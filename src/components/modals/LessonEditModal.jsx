import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';

/**
 * 编辑自建课文：改标题（中文 / 英文）+ 改序号。
 *
 * 序号的两个语义要讲清楚，否则用户会以为"改成 5 就是留个空档"：
 *   · 改序号 = **挪到第 N 位**，中间的课整体顺移，最后统一补齐 1…N（不会出现重号或空档）
 *   · 想补齐删课留下的空档（1、3 → 1、2），用侧栏「我的课文库」旁的「重排序号」
 */
function LessonEditModal({ open, lesson, onClose, onSave, onDelete, modalRef }) {
  const [titleCn, setTitleCn] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [no, setNo] = useState(1);
  const firstRef = useRef(null);

  // 每次打开时用当前课文填充表单
  useEffect(() => {
    if (!open || !lesson) return;
    setTitleCn(lesson.title_cn || '');
    setTitleEn(lesson.title_en || '');
    setNo(Number(lesson.lesson) || 1);
    const t = setTimeout(() => firstRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [open, lesson]);

  if (!open || !lesson) return null;
  // 只有"本来就没标题且输入框也为空"才算空。
  // 否则会出一个很坑的陷阱：只填了英文标题的课文，想把序号改一下却发现保存是灰的，
  // 看起来就像"点了没反应"。（真清空标题的情况由 renameLesson 兜住：空值不覆盖原值）
  const empty = !titleCn.trim() && !titleEn.trim() && !lesson.title_cn && !lesson.title_en;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="编辑课文" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>编辑课文</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <label className="auth-label">
          标题（中文）
          <input
            ref={firstRef}
            value={titleCn}
            onChange={(e) => setTitleCn(e.target.value)}
            maxLength={60}
            placeholder="例如：春节的由来"
          />
        </label>
        <label className="auth-label">
          标题（英文，可选）
          <input
            value={titleEn}
            onChange={(e) => setTitleEn(e.target.value)}
            maxLength={120}
            placeholder="例如：The Spring Festival"
          />
        </label>
        <label className="auth-label">
          序号（第几课）
          <input
            type="number"
            min="1"
            value={no}
            onChange={(e) => setNo(Number(e.target.value))}
          />
        </label>
        <p className="muted small">
          改序号 = 把它<b>放到第 {Number.isFinite(no) && no > 0 ? no : 1} 课</b>，中间的课整体顺移，
          整库序号会自动补齐成 1、2、3…（不会出现重号或空档）。
          如果只想补齐删课留下的空档（比如 1、3），用侧栏「我的课文库」旁的<b>重排序号</b>一键搞定。
        </p>
        {empty ? <div className="lib-tip" role="alert">标题不能为空</div> : null}
        <div className="modal-actions">
          <button className="primary-btn" onClick={() => onSave({ title_cn: titleCn.trim(), title_en: titleEn.trim(), lesson: no })} disabled={empty}>
            保存
          </button>
          <button className="ghost-btn" onClick={() => onDelete(lesson)}>
            <Trash2 size={14} />删除这节课
          </button>
          <button className="ghost-btn" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

export default React.memo(LessonEditModal);
