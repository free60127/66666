/**
 * 本机存储（localStorage）统一入口 + 历史 / 结果缓存读写。
 *
 * 为什么必须有 safeGet/safeSet：裸调 localStorage 在 Safari 无痕、禁用站点数据、
 * 被 iframe 嵌入时会抛 SecurityError，而这些调用出现在首次 render 的惰性初始化里 ——
 * 一抛就是整页白屏，且没有任何降级路径。
 */

export const HISTORY_KEY = 'bt-history';
/* ---------- 本机存储统一入口 ----------
 * 裸调 localStorage 在 Safari 无痕 / 禁用站点数据 / 被 iframe 嵌入时会抛 SecurityError，
 * 而这些调用出现在首次 render 的惰性初始化里 —— 一抛就是整页白屏，且没有任何降级路径。 */
export function safeGet(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch { return fallback; }
}
export function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
export function loadHistory() {
  try {
    const arr = JSON.parse(safeGet(HISTORY_KEY, '[]'));
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch { return []; }
}
export function saveHistory(arr) {
  safeSet(HISTORY_KEY, JSON.stringify(arr.slice(0, 20)));
}
const RESULT_KEY_PREFIX = 'bt-result-';
export function loadResultCache(jobId) {
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
export function pruneResultCache(keepJobIds) {
  const keep = new Set((keepJobIds || []).filter(Boolean).map((id) => RESULT_KEY_PREFIX + id));
  keep.add(RESULT_KEY_PREFIX);
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(RESULT_KEY_PREFIX) && !keep.has(key)) localStorage.removeItem(key);
    }
  } catch { /* ignore */ }
}
export function saveResultCache(jobId, data) {
  if (!jobId || !data) return;
  if (safeSet(RESULT_KEY_PREFIX + jobId, JSON.stringify(data))) return;
  pruneResultCache([jobId]); // 配额写满：清掉其它结果缓存再试一次（历史/收藏不动）
  safeSet(RESULT_KEY_PREFIX + jobId, JSON.stringify(data));
}
export function removeResultCache(jobId) {
  try { localStorage.removeItem(RESULT_KEY_PREFIX + jobId); } catch { /* ignore */ }
}

/* ---------- 历史墓碑（已删除的作业号）----------
 * 为什么需要：云同步的历史合并是**并集**（按 jobId 去重后合并）。
 * 只在本机删掉的话，下一次同步会从云端把这条记录原样并回来，用户看到的就是"删了又出现"。
 * 所以删除要留下墓碑：合并时过滤掉它，并把墓碑一起同步到云端，让其它设备也知道它已删。
 * 上限 500 条（远超历史本身 20 条的规模，防止无限增长）。 */
export const DELETED_HISTORY_KEY = 'bt-history-deleted';
export const DELETED_HISTORY_MAX = 500;

export function loadDeletedHistory() {
  try {
    const arr = JSON.parse(safeGet(DELETED_HISTORY_KEY, '[]'));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : [];
  } catch { return []; }
}
export function saveDeletedHistory(arr) {
  const list = [...new Set((Array.isArray(arr) ? arr : []).filter((x) => typeof x === 'string' && x))];
  safeSet(DELETED_HISTORY_KEY, JSON.stringify(list.slice(-DELETED_HISTORY_MAX)));
}

/* ---------- 删除墓碑：课文库 / 课文 / 收藏 ----------
 * 历史先有了墓碑（见上），这里把同一套机制补齐到另外三类 —— 原因完全相同：
 * 云同步的合并是**并集**，只在本机删掉的话，下一次同步会把云端旧副本原样并回来，
 * 用户看到的是"删了又出现"；对「清空收藏」「删除课文库」这类破坏性操作来说，
 * 等于静默回滚（用户以为清空了，下次又冒出来）。
 * 三条上限都远大于实际规模，只是防无限增长。 */
export const DELETED_LIBRARIES_KEY = 'bt-libs-deleted';
export const DELETED_LESSONS_KEY = 'bt-lessons-deleted';
export const DELETED_FAVORITES_KEY = 'bt-favs-deleted';
export const DELETED_LIBRARIES_MAX = 200;
export const DELETED_LESSONS_MAX = 1000;
export const DELETED_FAVORITES_MAX = 1000;

/** 课文的墓碑键：libId + '|' + lid（lid 是稳定 id，改标题/改序号都不变） */
export const lessonTombstoneKey = (libId, lid) => String(libId || '') + '|' + String(lid || '');

function loadIds(key) {
  try {
    const arr = JSON.parse(safeGet(key, '[]'));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : [];
  } catch { return []; }
}
function saveIds(key, arr, max) {
  safeSet(key, JSON.stringify([...new Set((Array.isArray(arr) ? arr : []).filter((x) => typeof x === 'string' && x))].slice(-max)));
}
export const loadDeletedLibraries = () => loadIds(DELETED_LIBRARIES_KEY);
export const saveDeletedLibraries = (arr) => saveIds(DELETED_LIBRARIES_KEY, arr, DELETED_LIBRARIES_MAX);
export const loadDeletedLessons = () => loadIds(DELETED_LESSONS_KEY);
export const saveDeletedLessons = (arr) => saveIds(DELETED_LESSONS_KEY, arr, DELETED_LESSONS_MAX);
export const loadDeletedFavorites = () => loadIds(DELETED_FAVORITES_KEY);
export const saveDeletedFavorites = (arr) => saveIds(DELETED_FAVORITES_KEY, arr, DELETED_FAVORITES_MAX);

/* ---------- 出过的错题（错误训练去重）----------
 * 记「这条错题上次被出题是什么时候」，下次出题就优先挑没出过的 ——
 * 用户的原话：「一篇课文 17 个错误，第一次出 10 道，第二次也出 10 道，
 * 希望第二次把剩下 7 道都包含在内，别大规模重复」。
 *
 * 为什么记时间戳而不是只记"出过"：只记布尔值就没有先后可言，老题会被反复抽中、
 * 新题永远排不上；有时间戳才能"最久没出的先来"。
 *
 * 为什么不进云同步：它是**出题顺序的偏好**，不是用户数据。为它改同步快照的结构
 * （还要考虑老版本客户端的合并）不值得；换设备后最多是把同一批错题再练一遍。
 */
export const DRILL_USED_KEY = 'bt-drill-used';
/** 上限：超过就丢最老的。1000 条远超一个人的错题规模，只是防无限增长 */
export const DRILL_USED_MAX = 1000;

export function loadDrillUsed() {
  try {
    const o = JSON.parse(safeGet(DRILL_USED_KEY, '{}'));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const t = Number(v);
      if (k && Number.isFinite(t) && t > 0) out[k] = t;
    }
    return out;
  } catch { return {}; }
}

/** 把这一次出题用掉的错题记上时间；顺带裁掉最老的，避免无限增长 */
export function markDrillUsed(map, ids, now = Date.now()) {
  const out = { ...(map && typeof map === 'object' ? map : {}) };
  for (const id of (Array.isArray(ids) ? ids : [])) if (id) out[String(id)] = now;
  const entries = Object.entries(out);
  if (entries.length <= DRILL_USED_MAX) return out;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, DRILL_USED_MAX));
}

export function saveDrillUsed(map) {
  safeSet(DRILL_USED_KEY, JSON.stringify(map && typeof map === 'object' ? map : {}));
}
