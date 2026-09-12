/**
 * 收藏夹：把作业里的知识点（错题/辨析、核心词、习语）存到本机 localStorage，
 * 之后不用打开整份作业就能快速复习。无需数据库；支持导出/导入 JSON 备份。
 *
 * 复习用 SM-2 间隔重复排期：每条收藏带 { ease, interval, due, reps }，
 * 复习时三档评分（忘了/一般/简单）→ 更新下次到期时间，首页只推"今天到期"的那些。
 * 这些调度字段会跟着同步码一起走（见 mergeFavorites），否则多设备复习进度会互相覆盖。
 */

export const FAV_KEY = 'bt-favorites';
export const FAV_MAX = 2000;
export const FAV_KIND_LABEL = { finding: '错题/辨析', vocab: '核心词', idiom: '习语', expression: '加分表达' };

/* ---------- SM-2 间隔重复 ---------- */
export const FAV_GRADES = { forgot: '忘了', normal: '一般', easy: '简单' };
export const FAV_EASE_START = 2.5;
export const FAV_EASE_MIN = 1.3;
export const FAV_EASE_MAX = 3.0;
export const FAV_INTERVAL_MAX = 365; // 天：再熟也别排到一年以后，否则等于再也不复习
/** 参与同步的调度字段（合并收藏时按这份清单一起带上） */
export const FAV_SCHEDULE_FIELDS = ['ease', 'interval', 'due', 'reps', 'lastReviewed', 'lastGrade'];
const DAY = 86400000;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 新收藏的初始排期：今天到期，等第一次复习后再拉开间隔 */
export function newSchedule(now = Date.now()) {
  return { ease: FAV_EASE_START, interval: 0, due: now, reps: 0, lastReviewed: 0, lastGrade: '' };
}

/** 补齐 / 纠正调度字段（老收藏没有这些字段，due 用收藏时间兜底 → 立刻可复习） */
export function withSchedule(item, now = Date.now()) {
  if (!item || typeof item !== 'object') return item;
  const ease = Math.min(FAV_EASE_MAX, Math.max(FAV_EASE_MIN, num(item.ease, FAV_EASE_START) || FAV_EASE_START));
  const interval = Math.max(0, Math.min(FAV_INTERVAL_MAX, Math.round(num(item.interval, 0))));
  const rawDue = num(item.due, 0);
  const due = rawDue > 0 ? rawDue : (num(item.createdAt, 0) || now);
  return {
    ...item,
    ease,
    interval,
    due,
    reps: Math.max(0, Math.round(num(item.reps, 0))),
    lastReviewed: Math.max(0, num(item.lastReviewed, 0)),
    lastGrade: FAV_GRADES[item.lastGrade] ? item.lastGrade : '',
  };
}

/**
 * 一次复习后的新排期（纯函数）。
 * 忘了 → 从头再来（reps 归零、明天再见）；一般 → 按当前难度因子拉长；简单 → 再乘 1.3 并调高难度因子。
 */
export function sm2Review(item, grade, now = Date.now()) {
  const cur = withSchedule(item, now);
  const g = FAV_GRADES[grade] ? grade : 'normal';
  let { ease, interval, reps } = cur;
  if (g === 'forgot') {
    reps = 0;
    interval = 1;
    ease = Math.max(FAV_EASE_MIN, ease - 0.2);
  } else if (g === 'normal') {
    interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(1, Math.round(interval * ease));
    reps += 1;
  } else {
    interval = reps === 0 ? 2 : reps === 1 ? 6 : Math.max(1, Math.round(interval * ease * 1.3));
    reps += 1;
    ease = Math.min(FAV_EASE_MAX, ease + 0.15);
  }
  interval = Math.max(1, Math.min(FAV_INTERVAL_MAX, interval));
  return {
    ...cur,
    ease: round2(ease),
    interval,
    reps,
    due: now + interval * DAY,
    lastReviewed: now,
    lastGrade: g,
  };
}

/** 到期时间：缺字段的老收藏按收藏时间算（即立刻可复习） */
export function dueOf(item) {
  const d = num(item && item.due, 0);
  if (d > 0) return d;
  return num(item && item.createdAt, 0);
}

/** 今天到期待复习的收藏（按到期时间从早到晚 —— 拖得最久的先复习） */
export function dueFavorites(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && x.id && dueOf(x) <= now)
    .sort((a, b) => dueOf(a) - dueOf(b));
}

