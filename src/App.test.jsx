import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiCandidateResults, AiCandidateSheet, authenticateCandidateSession, candidateLoadingMessage, requestSegmentCandidates } from './App';
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
    expect(html.match(/class="ai-result-card"/gu)).toHaveLength(5);
    expect(html).toContain('候補1');
    expect(html).toContain('Googleマップで探す');
  });
});
