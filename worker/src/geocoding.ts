import { ApiError } from './errors';

export const ORS_GEOCODE_URL = 'https://api.heigit.org/pelias/v1/search';
export const ORS_STRUCTURED_GEOCODE_URL = 'https://api.heigit.org/pelias/v1/search/structured';
export const MAX_GEOCODING_REQUESTS = 3;

export type GeocodingMethod = 'place_geocoding' | 'google_maps_query_geocoding' | 'name_only_geocoding' | 'structured_geocoding';
export interface GeocodedLocation { longitude: number; latitude: number; method: GeocodingMethod; confidence: 'exact' | 'approximate' }

interface Feature {
  geometry?: { coordinates?: number[] };
  properties?: {
    confidence?: number; name?: string; label?: string; layer?: string;
    region?: string; region_a?: string; county?: string; locality?: string; borough?: string; neighbourhood?: string;
  };
}

interface SearchStep { method: GeocodingMethod; structured: boolean; params: Record<string, string> }

const PLACE_LAYERS = new Set(['venue', 'address', 'street', 'station', 'locality', 'neighbourhood']);
const normalize = (value = '') => value.normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s　・･,，.。\-ー_()（）]/g, '');

function contextParts(note: string): string[] {
  const parts = new Set<string>();
  for (const match of note.matchAll(/[^\s,，、]+?[都道府県]/g)) parts.add(match[0]);
  for (const match of note.matchAll(/[^\s,，、都道府県]+?(?:市|区|町|村)/g)) parts.add(match[0]);
  return [...parts].map(normalize).filter((part) => part.length >= 2);
}

function structuredContext(note: string): { region?: string; locality?: string } {
  const region = note.match(/[^\s,，、]+?[都道府県]/)?.[0];
  const locality = note.match(/(?:[都道府県])?([^\s,，、都道府県]+?(?:市|区|町|村))/)?.[1];
  return { region, locality };
}

function chooseFeature(features: Feature[], name: string, note: string, strictContext: boolean): Feature | undefined {
  const wantedName = normalize(name);
  const wantedContext = contextParts(note);
  return features
    .map((feature, index) => {
      const properties = feature.properties ?? {};
      const coordinates = feature.geometry?.coordinates;
      if (!coordinates || coordinates.length < 2 || !coordinates.every(Number.isFinite)) return null;
      const confidence = properties.confidence ?? 0;
      if (confidence < 0.7) return null;
      const candidateName = normalize(properties.name || properties.label);
      const nameMatches = !candidateName || candidateName.includes(wantedName) || wantedName.includes(candidateName);
      if (!nameMatches) return null;
      const contextText = normalize([properties.label, properties.region, properties.region_a, properties.county,
        properties.locality, properties.borough, properties.neighbourhood].filter(Boolean).join(' '));
      const matchingContext = wantedContext.filter((part) => contextText.includes(part)).length;
      if (strictContext && wantedContext.length > 0 && matchingContext !== wantedContext.length) return null;
      const placeBonus = !properties.layer || PLACE_LAYERS.has(properties.layer) ? 0.03 : -0.08;
      return { feature, score: confidence + (candidateName === wantedName ? 0.12 : 0.06) + matchingContext * 0.08 + placeBonus - index * 0.001 };
    })
    .filter((candidate): candidate is { feature: Feature; score: number } => candidate !== null)
    .sort((a, b) => b.score - a.score)[0]?.feature;
}

function responseError(response: Response): ApiError {
  const retryable = response.status === 429 || response.status >= 500;
  let retryAfterSeconds: number | undefined;
  if (response.status === 429) {
    const value = response.headers.get('Retry-After');
    const seconds = Number(value);
    if (value && Number.isFinite(seconds) && seconds >= 0) retryAfterSeconds = Math.ceil(seconds);
    else {
      const date = value ? Date.parse(value) : NaN;
      retryAfterSeconds = Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : 60;
    }
  }
  return new ApiError(502, 'routing_unavailable', '地点を特定できませんでした。', retryable, retryAfterSeconds);
}

export async function geocodePlace(
  name: string,
  locationNote: string,
  normalMethod: 'place_geocoding' | 'google_maps_query_geocoding',
  apiKey: string,
  request: (url: string, init: RequestInit) => Promise<Response>,
): Promise<GeocodedLocation | null> {
  const cleanName = name.trim();
  const cleanNote = locationNote.trim();
  if (!cleanName) return null;
  const normalText = [cleanName, cleanNote].filter(Boolean).join(' ');
  const steps: SearchStep[] = [{ method: normalMethod, structured: false, params: { text: normalText } }];
  if (cleanNote) steps.push({ method: 'name_only_geocoding', structured: false, params: { text: cleanName } });
  {
    const context = structuredContext(cleanNote);
    steps.push({ method: 'structured_geocoding', structured: true, params: {
      venue: cleanName, ...(context.region ? { region: context.region } : {}),
      ...(context.locality ? { locality: context.locality } : {}), country: '日本',
    } });
  }

  for (const step of steps.slice(0, MAX_GEOCODING_REQUESTS)) {
    const url = new URL(step.structured ? ORS_STRUCTURED_GEOCODE_URL : ORS_GEOCODE_URL);
    for (const [key, value] of Object.entries(step.params)) url.searchParams.set(key, value);
    url.searchParams.set('size', '5');
    url.searchParams.set('boundary.country', 'JP');
    const response = await request(url.href, { headers: { Authorization: apiKey } });
    if (!response.ok) throw responseError(response);
    const json = await response.json() as { features?: Feature[] };
    const feature = chooseFeature(json.features ?? [], cleanName, cleanNote, contextParts(cleanNote).length > 0);
    if (!feature) continue;
    const coordinates = feature.geometry!.coordinates!;
    return { longitude: coordinates[0], latitude: coordinates[1], method: step.method,
      confidence: (feature.properties?.confidence ?? 0) >= 0.8 ? 'exact' : 'approximate' };
  }
  return null;
}
