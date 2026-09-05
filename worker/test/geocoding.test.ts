import { describe, expect, it, vi } from 'vitest';
import { geocodePlace, MAX_GEOCODING_REQUESTS, ORS_STRUCTURED_GEOCODE_URL } from '../src/geocoding';

const feature = (name: string, longitude: number, latitude: number, properties = {}) => ({
  geometry: { coordinates: [longitude, latitude] },
  properties: { name, label: name, confidence: 0.9, layer: 'venue', ...properties },
});
const response = (...features: ReturnType<typeof feature>[]) => Response.json({ features });
const geocode = (searchText: string, canonicalName = searchText, locationNote = '') => ({ searchText, canonicalName, locationNote });
const run = (input: ReturnType<typeof geocode>, fetcher: any, deadline = Date.now() + 8_000, now?: () => number) =>
  geocodePlace(input, 'place_geocoding', 'key', fetcher, deadline, now);

describe('ORS/Pelias地点解決fallback', () => {
  it('通常検索で成功したら追加fallbackを呼ばない', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(feature('東京駅', 139.767, 35.681)));
    await expect(run(geocode('東京駅'), fetcher)).resolves.toMatchObject({ method: 'place_geocoding', longitude: 139.767 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['千葉駅', '千葉県千葉市中央区', 140.113, 35.613],
    ['勝浦駅', '千葉県勝浦市', 140.312, 35.153],
  ])('%sは通常検索0件の後にname-only fallbackで都道府県に合う候補を解決する', async (name, note, longitude, latitude) => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response(
      feature(name, 135, 34, { label: `${name}, 大阪府`, region: '大阪府' }),
      feature(name, longitude, latitude, { label: `${name}, 千葉県`, region: '千葉県' }),
    ));
    await expect(run(geocode(name, name, note), fetcher)).resolves.toMatchObject({ method: 'name_only_geocoding', longitude, latitude });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    '京都府京都市', '東京都千代田区', '千葉県千葉市中央区', '山梨県南都留郡富士河口湖町', '三重県四日市市',
    '長野県大町市', '千葉県市川市市川1丁目', '福島県郡山市', '愛知県蒲郡市', '奈良県大和郡山市',
    '兵庫県姫路市市之郷町', '駅前の市営駐車場',
  ])('locationNote「%s」を市区町村の必須条件として解釈しない', async (note) => {
    const prefecture = ['京都府', '東京都', '千葉県', '山梨県', '三重県', '長野県', '福島県', '愛知県', '奈良県', '兵庫県'].find((value) => note.includes(value));
    const fetcher = vi.fn().mockResolvedValue(response(feature('目的地', 139, 35, prefecture ? { region: prefecture } : {})));
    await expect(run(geocode('目的地', '目的地', note), fetcher)).resolves.toMatchObject({ method: 'place_geocoding' });
  });

  it('同名候補は結果順やconfidenceだけで選ばず、都道府県で一意なら解決する', async () => {
    const tokyo = feature('府中駅', 139.477, 35.672, { region: '東京都', confidence: 0.85 });
    const hiroshima = feature('府中駅', 133.236, 34.568, { region: '広島県', confidence: 0.95 });
    const ambiguous = vi.fn().mockImplementation(async () => response(tokyo, hiroshima));
    await expect(run(geocode('府中駅'), ambiguous)).resolves.toBeNull();
    expect(ambiguous).toHaveBeenCalledOnce();

    const contextual = vi.fn().mockImplementation(async () => response(tokyo, hiroshima));
    await expect(run(geocode('府中駅', '府中駅', '東京都'), contextual)).resolves.toMatchObject({ longitude: 139.477 });
    expect(contextual).toHaveBeenCalledOnce();
  });

  it.each([
    ['東京駅', feature('東京駅ホテル', 139, 35)],
    ['勝浦駅', feature('勝浦', 140, 35, { layer: 'locality' })],
    ['東京駅', feature('東京駅', 139, 35, { confidence: 0.4 })],
  ])('%sに対する別地点・confidence不足を採用しない', async (name, wrong) => {
    const fetcher = vi.fn().mockImplementation(async () => response(wrong));
    await expect(run(geocode(name), fetcher)).resolves.toBeNull();
  });

  it('長音記号を意味のある文字として維持して地点名を完全一致判定する', async () => {
    const wrong = vi.fn().mockImplementation(async () => response(feature('スパ', 139, 35)));
    await expect(run(geocode('スーパー'), wrong)).resolves.toBeNull();

    const exact = vi.fn().mockResolvedValue(response(feature('スーパー', 139, 35)));
    await expect(run(geocode('スーパー'), exact)).resolves.toMatchObject({ longitude: 139, latitude: 35 });
    expect(exact).toHaveBeenCalledOnce();
  });

  it('structured fallbackは都道府県だけを地域構造として送る', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response());
    await expect(run(geocode('勝浦駅', '勝浦駅', '千葉県勝浦市'), fetcher)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(MAX_GEOCODING_REQUESTS);
    const structured = new URL(String(fetcher.mock.calls.at(-1)![0]));
    expect(`${structured.origin}${structured.pathname}`).toBe(ORS_STRUCTURED_GEOCODE_URL);
    expect(structured.searchParams.get('region')).toBe('千葉県');
    expect(structured.searchParams.has('county')).toBe(false);
    expect(structured.searchParams.has('locality')).toBe(false);
    expect(structured.searchParams.has('borough')).toBe(false);
  });

  it('fallback全体でdeadlineを共有し、期限後は次のrequestを開始しない', async () => {
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(200);
    const fetcher = vi.fn().mockResolvedValue(response());
    await expect(run(geocode('千葉駅', '千葉駅', '千葉県'), fetcher, 150, now)).rejects.toMatchObject({ code: 'routing_timeout' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][2]).toBe(50);
  });

  it('HTTP retry対象エラーは検索条件fallbackへ進めず伝播する', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    await expect(run(geocode('千葉駅', '千葉駅', '千葉県'), fetcher)).rejects.toMatchObject({ retryable: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
