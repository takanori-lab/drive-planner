import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_REQUEST = Object.freeze({ lang: 'ja', filter: 'countrycode:jp', limit: 5 })
export const REQUEST_INTERVAL_MS = 250
export const MAX_RATE_LIMIT_RETRIES = 2
export const REQUEST_TIMEOUT_MS = 10_000

export const CASES = Object.freeze([
  { category: '基本駅', query: '東京駅', expected: ['東京駅'] },
  { category: '基本駅', query: '千葉駅', expected: ['千葉駅'] },
  { category: '基本駅', query: '勝浦駅', expected: ['勝浦駅'] },
  { category: '基本駅', query: '新宿駅', expected: ['新宿駅'] },
  { category: '曖昧地点', query: '府中駅', expected: ['府中駅'], note: '同名・類似駅を住所で区別できるか確認' },
  { category: '曖昧地点', query: '大宮駅', expected: ['大宮駅'], note: '埼玉・京都などを住所で区別できるか確認' },
  { category: '観光地・広域地点', query: '河口湖', expected: ['河口湖'] },
  { category: '観光地・広域地点', query: '富士山', expected: ['富士山'] },
  { category: '観光地・広域地点', query: '大石公園', expected: ['大石公園'] },
  { category: '観光地・広域地点', query: '海ほたる', expected: ['海ほたる'] },
  { category: 'ドライブ向け施設', query: '道の駅どうし', expected: ['道の駅どうし'] },
  { category: 'ドライブ向け施設', query: '海ほたるPA', expected: { any: ['海ほたるPA', '海ほたるパーキングエリア', '海ほたる'] } },
  { category: 'ドライブ向け施設', query: '成田国際空港', expected: ['成田国際空港'] },
  { category: 'ドライブ向け施設', query: '三井アウトレットパーク 木更津', expected: ['三井アウトレットパーク', '木更津'] },
  { category: '店舗名', query: 'スターバックス コーヒー SHIBUYA TSUTAYA店', expected: ['スターバックス', 'SHIBUYA TSUTAYA'], note: '著名繁華街の実在チェーン店舗を名称だけで識別できるか' },
  { category: '店舗名 + 地域名', query: 'コメダ珈琲店 本店 名古屋', expected: ['コメダ珈琲店', '本店'], note: '本店という曖昧語を地域指定で絞れる実在店舗' },
  { category: '店舗名 + 地域名', query: 'さわやか 御殿場インター店', expected: ['さわやか', '御殿場インター'], note: 'ドライブ中に検索されやすい地域限定チェーンの実在店舗' },
  { category: '日本語住所', query: '東京都千代田区丸の内1丁目9番1号', expected: ['東京駅', '丸の内'] },
  { category: '市区町村 + 地点名', query: '山梨県南都留郡富士河口湖町 大石公園', expected: ['大石公園'] },
  { category: '表記ゆれ', query: '海ほたるパーキングエリア', expected: { any: ['海ほたるパーキングエリア', '海ほたるPA', '海ほたる'] } },
  { category: '入力途中文字列', query: 'とうきょ', expected: ['東京'], api: 'autocomplete', note: 'ひらがなの入力途中' },
  { category: '入力途中文字列', query: '三井アウトレット 木更', expected: ['三井アウトレット', '木更津'], api: 'autocomplete', note: '施設名と地域名の入力途中' },
])

const safeText = value => typeof value === 'string' ? value : ''
const finiteNumber = value => Number.isFinite(Number(value)) ? Number(value) : null

export function normalizeFeature(feature = {}) {
  const p = feature?.properties ?? {}
  const categories = Array.isArray(p.categories) ? p.categories.filter(value => typeof value === 'string') : []
  return {
    name: safeText(p.name), formatted: safeText(p.formatted || p.address_line1),
    prefecture: safeText(p.state), city: safeText(p.city || p.county || p.municipality),
    latitude: finiteNumber(p.lat ?? feature?.geometry?.coordinates?.[1]),
    longitude: finiteNumber(p.lon ?? feature?.geometry?.coordinates?.[0]),
    resultType: safeText(p.result_type), category: categories.join(', '),
    placeId: safeText(p.place_id),
  }
}

export function redactSecret(value, secret) {
  if (!secret || typeof value !== 'string') return value
  return value.split(secret).join('[REDACTED]')
}

const defaultSleep = durationMs => new Promise(resolve => setTimeout(resolve, durationMs))

export class RequestPacer {
  constructor({ intervalMs = REQUEST_INTERVAL_MS, now = Date.now, sleep = defaultSleep } = {}) {
    this.intervalMs = intervalMs
    this.now = now
    this.sleep = sleep
    this.nextRequestAt = 0
  }

