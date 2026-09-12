import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT, buildUserMessage, MATERIAL_PROMPT, buildMaterialMessage, QUIZ_PROMPT, buildQuizMessage, AI_LEVEL_KEYS, DEFAULT_AI_LEVEL, normalizeLevel } from './prompt.mjs';
import { recognizeImage } from './ocr.mjs';
import { MAX_SNAPSHOT_BYTES, createSyncStore, emptySnapshot, isValidSyncCode, newSyncCode, sanitizeSnapshot } from './sync.mjs';
import { createUpstashKv, createFileKv } from './kv.mjs';
import { createAccounts } from './accounts.mjs';
import { sendMail } from './mailer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ---------- .env loader ----------
 * 必须**最先**执行：下面 createSyncStore / createKv 会立刻读 UPSTASH_*，
 * 晚一步就会出现"我在 .env 里配了 Upstash，本地却仍在写文件"的怪现象。 */
function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8787);
const DIST = path.join(ROOT, 'dist');
// 本地数据目录（键值存储 / 云同步文件）。默认 <仓库>/data，可用 DATA_DIR 换位置
// （测试要隔离数据、或自托管想把数据放到别的盘时用得上）。
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
// 云同步存储：配了 Upstash 就用它（持久），否则退回本地文件（托管平台上重启会丢）
const syncStore = createSyncStore(DATA_DIR);
// 「能不能当持久存储用」要分环境看：
//  - Upstash：本来就是持久服务 → true
//  - 本地文件：自己电脑/自托管 VPS 上磁盘是自己的 → 持久；但托管平台（Render 等）的文件系统是
//    临时的，官方文档明确写「重新部署 / 重启 / 休眠都会丢失」——Render 免费版 15 分钟无访问就休眠。
const HOSTED = Boolean(process.env.RENDER || process.env.DYNO || process.env.VERCEL || process.env.FLY_APP_NAME || process.env.K_SERVICE);
const syncDurable = syncStore.durable || !HOSTED;

/* ---------- 账号体系 ----------
 * 与云同步共用同一个 Upstash 实例（键前缀不同），所以配一次环境变量两件事都解决。
 * 区别在于：**存储不持久时，账号功能直接关闭**。
 * 托管平台（Render 免费版）的磁盘是临时的 —— 在那里开账号等于骗用户：
 * 重新部署一次所有人的账号就没了。宁可不提供，也不提供一个会丢的。
 * 想开启：配 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（见 .env.example）。 */
const kv = (() => {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (url && token) return createUpstashKv({ url, token });
  return createFileKv(path.join(DATA_DIR, 'kv'));
})();
const kvDurable = kv.durable || !HOSTED;
const accountsOn = kvDurable;
const accounts = accountsOn ? createAccounts({ kv, mail: sendMail }) : null;

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
  1: { source: '第 1 册语料', file: 'new-concept-1-full.json' },
  2: { source: '第 2 册语料', file: 'new-concept-2-full.json' },
  3: { source: '第 3 册语料', file: 'new-concept-3.json' },
  4: { source: '第 4 册语料', file: 'new-concept-4.json' },
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
  // 语料文件缺失时返回空列表（前端会退回「自由模式」）。
  // 原先还有一段 test/agent_out 的遗留回退目录，已随测试产物清理掉。
  return { book, source, lessons: [] };
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
  // 只识别明确的“第 N 册 / book N”标记，避免把 Lesson 18 的“1”误判成第 1 册
  const m = t.match(/(?:book|volume)\s*([1-4])|第\s*([1-4])\s*册/i);
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
  baseUrl: () => String(process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').trim(),
  model: () => process.env.AI_MODEL || 'deepseek-chat',
  hasKey: () => Boolean(process.env.AI_API_KEY),
};

/* ---------- 接入点安全边界 ----------
 * 原先 baseUrl / apiKey 都直接取自请求体，等于把服务端做成开放代理：
 * 攻击者把 baseUrl 指向自己的服务器，本服务就会把 Authorization: Bearer <服务端 key> 主动送过去。
 * 现在的规则：
 *   1) 服务端密钥只允许发往服务端自己配置的 baseUrl，绝不发往客户端指定的地址；
 *   2) 客户端要用自定义接口，必须自带该接口的 key；
 *   3) 自定义接口默认禁止私网/环回/链路本地地址（防 SSRF）。
 */
const ALLOW_SERVER_KEY = process.env.ALLOW_SERVER_KEY !== '0'; // 公共站点可设 0：强制访客自带 key
const ALLOW_PRIVATE_BASE = process.env.ALLOW_PRIVATE_BASE_URL === '1';
const envKey = () => String(process.env.AI_API_KEY || '').trim();
const envVisionBase = () => String(process.env.AI_VISION_BASE_URL || '').trim();
const envVisionKey = () => String(process.env.AI_VISION_API_KEY || '').trim();

const sameEndpoint = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

function isSafeBaseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (ALLOW_PRIVATE_BASE) return true;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === '::1' || /^(fc|fd|fe80)/.test(host)) return false;
  return true;
}

