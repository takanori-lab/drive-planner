import { ApiError } from './errors';
import type { RoutingRequest } from './validation';

export const ROUTING_POLICY_VERSION = 'ors-v2';
export const ORS_DIRECTIONS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson';
export type RouteCondition = 'recommended' | 'local_roads';
export type ResolutionMethod = 'user_coordinates';
export type RoutingInput = RoutingRequest;
export interface RouteGeometry { type: 'LineString'; coordinates: [number, number][] }
export interface RoutingResult { status: 'ok'; provider: 'openrouteservice'; routingPolicyVersion: string; condition: RouteCondition; distanceMeters: number; durationSeconds: number; geometry?: RouteGeometry; majorRoads: string[]; locationResolution: { before: ResolutionMethod; after: ResolutionMethod }; confidence: 'exact' }
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

function normalizeGeometry(value: unknown): RouteGeometry | undefined {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'LineString') return undefined;
  const coordinates = (value as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2
    || !coordinates.every((coordinate) => Array.isArray(coordinate) && coordinate.length === 2
      && coordinate.every((number) => Number.isFinite(number))
      && Math.abs(coordinate[0] as number) <= 180 && Math.abs(coordinate[1] as number) <= 90)) return undefined;
  return { type: 'LineString', coordinates: coordinates as [number, number][] };
}

function extractMajorRoads(segments: unknown, routeDistance: number): string[] {
  if (!Array.isArray(segments) || !segments.every((segment) => segment && typeof segment === 'object'
    && Array.isArray((segment as { steps?: unknown }).steps))) return [];
  const roads = new Map<string, { distance: number; first: number }>();
  let order = 0;
  for (const segment of segments) {
    for (const step of (segment as { steps: unknown[] }).steps) {
      if (!step || typeof step !== 'object') continue;
      const { name, distance } = step as { name?: unknown; distance?: unknown };
      if (typeof name !== 'string' || !Number.isFinite(distance) || (distance as number) < 0) continue;
      const normalizedName = name.trim().replace(/\s+/gu, ' ');
      if (!normalizedName || normalizedName === '-') continue;
      const existing = roads.get(normalizedName);
      if (existing) existing.distance += distance as number;
      else roads.set(normalizedName, { distance: distance as number, first: order });
      order += 1;
    }
  }
  const threshold = Math.min(1000, routeDistance * 0.05);
  return [...roads.entries()]
    .filter(([, road]) => road.distance >= threshold)
    .sort((a, b) => b[1].distance - a[1].distance || a[1].first - b[1].first)
    .slice(0, 5)
    .sort((a, b) => a[1].first - b[1].first)
    .map(([name]) => name);
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
    const json = await response.json() as { features?: Array<{ properties?: { summary?: { distance?: number; duration?: number }; segments?: unknown }; geometry?: unknown }> };
    const feature = json.features?.[0];
    const summary = feature?.properties?.summary;
    if (!summary || !Number.isFinite(summary.distance) || !Number.isFinite(summary.duration)) throw new ApiError(502, 'routing_invalid_response', '経路を計算できませんでした。', true);
    const geometry = normalizeGeometry(feature?.geometry);
    return { status: 'ok', provider: 'openrouteservice', routingPolicyVersion: ROUTING_POLICY_VERSION, condition: input.condition,
      distanceMeters: summary.distance!, durationSeconds: summary.duration!, ...(geometry ? { geometry } : {}),
      majorRoads: extractMajorRoads(feature?.properties?.segments, summary.distance!), locationResolution, confidence: 'exact' };
  } catch (error) {
    if (error instanceof Error) (error as RoutingFailure).locationResolution = locationResolution;
    throw error;
  }
}
