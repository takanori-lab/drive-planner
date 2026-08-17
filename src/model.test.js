import { describe, expect, it } from 'vitest';
import { buildChatGptPrompt, createPlan, initialPlan, insertCandidate, isDraggable, isEndpoint, isRemovable, moveCandidate, removePoint, reorderPoint, segmentKey, updateCandidate } from './model';

describe('plan model', () => {
  it('builds a ChatGPT prompt with all drive context', () => {
    const plan = initialPlan();
    plan.title = '富士山周辺ドライブ';
    plan.date = '2026-08-29';
    plan.points.splice(1, 0, { id: 'bakery', name: '湖畔のパン屋', locationNote: ' 河口湖の北側にある店舗 ', memo: '美味しい' });
    plan.points[2].locationNote = '富士スバルライン五合目';
    plan.points[2].memo = '写真を撮りたい';
    plan.candidates[segmentKey(plan.points[1], plan.points[2])] = [
      { id: 'cake', name: '湖畔のケーキ屋', locationNote: '河口湖町○○', memo: '' },
      { id: 'view', name: '展望台', memo: '' },
    ];
    const prompt = buildChatGptPrompt(plan, 1, '景色がいい場所が気になる');
    expect(prompt).toContain('2026年8月29日');
    expect(prompt).toContain('「富士山周辺ドライブ」');
    expect(prompt).toContain('東京駅 → 湖畔のパン屋 → 河口湖 → 東京駅');
    expect(prompt).toContain('「湖畔のパン屋 → 河口湖」');
    expect(prompt).toContain('メインの目的地は「河口湖」');
    expect(prompt).toContain('地点の場所情報：\n- 湖畔のパン屋：河口湖の北側にある店舗\n- 河口湖：富士スバルライン五合目');
    expect(prompt).toContain('地点メモ：\n- 湖畔のパン屋：美味しい\n- 河口湖：写真を撮りたい');
    expect(prompt).toContain('- 湖畔のケーキ屋（河口湖町○○）\n- 展望台');
    expect(prompt).toContain('追加の希望：\n景色がいい場所が気になる');
    expect(prompt).toContain('候補を5件提案してください');
    expect(prompt).not.toContain('5件程度');
    expect(prompt).not.toContain('相性が特に良い2件');
    expect(prompt).toContain('統一されたMarkdown形式');
    expect(prompt).toContain('### 1. 場所名');
    expect(prompt).toContain('どんな場所：');
    expect(prompt).toContain('この区間で寄る理由：');
    expect(prompt).toContain('寄り道感：');
    expect(prompt).toContain('確認事項：');
    expect(prompt).toContain('### 5.');
    expect(prompt).toContain('営業時間、予約、定休日、駐車場、季節営業');
  });

  it('builds a prompt without optional date, candidates, or request', () => {
    const prompt = buildChatGptPrompt(initialPlan(), 0, '   ');
    expect(prompt).toContain('車で「東京発・河口湖ドライブ」をします。');
    expect(prompt).toContain('東京駅 → 河口湖 → 東京駅');
    expect(prompt).toContain('「東京駅 → 河口湖」');
    expect(prompt).toContain('メインの目的地は「河口湖」');
    expect(prompt).not.toContain('年');
    expect(prompt).not.toContain('すでに候補になっている場所：');
    expect(prompt).not.toContain('追加の希望：');
    expect(prompt).not.toContain('地点の場所情報：');
    expect(prompt).not.toContain('地点メモ：');
  });

  it('includes only a memo from the before point as a separate memo section', () => {
    const plan = initialPlan();
    plan.points[0].memo = '丸の内側から出発';

    const prompt = buildChatGptPrompt(plan, 0);

    expect(prompt).toContain('地点メモ：\n- 東京駅：丸の内側から出発');
    expect(prompt).not.toContain('地点の場所情報：');
    expect(prompt).not.toContain('- 河口湖：');
  });

  it('includes only a memo from the after point as a separate memo section', () => {
    const plan = initialPlan();
    plan.points[1].memo = '湖の北岸を中心に観光';

    const prompt = buildChatGptPrompt(plan, 0);

    expect(prompt).toContain('地点メモ：\n- 河口湖：湖の北岸を中心に観光');
    expect(prompt).not.toContain('地点の場所情報：');
    expect(prompt).not.toContain('- 東京駅：');
  });

  it('creates a new plan with unique role-specific points and no candidates', () => {
    const plan = createPlan({
      title: '富士山周辺ドライブ',
      date: '2026-09-20',
      startName: '東京駅',
      mainName: '富士山',
      goalName: '東京駅',
    });

    expect(plan.title).toBe('富士山周辺ドライブ');
    expect(plan.date).toBe('2026-09-20');
    expect(plan.points.map(({ name, locked, locationNote, memo }) => ({ name, locked, locationNote, memo }))).toEqual([
      { name: '東京駅', locked: 'start', locationNote: '', memo: '' },
      { name: '富士山', locked: 'main', locationNote: '', memo: '' },
      { name: '東京駅', locked: 'goal', locationNote: '', memo: '' },
    ]);
    expect(new Set(plan.points.map((point) => point.id)).size).toBe(3);
    expect(plan.candidates).toEqual({});
  });

  it('inserts a candidate and creates two segments', () => {
    const plan = initialPlan();
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [{ id: 'view', name: '展望台', memo: '夕方' }];
    const next = insertCandidate(plan, 0, 'view');
    expect(next.points.map((p) => p.name)).toEqual(['東京駅', '展望台', '河口湖', '東京駅']);
    expect(segmentKey(next.points[0], next.points[1])).toBe('tokyo-start::view');
    expect(segmentKey(next.points[1], next.points[2])).toBe('view::kawaguchiko');
  });

  it('updates only the selected candidate while preserving its id and segment', () => {
    const plan = initialPlan();
    const key = 'tokyo-start::kawaguchiko';
    const otherKey = 'kawaguchiko::tokyo-goal';
    plan.candidates = {
      [key]: [
        { id: 'bakery', name: '湖畔のパン屋', memo: '朝寄りたい' },
        { id: 'cafe', name: 'カフェ', memo: '休憩' },
      ],
      [otherKey]: [{ id: 'park', name: '公園', memo: '散歩' }],
    };

    const next = updateCandidate(plan, key, 'bakery', { name: '湖畔のベーカリー', locationNote: '河口湖の北側', memo: '9時ごろ寄りたい' });

    expect(next.candidates[key][0]).toEqual({ id: 'bakery', name: '湖畔のベーカリー', locationNote: '河口湖の北側', memo: '9時ごろ寄りたい' });
    expect(next.candidates[key][1]).toBe(plan.candidates[key][1]);
    expect(next.candidates[otherKey]).toBe(plan.candidates[otherKey]);
    expect(Object.keys(next.candidates)).toEqual(Object.keys(plan.candidates));
    expect(Object.values(next.candidates).flat()).toHaveLength(3);
  });

  it('returns the original plan when the candidate does not exist', () => {
    const plan = initialPlan();
    plan.candidates['tokyo-start::kawaguchiko'] = [{ id: 'cafe', name: 'カフェ', memo: '' }];
    expect(updateCandidate(plan, 'tokyo-start::kawaguchiko', 'missing', { name: '別名', memo: '別メモ' })).toBe(plan);
    expect(updateCandidate(plan, 'missing::segment', 'cafe', { name: '別名', memo: '別メモ' })).toBe(plan);
  });

  it('moves one unchanged candidate to the end of another segment', () => {
    const plan = initialPlan();
    const fromKey = 'tokyo-start::kawaguchiko';
    const toKey = 'kawaguchiko::tokyo-goal';
    const otherKey = 'unrelated::segment';
    const moving = { id: 'bakery', name: '湖畔のパン屋', memo: '朝寄りたい' };
    const sourceOther = { id: 'cafe', name: 'カフェ', memo: '休憩' };
    const destinationOther = { id: 'park', name: '公園', memo: '散歩' };
    const unrelated = [{ id: 'shop', name: '売店', memo: '' }];
    plan.candidates = { [fromKey]: [moving, sourceOther], [toKey]: [destinationOther], [otherKey]: unrelated };
    const countBefore = Object.values(plan.candidates).flat().length;

    const next = moveCandidate(plan, fromKey, toKey, moving.id);

    expect(next.candidates[fromKey]).toEqual([sourceOther]);
    expect(next.candidates[toKey]).toEqual([destinationOther, moving]);
    expect(next.candidates[toKey][1]).toBe(moving);
    expect(next.candidates[toKey][1]).toEqual({ id: 'bakery', name: '湖畔のパン屋', memo: '朝寄りたい' });
    expect(next.candidates[otherKey]).toBe(unrelated);
    expect(Object.values(next.candidates).flat()).toHaveLength(countBefore);
  });

  it('removes an empty source segment after moving its last candidate', () => {
    const plan = initialPlan();
    const fromKey = 'tokyo-start::kawaguchiko';
    const toKey = 'kawaguchiko::tokyo-goal';
    plan.candidates[fromKey] = [{ id: 'bakery', name: '湖畔のパン屋', memo: '' }];
    const next = moveCandidate(plan, fromKey, toKey, 'bakery');
    expect(next.candidates[fromKey]).toBeUndefined();
    expect(next.candidates[toKey]).toEqual([{ id: 'bakery', name: '湖畔のパン屋', memo: '' }]);
  });

  it('returns the original plan for a missing candidate or the same segment', () => {
    const plan = initialPlan();
    const fromKey = 'tokyo-start::kawaguchiko';
    plan.candidates[fromKey] = [{ id: 'bakery', name: '湖畔のパン屋', memo: '' }];
    expect(moveCandidate(plan, fromKey, 'kawaguchiko::tokyo-goal', 'missing')).toBe(plan);
    expect(moveCandidate(plan, fromKey, fromKey, 'bakery')).toBe(plan);
  });

  it('returns a removed point to the merged segment', () => {
    let plan = initialPlan();
    plan.points.splice(1, 0, { id: 'stop', name: '休憩所', memo: '' });
    plan = removePoint(plan, 1);
    expect(plan.candidates['tokyo-start::kawaguchiko'][0].name).toBe('休憩所');
  });

  it('keeps start and goal fixed while reordering normal points', () => {
    const plan = initialPlan();
    plan.points.splice(1, 0, { id: 'stop', name: '休憩所', memo: '' }, { id: 'cafe', name: 'カフェ', memo: '' });
    expect(reorderPoint(plan, 0, 1)).toBe(plan);
    expect(reorderPoint(plan, plan.points.length - 1, 2)).toBe(plan);
    expect(reorderPoint(plan, 1, 3).points.map((point) => point.id)).toEqual([
      'tokyo-start', 'cafe', 'kawaguchiko', 'stop', 'tokyo-goal',
    ]);
    expect(reorderPoint(plan, 1, 2).points[2].name).toBe('休憩所');
  });

  it('separates point roles from drag and remove permissions', () => {
    const [start, main, goal] = initialPlan().points;
    expect([start, main, goal].map(isEndpoint)).toEqual([true, false, true]);
    expect([start, main, goal].map(isDraggable)).toEqual([false, true, false]);
    expect([start, main, goal].map(isRemovable)).toEqual([false, false, false]);
    expect(isRemovable({ id: 'stop', name: '地点A' })).toBe(true);
  });

  it('moves MAIN freely between normal points but never beyond endpoints', () => {
    const plan = initialPlan();
    plan.points.splice(1, 0, { id: 'a', name: '地点A', memo: '' });
    plan.points.splice(3, 0, { id: 'b', name: '地点B', memo: '' });

    const beforeA = reorderPoint(plan, 2, 1);
    expect(beforeA.points.map((point) => point.id)).toEqual([
      'tokyo-start', 'kawaguchiko', 'a', 'b', 'tokyo-goal',
    ]);
    const afterB = reorderPoint(beforeA, 1, 3);
    expect(afterB.points.map((point) => point.id)).toEqual([
      'tokyo-start', 'a', 'b', 'kawaguchiko', 'tokyo-goal',
    ]);
    expect(reorderPoint(afterB, 3, 0)).toBe(afterB);
    expect(reorderPoint(afterB, 3, 4)).toBe(afterB);
  });

  it('rejects moving a normal point outside the route endpoints', () => {
    const plan = initialPlan();
    plan.points.splice(1, 0, { id: 'a', name: '地点A', memo: '' });
    expect(reorderPoint(plan, 1, 0)).toBe(plan);
    expect(reorderPoint(plan, 1, plan.points.length - 1)).toBe(plan);
  });

  it('does not remove MAIN', () => {
    const plan = initialPlan();
    expect(removePoint(plan, 1)).toBe(plan);
  });

  it('moves normal points to either side of MAIN while keeping candidates on their starting point', () => {
    const plan = initialPlan();
    plan.points.splice(1, 0,
      { id: 'stop', name: '休憩所', memo: '' },
      { id: 'cafe', name: 'カフェ', memo: '' },
    );
    plan.points.splice(4, 0, { id: 'park', name: '公園', memo: '' });
    plan.candidates['stop::cafe'] = [{ id: 'shop', name: '売店', memo: '' }];

    const afterMain = reorderPoint(plan, 1, 3);
    expect(afterMain.points.map((point) => point.id)).toEqual([
      'tokyo-start', 'cafe', 'kawaguchiko', 'stop', 'park', 'tokyo-goal',
    ]);
    expect(afterMain.candidates['stop::park']).toEqual(plan.candidates['stop::cafe']);
    expect(afterMain.candidates['stop::cafe']).toBeUndefined();

    const beforeMain = reorderPoint(afterMain, 4, 2);
    expect(beforeMain.points.map((point) => point.id)).toEqual([
      'tokyo-start', 'cafe', 'park', 'kawaguchiko', 'stop', 'tokyo-goal',
    ]);
    expect(beforeMain.candidates['stop::tokyo-goal']).toEqual(plan.candidates['stop::cafe']);
    expect(Object.values(beforeMain.candidates).flat()).toHaveLength(1);
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

  it('keeps every candidate unique when MAIN is reordered', () => {
    const plan = initialPlan();
    plan.points.splice(1, 0, { id: 'a', name: '地点A', memo: '' });
    plan.points.splice(3, 0, { id: 'b', name: '地点B', memo: '' });
    plan.candidates = {
      'tokyo-start::a': [{ id: 'c1', name: '候補1', memo: '' }],
      'a::kawaguchiko': [{ id: 'c2', name: '候補2', memo: '' }],
      'kawaguchiko::b': [{ id: 'c3', name: '候補3', memo: '' }],
      'b::tokyo-goal': [{ id: 'c4', name: '候補4', memo: '' }],
    };

    const next = reorderPoint(plan, 2, 3);
    expect(next.points.map((point) => point.id)).toEqual([
      'tokyo-start', 'a', 'b', 'kawaguchiko', 'tokyo-goal',
    ]);
    expect(next.candidates).toEqual({
      'tokyo-start::a': plan.candidates['tokyo-start::a'],
      'a::b': plan.candidates['a::kawaguchiko'],
      'b::kawaguchiko': plan.candidates['b::tokyo-goal'],
      'kawaguchiko::tokyo-goal': plan.candidates['kawaguchiko::b'],
    });
    expect(Object.values(next.candidates).flat().map((candidate) => candidate.id).sort()).toEqual([
      'c1', 'c2', 'c3', 'c4',
    ]);
  });

  it('adds an empty locationNote to every initial point', () => {
    expect(initialPlan().points.every((point) => point.locationNote === '')).toBe(true);
  });

  it('preserves locationNote when a candidate joins and leaves the route', () => {
    const plan = initialPlan();
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [{ id: 'falls', name: '田原の滝', locationNote: '山梨県都留市', memo: '景色が良さそう' }];

    const inserted = insertCandidate(plan, 0, 'falls');
    expect(inserted.points[1]).toMatchObject({ id: 'falls', locationNote: '山梨県都留市', memo: '景色が良さそう' });

    const removed = removePoint(inserted, 1);
    expect(removed.candidates[key][0]).toMatchObject({ name: '田原の滝', locationNote: '山梨県都留市', memo: '景色が良さそう' });
  });

  it('updates candidate locationNote without changing its id or segment', () => {
    const plan = initialPlan();
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [{ id: 'falls', name: '田原の滝', locationNote: '都留市', memo: '景色' }];

    const next = updateCandidate(plan, key, 'falls', { name: '田原の滝', locationNote: '山梨県都留市', memo: '景色が良さそう' });
    expect(next.candidates[key][0]).toEqual({ id: 'falls', name: '田原の滝', locationNote: '山梨県都留市', memo: '景色が良さそう' });
    expect(Object.keys(next.candidates)).toEqual([key]);
  });

  it('preserves locationNote while moving a candidate', () => {
    const plan = initialPlan();
    const fromKey = segmentKey(plan.points[0], plan.points[1]);
    const toKey = segmentKey(plan.points[1], plan.points[2]);
    plan.candidates[fromKey] = [{ id: 'falls', name: '田原の滝', locationNote: '山梨県都留市', memo: '' }];

    expect(moveCandidate(plan, fromKey, toKey, 'falls').candidates[toKey][0].locationNote).toBe('山梨県都留市');
  });

  it('keeps location information and memo distinct in prompts and supports legacy data', () => {
    const plan = initialPlan();
    delete plan.points[0].locationNote;
    plan.points[0].memo = '美味しい';
    plan.points[1].locationNote = '富士スバルライン五合目';
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [
      { id: 'cake', name: '湖畔のケーキ屋', locationNote: '河口湖町○○', memo: '' },
      { id: 'view', name: '展望台', memo: '' },
    ];

    const prompt = buildChatGptPrompt(plan, 0);
    expect(prompt).toContain('地点の場所情報：\n- 河口湖：富士スバルライン五合目');
    expect(prompt).not.toContain('地点の場所情報：\n- 東京駅：美味しい');
    expect(prompt).toContain('地点メモ：\n- 東京駅：美味しい');
    expect(prompt).toContain('- 湖畔のケーキ屋（河口湖町○○）\n- 展望台');
    expect(prompt).toContain('別の場所を勝手に想定せず、必要な追加情報を確認してください');
  });

});
