import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT, buildUserMessage, MATERIAL_PROMPT, buildMaterialMessage, QUIZ_PROMPT, buildQuizMessage, AI_LEVEL_KEYS, DEFAULT_AI_LEVEL } from './prompt.mjs';
import { recognizeImage } from './ocr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const DIST = path.join(ROOT, 'dist');
const AGENT_OUT = path.join(ROOT, 'test', 'agent_out', 'book2');

/* ---------- .env loader ---------- */
function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

/* ---------- corpus ---------- */
let corpora = null;
function normalizeLesson(raw, book, source) {
  const english = String(raw.english || raw.original || '').trim();
  return {
    book,
    lesson: Number(raw.lesson),
    title_en: String(raw.title_en || raw.title || '').trim(),
    title_cn: String(raw.title_cn || '').trim(),
    pdf_page: raw.pdf_page ?? null,
    chinese: String(raw.chinese || '').trim(),
    english,
    original: english,
    source,
  };
}
const BOOK_META = {
  1: { source: '新概念英语 第1册.pdf', file: 'new-concept-1-full.json' },
  2: { source: '新概念英语 第2册.pdf', file: 'new-concept-2-full.json' },
  3: { source: '新概念英语 第3册.pdf', file: 'new-concept-3.json' },
  4: { source: '新概念英语 第4册.pdf', file: 'new-concept-4.json' },
};
const isValidBook = (n) => [1, 2, 3, 4].includes(Number(n));
function loadBook(book) {
  const meta = BOOK_META[Number(book)];
  if (!meta) return { book: Number(book), source: '', lessons: [] };
  const source = meta.source;
  const full = path.join(ROOT, 'public', 'corpus', meta.file);
  if (fs.existsSync(full)) {
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      return { book, source: raw.source || source, lessons: (raw.lessons || []).map((l) => normalizeLesson(l, book, raw.source || source)).sort((a, b) => a.lesson - b.lesson) };
    } catch (e) { console.error('corpus parse failed:', full, e); }
  }
  const lessons = [];
  if (book === 2 && fs.existsSync(AGENT_OUT)) {
    for (const f of fs.readdirSync(AGENT_OUT)) {
      if (!/^lesson_\d+\.json$/.test(f)) continue;
      try { lessons.push(normalizeLesson(JSON.parse(fs.readFileSync(path.join(AGENT_OUT, f), 'utf8')), book, source)); } catch {}
    }
  }
  return { book, source, lessons: lessons.sort((a, b) => a.lesson - b.lesson) };
}
function getCorpora() {
  if (!corpora) corpora = new Map([1, 2, 3, 4].map((b) => [b, loadBook(b)]));
  return corpora;
}
function getCorpus(book = 2) {
  return getCorpora().get(Number(book)) || { book: Number(book), lessons: [], source: '' };
}
function allLessons(book = null) {
  if (book) return getCorpus(book).lessons;
  return [...getCorpora().values()].flatMap((c) => c.lessons);
}
function findLesson(book, lessonNo) {
  return getCorpus(book).lessons.find((l) => l.lesson === Number(lessonNo)) || null;
}

