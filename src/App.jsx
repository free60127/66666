import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, Camera, CheckCircle2, ChevronDown, ChevronRight, Cloud, Copy, Download, Flame, FolderPlus, History,
  ImagePlus, Library, LoaderCircle, PanelLeftClose, PanelLeftOpen, PenLine, Settings, Sparkles, Star, Timer,
  Upload, UserRound, WandSparkles, X,
} from 'lucide-react';
// mammoth（894 KB 源码）只在"上传 DOCX"这一个功能里用到，
// 改为 handleDocx 内动态 import，避免它被打进首屏主包。
import { createLibrary, ensureLessonIds, findLesson, loadLibraries, mergeLibraries, moveLesson, removeLesson, removeLibrary, renameLesson, renumberLibrary, saveLibraries, upsertLesson } from './lessonLibrary.js'
import { analyze, generateMaterial, getAnalyzeJob, getLessons, getLesson, getMaterialJob, getOcrJob, getStatus, loadSettings, matchLesson, ocr, saveSettings, wakeUp } from './api.js'
import { DEMO_LESSON_18, DEMO_LESSONS } from './demo.js'
import { mergeHistory } from './sync.js'
import { hasMorphology, mergeFavorites, morphologyText, saveFavorites } from './favorites.js'
import { formatDuration } from './format.js';
import { POLL_ANALYZE_MS, POLL_OCR_MS, TIMEOUT_ANALYZE_MS, TIMEOUT_OCR_MS } from './constants.js';
import { loadHistory, loadResultCache, pruneResultCache, safeGet, safeSet, saveHistory, saveResultCache } from './storage.js'
import { useTimer } from './hooks/useTimer.js'
import { submitAndPoll } from './hooks/pollJob.js'
import { useCloudSync } from './hooks/useCloudSync.js'
import { useAccount } from './hooks/useAccount.js'
import { useJobRunner } from './hooks/useJobRunner.js'
import { useModals } from './hooks/useModals.js'
import { useFavorites } from './hooks/useFavorites.js'
import ElapsedDisplay from './components/ElapsedDisplay.jsx';
import { ResultSheet } from './components/ResultSheet/index.jsx';
import { QuizSheet } from './components/ResultSheet/Quiz.jsx';
import Sidebar from './components/Sidebar.jsx';
import FavoritesModal from './components/modals/FavoritesModal.jsx'
import HistoryModal from './components/modals/HistoryModal.jsx'
import LessonEditModal from './components/modals/LessonEditModal.jsx'
const AI_LEVELS = ['小初', '高考英语', '四六级', '考研/专四', '专八'];
const DEFAULT_AI_LEVEL = '四六级';
const LEVEL_KEY = 'bt-polish-level';
// 「考研英语」「专四」已合并为「考研/专四」：本机旧设置里可能还是旧值，读出来先归一化，避免被静默降级成默认等级
const LEVEL_ALIASES = { 考研英语: '考研/专四', 专四: '考研/专四' };
const CONFIDENCE_LABEL = { high: '高置信度', medium: '中置信度', low: '低置信度', none: '未匹配', manual: '手动选择' };

/* ---------- 结果数据归一化（前端兜底）----------
 * 服务端已经清洗过一次；这里再兜一次是因为分享链接与本机缓存里可能存着历史脏数据，
 * 而 ResultSheet 会直接索引 sentences[i].findings / notes[i].word —— 脏元素会让整棵树崩掉。 */
function asObjectArray(value) {
  return (Array.isArray(value) ? value : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
}
function normalizeResult(data) {
  if (!data || typeof data !== 'object') return null;
  const overall = data.overall && typeof data.overall === 'object' && !Array.isArray(data.overall) ? data.overall : {};
  return {
    ...data,
    overall: { ...overall, scoreBreakdown: asObjectArray(overall.scoreBreakdown) },
    sentences: asObjectArray(data.sentences).map((s) => ({
      ...s,
      findings: asObjectArray(s.findings).map((f) => ({
        ...f,
        dimensions: Array.isArray(f.dimensions) ? f.dimensions.filter((x) => typeof x === 'string') : [],
        synonyms: Array.isArray(f.synonyms) ? f.synonyms.filter((x) => x != null) : [],
      })),
    })),
    vocabularyNotes: asObjectArray(data.vocabularyNotes),
    idiomHighlights: asObjectArray(data.idiomHighlights),
  };
}

/* ---------- 拍照 / 图片识别（OCR）前端预处理 ---------- */
// OCR 的三个目标框（中文提示 / 英文初稿 / 英文原文）
const OCR_LABEL = { chinese: '中文提示', english: '英文初稿', original: '英文原文' };

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败，请重试'));
    reader.readAsDataURL(file);
  });
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败（iPhone 的 HEIC 格式请先转成 JPG）'));
    img.src = src;
  });
}

/**
 * 客户端预处理：控制长边分辨率（手写体给更高分辨率）、必要时灰度+提对比，再压成 JPEG。
 * 目标：手写体识别质量更高，同时上传体积可控。
 */
async function prepareImage(file, mode) {
  const raw = await fileToDataUrl(file);
  const img = await loadImageEl(raw);
  const longEdge = Math.max(img.width, img.height) || 1;
  const target = mode === 'handwriting' ? 2400 : 1800;
  const minEdge = 1200; // 小图放大，避免模型看不清笔画
  let scale = 1;
  if (longEdge > target) scale = target / longEdge;
  else if (longEdge < minEdge) scale = Math.min(2.5, minEdge / longEdge);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (mode === 'handwriting') {
    try { ctx.filter = 'grayscale(1) contrast(1.25)'; } catch { /* 部分浏览器不支持 filter，忽略 */ }
  }
  ctx.drawImage(img, 0, 0, w, h);
  let quality = 0.92;
  let out = canvas.toDataURL('image/jpeg', quality);
  while (out.length > 4.2 * 1024 * 1024 && quality > 0.55) {
    quality -= 0.12;
    out = canvas.toDataURL('image/jpeg', quality);
  }
  return out;
}

/* ---------- 计时器：记录一篇课文/一次练习花了多久 ---------- */



function isMarker(line) {
  return /^(标题|中文|中文译文|译文|原稿|初稿|英文初稿|学生译本|AI\s*(润色|修正)|原文|原版|逐句|详细错误|分析)/i.test(line.trim());
}

function isMostlyEnglish(line) {
  const words = (line.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []);
  const letters = words.join('').length;
  const han = (line.match(/[\u4e00-\u9fff]/g) || []).length;
  // 短句也要能识别：至少 2 个英文单词、字母数 >=3，且英文显著多于中文
  return words.length >= 2 && letters >= 3 && letters > han * 2;
}

function parseAssignmentText(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
  if (lines.length < 3) throw new Error('DOCX 内容太少，至少需要标题、中文和英文初稿三部分');
  const title = lines[0];
  const draftStart = lines.findIndex((line, index) => index > 0 && !isMarker(line) && isMostlyEnglish(line));
  if (draftStart < 0) throw new Error('没有识别到英文初稿，请确认 DOCX 中包含英文回译内容');
  const chineseLines = lines.slice(1, draftStart).filter((line) => !isMarker(line));
  const draftLines = [];
  for (const line of lines.slice(draftStart)) {
    if (isMarker(line)) break;
    draftLines.push(line);
  }
  const chinese = chineseLines.join('\n').trim();
  const draft = draftLines.join('\n').trim();
  if (!chinese || !draft) throw new Error('未能同时识别出中文提示和英文初稿');
  return { title, chinese, draft };
}

/**
 * 站名只在这里定义一次。
 *
 * index.html 的 <title> **会被下面的 effect 覆盖** —— 两处各写一份，
 * 就会出现"改了 index.html 却不生效"的怪事（实测踩过：HTML 里改了，浏览器里还是旧的）。
 */
const SITE_NAME = '回译本';
const SITE_TAGLINE = '你的私人英语工坊';

function lessonLabel(lesson) {
  return lesson ? `Lesson ${lesson.lesson} · ${lesson.title_en || lesson.title_cn}` : '';
}

