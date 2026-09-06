#!/usr/bin/env node
import { resolve } from 'node:path'
import { createMarkdown, runCases, writeReport } from './ors-pelias-poc-lib.mjs'

const apiKey = process.env.ORS_API_KEY
if (!apiKey) {
  console.error('ORS_API_KEY が未設定です。環境変数へ設定してから再実行してください（キー自体は表示しません）。')
  process.exitCode = 1
} else {
  const results = await runCases({ apiKey, onResult(result, current, total) {
    console.log(`[${current}/${total}] ${result.query} ... ${result.error ? `error (${result.status ?? 'network'})` : `${result.count}件 (${result.durationMs} ms)`}`)
  } })
  const output = resolve('artifacts/ors-pelias-poc/report.md')
  await writeReport(output, createMarkdown(results))
  console.log(`完了: ${output}`)
}
