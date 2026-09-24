import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promises as dnsLookup } from 'node:dns';
import { SYSTEM_PROMPT, buildUserMessage, EN2CN_SYSTEM_PROMPT, buildEn2CnUserMessage, MATERIAL_PROMPT, buildMaterialMessage, QUIZ_PROMPT, buildQuizMessage, DRILL_PROMPT, buildDrillMessage, GRADE_PROMPT, GRADE_STREAM_PROMPT, buildGradeMessage, STREAM_FORMAT_RULES, OVERALL_REPAIR_PROMPT, buildOverallRepairMessage, AI_LEVEL_KEYS, DEFAULT_AI_LEVEL, normalizeLevel } from './prompt.mjs';
import { MAX_DRILL_COUNT, MAX_DRILL_POINTS, MAX_GRADE_ITEMS } from './limits.mjs';
import { sanitizeGrades, sanitizeQuestions } from './questionShape.mjs';
import { createGradeReader, finalizeGrades } from './gradeStream.mjs';
import { createResultReader, finalizeResult, SEGMENT_LABEL, usableOverall } from './analyzeStream.mjs';
import { recognizeImage } from './ocr.mjs';
import { MAX_SNAPSHOT_BYTES, createSyncStore, emptySnapshot, isValidSyncCode, newSyncCode, sanitizeSnapshot } from './sync.mjs';
import { createUpstashKv, createFileKv } from './kv.mjs';
import { resolveClientIp, trustProxyHops, trustCloudflareHeader } from './client-ip.mjs';
import { createAccounts } from './accounts.mjs';
import { createClassrooms } from './classrooms.mjs';
import { sanitizeOverall, sanitizeSentences } from './resultShape.mjs';
import { staleMsFor } from './job-stale.mjs';
// 方向常量与前端共用一份（src/direction.js 是纯常量模块，不碰 DOM）
import { normalizeDirection } from '../src/direction.js';
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
const classrooms = accountsOn ? createClassrooms({ kv, accounts, findJob }) : null;

/* 语料 / 内置库 / 课文匹配拆到 server/corpus.mjs（原先这一节占 118 行，
   与 HTTP、任务、限流无关）。导出名保持不变，下面的调用点一行都不用改。 */
import { BOOK_META, BOOK_IDS, BOOK_LEVEL_HINT, allLessons, findLesson, getCorpora, getCorpus, isValidBook, matchLesson, resolveLesson } from './corpus.mjs';

/* ---------- API Key 归一化 ----------
 * 真实踩坑（线上实测）：在部署平台的环境变量框里粘贴 Key 时，很容易把界面上的说明文字
 * 一起带进去 —— 线上那把实际是 `sk-…dff 必`（"必填"标记连着空格被粘了进来）。
 * 后果不是"认证失败"这么直白：undici 的 fetch 直接抛
 *     Cannot convert argument to a ByteString because the character at index 43 …
 * 用户看到的是一句完全不知所云的英文；更隐蔽的是 hasKey 仍然是 true，
 * 从状态接口看不出任何异常，排查时得先猜"是 key 错了还是模型接口挂了"。
 *
 * Key 只可能是可打印 ASCII，所以这里把非 ASCII 字符与所有空白一律去掉；
 * 真的改动过内容时打一行警告（不静默），且每个变量只警告一次，避免刷日志。
 * 访客在前端手填的 Key 走同一套归一化 —— 从别处复制粘贴带上空格是同样常见的事。 */
function normalizeApiKey(raw) {
  const s = String(raw == null ? '' : raw);
  const cleaned = s.replace(/[^!-~]/g, '');
  return { key: cleaned, dirty: Boolean(s) && cleaned !== s };
}
const warnedDirtyKeys = new Set();
const warnDirtyKey = (name) => {
  if (warnedDirtyKeys.has(name)) return;
  warnedDirtyKeys.add(name);
  console.warn('⚠️  ' + name + ' 里混进了非 ASCII 字符或空白（常见于粘贴时带上了平台界面的提示文字），'
    + '已自动清理后使用。建议到部署平台核对该项，避免把多余字符一起发往模型服务商。');
};
const envKey = () => {
  const { key, dirty } = normalizeApiKey(process.env.AI_API_KEY);
  if (dirty) warnDirtyKey('AI_API_KEY');
  return key;
};
const envVisionBase = () => String(process.env.AI_VISION_BASE_URL || '').trim();

const envVisionKey = () => {
  const { key, dirty } = normalizeApiKey(process.env.AI_VISION_API_KEY);
  if (dirty) warnDirtyKey('AI_VISION_API_KEY');
  return key;
};

