import { describe, expect, it, vi } from 'vitest';
import { buildAiRequestBody, buildRoutingRequestBody, createSession, fetchAiCandidates, fetchSegmentRoute, readSession, saveSession, sessionExpiredWhileSheetOpen, SESSION_STORAGE_KEY, WorkerApiError } from './api';
import { extractGoogleMapsPlace } from '../worker/src/google-maps';

const plan = {
  title: 'テスト旅行',
  points: [
    { id: 'secret-a', name: '出発', googleMapsUrl: 'https://maps.example/a', locationNote: '東口', memo: '朝', locked: 'start' },
    { id: 'secret-main', name: '目的地', googleMapsUrl: '', locationNote: '湖畔', memo: '', locked: 'main' },
    { id: 'secret-b', name: '到着', googleMapsUrl: '', locationNote: '', memo: '夕方', locked: 'goal' },
  ],
  candidates: {
    'secret-a::secret-main': [{ id: 'candidate-id', name: '既存候補', locationNote: '駅前', locked: true }],
    'secret-main::secret-b': [{ id: 'other-id', name: '他区間', locationNote: '' }],
  },
};

describe('AI request body', () => {
  it('選択区間とMAIN地点だけをWorker contractどおりに組み立てる', () => {
    const body = buildAiRequestBody(plan, 0, '静かな場所', () => 'request-1');
    expect(body).toEqual({
      requestId: 'request-1',
      plan: { title: 'テスト旅行', date: '', mainPoint: { name: '目的地', googleMapsUrl: '', locationNote: '湖畔', memo: '' } },
      segment: {
        before: { name: '出発', googleMapsUrl: 'https://maps.example/a', locationNote: '東口', memo: '朝' },
        after: { name: '目的地', googleMapsUrl: '', locationNote: '湖畔', memo: '' },
      },
      existingCandidates: [{ name: '既存候補', locationNote: '駅前' }],
      preferences: { freeText: '静かな場所', useWebSearch: false },
    });
    expect(JSON.stringify(body)).not.toMatch(/secret-|locked|localStorage|token/);
  });
});

describe('session', () => {
  const storage = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: vi.fn((key) => values.delete(key)) };
  };
  it('有効なsessionStorageのtokenを再利用する', () => {
    const target = storage();
    saveSession({ token: 'token', expiresAt: '2030-01-01T00:00:00.000Z' }, target);
    expect(readSession(target, Date.parse('2029-01-01'))?.token).toBe('token');
    expect(target.getItem(SESSION_STORAGE_KEY)).toContain('expiresAt');
  });
  it('期限切れtokenを破棄する', () => {
    const target = storage();
    saveSession({ token: 'old', expiresAt: '2020-01-01T00:00:00.000Z' }, target);
    expect(readSession(target, Date.parse('2021-01-01'))).toBeNull();
    expect(target.removeItem).toHaveBeenCalledWith(SESSION_STORAGE_KEY);
  });
  it('Sheet表示後にsessionが期限切れになったことを検知する', () => {
    expect(sessionExpiredWhileSheetOpen({ token: 'old' }, null)).toBe(true);
    expect(sessionExpiredWhileSheetOpen(null, null)).toBe(false);
    expect(sessionExpiredWhileSheetOpen({ token: 'valid' }, { token: 'valid' })).toBe(false);
  });
});

it('/sessionにはpasscodeだけを送る', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 't', expiresAt: '2030-01-01' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await createSession('合言葉', { fetchImpl, baseUrl: 'https://worker.test' });
  expect(fetchImpl).toHaveBeenCalledWith('https://worker.test/session', expect.objectContaining({ body: JSON.stringify({ passcode: '合言葉' }) }));
});

it('AI APIはBearer tokenをheaderだけに付ける', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok', candidates: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await fetchAiCandidates('session-secret', { requestId: 'r' }, { fetchImpl, baseUrl: 'https://worker.test' });
  const options = fetchImpl.mock.calls[0][1];
  expect(options.headers.Authorization).toBe('Bearer session-secret');
  expect(options.body).not.toContain('session-secret');
});

