/**
 * 逐课学习进度（"这一课我练过没有 / 练了几次 / 最好多少分"）。
 *
 * 为什么不能只靠历史记录：`bt-history` 只保留最近 20 条 —— 练到第 21 课之后，
 * 用户就再也看不出"我总共完成了多少课"。而这个数字恰恰是最能激励学习的东西。
 * 所以单独存一份**按 lessonKey 聚合**的进度表，不随历史淘汰。
 *
 * 存储结构（Object，键是 lessonKey）：
 *   { 'lesson:2-18': { n: 3, best: 86, last: 72, at: 1.7e12, ms: 372000 }, ... }
 *   n   = 完成次数（成功生成一次算一次）
 *   best= 历史最高分（用于"最好成绩"与激励）
 *   last= 最近一次得分
 *   at  = 最近一次完成时间（排序 / 同步时判定新旧）
 *   ms  = 累计练习用时
 *
 * 上限 2000 课：单条约 60 字节，2000 条约 120KB，远小于 5MB 配额。
 */
export const PROGRESS_KEY = 'bt-lesson-progress';
export const PROGRESS_MAX = 2000;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 读出全部进度；任何脏数据都当作"没有"，绝不让它把页面搞崩 */
export function loadProgress() {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PROGRESS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!isObj(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!k || !isObj(v)) continue;
      out[k] = {
        n: Math.max(0, Math.floor(num(v.n))),
        best: Math.max(0, num(v.best)),
        last: Math.max(0, num(v.last)),
        at: Math.max(0, num(v.at)),
        ms: Math.max(0, num(v.ms)),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveProgress(map) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(prune(map)));
    return true;
  } catch {
    return false; // 配额满：进度丢一次不影响使用，静默失败
  }
}

/** 超上限时只留最近完成的那些（按 at 倒序） */
export function prune(map, max = PROGRESS_MAX) {
  const entries = Object.entries(isObj(map) ? map : {});
  if (entries.length <= max) return Object.fromEntries(entries);
  entries.sort((a, b) => num(b[1] && b[1].at) - num(a[1] && a[1].at));
  return Object.fromEntries(entries.slice(0, max));
}

/**
 * 记一次完成。纯函数，返回**新的** map（不改原对象，方便 React 判等与同步合并）。
 * @param {string} lessonKey 形如 lesson:2-18 / lesson:my-<libId>-<lid> / free
 * @param {{score?: number, durationMs?: number, at?: number}} attempt
 */
export function recordAttempt(map, lessonKey, attempt = {}) {
  const key = String(lessonKey || '').trim();
  if (!key || key === 'free') return map; // 自由模式的成绩不归属于任何一课
  const prev = (isObj(map) && isObj(map[key])) ? map[key] : { n: 0, best: 0, last: 0, at: 0, ms: 0 };
  const score = Math.max(0, num(attempt.score));
  const at = num(attempt.at, Date.now());
  const next = {
    key,
    value: {
      n: prev.n + 1,
      best: Math.max(prev.best, score),
      last: score,
      at: Math.max(prev.at, at),
      ms: prev.ms + Math.max(0, num(attempt.durationMs)),
    },
  };
  const out = { ...(isObj(map) ? map : {}) };
  out[next.key] = next.value;
  return out;
}

/** 某一课的进度（没有则 null） */
export function progressOf(map, lessonKey) {
  const v = isObj(map) ? map[String(lessonKey || '')] : null;
  return isObj(v) && v.n > 0 ? v : null;
}

/**
 * 统计一批课文里练过几课（侧栏"本册进度"用）。
 * @param {string[]} lessonKeys 该册（或该自建库）全部课文的 key
 * @returns {{done: number, total: number, attempts: number, best: number}}
 */
export function summarize(map, lessonKeys) {
  const keys = Array.isArray(lessonKeys) ? lessonKeys : [];
  let done = 0;
  let attempts = 0;
  let best = 0;
  for (const k of keys) {
    const v = progressOf(map, k);
    if (!v) continue;
    done += 1;
    attempts += v.n;
    best = Math.max(best, v.best);
  }
  return { done, total: keys.length, attempts, best };
}

/**
 * 合并两份进度（跨设备同步用）。纯函数。
 *
 * 计数取 max 而不是相加：同一课在两台设备上都练过时，两边的数字会各自包含
 * "从对方同步过来的那部分"，相加必然重复计数（用户会看到"我明明只练了 3 次，显示 6 次"）。
 * max 不会虚高；"有没有完成"和"最高分"这两个真正驱动展示的字段也不会丢。
 */
export function mergeProgress(a, b) {
  const left = isObj(a) ? a : {};
  const right = isObj(b) ? b : {};
  const out = { ...left };
  for (const [k, v] of Object.entries(right)) {
    if (!isObj(v)) continue;
    const cur = out[k];
    if (!isObj(cur)) { out[k] = v; continue; }
    out[k] = {
      n: Math.max(num(cur.n), num(v.n)),
      best: Math.max(num(cur.best), num(v.best)),
      last: num(v.at) >= num(cur.at) ? num(v.last) : num(cur.last),
      at: Math.max(num(cur.at), num(v.at)),
      ms: Math.max(num(cur.ms), num(v.ms)),
    };
  }
  return prune(out);
}

/** 已完成的课文 key 集合（侧栏打星用，避免每行都做一次查找） */
export function doneSet(map) {
  const s = new Set();
  for (const [k, v] of Object.entries(isObj(map) ? map : {})) {
    if (isObj(v) && num(v.n) > 0) s.add(k);
  }
  return s;
}