function compact(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}
function lessonNumber(text) {
  const m = String(text || '').match(/(?:lesson|第\s*)\s*(\d{1,3})/i) || String(text || '').match(/\b(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}
function titleBook(text) {
  const t = String(text || '');
  // 只识别明确的“册/book/新概念 N”标记，避免把 Lesson 18 的“1”误判成第 1 册
  const m = t.match(/(?:新概念\s*第?\s*([1-4])\s*册|(?:book|volume)\s*([1-4])|第\s*([1-4])\s*册|(?:新概念)\s*([1-4]))/i);
  if (!m) return null;
  return Number(m[1] || m[2] || m[3] || m[4]);
}
function matchLesson({ title, chinese, book }) {
  const requestedBook = isValidBook(book) ? Number(book) : titleBook(title);
  const candidates = allLessons(requestedBook || null);
  const titleKey = compact(title);
  const cnKey = compact(chinese);
  const number = lessonNumber(title);
  const scored = candidates.map((l) => {
    const titleEn = compact(l.title_en);
    const titleCn = compact(l.title_cn);
    const sourceCn = compact(l.chinese);
    let score = 0;
    let reason = '';
    if (requestedBook && l.book === requestedBook) score += 30;
    if (number != null && l.lesson === number) { score += 220; reason += '课号匹配;'; }
    if (titleKey && (titleKey === titleEn || titleKey === titleCn)) { score += 180; reason += '标题精确匹配;'; }
    if (titleKey && (titleKey.includes(titleEn) || titleEn.includes(titleKey))) { score += 100; reason += '标题包含;'; }
    if (cnKey && sourceCn === cnKey) { score += 400; reason += '中文全文精确匹配;'; }
    if (cnKey && sourceCn) {
      let prefix = 0;
      while (prefix < Math.min(cnKey.length, sourceCn.length) && cnKey[prefix] === sourceCn[prefix]) prefix += 1;
      const p = Math.min(70, prefix / Math.max(1, Math.min(cnKey.length, sourceCn.length)) * 70);
      score += p;
      if (p >= 40) reason += '中文开头相似;';
    }
    return { lesson: l, score, reason };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0] || null;
  if (!best || best.score < 60) return { match: null, score: 0, confidence: 'none', reason: '' };
  const second = scored[1] || null;
  let confidence = best.score >= 320 ? 'high' : (best.score >= 150 ? 'medium' : 'low');
  // 若第一名与第二名差距太小，降低置信度，避免“误判”
  if (second && second.score > 0 && best.score - second.score < Math.max(40, best.score * 0.15)) confidence = 'low';
  return { match: best.lesson, score: best.score, confidence, reason: best.reason };
}
function resolveLesson({ book, lessonId, title, chinese }) {
  const n = Number(lessonId);
  if (Number.isFinite(n) && n > 0) return findLesson(isValidBook(book) ? Number(book) : 2, n);
  return matchLesson({ title, chinese, book }).match;
}

const stat = {
  baseUrl: () => process.env.AI_BASE_URL || 'https://api.deepseek.com/v1',
  model: () => process.env.AI_MODEL || 'deepseek-chat',
  hasKey: () => Boolean(process.env.AI_API_KEY),
};

// DeepSeek 最新的 flash 已原生支持图片输入，作为拍照识别（OCR）的默认视觉模型
const DEEPSEEK_VISION_MODEL = 'deepseek-flash';
function defaultVisionModel(baseUrl, model) {
  if (process.env.AI_VISION_MODEL) return process.env.AI_VISION_MODEL;
  return /deepseek/i.test(String(baseUrl || '')) ? DEEPSEEK_VISION_MODEL : model;
}

/* ---------- 音标兜底查询（模型没给 phonetic 时用，带内存缓存 + 熔断） ---------- */
const phoneticCache = new Map();
let phoneticFailures = 0;
let phoneticDown = false; // 词典接口不可达时（例如国内网络）直接放弃，避免每次页面都等超时
async function lookupPhonetic(rawWord) {
  const key = String(rawWord || '').trim().toLowerCase();
  if (!key) return '';
  if (phoneticCache.has(key)) return phoneticCache.get(key);
  // 只查单个英文单词；含空格/斜杠的短语直接放弃，避免误查
  if (!/^[a-z][a-z'’-]{0,40}$/.test(key)) { phoneticCache.set(key, ''); return ''; }
  if (phoneticDown) { phoneticCache.set(key, ''); return ''; }
  let phonetic = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(key), { signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) {
      const data = await r.json();
      const list = Array.isArray(data) ? data : [];
      for (const entry of list) {
        if (entry && typeof entry.phonetic === 'string' && entry.phonetic.trim()) { phonetic = entry.phonetic.trim(); break; }
        const arr = Array.isArray(entry?.phonetics) ? entry.phonetics : [];
        const hit = arr.find((x) => x && typeof x.text === 'string' && x.text.trim());
        if (hit) { phonetic = hit.text.trim(); break; }
      }
      phoneticFailures = 0;
    } else {
      phoneticFailures += 1;
    }
  } catch {
    phoneticFailures += 1;
  }
  if (phoneticFailures >= 3) phoneticDown = true;
  phoneticCache.set(key, phonetic);
  return phonetic;
}

/* ---------- 异步任务（分析/素材）持久化 ---------- */
const DATA_DIR = path.join(ROOT, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const JOB_TTL = 7 * 24 * 60 * 60 * 1000; // 保留 7 天，避免无限膨胀
const jobs = new Map();

function loadJobs() {
  try {
    const raw = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    const arr = Array.isArray(raw.jobs) ? raw.jobs : [];
    for (const j of arr) {
      if (!j || !j.jobId) continue;
      if (Date.now() - (j.createdAt || 0) < JOB_TTL) jobs.set(j.jobId, j);
    }
  } catch { /* 首次运行没有文件 */ }
}
function persistJobs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [...jobs.values()] }));
  } catch (e) { console.error('持久化任务失败:', e.message); }
}
function saveJob(job) {
  jobs.set(job.jobId, job);
  persistJobs();
}
loadJobs();

