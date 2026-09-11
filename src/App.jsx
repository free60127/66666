import React, { useEffect, useMemo, useRef, useState } from 'react';
// mammoth（894 KB 源码）只在"上传 DOCX"这一个功能里用到，
// 改为 handleDocx 内动态 import，避免它被打进首屏主包。
import {
  ArrowLeft, BookOpen, Camera, CheckCircle2, ChevronDown, ChevronRight, ClipboardCopy, Cloud, Copy, Download,
  FileText, Flame, FolderPlus, History, ImagePlus, Library, Link2, LoaderCircle, PanelLeftClose, PanelLeftOpen,
  PenLine, Plus, Settings, Sparkles, Star, Timer, Trash2, Upload, WandSparkles, X,
} from 'lucide-react';
import { createLibrary, loadLibraries, mergeLibraries, removeLesson, removeLibrary, saveLibraries, upsertLesson } from './lessonLibrary.js';
import { createNewSyncCode, loadSyncCode, loadSyncMeta, mergeHistory, saveSyncCode, saveSyncMeta, syncOnce } from './sync.js';
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
const AI_LEVELS = ['小初', '高考英语', '四六级', '考研/专四', '专八'];
const DEFAULT_AI_LEVEL = '四六级';
const LEVEL_KEY = 'bt-polish-level';
// 「考研英语」「专四」已合并为「考研/专四」：本机旧设置里可能还是旧值，读出来先归一化，避免被静默降级成默认等级
const LEVEL_ALIASES = { 考研英语: '考研/专四', 专四: '考研/专四' };
const CONFIDENCE_LABEL = { high: '高置信度', medium: '中置信度', low: '低置信度', none: '未匹配', manual: '手动选择' };
/* ---------- 本机存储统一入口 ----------
 * 裸调 localStorage 在 Safari 无痕 / 禁用站点数据 / 被 iframe 嵌入时会抛 SecurityError，
 * 而这些调用出现在首次 render 的惰性初始化里 —— 一抛就是整页白屏，且没有任何降级路径。 */
function safeGet(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch { return fallback; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function loadHistory() {
  try {
    const arr = JSON.parse(safeGet(HISTORY_KEY, '[]'));
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch { return []; }
}
function saveHistory(arr) {
  safeSet(HISTORY_KEY, JSON.stringify(arr.slice(0, 20)));
}
const RESULT_KEY_PREFIX = 'bt-result-';
function loadResultCache(jobId) {
  try {
    const raw = safeGet(RESULT_KEY_PREFIX + jobId, '');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
/**
 * 结果缓存淘汰：只保留最近的历史条目对应的结果。
 * 原来每生成一次写一份、永不删除（单份几十~上百 KB），几十次练习后 5MB 配额写满，
 * 之后所有 setItem 都会静默失败（表现为"保存没反应""切等级报错"）。
 */
function pruneResultCache(keepJobIds) {
  const keep = new Set((keepJobIds || []).filter(Boolean).map((id) => RESULT_KEY_PREFIX + id));
  keep.add(RESULT_KEY_PREFIX);
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(RESULT_KEY_PREFIX) && !keep.has(key)) localStorage.removeItem(key);
    }
  } catch { /* ignore */ }
}
function saveResultCache(jobId, data) {
  if (!jobId || !data) return;
  if (safeSet(RESULT_KEY_PREFIX + jobId, JSON.stringify(data))) return;
  pruneResultCache([jobId]); // 配额写满：清掉其它结果缓存再试一次（历史/收藏不动）
  safeSet(RESULT_KEY_PREFIX + jobId, JSON.stringify(data));
}

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
const OCR_MODE_LABEL = { auto: '自动识别', handwriting: '手写体优先', printed: '印刷体优先' };
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
/**
 * 独立的计时显示组件。
 * 原来"当前时刻"是 App 的状态，计时中每秒 setState 会让整个 App 重渲染一次
 * （55 个 useState + 收藏筛选 + 全部句子卡片/DraftText）。拆成叶子组件后只有它自己每秒重渲染。
 */
function ElapsedDisplay({ timer }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timer.running || !timer.startedAt) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer.running, timer.startedAt]);
  const ms = timer.accumulated + (timer.running && timer.startedAt ? Math.max(0, now - timer.startedAt) : 0);
  return <>{formatDuration(ms)}</>;
}

/**
 * 统一的异步任务轮询。
 * 分析 / 素材 / 自测题 / OCR 四处原来各写了一份逐字重复的循环（sleep→取任务→失败计数→
 * deadline→done/error），差别只有间隔、超时和文案。合并到这里，行为保持一致。
 * @returns {Promise<{data?: any, aborted?: true}>} 组件已卸载时返回 { aborted: true }
 */
