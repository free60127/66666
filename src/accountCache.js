/** 每个账号独立的本机缓存；访客数据首次登录可接入，换账号不会混入上一人的数据。 */
import { safeGet } from './storage.js';
const OWNER = 'bt-data-owner';
const keys = new Set(['bt-history', 'bt-history-deleted', 'bt-lesson-libraries', 'bt-favorites',
  'bt-libs-deleted', 'bt-lessons-deleted', 'bt-favs-deleted', 'bt-lesson-progress', 'bt-study-days',
  'bt-drafts', 'bt-drill-used', 'bt-timer', 'bt-sync-code', 'bt-sync-meta', 'bt-book', 'bt-lesson',
  'bt-lib-tab', 'bt-open-groups', 'bt-studio-settings', 'bt-studio-settings-key',
  'bts-class-memberships', 'bts-class-member-owner', 'bts-class-pending', 'bts-class-failed', 'bts-active-homework']);
const scoped = (key) => keys.has(key) || key.startsWith('bt-result-');
export const dataOwner = () => safeGet(OWNER);
const snapshot = () => Object.fromEntries(Object.keys(localStorage).filter(scoped).map((key) => [key, localStorage.getItem(key)]));
const replace = (raw) => {
  Object.keys(localStorage).filter(scoped).forEach((key) => localStorage.removeItem(key));
  Object.entries(raw || {}).filter(([key]) => scoped(key)).forEach(([key, value]) => localStorage.setItem(key, value));
};
export function switchDataOwner(userId) {
  const target = userId || 'guest';
  const previous = dataOwner() || safeGet('bts-class-member-owner');
  if (!previous && !userId) return false;
  if (previous === target) { localStorage.setItem(OWNER, target); return false; }
  // 首次升级：已有本机数据归入当前登录者，既不清空也不复制成两份。
  if (!previous) { localStorage.setItem(OWNER, target); return false; }
  const old = snapshot();
  const oldBackup = localStorage.getItem('bt-data-cache:' + previous);
  try {
    const stored = JSON.parse(localStorage.getItem('bt-data-cache:' + target) || '{}');
    localStorage.setItem('bt-data-cache:' + previous, JSON.stringify(old));
    replace(stored);
    localStorage.setItem(OWNER, target);
    sessionStorage.removeItem('bt-studio-settings-key');
    return true;
  } catch {
    localStorage.removeItem('bt-data-cache:' + previous);
    replace(old);
    if (oldBackup) { try { localStorage.setItem('bt-data-cache:' + previous, oldBackup); } catch { /* 当前数据已恢复 */ } }
    throw new Error('本机空间不足，无法安全切换账号，请先导出备份或清理浏览器存储');
  }
}
export function notifyAccountChanged() { window.dispatchEvent(new Event('bts:account-changed')); }
export function forgetAccountCache(userId) {
  localStorage.removeItem('bt-data-cache:' + userId);
  if (dataOwner() === userId) {
    replace({});
    localStorage.setItem(OWNER, 'guest');
  }
}
