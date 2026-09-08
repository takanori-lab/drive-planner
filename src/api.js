import { isValidLocation, segmentKey } from './model';

export const API_BASE_URL = 'https://drive-planner-api.takanori-tanaka0517.workers.dev';
export const ROUTING_POLICY_VERSION = 'ors-v2';
export const SESSION_STORAGE_KEY = 'drive-planner:ai-session:v1';
export const ROUTING_V2_PATH = '/v2/routing/segment';
export const ROUTING_V1_PATH = '/v1/routing/segment';

const placeForRequest = (place = {}) => ({
  name: place.name ?? '',
  googleMapsUrl: place.googleMapsUrl ?? '',
  locationNote: place.locationNote ?? '',
  memo: place.memo ?? '',
});

const boundedMajorRoads = (roads) => (Array.isArray(roads) ? roads : [])
  .filter((road) => typeof road === 'string' && road.trim())
  .slice(0, 20)
  .map((road) => road.slice(0, 120));

export function sampleRouteCoordinates(geometry, maximum = 20) {
  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) return [];
  const coordinates = geometry.coordinates;
  if (!coordinates.every((coordinate) => Array.isArray(coordinate) && coordinate.length >= 2
    && Number.isFinite(coordinate[0]) && coordinate[0] >= -180 && coordinate[0] <= 180
    && Number.isFinite(coordinate[1]) && coordinate[1] >= -90 && coordinate[1] <= 90)) return [];
  const count = Math.min(maximum, coordinates.length);
  if (count === 1) return [{ longitude: coordinates[0][0], latitude: coordinates[0][1] }];
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round(index * (coordinates.length - 1) / (count - 1));
    const [longitude, latitude] = coordinates[sourceIndex];
    return { latitude, longitude };
  });
}

export function buildRouteContext(before, after, routeResult, routingCondition) {
  const sampledCoordinates = sampleRouteCoordinates(routeResult?.geometry);
  if (isValidLocation(before?.location) && isValidLocation(after?.location)
    && routeResult?.status === 'ok' && sampledCoordinates.length >= 2) {
    return {
      source: 'ors', routingCondition,
      distanceMeters: routeResult.distanceMeters,
      durationSeconds: routeResult.durationSeconds,
      majorRoads: boundedMajorRoads(routeResult.majorRoads),
      sampledCoordinates,
    };
  }
  return { source: 'geographic_inference', routingCondition, distanceMeters: null, durationSeconds: null, majorRoads: [], sampledCoordinates: [] };
}

export function buildAiRequestBody(plan, segmentIndex, freeText = '', createRequestId = () => crypto.randomUUID(), routeResult, routingCondition) {
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
    routeContext: buildRouteContext(before, after, routeResult, routingCondition ?? plan.routingCondition ?? 'recommended'),
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
  constructor(httpStatus, code = 'internal_error', retryable = false, retryAfterMs) {
    super('Worker API request failed');
    this.name = 'WorkerApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryable = Boolean(retryable);
    this.retryAfterMs = retryAfterMs;
  }
}

async function parseResponse(response) {
  let body = null;
  try { body = await response.json(); } catch { /* raw responseを公開しない */ }
  if (!response.ok || body?.status === 'error') {
    const retryAfterSeconds = Number(response.headers.get('Retry-After') ?? body?.error?.retryAfterSeconds);
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : undefined;
    throw new WorkerApiError(response.status, body?.error?.code, body?.error?.retryable, retryAfterMs);
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
  const request = (requestBody) => fetchImpl(`${baseUrl}/v1/ai/segment-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(requestBody),
  });
  const response = await request(body);
  if (response.status !== 400 || !Object.hasOwn(body ?? {}, 'routeContext')) return parseResponse(response);
  // routeContext導入前のWorkerとのデプロイ順互換。旧Workerは未知フィールドを400で拒否する。
  const { routeContext: _routeContext, ...legacyBody } = body;
  return parseResponse(await request(legacyBody));
}

export function buildRoutingRequestBody(before, after, condition, createRequestId = () => crypto.randomUUID()) {
  if (!isValidLocation(before?.location) || !isValidLocation(after?.location)) throw new Error('経路計算には両端の有効な場所指定が必要です。');
  return { requestId: createRequestId(), condition, before: before.location, after: after.location };
}

export function buildLegacyRoutingRequestBody(before, after, condition, createRequestId = () => crypto.randomUUID()) {
  const placeForLegacyRouting = (place) => ({
    ...placeForRequest(place),
    googleMapsUrl: isValidLocation(place?.location)
      ? `https://www.google.com/maps?q=${place.location.latitude},${place.location.longitude}`
      : placeForRequest(place).googleMapsUrl,
  });
  return { requestId: createRequestId(), condition, before: placeForLegacyRouting(before), after: placeForLegacyRouting(after) };
}

export async function fetchSegmentRoute(before, after, condition, { fetchImpl = fetch, baseUrl = API_BASE_URL, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${ROUTING_V2_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRoutingRequestBody(before, after, condition)), signal });
  } catch (error) {
    // An old Worker rejects the cross-origin JSON preflight before JavaScript
    // can observe a 404. A simple GET distinguishes that deployment gap from
    // an outage: current Workers recognize this path and answer GET with 405.
    if (!(error instanceof TypeError) || signal?.aborted) throw error;
    let probe;
    try { probe = await fetchImpl(`${baseUrl}${ROUTING_V2_PATH}`, { method: 'GET', signal }); }
    catch { throw error; }
    if (probe.status !== 404) throw error;
    response = probe;
  }
  if (response.status !== 404 && response.status !== 405) return parseResponse(response);
  const legacyResponse = await fetchImpl(`${baseUrl}${ROUTING_V1_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildLegacyRoutingRequestBody(before, after, condition)), signal });
  return parseResponse(legacyResponse);
}
