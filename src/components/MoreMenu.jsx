import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Download, Flame, History, Languages, MoreVertical, Settings, Sparkles, Star } from 'lucide-react';

/**
 * 手机端的「更多」菜单（⋮）。
 *
 * 为什么要有它：手机端顶栏原来平铺了「编辑器 / 历史结果 / 收藏夹 / 今日待复习」四个按钮
 * 加一条状态条，换行后**占掉 200px、约 1/4 屏幕**（实测 390×844 与 320×568 都是 200px）；
 * 侧栏底部还并排着「AI 设置 / 备份」，而侧栏本来就挤。
 * 参考姊妹项目「单词本」的做法：次要入口统一收进右上角的 ⋮，顶栏只留"当前在哪 + 状态"。
 *
 * 放在菜单里的都是**低频或与当前任务无关**的入口；高频动作（生成、拍照、导入图片、
 * 上传 DOCX）一律留在正文，不藏。
 *
 * 桌面端（>900px）由 CSS 隐藏整个组件 —— 那边屏幕够宽，平铺更好用，不改动既有习惯。
 */
export default function MoreMenu({
  view, historyCount, favCount, dueCount,
  directionName, onToggleDirection,
  polishLevel, levels, onPolishLevel,
  ocrMode, onOcrMode,
  onBackToEditor, onOpenQuiz, hasQuiz,
  onOpenHistory, onOpenFavs, onStartReview,
  onOpenSettings, onOpenBackup,
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
  const Item = ({ icon, label, count, onClick, title }) => (
    <button type="button" className="more-item" title={title || label}
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

          <div className="more-sep" />

          <Item icon={<Languages size={15} />} label={'练习方向：' + directionName} onClick={onToggleDirection}
            title="点一下切换汉译英 / 英译汉" />
          <label className="more-field">
            <span>润色等级</span>
            <select className="ocr-mode" value={polishLevel} onChange={(e) => onPolishLevel(e.target.value)}
              title="AI 润色版、高级句式与推荐表达都会匹配该考试难度">
              {(levels || []).map((lv) => <option key={lv} value={lv}>{lv}</option>)}
            </select>
          </label>
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