const stat = {
  baseUrl: () => String(process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').trim(),
  model: () => process.env.AI_MODEL || 'deepseek-chat',
  hasKey: () => Boolean(envKey()),
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


const sameEndpoint = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

/* ---------- 私网判定 ----------
 * 只做"字面主机名正则"是不够的，实测能绕过的两条路径：
 *   ① IPv4 映射形式的 IPv6：http://[::ffff:127.0.0.1]:8188/ 与 http://[::ffff:a9fe:a9fe]/
 *      （= 169.254.169.254 云元数据）。u.hostname 是 `[::ffff:7f00:1]`，
 *      既不匹配 ^127\. 也不是 ::1，原来的正则全部漏过。
 *   ② 域名解析到内网：localtest.me 之类"公网域名 → 127.0.0.1"，字面量判断永远看不出。
 * 所以下面把 IP 分类独立出来，并在校验时补一次 DNS 解析。 */
const looksLikeIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

function isPrivateIp4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;          // 本机 / 私有 / 未指定
  if (a === 169 && b === 254) return true;                    // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  if (a >= 224) return true;                                  // 组播 / 保留段
  return false;
}

function isPrivateIp6(ip) {
  if (ip === '::' || ip === '::1') return true;
  if (/^f[cd]/.test(ip)) return true;                         // fc00::/7 唯一本地地址
  if (/^fe[89ab]/.test(ip)) return true;                      // fe80::/10 链路本地
  if (ip.startsWith('ff')) return true;                       // 组播
  return false;
}

/** 判断一个 **IP 字面量** 是否属于不该被访客指定为出网目标的地址段 */
function isPrivateIp(raw) {
  const ip = String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;
  // IPv4 映射 / 兼容写法：::ffff:127.0.0.1、::ffff:7f00:1（十六进制形式）、::127.0.0.1
  const mapped = ip.match(/^::(?:ffff:)?(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) return isPrivateIp4(mapped[1]);
    const hi = parseInt(mapped[2], 16);
    const lo = parseInt(mapped[3], 16);
    return isPrivateIp4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.'));
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return isPrivateIp4(ip);
  if (ip.includes(':')) return isPrivateIp6(ip);
  return true; // 既不是 v4 也不是 v6：调用方不该走到这里，保守判私网
}

/** 主机名本身就可疑（不查 DNS 也能判定） */
function isPrivateName(host) {
  const h = String(host || '').toLowerCase();
  return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

/**
 * 访客自带的 Base URL 是否允许出网。
 * 域名会**真的解析一次**：任何一个解析结果落在内网就拒绝（挡住 localtest.me /
 * DNS rebinding 这类"字面量看着是公网、连过去是内网"的路径）。解析失败同样拒绝 ——
 * 连域名都解析不出来时，后续 fetch 也只会以更晦涩的方式失败。
 */
async function isSafeBaseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (ALLOW_PRIVATE_BASE) return true; // 自托管/测试显式放行内网
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateName(host)) return false;
  if (looksLikeIp(host)) return !isPrivateIp(host);
  try {
    const addrs = await dnsLookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch { return false; }
}

/**
 * 解析一次模型调用的接入点。
 * @returns {Promise<{baseUrl: string, apiKey: string} | {error: string}>}
 */
async function resolveEndpoint({ bodyBase, bodyKey, fallbackBase, fallbackKey }) {
  const base = String(bodyBase || '').trim();
  const key = normalizeApiKey(bodyKey).key; // 前端粘贴的 key 同样可能带空格/全角字符
  if (!base || sameEndpoint(base, fallbackBase)) {
    return { baseUrl: fallbackBase, apiKey: key || (ALLOW_SERVER_KEY ? fallbackKey : '') };
  }
  if (!(await isSafeBaseUrl(base))) {
    return { error: '该 Base URL 不被允许（只接受公网可解析的 http/https 地址）。如需指向内网地址，请改在服务端 .env 里配置 AI_BASE_URL，或设 ALLOW_PRIVATE_BASE_URL=1' };
  }
  if (!key) {
    return { error: '使用自定义 Base URL 时，必须同时填写该接口的 API Key（服务端密钥不会发往自定义地址）' };
  }
  return { baseUrl: base.replace(/\/+$/, ''), apiKey: key };
}

/* ---------- 限流（内存滑动窗口，按来源 IP） ----------
 * 只是"减速带"：挡脚本批量刷接口，不承担鉴权职责。
 *
 * ⚠️ 取 IP 必须谨慎：X-Forwarded-For 是**客户端可以自己写的**请求头，
 * 只有代理**追加在右端**的那部分才可信：
 *     攻击者发：X-Forwarded-For: 1.2.3.4, 5.6.7.8
 *     边缘代理追加后：1.2.3.4, 5.6.7.8, <真实 IP>
 * 原实现取 [0]（最左）—— 等于"客户端说自己是哪个 IP 就是哪个"：每次换一个假 IP
 * 就能无限刷模型接口（每个请求都在真花钱）。登录失败锁定也用了这个 IP，同样会被绕过。
 * 现在从**右往左**数自己信任的代理层数，左端一律不信。 */
const TRUST_PROXY_HOPS = trustProxyHops(process.env, HOSTED);
// CF-Connecting-IP 由 Cloudflare 边缘覆写、客户端改不动 —— 但**只有确定流量必经 CF** 时才可信：
// 源站能被直连时，攻击者自己带这个头反而绕过限流。所以做成显式开关。
const TRUST_CF_IP = trustCloudflareHeader(process.env);

function clientIp(req) {
  return resolveClientIp({
    headers: req.headers || {},
    socketIp: req.socket?.remoteAddress || '',
    hops: TRUST_PROXY_HOPS,
    trustCf: TRUST_CF_IP,
  });
}
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 30);
// 前端错误上报走独立限流桶：错误风暴不应该把「生成」的配额吃掉
const REPORT_RATE_MAX = Number(process.env.REPORT_LIMIT_PER_MIN || 60);
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();

/* ---------- 前端错误上报的落地 ----------
 * 只放内存：报错是"运维观察"用的短期数据，重启即清（真要长期留就把 recordClientError
 * 改成写 KV，但当前量级没必要）。上限 200 条，防止错误风暴把内存吃掉。 */
const CLIENT_ERRORS_MAX = 200;
const clientErrors = [];
function recordClientError(entry) {
  clientErrors.push(entry);
  if (clientErrors.length > CLIENT_ERRORS_MAX) clientErrors.splice(0, clientErrors.length - CLIENT_ERRORS_MAX);
  // 同时打到 stdout：Render 等平台的控制台日志能直接看到，不必等有人来查
  console.error('[client-error]', entry.kind, '|', entry.path, '|', entry.message.slice(0, 200));
}

/**
 * 按 IP 的固定窗口限流。
 * @param {string} bucketKey 可选的桶后缀：前端错误上报这类"不该和生成抢配额"的端点用独立桶
 * @param {number} max 该桶的上限（缺省用全局 RATE_MAX）
 */
/* 桶表必须**有界**：原来的清理只写在"命中已存在的桶"这条分支里，
   于是每次换一个来源 IP（IPv6 /64 内轮换、代理池都行）就永远走新桶分支，
   一次清理都不触发 —— 实测 6 万个不同 IP 打过来，表涨到 6 万条且 70 秒后不回落；
   而且清理是全表扫描（100 万桶时单次 43ms），挂在请求路径上会把事件循环卡住。 */
/* env 解析注意：不能用 `Number(env) || 默认值` —— 0 是假值，会被悄悄换成默认值
   （实测：MAX_QUEUED_JOBS=0 本意是"不许排队"，结果被解析成 50）。
   统一走这里的 posInt()：只认正整数字符串，其余（含 0、空、NaN）一律回落默认值。 */
const posInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && String(raw ?? '').trim() !== '' ? Math.floor(n) : fallback;
};
const RATE_BUCKET_MAX = Math.max(1, posInt(process.env.RATE_BUCKET_MAX, 20000));
// 音标兜底查询是全站唯一会**代表服务器**去打第三方接口的 GET 端点：
// 独立桶 + 独立上限，别让人借服务器 IP 刷 dictionaryapi.dev，也别和「生成」抢配额
const PHONETIC_RATE_MAX = Math.max(1, posInt(process.env.PHONETIC_RATE_LIMIT_PER_MIN, 60));

function sweepRateBuckets(now) {
  for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
  // 清完还是超限（说明都是活跃桶）：按插入顺序淘汰最旧的，宁可少记几个 IP 也不能让内存无上限
  if (rateBuckets.size > RATE_BUCKET_MAX) {
    const over = rateBuckets.size - RATE_BUCKET_MAX;
    let i = 0;
    for (const k of rateBuckets.keys()) { if (i++ >= over) break; rateBuckets.delete(k); }
  }
}
// 与请求路径解耦的兜底清扫：长期没人打接口时也能把内存还回去
setInterval(() => sweepRateBuckets(Date.now()), 60_000).unref();

function rateLimited(req, bucketKey = '', max = RATE_MAX) {
  const now = Date.now();
  const ip = clientIp(req) + (bucketKey ? '|' + bucketKey : '');
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    // 新桶也要参与有界性检查 —— 绕过的就是"只有命中旧桶才清理"这一点
    if (rateBuckets.size >= RATE_BUCKET_MAX) sweepRateBuckets(now);
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  if (rateBuckets.size >= RATE_BUCKET_MAX) sweepRateBuckets(now);
  return bucket.count > max;
}

// DeepSeek 最新的 flash 已原生支持图片输入，作为拍照识别（OCR）的默认视觉模型
const DEEPSEEK_VISION_MODEL = 'deepseek-flash';
function defaultVisionModel(baseUrl, model) {
  if (process.env.AI_VISION_MODEL) return process.env.AI_VISION_MODEL;
  return /deepseek/i.test(String(baseUrl || '')) ? DEEPSEEK_VISION_MODEL : model;
}

