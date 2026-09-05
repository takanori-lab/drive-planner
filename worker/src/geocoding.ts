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
const normalize = (value = '') => value.normalize('NFKC').toLocaleLowerCase('ja').replace(/[\s　・･,，.。\-_()（）]/g, '');

const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const;

const ADMIN_SUFFIXES = ['市', '区', '町', '村'] as const;

function municipalityPrefix(value: string): string | undefined {
  const endings = ADMIN_SUFFIXES.map((suffix) => ({ suffix, index: value.indexOf(suffix, 1) }));
  // A city name can contain 町/村 (大町市), and a city precedes its ward.
  // Prefer those structural terminators before considering a standalone town
  // or village suffix.
  const first = endings.find(({ suffix, index }) => suffix === '市' && index >= 1)
    ?? endings.find(({ suffix, index }) => suffix === '区' && index >= 1)
    ?? endings.filter(({ index }) => index >= 1).sort((a, b) => a.index - b.index)[0];
  if (!first) return undefined;
  let end = first.index + 1;
  const stem = value.slice(0, first.index);
  // Administrative suffix characters can themselves be the last character of
  // a name (四日市市). Do not extend when the following address instead repeats
  // the municipality stem (市川市市川1丁目).
  if (value[end] === first.suffix && !value.slice(end).startsWith(stem)) end += 1;
  return value.slice(0, end);
}

function administrativeParts(note: string): { region?: string; county?: string; localities: string[]; boroughs: string[] } {
  const region = PREFECTURES.find((prefecture) => note.includes(prefecture));
  const segments = (region ? note.slice(note.indexOf(region) + region.length) : note)
    .split(/[\s　,，、()（）]+/).filter(Boolean);
  const localities: string[] = [];
  const boroughs: string[] = [];
  let county: string | undefined;
  for (const segment of segments) {
    let remainder = segment;
    // A 郡 is a county only when it has a meaningful name and is followed by a
    // municipality. This prevents city names such as 郡山市 and 蒲郡市 from
    // being split merely because they contain the same suffix character.
    const countyEnd = remainder.indexOf('郡', 2);
    const possibleCounty = countyEnd >= 2 ? remainder.slice(0, countyEnd + 1) : undefined;
    if (possibleCounty && municipalityPrefix(remainder.slice(possibleCounty.length))) {
      county = possibleCounty;
      remainder = remainder.slice(possibleCounty.length);
    }
    while (remainder) {
      // Consume one typed administrative component at a time; the helper
      // distinguishes suffix characters inside a name from following address
      // text, and leaves a city ward for the next pass.
      const part = municipalityPrefix(remainder);
      if (!part) break;
      if (part.endsWith('区') && localities.some((locality) => locality.endsWith('市'))) boroughs.push(part);
      else localities.push(part);
      remainder = remainder.slice(part.length);
    }
  }
  return { region, county, localities, boroughs };
}

function contextParts(note: string): string[] {
  const { region, county, localities, boroughs } = administrativeParts(note);
  return [region, county, ...localities, ...boroughs].filter((part): part is string => Boolean(part)).map(normalize).filter((part) => part.length >= 2);
}

function structuredContext(note: string): { region?: string; county?: string; locality?: string; borough?: string } {
  const { region, county, localities, boroughs } = administrativeParts(note);
  return { region, county, locality: localities.join('') || undefined, borough: boroughs.join('') || undefined };
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
      // A related locality (for example, 勝浦 for 勝浦駅) is not a safe
      // substitute: it can place the route at a city centroid. When Pelias
      // supplies a feature name, require an exact normalized match.
      if (candidateName && candidateName !== wantedName) return null;
      const contextText = normalize([properties.label, properties.region, properties.region_a, properties.county,
        properties.locality, properties.borough, properties.neighbourhood].filter(Boolean).join(' '));
      const matchingContext = wantedContext.filter((part) => contextText.includes(part)).length;
      if (strictContext && wantedContext.length > 0 && matchingContext !== wantedContext.length) return null;
      const placeBonus = !properties.layer || PLACE_LAYERS.has(properties.layer) ? 0.03 : -0.08;
      return { feature, score: confidence + 0.06 + matchingContext * 0.08 + placeBonus - index * 0.001 };
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
  searchText: string,
  locationNote: string,
  normalMethod: 'place_geocoding' | 'google_maps_query_geocoding',
  apiKey: string,
  request: (url: string, init: RequestInit) => Promise<Response>,
  expectedName = searchText,
): Promise<GeocodedLocation | null> {
  const cleanName = searchText.trim();
  const cleanExpectedName = expectedName.trim();
  const cleanNote = locationNote.trim();
  if (!cleanName || !cleanExpectedName) return null;
  const normalText = [cleanName, cleanNote].filter(Boolean).join(' ');
  const steps: SearchStep[] = [{ method: normalMethod, structured: false, params: { text: normalText } }];
  if (cleanNote) steps.push({ method: 'name_only_geocoding', structured: false, params: { text: cleanExpectedName } });
  {
    const context = structuredContext(cleanNote);
    steps.push({ method: 'structured_geocoding', structured: true, params: {
      venue: cleanExpectedName, ...(context.region ? { region: context.region } : {}),
      ...(context.county ? { county: context.county } : {}),
      ...(context.locality ? { locality: context.locality } : {}), country: '日本',
      ...(context.borough ? { borough: context.borough } : {}),
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
    const feature = chooseFeature(json.features ?? [], cleanExpectedName, cleanNote, contextParts(cleanNote).length > 0);
    if (!feature) continue;
    const coordinates = feature.geometry!.coordinates!;
    return { longitude: coordinates[0], latitude: coordinates[1], method: step.method,
      confidence: (feature.properties?.confidence ?? 0) >= 0.8 ? 'exact' : 'approximate' };
  }
  return null;
}
