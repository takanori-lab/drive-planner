import { describe, expect, it, vi } from 'vitest';
import { calculateRoute, ORS_DIRECTIONS_URL } from '../src/routing';

const place = (name: string, googleMapsUrl = '') => ({ name, googleMapsUrl, locationNote: '', memo: '' });
const input = (condition: 'recommended'|'local_roads' = 'recommended') => ({ requestId: 'route-1', condition, before: place('東京駅'), after: place('河口湖駅') });
const geocode = (longitude: number, latitude: number) => Response.json({ features: [{ geometry: { coordinates: [longitude, latitude] }, properties: { confidence: 0.9 } }] });
const directions = () => Response.json({ routes: [{ summary: { distance: 132800, duration: 6300 } }] });

describe('openrouteservice routing provider', () => {
  it.each([['recommended', undefined], ['local_roads', { avoid_features: ['highways'] }]] as const)('%sのrequestを生成しresponseをnormalizeする', async (condition, options) => {
    const fetcher = vi.fn().mockResolvedValueOnce(geocode(139.767, 35.681)).mockResolvedValueOnce(geocode(138.769, 35.498)).mockResolvedValueOnce(directions());
    const result = await calculateRoute(input(condition), 'dummy-test-key', fetcher);
    expect(result).toMatchObject({ status: 'ok', provider: 'openrouteservice', routingPolicyVersion: 'ors-v1', distanceMeters: 132800, durationSeconds: 6300 });
    const [url, init] = fetcher.mock.calls[2]; expect(url).toBe(ORS_DIRECTIONS_URL); expect(init.headers.Authorization).toBe('dummy-test-key');
    expect(JSON.parse(init.body)).toEqual({ coordinates: [[139.767, 35.681], [138.769, 35.498]], ...(options ? { options } : {}) });
  });
  it('Google Maps URLの座標を優先してgeocodingを省略する', async () => {
    const target = input(); target.before.googleMapsUrl = 'https://www.google.com/maps/@35.681,139.767,15z'; target.after.googleMapsUrl = 'https://www.google.com/maps/@35.498,138.769,15z';
    const fetcher = vi.fn().mockResolvedValue(directions()); const result = await calculateRoute(target, 'dummy', fetcher);
    expect(fetcher).toHaveBeenCalledOnce(); expect(result).toMatchObject({ locationResolution: { before: 'google_maps_coordinates', after: 'google_maps_coordinates' } });
  });
  it('URLのlabelからgeocodingへfallbackする', async () => {
    const target = input(); target.before.googleMapsUrl = 'https://www.google.com/maps/place/%E6%9D%B1%E4%BA%AC%E9%A7%85';
    const fetcher = vi.fn().mockResolvedValueOnce(geocode(139, 35)).mockResolvedValueOnce(geocode(138, 35)).mockResolvedValueOnce(directions());
    const result = await calculateRoute(target, 'dummy', fetcher);
    const requestedUrls = fetcher.mock.calls.slice(0, 2).map(([url]) => new URL(url));
    const geocodeUrl = requestedUrls.find((url) => url.searchParams.get('text') === '東京駅');
    expect(geocodeUrl).toBeDefined();
    expect(geocodeUrl!.origin).toBe('https://api.heigit.org');
    expect(geocodeUrl!.pathname).toBe('/pelias/v1/search');
    expect(geocodeUrl!.searchParams.get('text')).toBe('東京駅');
    expect(geocodeUrl!.searchParams.get('size')).toBe('1');
    expect(geocodeUrl!.searchParams.get('boundary.country')).toBe('JP');
    expect(result).toMatchObject({ locationResolution: { before: 'google_maps_query_geocoding' } });
  });
  it('地点を解決できなければrouteを生成しない', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ features: [] })); expect(await calculateRoute(input(), 'dummy', fetcher)).toMatchObject({ status: 'unresolved', unresolved: ['before', 'after'] });
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
    target.before.googleMapsUrl = 'https://www.google.com/maps/@35.681,139.767,15z';
    target.after.googleMapsUrl = 'https://www.google.com/maps/@35.498,138.769,15z';
    await expect(calculateRoute(target, 'dummy', vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toMatchObject({
      code: 'routing_unavailable', retryable,
    });
  });
  it('ORSの429待機時間を伝播し、ヘッダーがなければ60秒にする', async () => {
    const target = input();
    target.before.googleMapsUrl = 'https://www.google.com/maps/@35.681,139.767,15z';
    target.after.googleMapsUrl = 'https://www.google.com/maps/@35.498,138.769,15z';
    await expect(calculateRoute(target, 'dummy', vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '120' } })))).rejects.toMatchObject({ retryAfterSeconds: 120 });
    await expect(calculateRoute(target, 'dummy', vi.fn().mockResolvedValue(new Response('', { status: 429 })))).rejects.toMatchObject({ retryAfterSeconds: 60 });
  });
  it.each([[400, false], [503, true]])('geocodingのHTTP %iをretryable=%sに分類する', async (status, retryable) => {
    await expect(calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toMatchObject({
      code: 'routing_unavailable', retryable,
    });
  });
});
