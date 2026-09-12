/* ---------- 结果数据归一化（前端兜底）----------
 * 服务端已经清洗过一次；这里再兜一次是因为分享链接与本机缓存里可能存着历史脏数据，
 * 而 ResultSheet 会直接索引 sentences[i].findings / notes[i].word —— 脏元素会让整棵树崩掉。
 *
 * 从 App.jsx 挪出来：生成链路（hooks/useGeneration.js）与它之外的调用点都要用同一份。 */
export function asObjectArray(value) {
  return (Array.isArray(value) ? value : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
}

export function normalizeResult(data) {
  if (!data || typeof data !== 'object') return null;
  const overall = data.overall && typeof data.overall === 'object' && !Array.isArray(data.overall) ? data.overall : {};
  return {
    ...data,
    overall: { ...overall, scoreBreakdown: asObjectArray(overall.scoreBreakdown) },
    sentences: asObjectArray(data.sentences).map((s) => ({
      ...s,
      findings: asObjectArray(s.findings).map((f) => ({
        ...f,
        dimensions: Array.isArray(f.dimensions) ? f.dimensions.filter((x) => typeof x === 'string') : [],
        synonyms: Array.isArray(f.synonyms) ? f.synonyms.filter((x) => x != null) : [],
      })),
    })),
    vocabularyNotes: asObjectArray(data.vocabularyNotes),
    idiomHighlights: asObjectArray(data.idiomHighlights),
  };
}
