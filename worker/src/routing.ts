import { ApiError } from './errors';
import type { RoutingRequest } from './validation';

export const ROUTING_POLICY_VERSION = 'ors-v2';
export const ORS_DIRECTIONS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/json';
export type RouteCondition = 'recommended' | 'local_roads';
export type ResolutionMethod = 'user_coordinates';
export type RoutingInput = RoutingRequest;
export interface RoutingResult { status: 'ok'; provider: 'openrouteservice'; routingPolicyVersion: string; condition: RouteCondition; distanceMeters: number; durationSeconds: number; locationResolution: { before: ResolutionMethod; after: ResolutionMethod }; confidence: 'exact' }
export type LocationResolution = RoutingResult['locationResolution'];
export type RoutingFailure = Error & { locationResolution?: LocationResolution };

function retryAfterSeconds(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const value = response.headers.get('Retry-After'); const seconds = Number(value);
  if (value && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = value ? Date.parse(value) : NaN;
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return 60;
}
function upstreamUnavailable(response: Response): ApiError {
  return new ApiError(502, 'routing_unavailable', '経路を計算できませんでした。', response.status === 429 || response.status >= 500, retryAfterSeconds(response));
}
async function withTimeout(fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetcher(url, { ...init, signal: controller.signal }); }
  catch (error) { if ((error as Error)?.name === 'AbortError') throw new ApiError(504, 'routing_timeout', '経路計算がタイムアウトしました。', true); throw error; }
  finally { clearTimeout(timer); }
}

export async function calculateRoute(input: RoutingInput, apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = 8000): Promise<RoutingResult> {
  const locationResolution = { before: 'user_coordinates' as const, after: 'user_coordinates' as const };
  const options = input.condition === 'local_roads' ? { avoid_features: ['highways'] } : undefined;
  let response: Response;
  try {
    response = await withTimeout(fetcher, ORS_DIRECTIONS_URL, { method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[input.before.longitude, input.before.latitude], [input.after.longitude, input.after.latitude]], ...(options ? { options } : {}) }) }, timeoutMs);
    if (!response.ok) throw upstreamUnavailable(response);
    const json = await response.json() as { routes?: Array<{ summary?: { distance?: number; duration?: number } }> };
    const summary = json.routes?.[0]?.summary;
    if (!summary || !Number.isFinite(summary.distance) || !Number.isFinite(summary.duration)) throw new ApiError(502, 'routing_invalid_response', '経路を計算できませんでした。', true);
    return { status: 'ok', provider: 'openrouteservice', routingPolicyVersion: ROUTING_POLICY_VERSION, condition: input.condition,
      distanceMeters: summary.distance!, durationSeconds: summary.duration!, locationResolution, confidence: 'exact' };
  } catch (error) {
    if (error instanceof Error) (error as RoutingFailure).locationResolution = locationResolution;
    throw error;
  }
}
