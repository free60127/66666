export const EN2CN_DIMENSIONS = ['理解准确', '表达地道', '语体得当', '流畅度', '完整性'];
export const EN2CN_MAX = { 理解准确: 40, 表达地道: 15, 语体得当: 10, 流畅度: 10, 完整性: 25 };

/** Normalize structure only; missing scores or deductions remain invalid. */
export function normalizeEn2cnOverall(raw) {
  const overall = raw?.overall && typeof raw.overall === 'object' ? raw.overall : raw || {};
  const rows = overall.scoreBreakdown;
  return { ...overall, scoreBreakdown: rows && !Array.isArray(rows) && typeof rows === 'object'
    ? Object.entries(rows).map(([label, row]) => ({ ...(row && typeof row === 'object' ? row : { score: row }), label })) : rows };
}

/** Validate accounting, not semantic truth: the model must still interpret the source. */
export function en2cnScoreProblems(data) {
  const overall = data?.overall || {};
  const rows = overall.scoreBreakdown;
  const findings = (data?.sentences || []).flatMap((s) => s.findings || []);
  const problems = [];
  if (!Array.isArray(rows) || rows.length !== 5 || new Set(rows.map((r) => r.label)).size !== 5) return ['缺少五项独立评分'];
  const used = new Set();
  const sourceUsed = new Set();
  let total = 0;
  for (const label of EN2CN_DIMENSIONS) {
    const row = rows.find((r) => r.label === label);
    if (!row || !Array.isArray(row.deductions)) { problems.push(label + '缺少扣分依据'); continue; }
    let points = 0;
    for (const d of row.deductions) {
      if (!d || typeof d !== 'object') { problems.push('扣分依据格式无效'); continue; }
      const referenced = findings.filter((f) => d.sourceQuote && f.sourceQuote === d.sourceQuote && (!d.from || f.from === d.from));
      const suppliedIndex = Number(d.findingIndex);
      const f = referenced.length === 1 ? referenced[0] : Number.isInteger(suppliedIndex) && suppliedIndex > 0 ? findings[suppliedIndex - 1] : null;
      const index = findings.indexOf(f);
      const amount = Number(d.points);
      if (!f || f.level !== 'error' || !Number.isInteger(amount) || amount < 1 || amount > EN2CN_MAX[label]) {
        problems.push(label + '引用了非错误或无效扣分'); continue;
      }
      const sourceQuote = f.sourceQuote || d.sourceQuote;
      if ((d.sourceQuote && f.sourceQuote && d.sourceQuote !== f.sourceQuote) || (d.from && d.from !== f.from)) problems.push('扣分引用与逐句分析不符');
      if (!f.from || !String(data.draft || '').includes(f.from) || !sourceQuote || !String(data.chinese || '').includes(sourceQuote)) problems.push('扣分片段不能在原文和初稿中核验');
      if (f.primaryDimension && f.primaryDimension !== label) problems.push('扣分维度与错误归因不符');
      if (used.has(index) || sourceUsed.has(sourceQuote)) problems.push('同一信息重复扣分');
      if (/误译|数字|专名/.test(f.category || '') && label !== '理解准确') problems.push('事实误译应归理解准确');
      if (/漏译|增译/.test(f.category || '') && label !== '完整性') problems.push('信息缺失或新增应归完整性');
      used.add(index); sourceUsed.add(sourceQuote);
      points += amount;
    }
    const score = Number(row.score);
    if (Number(row.max) !== EN2CN_MAX[label] || points > EN2CN_MAX[label] || !Number.isInteger(score) || score !== EN2CN_MAX[label] - points) problems.push(label + '分数与依据不一致');
    total += score;
  }
  for (const [i, f] of findings.entries()) if (f.level === 'error' && !used.has(i)) problems.push('真实错误未体现于扣分依据');
  if (Number(overall.score) !== total) problems.push('总分与分项不一致');
  return [...new Set(problems)];
}

