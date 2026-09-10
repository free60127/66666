import React, { useEffect, useMemo, useRef, useState } from 'react';
import mammoth from 'mammoth/mammoth.browser.js';
import {
  ArrowLeft, BookOpen, Camera, CheckCircle2, ClipboardCopy, Download, FileText, Flame, History, ImagePlus,
  Link2, LoaderCircle, PanelLeftClose, PanelLeftOpen, PenLine, Plus, Settings, Sparkles, Star, Timer, Trash2, Upload, WandSparkles, X,
} from 'lucide-react';
import { analyze, generateMaterial, getAnalyzeJob, getLessons, getLesson, getMaterialJob, getOcrJob, getPhonetic, getQuizJob, getStatus, loadSettings, matchLesson, ocr, quiz, saveSettings } from './api.js';
import { DEMO_LESSON_18, DEMO_LESSONS } from './demo.js';
import { FAV_KIND_LABEL, favoritesToText, favFromExpression, favFromFinding, favFromIdiom, favFromVocab, filterFavorites, hasMorphology, loadFavorites, mergeFavorites, morphologyText, saveFavorites } from './favorites.js';
import { buildLocalQuiz, favoritesToQuizPoints, quizToText } from './quiz.js';

const LEVEL_LABEL = { error: '必须改错', improve: '润色升级', study: '对照学习' };
const CATEGORY_COLOR = {
  拼写: 'red', 标点: 'red', 语法: 'blue', 时态: 'blue', 语态: 'blue', 句式: 'blue',
  词义: 'gold', 近义词辨析: 'gold', 搭配: 'gold', 语义轻重: 'gold', 内涵外延: 'gold',
  感情色彩: 'gold', 语境: 'purple', 语域: 'purple', 语用: 'purple',
  流畅度: 'teal', 地道程度: 'teal', 习语: 'teal', 专名: 'purple', 其他: 'gray',
};

