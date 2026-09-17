/**
 * 出题结果的形状清洗（自测题 / 错误训练共用）。
 *
 * 为什么必须在服务端做，而不是只在提示词里叮嘱：这两类毛病**只在真实模型上出现**，
 * 而且不报错、不崩，只是让题目变得没法做 —— 提示词写得再清楚也拦不住偶发。
 * 用户实测反馈的两个具体问题（见 2026-09-17 的截图）：
 *
 *  1. **中文提示被挖空**：「根据中文提示填空：当那人试图让快艇转弯时，____ 脱手了。」
 *     中文是给学生看的**提示**，挖掉了他就无从下手 —— 空只能挖在英文里。
 *  2. **同一句话出两道题**：同一句英文先出「填空」再出「改错」。
 *     两道题考的是同一处错，学生做第二道时会觉得在做重复劳动（用户原话：
 *     "4 和 5，7 和 8 本质上不都是一道题吗"）。
 *
 * 这里两条都做成**可测的纯函数**：给一批题目，返回过滤后的题目 + 丢弃统计。
 */

/** 填空标记：连续下划线（半角/全角），以及只含空白的小括号 */
const BLANK_RE = /_{2,}|＿{1,}|\(\s*\)|（\s*）|\[\s*\]|【\s*】/g;
/** 中日韩文字与全角标点：出现在空的紧邻位置就说明这个空挖在中文里 */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** 取字符串里第 i 个字符（越界返回空串） */
const at = (s, i) => (i >= 0 && i < s.length ? s[i] : '');

/**
 * 题干里是否存在"挖在中文里的空"。
 *
 * 判据：空的前后**紧邻的非空白字符**只要有任一侧是中文/全角标点，就算挖错了。
 * 英文填空的邻居一定是拉丁字母或标点（`the ____ slipped`），不会命中。
 */
export function blankInChinese(question) {
  const text = String(question || '');
  if (!text) return false;
  BLANK_RE.lastIndex = 0;
  let m = BLANK_RE.exec(text);
  while (m) {
    const before = at(text, m.index - 1);
    const after = at(text, m.index + m[0].length);
    if (CJK_RE.test(before) || CJK_RE.test(after)) return true;
    m = BLANK_RE.exec(text);
  }
  return false;
}

/**
 * 这一题考的是哪句英文 —— 用于"同一句话别出两道题"。
 *
 * 做法：把题干里的填空与标点抹掉，取出最长的一段英文，归一化成小写词序列。
 * 太短（少于 4 个词）就不认，避免把"A. looked for"这种选项当成句子。
 */
export function sourceSentence(question) {
  const text = String(question || '').replace(BLANK_RE, ' ').replace(/[^A-Za-z'’\-\s]/g, ' ');
  const runs = text.split(/\s{2,}|\n/).map((x) => x.trim()).filter(Boolean);
  let best = '';
  for (const run of runs) {
    const words = run.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    if (words.length > best.split(' ').filter(Boolean).length) best = words.join(' ');
  }
  const words = best.toLowerCase().replace(/[^a-z'’\-\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length >= 4 ? words.join(' ') : '';
}

/** 题干/答案是不是空的（模型偶尔吐半条） */
export function isIncompleteQuestion(q) {
  if (!q || typeof q !== 'object') return true;
  const text = String(q.question || '').trim();
  const answer = String(q.answer || '').trim();
  return !text || !answer;
}

/**
 * 清洗一批题目。
 *
 * @param {Array} list  模型返回的 questions
 * @param {object} o
 * @param {number} o.count  要求的题量（多于这个数就截断；0/未给则不截断）
 * @param {boolean} o.drill 错误训练：额外启用"中文不能挖空""同句不重复"两条
 * @returns {{questions: Array, dropped: {incomplete:number, chineseBlank:number, duplicate:number, over:number}}}
 */
export function sanitizeQuestions(list, { count = 0, drill = false } = {}) {
  const out = [];
  const dropped = { incomplete: 0, chineseBlank: 0, duplicate: 0, over: 0 };
  const seen = new Set();

  for (const q of (Array.isArray(list) ? list : [])) {
    if (isIncompleteQuestion(q)) { dropped.incomplete += 1; continue; }
    if (drill) {
      // 中文提示里被挖空 → 这道题没法做（用户实测反馈）
      if (blankInChinese(q.question)) { dropped.chineseBlank += 1; continue; }
      // 同一句英文只留一道题（先出现的留下）：填空 + 改错 考的是同一处错，等于重复劳动
      const key = sourceSentence(q.question);
      if (key) {
        if (seen.has(key)) { dropped.duplicate += 1; continue; }
        seen.add(key);
      }
    }
    out.push(q);
  }

  const want = Number(count) > 0 ? Number(count) : 0;
  if (want && out.length > want) {
    dropped.over = out.length - want;
    return { questions: out.slice(0, want), dropped };
  }
  return { questions: out, dropped };
}
