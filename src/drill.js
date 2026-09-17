/**
 * 错误训练：把「你在这几课里**实际犯过的错**」捞出来，交给模型针对性地出题。
 *
 * 为什么单独一个模块：这一层要同时读三份数据 —— 逐课进度（`bt-lesson-progress`）、
 * 历史记录（`bt-history`，带 lessonKey）、以及每次作业的结果缓存（`bt-result-<jobId>`）。
 * 三者的键、生命周期、脏数据形态都不一样，掺进组件里既测不了也容易漏。
 * 这里只做纯函数：给什么数据算什么结果，不碰 React、不碰网络。
 *
 * 与「自测题」的关系：出题链路完全复用（points → /api/quiz → 试卷页），
 * 区别只在**输入从哪来** —— 自测题用收藏夹，这里用选中的课时错题。
 */

/** 一课的可读名字（内置库用 title_cn/en，自建库可能只有标题） */
export function lessonName(l) {
  if (!l) return '';
  const t = l.title_cn || l.title_en || l.title || '';
  return t ? `${String(l.lesson ?? l.lid ?? '').padStart(2, '0')} ${t}`.trim() : String(l.lesson ?? l.lid ?? '');
}

/** 只保留"真的算错"的项：study（对照学习）不是错，improve 单独标出来 */
const isError = (f) => String((f && f.level) || 'error') === 'error';
const isImprove = (f) => String((f && f.level) || '') === 'improve';

function findingText(f) {
  const from = String((f && f.from) || '').trim();
  const to = String((f && f.to) || '').trim();
  const cat = String((f && f.category) || '其他').trim();
  const why = String((f && f.explanation) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return { cat, from, to, why };
}

/** 一条错题压成给模型看的一行（错题与"可提升点"共用，只有措辞不同） */
function pointLine(name, e, kind) {
  if (kind === 'improve') {
    return `【${name}·可提升·${e.cat}】原句「${e.cn || '（无）'}」：我写「${e.from}」，更地道的是「${e.to}」${e.why ? '。' + e.why : ''}`;
  }
  return `【${name}·${e.cat}】原句「${e.cn || '（无）'}」里我写成「${e.from || '（漏写）'}」，应为「${e.to || '（多余）'}」${e.why ? '。' + e.why : ''}`;
}

/** 短哈希（djb2）：只用来给错题做稳定标识，不做安全用途 */
function shortHash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 5);
}

/**
 * 一条错题的**稳定 id** —— 用来记住"这道错题已经出过题了"。
 *
 * 为什么不用数组下标：下标会随"历史里又多了几条作业""某条历史被删"而整体位移，
 * 记住的 id 就全错位了 —— 表现为"我明明刚练过，怎么又出一样的题"。
 * 所以用「哪一课 + 错在哪类 + 把什么改成什么 + 原句指纹」来定身份：
 * 同一个班次里重复出现的同一条错误视为同一条（本来就该一起练）。
 */
export function errorId(lessonKey, e) {
  const cat = String((e && e.cat) || '');
  const from = String((e && e.from) || '');
  const to = String((e && e.to) || '');
  return [lessonKey || '', cat, from + '→' + to, shortHash((e && e.cn) || '')].join('|');
}

/**
 * 选出这一次要出的题 —— **没用过的优先，其次最久没用过的**。
 *
 * 用户的原话：「我一篇课文有 17 个错误，第一次出题 10 道，第二次也出 10 道，
 * 希望第二次尽量避免和第一次大规模重复，要把剩下 7 道都包含在内。」
 * 这条规则正好满足它：第二次的 10 道 = 没出过的 7 道 + 上次出过的 3 道（最久远的先来）。
 *
 * 两处刻意的设计：
 *  1. 课与课之间**轮转**取题（每课各一条、循环），而不是"错得最多的那课先拿完" ——
 *     否则选了两课、第一课有 30 个错，第二课永远轮不到，等于白选。
 *  2. 返回的是**恰好 count 条**（不够就有多少给多少），并把用掉的 id 一起带回去。
 *     调用方拿这批 id 记账，下次才不会又抽到它们 —— 这也是"精确覆盖"能成立的前提：
 *     多送给模型几条、让它自己挑，就无从知道它到底用了哪几条，记账必然失真。
 *
 * @param {Array} rows   collectDrills 的结果（只取选中的那几课）
 * @param {object} o
 * @param {number} o.count 要出多少题
 * @param {object} o.used  { [errorId]: 上次使用时间 } —— 见 storage.js 的 loadDrillUsed
 * @returns {{points: string[], ids: string[], fresh: number, reused: number}}
 */
