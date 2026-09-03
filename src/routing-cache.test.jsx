import { expect, it, vi } from 'vitest';
import { cachedRouteRequest } from './App';

it('成功結果は再利用し、一時的なerrorは次の機会に再試行する', async () => {
  const cache = new Map();
  const successful = vi.fn(async () => ({ status: 'ok', distanceMeters: 1000 }));
  await cachedRouteRequest(cache, 'success', successful);
  await cachedRouteRequest(cache, 'success', successful);
  expect(successful).toHaveBeenCalledOnce();

  const transient = vi.fn()
    .mockResolvedValueOnce({ status: 'error' })
    .mockResolvedValueOnce({ status: 'ok', distanceMeters: 2000 });
  expect(await cachedRouteRequest(cache, 'retry', transient)).toEqual({ status: 'error' });
  expect(await cachedRouteRequest(cache, 'retry', transient)).toMatchObject({ status: 'ok' });
  expect(transient).toHaveBeenCalledTimes(2);
});
