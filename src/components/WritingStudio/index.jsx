import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, BookOpen, Camera, ChevronRight, Eye, ImagePlus,
  LoaderCircle, PenLine, Timer, WandSparkles, X,
} from 'lucide-react'
import { writingBrief, getWritingBriefJob } from '../../api.js'
import { dataOwner } from '../../accountCache.js'
import { submitAndPoll } from '../../hooks/pollJob.js'
import { POLL_ANALYZE_MS, POLL_MAX_FAILURES, TIMEOUT_ANALYZE_MS } from '../../constants.js'
import { WRITING_TOPICS, WRITING_TOPIC_FILTERS } from '../../writingTopics.js'
import { WRITING_EXAM_BANK, WRITING_EXAM_META, WRITING_EXAM_TOPICS } from '../../writingExamBank.js'
import ElapsedDisplay from '../ElapsedDisplay.jsx'
import TopicImage from './TopicImage.jsx'
import WritingGuide from './WritingGuide.jsx'
import WritingMaterial from '../WritingMaterial.jsx'
import { hasWritingBrief, normalizeWritingBrief } from '../../writingGuidance.js'
import { countWritingWords as countWords, loadWritingState, splitWritingParagraphs, writingMaterial, writingTargetWords, writingTopicKey,
  WRITING_DRAFT_PREFIX, listWritingDrafts, newWritingWriter, rememberWritingTopic, saveWritingDraft, writingDraftFingerprint, writingDraftVersions } from '../../writing.js'
import '../../writing.css'

/**
 * 写作模式（独立 UI）：题库 → 写作 → 提交批改。
 *
 * 参照竞品的板块设计：
 * - 题库页：来源（四六级/考研/专四/专八/自编）+ 话题 + 难度筛选，题目卡片直接「写这篇」；
 * - 写作页：左栏题目卡（含配图与写作材料），右栏写作区；「直接开写」一支笔写到底，
 *   「按段带写」按 引言→主体1→主体2→结论 分段写，AI 生成本题写作指导（审题/段落安排/避坑/句式）；
 * - 吸底动作条：全文词数、计时、预览全文、提交批改。草稿自动保存（localStorage）。
 *
 * 批改走的是同一条 /api/analyze 链路（direction='writing'），结果仍由共享的 ResultSheet 渲染，
 * 所以历史/收藏/分享/云同步零改动（见 useGeneration 的 overrides 参数）。
 */

const SEG_META = [
  { key: 'intro', label: '引言', ratio: 0.15, tip: '点明主题，按题目要求交代背景或概括图表、材料' },
  { key: 'body1', label: '主体段 1', ratio: 0.3, tip: '展开第一个任务点，用论据、例子或题中数据支撑' },
  { key: 'body2', label: '主体段 2', ratio: 0.3, tip: '展开其余任务点，补充分析，注意与上一段衔接' },
  { key: 'concl', label: '结论', ratio: 0.25, tip: '总结全文，回应题目要求，不引入新的论据或数据' },
];

const emptyFilters = { exam: 'all', topic: 'all', level: 'all', q: '' };

