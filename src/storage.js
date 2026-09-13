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