function App() {
  const [settings, setSettings] = useState(loadSettings());
  // closeCamera / materialBusy 声明在后面，用 ref 透传「当前」的那一份（避免 TDZ）
  const closeCameraRef = useRef(null);
  const materialBusyRef = useRef(false);
  const [status, setStatus] = useState(null);
  const [lessons, setLessons] = useState([]);
  const [book, setBook] = useState(() => {
    const b = Number(safeGet('bt-book', ''));
    return [1, 2, 3, 4].includes(b) ? b : 2;
  });
  const [mode, setMode] = useState('lesson');
  const [lessonId, setLessonId] = useState(() => {
    const n = Number(safeGet('bt-lesson', ''));
    return Number.isFinite(n) && n > 0 ? n : 18;
  });
  const [matchedLesson, setMatchedLesson] = useState(null);
  const [title, setTitle] = useState('');
  const [chinese, setChinese] = useState('');
  const [draft, setDraft] = useState('');
  // 生成链路的繁忙/进度/计时（hooks/useJobRunner.js）；变量名沿用原来的，调用点不用改
  const {
    busy, step: progressStep, message: progressMsg, elapsed,
    run: runJob, cancelWait: cancelProgress,
  } = useJobRunner();
  // 「取消等待」：只让界面立刻解锁，**不停后台轮询** ——
  // 生成请求已经发出去了（钱已经花了），停掉轮询等于白花；继续跑完还能进「历史结果」。
  const cancelGenRef = useRef(false);
  const [lessonQuery, setLessonQuery] = useState(''); // 课文搜索（348 课靠翻列表太慢）
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [view, setView] = useState('editor');
  const [materialTopic, setMaterialTopic] = useState('');
  const [materialLevel, setMaterialLevel] = useState('中级');
  const [materialStyle, setMaterialStyle] = useState('生活故事');
  const {
    busy: materialBusy, elapsed: materialElapsed,
    run: runMaterialJob,
  } = useJobRunner();
  materialBusyRef.current = materialBusy;
  const [materialKeywords, setMaterialKeywords] = useState([]);
  const [generatedOriginal, setGeneratedOriginal] = useState('');
  const [matchConfidence, setMatchConfidence] = useState('');
  const [matchScore, setMatchScore] = useState(null);
  const [currentJobId, setCurrentJobId] = useState('');
  const [historyList, setHistoryList] = useState(loadHistory);
  // 收藏夹（本机 localStorage）
  // 全局提示条：编辑器页也能看到（shareTip 只在结果页渲染，
  // 之前把"已保存课文/已新建作业"这类反馈发给了它，等于用户什么都看不到）
  const [toast, setToast] = useState('');
  const [shareTip, setShareTip] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 900) return false;
    return safeGet('bt-sidebar', '') !== 'collapsed';
  });
  const fileRef = useRef(null);
  // 弹窗开关 + 键盘可达性（hooks/useModals.js）；变量名沿用原来的，调用点不用改
  const {
    settingsOpen, setSettingsOpen, materialOpen, setMaterialOpen,
    historyOpen, setHistoryOpen, favOpen, setFavOpen,
    libModalOpen, setLibModalOpen, newJobOpen, setNewJobOpen,
    backupOpen, setBackupOpen, camOpen, setCamOpen,
    lessonEdit, setLessonEdit, backupTip, setBackupTip, libTip, setLibTip,
    modalRefs,
  } = useModals({ getCloseCamera: closeCameraRef, getMaterialBusy: materialBusyRef });
  // 拍照 / 图片识别
  const [ocrBusy, setOcrBusy] = useState(null); // null | 'chinese' | 'english'
  const [ocrMode, setOcrMode] = useState('auto'); // auto | handwriting | printed
  const [ocrNotes, setOcrNotes] = useState({});
  const [dragOver, setDragOver] = useState(null); // null | 'chinese' | 'english'
  const [camSide, setCamSide] = useState('english');
  const [camError, setCamError] = useState('');
  const camVideoRef = useRef(null);
  const camStreamRef = useRef(null);
  const chineseCamRef = useRef(null);
  const chineseFileRef = useRef(null);
  const englishCamRef = useRef(null);
  const englishFileRef = useRef(null);
  const originalCamRef = useRef(null);   // 英文原文（标准答案）框的拍照 / 选图
  const originalFileRef = useRef(null);
  // 计时器（记录一篇课文做了多久）
  // 计时器（hooks/useTimer.js）：切课文自动归零、刷新恢复，细节见该文件里的说明
  // 自建课文库（本机保存）：用户可以把自己的作业存成课文，像内置语料一样反复练
  const [myLibs, setMyLibs] = useState(loadLibraries);
  const [myLibId, setMyLibId] = useState('');            // 当前选中的自建库（空 = 用内置册）
  // 自建课文的 key 用**稳定 id**（lid）而不是序号：序号用户随时会改，
  // 而 key 决定了「同一课的两次练习对比」和计时归属 —— 用序号的话一改就断链。
  const lessonKey = mode !== 'lesson' ? 'free'
    : (myLibId && matchedLesson && matchedLesson.book === 'my' && matchedLesson.lid
      ? `lesson:my-${myLibId}-${matchedLesson.lid}`
      : `lesson:${book}-${lessonId}`);
  const { timer, toggle: toggleTimer, reset: resetTimer, elapsedMsNow, hasElapsed } = useTimer(lessonKey);
  const [libPickId, setLibPickId] = useState('');
  const [newLibName, setNewLibName] = useState('');
  // 「新建回译作业」弹窗：当前作业有内容时先让用户决定要不要存进课文库
  const pendingNewRef = useRef(true);
  // 备份（课文库 + 收藏夹 + 历史）
  const backupFileRef = useRef(null);
  // 云同步（同步码）
  const [backendWaking, setBackendWaking] = useState(false); // 免费托管休眠后正在唤醒（首屏要等约 1 分钟）
  // 账号（可选：服务端配了持久存储才有）。账号只是"帮你记住同步码"的一层，
  // 同步码仍然是数据主键 —— 没有账号时一切照旧，有了账号换设备就不用抄码。
  // 最近一次「载入 / 保存」时的内容指纹：用来判断当前作业有没有改动过，
  // 避免在"打开库里的课文后直接点新建"时让用户重复保存一份完全相同的内容。
  const savedSnapshotRef = useRef('');
  // 自由模式的「英文原文（标准答案）」：填了才能在结果里做原文对照
  const [manualOriginal, setManualOriginal] = useState('');
  const [originalOpen, setOriginalOpen] = useState(false);
  // 润色等级：让润色版与推荐表达匹配用户目标考试的难度
  const [polishLevel, setPolishLevel] = useState(() => {
    const saved = safeGet(LEVEL_KEY, '');
    const level = LEVEL_ALIASES[saved] || saved;
    return AI_LEVELS.includes(level) ? level : DEFAULT_AI_LEVEL;
  });

  const toggleSidebar = useCallback(() => {
    const next = !sidebarOpen;
    safeSet('bt-sidebar', next ? 'open' : 'collapsed');
    setSidebarOpen(next);
  }, [sidebarOpen]);

  // 提示条统一定时器：原来每处各起一个 setTimeout，连续两次操作时先到的 timer
  // 会把后一条提示提前清掉（提示"闪一下就没了"）。这里改成共用一个，写前先取消。
  // 提示条定时器：按 setter 分开记，避免"收藏提示"把"作业提示"的定时器清掉
  const tipTimersRef = useRef(new Map());
  const flashTip = (setter, message, ms = 2600) => {
    setter(message);
    const prev = tipTimersRef.current.get(setter);
    if (prev) clearTimeout(prev);
    tipTimersRef.current.set(setter, setTimeout(() => setter(''), ms));
  };
  // 卸载时清掉所有计时器，并让仍在跑的轮询循环自行退出（否则会在后台一直打接口到超时）
  const aliveRef = useRef(true);
  useEffect(() => () => {
    aliveRef.current = false;
    for (const t of tipTimersRef.current.values()) clearTimeout(t);
    tipTimersRef.current.clear();
  }, []);
  // 生成任务令牌：用户在生成过程中切课 / 点「新建」时作废，
  // 任务完成后就不再强行把视图抢回结果页（结果本身仍然保留并写入历史）。
  const genTokenRef = useRef(0);
  const runGenerateRef = useRef(null);

  /* ---------- 收藏夹 / 复习 / 自测题 ----------
   * 状态与动作都在 hooks/useFavorites.js；变量名沿用原来的，调用点不用改。 */
  const {
    favorites, setFavorites, favQuery, setFavQuery, favKind, setFavKind, favTip, setFavTip,
    favReview, setFavReview, favDueCount, visibleFavorites, favHandlers, favFileRef,
    quizData, quizCount, setQuizCount, quizShowAnswers, setQuizShowAnswers, quizTip, quizBusy,
    removeFavorite, clearFavorites, exportFavorites, importFavorites, copyFavorites,
    startReview, gradeFavReview, skipFavReview, generateQuiz, copyQuiz,
  } = useFavorites({
    flash: (setter, msg, ms) => flashTip(setter, msg, ms),
    setView, settings, polishLevel,
    isOpen: favOpen, // 收藏夹是否打开（决定要不要算筛选结果）
    openFavs: () => setFavOpen(true), closeFavs: () => setFavOpen(false),
  });


  // 手机端侧栏是覆盖层，选中课文后自动收起
  const closeSidebarOnMobile = useCallback(() => {
    if (window.innerWidth <= 900) setSidebarOpen(false);
  }, []);

  const refreshStatus = async () => {
    try { setStatus(await getStatus()); } catch { setStatus(null); }
  };

  // 恢复上次打开的书册/课次；没有记录则默认第一课
  const pickInitialLesson = (list) => {
    const savedBook = Number(safeGet('bt-book', ''));
    const savedLesson = Number(safeGet('bt-lesson', ''));
    const targetBook = [1, 2, 3, 4].includes(savedBook) ? savedBook : 2;
    const match = list.find((l) => l.book === targetBook && l.lesson === savedLesson);
    if (match) return match;
    return list.find((l) => l.book === targetBook) || list[0] || null;
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      // 免费托管（Render）休眠后唤醒要约 1 分钟。必须**先探活再做首屏请求**：
      // 否则 /api/status 与 /api/lessons 会在 15 秒时超时，用户看到的是
      // "服务器出错 + 退回示例课文"，而其实再等 40 秒数据就来了。
      await wakeUp({ onSlow: () => { if (alive) setBackendWaking(true); } });
      if (!alive) return;
      setBackendWaking(false);
      refreshStatus();
      try {
        const data = await getLessons();
        if (!alive) return;
        const loaded = data.lessons || [];
        setLessons(loaded);
        if (loaded.length) {
          const target = pickInitialLesson(loaded);
          selectLesson(target.book, target.lesson);
        }
      } catch {
        // 后端彻底不可用才退回示例课文（保留原有的降级行为）
        if (!alive) return;
        const fallback = DEMO_LESSONS.map((l) => ({ ...l, book: 2 }));
        setLessons(fallback);
        const target = pickInitialLesson(fallback) || { book: 2, lesson: 18 };
        selectLesson(target.book, target.lesson);
      }
    })();
    return () => { alive = false; };
    // 刻意只在挂载时跑一次：selectLesson 每次渲染都是新函数，放进来会变成每次渲染都重新拉课表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 通过分享链接 #job=xxx 打开时，直接恢复该次生成结果（即使后端重启过，任务已持久化）
  useEffect(() => {
    const m = window.location.hash.match(/^#job=([A-Za-z0-9-]{8,64})/);
    if (!m) return;
    const jobId = m[1];
    getAnalyzeJob(jobId).then((r) => {
      if (!aliveRef.current) return;
      if (r.job?.status === 'done' && r.job.data) {
        setResult(normalizeResult(r.job.data)); // 归一化：坏数据不再让页面白屏，F5 也不会循环崩
        setCurrentJobId(jobId);
        setView('result');
        setError('');
      } else if (r.job?.status === 'error') {
        setError(r.job.error || '该任务生成失败');
      } else {
        setError('该结果仍在生成中，请稍后刷新查看');
      }
    }).catch(() => {
      if (!aliveRef.current) return;
      // 服务端已经查不到这条任务时，用本机缓存恢复（分享者本人 / 同一台设备还留着结果）
      const cached = loadResultCache(jobId);
      if (cached) {
        setResult(normalizeResult(cached));
        setCurrentJobId(jobId);
        setView('result');
        setError('');
      } else {
        // 服务端只认它自己留着的记录（默认保留期见 /api/status 的 jobs.ttlDays）。
        // 链接打不开时要给出可操作的下一步，而不是一句"不存在"。
        setError('这条分享链接打不开了：服务端已经没有这次批改的记录（链接被改动过，或结果已超出保留期）。'
          + '请让分享者重新「复制分享链接」发一次；想长期留存，用结果页的「导出 PDF」另存一份最稳妥。');
      }
    });
  }, []);

  // 页面标题跟随当前作业：导出 PDF / 另存网页时文件名才有意义（原来是恒定标题）
  useEffect(() => {
    if (view === 'result' && result?.title) document.title = result.title + ' · ' + SITE_NAME;
    else if (view === 'quiz') document.title = '自测题 · ' + SITE_NAME;
    else document.title = SITE_NAME + ' · ' + SITE_TAGLINE;
  }, [view, result?.title]);

  const activeLib = useMemo(() => myLibs.find((l) => l.id === myLibId) || null, [myLibs, myLibId]);
  /**
   * 有没有可用的 AI Key：**服务端配了，或者用户自己填了**。
   *
   * 这个判断必须全项目只有一处 —— 之前状态栏用「服务端 || 自己填」、
   * 而新加的引导块只看「服务端」，于是本地填了 Key 的用户会看到
   * 「上面说已配置、下面说还差一步」的自相矛盾。
   */
  const hasAiKey = Boolean(status?.hasKey || settings.apiKey);

  /**
   * 课文搜索：课号、中英标题、关键词都能命中。
   * 一册就 96 课（全书 348 课），靠翻列表找「Lesson 47」或「那篇讲春节的」都很痛苦。
   * 纯数字按课号优先 —— 输入 47 应该直接命中 Lesson 47，而不是标题里恰好含 47 的那几篇。
   */
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

  // 本次作业的「英文原文（标准答案）」优先级：
  // 用户手填 > AI 素材生成的原文 > 自建库课文自带的原文。
  // 内置册留空，交给服务端按 book/lessonId 去语料里取（行为不变）。
  const currentOriginal = manualOriginal.trim()
    || generatedOriginal
    || (myLibId ? (matchedLesson?.english || '') : '');

  // 请求令牌：连点两课时，先发的慢请求若后返回，会把标题/中文覆盖成上一课的内容
  // （表现为侧栏高亮第 5 课、编辑区却是第 3 课）。挂载时的自动选课也会"迟到覆盖"用户的手动选择。
  const lessonReqRef = useRef(0);
  const selectLesson = useCallback(async (nextBook, nextLesson, autoGenerate = false) => {
    const reqId = (lessonReqRef.current += 1);
    genTokenRef.current += 1; // 切课即作废正在跑的生成任务，避免它完成时抢回结果页
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
  }, []);

  const handleBookChange = useCallback((nextBook) => {
    setMyLibId(''); // 切回内置册
    const first = lessons.find((l) => l.book === nextBook);
    if (first) selectLesson(nextBook, first.lesson);
    else setBook(nextBook);
  }, [lessons, selectLesson]);

  /** 选中自建库（只切换侧栏列表，不改变当前作业）。 */
  const selectMyLib = useCallback((libId) => {
    setMyLibId(libId);
    setError('');
    const lib = myLibs.find((l) => l.id === libId);
    if (lib && !lib.lessons.length) flashTip(setToast, `「${lib.name}」还是空的：把当前作业存进去就能在这里选出来练习`, 4500);
  }, [myLibs]);

  /** 从自建库载入一节课（本地数据，不发请求）。 */
  const selectMyLesson = useCallback((libId, lessonNo) => {
    const lib = myLibs.find((x) => x.id === libId);
    const lesson = lib?.lessons.find((l) => l.lesson === Number(lessonNo));
    if (!lesson) return;
    lessonReqRef.current += 1; // 作废仍在飞的内置课文请求，避免它回来覆盖
    genTokenRef.current += 1;
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
    savedSnapshotRef.current = fingerprintOf(lesson.title_cn || lessonLabel(lesson), lesson.chinese || '', '', lesson.english || '');
  }, [myLibs]);

  /* ---------- 自建课文库：新建 / 保存 ---------- */
  const openLibModal = useCallback(() => {
    setLibPickId(myLibs[0]?.id || '');
    setNewLibName('');
    setLibTip('');
    setLibModalOpen(true);
  }, [myLibs, setLibTip, setLibModalOpen]);

  const openNewJobModal = () => {
    setLibPickId(myLibs[0]?.id || '');
    setNewLibName('');
    setLibTip('');
    setNewJobOpen(true);
  };

  /**
   * 把当前作业写进课文库（含"输入新库名即新建"）。
   * 保存成功返回 true；失败时把原因写进 libTip 并返回 false。
   */
  const persistToLibrary = () => {
    const name = newLibName.trim();
    let list = myLibs;
    let targetId = libPickId;
    if (name) {
      const dup = myLibs.find((l) => l.name === name);
      if (dup) targetId = dup.id;
      else {
        const created = createLibrary(myLibs, name);
        list = created;
        targetId = created[created.length - 1].id;
      }
    }
    if (!targetId) { setLibTip('请先选择或输入一个课文库名称'); return false; }
    const entry = {
      title_cn: title.trim() || chinese.trim().slice(0, 12) || '未命名作业',
      chinese: chinese.trim(),
      english: currentOriginal.trim(),
    };
    if (!entry.chinese) { setLibTip('中文提示还是空的：至少要有中文提示才能存成课文'); return false; }
    const { list: next, replaced } = upsertLesson(list, targetId, entry);
    setMyLibs(next);
    if (!saveLibraries(next)) { setLibTip('写入本机存储失败（空间可能已满），请先清理浏览器数据'); return false; }
    setMyLibId(targetId);
    savedSnapshotRef.current = fingerprintOf(title, chinese, draft, manualOriginal);
    flashTip(setToast, (replaced ? '已更新课文：' : '已保存课文：') + entry.title_cn
      + (entry.english ? '' : '（没填英文原文，练习时无法做原文对照）'), 4200);
    return true;
  };

  const saveToLibrary = () => {
    if (persistToLibrary()) setLibModalOpen(false);
  };

  const hasJobContent = () => Boolean(title.trim() || chinese.trim() || draft.trim() || manualOriginal.trim());
  const fingerprintOf = (t, c, d, o) => [t, c, d, o].map((s) => String(s || '').trim()).join('\u0001');
  const jobFingerprint = fingerprintOf(title, chinese, draft, manualOriginal);
  const jobDirty = jobFingerprint !== savedSnapshotRef.current;

  /** 真正开一份空白作业（调用前请先处理"当前作业要不要保存"）。 */
  const doStartNewJob = (closeSidebar) => {
    genTokenRef.current += 1;
    if (closeSidebar) closeSidebarOnMobile();
    setView('editor');
    setResult(null);
    setTitle('');
    setChinese('');
    setDraft('');
    setFileName('');
    setGeneratedOriginal('');
    setManualOriginal('');
    setMaterialKeywords([]);
    setMatchedLesson(null);
    setMatchConfidence('');
    setMatchScore(null);
    setError('');
    setOcrNotes({});
    setMode('free');       // 全新作业默认自由模式
    setMyLibId('');
    setOriginalOpen(true); // 展开原文栏，引导先填标准答案
    savedSnapshotRef.current = fingerprintOf('', '', '', '');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    flashTip(setToast, '已新建一份空白作业', 3000);
  };

  /**
   * 侧栏「新建回译作业」。
   * 注意语义：这是"新开一份作业"，不是"清空当前作业"——
   * 当前作业还有内容时会先弹窗，让用户选择存进课文库再新建，而不是直接销毁。
   */
  // 这三个内部函数每次渲染都会重建；直接写进依赖会让 startNewJob 每次都变、
  // 进而让 React.memo 过的侧栏每次 state 变化都重渲染（memo 就白加了）。
  // 用 ref 取"当下"的那一份：语义不变，依赖收敛成 []。
  const hasJobContentRef = useRef(hasJobContent);
  const doStartNewJobRef = useRef(doStartNewJob);
  const openNewJobModalRef = useRef(openNewJobModal);
  hasJobContentRef.current = hasJobContent;
  doStartNewJobRef.current = doStartNewJob;
  openNewJobModalRef.current = openNewJobModal;
  // 传给 React.memo 过的侧栏：必须用 useCallback 固定住，否则每次 state 变化它都会重渲染
  // 传给 React.memo 过的弹窗/结果页的回调与 ref：必须稳定，否则 memo 形同虚设
  // 结果页「返回编辑」：只切视图，**保留结果与 #job=**（用户还要回来对照/分享）
  // 顶栏「编辑器」（backToEditor）才是清空结果的那个 —— 两者语义不同，别接错。
  const backToEditorView = useCallback(() => setView('editor'), []);
  const favModalRef = useCallback((el) => { modalRefs.current.fav = el; }, [modalRefs]);
  const historyModalRef = useCallback((el) => { modalRefs.current.history = el; }, [modalRefs]);
  const lessonEditModalRef = useCallback((el) => { modalRefs.current.lessonEdit = el; }, [modalRefs]);
  const closeFavorites = useCallback(() => { setFavOpen(false); setFavReview(null); }, [setFavOpen, setFavReview]);
  const closeHistory = useCallback(() => setHistoryOpen(false), [setHistoryOpen]);
  const closeLessonEdit = useCallback(() => setLessonEdit(null), [setLessonEdit]);

  const openSettings = useCallback(() => setSettingsOpen(true), [setSettingsOpen]);
  const openBackup = useCallback(() => { setBackupTip(''); setBackupOpen(true); }, [setBackupTip, setBackupOpen]);

  const startNewJob = useCallback((closeSidebar = true) => {
    if (!hasJobContentRef.current()) { doStartNewJobRef.current(closeSidebar); return; }
    pendingNewRef.current = closeSidebar;
    openNewJobModalRef.current();
  }, []);

  /** 弹窗里选「保存并新建」。 */
  const saveAndStartNew = () => {
    if (!persistToLibrary()) return;
    setNewJobOpen(false);
    doStartNewJob(pendingNewRef.current !== false);
  };

  /** 弹窗里选「不保存，直接新建」。 */
  const discardAndStartNew = () => {
    setNewJobOpen(false);
    doStartNewJob(pendingNewRef.current !== false);
  };

  /** 顶栏「编辑器」：只切回编辑视图，不动任何内容（只清 #job= 免得刷新跳回结果页）。 */
  const backToEditor = useCallback(() => {
    setView('editor');
    setResult(null);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  /* ---------- 备份：课文库 + 收藏夹 + 历史 ---------- */
  const libraryLessonCount = myLibs.reduce((n, lib) => n + lib.lessons.length, 0);
  const backupSummary = `${myLibs.length} 个课文库（${libraryLessonCount} 篇课文） · ${favorites.length} 条收藏 · ${historyList.length} 条历史`;

  const exportBackup = () => {
    const payload = {
      app: 'back-translate-studio',
      version: 1,
      exportedAt: new Date().toISOString(),
      libraries: myLibs,
      favorites,
      history: historyList,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'retranslate-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setBackupTip('已导出：' + backupSummary + '。换设备或清了浏览器数据后，用这个文件就能恢复。');
  };

  const importBackup = async (file) => {
    if (!file) return;
    setBackupTip('');
    try {
      const data = JSON.parse(await file.text());
      const libs = Array.isArray(data?.libraries) ? data.libraries : [];
      const favs = Array.isArray(data?.favorites) ? data.favorites : [];
      const hist = Array.isArray(data?.history) ? data.history : [];
      if (!libs.length && !favs.length && !hist.length) throw new Error('文件里没有可导入的数据');

      // 导入进来的课文可能来自"还没有稳定 id"的旧备份 —— 写入前统一补上，
      // 否则这些课文的「编辑 / 改序号」会因为找不到条目而毫无反应（实测踩过）
      const { list: mergedLibs, libsAdded, lessonsAdded } = mergeLibraries(myLibs, libs);
      const { list: nextLibs } = ensureLessonIds(mergedLibs);
      if (libsAdded || lessonsAdded) { setMyLibs(nextLibs); saveLibraries(nextLibs); }

      let favAdded = 0;
      if (favs.length) {
        const { merged, added } = mergeFavorites(favs, favorites);
        favAdded = added;
        if (added) { setFavorites(merged); saveFavorites(merged); }
      }

      // 历史合并与云同步共用同一套逻辑（按 jobId 去重、按时间倒序、只留 20 条）
      const mergedHistory = mergeHistory(historyList, hist);
      const histAdded = Math.max(0, mergedHistory.length - historyList.length);
      if (histAdded) { setHistoryList(mergedHistory); saveHistory(mergedHistory); }

      setBackupTip(`导入完成：新增 ${libsAdded} 个课文库、${lessonsAdded} 篇课文、${favAdded} 条收藏、${histAdded} 条历史（同名课文自动去重）。`);
    } catch (e) {
      setBackupTip('导入失败：' + (e.message || '文件格式不正确'));
    }
  };

  // 老数据迁移：给还没有稳定 id（lid）的自建课文补上并落盘。
  // 必须落盘，而不是"每次读的时候临时生成" —— 临时 id 每次都会变，练习记录就对不上了。
  useEffect(() => {
    const { list, changed } = ensureLessonIds(myLibs);
    if (!changed) return;
    setMyLibs(list);
    saveLibraries(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 把同步合并回来的快照写回本机；只有真的变了才 setState（避免触发自动推送形成回环）。 */
  const applyMergedSnapshot = (merged) => {
    let changed = false;
    // 云端数据可能来自旧版本（没有 lid）—— 落盘前补齐，否则编辑/改序号会失灵
    const mergedLibs = ensureLessonIds(merged.libraries).list;
    if (JSON.stringify(myLibs) !== JSON.stringify(mergedLibs)) { setMyLibs(mergedLibs); saveLibraries(mergedLibs); changed = true; }
    if (JSON.stringify(favorites) !== JSON.stringify(merged.favorites)) { setFavorites(merged.favorites); saveFavorites(merged.favorites); changed = true; }
    if (JSON.stringify(historyList) !== JSON.stringify(merged.history)) { setHistoryList(merged.history); saveHistory(merged.history); changed = true; }
    return changed;
  };

  /* ---------- 云同步（同步码）----------
   * 状态机在 hooks/useCloudSync.js；这里只提供"本机数据 + 合并写回 + 提示"三件事，
   * 变量名沿用原来的，所以下面所有调用点都不用改。 */
  const {
    syncCode, setSyncCode, syncMeta, syncBusy, syncTip,
    codeInput, setCodeInput, syncLost, setSyncLost,
    runSync, startNewSync, useExistingCode, copySyncCode, stopSync,
  } = useCloudSync({
    local: { libraries: myLibs, favorites, history: historyList },
    applyMerged: applyMergedSnapshot,
    flash: (msg, ms) => flashTip(setToast, msg, ms),
  });

  /* ---------- 账号 ----------
   * 状态与动作都在 hooks/useAccount.js；变量名沿用原来的，调用点不用改。 */
  const {
    account, accountsOn, authOpen, setAuthOpen, authMode, authBusy, authTip, authForm, bindPw, setBindPw,
    authField, openAuth, doSignIn, doSignUp, doForgot, doReset, doSignOut, doSignOutEverywhere, doBindSync,
  } = useAccount({
    syncCode, setSyncCode, setSyncLost, runSync,
    flash: (msg, ms) => flashTip(setToast, msg, ms),
  });

  const deleteLibrary = useCallback((libId, libName) => {
    if (!window.confirm(`删除课文库「${libName}」？库里的课文会一起删掉，此操作不可撤销。`)) return;
    const next = removeLibrary(myLibs, libId);
    setMyLibs(next);
    saveLibraries(next);
    if (myLibId === libId) setMyLibId('');
    flashTip(setToast, '已删除课文库「' + libName + '」', 3000);
  }, [myLibs, myLibId]);

  const deleteMyLesson = useCallback((libId, lessonOrNo, label) => {
    if (!window.confirm(`从课文库删除「${label}」？

（其它课的序号不会自动变；想补齐空档点「我的课文库」旁的「重排序号」）`)) return;
    // 传进来的可能是"整个课文对象"（侧栏/弹窗），也可能是序号或 lid：
    // 没有稳定 id 的老数据要退回用序号，否则 Number(对象) = NaN，删除会静默失效
    const target = (lessonOrNo && typeof lessonOrNo === 'object')
      ? (lessonOrNo.lid || lessonOrNo.lesson)
      : lessonOrNo;
    const next = removeLesson(myLibs, libId, target);
    setMyLibs(next);
    saveLibraries(next);
    flashTip(setToast, '已删除课文「' + label + '」', 3000);
  }, [myLibs]);

  /** 打开「编辑课文」弹窗（改标题 / 改序号） */
  const openLessonEdit = useCallback((libId, lesson) => {
    if (!lesson) return;
    // 同时记住序号：万一这条数据还没有稳定 id（导入/同步进来的旧数据），
    // 也能按序号定位到它 —— 不能让"点编辑没反应"这种事再发生
    setLessonEdit({ libId, lid: lesson.lid || '', lesson: lesson.lesson });
  }, [setLessonEdit]);

  /** 按 { libId, lid, lesson } 找到要编辑的那节课（lid 优先，退回序号） */
  const resolveEditLesson = (target) => {
    if (!target) return null;
    const lib = myLibs.find((x) => x.id === target.libId);
    return findLesson(lib, target.lid) || findLesson(lib, target.lesson);
  };

  /** 保存编辑：先改标题，再按需挪序号；两件事落在同一份新列表上。 */
  const saveLessonEdit = ({ title_cn, title_en, lesson: targetNo }) => {
    const cur = lessonEdit;
    if (!cur) return;
    const before = resolveEditLesson(cur);
    if (!before) { setLessonEdit(null); return; }
    // 老数据（没有稳定 id）在这里补一个：这一次编辑之后它就固定下来了
    const withIds = ensureLessonIds(myLibs).list;
    const lid = before.lid || (findLesson(withIds.find((x) => x.id === cur.libId), before.lesson) || {}).lid;
    if (!lid) { setLessonEdit(null); return; }
    let next = renameLesson(withIds, cur.libId, lid, { title_cn, title_en });
    const wantNo = Math.round(Number(targetNo) || before.lesson);
    if (wantNo !== before.lesson) next = moveLesson(next, cur.libId, lid, wantNo);
    const after = findLesson(next.find((x) => x.id === cur.libId), lid);
    setMyLibs(next);
    if (!saveLibraries(next)) { flashTip(setToast, '写入本机存储失败（空间可能已满）', 4000); return; }
    // 正在练这一课：标题/序号同步刷新，免得编辑器里还显示旧标题
    if (myLibId === cur.libId && matchedLesson && (matchedLesson.lid === lid || matchedLesson.lesson === before.lesson)) {
      setMatchedLesson(after);
      setLessonId(after.lesson);
      if (title_cn && title_cn !== before.title_cn) setTitle(title_cn);
    }
    setLessonEdit(null);
    const moved = after && after.lesson !== before.lesson;
    flashTip(setToast, '已保存：' + ((after && after.title_cn) || title_cn)
      + (moved ? `（挪到第 ${after.lesson} 课，其余顺移）` : ''), 3600);
  };

  /** 一键把序号补齐成 1、2、3…（补上删课留下的空档） */
  const renumberMyLib = useCallback((libId) => {
    const lib = myLibs.find((x) => x.id === libId);
    if (!lib || !lib.lessons.length) return;
    const next = renumberLibrary(myLibs, libId);
    setMyLibs(next);
    saveLibraries(next);
    const after = next.find((x) => x.id === libId);
    if (myLibId === libId && matchedLesson && matchedLesson.lid) {
      const fresh = findLesson(after, matchedLesson.lid);
      if (fresh) { setMatchedLesson(fresh); setLessonId(fresh.lesson); }
    }
    flashTip(setToast, `已重排序号：${after.lessons.length} 节课现在是 1…${after.lessons.length}`, 3200);
  }, [myLibs, myLibId, matchedLesson]);

  const handleDocx = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setParsing(true);
    try {
      const mammoth = (await import('mammoth/mammoth.browser.js')).default;
      const raw = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      const parsed = parseAssignmentText(raw.value);
      setFileName(file.name);
      setTitle(parsed.title);
      setChinese(parsed.chinese);
      setDraft(parsed.draft);
      setGeneratedOriginal('');
      setManualOriginal(''); // 新作业：先清掉上一份的原文，等课文匹配结果出来再填
      setMaterialKeywords([]);
      const found = await matchLesson({ title: parsed.title, chinese: parsed.chinese });
      if (found?.match && found.confidence && found.confidence !== 'none' && found.confidence !== 'low') {
        setBook(found.match.book);
        setLessonId(found.match.lesson);
        setMatchedLesson(found.match);
        setMode('lesson');
        setTitle(lessonLabel(found.match));
        setManualOriginal(found.match.english || ''); // DOCX 命中课文后，原文也填进「英文原文」栏
        setMatchConfidence(found.confidence);
        setMatchScore(found.score);
        try {
          localStorage.setItem('bt-book', String(found.match.book));
          localStorage.setItem('bt-lesson', String(found.match.lesson));
        } catch { /* ignore */ }
      } else if (found?.match) {
        // 低置信度：默认先用自由模式，但把候选课文展示出来，用户可一键切换
        setBook(found.match.book);
        setLessonId(found.match.lesson);
        setMatchedLesson(found.match);
        setMode('free');
        setMatchConfidence(found.confidence || 'low');
        setMatchScore(found.score);
      } else {
        setMatchedLesson(null);
        setMode('free');
        setMatchConfidence('none');
        setMatchScore(null);
      }
    } catch (e) {
      setFileName('');
      setError(e.message || 'DOCX 读取失败');
    } finally {
      setParsing(false);
    }
  };

  const applyMatchedLesson = () => {
    if (!matchedLesson) return;
    setMode('lesson');
    setTitle(lessonLabel(matchedLesson));
    setManualOriginal(matchedLesson.english || ''); // 把这一课的英文原文带进「英文原文」栏
    setMatchConfidence('manual');
    setMatchScore(null);
    safeSet('bt-book', String(matchedLesson.book));
    safeSet('bt-lesson', String(matchedLesson.lesson));
  };

  const handleGenerateMaterial = async () => {
    const topic = materialTopic.trim();
    if (!topic) { setError('请填写素材主题'); return; }
    setError('');
    try {
      await runMaterialJob({
        submit: () => generateMaterial({
          topic, level: materialLevel, style: materialStyle,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
        }),
        fetchJob: getMaterialJob,
        intervalMs: POLL_ANALYZE_MS,
        timeoutMs: TIMEOUT_ANALYZE_MS,
        maxFailures: 10,
        netError: '网络不稳定，暂时无法获取素材，请重试',
        timeoutError: '生成素材超时（超过10分钟），请重新提交',
        onData: (data) => {
          const d = data || {};
          if (!d.original || !d.chinese) throw new Error('AI 返回内容不完整，请重试');
          setTitle(d.title || topic);
          setChinese(d.chinese);
          setDraft('');
          setGeneratedOriginal(d.original);
          // AI 素材的原文也要填进「英文原文」输入框，否则用户只看到空框
          // （之前只写进 generatedOriginal，折叠栏显示"已自动带入 N 词"但框里是空的）
          setManualOriginal(d.original || '');
          setMaterialKeywords(d.keywords || []);
          setMatchedLesson(null);
          setMode('free');
          setMatchConfidence('none');
          setMatchScore(null);
          setMaterialOpen(false);
        },
      });
    } catch (e) {
      setError(e.message || '素材生成失败');
    }
  };

  const addToHistory = (jobId, jobTitle, data, durationMs) => {
    saveResultCache(jobId, data);
    // lessonKey 一起进历史：结果页要靠它认出"上一次练的是同一课"（老记录没有，靠标题兜底）
    const entry = { jobId, title: jobTitle || '回译作业', time: Date.now(), durationMs: Number(durationMs) || 0, lessonKey: String((data && data.lessonKey) || '') };
    const next = [entry, ...historyList.filter((x) => x.jobId !== jobId)].slice(0, 20);
    saveHistory(next);
    pruneResultCache(next.map((x) => x.jobId)); // 结果缓存跟随历史条数淘汰，否则无限增长写满 5MB 配额
    setHistoryList(next);
  };

  const openHistoryModal = () => {
    setHistoryList(loadHistory());
    setHistoryOpen(true);
  };

  // 连点两条历史时，先发的慢请求后返回会把后点的那条覆盖掉 —— 用请求令牌丢弃过期结果
  const historyReqRef = useRef(0);
  const loadHistoryJob = async (jobId) => {
    const reqId = (historyReqRef.current += 1);
    genTokenRef.current += 1; // 打开历史结果时作废掉正在跑的生成任务，避免它稍后抢回视图
    // 优先用本机缓存，秒开且不受服务器任务清理影响
    const cached = loadResultCache(jobId);
    if (cached) {
      setHistoryOpen(false);
      setResult(normalizeResult(cached));
      setCurrentJobId(jobId);
      setView('result');
      setError('');
      window.history.replaceState(null, '', '#job=' + jobId);
      return;
    }
    try {
      const r = await getAnalyzeJob(jobId);
      if (reqId !== historyReqRef.current) return;
      const job = r.job;
      setHistoryOpen(false);
      if (job?.status === 'done' && job.data) {
        setResult(normalizeResult(job.data));
        setCurrentJobId(jobId);
        setView('result');
        setError('');
        window.history.replaceState(null, '', '#job=' + jobId);
      } else if (job?.status === 'error') {
        setError(job.error || '该任务生成失败');
      } else {
        setError('该结果仍在生成中或已超时，请稍后再试');
      }
    } catch (e) {
      if (reqId !== historyReqRef.current) return;
      setHistoryOpen(false);
      // 服务器任务已过期/重新部署丢失时，尝试用本机缓存的结果兜底
      const fallback = loadResultCache(jobId);
      if (fallback) {
        setResult(normalizeResult(fallback));
        setCurrentJobId(jobId);
        setView('result');
        setError('');
        window.history.replaceState(null, '', '#job=' + jobId);
      } else {
        setError(e.message || '无法读取该结果');
      }
    }
  };

  const shareResult = async () => {
    if (!currentJobId) { flashTip(setShareTip, '当前是离线示例，没有可分享的结果链接', 4000); return; }
    const url = window.location.origin + window.location.pathname + '#job=' + currentJobId;
    try {
      await navigator.clipboard.writeText(url);
      setError('');
      flashTip(setShareTip, '分享链接已复制，可发给老师或同学', 4000);
    } catch {
      setShareTip('复制失败，请手动复制链接：' + url);
    }
  };

  /* ---------- 拍照 / 图片识别 ---------- */
  const handleOcrFiles = async (side, files) => {
    const list = Array.from(files || []).filter((f) => f && /^image\//i.test(f.type || ''));
    if (!list.length) { setError('请选择图片文件（JPG / PNG / WEBP 等）'); return; }
    if (ocrBusy) return;
    // 三个目标框共用一条识别链路：服务端只认 chinese / english 两种语言，
    // 「英文原文」框用 english 识别、但结果落到 manualOriginal。
    const target = side === 'chinese'
      ? { lang: 'chinese', apply: setChinese, done: '已填入中文提示' }
      : side === 'original'
        ? { lang: 'english', apply: setManualOriginal, done: '已追加到英文原文' }
        : { lang: 'english', apply: setDraft, done: '已追加到英文初稿' };
    setError('');
    setOcrBusy(side);
    setOcrNotes((n) => ({ ...n, [side]: '正在准备图片…' }));
    try {
      const texts = [];
      for (let i = 0; i < list.length; i += 1) {
        setOcrNotes((n) => ({ ...n, [side]: `正在识别第 ${i + 1}/${list.length} 张…（约 5-30 秒）` }));
        const image = await prepareImage(list[i], ocrMode);
        const outcome = await submitAndPoll({
          submit: () => ocr({
            image, side: target.lang, mode: ocrMode,
            baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
            visionModel: settings.visionModel,
          }),
          fetchJob: getOcrJob,
          intervalMs: POLL_OCR_MS,
          timeoutMs: TIMEOUT_OCR_MS,
          maxFailures: 8,
          netError: '网络不稳定，暂时无法获取识别结果，请重试',
          timeoutError: '识别超时（超过 3 分钟），请换更清晰的照片或重新拍一张',
          isAlive: () => aliveRef.current,
        });
        if (outcome.aborted) return;
        const text = (outcome.data && outcome.data.text) || '';
        if (!text) throw new Error('识别超时（超过 3 分钟），请换更清晰的照片或重新拍一张');
        texts.push(text);
      }
      const merged = texts.join('\n\n');
      target.apply((prev) => (prev && prev.trim() ? prev.replace(/\s+$/, '') + '\n\n' + merged : merged));
      setOcrNotes((n) => ({ ...n, [side]: `识别完成：${merged.length} 字，${target.done}，请核对后再生成` }));
    } catch (e) {
      setOcrNotes((n) => ({ ...n, [side]: '识别失败：' + (e.message || '未知错误') }));
    } finally {
      setOcrBusy(null);
    }
  };

  const openCamera = async (side) => {
    setCamError('');
    const fallbackInput = side === 'chinese' ? chineseCamRef.current : side === 'original' ? originalCamRef.current : englishCamRef.current;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fallbackInput?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      // 先停掉上一次的流：否则第二次 getUserMedia 之后旧轨道泄漏，摄像头指示灯一直不灭
      try { camStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      camStreamRef.current = stream;
      setCamSide(side);
      setCamOpen(true);
    } catch (e) {
      setError('无法打开摄像头（' + (e.message || '权限被拒绝') + '），已打开系统选择器：可拍照或从相册选择');
      fallbackInput?.click();
    }
  };

  const closeCamera = () => {
    try { camStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    camStreamRef.current = null;
    setCamOpen(false);
    setCamError('');
  };
  closeCameraRef.current = closeCamera; // 供 useModals 在 Esc 关闭时调用

  const snapPhoto = async () => {
    const video = camVideoRef.current;
    if (!video || !video.videoWidth) { setCamError('相机画面尚未就绪，请稍候再点拍照'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) { setCamError('拍照失败，请重试'); return; }
    const file = new File([blob], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg' });
    const side = camSide;
    closeCamera();
    await handleOcrFiles(side, [file]);
  };

  // 桌面端：防止图片被拖到页面空白处时浏览器直接打开图片；同时负责组件卸载时关掉摄像头
  useEffect(() => {
    const prevent = (e) => { e.preventDefault(); };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
      try { camStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    };
  }, []);

  // 摄像头弹窗打开后再绑定视频流（保证 <video> 已挂载）
  useEffect(() => {
    if (!camOpen) return;
    const v = camVideoRef.current;
    if (v && camStreamRef.current) {
      v.srcObject = camStreamRef.current;
      v.play().catch(() => {});
    }
  }, [camOpen]);

  const runGenerate = async (overrideLessonId) => {
    const id = overrideLessonId ?? lessonId;
    const cn = chinese.trim();
    const df = draft.trim();
    if (!cn) { setError('请先上传包含中文提示的 DOCX，或填入中文提示'); return; }
    if (!df) { setError('请先上传包含英文初稿的 DOCX，或填入英文初稿'); return; }
    setError('');
    cancelGenRef.current = false; // 新的生成开始，清掉上一次的取消标记
    const myToken = (genTokenRef.current += 1);
    // 点击生成时定格用时（本次练习从开始计时到提交用掉的时长）
    const durationMs = elapsedMsNow(); // 定格「从开始计时到提交」的用时（不算等 AI 的时间）
    let jobId = '';
    try {
      await runJob({
        submit: () => analyze({
          title: title.trim(), chinese: cn, draft: df,
          book: mode === 'lesson' && !myLibId ? book : undefined,
          lessonId: mode === 'lesson' && !myLibId ? id : undefined,
          original: currentOriginal || undefined,
          level: polishLevel,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
        }),
        fetchJob: getAnalyzeJob,
        intervalMs: POLL_ANALYZE_MS,
        timeoutMs: TIMEOUT_ANALYZE_MS,
        maxFailures: 10,
        netError: '网络不稳定，暂时无法获取生成结果，请重试',
        timeoutError: '生成超时（超过10分钟），请重新提交',
        texts: { submit: '正在提交后台任务…', running: 'AI 正在后台生成（约1-2分钟）…', done: '生成完成' },
        onJobId: (id2) => { jobId = id2; },
        onData: (data) => {
          // attemptTime：这次练习的时间戳。结果页要靠它判断"哪次才算上一次"
          // （从历史里点开旧作业时，比它更晚的练习不能算"上次"）。
          const enriched = { ...(data || {}), durationMs, lessonKey, attemptTime: Date.now() };
          setResult(normalizeResult(enriched));
          if (jobId) setCurrentJobId(jobId);
          // 三种情况都不抢视图：生成期间用户切过课 / 点过「新建」/ 点过「取消等待」。
          // 但结果照常入历史 —— 用户随时能从「历史结果」里打开。
          const cancelled = cancelGenRef.current;
          if (!cancelled && myToken === genTokenRef.current) setView('result');
          if (jobId) {
            addToHistory(jobId, (data && data.title) || title, enriched, durationMs);
            window.history.replaceState(null, '', '#job=' + jobId);
          }
          if (cancelled) flashTip(setToast, '刚才那篇已经生成好，存进「历史结果」了', 6000);
        },
      });
    } catch (e) {
      setError(e.message);
      setView('editor');
    }
  };

  // 供 selectLesson 顺带触发生成用（见那里的注释）
  runGenerateRef.current = runGenerate;

  /**
   * 取消等待（不是取消任务）。
   *
   * 生成请求已经发出去了、模型调用已经在跑、费用已经产生 ——
   * 停掉轮询等于把这次调用白白扔掉。所以这里只做一件事：**让界面立刻解锁**，
   * 后台继续轮询，跑完了照常存进「历史结果」，再给一条提示告诉用户去哪找。
   */
  const cancelGenerate = () => {
    if (!busy) return;
    cancelGenRef.current = true;
    cancelProgress(); // 界面立刻解锁；后台轮询继续（见 hooks/useJobRunner.js 的说明）
    flashTip(setToast, '已取消等待，可以继续编辑。后台仍在生成，完成后会存进「历史结果」。', 7000);
  };

  const loadDemo = () => {
    genTokenRef.current += 1; // 正在跑的生成任务作废，避免它完成时把示例视图抢回结果页
    setResult(DEMO_LESSON_18);
    setView('result');
    setError('');
    setCurrentJobId('');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  const copyAll = async () => {
    if (!result) return;
    const text = [
      result.title,
      result.aiLevel ? '润色等级：' + result.aiLevel : '',
      result.durationMs ? '本次练习用时：' + formatDuration(result.durationMs) : '', '', '【中文译文】', result.chinese, '', '【原稿】', result.draft, '',
      '【AI 修正版】', result.ai, '', '【课文原文】', result.original, '',
      '【逐句解析】', result.overall?.summary || '', '',
      '【分项得分】', ...(result.overall?.scoreBreakdown || []).map((b) => '· ' + b.label + '：' + b.score + '/' + (b.max || 20) + (b.comment ? '（' + b.comment + '）' : '')), '',
      ...(result.sentences || []).flatMap((s, i) => [
        String(i + 1) + '. ' + s.cn, '原稿：' + s.draft, 'AI 修正版：' + s.ai,
        '原文：' + s.original, ...(s.findings || []).map((f) => {
          const dims = Array.isArray(f.dimensions) && f.dimensions.length ? '（维度：' + f.dimensions.join('、') + '）' : '';
          const syns = Array.isArray(f.synonyms) && f.synonyms.length ? '；近义词：' + f.synonyms.map((s) => typeof s === 'string' ? s : (s.word + (s.meaning ? ' ' + s.meaning : ''))).join(' / ') : '';
          const idiom = f.idiom ? '；习语：' + f.idiom : '';
          return '· [' + f.category + '] ' + f.from + ' → ' + f.to + '：' + f.explanation + dims + syns + idiom;
        }), '',
      ]),
      '【词汇深度辨析】', ...(result.vocabularyNotes || []).map((v, i) => String(i + 1) + '. ' + v.word + (v.type ? '（' + v.type + '）' : '') + '：' + (v.meaning || '') + (v.note ? ' ' + v.note : '') + (hasMorphology(v.morphology) ? ' 【' + morphologyText(v.morphology) + '】' : '')), '',
      '【地道习语】', ...(result.idiomHighlights || []).map((id, i) => String(i + 1) + '. ' + id.idiom + (id.common ? '（普通说法：' + id.common + '）' : '') + '：' + (id.explanation || '')), '',
      '【可学习的高级句式】', ...(result.advancedSentences || []).map((a) => '· ' + a), '',
      '【加分表达】', ...(result.bonusExpressions || []).map((b) => '· ' + b), '',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      flashTip(setShareTip, '已复制完整解析到剪贴板', 2500);
    } catch {
      // 非 HTTPS / 局域网 http 下 navigator.clipboard 直接是 undefined，原来会静默抛错
      flashTip(setShareTip, '复制失败：请手动选中文本复制（或改用 https 访问）', 4000);
    }
  };

  // 顶栏「编辑器」：只切回编辑视图，不动任何内容（只清 #job= 免得刷新跳回结果页）。

  const onSaveSettings = () => {
    const ok = saveSettings(settings);
    refreshStatus();
    setSettingsOpen(false);
    // 配额写满时 setItem 会失败，原来完全静默（表现为"保存并重连点了没反应"）
    if (!ok) flashTip(setToast, '设置没能写入本机存储（空间可能已满）：本次仍然生效，但刷新后需要重填', 5000);
  };

  // 课文库选择区（「保存到课文库」和「新建作业」两个弹窗共用）
  const libPickerFields = (
    <>
      {myLibs.length > 0 && (
        <div className="lib-picker">
          <div className="muted small">存到已有课文库：</div>
          {myLibs.map((lib) => {
            const picked = libPickId === lib.id && !newLibName.trim();
            return (
              <label key={lib.id} className={'lib-option' + (picked ? ' active' : '')}>
                <input type="radio" name="bt-lib" checked={picked} onChange={() => { setLibPickId(lib.id); setNewLibName(''); }} />
                <Library size={13} />
                <span>{lib.name}</span>
                <span className="muted small">（{lib.lessons.length} 课）</span>
              </label>
            );
          })}
        </div>
      )}
      <label>或新建一个课文库<input value={newLibName} onChange={(e) => setNewLibName(e.target.value)} placeholder="例如：我的第二册 / 高考真题精读" /></label>
    </>
  );

  return (
    <div className="app">
      <Sidebar
        sidebarOpen={sidebarOpen} onToggle={toggleSidebar} onCloseOnMobile={closeSidebarOnMobile}
        onNewJob={startNewJob} myLibId={myLibId} book={book} onBookChange={handleBookChange}
        myLibs={myLibs} onOpenLibModal={openLibModal} onSelectLib={selectMyLib} onDeleteLib={deleteLibrary}
        lessonQuery={lessonQuery} onLessonQuery={setLessonQuery} activeLib={activeLib} lessons={lessons} visibleLessons={visibleLessons}
        mode={mode} lessonId={lessonId} onSelectLesson={selectLesson} onSelectMyLesson={selectMyLesson} onDeleteMyLesson={deleteMyLesson}
        onEditMyLesson={openLessonEdit} onRenumberLib={renumberMyLib}
        onOpenSettings={openSettings} onOpenBackup={openBackup}
      />

      <main className="main">
        <header className="topbar">
          <button className="icon-btn side-toggle" onClick={toggleSidebar} title={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}>
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <div className="topbar-left"><BookOpen size={18} /><strong>{mode === 'lesson' ? '课文回译训练' : '自由回译训练'}</strong></div>
          <div className="status-chip" title={status ? (status.model + ' @ ' + status.baseUrl) : '请先启动后端 npm run server'}>
            <span className={'dot ' + (status ? 'ok' : 'err')} />
            {status ? (hasAiKey ? 'AI 已配置 · ' + status.model : '未配置 API Key · ' + status.model) : '后端未连接'}
            {status?.corpusLessons ? ' · ' + status.corpusLessons + ' 课' : ''}
          </div>
          <button className="ghost-btn" onClick={backToEditor}><X size={15} />编辑器</button>
          <button className="ghost-btn" onClick={openHistoryModal}><History size={15} />历史结果{historyList.length ? ` (${historyList.length})` : ''}</button>
          <button className="ghost-btn" onClick={() => { setFavTip(''); setFavReview(null); setFavOpen(true); }}><Star size={15} />收藏夹{favorites.length ? ` (${favorites.length})` : ''}</button>
          <button className={'ghost-btn due-btn' + (favDueCount ? ' has-due' : '')} onClick={startReview} title="按间隔重复安排：打开今天该复习的收藏">
            <Flame size={15} />今日待复习{favDueCount ? ` (${favDueCount})` : ''}
          </button>
        </header>
        {favTip ? <div className="fav-tip" role="status" aria-live="polite">{favTip}</div> : null}
        {toast ? <div className="fav-tip toast" role="status" aria-live="polite">{toast}</div> : null}
        {backendWaking ? (
          <div className="wake-tip" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={14} />
            正在唤醒服务（免费托管休眠后约需 1 分钟），请稍候…
          </div>
        ) : null}

        {view === 'editor' ? (
          <section className="editor">
            <div className="upload-strip">
              <input ref={fileRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={handleDocx} />
              <button className="primary-btn" onClick={() => fileRef.current?.click()} disabled={parsing}>
                {parsing ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
                {parsing ? '正在读取 DOCX…' : '上传 DOCX 作业'}
              </button>
              <span className="upload-name">{fileName || '上传后自动读取标题、中文和英文初稿'}</span>
              <button className="ghost-btn" onClick={() => { setMaterialOpen(true); setError(''); }} disabled={materialBusy}>
                <Sparkles size={16} />AI 生成训练素材
              </button>
              <button className="ghost-btn" onClick={openLibModal} title="把当前作业存进自建课文库，以后可以像课文一样选出来反复练习">
                <FolderPlus size={16} />保存到课文库
              </button>
              <label className="ocr-mode-wrap">润色等级
                <select className="ocr-mode" value={polishLevel} onChange={(e) => { setPolishLevel(e.target.value); safeSet(LEVEL_KEY, e.target.value); }} title="AI 润色版、高级句式与推荐表达都会匹配该考试难度">
                  {AI_LEVELS.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
                </select>
              </label>
              <label className="ocr-mode-wrap">识别模式
                <select className="ocr-mode" value={ocrMode} onChange={(e) => setOcrMode(e.target.value)} title="拍照 / 图片识别的模式">
                  <option value="auto">自动（印刷体/手写体）</option>
                  <option value="handwriting">手写体优先（更高清）</option>
                  <option value="printed">印刷体优先</option>
                </select>
              </label>
            </div>
            {matchedLesson && (
              <div className={'match-banner' + (mode === 'free' ? ' weak' : '')}>
                <BookOpen size={15} />
                {matchedLesson.book === 'my' ? (
                  // 自建库课文：book 是 'my' 这个标记值，不能当成册号渲染（原来会显示"第 my 册"）
                  <span className="match-text">当前课文：<b>我的课文库</b> · 第 {matchedLesson.lesson} 课{matchedLesson.title_cn ? ' · ' + matchedLesson.title_cn : ''}（{CONFIDENCE_LABEL[matchConfidence] || matchConfidence || '手动选择'}）{mode === 'free' ? '，当前按自由模式' : '，原文将自动带入分析'}</span>
                ) : (
                  <span className="match-text">已识别可能有课文：第 {matchedLesson.book} 册 · Lesson {matchedLesson.lesson} · {matchedLesson.title_en}（{CONFIDENCE_LABEL[matchConfidence] || matchConfidence || '未匹配'}{matchScore != null ? ` · 匹配分 ${matchScore}` : ''}）{mode === 'free' ? '，当前按自由模式' : '，原文将自动带入分析'}</span>
                )}
                {mode === 'free'
                  ? <button className="link" onClick={applyMatchedLesson}>改用这个课文</button>
                  : <button className="link" onClick={() => { setMode('free'); setMatchConfidence('manual'); }}>改用自由模式</button>}
              </div>
            )}
            {generatedOriginal && <div className="match-banner"><Sparkles size={15} />已载入 AI 原创训练素材（无教材版权）：{title}{materialKeywords.length ? ` · 建议词汇：${materialKeywords.join('、')}` : ''}，请根据中文提示写出你的英文初稿</div>}
            <div className="mode-tabs">
              <button className={mode === 'lesson' ? 'active' : ''} onClick={() => setMode('lesson')}><BookOpen size={15} />课文模式</button>
              <button className={mode === 'free' ? 'active' : ''} onClick={() => setMode('free')}><PenLine size={15} />自由模式</button>
            </div>
            <div className="title-row">
              <div className="title-field"><label htmlFor="bt-title">作业标题</label><input id="bt-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：第 2 册 lesson 11" /></div>
              <div className={'timer-box' + (timer.running ? ' running' : '')}>
                <Timer size={16} />
                <strong className="timer-display" title="本次练习用时"><ElapsedDisplay timer={timer} /></strong>
                <button className="ghost-btn sm" onClick={toggleTimer}>
                  {timer.running ? '暂停' : (hasElapsed ? '继续' : '开始计时')}
                </button>
                <button className="ghost-btn sm" onClick={resetTimer} disabled={!hasElapsed}>重置</button>
              </div>
            </div>
            <div className="editor-grid">
              <div
                className={'panel' + (dragOver === 'chinese' ? ' drag-on' : '')}
                onDragOver={(e) => { e.preventDefault(); setDragOver('chinese'); }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => { e.preventDefault(); setDragOver(null); handleOcrFiles('chinese', e.dataTransfer && e.dataTransfer.files); }}
              >
                <div className="panel-head">
                  <h2>中文提示</h2>
                  <div className="panel-tools">
                    <button className="ghost-btn sm" onClick={() => openCamera('chinese')} disabled={Boolean(ocrBusy)} title="调用摄像头拍照并识别中文">
                      {ocrBusy === 'chinese' ? <LoaderCircle className="spin" size={14} /> : <Camera size={14} />}拍照
                    </button>
                    <button className="ghost-btn sm" onClick={() => chineseFileRef.current?.click()} disabled={Boolean(ocrBusy)} title="从相册 / 文件选择图片并识别中文">
                      <ImagePlus size={14} />导入图片
                    </button>
                  </div>
                </div>
                <textarea className="big-textarea" value={chinese} onChange={(e) => setChinese(e.target.value)} placeholder="上传 DOCX 后自动填入；也可拍照、导入图片，或把图片直接拖到这里识别（印刷体 / 手写体均可）" />
                <div className={'ocr-note' + (String(ocrNotes.chinese || '').startsWith('识别失败') ? ' err' : '')}>
                  {ocrNotes.chinese || '支持：拍照 / 导入图片 / 电脑端拖入图片；识别后可先核对再生成'}
                </div>
                <input ref={chineseCamRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; handleOcrFiles('chinese', f); }} />
                <input ref={chineseFileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; handleOcrFiles('chinese', f); }} />
              </div>
              <div
                className={'panel' + (dragOver === 'english' ? ' drag-on' : '')}
                onDragOver={(e) => { e.preventDefault(); setDragOver('english'); }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => { e.preventDefault(); setDragOver(null); handleOcrFiles('english', e.dataTransfer && e.dataTransfer.files); }}
              >
                <div className="panel-head">
                  <h2>你的英文初稿</h2>
                  <div className="panel-tools">
                    <button className="ghost-btn sm" onClick={() => openCamera('english')} disabled={Boolean(ocrBusy)} title="调用摄像头拍照并识别英文">
                      {ocrBusy === 'english' ? <LoaderCircle className="spin" size={14} /> : <Camera size={14} />}拍照
                    </button>
                    <button className="ghost-btn sm" onClick={() => englishFileRef.current?.click()} disabled={Boolean(ocrBusy)} title="从相册 / 文件选择图片并识别英文">
                      <ImagePlus size={14} />导入图片
                    </button>
                  </div>
                </div>
                <textarea className="big-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="上传 DOCX 后自动填入；也可拍照作文纸、导入图片，或把图片直接拖到这里识别英文（印刷体 / 手写体均可）" />
                <div className={'ocr-note' + (String(ocrNotes.english || '').startsWith('识别失败') ? ' err' : '')}>
                  {ocrNotes.english || '支持：拍照 / 导入图片 / 电脑端拖入图片；手写体建议把「识别模式」切到「手写体优先」'}
                </div>
                <input ref={englishCamRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; handleOcrFiles('english', f); }} />
                <input ref={englishFileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; handleOcrFiles('english', f); }} />
              </div>
            </div>
            {/* 英文原文（标准答案）：可折叠。填了结果里才能做「原文对照」 */}
            <div
              className={'original-fold' + (originalOpen ? ' open' : '') + (dragOver === 'original' ? ' drag-on' : '')}
              onDragOver={(e) => { e.preventDefault(); setDragOver('original'); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => { e.preventDefault(); setDragOver(null); handleOcrFiles('original', e.dataTransfer && e.dataTransfer.files); }}
            >
              <div className="fold-head">
                <button className="fold-toggle" onClick={() => setOriginalOpen((v) => !v)} aria-expanded={originalOpen} aria-controls="bt-original">
                  {originalOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <span className="fold-title">英文原文（标准答案）</span>
                </button>
                <span className="muted small fold-note">
                  {manualOriginal.trim()
                    ? `已填 ${manualOriginal.trim().split(/\s+/).filter(Boolean).length} 词，结果里会逐句对照`
                    : currentOriginal.trim()
                      ? `已自动带入 ${currentOriginal.trim().split(/\s+/).filter(Boolean).length} 词（留空就用这一份）`
                      : '可选；不填的话结果里只有 AI 修正版，没有原文对照'}
                </span>
                <div className="panel-tools">
                  <button className="ghost-btn sm" onClick={() => openCamera('original')} disabled={Boolean(ocrBusy)} title="调用摄像头拍课文，识别成英文原文">
                    {ocrBusy === 'original' ? <LoaderCircle className="spin" size={14} /> : <Camera size={14} />}拍照
                  </button>
                  <button className="ghost-btn sm" onClick={() => originalFileRef.current?.click()} disabled={Boolean(ocrBusy)} title="从相册 / 文件选择图片，识别成英文原文">
                    <ImagePlus size={14} />导入图片
                  </button>
                </div>
              </div>
              {originalOpen && (
                <>
                  <textarea
                    id="bt-original"
                    className="big-textarea original-textarea"
                    value={manualOriginal}
                    onChange={(e) => setManualOriginal(e.target.value)}
                    placeholder="把这一课的英文原文粘贴到这里（课文原文 / 你要对标的范文都行）；也可以拍照或导入图片识别。留空则使用内置语料或 AI 素材自带的原文。"
                  />
                  <div className={'ocr-note' + (String(ocrNotes.original || '').startsWith('识别失败') ? ' err' : '')}>
                    {ocrNotes.original || '支持：拍照 / 导入图片 / 电脑端把图片拖进这一栏'}
                  </div>
                </>
              )}
              <input ref={originalCamRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; handleOcrFiles('original', f); }} />
              <input ref={originalFileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; handleOcrFiles('original', f); }} />
            </div>
            {error && <div className="error-banner" role="alert"><Flame size={15} /><span className="error-text">{error}</span><button className="link" onClick={loadDemo}>查看离线示例</button><button className="icon-btn err-close" onClick={() => setError('')} aria-label="关闭提示"><X size={15} /></button></div>}
            {/* 没有 Key 时不只是一句"未配置"，而是说清楚为什么需要、去哪弄、以及不配也能干什么 */}
            {!hasAiKey && !busy && (
              <div className="key-hint" role="note">
                <div className="key-hint-title"><Settings size={15} />还差一步：配置 AI 接口</div>
                <p>
                  本工具用<b>你自己的 API Key</b>调用大模型来批改。费用由你直接付给模型服务商，
                  <b>本站不经手、也不加价</b>；Key 只存在你的浏览器里（除非你自己填进服务端环境变量）。
                </p>
                <p className="muted small">
                  还没有 Key？<b>DeepSeek</b> 在 <code>platform.deepseek.com</code> 注册后即可免费创建，
                  按用量计费 —— 批改一篇课文大约几分钱。填好就能开始用了。
                </p>
                <div className="modal-actions">
                  <button className="primary-btn" onClick={() => setSettingsOpen(true)}>去填 API Key</button>
                  <button className="ghost-btn" onClick={loadDemo}>先看离线示例</button>
                </div>
              </div>
            )}
            <div className="actions-bar">
              <button className="primary-btn big" onClick={() => runGenerate()} disabled={busy || parsing}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <WandSparkles size={17} />}
                {busy ? 'AI 正在后台生成（约1-2分钟）…' : '生成完整回译训练作业'}
              </button>
              {!hasAiKey && <button className="ghost-btn" onClick={loadDemo}><Sparkles size={15} />离线示例</button>}
              <span className="muted actions-hint">{busy ? '已提交后台任务，请保持页面打开，完成后自动展示' : '生成顺序：标题 → 中文 → 原稿 → AI 修正版 → 原文 → 逐句解析'}</span>
            </div>
            {busy && (
              <div className="progress-box">
                <div className="progress-steps">
                  <span className={progressStep >= 1 ? 'active' : ''}><CheckCircle2 size={12} />已提交</span>
                  <span className={progressStep >= 2 ? 'active' : ''}><LoaderCircle className={progressStep === 2 ? 'spin' : ''} size={12} />AI 生成中</span>
                  <span className={progressStep >= 3 ? 'active' : ''}><CheckCircle2 size={12} />完成</span>
                </div>
                <div className="progress-track"><div className="progress-fill" style={{ width: progressStep >= 3 ? '100%' : progressStep >= 2 ? '66%' : '18%' }} /></div>
                <div className="progress-foot">
                  <span className="muted small">
                    {progressMsg}{elapsed > 0 ? ` · 已进行 ${elapsed} 秒` : ''}
                    {progressStep === 2 && elapsed >= 25 ? '（通常 60–120 秒）' : ''}
                  </span>
                  <button className="ghost-btn sm" onClick={cancelGenerate}>取消等待</button>
                </div>
                {elapsed >= 30 && (
                  <p className="muted small progress-note">
                    别关页面 —— 关掉就看不到结果了。等不及可以点「取消等待」继续编辑，
                    生成完会自动存进「历史结果」，不会白花这次调用。
                  </p>
                )}
              </div>
            )}
          </section>
        ) : view === 'quiz' ? (
          <section className="result">
            {quizData && (
              <QuizSheet
                quiz={quizData}
                showAnswers={quizShowAnswers}
                onToggleAnswers={() => setQuizShowAnswers((v) => !v)}
                onBack={() => setView('editor')}
                onBackToFav={() => setFavOpen(true)}
                onCopy={copyQuiz}
                tip={quizTip}
              />
            )}
          </section>
        ) : (
          <section className="result">
            {result && <ResultSheet result={result} onBack={backToEditorView} onCopy={copyAll} onShare={shareResult} shareTip={shareTip} fav={favHandlers} history={historyList} jobId={currentJobId} />}
          </section>
        )}
      </main>

      {camOpen && (
        <div className="modal-mask" onClick={closeCamera}>
          <div className="modal cam-modal" ref={(el) => { modalRefs.current.cam = el; }} role="dialog" aria-modal="true" aria-label="拍照识别" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>拍照识别 · {OCR_LABEL[camSide] || '英文初稿'}</h2><button className="icon-btn" onClick={closeCamera} aria-label="关闭"><X size={16} /></button></div>
            <video ref={camVideoRef} className="cam-video" playsInline muted autoPlay />
            {camError ? <p className="muted small cam-err">{camError}</p> : null}
            <p className="muted small">把纸张放平、光线充足、尽量让文字填满画面；手写体建议先把「识别模式」设为「手写体优先」。</p>
            <div className="modal-actions">
              <button className="primary-btn" onClick={snapPhoto}><Camera size={16} />拍照并识别</button>
              <button className="ghost-btn" onClick={() => { const side = camSide; closeCamera(); (side === 'chinese' ? chineseCamRef : side === 'original' ? originalCamRef : englishCamRef).current?.click(); }}>从相册选择</button>
            </div>
          </div>
        </div>
      )}

      {materialOpen && (
        <div className="modal-mask" onClick={() => !materialBusy && setMaterialOpen(false)}>
          <div className="modal material-modal" ref={(el) => { modalRefs.current.material = el; }} role="dialog" aria-modal="true" aria-label="AI 生成训练素材" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>AI 生成训练素材</h2><button className="icon-btn" onClick={() => setMaterialOpen(false)} disabled={materialBusy} aria-label="关闭"><X size={16} /></button></div>
            <label>主题<textarea rows={2} value={materialTopic} onChange={(e) => setMaterialTopic(e.target.value)} placeholder="例如：春节的由来 / 人工智能改变生活 / 城市通勤 / 中国茶文化" /></label>
            <div className="material-grid">
              <label>难度<select value={materialLevel} onChange={(e) => setMaterialLevel(e.target.value)}><option>基础</option><option>中级</option><option>高级</option></select></label>
              <label>文章类型<select value={materialStyle} onChange={(e) => setMaterialStyle(e.target.value)}><option>生活故事</option><option>中国文化</option><option>时事观察</option><option>科技</option><option>人物故事</option></select></label>
            </div>
            <p className="muted small">AI 将原创一篇 120-220 词英文短文 + 完整中文翻译，避开教材版权，可直接用于回译训练。</p>
            <div className="modal-actions">
              <button className="primary-btn" onClick={handleGenerateMaterial} disabled={materialBusy}>
                {materialBusy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
                {materialBusy ? `AI 正在创作素材…（${materialElapsed} 秒）` : '生成素材'}
              </button>
              <button className="ghost-btn" onClick={() => setMaterialOpen(false)} disabled={materialBusy}>取消</button>
            </div>
          </div>
        </div>
      )}

      {authOpen && (
        <div className="modal-mask auth-mask" onClick={() => !authBusy && setAuthOpen(false)}>
          <div className="modal auth-modal" role="dialog" aria-modal="true" aria-label="账号" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{authMode === 'login' ? '登录' : authMode === 'register' ? '注册账号' : authMode === 'forgot' ? '找回密码' : '重置密码'}</h2>
              <button className="icon-btn" onClick={() => setAuthOpen(false)} disabled={authBusy} aria-label="关闭"><X size={16} /></button>
            </div>

            <div className="auth-form">
              <label className="auth-label">
                邮箱
                <input
                  type="email" value={authForm.email} onChange={authField('email')}
                  placeholder="you@example.com" autoComplete="username"
                  disabled={authBusy || authMode === 'reset'}
                />
              </label>

              {authMode === 'register' ? (
                <label className="auth-label">
                  昵称（可选）
                  <input value={authForm.nickname} onChange={authField('nickname')} maxLength={20} placeholder="怎么称呼你" disabled={authBusy} />
                </label>
              ) : null}

              {authMode === 'reset' ? (
                <label className="auth-label">
                  邮箱验证码
                  <input value={authForm.code} onChange={authField('code')} inputMode="numeric" maxLength={8} placeholder="8 位数字" disabled={authBusy} />
                </label>
              ) : null}

              {authMode !== 'forgot' ? (
                <label className="auth-label">
                  {authMode === 'reset' ? '新密码' : '密码'}
                  <input
                    type="password" value={authForm.password} onChange={authField('password')}
                    placeholder="至少 8 位"
                    autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                    disabled={authBusy}
                  />
                </label>
              ) : null}

              {authMode === 'register' ? (
                <p className="muted small">
                  账号只存两样东西：<b>你的邮箱</b>，和<b>用你的密码加密后的同步码</b>。
                  密码本身经过 PBKDF2 哈希后才存储，服务端无法还原；
                  同步码更是服务端也解不开的密文。
                  <br />
                  这些数据存放在境外服务器（Cloudflare/Render 所在区域）。
                  你可以随时注销账号并删除全部数据。<b>本服务面向 14 周岁以上用户。</b>
                </p>
              ) : null}

              {authMode === 'reset' ? (
                <p className="muted small">
                  ⚠️ 重置密码后，之前用旧密码加密的同步码<b>无法自动解锁</b>。
                  如果你手上有同步码，填在下方可以一并存进账号。
                </p>
              ) : null}

              {authMode === 'reset' ? (
                <label className="auth-label">
                  同步码（可选）
                  <input value={authForm.syncCode} onChange={authField('syncCode')} placeholder="有就填，没有留空" disabled={authBusy} />
                </label>
              ) : null}
            </div>

            {authTip ? <div className="backup-tip" role="status" aria-live="polite">{authTip}</div> : null}

            <div className="modal-actions">
              {authMode === 'login' ? (
                <>
                  <button className="primary-btn" onClick={doSignIn} disabled={authBusy || !authForm.email || !authForm.password}>
                    {authBusy ? '登录中…' : '登录'}
                  </button>
                  <button className="ghost-btn" onClick={() => openAuth('register')} disabled={authBusy}>注册新账号</button>
                  <button className="ghost-btn" onClick={() => openAuth('forgot')} disabled={authBusy}>忘记密码</button>
                </>
              ) : authMode === 'register' ? (
                <>
                  <button className="primary-btn" onClick={doSignUp} disabled={authBusy || !authForm.email || !authForm.password}>
                    {authBusy ? '注册中…' : '注册'}
                  </button>
                  <button className="ghost-btn" onClick={() => openAuth('login')} disabled={authBusy}>已有账号，去登录</button>
                </>
              ) : authMode === 'forgot' ? (
                <>
                  <button className="primary-btn" onClick={doForgot} disabled={authBusy || !authForm.email}>
                    {authBusy ? '发送中…' : '发送验证码'}
                  </button>
                  <button className="ghost-btn" onClick={() => openAuth('login')} disabled={authBusy}>返回登录</button>
                </>
              ) : (
                <>
                  <button className="primary-btn" onClick={doReset} disabled={authBusy || !authForm.code || !authForm.password}>
                    {authBusy ? '提交中…' : '重置密码'}
                  </button>
                  <button className="ghost-btn" onClick={() => openAuth('forgot')} disabled={authBusy}>重新发码</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <LessonEditModal
        open={Boolean(lessonEdit)}
        lesson={resolveEditLesson(lessonEdit)}
        onClose={closeLessonEdit}
        onSave={saveLessonEdit}
        onDelete={(lesson) => { setLessonEdit(null); deleteMyLesson(lessonEdit.libId, lesson, lesson.title_cn); }}
        modalRef={lessonEditModalRef}
      />

      <HistoryModal open={historyOpen} onClose={closeHistory} modalRef={historyModalRef} items={historyList} onOpen={loadHistoryJob} />

      <FavoritesModal
        open={favOpen} onClose={closeFavorites} modalRef={favModalRef}
        favorites={favorites} visibleFavorites={visibleFavorites} favQuery={favQuery} onQuery={setFavQuery} favKind={favKind} onKind={setFavKind} dueCount={favDueCount}
        review={favReview} onStartReview={startReview} onGrade={gradeFavReview} onSkip={skipFavReview} onExitReview={() => setFavReview(null)}
        onReveal={() => setFavReview((r) => (r ? { ...r, revealed: true } : r))} onRemove={removeFavorite}
        onExport={exportFavorites} onImportClick={() => favFileRef.current?.click()} favFileRef={favFileRef} onImportFile={importFavorites} onCopy={copyFavorites} onClear={clearFavorites}
        quizCount={quizCount} onQuizCount={setQuizCount} onGenerateQuiz={generateQuiz} quizBusy={quizBusy} polishLevel={polishLevel}
      />

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="modal" ref={(el) => { modalRefs.current.settings = el; }} role="dialog" aria-modal="true" aria-label="AI 接入设置" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>AI 接入设置</h2><button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="关闭"><X size={16} /></button></div>
            <label>Base URL（OpenAI 兼容）<input value={settings.baseUrl || 'https://api.deepseek.com/v1'} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" /></label>
            <label>模型名<input value={settings.model || 'deepseek-chat'} onChange={(e) => setSettings({ ...settings, model: e.target.value })} placeholder="deepseek-chat / gpt-4o-mini / qwen-plus" /></label>
            <label>视觉模型（可选，拍照/图片识别用）<input value={settings.visionModel || ''} onChange={(e) => setSettings({ ...settings, visionModel: e.target.value })} placeholder="deepseek-flash（DeepSeek 已原生支持图片）" /></label>
            <label>API Key<input type="password" value={settings.apiKey || ''} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} placeholder="sk-..." /></label>
            <label className="remember-key"><input type="checkbox" checked={Boolean(settings.rememberKey)} onChange={(e) => setSettings({ ...settings, rememberKey: e.target.checked })} /> 在本机记住 Key（关闭浏览器后仍保留）</label>
            <p className="muted small">默认只保留到<b>关闭标签页</b>为止——Key 存在浏览器会话存储里，不长期落盘；勾选上面的选项才会长期保存（换设备 / 换浏览器需重填）。Key 只会发给你自己部署的这个后端，由它转发给模型接口；<b>自定义 Base URL 时必须同时填该接口的 Key</b>，否则服务端会拒绝（避免把你的密钥发给陌生地址）。想让所有访问者免填 Key，请在部署平台的环境变量里配置 AI_API_KEY / AI_VISION_MODEL。</p>
            <div className="modal-actions"><button className="primary-btn" onClick={onSaveSettings}>保存并重连</button><button className="ghost-btn" onClick={() => setSettingsOpen(false)}>取消</button></div>
          </div>
        </div>
      )}

      {libModalOpen && (
        <div className="modal-mask" onClick={() => setLibModalOpen(false)}>
          <div className="modal" ref={(el) => { modalRefs.current.lib = el; }} role="dialog" aria-modal="true" aria-label="保存到课文库" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>保存到课文库</h2><button className="icon-btn" onClick={() => setLibModalOpen(false)} aria-label="关闭"><X size={16} /></button></div>
            <p className="muted small">把当前作业的「标题 + 中文提示 + 英文原文」存成一节课，之后就能从左侧「我的课文库」里像课文一样选出来反复练习（只存在本机浏览器）。</p>
            <div className="lib-preview">
              <div><span className="muted">标题</span><strong>{title.trim() || (chinese.trim() ? chinese.trim().slice(0, 12) + '…' : '未命名作业')}</strong></div>
              <div><span className="muted">中文提示</span><strong className={chinese.trim() ? '' : 'warn'}>{chinese.trim() ? chinese.trim().length + ' 字' : '还没有，至少要有中文提示'}</strong></div>
              <div><span className="muted">英文原文</span><strong className={currentOriginal.trim() ? '' : 'warn'}>{currentOriginal.trim() ? currentOriginal.trim().split(/\s+/).filter(Boolean).length + ' 词' : '没填，练习时没有原文对照'}</strong></div>
            </div>
            {libPickerFields}
            {libTip ? <div className="lib-tip" role="alert">{libTip}</div> : null}
            <div className="modal-actions">
              <button className="primary-btn" onClick={saveToLibrary}>{newLibName.trim() ? (myLibs.some((l) => l.name === newLibName.trim()) ? '存入该库' : '新建并保存') : '保存'}</button>
              <button className="ghost-btn" onClick={() => setLibModalOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {newJobOpen && (
        <div className="modal-mask" onClick={() => setNewJobOpen(false)}>
          <div className="modal" ref={(el) => { modalRefs.current.newjob = el; }} role="dialog" aria-modal="true" aria-label="新建回译作业" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>新建回译作业</h2><button className="icon-btn" onClick={() => setNewJobOpen(false)} aria-label="关闭"><X size={16} /></button></div>
            <p className="muted small">这会打开一份<b>空白作业</b>，当前这份不会自动保留。</p>
            {jobDirty ? (
              <>
                <p className="muted small">建议先把当前作业存进课文库——以后可以随时从左侧「我的课文库」里选出来继续练。</p>
                <div className="lib-preview">
                  <div><span className="muted">标题</span><strong>{title.trim() || (chinese.trim() ? chinese.trim().slice(0, 12) + '…' : '未命名作业')}</strong></div>
                  <div><span className="muted">中文提示</span><strong className={chinese.trim() ? '' : 'warn'}>{chinese.trim() ? chinese.trim().length + ' 字' : '空'}</strong></div>
                  <div><span className="muted">英文初稿</span><strong className={draft.trim() ? '' : 'warn'}>{draft.trim() ? draft.trim().split(/\s+/).filter(Boolean).length + ' 词' : '还没写'}</strong></div>
                  <div><span className="muted">英文原文</span><strong className={currentOriginal.trim() ? '' : 'warn'}>{currentOriginal.trim() ? currentOriginal.trim().split(/\s+/).filter(Boolean).length + ' 词' : '空'}</strong></div>
                </div>
                {libPickerFields}
                {libTip ? <div className="lib-tip" role="alert">{libTip}</div> : null}
              </>
            ) : (
              <p className="muted small">这份内容<b>已经在课文库里、且没有改动</b>，不需要重复保存，直接新建即可。（想另存到别的库，请用编辑器工具栏的「保存到课文库」。）</p>
            )}
            <div className="modal-actions">
              {jobDirty ? (
                <>
                  <button className="primary-btn" onClick={saveAndStartNew}>存进课文库并新建</button>
                  <button className="ghost-btn" onClick={discardAndStartNew}>不保存，直接新建</button>
                </>
              ) : (
                <button className="primary-btn" onClick={discardAndStartNew}>新建空白作业</button>
              )}
              <button className="ghost-btn" onClick={() => setNewJobOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {backupOpen && (
        <div className="modal-mask" onClick={() => setBackupOpen(false)}>
          <div className="modal" ref={(el) => { modalRefs.current.backup = el; }} role="dialog" aria-modal="true" aria-label="备份与恢复" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>备份与恢复</h2><button className="icon-btn" onClick={() => setBackupOpen(false)} aria-label="关闭"><X size={16} /></button></div>
            <p className="muted small">课文库、收藏夹、历史都只存在<b>本机浏览器</b>里：换设备、换浏览器、清缓存都会丢。导出一个备份文件，换环境后导入即可恢复。</p>
            <div className="lib-preview">
              <div><span className="muted">当前数据</span><strong>{backupSummary}</strong></div>
            </div>
            <input ref={backupFileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importBackup(f); }} />
            <div className="modal-actions">
              <button className="primary-btn" onClick={exportBackup}><Download size={15} />导出备份文件</button>
              <button className="ghost-btn" onClick={() => backupFileRef.current?.click()}><Upload size={15} />导入备份文件</button>
              <button className="ghost-btn" onClick={() => setBackupOpen(false)}>关闭</button>
            </div>
            {backupTip ? <div className="backup-tip" role="status" aria-live="polite">{backupTip}</div> : null}

            {/* 账号：换设备不用抄同步码（服务端配了持久存储才显示） */}
            {accountsOn ? (
              <div className="sync-block">
                <div className="sync-title"><UserRound size={15} />账号（换设备免抄码）</div>
                {account ? (
                  <>
                    <p className="muted small">
                      已登录：<b>{account.user.email}</b>{account.user.nickname ? `（${account.user.nickname}）` : ''}
                    </p>
                    <p className="muted small">
                      在别的设备上用这个邮箱登录，同步码会自动取回，不用手抄。
                      同步码是用你的密码加密后存在服务端的，<b>服务端也解不开</b>。
                    </p>
                    {syncCode ? (
                      <div className="sync-row">
                        <input
                          type="password"
                          value={bindPw}
                          onChange={(e) => setBindPw(e.target.value)}
                          placeholder="输入账号密码，把本机同步码存进账号"
                          aria-label="账号密码（用于加密同步码）"
                        />
                        <button className="ghost-btn" onClick={doBindSync} disabled={authBusy || !bindPw}>存入账号</button>
                      </div>
                    ) : null}
                    <div className="modal-actions">
                      <button className="ghost-btn" onClick={doSignOut} disabled={authBusy}>退出登录</button>
                      <button className="ghost-btn" onClick={doSignOutEverywhere} disabled={authBusy} title="让其它设备上已登录的账号立刻下线（怀疑账号被盗用时用）">退出所有设备</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="muted small">
                      建个账号，换电脑 / 换手机时用邮箱登录就能把同步码取回来，<b>不用手抄那串 32 位码</b>。
                    </p>
                    <div className="modal-actions">
                      <button className="primary-btn" onClick={() => openAuth('register')}>注册</button>
                      <button className="ghost-btn" onClick={() => openAuth('login')}>登录</button>
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {/* 云同步：多设备之间合并同步（课文库 + 收藏夹 + 历史） */}
            <div className="sync-block">
              <div className="sync-title"><Cloud size={15} />云同步（多设备）</div>
              {!syncCode ? (
                <>
                  <p className="muted small">
                    生成一串同步码，在另一台设备上填同一串码，练习记录 / 收藏夹 / 课文库就会<b>双向合并</b>同步。
                    <b>同步码等于密码</b>——拿到的人可以读写你的数据，请勿外传。
                  </p>
                  {status?.sync && !status.sync.durable ? (
                    <p className="sync-lost" role="alert">
                      ⚠️ <b>当前服务端没有持久存储，云同步在这个环境下不可靠</b>：托管平台（Render 等）的文件系统是临时的，
                      <b>每次重新部署、重启、甚至休眠（约 15 分钟无访问）都会清空同步数据</b>。
                      请先在部署平台配置 <code>UPSTASH_REDIS_REST_URL</code> 与 <code>UPSTASH_REDIS_REST_TOKEN</code>（见 .env.example）；
                      在那之前请以「导出备份文件」为主要保障。
                    </p>
                  ) : null}
                  <div className="sync-row">
                    <input value={codeInput} onChange={(e) => setCodeInput(e.target.value.trim())} placeholder="已有同步码？粘贴到这里" aria-label="输入已有同步码" />
                    <button className="ghost-btn" onClick={useExistingCode} disabled={syncBusy || !codeInput}>使用该码</button>
                  </div>
                  <div className="modal-actions">
                    <button className="primary-btn" onClick={startNewSync} disabled={syncBusy}>{syncBusy ? '处理中…' : '生成新同步码'}</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="sync-row">
                    <code className="sync-code">{syncCode}</code>
                    <button className="ghost-btn sm" onClick={copySyncCode}><Copy size={13} />复制</button>
                    <button className="ghost-btn sm" onClick={startNewSync} disabled={syncBusy} title="换一串新码并把本机数据传上去">换码</button>
                    <button className="ghost-btn sm" onClick={stopSync}>停用</button>
                  </div>
                  {syncLost ? (
                    <p className="sync-lost" role="alert">
                      ⚠️ 云端已经找不到这串同步码的数据了 —— 最常见的原因是<b>服务端重新部署过</b>（免费托管的磁盘是临时的）。
                      <b>本机数据完全没丢</b>；点「换码」重新生成一串，本机数据会自动传上去，然后在其它设备上填这串新码即可。
                    </p>
                  ) : null}
                  {status?.sync && !status.sync.durable ? (
                    <p className="sync-lost" role="alert">
                      ⚠️ 服务端没有持久存储：<b>平台休眠（约 15 分钟无访问）或重新部署都会清空同步数据</b>。
                      建议尽快配置 <code>UPSTASH_*</code> 环境变量，并定期「导出备份文件」。
                    </p>
                  ) : null}
                  <p className="muted small">
                    {syncMeta.lastSyncAt
                      ? `上次同步：${new Date(syncMeta.lastSyncAt).toLocaleString('zh-CN', { hour12: false })}`
                      : '还没有同步过'}
                  </p>
                  <p className="muted small">在另一台设备上：打开「备份」→ 把这串码粘进输入框 → 使用该码，之后会自动同步。</p>
                  <div className="modal-actions">
                    <button className="primary-btn" onClick={() => runSync(true)} disabled={syncBusy}>{syncBusy ? '同步中…' : '立即同步'}</button>
                  </div>
                </>
              )}
              {syncTip ? <div className="backup-tip" role="status" aria-live="polite">{syncTip}</div> : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


export default App;
