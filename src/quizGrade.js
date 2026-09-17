/**
 * 自测卷的判分逻辑（纯函数：不碰 React、不碰网络，见 test/quizGrade.test.mjs）。
 *
 * 分两层（产品上叫"混合批改"）：
 *  · **本地判**：选择 / 填空 / 改错 / 答案只有一个词的翻译 —— 点一下立刻出对错，断网也能用；
 *  · **交给 AI**：翻译、造句这类"有多种正确写法"的主观题（见 hooks/useQuizGrade.js），
 *    AI 不可用时退回"对照参考答案自评"。
 *
 * 判分尺度的取舍：宁可把"意思对但写得不一样"判成「接近」，也不要判成「错」——
 * 学生明明改对了却被判错，比看到"接近，自己再对照一下"更打击人；而真正的错误
 * 由 AI（或参考答案）兜住。
 */

/** 判定结果的三档（界面上直接显示这三个字） */
export const VERDICT_LABEL = { right: '对', close: '接近', wrong: '错' };

/** 选项序号用的字母表（超过 8 个选项的卷子没见过，但别在这里崩） */
const LETTERS = 'ABCDEFGHIJ';

/**
 * 归一化：全角转半角、大小写、标点、多余空白都不算差异。
 * 「Swung round.」与「swing round」的差别不该是判分依据 —— 该判的是用词和语法。
 */
