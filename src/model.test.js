import { describe, expect, it } from 'vitest';
import { addAiResultsToSegment, aiResultToCandidate, buildChatGptPrompt, buildCompactCandidateMemo, buildGoogleMapsSearchUrl, createPlan, initialPlan, insertCandidate, isDraggable, isEndpoint, isGoogleMapsUrl, isRemovable, moveCandidate, normalizePlanMapsUrls, removePoint, reorderPoint, safeGoogleMapsUrl, segmentKey, updateCandidate, updatePlanInfo, updatePoint } from './model';

describe('plan model', () => {
  it('ドライブ名と日付だけを更新し、地点・候補・未知の情報を維持する', () => {
    const plan = { ...initialPlan(), date: '2026-08-24', aiContext: { version: 2 } };
    plan.candidates['tokyo-start::kawaguchiko'] = [{ id: 'candidate', name: '候補' }];
    const next = updatePlanInfo(plan, { title: '  新しい名前  ', date: '2026-09-01' });
    expect(next).toMatchObject({ title: '新しい名前', date: '2026-09-01', aiContext: plan.aiContext });
    expect(next.points).toBe(plan.points);
    expect(next.candidates).toBe(plan.candidates);
  });

  it.each([
    ['tokyo-start', 'start'],
    ['kawaguchiko', 'main'],
    ['tokyo-goal', 'goal'],
    ['normal', undefined],
  ])('%sの場所情報をidで更新し、identityと役割を維持する', (pointId, locked) => {
    const plan = initialPlan();
    if (pointId === 'normal') plan.points.splice(2, 0, { id: pointId, name: '通常地点', custom: true });
    const original = plan.points.find((point) => point.id === pointId);
    const next = updatePoint(plan, pointId, { name: ' 変更後 ', googleMapsUrl: ' https://maps.app.goo.gl/example ', locationNote: ' 補足 ', memo: ' メモ ' });
    const updated = next.points.find((point) => point.id === pointId);
    expect(updated).toMatchObject({ id: pointId, name: '変更後', googleMapsUrl: 'https://maps.app.goo.gl/example', locationNote: '補足', memo: 'メモ' });
    expect(updated.locked).toBe(locked);
    expect(updated.custom).toBe(original.custom);
  });

  it('地点名の変更後もidベースのsegmentとcandidateをそのまま維持する', () => {
    const plan = initialPlan();
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [{ id: 'candidate', name: '既存候補' }];
    const next = updatePoint(plan, 'tokyo-start', { name: '船橋駅', googleMapsUrl: '', locationNote: '', memo: '' });
    expect(segmentKey(next.points[0], next.points[1])).toBe(key);
    expect(next.candidates).toBe(plan.candidates);
    expect(next.candidates[key]).toEqual(plan.candidates[key]);
  });
  const aiResult = (name, overrides = {}) => ({
    resultId: `ai-${name}`,
    name,
    locationHint: ' 山梨県都留市 ',
    description: '湖を眺められる小さなパン屋です。',
    reason: '通り道から立ち寄りやすいため。',
    detourLevel: 'small',
    detourNote: '所要15分ほど',
    checkItems: ['営業時間を確認', '駐車場を確認'],
    ...overrides,
  });

  it('AI resultを通常candidateの項目だけへ変換する', () => {
    const converted = aiResultToCandidate(aiResult(' 湖畔のパン屋 '));
    expect(Object.keys(converted)).toEqual(['id', 'name', 'googleMapsUrl', 'locationNote', 'memo']);
    expect(converted.id).not.toBe('ai- 湖畔のパン屋 ');
    expect(converted).toMatchObject({ name: '湖畔のパン屋', googleMapsUrl: '', locationNote: '山梨県都留市' });
    expect(converted.memo).toBe('湖を眺められる小さなパン屋です。\n寄る理由：通り道から立ち寄りやすいため。\n寄り道 小：所要15分ほど\n確認：営業時間を確認 / 駐車場を確認');
  });

  it('空情報に不自然な区切りを作らずmemoを200文字以内にする', () => {
    expect(buildCompactCandidateMemo({ checkItems: ['', '  '] })).toBe('');
    expect(buildCompactCandidateMemo({ description: '長'.repeat(250), reason: '理由' })).toHaveLength(200);
  });

  it('選択結果を対象区間の末尾だけへ追加し、0件なら変更しない', () => {
    const plan = initialPlan();
    const targetKey = segmentKey(plan.points[0], plan.points[1]);
    const otherKey = segmentKey(plan.points[1], plan.points[2]);
    plan.candidates[targetKey] = [{ id: 'old', name: '既存', googleMapsUrl: '', locationNote: '', memo: '' }];
    plan.candidates[otherKey] = [{ id: 'other', name: '別区間', googleMapsUrl: '', locationNote: '', memo: '' }];
    expect(addAiResultsToSegment(plan, 'tokyo-start', 'kawaguchiko', []).plan).toBe(plan);
    const outcome = addAiResultsToSegment(plan, 'tokyo-start', 'kawaguchiko', [aiResult('候補C'), aiResult('候補D')]);
    expect(outcome.addedCount).toBe(2);
    expect(outcome.plan.candidates[targetKey].map(({ name }) => name)).toEqual(['既存', '候補C', '候補D']);
    expect(outcome.plan.candidates[otherKey]).toBe(plan.candidates[otherKey]);
  });

  it('対象地点が隣接していなければplanを変更しない', () => {
    const plan = initialPlan();
    const outcome = addAiResultsToSegment(plan, 'tokyo-start', 'tokyo-goal', [aiResult('候補')]);
    expect(outcome).toMatchObject({ plan, segmentFound: false, addedCount: 0 });
    expect(outcome.plan).toBe(plan);
  });

  it('既存および選択内の実質同名を除き、追加可能な候補だけ追加する', () => {
    const plan = initialPlan();
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [{ id: 'old', name: ' Lake Cafe ', googleMapsUrl: '', locationNote: '', memo: '' }];
    const outcome = addAiResultsToSegment(plan, 'tokyo-start', 'kawaguchiko', [
      aiResult('ＬＡＫＥ　ＣＡＦＥ'), aiResult('展望 台'), aiResult(' 展望台 '), aiResult('パン屋'),
    ]);
    expect(outcome).toMatchObject({ segmentFound: true, addedCount: 2, duplicateCount: 2 });
    expect(outcome.plan.candidates[key].map(({ name }) => name)).toEqual([' Lake Cafe ', '展望 台', 'パン屋']);
  });

  it('追加したcandidateを既存の編集・移動・ルート追加・ルート解除処理で扱える', () => {
    let plan = addAiResultsToSegment(initialPlan(), 'tokyo-start', 'kawaguchiko', [aiResult('パン屋')]).plan;
    const firstKey = 'tokyo-start::kawaguchiko';
    const id = plan.candidates[firstKey][0].id;
    plan = updateCandidate(plan, firstKey, id, { name: 'ベーカリー', googleMapsUrl: '', locationNote: '都留市', memo: '朝' });
    plan = moveCandidate(plan, firstKey, 'kawaguchiko::tokyo-goal', id);
    plan = insertCandidate(plan, 1, id);
    expect(plan.points[2]).toMatchObject({ id, name: 'ベーカリー', locationNote: '都留市', memo: '朝' });
    plan = removePoint(plan, 2);
    expect(Object.values(plan.candidates).flat().some((item) => item.name === 'ベーカリー')).toBe(true);
  });
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

    expect(next.candidates[key][0]).toEqual({ id: 'bakery', name: '湖畔のベーカリー', googleMapsUrl: '', locationNote: '河口湖の北側', memo: '9時ごろ寄りたい' });
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

  it('候補昇格時に区間の経路条件を分割後の両区間へ引き継ぐ', () => {
    const plan = initialPlan();
    const before = plan.points[0]; const after = plan.points[1];
    const oldKey = segmentKey(before, after);
    plan.candidates[oldKey] = [{ id: 'falls', name: '田原の滝', locationNote: '', memo: '' }];
    plan.segmentRoutingConditions[oldKey] = 'local_roads';

    const inserted = insertCandidate(plan, 0, 'falls');
    expect(inserted.segmentRoutingConditions).toEqual({
      [`${before.id}::falls`]: 'local_roads',
      [`falls::${after.id}`]: 'local_roads',
    });
    expect(inserted.segmentRoutingConditions).not.toHaveProperty(oldKey);
  });

  it('同じ経路条件を持つ両区間を結合すると条件を引き継ぐ', () => {
    const plan = initialPlan();
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [{ id: 'falls', name: '田原の滝', locationNote: '', memo: '' }];
    plan.segmentRoutingConditions[key] = 'local_roads';

    const inserted = insertCandidate(plan, 0, 'falls');
    const removed = removePoint(inserted, 1);

    expect(removed.segmentRoutingConditions).toEqual({ [key]: 'local_roads' });
  });

  it('全体設定と一致する有効な区間条件を結合後も引き継ぐ', () => {
    const plan = initialPlan();
    const before = plan.points[0]; const after = plan.points[1];
    const key = segmentKey(before, after);
    plan.candidates[key] = [{ id: 'falls', name: '田原の滝', locationNote: '', memo: '' }];
    plan.segmentRoutingConditions[key] = 'local_roads';

    const inserted = insertCandidate(plan, 0, 'falls');
    const withMatchingDefault = {
      ...inserted,
      routingCondition: 'local_roads',
      segmentRoutingConditions: { ...inserted.segmentRoutingConditions },
    };
    delete withMatchingDefault.segmentRoutingConditions[`falls::${after.id}`];

    const removed = removePoint(withMatchingDefault, 1);
    expect(removed.segmentRoutingConditions).toEqual({ [key]: 'local_roads' });
  });

  it('updates candidate locationNote without changing its id or segment', () => {
    const plan = initialPlan();
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [{ id: 'falls', name: '田原の滝', locationNote: '都留市', memo: '景色' }];

    const next = updateCandidate(plan, key, 'falls', { name: '田原の滝', locationNote: '山梨県都留市', memo: '景色が良さそう' });
    expect(next.candidates[key][0]).toEqual({ id: 'falls', name: '田原の滝', googleMapsUrl: '', locationNote: '山梨県都留市', memo: '景色が良さそう' });
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

  it('adds an empty Google Maps URL to initial and newly created points', () => {
    expect(initialPlan().points.every((point) => point.googleMapsUrl === '')).toBe(true);
    const created = createPlan({ title: '旅', date: '2026-09-01', startName: '東京', mainName: '富士山', goalName: '横浜' });
    expect(created.points.map((point) => point.googleMapsUrl)).toEqual(['', '', '']);
  });

  it('recognizes supported Google Maps URLs and rejects unsafe or unrelated URLs', () => {
    expect(isGoogleMapsUrl('https://maps.app.goo.gl/abc')).toBe(true);
    expect(isGoogleMapsUrl('https://www.google.com/maps/place/test')).toBe(true);
    expect(isGoogleMapsUrl('https://maps.google.com/?q=test')).toBe(true);
    expect(isGoogleMapsUrl('https://goo.gl/maps/abc')).toBe(true);
    expect(safeGoogleMapsUrl(' javascript:alert(1) ')).toBe('');
    expect(safeGoogleMapsUrl('https://example.com/maps')).toBe('');
    expect(safeGoogleMapsUrl('https://google.com.example.com/maps')).toBe('');
    expect(safeGoogleMapsUrl('https://other.google.com/maps')).toBe('');
  });

  it('migrates only a whole legacy Maps URL and supplies missing fields', () => {
    const plan = initialPlan();
    plan.points = [
      { id: 'url', name: 'URL', locationNote: 'https://maps.app.goo.gl/abc', memo: '' },
      { id: 'note', name: '補足', locationNote: '河口湖の北側', memo: '' },
      { id: 'mixed', name: '混在', locationNote: '河口湖の北側 https://maps.app.goo.gl/abc', memo: '' },
    ];
    plan.candidates = { segment: [{ id: 'candidate', name: '候補', locationNote: 'https://goo.gl/maps/xyz', memo: '' }] };
    const normalized = normalizePlanMapsUrls(plan);
    expect(normalized.points[0]).toMatchObject({ googleMapsUrl: 'https://maps.app.goo.gl/abc', locationNote: '' });
    expect(normalized.points[1]).toMatchObject({ googleMapsUrl: '', locationNote: '河口湖の北側' });
    expect(normalized.points[2]).toMatchObject({ googleMapsUrl: '', locationNote: '河口湖の北側 https://maps.app.goo.gl/abc' });
    expect(normalized.candidates.segment[0]).toMatchObject({ googleMapsUrl: 'https://goo.gl/maps/xyz', locationNote: '' });
  });

  it('builds an encoded Maps search URL from a name and location note', () => {
    const search = new URL(buildGoogleMapsSearchUrl({ name: 'Lake Bake', locationNote: '河口湖の北側' }));
    expect(search.searchParams.get('query')).toBe('Lake Bake 河口湖の北側');
    expect(buildGoogleMapsSearchUrl({ name: '  ', locationNote: '河口湖' })).toBe('');
  });

  it('preserves and updates Google Maps URLs through candidate operations', () => {
    const plan = initialPlan();
    const key = segmentKey(plan.points[0], plan.points[1]);
    const url = 'https://maps.app.goo.gl/falls';
    plan.candidates[key] = [{ id: 'falls', name: '田原の滝', googleMapsUrl: url, locationNote: '都留市', memo: '' }];
    const inserted = insertCandidate(plan, 0, 'falls');
    expect(inserted.points[1].googleMapsUrl).toBe(url);
    expect(removePoint(inserted, 1).candidates[key][0].googleMapsUrl).toBe(url);
    const updated = updateCandidate(plan, key, 'falls', { name: '田原の滝', googleMapsUrl: 'https://goo.gl/maps/new', locationNote: '都留市', memo: '' });
    expect(updated.candidates[key][0].googleMapsUrl).toBe('https://goo.gl/maps/new');
    expect(moveCandidate(plan, key, segmentKey(plan.points[1], plan.points[2]), 'falls').candidates['kawaguchiko::tokyo-goal'][0].googleMapsUrl).toBe(url);
  });

  it('includes point and candidate Maps URLs in the prompt without mixing memo roles', () => {
    const plan = initialPlan();
    plan.points[0].googleMapsUrl = 'https://maps.app.goo.gl/start';
    plan.points[0].locationNote = '丸の内側';
    plan.points[0].memo = '朝出発';
    const key = segmentKey(plan.points[0], plan.points[1]);
    plan.candidates[key] = [{ id: 'cafe', name: 'カフェ', googleMapsUrl: 'https://goo.gl/maps/cafe', locationNote: '', memo: '静か' }];
    const prompt = buildChatGptPrompt(plan, 0);
    expect(prompt).toContain('- Google Maps：https://maps.app.goo.gl/start');
    expect(prompt).toContain('- 補足：丸の内側');
    expect(prompt).toContain('地点メモ：\n- 東京駅：朝出発');
    expect(prompt).toContain('Google Maps：https://goo.gl/maps/cafe');
    expect(prompt).not.toContain('地点の場所情報：\n- 東京駅：朝出発');
  });

});
