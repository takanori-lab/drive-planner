import { expect, it, vi } from 'vitest';
import { cachedRouteRequest, formatDistance, formatDuration, requestRouteWithRetry } from './App';
import { WorkerApiError } from './api';

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

it('一時的なroutingエラーだけを上限付きで自動再試行する', async () => {
  const sleep = vi.fn(async () => undefined);
  const request = vi.fn()
    .mockRejectedValueOnce(new WorkerApiError(429, 'rate_limited', true))
    .mockRejectedValueOnce(new WorkerApiError(503, 'routing_unavailable', true))
    .mockResolvedValueOnce({ status: 'ok', distanceMeters: 2000 });
  await expect(requestRouteWithRetry(request, sleep)).resolves.toMatchObject({ status: 'ok' });
  expect(request).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenNthCalledWith(1, 1000);
  expect(sleep).toHaveBeenNthCalledWith(2, 3000);

  const rateLimited = vi.fn()
    .mockRejectedValueOnce(new WorkerApiError(429, 'rate_limited', true, 60_000))
    .mockResolvedValueOnce({ status: 'ok' });
  await expect(requestRouteWithRetry(rateLimited, sleep)).resolves.toMatchObject({ status: 'ok' });
  expect(sleep).toHaveBeenLastCalledWith(60_000);

  const permanent = vi.fn().mockRejectedValue(new WorkerApiError(400, 'invalid_request', false));
  await expect(requestRouteWithRetry(permanent, sleep)).resolves.toEqual({ status: 'error' });
  expect(permanent).toHaveBeenCalledOnce();
});

it('短い距離と時間をゼロに丸めず表示する', () => {
  expect(formatDistance(499)).toBe('499 m');
  expect(formatDistance(1250)).toBe('1.3 km');
  expect(formatDuration(30)).toBe('1分未満');
  expect(formatDuration(60)).toBe('1分');
});
