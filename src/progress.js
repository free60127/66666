/**
 * 练习进度：错误类型统计 + 「同一课文的两次练习」对比。
 *
 * 为什么单独成模块：结果页要回答"这次比上次好在哪"，数据源就是历史 + 结果缓存；
 * 而"怎么算同一课、好多少、哪类错真的改掉了"全是纯计算。
 * 抽出来一是结果页与历史页能共用，二是能在 node 里直接跑单测
 * （App.jsx 是 JSX，逻辑塞在里面就测不到）。
 *
 * 本模块**不碰任何存储**：要看历史里存的结果缓存，由调用方把读取函数传进来（readResult）。
 */

/** 一次结果里的问题类型分布（level=study 的"对照学习"不算问题，不进榜） */
export function tallyCategories(results) {
  const byCat = new Map();
  let errors = 0;
  let improves = 0;
  let sentences = 0;
  let used = 0;
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || typeof r !== 'object') continue;
    const sents = Array.isArray(r.sentences) ? r.sentences : [];
    if (!sents.length) continue;
    used += 1;
    for (const sn of sents) {
      if (!sn || typeof sn !== 'object') continue;
      sentences += 1;
      const fs = Array.isArray(sn.findings) ? sn.findings : [];
      for (const f of fs) {
        if (!f || typeof f !== 'object') continue;
        const cat = String(f.category || '').trim();
        if (!cat) continue;
        const lv = String(f.level || 'error');
        if (lv === 'study') continue; // 对照学习不是"错"，不进榜
        const cur = byCat.get(cat) || { cat, total: 0, error: 0, improve: 0 };
        cur.total += 1;
        if (lv === 'improve') { cur.improve += 1; improves += 1; } else { cur.error += 1; errors += 1; }
        byCat.set(cat, cur);
      }
    }
  }
  return {
    list: [...byCat.values()].sort((a, b) => b.total - a.total || b.error - a.error),
    errors,
    improves,
    sentences,
    used,
  };
}

/** 综合评分：没有就返回 null（而不是 0 —— 那会显示成"考了 0 分"） */
export function scoreOf(result) {
  const raw = result && result.overall ? result.overall.score : undefined;
  if (raw === undefined || raw === null || raw === '') return null; // Number(null) === 0，必须先挡掉
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 问题总数（必改 + 可提升），拿不到结构时返回 null */
function issueCountOf(result) {
  if (!result || !Array.isArray(result.sentences) || !result.sentences.length) return null;
  const t = tallyCategories([result]);
  return t.errors + t.improves;
}

/**
 * 课标识。
 * 新结果在生成时就带上 lessonKey（形如 lesson:2-18 / free）；这里是白名单式归一化，
 * 认不出的值一律当"没有标识"，避免脏数据把两次无关的练习凑成一对。
 */
export function normalizeLessonKey(key) {
  const k = String(key == null ? '' : key).trim();
  if (!k) return '';
  if (k === 'free' || k === 'demo') return k;
  return /^lesson:[\w-]+$/.test(k) ? k : '';
}

const LESSON_TITLE_RE = /^lesson\s*\d+/i;

/** 老结果没有 lessonKey：标题形如 "Lesson 18 · He often does this!" 时按标题当作同一课 */
export function legacyLessonKey(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || !LESSON_TITLE_RE.test(t)) return '';
  return 'title:' + t.slice(0, 120);
}

function attemptKeys(x) {
  const strong = normalizeLessonKey(x && x.lessonKey);
  return { strong, weak: strong ? '' : legacyLessonKey(x && x.title) };
}

/**
 * 两份结果是不是"同一课的两次练习"。
 * 强匹配（都有 lessonKey）优先；两边都没有标识时才退到标题匹配 ——
 * 这是为了兼容加 lessonKey 之前就存在的老历史，而不是为了"尽量对上"。
 */
export function sameLesson(a, b) {
  const ka = attemptKeys(a);
  const kb = attemptKeys(b);
  if (ka.strong && kb.strong) {
    if (ka.strong === 'free' || ka.strong === 'demo') return false; // 自由练习/示例没有"同一课"概念
    return ka.strong === kb.strong;
  }
  if (!ka.strong && !kb.strong && ka.weak && kb.weak) return ka.weak === kb.weak;
  return false;
}

/** 当前结果与缓存里那份是不是同一次练习（分享链接/离线示例没有 jobId，只能靠指纹认自己） */
function sameAttempt(a, b) {
  if (!a || !b) return false;
  return String(a.title || '') === String(b.title || '')
    && scoreOf(a) === scoreOf(b)
    && Number(a.overall && a.overall.issues) === Number(b.overall && b.overall.issues)
    && (Array.isArray(a.sentences) ? a.sentences.length : 0) === (Array.isArray(b.sentences) ? b.sentences.length : 0);
}