export function pickDrillItems(rows, { count = 10, used = {} } = {}) {
  const want = Math.max(1, Math.min(100, Number(count) || 10));
  const usedMap = used && typeof used === 'object' ? used : {};
  const queues = [];

  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r) continue;
    const all = [
      ...(Array.isArray(r.errors) ? r.errors : []).map((e) => ({ e, kind: 'error' })),
      ...(Array.isArray(r.improves) ? r.improves : []).map((e) => ({ e, kind: 'improve' })),
    ];
    const items = all.map(({ e, kind }) => {
      const id = errorId(r.key, e);
      return { row: r, e, kind, id, at: Number(usedMap[id]) || 0 };
    });
    // 课内顺序：没出过的按原顺序排前面；出过的按"最久没出"排后面
    const fresh = items.filter((x) => !x.at);
    const seen = items.filter((x) => x.at).sort((a, b) => a.at - b.at);
    const queue = [...fresh, ...seen];
    if (queue.length) queues.push(queue);
  }

  const picked = [];
  let moved = true;
  while (picked.length < want && moved) {
    moved = false;
    for (const q of queues) {
      if (picked.length >= want) break;
      const next = q.shift();
      if (!next) continue;
      picked.push(next);
      moved = true;
    }
  }
  return picked;
}

/**
 * pickDrillItems 的"给模型看"版本：文案 + 用掉的 id + 新旧统计。
 * 为什么把 id 一起回传：调用方要拿它记账（下次避开），见 markDrillUsed。
 */
export function pickDrillPoints(rows, opts = {}) {
  const picked = pickDrillItems(rows, opts);
  return {
    points: picked.map((x) => pointLine(x.row.name, x.e, x.kind)),
    ids: picked.map((x) => x.id),
    fresh: picked.filter((x) => !x.at).length,
    reused: picked.filter((x) => x.at).length,
  };
}

/**
 * 从「进度 + 历史 + 结果缓存」里收集每课的错题。
 *
 * @param {object} o
 * @param {Array}  o.lessons   当前可见课时列表（用来把 lessonKey 还原成课号/标题）
 * @param {Function} o.keyOf   课 → lessonKey（与侧栏/生成用的是同一个函数，绝不能各写一份）
 * @param {object} o.progress  逐课进度表（判断"练过没有"，历史只有 20 条会漏）
 * @param {Array}  o.history   历史记录（带 lessonKey + jobId）
 * @param {Function} o.loadResult  (jobId) => 结果对象（从结果缓存读）
 * @returns {Array<{key, lesson, name, attempts, errors, improves, byCategory, lastAt}>}
 *          按"错误数从多到少"排序 —— 用户最该先练的就是错得最多的那课
 */
export function collectDrills({ lessons, keyOf, progress = {}, history = [], loadResult } = {}) {
  const list = Array.isArray(lessons) ? lessons : [];
  const rows = new Map();

  for (const l of list) {
    if (!l) continue;
    const key = keyOf ? keyOf(l) : '';
    if (!key) continue;
    const p = progress[key] || null;
    rows.set(key, {
      key,
      lesson: l.lesson ?? l.lid ?? '',
      name: lessonName(l),
      attempts: Number(p && p.n) || 0,
      lastAt: Number(p && p.at) || 0,
      best: Number(p && p.best) || 0,
      errors: [],
      improves: [],
      byCategory: {},
      source: 'history',      // history = 有作业记录 | material = 只有上传的材料 | none
    });
  }

  // 历史里没有、但进度表里有记录的课（历史只留 20 条，老课会被挤掉）
  for (const [key, p] of Object.entries(progress || {})) {
    if (rows.has(key) || !p) continue;
    // 不属于当前课表（换了课文库/自建库）的进度不参与
    const lesson = /^lesson:([^-]+)-(.+)$/.exec(key);
    rows.set(key, {
      key,
      lesson: lesson ? lesson[2] : '',
      name: lesson ? `Lesson ${lesson[2]}` : key,
      attempts: Number(p.n) || 0,
      lastAt: Number(p.at) || 0,
      best: Number(p.best) || 0,
      errors: [], improves: [], byCategory: {}, source: 'history',
    });
  }

  // 把历史里的错题按 lessonKey 归到各课
  for (const h of (Array.isArray(history) ? history : [])) {
    if (!h || !h.lessonKey || !h.jobId) continue;
    const row = rows.get(h.lessonKey);
    if (!row) continue;                       // 不属于当前课表的历史，跳过
    let r = null;
    try { r = loadResult ? loadResult(h.jobId) : null; } catch { r = null; }
    if (!r || !Array.isArray(r.sentences)) continue;
    for (const sn of r.sentences) {
      if (!sn || !Array.isArray(sn.findings)) continue;
      const cn = String(sn.cn || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      for (const f of sn.findings) {
        if (!f || typeof f !== 'object') continue;
        const t = findingText(f);
        if (!t.cat && !t.from && !t.to) continue;
        const item = { ...t, cn, lesson: row.lesson, lessonName: row.name };
        if (isError(f)) {
          row.errors.push(item);
          row.byCategory[t.cat] = (row.byCategory[t.cat] || 0) + 1;
        } else if (isImprove(f)) {
          row.improves.push(item);
        }
      }
    }
  }

  const out = [...rows.values()].filter((r) => r.attempts > 0 || r.errors.length || r.improves.length);
  // 错误多的在前；同样多就按最近练过的排
  out.sort((a, b) => (b.errors.length - a.errors.length) || (b.lastAt - a.lastAt));
  return out;
}

/** 汇总：选中的这些课一共多少错、都是什么类型 */
export function summarizeDrills(rows) {
  const picked = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const byCategory = {};
  let errors = 0;
  let improves = 0;
  for (const r of picked) {
    errors += r.errors.length;
    improves += r.improves.length;
    for (const [cat, n] of Object.entries(r.byCategory || {})) byCategory[cat] = (byCategory[cat] || 0) + n;
  }
  const list = Object.entries(byCategory).map(([cat, n]) => ({ cat, n })).sort((a, b) => b.n - a.n);
  return { lessons: picked.length, errors, improves, byCategory: list };
}

/**
 * 压成给模型的要点清单（不带"用过没用过"的概念，给需要全量清单的调用方用）。
 * 每条都带**原始错句**，模型才知道"你当时想说什么"——只给 from→to 它会出成空泛的语法题。
 *
 * 出题链路上用的是 pickDrillPoints（它按"没出过的优先"选题）；
 * 这个函数保留下来是给"我要看全部错题"这类场景，两者共用 pointLine 的措辞。
 */
export function drillsToPoints(rows, { maxPerLesson = 10, max = 60 } = {}) {
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r) continue;
    let n = 0;
    for (const e of r.errors) {
      if (n >= maxPerLesson || out.length >= max) break;
      out.push(pointLine(r.name, e, 'error'));
      n += 1;
    }
    // 可提升点跟在错题后面（同样针对这个人，但不是"错"）
    for (const e of r.improves) {
      if (n >= maxPerLesson || out.length >= max) break;
      out.push(pointLine(r.name, e, 'improve'));
      n += 1;
    }
    if (out.length >= max) break;
  }
  return out;
}

