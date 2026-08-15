import { describe, expect, it } from 'vitest';
import { initialPlan, insertCandidate, removePoint, reorderPoint, segmentKey } from './model';

describe('plan model', () => {
  it('inserts a candidate and creates two segments', () => {
    const plan = initialPlan();
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [{ id: 'view', name: '展望台', memo: '夕方' }];
    const next = insertCandidate(plan, 0, 'view');
    expect(next.points.map((p) => p.name)).toEqual(['東京駅', '展望台', '河口湖', '東京駅']);
    expect(segmentKey(next.points[0], next.points[1])).toBe('tokyo-start::view');
    expect(segmentKey(next.points[1], next.points[2])).toBe('view::kawaguchiko');
  });

  it('returns a removed point to the merged segment', () => {
    let plan = initialPlan();
    plan.points.splice(1, 0, { id: 'stop', name: '休憩所', memo: '' });
    plan = removePoint(plan, 1);
    expect(plan.candidates['tokyo-start::kawaguchiko'][0].name).toBe('休憩所');
  });

  it('protects locked points while reordering normal points', () => {
    const plan = initialPlan();
    plan.points.splice(1, 0, { id: 'stop', name: '休憩所', memo: '' }, { id: 'cafe', name: 'カフェ', memo: '' });
    expect(reorderPoint(plan, 0, 1)).toBe(plan);
    expect(reorderPoint(plan, 1, 3)).toBe(plan);
    expect(reorderPoint(plan, 1, 2).points[2].name).toBe('休憩所');
  });

  it('moves candidate segments with their starting point when reordering', () => {
    const plan = initialPlan();
    plan.points.splice(1, 0,
      { id: 'stop', name: '休憩所', memo: '' },
      { id: 'cafe', name: 'カフェ', memo: '' },
    );
    plan.candidates['stop::cafe'] = [{ id: 'park', name: '公園', memo: '' }];
    const next = reorderPoint(plan, 1, 2);
    expect(next.points.map((point) => point.id)).toEqual(['tokyo-start', 'cafe', 'stop', 'kawaguchiko', 'tokyo-goal']);
    expect(next.candidates['stop::kawaguchiko']).toEqual(plan.candidates['stop::cafe']);
    expect(next.candidates['stop::cafe']).toBeUndefined();
  });
});
