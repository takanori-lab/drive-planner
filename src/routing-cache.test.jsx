import { expect, it, vi } from 'vitest';
import { abortRouteRequests, cachedRouteRequest, formatDistance, formatDuration, requestRouteWithRetry } from './App';
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

  const upstreamRateLimited = vi.fn()
    .mockRejectedValueOnce(new WorkerApiError(502, 'routing_unavailable', true, 60_000))
    .mockResolvedValueOnce({ status: 'ok' });
  await expect(requestRouteWithRetry(upstreamRateLimited, sleep)).resolves.toMatchObject({ status: 'ok' });
  expect(sleep).toHaveBeenLastCalledWith(60_000);

  const permanent = vi.fn().mockRejectedValue(new WorkerApiError(400, 'invalid_request', false));
  await expect(requestRouteWithRetry(permanent, sleep)).resolves.toEqual({ status: 'error' });
  expect(permanent).toHaveBeenCalledOnce();
});

it('中止された待機後は古いルートを再試行しない', async () => {
  const controller = new AbortController();
  const request = vi.fn().mockRejectedValue(new WorkerApiError(502, 'routing_unavailable', true, 60_000));
  const sleep = vi.fn((_delay, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const pending = requestRouteWithRetry(request, sleep, controller.signal);
  controller.abort();
  await expect(pending).resolves.toMatchObject({ status: 'error', aborted: true });
  expect(request).toHaveBeenCalledOnce();
});

it('unmount時に中止済みrequestをcacheへ残さない', () => {
  const abort = vi.fn();
  const cache = new Map([['segment', Promise.resolve({ status: 'ok' })]]);
  const controllers = new Map([['segment', { abort }]]);

  abortRouteRequests(cache, controllers);

  expect(abort).toHaveBeenCalledOnce();
  expect(cache.size).toBe(0);
  expect(controllers.size).toBe(0);
});

it('短い距離と時間をゼロに丸めず表示する', () => {
  expect(formatDistance(499)).toBe('499 m');
  expect(formatDistance(1250)).toBe('1.3 km');
  expect(formatDuration(30)).toBe('1分未満');
  expect(formatDuration(60)).toBe('1分');
});
