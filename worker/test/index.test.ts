import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken } from '../src/auth';
import worker, { type Env, handleRequest, type RateLimiter } from '../src/index';
import { MAX_BODY_BYTES } from '../src/validation';
import { INSTRUCTIONS, PROMPT_VERSION } from '../src/openai';

const aiEndpoint = 'https://api.example.test/v1/ai/segment-candidates';
const sessionEndpoint = 'https://api.example.test/session';
const productionOrigin = 'https://takanori-lab.github.io';
const TEST_PASSCODE = 'テスト専用プレースホルダー';
const TEST_SIGNING_KEY = 'テスト専用の十分に長い署名鍵プレースホルダー';

class FakeRateLimiter implements RateLimiter {
  readonly keys: string[] = [];
  constructor(private readonly allowed = true) {}
  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(key);
    return { success: this.allowed };
  }
}

function environment(options: { sessionAllowed?: boolean; aiAllowed?: boolean; routingAllowed?: boolean } = {}): Env {
  return {
    DRIVE_PLANNER_PASSCODE: TEST_PASSCODE,
    SESSION_SIGNING_KEY: TEST_SIGNING_KEY,
    OPENAI_API_KEY: 'テスト用ダミーキー',
    AI_LOG_EXPORT_KEY: 'test-export-key-placeholder',
    AI_LOGS_DB: undefined as unknown as Env['AI_LOGS_DB'],
    SESSION_RATE_LIMITER: new FakeRateLimiter(options.sessionAllowed),
    AI_RATE_LIMITER: new FakeRateLimiter(options.aiAllowed),
    ROUTING_RATE_LIMITER: new FakeRateLimiter(options.routingAllowed),
  };
}

const candidate = (index: number) => ({
  name: `候補${index}`, locationHint: `地域${index}`, description: `説明${index}`, reason: `理由${index}`,
  detourLevel: 'small', detourNote: `寄り道${index}`, checkItems: [`確認${index}`],
});

function openAiOutput(value: unknown, overrides: Record<string, unknown> = {}): Response {
  return Response.json({ id: 'resp_test_123', status: 'completed', usage: { input_tokens: 100, output_tokens: 200 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], ...overrides });
}

function successfulOutput(): Response {
  return openAiOutput({ status: 'ok', clarificationMessage: '', candidates: Array.from({ length: 5 }, (_, i) => candidate(i + 1)) });
}

function fixture() {
  const point = (name: string) => ({ name, googleMapsUrl: '', locationNote: '', memo: '' });
  return {
    requestId: '5eca122f-c098-4690-9575-5e906c3f86af',
    plan: { title: '富士山周辺ドライブ', date: '2026-08-29', mainPoint: point('富士山') },
    segment: { before: point('東京駅'), after: point('河口湖') },
    existingCandidates: [{ name: '候補例', locationNote: '' }],
    preferences: { freeText: '景色がいいところ', useWebSearch: false },
  };
}

