import { DragDropProvider } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { useEffect, useRef, useState } from 'react';
import { buildGoogleMapsSearchUrl, createPlan, initialPlan, insertCandidate, isDraggable, isRemovable, makeId, moveCandidate, normalizePlanMapsUrls, removePoint, reorderPoint, safeGoogleMapsUrl, segmentKey, STORAGE_KEY, updateCandidate } from './model';
import { buildAiRequestBody, clearSession, createSession, fetchAiCandidates, readSession, saveSession, sessionExpiredWhileSheetOpen, WorkerApiError } from './api';

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

function PointCard({ point, index, total, onChange, onRemove, handleRef, isDragging }) {
  const [editingField, setEditingField] = useState(null);
  const savedMapsUrl = safeGoogleMapsUrl(point.googleMapsUrl);
  const searchUrl = buildGoogleMapsSearchUrl(point);

  return <article className={`point-card ${point.locked === 'main' ? 'main-point' : ''} ${isDragging ? 'is-dragging' : ''}`}>
    <div className="point-icon" aria-hidden="true">{point.locked === 'main' ? '★' : index === 0 ? '●' : index === total - 1 ? '⌂' : '•'}</div>
    <div className="point-copy">
      <div className="point-title"><h2>{point.name}</h2>{point.locked === 'main' && <span className="main-badge">MAIN</span>}</div>
      {editingField === 'location' ? <div className="point-field-editor">
        <textarea autoFocus maxLength="300" value={point.locationNote ?? ''} placeholder="河口湖の北側 / 富士河口湖町○○" onChange={(e) => onChange({ ...point, locationNote: e.target.value })} />
        <button type="button" className="text-button" onClick={() => setEditingField(null)}>完了</button>
      </div> : <button type="button" className={`point-field-button location-note ${point.locationNote ? 'has-value' : ''}`} onClick={() => setEditingField('location')}>{point.locationNote ? <><span>場所</span>{point.locationNote}</> : '＋ 場所の補足'}</button>}
      {editingField === 'memo' ? <div className="point-field-editor">
        <textarea autoFocus value={point.memo ?? ''} placeholder="この地点のメモ" onChange={(e) => onChange({ ...point, memo: e.target.value })} />
        <button type="button" className="text-button" onClick={() => setEditingField(null)}>完了</button>
      </div> : <button type="button" className="point-field-button" onClick={() => setEditingField('memo')}>{point.memo || '＋ メモを追加'}</button>}
      <div className="maps-actions">
        <a href={savedMapsUrl || searchUrl} target="_blank" rel="noopener noreferrer">↗ Googleマップで{savedMapsUrl ? '開く' : '探す'}</a>
        <button type="button" onClick={() => setEditingField('maps')}>{savedMapsUrl ? 'GoogleマップURLを編集' : '＋ GoogleマップURLを登録'}</button>
      </div>
      {editingField === 'maps' && <div className="point-field-editor maps-editor">
        <label>GoogleマップURL<input autoFocus type="url" value={point.googleMapsUrl ?? ''} placeholder="https://maps.app.goo.gl/..." onChange={(e) => onChange({ ...point, googleMapsUrl: e.target.value })} /></label>
        <button type="button" className="text-button" onClick={() => setEditingField(null)}>完了</button>
      </div>}
      {isRemovable(point) && <button className="remove-point" onClick={onRemove}>ルートから外す</button>}
    </div>
    <button ref={handleRef} className="drag-handle" aria-label={`${point.name}を並べ替え`} disabled={!isDraggable(point)}>⠿</button>
  </article>;
}

