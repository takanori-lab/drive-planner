import { DragDropProvider } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { useEffect, useRef, useState } from 'react';
import { addAiResultsToSegment, buildGoogleMapsSearchUrl, createPlan, initialPlan, insertCandidate, isDraggable, isRemovable, makeId, moveCandidate, normalizePlanMapsUrls, removePoint, reorderPoint, routeTotal, routingConditionForSegment, safeGoogleMapsUrl, segmentKey, setPlanRoutingCondition, setSegmentRoutingCondition, STORAGE_KEY, updateCandidate, updatePlanInfo, updatePoint } from './model';
import { buildAiRequestBody, clearSession, createSession, fetchAiCandidates, fetchSegmentRoute, readSession, saveSession, sessionExpiredWhileSheetOpen, WorkerApiError } from './api';

const sensors = [
  PointerSensor.configure({
    activationConstraints(event) {
      if (event.pointerType === 'touch') {
        return [
          new PointerActivationConstraints.Delay({
            value: 300,
            tolerance: 8,
          }),
        ];
      }

      return undefined;
    },
  }),
  KeyboardSensor,
];

function loadPlan() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved?.points?.length >= 3 ? normalizePlanMapsUrls(saved) : initialPlan();
  } catch { return initialPlan(); }
}

export function PointCard({ point, index, total, onEdit, onRemove, handleRef, isDragging }) {
  const savedMapsUrl = safeGoogleMapsUrl(point.googleMapsUrl);
  const searchUrl = buildGoogleMapsSearchUrl(point);

  return <article className={`point-card ${point.locked === 'main' ? 'main-point' : ''} ${isDragging ? 'is-dragging' : ''}`}>
    <div className="point-icon" aria-hidden="true">{point.locked === 'main' ? '★' : index === 0 ? '●' : index === total - 1 ? '⌂' : '•'}</div>
    <div className="point-copy">
      <div className="point-title"><h2>{point.name}</h2>{point.locked === 'main' && <span className="main-badge">MAIN</span>}</div>
      {point.locationNote && <p className="point-location"><span>場所</span>{point.locationNote}</p>}
      {point.memo && <p className="point-memo">{point.memo}</p>}
      <div className="maps-actions">
        <a href={savedMapsUrl || searchUrl} target="_blank" rel="noopener noreferrer">↗ Googleマップで{savedMapsUrl ? '開く' : '探す'}</a>
        <button type="button" className="point-edit" onClick={onEdit}>編集</button>
      </div>
      {isRemovable(point) && <button className="remove-point" onClick={onRemove}>ルートから外す</button>}
    </div>
    <button ref={handleRef} className="drag-handle" aria-label={`${point.name}を並べ替え`} disabled={!isDraggable(point)}>⠿</button>
  </article>;
}

function RouteItem({ point, index, pointIndex, total, children, onEdit, onRemove }) {
  const { ref, handleRef, isDragging } = useSortable({
    id: point.id,
    index,
  });

  return <div ref={ref} className={`route-item ${isDragging ? 'is-dragging' : ''}`}>
    <PointCard point={point} index={pointIndex} total={total} onEdit={onEdit} onRemove={onRemove} handleRef={handleRef} isDragging={isDragging} />
    {children}
  </div>;
}

function CandidateCard({ candidate, onEdit, onMove, onPromote, onDelete }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!isMenuOpen) return undefined;
    const closeMenu = (event) => {
      if (!menuRef.current?.contains(event.target)) setIsMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [isMenuOpen]);

  return <article className="candidate">
    <span className="candidate-label">候補</span>
    <h3>{candidate.name}</h3>
    {candidate.locationNote && <p className="candidate-location"><span>場所</span>{candidate.locationNote}</p>}
    {candidate.memo && <p className="candidate-memo">{candidate.memo}</p>}
    {safeGoogleMapsUrl(candidate.googleMapsUrl) && <a className="candidate-maps-link" href={safeGoogleMapsUrl(candidate.googleMapsUrl)} target="_blank" rel="noopener noreferrer">↗ Googleマップで開く</a>}
    <div className="candidate-actions">
      <button type="button" className="primary small" onClick={() => onPromote(candidate.id)}>ルートに追加</button>
      <button type="button" className="candidate-edit" onClick={() => onEdit(candidate.id)}>編集</button>
      <div className="candidate-menu" ref={menuRef}>
        <button type="button" className="candidate-menu-trigger" aria-label="候補のその他の操作" aria-haspopup="menu" aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen((open) => !open)}>⋯</button>
        {isMenuOpen && <div className="candidate-menu-popover" role="menu">
          <button type="button" className="candidate-menu-move" role="menuitem" onClick={() => { setIsMenuOpen(false); onMove(candidate.id); }}>別の区間へ移動</button>
          <button type="button" className="candidate-menu-delete" role="menuitem" onClick={() => { setIsMenuOpen(false); onDelete(candidate.id); }}>削除</button>
        </div>}
      </div>
    </div>
  </article>;
}