/** 用户上传的材料（没有作业记录的课时）也压成一段 */
export function materialsToText(materials) {
  const list = Array.isArray(materials) ? materials.filter((m) => m && m.text) : [];
  return list.map((m) => `【${m.name || '上传材料'}】\n${String(m.text).slice(0, 6000)}`).join('\n\n');
}

/**
 * 本地兜底出题（AI 失败时用）：把错题直接变成"改错题"。
 * 有真错题在手，兜底卷的质量其实不差 —— 比重试一次网络请求更让用户踏实。
 *
 * 选题**与 AI 那条链路完全同一套规则**（pickDrillPoints：没出过的优先），
 * 所以兜底卷也不会把上次的题原样再来一遍。
 *
 * ⚠️ 题量上不"轮着出"：错题只有 4 条而要 10 题时，返回 4 道**不重复**的，
 * 而不是把同样 4 道抄两遍半 —— 重复的题对复习没有增量，只会让人觉得工具在糊弄。
 * （AI 那条链路不受影响：模型可以围绕同一个错点换角度出不同的题。）
 */
export function buildLocalDrill(rows, count = 10, { used = {} } = {}) {
  const picked = pickDrillItems(rows, { count, used }).filter(({ e }) => e.from && e.to);
  // 干扰项池：拿别人的"正确写法"当选项 —— 它们是**同一批错题里的真实表达**，
  // 比随机凑词更像回事，且天然跟这个人的水平贴。
  const pool = [...new Set(picked.map((x) => String(x.e.to || '').trim()).filter(Boolean))];
  const questions = picked.map(({ row: r, e }, i) => {
    const cat = e.cat ? '·' + e.cat : '';
    const why = e.why || `${e.cat || '错误'}：应改为「${e.to}」`;
    // 题型交替：全出"改错"十道会很单调（用户要求"题型灵活一点"）。
    // 这里只用**能自动判分**的两种：改错（写出来）与选择（选出正确表达）。
    if (i % 2 === 1 && pool.length >= 3) {
      const wrong = pool.filter((x) => x !== e.to).slice(0, 3);
      const options = [e.to, ...wrong].sort((a, b) => (a < b ? -1 : 1));   // 稳定顺序：同一次生成的卷子可复现
      return {
        type: '选择',
        question: `选择正确的表达（${r.name}${cat}）：原句说的是「${e.cn || '（无中文）'}」，`
          + `我写的是「${e.from}」。下面哪个才是对的？`,
        options: options.map((o, k) => String.fromCharCode(65 + k) + '. ' + o),
        answer: e.to,
        explanation: why,
        source: r.name,
      };
    }
    // ⚠️ 字段名必须与自测题那条链路**完全一致**（question / 中文题型 / source），
    //    否则试卷页、复制、导出 PDF 全都渲染不出来 —— 两个形状各写一份必然漂移。
    return {
      type: '改错',
      question: `改错（${r.name}${cat}）${e.cn ? '：原句说的是「' + e.cn + '」' : ''}
我写的是：${e.from}
请改正。`,
      options: [],
      answer: e.to,
      explanation: why,
      source: r.name,
    };
  });
  return {
    // 标题/字段与 buildLocalQuiz 对齐（同一个试卷页直接复用）
    title: '错误训练 · ' + questions.length + ' 题（本地生成）',
    local: true,
    count: questions.length,
    questions,
  };
}