/* ---------- 音标/词性兜底查询（模型没给 phonetic/pos 时用，带内存缓存 + 熔断） ---------- */
const phoneticCache = new Map();
// 缓存必须**有界**（全站唯一一个曾经无界的内存结构）：单词组合空间近乎无限，
// 随机单词打过来每条都会 set —— 实测风险与 rateBuckets 桶表无界是同一类问题。
// 上限 2000 条（单条约 50 字节，合计 ~100KB），超限按插入顺序淘汰最旧的。
const PHONETIC_CACHE_MAX = Math.max(100, posInt(process.env.PHONETIC_CACHE_MAX, 2000));
function cachePhonetic(key, value) {
  phoneticCache.set(key, value);
  if (phoneticCache.size > PHONETIC_CACHE_MAX) {
    const over = phoneticCache.size - PHONETIC_CACHE_MAX;
    let i = 0;
    for (const k of phoneticCache.keys()) { if (i++ >= over) break; phoneticCache.delete(k); }
  }
}
const EMPTY_WORD_INFO = { phonetic: '', pos: '' };
let phoneticFailures = 0;
let phoneticDown = false; // 词典接口不可达时（例如国内网络）直接放弃，避免每次页面都等超时
async function lookupPhonetic(rawWord) {
  const key = String(rawWord || '').trim().toLowerCase();
  if (!key) return EMPTY_WORD_INFO;
  if (phoneticCache.has(key)) return phoneticCache.get(key);
  // 只查单个英文单词；含空格/斜杠的短语直接放弃，避免误查
  if (!/^[a-z][a-z'’-]{0,40}$/.test(key)) { cachePhonetic(key, EMPTY_WORD_INFO); return EMPTY_WORD_INFO; }
  if (phoneticDown) { cachePhonetic(key, EMPTY_WORD_INFO); return EMPTY_WORD_INFO; }
  let phonetic = '';
  let pos = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(key), { signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) {
      const data = await r.json();
      const list = Array.isArray(data) ? data : [];
      const posSet = [];
      for (const entry of list) {
        // 词性取全部 meanings 的 partOfSpeech 去重（词典源按义项分组，同一词性会出现多次）
        const meanings = Array.isArray(entry?.meanings) ? entry.meanings : [];
        for (const m of meanings) {
          const p = String(m?.partOfSpeech || '').trim();
          if (p && !posSet.includes(p)) posSet.push(p);
        }
        if (!phonetic && entry && typeof entry.phonetic === 'string' && entry.phonetic.trim()) phonetic = entry.phonetic.trim();
        if (!phonetic) {
          const arr = Array.isArray(entry?.phonetics) ? entry.phonetics : [];
          const hit = arr.find((x) => x && typeof x.text === 'string' && x.text.trim());
          if (hit) phonetic = hit.text.trim();
        }
      }
      pos = posSet.join('/');
      phoneticFailures = 0;
    } else {
      phoneticFailures += 1;
    }
  } catch {
    phoneticFailures += 1;
  }
  if (phoneticFailures >= 3) phoneticDown = true;
  const info = { phonetic, pos };
  cachePhonetic(key, info);
  return info;
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

/**
 * 已被用户删除的任务号。
 * 为什么需要：生成中的任务在**跑完之后**还会 saveJob 一次（写 status/结果），
 * 不加这道闸，用户删掉的记录会被那个收尾写入重新写回 KV，看起来就是"删不掉"。
 * 只放内存即可 —— 进程重启后本来就不存在"还在跑的旧任务"。
 */
const deletedJobs = new Set();
const DELETED_JOBS_MAX = 1000;

function markJobDeleted(jobId) {
  deletedJobs.add(jobId);
  if (deletedJobs.size > DELETED_JOBS_MAX) {
    deletedJobs.delete(deletedJobs.values().next().value);
  }
}

/** 删除一条任务记录：内存 + KV 都要删，并挡住后续的收尾写入。 */
async function deleteJob(jobId) {
  markJobDeleted(jobId);
  jobs.delete(jobId);
  try {
    await kv.del(JOB_PREFIX + jobId);
  } catch (e) {
    console.error('删除任务失败:', e.message);
    throw e;
  }
}

/** 定长比较（删除凭据），避免用 === 比字符串泄露长度/前缀信息。 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** 内存是快路径，KV 是持久层。写入不阻塞请求（任务状态更新很频繁）。 */
function saveJob(job) {
  if (!job || !job.jobId) return;
  if (deletedJobs.has(job.jobId)) return; // 已被用户删除：别把收尾写入变成"复活"
  jobs.set(job.jobId, job);
  Promise.resolve(kv.set(JOB_PREFIX + job.jobId, JSON.stringify(job), JOB_TTL_SEC))
    .catch((e) => console.error('任务落盘失败:', e.message));
}

/**
 * 把任务标记为失败（safeRun 的兜底动作）。
 * 一定要写进 job.error：用户看到的是「明确失败 + 原因」，而不是一直转圈到超时。
 */
function markJobFailed(jobId, e) {
  const message = (e && e.message) || '未知错误';
  // userFacing：排队被拒这类文案本来就是写给用户看的，不该再套一层"服务端任务异常"
  const text = e && e.userFacing
    ? message
    : '服务端任务异常：' + message + '（请重试；若反复出现请把这句话发给开发者）';
  const apply = (job) => {
    if (!job) return;
    job.status = 'error';
    job.error = text;
    job.updatedAt = Date.now();
    saveJob(job);
  };
  try {
    const mem = jobs.get(jobId);
    if (mem) { apply(mem); return undefined; }
    // 连 job 都没拿到（比如 findJob 自己就抛了）：按内存 → KV 的顺序再试一次，
    // 仍然失败就只记日志 —— 兜底动作本身绝不能再抛出去。
    return Promise.resolve()
      .then(() => findJob(jobId))
      .then(apply)
      .catch((err) => console.error('[job] 标记失败时又失败:', jobId, err && err.message));
  } catch (err) {
    console.error('[job] 标记失败:', jobId, err && err.message);
    return undefined;
  }
}

/**
 * 任务入口的统一兜底。
 *
 * 为什么必须有：四条链路（分析/素材/OCR/自测题）都是 `runXxxJob(jobId, …)` 这样
 * **即发即忘**地调用的，没有任何 .catch()。而 Node 15+ 对未处理的 Promise 拒绝
 * 默认是**直接结束进程** —— 一次 Upstash 抖动、一次 KV 读失败，就能把整个服务带走，
 * 所有正在跑的 30-120 秒任务一起陪葬（用户看到「生成中」永远转圈，钱也白花了）。
 * 这里把三件事绑在一起：记日志（带任务名 + jobId）、把任务标为 error、绝不冒泡。
 */
/* ---------- 并发闸门 ----------
 * 限流（每分钟多少次）**不是**资源保护：它管不住"同时有多少个任务在跑"。
 * OCR 单个请求 body 上限 20MB，一张 12MB 图片的 dataURL 约 16MB，会一直被闭包引用到识别结束；
 * 实测 6 个并发 OCR 就能吃掉免费档 512MB 内存的一大半，30 个/分钟更不用说。
 * 这里加一道最朴素的闸门：超过上限就排队，队列也满了直接 503 —— 而不是把进程拖到 OOM
 * （OOM 会连累所有正在跑的任务一起死）。 */
const MAX_INFLIGHT_JOBS = Math.max(1, posInt(process.env.MAX_INFLIGHT_JOBS, 4));
const MAX_QUEUED_JOBS = posInt(process.env.MAX_QUEUED_JOBS, 50);
let inflightJobs = 0;
const jobQueue = [];

/** 抢一个并发名额（满了就排队；队列满则直接拒绝）。名额在任务结束时**转交**给下一个排队者。 */
async function acquireJobSlot() {
  if (inflightJobs < MAX_INFLIGHT_JOBS) { inflightJobs += 1; return true; }
  if (jobQueue.length >= MAX_QUEUED_JOBS) return false;
  await new Promise((resolve) => jobQueue.push(resolve));
  return true; // 名额由释放方转交，这里不再自增（否则会多算一个）
}
function releaseJobSlot() {
  const next = jobQueue.shift();
  if (next) next();               // 名额转交：计数保持不变
  else inflightJobs -= 1;
}

function safeRun(name, jobId, fn) {
  return acquireJobSlot()
    .then((got) => {
      if (!got) {
        const busy = new Error('服务器正忙（同时在跑的任务已达上限），请过一会儿再试 —— 这次没有调用模型，不产生费用。');
        busy.userFacing = true;
        return markJobFailed(jobId, busy);
      }
      return Promise.resolve()
        .then(fn)
        .catch((e) => {
          console.error('[job] ' + name + ' 异常:', jobId, (e && e.stack) || e);
          return markJobFailed(jobId, e);
        })
        .finally(releaseJobSlot);
    });
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
  // ⚠️ 这一行不能少：原来只有上面的 get、没有这里的 set，
  // 于是 last 恒为 0，"每天最多续期一次"是死代码 —— 每次从 KV 读回老任务都会再写一次整条记录
  // （写放大 + 白烧共享存储的命令数）。注意要在发起写入时记，而不是等它成功：
  // 续期本身是尽力而为，失败也不该变成"每次都重试"。
  jobRenewedAt.set(job.jobId, Date.now());
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
 * 故障演练开关（生产不设这个环境变量）：
 *   FAULT_INJECT=findJob:1  → 第 1 次 findJob 抛错（只影响这一次）
 * 用来回归「任务入口抛异常不能把进程带走」这条 —— 没有它就只能靠线上偶发故障来发现。
 */
const FAULT_INJECT = String(process.env.FAULT_INJECT || '');
let faultFindJobLeft = FAULT_INJECT.includes('findJob') ? Math.max(1, Number(FAULT_INJECT.split(':')[1]) || 1) : 0;

/**
 * 取任务：内存没有就去 KV 找。
 * **部署重启后靠这一步把进行中的任务捞回来** —— 这是本次改动的全部意义。
 */
async function findJob(jobId) {
  if (faultFindJobLeft > 0) { faultFindJobLeft -= 1; throw new Error('fault-inject: findJob 失败（演练用）'); }
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
 * 异步函数，重启就没了。所以一个正在跑的任务如果服务端重启，它会永远停在 running。
 *
 * 这里按时间兜底：超过阈值还没落定，就明确判为失败，让用户看到原因而不是干等。
 *
 * 阈值表在 job-stale.mjs（单独成文件是为了能被测试引用，见那里的说明）——
 * 核心不变式：**服务端阈值必须小于前端各自的轮询上限**，否则用户先吃到"等待超时"，
 * 服务端却还认为任务在跑，而且客户端放弃后任务还在继续调模型花钱。
 */
function guardStale(job) {
  if (!job || (job.status !== 'running' && job.status !== 'pending')) return job;
  const ts = Number(job.updatedAt || job.createdAt || 0);
  if (ts && Date.now() - ts > staleMsFor(job.kind)) {
    job.status = 'error';
    job.error = '这次任务超时没完成（常见原因：服务端重启，或模型接口长时间无响应）。请重新提交一次。';
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
/** 流式调用的等待上限：比普通调用长（批改要一条条往外写），但要小于任务僵尸阈值。
 *  前端还有自己的三道保险丝（首段 8s / 停顿 30s / 全程 150s），见 src/gradeStream.js。 */
const STREAM_TIMEOUT_MS = Number(process.env.AI_STREAM_TIMEOUT_MS || 4 * 60 * 1000);
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

async function postChat({ url, headers, body, withFormat, timeoutMs = 120000 }) {
  let r;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    r = await fetch(url, {
      method: 'POST', headers,
      signal: controller.signal,
      // 不跟随重定向。跟随 = 把"刚才验证过是公网"的目标换成响应头里指定的任意地址：
      // 攻击者用自己的公网域名通过校验，再回一个 307 Location: http://169.254.169.254/，
      // undici 会带着 body 跟过去 —— 前面所有私网校验全部白做。
      redirect: 'manual',
      body: JSON.stringify(withFormat ? Object.assign({}, body, { response_format: { type: 'json_object' } }) : body),
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('模型接口请求超时（' + Math.round(timeoutMs / 1000) + '秒），请稍后重试');
    throw new Error('无法连接模型接口: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location') || '(响应里没有 Location)';
    throw new Error('模型接口返回了重定向（' + r.status + ' → ' + loc + '）。出于安全考虑不自动跟随，请把 Base URL 直接写成最终地址。');
  }
  return r;
}

async function callLLM({ baseUrl, model, apiKey, messages, timeoutMs }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const baseBody = { model, messages, temperature: 0.3 };

  async function doPost(maxTokens) {
    const body = Object.assign({}, baseBody, { max_tokens: maxTokens });
    let r = await postChat({ url, headers, body, withFormat: true, timeoutMs });
    if (!r.ok && /response_format|format/i.test(await r.clone().text())) {
      r = await postChat({ url, headers, body, withFormat: false, timeoutMs });
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

/* ---------- 流式调用（批改边收边贴）----------
 * 与 callLLM 的区别只有两点：
 *  · `stream: true`，并且**不能带 response_format** —— response_format 要求"一次性输出一个 JSON"，
 *    与"一行一道题"的约定冲突（格式约束交给提示词，解析端有兜底，见 server/gradeStream.mjs）；
 *  · 每收到一段增量就回调 `onDelta`，调用方边解析边往界面上推。
 * 安全约定与 postChat 完全一致（不跟随重定向、超时、错误文案）。
 */
async function callLLMStream({ baseUrl, model, apiKey, messages }, { onDelta, timeoutMs = STREAM_TIMEOUT_MS, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const r = await postChat({
    url, headers, withFormat: false, timeoutMs,
    body: { model, messages, temperature: 0.3, stream: true, max_tokens: maxTokens },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('模型接口错误 ' + r.status + ': ' + t.slice(0, 500));
  }
  if (!r.body) throw new Error('模型接口没有返回流式响应体');

  let full = '';
  let finishReason = '';
  let buf = '';
  /** 吃一段 SSE 文本：拆 data: 行 → 取 choices[0].delta.content */
  const feedSse = (text) => {
    buf += text;
    let idx = buf.indexOf('\n');
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      idx = buf.indexOf('\n');
      if (!line || !line.startsWith('data:')) continue;       // 空行 / SSE 注释（心跳）
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }  // 半截行：跳过，下一块会补全
      const choice = (obj.choices && obj.choices[0]) || {};
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
      const delta = (choice.delta && choice.delta.content) || '';
      if (delta) { full += delta; if (onDelta) onDelta(delta); }
    }
  };

  /* 有的网关 / 自建代理**不认 stream:true**，直接回一个普通 JSON。
   * 不能因此报"模型没有返回内容"——那等于把一整次生成判死。
   * 先看 content-type，不是事件流就把整段读回来：里头若有 data: 行就按 SSE 解析，
   * 否则按普通 completion 取 content（结果照常拿到，只是没有"边生成边显示"）。 */
  const ctype = String(r.headers.get('content-type') || '');
  if (!/text\/event-stream/i.test(ctype)) {
    const text = await r.text().catch(() => '');
    if (!/^\s*data:/m.test(text)) {
      let content = '';
      try {
        const data = JSON.parse(text);
        const c0 = (data.choices && data.choices[0]) || {};
        content = (c0.message && c0.message.content) || (c0.delta && c0.delta.content) || '';
        if (c0.finish_reason) finishReason = String(c0.finish_reason);
      } catch { /* 不是 JSON：下面统一报错 */ }
      if (!String(content).trim()) throw new Error('模型没有返回内容，请重试');
      console.warn('[stream] 该模型接口忽略了 stream=true（返回的是普通 JSON），本次按一次性结果处理');
      if (onDelta) onDelta(String(content));
      full = String(content);
      if (finishReason === 'length') console.warn('[stream] 输出被 max_tokens 截断，可能有内容不完整');
      return { text: full, finishReason, streamed: false };
    }
    feedSse(text);
  } else {
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of r.body) feedSse(decoder.decode(chunk, { stream: true }));
  }
  if (!full.trim()) throw new Error('模型没有返回内容，请重试');
  if (finishReason === 'length') console.warn('[stream] 输出被 max_tokens 截断，可能有内容不完整');
  return { text: full, finishReason, streamed: true };
}

/* ---------- 异步分析任务 ---------- */
/**
 * 把模型给的解析对象收敛成 job.data —— **一次性解析与流式收尾共用同一份**。
 *
 * 为什么必须共用：流式是"边生成边显示"，如果最终落库走另一套映射，
 * 就会出现"我看到的"和"历史里存下来的"不是同一个东西（少一句、少一条点评），
 * 而这种不一致只有在用户回头看历史时才会发现。
 */
function buildAnalyzeData({ parsed, dir, title, chinese, draft, original, level, lesson, lessonNo }) {
  // 清洗 findings：丢掉「went → went」这类无意义对照（模型偶尔会为凑数而生造），
  // 丢了多少条打进日志 —— 数量长期偏高就说明 prompt 需要再收一收。
  const cleanedSentences = sanitizeSentences(parsed.sentences);
  if (cleanedSentences.dropped > 0) {
    console.warn(`[analyze] 丢弃 ${cleanedSentences.dropped} 条无意义 findings（from 与 to 相同/缺失或重复）`);
  }
  return {
    direction: dir,
    title: parsed.title || title,
    chinese: parsed.chinese || chinese,
    draft: parsed.draft || draft,
    ai: parsed.ai || '',
    original: parsed.original || original,
    aiLevel: level || DEFAULT_AI_LEVEL,
    overall: sanitizeOverall(parsed.overall),
    sentences: cleanedSentences.list,
    vocabularyNotes: objectArray(parsed.vocabularyNotes),
    idiomHighlights: objectArray(parsed.idiomHighlights),
    advancedSentences: Array.isArray(parsed.advancedSentences) ? parsed.advancedSentences : [],
    bonusExpressions: Array.isArray(parsed.bonusExpressions) ? parsed.bonusExpressions : [],
    meta: { book: lesson?.book || null, lessonId: lesson?.lesson || lessonNo },
  };
}

async function runAnalyzeJob(jobId, { title, chinese, draft, original, lesson, lessonNo, baseUrl, model, apiKey, level, direction, stream = false }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  job.segments = [];              // 流式过程中逐步长出来的段（内存里读给 SSE 用）
  saveJob(job);
  try {
    // 两个方向共用同一套 JSON 字段（见 src/direction.js 的说明），只是 prompt 不同：
    // 汉译英把 chinese 当"中文提示"、original 当"英文原文"；
    // 英译汉把 chinese 当"英文原文"、original 当"参考译文"。
    const dir = normalizeDirection(direction);
    // 流式时在系统提示词后面追加"一行一段"的格式说明（内容要求原样保留，只换输出格式）
    const messages = dir === 'en2cn'
      ? [
        { role: 'system', content: EN2CN_SYSTEM_PROMPT + (stream ? STREAM_FORMAT_RULES : '') },
        { role: 'user', content: buildEn2CnUserMessage({ title, source: chinese, draft, reference: original, level }) },
      ]
      : [
        { role: 'system', content: SYSTEM_PROMPT + (stream ? STREAM_FORMAT_RULES : '') },
        { role: 'user', content: buildUserMessage({ title, chinese, draft, original, level }) },
      ];

    let raw = '';
    let segments = [];
    if (stream) {
      const reader = createResultReader();
      // 预算给到 32000：一行一段之后"逐句解析 + 词汇 + 习语 + 句式"的总量比一次性 JSON 更长，
      // 用默认的 20000 容易在写完整段之前就被截断（表现是综合评分/词汇/习语整块没有）
      const out = await callLLMStream({ baseUrl, model, apiKey, messages }, {
        maxTokens: RETRY_MAX_TOKENS,
        onDelta: (delta) => {
          const got = reader.feed(delta);
          if (!got.length) return;
          segments = segments.concat(got);
          job.segments = segments;
          // ⚠️ 这里**故意不写 KV**：每一段写一次库会把存储打爆（完成时统一写一次）。
          // 内存里这份就是 SSE 读的那份（findJob 先查内存，拿到的是同一个对象）。
          job.updatedAt = Date.now();
        },
      });
      raw = out.text;
      for (const seg of reader.flush()) segments.push(seg);
      job.streamStats = reader.stats;
      // 被 max_tokens 截断：后面的块（整体评价 / 词汇 / 习语…）根本没写出来。
      // 如实告诉用户，别让他以为"这些内容本来就不生成"。
      if (out.finishReason === 'length') {
        job.streamIncomplete = true;
        console.warn(`[analyze/stream] 输出被截断（finish_reason=length）：已收 ${segments.length} 段，可能有整块内容缺失`);
      }
      if (job.streamStats && job.streamStats.repaired) {
        console.warn(`[analyze/stream] ${job.streamStats.repaired} 段走了"形状归一"（模型没按示例写），内容已尽量救回`);
      }
    } else {
      raw = await callLLM({ baseUrl, model, apiKey, messages });
    }

    let parsed;
    if (stream) {
      const final = finalizeResult({ segments, rawText: raw, parseLoose: parseJsonLoose });
      parsed = final.parsed;
      job.streamMode = final.mode;   // stream（正常）/ fallback（模型没按一行一段来）/ empty
      if (!parsed) throw new Error('模型返回的内容无法解析（既不是分段格式，也不是完整 JSON），请重试或换模型');
    } else {
      try {
        parsed = parseJsonLoose(raw);
      } catch (e) {
        throw new Error('模型返回不是有效 JSON，请重试或换模型');
      }
    }
    job.data = buildAnalyzeData({ parsed, dir, title, chinese, draft, original, level, lesson, lessonNo });
    // 整体评价缺失（模型整块没写 / 只写了占位符）→ 先补一次小请求，再退到本地估算。
    // 这两步都只影响"有没有分数和建议"，不改变任何逐句批改内容。
    // 只有在**有逐句批改可依据**时才补这一次请求：没有 findings 时既没有依据，
    // 又会白白多花一次调用、把任务时长翻倍（并发名额测试就是这么被拖红的）。
    const findingCount = (job.data.sentences || []).reduce((n, x) => n + ((x && Array.isArray(x.findings)) ? x.findings.length : 0), 0);
    if (!usableOverall(job.data.overall) && findingCount > 0) {
      try {
        job.data.overall = await repairOverall({ baseUrl, model, apiKey, data: job.data });
        job.overallRepaired = true;
        console.warn('[analyze] 模型没给整体评价，已用一次补救请求补上');
      } catch (e) {
        job.data.overall = localOverall(job.data);
        job.overallRepaired = false;
        console.warn('[analyze] 整体评价补救失败，改用本地估算：' + (e && e.message));
      }
    }
    if (job.streamIncomplete) job.data.incomplete = true;
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
async function runQuizJob(jobId, { points, count, level, baseUrl, model, apiKey, drill = false, materials = '' }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  saveJob(job);
  try {
    // 错误训练与自测题共用这个任务（限流/僵尸判定/结果清洗都一样），只有提示词不同
    const messages = drill
      ? [
        { role: 'system', content: DRILL_PROMPT },
        { role: 'user', content: buildDrillMessage({ points, count, level, materials }) },
      ]
      : [
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
    const rawQuestions = (Array.isArray(parsed.questions) ? parsed.questions : [])
      .filter((q) => q && (q.question || q.answer))
      .map((q) => ({
        type: String(q.type || '问答'),
        question: String(q.question || ''),
        options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : [],
        answer: String(q.answer || ''),
        explanation: String(q.explanation || ''),
        source: String(q.source || ''),
      }));
    // 形状清洗（见 server/questionShape.mjs）：丢掉"中文提示被挖空"和"同一句话出两道题"的题。
    // 这两类毛病只在真模型上偶发，提示词拦不住 —— 用户实测反馈过（填空把中文挖了、
    // 同一句先出填空再出改错）。drill 才启用这两条：自测题的题干本来就是知识点，不适用。
    const { questions, dropped } = sanitizeQuestions(rawQuestions, { count, drill });
    if (dropped.chineseBlank || dropped.duplicate || dropped.incomplete) {
      console.warn(`[quiz${drill ? '/drill' : ''}] 丢弃题目：中文被挖空 ${dropped.chineseBlank} 条 · 同句重复 ${dropped.duplicate} 条 · 不完整 ${dropped.incomplete} 条`);
    }
    if (!questions.length) throw new Error('模型没有生成有效题目，请重试');
    job.data = {
      // 兜底标题要分模式：错误训练若沿用"收藏知识点自测"，题目页的标题就跟功能对不上
      title: parsed.title || (drill
        ? ('错误训练 · ' + questions.length + ' 题')
        : ('收藏知识点自测（' + questions.length + ' 题）')),
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

/* ---------- 整体评价缺失时的兜底 ----------
 * 线上实测：真模型偶尔整块不写 overall（或只写一个省略号占位），结果页就是
 * "综合评分 - 、练习建议空"。先补一次**专门只问 overall**的小请求（几秒、几百 token），
 * 补不到再用逐句批改的统计给一份**本地估算**并标注出来 —— 绝不假装这是 AI 的判断。
 */
function localOverall(data) {
  const findings = (data.sentences || []).flatMap((x) => (Array.isArray(x.findings) ? x.findings : []));
  const by = (lv) => findings.filter((f) => f && f.level === lv).length;
  const errors = by('error'), improves = by('improve'), studies = by('study');
  const cats = new Map();
  for (const f of findings) {
    const k = String((f && f.category) || '其它');
    cats.set(k, (cats.get(k) || 0) + 1);
  }
  const top = [...cats].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const score = Math.max(40, Math.min(100, Math.round(100 - errors * 4 - improves * 1.5 - studies * 0.5)));
  return {
    local: true,
    score,
    issues: findings.length,
    summary: '本次共 ' + findings.length + ' 处分析：必改 ' + errors + ' 处、可提升 ' + improves
      + ' 处、对照学习 ' + studies + ' 处。' + (top.length ? '集中在' + top.map(([c, n]) => c + '（' + n + ' 处）').join('、') + '。' : ''),
    highlights: [],
    advice: top.map(([c, n]) => '重点复习「' + c + '」类问题（本次 ' + n + ' 处）'),
    scoreBreakdown: [],
  };
}

/** 补一次"只问 overall"的请求；失败返回 null（调用方退到本地估算） */
async function repairOverall({ baseUrl, model, apiKey, data }) {
  const findings = (data.sentences || []).flatMap((x) => (Array.isArray(x.findings) ? x.findings : []));
  const messages = [
    { role: 'system', content: OVERALL_REPAIR_PROMPT },
    { role: 'user', content: buildOverallRepairMessage({ title: data.title, chinese: data.chinese, draft: data.draft, ai: data.ai, findings }) },
  ];
  // 短超时（45 秒）：补救只是"锦上添花"，绝不能因为它把任务拖住、占着并发名额
  const raw = await callLLM({ baseUrl, model, apiKey, messages, timeoutMs: 45000 });
  const parsed = parseJsonLoose(raw);
  const overall = sanitizeOverall(parsed && parsed.overall && typeof parsed.overall === 'object' ? parsed.overall : parsed);
  if (!usableOverall(overall)) throw new Error('补救请求也没给出可用的整体评价');
  return overall;
}

/* ---------- 自测卷批改任务（mode=grade）----------
 * 与出题**共用一条任务链路**（同样的 job kind=quiz、同样的轮询端点、同样的限流与僵尸判定），
 * 只有提示词和返回形状不同：出题返回 questions，批改返回 grades。
 * 另起一套端点只会把已经验证过的那些东西再抄一遍。
 *
 * 流式（stream=1）：模型一行一道题地往外写，每解析出一行就更新 job.grades，
 * 由 GET /api/quiz/:id/stream 推给浏览器 —— 学生看着点评一条条长出来，不用等整批写完。
 */
async function runGradeJob(jobId, { items, level, baseUrl, model, apiKey, stream = false }) {
  const job = await findJob(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  job.grades = [];                 // 流式过程中逐步长出来的判定（内存里读给 SSE 用）
  job.gradeTotal = items.length;
  saveJob(job);
  try {
    const messages = [
      { role: 'system', content: stream ? GRADE_STREAM_PROMPT : GRADE_PROMPT },
      { role: 'user', content: buildGradeMessage({ items, level }) },
    ];
    let raw = '';
    let streamed = [];
    let stats = null;
    if (stream) {
      const reader = createGradeReader({ itemCount: items.length });
      const out = await callLLMStream({ baseUrl, model, apiKey, messages }, {
        onDelta: (delta) => {
          const got = reader.feed(delta);
          if (!got.length) return;
          streamed = streamed.concat(got);
          job.grades = streamed;
          // ⚠️ 这里**故意不写 KV**：每行写一次库会把存储打爆（完成时统一写一次）。
          // 内存里这份就是 SSE 读的那份（findJob 先查内存，是同一个对象）。
          job.updatedAt = Date.now();
        },
      });
      raw = out.text;
      for (const g of reader.flush()) streamed.push(g);
      stats = reader.stats;
      job.streamStats = stats;
    } else {
      raw = await callLLM({ baseUrl, model, apiKey, messages });
    }

    let grades;
    if (stream) {
      const final = finalizeGrades({ grades: streamed, rawText: raw, parseLoose: parseJsonLoose, itemCount: items.length });
      grades = final.grades;
      job.streamMode = final.mode;   // stream（正常）/ fallback（模型没按一行一题来）/ empty
    } else {
      let parsed;
      try {
        parsed = parseJsonLoose(raw);
      } catch {
        throw new Error('模型返回不是有效 JSON，请重试或换模型');
      }
      grades = sanitizeGrades(parsed, items.length);
    }
    if (!grades.length) throw new Error('模型没有给出批改结果，请重试');
    // 漏判的题目：不让它们变成"永远转圈"，由前端标成未批改（可以再点一次批改）
    if (grades.length < items.length) {
      console.warn(`[quiz/grade] 模型漏判 ${items.length - grades.length} 题`);
    }
    job.data = { grades };
    job.status = 'done';
    job.updatedAt = Date.now();
    saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || '批改失败，请重试';
    job.updatedAt = Date.now();
    saveJob(job);
  } finally {
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    saveJob(job);
    scheduleForget(jobId);
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Delete-Token');
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    /* ---------- 前端错误上报（自建，不引第三方 SDK）----------
     * 为什么需要：线上出问题时只能等用户截图 —— 等于"盲飞"。
     * 隐私：只收错误消息/堆栈/路径，**不收任何用户内容**；URL 里去掉 hash 与查询串
     *       （结果页的 #job=xxx 是分享凭证，不该进日志）。
     * 独立限流桶：错误风暴不该把「生成」的配额吃掉。 */
    if (p === '/api/report' && req.method === 'POST') {
      if (rateLimited(req, 'report', REPORT_RATE_MAX)) return json(res, 429, { error: 'too many reports' });
      const body = await readBody(req, 16 * 1024);
      const message = String(body.message || '').slice(0, 2000).trim();
      if (!message) return json(res, 400, { error: 'missing message' });
      recordClientError({
        kind: String(body.kind || 'unknown').slice(0, 20),
        message,
        stack: String(body.stack || '').slice(0, 4000),
        path: String(body.path || '').slice(0, 300),
        ua: String(req.headers['user-agent'] || '').slice(0, 300),
        at: Date.now(),
      });
      return json(res, 200, { ok: true });
    }
    // 取回最近的上报：默认关闭，只有服务端配了 REPORT_TOKEN 且调用方带对才给看
    // （错误栈里可能有内部路径信息，不能默认公开）
    if (p === '/api/reports' && req.method === 'GET') {
      const want = String(process.env.REPORT_TOKEN || '').trim();
      if (!want) return json(res, 404, { error: 'unknown api' });
      if (!safeEqual(url.searchParams.get('token'), want)) return json(res, 403, { error: 'forbidden' });
      return json(res, 200, { ok: true, count: clientErrors.length, reports: clientErrors.slice(-100).reverse() });
    }

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
        register: () => accounts.register({ ...body, ip, role: 'student' }),
        'teacher-register': () => accounts.register({ ...body, ip, role: 'teacher' }),
        'become-teacher': () => accounts.becomeTeacher(token),
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
      const { status, ...rest } = r; // ok 由下面统一回 true，不需要透传
      return json(res, status || 200, { ok: true, ...rest });
    }
    /* ---------- 教师班级与学生练习 ---------- */
    if (p.startsWith('/api/classes')) {
      if (!classrooms) return json(res, 503, { error: '班级功能需要持久存储；请配置 Upstash Redis' });
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const ip = clientIp(req);
      const body = req.method === 'POST' ? await readBody(req, 32 * 1024) : {};
      let result;
      if (p === '/api/classes' && req.method === 'GET') result = await classrooms.list(token);
      else if (p === '/api/classes' && req.method === 'POST') result = await classrooms.create(token, body.name);
      else if (p === '/api/classes/join' && req.method === 'POST') result = await classrooms.join({ ...body, ip });
      else if (p === '/api/classes/submit' && req.method === 'POST') result = await classrooms.submit({ ...body, ip });
      else {
        const match = p.match(/^\/api\/classes\/([a-f0-9]{32})(?:\/(archive))?$/);
        if (!match) return json(res, 404, { error: 'unknown class api' });
        if (match[2] === 'archive' && req.method === 'POST') result = await classrooms.archive(token, match[1]);
        else if (!match[2] && req.method === 'GET') result = await classrooms.detail(token, match[1]);
        else return json(res, 405, { error: 'method not allowed' });
      }
      if (!result.ok) return json(res, result.status || 400, { error: result.error });
      const { status, ...data } = result;
      return json(res, status || 200, data);
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
        books: [...getCorpora().values()].map((c) => ({
          book: c.book, label: c.label, lessons: c.lessons.length, source: c.source,
          levelHint: BOOK_LEVEL_HINT[c.book] || '',
          // 期望的语料文件名：库是空的时候前端据此提示"把语料放到 public/corpus/xxx.json"
          file: (BOOK_META[c.book] || {}).file || '',
        })),
        sync: { store: syncStore.kind, durable: syncDurable, hosted: HOSTED },
        accounts: { enabled: accountsOn, durable: kvDurable },
        // 分享链接（#job=xxx）的有效期与清理策略：保留多久、最多留多少条
        jobs: { store: kv.kind, durable: kvDurable, ttlDays: JOB_TTL_DAYS, max: JOB_MAX_COUNT, retained: Math.max(0, jobSeq - jobEvicted) },
        // 限流按什么算"一个客户端"：可信代理跳数配错会让限流失效（或被自己人误伤）
        // buckets：当前限流桶数（有界性的观测点 —— 被轮换 IP 打时它必须停在 RATE_BUCKET_MAX 附近）
        rateLimit: { perMin: RATE_MAX, trustProxyHops: TRUST_PROXY_HOPS, trustCfIp: TRUST_CF_IP, buckets: rateBuckets.size, bucketMax: RATE_BUCKET_MAX },
        // 并发闸门：同时在跑的模型任务数上限 / 排队上限（挡 OOM 用）
        concurrency: { maxInflight: MAX_INFLIGHT_JOBS, maxQueued: MAX_QUEUED_JOBS },
      });
    }
    if (p === '/api/lessons' && req.method === 'GET') {
      // 非法 book 以前会被悄悄当成 null → 返回全部 348 课，前端以为筛选成功了。
      // 现在：不传 = 全部；传了但不是 1-4 = 明确 400。
      const rawBook = url.searchParams.get('book');
      let book = null;
      if (rawBook !== null && rawBook.trim() !== '') {
        const n = Number(rawBook);
        if (!isValidBook(n)) return json(res, 400, { error: `book 必须是 ${BOOK_IDS[0]}-${BOOK_IDS[BOOK_IDS.length - 1]} 的整数（不传则返回全部课次）` });
        book = n;
      }
      const lessons = allLessons(book).map((l) => ({
        book: l.book, lesson: l.lesson, title_en: l.title_en, title_cn: l.title_cn,
        section: l.section || '', // 小标题分组（回译课文库的 六个级别段）——侧栏分组标题靠它
        pdf_page: l.pdf_page, englishLen: l.english.length, chineseLen: l.chinese.length,
      }));
      return json(res, 200, { book, lessons });
    }
    const lessonMatch = p.match(/^\/api\/lessons\/(?:(\d{1,2})\/)?(\d+)$/);
    if (lessonMatch && req.method === 'GET') {
      const book = Number(lessonMatch[1] || 2);
      const n = Number(lessonMatch[2]);
      if (!isValidBook(book)) return json(res, 400, { error: 'book 不合法' });
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
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      const { baseUrl, apiKey } = ep;
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'material', title: '素材：' + topic, status: 'pending', createdAt: Date.now(), data: null, error: null });
      registerJob(jobId); // 登记序号 + 超上限时淘汰最旧的任务
      safeRun('material', jobId, () => runMaterialJob(jobId, { topic, level, style, baseUrl, model, apiKey }));
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
      // 独立限流：这个端点会代表服务器去打第三方词典接口，单独给一个宽松但不设限的桶
      if (rateLimited(req, 'phonetic', PHONETIC_RATE_MAX)) return json(res, 429, { error: '音标查询太频繁，请稍后再试' });
      const word = url.searchParams.get('word') || '';
      if (!word.trim()) return json(res, 400, { error: '缺少 word 参数' });
      const info = await lookupPhonetic(word);
      return json(res, 200, { ok: true, word: word.trim(), phonetic: info.phonetic, pos: info.pos });
    }
    if (p === '/api/ocr' && req.method === 'POST') {
      const body = await readBody(req);
      const image = String(body.image || '');
      if (!image) return json(res, 400, { error: '缺少图片（image 字段）' });

      const model = String(body.model || '').trim() || stat.model();
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      const { baseUrl, apiKey } = ep;
      // 视觉模型优先级：请求参数 > AI_VISION_MODEL > DeepSeek 路由默认 deepseek-flash > 主模型
      const visionModel = String(body.visionModel || '').trim() || defaultVisionModel(baseUrl, model);
      const visionEp = await resolveEndpoint({
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
      safeRun('ocr', jobId, () => runOcrJob(jobId, { image, side, mode, vision }));
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
      // 同一个端点三种模式：出题（默认）/ drill（错误训练）/ grade（批改自测卷）。
      // 共用的原因：提交→轮询→限流→僵尸任务→结果清洗这条链路已经验证过，
      // 每加一种模式就抄一遍的话，改一处必然漏一处。
      const mode = String(body.mode || '');
      const drill = mode === 'drill';

      /* ---------- mode=grade：批改（只判"本地拿不准的题"，见 GRADE_PROMPT） ---------- */
      if (mode === 'grade') {
        // 题号**由服务端按批次位置重排**（不信客户端传什么）：模型只要照着回 0..n-1，
        // 形状清洗就能拿它当边界用；客户端负责把位置映射回卷子上的题号。
        const parsed = (Array.isArray(body.items) ? body.items : [])
          .slice(0, MAX_GRADE_ITEMS)
          .map((it) => ({
            type: String((it && it.type) || '').slice(0, 40),
            question: String((it && it.question) || '').slice(0, 1200),
            options: Array.isArray(it && it.options) ? it.options.slice(0, 8).map((o) => String(o)) : [],
            answer: String((it && it.answer) || '').slice(0, 1200),
            explanation: String((it && it.explanation) || '').slice(0, 800),
            userAnswer: String((it && it.userAnswer) || '').slice(0, 1200),
          }))
          .filter((it) => it.question || it.answer);
        const items = parsed.map((it, i) => ({ ...it, index: i }));
        if (!items.length) return json(res, 400, { error: '没有需要批改的题目' });
        const model = String(body.model || '').trim() || stat.model();
        const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
        if (ep.error) return json(res, 400, { error: ep.error });
        if (!ep.apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });
        const jobId = randomUUID();
        saveJob({ jobId, kind: 'quiz', title: '批改 · ' + items.length + ' 题', status: 'pending', createdAt: Date.now(), data: null, error: null });
        registerJob(jobId);
        // stream=1：一行一道题地流式批改（前端边收边贴，见 GET /api/quiz/:id/stream）。
        // 默认仍是关的 —— 老前端提交上来没有这个字段，行为一个字都不变。
        const stream = body.stream === true || body.stream === 1 || body.stream === '1';
        safeRun('quiz', jobId, () => runGradeJob(jobId, { items, level: normalizeLevel(body.level), baseUrl: ep.baseUrl, model, apiKey: ep.apiKey, stream }));
        return json(res, 200, { ok: true, jobId, status: 'pending', stream });
      }

      // 上限放宽到 120：前端现在**按题量精确送点**（10 道题就送 10 条错题，
      // 这样才知道用户做的是哪几条、下次好避开），题量上限 100 时不能再被 60 截断。
      const points = (Array.isArray(body.points) ? body.points : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .slice(0, MAX_DRILL_POINTS);
      // mode=drill：错误训练。走**同一条任务链路**（提交→轮询→试卷页），只换提示词与标题 ——
      // 另起一个端点只会把限流/僵尸任务/结果清洗这些已经验证过的东西再抄一遍。
      if (!points.length) return json(res, 400, { error: drill ? '选中的课时里没有找到错题' : '请先收藏一些知识点，再生成自测题' });
      // 100 是产品上限（与 src/constants.js 的 MAX_DRILL_COUNT、前端 generateDrill 一致）
      const count = Math.max(1, Math.min(MAX_DRILL_COUNT, Number(body.count) || 10));
      const level = normalizeLevel(body.level);
      const materials = drill ? String(body.materials || '').slice(0, MAX_SMALL_BYTES / 2) : '';
      const model = String(body.model || '').trim() || stat.model();
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      const { baseUrl, apiKey } = ep;
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      saveJob({ jobId, kind: 'quiz', title: (drill ? '错误训练 · ' : '自测题 · ') + count + ' 题', status: 'pending', createdAt: Date.now(), data: null, error: null });
      registerJob(jobId);
      safeRun('quiz', jobId, () => runQuizJob(jobId, { points, count, level, baseUrl, model, apiKey, drill, materials }));
      return json(res, 200, { ok: true, jobId, status: 'pending' });
    }
    /* ---------- 流式批改：GET /api/quiz/:id/stream（SSE） ----------
     * 只推**新增**的判定（?from=N / Last-Event-ID），断线重连不重放；
     * 15 秒一次注释心跳，防代理把长连接掐掉；
     * 结束时 event: done 带上**最终完整结果** —— 前端据此收敛，
     * 保证"边看边长出来的"和"最后存下来的"是同一个东西（与单词本的查词同构）。 */
    const quizStreamMatch = p.match(/^\/api\/quiz\/([A-Za-z0-9-]{8,64})\/stream$/);
    if (quizStreamMatch && req.method === 'GET') {
      const jobId = quizStreamMatch[1];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',        // 让 nginx / 平台代理不要缓冲
      });
      const NL = String.fromCharCode(10);
      const send = (event, data, id) => {
        // 带 id 行：断线重连时浏览器自动带 Last-Event-ID，下面才能从断点续传（不重放已收到的判定）
        if (id !== undefined && id !== null) res.write('id: ' + id + NL);
        res.write('event: ' + event + NL);
        res.write('data: ' + JSON.stringify(data) + NL + NL);
      };
      res.write(': connected' + NL + NL);

      const url0 = new URL(req.url, 'http://x');
      let cursor = Math.max(0, Number(url0.searchParams.get('from') || req.headers['last-event-id'] || 0) || 0);
      let closed = false;
      req.on('close', () => { closed = true; });
      const heartbeat = setInterval(() => { if (!closed) res.write(': ping' + NL + NL); }, 15000);

      try {
        const first = guardStale(await findJob(jobId)) || null;
        if (!first || first.kind !== 'quiz') { send('error', { error: '任务不存在或已过期，请重新批改' }); return res.end(); }
        // 已经跑完的任务（切走又回来 / 秒回）：一次性推完再结束
        if (first.status === 'done' || first.status === 'error') {
          const list = Array.isArray(first.grades) ? first.grades : [];
          for (let i = cursor; i < list.length; i += 1) send('grade', { grade: list[i], done: i + 1, total: first.gradeTotal || list.length }, i + 1);
          if (first.status === 'error') send('error', { error: first.error || '批改失败，请重试' });
          else send('done', { job: { jobId: first.jobId, status: 'done', data: first.data || null } });
          return res.end();
        }
        const deadline = Date.now() + staleMsFor('quiz');
        while (!closed && Date.now() < deadline) {
          const job = guardStale(await findJob(jobId)) || null;
          if (!job) { send('error', { error: '任务不存在或已过期，请重新批改' }); break; }
          const list = Array.isArray(job.grades) ? job.grades : [];
          for (let i = cursor; i < list.length; i += 1) {
            send('grade', { grade: list[i], done: i + 1, total: job.gradeTotal || list.length }, i + 1);
          }
          cursor = Math.max(cursor, list.length);
          if (job.status === 'done') { send('done', { job: { jobId: job.jobId, status: 'done', data: job.data || null } }); break; }
          if (job.status === 'error') { send('error', { error: job.error || '批改失败，请重试' }); break; }
          // 判定级轮询（250ms）：只读内存里那份 job（findJob 先查内存，是同一个对象），
          // 比任务级轮询快得多，也远小于写 KV 的代价（流式期间我们刻意不写 KV）
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) {
        if (!closed) send('error', { error: String((e && e.message) || e) });
      } finally {
        clearInterval(heartbeat);
        if (!closed) res.end();
      }
      return undefined;
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

      // 练习方向：汉译英（默认）/ 英译汉。脏值静默回落默认方向，与 level 的处理一致。
      const direction = normalizeDirection(body.direction);
      const userOriginal = String(body.original || '').trim();
      const lessonNo = body.lessonId != null ? Number(body.lessonId) : null;
      const lesson = userOriginal ? null : resolveLesson({ book: body.book, lessonId: lessonNo, title: body.title, chinese });
      const title = body.title || (lesson ? 'Lesson ' + lesson.lesson + ' · ' + (lesson.title_en || lesson.title_cn) : '自由回译训练');
      // 润色等级：小初 / 高考英语 / 四六级 / 考研·专四 / 专八
      const level = normalizeLevel(body.level);

      const model = String(body.model || '').trim() || stat.model();
      const ep = await resolveEndpoint({ bodyBase: body.baseUrl, bodyKey: body.apiKey, fallbackBase: stat.baseUrl(), fallbackKey: envKey() });
      if (ep.error) return json(res, 400, { error: ep.error });
      const { baseUrl, apiKey } = ep;
      if (!apiKey) return json(res, 400, { error: '未配置 AI_API_KEY：请复制 .env.example 为 .env 并填写，或在设置面板填入 API Key' });

      const jobId = randomUUID();
      // 删除凭据：分享链接是「可读」能力，不该顺带给出删除权，所以删除要另配一个只发一次的 token。
      // 只在**创建响应**里返回，GET /api/analyze/:jobId 不会带它。
      const deleteToken = randomBytes(16).toString('hex');
      // stream=1：模型一行一段地往外写，结果页边收边画（见 GET /api/analyze/:id/stream）。
      // 默认仍是关的 —— 老前端不带这个字段，行为一个字都不变。
      const stream = body.stream === true || body.stream === 1 || body.stream === '1';
      saveJob({ jobId, kind: 'analyze', title, status: 'pending', createdAt: Date.now(), data: null, error: null, deleteToken });
      registerJob(jobId);
      // 立即返回任务号，后台再调用模型；手机端/弱网不会因长时间占用请求而卡死
      safeRun('analyze', jobId, () => runAnalyzeJob(jobId, {
        title, chinese, draft, original: lesson ? lesson.english : userOriginal,
        lesson, lessonNo, baseUrl, model, apiKey, level, direction, stream,
      }));
      return json(res, 200, { ok: true, jobId, status: 'pending', deleteToken, stream });
    }

    /* ---------- 流式解析：GET /api/analyze/:id/stream（SSE） ----------
     * 只推**新增**的段（?from=N / Last-Event-ID），断线重连不重放；
     * 15 秒一次注释心跳，防代理把长连接掐掉；
     * 结束时 event: done 带上**最终完整结果**（服务端收敛过的）—— 前端据此覆盖 partial，
     * 保证"边看边长出来的"和"存进历史的"是同一个东西。 */
    const analyzeStreamMatch = p.match(/^\/api\/analyze\/([A-Za-z0-9-]{8,64})\/stream$/);
    if (analyzeStreamMatch && req.method === 'GET') {
      const jobId = analyzeStreamMatch[1];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const NL = String.fromCharCode(10);
      const send = (event, data, id) => {
        if (id !== undefined && id !== null) res.write('id: ' + id + NL);
        res.write('event: ' + event + NL);
        res.write('data: ' + JSON.stringify(data) + NL + NL);
      };
      res.write(': connected' + NL + NL);

      const url0 = new URL(req.url, 'http://x');
      let cursor = Math.max(0, Number(url0.searchParams.get('from') || req.headers['last-event-id'] || 0) || 0);
      let closed = false;
      req.on('close', () => { closed = true; });
      const heartbeat = setInterval(() => { if (!closed) res.write(': ping' + NL + NL); }, 15000);

      try {
        const first = guardStale(await findJob(jobId)) || null;
        if (!first || first.kind !== 'analyze') { send('error', { error: '任务不存在或已过期，请重新提交' }); return res.end(); }
        // 已经跑完的任务（切走又回来 / 秒回）：一次性推完再结束
        if (first.status === 'done' || first.status === 'error') {
          const list = Array.isArray(first.segments) ? first.segments : [];
          for (let i = cursor; i < list.length; i += 1) send('segment', { index: i, seg: list[i], label: SEGMENT_LABEL[list[i].t] || '' }, i + 1);
          if (first.status === 'error') send('error', { error: first.error || '生成失败，请重试' });
          else send('done', { job: { jobId: first.jobId, status: 'done', data: first.data || null } });
          return res.end();
        }
        const deadline = Date.now() + staleMsFor('analyze');
        while (!closed && Date.now() < deadline) {
          const job = guardStale(await findJob(jobId)) || null;
          if (!job) { send('error', { error: '任务不存在或已过期，请重新提交' }); break; }
          const list = Array.isArray(job.segments) ? job.segments : [];
          for (let i = cursor; i < list.length; i += 1) {
            send('segment', { index: i, seg: list[i], label: SEGMENT_LABEL[list[i].t] || '' }, i + 1);
          }
          cursor = Math.max(cursor, list.length);
          if (job.status === 'done') { send('done', { job: { jobId: job.jobId, status: 'done', data: job.data || null } }); break; }
          if (job.status === 'error') { send('error', { error: job.error || '生成失败，请重试' }); break; }
          // 段级轮询（250ms）：只读内存里那份 job（findJob 先查内存，是同一个对象），
          // 远小于写 KV 的代价（流式期间我们刻意不写 KV）
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) {
        if (!closed) send('error', { error: String((e && e.message) || e) });
      } finally {
        clearInterval(heartbeat);
        if (!closed) res.end();
      }
      return undefined;
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
    // 删除某次作业（历史记录里的「删除」）：服务端记录一并删掉，分享链接随即失效
    if (jobMatch && req.method === 'DELETE') {
      const job = await findJob(jobMatch[1]);
      if (!job) return json(res, 404, { error: '任务不存在或已被删除' });
      // 新任务带 deleteToken，必须匹配；老任务（本功能上线前创建）没有 token，
      // 为免"永远删不掉"仍允许删除 —— 它们本来就只靠不可猜的 jobId 保护。
      if (job.deleteToken && !safeEqual(req.headers['x-delete-token'], job.deleteToken)) {
        return json(res, 403, { error: '删除凭据不匹配：这条记录不是在本机生成的，无法删除' });
      }
      await deleteJob(job.jobId);
      return json(res, 200, { ok: true, deleted: job.jobId });
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
  console.log('限流: ' + RATE_MAX + ' 次/分钟 · 可信代理 ' + TRUST_PROXY_HOPS + ' 跳'
    + (TRUST_CF_IP ? ' · 信任 CF-Connecting-IP' : '') + '（TRUST_PROXY_HOPS / TRUST_CF_CONNECTING_IP 可调）');
  // 跳数配多了是**静默失效**（fail-open）：多信任一跳，XFF 里客户端自己伪造的那一段就会被当成真实 IP。
  // 方向不对称：配少了只会退回 socket（大家共用一个桶，误伤但安全），配多了等于限流不存在。
  if (TRUST_PROXY_HOPS >= 2) {
    console.warn('⚠️  限流信任 ' + TRUST_PROXY_HOPS + ' 跳代理。'
      + '如果前面实际只有 ' + (TRUST_PROXY_HOPS - 1) + ' 层，X-Forwarded-For 里"客户端能自己写的那一段"'
      + '会被当成真实 IP —— 攻击者每次换个假 IP 就能绕过限流（fail-open），而界面上没有任何症状。');
    console.warn('   请确认前面真的有 ' + TRUST_PROXY_HOPS + ' 层可信代理：'
      + 'Render 直连 = 1；Cloudflare / Nginx 在 Render 前面 = 2；本机或自托管直连 = 0。'
      + '当前生效值可查 /api/status 的 rateLimit 字段。');
  }
  if (TRUST_PROXY_HOPS === 0 && TRUST_CF_IP) {
    console.warn('⚠️  TRUST_CF_CONNECTING_IP=1 但可信代理跳数为 0：CF 头会优先于 0 跳生效，'
      + '请确认源站不可被直连（否则攻击者自带这个头即可绕过限流）。');
  }
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

/* ---------- 进程级兜底：只记日志，绝不退出 ----------
 * Node 15+ 默认把「未处理的 Promise 拒绝」当致命错误 —— 直接结束进程。
 * 对这个服务来说代价太大：一次外部存储抖动就会把正在跑的任务全丢掉。
 * 所以这里记下来继续跑（HTTP 层自己有 try/catch，会回 500）。
 * 真到了不可恢复的地步，健康检查会失败，部署平台自然会重启 —— 那是平台该管的事，
 * 不该由一次偶发的网络错误来决定。 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && (reason.stack || reason.message)) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', (err && (err.stack || err.message)) || err);
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
