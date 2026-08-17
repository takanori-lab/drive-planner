export const STORAGE_KEY = 'drive-planner:v1';

export const initialPlan = () => ({
  title: '東京発・河口湖ドライブ',
  points: [
    { id: 'tokyo-start', name: '東京駅', memo: '', locked: 'start' },
    { id: 'kawaguchiko', name: '河口湖', memo: '', locked: 'main' },
    { id: 'tokyo-goal', name: '東京駅', memo: '', locked: 'goal' },
  ],
  candidates: {},
});

export const segmentKey = (a, b) => `${a.id}::${b.id}`;
export const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createPlan({ title, date, startName, mainName, goalName }) {
  const planId = makeId();
  return {
    title,
    date,
    points: [
      { id: `${planId}-start`, name: startName, memo: '', locked: 'start' },
      { id: `${planId}-main`, name: mainName, memo: '', locked: 'main' },
      { id: `${planId}-goal`, name: goalName, memo: '', locked: 'goal' },
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
  const point = { id: candidate.id, name: candidate.name, memo: candidate.memo || '' };
  const points = [...plan.points.slice(0, segmentIndex + 1), point, ...plan.points.slice(segmentIndex + 1)];
  const rest = (plan.candidates[oldKey] || []).filter((item) => item.id !== candidateId);
  const candidates = { ...plan.candidates };
  delete candidates[oldKey];
  if (rest.length) candidates[segmentKey(before, point)] = rest;
  return { ...plan, points, candidates };
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
    { id: makeId(), name: point.name, memo: point.memo },
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
