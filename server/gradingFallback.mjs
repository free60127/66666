/** Findings alone cannot justify a numeric grade: style suggestions are not deductions. */
export function localOverall(data) {
  const findings = (data.sentences || []).flatMap((s) => Array.isArray(s?.findings) ? s.findings.filter((f) => f && typeof f === 'object') : []);
  const count = (level) => findings.filter((f) => f.level === level).length;
  const categories = new Map();
  for (const f of findings.filter((f) => f.level === 'error')) categories.set(f.category || '其它', (categories.get(f.category || '其它') || 0) + 1);
  const top = [...categories].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return { local: true, score: null, issues: findings.length, scoreBreakdown: [], highlights: [],
    summary: `本次评分暂不可用，已保留逐句批改。必改 ${count('error')} 处、可选提升 ${count('improve')} 处、对照学习 ${count('study')} 处。改进建议数量不代表应扣分数。`,
    advice: top.length ? top.map(([category]) => `优先核对「${category}」类问题，先修正影响含义的错漏。`) : ['先核对译文是否准确、完整；可选润色可按需采纳。'] };
}