/**
 * 解析一次模型调用的接入点。
 * @returns {{baseUrl: string, apiKey: string} | {error: string}}
 */
function resolveEndpoint({ bodyBase, bodyKey, fallbackBase, fallbackKey }) {
  const base = String(bodyBase || '').trim();
  const key = String(bodyKey || '').trim();
  if (!base || sameEndpoint(base, fallbackBase)) {
    return { baseUrl: fallbackBase, apiKey: key || (ALLOW_SERVER_KEY ? fallbackKey : '') };
  }
  if (!isSafeBaseUrl(base)) {
    return { error: '该 Base URL 不被允许（仅支持公网 http/https）。如需指向内网地址，请改在服务端 .env 里配置 AI_BASE_URL，或设 ALLOW_PRIVATE_BASE_URL=1' };
  }
  if (!key) {
    return { error: '使用自定义 Base URL 时，必须同时填写该接口的 API Key（服务端密钥不会发往自定义地址）' };
  }
  return { baseUrl: base.replace(/\/+$/, ''), apiKey: key };
}

/* ---------- 限流（内存滑动窗口，按来源 IP） ----------
 * 只是"减速带"：挡脚本批量刷接口，不承担鉴权职责。 */
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();
function clientIp(req) {
  const sock = req.socket?.remoteAddress || 'unknown';
  if (process.env.RENDER || process.env.TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return sock;
}
function rateLimited(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
  return bucket.count > RATE_MAX;
}

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

/**
 * 任务保留期 = 分享链接的有效期。
 *
 * 「复制分享链接」生成的是 `#job=<id>`，对方打开时**只能从服务端取这条记录** ——
 * 记录没了链接就废了。原来是 7 天：发给孩子/同事"过阵子再看"根本不够，
 * 一周后点开只会看到「任务不存在或已过期」。
 *
 * 现在默认 3650 天（10 年，等于长期有效）。一条结果几十 KB，Upstash 免费额度 256MB
 * 够存几千次批改，"长期保留"的成本可以忽略；真要控制体积就用 JOB_TTL_DAYS 调小
 * （例：JOB_TTL_DAYS=90）。配了 Upstash 时这份数据本来就跨部署持久，链接不会再因为发版失效。
 */
const JOB_TTL_DAYS = (() => {
  const n = Number(String(process.env.JOB_TTL_DAYS ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : 3650;
})();
const JOB_TTL = JOB_TTL_DAYS * 24 * 60 * 60 * 1000;
const jobs = new Map();

/* ---------- 任务持久化：一条一个键，存 KV ----------
 * 原先是整个 jobs.json 一把写。两个问题：
 *   1) 每次状态更新都要把**全部**任务序列化一遍；并发几个任务时同步阻塞事件循环；
 *   2) 更严重 —— 托管平台的磁盘是**临时的**：每次部署/重启，正在生成的任务就全丢，
 *      用户看到「任务不存在或已过期」，而那次模型调用已经花掉钱了。
 * 改存 KV 之后任务跨部署存活，TTL 交给存储层管，也不用再整文件重写。 */
const JOB_PREFIX = 'bts:job:';
const JOB_TTL_SEC = Math.floor(JOB_TTL / 1000);

/** 内存是快路径，KV 是持久层。写入不阻塞请求（任务状态更新很频繁）。 */
function saveJob(job) {
  if (!job || !job.jobId) return;
  jobs.set(job.jobId, job);
  Promise.resolve(kv.set(JOB_PREFIX + job.jobId, JSON.stringify(job), JOB_TTL_SEC))
    .catch((e) => console.error('任务落盘失败:', e.message));
}

/**
 * 只清内存里的副本（**不动 KV**）。
 *
 * 内存清理和 KV 保留期必须分开，两个原因：
 *   1) setTimeout 的延迟上限是 2^31-1 毫秒（约 24.8 天）—— 拿"10 年"去 setTimeout 会溢出成
 *      **立即执行**，等于刚写完就把任务删掉，分享链接当场失效；
 *   2) 内存里没必要留十年：KV 才是权威，findJob() 找不到内存会回 KV 捞。
 * 所以内存按 JOB_MEM_TTL 例行清理，KV 的过期交给存储层（Upstash EX / 文件信封）。
 */
const JOB_MEM_TTL = 6 * 60 * 60 * 1000;
function scheduleForget(jobId) {
  const t = setTimeout(() => { jobs.delete(jobId); }, JOB_MEM_TTL);
  if (t && typeof t.unref === 'function') t.unref(); // 别拖着进程不退出（自托管 / 命令行场景）
}

/**
 * 续期：从 KV 读到一条老任务时，把它按**当前**保留期再写一遍。
 *
 * 为什么需要：TTL 是写在键上的，改大 JOB_TTL_DAYS 只影响之后新建的任务 ——
 * 之前发出去的链接仍按旧的有效期（比如 7 天）倒计时。有了这一步，
 * **任何在过期前被打开一次的老链接都会自动续到新保留期**，不用等用户重发。
 * 每个任务每天最多续一次，避免每次打开都写一次 KV。
 */
const JOB_RENEW_MS = 24 * 60 * 60 * 1000;
const jobRenewedAt = new Map();
function renewJobTtl(job) {
  if (!job || !job.jobId) return;
  if (jobRenewedAt.size > 5000) jobRenewedAt.clear(); // 防无限增长：最坏是多写几次 KV，不影响正确性
  const last = jobRenewedAt.get(job.jobId) || 0;
  if (Date.now() - last < JOB_RENEW_MS) return;
  Promise.resolve(kv.set(JOB_PREFIX + job.jobId, JSON.stringify(job), JOB_TTL_SEC))
    .catch(() => { /* 续期失败不影响本次读取；下次打开再试 */ });
}

/* ---------- 自动清理：保留期之外再加"总量上限" ----------
 * 只有 TTL 挡不住"量堆满"这件事：TTL 是 10 年，而 Upstash 免费额度是 256MB —— 而且这
 * 256MB 是**和云同步、账号共用的**，写满之后收藏同步和登录会一起开始失败。
 *
 * 所以再加一层按条数的兜底：只保留最近 JOB_MAX_COUNT 条，多出来的从**最旧的**开始删。
 * 实现用一个自增序号 + 淘汰指针，不扫描键空间（SCAN 在 Upstash 上按命令计费）：
 *   · 每完成一次批改：INCR 取序号 + 写一条「序号 → jobId」的小映射键（各 1 条命令）
 *   · 超过上限时：读一条映射 → 删任务键 + 删映射（1 读 2 删），每次只淘汰一条
 * 换算：2000 条 × 40KB ≈ 80MB，安全落在 256MB 内，也给同步数据留足空间。
 * 想更保守就调小 JOB_MAX_COUNT（例：500）。
 */
const JOB_MAX_COUNT = (() => {
  const n = Number(String(process.env.JOB_MAX_COUNT ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();
const JOB_SEQ_KEY = 'bts:jobs:seq';
const JOB_SEQ_PREFIX = 'bts:jobseq:';
let jobSeq = 0;      // 已发放的最大序号
let jobEvicted = 0;  // 已淘汰到的序号（指针左边都已删除）
const seqKeyOf = (n) => JOB_SEQ_PREFIX + String(n).padStart(12, '0');

/** 启动时把序号指针读回来，并把淘汰指针推到"当前应有的位置"，避免重启后一次性补删上万条 */
async function loadJobSeq() {
  try {
    jobSeq = Number(await kv.get(JOB_SEQ_KEY)) || 0;
    jobEvicted = Math.max(0, jobSeq - JOB_MAX_COUNT);
    if (jobSeq) console.log('任务序号: ' + jobSeq + ' · 保留上限 ' + JOB_MAX_COUNT + ' 条');
  } catch { /* 存储不可用时先跳过，新任务照样能生成 */ }
}

/** 登记一条新任务；超出上限时顺手淘汰最旧的一条。失败不影响本次生成。 */
async function registerJob(jobId) {
  if (!jobId) return;
  try {
    jobSeq = Number(await kv.incrBy(JOB_SEQ_KEY, 1)) || jobSeq + 1;
    await kv.set(seqKeyOf(jobSeq), jobId, JOB_TTL_SEC);
    while (jobSeq - jobEvicted > JOB_MAX_COUNT) {
      jobEvicted += 1;
      const key = seqKeyOf(jobEvicted);
      const oldId = await kv.get(key);
      if (oldId) {
        // 内存那份也要删：findJob 先查内存，只删 KV 的话被淘汰的任务在本次进程内仍然打得开
        jobs.delete(oldId);
        await kv.del(JOB_PREFIX + oldId);
        console.log('自动清理：删除最旧的任务 ' + oldId + '（保留上限 ' + JOB_MAX_COUNT + ' 条）');
      }
      await kv.del(key);
    }
  } catch (e) {
    console.error('任务登记/清理失败:', e.message);
  }
}

/**
 * 取任务：内存没有就去 KV 找。
 * **部署重启后靠这一步把进行中的任务捞回来** —— 这是本次改动的全部意义。
 */
async function findJob(jobId) {
  const mem = jobs.get(jobId);
  if (mem) return mem;
  try {
    const raw = await kv.get(JOB_PREFIX + jobId);
    if (!raw) return null;
    const job = JSON.parse(raw);
    if (job && job.jobId) {
      jobs.set(jobId, job);
      // 从 KV 捞回来的副本同样要有"内存过期"：否则每次读一个老结果都会永久占住内存
      scheduleForget(jobId);
      renewJobTtl(job); // 老链接被打开一次就续到当前保留期
      return guardStale(job);
    }
  } catch (e) {
    console.error('读取任务失败:', e.message);
  }
  return null;
}

/**
 * 「僵尸任务」判定。
 *
 * 任务现在能跨部署活下来了，但**它的执行不会跟着续跑** —— 后台的 runXxxJob 是进程内的
 * 异步函数，重启就没了。所以一个正在跑的任务如果服务端重启，它会永远停在 running，
 * 前端就一直转圈转到 10 分钟超时。
 *
 * 这里按时间兜底：超过既定超时还没落定，就明确判为失败，让用户看到原因而不是干等。
 */
const JOB_STALE_MS = 12 * 60 * 1000; // 前端轮询上限是 10 分钟，留 2 分钟余量
function guardStale(job) {
  if (!job || (job.status !== 'running' && job.status !== 'pending')) return job;
  const ts = Number(job.updatedAt || job.createdAt || 0);
  if (ts && Date.now() - ts > JOB_STALE_MS) {
    job.status = 'error';
    job.error = '生成过程中服务端重启了，这次任务没能完成。请重新提交一次（不会重复扣费到你的账号，但这次的模型调用已经产生）。';
    job.updatedAt = Date.now();
    job.updatedAt = Date.now();
  saveJob(job);
  }
  return job;
}


/* ---------- helpers ---------- */
/** 预期内的用户错误：按原状态码与文案回给客户端；其余异常统一 500 且不回显内部信息。 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
function json(res, code, obj) {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 拍照识别会上传 base64 图片，所以放到 20MB
/**
 * 按接口分别设限，而不是全都用 20MB。
 *
 * 纯文本接口如果也放开到 20MB，攻击者一次就能塞进几十万个字符 ——
 * 光是 JSON.parse 和字段校验就能把 CPU 吃满，更别说后面还要拿这些文本去调模型（真金白银）。
 * 真实用量远小于这里的额度：课文正文 1–3 千字符，主题就一行字。
 */
const MAX_TEXT_BYTES = 256 * 1024; // 课文正文类：中文 / 英文原文 / 英文初稿
const MAX_SMALL_BYTES = 64 * 1024; // 短输入：生成主题、收藏知识点列表
/**
 * 读取并解析 JSON 请求体。
 * - 超限时不再 req.destroy()：那样客户端收到的是"连接被重置"，看不到原因。
 *   这里改为把剩余数据排空后回 413，客户端能拿到标准 JSON 错误。
 * - JSON 非法时回 400，而不是当成空对象 —— 否则会被后续校验报成"缺少 xxx 字段"，把人往错的方向带。
 * @param {number} maxBytes 本次允许的最大体积（云同步这类接口传更小值，避免解析超大 body）
 */
async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const c of req) {
    if (tooLarge) continue; // 继续把请求体读完，保证连接状态正常、响应能送达
    size += c.length;
    if (size > maxBytes) { tooLarge = true; chunks.length = 0; continue; }
    chunks.push(c);
  }
  if (tooLarge) throw new HttpError(413, `请求体过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB），请精简后重试`);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, 'JSON 格式错误：' + String((e && e.message) || '').slice(0, 120));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是一个 JSON 对象');
  }
  return parsed;
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

/* ---------- 模型输出归一化 ----------
 * 模型偶尔会把 null / 字符串 / 数字混进本应是对象数组的字段，
 * 前端在渲染期直接索引这些元素（s.findings、v.word …）就会抛 TypeError，
 * 而 React 没有 ErrorBoundary 时整棵树会被卸载 —— 表现为整页白屏。
 * 所以入口处一律做元素级清洗，脏元素直接丢弃。 */
function objectArray(value) {
  return (Array.isArray(value) ? value : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
}
function stringArray(value) {
  return (Array.isArray(value) ? value : []).filter((x) => typeof x === 'string');
}
function sanitizeSentences(value) {
  return objectArray(value).map((s) => ({
    ...s,
    findings: objectArray(s.findings).map((f) => ({
      ...f,
      dimensions: stringArray(f.dimensions),
      synonyms: Array.isArray(f.synonyms) ? f.synonyms.filter((x) => x != null) : [],
    })),
  }));
}
function sanitizeOverall(value) {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { ...o, scoreBreakdown: objectArray(o.scoreBreakdown) };
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
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
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
      overall: sanitizeOverall(parsed.overall),
      sentences: sanitizeSentences(parsed.sentences),
      vocabularyNotes: objectArray(parsed.vocabularyNotes),
      idiomHighlights: objectArray(parsed.idiomHighlights),
      advancedSentences: Array.isArray(parsed.advancedSentences) ? parsed.advancedSentences : [],
      bonusExpressions: Array.isArray(parsed.bonusExpressions) ? parsed.bonusExpressions : [],
    };
    job.status = 'done';
    job.meta = { book: lesson?.book || null, lessonId: lesson?.lesson || lessonNo, baseUrl, model };
    job.updatedAt = Date.now();
  saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '生成失败，请重试';
    job.updatedAt = Date.now();
  saveJob(job);
  } finally {
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  saveJob(job);
    scheduleForget(jobId); // 只清内存，KV 那份按 JOB_TTL 长期保留（分享链接靠它）
  }
}

/* ---------- 异步素材生成任务 ---------- */
async function runMaterialJob(jobId, { topic, level, style, baseUrl, model, apiKey }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
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
      keywords: (Array.isArray(parsed.keywords) ? parsed.keywords : []).filter((k) => typeof k === 'string' || typeof k === 'number').map(String).filter(Boolean),
    };
    job.status = 'done';
    job.updatedAt = Date.now();
  saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '素材生成失败，请重试';
    job.updatedAt = Date.now();
  saveJob(job);
  } finally {
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  saveJob(job);
    scheduleForget(jobId); // 只清内存，KV 那份按 JOB_TTL 长期保留（分享链接靠它）
  }
}

/* ---------- 图片识别任务（拍照 / 导入图片 → 视觉模型逐字转写） ---------- */
async function runOcrJob(jobId, { image, side, mode, vision }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
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
    job.updatedAt = Date.now();
  saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '图片识别失败，请重试';
    job.updatedAt = Date.now();
  saveJob(job);
  } finally {
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  saveJob(job);
    scheduleForget(jobId); // 只清内存，KV 那份按 JOB_TTL 长期保留（分享链接靠它）
  }
}

