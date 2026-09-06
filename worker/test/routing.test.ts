import { describe, expect, it, vi } from 'vitest';
import { calculateRoute, ORS_DIRECTIONS_URL } from '../src/routing';

const input = (condition: 'recommended'|'local_roads' = 'recommended') => ({ requestId: 'route-1', condition, before: { latitude: 35.681, longitude: 139.767 }, after: { latitude: 35.498, longitude: 138.769 } });
const directions = () => Response.json({ routes: [{ summary: { distance: 132800, duration: 6300 } }] });

describe('openrouteservice routing provider', () => {
  it.each([['recommended', undefined], ['local_roads', { avoid_features: ['highways'] }]] as const)('%sのユーザー座標を直接ORSへ渡す', async (condition, options) => {
    const fetcher = vi.fn().mockResolvedValue(directions());
    const result = await calculateRoute(input(condition), 'dummy-test-key', fetcher);
    expect(result).toMatchObject({ status: 'ok', provider: 'openrouteservice', routingPolicyVersion: 'ors-v2', distanceMeters: 132800, durationSeconds: 6300, confidence: 'exact', locationResolution: { before: 'user_coordinates', after: 'user_coordinates' } });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]; expect(url).toBe(ORS_DIRECTIONS_URL); expect(init.headers.Authorization).toBe('dummy-test-key');
    expect(JSON.parse(init.body)).toEqual({ coordinates: [[139.767, 35.681], [138.769, 35.498]], ...(options ? { options } : {}) });
  });
  it.each([[400, false], [401, false], [429, true], [503, true]])('Directions HTTP %sを安全に分類する', async (status, retryable) => {
    await expect(calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(new Response('', { status })))).rejects.toMatchObject({ code: 'routing_unavailable', retryable, locationResolution: { before: 'user_coordinates', after: 'user_coordinates' } });
  });
  it('ORSの429待機時間を伝播する', async () => {
    await expect(calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '12' } })))).rejects.toMatchObject({ retryAfterSeconds: 12 });
  });
  it('不正responseを安全に拒否する', async () => {
    await expect(calculateRoute(input(), 'dummy', vi.fn().mockResolvedValue(Response.json({ routes: [] })))).rejects.toMatchObject({ code: 'routing_invalid_response', locationResolution: { before: 'user_coordinates', after: 'user_coordinates' } });
  });
  it('timeoutを安全に拒否する', async () => {
    const fetcher = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any;
    await expect(calculateRoute(input(), 'dummy', fetcher, 1)).rejects.toMatchObject({ code: 'routing_timeout', retryable: true });
  });
});
