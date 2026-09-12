/**
 * 选课：内置四册课表 + 自建课文库的选课，以及"当前正在练哪一课"的状态。
 *
 * 这是全项目耦合最重的一块，边界必须写清楚：
 * · 它**会写编辑区**（选课要把标题/中文/原文填进去），所以由 App 把 useEditor 的 setter 传进来；
 * · 它**会触发生成**（连点两课时自动生成），走 runGenerateRef 取"当下那份"，避免依赖链塌掉；
 * · 它依赖自建库（activeLib / myLibs 来自 useLibraries），但不管库的增删改。
 * 把这三条写明，是因为这块以前散在 App 的十来处，改一处很容易漏掉另外两处。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLesson, getLessons, wakeUp } from '../api.js';
import { safeGet, safeSet } from '../storage.js';
import { DEMO_LESSONS } from '../demo.js';
import { lessonLabel } from '../lessonLabel.js';

/**
 * @param {object} o
 * @param {object} o.libs useLibraries 的返回值里需要的几个（activeLib / myLibs / myLibId / setMyLibId）
 * @param {object} o.editor useEditor 的 setter（选课要填编辑区）
 * @param {Function} o.runGenerateRef 生成函数的 ref（自动生成用）
 * @param {Function} o.refreshStatus 刷新顶部状态（探活后调用）
 * @param {Function} o.setError 全局错误条（清空用）
 * @param {Function} o.setMode 切换课文/自由模式
 * @param {Function} o.markSavedSnapshot 记录"已保存快照"（判断作业有没有改动过）
 * @param {Function} o.toast 提示
 */