/** Sum evidenced deductions on the server. A model's intuition is not an extra deduction. */
export function reconcileEn2cnOverall(data) {
  const overall = normalizeEn2cnOverall(data?.overall);
  const rows = overall.scoreBreakdown;
  const findings = (data?.sentences || []).flatMap((s) => s.findings || []);
  if (!Array.isArray(rows) || rows.length !== 5) return overall;
  const retained = new Set();
  const rebuilt = [];
  for (const label of EN2CN_DIMENSIONS) {
    const row = rows.find((r) => r?.label === label);
    if (!row || Number(row.max) !== EN2CN_MAX[label] || !Array.isArray(row.deductions)) return overall;
    const deductions = [];
    const evidence = [];
    for (const d of row.deductions) {
      if (!d || typeof d !== 'object') return overall;
      const matches = findings.filter((f) => d.sourceQuote && f.sourceQuote === d.sourceQuote && (!d.from || f.from === d.from));
      const f = matches.length === 1 ? matches[0] : findings[Number(d.findingIndex) - 1];
      if (!f) return overall;
      if (f.level === 'improve' || f.level === 'study' || (f.primaryDimension && f.primaryDimension !== label)) continue;
      const i = findings.indexOf(f);
      if (retained.has(i)) continue;
      retained.add(i);
      deductions.push(d);
      evidence.push({ f, points: Number(d.points) });
    }
    const score = EN2CN_MAX[label] - deductions.reduce((n, d) => n + Number(d.points), 0);
    const changed = score !== Number(row.score) || deductions.length !== row.deductions.length;
    const comment = changed ? evidence.length
      ? evidence.map(({ f, points }) => `「${f.from}」：${f.explanation || f.category}（扣${points}分）`).join('；')
      : '未发现本项需要扣分的独立错误；可选表达建议不扣分，同一信息错误不重复计分。'
      : row.comment;
    rebuilt.push({ ...row, score, deductions, comment });
  }
  const candidate = { ...overall, scoreBreakdown: rebuilt, score: rebuilt.reduce((n, r) => n + r.score, 0), scoringVersion: 'en2cn-evidence-v2' };
  return en2cnScoreProblems({ ...data, overall: candidate }).length ? overall : candidate;
}

export const EN2CN_SCORE_EVIDENCE_RULES = `
【英译汉扣分账本，必须输出】
每条 error finding 新增 sourceQuote（英文原文中逐字存在、精确对应本条错误的短片段）和 primaryDimension（理解准确/表达地道/语体得当/流畅度/完整性之一）。improve/study 不扣分。
误译、数字、专名误读归理解准确；真正未表达的信息或无依据新增归完整性。已表达但译错不是漏译。表达地道/语体得当/流畅度只记录独立存在的中文语言错误，不能因同一事实错误再次扣分。
先完成 sentences，再输出 overall，避免先评分后凑错误。overall.scoreBreakdown 每一项新增 deductions 数组，每条为 {"sourceQuote":"对应finding的英文原文引用","from":"对应finding的初稿片段","points":2}，sourceQuote/from 必须逐字照抄所对应的 error finding 字段，不用易错的数组编号作为唯一依据。
英译汉的满分权重为理解准确40、表达地道15、语体得当10、流畅度10、完整性25，总计100。信息准确和完整共占65分，避免严重误译只扣20分而其余通顺就获得高分。没有真实错误的分项 deductions=[]、得该项满分，只有可选建议时不得凭感觉扣分。
扣分严重程度结合影响范围判断，不按错误数量机械计分；同一条 finding、同一处原文信息只能归一个分项且扣一次，合并重复错误。每项 score=max-本项扣分合计，总分为五项之和。
完整性依据全文缺失的信息占比及重要性判断；漏掉一个普通分句不能视为大部分全文缺失，不得为把总分压进某档而把大部分完整性分扣在一个局部漏译上。对照全文中已准确保留的事实，按实际影响范围分配扣分。
中文可用被字句、合理指代、省略可推知主语、拆分或合并句子；句号改分号、不是改并非、同义词替换等正常异译属于可选建议。除非有独立语义/语体错误，不得扣分。`;