async function pollJob({ jobId, fetchJob, intervalMs, timeoutMs, maxFailures, netError, timeoutError, onProgress, isAlive }) {
  const deadline = Date.now() + timeoutMs;
  let failures = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (isAlive && !isAlive()) return { aborted: true };
    let r;
    try {
      r = await fetchJob(jobId);
      failures = 0;
    } catch {
      failures += 1;
      if (failures > maxFailures) throw new Error(netError);
      continue;
    }
    const job = r && r.job;
    if (!job) continue;
    if (job.status === 'done') return { data: job.data };
    if (job.status === 'error') throw new Error(job.error || '任务失败，请重试');
    if (onProgress) onProgress(job);
  }
  throw new Error(timeoutError);
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
    // given 有值时原来直接 return，导致 value 只在挂载时取一次：
    // 列表用下标 key 复用实例时，切换作业/筛选收藏会让音标停留在上一个词上（串词）。
    if (given) { setValue(given); return undefined; }
    if (!key) { setValue(''); return undefined; }
    const cache = phoneticCacheMap();
    if (cache.has(key)) { setValue(cache.get(key) || ''); return undefined; }
    setValue(''); // 换词先清空，避免旧音标短暂挂在新闻上
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
  // 全局提示条：编辑器页也能看到（shareTip 只在结果页渲染，
  // 之前把"已保存课文/已新建作业"这类反馈发给了它，等于用户什么都看不到）
  const [toast, setToast] = useState('');
  // 自测题
  const [quizData, setQuizData] = useState(null);
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizCount, setQuizCount] = useState(10);
  const [quizShowAnswers, setQuizShowAnswers] = useState(false); // 默认隐藏答案，先自己做
  const [quizTip, setQuizTip] = useState('');
  const [shareTip, setShareTip] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 900) return false;
    return safeGet('bt-sidebar', '') !== 'collapsed';
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
  const originalCamRef = useRef(null);   // 英文原文（标准答案）框的拍照 / 选图
  const originalFileRef = useRef(null);
  const favFileRef = useRef(null);
  // 计时器（记录一篇课文做了多久）
  const [timer, setTimer] = useState(loadTimer);
  // 自建课文库（本机保存）：用户可以把自己的作业存成课文，像内置语料一样反复练
  const [myLibs, setMyLibs] = useState(loadLibraries);
  const [myLibId, setMyLibId] = useState('');            // 当前选中的自建库（空 = 用内置册）
  const [libModalOpen, setLibModalOpen] = useState(false);
  const [libPickId, setLibPickId] = useState('');
  const [newLibName, setNewLibName] = useState('');
  const [libTip, setLibTip] = useState('');
  // 「新建回译作业」弹窗：当前作业有内容时先让用户决定要不要存进课文库
  const [newJobOpen, setNewJobOpen] = useState(false);
  const pendingNewRef = useRef(true);
  // 备份（课文库 + 收藏夹 + 历史）
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupTip, setBackupTip] = useState('');
  const backupFileRef = useRef(null);
  // 云同步（同步码）
  const [syncCode, setSyncCode] = useState(loadSyncCode);
  const [syncMeta, setSyncMeta] = useState(loadSyncMeta);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncTip, setSyncTip] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [syncLost, setSyncLost] = useState(false); // 云端没有这串码的数据（通常是平台重新部署）
  const syncBusyRef = useRef(false);
  const lastSyncAtRef = useRef(0);
  // 最近一次"手动操作"（生成码/换码/填码/停用/立即同步）的时间：
  // 自动同步在这之后 5 秒内不跑，否则它会把手动操作刚给出的提示覆盖掉（用户就看不到失败原因了）
  const manualActionAtRef = useRef(0);
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

  const toggleSidebar = () => {
    const next = !sidebarOpen;
    safeSet('bt-sidebar', next ? 'open' : 'collapsed');
    setSidebarOpen(next);
  };

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
    clearInterval(progressTimerRef.current);
    for (const t of tipTimersRef.current.values()) clearTimeout(t);
    tipTimersRef.current.clear();
  }, []);
  // 生成任务令牌：用户在生成过程中切课 / 点「新建」时作废，
  // 任务完成后就不再强行把视图抢回结果页（结果本身仍然保留并写入历史）。
  const genTokenRef = useRef(0);

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
    const savedBook = Number(safeGet('bt-book', ''));
    const savedLesson = Number(safeGet('bt-lesson', ''));
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
      // 后端任务已清理（重新部署/超 7 天）时，用本机缓存恢复
      const cached = loadResultCache(jobId);
      if (cached) {
        setResult(normalizeResult(cached));
        setCurrentJobId(jobId);
        setView('result');
        setError('');
      } else {
        setError('任务不存在或已过期，请重新提交');
      }
    });
  }, []);

  // 页面标题跟随当前作业：导出 PDF / 另存网页时文件名才有意义（原来是恒定标题）
  useEffect(() => {
    if (view === 'result' && result?.title) document.title = result.title + ' · 回译本';
    else if (view === 'quiz') document.title = '自测题 · 回译本';
    else document.title = '回译本 · 新概念回译训练';
  }, [view, result?.title]);

  const activeLib = useMemo(() => myLibs.find((l) => l.id === myLibId) || null, [myLibs, myLibId]);
  const visibleLessons = useMemo(
    () => (activeLib ? activeLib.lessons : lessons.filter((l) => l.book === book)),
    [activeLib, lessons, book],
  );

  // 本次作业的「英文原文（标准答案）」优先级：
  // 用户手填 > AI 素材生成的原文 > 自建库课文自带的原文。
  // 内置册留空，交给服务端按 book/lessonId 去语料里取（行为不变）。
  const currentOriginal = manualOriginal.trim()
    || generatedOriginal
    || (myLibId ? (matchedLesson?.english || '') : '');

  // 请求令牌：连点两课时，先发的慢请求若后返回，会把标题/中文覆盖成上一课的内容
  // （表现为侧栏高亮第 5 课、编辑区却是第 3 课）。挂载时的自动选课也会"迟到覆盖"用户的手动选择。
  const lessonReqRef = useRef(0);
  const selectLesson = async (nextBook, nextLesson, autoGenerate = false) => {
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
    if (autoGenerate) setTimeout(() => runGenerate(nextLesson), 60);
  };

  const handleBookChange = (nextBook) => {
    setMyLibId(''); // 切回内置册
    const first = lessons.find((l) => l.book === nextBook);
    if (first) selectLesson(nextBook, first.lesson);
    else setBook(nextBook);
  };

  /** 选中自建库（只切换侧栏列表，不改变当前作业）。 */
  const selectMyLib = (libId) => {
    setMyLibId(libId);
    setError('');
    const lib = myLibs.find((l) => l.id === libId);
    if (lib && !lib.lessons.length) flashTip(setToast, `「${lib.name}」还是空的：把当前作业存进去就能在这里选出来练习`, 4500);
  };

  /** 从自建库载入一节课（本地数据，不发请求）。 */
  const selectMyLesson = (libId, lessonNo) => {
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
  };

  /* ---------- 自建课文库：新建 / 保存 ---------- */
  const openLibModal = () => {
    setLibPickId(myLibs[0]?.id || '');
    setNewLibName('');
    setLibTip('');
    setLibModalOpen(true);
  };

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
  const startNewJob = (closeSidebar = true) => {
    if (!hasJobContent()) { doStartNewJob(closeSidebar); return; }
    pendingNewRef.current = closeSidebar;
    openNewJobModal();
  };

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
  const backToEditor = () => {
    setView('editor');
    setResult(null);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };

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

      const { list: nextLibs, libsAdded, lessonsAdded } = mergeLibraries(myLibs, libs);
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

  /* ---------- 云同步（同步码） ---------- */
  /** 把合并结果写回本机；只有真的变了才 setState（避免触发自动推送形成回环）。 */
  const applyMergedSnapshot = (merged) => {
    let changed = false;
    if (JSON.stringify(myLibs) !== JSON.stringify(merged.libraries)) { setMyLibs(merged.libraries); saveLibraries(merged.libraries); changed = true; }
    if (JSON.stringify(favorites) !== JSON.stringify(merged.favorites)) { setFavorites(merged.favorites); saveFavorites(merged.favorites); changed = true; }
    if (JSON.stringify(historyList) !== JSON.stringify(merged.history)) { setHistoryList(merged.history); saveHistory(merged.history); changed = true; }
    return changed;
  };

  const runSync = async (manual = true, codeOverride) => {
    const code = codeOverride || syncCode;
    if (!code) { if (manual) setSyncTip('还没有同步码：先生成一个，或在另一台设备上把码填进来'); return; }
    if (syncBusyRef.current) { if (manual) setSyncTip('正在同步中，请稍候再试'); return; }
    // 自动同步让位给刚发生的手动操作，避免覆盖提示 / 抢在同一时刻发请求
    if (!manual && Date.now() - manualActionAtRef.current < 5000) return;
    if (manual) manualActionAtRef.current = Date.now();
    syncBusyRef.current = true;
    setSyncBusy(true);
    if (manual) setSyncTip('正在同步…');
    try {
      const res = await syncOnce({ code, local: { libraries: myLibs, favorites, history: historyList } });
      if (!res.ok) {
        if (res.code === 'NOT_FOUND') { setSyncLost(true); setSyncTip(res.error); }
        else setSyncTip(res.error || '同步失败');
        return;
      }
      setSyncLost(false);
      lastSyncAtRef.current = Date.now();
      const changed = applyMergedSnapshot(res.merged);
      const meta = { ...loadSyncMeta(), lastSyncAt: lastSyncAtRef.current, version: res.version };
      saveSyncMeta(meta); setSyncMeta(meta);
      const a = res.added || {};
      const gained = (a.libsAdded || 0) + (a.lessonsAdded || 0) + (a.favAdded || 0) + (a.histAdded || 0);
      if (manual) {
        setSyncTip(gained
          ? `同步完成：新增 ${a.libsAdded || 0} 个课文库、${a.lessonsAdded || 0} 篇课文、${a.favAdded || 0} 条收藏、${a.histAdded || 0} 条历史`
          : '同步完成：已是最新，没有新增内容');
      } else if (changed) {
        flashTip(setToast, '已从云端同步到新内容', 3200);
      }
    } catch (e) {
      setSyncTip('同步失败：' + (e.message || '网络错误'));
    } finally {
      syncBusyRef.current = false;
      setSyncBusy(false);
    }
  };

  const startNewSync = async () => {
    // 正在同步时不要静默 return —— 用户会以为按钮坏了
    if (syncBusyRef.current) { setSyncTip('正在同步中，请稍候再试'); return; }
    manualActionAtRef.current = Date.now(); // 先占位，防止自动同步覆盖下面可能出现的失败提示
    syncBusyRef.current = true;
    setSyncBusy(true);
    setSyncTip('');
    try {
      const code = await createNewSyncCode();
      saveSyncCode(code); setSyncCode(code);
      syncBusyRef.current = false;
      await runSync(true, code);
    } catch (e) {
      setSyncTip('生成同步码失败：' + (e.message || '网络错误'));
    } finally {
      syncBusyRef.current = false;
      setSyncBusy(false);
    }
  };

  const useExistingCode = async () => {
    const code = codeInput.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) { setSyncTip('同步码应为 32 位十六进制字符，请检查是否复制完整'); return; }
    manualActionAtRef.current = Date.now();
    saveSyncCode(code); setSyncCode(code); setCodeInput('');
    await runSync(true, code);
  };

  const copySyncCode = async () => {
    try { await navigator.clipboard.writeText(syncCode); setSyncTip('同步码已复制 —— 在另一台设备的「备份 → 云同步」里粘贴即可'); }
    catch { setSyncTip('复制失败，请手动选中复制'); }
  };

  const stopSync = () => {
    if (!window.confirm('停用云同步？\n\n本机数据不受影响。云端那份数据仍在这串码下（除非服务端重新部署过），以后把这串码填回来就能继续用。')) return;
    saveSyncCode(''); setSyncCode(''); setSyncLost(false); setSyncTip('已停用云同步（本机数据保留）');
  };

  // 打开页面时自动同步一次（把云端新增内容合并进来）
  useEffect(() => {
    if (syncCode) runSync(false, syncCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 本机数据变化后防抖推送（刚同步完的 3 秒内不触发，避免自己触发自己）
  useEffect(() => {
    if (!syncCode) return undefined;
    if (Date.now() - lastSyncAtRef.current < 3000) return undefined;
    const t = setTimeout(() => { runSync(false); }, 8000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myLibs, favorites, historyList, syncCode]);

  const deleteLibrary = (libId, libName) => {
    if (!window.confirm(`删除课文库「${libName}」？库里的课文会一起删掉，此操作不可撤销。`)) return;
    const next = removeLibrary(myLibs, libId);
    setMyLibs(next);
    saveLibraries(next);
    if (myLibId === libId) setMyLibId('');
    flashTip(setToast, '已删除课文库「' + libName + '」', 3000);
  };

  const deleteMyLesson = (libId, lessonNo, label) => {
    if (!window.confirm(`从课文库删除「${label}」？`)) return;
    const next = removeLesson(myLibs, libId, lessonNo);
    setMyLibs(next);
    saveLibraries(next);
    flashTip(setToast, '已删除课文「' + label + '」', 3000);
  };

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
      const outcome = await pollJob({
        jobId,
        fetchJob: getMaterialJob,
        intervalMs: 2500,
        timeoutMs: 10 * 60 * 1000,
        maxFailures: 10,
        netError: '网络不稳定，暂时无法获取素材，请重试',
        timeoutError: '生成素材超时（超过10分钟），请重新提交',
        isAlive: () => aliveRef.current,
      });
      if (outcome.aborted) return;
      const data = outcome.data || {};
      if (!data.original || !data.chinese) throw new Error('AI 返回内容不完整，请重试');
      setTitle(data.title || topic);
      setChinese(data.chinese);
      setDraft('');
      setGeneratedOriginal(data.original);
      // AI 素材的原文也要填进「英文原文」输入框，否则用户只看到空框
      // （之前只写进 generatedOriginal，折叠栏显示"已自动带入 N 词"但框里是空的）
      setManualOriginal(data.original || '');
      setMaterialKeywords(data.keywords || []);
      setMatchedLesson(null);
      setMode('free');
      setMatchConfidence('none');
      setMatchScore(null);
      setMaterialOpen(false);
      return;
    } catch (e) {
      setError(e.message || '素材生成失败');
    } finally {
      clearInterval(materialTimer);
      setMaterialBusy(false);
    }
  };

  const addToHistory = (jobId, jobTitle, data, durationMs) => {
    saveResultCache(jobId, data);
    const entry = { jobId, title: jobTitle || '回译作业', time: Date.now(), durationMs: Number(durationMs) || 0 };
    const next = [entry, ...historyList.filter((x) => x.jobId !== jobId)].slice(0, 20);
    saveHistory(next);
    pruneResultCache(next.map((x) => x.jobId)); // 结果缓存跟随历史条数淘汰，否则无限增长写满 5MB 配额
    setHistoryList(next);
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
    flashTip(setFavTip, exists ? '已取消收藏' : (ok ? '已收藏，可在右上角「收藏夹」随时复习' : '收藏失败：本机存储空间可能已满，请先导出备份'));
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
    flashTip(setFavTip, '已清空收藏', 2500);
  };
  const exportFavorites = () => {
    if (!favorites.length) { flashTip(setFavTip, '还没有收藏内容', 2000); return; }
    const blob = new Blob([JSON.stringify({ app: 'back-translate-studio', exportedAt: new Date().toISOString(), favorites }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'retranslate-favorites-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    flashTip(setFavTip, '已导出备份文件，请妥善保存', 3000);
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
      flashTip(setFavTip, '导入完成：新增 ' + added + ' 条' + (ok ? '' : '（本机存储可能已满）'), 4000);
    } catch (e) {
      flashTip(setFavTip, '导入失败：' + (e.message || '文件格式不正确'), 4000);
    }
  };
  const copyFavorites = async () => {
    if (!favorites.length) return;
    try { await navigator.clipboard.writeText(favoritesToText(favorites)); flashTip(setFavTip, '已复制全部收藏到剪贴板', 3000); }
    catch { flashTip(setFavTip, '复制失败，请手动选择文本', 3000); }
  };
  // 只在收藏夹打开时才计算：原来是每帧无条件跑一遍（最多 2000 条 join + toLowerCase）
  const visibleFavorites = useMemo(
    () => (favOpen ? filterFavorites(favorites, { kind: favKind, query: favQuery }) : []),
    [favOpen, favorites, favKind, favQuery],
  );

  /* ---------- 根据收藏生成自测题 ---------- */
  const generateQuiz = async () => {
    const pool = favKind === 'all' ? favorites : filterFavorites(favorites, { kind: favKind });
    if (!pool.length) { flashTip(setFavTip, '还没有可用于出题的收藏', 2500); return; }
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
      const outcome = await pollJob({
        jobId,
        fetchJob: getQuizJob,
        intervalMs: 2000,
        timeoutMs: 5 * 60 * 1000,
        maxFailures: 8,
        netError: '网络不稳定，暂时无法获取题目',
        timeoutError: '生成超时或题目为空，请重试',
        isAlive: () => aliveRef.current,
      });
      if (outcome.aborted) return;
      const data = outcome.data;
      if (!data || !Array.isArray(data.questions) || !data.questions.length) throw new Error('生成超时或题目为空，请重试');
      setQuizData(data);
      setQuizShowAnswers(false);
      setFavOpen(false);
      setView('quiz');
    } catch (e) {
      // AI 出题失败时用本地题库兜底，保证功能始终可用
      const local = buildLocalQuiz(pool, quizCount);
      if (local.questions.length) {
        setQuizData(local);
        setQuizShowAnswers(false);
        setQuizTip('AI 出题失败（' + (e.message || '未知错误') + '），已用本地题库兜底生成');
        setFavOpen(false);
        setView('quiz');
      } else {
        flashTip(setFavTip, '生成失败：' + (e.message || '未知错误'), 4000);
      }
    } finally {
      setQuizBusy(false);
    }
  };
  const copyQuiz = async () => {
    if (!quizData) return;
    try {
      await navigator.clipboard.writeText(quizToText(quizData, { withAnswers: quizShowAnswers }));
      flashTip(setQuizTip, '已复制题目' + (quizShowAnswers ? '（含答案）' : '（不含答案）'), 2500);
    } catch { flashTip(setQuizTip, '复制失败，请手动选择文本', 2500); }
  };
  const favoritedIds = useMemo(() => new Set(favorites.map((x) => x.id)), [favorites]);
  const favHandlers = useMemo(() => ({ has: (id) => favoritedIds.has(id), toggle: toggleFavorite }), [favoritedIds, favorites]);

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

  /* ---------- 计时器 ---------- */
  const lessonKey = mode === 'lesson' ? `lesson:${book}-${lessonId}` : 'free';
  // 是否已经有累计用时（用于按钮文案与禁用态）——不需要"当前时刻"，因此不会引起每秒重渲染
  const hasElapsed = timer.running || timer.accumulated > 0;

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
        const resp = await ocr({
          image, side: target.lang, mode: ocrMode,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
          visionModel: settings.visionModel,
        });
        const jobId = resp.jobId;
        if (!jobId) throw new Error('服务器未返回任务编号，请重试');
        const outcome = await pollJob({
          jobId,
          fetchJob: getOcrJob,
          intervalMs: 1500,
          timeoutMs: 3 * 60 * 1000,
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
    const myToken = (genTokenRef.current += 1);
    // 点击生成时定格用时（本次练习从开始计时到提交用掉的时长）
    const durationMs = timer.accumulated + (timer.running && timer.startedAt ? Math.max(0, Date.now() - timer.startedAt) : 0);
    setProgressStep(1); setProgressMsg('正在提交后台任务…'); startProgressTimer();
    let finishedOk = false;
    try {
      const resp = await analyze({
        title: title.trim(), chinese: cn, draft: df,
        book: mode === 'lesson' && !myLibId ? book : undefined,
        lessonId: mode === 'lesson' && !myLibId ? id : undefined,
        original: currentOriginal || undefined,
        level: polishLevel,
        baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
      });
      const jobId = resp.jobId;
      if (!jobId) {
        if (resp.data) { setResult(normalizeResult(resp.data)); setView('result'); return; }
        throw new Error('服务器未返回任务编号，请重试');
      }
      setProgressStep(2); setProgressMsg('AI 正在后台生成（约1-2分钟）…');
      const outcome = await pollJob({
        jobId,
        fetchJob: getAnalyzeJob,
        intervalMs: 2500,
        timeoutMs: 10 * 60 * 1000,
        maxFailures: 10,
        netError: '网络不稳定，暂时无法获取生成结果，请重试',
        timeoutError: '生成超时（超过10分钟），请重新提交',
        isAlive: () => aliveRef.current,
        onProgress: () => { setProgressStep(2); setProgressMsg('AI 正在后台生成（约1-2分钟）…'); },
      });
      if (outcome.aborted) return;
      setProgressStep(3); setProgressMsg('生成完成'); finishedOk = true;
      const enriched = { ...(outcome.data || {}), durationMs };
      setResult(normalizeResult(enriched));
      setCurrentJobId(jobId);
      // 生成期间用户切过课 / 点过「新建」就不再抢回视图；结果照常入历史，可从历史里打开
      if (myToken === genTokenRef.current) setView('result');
      addToHistory(jobId, outcome.data?.title || title, enriched, durationMs);
      window.history.replaceState(null, '', '#job=' + jobId);
      return;
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

  /* ---------- 弹窗可访问性：role=dialog + Esc 关闭 + 焦点陷阱 ----------
   * 5 个弹窗原来都没有 dialog 语义、不能用键盘关闭、Tab 会跑到弹窗外的内容上。 */
  const modalRefs = useRef({});
  useEffect(() => {
    const open = camOpen ? 'cam' : materialOpen ? 'material' : newJobOpen ? 'newjob' : libModalOpen ? 'lib' : backupOpen ? 'backup' : historyOpen ? 'history' : favOpen ? 'fav' : settingsOpen ? 'settings' : null;
    if (!open) return undefined;
    const closers = {
      cam: closeCamera,
      material: () => { if (!materialBusy) setMaterialOpen(false); },
      newjob: () => setNewJobOpen(false),
      lib: () => setLibModalOpen(false),
      backup: () => setBackupOpen(false),
      history: () => setHistoryOpen(false),
      fav: () => setFavOpen(false),
      settings: () => setSettingsOpen(false),
    };
    const onKeyDown = (e) => {
      const node = modalRefs.current[open];
      if (e.key === 'Escape') { e.preventDefault(); closers[open](); return; }
      if (e.key !== 'Tab' || !node) return;
      const focusables = Array.from(node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!node.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    const timer = setTimeout(() => modalRefs.current[open]?.querySelector('button, input, select, textarea')?.focus(), 40);
    return () => { document.removeEventListener('keydown', onKeyDown); clearTimeout(timer); };
  }, [camOpen, materialOpen, newJobOpen, libModalOpen, backupOpen, historyOpen, favOpen, settingsOpen, materialBusy]);

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
      <label>或新建一个课文库<input value={newLibName} onChange={(e) => setNewLibName(e.target.value)} placeholder="例如：我的新概念 2 / 高考真题精读" /></label>
    </>
  );

  return (
    <div className="app">
      {sidebarOpen && <div className="sidebar-backdrop" onClick={toggleSidebar} aria-hidden="true" />}
      <aside className={'sidebar' + (sidebarOpen ? '' : ' collapsed')}>
        <button className="sidebar-close" onClick={toggleSidebar} aria-label="收起侧栏"><X size={18} /></button>
        <div className="brand"><div className="brand-mark">回</div><div><strong>回译本</strong><span>BACK-TRANSLATE STUDIO</span></div></div>
        <button className="primary-btn" onClick={() => startNewJob(true)}><Plus size={16} />新建回译作业</button>
        <div className="side-section">
          <div className="side-title">课文库</div>
          <div className="book-tabs">
            {[1, 2, 3, 4].map((n) => <button key={n} className={!myLibId && book === n ? 'active' : ''} onClick={() => handleBookChange(n)}>新概念 {n}</button>)}
          </div>

          <div className="my-libs">
            <div className="my-libs-head">
              <span className="side-title">我的课文库</span>
              <button className="lib-add" onClick={openLibModal} title="新建课文库 / 把当前作业存进课文库" aria-label="新建课文库">
                <FolderPlus size={14} />
              </button>
            </div>
            {myLibs.length === 0 && (
              <div className="lib-empty">还没有自建库：点右上角 <FolderPlus size={11} /> 把当前作业存成课文，就能像课文一样反复练。</div>
            )}
            {myLibs.map((lib) => (
              <div key={lib.id} className={'lib-row' + (myLibId === lib.id ? ' active' : '')}>
                <button className="lib-tab" onClick={() => { closeSidebarOnMobile(); selectMyLib(lib.id); }}>
                  <Library size={13} />
                  <span className="lib-name">{lib.name}</span>
                  <span className="lib-count">{lib.lessons.length}</span>
                </button>
                <button className="lib-del" onClick={() => deleteLibrary(lib.id, lib.name)} title="删除该课文库" aria-label={'删除课文库 ' + lib.name}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="lesson-list">
            {visibleLessons.length === 0 && (
              <div className="muted">{activeLib ? '这个库还是空的：把当前作业存进来即可' : '正在加载语料…'}</div>
            )}
            {visibleLessons.map((l) => {
              const isActive = mode === 'lesson' && lessonId === l.lesson && (activeLib ? myLibId === activeLib.id : (book === l.book && !myLibId));
              return (
                <div key={`${l.book}-${l.lesson}`} className={'lesson-row' + (isActive ? ' active' : '')}>
                  <button className="lesson-item" onClick={() => { closeSidebarOnMobile(); if (activeLib) selectMyLesson(activeLib.id, l.lesson); else selectLesson(l.book, l.lesson); }}>
                    <span className="lesson-no">{String(l.lesson).padStart(2, '0')}</span>
                    <span className="lesson-title">{l.title_cn || l.title_en || 'Lesson ' + l.lesson}</span>
                  </button>
                  {activeLib && (
                    <button className="lesson-del" onClick={() => deleteMyLesson(activeLib.id, l.lesson, l.title_cn || ('Lesson ' + l.lesson))} title="从库中删除" aria-label="从库中删除">
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="side-footer">
          <button className="ghost-btn" onClick={() => setSettingsOpen(true)}><Settings size={15} />AI 设置</button>
          <button className="ghost-btn" onClick={() => { setBackupTip(''); setBackupOpen(true); }} title="导出 / 导入本机数据备份（课文库、收藏夹、历史）"><Download size={15} />备份</button>
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
          <button className="ghost-btn" onClick={backToEditor}><X size={15} />编辑器</button>
          <button className="ghost-btn" onClick={openHistoryModal}><History size={15} />历史结果{historyList.length ? ` (${historyList.length})` : ''}</button>
          <button className="ghost-btn" onClick={() => setFavOpen(true)}><Star size={15} />收藏夹{favorites.length ? ` (${favorites.length})` : ''}</button>
        </header>
        {favTip ? <div className="fav-tip" role="status" aria-live="polite">{favTip}</div> : null}
        {toast ? <div className="fav-tip toast" role="status" aria-live="polite">{toast}</div> : null}

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
                  <span className="match-text">已识别可能有课文：新概念英语第 {matchedLesson.book} 册 · Lesson {matchedLesson.lesson} · {matchedLesson.title_en}（{CONFIDENCE_LABEL[matchConfidence] || matchConfidence || '未匹配'}{matchScore != null ? ` · 匹配分 ${matchScore}` : ''}）{mode === 'free' ? '，当前按自由模式' : '，原文将自动带入分析'}</span>
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
              <div className="title-field"><label htmlFor="bt-title">作业标题</label><input id="bt-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：新概念2 lesson 11" /></div>
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

      {historyOpen && (
        <div className="modal-mask" onClick={() => setHistoryOpen(false)}>
          <div className="modal history-modal" ref={(el) => { modalRefs.current.history = el; }} role="dialog" aria-modal="true" aria-label="历史作业" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>历史作业</h2><button className="icon-btn" onClick={() => setHistoryOpen(false)} aria-label="关闭"><X size={16} /></button></div>
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
          <div className="modal fav-modal" ref={(el) => { modalRefs.current.fav = el; }} role="dialog" aria-modal="true" aria-label="收藏夹" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>收藏夹（{favorites.length}）</h2><button className="icon-btn" onClick={() => setFavOpen(false)} aria-label="关闭"><X size={16} /></button></div>
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

            {/* 云同步：多设备之间合并同步（课文库 + 收藏夹 + 历史） */}
            <div className="sync-block">
              <div className="sync-title"><Cloud size={15} />云同步（多设备）</div>
              {!syncCode ? (
                <>
                  <p className="muted small">
                    生成一串同步码，在另一台设备上填同一串码，练习记录 / 收藏夹 / 课文库就会<b>双向合并</b>同步。
                    <b>同步码等于密码</b>——拿到的人可以读写你的数据，请勿外传。
                  </p>
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
                  <p className="muted small">
                    {syncMeta.lastSyncAt
                      ? `上次同步：${new Date(syncMeta.lastSyncAt).toLocaleString('zh-CN', { hour12: false })}`
                      : '还没有同步过'}
                    {status?.sync && !status.sync.durable
                      ? ' · ⚠️ 服务端当前用本机文件存储，平台重新部署会丢，建议按 .env.example 配置云端存储'
                      : ''}
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
        {shareTip ? <span className="share-tip" role="status" aria-live="polite">{shareTip}</span> : null}
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
                      <div key={'sb' + (b.label || '') + '#' + i}>
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
          {sentences.map((sentence, i) => <SentenceCard key={'s' + (sentence.cn || sentence.draft || '') + '#' + i} index={i} sentence={sentence} result={result} fav={fav} />)}
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
            <div className={'finding level-' + (finding.level || 'error')} key={'f' + (finding.from || '') + '→' + (finding.to || '') + '#' + i}>
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
          <div className="vocab-card" key={'vn' + (v.word || '') + '#' + i}>
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
          <div className="idiom-card" key={'ih' + (id.idiom || '') + '#' + i}>
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
          <div className={'summary-card ' + tone} key={'sm' + tone + '#' + (typeof item === 'string' ? item : i)}>
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
        <p className="quiz-hint">先自己做完，再点右上角「显示答案」对照；导出 PDF 时答案与解析会统一印在最后。</p>
        <ol className="quiz-list">
          {qs.map((q, i) => (
            <li className="quiz-item" key={'q' + (q.question || '') + '#' + i}>
              <div className="quiz-head">
                <span className="quiz-no">{i + 1}</span>
                <span className="quiz-type">{q.type || '问答'}</span>
              </div>
              <div className="quiz-question">{q.question}</div>
              {Array.isArray(q.options) && q.options.length ? (
                <ul className="quiz-options">{q.options.map((o, j) => <li key={'o' + j}>{o}</li>)}</ul>
              ) : null}
            </li>
          ))}
        </ol>
        {!qs.length ? <p className="muted">还没有题目，请先在收藏夹里收藏一些知识点再生成。</p> : null}

        {/* 答案区：屏幕默认隐藏，导出 PDF 时始终印在最后 */}
        <section className={'quiz-answers' + (showAnswers ? '' : ' hidden')}>
          <h2 className="quiz-answers-title">答案与解析</h2>
          {qs.map((q, i) => (
            <div className="quiz-answer-item" key={'a' + i}>
              <div className="quiz-answer-line">
                <span className="quiz-no">{i + 1}</span>
                <strong>答案：</strong>{q.answer}
              </div>
              {q.explanation ? <div className="quiz-exp"><strong>解析：</strong>{q.explanation}</div> : null}
              {q.source ? <div className="quiz-src">考点：{q.source}</div> : null}
            </div>
          ))}
        </section>
      </article>
    </div>
  );
}

export default App;
