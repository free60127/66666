import React, { useRef } from 'react';
import { Flame, FolderPlus, Library, ListOrdered, PenLine, Plus, Star, Target, Trash2, Upload, X } from 'lucide-react';
import { doneSet, progressOf, summarize } from '../lessonProgress.js';
import { summarizeStreak } from '../studyStreak.js';
import { lessonKeyOf } from '../lessonLabel.js';

/**
 * 左侧栏：课文库（内置 4 册 + 我的课文库）+ 搜课 + 课文列表。
 * （原底部的「AI 设置 / 备份」已删：方案A 之后这两个入口统一收进顶栏 ⋮ 菜单。）
 *
 * 抽出来的原因：它是**纯展示 + 回调**（不持有任何状态），却占了 App 里最长的一段 JSX；
 * 留在 App 里既看不出编辑逻辑，也没法单独改样式（改侧栏要在一屏一屏地翻 3000 行）。
 * 所有状态仍由 App 持有，这里只接收值 + 回调 —— 拆出去不改变任何行为。
 */
function Sidebar({
  sidebarOpen, onToggle, onCloseOnMobile,
  onNewJob, myLibId, book, onBookChange, myLibs, onOpenLibModal, onSelectLib, onDeleteLib,
  onImportCorpus, onAddSection, onRenameSection, onDeleteSection,
  lessonQuery, onLessonQuery, activeLib, lessons, visibleLessons,
  mode, lessonId, onSelectLesson, onSelectMyLesson, onDeleteMyLesson, onEditMyLesson, onRenumberLib,
  lessonProgress, studyDays, books, directionName,
  drillReady, onOpenDrill,
}) {  // lessonKey 统一走 lessonLabel.lessonKeyOf —— 与生成/进度/错误训练用的是同一份实现，
  // 各写一份只要漂移一处（自建库用 lid 还是序号），就会出现"练过却不打星"或"错题归错课"。
  const keyOf = (l) => lessonKeyOf(l, activeLib);
  const currentBookMeta = (books || []).find((b) => b.book === book) || null;
  const done = doneSet(lessonProgress);
  const scopeStats = summarize(lessonProgress, visibleLessons.map(keyOf));
  const streak = summarizeStreak(studyDays);
  // 语料 JSON 导入的文件选择器（不受控：选完即清空，同一文件可重复导入）
  const corpusFileRef = useRef(null);

  return (
    <>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={onToggle} aria-hidden="true" />}
      <aside className={'sidebar' + (sidebarOpen ? '' : ' collapsed')}>
        <button className="sidebar-close" onClick={onToggle} aria-label="收起侧栏"><X size={18} /></button>
        <div className="brand"><div className="brand-mark">回</div><div><strong>回译本</strong><span>BACK-TRANSLATE STUDIO</span></div></div>
        <button className="primary-btn" onClick={() => onNewJob(true)}><Plus size={16} />新建{directionName === '英译汉' ? '翻译' : '回译'}作业</button>
        <div className="side-section">
          <div className="side-title">课文库</div>
          {/* 方案A·两大分组：内置册 tab 已撤（新概念语料下架 + 真题并入「真题」分组） */}

          <div className="my-libs">
            <div className="my-libs-head">
              <span className="side-title">我的课文库</span>
              <input ref={corpusFileRef} type="file" accept=".json,application/json" hidden
                onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f && onImportCorpus) onImportCorpus(f); }} />
              {onImportCorpus && (
                <button className="lib-add" onClick={() => corpusFileRef.current?.click()}
                  title="导入语料 JSON：把 README「语料」格式的 JSON 文件转成我的课文库（导入后走云同步，其他设备同码可见）"
                  aria-label="导入语料 JSON">
                  <Upload size={14} />
                </button>
              )}
              {activeLib && onAddSection && (
                <button className="lib-add" onClick={() => { const n = window.prompt('新分组名称'); if (n && n.trim()) onAddSection(activeLib.id, n.trim()); }}
                  title="新建分组" aria-label="新建分组">
                  <Plus size={14} />
                </button>
              )}
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

          {streak.total > 0 ? (
            <div className={'streak-row' + (streak.current > 0 ? ' on' : '')}
              title={`连续学习 ${streak.current} 天 · 最长 ${streak.longest} 天 · 累计 ${streak.total} 天${streak.todayDone ? ' · 今天已完成' : ' · 今天还没练'}`}>
              <span className="streak-flame"><Flame size={13} fill={streak.current > 0 ? 'currentColor' : 'none'} /></span>
              {streak.current > 0
                ? <><strong>连续 {streak.current} 天</strong><span className="streak-sub">{streak.todayDone ? '今天已完成' : '今天还没练'}</span></>
                : <><strong>连续中断</strong><span className="streak-sub">最长 {streak.longest} 天 · 练一课即可重启</span></>}
            </div>
          ) : null}

          {/* 错误训练：放在"连续天数"和"本册进度"之间 —— 上面是激励（我坚持了多久），
              下面是进度（我做了多少），中间正好是"我错在哪、怎么补"。
              按钮上的数字是**这个课文库里可训练的错题数**，一眼看出点进去有没有东西。 */}
          {onOpenDrill ? (
            <button className={'drill-entry' + (drillReady ? ' has' : '')} onClick={onOpenDrill}
              title={drillReady
                ? `用你练过的课里实际犯过的错出题（${drillReady} 处可训练）`
                : '用你练过的课里实际犯过的错出针对性练习'}>
              <Target size={14} />
              <span>错误训练</span>
              {drillReady ? <i>{drillReady}</i> : <em>暂无错题</em>}
            </button>
          ) : null}

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
                  : (activeLib
                    ? '这个库还是空的：把当前作业存进来即可'
                    : (currentBookMeta && currentBookMeta.lessons === 0
                      // 已知这个内置库是空的：直接告诉使用者该放哪个文件（比"正在加载语料…"有用得多）
                      ? `${currentBookMeta.label}还没有语料：把语料文件放到 public/corpus/${currentBookMeta.file || ''} 即可（格式见 README 的「语料」一节）`
                      : '正在加载语料…'))}
              </div>
            )}
            {(() => {
              // 小标题分组：带 section 字段的库（如「回译课文」）在分组变化处插入小标题行，
              // 搜索过滤后同样按过滤结果的分组边界渲染
              const renderLessonRow = (l) => {
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
              };
              const nodes = [];
              let lastSec = '';
              const topHeader = (label) => nodes.push(
                <div key={'top-' + label} className="top-group-title">{label}</div>
              );
              const pushSectionHeader = (label, cls) => nodes.push(
                <div key={'sec-' + nodes.length} className={'lesson-group-title' + (cls ? ' ' + cls : '')}>{label}</div>
              );
              if (activeLib) {
                // 我的课文库：自建库的分组也渲染组头（组内改名/删除）
                visibleLessons.forEach((l) => {
                  if (l.section && l.section !== lastSec) {
                    nodes.push(
                      <div key={'sec-' + l.section} className="lesson-group-title mylib-group">
                        <span className="lgt-name">{l.section}</span>
                        <span className="lgt-ops">
                          <button className="lgt-btn" onClick={(e) => { e.stopPropagation(); const n = window.prompt('修改分组名称', l.section); if (n && n.trim() && n.trim() !== l.section) onRenameSection(activeLib.id, l.section, n.trim()); }} title="重命名此分组" aria-label="重命名此分组"><PenLine size={11} /></button>
                          <button className="lgt-btn" onClick={(e) => { e.stopPropagation(); if (window.confirm(`删除分组「${l.section}」？组内课文会移动到第一组，不会删除课文。`)) onDeleteSection(activeLib.id, l.section); }} title="删除此分组（课文移到第一组）" aria-label="删除此分组"><Trash2 size={11} /></button>
                        </span>
                      </div>
                    );
                    lastSec = l.section;
                  }
                  nodes.push(renderLessonRow(l));
                });
              } else {
                // 内置课文库（方案A·两大分组）：回译课文（360 课，按六个级别小标题）
                // + 真题（四级/六级/英一/英二/专八，各年真题）；搜索跨全部 530 课
                const q = lessonQuery.trim().toLowerCase();
                const matchQ = (l) => {
                  if (!q) return true;
                  const text = `${l.lesson} ${l.title_cn || ''} ${l.title_en || ''}`.toLowerCase();
                  if (/^\d{1,3}$/.test(q)) { const n = Number(q); return l.lesson === n || text.includes(q); }
                  return text.includes(q);
                };
                const huiyi = lessons.filter((l) => l.book === 10 && matchQ(l));
                if (huiyi.length) {
                  topHeader('回译课文');
                  let sec = '';
                  huiyi.forEach((l) => {
                    if (l.section && l.section !== sec) { pushSectionHeader(l.section); sec = l.section; }
                    nodes.push(renderLessonRow(l));
                  });
                }
                const examGroups = [5, 6, 7, 8, 9]
                  .map((b) => ({ label: ((books || []).find((x) => x.book === b) || {}).label || '', ls: lessons.filter((l) => l.book === b && matchQ(l)) }))
                  .filter((g) => g.ls.length);
                if (examGroups.length) {
                  topHeader('真题');
                  examGroups.forEach((g) => {
                    pushSectionHeader(g.label);
                    g.ls.forEach((l) => nodes.push(renderLessonRow(l)));
                  });
                }
              }
              return nodes;
            })()}
          </div>
        </div>
      </aside>
    </>
  );
}

export default React.memo(Sidebar);
