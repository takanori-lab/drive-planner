import { describe, expect, it, vi } from 'vitest'
import { createMarkdown, normalizeFeature, requestGeoapify } from './geoapify-poc-lib.mjs'

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
    const failed = await requestGeoapify({ query: '失敗', apiKey: 'secret', fetchImpl: async () => ({ ok: false, status: 429 }) })
    expect(empty).toMatchObject({ count: 0, status: 200, error: null })
    expect(failed).toMatchObject({ count: 0, status: 429, error: 'Geoapify returned HTTP 429' })
  })

  it('候補詳細を含むMarkdownを生成する', () => {
    const result = { query: '東京駅', api: 'search', request: { lang: 'ja' }, count: 1, candidates: [normalizeFeature(feature)], durationMs: 12, status: 200, error: null }
    const markdown = createMarkdown([result], [{ category: '基本駅', query: '東京駅', expected: ['東京駅'] }], '2026-09-06T00:00:00Z')
    expect(markdown).toContain('期待候補順位（補助）')
    expect(markdown).toContain('| 1 | 東京駅 |')
    expect(markdown).toContain('人間が確認')
  })
})
