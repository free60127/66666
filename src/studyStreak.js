/**
 * 连续学习天数（streak）。
 *
 * 为什么单独存一份日期列表，而不是从历史/进度里推：
 *  · 历史只留 20 条 —— 一天练两课就会把更早的记录挤掉，"哪天练过"根本推不出来；
 *  · 逐课进度按课文聚合，同一课反复练也只留最后时间，同样推不出连续天数。
 * 所以按"天"存一份去重后的日期列表（本地时区，YYYY-MM-DD），上限 400 天（约 5KB）。
 *
 * 时区：一律用**本地日期**。用 UTC 会让晚上练的人（尤其东八区 00:00-08:00）
 * 被判成"昨天"，连续天数凭空断掉 —— 这类细节直接决定用户信不信这个数字。
 */
export const DAYS_KEY = 'bt-study-days';
export const DAYS_MAX = 400;

const isDayKey = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** 本地时区的 YYYY-MM-DD（可直接按字符串比较/排序） */
export function dayKey(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** dayKey 往前 / 往后 n 天（用本地 Date 运算，跨月跨年与夏令时都不会错） */
export function shiftDay(key, n) {
  if (!isDayKey(key)) return '';
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dayKey(dt);
}

export function loadDays() {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(DAYS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? normalizeDays(arr) : [];
  } catch {
    return [];
  }
}

export function saveDays(days) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(DAYS_KEY, JSON.stringify(normalizeDays(days)));
    return true;
  } catch {
    return false; // 配额满就丢了这一次，不影响使用
  }
}

/** 去重 + 只留合法日期 + 倒序 + 截断（纯函数） */
export function normalizeDays(days, max = DAYS_MAX) {
  const set = new Set();
  for (const d of Array.isArray(days) ? days : []) if (isDayKey(d)) set.add(d);
  return [...set].sort().reverse().slice(0, max);
}

/** 记一天（纯函数，返回新数组）。同一天练多次只算一天。 */
export function recordDay(days, key = dayKey()) {
  if (!isDayKey(key)) return days;
  if (Array.isArray(days) && days.includes(key)) return days;
  return normalizeDays([key, ...(Array.isArray(days) ? days : [])]);
}

/**
 * 当前连续天数。
 * 今天还没练时从**昨天**往回数 —— 否则用户一觉醒来会看到"连续 0 天"，
 * 而他今天完全还来得及练（这是所有 streak 类产品的通行做法）。
 */
export function currentStreak(days, today = dayKey()) {
  const set = new Set(normalizeDays(days));
  if (!set.size || !isDayKey(today)) return 0;
  let cursor = set.has(today) ? today : shiftDay(today, -1);
  let n = 0;
  while (cursor && set.has(cursor)) {
    n += 1;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

/** 历史最长连续天数 */
export function longestStreak(days) {
  const list = normalizeDays(days).slice().reverse(); // 升序
  if (!list.length) return 0;
  let best = 1;
  let run = 1;
  for (let i = 1; i < list.length; i += 1) {
    run = (shiftDay(list[i - 1], 1) === list[i]) ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * 合并两份日期（跨设备同步用）：取并集。
 * 与逐课进度不同，"哪天练过"取并集绝不会重复计数（一天就是一天）。
 */
export function mergeDays(a, b) {
  return normalizeDays([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
}

/** 汇总展示用 */
export function summarizeStreak(days, today = dayKey()) {
  const list = normalizeDays(days);
  return {
    current: currentStreak(list, today),
    longest: Math.max(longestStreak(list), currentStreak(list, today)),
    todayDone: list.includes(today),
    total: list.length,
  };
}
