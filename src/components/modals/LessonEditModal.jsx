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

  // 打开时用当前课文填充表单。
  //
  // 这里刻意在**渲染期同步填充**，而不是放 useEffect：effect 要等浏览器绘制之后才跑，
  // 中间存在"弹窗已经可见、输入框还是空"的一帧。后果不只是视觉上闪一下：
  //   · 自动化测试在这一帧读到空标题 → 断言失败（tools/e2e-b6b7.mjs 里偶发复现过）
  //   · 更糟的是用户手快先输入，随后 effect 再用课文原值把输入覆盖掉 —— 表现为"改了没生效"
  // 不能靠 useState 初值兜住：本组件是常驻挂载的（关闭时只是 return null），初值只在首次挂载时生效。
  //
  // ⚠️ key 只认**这一节课的身份**（lid，退回序号），**不要带标题内容**。
  // 带内容时，只要父组件那边这节课的 title_cn 变了一次（改名落盘、同步合并、补 lid…），
  // 填充就会重跑一遍，把用户**正在输入**的三个框整体覆盖回旧值 ——
  // 现场实测（tools/e2e-b6b7.mjs 诊断③）：序号那个 1 被拼进了标题、序号却还是 2。
  // 那是"改了没生效"最典型的形态，而它只在特定时序下出现，看代码几乎看不出来。
  const fillKey = open && lesson
    ? `${lesson.lid || ''}|${lesson.lesson || ''}`
    : null;
  const [filledFor, setFilledFor] = useState(null);
  if (fillKey !== filledFor) {
    setFilledFor(fillKey);
    if (fillKey) {
      setTitleCn(lesson.title_cn || '');
      setTitleEn(lesson.title_en || '');
      setNo(Number(lesson.lesson) || 1);
    }
  }

  // 聚焦：**只在"从关到开"的那一刻做一次**，之后绝不再动焦点。
  //
  // 为什么守卫要用 wasOpen 而不是 lesson：`lesson` 是父组件从 myLibs 里查出来的对象，
  // 它一变 effect 就重跑，40ms 后再把焦点抢回标题框 —— 用户正在改「序号」时被抢走焦点，
  // 接下来敲的字就落进标题里（实测复现：落盘标题变成「人工智能（改过标题）1」）。
  // 这与 useModals 里修过的"焦点被抢走、中文输入法被打断"是同一类问题：
  // 只要存在"组件重渲染就把焦点送回第一个框"的路径，用户的数据迟早会被写错地方。
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) { wasOpenRef.current = false; return undefined; }
    if (!lesson || wasOpenRef.current) return undefined;   // 这次打开已经聚焦过了
    wasOpenRef.current = true;
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
