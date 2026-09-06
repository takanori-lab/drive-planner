#!/usr/bin/env node
import { resolve } from 'node:path'
import { CASES, createMarkdown, requestGeoapify, writeReport } from './geoapify-poc-lib.mjs'

const apiKey = process.env.GEOAPIFY_API_KEY
if (!apiKey) {
  console.error('GEOAPIFY_API_KEY が未設定です。環境変数へ設定してから再実行してください（キー自体は表示しません）。')
  process.exitCode = 1
} else {
  const results = []
  for (const testCase of CASES) {
    process.stdout.write(`[${results.length + 1}/${CASES.length}] ${testCase.category}: ${testCase.query} ... `)
    const result = await requestGeoapify({ ...testCase, apiKey })
    results.push(result)
    console.log(result.error ? `error (${result.status ?? 'network'})` : `${result.count}件 (${result.durationMs} ms)`)
  }
  const output = resolve('artifacts/geoapify-poc/report.md')
  await writeReport(output, createMarkdown(results))
  console.log(`完了: ${output}`)
}