export function useLessons({
  activeLib, myLibs, myLibId, setMyLibId,
  setTitle, setChinese, setDraft, setGeneratedOriginal, setManualOriginal, setMaterialKeywords,
  setMatchConfidence, setMatchScore, setMode,
  runGenerateRef, refreshStatus, setError, markSavedSnapshot, toast, setBackendWaking, genTokenRef, aliveRef,
}) {
  const [lessons, setLessons] = useState([]);
  const [book, setBook] = useState(() => {
    const b = Number(safeGet('bt-book', ''));
    return [1, 2, 3, 4].includes(b) ? b : 2;
  });
  const [lessonId, setLessonId] = useState(() => {
    const n = Number(safeGet('bt-lesson', ''));
    return Number.isFinite(n) && n > 0 ? n : 18;
  });
  const [matchedLesson, setMatchedLesson] = useState(null);
  const [lessonQuery, setLessonQuery] = useState(''); // 课文搜索（348 课靠翻列表太慢）

  // 请求令牌：连点两课时，先发的慢请求若后返回，会把标题/中文覆盖成上一课的内容
  // （表现为侧栏高亮第 5 课、编辑区却是第 3 课）。挂载时的自动选课也会"迟到覆盖"用户的手动选择。
  const lessonReqRef = useRef(0);

  /** 侧栏列表：当前库的课文，或内置册（按搜索词过滤；纯数字按课号匹配，便于"跳到第 47 课"） */
  const visibleLessons = useMemo(() => {
    const base = activeLib ? activeLib.lessons : lessons.filter((l) => l.book === book);
    const q = lessonQuery.trim().toLowerCase();
    if (!q) return base;
    const text = (l) => `${l.lesson} ${l.title_cn || ''} ${l.title_en || ''}`.toLowerCase();
    if (/^\d{1,3}$/.test(q)) {
      const n = Number(q);
      return base.filter((l) => l.lesson === n || text(l).includes(q));
    }
    return base.filter((l) => text(l).includes(q));
  }, [activeLib, lessons, book, lessonQuery]);

  /** 加载内置课表（探活 → 拉取；后端彻底不可用时退回内置示例） */
  useEffect(() => {
    let alive = true;
    (async () => {
      // 免费托管（Render）休眠后唤醒要约 1 分钟。必须**先探活再做首屏请求**：
      // 否则 /api/status 与 /api/lessons 会在 15 秒时超时，用户看到的是
      // "服务器出错 + 退回示例课文"，而其实再等 40 秒数据就来了。
      await wakeUp({ onSlow: () => { if (alive && setBackendWaking) setBackendWaking(true); } });
      if (!alive) return;
      if (setBackendWaking) setBackendWaking(false);
      if (refreshStatus) refreshStatus();
      try {
        const data = await getLessons();
        if (!alive) return;
        const loaded = data.lessons || [];
        setLessons(loaded);
        if (loaded.length) {
          const target = pickInitialLesson(loaded);
          selectLessonRef.current(target.book, target.lesson);
        }
      } catch {
        // 后端彻底不可用才退回示例课文（保留原有的降级行为）
        if (!alive) return;
        const fallback = DEMO_LESSONS.map((l) => ({ ...l, book: 2 }));
        setLessons(fallback);
        const target = pickInitialLesson(fallback) || { book: 2, lesson: 18 };
        selectLessonRef.current(target.book, target.lesson);
      }
    })();
    return () => { alive = false; };
    // 刻意只在挂载时跑一次：selectLesson 每次渲染都是新函数，放进来会变成每次渲染都重新拉课表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 选中内置课文：带回原文填入编辑区（并发请求用令牌丢弃过期结果） */
  const selectLesson = useCallback(async (nextBook, nextLesson, autoGenerate = false) => {
    const reqId = (lessonReqRef.current += 1);
    if (genTokenRef) genTokenRef.current += 1; // 切课即作废正在跑的生成任务，避免它完成时抢回结果页
    setBook(nextBook);
    setLessonId(nextLesson);
    setMatchedLesson(null);
    setMode('lesson');
    setMatchConfidence('manual');
    setMatchScore(null);
    safeSet('bt-book', String(nextBook));
    safeSet('bt-lesson', String(nextLesson));
    try {
      const lesson = await getLesson(nextBook, nextLesson);
      if (reqId !== lessonReqRef.current) return; // 已被更晚的选择取代，丢弃这次结果
      setTitle(lessonLabel(lesson));
      setChinese(lesson.chinese || '');
      setDraft('');
      setGeneratedOriginal('');
      // 语料里每一课都带英文原文（348 课全有），直接把标准答案填进「英文原文」栏，
      // 用户可以看到/对照，不再是一个空框。
      setManualOriginal(lesson.english || '');
      setMaterialKeywords([]);
      setMatchedLesson(lesson);
      // 注意：内置课文不写 savedSnapshot —— 它还没进过课文库，用户随时可能想存进去
    } catch {
      if (reqId !== lessonReqRef.current) return;
      setTitle(`Lesson ${nextLesson}`);
      setChinese('');
      setDraft('');
      setGeneratedOriginal('');
      setManualOriginal('');
      setMaterialKeywords([]);
    }
    // 走 ref 取当下的生成函数：否则 selectLesson 的依赖会一路拖到整个生成流程
    if (autoGenerate) setTimeout(() => runGenerateRef.current && runGenerateRef.current(nextLesson), 60);
  }, [genTokenRef, runGenerateRef, setChinese, setDraft, setGeneratedOriginal, setManualOriginal, setMatchConfidence, setMatchScore, setMaterialKeywords, setMode, setTitle]);

  // 探活 effect 里要调 selectLesson，但它自己会随依赖变化 → 用 ref 取最新那份
  const selectLessonRef = useRef(selectLesson);
  selectLessonRef.current = selectLesson;

  const handleBookChange = useCallback((nextBook) => {
    setMyLibId(''); // 切回内置册
    const first = lessons.find((l) => l.book === nextBook);
    if (first) selectLesson(nextBook, first.lesson);
    else setBook(nextBook);
  }, [lessons, selectLesson, setMyLibId]);

  /** 从自建库载入一节课（本地数据，不发请求） */
  const selectMyLesson = useCallback((libId, lessonNo) => {
    const lib = myLibs.find((x) => x.id === libId);
    const lesson = lib?.lessons.find((l) => l.lesson === Number(lessonNo));
    if (!lesson) return;
    lessonReqRef.current += 1; // 作废仍在飞的内置课文请求，避免它回来覆盖
    if (genTokenRef) genTokenRef.current += 1;
    setMyLibId(libId);
    setLessonId(lesson.lesson);
    setMatchedLesson(lesson);
    setMode('lesson');
    setMatchConfidence('manual');
    setMatchScore(null);
    setTitle(lesson.title_cn || lessonLabel(lesson)); // 自建课文直接用标题，不带 Lesson 编号
    setChinese(lesson.chinese || '');
    setDraft('');
    setGeneratedOriginal('');
    setManualOriginal(lesson.english || '');
    setMaterialKeywords([]);
    setError('');
    if (markSavedSnapshot) markSavedSnapshot(lesson);
  }, [myLibs, setMyLibId, genTokenRef, setChinese, setDraft, setGeneratedOriginal, setManualOriginal, setMatchConfidence, setMatchScore, setMaterialKeywords, setMode, setTitle, setError, markSavedSnapshot]);

  /** 「改用这一课」：把当前匹配到的课文正式选中（只改标题与原文，不重新拉课表） */
  const applyMatchedLesson = useCallback(() => {
    if (!matchedLesson) return;
    setMode('lesson');
    setTitle(lessonLabel(matchedLesson));
    setManualOriginal(matchedLesson.english || ''); // 把这一课的英文原文带进「英文原文」栏
    setMatchConfidence('manual');
    setMatchScore(null);
    safeSet('bt-book', String(matchedLesson.book));
    safeSet('bt-lesson', String(matchedLesson.lesson));
  }, [matchedLesson, setManualOriginal, setMatchConfidence, setMatchScore, setMode, setTitle]);

  return {
    lessons, setLessons, book, setBook, lessonId, setLessonId, matchedLesson, setMatchedLesson,
    lessonQuery, setLessonQuery, visibleLessons,
    selectLesson, handleBookChange, selectMyLesson, applyMatchedLesson,
  };
}

/** 恢复上次打开的书册/课次；没有记录则默认该册第一课 */
function pickInitialLesson(list) {
  const savedBook = Number(safeGet('bt-book', ''));
  const savedLesson = Number(safeGet('bt-lesson', ''));
  const targetBook = [1, 2, 3, 4].includes(savedBook) ? savedBook : 2;
  const match = list.find((l) => l.book === targetBook && l.lesson === savedLesson);
  if (match) return match;
  return list.find((l) => l.book === targetBook) || list[0] || null;
}
