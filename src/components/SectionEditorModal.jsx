import { useMemo, useState } from 'react';
import { X } from 'lucide-react';

const lessonKey = (lesson) => String(lesson.lid || lesson.lesson);

export default function SectionEditorModal({ lib, originalName, onSave, onClose, modalRef }) {
  const editing = originalName !== null;
  const [name, setName] = useState(originalName || '');
  const [selected, setSelected] = useState(() => new Set(
    editing ? lib.lessons.filter((lesson) => lesson.section === originalName).map(lessonKey) : [],
  ));
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return lib.lessons;
    return lib.lessons.filter((lesson) =>
      `${lesson.lesson} ${lesson.title_cn || ''} ${lesson.title_en || ''}`.toLowerCase().includes(needle));
  }, [lib.lessons, query]);

  const toggle = (key) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const selectVisible = (checked) => setSelected((current) => {
    const next = new Set(current);
    filtered.forEach((lesson) => {
      if (checked) next.add(lessonKey(lesson)); else next.delete(lessonKey(lesson));
    });
    return next;
  });
  const submit = (event) => {
    event.preventDefault();
    const message = onSave({ libId: lib.id, oldName: originalName, name: name.trim(), selectedIds: [...selected] });
    if (message) setError(message);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal section-editor" ref={modalRef} role="dialog" aria-modal="true"
        aria-label={editing ? '修改分组' : '新建分组'} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{editing ? '修改分组' : '新建分组'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <p className="muted small">课文库：<b>{lib.name}</b>。勾选要放进此组的课文；取消勾选会将原组课文移至“未分组”，不会删除课文或修改编号。</p>
        <form onSubmit={submit}>
          <label>分组名称
            <input value={name} onChange={(event) => { setName(event.target.value); setError(''); }}
              maxLength={40} placeholder="例如：重点复习" required />
          </label>
          <div className="section-picker-head">
            <strong>选择课文编号 <span className="muted">（已选 {selected.size} / {lib.lessons.length}）</span></strong>
            {lib.lessons.length > 0 && <div>
              <button type="button" className="link" onClick={() => selectVisible(true)}>全选{query ? '筛选结果' : ''}</button>
              <button type="button" className="link" onClick={() => selectVisible(false)}>清空{query ? '筛选结果' : ''}</button>
            </div>}
          </div>
          {lib.lessons.length > 8 && (
            <input className="section-picker-search" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索编号或课文标题" aria-label="搜索待分组课文" />
          )}
          <div className="section-picker-list" role="group" aria-label="选择课文编号">
            {filtered.map((lesson) => {
              const key = lessonKey(lesson);
              return <label key={key} className="section-picker-row">
                <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                <span className="section-picker-no">{String(lesson.lesson).padStart(2, '0')}</span>
                <span className="section-picker-title">{lesson.title_cn || lesson.title_en || `Lesson ${lesson.lesson}`}</span>
                {lesson.section && lesson.section !== originalName && <small>{lesson.section}</small>}
              </label>;
            })}
            {filtered.length === 0 && <p className="muted small">{lib.lessons.length ? '没有匹配的课文' : '本库暂无课文；可以先创建空组，保存课文时再选入。'}</p>}
          </div>
          {error && <p className="lib-tip" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="submit" className="primary-btn">{editing ? '保存分组' : '创建分组'}</button>
            <button type="button" className="ghost-btn" onClick={onClose}>取消</button>
          </div>
        </form>
      </div>
    </div>
  );
}