/* ---------- helpers ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    // 拍照识别会上传 base64 图片，放宽到 20MB，避免大图直接把内存打爆
    if (size > 20 * 1024 * 1024) { req.destroy(); throw new Error('请求体过大（超过 20MB），请压缩图片后重试'); }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}
const DEFAULT_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 20000);
const FALLBACK_MAX_TOKENS = 8192;
const RETRY_MAX_TOKENS = 32000;

function stripJson(raw) {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t;
}

function parseJsonLoose(raw) {
  const text = stripJson(raw);
  if (!text) throw new Error('empty');
  try { return JSON.parse(text); } catch (e) { /* fallthrough */ }
  // 常见模型小瑕疵：末尾多余的逗号
  const fixed = text.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(fixed); } catch (e) { /* fallthrough */ }
  throw new Error('invalid json');
}

async function postChat({ url, headers, body, withFormat, timeoutMs = 120000 }) {
  let r;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    r = await fetch(url, {
      method: 'POST', headers,
      signal: controller.signal,
      body: JSON.stringify(withFormat ? Object.assign({}, body, { response_format: { type: 'json_object' } }) : body),
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('模型接口请求超时（' + Math.round(timeoutMs / 1000) + '秒），请稍后重试');
    throw new Error('无法连接模型接口: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
  return r;
}

async function callLLM({ baseUrl, model, apiKey, messages }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const baseBody = { model, messages, temperature: 0.3 };

  async function doPost(maxTokens) {
    const body = Object.assign({}, baseBody, { max_tokens: maxTokens });
    let r = await postChat({ url, headers, body, withFormat: true });
    if (!r.ok && /response_format|format/i.test(await r.clone().text())) {
      r = await postChat({ url, headers, body, withFormat: false });
    }
    if (!r.ok) {
      const t = await r.text();
      const limit = /max_tokens|output token|exceed|maximum|too large/i.test(t);
      const err = new Error('模型接口错误 ' + r.status + ': ' + t.slice(0, 500));
      err.limitTooLarge = limit;
      throw err;
    }
    const data = await r.json();
    return {
      content: data?.choices?.[0]?.message?.content || '',
      finishReason: data?.choices?.[0]?.finish_reason || '',
    };
  }

  let result;
  try {
    result = await doPost(DEFAULT_MAX_TOKENS);
  } catch (e) {
    if (e.limitTooLarge && DEFAULT_MAX_TOKENS !== FALLBACK_MAX_TOKENS) {
      result = await doPost(FALLBACK_MAX_TOKENS);
    } else {
      throw e;
    }
  }
  // 输出被截断（finish_reason=length）时自动用更大的上限重试一次
  if (result.finishReason === 'length' && DEFAULT_MAX_TOKENS < RETRY_MAX_TOKENS) {
    result = await doPost(RETRY_MAX_TOKENS);
  }
  return result.content;
}

/* ---------- 异步分析任务 ---------- */
async function runAnalyzeJob(jobId, { title, chinese, draft, original, lesson, lessonNo, baseUrl, model, apiKey, level }) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  saveJob(job);
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage({ title, chinese, draft, original, level }) },
    ];
    const raw = await callLLM({ baseUrl, model, apiKey, messages });
    let parsed;
    try {
      parsed = parseJsonLoose(raw);
    } catch (e) {
      throw new Error('模型返回不是有效 JSON，请重试或换模型');
    }
    job.data = {
      title: parsed.title || title,
      chinese: parsed.chinese || chinese,
      draft: parsed.draft || draft,
      ai: parsed.ai || '',
      original: parsed.original || original,
      aiLevel: level || DEFAULT_AI_LEVEL,
      overall: parsed.overall || {},
      sentences: Array.isArray(parsed.sentences) ? parsed.sentences : [],
      vocabularyNotes: Array.isArray(parsed.vocabularyNotes) ? parsed.vocabularyNotes : [],
      idiomHighlights: Array.isArray(parsed.idiomHighlights) ? parsed.idiomHighlights : [],
      advancedSentences: Array.isArray(parsed.advancedSentences) ? parsed.advancedSentences : [],
      bonusExpressions: Array.isArray(parsed.bonusExpressions) ? parsed.bonusExpressions : [],
    };
    job.status = 'done';
    job.meta = { book: lesson?.book || null, lessonId: lesson?.lesson || lessonNo, baseUrl, model };
    saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '生成失败，请重试';
    saveJob(job);
  } finally {
    job.finishedAt = Date.now();
    saveJob(job);
    setTimeout(() => { jobs.delete(jobId); persistJobs(); }, JOB_TTL);
  }
}

