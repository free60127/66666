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
 * 压成给模型的要点清单。
 * 每条都带**原始错句**，模型才知道"你当时想说什么"——只给 from→to 它会出成空泛的语法题。
 */
export function drillsToPoints(rows, { maxPerLesson = 10, max = 60 } = {}) {
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r) continue;
    let n = 0;
    for (const e of r.errors) {
      if (n >= maxPerLesson || out.length >= max) break;
      out.push(`【${r.name}·${e.cat}】原句「${e.cn || '（无）'}」里我写成「${e.from || '（漏写）'}」，应为「${e.to || '（多余）'}」${e.why ? '。' + e.why : ''}`);
      n += 1;
    }
    // 可提升点跟在错题后面（同样针对这个人，但不是"错"）
    for (const e of r.improves) {
      if (n >= maxPerLesson || out.length >= max) break;
      out.push(`【${r.name}·可提升·${e.cat}】原句「${e.cn || '（无）'}」：我写「${e.from}」，更地道的是「${e.to}」${e.why ? '。' + e.why : ''}`);
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
 * 本地兜底出题（AI 失败时用）：把错题直接变成"改错题"和"翻译题"。
 * 有真错题在手，兜底卷的质量其实不差 —— 比重试一次网络请求更让用户踏实。
 */
export function buildLocalDrill(rows, count = 10) {
  const picked = (Array.isArray(rows) ? rows : []).filter((r) => r && (r.errors.length || r.improves.length));
  const pool = [];
  for (const r of picked) {
    for (const e of [...r.errors, ...r.improves]) {
      if (!e.from || !e.to) continue;
      // ⚠️ 字段名必须与自测题那条链路**完全一致**（question / 中文题型 / source），
      //    否则试卷页、复制、导出 PDF 全都渲染不出来 —— 两个形状各写一份必然漂移。
      pool.push({
        type: '改错',
        question: `改错（${r.name}${e.cat ? '·' + e.cat : ''}）${e.cn ? '：原句说的是「' + e.cn + '」' : ''}\n我写的是：${e.from}\n请改正。`,
        options: [],
        answer: e.to,
        explanation: e.why || `${e.cat || '错误'}：应改为「${e.to}」`,
        source: r.name,
      });
    }
  }
  const n = Math.max(1, Math.min(50, Number(count) || 10));
  const questions = [];
  for (let i = 0; i < n && pool.length; i += 1) questions.push(pool[i % pool.length]);
  return {
    // 标题/字段与 buildLocalQuiz 对齐（同一个试卷页直接复用）
    title: '错误训练 · ' + questions.length + ' 题（本地生成）',
    local: true,
    count: questions.length,
    questions,
  };
}
