import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiCandidateResults, AiCandidateSheet, AiSearchingView, CandidateSheet, PlanInfoSheet, PointCard, PointEditSheet, SearchCompanionAnimation, Segment, acquireSearchInFlight, authenticateCandidateSession, candidateLoadingMessage, requestSegmentCandidates } from './App';
import { initialPlan } from './model';
import { SESSION_STORAGE_KEY } from './api';

function storage(initialSession = null) {
  const values = new Map(initialSession ? [[SESSION_STORAGE_KEY, JSON.stringify(initialSession)]] : []);
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const validSession = () => ({ token: 'valid-session-token', expiresAt: new Date(Date.now() + 60_000).toISOString() });
const candidate = (index) => ({ resultId: `result-${index}`, name: `候補${index}`, locationHint: '山梨県', description: '説明', reason: '理由', detourLevel: 'small', detourNote: '少し寄り道', checkItems: ['営業時間'] });

describe('既存ドライブ編集UI', () => {
  it('地点解決できなかった側の地点名を表示する', () => {
    const html = renderToStaticMarkup(<Segment before={{ name: '千葉駅' }} after={{ name: '勝浦駅' }} candidates={[]}
      routeResult={{ status: 'unresolved', unresolved: ['after'] }} condition="recommended" onCondition={() => undefined}
      onAdd={() => undefined} onAsk={() => undefined} onEdit={() => undefined} onMove={() => undefined} onPromote={() => undefined} onDelete={() => undefined} />);
    expect(html).toContain('勝浦駅を特定できません');
    expect(html).not.toContain('千葉駅・勝浦駅を特定できません');
  });

  it('現在値入りのドライブ情報編集Sheetを表示する', () => {
    const html = renderToStaticMarkup(<PlanInfoSheet plan={{ title: '夏のドライブ', date: '2026-08-24' }} onClose={() => undefined} onSubmit={() => undefined} />);
    expect(html).toContain('ドライブ情報を編集');
    expect(html).toContain('value="夏のドライブ"');
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-08-24"');
    expect(html).toContain('変更を保存');
  });

  it('ルート地点編集Sheetをcandidate編集と同じ項目順で表示する', () => {
    const point = { id: 'main', locked: 'main', name: '河口湖', googleMapsUrl: 'https://maps.app.goo.gl/example', locationNote: '北岸', memo: '夕方' };
    const html = renderToStaticMarkup(<PointEditSheet point={point} onClose={() => undefined} onSubmit={() => undefined} />);
    expect(html).toContain('場所情報を編集');
    expect(html.indexOf('場所名')).toBeLessThan(html.indexOf('GoogleマップURL'));
    expect(html.indexOf('GoogleマップURL')).toBeLessThan(html.indexOf('場所の補足'));
    expect(html.indexOf('場所の補足')).toBeLessThan(html.indexOf('メモ'));
    expect(html).toContain('maxLength="60"');
    expect(html).toContain('maxLength="300"');
    expect(html).toContain('maxLength="200"');
  });

  it('PointCardは情報を表示し、inline editorではなく統一された編集操作を持つ', () => {
    const html = renderToStaticMarkup(<PointCard point={{ id: 'start', locked: 'start', name: '東京駅', locationNote: '丸の内口', memo: '集合', googleMapsUrl: '' }} index={0} total={3} onEdit={() => undefined} />);
    expect(html).toContain('丸の内口');
    expect(html).toContain('集合');
    expect(html).toContain('Googleマップで探す');
    expect(html).toContain('>編集</button>');
    expect(html).not.toContain('場所の補足</button>');
    expect(html).not.toContain('GoogleマップURLを編集');
  });

  it('candidate編集Sheetも従来どおり場所情報を編集できる', () => {
    const html = renderToStaticMarkup(<CandidateSheet route="A → B" mode="edit" initialName="候補" onClose={() => undefined} onSubmit={() => undefined} />);
    expect(html).toContain('立ち寄り候補を編集');
    expect(html).toContain('GoogleマップURL');
    expect(html).toContain('場所の補足');
    expect(html).toContain('メモ');
  });
});

describe('寄り道候補探索Sheet', () => {
  afterEach(() => {
    delete globalThis.sessionStorage;
    vi.unstubAllGlobals();
  });

  it('sessionがなければ認証画面だけを表示する', () => {
    globalThis.sessionStorage = storage();
    const html = renderToStaticMarkup(<AiCandidateSheet plan={initialPlan()} segmentIndex={0} onClose={() => undefined} />);
    expect(html).toContain('Drive Plannerのパスコード');
    expect(html).toContain('続ける');
    expect(html).not.toContain('条件を追加（任意）');
    expect(html).not.toContain('data-testid="search-companion"');
  });

  it('有効なsessionがあれば認証を飛ばし、条件を閉じた探索画面を表示する', () => {
    globalThis.sessionStorage = storage(validSession());
    const html = renderToStaticMarkup(<AiCandidateSheet plan={initialPlan()} segmentIndex={0} onClose={() => undefined} />);
    expect(html).not.toContain('Drive Plannerのパスコード');
    expect(html).toContain('<summary>条件を追加（任意）</summary>');
    expect(html).toContain('>候補を探す</button>');
    expect(html).not.toContain('<details class="search-conditions" open=""');
  });

  it('認証成功でsessionを保存するが候補探索requestは送らない', async () => {
    globalThis.sessionStorage = storage();
    const created = validSession();
    const fetchMock = vi.fn().mockResolvedValue(Response.json(created));
    vi.stubGlobal('fetch', fetchMock);
    await expect(authenticateCandidateSession('合言葉')).resolves.toEqual(created);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain('/session');
    expect(globalThis.sessionStorage.getItem(SESSION_STORAGE_KEY)).toContain(created.token);
    const html = renderToStaticMarkup(<AiCandidateSheet plan={initialPlan()} segmentIndex={0} onClose={() => undefined} />);
    expect(html).toContain('条件を追加（任意）');
  });

  it('入力した条件をfreeTextとして候補探索requestへ含める', async () => {
    const session = validSession();
    globalThis.sessionStorage = storage(session);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: 'ok', candidates: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await requestSegmentCandidates(initialPlan(), 0, ' 景色を多めに ', session);
    expect(response.expired).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/ai/segment-candidates');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).preferences.freeText).toBe('景色を多めに');
  });

  it('session期限切れ時は候補requestを送らず認証へ戻す結果を返す', async () => {
    const displayed = validSession();
    globalThis.sessionStorage = storage({ token: displayed.token, expiresAt: new Date(Date.now() - 1).toISOString() });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestSegmentCandidates(initialPlan(), 0, '', displayed)).resolves.toEqual({ expired: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('認証中と候補探索中のloading文言を分ける', () => {
    expect(candidateLoadingMessage(null)).toBe('確認しています…');
    expect(candidateLoadingMessage(validSession())).toBe('候補を探しています…');
  });

  it('AI探索中の専用UIは装飾画像と読み上げ用statusを表示する', () => {
    const html = renderToStaticMarkup(<AiSearchingView />);
    expect(html).toContain('data-testid="search-companion"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('寄り道候補を探しています…');
    expect(html).not.toContain('澪');
    expect(html).not.toContain('Mio');
  });

  it('同期的なin-flight guardは高速な2回目の探索を拒否し、解除後は再探索できる', () => {
    const searchInFlightRef = { current: false };
    expect(acquireSearchInFlight(searchInFlightRef)).toBe(true);
    expect(acquireSearchInFlight(searchInFlightRef)).toBe(false);
    searchInFlightRef.current = false;
    expect(acquireSearchInFlight(searchInFlightRef)).toBe(true);
  });

  it('検索キャラクターは装飾要素として扱う', () => {
    const html = renderToStaticMarkup(<SearchCompanionAnimation />);
    expect(html).toBe('<div class="search-companion" aria-hidden="true" data-testid="search-companion"></div>');
  });

  it('needs_clarificationでは原因地点を断定せず詳細を折りたたむ', () => {
    const html = renderToStaticMarkup(<AiCandidateResults result={{ status: 'needs_clarification', clarificationMessage: 'MAINの住所を追加してください。', candidates: [] }} />);
    expect(html).toContain('地点の場所を特定できませんでした。');
    expect(html).toContain('<summary>詳細を見る</summary>');
    expect(html).toContain('MAINの住所を追加してください。');
    expect(html).not.toContain('「河口湖」の場所を特定できませんでした。');
  });

  it('正常responseの候補を表示する', () => {
    const candidates = Array.from({ length: 5 }, (_, index) => candidate(index + 1));
    const html = renderToStaticMarkup(<AiCandidateResults result={{ status: 'ok', candidates }} />);
    expect(html.match(/class="ai-result-card(?: is-selected)?"/gu)).toHaveLength(5);
    expect(html).toContain('候補1');
    expect(html).toContain('Googleマップで探す');
    expect(html.match(/type="checkbox"/gu)).toHaveLength(5);
    expect(html).toContain('この候補を選択');
  });

  it('複数選択状態を表示できる', () => {
    const candidates = Array.from({ length: 5 }, (_, index) => candidate(index + 1));
    const html = renderToStaticMarkup(<AiCandidateResults result={{ status: 'ok', candidates }} selectedIndexes={[0, 2]} />);
    expect(html.match(/追加する候補に選択済み/gu)).toHaveLength(2);
    expect(html.match(/is-selected/gu)).toHaveLength(2);
  });

  it('選択0件では追加ボタンをdisabledで表示する', () => {
    globalThis.sessionStorage = storage(validSession());
    const candidates = Array.from({ length: 5 }, (_, index) => candidate(index + 1));
    const html = renderToStaticMarkup(<AiCandidateSheet plan={initialPlan()} segmentIndex={0} initialResult={{ status: 'ok', candidates }} onClose={() => undefined} />);
    expect(html).toContain('<button type="button" class="primary" disabled="">選んだ候補を追加（0件）</button>');
  });
});
