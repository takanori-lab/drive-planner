import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const ORS_GEOCODE_BASE_URL = 'https://api.heigit.org/pelias/v1'
export const DEFAULT_REQUEST = Object.freeze({ lang: 'ja', 'boundary.country': 'JP', size: 5 })
export const REQUEST_INTERVAL_MS = 250
export const MAX_RATE_LIMIT_RETRIES = 2
export const REQUEST_TIMEOUT_MS = 10_000

export const CASES = Object.freeze([
  { category: '基本駅', query: '東京駅', expected: ['東京駅'] },
  { category: '基本駅', query: '千葉駅', expected: ['千葉駅'] },
  { category: '基本駅', query: '勝浦駅', expected: ['勝浦駅'], note: '千葉県勝浦市のJR勝浦駅かを地域・座標で確認' },
  { category: '基本駅', query: '新宿駅', expected: ['新宿駅'] },
  { category: '曖昧地点', query: '府中駅', expected: ['府中駅'], note: '地域情報で同名候補を区別できるか確認' },
  { category: '曖昧地点', query: '大宮駅', expected: ['大宮駅'], note: '埼玉・京都などを地域情報で区別できるか確認' },
  { category: '観光地・広域地点', query: '河口湖', expected: ['河口湖'] },
  { category: '観光地・広域地点', query: '富士山', expected: ['富士山'], note: '一般に目的地として想定する富士山かを地域・座標で確認' },
  { category: '観光地・広域地点', query: '大石公園', expected: ['大石公園'], note: '富士河口湖町の大石公園かを確認' },
  { category: '観光地・広域地点', query: '海ほたる', expected: ['海ほたる'] },
  { category: 'ドライブ向け施設', query: '道の駅どうし', expected: ['道の駅どうし'] },
  { category: 'ドライブ向け施設', query: '海ほたるPA', expected: { any: ['海ほたるPA', '海ほたるパーキングエリア', '海ほたる'] } },
  { category: 'ドライブ向け施設', query: '成田国際空港', expected: ['成田国際空港'] },
  { category: 'ドライブ向け施設', query: '三井アウトレットパーク 木更津', expected: ['三井アウトレットパーク', '木更津'] },
  { category: '店舗名', query: 'スターバックス コーヒー SHIBUYA TSUTAYA店', expected: ['スターバックス', 'SHIBUYA TSUTAYA'] },
  { category: '店舗名 + 地域名', query: 'コメダ珈琲店 本店 名古屋', expected: ['コメダ珈琲店', '本店'] },
  { category: '店舗名 + 地域名', query: 'さわやか 御殿場インター店', expected: ['さわやか', '御殿場インター'], note: 'その店舗そのものかを名称・地域・座標で確認' },
  { category: '日本語住所', query: '東京都千代田区丸の内1丁目9番1号', expected: ['東京駅', '丸の内'] },
  { category: '市区町村 + 地点名', query: '山梨県南都留郡富士河口湖町 大石公園', expected: ['大石公園'] },
  { category: '表記ゆれ', query: '海ほたるパーキングエリア', expected: { any: ['海ほたるパーキングエリア', '海ほたるPA', '海ほたる'] } },
  { category: '入力途中文字列', query: 'とうきょ', expected: ['東京'], api: 'autocomplete' },
  { category: '入力途中文字列', query: '三井アウトレット 木更', expected: ['三井アウトレット', '木更津'], api: 'autocomplete' },
])

const safeText = value => typeof value === 'string' ? value : ''
const finiteNumber = value => Number.isFinite(Number(value)) ? Number(value) : null
const textList = value => (Array.isArray(value) ? value : [value]).filter(x => typeof x === 'string').join(', ')

