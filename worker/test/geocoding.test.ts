import { describe, expect, it, vi } from 'vitest';
import { geocodePlace, MAX_GEOCODING_REQUESTS, ORS_GEOCODE_URL, ORS_STRUCTURED_GEOCODE_URL } from '../src/geocoding';

const feature = (name: string, longitude: number, latitude: number, properties = {}) => ({
  geometry: { coordinates: [longitude, latitude] },
  properties: { name, label: name, confidence: 0.9, layer: 'venue', ...properties },
});
const response = (...features: ReturnType<typeof feature>[]) => Response.json({ features });

describe('ORS/Pelias地点解決fallback', () => {
  it('通常検索で成功したら追加fallbackを呼ばない', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(feature('東京駅', 139.767, 35.681)));
    await expect(geocodePlace('東京駅', '', 'place_geocoding', 'key', fetcher)).resolves.toMatchObject({
      method: 'place_geocoding', longitude: 139.767,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toContain(ORS_GEOCODE_URL);
  });

  it.each([
    ['千葉駅', '千葉県千葉市中央区', 140.113, 35.613],
    ['勝浦駅', '千葉県勝浦市', 140.312, 35.153],
  ])('%sは通常検索0件の後にname-only fallbackで地域に合う候補を解決する', async (name, note, longitude, latitude) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(
        feature(name, 135, 34, { label: `${name}, 大阪府`, region: '大阪府', locality: '大阪市' }),
        feature(name, longitude, latitude, { label: `${name}, ${note}`, region: '千葉県', locality: note.includes('勝浦') ? '勝浦市' : '千葉市中央区' }),
      ));
    await expect(geocodePlace(name, note, 'place_geocoding', 'key', fetcher)).resolves.toMatchObject({
      method: 'name_only_geocoding', longitude, latitude,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('text')).toBe(name);
  });

  it('name-onlyで誤った地域の候補しかなければstructured検索後もunresolvedにする', async () => {
    const wrong = feature('勝浦駅', 134.5, 34.2, { label: '勝浦駅, 徳島県', region: '徳島県', locality: '徳島市' });
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response(wrong)).mockResolvedValueOnce(response(wrong));
    await expect(geocodePlace('勝浦駅', '千葉県勝浦市', 'place_geocoding', 'key', fetcher)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(MAX_GEOCODING_REQUESTS);
    const structured = new URL(fetcher.mock.calls[2][0]);
    expect(`${structured.origin}${structured.pathname}`).toBe(ORS_STRUCTURED_GEOCODE_URL);
    expect(structured.searchParams.get('venue')).toBe('勝浦駅');
    expect(structured.searchParams.get('region')).toBe('千葉県');
    expect(structured.searchParams.get('locality')).toBe('勝浦市');
  });

  it('地点名のみでも通常検索0件ならstructuredを1回だけ試す', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response(feature('河口湖', 138.769, 35.498)));
    await expect(geocodePlace('河口湖', '', 'place_geocoding', 'key', fetcher)).resolves.toMatchObject({ method: 'structured_geocoding' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('confidence不足・地点名不一致の候補は採用しない', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(feature('千葉駅', 140, 35, { confidence: 0.4 })))
      .mockResolvedValueOnce(response(feature('千葉寺駅', 140, 35, { region: '千葉県', locality: '千葉市中央区' })))
      .mockResolvedValueOnce(response());
    await expect(geocodePlace('千葉駅', '千葉県千葉市中央区', 'place_geocoding', 'key', fetcher)).resolves.toBeNull();
  });

  it('HTTP retry対象エラーは検索条件fallbackへ進めずそのまま伝播する', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    await expect(geocodePlace('千葉駅', '千葉県千葉市', 'place_geocoding', 'key', fetcher)).rejects.toMatchObject({ retryable: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
