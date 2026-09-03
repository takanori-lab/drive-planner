import { ApiError, errorResponse } from './errors';
import { MAX_BODY_BYTES, validateRoutingRequest, validateSegmentCandidatesRequest } from './validation';
import { createSessionToken, passcodeMatches, verifySessionToken } from './auth';
import { generateCandidates } from './openai';
import { resolveRequestGoogleMaps } from './google-maps';
import { exportAiLogs, saveAiGenerationLog, type D1Database } from './ai-logs';
import { ADMIN_PAGE } from './admin-page';
import { calculateRoute } from './routing';
import { saveRoutingLog } from './routing-logs';

const PRODUCTION_ORIGIN = 'https://takanori-lab.github.io';
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const SHARED_AI_RATE_LIMIT_KEY = 'drive-planner-shared-group-v1';
const SHARED_ROUTING_RATE_LIMIT_KEY = 'drive-planner-routing-shared-group-v1';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DRIVE_PLANNER_PASSCODE: string;
  SESSION_SIGNING_KEY: string;
  OPENAI_API_KEY: string;
  ORS_API_KEY?: string;
  AI_LOG_EXPORT_KEY: string;
  AI_LOGS_DB: D1Database;
  SESSION_RATE_LIMITER: RateLimiter;
  AI_RATE_LIMITER: RateLimiter;
  ROUTING_IP_RATE_LIMITER: RateLimiter;
  ROUTING_RATE_LIMITER: RateLimiter;
}

function allowedOrigin(origin: string | null): string | null {
  return origin === PRODUCTION_ORIGIN || (origin !== null && LOCAL_ORIGIN.test(origin)) ? origin : null;
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers(JSON_HEADERS);
  const origin = allowedOrigin(request.headers.get('Origin'));
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return headers;
}

async function parseBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ApiError(415, 'unsupported_media_type', 'Content-Type は application/json を指定してください。');
  }
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'リクエストのサイズが上限を超えています。');
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'リクエストのサイズが上限を超えています。');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError(400, 'invalid_json', 'JSONの形式を確認してください。');
  }
}

function preflight(request: Request): Response {
  const origin = allowedOrigin(request.headers.get('Origin'));
  if (!origin) return errorResponse(new ApiError(403, 'invalid_request', '許可されていないOriginです。'), JSON_HEADERS);
  const headers = corsHeaders(request);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function rateLimited(): ApiError {
  return new ApiError(429, 'rate_limited', 'リクエスト回数が上限に達しました。しばらく待ってからお試しください。', true);
}

function requireBearer(request: Request): string {
  const authorization = request.headers.get('Authorization');
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u);
  if (!match) throw new ApiError(401, 'unauthorized', '認証が必要です。');
  return match[1];
}

function validateSessionRequest(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_request', 'リクエスト内容を確認してください。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || typeof input.passcode !== 'string' || input.passcode.length < 1 || input.passcode.length > 256) {
    throw new ApiError(400, 'invalid_request', 'リクエスト内容を確認してください。');
  }
  return input.passcode;
}