/* ---------- 异步素材生成任务 ---------- */
async function runMaterialJob(jobId, { topic, level, style, baseUrl, model, apiKey }) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  saveJob(job);
  try {
    const messages = [
      { role: 'system', content: MATERIAL_PROMPT },
      { role: 'user', content: buildMaterialMessage({ topic, level, style }) },
    ];
    const raw = await callLLM({ baseUrl, model, apiKey, messages });
    let parsed;
    try {
      parsed = parseJsonLoose(raw);
    } catch (e) {
      throw new Error('模型返回不是有效 JSON，请重试或换模型');
    }
    job.data = {
      title: String(parsed.title || topic).trim(),
      original: String(parsed.original || '').trim(),
      chinese: String(parsed.chinese || '').trim(),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter(Boolean) : [],
    };
    job.status = 'done';
    saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '素材生成失败，请重试';
    saveJob(job);
  } finally {
    job.finishedAt = Date.now();
    saveJob(job);
    setTimeout(() => { jobs.delete(jobId); persistJobs(); }, JOB_TTL);
  }
}

/* ---------- 图片识别任务（拍照 / 导入图片 → 视觉模型逐字转写） ---------- */
async function runOcrJob(jobId, { image, side, mode, vision }) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  saveJob(job);
  try {
    const result = await recognizeImage({ image, side, mode, vision });
    job.data = {
      text: result.text,
      engine: result.engine,
      model: result.model,
      chars: result.text.length,
      garbled: Boolean(result.garbled),
      quality: result.quality || null,
    };
    job.status = 'done';
    saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '图片识别失败，请重试';
    saveJob(job);
  } finally {
    job.finishedAt = Date.now();
    saveJob(job);
    setTimeout(() => { jobs.delete(jobId); persistJobs(); }, JOB_TTL);
  }
}

/* ---------- 自测题任务（根据收藏知识点出题） ---------- */
async function runQuizJob(jobId, { points, count, level, baseUrl, model, apiKey }) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  saveJob(job);
  try {
    const messages = [
      { role: 'system', content: QUIZ_PROMPT },
      { role: 'user', content: buildQuizMessage({ points, count, level }) },
    ];
    const raw = await callLLM({ baseUrl, model, apiKey, messages });
    let parsed;
    try {
      parsed = parseJsonLoose(raw);
    } catch (e) {
      throw new Error('模型返回不是有效 JSON，请重试或换模型');
    }
    const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
      .filter((q) => q && (q.question || q.answer))
      .map((q) => ({
        type: String(q.type || '问答'),
        question: String(q.question || ''),
        options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : [],
        answer: String(q.answer || ''),
        explanation: String(q.explanation || ''),
        source: String(q.source || ''),
      }));
    if (!questions.length) throw new Error('模型没有生成有效题目，请重试');
    job.data = {
      title: parsed.title || ('收藏知识点自测（' + questions.length + ' 题）'),
      level: level || DEFAULT_AI_LEVEL,
      count: questions.length,
      questions,
    };
    job.status = 'done';
    saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '生成自测题失败，请重试';
    saveJob(job);
  } finally {
    job.finishedAt = Date.now();
    saveJob(job);
    setTimeout(() => { jobs.delete(jobId); persistJobs(); }, JOB_TTL);
  }
}