/** 下一次到期时间（没有未来到期项 → null） */
export function nextDueAt(list, now = Date.now()) {
  let best = Infinity;
  for (const x of (Array.isArray(list) ? list : [])) {
    if (!x || !x.id) continue;
    const d = dueOf(x);
    if (d > now && d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}

/** 到期状态文案：给收藏列表条目用 */
export function dueLabel(item, now = Date.now()) {
  const due = dueOf(item);
  if (!due || due <= now) return '待复习';
  const days = Math.ceil((due - now) / DAY);
  return days <= 1 ? '明天' : days + ' 天后';
}

function store() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadFavorites() {
  const s = store();
  if (!s) return [];
  try {
    const arr = JSON.parse(s.getItem(FAV_KEY) || '[]');
    // 老数据没有调度字段：读出来就补齐，复习入口才不会漏掉以前收藏的内容
    return Array.isArray(arr) ? arr.filter((x) => x && x.id && x.title).map((x) => withSchedule(x)) : [];
  } catch { return []; }
}

export function saveFavorites(arr) {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(FAV_KEY, JSON.stringify((Array.isArray(arr) ? arr : []).slice(0, FAV_MAX)));
    return true;
  } catch { return false; }
}

export function favKey(parts) {
  return (Array.isArray(parts) ? parts : [parts])
    .filter(Boolean)
    .join('|')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function synWords(synonyms) {
  return (Array.isArray(synonyms) ? synonyms : [])
    .map((x) => (typeof x === 'string' ? x : x && x.word))
    .filter(Boolean);
}
function exLines(examples, keyA = 'en', keyB = 'example') {
  return (Array.isArray(examples) ? examples : [])
    .map((x) => x && (x[keyA] || x[keyB]))
    .filter(Boolean);
}
function wrapPhonetic(p) {
  const v = String(p || '').trim();
  if (!v) return '';
  return v.startsWith('/') ? v : '/' + v + '/';
}

/** 词根词缀拆解 → 一行文本（morphology 可能是对象，也可能是模型直接给的字符串） */
export function morphologyText(m) {
  if (!m) return '';
  if (typeof m === 'string') return m.trim();
  return [
    m.parts ? '拆解：' + m.parts : '',
    m.image ? '记忆画面：' + m.image : '',
    m.family ? '同根词：' + m.family : '',
  ].filter(Boolean).join('；');
}

/** 判断一个 vocabularyNote 是否真的有可展示的词根词缀内容 */
export function hasMorphology(m) {
  if (!m) return false;
  if (typeof m === 'string') return Boolean(m.trim());
  return Boolean((m.parts && String(m.parts).trim()) || (m.image && String(m.image).trim()) || (m.family && String(m.family).trim()));
}

export function favFromFinding(finding, result) {
  const f = finding || {};
  const syns = synWords(f.synonyms);
  const exs = exLines(f.examples);
  return {
    id: favKey(['finding', result && result.title, f.category, f.from, f.to]),
    kind: 'finding',
    title: (f.from ? f.from + ' → ' + f.to : f.to) || f.category || '知识点',
    category: f.category || '',
    level: f.level || '',
    body: f.explanation || '',
    extra: [
      Array.isArray(f.dimensions) && f.dimensions.length ? '维度：' + f.dimensions.join('、') : '',
      f.idiom ? '习语：' + f.idiom : '',
      syns.length ? '近义词：' + syns.join('、') : '',
      exs.length ? '例句：' + exs.join(' / ') : '',
    ].filter(Boolean).join('\n'),
    source: (result && result.title) || '',
    sourceLevel: (result && result.aiLevel) || '',
  };
}

export function favFromVocab(v, result) {
  const word = (v && v.word) || '';
  return {
    id: favKey(['vocab', result && result.title, word]),
    kind: 'vocab',
    title: word + (v && v.phonetic ? '  ' + wrapPhonetic(v.phonetic) : ''),
    category: (v && v.type) || '词汇',
    level: '',
    body: [v && v.meaning, v && v.note].filter(Boolean).join('\n'),
    extra: [
      Array.isArray(v && v.dimensions) && v.dimensions.length ? '维度：' + v.dimensions.join('、') : '',
      hasMorphology(v && v.morphology) ? '词根词缀：' + morphologyText(v.morphology) : '',
      synWords(v && v.synonyms).length ? '近义词：' + synWords(v && v.synonyms).join('、') : '',
      exLines(v && v.examples).length ? '例句：' + exLines(v && v.examples).join(' / ') : '',
    ].filter(Boolean).join('\n'),
    source: (result && result.title) || '',
    sourceLevel: (result && result.aiLevel) || '',
  };
}

export function favFromIdiom(it, result) {
  const x = it || {};
  return {
    id: favKey(['idiom', result && result.title, x.idiom]),
    kind: 'idiom',
    title: x.idiom || '习语',
    category: '习语',
    level: '',
    body: [x.common ? '普通说法：' + x.common : '', x.explanation].filter(Boolean).join('\n'),
    extra: [
      x.example ? '例句：' + x.example : '',
      x.situation ? '场景：' + x.situation : '',
    ].filter(Boolean).join('\n'),
    source: (result && result.title) || '',
    sourceLevel: (result && result.aiLevel) || '',
  };
}

/** 加分表达 / 高级句式（文案形如 "earn one's living behind the wheel of a taxi · 中文点拨：……"） */
export function favFromExpression(item, result, category = '加分表达') {
  const raw = typeof item === 'string' ? item : JSON.stringify(item || '');
  const parts = String(raw).split(/[·•]\s*中文[点说]拨?\s*[:：]?\s*/i);
  const en = (parts[0] || '').trim();
  const tip = parts[1] ? parts[1].trim() : '';
  return {
    id: favKey(['expr', result && result.title, category, en]),
    kind: 'expression',
    title: en || '加分表达',
    category,
    level: '',
    body: tip,
    extra: '',
    source: (result && result.title) || '',
    sourceLevel: (result && result.aiLevel) || '',
  };
}

/** 收藏夹弹窗的筛选：按类型 + 关键词（标题/正文/补充/分类/来源） */
export function filterFavorites(list, { kind = 'all', query = '' } = {}) {
  const arr = Array.isArray(list) ? list : [];
  const q = String(query || '').trim().toLowerCase();
  return arr.filter((x) => {
    if (!x) return false;
    if (kind !== 'all' && x.kind !== kind) return false;
    if (!q) return true;
    return [x.title, x.body, x.extra, x.category, x.source]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q);
  });
}

/** 复习进度的排序依据：最近复习过 > 复习次数多 > 到期更晚 */
function scheduleRank(x) {
  return [num(x && x.lastReviewed, 0), num(x && x.reps, 0), num(x && x.due, 0)];
}

/**
 * 合并同一条收藏的两份副本。
 * 正文字段（标题/解释/来源）永远以本机已有的为准 —— 同步是合并不是覆盖；
 * 但**复习进度必须并过来**：进度只在新复习过的那份上有意义。
 * 以前这里只按 id 去重、直接丢掉进来的副本，结果就是"这台设备复习了，另一台还显示待复习"。
 */
export function mergeFavoriteItem(local, incoming) {
  if (!local) return incoming;
  if (!incoming) return local;
  const a = scheduleRank(local);
  const b = scheduleRank(incoming);
  const pickIncoming = b[0] !== a[0] ? b[0] > a[0] : b[1] !== a[1] ? b[1] > a[1] : b[2] > a[2];
  const src = pickIncoming ? incoming : local;
  const changed = FAV_SCHEDULE_FIELDS.some((k) => (local[k] === undefined ? '' : local[k]) !== (src[k] === undefined ? '' : src[k]));
  if (!changed) return local; // 没变化就返回原对象，避免同步时无意义的写入与重渲染
  const out = { ...local };
  for (const k of FAV_SCHEDULE_FIELDS) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/**
 * 合并导入/同步来的收藏（按 id 去重，新的在前）。
 * @returns {{merged: Array, added: number, updated: number}} updated = 复习进度被更新的条数
 */
export function mergeFavorites(incoming, current) {
  const cur = (Array.isArray(current) ? current : []).slice();
  const add = (Array.isArray(incoming) ? incoming : []).filter((x) => x && x.id && x.title);
  const index = new Map();
  cur.forEach((x, i) => { if (x && x.id) index.set(x.id, i); });
  const fresh = [];
  const freshIds = new Set();
  let updated = 0;
  for (const item of add) {
    const i = index.get(item.id);
    if (i === undefined) {
      if (freshIds.has(item.id)) continue;
      freshIds.add(item.id);
      fresh.push(item);
      continue;
    }
    // 注意：这里**不**给进来的一份补默认排期 —— 只有对方真的复习过（带具体 due/reps）
    // 才值得写回本机；否则两边都没有排期时每次同步都会"造"出一次无意义更新。
    const merged = mergeFavoriteItem(cur[i], item);
    if (merged !== cur[i]) { cur[i] = merged; updated += 1; }
  }
  return { merged: [...fresh, ...cur], added: fresh.length, updated };
}

/** 把收藏导出为纯文本（用于「复制全部」） */
export function favoritesToText(list) {
  return (Array.isArray(list) ? list : []).map((x, i) => [
    (i + 1) + '. [' + (FAV_KIND_LABEL[x.kind] || x.kind) + (x.category ? ' / ' + x.category : '') + '] ' + x.title,
    x.body || '',
    x.extra || '',
    x.source ? '（来自：' + x.source + '）' : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}