export function normalizeAnswer(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')                                   // 全角字母/数字/标点 → 半角
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[.,!?;:"'()[\]{}<>·、，。！？；：（）【】《》…—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 标准答案里可能写了多种可接受写法（"swing / swung"、"on；upon"、"by bus 或 on foot"）。
 * 拆开的原因：拆之前，学生写对了另一种写法也会被判错。
 * 括号里的补充说明（「swing（过去式 swung）」）也会单独拆成一种写法。
 */
export function answerVariants(answer) {
  const raw = String(answer == null ? '' : answer);
  const parts = raw
    .split(/[/|｜；;]|\s+或\s+|\s+or\s+|、/i)
    .map((x) => x.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    out.push(p);
    const noParen = p.replace(/[（(][^）)]*[）)]/g, ' ').trim();
    if (noParen && noParen !== p) out.push(noParen);
    // 「swing（过去式 swung）」：括号里中文标签后面的那个英文词也是可接受写法。
    // 只认"以中文开头、以英文结尾"的括号，避免把英文注释整段当成答案。
    const inner = /[（(]([^）)]*)[）)]/.exec(p);
    const tagged = inner && /^[\u4e00-\u9fa5][^A-Za-z]*([A-Za-z][A-Za-z'\- ]*)$/.exec(inner[1].trim());
    if (tagged && tagged[1].trim()) out.push(tagged[1].trim());
  }
  return [...new Set(out.map(normalizeAnswer).filter(Boolean))];
}

/** 分句成词（判相似度用） */
function words(s) {
  return normalizeAnswer(s).split(' ').filter(Boolean);
}

/**
 * 相似度 0..1：按**词**求最长公共子序列，再除以较长者的词数。
 * 用 LCS 而不是逐位比较，是因为学生会调换语序、增删修饰语 —— 那些不该算全错。
 */
export function similarity(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.length || !B.length) return 0;
  let prev = new Uint16Array(B.length + 1);
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Uint16Array(B.length + 1);
    for (let j = 1; j <= B.length; j += 1) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[B.length] / Math.max(A.length, B.length);
}

/**
 * 字符级相似度 0..1（忽略空格）。
 *
 * 为什么还要有它：词级相似度看不出"一个词里拼错两个字母" ——
 * steering **weel** 与 steering **wheel** 的词级相似度只有 0.5（会被判错），
 * 而这明明只是手滑。填空/单词类答案按字符比更贴近人的直觉。
 */
export function charSimilarity(a, b) {
  const A = normalizeAnswer(a).replace(/ /g, '');
  const B = normalizeAnswer(b).replace(/ /g, '');
  if (!A.length || !B.length) return 0;
  let prev = new Uint16Array(B.length + 1);
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Uint16Array(B.length + 1);
    for (let j = 1; j <= B.length; j += 1) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[B.length] / Math.max(A.length, B.length);
}

/* ---------- 选择题：选项与答案的对应关系 ---------- */

/** 选项自带的字母（"B. swing…" → "B"）；没有就返回空串 */
export function optionLetter(o) {
  const m = /^\s*[（(]?([A-Ja-j])[)）.、．:：]\s*\S/.exec(String(o == null ? '' : o));
  return m ? m[1].toUpperCase() : '';
}

/** 界面上显示的选项字母：选项自己没带就按位置给 A/B/C/D */
export function optionLabel(o, i) {
  return optionLetter(o) || LETTERS[i] || String(i + 1);
}

/** 选项去掉字母前缀后的正文 */
export function optionText(o) {
  return String(o == null ? '' : o).replace(/^\s*[（(]?[A-Ja-j][)）.、．:：]\s*/, '').trim();
}

/**
 * 标准答案对应哪个选项。
 * 模型写答案的三种习惯都要认：写字母（"B"）、写字母+正文（"B. swing"）、直接写正文（"swing"）。
 */
export function answerLetter(q) {
  const opts = Array.isArray(q && q.options) ? q.options.filter((o) => String(o == null ? '' : o).trim()) : [];
  const ans = String((q && q.answer) || '').trim();
  if (!ans) return '';
  if (/^[A-Ja-j]$/.test(ans)) return ans.toUpperCase();
  const na = normalizeAnswer(ans);
  const byText = opts.findIndex((o) => normalizeAnswer(optionText(o)) === na);
  if (byText >= 0) return optionLabel(opts[byText], byText);
  const m = /^\s*[（(]?([A-Ja-j])[)）.、．:：]/.exec(ans);
  if (m) {
    const L = m[1].toUpperCase();
    if (opts.some((o, i) => optionLabel(o, i) === L)) return L;
  }
  return '';
}

/* ---------- 题型 → 判分方式 ---------- */

/** 答案是不是"一个词/一个短词组"—— 这种翻译题本地也能判，不必麻烦 AI */
export function isShortAnswer(answer) {
  const n = normalizeAnswer(answer);
  if (!n) return false;
  return n.split(' ').length <= 4 && n.length <= 40;
}

/**
 * 这道题怎么判：
 *  choice（点选项）/ blank（填空，精确比对）/ fix（改错，句子相似度）/ subjective（交给 AI）
 */
export function gradingMode(q) {
  const opts = Array.isArray(q && q.options) ? q.options.filter((o) => String(o == null ? '' : o).trim()) : [];
  const type = String((q && q.type) || '');
  if (opts.length >= 2) return 'choice';
  if (type.includes('选择')) return 'choice';
  if (type.includes('改错') || type.includes('纠错')) return 'fix';
  if (type.includes('填空')) return 'blank';
  return isShortAnswer(q && q.answer) ? 'blank' : 'subjective';
}

/** 需要 AI 判的主观题（翻译/造句这类没有唯一答案的） */
export function needsAI(q) {
  return gradingMode(q) === 'subjective';
}

/**
 * 本地判完之后，这一题还要不要请 AI 复核。
 *
 * 三种情况要：① 主观题（本地根本判不了）；② 本地判成「接近」的（拿不准）；
 * ③ 改错题本地判「错」的 —— 改错有无数种改法，本地相似度认不出"换了个说法但改对了"，
 * 一棍子打成错最伤人也最不准。选择题和普通填空判错就是错，不必再花一次调用。
 */
export function needsAIGrade(q, verdict) {
  const mode = gradingMode(q);
  if (mode === 'subjective') return true;
  if (!verdict) return false;
  if (verdict.status === 'close') return true;
  return mode === 'fix' && verdict.status === 'wrong';
}

/**
 * 本地判一道题。
 * @param {object} q    题目（含 answer / options）
 * @param {string} raw  学生的作答（选择题传选项字母）
 * @returns {{status:'right'|'close'|'wrong', by:'local', expected:string, reason?:string}|null}
 *          主观题或没有标准答案时返回 null（调用方改用 AI / 自评）
 */
export function judgeLocally(q, raw) {
  const expected = String((q && q.answer) || '').trim();
  const value = String(raw == null ? '' : raw).trim();
  const mode = gradingMode(q);
  if (mode === 'subjective' || !expected) return null;
  // 没作答就是错，不用绕一圈：空答案送进模型只会浪费一次调用
  if (!value) return { status: 'wrong', by: 'local', expected, reason: 'empty' };

  if (mode === 'choice') {
    const got = value.toUpperCase();
    const want = answerLetter(q);
    if (want) return { status: want === got ? 'right' : 'wrong', by: 'local', expected };
    // 认不出标准答案对应哪个选项（模型没按 "A. xxx" 的格式写）→ 退化成正文比对
    const opts = Array.isArray(q.options) ? q.options : [];
    const idx = opts.findIndex((o, i) => optionLabel(o, i) === got);
    const mine = idx >= 0 ? optionText(opts[idx]) : value;
    return { status: similarity(mine, expected) >= 0.9 ? 'right' : 'wrong', by: 'local', expected };
  }

  const variants = answerVariants(expected);
  const mine = normalizeAnswer(value);
  if (variants.includes(mine)) return { status: 'right', by: 'local', expected };

  if (mode === 'fix') {
    const sim = similarity(mine, expected);
    // 改错题的标准答案是一整句：只要**有一个实词和标准答案不一样**就算"接近"，
    // 交给参考答案（或 AI 复核）去判断那处改动到底对不对 —— 这里判"错"太容易冤枉人。
    return { status: sim >= 0.97 ? 'right' : sim >= 0.6 ? 'close' : 'wrong', by: 'local', expected };
  }

  // 填空/单词：词级与字符级取高的那个（拼错一两个字母 → 接近，而不是错）
  const best = variants.reduce((m, v) => Math.max(m, charSimilarity(v, mine), similarity(v, mine)), 0);
  // 答案是单个词、学生却把整句抄了进来 → 算接近（提示他只需填空格那一处）
  const spilled = variants.some((v) => v.split(' ').length === 1 && mine.split(' ').includes(v));
  return { status: best >= 0.75 || spilled ? 'close' : 'wrong', by: 'local', expected };
}

/**
 * 汇总：已判几题、三档各几题（界面底部的进度与得分）。
 * 「待自评」（status='pending'，AI 用不了时主观题退回来的状态）单列 ——
 * 它既不算已批改、也不算没做，混进任何一档都会让底部那行数字对不上。
 */
export function summarizeVerdicts(verdicts, total) {
  const list = Object.values(verdicts || {}).filter(Boolean);
  const n = (s) => list.filter((v) => v.status === s).length;
  const right = n('right');
  const close = n('close');
  const wrong = n('wrong');
  const selfPending = n('pending');
  const judged = right + close + wrong;
  return {
    total,
    judged,
    right,
    close,
    wrong,
    selfPending,
    unjudged: Math.max(0, total - judged - selfPending),
  };
}
