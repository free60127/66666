/**
 * 时间显示格式化（结果页 / 历史列表 / 计时器共用）。
 * 纯函数、无依赖 —— 抽出来的直接好处是能单测（见 tools/… 与 npm test 里的边界用例）。
 */

/** 本地时间「9/12 15:41」；空值返回空串 */
export function formatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/** 只到"日"的日期（复习排期按自然日翻篇，显示到分钟会让人以为要等到那个时刻） */
export function formatDay(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }); } catch { return ''; }
}

/** 时长：不足 1 小时用 MM:SS，超过用 H:MM:SS（练习用时 / 对比差值都用它） */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * 文件名用的「本地」日期戳 YYYY-MM-DD。
 *
 * 为什么不能用 `new Date().toISOString().slice(0, 10)`：那是 **UTC** 日期。
 * 东八区用户在当地 00:00–08:00 之间导出的备份，文件名会写成**前一天**
 * （实测：本机 2026-09-17 06:27 导出，文件名却是 …-2026-09-16.json）。
 * 天天导出、按文件名归档的人会被这一天之差弄乱顺序。
 */
export function dayStamp(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
