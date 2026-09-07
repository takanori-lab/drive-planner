import { describe, expect, it, vi } from 'vitest';
import { calculateRoute, ORS_DIRECTIONS_URL } from '../src/routing';

const input = (condition: 'recommended'|'local_roads' = 'recommended') => ({ requestId: 'route-1', condition, before: { latitude: 35.681, longitude: 139.767 }, after: { latitude: 35.498, longitude: 138.769 } });
const directions = (overrides: Record<string, unknown> = {}) => Response.json({ features: [{
  properties: { summary: { distance: 132800, duration: 6300 }, segments: [], ...overrides.properties as object },
  geometry: { type: 'LineString', coordinates: [[139.767, 35.681], [138.769, 35.498]] },
  ...overrides,
}] });

describe('openrouteservice routing provider', () => {
  it.each([['recommended', undefined], ['local_roads', { avoid_features: ['highways'] }]] as const)('%sのユーザー座標を直接ORSへ渡す', async (condition, options) => {
    const fetcher = vi.fn().mockResolvedValue(directions());
    const result = await calculateRoute(input(condition), 'dummy-test-key', fetcher);
    expect(result).toMatchObject({ status: 'ok', provider: 'openrouteservice', routingPolicyVersion: 'ors-v2', distanceMeters: 132800, durationSeconds: 6300,
      geometry: { type: 'LineString', coordinates: [[139.767, 35.681], [138.769, 35.498]] }, majorRoads: [], confidence: 'exact', locationResolution: { before: 'user_coordinates', after: 'user_coordinates' } });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]; expect(url).toBe(ORS_DIRECTIONS_URL); expect(init.headers.Authorization).toBe('dummy-test-key');
    expect(JSON.parse(init.body)).toEqual({ coordinates: [[139.767, 35.681], [138.769, 35.498]], ...(options ? { options } : {}) });
  });
  it('step名を距離で選定し、空白正規化・同名合算後に初出順で最大5件返す', async () => {
    const steps = [
      { name: '  First   Road ', distance: 600 }, { name: '', distance: 9999 }, { name: ' ', distance: 9999 }, { name: '-', distance: 9999 },
      { name: 'Second Road', distance: 1800 }, { name: 'First Road', distance: 500 }, { name: 'Third', distance: 1700 },
      { name: 'Fourth', distance: 1600 }, { name: 'Fifth', distance: 1500 }, { name: 'Sixth', distance: 1400 },
    ];
    const result = await calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(directions({
      properties: { summary: { distance: 20000, duration: 1000 }, segments: [{ steps }] },
    })));
    expect(result.majorRoads).toEqual(['Second Road', 'Third', 'Fourth', 'Fifth', 'Sixth']);
  });
  it.each([
    [10000, [{ name: '499m', distance: 499 }, { name: '500m', distance: 500 }], ['500m']],
    [100000, [{ name: '999m', distance: 999 }, { name: '1000m', distance: 1000 }], ['1000m']],
  ])('route距離%sではmin(1000m, 5%%)を閾値にする', async (distance, steps, expected) => {
    const result = await calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(directions({
      properties: { summary: { distance, duration: 1000 }, segments: [{ steps }] },
    })));
    expect(result.majorRoads).toEqual(expected);
  });
  it.each([
    ['geometry欠損', undefined],
    ['geometry型不正', { type: 'Point', coordinates: [139, 35] }],
    ['座標不正', { type: 'LineString', coordinates: [[139, 35], ['invalid', 36]] }],
    ['座標範囲外', { type: 'LineString', coordinates: [[139, 35], [181, 36]] }],
  ])('%sでも距離・時間を維持してgeometryだけ省略する', async (_label, geometry) => {
    const result = await calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(directions({ geometry })));
    expect(result).toMatchObject({ distanceMeters: 132800, durationSeconds: 6300, majorRoads: [] });
    expect(result).not.toHaveProperty('geometry');
  });
  it.each([undefined, null, {}, [{ steps: 'invalid' }]])('stepsが欠損・不正でも距離・時間を維持する', async (segments) => {
    const result = await calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(directions({
      properties: { summary: { distance: 132800, duration: 6300 }, segments },
    })));
    expect(result).toMatchObject({ distanceMeters: 132800, durationSeconds: 6300, majorRoads: [] });
  });
  it.each([[400, false], [401, false], [429, true], [503, true]])('Directions HTTP %sを安全に分類する', async (status, retryable) => {
    await expect(calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toMatchObject({ code: 'routing_unavailable', retryable, locationResolution: { before: 'user_coordinates', after: 'user_coordinates' } });
  });
  it('ORSの429待機時間を伝播する', async () => {
    await expect(calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '12' } })))).rejects.toMatchObject({ retryAfterSeconds: 12 });
  });
  it('不正responseを安全に拒否する', async () => {
    await expect(calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(Response.json({ features: [] })))).rejects.toMatchObject({ code: 'routing_invalid_response', locationResolution: { before: 'user_coordinates', after: 'user_coordinates' } });
  });
  it('timeoutを安全に拒否する', async () => {
    const fetcher = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any;
    await expect(calculateRoute(input(), 'dummy', fetcher, 1)).rejects.toMatchObject({ code: 'routing_timeout', retryable: true });
  });
});
