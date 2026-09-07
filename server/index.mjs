import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT, buildUserMessage, MATERIAL_PROMPT, buildMaterialMessage } from './prompt.mjs';

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
  const m = String(text || '').match(/(?:新概念\s*)?(?:book|册|volume)?\s*([1-4])(?:\s*册)?/i);
  return m ? Number(m[1]) : null;
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
    if (requestedBook && l.book === requestedBook) score += 30;
    if (number != null && l.lesson === number) score += 220;
    if (titleKey && (titleKey === titleEn || titleKey === titleCn)) score += 180;
    if (titleKey && (titleKey.includes(titleEn) || titleEn.includes(titleKey))) score += 100;
    if (cnKey && sourceCn === cnKey) score += 400;
    if (cnKey && sourceCn) {
      let prefix = 0;
      while (prefix < Math.min(cnKey.length, sourceCn.length) && cnKey[prefix] === sourceCn[prefix]) prefix += 1;
      score += Math.min(70, prefix / Math.max(1, Math.min(cnKey.length, sourceCn.length)) * 70);
    }
    return { lesson: l, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.lesson || null;
}
function resolveLesson({ book, lessonId, title, chinese }) {
  const n = Number(lessonId);
  if (Number.isFinite(n) && n > 0) return findLesson(isValidBook(book) ? Number(book) : 2, n);
  return matchLesson({ title, chinese, book });
}

const stat = {
  baseUrl: () => process.env.AI_BASE_URL || 'https://api.deepseek.com/v1',
  model: () => process.env.AI_MODEL || 'deepseek-chat',
  hasKey: () => Boolean(process.env.AI_API_KEY),
};

/* ---------- 异步分析与任务状态 ---------- */
const analyzeJobs = new Map();

/* ---------- helpers ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
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

async function postChat({ url, headers, body, withFormat }) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify(withFormat ? Object.assign({}, body, { response_format: { type: 'json_object' } }) : body),
    });
  } catch (e) {
    throw new Error('无法连接模型接口: ' + e.message);
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
async function runAnalyzeJob(jobId, { title, chinese, draft, original, lesson, lessonNo, baseUrl, model, apiKey }) {
  const job = analyzeJobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage({ title, chinese, draft, original }) },
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
      overall: parsed.overall || {},
      sentences: Array.isArray(parsed.sentences) ? parsed.sentences : [],
      vocabularyNotes: Array.isArray(parsed.vocabularyNotes) ? parsed.vocabularyNotes : [],
      idiomHighlights: Array.isArray(parsed.idiomHighlights) ? parsed.idiomHighlights : [],
      advancedSentences: Array.isArray(parsed.advancedSentences) ? parsed.advancedSentences : [],
      bonusExpressions: Array.isArray(parsed.bonusExpressions) ? parsed.bonusExpressions : [],
    };
    job.status = 'done';
    job.meta = { book: lesson?.book || null, lessonId: lesson?.lesson || lessonNo, baseUrl, model };
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '生成失败，请重试';
  } finally {
    job.finishedAt = Date.now();
    setTimeout(() => analyzeJobs.delete(jobId), 10 * 60 * 1000);
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
      const match = matchLesson({
        title: String(body.title || ''),
        chinese: String(body.chinese || ''),
        book: body.book,
      });
      return json(res, 200, {
        match,
        confidence: match ? (lessonNumber(body.title) === match.lesson ? 'high' : 'medium') : 'none',
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

      const messages = [
        { role: 'system', content: MATERIAL_PROMPT },
        { role: 'user', content: buildMaterialMessage({ topic, level, style }) },
      ];
      const raw = await callLLM({ baseUrl, model, apiKey, messages });
      let parsed;
      try {
        parsed = parseJsonLoose(raw);
      } catch (e) {
        return json(res, 502, { error: '模型返回不是有效 JSON，请重试或换模型', raw: raw.slice(0, 800) });
      }
      return json(res, 200, {
        ok: true,
        data: {
          title: String(parsed.title || topic).trim(),
          original: String(parsed.original || '').trim(),
          chinese: String(parsed.chinese || '').trim(),
          keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter(Boolean) : [],
        },
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

      const baseUrl = String(body.baseUrl || '').trim() || stat.baseUrl();
      const model = String(body.model || '').trim() || stat.model();
      const apiKey = String(body.apiKey || '').trim() || process.env.AI_API_KEY || '';
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      analyzeJobs.set(jobId, { jobId, status: 'pending', createdAt: Date.now(), data: null, error: null });
      // 立即返回任务号，后台再调用模型；手机端/弱网不会因长时间占用请求而卡死
      runAnalyzeJob(jobId, {
        title, chinese, draft, original: lesson ? lesson.english : userOriginal,
        lesson, lessonNo, baseUrl, model, apiKey,
      });
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    const jobMatch = p.match(/^\/api\/analyze\/([A-Za-z0-9-]{8,64})$/);
    if (jobMatch && req.method === 'GET') {
      const job = analyzeJobs.get(jobMatch[1]);
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
