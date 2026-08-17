import { ApiError, errorResponse } from './errors';
import { MAX_BODY_BYTES, validateSegmentCandidatesRequest } from './validation';

const PRODUCTION_ORIGIN = 'https://takanori-lab.github.io';
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

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
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = corsHeaders(request);
  try {
    if (url.pathname === '/health') {
      if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'このHTTPメソッドは使用できません。');
      return Response.json({ status: 'ok' }, { headers });
    }

    if (url.pathname === '/v1/ai/segment-candidates') {
      if (request.method === 'OPTIONS') return preflight(request);
      if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'このHTTPメソッドは使用できません。');
      const input = validateSegmentCandidatesRequest(await parseBody(request));
      return Response.json({
        requestId: input.requestId,
        status: 'ok',
        candidates: [{
          resultId: 'sample-1',
          name: 'サンプル候補',
          locationHint: 'サンプル地域',
          description: '開発用の固定レスポンスです。',
          reason: 'FrontendとBackendの接続確認に使用します。',
          detourLevel: 'small',
          detourNote: '開発用',
          checkItems: [],
          sources: [],
        }],
        meta: { webSearchUsed: false, candidateCount: 1 },
      }, { headers });
    }
    throw new ApiError(404, 'not_found', '指定されたAPIは見つかりません。');
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 405) headers.set('Allow', url.pathname === '/health' ? 'GET' : 'POST, OPTIONS');
      return errorResponse(error, headers);
    }
    return errorResponse(new ApiError(500, 'internal_error', '一時的なエラーが発生しました。', true), headers);
  }
}

export default { fetch: handleRequest };
