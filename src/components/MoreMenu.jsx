import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Download, Flame, FolderPlus, GraduationCap, History, MoreVertical, Settings, Sparkles, Star } from 'lucide-react';

/**
 * 「更多」菜单（⋮）—— 全端统一（方案A 聚焦编辑）。
 *
 * 演变：最初是手机端专属（顶栏平铺 4 个按钮 + 状态条要占 1/4 屏幕），桌面端平铺。
 * 方案A 之后桌面端顶栏同样只留「标题 + 状态 + ⋮」，本组件成为**唯一**的次级入口容器：
 *   - 历史结果 / 收藏夹 / 今日待复习 / 返回编辑器
 *   - AI 生成训练素材 / 保存到课文库（仅编辑器视图；从原上传条挪来 —— 低频动作不占首屏）
 *   - 识别模式（拍照/图片识别相关；练习方向与润色难度在编辑器的模式条上，不在这里重复）
 *   - AI 设置 / 备份 / 状态信息
 *
 * 放在菜单里的都是**低频或与当前任务无关**的入口；高频动作（生成、拍照、导入图片、
 * 导入 DOCX）一律留在正文，不藏。
 */
export default function MoreMenu({
  view, historyCount, favCount, dueCount,
  ocrMode, onOcrMode,
  onBackToEditor, onOpenQuiz, hasQuiz,
  onOpenHistory, onOpenFavs, onStartReview,
  onOpenMaterial, materialBusy, onOpenSaveToLib,
  onOpenSettings, onOpenBackup,
  onOpenClass,
  info, infoSub,
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  // 点外面 / 按 Esc 关掉。用 mousedown 而不是 click：
  // 点在按钮上时 click 会先冒泡到 document 再回到按钮，导致"刚开就被关"。
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  /** 菜单项：点完就收起菜单（不然还得再点一次外面） */
  const Item = ({ icon, label, count, onClick, title, disabled }) => (
    <button type="button" className="more-item" title={title || label} disabled={disabled}
      onClick={() => { setOpen(false); if (onClick) onClick(); }}>
      {icon}
      <span>{label}</span>
      {count ? <span className="more-count">{count}</span> : null}
    </button>
  );

  return (
    <div className="more-wrap" ref={boxRef}>
      <button type="button" className="icon-btn more-btn" onClick={() => setOpen((v) => !v)}
        aria-label="更多" aria-expanded={open} title="更多">
        <MoreVertical size={18} />
      </button>
      {open ? (
        <div className="more-menu" role="menu">
          {view !== 'editor' ? <Item icon={<BookOpen size={15} />} label="返回编辑器" onClick={onBackToEditor} /> : null}
          {view === 'quiz' && hasQuiz ? <Item icon={<Sparkles size={15} />} label="看刚才那份自测题" onClick={onOpenQuiz} /> : null}
          <Item icon={<History size={15} />} label="历史结果" count={historyCount} onClick={onOpenHistory} />
          <Item icon={<Star size={15} />} label="收藏夹" count={favCount} onClick={onOpenFavs} />
          <Item icon={<Flame size={15} />} label="今日待复习" count={dueCount} onClick={onStartReview}
            title="按间隔重复安排：打开今天该复习的收藏" />
          {view === 'editor' ? (
            <>
              <div className="more-sep" />
              <Item icon={<Sparkles size={15} />} label="AI 生成训练素材" disabled={materialBusy}
                onClick={onOpenMaterial} title="AI 原创一篇短文 + 中文翻译，避开教材版权，直接用于回译训练" />
              <Item icon={<FolderPlus size={15} />} label="保存到课文库" onClick={onOpenSaveToLib}
                title="把当前作业存进自建课文库，以后可以像课文一样选出来反复练习" />
            </>
          ) : null}

          <div className="more-sep" />

          <label className="more-field">
            <span>识别模式</span>
            <select className="ocr-mode" value={ocrMode} onChange={(e) => onOcrMode(e.target.value)} title="拍照 / 图片识别的模式">
              <option value="auto">自动</option>
              <option value="handwriting">手写体优先</option>
              <option value="printed">印刷体优先</option>
            </select>
          </label>

          <div className="more-sep" />

          <Item icon={<Settings size={15} />} label="AI 设置" onClick={onOpenSettings} />
          <Item icon={<Download size={15} />} label="备份 / 恢复" onClick={onOpenBackup}
            title="导出 / 导入本机数据备份（课文库、收藏夹、历史）" />
          <Item icon={<GraduationCap size={15} />} label="加入教师班级" onClick={onOpenClass} />
          <Item icon={<GraduationCap size={15} />} label="教师后台" onClick={() => { window.location.href = import.meta.env.BASE_URL + 'teacher.html'; }} />

          {info ? (
            <div className="more-info">
              <span className="more-dot" />{info}
              {infoSub ? <><br />{infoSub}</> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