const formatDuration = (seconds) => { const minutes = Math.round(seconds / 60); const hours = Math.floor(minutes / 60); const rest = minutes % 60; return hours ? `${hours}時間${rest ? `${rest}分` : ''}` : `${rest}分`; };
const formatRoute = (result) => `${Math.round(result.distanceMeters / 1000)} km ・ 約${formatDuration(result.durationSeconds)}`;

function Segment({ before, after, candidates, routeResult, condition, onCondition, onAdd, onAsk, onEdit, onMove, onPromote, onDelete }) {
  return <section className="segment">
    <div className="segment-line"><span>↓</span><small>{before.name} から {after.name} まで</small></div>
    <div className="route-metrics"><span role="status">{routeResult?.status === 'loading' ? '道路距離を計算中…' : routeResult?.status === 'ok' ? `${routeResult.confidence === 'approximate' ? '概算 ' : ''}${formatRoute(routeResult)}` : routeResult?.status === 'unresolved' ? '地点を特定できません' : routeResult?.status === 'error' ? '距離・時間を取得できません' : ''}</span><label>経路: <select aria-label={`${before.name}から${after.name}の経路条件`} value={condition} onChange={(event) => onCondition(event.target.value)}><option value="recommended">おすすめ</option><option value="local_roads">一般道中心</option></select></label></div>
    {candidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} onEdit={onEdit} onMove={onMove} onPromote={onPromote} onDelete={onDelete} />)}
    <button className="add-candidate" onClick={onAdd}>＋ この区間に候補を追加</button>
    <button className="ask-chatgpt" onClick={onAsk}>✨ この区間の候補を探す</button>
  </section>;
}

const ERROR_MESSAGES = {
  rate_limited: 'リクエスト回数が多すぎます。少し待ってからもう一度お試しください。',
  ai_timeout: 'AIからの応答がタイムアウトしました。時間をおいてもう一度お試しください。',
  ai_unavailable: '現在、AIを一時的に利用できません。時間をおいてもう一度お試しください。',
  ai_invalid_response: 'AIから有効な候補を取得できませんでした。もう一度お試しください。',
  internal_error: '一時的なエラーが発生しました。時間をおいてもう一度お試しください。',
};

const DETOUR_LABELS = { small: '寄り道 小', medium: '寄り道 中', large: '寄り道 大' };

export async function authenticateCandidateSession(passcode) {
  const created = await createSession(passcode);
  saveSession(created);
  return created;
}

export async function requestSegmentCandidates(plan, segmentIndex, extraRequest, displayedSession) {
  const current = readSession();
  if (sessionExpiredWhileSheetOpen(displayedSession, current) || !current) return { expired: true };
  return { expired: false, result: await fetchAiCandidates(current.token, buildAiRequestBody(plan, segmentIndex, extraRequest.trim())) };
}

export const candidateLoadingMessage = (session) => session ? '候補を探しています…' : '確認しています…';

export function acquireSearchInFlight(searchInFlightRef) {
  if (searchInFlightRef.current) return false;
  searchInFlightRef.current = true;
  return true;
}

const SEARCHING_HINTS = [
  'ルートから外れすぎない場所を探しています',
  'ちょっと意外な寄り道も探しています',
  'この区間に合いそうな候補を探しています',
];

export function SearchCompanionAnimation() {
  return <div className="search-companion" aria-hidden="true" data-testid="search-companion" />;
}

