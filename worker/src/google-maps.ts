import type { SegmentCandidatesRequest } from './validation';

export const GOOGLE_MAPS_TIMEOUT_MS = 3_000;
export const GOOGLE_MAPS_MAX_REDIRECTS = 5;

export type ResolvedGoogleMapsPlace = {
  label?: string;
  query?: string;
  latitude?: number;
  longitude?: number;
  resolvedUrl: string;
};

export type ResolvedGoogleMapsContext = Partial<Record<'segment.before' | 'segment.after' | 'plan.mainPoint', ResolvedGoogleMapsPlace>>;

function validGoogleMapsUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'maps.app.goo.gl') return url.pathname.length > 1;
  if (url.hostname === 'goo.gl') return url.pathname === '/maps' || url.pathname.startsWith('/maps/');
  if (url.hostname === 'maps.google.com') return url.pathname === '/' || url.pathname.startsWith('/maps');
  return (url.hostname === 'google.com' || url.hostname === 'www.google.com')
    && (url.pathname === '/maps' || url.pathname.startsWith('/maps/'));
}

function parseAllowedUrl(value: string, base?: URL): URL | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return validGoogleMapsUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function needsRedirectResolution(url: URL): boolean {
  return url.hostname === 'maps.app.goo.gl' || url.hostname === 'goo.gl';
}

function coordinate(value: string | null, min: number, max: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : undefined;
}

export function extractGoogleMapsPlace(value: string): ResolvedGoogleMapsPlace | null {
  const url = parseAllowedUrl(value);
  if (!url) return null;
  const placeMatch = url.pathname.match(/\/place\/([^/]+)/u);
  let label: string | undefined;
  if (placeMatch) {
    try { label = decodeURIComponent(placeMatch[1].replaceAll('+', ' ')).trim() || undefined; } catch { /* 不正なencodingを推測しない */ }
  }
  const queryValue = url.searchParams.get('query') ?? url.searchParams.get('q');
  const query = queryValue?.trim() || undefined;
  const queryCoordinates = query?.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/u);
  // `/@lat,long,zoom` is the map viewport center, not necessarily the selected
  // place. Only coordinates supplied as the explicit Maps query identify the
  // destination closely enough to bypass geocoding.
  const latitude = coordinate(queryCoordinates?.[1] ?? null, -90, 90);
  const longitude = coordinate(queryCoordinates?.[2] ?? null, -180, 180);
  return { ...(label ? { label } : {}), ...(query ? { query } : {}),
    ...(latitude !== undefined && longitude !== undefined ? { latitude, longitude } : {}), resolvedUrl: url.href };
}

export async function resolveGoogleMapsUrl(
  value: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = GOOGLE_MAPS_TIMEOUT_MS,
  maxRedirects = GOOGLE_MAPS_MAX_REDIRECTS,
): Promise<ResolvedGoogleMapsPlace | null> {
  const initial = parseAllowedUrl(value);
  if (!initial) return null;
  let current: URL = initial;
  if (!needsRedirectResolution(current)) return extractGoogleMapsPlace(current.href);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const response = await fetcher(current.href, { method: 'GET', redirect: 'manual', signal: controller.signal });
      if (response.status < 300 || response.status >= 400) return response.ok ? extractGoogleMapsPlace(current.href) : null;
      if (redirects === maxRedirects) return null;
      const location = response.headers.get('Location');
      const next: URL | null = location ? parseAllowedUrl(location, current) : null;
      if (!next) return null;
      current = next;
      if (!needsRedirectResolution(current)) return extractGoogleMapsPlace(current.href);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
  return null;
}

export async function resolveRequestGoogleMaps(
  input: SegmentCandidatesRequest,
  fetcher: typeof fetch = fetch,
  timeoutMs = GOOGLE_MAPS_TIMEOUT_MS,
): Promise<ResolvedGoogleMapsContext> {
  const places = [
    ['segment.before', input.segment.before],
    ['segment.after', input.segment.after],
    ['plan.mainPoint', input.plan.mainPoint],
  ] as const;
  const cache = new Map<string, Promise<ResolvedGoogleMapsPlace | null>>();
  const resolved = await Promise.all(places.map(async ([role, place]) => {
    const url = place.googleMapsUrl.trim();
    if (!url) return [role, null] as const;
    let pending = cache.get(url);
    if (!pending) {
      pending = resolveGoogleMapsUrl(url, fetcher, timeoutMs);
      cache.set(url, pending);
    }
    return [role, await pending] as const;
  }));
  return Object.fromEntries(resolved.filter((entry): entry is [typeof entry[0], ResolvedGoogleMapsPlace] => entry[1] !== null));
}
