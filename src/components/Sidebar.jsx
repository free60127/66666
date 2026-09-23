import React, { useRef, useState } from 'react';
import { ChevronDown, Flame, FolderPlus, Library, ListOrdered, PenLine, Plus, Star, Target, Trash2, Upload, X } from 'lucide-react';
import { doneSet, progressOf, summarize } from '../lessonProgress.js';
import { summarizeStreak } from '../studyStreak.js';
import { lessonKeyOf } from '../lessonLabel.js';
import { safeGet, safeSet } from '../storage.js';

/**
 * 左侧栏：课文库（内置「回译课文 / 真题」两库 + 我的课文库）+ 搜课 + 课文列表。
 * （原底部的「AI 设置 / 备份」已删：方案A 之后这两个入口统一收进顶栏 ⋮ 菜单。）
 *
 * 抽出来的原因：它是**纯展示 + 回调**（几乎不持有状态），却占了 App 里最长的一段 JSX；
 * 留在 App 里既看不出编辑逻辑，也没法单独改样式（改侧栏要在一屏一屏地翻 3000 行）。
 * 所有业务状态仍由 App 持有；这里唯一的本地状态是「组折叠」，纯视图偏好所以留在本地。
 */
function Sidebar({
  sidebarOpen, onToggle, onCloseOnMobile,
  onNewJob, myLibId, book, builtinTab, onBuiltinTab, myLibs, onOpenLibModal, onSelectLib, onDeleteLib,
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

  // 两个内置库的课文数（卡片上的角标，也是搜索框文案）
  const huiyiCount = lessons.filter((l) => l.book === 10).length;
  const examCount = lessons.filter((l) => l.book >= 5 && l.book <= 9).length;
  const builtinCount = builtinTab === 'huiyi' ? huiyiCount : examCount;

  // 组开合（回译课文的级别组 / 真题的各考试组）：存**展开的组**而不是折叠的组 ——
  // 空列表 = 全部折叠，所以「第一次进来」的默认态就是全折叠（2026-09-23 用户拍板）。
  const [openGroups, setOpenGroups] = useState(() => {
    try { return new Set(JSON.parse(safeGet('bt-open-groups', '') || '[]')); } catch { return new Set(); }
  });
  const toggleGroup = (key) => {
    const next = new Set(openGroups);
    if (next.has(key)) next.delete(key); else next.add(key);
    setOpenGroups(next);
    safeSet('bt-open-groups', JSON.stringify([...next]));
  };

  // 搜索匹配与「没有匹配」空态：必须和**实际渲染的列表**同一个口径 ——
  // 内置库渲染的是「所选库卡片」的课文（回译课文=book 10 / 真题=book 5-9），
  // 若用 visibleLessons（旧书册口径）判断空态，会出现"上面挂着没有匹配、
  // 下面却列着匹配结果"的精分现场。自建库仍渲染 visibleLessons，口径不变。
  const q = lessonQuery.trim().toLowerCase();
  const searchMatches = (l) => {
    if (!q) return true;
    const text = `${l.lesson} ${l.title_cn || ''} ${l.title_en || ''}`.toLowerCase();
    if (/^\d{1,3}$/.test(q)) { const n = Number(q); return l.lesson === n || text.includes(q); }
    return text.includes(q);
  };
  const listEmpty = activeLib
    ? visibleLessons.length === 0
    : !lessons.some((l) => (builtinTab === 'huiyi' ? l.book === 10 : l.book >= 5 && l.book <= 9) && searchMatches(l));

  return (
    <>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={onToggle} aria-hidden="true" />}
      <aside className={'sidebar' + (sidebarOpen ? '' : ' collapsed')}>
        <button className="sidebar-close" onClick={onToggle} aria-label="收起侧栏"><X size={18} /></button>
        <div className="brand"><div className="brand-mark">回</div><div><strong>回译本</strong><span>BACK-TRANSLATE STUDIO</span></div></div>
        <button className="primary-btn" onClick={() => onNewJob(true)}><Plus size={16} />新建{directionName === '英译汉' ? '翻译' : '回译'}作业</button>
        <div className="side-section">
          <div className="side-title">课文库</div>
          {/* 内置库选择卡片（原来是一排书册 tab）：新概念语料下架后合并成两个库 ——
              回译课文（分级课内语料）和真题（四六级/考研/专八）。 */}
          <div className="builtin-tabs">
            <button type="button" className={'builtin-tab' + (builtinTab === 'huiyi' ? ' active' : '')}
              onClick={() => onBuiltinTab('huiyi')} aria-pressed={builtinTab === 'huiyi'}>
              <span>回译课文</span><i>{huiyiCount}</i>
            </button>
            <button type="button" className={'builtin-tab' + (builtinTab === 'exam' ? ' active' : '')}
              onClick={() => onBuiltinTab('exam')} aria-pressed={builtinTab === 'exam'}>
              <span>真题</span><i>{examCount}</i>
            </button>
          </div>

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
              placeholder={activeLib
                ? '搜索本库课文'
                : (builtinTab === 'huiyi'
                  ? `搜索回译课文（共 ${builtinCount} 课）`
                  : `搜索真题（共 ${builtinCount} 课）`)}
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
                <span>{activeLib ? '本库进度' : book === 10 ? '回译课文进度' : (((books || []).find((x) => x.book === book) || {}).label || `第 ${book} 册`) + '进度'}</span>
                <strong>{scopeStats.done}<i>/{scopeStats.total}</i></strong>
              </div>
              <div className="book-progress-track">
                <div className="book-progress-fill" style={{ width: (scopeStats.done / scopeStats.total * 100) + '%' }} />
              </div>
            </div>
          ) : null}

          <div className="lesson-list">
            {listEmpty && (
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
                // 内置课文库：只显示顶部选中的「库」卡片 —— 回译课文（book 10，按级别分组）
                // 或真题（book 5-9，各考试一组）。组名点击可折叠；搜索时忽略折叠
                //（否则匹配到的课文在折叠组里会"看起来没搜到"）。匹配口径用外层的 searchMatches。
                const searching = q.length > 0;
                const foldBtn = (key, label) => {
                  const isOpen = searching || openGroups.has(key);
                  return (
                    <button type="button" key={key}
                      className={'lesson-group-title foldable' + (isOpen ? ' open' : '')}
                      onClick={() => toggleGroup(key)} aria-expanded={isOpen}
                      title={isOpen ? '折叠这一组' : '展开这一组'}>
                      <span className="lgt-name">{label}</span>
                      <ChevronDown size={12} className="fold-chevron" />
                    </button>
                  );
                };
                const pushGroup = (key, label, ls) => {
                  nodes.push(foldBtn(key, label));
                  if (!searching && !openGroups.has(key)) return;
                  ls.forEach((l) => nodes.push(renderLessonRow(l)));
                };
                if (builtinTab === 'huiyi') {
                  // 回译课文：按 section 顺序分组（小初 / 初中 / 高中 / …）
                  const groups = [];
                  let cur = null;
                  lessons.filter((l) => l.book === 10 && searchMatches(l)).forEach((l) => {
                    const s = l.section || '其他';
                    if (!cur || cur.label !== s) { cur = { label: s, ls: [] }; groups.push(cur); }
                    cur.ls.push(l);
                  });
                  groups.forEach((g) => pushGroup('huiyi:' + g.label, g.label, g.ls));
                } else {
                  [5, 6, 7, 8, 9]
                    .map((b) => ({ label: ((books || []).find((x) => x.book === b) || {}).label || `第 ${b} 册`, ls: lessons.filter((l) => l.book === b && searchMatches(l)) }))
                    .filter((g) => g.ls.length)
                    .forEach((g) => pushGroup('exam:' + g.label, g.label, g.ls));
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
