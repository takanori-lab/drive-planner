import type { D1Database } from './ai-logs';
import type { RoutingInput } from './routing';

const SCHEMA = `CREATE TABLE IF NOT EXISTS routing_evaluation_logs (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, request_id TEXT NOT NULL, provider TEXT NOT NULL,
 routing_policy_version TEXT NOT NULL, condition TEXT NOT NULL, preference TEXT NOT NULL,
 avoid_features_json TEXT NOT NULL, resolution_methods_json TEXT NOT NULL, distance_meters REAL,
 duration_seconds REAL, status TEXT NOT NULL, error_code TEXT)`;

export async function saveRoutingLog(db: D1Database, input: RoutingInput, result: any, errorCode?: string): Promise<void> {
  await db.exec(SCHEMA);
  await db.prepare(`INSERT INTO routing_evaluation_logs (id, created_at, request_id, provider, routing_policy_version,
   condition, preference, avoid_features_json, resolution_methods_json, distance_meters, duration_seconds, status, error_code)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), new Date().toISOString(), input.requestId,
    'openrouteservice', 'ors-v1', input.condition, 'recommended', JSON.stringify(input.condition === 'local_roads' ? ['highways'] : []),
    JSON.stringify(result?.locationResolution || {}), result?.distanceMeters ?? null, result?.durationSeconds ?? null,
    errorCode ? 'error' : result?.status || 'error', errorCode || null).run();
}
