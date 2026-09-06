import { describe, expect, it, vi } from 'vitest'
import { CASES, createMarkdown, findExpectedRank, normalizeFeature, RequestPacer, requestOrsPelias, runCases } from './ors-pelias-poc-lib.mjs'

const feature = { type: 'Feature', geometry: { coordinates: [139.767, 35.681] }, properties: { name: '東京駅', label: '東京駅, 千代田区, 東京都, 日本', street: '丸の内', housenumber: '1-9-1', region: '東京都', county: '千代田区', locality: '丸の内', layer: 'venue', source: 'openstreetmap', source_id: '123', gid: 'openstreetmap:venue:123', category: ['transport', 'train'], confidence: 0.9, match_type: 'exact' } }
const ok = features => ({ ok: true, status: 200, json: async () => ({ features }) })

describe('ORS/Pelias PoC', () => {
  it('Geoapify PoCと同じ22 queryを同じ順序で持つ', () => {
    expect(CASES).toHaveLength(22)
    expect(CASES.at(-2)).toMatchObject({ query: 'とうきょ', api: 'autocomplete' })
    expect(CASES.at(-1)).toMatchObject({ query: '三井アウトレット 木更', api: 'autocomplete' })
  })

  it('Pelias固有のlayer/source/categoryと座標をnormalizeする', () => {
    expect(normalizeFeature(feature)).toEqual({ name: '東京駅', label: '東京駅, 千代田区, 東京都, 日本', address: '1-9-1 丸の内', region: '東京都', county: '千代田区', locality: '丸の内', latitude: 35.681, longitude: 139.767, layer: 'venue', source: 'openstreetmap', category: 'transport, train', providerId: 'openstreetmap:venue:123', confidence: 0.9, matchType: 'exact' })
    expect(normalizeFeature({ properties: { category: 'station', source_id: 'fallback' } })).toMatchObject({ latitude: null, category: 'station', providerId: 'fallback' })
  })

  it.each(['search', 'autocomplete'])('%s responseをnormalizeする', async api => {
    const fetchImpl = vi.fn(async () => ok([feature]))
    const result = await requestOrsPelias({ query: '東京', api, apiKey: 'secret', fetchImpl })
    expect(result).toMatchObject({ api, status: 200, count: 1, error: null })
    expect(result.candidates[0]).toMatchObject({ layer: 'venue', source: 'openstreetmap' })
    expect(fetchImpl.mock.calls[0][0].pathname).toBe(`/geocode/${api}`)
  })

  it('0件とHTTP errorを結果にする', async () => {
    expect(await requestOrsPelias({ query: 'なし', apiKey: 'secret', fetchImpl: async () => ok([]) })).toMatchObject({ status: 200, count: 0, error: null })
    expect(await requestOrsPelias({ query: '失敗', apiKey: 'secret', fetchImpl: async () => ({ ok: false, status: 500 }) })).toMatchObject({ status: 500, count: 0, error: 'ORS/Pelias returned HTTP 500' })
  })

  it('API key未設定では外部通信せず、URLを含むerrorからraw/encoded keyを消す', async () => {
    const fetchImpl = vi.fn()
    const missing = await requestOrsPelias({ query: '東京駅', fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled(); expect(missing.error).toContain('未設定')
    const key = 'SECRET/+ KEY'
    const failed = await requestOrsPelias({ query: '東京駅', apiKey: key, fetchImpl: async url => { throw new Error(String(url)) } })
    expect(JSON.stringify(failed)).not.toContain(key)
    expect(JSON.stringify(failed)).not.toContain(encodeURIComponent(key))
    expect(failed.error).toContain('[REDACTED]')
  })

  it('pacingとtransport durationを分離する', async () => {
    const times = [10, 35]
    const result = await requestOrsPelias({ query: '東京駅', apiKey: 'secret', pacer: { wait: async () => 250 }, measureNow: () => times.shift(), fetchImpl: async () => ok([]) })
    expect(result).toMatchObject({ durationMs: 25, waitDurationMs: 250 })
  })

  it('429 Retry-Afterを尊重して再試行する', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '2' } }).mockResolvedValueOnce(ok([feature]))
    const result = await requestOrsPelias({ query: '東京駅', apiKey: 'secret', fetchImpl, sleep })
    expect(sleep).toHaveBeenCalledWith(2000); expect(result).toMatchObject({ status: 200, count: 1, rateLimitRetries: 1 })
  })

  it('最終429でもfallback cooldown後に後続ケースを実行する', async () => {
    let clock = 0
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } }).mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } }).mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } }).mockResolvedValueOnce(ok([feature]))
    const results = await runCases({ cases: [{ query: '制限', expected: [] }, { query: '後続', expected: [] }], apiKey: 'secret', fetchImpl, pacer: new RequestPacer({ intervalMs: 0 }), requestOptions: { sleep: async ms => { clock += ms }, now: () => clock } })
    expect(results[0]).toMatchObject({ status: 429, rateLimitRetries: 2, waitDurationMs: 6000 })
    expect(results[1]).toMatchObject({ status: 200, count: 1 })
  })

  it('timeoutとnetwork error後にも後続ケースを実行し古いstatusを残さない', async () => {
    const fetchImpl = vi.fn().mockImplementationOnce((_url, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))).mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(ok([feature]))
    const results = await runCases({ cases: [{ query: 'timeout' }, { query: 'network' }, { query: '後続' }], apiKey: 'secret', fetchImpl, pacer: new RequestPacer({ intervalMs: 0 }), requestOptions: { requestTimeoutMs: 5 } })
    expect(results[0].error.toLowerCase()).toContain('timeout')
    expect(results[1]).toMatchObject({ status: null, error: 'network down' })
    expect(results[2]).toMatchObject({ status: 200, count: 1 })
  })

  it('文字列補助判定はlabelと地域も対象にしAND/ORを区別する', () => {
    const candidates = [{ name: 'アウトレット', label: '三井アウトレットパーク', address: '', region: '千葉県', county: '', locality: '木更津市' }, { name: '海ほたる', label: '', address: '', region: '', county: '', locality: '' }]
    expect(findExpectedRank({ expected: ['三井アウトレットパーク', '木更津'] }, candidates)).toBe(1)
    expect(findExpectedRank({ expected: { any: ['海ほたるPA', '海ほたる'] } }, candidates)).toBe(2)
    expect(findExpectedRank({ expected: ['富士山', '山梨県'] }, candidates)).toBeNull()
  })

  it('人間確認に必要な候補metadataを含むreportを生成する', () => {
    const result = { query: '東京駅', api: 'search', request: { lang: 'ja' }, status: 200, durationMs: 12, waitDurationMs: 250, rateLimitRetries: 0, count: 1, candidates: [normalizeFeature(feature)], error: null }
    const markdown = createMarkdown([result], [{ category: '基本駅', query: '東京駅', expected: ['東京駅'] }], '2026-09-06T00:00:00Z')
    expect(markdown).toContain('自動補助順位'); expect(markdown).toContain('人間が確認')
    expect(markdown).toContain('openstreetmap:venue:123'); expect(markdown).not.toContain('api_key')
  })
})
