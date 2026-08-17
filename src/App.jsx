import { DragDropProvider } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { useEffect, useState } from 'react';
import { createPlan, initialPlan, insertCandidate, isDraggable, isRemovable, makeId, removePoint, reorderPoint, segmentKey, STORAGE_KEY, updateCandidate } from './model';

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
    return saved?.points?.length >= 3 ? saved : initialPlan();
  } catch { return initialPlan(); }
}

function PointCard({ point, index, total, onChange, onRemove, handleRef, isDragging }) {
  const [editing, setEditing] = useState(false);

  return <article className={`point-card ${point.locked === 'main' ? 'main-point' : ''} ${isDragging ? 'is-dragging' : ''}`}>
    <div className="point-icon" aria-hidden="true">{point.locked === 'main' ? '★' : index === 0 ? '●' : index === total - 1 ? '⌂' : '•'}</div>
    <div className="point-copy">
      <div className="point-title"><h2>{point.name}</h2>{point.locked === 'main' && <span className="main-badge">MAIN</span>}</div>
      {editing ? <div className="memo-editor">
        <textarea autoFocus value={point.memo} placeholder="この地点のメモ" onChange={(e) => onChange({ ...point, memo: e.target.value })} />
        <button className="text-button" onClick={() => setEditing(false)}>完了</button>
      </div> : <button className="memo-button" onClick={() => setEditing(true)}>{point.memo || '＋ メモを追加'}</button>}
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

function Segment({ before, after, candidates, onAdd, onEdit, onPromote, onDelete }) {
  return <section className="segment">
    <div className="segment-line"><span>↓</span><small>{before.name} から {after.name} まで</small></div>
    {candidates.map((candidate) => <article className="candidate" key={candidate.id}>
      <span className="candidate-label">立ち寄り候補</span><h3>{candidate.name}</h3>
      {candidate.memo && <p>{candidate.memo}</p>}
      <div className="candidate-actions"><button className="primary small" onClick={() => onPromote(candidate.id)}>ルートに追加</button><button className="secondary small" onClick={() => onEdit(candidate.id)}>編集</button><button className="danger small" onClick={() => onDelete(candidate.id)}>削除</button></div>
    </article>)}
    <button className="add-candidate" onClick={onAdd}>＋ この区間に候補を追加</button>
  </section>;
}

function CandidateSheet({ route, initialName = '', initialMemo = '', mode = 'new', onClose, onSubmit }) {
  const [name, setName] = useState(initialName); const [memo, setMemo] = useState(initialMemo);
  const isEditing = mode === 'edit';
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim(), memo.trim()); }}>
      <div className="sheet-grip" /><div className="sheet-head"><div><span className="eyebrow">{isEditing ? 'EDIT STOP' : 'NEW STOP'}</span><h2 id="sheet-title">立ち寄り候補を{isEditing ? '編集' : '追加'}</h2></div><button type="button" className="close" aria-label="閉じる" onClick={onClose}>×</button></div>
      <p className="route-context">{route}</p>
      <label>場所名<input autoFocus required maxLength="60" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：湖畔のパン屋" /></label>
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
  const [plan, setPlan] = useState(loadPlan); const [candidateSheet, setCandidateSheet] = useState(null); const [isCreating, setIsCreating] = useState(false); const [saved, setSaved] = useState(true);
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
    return <Segment before={before} after={after} candidates={plan.candidates[key] || []} onAdd={() => setCandidateSheet({ mode: 'new', index })} onEdit={(candidateId) => setCandidateSheet({ mode: 'edit', index, candidateId })} onPromote={(id) => setPlan((old) => insertCandidate(old, index, id))} onDelete={(id) => setPlan((old) => ({ ...old, candidates: { ...old.candidates, [key]: (old.candidates[key] || []).filter((c) => c.id !== id) } }))} />;
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
      return <CandidateSheet route={`${plan.points[index].name} → ${plan.points[index + 1].name}`} mode={mode} initialName={candidate?.name} initialMemo={candidate?.memo} onClose={() => setCandidateSheet(null)} onSubmit={(name, memo) => {
        if (mode === 'edit') {
          setPlan((old) => updateCandidate(old, key, candidateId, { name, memo }));
        } else {
          setPlan((old) => ({ ...old, candidates: { ...old.candidates, [key]: [...(old.candidates[key] || []), { id: makeId(), name, memo }] } }));
        }
        setCandidateSheet(null);
      }} />;
    })()}
    {isCreating && <CreatePlanSheet onClose={() => setIsCreating(false)} onSubmit={submitNewPlan} />}
  </>;
}
