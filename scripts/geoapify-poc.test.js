import { describe, expect, it, vi } from 'vitest'
import { createMarkdown, normalizeFeature, RequestPacer, requestGeoapify, runCases } from './geoapify-poc-lib.mjs'

const feature = { properties: { name: '東京駅', formatted: '日本、東京都千代田区 東京駅', state: '東京都', city: '千代田区', lat: 35.681, lon: 139.767, result_type: 'amenity', category: 'public_transport.train', place_id: 'provider-id' } }

describe('Geoapify PoC', () => {
  it('レスポンスから候補項目を安全に抽出する', () => {
    expect(normalizeFeature(feature)).toMatchObject({ name: '東京駅', prefecture: '東京都', city: '千代田区', latitude: 35.681, placeId: 'provider-id' })
    expect(normalizeFeature({ geometry: { coordinates: [139, 35] } })).toMatchObject({ name: '', latitude: 35, longitude: 139 })
  })

  it('APIキーを結果やエラーへ含めない', async () => {
    const key = 'VERY_SECRET_KEY'
    const fetchImpl = vi.fn(async url => { throw new Error(`failed: ${url}`) })
    const result = await requestGeoapify({ query: '東京駅', apiKey: key, fetchImpl })
    expect(JSON.stringify(result)).not.toContain(key)
    expect(result.error).toContain('[REDACTED]')
  })

  it('0件とAPIエラーでも結果を返す', async () => {
    const empty = await requestGeoapify({ query: 'なし', apiKey: 'secret', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ features: [] }) }) })
    const failed = await requestGeoapify({ query: '失敗', apiKey: 'secret', fetchImpl: async () => ({ ok: false, status: 500 }) })
    expect(empty).toMatchObject({ count: 0, status: 200, error: null })
    expect(failed).toMatchObject({ count: 0, status: 500, error: 'Geoapify returned HTTP 500' })
  })

  it('候補詳細を含むMarkdownを生成する', () => {
    const result = { query: '東京駅', api: 'search', request: { lang: 'ja' }, count: 1, candidates: [normalizeFeature(feature)], durationMs: 12, status: 200, error: null }
    const markdown = createMarkdown([result], [{ category: '基本駅', query: '東京駅', expected: ['東京駅'] }], '2026-09-06T00:00:00Z')
    expect(markdown).toContain('期待候補順位（補助）')
    expect(markdown).toContain('| 1 | 東京駅 |')
    expect(markdown).toContain('人間が確認')
  })

  it('共有pacerでrequest間隔を適用する', async () => {
    let clock = 1000
    const starts = []
    const sleep = vi.fn(async ms => { clock += ms })
    const pacer = new RequestPacer({ intervalMs: 250, now: () => clock, sleep })
    const fetchImpl = vi.fn(async () => {
      starts.push(clock)
      return { ok: true, status: 200, json: async () => ({ features: [] }) }
    })
    await requestGeoapify({ query: '東京駅', apiKey: 'secret', fetchImpl, pacer })
    await requestGeoapify({ query: '千葉駅', apiKey: 'secret', fetchImpl, pacer })
    expect(starts).toEqual([1000, 1250])
    expect(sleep).toHaveBeenCalledWith(250)
  })

  it('429のRetry-Afterを尊重してbounded retryする', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '2' } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ features: [feature] }) })
    const result = await requestGeoapify({ query: '東京駅', apiKey: 'secret', fetchImpl, sleep })
    expect(sleep).toHaveBeenCalledWith(2000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 200, count: 1, rateLimitRetries: 1, error: null })
  })

  it('retry上限後はrate limit errorを記録し後続ケースを継続する', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '0' } })
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '0' } })
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '0' } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ features: [feature] }) })
    const results = await runCases({
      cases: [{ query: '制限対象', expected: [] }, { query: '後続', expected: [] }], apiKey: 'secret', fetchImpl,
      pacer: new RequestPacer({ intervalMs: 0 }),
    })
    expect(results[0]).toMatchObject({ status: 429, count: 0, rateLimitRetries: 2 })
    expect(results[0].error).toContain('rate limit')
    expect(results[1]).toMatchObject({ status: 200, count: 1, error: null })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })
})