/* ---------- 自测题任务（根据收藏知识点出题） ---------- */
async function runQuizJob(jobId, { points, count, level, baseUrl, model, apiKey }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
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
    job.updatedAt = Date.now();
  saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '生成自测题失败，请重试';
    job.updatedAt = Date.now();
  saveJob(job);
  } finally {
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  saveJob(job);
    scheduleForget(jobId); // 只清内存，KV 那份按 JOB_TTL 长期保留（分享链接靠它）
  }
}

/* ---------- server ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
/** 判断目标路径确实位于 dist 目录内（防目录穿越）。
 *  注意 rel === '' 表示 dist 根目录本身（请求 "/"），必须放行，否则整站 403。 */
function insideDist(file) {
  const rel = path.relative(DIST, file);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function serveStatic(res, pathname) {
  let file = path.normalize(path.join(DIST, pathname));
  // 用 path.relative 判断越界（原来的 file.startsWith(DIST) 写法脆弱：
  // 若存在 dist-xxx 这样的同级目录，前缀判断会误判为"在 dist 内"）
  if (!insideDist(file)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
    if (!fs.existsSync(file)) return index(res);
  }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  // 带内容 hash 的资源与字体可以长期强缓存；index.html 每次校验，保证发版立刻生效
  headers['Cache-Control'] = /-[A-Za-z0-9_]{8}\.(js|css)$/.test(path.basename(file)) || ext === '.woff2'
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}
function index(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body><h1>回译训练工作室</h1><p>开发模式请访问 Vite 服务（默认 http://localhost:5173）。运行 npm run dev 后打开前端。</p></body></html>');
}

// 跨域白名单：默认不发送任何 CORS 头（只服务同源页面）。
// 需要跨域时用 ALLOW_ORIGIN=https://a.com,https://b.com 显式列白名单。
// 原先无条件 Access-Control-Allow-Origin: *，等于允许任意网站驱动本机后端。
//
// 末尾斜杠一律去掉：浏览器发的 Origin 头永远是 `协议://域名[:端口]`、不带路径，
// 而人写配置时习惯性会多打一个 "/" —— 那样会**静默**匹配不上（不报错，只是前端拿不到数据）。
const ALLOWED_ORIGINS = String(process.env.ALLOW_ORIGIN || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // 会调用模型的接口先过限流，避免被脚本批量刷（也防匿名白嫖服务端 key）
    if (req.method === 'POST' && ['/api/analyze', '/api/ocr', '/api/quiz', '/api/generate-material', '/api/match'].includes(p) && rateLimited(req)) {
      return json(res, 429, { error: '请求过于频繁，请稍后再试（每分钟上限 ' + RATE_MAX + ' 次）' });
    }

    /* ---------- 云同步：同步码 → 一份快照 JSON ----------
     * 同步码本身就是凭证（128 位随机），拿到码的人可以读写这份数据。
     * 推送用乐观锁（baseVersion），版本对不上就返回 409 + 云端最新数据，由前端合并后重试。 */
    if (p === '/api/sync/info') {
      return json(res, 200, { ok: true, store: syncStore.kind, durable: syncDurable, hosted: HOSTED });
    }
    if (p === '/api/sync/new' && req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: '请求过于频繁，请稍后再试' });
      const code = newSyncCode();
      await syncStore.write(code, { version: 1, updatedAt: Date.now(), device: '', data: emptySnapshot() });
      return json(res, 200, { ok: true, code, version: 1 });
    }
    const syncMatch = p.match(/^\/api\/sync\/(.+)$/);
    if (syncMatch) {
      const code = String(syncMatch[1] || '').toLowerCase();
      if (!isValidSyncCode(code)) return json(res, 400, { error: '同步码格式不正确（应为 32 位十六进制）' });
      if (req.method === 'GET') {
        const doc = await syncStore.read(code);
        if (!doc) return json(res, 404, { error: '同步码不存在，请检查是否输错' });
        return json(res, 200, { ok: true, version: doc.version, updatedAt: doc.updatedAt, data: doc.data });
      }
      if (req.method === 'POST') {
        if (rateLimited(req)) return json(res, 429, { error: '同步过于频繁，请稍后再试' });
        // 快照本身限 2MB，给 JSON 包装留点余量即可，不必解析 20MB 的 body
        const body = await readBody(req, MAX_SNAPSHOT_BYTES + 256 * 1024);
        const check = sanitizeSnapshot(body.data);
        if (!check.ok) return json(res, 413, { error: check.error });
        const data = check.data;
        // 云端没有这串码时**直接建**，而不是 404 让客户端放弃。
        //
        // 实测踩到的场景：换过存储后端（或免费托管的临时磁盘被清）之后，老用户的码在云端就
        // "不存在"了 —— 但他们本机数据完好，而且**每台设备用的都是同一串码**。
        // 这时候回 404 等于把用户卡死：每台设备都推不上去也拉不下来，一直显示"云端找不到"。
        // 让第一台推送的设备把槽位建起来，多设备就自动恢复了，码也不用换。
        //
        // 这样会不会把"打错码"也静默接受？不会 —— 手填新码时前端会先探一次（见 useExistingCode），
        // 打错的码在输入那一刻就被拦下了。
        if (check.dropped && (check.dropped.favorites || check.dropped.history)) {
          console.warn('同步快照丢弃了超限条目:', JSON.stringify(check.dropped));
        }
        // 用**原子的**比较并写入，而不是「先读版本 → 判断 → 再写」。
        //
        // 后者两次调用之间隔着一次网络往返（几十毫秒），两台设备同时提交时都可能读到
        // 同一个版本、都通过检查，然后后写的把先写的覆盖掉 —— **先写的那次更新永久丢失**，
        // 而且两边都不会收到 409，前端的重试也就救不回来。
        //
        // 云端没有这串码时直接建（版本从 0 起）：换过存储后端（或免费托管的临时磁盘被清）
        // 之后老用户的码在云端就"不存在"了，但他们本机数据完好、每台设备用的都是同一串码。
        // 这时候回 404 等于把用户卡死。让第一台推送的设备把槽位建起来，多设备自动恢复。
        // 打错的码不会因此被静默接受 —— 手填新码时前端会先探一次（见 useExistingCode）。
        const baseVersion = Number(body.baseVersion);
        const next = {
          version: (Number.isFinite(baseVersion) ? baseVersion : 0) + 1,
          updatedAt: Date.now(),
          device: String(body.device || '').slice(0, 40),
          data,
        };
        const cas = await syncStore.compareAndSwap(code, Number.isFinite(baseVersion) ? baseVersion : 0, next);
        if (!cas.ok) {
          const cur = cas.current || { version: 0, updatedAt: 0, data: emptySnapshot() };
          return json(res, 409, { error: '云端已被其它设备更新', version: cur.version, updatedAt: cur.updatedAt, data: cur.data });
        }
        return json(res, 200, { ok: true, version: next.version, updatedAt: next.updatedAt });
      }
    }
    /* ---------- 账号（可选：只有存储持久时才启用） ----------
     * 账号只是"帮你记住同步码"的一层，不替代同步码 ——
     * 同步码仍然是数据主键，出问题把账号层关掉就回到没有账号的状态。 */
    if (p === '/api/auth/config') {
      return json(res, 200, { ok: true, enabled: accountsOn, store: kv.kind, durable: kvDurable });
    }
    if (p.startsWith('/api/auth/')) {
      if (!accounts) {
        return json(res, 503, {
          error: '账号功能未启用：服务端没有配置持久存储。'
            + '托管平台的磁盘是临时的，在那里开账号会导致重新部署后所有账号丢失，所以默认关闭。'
            + '配置 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 后自动开启。',
        });
      }
      const action = p.slice('/api/auth/'.length);
      if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const ip = clientIp(req);
      const body = req.method === 'POST' ? await readBody(req, 64 * 1024) : {};

      const handlers = {
        register: () => accounts.register({ ...body, ip }),
        login: () => accounts.login({ ...body, ip, device: body.device }),
        logout: () => accounts.logout(token),
        'logout-all': () => accounts.logoutAll(token),
        me: () => accounts.me(token),
        sync: () => accounts.setSync(token, body.sync),
        'change-password': () => accounts.changePassword(token, body),
        'delete-account': () => accounts.deleteAccount(token, body),
        forgot: () => accounts.forgot({ email: body.email, ip }),
        'reset-password': () => accounts.resetPassword({ ...body, ip }),
      }[action];
      if (!handlers) return json(res, 404, { error: 'unknown auth api' });

      const r = await handlers();
      if (!r.ok) return json(res, r.status || 400, { error: r.error });
      const { ok: _ok, status, ...rest } = r;
      return json(res, status || 200, { ok: true, ...rest });
    }
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
        sync: { store: syncStore.kind, durable: syncDurable, hosted: HOSTED },
        accounts: { enabled: accountsOn, durable: kvDurable },
        // 分享链接（#job=xxx）的有效期与清理策略：保留多久、最多留多少条
        jobs: { store: kv.kind, durable: kvDurable, ttlDays: JOB_TTL_DAYS, max: JOB_MAX_COUNT, retained: Math.max(0, jobSeq - jobEvicted) },
      });
    }
    if (p === '/api/lessons' && req.method === 'GET') {
      // 非法 book 以前会被悄悄当成 null → 返回全部 348 课，前端以为筛选成功了。
      // 现在：不传 = 全部；传了但不是 1-4 = 明确 400。
      const rawBook = url.searchParams.get('book');
      let book = null;
      if (rawBook !== null && rawBook.trim() !== '') {
        const n = Number(rawBook);
        if (!isValidBook(n)) return json(res, 400, { error: 'book 必须是 1-4 的整数（不传则返回全部课次）' });
        book = n;
      }
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
      const body = await readBody(req, MAX_TEXT_BYTES);
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
      const body = await readBody(req, MAX_SMALL_BYTES);
      const topic = String(body.topic || '').trim();
      if (!topic) return json(res, 400, { error: '请填写主题，例如：春节、人工智能、城市通勤' });
      const level = String(body.level || '中级');
      const style = String(body.style || '生活故事');
      const model = String(body.model || '').trim() || stat.model();
      const ep = resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      const { baseUrl, apiKey } = ep;
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'material', title: '素材：' + topic, status: 'pending', createdAt: Date.now(), data: null, error: null });
      registerJob(jobId); // 登记序号 + 超上限时淘汰最旧的任务
      runMaterialJob(jobId, { topic, level, style, baseUrl, model, apiKey });
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    const materialMatch = p.match(/^\/api\/generate-material\/([A-Za-z0-9-]{8,64})$/);
    if (materialMatch && req.method === 'GET') {
      const job = await findJob(materialMatch[1]);
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

      const model = String(body.model || '').trim() || stat.model();
      const ep = resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      const { baseUrl, apiKey } = ep;
      // 视觉模型优先级：请求参数 > AI_VISION_MODEL > DeepSeek 路由默认 deepseek-flash > 主模型
      const visionModel = String(body.visionModel || '').trim() || defaultVisionModel(baseUrl, model);
      const visionEp = resolveEndpoint({
        bodyBase: body.visionBaseUrl,
        bodyKey: body.visionApiKey || apiKey,
        fallbackBase: envVisionBase() || baseUrl,
        fallbackKey: envVisionKey() || apiKey,
      });
      if (visionEp.error) return json(res, 400, { error: visionEp.error });
      const vision = {
        baseUrl: visionEp.baseUrl,
        model: visionModel,
        apiKey: visionEp.apiKey,
        // 主模型是纯文本模型时，自动回退到 DeepSeek 原生多模态的 flash
        fallbackModel: /deepseek/i.test(visionEp.baseUrl) && visionModel !== DEEPSEEK_VISION_MODEL ? DEEPSEEK_VISION_MODEL : '',
      };
      if (!vision.apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const side = body.side === 'chinese' ? 'chinese' : 'english';
      const mode = ['auto', 'handwriting', 'printed'].includes(body.mode) ? body.mode : 'auto';
      const jobId = randomUUID();
      saveJob({ jobId, kind: 'ocr', title: '图片识别 · ' + (side === 'chinese' ? '中文' : '英文'), status: 'pending', createdAt: Date.now(), data: null, error: null });
      registerJob(jobId);
      runOcrJob(jobId, { image, side, mode, vision });
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    const ocrMatch = p.match(/^\/api\/ocr\/([A-Za-z0-9-]{8,64})$/);
    if (ocrMatch && req.method === 'GET') {
      const job = await findJob(ocrMatch[1]);
      if (!job || job.kind !== 'ocr') return json(res, 404, { error: '任务不存在或已过期，请重新识别' });
      return json(res, 200, {
        ok: true,
        job: { jobId: job.jobId, status: job.status, data: job.data || null, error: job.error || null },
      });
    }
    if (p === '/api/quiz' && req.method === 'POST') {
      const body = await readBody(req, MAX_SMALL_BYTES);
      const points = (Array.isArray(body.points) ? body.points : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .slice(0, 60);
      if (!points.length) return json(res, 400, { error: '请先收藏一些知识点，再生成自测题' });
      const count = Math.max(1, Math.min(50, Number(body.count) || 10));
      const level = normalizeLevel(body.level);
      const model = String(body.model || '').trim() || stat.model();
      const ep = resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      const { baseUrl, apiKey } = ep;
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'quiz', title: '自测题 · ' + count + ' 题', status: 'pending', createdAt: Date.now(), data: null, error: null });
      registerJob(jobId);
      runQuizJob(jobId, { points, count, level, baseUrl, model, apiKey });
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    const quizMatch = p.match(/^\/api\/quiz\/([A-Za-z0-9-]{8,64})$/);
    if (quizMatch && req.method === 'GET') {
      const job = await findJob(quizMatch[1]);
      if (!job || job.kind !== 'quiz') return json(res, 404, { error: '任务不存在或已过期，请重新生成' });
      return json(res, 200, {
        ok: true,
        job: { jobId: job.jobId, status: job.status, data: job.data || null, error: job.error || null },
      });
    }
    if (p === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req, MAX_TEXT_BYTES);
      const chinese = String(body.chinese || '').trim();
      const draft = String(body.draft || '').trim();
      if (!chinese || !draft) return json(res, 400, { error: '缺少中文提示或英文初稿' });

      const userOriginal = String(body.original || '').trim();
      const lessonNo = body.lessonId != null ? Number(body.lessonId) : null;
      const lesson = userOriginal ? null : resolveLesson({ book: body.book, lessonId: lessonNo, title: body.title, chinese });
      const title = body.title || (lesson ? 'Lesson ' + lesson.lesson + ' · ' + (lesson.title_en || lesson.title_cn) : '自由回译训练');
      // 润色等级：小初 / 高考英语 / 四六级 / 考研·专四 / 专八
      const level = normalizeLevel(body.level);

      const model = String(body.model || '').trim() || stat.model();
      const ep = resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      const { baseUrl, apiKey } = ep;
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'analyze', title, status: 'pending', createdAt: Date.now(), data: null, error: null });
      registerJob(jobId);
      // 立即返回任务号，后台再调用模型；手机端/弱网不会因长时间占用请求而卡死
      runAnalyzeJob(jobId, {
        title, chinese, draft, original: lesson ? lesson.english : userOriginal,
        lesson, lessonNo, baseUrl, model, apiKey, level,
      });
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    const jobMatch = p.match(/^\/api\/analyze\/([A-Za-z0-9-]{8,64})$/);
    if (jobMatch && req.method === 'GET') {
      const job = await findJob(jobMatch[1]);
      if (!job) return json(res, 404, { error: '任务不存在或已过期，请重新提交' });
      return json(res, 200, {
        ok: true,
        job: { jobId: job.jobId, status: job.status, data: job.data || null, error: job.error || null },
      });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown api' });
    return serveStatic(res, p);
  } catch (e) {
    // 预期内的用户错误按原样返回；未预期的异常只在服务端日志留全量，不回显内部信息
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error(e);
    return json(res, 500, { error: '服务器内部错误，请稍后重试（详情见服务端日志）' });
  }
});

