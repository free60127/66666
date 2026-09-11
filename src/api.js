// 与后端 /api 通信的小工具
// 统一超时：以前裸 fetch 没有超时，网络卡死时首屏状态、课程列表、生成请求会一直挂着。
//
// API_BASE：前端搬到 GitHub Pages 之后就和后端**不同源**了，必须用绝对地址。
// 构建时由 VITE_API_BASE 指定（见 .github/workflows/deploy-pages.yml）。
// 留空 = 同源 —— Render 一体部署、以及本地 dev 走 Vite 代理，都是这种形态，一套代码两种都能跑。
export const API_BASE = String(import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

export const TIMEOUT = { fast: 15000, normal: 30000, upload: 60000, wake: 95000 };

/** 带超时的 fetch。超时统一转成可读错误，避免 AbortError 直接冒到界面上。 */
async function request(path, options = {}, timeoutMs = TIMEOUT.normal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(API_BASE + path, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：请检查网络后重试`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function api(path, options = {}, timeoutMs = TIMEOUT.normal) {
  const res = await request(path, { headers: { 'Content-Type': 'application/json' }, ...options }, timeoutMs);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败: ' + res.status));
  return data;
}

/**
 * 唤醒后端。
 *
 * 免费托管（Render 等）15 分钟没有流量就休眠，**唤醒要约 1 分钟**，期间请求会一直挂着。
 * 如果首屏直接拿 TIMEOUT.fast（15 秒）去打 /api/status，就会在服务还没起来时超时 ——
 * 用户看到的是"服务器出错"，而其实再等 40 秒就好了。
 *
 * 所以先用最轻的 /api/health 探活、超时给到 95 秒；等待超过 slowAfterMs 时回调 onSlow，
 * 让界面能显示"正在唤醒服务"。
 * @returns {Promise<boolean>} 后端是否已就绪（失败也返回 false 而不抛，调用方自行决定降级）
 */
export async function wakeUp({ slowAfterMs = 2500, onSlow } = {}) {
  let timer = null;
  if (onSlow) timer = setTimeout(onSlow, slowAfterMs);
  try {
    await api('/api/health', {}, TIMEOUT.wake);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 与 api() 相同，但把 HTTP 状态码一并返回 —— 同步推送需要区分 409（版本冲突）。 */
async function apiRaw(path, options = {}, timeoutMs = TIMEOUT.normal) {
  const res = await request(path, { headers: { 'Content-Type': 'application/json' }, ...options }, timeoutMs);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const getStatus = () => api('/api/status', {}, TIMEOUT.fast);
export const getLessons = (book) => api('/api/lessons' + (book ? '?book=' + book : ''), {}, TIMEOUT.fast);
export const getLesson = (book, n) => api('/api/lessons/' + (n == null ? book : book + '/' + n), {}, TIMEOUT.fast);
export const matchLesson = (payload) => api('/api/match', { method: 'POST', body: JSON.stringify(payload) });
export const analyze = (payload) => api('/api/analyze', { method: 'POST', body: JSON.stringify(payload) });
export const getAnalyzeJob = (jobId) => api('/api/analyze/' + jobId, {}, TIMEOUT.fast);
export const generateMaterial = (payload) => api('/api/generate-material', { method: 'POST', body: JSON.stringify(payload) });
export const getMaterialJob = (jobId) => api('/api/generate-material/' + jobId, {}, TIMEOUT.fast);
// 拍照 / 图片识别：提交图片 → 轮询识别结果（要上传 base64 图片，给更长的超时）
export const ocr = (payload) => api('/api/ocr', { method: 'POST', body: JSON.stringify(payload ?? {}) }, TIMEOUT.upload);
export const getOcrJob = (jobId) => api('/api/ocr/' + jobId, {}, TIMEOUT.fast);
// 音标兜底查询（模型没返回 phonetic 时用）
export const getPhonetic = (word) => api('/api/phonetic?word=' + encodeURIComponent(word));
// 收藏知识点自测题：提交 → 轮询结果
export const quiz = (payload) => api('/api/quiz', { method: 'POST', body: JSON.stringify(payload ?? {}) });
export const getQuizJob = (jobId) => api('/api/quiz/' + jobId, {}, TIMEOUT.fast);

/* ---------- 云同步（同步码） ---------- */
export const getSyncInfo = () => api('/api/sync/info');export const createSyncCode = () => api('/api/sync/new', { method: 'POST' });
/** 拉取云端快照；码不存在时抛出的错误带 status=404，调用方据此区分"云端数据没了"与"网络故障"。 */
export async function pullCloudSync(code) {
  const r = await apiRaw('/api/sync/' + encodeURIComponent(code));
  if (r.ok) return r.data;
  const err = new Error((r.data && r.data.error) || ('读取云端数据失败：HTTP ' + r.status));
  err.status = r.status;
  throw err;
}
export const pushCloudSync = (code, payload) =>
  apiRaw('/api/sync/' + encodeURIComponent(code), { method: 'POST', body: JSON.stringify(payload) });

/* ---------- 账号（可选：服务端配了持久存储才启用） ----------
 * 账号只是"帮你记住同步码"的一层，不替代同步码 —— 同步码仍然是数据主键。
 * 用 apiRaw 而不是 api：401（会话过期）需要和"网络错误"区分开，前者要清掉本地 token。 */
const authPost = (path, payload, token, timeoutMs) => apiRaw('/api/auth/' + path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  },
  body: JSON.stringify(payload ?? {}),
}, timeoutMs);

export const getAuthConfig = () => api('/api/auth/config', {}, TIMEOUT.fast);
export const authRegister = (p) => authPost('register', p);
export const authLogin = (p) => authPost('login', p);
export const authLogout = (token) => authPost('logout', {}, token);
export const authLogoutAll = (token) => authPost('logout-all', {}, token);
export const authSetSync = (token, sync) => authPost('sync', { sync }, token);
export const authChangePassword = (token, p) => authPost('change-password', p, token);
export const authDeleteAccount = (token, p) => authPost('delete-account', p, token);
// 发信走 SMTP，可能几秒才回来，给上传档超时
export const authForgot = (p) => authPost('forgot', p, '', TIMEOUT.upload);
export const authResetPassword = (p) => authPost('reset-password', p);
export const authMe = (token) => apiRaw('/api/auth/me', {
  headers: token ? { Authorization: 'Bearer ' + token } : {},
}, TIMEOUT.fast);

// 本地设置（仅个人使用时，key 会随请求发给你自己部署的后端）
const KEY = 'bt-studio-settings';
const KEY_PERSIST = 'bt-studio-settings-key'; // 「记住此设备」才用的长期槽位

/**
 * 读取设置。
 * apiKey 默认是「会话级」的：存在 sessionStorage，关闭标签页即失效，
 * 降低 XSS / 恶意扩展长期读取的风险；非敏感字段（baseUrl / model / visionModel）仍存 localStorage，
 * 所以刷新页面后接口配置还在、只有 Key 需要重填（除非勾了「在本机记住」）。
 */
export function loadSettings() {
  let local = {};
  let session = {};
  try { local = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { local = {}; }
  try { session = JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch { session = {}; }
  const merged = { ...local, ...session };

  // 迁移：旧版本把 Key 明文长期存在 localStorage 里，搬到会话槽后从本地抹掉
  if (local.apiKey && !session.apiKey) {
    merged.apiKey = local.apiKey;
    try {
      const rest = { ...local };
      delete rest.apiKey;
      localStorage.setItem(KEY, JSON.stringify(rest));
      sessionStorage.setItem(KEY, JSON.stringify({ apiKey: local.apiKey }));
    } catch { /* 存储不可用则忽略 */ }
  }
  // 用户显式勾选「在本机记住」时，才读长期槽位
  if (!merged.apiKey) {
    try {
      const persisted = JSON.parse(localStorage.getItem(KEY_PERSIST) || 'null');
      if (persisted && persisted.apiKey) { merged.apiKey = persisted.apiKey; merged.rememberKey = true; }
    } catch { /* ignore */ }
  }
  return merged;
}

/** 保存设置；返回 false 表示本机存储写入失败（例如配额已满）。 */
export function saveSettings(settings) {
  const { apiKey, ...rest } = settings || {};
  let ok = true;
  try { localStorage.setItem(KEY, JSON.stringify(rest)); } catch { ok = false; }
  try { sessionStorage.setItem(KEY, JSON.stringify({ apiKey: apiKey || '' })); } catch { ok = false; }
  try {
    if (settings?.rememberKey) localStorage.setItem(KEY_PERSIST, JSON.stringify({ apiKey: apiKey || '' }));
    else localStorage.removeItem(KEY_PERSIST);
  } catch { ok = false; }
  return ok;
}