/* ---------- server ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
function serveStatic(res, pathname) {
  let file = path.normalize(path.join(DIST, pathname));
  if (!file.startsWith(DIST)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
    if (!fs.existsSync(file)) return index(res);
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}
function index(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body><h1>回译训练工作室</h1><p>开发模式请访问 Vite 服务（默认 http://localhost:5173）。运行 npm run dev 后打开前端。</p></body></html>');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/health') return json(res, 200, { ok: true });
    if (p === '/api/status') {
      return json(res, 200, {
        baseUrl: stat.baseUrl(), model: stat.model(), hasKey: stat.hasKey(),
        visionModel: defaultVisionModel(stat.baseUrl(), stat.model()),
        ocr: true,
        aiLevels: AI_LEVEL_KEYS,
        defaultAiLevel: DEFAULT_AI_LEVEL,
        corpusLessons: allLessons().length,
        books: [...getCorpora().values()].map((c) => ({ book: c.book, lessons: c.lessons.length, source: c.source })),
      });
    }
    if (p === '/api/lessons' && req.method === 'GET') {
      const requestedBook = Number(url.searchParams.get('book'));
      const book = isValidBook(requestedBook) ? requestedBook : null;
      const lessons = allLessons(book).map((l) => ({
        book: l.book, lesson: l.lesson, title_en: l.title_en, title_cn: l.title_cn,
        pdf_page: l.pdf_page, englishLen: l.english.length, chineseLen: l.chinese.length,
      }));
      return json(res, 200, { book, lessons });
    }
    const lessonMatch = p.match(/^\/api\/lessons\/(?:(1|2|3|4)\/)?(\d+)$/);
    if (lessonMatch && req.method === 'GET') {
      const book = Number(lessonMatch[1] || 2);
      const n = Number(lessonMatch[2]);
      const l = findLesson(book, n);
      if (!l) return json(res, 404, { error: 'lesson not found' });
      return json(res, 200, l);
    }
    if (p === '/api/match' && req.method === 'POST') {
      const body = await readBody(req);
      const m = matchLesson({
        title: String(body.title || ''),
        chinese: String(body.chinese || ''),
        book: body.book,
      });
      return json(res, 200, {
        match: m.match,
        confidence: m.confidence,
        score: m.score,
        reason: m.reason,
      });
    }
    if (p === '/api/generate-material' && req.method === 'POST') {
      const body = await readBody(req);
      const topic = String(body.topic || '').trim();
      if (!topic) return json(res, 400, { error: '请填写主题，例如：春节、人工智能、城市通勤' });
      const level = String(body.level || '中级');
      const style = String(body.style || '生活故事');
      const baseUrl = String(body.baseUrl || '').trim() || stat.baseUrl();
      const model = String(body.model || '').trim() || stat.model();
      const apiKey = String(body.apiKey || '').trim() || process.env.AI_API_KEY || '';
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'material', title: '素材：' + topic, status: 'pending', createdAt: Date.now(), data: null, error: null });
      runMaterialJob(jobId, { topic, level, style, baseUrl, model, apiKey });
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    const materialMatch = p.match(/^\/api\/generate-material\/([A-Za-z0-9-]{8,64})$/);
    if (materialMatch && req.method === 'GET') {
      const job = jobs.get(materialMatch[1]);
      if (!job || job.kind !== 'material') return json(res, 404, { error: '任务不存在或已过期，请重新提交' });
      return json(res, 200, {
        ok: true,
        job: { jobId: job.jobId, status: job.status, data: job.data || null, error: job.error || null },
      });
    }
    if (p === '/api/phonetic' && req.method === 'GET') {
      const word = url.searchParams.get('word') || '';
      if (!word.trim()) return json(res, 400, { error: '缺少 word 参数' });
      const phonetic = await lookupPhonetic(word);
      return json(res, 200, { ok: true, word: word.trim(), phonetic });
    }
    if (p === '/api/ocr' && req.method === 'POST') {
      const body = await readBody(req);
      const image = String(body.image || '');
      if (!image) return json(res, 400, { error: '缺少图片（image 字段）' });

      const baseUrl = String(body.baseUrl || '').trim() || stat.baseUrl();
      const model = String(body.model || '').trim() || stat.model();
      const apiKey = String(body.apiKey || '').trim() || process.env.AI_API_KEY || '';
      // 视觉模型优先级：请求参数 > AI_VISION_MODEL > DeepSeek 路由默认 deepseek-flash > 主模型
      const visionModel = String(body.visionModel || '').trim() || defaultVisionModel(baseUrl, model);
      const vision = {
        baseUrl: String(body.visionBaseUrl || '').trim() || process.env.AI_VISION_BASE_URL || baseUrl,
        model: visionModel,
        apiKey: String(body.visionApiKey || '').trim() || process.env.AI_VISION_API_KEY || apiKey,
        // 主模型是纯文本模型时，自动回退到 DeepSeek 原生多模态的 flash
        fallbackModel: /deepseek/i.test(baseUrl) && visionModel !== DEEPSEEK_VISION_MODEL ? DEEPSEEK_VISION_MODEL : '',
      };
      if (!vision.apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const side = body.side === 'chinese' ? 'chinese' : 'english';
      const mode = ['auto', 'handwriting', 'printed'].includes(body.mode) ? body.mode : 'auto';
      const jobId = randomUUID();
      saveJob({ jobId, kind: 'ocr', title: '图片识别 · ' + (side === 'chinese' ? '中文' : '英文'), status: 'pending', createdAt: Date.now(), data: null, error: null });
      runOcrJob(jobId, { image, side, mode, vision });
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    const ocrMatch = p.match(/^\/api\/ocr\/([A-Za-z0-9-]{8,64})$/);
    if (ocrMatch && req.method === 'GET') {
      const job = jobs.get(ocrMatch[1]);
      if (!job || job.kind !== 'ocr') return json(res, 404, { error: '任务不存在或已过期，请重新识别' });
      return json(res, 200, {
        ok: true,
        job: { jobId: job.jobId, status: job.status, data: job.data || null, error: job.error || null },
      });
    }
    if (p === '/api/quiz' && req.method === 'POST') {
      const body = await readBody(req);
      const points = (Array.isArray(body.points) ? body.points : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .slice(0, 60);
      if (!points.length) return json(res, 400, { error: '请先收藏一些知识点，再生成自测题' });
      const count = Math.max(1, Math.min(50, Number(body.count) || 10));
      const level = AI_LEVEL_KEYS.includes(String(body.level || '').trim()) ? String(body.level).trim() : DEFAULT_AI_LEVEL;
      const baseUrl = String(body.baseUrl || '').trim() || stat.baseUrl();
      const model = String(body.model || '').trim() || stat.model();
      const apiKey = String(body.apiKey || '').trim() || process.env.AI_API_KEY || '';
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'quiz', title: '自测题 · ' + count + ' 题', status: 'pending', createdAt: Date.now(), data: null, error: null });
      runQuizJob(jobId, { points, count, level, baseUrl, model, apiKey });
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    const quizMatch = p.match(/^\/api\/quiz\/([A-Za-z0-9-]{8,64})$/);
    if (quizMatch && req.method === 'GET') {
      const job = jobs.get(quizMatch[1]);
      if (!job || job.kind !== 'quiz') return json(res, 404, { error: '任务不存在或已过期，请重新生成' });
      return json(res, 200, {
        ok: true,
        job: { jobId: job.jobId, status: job.status, data: job.data || null, error: job.error || null },
      });
    }
    if (p === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const chinese = String(body.chinese || '').trim();
      const draft = String(body.draft || '').trim();
      if (!chinese || !draft) return json(res, 400, { error: '缺少中文提示或英文初稿' });

      const userOriginal = String(body.original || '').trim();
      const lessonNo = body.lessonId != null ? Number(body.lessonId) : null;
      const lesson = userOriginal ? null : resolveLesson({ book: body.book, lessonId: lessonNo, title: body.title, chinese });
      const title = body.title || (lesson ? 'Lesson ' + lesson.lesson + ' · ' + (lesson.title_en || lesson.title_cn) : '自由回译训练');
      // 润色等级：小初 / 高考英语 / 四六级 / 考研英语 / 专四 / 专八
      const level = AI_LEVEL_KEYS.includes(String(body.level || '').trim()) ? String(body.level).trim() : DEFAULT_AI_LEVEL;

      const baseUrl = String(body.baseUrl || '').trim() || stat.baseUrl();
      const model = String(body.model || '').trim() || stat.model();
      const apiKey = String(body.apiKey || '').trim() || process.env.AI_API_KEY || '';
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'analyze', title, status: 'pending', createdAt: Date.now(), data: null, error: null });
      // 立即返回任务号，后台再调用模型；手机端/弱网不会因长时间占用请求而卡死
      runAnalyzeJob(jobId, {
        title, chinese, draft, original: lesson ? lesson.english : userOriginal,
        lesson, lessonNo, baseUrl, model, apiKey, level,
      });
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    const jobMatch = p.match(/^\/api\/analyze\/([A-Za-z0-9-]{8,64})$/);
    if (jobMatch && req.method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res, 404, { error: '任务不存在或已过期，请重新提交' });
      return json(res, 200, {
        ok: true,
        job: { jobId: job.jobId, status: job.status, data: job.data || null, error: job.error || null },
      });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown api' });
    return serveStatic(res, p);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message || 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log('回译训练工作室后端已启动: http://localhost:' + PORT);
  console.log('模型: ' + stat.model() + ' @ ' + stat.baseUrl() + '  key: ' + (stat.hasKey() ? '已配置' : '未配置'));
  console.log('语料: ' + getCorpus().lessons.length + ' 课');
});
