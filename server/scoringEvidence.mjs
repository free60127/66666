/** Shared accounting only. Semantic judgments belong to the direction-specific review. */
export const EVIDENCE_POLICY = 'translation-evidence-20261011';
export const SEVERITY_MIN = { minor: 1, major: 4, critical: 10 };

export function normalizeEvidenceOverall(raw) {
  const overall = raw?.overall && typeof raw.overall === 'object' ? raw.overall : raw || {};
  const rows = overall.scoreBreakdown;
  return { ...overall, scoreBreakdown: rows && !Array.isArray(rows) && typeof rows === 'object'
    ? Object.entries(rows).map(([label, row]) => ({ ...(row && typeof row === 'object' ? row : { score: row }), label })) : rows };
}

/** Span nesting is not proof that two errors have the same cause. */
export function sameError(a, b) {
  return a?.level === 'error' && b?.level === 'error' &&
    ['sourceQuote', 'from', 'to', 'primaryDimension', 'severity'].every((key) => a[key] === b[key]) &&
    Boolean(a.sourceQuote && a.from && a.to && a.primaryDimension);
}

export function dedupeExactErrors(data) {
  const retained = [];
  let dropped = 0;
  const sentences = (data.sentences || []).map((s) => ({ ...s, findings: (s.findings || []).filter((f) => {
    if (retained.some((g) => sameError(f, g))) { dropped++; return false; }
    retained.push(f); return true;
  }) }));
  return dropped ? { ...data, sentences } : data;
}

function resolveFinding(findings, d) {
  const exact = findings.filter((f) => d.sourceQuote && f.sourceQuote === d.sourceQuote && (!d.from || f.from === d.from));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  // A stale citation must never select an unrelated error by its old array index.
  if (d.sourceQuote && findings.some((f) => f.sourceQuote)) return null;
  const index = Number(d.findingIndex);
  const byIndex = Number.isInteger(index) && index > 0 ? findings[index - 1] : null;
  if (byIndex && (!d.from || d.from === byIndex.from)) return byIndex;
  const byDraft = findings.filter((f) => !f.sourceQuote && d.from && f.from === d.from);
  return byDraft.length === 1 ? byDraft[0] : null;
}

export function createEvidenceScoring({ dimensions, maxima, version, extraProblem }) {
  function problems(data) {
    const overall = data?.overall || {};
    const rows = overall.scoreBreakdown;
    const findings = (data?.sentences || []).flatMap((s) => s.findings || []);
    if (!Array.isArray(rows) || rows.length !== dimensions.length || new Set(rows.map((r) => r?.label)).size !== dimensions.length) return ['缺少五项独立评分'];
    const errors = [];
    const used = new Set();
    const chargedFindings = [];
    let total = 0;
    for (const label of dimensions) {
      const row = rows.find((r) => r?.label === label);
      if (!row || !Array.isArray(row.deductions)) { errors.push(label + '缺少扣分依据'); continue; }
      let points = 0;
      for (const d of row.deductions) {
        if (!d || typeof d !== 'object') { errors.push('扣分依据格式无效'); continue; }
        const f = resolveFinding(findings, d);
        const amount = Number(d.points);
        if (!f || f.level !== 'error' || !Number.isInteger(amount) || amount < 1 || amount > maxima[label]) {
          errors.push(label + '引用了非错误或无效扣分'); continue;
        }
        const index = findings.indexOf(f);
        const source = f.sourceQuote || d.sourceQuote;
        if ((d.sourceQuote && f.sourceQuote && d.sourceQuote !== f.sourceQuote) || (d.from && d.from !== f.from)) errors.push('扣分引用与逐句分析不符');
        if (!f.from || !String(data.draft || '').includes(f.from) || !source || !String(data.chinese || '').includes(source)) errors.push('扣分片段不能在原文和初稿中核验');
        if (f.primaryDimension && f.primaryDimension !== label) errors.push('扣分维度与错误归因不符');
        if (used.has(index) || chargedFindings.some((prior) => sameError(prior, f))) errors.push('同一信息重复扣分');
        chargedFindings.push(f);
        if (data.gradingPolicyVersion === EVIDENCE_POLICY && (!dimensions.includes(f.primaryDimension) || !Object.hasOwn(SEVERITY_MIN, f.severity))) errors.push('错误缺少维度或严重性');
        if (Object.hasOwn(SEVERITY_MIN, f.severity) && amount < SEVERITY_MIN[f.severity]) errors.push('扣分低于错误严重性下限');
        if (f.severity === 'minor' && amount > 3) errors.push('细节错误扣分超过3分');
        if (f.severity === 'major' && amount > 8) errors.push('重要错误扣分超过8分');
        const extra = extraProblem?.(data, f, d, label);
        if (extra) errors.push(...extra);
        used.add(index); points += amount;
      }
      const score = Number(row.score);
      if (Number(row.max) !== maxima[label] || !Number.isInteger(score) || score !== Math.max(0, maxima[label] - points)) errors.push(label + '分数与依据不一致');
      total += score;
    }
    for (const [i, f] of findings.entries()) if (f.level === 'error' && !used.has(i)) errors.push('真实错误未体现于扣分依据');
    if (Number(overall.score) !== total) errors.push('总分与分项不一致');
    return [...new Set(errors)];
  }

  function reconcile(data) {
    const overall = normalizeEvidenceOverall(data?.overall);
    const rows = overall.scoreBreakdown;
    const findings = (data?.sentences || []).flatMap((s) => s.findings || []);
    if (!Array.isArray(rows) || rows.length !== dimensions.length) return overall;
    const retained = new Set();
    const rebuilt = [];
    for (const label of dimensions) {
      const row = rows.find((r) => r?.label === label);
      if (!row || Number(row.max) !== maxima[label] || !Array.isArray(row.deductions)) return overall;
      const deductions = [];
      for (const d of row.deductions) {
        if (!d || typeof d !== 'object') return overall;
        const f = resolveFinding(findings, d);
        if (!f) return overall; // Unknown/wide spans need review; never silently erase them.
        if (f.level !== 'error' || (f.primaryDimension && f.primaryDimension !== label)) continue;
        const index = findings.indexOf(f);
        if (retained.has(index)) continue;
        retained.add(index);
        deductions.push({ ...d, sourceQuote: f.sourceQuote || d.sourceQuote, from: f.from });
      }
      const score = Math.max(0, maxima[label] - deductions.reduce((n, d) => n + Number(d.points), 0));
      const comment = deductions.length
        ? deductions.map((d) => `「${String(d.from).slice(0, 80)}」（扣${d.points}分）`).join('；') + (score === 0 ? '；本项扣分以满分为上限。' : '')
        : '未检出本项独立错误；可选润色与学习点不扣分。';
      rebuilt.push({ ...row, score, deductions, comment });
    }
    const criticalErrors = findings.filter((f) => f.level === 'error' && f.severity === 'critical').length;
    const candidate = { ...overall, scoreBreakdown: rebuilt, score: rebuilt.reduce((n, r) => n + r.score, 0), scoringVersion: version,
      issues: findings.length, taskAssessment: criticalErrors ? { status: 'needs-revision', criticalErrors, message: '存在关键含义或结构错误，请先修正相关句。总分不代表翻译任务已准确完成。' } : null };
    return problems({ ...data, overall: candidate }).length ? overall : candidate;
  }
  return { problems, reconcile };
}
