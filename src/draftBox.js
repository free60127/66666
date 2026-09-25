import { safeGet, safeSet } from './storage.js';

/**
 * 草稿本：按课文（lessonKey）保存写了一半的初稿。
 *
 * 三条写入路径，缺一不可：
 * · 自动保存（App 里防抖 800ms）—— 正常打字随时落盘；
 * · 主动保存（编辑器"存草稿"按钮）—— 给用户确定性；
 * · pagehide / visibilitychange 兜底 —— 手机切后台、直接杀 App 没有任何"退出事件"，
 *   靠它把最后一次内容同步写进 localStorage，刷新/杀进程也不丢。
 * 恢复发生在选同一课时（useLessons.selectLesson / selectMyLesson / 首屏自动选课）。
 */

const KEY = 'bt-drafts';
const MAX_DRAFTS = 30; // 最多记住 30 篇半成品，LRU 淘汰最久未保存的

const readAll = () => {
  try {
    const obj = JSON.parse(safeGet(KEY, '') || '{}');
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
};

const writeAll = (drafts) => safeSet(KEY, JSON.stringify(drafts));

/** 读某一课的草稿；没有或已损坏返回 null。 */
export function loadDraft(lessonKey) {
  if (!lessonKey) return null;
  const all = readAll();
  const draft = all[lessonKey];
  return draft && typeof draft.draft === 'string' && draft.draft.trim() ? draft : null;
}

/**
 * 保存草稿。初稿为空时不写入 —— 保留旧草稿：
 * 程序性清空（切课的瞬间）和"用户清空重写"在这里语义一致，
 * 真想丢弃用 clearDraft（恢复横幅上的"丢弃"按钮）。
 */
export function saveDraft(lessonKey, snapshot) {
  if (!lessonKey) return false;
  const draft = String(snapshot?.draft ?? '');
  if (!draft.trim()) return false;
  const all = readAll();
  all[lessonKey] = {
    title: String(snapshot.title || '').slice(0, 200),
    chinese: String(snapshot.chinese || '').slice(0, 20000),
    draft: draft.slice(0, 20000),
    manualOriginal: String(snapshot.manualOriginal || '').slice(0, 20000),
    generatedOriginal: String(snapshot.generatedOriginal || '').slice(0, 20000),
    materialKeywords: Array.isArray(snapshot.materialKeywords) ? snapshot.materialKeywords.slice(0, 20) : [],
    direction: snapshot.direction || '',
    savedAt: Date.now(),
  };
  // LRU：超上限时按 savedAt 淘汰最旧的（当前这篇刚写入必然最新，不会被淘汰）
  const entries = Object.entries(all);
  if (entries.length > MAX_DRAFTS) {
    entries.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
    return writeAll(Object.fromEntries(entries.slice(0, MAX_DRAFTS)));
  } else {
    return writeAll(all);
  }
}

/** 丢弃某课的草稿（恢复横幅上的"丢弃"按钮）。 */
export function clearDraft(lessonKey) {
  if (!lessonKey) return false;
  const all = readAll();
  if (all[lessonKey]) {
    delete all[lessonKey];
    return writeAll(all);
  }
  return true;
}

/** 横幅文案：草稿是多久前保存的（"刚刚 / 5 分钟前 / 2 小时前 / 3 天前"）。 */
export function draftAgeText(savedAt) {
  const ms = Date.now() - (savedAt || 0);
  if (ms < 60000) return '刚刚';
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟前`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时前`;
  return `${Math.floor(ms / 86400000)} 天前`;
}
