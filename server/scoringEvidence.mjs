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


/** 不参与重复传播的超常用词：它们多义、上下文敏感，换处出现多半是另一回事。 */
const REPEAT_STOPWORDS = new Set(('the a an is are was were be been am to of in on at for and or but i you he she it we they me him her us them my your his its our their this that these those there here as so if then than not no nor do does did done have has had having must can could will would shall should may might said says say get got go went come came make made take took see saw know knew think think said').split(' '));

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 重复出现兜底：某个 1–2 词的 error 根在后续句群的 draft 里逐字再现、而该句群没有
 *  涉及它的 finding 时，补一条同根 finding（说明简化为"同第N处"）。只传播短片段
 *  与非超常用词，避免把上下文敏感词误伤到别的语境。纯确定性，模型漏检的最后防线。 */
export function propagateRepeats(data) {
  if (!data || !Array.isArray(data?.sentences)) return data;
  const roots = [];
  for (const s of data.sentences) {
    for (const f of (s.findings || [])) {
      if (!f || f.level !== 'error' || !f.from || !f.to) continue;
      const from = String(f.from).trim();
      if (!from || from.length > 24 || from.split(/\s+/).length > 2) continue;
      if (REPEAT_STOPWORDS.has(from.toLowerCase())) continue;
      roots.push({ f, from });
    }
  }
  if (!roots.length) return data;
  let added = 0;
  const sentences = data.sentences.map((s) => {
    let findings = Array.isArray(s.findings) ? [...s.findings] : [];
    const draft = String(s.draft || '');
    for (const [i, root] of roots.entries()) {
      const re = new RegExp('(^|[^A-Za-z0-9])' + escapeRe(root.from) + '($|[^A-Za-z0-9])', 'i');
      const m = draft.match(re);
      if (!m) continue;
      const exists = findings.some((g) => g && ((g.from || '').includes(root.from) || (g.to || '').includes(root.from)));
      if (exists) continue;
      added++;
      findings.push({ ...root.f, from: root.from, to: root.f.to,
        explanation: `同第${i + 1}处（重复出现）：${root.from} 应为 ${root.f.to}。${String(root.f.explanation || '').slice(0, 80)}` });
    }
    return { ...s, findings };
  });
  if (!added) return data;
  console.warn(`[analyze] 重复出现兜底：补 ${added} 条同根 finding（模型漏检的后续出现）`);
  return { ...data, sentences };
}
