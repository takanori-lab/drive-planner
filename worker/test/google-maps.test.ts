import { describe, expect, it, vi } from 'vitest';
import { extractGoogleMapsPlace, resolveGoogleMapsUrl, resolveRequestGoogleMaps } from '../src/google-maps';
import type { SegmentCandidatesRequest } from '../src/validation';

const input = (url = ''): SegmentCandidatesRequest => ({
  requestId: '00000000-0000-4000-8000-000000000001',
  plan: { title: '', date: '', mainPoint: { name: 'MAIN', googleMapsUrl: url, locationNote: '', memo: '' } },
  segment: {
    before: { name: 'A', googleMapsUrl: url, locationNote: '', memo: '' },
    after: { name: 'B', googleMapsUrl: '', locationNote: '', memo: '' },
  },
  existingCandidates: [], preferences: { freeText: '', useWebSearch: false },
});

describe('Google Maps共有URL解決', () => {
  it('短縮URLのredirectを手動で追い、最終URLからplace名を抽出する', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://goo.gl/maps/next' } }))
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: 'https://www.google.com/maps/place/%E6%B9%96%E7%95%94%E3%81%AE%E3%83%91%E3%83%B3%E5%B1%8B/@35.5,138.7,15z' } }));
    await expect(resolveGoogleMapsUrl('https://maps.app.goo.gl/abc', fetcher)).resolves.toEqual({
      label: '湖畔のパン屋', resolvedUrl: 'https://www.google.com/maps/place/%E6%B9%96%E7%95%94%E3%81%AE%E3%83%91%E3%83%B3%E5%B1%8B/@35.5,138.7,15z',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(options).not.toHaveProperty('headers');
    }
  });

  it('許可されていない初期hostとredirect先をfetchしない', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://google.com.example.com/maps/place/secret' } }));
    await expect(resolveGoogleMapsUrl('https://evil-google.com/maps', fetcher)).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(resolveGoogleMapsUrl('https://maps.app.goo.gl/abc', fetcher)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('redirect上限を適用する', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://maps.app.goo.gl/again' } }));
    await expect(resolveGoogleMapsUrl('https://maps.app.goo.gl/start', fetcher, 3_000, 2)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('timeout時は失敗としてfallbackできる', async () => {
    const fetcher = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await expect(resolveGoogleMapsUrl('https://maps.app.goo.gl/slow', fetcher, 1)).resolves.toBeNull();
  });

  it('完全URLのplace、query、座標を本文fetchなしで解析する', async () => {
    expect(extractGoogleMapsPlace('https://www.google.com/maps/place/Tokyo+Station')).toMatchObject({ label: 'Tokyo Station' });
    expect(extractGoogleMapsPlace('https://maps.google.com/maps?query=%E6%B2%B3%E5%8F%A3%E6%B9%96')).toMatchObject({ query: '河口湖' });
    expect(extractGoogleMapsPlace('https://google.com/maps?q=35.1%2C139.2')).toMatchObject({ latitude: 35.1, longitude: 139.2 });
    const fetcher = vi.fn();
    await resolveGoogleMapsUrl('https://www.google.com/maps/place/Tokyo', fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('表示中心の@座標を目的地座標として扱わない', () => {
    expect(extractGoogleMapsPlace('https://www.google.com/maps/place/Tokyo+Station/@35.1,139.2,15z')).toMatchObject({ label: 'Tokyo Station' });
    expect(extractGoogleMapsPlace('https://www.google.com/maps/place/Tokyo+Station/@35.1,139.2,15z')).not.toMatchObject({
      latitude: expect.any(Number), longitude: expect.any(Number),
    });
  });

  it('範囲外の座標は採用しない', () => {
    expect(extractGoogleMapsPlace('https://www.google.com/maps?q=91%2C181')).not.toMatchObject({ latitude: expect.any(Number), longitude: expect.any(Number) });
  });

  it('同じURLを重複fetchせず、URLがなければfetchしない', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://www.google.com/maps/place/Test' } }));
    const context = await resolveRequestGoogleMaps(input('https://maps.app.goo.gl/same'), fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(context['segment.before']).toMatchObject({ label: 'Test' });
    expect(context['plan.mainPoint']).toMatchObject({ label: 'Test' });
    fetcher.mockClear();
    await resolveRequestGoogleMaps(input(), fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
