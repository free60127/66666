/** 每个账号独立的本机缓存；访客数据首次登录可接入，换账号不会混入上一人的数据。 */
import { safeGet } from './storage.js';
const OWNER = 'bt-data-owner';
const keys = new Set(['bt-history', 'bt-history-deleted', 'bt-lesson-libraries', 'bt-favorites',
  'bt-libs-deleted', 'bt-lessons-deleted', 'bt-favs-deleted', 'bt-lesson-progress', 'bt-study-days',
  'bt-drafts', 'bt-writing-studio', 'bt-writing-current', 'bt-writing-open', 'bt-drill-used', 'bt-timer', 'bt-sync-code', 'bt-sync-meta', 'bt-book', 'bt-lesson',
  'bt-lib-tab', 'bt-open-groups', 'bt-studio-settings', 'bt-studio-settings-key',
  'bts-class-memberships', 'bts-class-member-owner', 'bts-class-pending', 'bts-class-failed', 'bts-active-homework']);
const scoped = (key) => keys.has(key) || key === 'bt-quiz-current' || key === 'bt-study-focus' || key.startsWith('bt-quiz-session:') || key.startsWith('bt-result-') || key.startsWith('bt-writing-draft:');
export const dataOwner = () => safeGet(OWNER);
const snapshot = () => Object.fromEntries(Object.keys(localStorage).filter(scoped).map((key) => [key, localStorage.getItem(key)]));
// 配额满等写入失败不能让进程停在「写了一半」：逐键兜住，返回失败数由调用方决定回滚
const put = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
const replace = (raw) => {
  Object.keys(localStorage).filter(scoped).forEach((key) => { try { localStorage.removeItem(key); } catch { /* 单项失败继续 */ } });
  let failed = 0;
  Object.entries(raw || {}).filter(([key]) => scoped(key)).forEach(([key, value]) => { if (!put(key, value)) failed += 1; });
  return failed;
};
export function switchDataOwner(userId) {
  const target = userId || 'guest';
  const previous = dataOwner() || safeGet('bts-class-member-owner');
  if (!previous && !userId) return false;
  if (previous === target) { localStorage.setItem(OWNER, target); return false; }
  window.dispatchEvent(new Event('bts:before-account-change'));
  // 首次升级：已有本机数据归入当前登录者，既不清空也不复制成两份。
  if (!previous) { localStorage.setItem(OWNER, target); return false; }
  const old = snapshot();
  const oldBackup = localStorage.getItem('bt-data-cache:' + previous);
  try {
    const stored = JSON.parse(localStorage.getItem('bt-data-cache:' + target) || '{}');
    if (!put('bt-data-cache:' + previous, JSON.stringify(old))) throw new Error('quota');
    const failed = replace(stored);
    // 任一关键写失败（含 OWNER 本身）都按整体失败处理，走统一回滚，绝不留「半切换」脏状态
    if (failed > 0 || !put(OWNER, target)) throw new Error('quota');
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
    // 注销 ≠ 登出：账号数据销毁，但「登录前访客时期」的备份要恢复出来（登出路径就是这么做的）。
    // 否则留下一份空的活动数据，下一次登录任何账号都会用它覆盖 cache:guest —— 访客数据就此丢失。
    try { replace(JSON.parse(localStorage.getItem('bt-data-cache:guest') || '{}')); }
    catch { replace({}); }
    localStorage.setItem(OWNER, 'guest');
    // 正常切换路径会清这个键，但注销后 owner 已是 guest，clearAccount 的 switchDataOwner('')
    // 会因 previous === target 提前返回而跳过——会话级 API Key 不能残留给注销后的访客会话。
    try { sessionStorage.removeItem('bt-studio-settings-key'); } catch { /* ignore */ }
  }
}
