/* ---------- 结果数据归一化（前端兜底）----------
 * 服务端已经清洗过一次；这里再兜一次是因为分享链接与本机缓存里可能存着历史脏数据，
 * 而 ResultSheet 会直接索引 sentences[i].findings / notes[i].word —— 脏元素会让整棵树崩掉。
 *
 * 从 App.jsx 挪出来：生成链路（hooks/useGeneration.js）与它之外的调用点都要用同一份。 */
export function asObjectArray(value) {
  return (Array.isArray(value) ? value : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
}

/**
 * from 与 to 实质相同的条目 = 噪音（模型偶尔会为凑数产出「went → went」）。
 * 与 server/resultShape.mjs 的 sameExpression 保持同一规则：**只归一化空白** ——
 * 大小写、标点、冠词等差异都是真实可批改的点，归一化掉会把有效条目误删。
 */
function sameExpression(a, b) {
  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const x = norm(a);
  return x !== '' && x === norm(b);
}

function isNoopFinding(f) {
  if (!f || typeof f !== 'object') return true;
  const from = String(f.from == null ? '' : f.from).trim();
  const to = String(f.to == null ? '' : f.to).trim();
  if (!from || !to) return true;
  return sameExpression(from, to);
}

export function normalizeResult(data) {
  if (!data || typeof data !== 'object') return null;
  const overall = data.overall && typeof data.overall === 'object' && !Array.isArray(data.overall) ? data.overall : {};
  const sentences = asObjectArray(data.sentences).map((s) => ({
    ...s,
    // 过滤「went → went」这类无意义对照：**新结果在服务端已过滤**，这里是为了
    // 清理**已经存下来的旧结果**（本机缓存 / 历史 / 分享链接）—— 用户不用重新生成。
    findings: asObjectArray(s.findings)
      .filter((f) => !isNoopFinding(f))
      .map((f) => ({
        ...f,
        dimensions: Array.isArray(f.dimensions) ? f.dimensions.filter((x) => typeof x === 'string') : [],
        synonyms: Array.isArray(f.synonyms) ? f.synonyms.filter((x) => x != null) : [],
      })),
  }));
  // 过滤后重算"问题总数"：overall.issues 的口径就是"错误+改进点+学习点的总数"，
  // 不重算的话会出现"标题写 13 处、下面只列出 12 条"的不一致（用户会怀疑漏了内容）。
  const issuesTotal = sentences.reduce((n, s) => n + (s.findings ? s.findings.length : 0), 0);

  return {
    ...data,
    overall: {
      ...overall,
      scoreBreakdown: asObjectArray(overall.scoreBreakdown),
      issues: sentences.length ? issuesTotal : overall.issues,
    },
    sentences,
    vocabularyNotes: asObjectArray(data.vocabularyNotes),
    idiomHighlights: asObjectArray(data.idiomHighlights),
  };
}
