import type { GenerationResult } from './openai';
import type { ResolvedGoogleMapsContext } from './google-maps';

export interface D1Result<T = unknown> { results?: T[] }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<D1Result<T>>;
}
export interface D1Database {
  exec(query: string): Promise<unknown>;
  prepare(query: string): D1PreparedStatement;
}

const CREATE_TABLE = "CREATE TABLE IF NOT EXISTS ai_generation_logs (id TEXT PRIMARY KEY, log_version INTEGER NOT NULL, created_at TEXT NOT NULL, request_id TEXT NOT NULL, openai_response_id TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, instructions TEXT NOT NULL, input_json TEXT NOT NULL, resolved_google_maps_context_json TEXT NOT NULL, output_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('ok', 'needs_clarification')), usage_json TEXT NOT NULL);";
const CREATE_INDEX = 'CREATE INDEX IF NOT EXISTS idx_ai_generation_logs_created_at_id ON ai_generation_logs(created_at, id);';

export async function ensureAiLogSchema(db: D1Database): Promise<void> {
  await db.exec(CREATE_TABLE);
  await db.exec(CREATE_INDEX);
}

export async function saveAiGenerationLog(
  db: D1Database,
  requestId: string,
  resolvedGoogleMapsContext: ResolvedGoogleMapsContext,
  generated: GenerationResult,
): Promise<void> {
  await ensureAiLogSchema(db);
  await db.prepare(`INSERT INTO ai_generation_logs
    (id, log_version, created_at, request_id, openai_response_id, model, prompt_version,
     instructions, input_json, resolved_google_maps_context_json, output_json, status, usage_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), 1, new Date().toISOString(), requestId, generated.openaiResponseId,
      generated.model, generated.promptVersion, generated.instructions, JSON.stringify(generated.input),
      JSON.stringify(resolvedGoogleMapsContext), JSON.stringify({ status: generated.status,
        clarificationMessage: generated.clarificationMessage, candidates: generated.candidates }),
      generated.status, JSON.stringify(generated.usage))
    .run();
}

interface LogRow {
  id: string; log_version: number; created_at: string; request_id: string;
  openai_response_id: string; model: string; prompt_version: string; instructions: string;
  input_json: string; resolved_google_maps_context_json: string; output_json: string; usage_json: string;
}

export async function exportAiLogs(db: D1Database): Promise<string> {
  await ensureAiLogSchema(db);
  const lines: string[] = [];
  const batchSize = 500;
  let offset = 0;
  while (true) {
    const result = await db.prepare(`SELECT id, log_version, created_at, request_id, openai_response_id,
      model, prompt_version, instructions, input_json, resolved_google_maps_context_json, output_json, usage_json
      FROM ai_generation_logs ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
      .bind(batchSize, offset).all<LogRow>();
    const rows = result.results ?? [];
    for (const row of rows) lines.push(JSON.stringify({
      logVersion: row.log_version, id: row.id, createdAt: row.created_at, requestId: row.request_id,
      openaiResponseId: row.openai_response_id, model: row.model, promptVersion: row.prompt_version,
      instructions: row.instructions, input: JSON.parse(row.input_json),
      resolvedGoogleMapsContext: JSON.parse(row.resolved_google_maps_context_json),
      output: JSON.parse(row.output_json), usage: JSON.parse(row.usage_json),
    }));
    if (rows.length < batchSize) break;
    offset += rows.length;
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