export function normalizeFeature(feature = {}) {
  const p = feature?.properties ?? {}
  const coordinates = feature?.geometry?.coordinates ?? []
  return {
    name: safeText(p.name), label: safeText(p.label),
    address: safeText(p.address || [p.housenumber, p.street].filter(Boolean).join(' ')),
    region: safeText(p.region), county: safeText(p.county), locality: safeText(p.locality || p.localadmin),
    latitude: finiteNumber(coordinates[1]), longitude: finiteNumber(coordinates[0]),
    layer: safeText(p.layer), source: safeText(p.source), category: textList(p.category),
    providerId: safeText(p.gid || p.source_id || p.id), confidence: finiteNumber(p.confidence),
    matchType: safeText(p.match_type),
  }
}

export function redactSecret(value, secret) {
  if (!secret || typeof value !== 'string') return value
  const encodedForms = [secret, encodeURIComponent(secret), new URLSearchParams({ value: secret }).get('value')]
  const redacted = encodedForms.reduce((text, token) => text.split(token).join('[REDACTED]'), value)
  return redacted.replace(/([?&]api_key=)[^&\s]*/gi, '$1[REDACTED]')
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class RequestPacer {
  constructor({ intervalMs = REQUEST_INTERVAL_MS, now = Date.now, sleep = defaultSleep } = {}) {
    this.intervalMs = intervalMs; this.now = now; this.sleep = sleep; this.nextRequestAt = 0
  }
  async wait() {
    const delayMs = Math.max(0, this.nextRequestAt - this.now())
    if (delayMs) await this.sleep(delayMs)
    this.nextRequestAt = this.now() + this.intervalMs
    return delayMs
  }
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

export async function requestOrsPelias({
  query, api = 'search', apiKey, fetchImpl = fetch, pacer,
  maxRateLimitRetries = MAX_RATE_LIMIT_RETRIES, sleep = defaultSleep, now = Date.now,
  measureNow = performance.now.bind(performance), requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const request = { ...DEFAULT_REQUEST }
  if (!apiKey) return { query, api, request, count: 0, candidates: [], durationMs: 0, waitDurationMs: 0, status: null, rateLimitRetries: 0, error: 'ORS_API_KEY が未設定です' }
  const url = new URL(`${ORS_GEOCODE_BASE_URL}/${api}`)
  url.search = new URLSearchParams({ text: query, ...request }).toString()
  let status = null; let rateLimitRetries = 0; let durationMs = 0; let waitDurationMs = 0
  while (true) {
    try {
      if (pacer) waitDurationMs += await pacer.wait()
      status = null
      const started = measureNow()
      let response; let payload
      try {
        response = await fetchImpl(url, { headers: { Accept: 'application/geo+json', Authorization: apiKey }, signal: AbortSignal.timeout(requestTimeoutMs) })
        status = response.status
        if (response.ok) payload = await response.json()
      } finally { durationMs += Math.max(0, measureNow() - started) }
      if (status === 429 && rateLimitRetries < maxRateLimitRetries) {
        const delayMs = retryAfterMs(response.headers?.get?.('retry-after'), now()) ?? 1000 * (rateLimitRetries + 1)
        rateLimitRetries += 1; await sleep(delayMs); waitDurationMs += delayMs; continue
      }
      if (status === 429) {
        const delayMs = retryAfterMs(response.headers?.get?.('retry-after'), now()) ?? 1000 * (rateLimitRetries + 1)
        await sleep(delayMs); waitDurationMs += delayMs
        throw new Error(`ORS/Pelias rate limit (HTTP 429) remained after ${rateLimitRetries} retries`)
      }
      if (!response.ok) throw new Error(`ORS/Pelias returned HTTP ${response.status}`)
      const candidates = Array.isArray(payload?.features) ? payload.features.slice(0, request.size).map(normalizeFeature) : []
      return { query, api, request, count: candidates.length, candidates, durationMs: Math.round(durationMs), waitDurationMs, status, rateLimitRetries, error: null }
    } catch (error) {
      return { query, api, request, count: 0, candidates: [], durationMs: Math.round(durationMs), waitDurationMs, status, rateLimitRetries,
        error: redactSecret(error instanceof Error ? error.message : String(error), apiKey) }
    }
  }
}

export async function runCases({ cases = CASES, apiKey, fetchImpl = fetch, pacer = new RequestPacer(), requestOptions = {}, onResult } = {}) {
  const results = []
  for (const testCase of cases) {
    const result = await requestOrsPelias({ ...requestOptions, ...testCase, apiKey, fetchImpl, pacer })
    results.push(result); onResult?.(result, results.length, cases.length)
  }
  return results
}

export function findExpectedRank(testCase, candidates) {
  const expected = Array.isArray(testCase.expected) ? { all: testCase.expected } : (testCase.expected ?? {})
  const all = expected.all ?? []; const any = expected.any ?? []
  const index = candidates.findIndex(candidate => {
    const text = `${candidate.name} ${candidate.label} ${candidate.address} ${candidate.region} ${candidate.county} ${candidate.locality}`.toLocaleLowerCase('ja')
    const includes = term => typeof term === 'string' && text.includes(term.toLocaleLowerCase('ja'))
    return all.every(includes) && (!any.length || any.some(includes))
  })
  return index < 0 ? null : index + 1
}

const escapeCell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
const expectedText = expected => Array.isArray(expected) ? expected.join(' AND ') : (expected?.any ?? []).join(' OR ') || '指定なし'

export function createMarkdown(results, cases = CASES, generatedAt = new Date().toISOString()) {
  const lines = ['# ORS/Pelias 日本語地点検索 PoC 結果', '', `生成日時: ${generatedAt}`, '',
    '> 自動補助順位は期待語の文字列一致にすぎず、成功判定ではありません。同名の別地点を成功扱いしないよう、地域・座標・label・施設 identity・layer/source/categoryを人間が確認してください。', '',
    '## サマリー', '', '| 分類 | Query | API | HTTP | 件数 | 自動補助順位 | Error |', '|---|---|---:|---:|---:|---:|---|']
  results.forEach((r, i) => lines.push(`| ${escapeCell(cases[i].category)} | ${escapeCell(r.query)} | ${r.api} | ${r.status ?? '-'} | ${r.count} | ${findExpectedRank(cases[i], r.candidates) ?? '未検出／要確認'} | ${escapeCell(r.error ?? 'なし')} |`))
  lines.push('', '## ケース別詳細', '')
  results.forEach((r, i) => {
    const c = cases[i]
    lines.push(`### ${i + 1}. ${c.category}: ${r.query}`, '', `- API種別: \`${r.api}\``, `- request条件: \`${JSON.stringify(r.request)}\``,
      `- HTTP status / transport duration / 結果件数: ${r.status ?? '-'} / ${r.durationMs} ms / ${r.count}`,
      `- Pacing / backoff待ち時間: ${r.waitDurationMs ?? 0} ms`, `- Rate limit retry回数: ${r.rateLimitRetries ?? 0}`,
      `- 自動補助順位: **${findExpectedRank(c, r.candidates) ?? '未検出／要確認'}**（期待語: ${expectedText(c.expected)}）`,
      `- Error: ${escapeCell(r.error ?? 'なし')}`, `- 人間が確認: 地域、座標、label/address、施設 identity、layer/source/category${c.note ? `（${c.note}）` : ''}`, '',
      '| # | name | label | address / region | latitude | longitude | layer | source | category | provider ID | confidence / match_type |',
      '|---:|---|---|---|---:|---:|---|---|---|---|---|')
    if (!r.candidates.length) lines.push('| - | 候補なし | | | | | | | | | |')
    r.candidates.forEach((x, rank) => lines.push(`| ${rank + 1} | ${escapeCell(x.name)} | ${escapeCell(x.label)} | ${escapeCell([x.address, x.region, x.county, x.locality].filter(Boolean).join(' / '))} | ${x.latitude ?? ''} | ${x.longitude ?? ''} | ${escapeCell(x.layer)} | ${escapeCell(x.source)} | ${escapeCell(x.category)} | ${escapeCell(x.providerId)} | ${escapeCell([x.confidence, x.matchType].filter(v => v !== null && v !== '').join(' / '))} |`))
    lines.push('')
  })
  return `${lines.join('\n')}\n`
}

export async function writeReport(path, markdown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, markdown, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
}
