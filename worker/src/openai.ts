import { ApiError } from './errors';
import type { SegmentCandidatesRequest } from './validation';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_MODEL = 'gpt-5.6-luna';
export const OPENAI_MAX_OUTPUT_TOKENS = 4000;
export const OPENAI_TIMEOUT_MS = 45_000;

const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'locationHint', 'description', 'reason', 'detourLevel', 'detourNote', 'checkItems'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    locationHint: { type: 'string', minLength: 1, maxLength: 300 },
    description: { type: 'string', minLength: 1, maxLength: 600 },
    reason: { type: 'string', minLength: 1, maxLength: 600 },
    detourLevel: { type: 'string', enum: ['small', 'medium', 'large'] },
    detourNote: { type: 'string', minLength: 1, maxLength: 300 },
    checkItems: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 200 } },
  },
} as const;

export const OUTPUT_FORMAT = {
  type: 'json_schema',
  name: 'drive_planner_segment_candidates',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'clarificationMessage', 'candidates'],
    properties: {
      status: { type: 'string', enum: ['ok', 'needs_clarification'] },
      clarificationMessage: { type: 'string', maxLength: 500 },
      candidates: { type: 'array', minItems: 0, maxItems: 5, items: candidateSchema },
    },
  },
} as const;

const INSTRUCTIONS = `あなたはDrive Plannerの寄り道候補を提案します。確定地点AからBの間で、車だからこそ寄りやすく、予定外でも面白そうな候補を探してください。
大きくルートを外れず車で寄りやすい、少し変わった施設・場所、景色のよい場所や道、地元らしい場所、食べ物、ニッチな場所を重視し、有名観光地だけを機械的に並べないでください。既存候補との重複を避け、freeText、MAIN地点、ドライブ全体のテーマを考慮してください。
Web Searchは使用できません。googleMapsUrlを開いた、検索した、確認したとは絶対に表現せず、URLだけから場所を特定できたと装わないでください。地点名、locationNote、memoだけでA/BやMAINの具体的な場所を十分特定できない場合は別の場所を想定せずneeds_clarificationを返してください。営業時間、営業日、道路状況などの最新情報を確認済みと表現せず、最新確認が必要な内容はcheckItemsへ入れてください。
正常時は候補を必ず5件、clarificationMessageは空文字にしてください。確認が必要な場合は候補を0件にし、具体的なclarificationMessageを返してください。`;

type Candidate = {
  name: string; locationHint: string; description: string; reason: string;
  detourLevel: 'small' | 'medium' | 'large'; detourNote: string; checkItems: string[];
};
export type GeneratedCandidates =
  | { status: 'ok'; clarificationMessage: ''; candidates: Candidate[] }
  | { status: 'needs_clarification'; clarificationMessage: string; candidates: [] };

function invalidResponse(): never {
  throw new ApiError(502, 'ai_invalid_response', 'AIから有効な候補を取得できませんでした。');
}

function validString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function validateOutput(value: unknown): GeneratedCandidates {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => !['status', 'clarificationMessage', 'candidates'].includes(key)) || !Array.isArray(root.candidates)) invalidResponse();
  const candidates = root.candidates.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalidResponse();
    const c = item as Record<string, unknown>;
    const keys = ['name', 'locationHint', 'description', 'reason', 'detourLevel', 'detourNote', 'checkItems'];
    if (Object.keys(c).length !== keys.length || keys.some((key) => !(key in c)) || !validString(c.name, 1, 120)
      || !validString(c.locationHint, 1, 300) || !validString(c.description, 1, 600) || !validString(c.reason, 1, 600)
      || !['small', 'medium', 'large'].includes(c.detourLevel as string) || !validString(c.detourNote, 1, 300)
      || !Array.isArray(c.checkItems) || c.checkItems.length > 8 || !c.checkItems.every((x) => validString(x, 1, 200))) invalidResponse();
    return c as Candidate;
  });
  if (root.status === 'ok' && root.clarificationMessage === '' && candidates.length === 5) return { status: 'ok', clarificationMessage: '', candidates };
  if (root.status === 'needs_clarification' && validString(root.clarificationMessage, 1, 500) && candidates.length === 0) {
    return { status: 'needs_clarification', clarificationMessage: root.clarificationMessage, candidates: [] };
  }
  return invalidResponse();
}

function outputText(response: Record<string, unknown>): string {
  if (response.status !== 'completed' || !Array.isArray(response.output)) invalidResponse();
  let text: string | undefined;
  for (const item of response.output) {
    if (!item || typeof item !== 'object') continue;
    const message = item as Record<string, unknown>;
    if (message.type !== 'message' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      const content = part as Record<string, unknown>;
      if (content.type === 'refusal') invalidResponse();
      if (content.type === 'output_text' && typeof content.text === 'string') {
        if (text !== undefined) invalidResponse();
        text = content.text;
      }
    }
  }
  if (text === undefined) invalidResponse();
  return text;
}

export async function generateCandidates(
  input: SegmentCandidatesRequest,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = OPENAI_TIMEOUT_MS,
): Promise<GeneratedCandidates> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetcher(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, reasoning: { effort: 'medium' }, store: false, max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS, instructions: INSTRUCTIONS, input: JSON.stringify(input), text: { format: OUTPUT_FORMAT } }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new ApiError(504, 'ai_timeout', 'AIの応答がタイムアウトしました。時間をおいて再度お試しください。', true);
    }
    throw new ApiError(502, 'ai_unavailable', 'AIサービスを一時的に利用できません。', true);
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 401 || response.status === 403 || response.status === 400) throw new ApiError(500, 'internal_error', '一時的なエラーが発生しました。');
  if (response.status === 429 || response.status >= 500) throw new ApiError(502, 'ai_unavailable', 'AIサービスを一時的に利用できません。', true);
  if (!response.ok) throw new ApiError(502, 'ai_unavailable', 'AIサービスを利用できません。');
  let raw: unknown;
  try { raw = await response.json(); } catch { return invalidResponse(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalidResponse();
  let parsed: unknown;
  try { parsed = JSON.parse(outputText(raw as Record<string, unknown>)); } catch (error) {
    if (error instanceof ApiError) throw error;
    return invalidResponse();
  }
  return validateOutput(parsed);
}