  async wait() {
    const delayMs = Math.max(0, this.nextRequestAt - this.now())
    if (delayMs > 0) await this.sleep(delayMs)
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

export async function requestGeoapify({
  query, api = 'search', apiKey, fetchImpl = fetch, pacer,
  maxRateLimitRetries = MAX_RATE_LIMIT_RETRIES, sleep = defaultSleep, now = Date.now,
  measureNow = performance.now.bind(performance), requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const request = { ...DEFAULT_REQUEST }
  const url = new URL(`https://api.geoapify.com/v1/geocode/${api}`)
  url.search = new URLSearchParams({ text: query, ...request, apiKey }).toString()
  let status = null
  let rateLimitRetries = 0
  let durationMs = 0
  let waitDurationMs = 0
  while (true) {
    try {
      if (pacer) waitDurationMs += await pacer.wait()
      status = null
      const attemptStarted = measureNow()
      let response
      let payload
      try {
        response = await fetchImpl(url, {
          headers: { Accept: 'application/geo+json' },
          signal: AbortSignal.timeout(requestTimeoutMs),
        })
        status = response.status
        if (response.ok) payload = await response.json()
      } finally {
        durationMs += Math.max(0, measureNow() - attemptStarted)
      }
      if (status === 429 && rateLimitRetries < maxRateLimitRetries) {
        const header = response.headers?.get?.('retry-after')
        const delayMs = retryAfterMs(header, now()) ?? 1000 * (rateLimitRetries + 1)
        rateLimitRetries += 1
        await sleep(delayMs)
        waitDurationMs += delayMs
        continue
      }
      if (status === 429) {
        const finalDelayMs = retryAfterMs(response.headers?.get?.('retry-after'), now())
          ?? 1000 * (rateLimitRetries + 1)
        await sleep(finalDelayMs)
        waitDurationMs += finalDelayMs
        throw new Error(`Geoapify rate limit (HTTP 429) remained after ${rateLimitRetries} retries`)
      }
      if (!response.ok) throw new Error(`Geoapify returned HTTP ${response.status}`)
      const candidates = Array.isArray(payload?.features) ? payload.features.slice(0, request.limit).map(normalizeFeature) : []
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
    const result = await requestGeoapify({ ...requestOptions, ...testCase, apiKey, fetchImpl, pacer })
    results.push(result)
    onResult?.(result, results.length, cases.length)
  }
  return results
}

export function findExpectedRank(testCase, candidates) {
  const expected = Array.isArray(testCase.expected) ? { all: testCase.expected } : (testCase.expected ?? {})
  const all = Array.isArray(expected.all) ? expected.all : []
  const any = Array.isArray(expected.any) ? expected.any : []
  const includes = (text, term) => typeof term === 'string' && text.includes(term.toLocaleLowerCase('ja'))
  const index = candidates.findIndex(candidate => {
    const text = `${candidate.name} ${candidate.formatted}`.toLocaleLowerCase('ja')
    return all.every(term => includes(text, term)) && (any.length === 0 || any.some(term => includes(text, term)))
  })
  return index < 0 ? null : index + 1
}

function describeExpected(expected) {
  if (Array.isArray(expected)) return expected.join(' AND ')
  const parts = []
  if (Array.isArray(expected?.all) && expected.all.length) parts.push(expected.all.join(' AND '))
  if (Array.isArray(expected?.any) && expected.any.length) parts.push(`(${expected.any.join(' OR ')})`)
  return parts.join(' AND ') || '指定なし'
}

const escapeCell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
const yn = value => value ? 'はい' : 'いいえ'

export function createMarkdown(results, cases = CASES, generatedAt = new Date().toISOString()) {
  const lines = [
    '# Geoapify 日本語地点検索 PoC 結果', '', `生成日時: ${generatedAt}`, '',
    '> 自動判定は期待語の文字列一致による補助情報です。地点の正しさ、候補の区別しやすさ、日本語表示の自然さは人間が確認してください。', '',
    '## サマリー', '', '| 分類 | Query | API | HTTP | 件数 | 期待候補順位（補助） | 座標あり | Error |',
    '|---|---|---:|---:|---:|---:|---:|---|',
  ]
  results.forEach((result, i) => {
    const rank = findExpectedRank(cases[i], result.candidates)
    lines.push(`| ${escapeCell(cases[i].category)} | ${escapeCell(result.query)} | ${result.api} | ${result.status ?? '-'} | ${result.count} | ${rank ?? '未検出／要確認'} | ${yn(result.candidates.some(c => c.latitude !== null && c.longitude !== null))} | ${escapeCell(result.error ?? 'なし')} |`)
  })
  lines.push('', '## ケース別詳細', '')
  results.forEach((result, i) => {
    const c = cases[i]
    lines.push(`### ${i + 1}. ${c.category}: ${result.query}`, '',
      `- API種別: \`${result.api}\``, `- request条件: \`${JSON.stringify(result.request)}\``,
      `- HTTP status / duration / 結果件数: ${result.status ?? '-'} / ${result.durationMs} ms / ${result.count}`,
      `- Pacing / backoff待ち時間: ${result.waitDurationMs ?? 0} ms`,
      `- Rate limit retry回数: ${result.rateLimitRetries ?? 0}`,
      `- 目的地点: 自動補助順位 **${findExpectedRank(c, result.candidates) ?? '未検出／要確認'}**（期待語: ${describeExpected(c.expected)}）`,
      `- Routing用座標: **${yn(result.candidates.some(x => x.latitude !== null && x.longitude !== null))}**`,
      `- Error: ${escapeCell(result.error ?? 'なし')}`,
      `- 人間が確認: 目的地点の妥当性、候補を住所で区別可能か、日本語表示が十分か${c.note ? `（${c.note}）` : ''}`, '',
      '| # | name | formatted / address | 都道府県 | 市区町村等 | latitude | longitude | result_type | category | place_id |',
      '|---:|---|---|---|---|---:|---:|---|---|---|')
    if (!result.candidates.length) lines.push('| - | 候補なし | | | | | | | | |')
    result.candidates.forEach((x, rank) => lines.push(`| ${rank + 1} | ${escapeCell(x.name)} | ${escapeCell(x.formatted)} | ${escapeCell(x.prefecture)} | ${escapeCell(x.city)} | ${x.latitude ?? ''} | ${x.longitude ?? ''} | ${escapeCell(x.resultType)} | ${escapeCell(x.category)} | ${escapeCell(x.placeId)} |`))
    lines.push('')
  })
  return `${lines.join('\n')}\n`
}

export async function writeReport(path, markdown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, markdown, { encoding: 'utf8', mode: 0o600 })
}
