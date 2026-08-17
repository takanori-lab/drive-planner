import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index';
import { MAX_BODY_BYTES } from '../src/validation';

const endpoint = 'https://api.example.test/v1/ai/segment-candidates';
const productionOrigin = 'https://takanori-lab.github.io';

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

function post(body: unknown, headers: HeadersInit = {}): Request {
  return new Request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('Drive Planner Worker', () => {
  it('GET /health は小さな正常レスポンスを返す', async () => {
    const response = await handleRequest(new Request('https://api.example.test/health'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('正常なPOSTに固定候補と同じrequestIdを返す', async () => {
    const response = await handleRequest(post(fixture()));
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.requestId).toBe(fixture().requestId);
    expect(body.status).toBe('ok');
    expect(body.candidates).toHaveLength(1);
    expect(body.meta).toEqual({ webSearchUsed: false, candidateCount: 1 });
  });

  it('不正JSONを統一エラーにする', async () => {
    const response = await handleRequest(post('{broken'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 'error', error: { code: 'invalid_json', retryable: false } });
  });

  it('必須項目の欠落を拒否する', async () => {
    const input = fixture() as Record<string, unknown>;
    delete input.segment;
    const response = await handleRequest(post(input));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 'error', error: { code: 'invalid_request' } });
  });

  it('不正methodをAllowヘッダー付きで拒否する', async () => {
    const response = await handleRequest(new Request(endpoint, { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST, OPTIONS');
  });

  it('application/json以外を拒否する', async () => {
    const response = await handleRequest(post(JSON.stringify(fixture()), { 'Content-Type': 'text/plain' }));
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
  });

  it.each([productionOrigin, 'http://localhost:5173', 'http://127.0.0.1:4173'])('許可Origin %s を返す', async (origin) => {
    const response = await handleRequest(post(fixture(), { Origin: origin }));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('不許可OriginにはCORS許可ヘッダーを返さない', async () => {
    const response = await handleRequest(post(fixture(), { Origin: 'https://evil.example' }));
    expect(response.status).toBe(200);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });

  it('許可Originのpreflightだけを受け付ける', async () => {
    const allowed = await handleRequest(new Request(endpoint, { method: 'OPTIONS', headers: { Origin: productionOrigin } }));
    const denied = await handleRequest(new Request(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(denied.status).toBe(403);
  });

  it('文字列長・配列件数・bodyサイズの上限を検証する', async () => {
    const longText = fixture();
    longText.preferences.freeText = 'あ'.repeat(1001);
    expect((await handleRequest(post(longText))).status).toBe(400);

    const many = fixture();
    many.existingCandidates = Array.from({ length: 21 }, (_, index) => ({ name: `候補${index}`, locationNote: '' }));
    expect((await handleRequest(post(many))).status).toBe(400);

    const oversized = `"${'a'.repeat(MAX_BODY_BYTES)}"`;
    const response = await handleRequest(post(oversized));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('内部IDなどcontract外の項目を拒否する', async () => {
    const input = fixture();
    (input.segment.before as Record<string, unknown>).id = 'local-only';
    expect((await handleRequest(post(input))).status).toBe(400);
  });
});
