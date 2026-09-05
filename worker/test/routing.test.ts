import { describe, expect, it, vi } from 'vitest';
import { calculateRoute, ORS_DIRECTIONS_URL } from '../src/routing';

const place = (name: string, googleMapsUrl = '') => ({ name, googleMapsUrl, locationNote: '', memo: '' });
const input = (condition: 'recommended'|'local_roads' = 'recommended') => ({ requestId: 'route-1', condition, before: place('東京駅'), after: place('河口湖駅') });
const geocode = (longitude: number, latitude: number, name = longitude < 139 ? '河口湖駅' : '東京駅', properties = {}) => Response.json({ features: [{ geometry: { coordinates: [longitude, latitude] }, properties: { name, label: name, layer: 'venue', confidence: 0.9, ...properties } }] });
const directions = () => Response.json({ routes: [{ summary: { distance: 132800, duration: 6300 } }] });
const routeFetcher = (beforeName = '東京駅') => vi.fn(async (request: URL | RequestInfo) => {
  const url = String(request);
  if (url === ORS_DIRECTIONS_URL) return directions();
  const text = new URL(url).searchParams.get('text') ?? '';
  return text.includes(beforeName) ? geocode(139.767, 35.681, beforeName) : geocode(138.769, 35.498, '河口湖駅');
});

