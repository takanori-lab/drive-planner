import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REQUIRED_SECRETS = [
  'DRIVE_PLANNER_PASSCODE',
  'SESSION_SIGNING_KEY',
  'OPENAI_API_KEY',
  'AI_LOG_EXPORT_KEY',
  'ORS_API_KEY',
];

export function missingSecrets(entries) {
  const registered = new Set(entries.map((entry) => entry.name));
  return REQUIRED_SECRETS.filter((name) => !registered.has(name));
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'list', '--format', 'json'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'Cloudflare WorkerのSecret一覧を取得できませんでした。\n');
    process.exit(result.status || 1);
  }

  let entries;
  try { entries = JSON.parse(result.stdout); }
  catch {
    process.stderr.write('wrangler secret listの出力を解析できませんでした。\n');
    process.exit(1);
  }
  const missing = missingSecrets(entries);
  if (missing.length) {
    process.stderr.write(`未登録のWorker Secretがあります: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write('必要なWorker Secretがすべて登録されています。\n');
}
