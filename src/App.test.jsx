import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiCandidateSheet } from './App';
import { initialPlan } from './model';
import { SESSION_STORAGE_KEY } from './api';

const storage = (session = null) => ({
  getItem: (key) => key === SESSION_STORAGE_KEY && session ? JSON.stringify(session) : null,
  removeItem: () => undefined,
  setItem: () => undefined,
});

describe('寄り道候補探索Sheet', () => {
  afterEach(() => { delete globalThis.sessionStorage; });

  it('有効なsessionがなければ探索条件を出さず認証ステップだけを表示する', () => {
    globalThis.sessionStorage = storage();
    const html = renderToStaticMarkup(<AiCandidateSheet plan={initialPlan()} segmentIndex={0} onClose={() => undefined} />);
    expect(html).toContain('寄り道候補を探す');
    expect(html).toContain('Drive Plannerのパスコード');
    expect(html).toContain('続ける');
    expect(html).not.toContain('条件を追加（任意）');
    expect(html).not.toContain('候補を探す</button>');
  });

  it('有効なsessionがあれば認証を飛ばし、条件を閉じた探索画面を表示する', () => {
    globalThis.sessionStorage = storage({ token: 'valid', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const html = renderToStaticMarkup(<AiCandidateSheet plan={initialPlan()} segmentIndex={0} onClose={() => undefined} />);
    expect(html).not.toContain('Drive Plannerのパスコード');
    expect(html).toContain('<summary>条件を追加（任意）</summary>');
    expect(html).toContain('>候補を探す</button>');
    expect(html).not.toContain('<details class="search-conditions" open=""');
  });
});
