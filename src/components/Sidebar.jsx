import React from 'react';
import { Download, FolderPlus, Library, ListOrdered, PenLine, Plus, Settings, Star, Trash2, X } from 'lucide-react';
import { doneSet, progressOf, summarize } from '../lessonProgress.js';

/**
 * 左侧栏：课文库（内置 4 册 + 我的课文库）+ 搜课 + 课文列表 + 底部设置/备份入口。
 *
 * 抽出来的原因：它是**纯展示 + 回调**（不持有任何状态），却占了 App 里最长的一段 JSX；
 * 留在 App 里既看不出编辑逻辑，也没法单独改样式（改侧栏要在一屏一屏地翻 3000 行）。
 * 所有状态仍由 App 持有，这里只接收值 + 回调 —— 拆出去不改变任何行为。
 */
function Sidebar({
  sidebarOpen, onToggle, onCloseOnMobile,
  onNewJob, myLibId, book, onBookChange, myLibs, onOpenLibModal, onSelectLib, onDeleteLib,
  lessonQuery, onLessonQuery, activeLib, lessons, visibleLessons,
  mode, lessonId, onSelectLesson, onSelectMyLesson, onDeleteMyLesson, onEditMyLesson, onRenumberLib,
  onOpenSettings, onOpenBackup, lessonProgress,
}) {
  // 每节课的 lessonKey 必须与生成时用的完全一致（App 里的 lessonKey 也是这个格式），
  // 否则会出现"明明练过却不打星"。自建库用稳定 id（lid），所以改标题/改序号都不会丢进度。
  const keyOf = (l) => (activeLib
    ? `lesson:my-${activeLib.id}-${l.lid || l.lesson}`
    : `lesson:${l.book}-${l.lesson}`);
  const done = doneSet(lessonProgress);
  const scopeStats = summarize(lessonProgress, visibleLessons.map(keyOf));

  return (
    <>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={onToggle} aria-hidden="true" />}
      <aside className={'sidebar' + (sidebarOpen ? '' : ' collapsed')}>
        <button className="sidebar-close" onClick={onToggle} aria-label="收起侧栏"><X size={18} /></button>
        <div className="brand"><div className="brand-mark">回</div><div><strong>回译本</strong><span>BACK-TRANSLATE STUDIO</span></div></div>
        <button className="primary-btn" onClick={() => onNewJob(true)}><Plus size={16} />新建回译作业</button>
        <div className="side-section">
          <div className="side-title">课文库</div>
          <div className="book-tabs">
            {[1, 2, 3, 4].map((n) => <button key={n} className={!myLibId && book === n ? 'active' : ''} onClick={() => onBookChange(n)}>第 {n} 册</button>)}
          </div>

          <div className="my-libs">
            <div className="my-libs-head">
              <span className="side-title">我的课文库</span>
              {activeLib && activeLib.lessons.length > 0 && (
                <button className="lib-add" onClick={() => onRenumberLib(activeLib.id)} title="重排序号：把每节课的序号补齐成 1、2、3…（删课留下的空档会补上）" aria-label="重排序号">
                  <ListOrdered size={14} />
                </button>
              )}
              <button className="lib-add" onClick={onOpenLibModal} title="新建课文库 / 把当前作业存进课文库" aria-label="新建课文库">
                <FolderPlus size={14} />
              </button>
            </div>
            {myLibs.length === 0 && (
              <div className="lib-empty">还没有自建库：点右上角 <FolderPlus size={11} /> 把当前作业存成课文，就能像课文一样反复练。</div>
            )}
            {myLibs.map((lib) => (
              <div key={lib.id} className={'lib-row' + (myLibId === lib.id ? ' active' : '')}>
                <button className="lib-tab" onClick={() => { onCloseOnMobile(); onSelectLib(lib.id); }}>
                  <Library size={13} />
                  <span className="lib-name">{lib.name}</span>
                  <span className="lib-count">{lib.lessons.length}</span>
                </button>
                <button className="lib-del" onClick={() => onDeleteLib(lib.id, lib.name)} title="删除该课文库" aria-label={'删除课文库 ' + lib.name}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="lesson-search">
            <input
              value={lessonQuery}
              onChange={(e) => onLessonQuery(e.target.value)}
              placeholder={activeLib ? '搜索本库课文' : `搜索第 ${book} 册（共 ${lessons.filter((l) => l.book === book).length} 课）`}
              aria-label="搜索课文"
            />
            {lessonQuery ? (
              <button className="lesson-search-clear" onClick={() => onLessonQuery('')} aria-label="清空搜索"><X size={13} /></button>
            ) : null}
          </div>

          {scopeStats.total > 0 ? (
            <div className="book-progress" title={`已练 ${scopeStats.done} 课 · 共 ${scopeStats.total} 课${scopeStats.attempts ? ` · 累计 ${scopeStats.attempts} 次` : ''}`}>
              <div className="book-progress-head">
                <span>{activeLib ? '本库进度' : `第 ${book} 册进度`}</span>
                <strong>{scopeStats.done}<i>/{scopeStats.total}</i></strong>
              </div>
              <div className="book-progress-track">
                <div className="book-progress-fill" style={{ width: (scopeStats.done / scopeStats.total * 100) + '%' }} />
              </div>
            </div>
          ) : null}

          <div className="lesson-list">
            {visibleLessons.length === 0 && (
              <div className="muted">
                {lessonQuery
                  ? `没有匹配「${lessonQuery}」的课文`
                  : (activeLib ? '这个库还是空的：把当前作业存进来即可' : '正在加载语料…')}
              </div>
            )}
            {visibleLessons.map((l) => {
              const isActive = mode === 'lesson' && lessonId === l.lesson && (activeLib ? myLibId === activeLib.id : (book === l.book && !myLibId));
              return (
                <div key={`${l.book}-${l.lesson}`} className={'lesson-row' + (isActive ? ' active' : '')}>
                  <button className="lesson-item" onClick={() => { onCloseOnMobile(); if (activeLib) onSelectMyLesson(activeLib.id, l.lesson); else onSelectLesson(l.book, l.lesson); }}>
                    <span className="lesson-no">{String(l.lesson).padStart(2, '0')}</span>
                    <span className="lesson-title">{l.title_cn || l.title_en || 'Lesson ' + l.lesson}</span>
                    {(() => {
                      const key = keyOf(l);
                      if (!done.has(key)) return null; // Set 做快速判定，命中后再取详情做提示
                      const p = progressOf(lessonProgress, key);
                      return (
                        <span className="lesson-done" title={`已完成 ${p.n} 次${p.best ? ' · 最好 ' + p.best + ' 分' : ''}`} aria-label="已完成">
                          <Star size={12} fill="currentColor" />
                        </span>
                      );
                    })()}
                  </button>
                  {activeLib && (
                    <button className="lesson-edit" onClick={() => onEditMyLesson(activeLib.id, l)} title="改标题 / 改序号" aria-label="编辑这节课">
                      <PenLine size={12} />
                    </button>
                  )}
                  {activeLib && (
                    <button className="lesson-del" onClick={() => onDeleteMyLesson(activeLib.id, l, l.title_cn || ('Lesson ' + l.lesson))} title="从库中删除" aria-label="从库中删除">
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="side-footer">
          <button className="ghost-btn" onClick={onOpenSettings}><Settings size={15} />AI 设置</button>
          <button className="ghost-btn" onClick={onOpenBackup} title="导出 / 导入本机数据备份（课文库、收藏夹、历史）"><Download size={15} />备份</button>
        </div>
      </aside>
    </>
  );
}

export default React.memo(Sidebar);
