import { ApiError } from './errors';

export const ORS_GEOCODE_URL = 'https://api.heigit.org/pelias/v1/search';
export const ORS_STRUCTURED_GEOCODE_URL = 'https://api.heigit.org/pelias/v1/search/structured';
export const MAX_GEOCODING_REQUESTS = 3;

export type GeocodingMethod = 'place_geocoding' | 'google_maps_query_geocoding' | 'name_only_geocoding' | 'structured_geocoding';
export interface GeocodedLocation { longitude: number; latitude: number; method: GeocodingMethod; confidence: 'exact' | 'approximate' }
export interface GeocodingInput { searchText: string; canonicalName: string; locationNote: string }

interface Feature {
  geometry?: { coordinates?: number[] };
  properties?: {
    confidence?: number; name?: string; label?: string; layer?: string;
    region?: string; region_a?: string;
  };
}

interface SearchStep { method: GeocodingMethod; structured: boolean; params: Record<string, string> }

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県',
  '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県',
  '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県',
  '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県',
  '鹿児島県', '沖縄県',
] as const;
const ACCEPTED_LAYERS = new Set(['venue', 'address', 'street', 'station', 'locality', 'neighbourhood']);
const normalize = (value = '') => value.normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s　・･,，.。\-ー_()（）]/g, '');
const explicitPrefecture = (note: string) => PREFECTURES.find((prefecture) => note.includes(prefecture));

function chooseFeature(features: Feature[], canonicalName: string, prefecture?: string): { feature?: Feature; ambiguous: boolean } {
  const wantedName = normalize(canonicalName);
  const candidates = features.filter((feature) => {
    const properties = feature.properties ?? {};
    const coordinates = feature.geometry?.coordinates;
    if (!coordinates || coordinates.length < 2 || !coordinates.every(Number.isFinite)) return false;
    if ((properties.confidence ?? 0) < 0.7) return false;
    if (normalize(properties.name) !== wantedName) return false;
    if (properties.layer && !ACCEPTED_LAYERS.has(properties.layer)) return false;
    if (prefecture) {
      const regionText = normalize([properties.region, properties.region_a, properties.label].filter(Boolean).join(' '));
      if (!regionText.includes(normalize(prefecture))) return false;
    }
    return true;
  });
  // Result order and confidence do not safely disambiguate identically named places.
  return { ...(candidates.length === 1 ? { feature: candidates[0] } : {}), ambiguous: candidates.length > 1 };
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
  input: GeocodingInput,
  normalMethod: 'place_geocoding' | 'google_maps_query_geocoding',
  apiKey: string,
  request: (url: string, init: RequestInit, remainingMs: number) => Promise<Response>,
  deadline: number,
  now: () => number = Date.now,
): Promise<GeocodedLocation | null> {
  const searchText = input.searchText.trim();
  const canonicalName = input.canonicalName.trim();
  const locationNote = input.locationNote.trim();
  if (!searchText || !canonicalName) return null;
  const prefecture = explicitPrefecture(locationNote);
  const normalText = [searchText, locationNote].filter(Boolean).join(' ');
  const steps: SearchStep[] = [{ method: normalMethod, structured: false, params: { text: normalText } }];
  if (normalText !== canonicalName) steps.push({ method: 'name_only_geocoding', structured: false, params: { text: canonicalName } });
  steps.push({ method: 'structured_geocoding', structured: true, params: {
    venue: canonicalName, ...(prefecture ? { region: prefecture } : {}), country: '日本',
  } });

  for (const step of steps.slice(0, MAX_GEOCODING_REQUESTS)) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new ApiError(504, 'routing_timeout', '経路計算がタイムアウトしました。', true);
    const url = new URL(step.structured ? ORS_STRUCTURED_GEOCODE_URL : ORS_GEOCODE_URL);
    for (const [key, value] of Object.entries(step.params)) url.searchParams.set(key, value);
    url.searchParams.set('size', '5');
    url.searchParams.set('boundary.country', 'JP');
    const response = await request(url.href, { headers: { Authorization: apiKey } }, remainingMs);
    if (!response.ok) throw responseError(response);
    const json = await response.json() as { features?: Feature[] };
    const selection = chooseFeature(json.features ?? [], canonicalName, prefecture);
    if (selection.ambiguous) return null;
    const feature = selection.feature;
    if (!feature) continue;
    const coordinates = feature.geometry!.coordinates!;
    return { longitude: coordinates[0], latitude: coordinates[1], method: step.method,
      confidence: (feature.properties?.confidence ?? 0) >= 0.8 ? 'exact' : 'approximate' };
  }
  return null;
}
