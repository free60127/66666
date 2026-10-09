/** 账号会话与管理。学习数据由服务端按 userId 保存，旧同步码只用于迁移。 */
import {
  getAuthConfig, authRegister, authLogin, authLogout, authLogoutAll, authMe,
  authChangePassword, authDeleteAccount, authForgot, authResetPassword,
} from './api.js';
import { switchDataOwner, notifyAccountChanged, forgetAccountCache } from './accountCache.js';

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
  const before = loadAccount();
  switchDataOwner(user.id);
  localStorage.setItem(TOKEN_KEY, token || '');
  localStorage.setItem(USER_KEY, JSON.stringify(user || null));
  if (before?.token !== token || before?.user?.id !== user.id) notifyAccountChanged();
}
export function clearAccount() {
  switchDataOwner('');
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  notifyAccountChanged();
}

/** 服务端是否启用了账号功能（没配持久存储时是关的）。 */
export async function accountAvailable() {
  try {
    const r = await getAuthConfig();
    return Boolean(r && r.enabled);
  } catch { return false; }
}
export async function accountConfig() {
  try { return await getAuthConfig(); } catch { return { enabled: false, recoveryEnabled: false, emailVerify: false }; }
}

/** 把 apiRaw 的返回统一成 {ok, error, ...} */
const wrap = (r) => (r.ok ? { ok: true, ...(r.data || {}) } : { ok: false, status: r.status, error: (r.data && r.data.error) || ('请求失败：HTTP ' + r.status) });

export async function signUp({ email, password, nickname, code }) {
  const r = wrap(await authRegister({ email, password, nickname, code }));
  if (r.ok) saveAccount(r.token, r.user);
  return { ...r, classMembers: r.classMembers || [] };
}
export async function signIn({ email, password }) {
  const r = wrap(await authLogin({ email, password }));
  if (r.ok) saveAccount(r.token, r.user);
  return { ...r, classMembers: r.classMembers || [] };
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
  if (r.ok) clearAccount();
  return r;
}

/** 校验本地令牌还有效；失效时顺手清掉。 */
export async function verifySession(token) {
  const r = wrap(await authMe(token));
  if (r.ok) {
    saveAccount(token, r.user);
    return r;
  }
  if (r.status === 401) clearAccount();
  return r;
}

export async function changePassword({ token, oldPassword, newPassword }) {
  const r = wrap(await authChangePassword(token, { oldPassword, newPassword }));
  if (r.ok && r.token) saveAccount(r.token, r.user);
  return r;
}

export async function deleteAccount({ token, password }) {
  const r = wrap(await authDeleteAccount(token, { password }));
  if (r.ok) { forgetAccountCache(loadAccount()?.user?.id); clearAccount(); }
  return r;
}

export async function requestResetCode(email) {
  return wrap(await authForgot({ email }));
}

/** 密码重置不会改变账号的数据主键。 */
export async function resetPassword({ email, code, newPassword }) {
  const r = wrap(await authResetPassword({ email, code, newPassword }));
  if (r.ok) clearAccount();
  return r;
}
