import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_REQUEST = Object.freeze({ lang: 'ja', filter: 'countrycode:jp', limit: 5 })

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
  { category: 'ドライブ向け施設', query: '海ほたるPA', expected: ['海ほたる', '海ほたるパーキングエリア'] },
  { category: 'ドライブ向け施設', query: '成田国際空港', expected: ['成田国際空港'] },
  { category: 'ドライブ向け施設', query: '三井アウトレットパーク 木更津', expected: ['三井アウトレットパーク', '木更津'] },
  { category: '店舗名', query: 'スターバックス コーヒー SHIBUYA TSUTAYA店', expected: ['スターバックス', 'SHIBUYA TSUTAYA'], note: '著名繁華街の実在チェーン店舗を名称だけで識別できるか' },
  { category: '店舗名 + 地域名', query: 'コメダ珈琲店 本店 名古屋', expected: ['コメダ珈琲店', '本店'], note: '本店という曖昧語を地域指定で絞れる実在店舗' },
  { category: '店舗名 + 地域名', query: 'さわやか 御殿場インター店', expected: ['さわやか', '御殿場インター'], note: 'ドライブ中に検索されやすい地域限定チェーンの実在店舗' },
  { category: '日本語住所', query: '東京都千代田区丸の内1丁目9番1号', expected: ['東京駅', '丸の内'] },
  { category: '市区町村 + 地点名', query: '山梨県南都留郡富士河口湖町 大石公園', expected: ['大石公園'] },
  { category: '表記ゆれ', query: '海ほたるパーキングエリア', expected: ['海ほたる'] },
  { category: '入力途中文字列', query: 'とうきょ', expected: ['東京'], api: 'autocomplete', note: 'ひらがなの入力途中' },
  { category: '入力途中文字列', query: '三井アウトレット 木更', expected: ['三井アウトレット', '木更津'], api: 'autocomplete', note: '施設名と地域名の入力途中' },
])

const safeText = value => typeof value === 'string' ? value : ''
const finiteNumber = value => Number.isFinite(Number(value)) ? Number(value) : null

export function normalizeFeature(feature = {}) {
  const p = feature?.properties ?? {}
  return {
    name: safeText(p.name), formatted: safeText(p.formatted || p.address_line1),
    prefecture: safeText(p.state), city: safeText(p.city || p.county || p.municipality),
    latitude: finiteNumber(p.lat ?? feature?.geometry?.coordinates?.[1]),
    longitude: finiteNumber(p.lon ?? feature?.geometry?.coordinates?.[0]),
    resultType: safeText(p.result_type), category: safeText(p.category),
    placeId: safeText(p.place_id),
  }
}

export function redactSecret(value, secret) {
  if (!secret || typeof value !== 'string') return value
  return value.split(secret).join('[REDACTED]')
}

export async function requestGeoapify({ query, api = 'search', apiKey, fetchImpl = fetch }) {
  const started = performance.now()
  const request = { ...DEFAULT_REQUEST }
  const url = new URL(`https://api.geoapify.com/v1/geocode/${api}`)
  url.search = new URLSearchParams({ text: query, ...request, apiKey }).toString()
  let status = null
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/geo+json' } })
    status = response.status
    if (!response.ok) throw new Error(`Geoapify returned HTTP ${response.status}`)
    const payload = await response.json()
    const candidates = Array.isArray(payload?.features) ? payload.features.slice(0, request.limit).map(normalizeFeature) : []
    return { query, api, request, count: candidates.length, candidates, durationMs: Math.round(performance.now() - started), status, error: null }
  } catch (error) {
    return { query, api, request, count: 0, candidates: [], durationMs: Math.round(performance.now() - started), status,
      error: redactSecret(error instanceof Error ? error.message : String(error), apiKey) }
  }
}

export function findExpectedRank(testCase, candidates) {
  const terms = testCase.expected ?? []
  const index = candidates.findIndex(c => terms.every(term => `${c.name} ${c.formatted}`.toLocaleLowerCase('ja').includes(term.toLocaleLowerCase('ja'))))
  return index < 0 ? null : index + 1
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
      `- 目的地点: 自動補助順位 **${findExpectedRank(c, result.candidates) ?? '未検出／要確認'}**（期待語: ${c.expected.join('・')}）`,
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
