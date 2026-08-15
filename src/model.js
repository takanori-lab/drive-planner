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
  if (!point || point.locked) return plan;
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
  if (!point || point.locked || plan.points[to]?.locked || to <= 0 || to >= plan.points.length - 1 || from === to) return plan;
  const points = [...plan.points];
  points.splice(from, 1);
  points.splice(to, 0, point);
  return { ...plan, points };
}