export function WritingStudio({
  busy, polishLevel, settings, aliveRef,
  timer, hasElapsed, toggleTimer,
  onSubmit, onOcrImages, onTopicChange, onLeaveTopic, assignedTopic, workTitle, titleTopicKey,
}) {
  const stored = useRef(loadWritingState());
  const [view, setView] = useState(() => stored.current?.topic ? 'write' : 'bank');
  const [filters, setFilters] = useState(emptyFilters);
  const [topic, setTopic] = useState(() => WRITING_EXAM_BANK.find((item) => item.id === stored.current?.topic?.id) || stored.current?.topic || null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  const [mode, setMode] = useState(() => stored.current?.mode || 'direct');
  const [essay, setEssay] = useState(() => stored.current?.essay || '');
  const [segs, setSegs] = useState(() => (Array.isArray(stored.current?.segs) && stored.current.segs.length === 4) ? stored.current.segs : ['', '', '', '']);
  const [activeSeg, setActiveSeg] = useState(0);
  const [brief, setBrief] = useState(() => stored.current?.brief || null);
  const [angle, setAngle] = useState(() => stored.current?.angle || '');
  const [briefState, setBriefState] = useState(() => stored.current?.brief ? 'done' : 'idle'); // idle | running | done | error
  const [briefErr, setBriefErr] = useState('');
  const [briefOpen, setBriefOpen] = useState(() => stored.current?.briefOpen || false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [savedAt, setSavedAt] = useState(() => stored.current?.savedAt || 0);
  const [draftTitle, setDraftTitle] = useState(() => stored.current?.workTitle || stored.current?.topic?.zh || '');
  const [savedDrafts, setSavedDrafts] = useState(listWritingDrafts);
  const [localError, setLocalError] = useState('');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const mountedRef = useRef(true);
  const briefRequestRef = useRef(0);
  const baseRef = useRef(stored.current);
  const writerRef = useRef(newWritingWriter());
  const ownerRef = useRef(dataOwner());

  const fullText = mode === 'direct' ? essay : segs.join('\n\n');
  const wordCount = countWords(fullText);
  const targetWords = writingTargetWords(topic, polishLevel);
  const topicKey = writingTopicKey(topic);
  const material = writingMaterial(topic);
  const segTargets = SEG_META.map((s) => Math.max(20, Math.round(targetWords * s.ratio / 5) * 5));

  /* ---------- 草稿自动保存（800ms 防抖；提交/切题不丢内容） ---------- */
  const saveTimerRef = useRef(null);
  const stateRef = useRef(null);
  stateRef.current = { topic, mode, essay, segs, brief, angle, briefOpen,
    workTitle: titleTopicKey === topicKey && typeof workTitle === 'string' ? workTitle : draftTitle };
  const saveCurrent = useCallback((notify = true) => {
    const snap = stateRef.current;
    if (!snap?.topic || dataOwner() !== ownerRef.current) return true;
    try {
      baseRef.current = saveWritingDraft(snap, baseRef.current, writerRef.current);
      if (notify && mountedRef.current) { setSavedAt(baseRef.current.savedAt); setSaveError(''); setSavedDrafts(listWritingDrafts()); }
      return true;
    } catch {
      if (notify && mountedRef.current) setSaveError('草稿未能保存到浏览器，请先复制全文备份后再离开。');
      return false;
    }
  }, []);
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(saveCurrent, 800);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [topic, mode, essay, segs, brief, angle, briefOpen, workTitle, draftTitle, saveCurrent]);
  useEffect(() => {
    mountedRef.current = true;
    const flush = () => saveCurrent(false);
    const collect = (event) => { if (dataOwner() === ownerRef.current && stateRef.current?.topic) event.detail.drafts.push({ ...stateRef.current, savedAt: Date.now() }); };
    const onHidden = () => { if (document.hidden) flush(); };
    window.addEventListener('pagehide', flush);
    window.addEventListener('bts:before-account-change', flush);
    window.addEventListener('bts:flush-writing', flush);
    window.addEventListener('bts:collect-writing-drafts', collect);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      flush();
      mountedRef.current = false;
      briefRequestRef.current += 1;
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('bts:before-account-change', flush);
      window.removeEventListener('bts:flush-writing', flush);
      window.removeEventListener('bts:collect-writing-drafts', collect);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [saveCurrent]);
  useEffect(() => { onTopicChange?.(topic, stateRef.current.workTitle); }, [topic, onTopicChange]);
  useEffect(() => {
    const refresh = (event) => {
      if (dataOwner() !== ownerRef.current) return;
      if (!event.key || event.key.startsWith(WRITING_DRAFT_PREFIX)) setSavedDrafts(listWritingDrafts());
    };
    window.addEventListener('storage', refresh);
    window.addEventListener('bts:writing-drafts-changed', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('bts:writing-drafts-changed', refresh); };
  }, []);

  /* 首次输入自动开始计时（参照竞品「开始输入后自动计时」） */
  const firstInputRef = useRef(false);
  useEffect(() => { firstInputRef.current = false; }, [topicKey]);
  const onFirstInput = () => {
    if (firstInputRef.current) return;
    firstInputRef.current = true;
    if (!timer.running) toggleTimer();
  };

  /* ---------- 题库筛选 ---------- */
  const examChips = useMemo(() => [
    { id: 'all', name: '全部' },
    ...Object.keys(WRITING_EXAM_META).map((k) => ({ id: k, name: WRITING_EXAM_META[k].name })),
    { id: 'own', name: '精选自编' },
  ], []);
  const topicChips = useMemo(() => {
    const set = new Set([...WRITING_EXAM_TOPICS, ...WRITING_TOPIC_FILTERS.topics]);
    return ['all', ...set];
  }, []);
  const bankList = useMemo(() => {
    const own = WRITING_TOPICS.map((t) => ({
      id: 'own-' + t.id, exam: 'own', label: '精选自编', zh: t.zh, topic: t.topic,
      level: t.level, qtype: t.type, question: t.question, words: null, image: null,
    }));
    const all = [...WRITING_EXAM_BANK, ...own];
    const q = filters.q.trim().toLowerCase();
    return all.filter((t) => {
      if (filters.exam !== 'all' && t.exam !== filters.exam) return false;
      if (filters.topic !== 'all' && t.topic !== filters.topic) return false;
      if (filters.level !== 'all' && t.level !== filters.level) return false;
      if (q && !(t.zh.toLowerCase().includes(q) || t.question.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [filters]);

  /* ---------- 班级写作作业：锁定教师布置的题目 ----------
   * assignedTopic 来自进行中的班级任务（App 在认题/刷新时下发）。
   * 锁定后不进题库、不能换题 —— 服务端按「题目逐字一致」校验上报，换题会被整篇拒收。 */
  const assignedTopicObj = useMemo(() => {
    const q = String(assignedTopic?.question || '').trim();
    if (!q) return null;
    return {
      id: 'assigned', exam: 'assigned', label: assignedTopic.label || '班级作业',
      classId: assignedTopic.classId, hwId: assignedTopic.hwId,
      zh: assignedTopic.title || '班级写作作业', topic: '班级作业', level: '中级', qtype: '命题作文',
      question: q, material: assignedTopic.material || '', imageDesc: assignedTopic.imageDesc || '',
      words: assignedTopic.words || null, image: null,
    };
  }, [assignedTopic]);
  const topicLocked = Boolean(assignedTopicObj);

  /* ---------- 动作 ---------- */
  const startTopic = useCallback((t, restoredDraft, notifyLeave = true) => {
    if (!saveCurrent()) return false;
    const saved = restoredDraft || loadWritingState(writingTopicKey(t));
    try { rememberWritingTopic(t); } catch { setSaveError('无法记住当前题目，请先导出草稿备份。'); return false; }
    if (notifyLeave) onLeaveTopic?.();
    baseRef.current = saved;
    writerRef.current = newWritingWriter();
    setDraftTitle(saved?.workTitle ?? t.zh ?? '');
    onTopicChange?.(t, saved?.workTitle ?? t.zh ?? '');
    setEssay(typeof saved?.essay === 'string' ? saved.essay : '');
    setSegs(Array.isArray(saved?.segs) && saved.segs.length === 4 ? saved.segs.map((s) => typeof s === 'string' ? s : '') : ['', '', '', '']);
    setMode(saved?.mode === 'guided' ? 'guided' : 'direct');
    setSavedAt(saved?.savedAt || 0);
    setActiveSeg(0);
    briefRequestRef.current += 1;
    setTopic(t);
    const restored = normalizeWritingBrief(saved?.brief);
    const savedBrief = hasWritingBrief(restored) ? restored : null;
    setBrief(savedBrief);
    setAngle(typeof saved?.angle === 'string' ? saved.angle.slice(0, 400) : '');
    setBriefOpen(typeof saved?.briefOpen === 'boolean' ? saved.briefOpen : saved?.mode === 'guided');
    setBriefState(savedBrief ? 'done' : 'idle');
    setBriefErr('');
    setLocalError('');
    setView('write');
    window.scrollTo({ top: 0 });
    return true;
  }, [saveCurrent, onLeaveTopic, onTopicChange]);

  // 应用班级作业题目（放在 startTopic 之后声明，依赖它加载该题的历史草稿）
  const appliedAssignedRef = useRef('');
  useEffect(() => {
    if (!assignedTopicObj) { appliedAssignedRef.current = ''; return; }
    const key = JSON.stringify(assignedTopicObj);
    if (appliedAssignedRef.current === key) return;
    // Rehydrating the same homework after refresh is not a user navigation:
    // keep the pending grading recovery alive. Real task changes invalidate it.
    const restoringSameTask = !appliedAssignedRef.current
      && writingTopicKey(stateRef.current.topic) === writingTopicKey(assignedTopicObj);
    if (startTopic(assignedTopicObj, undefined, !restoringSameTask)) appliedAssignedRef.current = key;
  }, [assignedTopicObj, startTopic]);

  const switchMode = (next) => {
    if (next === mode) return;
    if (next === 'guided') { setSegs(splitWritingParagraphs(essay)); setBriefOpen(true); }
    else setEssay(segs.filter((s) => s.trim()).join('\n\n'));
    setMode(next);
  };

  const startCustom = () => {
    const q = customText.trim();
    if (!q) { setLocalError('请先粘贴或输入作文题目'); return; }
    setCustomOpen(false);
    startTopic({ id: 'custom', exam: 'custom', label: '自定义题目', zh: q.length > 18 ? q.slice(0, 18) + '…' : q, topic: '自定义', level: '中级', qtype: '自由命题', question: q, words: null, image: null });
  };

  const genBrief = useCallback(async (requestedAngle = '') => {
    if (!topic || !topic.question || briefState === 'running' || busy) return;
    const selected = typeof requestedAngle === 'string' ? requestedAngle.trim().slice(0, 400) : '';
    setAngle(selected);
    setBriefState('running');
    setBriefErr('');
    setBriefOpen(true);
    const requestId = ++briefRequestRef.current;
    const isCurrent = () => mountedRef.current && aliveRef.current && requestId === briefRequestRef.current;
    try {
      const outcome = await submitAndPoll({
        submit: () => writingBrief({
          topic: topic.question, material, imageDesc: topic.imageDesc || '', level: polishLevel, angle: selected, targetWords,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
        }),
        fetchJob: getWritingBriefJob,
        intervalMs: POLL_ANALYZE_MS,
        timeoutMs: TIMEOUT_ANALYZE_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，暂时无法获取写作指导，请重试',
        timeoutError: '生成指导超时，请重试',
        isAlive: isCurrent,
      });
      if (outcome.aborted || !isCurrent()) return;
      const d = normalizeWritingBrief(outcome.data, selected);
      if (!hasWritingBrief(d)) throw new Error('AI 返回内容不完整，请重试');
      setBrief(d);
      setAngle(d.selectedAngle);
      setBriefState('done');
    } catch (e) {
      if (!isCurrent()) return;
      setBriefState('error');
      setBriefErr(e.message || '生成失败，请重试');
    }
  }, [topic, material, briefState, polishLevel, settings, aliveRef, targetWords, busy]);

  const runOcr = async (files) => {
    if (ocrBusy || !onOcrImages) return;
    setOcrBusy(true);
    setLocalError('');
    const requestedKey = topicKey;
    try {
      const text = await onOcrImages(files);
      if (!mountedRef.current || writingTopicKey(stateRef.current?.topic) !== requestedKey) return;
      if (!text) throw new Error('没有识别到文字，请换更清晰的照片');
      if (mode === 'direct') {
        setEssay((prev) => (prev && prev.trim() ? prev.replace(/\s+$/, '') + '\n\n' + text : text));
      } else {
        setSegs((arr) => arr.map((s, i) => (i === activeSeg
          ? (s && s.trim() ? s.replace(/\s+$/, '') + '\n\n' + text : text)
          : s)));
      }
    } catch (e) {
      if (!mountedRef.current || writingTopicKey(stateRef.current?.topic) !== requestedKey) return;
      setLocalError('识别失败：' + (e.message || '未知错误'));
    } finally {
      if (mountedRef.current) setOcrBusy(false);
    }
  };

  const submit = () => {
    if (busy) return;
    if (!topic || !topic.question.trim()) { setLocalError('请先选择题目，或粘贴自定义题目'); return; }
    const text = fullText.trim();
    if (!text) { setLocalError('作文还是空的，写一点再提交批改'); return; }
    if (countWords(text) < 20) { setLocalError('作文太短（至少 20 词）——先写完主体内容再提交'); return; }
    setLocalError('');
    if (!saveCurrent()) return;
    onSubmit({
      topic: topic.question.trim(),
      material,
      imageDesc: topic.imageDesc || '',
      essay: text,
      title: stateRef.current.workTitle,
      topicId: topicKey,
      targetWords,
      writingTopic: topic,
      assignment: topicLocked ? { classId: assignedTopicObj.classId, hwId: assignedTopicObj.hwId } : null,
    });
  };

  const savedText = savedAt
    ? '草稿已自动保存 ' + new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '草稿会自动保存';

  /* ---------- 题库页 ---------- */
  if (view === 'bank' && !topicLocked) {
    return (
      <div className="ws">
        <div className="ws-bank-head">
          <div>
            <h2 className="ws-title"><PenLine size={18} />写作题库</h2>
            <p className="muted small">共 {bankList.length} 道题 · 选一道直接开写，或按段带写 · 批改按内容/结构/词汇/语法四维打分</p>
          </div>
        </div>
        {topic ? <button className="ghost-btn" onClick={() => setView('write')}>继续上次写作：{topic.zh || '自定义题目'}</button> : null}
        {savedDrafts.length ? <details className="ws-topic-desc">
          <summary>我的写作草稿（{savedDrafts.length} 份）</summary>
          {savedDrafts.map((item, i) => <p key={item.writer + ':' + i}><button className="ghost-btn sm"
            onClick={() => startTopic(item.topic, item)}>{item.workTitle || item.topic.zh || '未命名作文'} · {new Date(item.savedAt || 0).toLocaleString('zh-CN')}</button></p>)}
        </details> : null}
        {localError ? <p className="error-banner" role="alert">{localError}</p> : null}
        {saveError ? <p className="error-banner" role="alert">{saveError}</p> : null}
        {customOpen ? (
          <div className="ws-custom">
            <textarea
              className="ws-custom-input"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="粘贴或输入你的作文题目（英文），例如：Some people think that students should have part-time jobs. Do you agree?"
              rows={3}
              aria-label="自定义作文题目"
              autoFocus
            />
            <div className="ws-custom-actions">
              <button className="primary-btn sm" onClick={startCustom}>用这道题写作</button>
              <button className="ghost-btn sm" onClick={() => setCustomOpen(false)}>取消</button>
            </div>
          </div>
        ) : (
          <button className="ws-custom-entry" onClick={() => { setCustomOpen(true); setLocalError(''); }}>
            <PenLine size={14} />自定义题目：粘贴任意题目来写
          </button>
        )}
        <div className="ws-filters">
          <div className="ws-filter-row">
            <span className="ws-filter-label">来源</span>
            {examChips.map((c) => (
              <button key={c.id} className={filters.exam === c.id ? 'active' : ''}
                onClick={() => setFilters((f) => ({ ...f, exam: c.id }))}>{c.name}</button>
            ))}
          </div>
          <div className="ws-filter-row">
            <span className="ws-filter-label">话题</span>
            {topicChips.map((t) => (
              <button key={t} className={filters.topic === t ? 'active' : ''}
                onClick={() => setFilters((f) => ({ ...f, topic: t }))}>{t === 'all' ? '全部' : t}</button>
            ))}
          </div>
          <div className="ws-filter-row">
            <span className="ws-filter-label">难度</span>
            {['all', ...WRITING_TOPIC_FILTERS.levels].map((lv) => (
              <button key={lv} className={filters.level === lv ? 'active' : ''}
                onClick={() => setFilters((f) => ({ ...f, level: lv }))}>{lv === 'all' ? '全部' : lv}</button>
            ))}
            <input
              className="ws-search"
              aria-label="搜索写作题目"
              value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              placeholder="搜标题或题干，如 advertising、图书馆"
            />
            {(filters.exam !== 'all' || filters.topic !== 'all' || filters.level !== 'all' || filters.q) ? (
              <button className="link" onClick={() => setFilters(emptyFilters)}>清除筛选</button>
            ) : null}
          </div>
        </div>
        <div className="ws-cards">
          {bankList.map((t) => (
            <article key={t.id} className="ws-card" onClick={() => startTopic(t)}>
              <div className="ws-card-meta">
                <span>{t.level}</span><i>·</i><span>{t.qtype}</span><i>·</i><span>{t.label}</span>
              </div>
              <h3 className="ws-card-zh">{t.zh}</h3>
              <p className="ws-card-q">{t.question}</p>
              {t.image ? <TopicImage src={t.image} title={t.zh} thumbnail /> : null}
              <div className="ws-card-actions">
                <button className="primary-btn sm" onClick={(e) => { e.stopPropagation(); startTopic(t); }}>写这篇</button>
              </div>
            </article>
          ))}
          {!bankList.length ? <p className="muted ws-empty">没有符合条件的题目——换个筛选，或用「自定义题目」。</p> : null}
        </div>
      </div>
    );
  }

  /* ---------- 写作页 ---------- */
  return (
    <div className="ws">
      <div className="ws-topbar">
        {topicLocked
          ? <span className="ws-chip" title="班级作业期间不能更换题目：批改上报要求题目与教师布置的完全一致">{topic ? topic.label : '班级作业'} · 题目已锁定</span>
          : <button className="ghost-btn sm" onClick={() => { if (saveCurrent()) { onLeaveTopic?.(); setView('bank'); } }}><ArrowLeft size={14} />返回题库</button>}
        <div className="ws-topbar-meta">
          <span className="ws-chip">{topic ? topic.label : ''}</span>
          {stateRef.current.workTitle ? <b className="ws-topbar-zh">{stateRef.current.workTitle}</b> : null}
        </div>
        <span className="muted small ws-saved">{savedText}</span>
      </div>
      {localError ? (
        <div className="error-banner" role="alert"><span className="error-text">{localError}</span>
          <button className="icon-btn err-close" onClick={() => setLocalError('')} aria-label="关闭提示"><X size={15} /></button>
        </div>
      ) : null}
      {savedDrafts.some((item) => writingTopicKey(item.topic) === topicKey && writingDraftFingerprint(item) !== writingDraftFingerprint(baseRef.current)) ? (
        <details className="ws-topic-card ws-draft-copies">
          <summary>此题有其他已保存版本，点击查看（当前文字会先保存）</summary>
          {writingDraftVersions(topicKey).filter((item) => writingDraftFingerprint(item) !== writingDraftFingerprint(baseRef.current)).map((item, i) => (
            <div key={item.writer + ':' + i}>
              <p className="muted small">{new Date(item.savedAt).toLocaleString('zh-CN')} · {item.workTitle}</p>
              <p>{(item.mode === 'guided' ? item.segs.join('\n\n') : item.essay).slice(0, 180)}</p>
              <button className="ghost-btn sm" onClick={() => startTopic(topic, item)}>载入此版本</button>
            </div>
          ))}
        </details>
      ) : null}
      <div className="ws-grid">
        {/* 左栏：题目、配图与阅读材料 */}
        <aside className="ws-side">
          <div className="ws-topic-card">
            <div className="ws-topic-head"><BookOpen size={15} /><h3>作文题目</h3></div>
            <p className="ws-topic-q">{topic ? topic.question : ''}</p>
            <p className="muted small">练习目标：约 {targetWords} 词，具体字数以题干要求为准。</p>
            {topic && topic.image ? (
              <figure className="ws-topic-fig">
                <TopicImage src={topic.image} title={topic.zh || '作文题目'} />
                <figcaption className="muted small">题目配图（图表/图画作文请依据图片内容写作）</figcaption>
              </figure>
            ) : null}
            {topic && topic.imageDesc ? (
              <details className="ws-topic-desc">
                <summary className="muted small">题目配图文字说明</summary>
                <p className="small">{topic.imageDesc}</p>
              </details>
            ) : null}
            {material ? (
              <details className="ws-topic-desc" open>
                <summary className="muted small">写作材料（题目要求的阅读材料）</summary>
                <WritingMaterial text={material} className="small ws-material" />
              </details>
            ) : null}
          </div>
        </aside>
        {/* 右栏：写作区 */}
        <div className="ws-editor">
          <div className="ws-mode-tabs" role="tablist" aria-label="写作方式">
            <button role="tab" aria-selected={mode === 'direct'} className={mode === 'direct' ? 'active' : ''}
              disabled={ocrBusy} onClick={() => switchMode('direct')}>直接开写<i>整篇一气呵成</i></button>
            <button role="tab" aria-selected={mode === 'guided'} className={mode === 'guided' ? 'active' : ''}
              disabled={ocrBusy} onClick={() => switchMode('guided')}>按段带写<i>一段一段写，AI 给思路</i></button>
          </div>
          {mode === 'guided' || briefOpen ? (
            <nav className="ws-seg-tabs" aria-label={mode === 'guided' ? '按段写作' : '段落指导'}>
              {SEG_META.map((s, i) => (
                <span key={s.key} className="ws-seg-wrap">
                  {i > 0 ? <ChevronRight size={13} className="ws-seg-arrow" /> : null}
                  <button className={'ws-seg-tab' + (activeSeg === i ? ' active' : '')}
                    aria-pressed={activeSeg === i} onClick={() => setActiveSeg(i)}>
                    <b>{s.label}</b><span className="muted small">约 {segTargets[i]} 词</span>
                  </button>
                </span>
              ))}
            </nav>
          ) : null}
          <WritingGuide key={topicKey} brief={brief} status={briefState} error={briefErr} open={briefOpen}
            onToggle={() => setBriefOpen((value) => !value)} activeSeg={activeSeg} paragraphLabel={SEG_META[activeSeg].label}
            angle={angle} onGenerate={genBrief} disabled={busy} />
          {mode === 'direct' ? (
            <div className="ws-write-area">
              <textarea
                className="ws-essay"
                aria-label="我的作文"
                value={essay}
                onChange={(e) => { onFirstInput(); setEssay(e.target.value); }}
                placeholder="Start writing your essay here..."
                spellCheck={false}
              />
              <div className="ws-write-foot">
                <span className="ws-count">已写 <b>{wordCount}</b> / 约 {targetWords} 词</span>
                <div className="ws-write-tools">
                  <button className="ghost-btn sm" disabled={ocrBusy} onClick={() => cameraRef.current?.click()}>
                    {ocrBusy ? <LoaderCircle className="spin" size={14} /> : <Camera size={14} />}拍照识别
                  </button>
                  <button className="ghost-btn sm" disabled={ocrBusy} onClick={() => fileRef.current?.click()}>
                    <ImagePlus size={14} />导入图片
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="ws-write-area">
              {!briefOpen || !brief ? <div className="ws-seg-tip">
                {brief?.outline[activeSeg] || <><b>写{SEG_META[activeSeg].label}：</b>{SEG_META[activeSeg].tip}</>}
              </div> : null}
              <textarea
                className="ws-essay"
                aria-label={SEG_META[activeSeg].label}
                value={segs[activeSeg]}
                onChange={(e) => {
                  onFirstInput();
                  const v = e.target.value;
                  setSegs((arr) => arr.map((s, i) => (i === activeSeg ? v : s)));
                }}
                placeholder={'在这里写' + SEG_META[activeSeg].label + '…'}
                spellCheck={false}
              />
              <div className="ws-write-foot">
                <span className="ws-count">本段 <b>{countWords(segs[activeSeg])}</b> / 约 {segTargets[activeSeg]} 词 · 全文 {wordCount} 词</span>
                <div className="ws-write-tools">
                  <button className="ghost-btn sm" disabled={activeSeg === 0} onClick={() => setActiveSeg((i) => Math.max(0, i - 1))}>‹ 上一段</button>
                  <button className="ghost-btn sm" disabled={activeSeg === SEG_META.length - 1} onClick={() => setActiveSeg((i) => Math.min(SEG_META.length - 1, i + 1))}>下一段 ›</button>
                  <button className="ghost-btn sm" disabled={ocrBusy} onClick={() => cameraRef.current?.click()}>
                    {ocrBusy ? <LoaderCircle className="spin" size={14} /> : <Camera size={14} />}拍照识别
                  </button>
                </div>
              </div>
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) runOcr(f); }} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden
            onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) runOcr(f); }} />
        </div>
      </div>
      {saveError ? <p className="error-banner" role="alert">{saveError}</p> : null}
      {/* 吸底动作条：全文词数 + 计时 + 预览 + 提交（手机端随页面滚动置底） */}
      <div className="ws-dock">
        <span className="ws-count ws-dock-count">全文 <b>{wordCount}</b> / 约 {targetWords} 词</span>
        {busy ? (
          <button className="primary-btn big" disabled><LoaderCircle className="spin" size={16} />AI 正在批改，可在历史作业查看…</button>
        ) : (
          <button className="primary-btn big" onClick={submit}><WandSparkles size={16} />提交批改</button>
        )}
        <button className="ghost-btn" onClick={() => setPreviewOpen(true)} disabled={!wordCount}><Eye size={15} />预览全文</button>
        <div className={'timer-box' + (timer.running ? ' running' : '')} title="本次写作用时">
          <Timer size={16} />
          <strong className="timer-display"><ElapsedDisplay timer={timer} /></strong>
          <button className="ghost-btn sm" onClick={toggleTimer}>{timer.running ? '暂停' : (hasElapsed ? '继续' : '计时')}</button>
        </div>
      </div>
      {previewOpen ? (
        <div className="ws-preview-mask" onClick={() => setPreviewOpen(false)}>
          <div className="ws-preview" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="全文预览">
            <div className="ws-preview-head">
              <h3>全文预览（{wordCount} 词）</h3>
              <button className="icon-btn" onClick={() => setPreviewOpen(false)} aria-label="关闭预览"><X size={16} /></button>
            </div>
            {mode === 'direct'
              ? fullText.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)
              : SEG_META.map((s, i) => segs[i] && segs[i].trim() ? (
                <div key={s.key}><p className="muted small">【{s.label}】</p><p>{segs[i]}</p></div>
              ) : null)}
            {!wordCount ? <p className="muted">（还没有内容）</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default WritingStudio;
