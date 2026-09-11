/**
 * 账号（客户端编排层）。
 *
 * 职责边界：
 *   - 本模块只负责「登录态存储」和「同步码的加解密编排」，**不碰同步逻辑本身**。
 *     从账号解出来的同步码交给 App 处理 —— 同步码始终是数据主键，账号只是帮你记住它。
 *   - 密码**从不落盘**，只在内存里活过一次调用（用来派生加解密同步码的密钥）。
 *
 * 为什么登录态存 localStorage 而密码不存：
 *   会话令牌是可撤销的（服务端能踢、30 天过期），密码不是。
 *   存令牌的泄露后果可控；存密码的后果是不可控的。
 */
import {
  getAuthConfig, authRegister, authLogin, authLogout, authLogoutAll, authMe,
  authSetSync, authChangePassword, authDeleteAccount, authForgot, authResetPassword,
} from './api.js';
import { sealText, openText, isBox } from './secretBox.js';

const TOKEN_KEY = 'bt-acct-token';
const USER_KEY = 'bt-acct-user';

export function loadAccount() {
  try {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    const user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    return token && user ? { token, user } : null;
  } catch { return null; }
}
export function saveAccount(token, user) {
  try {
    localStorage.setItem(TOKEN_KEY, token || '');
    localStorage.setItem(USER_KEY, JSON.stringify(user || null));
  } catch { /* 存储不可用则只在内存里活 */ }
}
export function clearAccount() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch { /* ignore */ }
}

/** 服务端是否启用了账号功能（没配持久存储时是关的）。 */
export async function accountAvailable() {
  try {
    const r = await getAuthConfig();
    return Boolean(r && r.enabled);
  } catch { return false; }
}

/** 把 apiRaw 的返回统一成 {ok, error, ...} */
const wrap = (r) => (r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, status: r.status, error: (r.data && r.data.error) || ('请求失败：HTTP ' + r.status) });

/** 同步码 → 保险箱密文（用密码派生密钥加密） */
async function sealSync(syncCode, password) {
  if (!syncCode) return null;
  return sealText(syncCode, password);
}

/**
 * 注册。
 * 如果本机已有同步码，就用密码加密后一并存进账号 —— 这样在别的设备登录就能拿回来。
 */
export async function signUp({ email, password, nickname, syncCode }) {
  let sync = null;
  if (syncCode) {
    try { sync = await sealSync(syncCode, password); }
    catch { sync = null; } // 加密失败不该挡住注册，最多是这次没带上同步码
  }
  const r = wrap(await authRegister({ email, password, nickname, sync }));
  if (!r.ok) return r;
  saveAccount(r.token, r.user);
  return { ok: true, user: r.user, syncCode: syncCode || '' };
}

/**
 * 登录 → 用密码解开账号里存的同步码。
 * @returns {{ok:true, user, syncCode:string, hasSync:boolean, syncError?:string}}
 *   hasSync=false 表示**账号里压根没存过同步码** —— 调用方应当立刻把本机的码绑上去，
 *   否则这台设备会一直用自己那串，和别的设备永远碰不上面（实测踩过）。
 *   syncError 有值表示"登录成功但同步码解不开"（通常是上次重置过密码），
 *   这时不要让用户以为账号坏了 —— 照常登录，只是同步要重新设置。
 */
export async function signIn({ email, password }) {
  const r = wrap(await authLogin({ email, password }));
  if (!r.ok) return r;
  saveAccount(r.token, r.user);

  let syncCode = '';
  let syncError = '';
  const hasSync = isBox(r.sync);
  if (hasSync) {
    const plain = await openText(r.sync, password);
    if (plain) syncCode = plain;
    else syncError = '账号里的同步码解不开（可能是重置过密码）。已登录，但需要重新设置同步码。';
  }
  return { ok: true, user: r.user, syncCode, hasSync, syncError };
}

export async function signOut(token) {
  try { await authLogout(token); } catch { /* 网络失败也要清本地，否则用户被困住 */ }
  clearAccount();
  return { ok: true };
}

/**
 * 退出所有设备（含当前这台）—— 怀疑令牌泄露时的一键止血。
 * 服务端把会话世代号 +1，所有已签发的令牌立刻作废（包括正在用的这一条），
 * 所以本地也要一并清掉，然后重新登录即可。
 */
export async function signOutEverywhere(token) {
  const r = wrap(await authLogoutAll(token));
  clearAccount();
  return r;
}

/** 校验本地令牌还有效；失效时顺手清掉。 */
export async function verifySession(token) {
  const r = await authMe(token);
  if (r.ok) {
    const u = r.data && r.data.user;
    if (u) saveAccount(token, u);
    const sync = (r.data && r.data.sync) || null;
    return { ok: true, user: u, sync, hasSync: isBox(sync) };
  }
  if (r.status === 401) clearAccount();
  return { ok: false, status: r.status };
}

/** 把当前同步码加密后存进账号（换设备/首次绑定时用）。 */
export async function bindSyncCode(token, syncCode, password) {
  const box = await sealSync(syncCode, password);
  if (!box) return { ok: false, error: '没有可绑定的同步码' };
  return wrap(await authSetSync(token, box));
}

/**
 * 改密码。
 * **必须同时提交用新密码重新加密的同步码** —— 服务端没有旧密码，代劳不了；
 * 不传的话旧密文就永远解不开了。
 */
export async function changePassword({ token, oldPassword, newPassword, syncCode }) {
  let sync = null;
  if (syncCode) {
    try { sync = await sealSync(syncCode, newPassword); }
    catch { return { ok: false, error: '同步码加密失败，请重试' }; }
  }
  const r = wrap(await authChangePassword(token, { oldPassword, newPassword, sync }));
  if (!r.ok) return r;
  if (r.token) saveAccount(r.token, r.user); // 服务端会换发新令牌（旧的全部失效）
  return { ok: true, user: r.user };
}

export async function deleteAccount({ token, password }) {
  const r = wrap(await authDeleteAccount(token, { password }));
  if (r.ok) clearAccount();
  return r;
}

export async function requestResetCode(email) {
  return wrap(await authForgot({ email }));
}

/** 重置密码。`syncCode` 可选：传了就用新密码加密后一起存回去（用户手上有码的情况）。 */
export async function resetPassword({ email, code, newPassword, syncCode }) {
  let sync = null;
  if (syncCode) {
    try { sync = await sealSync(syncCode, newPassword); }
    catch { sync = null; }
  }
  const r = wrap(await authResetPassword({ email, code, newPassword, sync }));
  if (r.ok) clearAccount(); // 服务端已把全部旧会话作废，本地令牌留着只会误导
  return r;
}