const HISTORY_KEY = 'bt-history';
const AI_LEVELS = ['小初', '高考英语', '四六级', '考研英语', '专四', '专八'];
const DEFAULT_AI_LEVEL = '四六级';
const LEVEL_KEY = 'bt-polish-level';
const CONFIDENCE_LABEL = { high: '高置信度', medium: '中置信度', low: '低置信度', none: '未匹配', manual: '手动选择' };
function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch { return []; }
}
function saveHistory(arr) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, 20))); } catch { /* ignore */ }
}
function loadResultCache(jobId) {
  try {
    const raw = localStorage.getItem('bt-result-' + jobId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveResultCache(jobId, data) {
  if (!jobId || !data) return;
  try { localStorage.setItem('bt-result-' + jobId, JSON.stringify(data)); } catch { /* ignore */ }
}

/* ---------- 拍照 / 图片识别（OCR）前端预处理 ---------- */
const OCR_MODE_LABEL = { auto: '自动识别', handwriting: '手写体优先', printed: '印刷体优先' };

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
function formatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/* ---------- 计时器：记录一篇课文/一次练习花了多久 ---------- */
const TIMER_KEY = 'bt-timer';
function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function loadTimer() {
  try {
    const t = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
    if (t && typeof t === 'object') {
      return {
        running: Boolean(t.running),
        startedAt: Number(t.startedAt) || null,
        accumulated: Math.max(0, Number(t.accumulated) || 0),
        lessonKey: String(t.lessonKey || ''),
      };
    }
  } catch { /* ignore */ }
  return { running: false, startedAt: null, accumulated: 0, lessonKey: '' };
}
function saveTimer(t) {
  try { localStorage.setItem(TIMER_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

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

function lessonLabel(lesson) {
  return lesson ? `Lesson ${lesson.lesson} · ${lesson.title_en || lesson.title_cn}` : '';
}

function collectMarks(text, findings) {
  const src = String(text || '');
  const arr = Array.isArray(findings) ? findings : [];
  if (!src || !arr.length) return [];
  const chars = [];
  const map = [];
  let prevWs = true;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      if (prevWs) continue;
      chars.push(' ');
      map.push({ s: i, e: i + 1 });
      prevWs = true;
    } else {
      chars.push(ch.toLowerCase());
      map.push({ s: i, e: i + 1 });
      prevWs = false;
    }
  }
  const norm = chars.join('');
  const taken = [];
  const marks = [];
  const needles = arr
    .map((f) => (f && typeof f.from === 'string' ? f.from.replace(/\s+/g, ' ').trim().toLowerCase() : ''))
    .filter((f) => f.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const needle of needles) {
    let idx = 0;
    while (idx <= norm.length - needle.length) {
      const pos = norm.indexOf(needle, idx);
      if (pos < 0) break;
      const start = map[pos].s;
      const end = map[pos + needle.length - 1].e;
      const overlap = taken.some(([a, b]) => start < b && end > a);
      if (!overlap) {
        marks.push({ start, end });
        taken.push([start, end]);
        break;
      }
      idx = pos + 1;
    }
  }
  return marks.sort((a, b) => a.start - b.start);
}

// 只有「必须改正的错误」才在原稿上标线；纯润色升级（improve/study）不标，避免学生误以为整句都错了
const MUST_FIX_CATEGORY = /拼写|标点|语法|时态|语态|专名/;
function isMustFix(finding) {
  const f = finding || {};
  if (typeof f.from !== 'string' || !f.from.trim()) return false;
  if (f.level === 'error') return true;
  // 模型偶尔漏填 level：拼写/标点/语法/时态这类硬错误仍按必须改错处理
  return !f.level && MUST_FIX_CATEGORY.test(String(f.category || ''));
}

function DraftText({ text, findings }) {
  const src = String(text || '');
  const errs = (Array.isArray(findings) ? findings : []).filter(isMustFix);
  const marks = collectMarks(text, errs);
  if (!marks.length) return src;
  const out = [];
  let cursor = 0;
  marks.forEach((m, i) => {
    if (m.start > cursor) out.push(<span key={'t' + i}>{src.slice(cursor, m.start)}</span>);
    out.push(<mark key={'m' + i} className="hl" title="必须改正的错误">{src.slice(m.start, m.end)}</mark>);
    cursor = m.end;
  });
  if (cursor < src.length) out.push(<span key="tail">{src.slice(cursor)}</span>);
  return out;
}

function SynRow({ s }) {
  if (!s) return null;
  if (typeof s === 'string') return <div className="syn-row"><div className="syn-head"><strong className="syn-word">{s}</strong></div></div>;
  return (
    <div className="syn-row">
      <div className="syn-head">
        <strong className="syn-word">{s.word}</strong>
        <Phonetic word={s.word} phonetic={s.phonetic} />
        {s.register ? <span className="syn-meta">{s.register}</span> : null}
        {s.tone ? <span className="syn-meta">{s.tone}</span> : null}
        {s.strength ? <span className="syn-meta">{s.strength}</span> : null}
      </div>
      {s.meaning ? <div className="syn-meaning">{s.meaning}</div> : null}
      {s.usage ? <div className="syn-usage">{s.usage}</div> : null}
      {s.example ? <div className="syn-ex">{s.example}</div> : null}
    </div>
  );
}

/* 音标：优先用模型返回的 phonetic；缺失时向后端查词典并缓存（内存 + localStorage） */
const PHONETIC_KEY = 'bt-phonetics';
let phoneticMem = null;
function phoneticCacheMap() {
  if (!phoneticMem) {
    try { phoneticMem = new Map(Object.entries(JSON.parse(localStorage.getItem(PHONETIC_KEY) || '{}'))); }
    catch { phoneticMem = new Map(); }
  }
  return phoneticMem;
}
function persistPhonetic() {
  try { localStorage.setItem(PHONETIC_KEY, JSON.stringify(Object.fromEntries(phoneticCacheMap()))); } catch { /* ignore */ }
}
function Phonetic({ word, phonetic }) {
  const given = String(phonetic || '').trim();
  const key = String(word || '').trim().toLowerCase();
  const [value, setValue] = useState(() => given || (key ? (phoneticCacheMap().get(key) || '') : ''));
  useEffect(() => {
    if (given || !key) return undefined;
    const cache = phoneticCacheMap();
    if (cache.has(key)) { setValue(cache.get(key) || ''); return undefined; }
    let alive = true;
    getPhonetic(key).then((r) => {
      const v = String((r && r.phonetic) || '').trim();
      cache.set(key, v);
      persistPhonetic();
      if (alive) setValue(v);
    }).catch(() => { cache.set(key, ''); });
    return () => { alive = false; };
  }, [key, given]);
  if (!value) return null;
  return <span className="phonetic">{value.startsWith('/') ? value : '/' + value + '/'}</span>;
}

/* ---------- 收藏夹（本机 localStorage，无需数据库） ---------- */
function FavStar({ active, onToggle }) {
  return (
    <button
      type="button"
      className={'fav-star' + (active ? ' on' : '')}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={active ? '取消收藏' : '收藏这条知识点（可在右上角「收藏夹」快速复习）'}
      aria-label={active ? '取消收藏' : '收藏'}
    >
      <Star size={14} fill={active ? 'currentColor' : 'none'} />
    </button>
  );
}

function FindingExtras({ finding }) {
  const f = finding || {};
  const dims = Array.isArray(f.dimensions) ? f.dimensions : [];
  const syns = Array.isArray(f.synonyms) ? f.synonyms : [];
  const exs = Array.isArray(f.examples) ? f.examples : [];
  if (!dims.length && !syns.length && !exs.length && !f.idiom) return null;
  return (
    <div className="finding-extras">
      {dims.length ? (
        <div className="dim-row"><span className="ext-label">辨析维度</span>
          <span className="dim-chips">{dims.map((d, i) => <span className="dim-chip" key={'fd' + i}>{d}</span>)}</span>
        </div>
      ) : null}
      {f.idiom ? <div className="idiom-note"><span className="ext-label">地道习语</span><strong>{f.idiom}</strong></div> : null}
      {syns.length ? (
        <div className="syn-block"><span className="ext-label">近义词对比</span>
          <div className="syn-list">{syns.map((s, i) => <SynRow key={'fs' + i} s={s} />)}</div>
        </div>
      ) : null}
      {exs.length ? (
        <div className="ex-block"><span className="ext-label">例句</span>
          {exs.map((x, i) => (
            <div className="example-line" key={'fe' + i}>
              <em>{x?.en || x?.example || ''}</em>
              {x?.cn ? <span>{x.cn}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function App() {
  const [settings, setSettings] = useState(loadSettings());
  const [status, setStatus] = useState(null);
  const [lessons, setLessons] = useState([]);
  const [book, setBook] = useState(() => {
    const b = Number(localStorage.getItem('bt-book'));
    return [1, 2, 3, 4].includes(b) ? b : 2;
  });
  const [mode, setMode] = useState('lesson');
  const [lessonId, setLessonId] = useState(() => {
    const n = Number(localStorage.getItem('bt-lesson'));
    return Number.isFinite(n) && n > 0 ? n : 18;
  });
  const [matchedLesson, setMatchedLesson] = useState(null);
  const [title, setTitle] = useState('');
  const [chinese, setChinese] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const progressTimerRef = useRef(null);
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [view, setView] = useState('editor');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [materialTopic, setMaterialTopic] = useState('');
  const [materialLevel, setMaterialLevel] = useState('中级');
  const [materialStyle, setMaterialStyle] = useState('生活故事');
  const [materialBusy, setMaterialBusy] = useState(false);
  const [materialElapsed, setMaterialElapsed] = useState(0);
  const [materialKeywords, setMaterialKeywords] = useState([]);
  const [generatedOriginal, setGeneratedOriginal] = useState('');
  const [matchConfidence, setMatchConfidence] = useState('');
  const [matchScore, setMatchScore] = useState(null);
  const [currentJobId, setCurrentJobId] = useState('');
  const [historyList, setHistoryList] = useState(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 收藏夹（本机 localStorage）
  const [favorites, setFavorites] = useState(loadFavorites);
  const [favOpen, setFavOpen] = useState(false);
  const [favQuery, setFavQuery] = useState('');
  const [favKind, setFavKind] = useState('all');
  const [favTip, setFavTip] = useState('');
  // 自测题
  const [quizData, setQuizData] = useState(null);
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizCount, setQuizCount] = useState(10);
  const [quizShowAnswers, setQuizShowAnswers] = useState(true);
  const [quizTip, setQuizTip] = useState('');
  const [shareTip, setShareTip] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 900) return false;
    return localStorage.getItem('bt-sidebar') !== 'collapsed';
  });
  const fileRef = useRef(null);
  // 拍照 / 图片识别
  const [ocrBusy, setOcrBusy] = useState(null); // null | 'chinese' | 'english'
  const [ocrMode, setOcrMode] = useState('auto'); // auto | handwriting | printed
  const [ocrNotes, setOcrNotes] = useState({});
  const [dragOver, setDragOver] = useState(null); // null | 'chinese' | 'english'
  const [camOpen, setCamOpen] = useState(false);
  const [camSide, setCamSide] = useState('english');
  const [camError, setCamError] = useState('');
  const camVideoRef = useRef(null);
  const camStreamRef = useRef(null);
  const chineseCamRef = useRef(null);
  const chineseFileRef = useRef(null);
  const englishCamRef = useRef(null);
  const englishFileRef = useRef(null);
  const favFileRef = useRef(null);
  // 计时器（记录一篇课文做了多久）
  const [timer, setTimer] = useState(loadTimer);
  const [clockNow, setClockNow] = useState(() => Date.now());
  // 润色等级：让润色版与推荐表达匹配用户目标考试的难度
  const [polishLevel, setPolishLevel] = useState(() => {
    const saved = localStorage.getItem(LEVEL_KEY);
    return AI_LEVELS.includes(saved) ? saved : DEFAULT_AI_LEVEL;
  });

  const toggleSidebar = () => {
    setSidebarOpen((open) => {
      localStorage.setItem('bt-sidebar', open ? 'collapsed' : 'open');
      return !open;
    });
  };

  const startProgressTimer = () => {
    const start = Date.now();
    setElapsed(0);
    clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
  };
  const stopProgressTimer = () => {
    clearInterval(progressTimerRef.current);
    progressTimerRef.current = null;
  };
  // 手机端侧栏是覆盖层，选中课文后自动收起
  const closeSidebarOnMobile = () => {
    if (window.innerWidth <= 900) setSidebarOpen(false);
  };

  const refreshStatus = async () => {
    try { setStatus(await getStatus()); } catch { setStatus(null); }
  };

  // 恢复上次打开的书册/课次；没有记录则默认第一课
  const pickInitialLesson = (list) => {
    const savedBook = Number(localStorage.getItem('bt-book'));
    const savedLesson = Number(localStorage.getItem('bt-lesson'));
    const targetBook = [1, 2, 3, 4].includes(savedBook) ? savedBook : 2;
    const match = list.find((l) => l.book === targetBook && l.lesson === savedLesson);
    if (match) return match;
    return list.find((l) => l.book === targetBook) || list[0] || null;
  };

  useEffect(() => {
    let alive = true;
    refreshStatus();
    getLessons().then((data) => {
      if (!alive) return;
      const loaded = data.lessons || [];
      setLessons(loaded);
      if (loaded.length) {
        const target = pickInitialLesson(loaded);
        selectLesson(target.book, target.lesson);
      }
    }).catch(() => {
      if (!alive) return;
      const fallback = DEMO_LESSONS.map((l) => ({ ...l, book: 2 }));
      setLessons(fallback);
      const target = pickInitialLesson(fallback) || { book: 2, lesson: 18 };
      selectLesson(target.book, target.lesson);
    });
    return () => { alive = false; };
  }, []);

  // 通过分享链接 #job=xxx 打开时，直接恢复该次生成结果（即使后端重启过，任务已持久化）
  useEffect(() => {
    const m = window.location.hash.match(/^#job=([A-Za-z0-9-]{8,64})/);
    if (!m) return;
    const jobId = m[1];
    getAnalyzeJob(jobId).then((r) => {
      if (r.job?.status === 'done' && r.job.data) {
        setResult(r.job.data);
        setCurrentJobId(jobId);
        setView('result');
        setError('');
      } else if (r.job?.status === 'error') {
        setError(r.job.error || '该任务生成失败');
      } else {
        setError('该结果仍在生成中，请稍后刷新查看');
      }
    }).catch(() => {
      // 后端任务已清理（重新部署/超 7 天）时，用本机缓存恢复
      const cached = loadResultCache(jobId);
      if (cached) {
        setResult(cached);
        setCurrentJobId(jobId);
        setView('result');
        setError('');
      } else {
        setError('任务不存在或已过期，请重新提交');
      }
    });
  }, []);

  const visibleLessons = useMemo(() => lessons.filter((l) => l.book === book), [lessons, book]);

  const selectLesson = async (nextBook, nextLesson, autoGenerate = false) => {
    setBook(nextBook);
    setLessonId(nextLesson);
    setMatchedLesson(null);
    setMode('lesson');
    setMatchConfidence('manual');
    setMatchScore(null);
    try {
      localStorage.setItem('bt-book', String(nextBook));
      localStorage.setItem('bt-lesson', String(nextLesson));
    } catch { /* ignore */ }
    try {
      const lesson = await getLesson(nextBook, nextLesson);
      setTitle(lessonLabel(lesson));
      setChinese(lesson.chinese || '');
      setDraft('');
      setGeneratedOriginal('');
      setMaterialKeywords([]);
      setMatchedLesson(lesson);
    } catch {
      setTitle(`Lesson ${nextLesson}`);
      setChinese('');
      setDraft('');
      setGeneratedOriginal('');
      setMaterialKeywords([]);
    }
    if (autoGenerate) setTimeout(() => runGenerate(nextLesson), 60);
  };

  const handleBookChange = (nextBook) => {
    const first = lessons.find((l) => l.book === nextBook);
    if (first) selectLesson(nextBook, first.lesson);
    else setBook(nextBook);
  };

  const handleDocx = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setParsing(true);
    try {
      const raw = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      const parsed = parseAssignmentText(raw.value);
      setFileName(file.name);
      setTitle(parsed.title);
      setChinese(parsed.chinese);
      setDraft(parsed.draft);
      setGeneratedOriginal('');
      setMaterialKeywords([]);
      const found = await matchLesson({ title: parsed.title, chinese: parsed.chinese });
      if (found?.match && found.confidence && found.confidence !== 'none' && found.confidence !== 'low') {
        setBook(found.match.book);
        setLessonId(found.match.lesson);
        setMatchedLesson(found.match);
        setMode('lesson');
        setTitle(lessonLabel(found.match));
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
    setMatchConfidence('manual');
    setMatchScore(null);
    try {
      localStorage.setItem('bt-book', String(matchedLesson.book));
      localStorage.setItem('bt-lesson', String(matchedLesson.lesson));
    } catch { /* ignore */ }
  };

  const handleGenerateMaterial = async () => {
    const topic = materialTopic.trim();
    if (!topic) { setError('请填写素材主题'); return; }
    setError(''); setMaterialBusy(true);
    const materialStart = Date.now();
    setMaterialElapsed(0);
    const materialTimer = setInterval(() => setMaterialElapsed(Math.floor((Date.now() - materialStart) / 1000)), 1000);
    try {
      const resp = await generateMaterial({
        topic, level: materialLevel, style: materialStyle,
        baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
      });
      const jobId = resp.jobId;
      if (!jobId) throw new Error('服务器未返回任务编号，请重试');
      const deadline = Date.now() + 10 * 60 * 1000;
      let pollFailures = 0;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        let r;
        try {
          r = await getMaterialJob(jobId);
          pollFailures = 0;
        } catch (e) {
          pollFailures += 1;
          if (pollFailures > 10) throw new Error('网络不稳定，暂时无法获取素材，请重试');
          continue;
        }
        const job = r.job;
        if (!job) continue;
        if (job.status === 'done') {
          const data = job.data || {};
          if (!data.original || !data.chinese) throw new Error('AI 返回内容不完整，请重试');
          setTitle(data.title || topic);
          setChinese(data.chinese);
          setDraft('');
          setGeneratedOriginal(data.original);
          setMaterialKeywords(data.keywords || []);
          setMatchedLesson(null);
          setMode('free');
          setMatchConfidence('none');
          setMatchScore(null);
          setMaterialOpen(false);
          return;
        }
        if (job.status === 'error') {
          throw new Error(job.error || '素材生成失败，请重试');
        }
      }
      throw new Error('生成素材超时（超过10分钟），请重新提交');
    } catch (e) {
      setError(e.message || '素材生成失败');
    } finally {
      clearInterval(materialTimer);
      setMaterialBusy(false);
    }
  };

  const addToHistory = (jobId, jobTitle, data, durationMs) => {
    saveResultCache(jobId, data);
    setHistoryList((prev) => {
      const next = [{ jobId, title: jobTitle || '回译作业', time: Date.now(), durationMs: Number(durationMs) || 0 }, ...prev.filter((x) => x.jobId !== jobId)].slice(0, 20);
      saveHistory(next);
      return next;
    });
  };

  const openHistoryModal = () => {
    setHistoryList(loadHistory());
    setHistoryOpen(true);
  };

  /* ---------- 收藏夹（本机保存，无需数据库） ---------- */
  const toggleFavorite = (item) => {
    if (!item || !item.id) return;
    const exists = favorites.some((x) => x.id === item.id);
    const next = exists
      ? favorites.filter((x) => x.id !== item.id)
      : [{ ...item, createdAt: Date.now() }, ...favorites];
    const ok = saveFavorites(next);
    setFavorites(next);
    setFavTip(exists ? '已取消收藏' : (ok ? '已收藏，可在右上角「收藏夹」随时复习' : '收藏失败：本机存储空间可能已满，请先导出备份'));
    setTimeout(() => setFavTip(''), 2600);
  };
  const removeFavorite = (id) => {
    const next = favorites.filter((x) => x.id !== id);
    saveFavorites(next);
    setFavorites(next);
  };
  const clearFavorites = () => {
    if (!favorites.length) return;
    if (!window.confirm('确定清空全部收藏？建议先「导出备份」。')) return;
    saveFavorites([]);
    setFavorites([]);
    setFavTip('已清空收藏');
    setTimeout(() => setFavTip(''), 2500);
  };
  const exportFavorites = () => {
    if (!favorites.length) { setFavTip('还没有收藏内容'); setTimeout(() => setFavTip(''), 2000); return; }
    const blob = new Blob([JSON.stringify({ app: 'back-translate-studio', exportedAt: new Date().toISOString(), favorites }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'retranslate-favorites-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setFavTip('已导出备份文件，请妥善保存');
    setTimeout(() => setFavTip(''), 3000);
  };
  const importFavorites = async (file) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const arr = Array.isArray(data) ? data : (Array.isArray(data && data.favorites) ? data.favorites : []);
      if (!arr.filter((x) => x && x.id && x.title).length) throw new Error('文件里没有可用的收藏数据');
      const { merged, added } = mergeFavorites(arr, favorites);
      const ok = saveFavorites(merged);
      setFavorites(merged);
      setFavTip('导入完成：新增 ' + added + ' 条' + (ok ? '' : '（本机存储可能已满）'));
    } catch (e) {
      setFavTip('导入失败：' + (e.message || '文件格式不正确'));
    }
    setTimeout(() => setFavTip(''), 4000);
  };
  const copyFavorites = async () => {
    if (!favorites.length) return;
    try { await navigator.clipboard.writeText(favoritesToText(favorites)); setFavTip('已复制全部收藏到剪贴板'); }
    catch { setFavTip('复制失败，请手动选择文本'); }
    setTimeout(() => setFavTip(''), 3000);
  };
  const visibleFavorites = filterFavorites(favorites, { kind: favKind, query: favQuery });

  /* ---------- 根据收藏生成自测题 ---------- */
  const generateQuiz = async () => {
    const pool = favKind === 'all' ? favorites : filterFavorites(favorites, { kind: favKind });
    if (!pool.length) { setFavTip('还没有可用于出题的收藏'); setTimeout(() => setFavTip(''), 2500); return; }
    setQuizBusy(true);
    setQuizTip('');
    setFavTip('');
    try {
      const resp = await quiz({
        points: favoritesToQuizPoints(pool),
        count: quizCount,
        level: polishLevel,
        baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
      });
      const jobId = resp.jobId;
      if (!jobId) throw new Error('服务器未返回任务编号，请重试');
      const deadline = Date.now() + 5 * 60 * 1000;
      let failures = 0;
      let data = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        let r;
        try { r = await getQuizJob(jobId); failures = 0; }
        catch (e) { failures += 1; if (failures > 8) throw new Error('网络不稳定，暂时无法获取题目'); continue; }
        const job = r.job;
        if (!job) continue;
        if (job.status === 'done') { data = job.data; break; }
        if (job.status === 'error') throw new Error(job.error || '生成失败');
      }
      if (!data || !Array.isArray(data.questions) || !data.questions.length) throw new Error('生成超时或题目为空，请重试');
      setQuizData(data);
      setQuizShowAnswers(true);
      setFavOpen(false);
      setView('quiz');
    } catch (e) {
      // AI 出题失败时用本地题库兜底，保证功能始终可用
      const local = buildLocalQuiz(pool, quizCount);
      if (local.questions.length) {
        setQuizData(local);
        setQuizShowAnswers(true);
        setQuizTip('AI 出题失败（' + (e.message || '未知错误') + '），已用本地题库兜底生成');
        setFavOpen(false);
        setView('quiz');
      } else {
        setFavTip('生成失败：' + (e.message || '未知错误'));
      }
    } finally {
      setQuizBusy(false);
      setTimeout(() => setFavTip(''), 4000);
    }
  };
  const copyQuiz = async () => {
    if (!quizData) return;
    try {
      await navigator.clipboard.writeText(quizToText(quizData, { withAnswers: quizShowAnswers }));
      setQuizTip('已复制题目' + (quizShowAnswers ? '（含答案）' : '（不含答案）'));
    } catch { setQuizTip('复制失败，请手动选择文本'); }
    setTimeout(() => setQuizTip(''), 2500);
  };
  const favoritedIds = useMemo(() => new Set(favorites.map((x) => x.id)), [favorites]);
  const favHandlers = useMemo(() => ({ has: (id) => favoritedIds.has(id), toggle: toggleFavorite }), [favoritedIds, favorites]);

  const loadHistoryJob = async (jobId) => {
    // 优先用本机缓存，秒开且不受服务器任务清理影响
    const cached = loadResultCache(jobId);
    if (cached) {
      setHistoryOpen(false);
      setResult(cached);
      setCurrentJobId(jobId);
      setView('result');
      setError('');
      window.history.replaceState(null, '', '#job=' + jobId);
      return;
    }
    try {
      const r = await getAnalyzeJob(jobId);
      const job = r.job;
      setHistoryOpen(false);
      if (job?.status === 'done' && job.data) {
        setResult(job.data);
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
      setHistoryOpen(false);
      // 服务器任务已过期/重新部署丢失时，尝试用本机缓存的结果兜底
      const cached = loadResultCache(jobId);
      if (cached) {
        setResult(cached);
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
    if (!currentJobId) { setShareTip('当前是离线示例，没有可分享的结果链接'); return; }
    const url = window.location.origin + window.location.pathname + '#job=' + currentJobId;
    try {
      await navigator.clipboard.writeText(url);
      setShareTip('分享链接已复制，可发给老师或同学');
      setError('');
      setTimeout(() => setShareTip(''), 4000);
    } catch {
      setShareTip('复制失败，请手动复制链接：' + url);
    }
  };

  /* ---------- 计时器 ---------- */
  const lessonKey = mode === 'lesson' ? `lesson:${book}-${lessonId}` : 'free';
  const elapsedMs = timer.accumulated + (timer.running && timer.startedAt ? Math.max(0, clockNow - timer.startedAt) : 0);

  // 每秒刷新一次显示（只在计时中走定时器，避免空转）
  useEffect(() => {
    if (!timer.running) return undefined;
    setClockNow(Date.now());
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer.running]);

  // 切换课文 / 模式时，自动归零重新计时
  useEffect(() => {
    setTimer((t) => {
      if (t.lessonKey === lessonKey) return t;
      const next = { running: false, startedAt: null, accumulated: 0, lessonKey };
      saveTimer(next);
      return next;
    });
  }, [lessonKey]);

  const toggleTimer = () => {
    setTimer((t) => {
      const now = Date.now();
      const next = t.running
        ? { ...t, running: false, accumulated: t.accumulated + Math.max(0, now - (t.startedAt || now)), startedAt: null, lessonKey }
        : { ...t, running: true, startedAt: now, lessonKey };
      saveTimer(next);
      setClockNow(now);
      return next;
    });
  };

  const resetTimer = () => {
    setTimer(() => {
      const next = { running: false, startedAt: null, accumulated: 0, lessonKey };
      saveTimer(next);
      return next;
    });
  };

  /* ---------- 拍照 / 图片识别 ---------- */
  const handleOcrFiles = async (side, files) => {
    const list = Array.from(files || []).filter((f) => f && /^image\//i.test(f.type || ''));
    if (!list.length) { setError('请选择图片文件（JPG / PNG / WEBP 等）'); return; }
    if (ocrBusy) return;
    setError('');
    setOcrBusy(side);
    setOcrNotes((n) => ({ ...n, [side]: '正在准备图片…' }));
    try {
      const texts = [];
      for (let i = 0; i < list.length; i += 1) {
        setOcrNotes((n) => ({ ...n, [side]: `正在识别第 ${i + 1}/${list.length} 张…（约 5-30 秒）` }));
        const image = await prepareImage(list[i], ocrMode);
        const resp = await ocr({
          image, side, mode: ocrMode,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
          visionModel: settings.visionModel,
        });
        const jobId = resp.jobId;
        if (!jobId) throw new Error('服务器未返回任务编号，请重试');
        const deadline = Date.now() + 3 * 60 * 1000;
        let text = '';
        let failures = 0;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          let r;
          try { r = await getOcrJob(jobId); failures = 0; }
          catch (err) { failures += 1; if (failures > 8) throw new Error('网络不稳定，暂时无法获取识别结果，请重试'); continue; }
          const job = r.job;
          if (!job) continue;
          if (job.status === 'done') { text = (job.data && job.data.text) || ''; break; }
          if (job.status === 'error') throw new Error(job.error || '图片识别失败');
        }
        if (!text) throw new Error('识别超时（超过 3 分钟），请换更清晰的照片或重新拍一张');
        texts.push(text);
      }
      const merged = texts.join('\n\n');
      const apply = side === 'chinese' ? setChinese : setDraft;
      apply((prev) => (prev && prev.trim() ? prev.replace(/\s+$/, '') + '\n\n' + merged : merged));
      setOcrNotes((n) => ({ ...n, [side]: `识别完成：${merged.length} 字，已${side === 'chinese' ? '填入中文提示' : '追加到英文初稿'}，请核对后再生成` }));
    } catch (e) {
      setOcrNotes((n) => ({ ...n, [side]: '识别失败：' + (e.message || '未知错误') }));
    } finally {
      setOcrBusy(null);
    }
  };

  const openCamera = async (side) => {
    setCamError('');
    const fallbackInput = side === 'chinese' ? chineseCamRef.current : englishCamRef.current;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fallbackInput?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
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
    setError(''); setBusy(true);
    // 点击生成时定格用时（本次练习从开始计时到提交用掉的时长）
    const durationMs = timer.accumulated + (timer.running && timer.startedAt ? Math.max(0, Date.now() - timer.startedAt) : 0);
    setProgressStep(1); setProgressMsg('正在提交后台任务…'); startProgressTimer();
    let finishedOk = false;
    try {
      const resp = await analyze({
        title: title.trim(), chinese: cn, draft: df,
        book: mode === 'lesson' ? book : undefined,
        lessonId: mode === 'lesson' ? id : undefined,
        original: mode === 'free' ? (generatedOriginal || undefined) : undefined,
        level: polishLevel,
        baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
      });
      const jobId = resp.jobId;
      if (!jobId) {
        if (resp.data) { setResult(resp.data); setView('result'); return; }
        throw new Error('服务器未返回任务编号，请重试');
      }
      setProgressStep(2); setProgressMsg('AI 正在后台生成（约1-2分钟）…');
      const deadline = Date.now() + 10 * 60 * 1000;
      let pollFailures = 0;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        let r;
        try {
          r = await getAnalyzeJob(jobId);
          pollFailures = 0;
        } catch (e) {
          pollFailures += 1;
          if (pollFailures > 10) throw new Error('网络不稳定，暂时无法获取生成结果，请重试');
          continue;
        }
        const job = r.job;
        if (!job) continue;
        if (job.status === 'done') {
          setProgressStep(3); setProgressMsg('生成完成'); finishedOk = true;
          const enriched = { ...(job.data || {}), durationMs };
          setResult(enriched);
          setCurrentJobId(jobId);
          setView('result');
          addToHistory(jobId, job.data?.title || title, enriched, durationMs);
          window.history.replaceState(null, '', '#job=' + jobId);
          return;
        }
        if (job.status === 'error') {
          throw new Error(job.error || '生成失败，请重试');
        }
        if (job.status === 'running') {
          setProgressStep(2); setProgressMsg('AI 正在后台生成（约1-2分钟）…');
        }
      }
      throw new Error('生成超时（超过10分钟），请重新提交');
    } catch (e) {
      setError(e.message);
      setView('editor');
    } finally {
      stopProgressTimer();
      setBusy(false);
      if (!finishedOk) { setProgressStep(0); setProgressMsg(''); }
    }
  };

  const loadDemo = () => {
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
    await navigator.clipboard.writeText(text);
  };

  const onSaveSettings = () => { saveSettings(settings); refreshStatus(); setSettingsOpen(false); };

  return (
    <div className="app">
      {sidebarOpen && <div className="sidebar-backdrop" onClick={toggleSidebar} aria-hidden="true" />}
      <aside className={'sidebar' + (sidebarOpen ? '' : ' collapsed')}>
        <button className="sidebar-close" onClick={toggleSidebar} aria-label="收起侧栏"><X size={18} /></button>
        <div className="brand"><div className="brand-mark">回</div><div><strong>回译本</strong><span>BACK-TRANSLATE STUDIO</span></div></div>
        <button className="primary-btn" onClick={() => { closeSidebarOnMobile(); setView('editor'); setResult(null); }}><Plus size={16} />新建回译作业</button>
        <div className="side-section">
          <div className="side-title">课文库</div>
          <div className="book-tabs">
            {[1, 2, 3, 4].map((n) => <button key={n} className={book === n ? 'active' : ''} onClick={() => handleBookChange(n)}>新概念 {n}</button>)}
          </div>
          <div className="lesson-list">
            {visibleLessons.length === 0 && <div className="muted">正在加载语料…</div>}
            {visibleLessons.map((l) => (
              <button key={`${l.book}-${l.lesson}`} className={'lesson-item' + (lessonId === l.lesson && book === l.book && mode === 'lesson' ? ' active' : '')}
                onClick={() => { closeSidebarOnMobile(); selectLesson(l.book, l.lesson); }}>
                <span className="lesson-no">{String(l.lesson).padStart(2, '0')}</span>
                <span className="lesson-title">{l.title_cn || l.title_en || 'Lesson ' + l.lesson}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="side-footer">
          <button className="ghost-btn" onClick={() => setSettingsOpen(true)}><Settings size={15} />AI 设置</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="icon-btn side-toggle" onClick={toggleSidebar} title={sidebarOpen ? '收起侧栏' : '展开侧栏'} aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}>
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <div className="topbar-left"><BookOpen size={18} /><strong>{mode === 'lesson' ? '课文回译训练' : '自由回译训练'}</strong></div>
          <div className="status-chip" title={status ? (status.model + ' @ ' + status.baseUrl) : '请先启动后端 npm run server'}>
            <span className={'dot ' + (status ? 'ok' : 'err')} />
            {status ? ((status.hasKey || settings.apiKey) ? 'AI 已配置 · ' + status.model : '未配置 API Key · ' + status.model) : '后端未连接'}
            {status?.corpusLessons ? ' · ' + status.corpusLessons + ' 课' : ''}
          </div>
          <button className="ghost-btn" onClick={() => { setView('editor'); setResult(null); }}><X size={15} />编辑器</button>
          <button className="ghost-btn" onClick={openHistoryModal}><History size={15} />历史结果{historyList.length ? ` (${historyList.length})` : ''}</button>
          <button className="ghost-btn" onClick={() => setFavOpen(true)}><Star size={15} />收藏夹{favorites.length ? ` (${favorites.length})` : ''}</button>
        </header>
        {favTip ? <div className="fav-tip">{favTip}</div> : null}

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
              <label className="ocr-mode-wrap">润色等级
                <select className="ocr-mode" value={polishLevel} onChange={(e) => { setPolishLevel(e.target.value); localStorage.setItem(LEVEL_KEY, e.target.value); }} title="AI 润色版、高级句式与推荐表达都会匹配该考试难度">
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
                <span className="match-text">已识别可能有课文：新概念英语第 {matchedLesson.book} 册 · Lesson {matchedLesson.lesson} · {matchedLesson.title_en}（{CONFIDENCE_LABEL[matchConfidence] || matchConfidence || '未匹配'}{matchScore != null ? ` · 匹配分 ${matchScore}` : ''}）{mode === 'free' ? '，当前按自由模式' : '，原文将自动带入分析'}</span>
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
              <div className="title-field"><label>作业标题</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：新概念2 lesson 11" /></div>
              <div className={'timer-box' + (timer.running ? ' running' : '')}>
                <Timer size={16} />
                <strong className="timer-display" title="本次练习用时">{formatDuration(elapsedMs)}</strong>
                <button className="ghost-btn sm" onClick={toggleTimer}>
                  {timer.running ? '暂停' : (elapsedMs > 0 ? '继续' : '开始计时')}
                </button>
                <button className="ghost-btn sm" onClick={resetTimer} disabled={elapsedMs === 0 && !timer.running}>重置</button>
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
                <input ref={chineseCamRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files; e.target.value = ''; handleOcrFiles('chinese', f); }} />
                <input ref={chineseFileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = e.target.files; e.target.value = ''; handleOcrFiles('chinese', f); }} />
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
                <input ref={englishCamRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files; e.target.value = ''; handleOcrFiles('english', f); }} />
                <input ref={englishFileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = e.target.files; e.target.value = ''; handleOcrFiles('english', f); }} />
              </div>
            </div>
            {error && <div className="error-banner"><Flame size={15} /><span className="error-text">{error}</span><button className="link" onClick={loadDemo}>查看离线示例</button><button className="icon-btn err-close" onClick={() => setError('')} aria-label="关闭提示"><X size={15} /></button></div>}
            <div className="actions-bar">
              <button className="primary-btn big" onClick={() => runGenerate()} disabled={busy || parsing}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <WandSparkles size={17} />}
                {busy ? 'AI 正在后台生成（约1-2分钟）…' : '生成完整回译训练作业'}
              </button>
              {!status?.hasKey && <button className="ghost-btn" onClick={loadDemo}><Sparkles size={15} />离线示例</button>}
              <span className="muted">{busy ? '已提交后台任务，请保持页面打开，完成后自动展示' : '生成顺序：标题 → 中文 → 原稿 → AI 修正版 → 原文 → 逐句解析'}</span>
            </div>
            {busy && (
              <div className="progress-box">
                <div className="progress-steps">
                  <span className={progressStep >= 1 ? 'active' : ''}><CheckCircle2 size={12} />已提交</span>
                  <span className={progressStep >= 2 ? 'active' : ''}><LoaderCircle className={progressStep === 2 ? 'spin' : ''} size={12} />AI 生成中</span>
                  <span className={progressStep >= 3 ? 'active' : ''}><CheckCircle2 size={12} />完成</span>
                </div>
                <div className="progress-track"><div className="progress-fill" style={{ width: progressStep >= 3 ? '100%' : progressStep >= 2 ? '66%' : '18%' }} /></div>
                <span className="muted small">{progressMsg}{elapsed > 0 ? ` · 已进行 ${elapsed} 秒` : ''}</span>
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
            {result && <ResultSheet result={result} onBack={() => setView('editor')} onCopy={copyAll} onShare={shareResult} shareTip={shareTip} fav={favHandlers} />}
          </section>
        )}
      </main>

      {camOpen && (
        <div className="modal-mask" onClick={closeCamera}>
          <div className="modal cam-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>拍照识别 · {camSide === 'chinese' ? '中文提示' : '英文初稿'}</h2><button className="icon-btn" onClick={closeCamera}><X size={16} /></button></div>
            <video ref={camVideoRef} className="cam-video" playsInline muted autoPlay />
            {camError ? <p className="muted small cam-err">{camError}</p> : null}
            <p className="muted small">把纸张放平、光线充足、尽量让文字填满画面；手写体建议先把「识别模式」设为「手写体优先」。</p>
            <div className="modal-actions">
              <button className="primary-btn" onClick={snapPhoto}><Camera size={16} />拍照并识别</button>
              <button className="ghost-btn" onClick={() => { const side = camSide; closeCamera(); (side === 'chinese' ? chineseCamRef : englishCamRef).current?.click(); }}>从相册选择</button>
            </div>
          </div>
        </div>
      )}

      {materialOpen && (
        <div className="modal-mask" onClick={() => !materialBusy && setMaterialOpen(false)}>
          <div className="modal material-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>AI 生成训练素材</h2><button className="icon-btn" onClick={() => setMaterialOpen(false)} disabled={materialBusy}><X size={16} /></button></div>
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

      {historyOpen && (
        <div className="modal-mask" onClick={() => setHistoryOpen(false)}>
          <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>历史作业</h2><button className="icon-btn" onClick={() => setHistoryOpen(false)}><X size={16} /></button></div>
            {historyList.length === 0 ? <p className="muted">暂无历史记录。生成一次完整分析后，记录会自动保存在这里；此功能上线前生成的旧作业不会自动补录。</p> : (
              <div className="history-list">
                {historyList.map((h) => (
                  <button className="history-item" key={h.jobId} onClick={() => loadHistoryJob(h.jobId)}>
                    <span className="history-info"><strong>{h.title || '回译作业'}</strong><span className="muted small">{formatTime(h.time)}{h.durationMs ? ` · 用时 ${formatDuration(h.durationMs)}` : ''}</span></span>
                    <span className="history-link">查看结果</span>
                  </button>
                ))}
              </div>
            )}
            <p className="muted small">历史记录保存在当前浏览器；每次结果也会持久化在后端 7 天，可通过分享链接在任何设备打开。</p>
          </div>
        </div>
      )}

      {favOpen && (
        <div className="modal-mask" onClick={() => setFavOpen(false)}>
          <div className="modal fav-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>收藏夹（{favorites.length}）</h2><button className="icon-btn" onClick={() => setFavOpen(false)}><X size={16} /></button></div>
            <div className="fav-toolbar">
              <input className="fav-search" value={favQuery} onChange={(e) => setFavQuery(e.target.value)} placeholder="搜索单词、短语或解释…" />
              <select className="ocr-mode" value={favKind} onChange={(e) => setFavKind(e.target.value)}>
                <option value="all">全部</option>
                <option value="finding">错题 / 辨析</option>
                <option value="vocab">核心词</option>
                <option value="idiom">习语</option>
                <option value="expression">加分表达</option>
              </select>
            </div>
            {favorites.length === 0 ? (
              <p className="muted">还没有收藏。在作业结果里点每条知识点右上角的 ☆ 就能收藏，之后在这里直接复习，不用再打开整份作业。</p>
            ) : visibleFavorites.length === 0 ? (
              <p className="muted">没有匹配的收藏。</p>
            ) : (
              <div className="fav-list">
                {visibleFavorites.map((x) => (
                  <div className="fav-item" key={x.id}>
                    <div className="fav-item-head">
                      <span className="fav-kind">{FAV_KIND_LABEL[x.kind] || x.kind}</span>
                      {x.category ? <span className="fav-cat">{x.category}</span> : null}
                      {x.level ? <span className={'fav-level ' + x.level}>{LEVEL_LABEL[x.level] || x.level}</span> : null}
                      <span className="fav-date">{formatTime(x.createdAt)}</span>
                      <button className="icon-btn fav-del" onClick={() => removeFavorite(x.id)} title="删除这条收藏"><Trash2 size={14} /></button>
                    </div>
                    <div className="fav-title">{x.title}</div>
                    {x.body ? <div className="fav-body">{x.body}</div> : null}
                    {x.extra ? <div className="fav-extra">{x.extra}</div> : null}
                    {x.source ? <div className="fav-source">来自：{x.source}{x.sourceLevel ? ' · 润色等级 ' + x.sourceLevel : ''}</div> : null}
                  </div>
                ))}
              </div>
            )}
            <div className="fav-quiz">
              <div className="fav-quiz-title">根据收藏自测</div>
              <div className="fav-quiz-row">
                <label className="fav-quiz-count">题目数量
                  <select className="ocr-mode" value={quizCount} onChange={(e) => setQuizCount(Number(e.target.value))}>
                    {[5, 10, 15, 20, 30, 50].map((n) => <option key={n} value={n}>{n} 题</option>)}
                  </select>
                </label>
                <button className="primary-btn" onClick={generateQuiz} disabled={quizBusy || !favorites.length}>
                  {quizBusy ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}
                  {quizBusy ? 'AI 正在出题…' : '生成自测题'}
                </button>
              </div>
              <p className="muted small">按当前筛选范围出题（{favKind === 'all' ? '全部收藏' : (FAV_KIND_LABEL[favKind] || favKind)}），难度跟随「润色等级 {polishLevel}」；生成后点「导出 PDF」即可打印，答案统一印在最后。</p>
            </div>
            <div className="fav-footer">
              <button className="ghost-btn sm" onClick={exportFavorites}><Download size={14} />导出备份</button>
              <button className="ghost-btn sm" onClick={() => favFileRef.current?.click()}><Upload size={14} />导入备份</button>
              <button className="ghost-btn sm" onClick={copyFavorites} disabled={!favorites.length}><ClipboardCopy size={14} />复制全部</button>
              <button className="ghost-btn sm" onClick={clearFavorites} disabled={!favorites.length}><Trash2 size={14} />清空</button>
              <input ref={favFileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; importFavorites(f); }} />
            </div>
            <p className="muted small">收藏保存在<b>本机浏览器</b>（不依赖数据库）。清除浏览器数据、换浏览器 / 设备、或更换域名都会导致收藏丢失，建议定期「导出备份」。</p>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>AI 接入设置</h2><button className="icon-btn" onClick={() => setSettingsOpen(false)}><X size={16} /></button></div>
            <label>Base URL（OpenAI 兼容）<input value={settings.baseUrl || 'https://api.deepseek.com/v1'} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" /></label>
            <label>模型名<input value={settings.model || 'deepseek-chat'} onChange={(e) => setSettings({ ...settings, model: e.target.value })} placeholder="deepseek-chat / gpt-4o-mini / qwen-plus" /></label>
            <label>视觉模型（可选，拍照/图片识别用）<input value={settings.visionModel || ''} onChange={(e) => setSettings({ ...settings, visionModel: e.target.value })} placeholder="deepseek-flash（DeepSeek 已原生支持图片）" /></label>
            <label>API Key<input type="password" value={settings.apiKey || ''} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} placeholder="sk-..." /></label>
            <p className="muted small">拍照识别用「视觉模型」：DeepSeek 的 <strong>deepseek-flash</strong> 已原生支持图片输入，留空时 DeepSeek 接口会自动使用它；其他厂商请填对应的多模态模型（如 gpt-4o-mini / qwen-vl-max）。Key 只保存在本机浏览器 localStorage（仅你自己可见）；想让所有访问者免填 Key，请在部署平台的环境变量里配置 AI_API_KEY / AI_VISION_MODEL。</p>
            <div className="modal-actions"><button className="primary-btn" onClick={onSaveSettings}>保存并重连</button><button className="ghost-btn" onClick={() => setSettingsOpen(false)}>取消</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultSheet({ result, onBack, onCopy, onShare, shareTip, fav }) {
  const overall = result.overall || {};
  const sentences = result.sentences || [];
  const allFindings = sentences.flatMap((s) => s.findings || []);
  return (
    <div className="result-sheet">
      <div className="result-toolbar">
        <button className="ghost-btn" onClick={onBack}><ArrowLeft size={15} />返回编辑</button>
        <button className="ghost-btn" onClick={onCopy}><ClipboardCopy size={15} />复制全部</button>
        <button className="ghost-btn" onClick={onShare}><Link2 size={15} />复制分享链接</button>
        <button className="ghost-btn" onClick={() => window.print()}><Download size={15} />导出 PDF</button>
        {shareTip ? <span className="share-tip">{shareTip}</span> : null}
      </div>
      <article className="sheet">
        <header className="sheet-title"><span className="eyebrow">BACK-TRANSLATE TRAINING · 回译训练作业</span><h1>{result.title}</h1>
          {result.aiLevel ? <span className="sheet-duration">润色等级 {result.aiLevel}</span> : null}
          {result.durationMs ? <span className="sheet-duration">本次练习用时 {formatDuration(result.durationMs)}</span> : null}
        </header>
        <Section label="中文" tone="cn"><p>{result.chinese}</p></Section>
        <Section label="原稿" tone="draft" note="红色标记 = 必须改正的错误（纯润色升级不再标线，可在下方逐句解析里对照学习）"><p><DraftText text={result.draft} findings={allFindings} /></p></Section>
        <Section label="AI 修正版" tone="ai"><p>{result.ai}</p></Section>
        <Section label="原文" tone="original"><p>{result.original || '（自由模式：未匹配到课文原文）'}</p></Section>
        <section className="sheet-section analysis">
          <div className="section-heading"><span className="label-dot" /><h2>逐句解析与三版本对比</h2><span className="muted small">{sentences.length} 个句群 · {overall.issues ?? 0} 项分析</span></div>
          <div className="overall-card">
            <div className="score-ring"><strong>{overall.score ?? '-'}</strong><span>综合评分</span></div>
            <div className="overall-body">
              <p>{overall.summary || ''}</p>
              <div className="chips">{(overall.highlights || []).map((h, i) => <span key={'hl' + i} className="chip"><CheckCircle2 size={13} />{h}</span>)}</div>
              <div className="advice"><strong>练习建议</strong><ul>{(overall.advice || []).map((a, i) => <li key={'ad' + i}>{a}</li>)}</ul></div>
              {Array.isArray(overall.scoreBreakdown) && overall.scoreBreakdown.length ? (
                <div className="score-breakdown">
                  <div className="score-breakdown-title">分项得分</div>
                  {overall.scoreBreakdown.map((b, i) => {
                    const max = Number(b.max) || 20;
                    const pct = Math.max(0, Math.min(100, (Number(b.score) || 0) / max * 100));
                    return (
                      <div key={'sb' + i}>
                        <div className="score-row">
                          <span className="score-label">{b.label}</span>
                          <div className="score-track"><div className="score-fill" style={{ width: pct + '%' }} /></div>
                          <span className="score-num">{b.score}/{max}</span>
                        </div>
                        {b.comment ? <div className="score-comment">{b.comment}</div> : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
          {sentences.map((sentence, i) => <SentenceCard key={'s' + i} index={i} sentence={sentence} result={result} fav={fav} />)}
        </section>
        <VocabularyNotes items={result.vocabularyNotes} result={result} fav={fav} />
        <IdiomHighlights items={result.idiomHighlights} result={result} fav={fav} />
        <section className="sheet-section summary">
          <div className="section-heading"><span className="label-dot" /><h2>学习总结 · 可学习的高级句式与加分表达</h2></div>
          <SummaryBlock title="高级句式" tone="teal" items={result.advancedSentences} result={result} fav={fav} />
          <SummaryBlock title="加分表达" tone="gold" items={result.bonusExpressions} result={result} fav={fav} />
        </section>
      </article>
    </div>
  );
}

function Section({ label, tone, note, children }) {
  return <section className={'sheet-section v-' + tone}><div className="section-heading"><span className="label-dot" /><h2>{label}</h2>{note ? <span className="section-note">{note}</span> : null}</div>{children}</section>;
}

function SentenceCard({ index, sentence, result, fav }) {
  const findings = sentence.findings || [];
  return (
    <div className="sentence-card">
      <div className="sentence-head"><span className="sentence-index">{String(index + 1).padStart(2, '0')}</span><p className="sentence-cn">{sentence.cn}</p><span className="finding-count">{findings.length} 项</span></div>
      <div className="versions">
        <VersionRow label="原稿" tone="draft" text={<DraftText text={sentence.draft} findings={findings} />} />
        <VersionRow label="AI 修正版" tone="ai" text={sentence.ai} />
        {sentence.original ? <VersionRow label="课文原文" tone="original" text={sentence.original} /> : null}
      </div>
      <div className="findings">
        {findings.map((finding, i) => {
          const favItem = fav ? favFromFinding(finding, result) : null;
          return (
            <div className={'finding level-' + (finding.level || 'error')} key={'f' + i}>
              <div className="finding-top">
                <span className={'cat cat-' + (CATEGORY_COLOR[finding.category] || 'gray')}>{finding.category}</span>
                <span className="level">{LEVEL_LABEL[finding.level] || finding.level}</span>
                {fav ? <FavStar active={fav.has(favItem.id)} onToggle={() => fav.toggle(favItem)} /> : null}
              </div>
              <div className="finding-diff"><span className="from">{finding.from}</span><span className="arrow">→</span><strong className="to">{finding.to}</strong></div>
              <p className="finding-exp">{finding.explanation}</p>
              <FindingExtras finding={finding} />
            </div>
          );
        })}
        {findings.length === 0 && <div className="muted small">该句未发现明显问题。</div>}
      </div>
    </div>
  );
}

function VersionRow({ label, tone, text }) {
  return <div className={'v-row ' + tone}><span className="v-label">{label}</span><p>{text}</p></div>;
}

function VocabularyNotes({ items, result, fav }) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!arr.length) return null;
  return (
    <section className="sheet-section vocab">
      <div className="section-heading"><span className="label-dot" /><h2>词汇深度辨析</h2><span className="muted small">{arr.length} 组核心词 · 六大维度拆解</span></div>
      {arr.map((v, i) => {
        const dims = Array.isArray(v.dimensions) ? v.dimensions : [];
        const syns = Array.isArray(v.synonyms) ? v.synonyms : [];
        const exs = Array.isArray(v.examples) ? v.examples : [];
        const favItem = fav ? favFromVocab(v, result) : null;
        return (
          <div className="vocab-card" key={'vn' + i}>
            <div className="vocab-head">
              <strong className="vocab-word">{v.word}</strong><Phonetic word={v.word} phonetic={v.phonetic} />{v.type ? <span className="vocab-type">{v.type}</span> : null}
              {fav ? <FavStar active={fav.has(favItem.id)} onToggle={() => fav.toggle(favItem)} /> : null}
            </div>
            {v.meaning ? <p className="vocab-meaning">{v.meaning}</p> : null}
            {hasMorphology(v.morphology) ? (
              <div className="vocab-morph">
                {typeof v.morphology === 'string'
                  ? <div className="morph-line">🧩 {v.morphology}</div>
                  : (
                    <>
                      {v.morphology.parts ? <div className="morph-line">🧩 {v.morphology.parts}</div> : null}
                      {v.morphology.image ? <div className="morph-line morph-image">💡 {v.morphology.image}</div> : null}
                      {v.morphology.family ? <div className="morph-line morph-family">同根：{v.morphology.family}</div> : null}
                    </>
                  )}
              </div>
            ) : null}
            {dims.length ? <div className="dim-chips">{dims.map((d, j) => <span className="dim-chip" key={'vd' + j}>{d}</span>)}</div> : null}
            {syns.length ? <div className="syn-block"><span className="ext-label">近义词对比</span><div className="syn-list">{syns.map((s, j) => <SynRow key={'vs' + j} s={s} />)}</div></div> : null}
            {exs.length ? <div className="ex-block"><span className="ext-label">例句</span>{exs.map((x, j) => <div className="example-line" key={'ve' + j}><em>{x?.en || x?.example || ''}</em>{x?.cn ? <span>{x.cn}</span> : null}</div>)}</div> : null}
            {v.note ? <p className="vocab-note">{v.note}</p> : null}
          </div>
        );
      })}
    </section>
  );
}

function IdiomHighlights({ items, result, fav }) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!arr.length) return null;
  return (
    <section className="sheet-section idiom">
      <div className="section-heading"><span className="label-dot" /><h2>地道习语强化</h2><span className="muted small">{arr.length} 条 · 写作与口语加分素材</span></div>
      {arr.map((id, i) => {
        const favItem = fav ? favFromIdiom(id, result) : null;
        return (
          <div className="idiom-card" key={'ih' + i}>
            <div className="idiom-head">
              <span className="idiom-badge">习语</span><strong>{id.idiom}</strong>{id.situation ? <span className="idiom-situation">{id.situation}</span> : null}
              {fav ? <FavStar active={fav.has(favItem.id)} onToggle={() => fav.toggle(favItem)} /> : null}
            </div>
            {id.common ? <div className="idiom-common">普通说法：{id.common}</div> : null}
            {id.example ? <div className="idiom-example">{id.example}</div> : null}
            {id.explanation ? <p className="idiom-exp">{id.explanation}</p> : null}
          </div>
        );
      })}
    </section>
  );
}

function SummaryBlock({ title, tone, items, result, fav }) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return null;
  return (
    <div className="summary-block">
      <h3 className={'summary-title ' + tone}>{title}</h3>
      {arr.map((item, i) => {
        const s = typeof item === 'string' ? item : JSON.stringify(item);
        const parts = s.split(/[·•]\s*中文[点说]/i);
        const favItem = fav ? favFromExpression(item, result, title) : null;
        return (
          <div className={'summary-card ' + tone} key={'sm' + tone + i}>
            <div className="summary-head">
              <p className="summary-quote">{parts[0].trim()}</p>
              {fav ? <FavStar active={fav.has(favItem.id)} onToggle={() => fav.toggle(favItem)} /> : null}
            </div>
            {parts[1] ? <p className="summary-tip">中文点拨：{parts[1].trim()}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- 收藏知识点自测题 ---------- */
function QuizSheet({ quiz, showAnswers, onToggleAnswers, onBack, onBackToFav, onCopy, tip }) {
  const qs = quiz && Array.isArray(quiz.questions) ? quiz.questions : [];
  return (
    <div className="result-sheet quiz-sheet">
      <div className="result-toolbar">
        <button className="ghost-btn" onClick={onBack}><ArrowLeft size={15} />返回编辑</button>
        <button className="ghost-btn" onClick={onBackToFav}><Star size={15} />收藏夹</button>
        <button className="ghost-btn" onClick={onToggleAnswers}>{showAnswers ? '隐藏答案' : '显示答案'}</button>
        <button className="ghost-btn" onClick={onCopy}><ClipboardCopy size={15} />复制题目</button>
        <button className="ghost-btn" onClick={() => window.print()}><Download size={15} />导出 PDF</button>
        {tip ? <span className="share-tip">{tip}</span> : null}
      </div>
      <article className="sheet">
        <header className="sheet-title">
          <span className="eyebrow">SELF-CHECK QUIZ · 收藏知识点自测</span>
          <h1>{quiz.title}</h1>
          <span className="sheet-duration">共 {qs.length} 题{quiz.local ? ' · 本地兜底生成' : ''}{quiz.level ? ' · 润色等级 ' + quiz.level : ''}</span>
        </header>
        <p className="quiz-hint">先自己做完，再点「显示答案」对照；导出 PDF 时答案会统一印在最后。</p>
        <ol className="quiz-list">
          {qs.map((q, i) => (
            <li className="quiz-item" key={'q' + i}>
              <div className="quiz-head">
                <span className="quiz-no">{i + 1}</span>
                <span className="quiz-type">{q.type || '问答'}</span>
                {q.source ? <span className="quiz-src">考点：{q.source}</span> : null}
              </div>
              <div className="quiz-question">{q.question}</div>
              {Array.isArray(q.options) && q.options.length ? (
                <ul className="quiz-options">{q.options.map((o, j) => <li key={'o' + j}>{o}</li>)}</ul>
              ) : null}
              {showAnswers ? (
                <div className="quiz-answer">
                  <div><strong>答案：</strong>{q.answer}</div>
                  {q.explanation ? <div className="quiz-exp"><strong>解析：</strong>{q.explanation}</div> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        {!qs.length ? <p className="muted">还没有题目，请先在收藏夹里收藏一些知识点再生成。</p> : null}
      </article>
    </div>
  );
}

export default App;
