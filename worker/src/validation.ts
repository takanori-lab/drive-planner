import { ApiError } from './errors';

export const MAX_BODY_BYTES = 32 * 1024;
const MAX_EXISTING_CANDIDATES = 20;

export interface PlaceInput {
  name: string;
  googleMapsUrl: string;
  locationNote: string;
  memo: string;
}

export interface SegmentCandidatesRequest {
  requestId: string;
  plan: { title: string; date: string; mainPoint: PlaceInput };
  segment: { before: PlaceInput; after: PlaceInput };
  existingCandidates: Array<{ name: string; locationNote: string }>;
  preferences: { freeText: string; useWebSearch: boolean };
}
export interface RoutingRequest { requestId: string; condition: 'recommended' | 'local_roads'; before: PlaceInput; after: PlaceInput }

export function validateRoutingRequest(value: unknown): RoutingRequest {
  const root = object(value, 'body'); exactKeys(root, ['requestId', 'condition', 'before', 'after'], 'body');
  const condition = string(root.condition, 'condition', 20);
  if (condition !== 'recommended' && condition !== 'local_roads') invalid('condition は recommended または local_roads を指定してください。');
  return { requestId: string(root.requestId, 'requestId', 100), condition, before: place(root.before, 'before'), after: place(root.after, 'after') };
}

function invalid(detail: string): never {
  throw new ApiError(400, 'invalid_request', `リクエスト内容を確認してください。${detail}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} はオブジェクトで指定してください。`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) invalid(`${path}.${unknown} は指定できません。`);
  const missing = keys.find((key) => !(key in value));
  if (missing) invalid(`${path}.${missing} は必須です。`);
}

function string(value: unknown, path: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${path} は文字列で指定してください。`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) invalid(`${path} を入力してください。`);
  if (value.length > max) invalid(`${path} は ${max} 文字以内で指定してください。`);
  return value;
}

function place(value: unknown, path: string): PlaceInput {
  const input = object(value, path);
  exactKeys(input, ['name', 'googleMapsUrl', 'locationNote', 'memo'], path);
  return {
    name: string(input.name, `${path}.name`, 120),
    googleMapsUrl: string(input.googleMapsUrl, `${path}.googleMapsUrl`, 2048, true),
    locationNote: string(input.locationNote, `${path}.locationNote`, 500, true),
    memo: string(input.memo, `${path}.memo`, 1000, true),
  };
}

function validDate(value: string): boolean {
  if (value === '') return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

export function validateSegmentCandidatesRequest(value: unknown): SegmentCandidatesRequest {
  const root = object(value, 'body');
  exactKeys(root, ['requestId', 'plan', 'segment', 'existingCandidates', 'preferences'], 'body');

  const requestId = string(root.requestId, 'requestId', 100);
  const plan = object(root.plan, 'plan');
  exactKeys(plan, ['title', 'date', 'mainPoint'], 'plan');
  const date = string(plan.date, 'plan.date', 10, true);
  if (!validDate(date)) invalid('plan.date は YYYY-MM-DD 形式の実在する日付、または空文字で指定してください。');

  const segment = object(root.segment, 'segment');
  exactKeys(segment, ['before', 'after'], 'segment');

  if (!Array.isArray(root.existingCandidates)) invalid('existingCandidates は配列で指定してください。');
  if (root.existingCandidates.length > MAX_EXISTING_CANDIDATES) invalid(`existingCandidates は ${MAX_EXISTING_CANDIDATES} 件以内で指定してください。`);
  const existingCandidates = root.existingCandidates.map((value, index) => {
    const candidate = object(value, `existingCandidates[${index}]`);
    exactKeys(candidate, ['name', 'locationNote'], `existingCandidates[${index}]`);
    return {
      name: string(candidate.name, `existingCandidates[${index}].name`, 120),
      locationNote: string(candidate.locationNote, `existingCandidates[${index}].locationNote`, 500, true),
    };
  });

  const preferences = object(root.preferences, 'preferences');
  exactKeys(preferences, ['freeText', 'useWebSearch'], 'preferences');
  if (typeof preferences.useWebSearch !== 'boolean') invalid('preferences.useWebSearch は真偽値で指定してください。');

  return {
    requestId,
    plan: {
      title: string(plan.title, 'plan.title', 120),
      date,
      mainPoint: place(plan.mainPoint, 'plan.mainPoint'),
    },
    segment: {
      before: place(segment.before, 'segment.before'),
      after: place(segment.after, 'segment.after'),
    },
    existingCandidates,
    preferences: {
      freeText: string(preferences.freeText, 'preferences.freeText', 1000, true),
      useWebSearch: preferences.useWebSearch,
    },
  };
}
