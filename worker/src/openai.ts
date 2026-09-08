import { ApiError } from './errors';
import type { SegmentCandidatesRequest } from './validation';
import type { ResolvedGoogleMapsContext } from './google-maps';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_MODEL = 'gpt-5.6-luna';
export const OPENAI_MAX_OUTPUT_TOKENS = 4000;
export const OPENAI_TIMEOUT_MS = 45_000;

const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'locationHint', 'description', 'reason', 'detourLevel', 'detourNote', 'checkItems', 'referenceLocation'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    locationHint: { type: 'string', minLength: 1, maxLength: 300 },
    description: { type: 'string', minLength: 1, maxLength: 600 },
    reason: { type: 'string', minLength: 1, maxLength: 600 },
    detourLevel: { type: 'string', enum: ['small', 'medium', 'large'] },
    detourNote: { type: 'string', minLength: 1, maxLength: 300 },
    checkItems: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 200 } },
    referenceLocation: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['latitude', 'longitude'], properties: {
        latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
      } },
      { type: 'null' },
    ] },
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

export const PROMPT_VERSION = 'segment-candidates-v3';
export const INSTRUCTIONS = `あなたはDrive Plannerの寄り道候補を提案します。車で立ち寄りやすく、予定外でも面白い場所を探してください。

【探索範囲の優先順位】routeContext.sourceがorsなら、sampledCoordinatesが表す取得済みORS実ルートとmajorRoadsを最優先の探索範囲にします。geographic_inferenceならsegment.before → segment.afterの位置関係から自然な地理範囲を最優先にします。面白くても遠い場所より今回の経路に自然な場所を選び、5件を揃えるため範囲を広げません。MAINとplan.titleはテーマ・候補種類の補助情報に限り、MAINを経由地点や探索経路として扱いません。freeTextは「何を探すか」へ強く反映しても探索範囲を変えません。

【希望の解釈】包含と除外を区別します。「ラーメン以外も」「ラーメンだけでなく」はラーメンを含めた多様化であり除外ではありません。「ラーメン以外がいい」「ラーメンは除外して」のような明示的指示だけを除外として扱います。

【候補】少し変わった施設、景勝地、地元の食やニッチな場所を重視し、有名地だけを並べず既存候補と重複させません。原則、ユーザーがそのまま選べる具体的な店舗・施設・地点を出し、具体地点を出せるのに「○○駅周辺の飲食店」のような曖昧な地域へ逃げません。商店街、市場、公園、景勝地などエリア自体が立ち寄り先なら許容し、5件の粒度を極端にばらつかせません。reasonには魅力と今回の経路の寄り道に適する理由を簡潔に書きます。

detourLevelはsmall=自然な範囲からほぼ外れない、medium=流れを保つが明確な追加移動、large=かなり外れる可能性または別方向への大きな寄り道です。detourNoteと整合させ、正確な追加時間・距離を推測・断定せず、迷えば過小評価しません。

checkItemsは開催日、遊歩道、進行方向、季節営業など候補固有で事前確認価値が高い事項を0～3件程度にし、一般的な営業時間・混雑・駐車場等を全候補へ機械的に反復しません。

referenceLocationは地点を十分推定できる場合だけ有効範囲の緯度経度を返し、不確かならnullにします。これは参考情報で、確認済みlocation、正確な入口・駐車場位置、Routing用座標ではありません。

【安全制約】Web Searchは使用できません。googleMapsUrlを開いた・検索した・確認したと表現せず、短縮URL文字列だけで推測しません。Workerが安全に解決したresolvedGoogleMapsContextは地点特定に使えます。routeContext.sourceがorsで有効なsampledCoordinatesがあれば、その始終点位置をA/B特定の根拠とし、before/afterの文字情報が曖昧という理由だけでneeds_clarificationにしません。geographic_inferenceで解決情報もなく地点名、locationNote、memoからA/Bを十分特定できなければ、別地点を想定せずneeds_clarificationを返します。A/BでないMAINの曖昧さだけでは確認を求めず、MAINがA/Bなら十分な特定が必要です。最新の営業・道路状況を確認済みと表現しません。

正常時はreason、detourLevel、detourNote、checkItemsを持つ候補を必ず5件返しclarificationMessageは空文字にします。確認が必要なら候補0件と具体的なclarificationMessageを返します。`;

type Candidate = {
  name: string; locationHint: string; description: string; reason: string;
  detourLevel: 'small' | 'medium' | 'large'; detourNote: string; checkItems: string[];
  referenceLocation: { latitude: number; longitude: number } | null;
};
export type GeneratedCandidates =
  | { status: 'ok'; clarificationMessage: ''; candidates: Candidate[] }
  | { status: 'needs_clarification'; clarificationMessage: string; candidates: [] };

export type GenerationResult = GeneratedCandidates & {
  openaiResponseId: string;
  usage: unknown;
  model: string;
  promptVersion: string;
  instructions: string;
  input: Record<string, unknown>;
};

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
    const keys = ['name', 'locationHint', 'description', 'reason', 'detourLevel', 'detourNote', 'checkItems', 'referenceLocation'];
    const reference = c.referenceLocation;
    if (Object.keys(c).length !== keys.length || keys.some((key) => !(key in c)) || !validString(c.name, 1, 120)
      || !validString(c.locationHint, 1, 300) || !validString(c.description, 1, 600) || !validString(c.reason, 1, 600)
      || !['small', 'medium', 'large'].includes(c.detourLevel as string) || !validString(c.detourNote, 1, 300)
      || !Array.isArray(c.checkItems) || c.checkItems.length > 8 || !c.checkItems.every((x) => validString(x, 1, 200))
      || !(reference === null || (reference && typeof reference === 'object' && !Array.isArray(reference)
        && Object.keys(reference).length === 2 && Number.isFinite((reference as Record<string, unknown>).latitude)
        && Number.isFinite((reference as Record<string, unknown>).longitude)
        && (reference as { latitude: number }).latitude >= -90 && (reference as { latitude: number }).latitude <= 90
        && (reference as { longitude: number }).longitude >= -180 && (reference as { longitude: number }).longitude <= 180))) invalidResponse();
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
  resolvedGoogleMapsContext: ResolvedGoogleMapsContext = {},
): Promise<GenerationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetcher(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, reasoning: { effort: 'medium' }, store: true, metadata: { app: 'drive-planner', feature: 'segment-candidates' }, max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS, instructions: INSTRUCTIONS, input: JSON.stringify({ ...input, resolvedGoogleMapsContext }), text: { format: OUTPUT_FORMAT } }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      console.warn('openai_timeout', { model: OPENAI_MODEL });
      throw new ApiError(504, 'ai_timeout', 'AIの応答がタイムアウトしました。時間をおいて再度お試しください。', true);
    }
    console.warn('openai_network_error', { model: OPENAI_MODEL });
    throw new ApiError(502, 'ai_unavailable', 'AIサービスを一時的に利用できません。', true);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) console.warn('openai_upstream_error', { status: response.status, model: OPENAI_MODEL });
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
  const generated = validateOutput(parsed);
  const responseRecord = raw as Record<string, unknown>;
  if (typeof responseRecord.id !== 'string' || !responseRecord.id) invalidResponse();
  return Object.assign(generated, {
    openaiResponseId: responseRecord.id,
    usage: responseRecord.usage ?? null,
    model: OPENAI_MODEL,
    promptVersion: PROMPT_VERSION,
    instructions: INSTRUCTIONS,
    input: { ...input, resolvedGoogleMapsContext },
  });
}