function post(url: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function authorization(env = environment()): Promise<string> {
  const { token } = await createSessionToken(env.SESSION_SIGNING_KEY);
  return `Bearer ${token}`;
}

describe('Drive Planner Worker', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => successfulOutput())));
  it('GET /health は認証なしで200を返す', async () => {
    const response = await handleRequest(new Request('https://api.example.test/health'), environment());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('routing専用rate limitをORSより先に適用し、AI limiterへ影響させない', async () => {
    const env = environment(); env.ORS_API_KEY = 'テスト用ダミーORSキー';
    const routing = env.ROUTING_RATE_LIMITER as FakeRateLimiter;
    const ai = env.AI_RATE_LIMITER as FakeRateLimiter;
    const body = { requestId: 'route-request', condition: 'recommended', before: fixture().segment.before, after: fixture().segment.after };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ features: [{ geometry: { coordinates: [139.7, 35.6] }, properties: { confidence: 0.9 } }] }))
      .mockResolvedValueOnce(Response.json({ features: [{ geometry: { coordinates: [138.7, 35.5] }, properties: { confidence: 0.9 } }] }))
      .mockResolvedValueOnce(Response.json({ routes: [{ summary: { distance: 1000, duration: 600 } }] }));
    const response = await handleRequest(post('https://api.example.test/v1/routing/segment', body, { Origin: productionOrigin }), env, fetcher);
    expect(response.status).toBe(200);
    expect(routing.keys).toEqual(['drive-planner-routing-shared-group-v1']);
    expect(ai.keys).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('routing rate limit超過時はORSを呼ばず429を返す', async () => {
    const env = environment({ routingAllowed: false }); env.ORS_API_KEY = 'テスト用ダミーORSキー';
    const fetcher = vi.fn();
    const body = { requestId: 'route-request', condition: 'local_roads', before: fixture().segment.before, after: fixture().segment.after };
    const response = await handleRequest(post('https://api.example.test/v1/routing/segment', body, { Origin: productionOrigin }), env, fetcher);
    expect(response.status).toBe(429); expect(await response.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect((env.AI_RATE_LIMITER as FakeRateLimiter).keys).toEqual([]);
  });

  it('許可されていないOriginのrouting POSTをORSより先に拒否する', async () => {
    const env = environment(); env.ORS_API_KEY = 'テスト用ダミーORSキー'; const fetcher = vi.fn();
    const body = { requestId: 'route-request', condition: 'recommended', before: fixture().segment.before, after: fixture().segment.after };
    expect((await handleRequest(post('https://api.example.test/v1/routing/segment', body, { Origin: 'https://evil.example' }), env, fetcher)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled(); expect((env.ROUTING_RATE_LIMITER as FakeRateLimiter).keys).toEqual([]);
  });

  it('管理ページはSecretを埋め込まずAuthorization headerでexportする', async () => {
    const env = environment();
    const response = await handleRequest(new Request('https://api.example.test/admin/ai-logs'), env);
    const html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('AIログをエクスポート');
    expect(html).toContain("Authorization:'Bearer '+key.value"); expect(html).not.toContain(env.AI_LOG_EXPORT_KEY);
    expect(html).not.toContain('localStorage'); expect(html).not.toContain('sessionStorage');
  });

  it('export APIはSecretなしと不正Secretを401で拒否する', async () => {
    const url = 'https://api.example.test/v1/admin/ai-logs/export'; const env = environment();
    expect((await handleRequest(new Request(url), env)).status).toBe(401);
    expect((await handleRequest(new Request(url, { headers: { Authorization: 'Bearer wrong' } }), env)).status).toBe(401);
  });

  it('正しいSecretでJSONLをno-storeの添付ファイルとして返す', async () => {
    const env = environment(); const row = { id: 'log-1', log_version: 1, created_at: '2026-08-22T00:00:00.000Z', request_id: 'req-1', openai_response_id: 'resp-1', model: 'gpt-5.6-luna', prompt_version: 'segment-candidates-v1', instructions: '指示', input_json: '{"freeText":"景色"}', resolved_google_maps_context_json: '{}', output_json: '{"status":"ok","candidates":[]}', usage_json: '{"total_tokens":3}' };
    const statement: any = { bind: vi.fn(() => statement), all: vi.fn(async () => ({ results: [row] })) };
    env.AI_LOGS_DB = { exec: vi.fn(async () => ({})), prepare: vi.fn(() => statement) };
    const response = await handleRequest(new Request('https://api.example.test/v1/admin/ai-logs/export', { headers: { Authorization: `Bearer ${env.AI_LOG_EXPORT_KEY}` } }), env);
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toContain('application/x-ndjson');
    expect(response.headers.get('Content-Disposition')).toContain('attachment; filename="drive-planner-ai-logs-'); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const exported = JSON.parse((await response.text()).trim()); expect(exported.input).toEqual({ freeText: '景色' }); expect(exported.output.status).toBe('ok');
    expect(JSON.stringify(exported)).not.toContain(env.AI_LOG_EXPORT_KEY);
  });

  it('D1保存失敗時もAIの正常レスポンスを返す', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined); const env = environment();
    env.AI_LOGS_DB = { exec: vi.fn(async () => { throw new Error('secret detail'); }), prepare: vi.fn() as any };
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(200); expect(warning).toHaveBeenCalledWith('ai_log_write_failed', { requestId: fixture().requestId });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret detail'); expect(JSON.stringify(warning.mock.calls)).not.toContain(fixture().preferences.freeText);
  });

  it('正しいpasscodeで8時間のsession tokenを発行する', async () => {
    const before = Date.now();
    const response = await handleRequest(post(sessionEndpoint, { passcode: TEST_PASSCODE }), environment());
    const body = await response.json() as { token: string; expiresAt: string };
    expect(response.status).toBe(200);
    expect(body.token.split('.')).toHaveLength(2);
    expect(Date.parse(body.expiresAt) - before).toBeGreaterThan(7.9 * 60 * 60 * 1000);
    expect(JSON.stringify(body)).not.toContain(TEST_PASSCODE);
  });

  it('誤ったpasscodeを401で拒否する', async () => {
    const response = await handleRequest(post(sessionEndpoint, { passcode: '誤った入力' }), environment());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it.each([{}, { passcode: 1 }, { passcode: TEST_PASSCODE, extra: true }])('不正なsession requestを拒否する', async (body) => {
    expect((await handleRequest(post(sessionEndpoint, body), environment())).status).toBe(400);
  });

  it('session rate limitを429で返す', async () => {
    const response = await handleRequest(post(sessionEndpoint, { passcode: TEST_PASSCODE }), environment({ sessionAllowed: false }));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited', retryable: true } });
  });

  it('session rate limitにはCF-Connecting-IPを使う', async () => {
    const env = environment();
    const limiter = env.SESSION_RATE_LIMITER as FakeRateLimiter;
    await handleRequest(post(sessionEndpoint, { passcode: TEST_PASSCODE }, { 'CF-Connecting-IP': '192.0.2.10' }), env);
    expect(limiter.keys).toEqual(['192.0.2.10']);
  });

  it('Authorizationなしと不正tokenを401で拒否する', async () => {
    expect((await handleRequest(post(aiEndpoint, fixture()), environment())).status).toBe(401);
    expect((await handleRequest(post(aiEndpoint, fixture(), { Authorization: 'Bearer invalid.token' }), environment())).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('改ざんtokenを401で拒否する', async () => {
    const auth = await authorization();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: `${auth}x` }), environment());
    expect(response.status).toBe(401);
  });

  it('期限切れtokenを401で拒否する', async () => {
    const env = environment();
    const { token } = await createSessionToken(env.SESSION_SIGNING_KEY, Math.floor(Date.now() / 1000) - 100, 1);
    expect((await handleRequest(post(aiEndpoint, fixture(), { Authorization: `Bearer ${token}` }), env)).status).toBe(401);
  });

  it('正常tokenとbodyでOpenAIを1回呼び候補5件を返す', async () => {
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.requestId).toBe(fixture().requestId);
    expect(body.candidates).toHaveLength(5);
    expect(body.meta).toEqual({ webSearchUsed: false, candidateCount: 5 });
    expect(fetch).toHaveBeenCalledOnce();
    for (const item of body.candidates) {
      expect(item.resultId).toMatch(/^[0-9a-f-]{36}$/);
      expect(item.sources).toEqual([]);
    }
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const request = JSON.parse(init?.body as string);
    expect(request).toMatchObject({ model: 'gpt-5.6-luna', reasoning: { effort: 'medium' }, store: true,
      metadata: { app: 'drive-planner', feature: 'segment-candidates' }, max_output_tokens: 4000,
      text: { format: { type: 'json_schema', name: 'drive_planner_segment_candidates', strict: true } } });
    expect(PROMPT_VERSION).toBe('segment-candidates-v2');
    expect(request.instructions).toBe(INSTRUCTIONS);
    for (const rule of [
      'segment.before → segment.afterが最優先',
      'MAINを経由地点として扱ったり',
      'freeTextは「何を探すか」に強く反映してよい一方、A→Bの地理的探索範囲を変更してはいけません',
      'smallはA→Bの自然な移動範囲からほとんど外れず',
      'mediumはA→Bの流れを維持できるが明確な寄り道・追加移動',
      'largeはA→Bの自然な流れからかなり外れる可能性',
      '5件を揃えるために遠方・区間外へ探索範囲を広げてはいけません',
      'needs_clarification',
      'MAINだけが曖昧であることを理由にneeds_clarificationを返さず',
      'resolvedGoogleMapsContext',
      'Web Searchは使用できません',
    ]) expect(request.instructions).toContain(rule);
    expect(request.text.format.schema).toMatchObject({
      type: 'object',
      required: ['status', 'clarificationMessage', 'candidates'],
      properties: { candidates: { type: 'array', maxItems: 5 } },
    });
    expect(request.metadata).toEqual({ app: 'drive-planner', feature: 'segment-candidates' });
    expect(JSON.stringify(request.metadata)).not.toContain(env.OPENAI_API_KEY);
    expect(JSON.stringify(request.metadata)).not.toContain(env.DRIVE_PLANNER_PASSCODE);
    expect(JSON.stringify(request.metadata)).not.toContain(env.SESSION_SIGNING_KEY);
    expect(JSON.stringify(request.metadata)).not.toContain('景色がいいところ');
    expect(request).not.toHaveProperty('tools');
    const sent = JSON.parse(request.input);
    expect(sent).toEqual({ ...fixture(), resolvedGoogleMapsContext: {} });
    expect(request.input).not.toContain('localStorage');
    expect(request.input).not.toContain('internalId');
  });

  it('解決したGoogle Maps地点情報をOpenAI入力へ追加し、GoogleへSecretを送らない', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://www.google.com/maps/place/%E6%B9%96%E7%95%94%E3%81%AE%E3%83%91%E3%83%B3%E5%B1%8B/@35.5,138.7,15z' } }))
      .mockResolvedValueOnce(successfulOutput());
    const env = environment();
    const requestBody = fixture();
    requestBody.segment.after.googleMapsUrl = 'https://maps.app.goo.gl/example';
    const response = await handleRequest(post(aiEndpoint, requestBody, { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [googleUrl, googleInit] = vi.mocked(fetch).mock.calls[0];
    expect(googleUrl).toBe('https://maps.app.goo.gl/example');
    expect(googleInit).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(googleInit).not.toHaveProperty('headers');
    expect(JSON.stringify(googleInit)).not.toContain(env.OPENAI_API_KEY);
    expect(JSON.stringify(googleInit)).not.toContain('Authorization');
    const openAiRequest = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(JSON.parse(openAiRequest.input).resolvedGoogleMapsContext['segment.after']).toMatchObject({
      label: '湖畔のパン屋', latitude: 35.5, longitude: 138.7,
    });
    expect(openAiRequest.instructions).toContain('resolvedGoogleMapsContext');
    expect(openAiRequest.instructions).toContain('Web Searchは使用できません');
  });

  it('Google Maps URL解決失敗時も元の地点情報でOpenAI生成を続ける', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://evil.example/private' } }))
      .mockResolvedValueOnce(successfulOutput());
    const env = environment();
    const requestBody = fixture();
    requestBody.segment.before.googleMapsUrl = 'https://maps.app.goo.gl/broken';
    const response = await handleRequest(post(aiEndpoint, requestBody, { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(200);
    const openAiRequest = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(JSON.parse(openAiRequest.input).resolvedGoogleMapsContext).toEqual({});
  });

  it('default exportのfetchはExecutionContextをOpenAI fetcherとして使わない', async () => {
    const env = environment();
    const fakeExecutionContext = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const request = post(aiEndpoint, fixture(), { Authorization: await authorization(env) });

    const response = await Reflect.apply(worker.fetch, worker, [request, env, fakeExecutionContext]);

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fakeExecutionContext.waitUntil).not.toHaveBeenCalled();
    expect(fakeExecutionContext.passThroughOnException).not.toHaveBeenCalled();
  });

  it('AI API rate limitを429で返す', async () => {
    const env = environment({ aiAllowed: false });
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('AI APIはtokenを再発行しても共有グループのRate Limit keyを使う', async () => {
    const env = environment();
    const limiter = env.AI_RATE_LIMITER as FakeRateLimiter;
    const first = await authorization(env);
    const second = await authorization(env);
    await handleRequest(post(aiEndpoint, fixture(), { Authorization: first }), env);
    await handleRequest(post(aiEndpoint, fixture(), { Authorization: second }), env);
    expect(limiter.keys).toEqual(['drive-planner-shared-group-v1', 'drive-planner-shared-group-v1']);
  });

  it('許可OriginのpreflightでAuthorizationを許可し、不許可Originを拒否する', async () => {
    const allowed = await handleRequest(new Request(aiEndpoint, { method: 'OPTIONS', headers: { Origin: productionOrigin } }), environment());
    const denied = await handleRequest(new Request(aiEndpoint, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), environment());
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(allowed.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(denied.status).toBe(403);
  });

  it.each([productionOrigin, 'http://localhost:5173', 'http://127.0.0.1:4173'])('許可Origin %s を返す', async (origin) => {
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Origin: origin, Authorization: await authorization(env) }), env);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('不許可Originには従来どおりCORS許可ヘッダーを返さない', async () => {
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Origin: 'https://evil.example', Authorization: await authorization(env) }), env);
    expect(response.status).toBe(200);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });

  it('認証後もJSON・schema・bodyサイズを検証する', async () => {
    const env = environment();
    const auth = await authorization(env);
    expect((await handleRequest(post(aiEndpoint, '{broken', { Authorization: auth }), env)).status).toBe(400);
    const missing = fixture() as Record<string, unknown>; delete missing.segment;
    expect((await handleRequest(post(aiEndpoint, missing, { Authorization: auth }), env)).status).toBe(400);
    const oversized = `"${'a'.repeat(MAX_BODY_BYTES)}"`;
    expect((await handleRequest(post(aiEndpoint, oversized, { Authorization: auth }), env)).status).toBe(413);
  });

  it('AI APIの不正methodを405とAllowヘッダー付きで拒否する', async () => {
    const response = await handleRequest(new Request(aiEndpoint, { method: 'GET' }), environment());
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('認証後にapplication/json以外を415で拒否する', async () => {
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, JSON.stringify(fixture()), {
      Authorization: await authorization(env),
      'Content-Type': 'text/plain',
    }), env);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
  });

  it('認証後も文字列長と既存候補件数の上限を検証する', async () => {
    const env = environment();
    const auth = await authorization(env);
    const longText = fixture();
    longText.preferences.freeText = 'あ'.repeat(1001);
    expect((await handleRequest(post(aiEndpoint, longText, { Authorization: auth }), env)).status).toBe(400);

    const many = fixture();
    many.existingCandidates = Array.from({ length: 21 }, (_, index) => ({ name: `候補${index}`, locationNote: '' }));
    expect((await handleRequest(post(aiEndpoint, many, { Authorization: auth }), env)).status).toBe(400);
  });

  it('認証後もcontract外フィールドを拒否する', async () => {
    const env = environment();
    const input = fixture();
    (input.segment.before as Record<string, unknown>).id = 'local-only';
    expect((await handleRequest(post(aiEndpoint, input, { Authorization: await authorization(env) }), env)).status).toBe(400);
  });

  it('確認が必要な応答を明確なcontractへ変換する', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(openAiOutput({ status: 'needs_clarification', clarificationMessage: '出発地点の都道府県を入力してください。', candidates: [] }));
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'needs_clarification', clarificationMessage: expect.any(String), candidates: [], meta: { webSearchUsed: false, candidateCount: 0 } });
  });

  it.each([
    ['候補数が4件', openAiOutput({ status: 'ok', clarificationMessage: '', candidates: Array.from({ length: 4 }, (_, i) => candidate(i)) })],
    ['malformed JSON', Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{broken' }] }] })],
    ['refusal', Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: '不可' }] }] })],
    ['incomplete', Response.json({ status: 'incomplete', output: [] })],
  ])('%sを安全なupstream invalid responseにする', async (_name, upstream) => {
    vi.mocked(fetch).mockResolvedValueOnce(upstream);
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'ai_invalid_response', retryable: false } });
  });

  it.each([429, 500])('OpenAI %sをretryable errorにする', async (status) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(fetch).mockResolvedValueOnce(new Response('外部の詳細', { status }));
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'ai_unavailable', retryable: true } });
    expect(text).not.toContain('外部の詳細');
    expect(warning).toHaveBeenCalledWith('openai_upstream_error', { status, model: 'gpt-5.6-luna' });
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).not.toContain(env.OPENAI_API_KEY);
    expect(logged).not.toContain(fixture().plan.mainPoint.name);
    expect(logged).not.toContain('外部の詳細');
  });

  it.each([400, 401, 403])('OpenAI %sを再試行不可のinternal errorにし、raw bodyやSecretを漏らさない', async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('認証・リクエスト詳細', { status }));
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'internal_error', retryable: false } });
    expect(text).not.toContain('認証・リクエスト詳細');
    expect(text).not.toContain(env.OPENAI_API_KEY);
  });

  it('network errorをretryable errorにする', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network error: 秘密の詳細'));
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'ai_unavailable', retryable: true } });
    expect(warning).toHaveBeenCalledWith('openai_network_error', { model: 'gpt-5.6-luna' });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('秘密の詳細');
    expect(JSON.stringify(warning.mock.calls)).not.toContain(env.OPENAI_API_KEY);
  });

  it('timeoutをretryable errorにする', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hanging = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const env = environment();
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env, hanging, 1);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: 'ai_timeout', retryable: true } });
    expect(warning).toHaveBeenCalledWith('openai_timeout', { model: 'gpt-5.6-luna' });
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).not.toContain(env.OPENAI_API_KEY);
    expect(logged).not.toContain(fixture().preferences.freeText);
  });

  it('OPENAI_API_KEY不足はOpenAIを呼ばずinternal errorにする', async () => {
    const env = environment(); env.OPENAI_API_KEY = '';
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'internal_error', retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('想定外のinternal errorは従来どおりretryableにする', async () => {
    const env = environment();
    env.AI_RATE_LIMITER = { limit: vi.fn().mockRejectedValue(new Error('unexpected')) };
    const response = await handleRequest(post(aiEndpoint, fixture(), { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'internal_error', retryable: true } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('useWebSearch=trueを未実装として400で拒否する', async () => {
    const env = environment(); const input = fixture(); input.preferences.useWebSearch = true;
    const response = await handleRequest(post(aiEndpoint, input, { Authorization: await authorization(env) }), env);
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
