export const STORAGE_KEY = 'drive-planner:v1';

export const initialPlan = () => ({
  title: '東京発・河口湖ドライブ',
  points: [
    { id: 'tokyo-start', name: '東京駅', googleMapsUrl: '', locationNote: '', memo: '', locked: 'start' },
    { id: 'kawaguchiko', name: '河口湖', googleMapsUrl: '', locationNote: '', memo: '', locked: 'main' },
    { id: 'tokyo-goal', name: '東京駅', googleMapsUrl: '', locationNote: '', memo: '', locked: 'goal' },
  ],
  candidates: {},
});

export const segmentKey = (a, b) => `${a.id}::${b.id}`;
export const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function isGoogleMapsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'maps.app.goo.gl'
      || (host === 'goo.gl' && (url.pathname === '/maps' || url.pathname.startsWith('/maps/')))
      || ((host === 'google.com' || host === 'www.google.com' || host === 'maps.google.com')
        && (host === 'maps.google.com' || url.pathname === '/maps' || url.pathname.startsWith('/maps/')));
  } catch {
    return false;
  }
}

export function safeGoogleMapsUrl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return isGoogleMapsUrl(trimmed) ? trimmed : '';
}

function hasUrl(value) {
  return /https?:\/\/\S+/i.test(value || '');
}

export function buildGoogleMapsQuery(place) {
  const name = place?.name?.trim() || '';
  if (!name) return '';
  const note = place?.locationNote?.trim() || '';
  return note && !hasUrl(note) ? `${name} ${note}` : name;
}

export function buildGoogleMapsSearchUrl(place) {
  const query = typeof place === 'string' ? place.trim() : buildGoogleMapsQuery(place);
  if (!query) return '';
  const params = new URLSearchParams({ api: '1', query });
  return `https://www.google.com/maps/search/?${params}`;
}

function normalizePlaceMapsUrl(place) {
  const locationNote = place?.locationNote ?? '';
  const existingUrl = place?.googleMapsUrl ?? '';
  const migrate = !existingUrl.trim() && isGoogleMapsUrl(locationNote);
  return {
    ...place,
    googleMapsUrl: migrate ? locationNote.trim() : existingUrl,
    locationNote: migrate ? '' : locationNote,
  };
}

export function normalizePlanMapsUrls(plan) {
  return {
    ...plan,
    points: (plan.points || []).map(normalizePlaceMapsUrl),
    candidates: Object.fromEntries(Object.entries(plan.candidates || {}).map(([key, candidates]) => [
      key,
      candidates.map(normalizePlaceMapsUrl),
    ])),
  };
}

function formatJapaneseDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!match) return '';
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}

export function buildChatGptPrompt(plan, segmentIndex, extraRequest = '') {
  const before = plan.points[segmentIndex];
  const after = plan.points[segmentIndex + 1];
  if (!before || !after) return '';
  const date = formatJapaneseDate(plan.date);
  const route = plan.points.map((point) => point.name).join(' → ');
  const main = plan.points.find((point) => point.locked === 'main');
  const candidates = plan.candidates?.[segmentKey(before, after)] || [];
  const request = extraRequest.trim();
  const intro = date ? `${date}に車で「${plan.title}」をします。` : `車で「${plan.title}」をします。`;
  const pointLocations = [before, after].filter((point) => point.googleMapsUrl?.trim() || point.locationNote?.trim());
  const pointMemos = [before, after].filter((point) => point.memo?.trim());
  const locationSection = pointLocations.length ? `\n地点の場所情報：\n${pointLocations.map((point) => {
    if (!point.googleMapsUrl?.trim()) return `- ${point.name}：${point.locationNote.trim()}`;
    const details = [];
    if (point.googleMapsUrl?.trim()) details.push(`  - Google Maps：${point.googleMapsUrl.trim()}`);
    if (point.locationNote?.trim()) details.push(`  - 補足：${point.locationNote.trim()}`);
    return `- ${point.name}\n${details.join('\n')}`;
  }).join('\n')}\n` : '';
  const memoSection = pointMemos.length ? `\n地点メモ：\n${pointMemos.map((point) => `- ${point.name}：${point.memo.trim()}`).join('\n')}\n` : '';
  const candidateSection = candidates.length ? `\nすでに候補になっている場所：\n${candidates.map((candidate) => {
    if (!candidate.googleMapsUrl?.trim()) return `- ${candidate.name}${candidate.locationNote?.trim() ? `（${candidate.locationNote.trim()}）` : ''}`;
    const details = [];
    if (candidate.googleMapsUrl?.trim()) details.push(`  Google Maps：${candidate.googleMapsUrl.trim()}`);
    if (candidate.locationNote?.trim()) details.push(`  補足：${candidate.locationNote.trim()}`);
    return `- ${candidate.name}${details.length ? `\n${details.join('\n')}` : ''}`;
  }).join('\n')}\n` : '';
  const requestSection = request ? `\n追加の希望：\n${request}\n` : '';

  return `${intro}

現在のルートは、
${route}
です。

${main ? `メインの目的地は「${main.name}」です。\n\n` : ''}今回、
「${before.name} → ${after.name}」
の間で立ち寄れる場所を探しています。
${locationSection}${memoSection}${candidateSection}${requestSection}
地点の場所情報がある場合は、その情報を優先して具体的な場所を特定してください。Google Maps URLも地点を特定するための場所情報です。地点名だけでは具体的な場所を特定できず、場所の補足情報も十分でない場合は、別の場所を勝手に想定せず、必要な追加情報を確認してください。

有名観光地を並べるだけではなく、車だからこそ寄りやすい場所、少し変わった施設や場所、景色のいい道・スポット、地元らしい場所など、「予定していなかったけれど寄ったら面白そう」と思える候補を5件提案してください。

大きくルートを外れる場所は避け、すでに候補になっている場所との重複もできるだけ避けてください。

5件は比較しやすいよう、それぞれ以下の統一されたMarkdown形式で整理してください。

### 1. 場所名

どんな場所：
...

この区間で寄る理由：
...

寄り道感：
...

確認事項：
...

2件目以降も同じ形式で、### 2. から ### 5. まで記載してください。

確認事項には、営業時間、予約、定休日、駐車場、季節営業、その他事前に確認した方がよいことを含めてください。

必要であればWeb検索を使い、現在営業しているか、営業時間、定休日、予約、駐車場、季節営業などの最新情報も確認してください。`;
}

