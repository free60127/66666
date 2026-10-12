/** Shared result-shape helpers only. Scoring gates were removed on 2026-10-12:
 *  real models could not reliably fill deduction ledgers, which made "评分暂不可用"
 *  the norm instead of the exception. Semantic judgments belong to the reviews. */

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