export async function handleRequest(request: Request, env: Env, fetcher: typeof fetch = fetch, aiTimeoutMs?: number): Promise<Response> {
  const url = new URL(request.url);
  const headers = corsHeaders(request);
  try {
    if (url.pathname === '/health') {
      if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'このHTTPメソッドは使用できません。');
      return Response.json({ status: 'ok' }, { headers });
    }

    if (url.pathname === '/admin/ai-logs') {
      if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'このHTTPメソッドは使用できません。');
      return new Response(ADMIN_PAGE, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        'Referrer-Policy': 'no-referrer',
      } });
    }

    if (url.pathname === '/v1/admin/ai-logs/export') {
      if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'このHTTPメソッドは使用できません。');
      const authorization = request.headers.get('Authorization');
      const submitted = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!submitted || !env?.AI_LOG_EXPORT_KEY || !(await passcodeMatches(submitted, env.AI_LOG_EXPORT_KEY))) {
        throw new ApiError(401, 'unauthorized', '認証が必要です。');
      }
      if (!env.AI_LOGS_DB) throw new Error('Worker configuration is incomplete');
      const body = await exportAiLogs(env.AI_LOGS_DB);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      return new Response(body, { headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="drive-planner-ai-logs-${stamp}.jsonl"`,
        'Cache-Control': 'no-store',
      } });
    }

    if (url.pathname === '/session') {
      if (request.method === 'OPTIONS') return preflight(request);
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'このHTTPメソッドは使用できません。');
      if (!env?.DRIVE_PLANNER_PASSCODE || !env.SESSION_SIGNING_KEY || !env.SESSION_RATE_LIMITER) throw new Error('Worker configuration is incomplete');
      const connectionKey = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await env.SESSION_RATE_LIMITER.limit({ key: connectionKey })).success) throw rateLimited();
      const passcode = validateSessionRequest(await parseBody(request));
      if (!(await passcodeMatches(passcode, env.DRIVE_PLANNER_PASSCODE))) throw new ApiError(401, 'unauthorized', '認証に失敗しました。');
      const session = await createSessionToken(env.SESSION_SIGNING_KEY);
      return Response.json({ token: session.token, expiresAt: new Date(session.claims.expiresAt * 1000).toISOString() }, { headers });
    }

    if (url.pathname === '/v1/routing/segment') {
      if (request.method === 'OPTIONS') return preflight(request);
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'このHTTPメソッドは使用できません。');
      if (!allowedOrigin(request.headers.get('Origin'))) throw new ApiError(403, 'invalid_request', '許可されていないOriginです。');
      if (!env?.ROUTING_IP_RATE_LIMITER || !env.ROUTING_RATE_LIMITER) throw new Error('Worker configuration is incomplete');
      const connectionKey = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await env.ROUTING_IP_RATE_LIMITER.limit({ key: connectionKey })).success) throw rateLimited();
      if (!(await env.ROUTING_RATE_LIMITER.limit({ key: SHARED_ROUTING_RATE_LIMIT_KEY })).success) throw rateLimited();
      const input = validateRoutingRequest(await parseBody(request));
      if (!env?.ORS_API_KEY) throw new ApiError(500, 'routing_not_configured', '経路計算を利用できません。');
      let result;
      try {
        result = await calculateRoute(input, env.ORS_API_KEY, fetcher, aiTimeoutMs);
        if (env.AI_LOGS_DB) try { await saveRoutingLog(env.AI_LOGS_DB, input, result); } catch { console.warn('routing_log_write_failed', { requestId: input.requestId }); }
      } catch (error) {
        if (env.AI_LOGS_DB) try { await saveRoutingLog(env.AI_LOGS_DB, input, null, error instanceof ApiError ? error.code : 'internal_error'); } catch { console.warn('routing_log_write_failed', { requestId: input.requestId }); }
        throw error;
      }
      return Response.json(result, { headers });
    }

    if (url.pathname === '/v1/ai/segment-candidates') {
      if (request.method === 'OPTIONS') return preflight(request);
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'このHTTPメソッドは使用できません。');
      if (!env?.SESSION_SIGNING_KEY || !env.AI_RATE_LIMITER) throw new Error('Worker configuration is incomplete');
      await verifySessionToken(requireBearer(request), env.SESSION_SIGNING_KEY);
      if (!(await env.AI_RATE_LIMITER.limit({ key: SHARED_AI_RATE_LIMIT_KEY })).success) throw rateLimited();
      const input = validateSegmentCandidatesRequest(await parseBody(request));
      if (input.preferences.useWebSearch) throw new ApiError(400, 'invalid_request', 'Web Searchを利用する候補生成はまだ提供していません。');
      if (!env.OPENAI_API_KEY) throw new ApiError(500, 'internal_error', '一時的なエラーが発生しました。');
      const resolvedGoogleMaps = await resolveRequestGoogleMaps(input, fetcher);
      const generated = await generateCandidates(input, env.OPENAI_API_KEY, fetcher, aiTimeoutMs, resolvedGoogleMaps);
      if (env.AI_LOGS_DB) {
        try {
          await saveAiGenerationLog(env.AI_LOGS_DB, input.requestId, resolvedGoogleMaps, generated);
        } catch {
          console.warn('ai_log_write_failed', { requestId: input.requestId });
        }
      }
      if (generated.status === 'needs_clarification') return Response.json({
        requestId: input.requestId, status: generated.status, clarificationMessage: generated.clarificationMessage,
        candidates: [], meta: { webSearchUsed: false, candidateCount: 0 },
      }, { headers });
      return Response.json({ requestId: input.requestId, status: 'ok', candidates: generated.candidates.map((candidate) => ({
        resultId: crypto.randomUUID(), ...candidate, sources: [],
      })), meta: { webSearchUsed: false, candidateCount: 5 } }, { headers });
    }
    throw new ApiError(404, 'not_found', '指定されたAPIは見つかりません。');
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 405) headers.set('Allow', ['/health', '/admin/ai-logs', '/v1/admin/ai-logs/export'].includes(url.pathname) ? 'GET' : 'POST, OPTIONS');
      return errorResponse(error, headers);
    }
    return errorResponse(new ApiError(500, 'internal_error', '一時的なエラーが発生しました。', true), headers);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