const DAY = 86400000;

function compareNum(prev, now) {
  if (prev == null && now == null) return null;
  const p = prev == null ? 0 : prev;
  const n = now == null ? 0 : now;
  return { prev: p, now: n, delta: n - p };
}

/**
 * 找出上一次同课练习并算出差异。
 *
 * @param {object}   o
 * @param {Array}    o.history    历史列表（新的在前，顺序无所谓，内部按 time 排）
 * @param {object}   o.result     当前结果
 * @param {string}   [o.jobId]    当前结果的 jobId（自己不算"上次"）
 * @param {Function} [o.readResult] 由 jobId 读结果缓存的函数；不传就只认能强匹配的数据
 * @param {number}   [o.topCats]  对比几类问题（默认 4）
 * @returns {object|null} 没有可比的上一次 → null
 */
export function compareWithPrevious({ history, result, jobId = '', readResult = null, topCats = 4, now = Date.now() } = {}) {
  const cur = result;
  if (!cur || typeof cur !== 'object') return null;
  const read = typeof readResult === 'function' ? readResult : () => null;
  const list = (Array.isArray(history) ? history : [])
    .filter((h) => h && h.jobId)
    .slice()
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));

  let prevEntry = null;
  let prev = null;
  // 「上次」必须**早于这一次**。历史里躺着的不只是过去：从「历史结果」点开一条旧作业时，
  // 更新的那几次练习也在列表里 —— 不加时间截断就会拿"后来的那次"当上次，结论完全是反的。
  const selfEntry = jobId ? list.find((h) => h.jobId === jobId) : null;
  const curTime = Number(cur.attemptTime) || (selfEntry && Number(selfEntry.time)) || now;
  for (const h of list) {
    if (jobId && h.jobId === jobId) continue;
    if ((Number(h.time) || 0) > curTime) continue; // 比这次晚的练习不算"上次"
    let cached = null;
    try { cached = read(h.jobId); } catch { cached = null; }
    if (!cached || typeof cached !== 'object') continue;
    if (!jobId && sameAttempt(cached, cur)) continue; // 没有 jobId 时别把"自己"当成上一次
    if (!sameLesson(cached, cur)) continue;
    prevEntry = h;
    prev = cached;
    break;
  }
  if (!prevEntry || !prev) return null;

  const prevTally = tallyCategories([prev]);
  const curTally = tallyCategories([cur]);
  const prevScore = scoreOf(prev);
  const curScore = scoreOf(cur);
  const prevIssues = issueCountOf(prev);
  const curIssues = issueCountOf(cur);
  const prevDuration = Number(prev.durationMs) || 0;
  const curDuration = Number(cur.durationMs) || 0;

  const nowByCat = new Map(curTally.list.map((x) => [x.cat, x]));
  const items = prevTally.list.slice(0, Math.max(0, topCats)).map((p) => {
    const n = nowByCat.get(p.cat);
    const nowTotal = n ? n.total : 0;
    const delta = nowTotal - p.total;
    return {
      cat: p.cat,
      prev: p.total,
      now: nowTotal,
      delta,
      state: nowTotal === 0 ? 'fixed' : delta < 0 ? 'down' : delta > 0 ? 'up' : 'same',
    };
  });

  const score = compareNum(prevScore, curScore);
  const errors = compareNum(prevTally.errors, curTally.errors);
  const improves = compareNum(prevTally.improves, curTally.improves);
  const issues = compareNum(prevIssues, curIssues);
  const duration = prevDuration && curDuration ? compareNum(prevDuration, curDuration) : null;
  const time = Number(prevEntry.time) || 0;

  // 上一次一条有效问题都没有、这次也没有 —— 没什么可对比的
  if (!score && !items.length) return null;

  return {
    prev: {
      jobId: prevEntry.jobId,
      time,
      title: String(prev.title || prevEntry.title || ''),
      daysAgo: time ? Math.max(0, Math.floor((now - time) / DAY)) : null,
      score: prevScore,
      errors: prevTally.errors,
      improves: prevTally.improves,
      categories: prevTally.list,
    },
    cur: {
      score: curScore,
      errors: curTally.errors,
      improves: curTally.improves,
      categories: curTally.list,
    },
    score,
    errors,
    improves,
    issues,
    duration,
    items,
    tried: items.length,
    fixed: items.filter((x) => x.state === 'fixed').length,
    worse: items.filter((x) => x.state === 'up').length,
    still: items.filter((x) => x.state === 'same' || x.state === 'down').length,
  };
}
