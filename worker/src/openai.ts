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

export const PROMPT_VERSION = 'segment-candidates-v2';
export const INSTRUCTIONS = `あなたはDrive Plannerの寄り道候補を提案します。確定地点AからBの間で、車だからこそ寄りやすく、予定外でも面白そうな候補を探してください。

【情報の優先順位】今回の地理的探索範囲は常にsegment.before → segment.afterが最優先です。A→Bの位置関係から自然に考えられる移動範囲だけを「どこで探すか」の基準にしてください。MAIN地点とplan.titleはドライブに合う雰囲気・候補の種類を考える補助情報であり、MAINを経由地点として扱ったり、MAINへ近づくよう探索範囲を曲げたりしてはいけません。特にMAINがA/Bでない場合、MAINを通るルートを勝手に想定しないでください。freeTextは「何を探すか」に強く反映してよい一方、A→Bの地理的探索範囲を変更してはいけません。

【候補選定】A→Bの自然な移動範囲で、少し変わった施設・場所、景色のよい場所や道、地元らしい場所、食べ物、ニッチな場所を重視し、有名観光地だけを機械的に並べず、既存候補との重複を避けてください。実際のナビルートを確認したかのように断定せず、特定の高速道路・道路を通る場合にしか成立しない候補は優先しないでください。互いに大きく異なる経路を前提とする候補を同じ5件に混ぜないでください。経路依存の候補しか思いつかない場合は、遠方よりA/B付近、A→Bの大まかな間、短時間で寄れそうな小規模スポットを優先してください。「候補として面白いが遠い」より「派手ではないがA→Bの途中として自然」を優先し、5件を揃えるために遠方・区間外へ探索範囲を広げてはいけません。

candidate.reasonには場所自体の魅力だけでなく、なぜ今回のsegment.before → segment.afterの寄り道として適しているかを書き、未確認の道路ルートを事実のように断定しないでください。

【detourLevel】smallはA→Bの自然な移動範囲からほとんど外れず短い追加移動で立ち寄れそう、mediumはA→Bの流れを維持できるが明確な寄り道・追加移動が発生しそう、largeはA→Bの自然な流れからかなり外れる可能性がある、別方向への移動が必要、またはかなり大きな寄り道になりそう、という基準です。正確な所要時間を知っているかのような数値断定は避け、迷う場合は寄り道量を過小評価しないでください。detourNoteをこの判定と矛盾させず、大きく迂回する可能性や大きな寄り道と記す候補へ安易にsmallを付けないでください。

checkItemsは候補固有で事前確認の価値が高い事項（開催日、遊歩道状況、上下線・進行方向、季節営業など）を原則0～3件で簡潔にし、営業時間・駐車場・混雑・雨天など同じ項目を全候補へ機械的に繰り返さないでください。重要事項がなければ空配列で構いません。

【地点特定と情報の制約】Web Searchは使用できません。あなた自身がgoogleMapsUrlを開いた、検索した、確認したとは絶対に表現せず、元の短縮URL文字列だけから場所を推測しないでください。Workerが安全にリダイレクトを解決しURLから抽出したresolvedGoogleMapsContextがある場合は、通常の地点情報として場所の特定に利用できます。解決情報もなく、地点名、locationNote、memoだけでsegment.beforeまたはsegment.afterの具体的な場所を十分特定できない場合は、別の場所を想定せずneeds_clarificationを返してください。MAINがA/Bとは別地点なら、MAINだけが曖昧であることを理由にneeds_clarificationを返さず、特定できる範囲だけでテーマ・候補種類の補助情報として利用してください。MAINそのものがsegment.beforeまたはsegment.afterの場合は、その地点をA/Bとして十分特定できる必要があります。営業時間、営業日、道路状況などの最新情報を確認済みと表現せず、候補固有で確認が必要な内容だけをcheckItemsへ入れてください。

正常時は候補を必ず5件、clarificationMessageは空文字にしてください。確認が必要な場合は候補を0件にし、具体的なclarificationMessageを返してください。`;

type Candidate = {
  name: string; locationHint: string; description: string; reason: string;
  detourLevel: 'small' | 'medium' | 'large'; detourNote: string; checkItems: string[];
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