function RouteItem({ point, index, pointIndex, total, children, onChange, onRemove }) {
  const { ref, handleRef, isDragging } = useSortable({
    id: point.id,
    index,
  });

  return <div ref={ref} className={`route-item ${isDragging ? 'is-dragging' : ''}`}>
    <PointCard point={point} index={pointIndex} total={total} onChange={onChange} onRemove={onRemove} handleRef={handleRef} isDragging={isDragging} />
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

function Segment({ before, after, candidates, onAdd, onAsk, onEdit, onMove, onPromote, onDelete }) {
  return <section className="segment">
    <div className="segment-line"><span>↓</span><small>{before.name} から {after.name} まで</small></div>
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

function AiCandidateSheet({ plan, segmentIndex, onClose }) {
  const [extraRequest, setExtraRequest] = useState('');
  const [passcode, setPasscode] = useState('');
  const [session, setSession] = useState(() => readSession());
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
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

  const requestCandidates = async (token) => {
    const body = buildAiRequestBody(plan, segmentIndex, extraRequest.trim());
    const response = await fetchAiCandidates(token, body);
    setResult(response);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError('');
    setResult(null);
    let authenticating = false;
    try {
      let current = readSession();
      if (sessionExpiredWhileSheetOpen(session, current)) {
        setSession(null);
        setError('認証の有効期限が切れました。パスコードを入力してください。');
        return;
      }
      if (!current) {
        authenticating = true;
        const created = await createSession(passcode);
        saveSession(created);
        current = created;
        setSession(created);
        setPasscode('');
        authenticating = false;
      }
      await requestCandidates(current.token);
    } catch (caught) {
      handleError(caught, authenticating);
      if (authenticating) setPasscode('');
    } finally {
      setLoading(false);
    }
  };

  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="sheet ai-candidate-sheet" role="dialog" aria-modal="true" aria-labelledby="ai-sheet-title" onSubmit={submit}>
      <div className="sheet-grip" />
      <div className="sheet-head"><div><span className="eyebrow">AI SUGGESTIONS</span><h2 id="ai-sheet-title">AIに候補を聞く</h2></div><button type="button" className="close" aria-label="閉じる" onClick={onClose}>×</button></div>
      <p className="ai-description">この区間に立ち寄りやすい候補を5件提案します。</p>
      <p className="route-context">{before.name} → {after.name}</p>
      {!session && <label>Drive Plannerのパスコード<input autoFocus required type="password" autoComplete="current-password" value={passcode} onChange={(event) => setPasscode(event.target.value)} /></label>}
      <label>追加の希望 <span>（任意）</span><textarea maxLength="300" value={extraRequest} onChange={(event) => setExtraRequest(event.target.value)} placeholder="例：景色がいい場所が気になる" /></label>
      <button className="primary submit" disabled={loading || (!session && !passcode)}>{loading ? '候補を探しています…' : session ? 'AIに候補を探してもらう' : '認証して候補を探す'}</button>
      {loading && <p className="ai-loading" role="status">候補を探しています…</p>}
      {error && <p className="ai-error" role="alert">{error}</p>}
      {result?.status === 'needs_clarification' && <div className="clarification" role="status"><strong>候補を探すために、もう少し場所の情報が必要です。</strong><p>{result.clarificationMessage}</p></div>}
      {result?.status === 'ok' && <section className="ai-results" aria-label="AIの提案">
        <h3>AIの提案</h3>
        {result.candidates.map((candidate, index) => <article className="ai-result-card" key={candidate.resultId || `${candidate.name}-${index}`}>
          <span className="ai-result-label">AIの提案 {index + 1}</span>
          <h4>{candidate.name}</h4>
          {candidate.locationHint && <p className="ai-location">{candidate.locationHint}</p>}
          <p>{candidate.description}</p>
          <div className="ai-reason"><strong>この区間で寄る理由</strong><p>{candidate.reason}</p></div>
          <span className={`detour detour-${candidate.detourLevel}`}>{DETOUR_LABELS[candidate.detourLevel] || '寄り道'}</span>
          {candidate.detourNote && <p>{candidate.detourNote}</p>}
          {candidate.checkItems?.length > 0 && <div className="check-items"><strong>事前の確認事項</strong><ul>{candidate.checkItems.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul></div>}
          <a className="ai-maps-link" href={buildGoogleMapsSearchUrl({ name: candidate.name, locationNote: candidate.locationHint })} target="_blank" rel="noopener noreferrer">↗ Googleマップで探す</a>
        </article>)}
      </section>}
    </form>
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

function CandidateSheet({ route, initialName = '', initialGoogleMapsUrl = '', initialLocationNote = '', initialMemo = '', mode = 'new', onClose, onSubmit }) {
  const [name, setName] = useState(initialName); const [googleMapsUrl, setGoogleMapsUrl] = useState(initialGoogleMapsUrl); const [locationNote, setLocationNote] = useState(initialLocationNote); const [memo, setMemo] = useState(initialMemo);
  const isEditing = mode === 'edit';
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <form className="sheet candidate-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim(), googleMapsUrl.trim(), locationNote.trim(), memo.trim()); }}>
      <div className="sheet-grip" /><div className="sheet-head"><div><span className="eyebrow">{isEditing ? 'EDIT STOP' : 'NEW STOP'}</span><h2 id="sheet-title">立ち寄り候補を{isEditing ? '編集' : '追加'}</h2></div><button type="button" className="close" aria-label="閉じる" onClick={onClose}>×</button></div>
      <p className="route-context">{route}</p>
      <label>場所名<input autoFocus required maxLength="60" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：湖畔のパン屋" /></label>
      <a className={`maps-search-link ${name.trim() ? '' : 'disabled'}`} href={buildGoogleMapsSearchUrl({ name, locationNote }) || undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!name.trim()} onClick={(event) => !name.trim() && event.preventDefault()}>↗ Googleマップで探す</a>
      <label>GoogleマップURL <span>（任意）</span><input type="url" value={googleMapsUrl} onChange={(e) => setGoogleMapsUrl(e.target.value)} placeholder="https://maps.app.goo.gl/..." /></label>
      <label>場所の補足 <span>（任意）</span><textarea maxLength="300" value={locationNote} onChange={(e) => setLocationNote(e.target.value)} placeholder="河口湖の北側 / 富士河口湖町○○" /></label>
      <label>メモ <span>（任意）</span><textarea maxLength="200" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="気になること、寄りたい時間など" /></label>
      <button className="primary submit" disabled={!name.trim()}>{isEditing ? '変更を保存' : '候補として保存'}</button>
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
  const [plan, setPlan] = useState(loadPlan); const [candidateSheet, setCandidateSheet] = useState(null); const [moveSheet, setMoveSheet] = useState(null); const [aiSegment, setAiSegment] = useState(null); const [isCreating, setIsCreating] = useState(false); const [saved, setSaved] = useState(true);
  const start = plan.points[0];
  const goal = plan.points[plan.points.length - 1];
  const middlePoints = plan.points.slice(1, -1);
  useEffect(() => { setSaved(false); const id = setTimeout(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(plan)); setSaved(true); }, 180); return () => clearTimeout(id); }, [plan]);
  const updatePoint = (index, point) => setPlan((old) => ({ ...old, points: old.points.map((p, i) => i === index ? point : p) }));
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
    return <Segment before={before} after={after} candidates={plan.candidates[key] || []} onAdd={() => setCandidateSheet({ mode: 'new', index })} onAsk={() => setAiSegment(index)} onEdit={(candidateId) => setCandidateSheet({ mode: 'edit', index, candidateId })} onMove={(candidateId) => setMoveSheet({ fromKey: key, candidateId })} onPromote={(id) => setPlan((old) => insertCandidate(old, index, id))} onDelete={(id) => setPlan((old) => ({ ...old, candidates: { ...old.candidates, [key]: (old.candidates[key] || []).filter((c) => c.id !== id) } }))} />;
  };
  return <>
    <header className="app-header"><div className="brand"><span className="brand-mark">↗</span><span>DRIVE PLANNER</span></div><div className={`save-state ${saved ? '' : 'saving'}`}><i />{saved ? 'この端末に保存済み' : '保存中…'}</div></header>
    <main><section className="hero"><span className="eyebrow">MY DRIVE PLAN</span><h1>{plan.title}</h1>{formatPlanDate(plan.date) && <time className="plan-date" dateTime={plan.date}>{formatPlanDate(plan.date)}</time>}<p>気になる場所を候補に置いて、好きな順番にルートを育てよう。</p><button className="new-drive" onClick={() => setIsCreating(true)}>＋ 新しいドライブ</button><div className="summary"><span><b>{plan.points.length}</b> ルート地点</span><span><b>{Object.values(plan.candidates).flat().length}</b> 候補</span></div></section>
      <DragDropProvider sensors={sensors} onDragEnd={finishReorder}>
        <section className="timeline" aria-label="ドライブルート">
          <div className="route-item route-endpoint">
            <PointCard point={start} index={0} total={plan.points.length} onChange={(point) => updatePoint(0, point)} />
            {renderSegment(0)}
          </div>
          <div className="sortable-region">
            {middlePoints.map((point, sortableIndex) => {
              const pointIndex = sortableIndex + 1;
              return <RouteItem key={point.id} point={point} index={sortableIndex} pointIndex={pointIndex} total={plan.points.length} onChange={(updated) => updatePoint(pointIndex, updated)} onRemove={() => setPlan((old) => removePoint(old, pointIndex))}>
                {renderSegment(pointIndex)}
              </RouteItem>;
            })}
          </div>
          <div className="route-item route-endpoint">
            <PointCard point={goal} index={plan.points.length - 1} total={plan.points.length} onChange={(point) => updatePoint(plan.points.length - 1, point)} />
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
    {aiSegment !== null && <AiCandidateSheet plan={plan} segmentIndex={aiSegment} onClose={() => setAiSegment(null)} />}
  </>;
}