server.listen(PORT, () => {
  console.log('回译训练工作室后端已启动: http://localhost:' + PORT);
  console.log('模型: ' + stat.model() + ' @ ' + stat.baseUrl() + '  key: ' + (stat.hasKey() ? '已配置' : '未配置'));
  console.log('语料: ' + getCorpus().lessons.length + ' 课');
  console.log('云同步存储: ' + syncStore.kind + (syncDurable ? '（持久）' : '（本机文件 · 托管平台上会随休眠/重启清空）'));
  console.log('账号功能: ' + (accountsOn ? '已启用（存储 ' + kv.kind + '）' : '未启用（存储不持久）')
    + '  SMTP: ' + (process.env.SMTP_USER && process.env.SMTP_PASS ? '已配置' : '未配置（找回密码不可用）'));
  console.log('分享链接: 结果保留 ' + JOB_TTL_DAYS + ' 天（存储 ' + kv.kind + (kvDurable ? ' · 持久' : ' · 本机文件')
    + '）· 超出 ' + JOB_MAX_COUNT + ' 条自动淘汰最旧的（JOB_TTL_DAYS / JOB_MAX_COUNT 可调）');
  // 存储用量（键数）：给"离上限还有多远"一个量级；免费额度 256MB / 单库
  Promise.resolve(kv.dbSize())
    .then((n) => console.log('存储用量: ' + n + ' 个键' + (kv.kind === 'upstash' ? '（Upstash 免费额度 256MB，单条结果约 15-60KB）' : '（本机 data/kv）')))
    .catch(() => { /* 用量只是提示，读不到就算了 */ });
  loadJobSeq(); // 任务序号 / 淘汰指针：重启后接着上次的位置淘汰，不会一次性补删
  if (!syncDurable) {
    console.warn('⚠️  未配置 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN：同步数据写在容器本地磁盘，'
      + '托管平台重新部署或重启后会丢失。生产环境请按 .env.example 配置云端存储。');
  }
  if (!accountsOn) {
    console.warn('⚠️  账号功能未启用：托管平台的磁盘是临时的，在那里开账号会导致重新部署后账号全丢，'
      + '所以默认关闭。配置 UPSTASH_* 后自动开启。');
  } else if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('⚠️  未配置 SMTP_USER / SMTP_PASS：注册登录可用，但「找回密码」发不出邮件。');
  }
});

/* ---------- 退出前落盘 ----------
 * 任务落盘改成了防抖 + 异步，好处是不阻塞；代价是「最后一次变更」可能还在 200ms 的窗口里。
 * 部署平台（Render 等）重启时会先发 SIGTERM，正好用这个信号同步补写一次。
 * 只处理一次，避免重复触发；写完就正常退出。 */
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref(); // 兜底：连接没断干净也别卡住
  });
}
