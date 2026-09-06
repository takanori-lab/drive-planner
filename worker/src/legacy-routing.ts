import { ApiError } from './errors';
import { resolveGoogleMapsUrl } from './google-maps';
import { geocodePlace, ORS_GEOCODE_URL, type GeocodingMethod } from './geocoding';
import type { PlaceInput } from './validation';

export const LEGACY_ROUTING_POLICY_VERSION = 'ors-v2';
export const ORS_DIRECTIONS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/json';
export { ORS_GEOCODE_URL };
export type RouteCondition = 'recommended' | 'local_roads';
export type ResolutionMethod = 'google_maps_coordinates' | GeocodingMethod | 'unresolved';
export interface LegacyRoutingInput { requestId: string; condition: RouteCondition; before: PlaceInput; after: PlaceInput }
export interface ResolvedLocation { longitude: number; latitude: number; method: ResolutionMethod; confidence: 'exact' | 'approximate' }
export interface RoutingResult { status: 'ok'; provider: 'openrouteservice'; routingPolicyVersion: string; condition: RouteCondition; distanceMeters: number; durationSeconds: number; locationResolution: { before: ResolutionMethod; after: ResolutionMethod }; confidence: 'exact' | 'approximate' }
export interface UnresolvedRoutingResult { status: 'unresolved'; provider: 'openrouteservice'; routingPolicyVersion: string; unresolved: ('before'|'after')[]; locationResolution: { before: ResolutionMethod; after: ResolutionMethod } }
export type LocationResolution = RoutingResult['locationResolution'];
export type RoutingFailure = Error & { locationResolution?: LocationResolution };

function retryAfterSeconds(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const value = response.headers.get('Retry-After');
  const seconds = Number(value);
  if (value && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = value ? Date.parse(value) : NaN;
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return 60;
}

function upstreamUnavailable(response: Response, message: string): ApiError {
  const retryable = response.status === 429 || response.status >= 500;
  return new ApiError(502, 'routing_unavailable', message, retryable, retryAfterSeconds(response));
}

async function withTimeout(fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetcher(url, { ...init, signal: controller.signal }); }
  catch (error) { if ((error as Error)?.name === 'AbortError') throw new ApiError(504, 'routing_timeout', '経路計算がタイムアウトしました。', true); throw error; }
  finally { clearTimeout(timer); }
}

export async function resolveLocation(place: PlaceInput, apiKey: string, fetcher: typeof fetch, deadline: number): Promise<ResolvedLocation | null> {
  let searchText = place.name.trim();
  let canonicalName = place.name.trim();
  let method: 'place_geocoding' | 'google_maps_query_geocoding' = 'place_geocoding';
  if (place.googleMapsUrl) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new ApiError(504, 'routing_timeout', '経路計算がタイムアウトしました。', true);
    const resolved = await resolveGoogleMapsUrl(place.googleMapsUrl, fetcher, Math.min(remainingMs, 3000));
    if (resolved?.latitude !== undefined && resolved.longitude !== undefined) return { latitude: resolved.latitude, longitude: resolved.longitude, method: 'google_maps_coordinates', confidence: 'exact' };
    const mapsSearchText = resolved?.label || resolved?.query;
    if (mapsSearchText) {
      // A query-only Maps URL describes the destination more accurately than a
      // user-facing alias, so use it for both lookup and result validation.
      canonicalName = mapsSearchText.trim();
      searchText = mapsSearchText.trim();
      method = 'google_maps_query_geocoding';
    }
  }
  if (!searchText || !canonicalName) return null;
  return geocodePlace({ searchText, canonicalName, locationNote: place.locationNote }, method, apiKey,
    (url, init, remainingMs) => withTimeout(fetcher, url, init, remainingMs), deadline);
}

export async function calculateLegacyRoute(input: LegacyRoutingInput, apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = 8000): Promise<RoutingResult | UnresolvedRoutingResult> {
  const deadline = Date.now() + timeoutMs;
  const [beforeResult, afterResult] = await Promise.allSettled([
    resolveLocation(input.before, apiKey, fetcher, deadline),
    resolveLocation(input.after, apiKey, fetcher, deadline),
  ]);
  const before = beforeResult.status === 'fulfilled' ? beforeResult.value : null;
  const after = afterResult.status === 'fulfilled' ? afterResult.value : null;
  const geocodingFailure = beforeResult.status === 'rejected' ? beforeResult.reason
    : afterResult.status === 'rejected' ? afterResult.reason : undefined;
  if (geocodingFailure !== undefined) {
    if (geocodingFailure instanceof Error) (geocodingFailure as RoutingFailure).locationResolution = {
      before: before?.method ?? 'unresolved',
      after: after?.method ?? 'unresolved',
    };
    throw geocodingFailure;
  }
  if (!before || !after) return { status: 'unresolved', provider: 'openrouteservice', routingPolicyVersion: LEGACY_ROUTING_POLICY_VERSION, unresolved: [...(!before ? ['before' as const] : []), ...(!after ? ['after' as const] : [])],
    locationResolution: { before: before?.method ?? 'unresolved', after: after?.method ?? 'unresolved' } };
  const options = input.condition === 'local_roads' ? { avoid_features: ['highways'] } : undefined;
  const locationResolution = { before: before.method, after: after.method };
  let summary: { distance?: number; duration?: number } | undefined;
  try {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new ApiError(504, 'routing_timeout', '経路計算がタイムアウトしました。', true);
    const response = await withTimeout(fetcher, ORS_DIRECTIONS_URL, { method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ coordinates: [[before.longitude, before.latitude], [after.longitude, after.latitude]], ...(options ? { options } : {}) }) }, remainingMs);
    if (!response.ok) throw upstreamUnavailable(response, '経路を計算できませんでした。');
    const json = await response.json() as { routes?: Array<{ summary?: { distance?: number; duration?: number } }> };
    summary = json.routes?.[0]?.summary;
    if (!summary || !Number.isFinite(summary.distance) || !Number.isFinite(summary.duration)) throw new ApiError(502, 'routing_invalid_response', '経路を計算できませんでした。', true);
  } catch (error) {
    if (error instanceof Error) (error as RoutingFailure).locationResolution = locationResolution;
    throw error;
  }
  return { status: 'ok', provider: 'openrouteservice', routingPolicyVersion: LEGACY_ROUTING_POLICY_VERSION, condition: input.condition,
    distanceMeters: summary.distance!, durationSeconds: summary.duration!, locationResolution,
    confidence: before.confidence === 'exact' && after.confidence === 'exact' ? 'exact' : 'approximate' };
}