export function AiSearchingView() {
  const [hintIndex, setHintIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setHintIndex((current) => (current + 1) % SEARCHING_HINTS.length), 5000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="ai-searching-view">
    <SearchCompanionAnimation />
    <p className="ai-searching-title" role="status" aria-live="polite">寄り道候補を探しています…</p>
    <p className="ai-searching-hint" aria-hidden="true">{SEARCHING_HINTS[hintIndex]}</p>
  </div>;
}

export function AiCandidateResults({ result, selectedIndexes = [], onToggle = () => undefined }) {
  if (result?.status === 'needs_clarification') return <div className="clarification" role="status"><strong>地点の場所を特定できませんでした。</strong><p>地点の場所情報を追加して、もう一度探してください。</p><details><summary>詳細を見る</summary><p>{result.clarificationMessage}</p></details></div>;
  if (result?.status !== 'ok') return null;
  return <section className="ai-results" aria-label="AIの提案">
    <h3>寄り道候補</h3>
    {result.candidates.map((candidate, index) => {
      const selected = selectedIndexes.includes(index);
      return <article className={selected ? 'ai-result-card is-selected' : 'ai-result-card'} key={candidate.resultId || `${candidate.name}-${index}`}>
      <label className="ai-result-selector"><input type="checkbox" checked={selected} onChange={() => onToggle(index)} /><span>{selected ? '追加する候補に選択済み' : 'この候補を選択'}</span></label>
      <span className="ai-result-label">候補 {index + 1}</span>
      <h4>{candidate.name}</h4>
      {candidate.locationHint && <p className="ai-location">{candidate.locationHint}</p>}
      <p>{candidate.description}</p>
      <div className="ai-reason"><strong>この区間で寄る理由</strong><p>{candidate.reason}</p></div>
      <span className={`detour detour-${candidate.detourLevel}`}>{DETOUR_LABELS[candidate.detourLevel] || '寄り道'}</span>
      {candidate.detourNote && <p>{candidate.detourNote}</p>}
      {candidate.checkItems?.length > 0 && <div className="check-items"><strong>事前の確認事項</strong><ul>{candidate.checkItems.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul></div>}
      <a className="ai-maps-link" href={buildGoogleMapsSearchUrl({ name: candidate.name, locationNote: candidate.locationHint })} target="_blank" rel="noopener noreferrer">↗ Googleマップで探す</a>
    </article>;
    })}
  </section>;
}

export function AiCandidateSheet({ plan, segmentIndex, onAddCandidates = () => ({ segmentFound: true, addedCount: 0, duplicateCount: 0 }), onClose, initialResult = null }) {
  const [extraRequest, setExtraRequest] = useState('');
  const [passcode, setPasscode] = useState('');
  const [session, setSession] = useState(() => readSession());
  const [result, setResult] = useState(initialResult);
  const [error, setError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const searchInFlightRef = useRef(false);
  const [conditionsOpen, setConditionsOpen] = useState(false);
  const [selectedIndexes, setSelectedIndexes] = useState([]);
  const [addMessage, setAddMessage] = useState('');
  const before = plan.points[segmentIndex];
  const after = plan.points[segmentIndex + 1];

  const handleError = (caught, authenticating = false) => {
    if (caught instanceof WorkerApiError && caught.httpStatus === 401) {
      if (!authenticating) {
        clearSession();
        setSession(null);
        setError('認証の有効期限が切れました。パスコードを入力してください。');
      } else setError('パスコードが正しくありません。');
    } else if (caught instanceof WorkerApiError) {
      setError(ERROR_MESSAGES[caught.code] || ERROR_MESSAGES.internal_error);
    } else setError('通信に失敗しました。接続を確認してもう一度お試しください。');
  };

  const authenticate = async (event) => {
    event.preventDefault();
    if (isAuthenticating) return;
    setIsAuthenticating(true);
    setError('');
    try {
      const created = await authenticateCandidateSession(passcode);
      setSession(created);
      setPasscode('');
    } catch (caught) {
      handleError(caught, true);
      setPasscode('');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const search = async (event) => {
    event.preventDefault();
    if (!acquireSearchInFlight(searchInFlightRef)) return;
    setIsSearching(true);
    setError('');
    setResult(null);
    setSelectedIndexes([]);
    setAddMessage('');
    try {
      const response = await requestSegmentCandidates(plan, segmentIndex, extraRequest, session);
      if (response.expired) {
        setSession(null);
        setError('認証の有効期限が切れました。パスコードを入力してください。');
        return;
      }
      setResult(response.result);
    } catch (caught) {
      handleError(caught);
    } finally {
      searchInFlightRef.current = false;
      setIsSearching(false);
    }
  };

  const addSelected = () => {
    if (!selectedIndexes.length || result?.status !== 'ok') return;
    const outcome = onAddCandidates(result.candidates.filter((_, index) => selectedIndexes.includes(index)));
    if (!outcome.segmentFound) {
      setAddMessage('対象の区間が現在のルートにないため、追加しませんでした。区間を選び直してください。');
      return;
    }
    setSelectedIndexes([]);
    if (!outcome.addedCount) setAddMessage('選択した候補はすでに追加されています。');
    else if (outcome.duplicateCount) setAddMessage(`${outcome.addedCount}件を候補へ追加しました。同名の候補${outcome.duplicateCount}件は重複のため追加していません。`);
    else setAddMessage(`${outcome.addedCount}件を候補へ追加しました。`);
  };

  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !isSearching && onClose()}>
    <section className="sheet ai-candidate-sheet" role="dialog" aria-modal="true" aria-labelledby="ai-sheet-title">
      <div className="sheet-grip" />
      <div className="sheet-head"><div><span className="eyebrow">DISCOVER A DETOUR</span><h2 id="ai-sheet-title">寄り道候補を探す</h2></div><button type="button" className="close" aria-label="閉じる" disabled={isSearching} onClick={onClose}>×</button></div>
      <p className="route-context">{before.name} → {after.name}</p>
      {!session ? <form onSubmit={authenticate}>
        <p className="ai-description">候補探索機能を利用するため、Drive Plannerのパスコードを入力してください。</p>
        <label>Drive Plannerのパスコード<input autoFocus required type="password" autoComplete="current-password" value={passcode} onChange={(event) => setPasscode(event.target.value)} /></label>
        <button className="primary submit" disabled={isAuthenticating || !passcode}>{isAuthenticating ? '確認しています…' : '続ける'}</button>
      </form> : isSearching ? <AiSearchingView /> : <form onSubmit={search}>
        <p className="ai-description">この区間で、車で立ち寄りやすい場所を5件探します。</p>
        <details className="search-conditions" open={conditionsOpen} onToggle={(event) => setConditionsOpen(event.currentTarget.open)}>
          <summary>条件を追加（任意）</summary>
          <label>希望する条件<textarea maxLength="300" value={extraRequest} onChange={(event) => setExtraRequest(event.target.value)} placeholder="例：景色がいい場所を多めに / 食べ物以外 / 30分以内の寄り道" /></label>
        </details>
        <button className="primary submit">候補を探す</button>
      </form>}
      {error && <p className="ai-error" role="alert">{error}</p>}
      <AiCandidateResults result={result} selectedIndexes={selectedIndexes} onToggle={(index) => setSelectedIndexes((current) => current.includes(index) ? current.filter((item) => item !== index) : [...current, index])} />
      {result?.status === 'ok' && <div className="ai-add-actions"><button type="button" className="primary" disabled={!selectedIndexes.length} onClick={addSelected}>選んだ候補を追加（{selectedIndexes.length}件）</button>{addMessage && <p className="ai-add-message" role="status">{addMessage}</p>}</div>}
    </section>
  </div>;
}

function MoveCandidateSheet({ candidate, currentRoute, destinations, onClose, onMove }) {
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="sheet move-candidate-sheet" role="dialog" aria-modal="true" aria-labelledby="move-candidate-title">
      <div className="sheet-grip" />
      <div className="sheet-head"><div><span className="eyebrow">MOVE STOP</span><h2 id="move-candidate-title">候補を別の区間へ移動</h2></div><button type="button" className="close" aria-label="閉じる" onClick={onClose}>×</button></div>
      <h3 className="move-candidate-name">{candidate.name}</h3>
      <p className="move-current"><span>現在：</span>{currentRoute}</p>
      <h3 className="move-destination-title">移動先を選択</h3>
      <div className="move-destinations">
        {destinations.map(({ key, label }) => <button type="button" className="move-destination" key={key} onClick={() => onMove(key)}>{label}</button>)}
      </div>
    </section>
  </div>;
}

function PlaceFields({ name, setName, googleMapsUrl, setGoogleMapsUrl, locationNote, setLocationNote, memo, setMemo, autoFocus = false }) {
  return <>
    <label>場所名<input autoFocus={autoFocus} required maxLength="60" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：湖畔のパン屋" /></label>
    <a className={`maps-search-link ${name.trim() ? '' : 'disabled'}`} href={buildGoogleMapsSearchUrl({ name, locationNote }) || undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!name.trim()} onClick={(event) => !name.trim() && event.preventDefault()}>↗ Googleマップで探す</a>
    <label>GoogleマップURL <span>（任意）</span><input type="url" value={googleMapsUrl} onChange={(e) => setGoogleMapsUrl(e.target.value)} placeholder="https://maps.app.goo.gl/..." /></label>
    <label>場所の補足 <span>（任意）</span><textarea maxLength="300" value={locationNote} onChange={(e) => setLocationNote(e.target.value)} placeholder="河口湖の北側 / 富士河口湖町○○" /></label>
    <label>メモ <span>（任意）</span><textarea maxLength="200" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="気になること、寄りたい時間など" /></label>
  </>;
}

export function CandidateSheet({ route, initialName = '', initialGoogleMapsUrl = '', initialLocationNote = '', initialMemo = '', mode = 'new', onClose, onSubmit }) {
  const [name, setName] = useState(initialName); const [googleMapsUrl, setGoogleMapsUrl] = useState(initialGoogleMapsUrl); const [locationNote, setLocationNote] = useState(initialLocationNote); const [memo, setMemo] = useState(initialMemo);
  const isEditing = mode === 'edit';
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <form className="sheet candidate-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim(), googleMapsUrl.trim(), locationNote.trim(), memo.trim()); }}>
      <div className="sheet-grip" /><div className="sheet-head"><div><span className="eyebrow">{isEditing ? 'EDIT STOP' : 'NEW STOP'}</span><h2 id="sheet-title">立ち寄り候補を{isEditing ? '編集' : '追加'}</h2></div><button type="button" className="close" aria-label="閉じる" onClick={onClose}>×</button></div>
      <p className="route-context">{route}</p>
      <PlaceFields {...{ name, setName, googleMapsUrl, setGoogleMapsUrl, locationNote, setLocationNote, memo, setMemo }} autoFocus />
      <button className="primary submit" disabled={!name.trim()}>{isEditing ? '変更を保存' : '候補として保存'}</button>
    </form>
  </div>;
}

export function PointEditSheet({ point, onClose, onSubmit }) {
  const [name, setName] = useState(point.name); const [googleMapsUrl, setGoogleMapsUrl] = useState(point.googleMapsUrl ?? ''); const [locationNote, setLocationNote] = useState(point.locationNote ?? ''); const [memo, setMemo] = useState(point.memo ?? '');
  const nameChanged = name.trim() !== point.name.trim();
  const hasExistingDetails = Boolean(point.googleMapsUrl?.trim() || point.locationNote?.trim() || point.memo?.trim());
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="sheet candidate-sheet" role="dialog" aria-modal="true" aria-labelledby="point-edit-title" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSubmit({ name: name.trim(), googleMapsUrl: googleMapsUrl.trim(), locationNote: locationNote.trim(), memo: memo.trim() }); }}>
      <div className="sheet-grip" /><div className="sheet-head"><div><span className="eyebrow">EDIT STOP</span><h2 id="point-edit-title">場所情報を編集</h2></div><button type="button" className="close" aria-label="閉じる" onClick={onClose}>×</button></div>
      <p className="route-context">{point.locked === 'start' ? 'START' : point.locked === 'main' ? 'MAIN' : point.locked === 'goal' ? 'GOAL' : 'ルート地点'}</p>
      <PlaceFields {...{ name, setName, googleMapsUrl, setGoogleMapsUrl, locationNote, setLocationNote, memo, setMemo }} autoFocus />
      {nameChanged && hasExistingDetails && <p className="edit-warning" role="status">地点名を変更した場合は、登録済みの場所情報も確認してください。</p>}
      <button className="primary submit" disabled={!name.trim()}>変更を保存</button>
    </form>
  </div>;
}

export function PlanInfoSheet({ plan, onClose, onSubmit }) {
  const [title, setTitle] = useState(plan.title ?? ''); const [date, setDate] = useState(plan.date ?? '');
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="sheet plan-info-sheet" role="dialog" aria-modal="true" aria-labelledby="plan-info-title" onSubmit={(event) => { event.preventDefault(); if (title.trim() && date) onSubmit({ title: title.trim(), date }); }}>
      <div className="sheet-grip" /><div className="sheet-head"><div><span className="eyebrow">EDIT DRIVE</span><h2 id="plan-info-title">ドライブ情報を編集</h2></div><button type="button" className="close" aria-label="閉じる" onClick={onClose}>×</button></div>
      <label>ドライブ名<input autoFocus required maxLength="60" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>日付<input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <button className="primary submit" disabled={!title.trim() || !date}>変更を保存</button>
    </form>
  </div>;
}

function CreatePlanSheet({ onClose, onSubmit }) {
  const [values, setValues] = useState({ title: '', date: '', startName: '', mainName: '', goalName: '' });
  const update = (key) => (event) => setValues((old) => ({ ...old, [key]: event.target.value }));
  const isComplete = Object.values(values).every((value) => value.trim());

  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="sheet create-plan-sheet" role="dialog" aria-modal="true" aria-labelledby="create-plan-title" onSubmit={(event) => {
      event.preventDefault();
      if (isComplete) onSubmit(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])));
    }}>
      <div className="sheet-grip" />
      <div className="sheet-head"><div><span className="eyebrow">NEW DRIVE</span><h2 id="create-plan-title">新しいドライブを作成</h2></div><button type="button" className="close" aria-label="閉じる" onClick={onClose}>×</button></div>
      <p className="replace-notice">現在のドライブ内容は、作成したドライブに置き換わります。</p>
      <label>ドライブ名<input autoFocus required maxLength="60" value={values.title} onChange={update('title')} placeholder="例：富士山周辺ドライブ" /></label>
      <label>日付<input required type="date" value={values.date} onChange={update('date')} /></label>
      <label>出発地点<input required maxLength="60" value={values.startName} onChange={update('startName')} placeholder="例：東京駅" /></label>
      <label>MAIN地点<input required maxLength="60" value={values.mainName} onChange={update('mainName')} placeholder="例：富士山" /></label>
      <label>到着地点<input required maxLength="60" value={values.goalName} onChange={update('goalName')} placeholder="例：東京駅" /></label>
      <button className="primary submit" disabled={!isComplete}>作成する</button>
    </form>
  </div>;
}

function formatPlanDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!match) return null;
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}

export default function App() {
  const [plan, setPlan] = useState(loadPlan); const [candidateSheet, setCandidateSheet] = useState(null); const [pointSheetId, setPointSheetId] = useState(null); const [moveSheet, setMoveSheet] = useState(null); const [aiSegment, setAiSegment] = useState(null); const [isCreating, setIsCreating] = useState(false); const [isEditingPlan, setIsEditingPlan] = useState(false); const [saved, setSaved] = useState(true);
  const [routeResults, setRouteResults] = useState({}); const routeCache = useRef(new Map());
  const start = plan.points[0];
  const goal = plan.points[plan.points.length - 1];
  const middlePoints = plan.points.slice(1, -1);
  useEffect(() => { setSaved(false); const id = setTimeout(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(plan)); setSaved(true); }, 180); return () => clearTimeout(id); }, [plan]);
  useEffect(() => {
    let active = true;
    for (let index = 0; index < plan.points.length - 1; index += 1) {
      const before = plan.points[index], after = plan.points[index + 1], key = segmentKey(before, after);
      const condition = routingConditionForSegment(plan, before, after);
      const identity = JSON.stringify([before.googleMapsUrl || '', before.name || '', before.locationNote || '', after.googleMapsUrl || '', after.name || '', after.locationNote || '', condition]);
      let pending = routeCache.current.get(identity);
      if (!pending) { pending = fetchSegmentRoute(before, after, condition).catch(() => ({ status: 'error' })); routeCache.current.set(identity, pending); }
      setRouteResults((old) => ({ ...old, [key]: { status: 'loading' } }));
      pending.then((result) => active && setRouteResults((old) => ({ ...old, [key]: result })));
    }
    return () => { active = false; };
  }, [plan.points, plan.routingCondition, plan.segmentRoutingConditions]);
  const reset = () => { if (window.confirm('現在のドライブ内容を削除して、サンプルプランに戻しますか？')) { localStorage.removeItem(STORAGE_KEY); setPlan(initialPlan()); } };
  const submitNewPlan = (values) => {
    if (!window.confirm('現在のドライブ内容を新しいドライブに置き換えます。よろしいですか？')) return;
    setPlan(createPlan(values));
    setCandidateSheet(null);
    setIsCreating(false);
  };
  const finishReorder = ({ operation }) => {
    const { source } = operation;
    if (source && source.initialIndex !== source.index) {
      // Sortable indexes are relative to middlePoints. The model works with
      // indexes in the complete points array, whose first item is the start.
      setPlan((old) => reorderPoint(old, source.initialIndex + 1, source.index + 1));
    }
  };
  const renderSegment = (index) => {
    const before = plan.points[index];
    const after = plan.points[index + 1];
    const key = segmentKey(before, after);
    const condition = routingConditionForSegment(plan, before, after);
    return <Segment before={before} after={after} candidates={plan.candidates[key] || []} routeResult={routeResults[key]} condition={condition} onCondition={(value) => setPlan((old) => setSegmentRoutingCondition(old, before, after, value))} onAdd={() => setCandidateSheet({ mode: 'new', index })} onAsk={() => setAiSegment({ segmentIndex: index, beforeId: before.id, afterId: after.id })} onEdit={(candidateId) => setCandidateSheet({ mode: 'edit', index, candidateId })} onMove={(candidateId) => setMoveSheet({ fromKey: key, candidateId })} onPromote={(id) => setPlan((old) => insertCandidate(old, index, id))} onDelete={(id) => setPlan((old) => ({ ...old, candidates: { ...old.candidates, [key]: (old.candidates[key] || []).filter((c) => c.id !== id) } }))} />;
  };
  const totalRoute = routeTotal(plan.points, routeResults);
  return <>
    <header className="app-header"><div className="brand"><span className="brand-mark">↗</span><span>DRIVE PLANNER</span></div><div className={`save-state ${saved ? '' : 'saving'}`}><i />{saved ? 'この端末に保存済み' : '保存中…'}</div></header>
    <main><section className="hero"><span className="eyebrow">MY DRIVE PLAN</span><h1>{plan.title}</h1>{formatPlanDate(plan.date) && <time className="plan-date" dateTime={plan.date}>{formatPlanDate(plan.date)}</time>}<p>気になる場所を候補に置いて、好きな順番にルートを育てよう。</p><div className="hero-actions"><button className="edit-drive" onClick={() => setIsEditingPlan(true)}>ドライブ情報を編集</button><button className="new-drive" onClick={() => setIsCreating(true)}>＋ 新しいドライブ</button></div><div className="summary"><span><b>{plan.points.length}</b> ルート地点</span><span><b>{Object.values(plan.candidates).flat().length}</b> 候補</span></div><div className="route-summary"><label>全体の経路 <select value={plan.routingCondition} onChange={(event) => setPlan((old) => setPlanRoutingCondition(old, event.target.value))}><option value="recommended">おすすめ</option><option value="local_roads">一般道中心</option></select></label>{totalRoute.completed > 0 && <strong>{totalRoute.complete ? '合計' : `計算済み ${totalRoute.completed}/${totalRoute.total}区間`} 約{Math.round(totalRoute.distanceMeters / 1000)} km ・ 約{formatDuration(totalRoute.durationSeconds)}</strong>}<small>距離・時間はリアルタイム交通を含まない計画用の目安です。</small></div></section>
      <DragDropProvider sensors={sensors} onDragEnd={finishReorder}>
        <section className="timeline" aria-label="ドライブルート">
          <div className="route-item route-endpoint">
            <PointCard point={start} index={0} total={plan.points.length} onEdit={() => setPointSheetId(start.id)} />
            {renderSegment(0)}
          </div>
          <div className="sortable-region">
            {middlePoints.map((point, sortableIndex) => {
              const pointIndex = sortableIndex + 1;
              return <RouteItem key={point.id} point={point} index={sortableIndex} pointIndex={pointIndex} total={plan.points.length} onEdit={() => setPointSheetId(point.id)} onRemove={() => setPlan((old) => removePoint(old, pointIndex))}>
                {renderSegment(pointIndex)}
              </RouteItem>;
            })}
          </div>
          <div className="route-item route-endpoint">
            <PointCard point={goal} index={plan.points.length - 1} total={plan.points.length} onEdit={() => setPointSheetId(goal.id)} />
          </div>
        </section>
      </DragDropProvider>
      <section className="hint"><span>⠿</span><div><b>順番を変えるには</b><p>通常地点またはMAIN地点の右側のハンドルをドラッグします。タッチ操作では長押ししてから移動してください。</p></div></section>
      <button className="reset" onClick={reset}>サンプルプランに戻す</button>
    </main><footer>Drive Planner Prototype 01</footer>
    {candidateSheet && (() => {
      const { index, mode, candidateId } = candidateSheet;
      const key = segmentKey(plan.points[index], plan.points[index + 1]);
      const candidate = mode === 'edit' ? (plan.candidates[key] || []).find((item) => item.id === candidateId) : null;
      if (mode === 'edit' && !candidate) return null;
      return <CandidateSheet route={`${plan.points[index].name} → ${plan.points[index + 1].name}`} mode={mode} initialName={candidate?.name} initialGoogleMapsUrl={candidate?.googleMapsUrl ?? ''} initialLocationNote={candidate?.locationNote ?? ''} initialMemo={candidate?.memo} onClose={() => setCandidateSheet(null)} onSubmit={(name, googleMapsUrl, locationNote, memo) => {
        if (mode === 'edit') {
          setPlan((old) => updateCandidate(old, key, candidateId, { name, googleMapsUrl, locationNote, memo }));
        } else {
          setPlan((old) => ({ ...old, candidates: { ...old.candidates, [key]: [...(old.candidates[key] || []), { id: makeId(), name, googleMapsUrl, locationNote, memo }] } }));
        }
        setCandidateSheet(null);
      }} />;
    })()}
    {moveSheet && (() => {
      const { fromKey, candidateId } = moveSheet;
      const candidate = (plan.candidates[fromKey] || []).find((item) => item.id === candidateId);
      if (!candidate) return null;
      const segments = plan.points.slice(0, -1).map((point, index) => ({
        key: segmentKey(point, plan.points[index + 1]),
        label: `${point.name} → ${plan.points[index + 1].name}`,
      }));
      const currentRoute = segments.find((segment) => segment.key === fromKey)?.label || '';
      return <MoveCandidateSheet candidate={candidate} currentRoute={currentRoute} destinations={segments.filter((segment) => segment.key !== fromKey)} onClose={() => setMoveSheet(null)} onMove={(toKey) => {
        setPlan((old) => moveCandidate(old, fromKey, toKey, candidateId));
        setMoveSheet(null);
      }} />;
    })()}
    {isCreating && <CreatePlanSheet onClose={() => setIsCreating(false)} onSubmit={submitNewPlan} />}
    {isEditingPlan && <PlanInfoSheet plan={plan} onClose={() => setIsEditingPlan(false)} onSubmit={(updates) => { setPlan((old) => updatePlanInfo(old, updates)); setIsEditingPlan(false); }} />}
    {pointSheetId && (() => {
      const point = plan.points.find((item) => item.id === pointSheetId);
      if (!point) return null;
      return <PointEditSheet point={point} onClose={() => setPointSheetId(null)} onSubmit={(updates) => { setPlan((old) => updatePoint(old, pointSheetId, updates)); setPointSheetId(null); }} />;
    })()}
    {aiSegment !== null && (() => {
      const segmentIndex = plan.points.findIndex((point, index) => point.id === aiSegment.beforeId && plan.points[index + 1]?.id === aiSegment.afterId);
      const safeIndex = segmentIndex >= 0 ? segmentIndex : aiSegment.segmentIndex;
      return <AiCandidateSheet plan={plan} segmentIndex={safeIndex} onAddCandidates={(results) => {
        const outcome = addAiResultsToSegment(plan, aiSegment.beforeId, aiSegment.afterId, results);
        if (outcome.plan !== plan) setPlan(outcome.plan);
        return outcome;
      }} onClose={() => setAiSegment(null)} />;
    })()}
  </>;
}
