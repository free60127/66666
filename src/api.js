// 与后端 /api 通信的小工具
export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败: ' + res.status));
  return data;
}

export const getStatus = () => api('/api/status');
export const getLessons = (book) => api('/api/lessons' + (book ? '?book=' + book : ''));
export const getLesson = (book, n) => api('/api/lessons/' + (n == null ? book : book + '/' + n));
export const matchLesson = (payload) => api('/api/match', { method: 'POST', body: JSON.stringify(payload) });
export const analyze = (payload) => api('/api/analyze', { method: 'POST', body: JSON.stringify(payload) });
export const getAnalyzeJob = (jobId) => api('/api/analyze/' + jobId);
export const generateMaterial = (payload) => api('/api/generate-material', { method: 'POST', body: JSON.stringify(payload) });
export const getMaterialJob = (jobId) => api('/api/generate-material/' + jobId);
// 拍照 / 图片识别：提交图片 → 轮询识别结果
export const ocr = (payload) => api('/api/ocr', { method: 'POST', body: JSON.stringify(payload ?? {}) });
export const getOcrJob = (jobId) => api('/api/ocr/' + jobId);
// 音标兜底查询（模型没返回 phonetic 时用）
export const getPhonetic = (word) => api('/api/phonetic?word=' + encodeURIComponent(word));
// 收藏知识点自测题：提交 → 轮询结果
export const quiz = (payload) => api('/api/quiz', { method: 'POST', body: JSON.stringify(payload ?? {}) });
export const getQuizJob = (jobId) => api('/api/quiz/' + jobId);

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