export function createPlan({ title, date, startName, mainName, goalName }) {
  const planId = makeId();
  return {
    title,
    date,
    points: [
      { id: `${planId}-start`, name: startName, googleMapsUrl: '', locationNote: '', memo: '', locked: 'start' },
      { id: `${planId}-main`, name: mainName, googleMapsUrl: '', locationNote: '', memo: '', locked: 'main' },
      { id: `${planId}-goal`, name: goalName, googleMapsUrl: '', locationNote: '', memo: '', locked: 'goal' },
    ],
    candidates: {},
  };
}

// `locked` identifies a point's role. Only route endpoints are position-locked;
// MAIN remains a protected point, but may be reordered between the endpoints.
export const isEndpoint = (point) => point?.locked === 'start' || point?.locked === 'goal';
export const isDraggable = (point) => Boolean(point) && !isEndpoint(point);
export const isRemovable = (point) => Boolean(point) && !point.locked;

export function insertCandidate(plan, segmentIndex, candidateId) {
  const before = plan.points[segmentIndex];
  const after = plan.points[segmentIndex + 1];
  const oldKey = segmentKey(before, after);
  const candidate = (plan.candidates[oldKey] || []).find((item) => item.id === candidateId);
  if (!candidate) return plan;
  const point = { id: candidate.id, name: candidate.name, googleMapsUrl: candidate.googleMapsUrl ?? '', locationNote: candidate.locationNote ?? '', memo: candidate.memo || '' };
  const points = [...plan.points.slice(0, segmentIndex + 1), point, ...plan.points.slice(segmentIndex + 1)];
  const rest = (plan.candidates[oldKey] || []).filter((item) => item.id !== candidateId);
  const candidates = { ...plan.candidates };
  delete candidates[oldKey];
  if (rest.length) candidates[segmentKey(before, point)] = rest;
  return { ...plan, points, candidates };
}

export function updateCandidate(plan, key, candidateId, updates) {
  const segmentCandidates = plan.candidates[key];
  if (!segmentCandidates?.some((candidate) => candidate.id === candidateId)) return plan;

  return {
    ...plan,
    candidates: {
      ...plan.candidates,
      [key]: segmentCandidates.map((candidate) => candidate.id === candidateId
        ? { ...candidate, name: updates.name, googleMapsUrl: updates.googleMapsUrl ?? candidate.googleMapsUrl ?? '', locationNote: updates.locationNote ?? candidate.locationNote ?? '', memo: updates.memo, id: candidate.id }
        : candidate),
    },
  };
}

export function moveCandidate(plan, fromKey, toKey, candidateId) {
  if (fromKey === toKey) return plan;
  const sourceCandidates = plan.candidates[fromKey];
  const candidate = sourceCandidates?.find((item) => item.id === candidateId);
  if (!candidate) return plan;

  const remainingCandidates = sourceCandidates.filter((item) => item.id !== candidateId);
  const candidates = { ...plan.candidates };
  if (remainingCandidates.length) candidates[fromKey] = remainingCandidates;
  else delete candidates[fromKey];
  candidates[toKey] = [...(plan.candidates[toKey] || []), candidate];
  return { ...plan, candidates };
}

export function removePoint(plan, pointIndex) {
  const point = plan.points[pointIndex];
  if (!isRemovable(point)) return plan;
  const before = plan.points[pointIndex - 1];
  const after = plan.points[pointIndex + 1];
  const leftKey = segmentKey(before, point);
  const rightKey = segmentKey(point, after);
  const merged = [
    ...(plan.candidates[leftKey] || []),
    { id: makeId(), name: point.name, googleMapsUrl: point.googleMapsUrl ?? '', locationNote: point.locationNote ?? '', memo: point.memo ?? '' },
    ...(plan.candidates[rightKey] || []),
  ];
  const candidates = { ...plan.candidates };
  delete candidates[leftKey];
  delete candidates[rightKey];
  candidates[segmentKey(before, after)] = merged;
  return { ...plan, points: plan.points.filter((_, index) => index !== pointIndex), candidates };
}

export function reorderPoint(plan, from, to) {
  const point = plan.points[from];
  if (!isDraggable(point) || to <= 0 || to >= plan.points.length - 1 || from === to) return plan;
  const points = [...plan.points];
  points.splice(from, 1);
  points.splice(to, 0, point);

  // A candidate collection follows the point from which its segment starts;
  // otherwise the old adjacency key would make those candidates disappear.
  const candidates = {};
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[index];
    const after = points[index + 1];
    const oldEntry = Object.entries(plan.candidates).find(([key]) => key.startsWith(`${before.id}::`));
    if (oldEntry?.[1]?.length) candidates[segmentKey(before, after)] = oldEntry[1];
  }
  return { ...plan, points, candidates };
}