it('HTTP error contractをraw messageなしで安全にparseする', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'error', error: { code: 'rate_limited', message: 'raw', retryable: true } }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
  await expect(createSession('x', { fetchImpl })).rejects.toEqual(expect.objectContaining({ code: 'rate_limited', httpStatus: 429, retryable: true }));
  await expect(createSession('x', { fetchImpl })).rejects.not.toEqual(expect.objectContaining({ message: 'raw' }));
  expect(WorkerApiError).toBeDefined();
});

it('429のRetry-Afterを再試行待機時間として保持する', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'error', error: { code: 'rate_limited', retryable: true } }), {
    status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
  }));
  await expect(fetchSegmentRoute({ location: { latitude: 35, longitude: 139 } }, { location: { latitude: 36, longitude: 140 } }, 'recommended', { fetchImpl })).rejects.toMatchObject({ retryAfterMs: 60_000 });
});

it('routing requestにはユーザー指定座標だけを入れる', () => {
  const before = { name: '東京駅', googleMapsUrl: 'https://example.test', locationNote: '丸の内', location: { latitude: 35.681, longitude: 139.767 } };
  const after = { name: '勝浦駅', location: { latitude: 35.153, longitude: 140.312 } };
  expect(buildRoutingRequestBody(before, after, 'recommended', () => 'request')).toEqual({ requestId: 'request', condition: 'recommended', before: before.location, after: after.location });
  expect(() => buildRoutingRequestBody({ ...before, location: null }, after, 'recommended')).toThrow();
  expect(() => buildRoutingRequestBody(before, { ...after, location: { latitude: 35, longitude: 181 } }, 'recommended')).toThrow();
});

describe('Routing endpointのdeploy互換fallback', () => {
  const before = { name: '東京駅', googleMapsUrl: 'https://maps.example/tokyo', locationNote: '丸の内', memo: '集合', location: { latitude: 35.681, longitude: 139.767 } };
  const after = { name: '勝浦駅', googleMapsUrl: '', locationNote: '', memo: '', location: { latitude: 35.153, longitude: 140.312 } };
  it('新Workerではv2だけをcoordinate payloadで呼ぶ', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ status: 'ok', distanceMeters: 1, durationSeconds: 1 }));
    await fetchSegmentRoute(before, after, 'recommended', { fetchImpl, baseUrl: 'https://api.test' });
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(fetchImpl.mock.calls[0][0]).toBe('https://api.test/v2/routing/segment');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).before).toEqual(before.location);
  });
  it.each([404, 405])('v2がHTTP %sの場合だけv1へPlaceInputでfallbackする', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status })).mockResolvedValueOnce(Response.json({ status: 'ok' }));
    await fetchSegmentRoute(before, after, 'recommended', { fetchImpl, baseUrl: 'https://api.test' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(fetchImpl.mock.calls[1][0]).toBe('https://api.test/v1/routing/segment');
    const legacy = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(legacy.before).toEqual({ name: '東京駅', googleMapsUrl: 'https://www.google.com/maps?q=35.681,139.767', locationNote: '丸の内', memo: '集合' });
    expect(legacy.after.googleMapsUrl).toBe('https://www.google.com/maps?q=35.153,140.312');
    expect(extractGoogleMapsPlace(legacy.before.googleMapsUrl)).toMatchObject(before.location);
    expect(extractGoogleMapsPlace(legacy.after.googleMapsUrl)).toMatchObject(after.location);
    expect(before.googleMapsUrl).toBe('https://maps.example/tokyo'); expect(after.googleMapsUrl).toBe('');
  });
  it.each([400, 429, 500, 503])('v2がHTTP %sならv1へfallbackしない', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'error', error: { code: 'routing_unavailable' } }), { status, headers: { 'Content-Type': 'application/json' } }));
    await expect(fetchSegmentRoute(before, after, 'recommended', { fetchImpl, baseUrl: 'https://api.test' })).rejects.toBeInstanceOf(WorkerApiError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
