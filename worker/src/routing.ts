import { ApiError } from './errors';
import { resolveGoogleMapsUrl } from './google-maps';
import type { PlaceInput } from './validation';

export const ROUTING_POLICY_VERSION = 'ors-v1';
export const ORS_DIRECTIONS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/json';
export const ORS_GEOCODE_URL = 'https://api.heigit.org/pelias/v1/search';
export type RouteCondition = 'recommended' | 'local_roads';
export type ResolutionMethod = 'google_maps_coordinates' | 'google_maps_query_geocoding' | 'place_geocoding';
export interface RoutingInput { requestId: string; condition: RouteCondition; before: PlaceInput; after: PlaceInput }
export interface ResolvedLocation { longitude: number; latitude: number; method: ResolutionMethod; confidence: 'exact' | 'approximate' }
export interface RoutingResult { status: 'ok'; provider: 'openrouteservice'; routingPolicyVersion: string; condition: RouteCondition; distanceMeters: number; durationSeconds: number; locationResolution: { before: ResolutionMethod; after: ResolutionMethod }; confidence: 'exact' | 'approximate' }

async function withTimeout(fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetcher(url, { ...init, signal: controller.signal }); }
  catch (error) { if ((error as Error)?.name === 'AbortError') throw new ApiError(504, 'routing_timeout', '経路計算がタイムアウトしました。', true); throw error; }
  finally { clearTimeout(timer); }
}

export async function resolveLocation(place: PlaceInput, apiKey: string, fetcher: typeof fetch, timeoutMs: number): Promise<ResolvedLocation | null> {
  let query = '';
  if (place.googleMapsUrl) {
    const resolved = await resolveGoogleMapsUrl(place.googleMapsUrl, fetcher, Math.min(timeoutMs, 3000));
    if (resolved?.latitude !== undefined && resolved.longitude !== undefined) return { latitude: resolved.latitude, longitude: resolved.longitude, method: 'google_maps_coordinates', confidence: 'exact' };
    query = resolved?.query || resolved?.label || '';
  }
  const method: ResolutionMethod = query ? 'google_maps_query_geocoding' : 'place_geocoding';
  if (!query) query = [place.name, place.locationNote].filter(Boolean).join(' ').trim();
  if (!query) return null;
  const url = new URL(ORS_GEOCODE_URL); url.searchParams.set('text', query); url.searchParams.set('size', '1'); url.searchParams.set('boundary.country', 'JP');
  const response = await withTimeout(fetcher, url.href, { headers: { Authorization: apiKey } }, timeoutMs);
  if (!response.ok) throw new ApiError(502, 'routing_unavailable', '地点を特定できませんでした。', true);
  const json = await response.json() as { features?: Array<{ geometry?: { coordinates?: number[] }; properties?: { confidence?: number } }> };
  const feature = json.features?.[0]; const coordinates = feature?.geometry?.coordinates;
  if (!coordinates || coordinates.length < 2 || !coordinates.every(Number.isFinite)) return null;
  return { longitude: coordinates[0], latitude: coordinates[1], method, confidence: (feature?.properties?.confidence ?? 0) >= 0.8 ? 'exact' : 'approximate' };
}

export async function calculateRoute(input: RoutingInput, apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = 8000): Promise<RoutingResult | { status: 'unresolved'; provider: 'openrouteservice'; routingPolicyVersion: string; unresolved: ('before'|'after')[] }> {
  const [before, after] = await Promise.all([resolveLocation(input.before, apiKey, fetcher, timeoutMs), resolveLocation(input.after, apiKey, fetcher, timeoutMs)]);
  if (!before || !after) return { status: 'unresolved', provider: 'openrouteservice', routingPolicyVersion: ROUTING_POLICY_VERSION, unresolved: [...(!before ? ['before' as const] : []), ...(!after ? ['after' as const] : [])] };
  const options = input.condition === 'local_roads' ? { avoid_features: ['highways'] } : undefined;
  const response = await withTimeout(fetcher, ORS_DIRECTIONS_URL, { method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ coordinates: [[before.longitude, before.latitude], [after.longitude, after.latitude]], ...(options ? { options } : {}) }) }, timeoutMs);
  if (!response.ok) throw new ApiError(502, 'routing_unavailable', '経路を計算できませんでした。', true);
  const json = await response.json() as { routes?: Array<{ summary?: { distance?: number; duration?: number } }> }; const summary = json.routes?.[0]?.summary;
  if (!summary || !Number.isFinite(summary.distance) || !Number.isFinite(summary.duration)) throw new ApiError(502, 'routing_invalid_response', '経路を計算できませんでした。', true);
  return { status: 'ok', provider: 'openrouteservice', routingPolicyVersion: ROUTING_POLICY_VERSION, condition: input.condition,
    distanceMeters: summary.distance!, durationSeconds: summary.duration!, locationResolution: { before: before.method, after: after.method },
    confidence: before.confidence === 'exact' && after.confidence === 'exact' ? 'exact' : 'approximate' };
}
