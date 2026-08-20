import { describe, expect, it, vi } from 'vitest';
import { buildAiRequestBody, createSession, fetchAiCandidates, readSession, saveSession, sessionExpiredWhileSheetOpen, SESSION_STORAGE_KEY, WorkerApiError } from './api';

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
