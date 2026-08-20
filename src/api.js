import { segmentKey } from './model';

export const API_BASE_URL = 'https://drive-planner-api.takanori-tanaka0517.workers.dev';
export const SESSION_STORAGE_KEY = 'drive-planner:ai-session:v1';

const placeForRequest = (place = {}) => ({
  name: place.name ?? '',
  googleMapsUrl: place.googleMapsUrl ?? '',
  locationNote: place.locationNote ?? '',
  memo: place.memo ?? '',
});

export function buildAiRequestBody(plan, segmentIndex, freeText = '', createRequestId = () => crypto.randomUUID()) {
  const before = plan.points[segmentIndex];
  const after = plan.points[segmentIndex + 1];
  if (!before || !after) throw new Error('対象区間が見つかりません。');
  const mainPoint = plan.points.find((point) => point.locked === 'main');
  if (!mainPoint) throw new Error('MAIN地点が見つかりません。');

  return {
    requestId: createRequestId(),
    plan: {
      title: plan.title ?? '',
      date: plan.date ?? '',
      mainPoint: placeForRequest(mainPoint),
    },
    segment: { before: placeForRequest(before), after: placeForRequest(after) },
    existingCandidates: (plan.candidates?.[segmentKey(before, after)] ?? []).map((candidate) => ({
      name: candidate.name ?? '',
      locationNote: candidate.locationNote ?? '',
    })),
    preferences: { freeText, useWebSearch: false },
  };
}

export function readSession(storage = globalThis.sessionStorage, now = Date.now()) {
  try {
    const session = JSON.parse(storage?.getItem(SESSION_STORAGE_KEY));
    if (typeof session?.token === 'string' && session.token && Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) > now) return session;
  } catch {
    // 壊れた値も期限切れと同様に破棄する。
  }
  storage?.removeItem(SESSION_STORAGE_KEY);
  return null;
}

export function saveSession(session, storage = globalThis.sessionStorage) {
  storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: session.token, expiresAt: session.expiresAt }));
}

export function clearSession(storage = globalThis.sessionStorage) {
  storage?.removeItem(SESSION_STORAGE_KEY);
}

export function sessionExpiredWhileSheetOpen(displayedSession, storedSession) {
  return Boolean(displayedSession) && !storedSession;
}

export class WorkerApiError extends Error {
  constructor(httpStatus, code = 'internal_error', retryable = false) {
    super('Worker API request failed');
    this.name = 'WorkerApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

async function parseResponse(response) {
  let body = null;
  try { body = await response.json(); } catch { /* raw responseを公開しない */ }
  if (!response.ok || body?.status === 'error') {
    throw new WorkerApiError(response.status, body?.error?.code, body?.error?.retryable);
  }
  return body;
}

export async function createSession(passcode, { fetchImpl = fetch, baseUrl = API_BASE_URL } = {}) {
  const response = await fetchImpl(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  return parseResponse(response);
}

export async function fetchAiCandidates(token, body, { fetchImpl = fetch, baseUrl = API_BASE_URL } = {}) {
  const response = await fetchImpl(`${baseUrl}/v1/ai/segment-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}
