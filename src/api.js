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

// 本地设置（仅个人使用时，key 会随请求发给 localhost 后端）
const KEY = 'bt-studio-settings';
export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