describe('openrouteservice routing provider', () => {
  it.each([['recommended', undefined], ['local_roads', { avoid_features: ['highways'] }]] as const)('%sのrequestを生成しresponseをnormalizeする', async (condition, options) => {
    const fetcher = vi.fn().mockResolvedValueOnce(geocode(139.767, 35.681)).mockResolvedValueOnce(geocode(138.769, 35.498)).mockResolvedValueOnce(directions());
    const result = await calculateRoute(input(condition), 'dummy-test-key', fetcher);
    expect(result).toMatchObject({ status: 'ok', provider: 'openrouteservice', routingPolicyVersion: 'ors-v2', distanceMeters: 132800, durationSeconds: 6300 });
    const [url, init] = fetcher.mock.calls[2]; expect(url).toBe(ORS_DIRECTIONS_URL); expect(init.headers.Authorization).toBe('dummy-test-key');
    expect(JSON.parse(init.body)).toEqual({ coordinates: [[139.767, 35.681], [138.769, 35.498]], ...(options ? { options } : {}) });
  });
  it('Google Maps URLの座標を優先してgeocodingを省略する', async () => {
    const target = input(); target.before.googleMapsUrl = 'https://www.google.com/maps?q=35.681%2C139.767'; target.after.googleMapsUrl = 'https://www.google.com/maps?query=35.498%2C138.769';
    const fetcher = vi.fn().mockResolvedValue(directions()); const result = await calculateRoute(target, 'dummy', fetcher);
    expect(fetcher).toHaveBeenCalledOnce(); expect(result).toMatchObject({ locationResolution: { before: 'google_maps_coordinates', after: 'google_maps_coordinates' } });
  });
  it('Google Mapsの表示中心ではなくplace名をgeocodingする', async () => {
    const target = input(); target.before.googleMapsUrl = 'https://www.google.com/maps/place/%E6%9D%B1%E4%BA%AC%E9%A7%85/@35.0,139.0,15z';
    const fetcher = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = String(input);
      if (url === ORS_DIRECTIONS_URL) return directions();
      return new URL(url).searchParams.get('text') === '東京駅' ? geocode(139.767, 35.681) : geocode(138.769, 35.498);
    });
    const result = await calculateRoute(target, 'dummy', fetcher);
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).searchParams.get('text') === '東京駅')).toBe(true);
    const directionsCall = fetcher.mock.calls.find(([url]) => String(url) === ORS_DIRECTIONS_URL)!;
    expect(JSON.parse(directionsCall[1]!.body as string).coordinates[0]).toEqual([139.767, 35.681]);
    expect(result).toMatchObject({ locationResolution: { before: 'google_maps_query_geocoding' } });
  });
  it('URLのlabelからgeocodingへfallbackする', async () => {
    const target = input(); target.before.googleMapsUrl = 'https://www.google.com/maps/place/%E6%9D%B1%E4%BA%AC%E9%A7%85'; target.before.locationNote = '丸の内口';
    const fetcher = routeFetcher();
    const result = await calculateRoute(target, 'dummy', fetcher);
    const requestedUrls = fetcher.mock.calls.slice(0, 2).map(([url]) => new URL(String(url)));
    const geocodeUrl = requestedUrls.find((url) => url.searchParams.get('text') === '東京駅 丸の内口');
    expect(geocodeUrl).toBeDefined();
    expect(geocodeUrl!.origin).toBe('https://api.heigit.org');
    expect(geocodeUrl!.pathname).toBe('/pelias/v1/search');
    expect(geocodeUrl!.searchParams.get('text')).toBe('東京駅 丸の内口');
    expect(geocodeUrl!.searchParams.get('size')).toBe('5');
    expect(geocodeUrl!.searchParams.get('boundary.country')).toBe('JP');
    expect(result).toMatchObject({ locationResolution: { before: 'google_maps_query_geocoding' } });
  });
  it('display nameではなくMaps labelをcanonical nameとして検証する', async () => {
    const target = input(); target.before.name = '集合場所';
    target.before.googleMapsUrl = 'https://www.google.com/maps/place/%E6%9D%B1%E4%BA%AC%E9%A7%85?query=%E6%96%B0%E5%AE%BF%E9%A7%85';
    const fetcher = routeFetcher();
    const result = await calculateRoute(target, 'dummy', fetcher);
    expect(fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url !== ORS_DIRECTIONS_URL)
      .map((url) => new URL(url).searchParams.get('text'))).toContain('東京駅');
    expect(result).toMatchObject({ status: 'ok', locationResolution: { before: 'google_maps_query_geocoding' } });
  });
  it('qualified queryは検索に使うがfeature名の完全一致条件には使わない', async () => {
    const target = input(); target.before.googleMapsUrl = 'https://www.google.com/maps?query=%E6%9D%B1%E4%BA%AC%E9%A7%85%20%E6%9D%B1%E4%BA%AC%E9%83%BD%E5%8D%83%E4%BB%A3%E7%94%B0%E5%8C%BA';
    const fetcher = vi.fn(async (request: URL | RequestInfo) => {
      const url = String(request);
      if (url === ORS_DIRECTIONS_URL) return directions();
      const text = new URL(url).searchParams.get('text') ?? '';
      return text.includes('東京駅')
        ? geocode(139.767, 35.681, '東京駅', { region: '東京都' })
        : geocode(138.769, 35.498, '河口湖駅');
    });
    await expect(calculateRoute(target, 'dummy', fetcher)).resolves.toMatchObject({ status: 'ok' });
    expect(fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url !== ORS_DIRECTIONS_URL)
      .map((url) => new URL(url).searchParams.get('text'))).toContain('東京駅 東京都千代田区');
  });
  it('query-only Maps URLはdisplay aliasではなくqueryで検証する', async () => {
    const target = input(); target.before.name = '集合場所';
    target.before.googleMapsUrl = 'https://www.google.com/maps?query=%E6%9D%B1%E4%BA%AC%E9%A7%85';
    const fetcher = routeFetcher();
    await expect(calculateRoute(target, 'dummy', fetcher)).resolves.toMatchObject({
      status: 'ok', locationResolution: { before: 'google_maps_query_geocoding' },
    });
  });
  it('Maps URLを解決できない場合は通常place geocodingとして扱う', async () => {
    const target = input(); target.before.googleMapsUrl = 'https://example.com/not-maps';
    const fetcher = routeFetcher();
    await expect(calculateRoute(target, 'dummy', fetcher)).resolves.toMatchObject({ locationResolution: { before: 'place_geocoding' } });
  });
  it('URLのテキストqueryにlocationNoteを加えてgeocodingする', async () => {
    const target = input(); target.before.googleMapsUrl = 'https://www.google.com/maps?query=%E3%82%B9%E3%82%BF%E3%83%BC%E3%83%90%E3%83%83%E3%82%AF%E3%82%B9'; target.before.locationNote = '渋谷駅周辺';
    const fetcher = routeFetcher('スターバックス');
    await calculateRoute(target, 'dummy', fetcher);
    const geocodeQueries = fetcher.mock.calls.slice(0, 2).map(([url]) => new URL(String(url)).searchParams.get('text'));
    expect(geocodeQueries).toContain('スターバックス 渋谷駅周辺');
  });
  it('地点を解決できなければrouteを生成しない', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ features: [] })); expect(await calculateRoute(input(), 'dummy', fetcher)).toMatchObject({ status: 'unresolved', unresolved: ['before', 'after'], locationResolution: { before: 'unresolved', after: 'unresolved' } });
  });
  it('ORS errorとtimeoutを安全なerrorにする', async () => {
    await expect(calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(new Response('', { status: 503 })))).rejects.toMatchObject({ code: 'routing_unavailable' });
    const timeout = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })))));
    await expect(calculateRoute(input(), 'dummy', timeout as any, 1)).rejects.toMatchObject({ code: 'routing_timeout' });
  });
  it.each([
    [400, false], [401, false], [429, true], [503, true],
  ])('directionsのHTTP %iをretryable=%sに分類する', async (status, retryable) => {
    const target = input();
    target.before.googleMapsUrl = 'https://www.google.com/maps?q=35.681%2C139.767';
    target.after.googleMapsUrl = 'https://www.google.com/maps?q=35.498%2C138.769';
    await expect(calculateRoute(target, 'dummy', vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toMatchObject({
      code: 'routing_unavailable', retryable,
    });
  });
  it('ORSの429待機時間を伝播し、ヘッダーがなければ60秒にする', async () => {
    const target = input();
    target.before.googleMapsUrl = 'https://www.google.com/maps?q=35.681%2C139.767';
    target.after.googleMapsUrl = 'https://www.google.com/maps?q=35.498%2C138.769';
    await expect(calculateRoute(target, 'dummy', vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '120' } })))).rejects.toMatchObject({ retryAfterSeconds: 120 });
    await expect(calculateRoute(target, 'dummy', vi.fn().mockResolvedValue(new Response('', { status: 429 })))).rejects.toMatchObject({ retryAfterSeconds: 60 });
  });
  it.each([[400, false], [503, true]])('geocodingのHTTP %iをretryable=%sに分類する', async (status, retryable) => {
    await expect(calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toMatchObject({
      code: 'routing_unavailable', retryable,
    });
  });
});
