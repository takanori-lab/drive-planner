import { describe, expect, it } from 'vitest';
import { initialPlan, normalizePlanMapsUrls, reorderPoint, routeTotal, routingConditionForSegment, setSegmentRoutingCondition } from './model';

describe('routing plan model', () => {
  it('既存localStorage形式へおすすめと空のoverrideを補う', () => {
    const old = { title: '旧プラン', points: initialPlan().points, candidates: {} };
    expect(normalizePlanMapsUrls(old)).toMatchObject({ routingCondition: 'recommended', segmentRoutingConditions: {} });
  });
  it('地点名を変えても地点IDベースのoverrideを維持する', () => {
    const plan = initialPlan(); const before = plan.points[0], after = plan.points[1];
    const overridden = setSegmentRoutingCondition(plan, before, after, 'local_roads');
    overridden.points[0] = { ...before, name: '東京駅丸の内口' };
    expect(routingConditionForSegment(overridden, overridden.points[0], after)).toBe('local_roads');
  });
  it('並び替え後に存在しないsegmentのoverrideを除去する', () => {
    const plan = initialPlan(); plan.points.splice(2, 0, { id: 'stop', name: '休憩', googleMapsUrl: '', locationNote: '', memo: '' });
    plan.segmentRoutingConditions = { 'kawaguchiko::stop': 'local_roads' };
    expect(reorderPoint(plan, 2, 1).segmentRoutingConditions).toEqual({});
  });
  it('candidateを含めず、失敗区間があれば部分合計として返す', () => {
    const plan = initialPlan(); plan.candidates['tokyo-start::kawaguchiko'] = [{ id: 'candidate', name: '候補' }];
    const total = routeTotal(plan.points, { 'tokyo-start::kawaguchiko': { status: 'ok', distanceMeters: 1000, durationSeconds: 600 }, 'kawaguchiko::tokyo-goal': { status: 'error' } });
    expect(total).toEqual({ complete: false, completed: 1, total: 2, distanceMeters: 1000, durationSeconds: 600 });
  });
});
