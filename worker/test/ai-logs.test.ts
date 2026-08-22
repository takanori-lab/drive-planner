import { describe, expect, it } from 'vitest';
import { ensureAiLogSchema, exportAiLogs, saveAiGenerationLog, type D1Database, type D1PreparedStatement } from '../src/ai-logs';
import { INSTRUCTIONS, PROMPT_VERSION, type GenerationResult } from '../src/openai';

class FakeStatement implements D1PreparedStatement {
  values: unknown[] = [];
  constructor(private readonly db: FakeD1) {}
  bind(...values: unknown[]): D1PreparedStatement { this.values = values; return this; }
  async run(): Promise<unknown> { this.db.inserted.push(this.values); return {}; }
  async all<T>(): Promise<{ results?: T[] }> { return { results: this.db.rows as T[] }; }
}
class FakeD1 implements D1Database {
  schemas: string[] = []; inserted: unknown[][] = []; rows: Record<string, unknown>[] = [];
  async exec(sql: string): Promise<unknown> { this.schemas.push(sql); return {}; }
  prepare(): D1PreparedStatement { return new FakeStatement(this); }
}
const output = (status: 'ok' | 'needs_clarification'): GenerationResult => ({
  status, clarificationMessage: status === 'ok' ? '' : '地点を確認してください', candidates: [],
  openaiResponseId: 'resp_123', usage: { input_tokens: 12 }, model: 'gpt-5.6-luna',
  promptVersion: PROMPT_VERSION, instructions: INSTRUCTIONS,
  input: { requestId: 'request-123', preferences: { freeText: '景色' } },
} as GenerationResult);

describe('AI実行ログ', () => {
  it('初回にテーブルとindexをIF NOT EXISTSで作成する', async () => {
    const db = new FakeD1(); await ensureAiLogSchema(db);
    expect(db.schemas).toHaveLength(2);
    expect(db.schemas[0]).toMatch(/^CREATE TABLE IF NOT EXISTS ai_generation_logs \(.+\);$/);
    expect(db.schemas[0]).not.toContain('\n');
    expect(db.schemas[1]).toBe('CREATE INDEX IF NOT EXISTS idx_ai_generation_logs_created_at_id ON ai_generation_logs(created_at, id);');
  });
  it.each(['ok', 'needs_clarification'] as const)('%sを必要情報とともに保存する', async (status) => {
    const db = new FakeD1(); await saveAiGenerationLog(db, 'request-123', { 'segment.before': { label: '東京', resolvedUrl: 'https://www.google.com/maps/place/example' } }, output(status));
    const saved = JSON.stringify(db.inserted[0]);
    expect(db.inserted[0]).toContain(INSTRUCTIONS);
    for (const expected of ['request-123', 'resp_123', 'gpt-5.6-luna', PROMPT_VERSION, 'freeText', '東京', status, 'input_tokens']) expect(saved).toContain(expected);
    for (const secret of ['OPENAI_API_KEY', 'DRIVE_PLANNER_PASSCODE', 'SESSION_SIGNING_KEY', 'session token', 'AI_LOG_EXPORT_KEY']) expect(saved).not.toContain(secret);
  });
  it('JSONをオブジェクトに戻し1レコード1行でexportする', async () => {
    const db = new FakeD1(); db.rows = [1, 2].map((n) => ({ id: `id-${n}`, log_version: 1, created_at: `2026-01-0${n}T00:00:00.000Z`, request_id: `req-${n}`, openai_response_id: `resp-${n}`, model: 'gpt-5.6-luna', prompt_version: PROMPT_VERSION, instructions: INSTRUCTIONS, input_json: JSON.stringify({ freeText: `入力${n}` }), resolved_google_maps_context_json: '{}', output_json: JSON.stringify({ status: 'ok', candidates: [] }), usage_json: JSON.stringify({ total_tokens: n }) }));
    const lines = (await exportAiLogs(db)).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2); expect(lines[0].input).toEqual({ freeText: '入力1' }); expect(lines[1].output).toEqual({ status: 'ok', candidates: [] });
  });
});
