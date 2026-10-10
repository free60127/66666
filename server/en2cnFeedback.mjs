/** Preserve logic boundaries and distinguish insertion anchors from replacement text. */
export function normalizeEn2cnFeedback(data) {
  if (data?.direction !== 'en2cn') return data;
  return { ...data, sentences: (data.sentences || []).map((sentence) => ({ ...sentence,
    findings: (sentence.findings || []).map((finding) => {
      let f = { ...finding };
      // Narrow, evidenced case: not all -> none. Do not rewrite unrelated findings
      // merely because their source sentence happens to contain a negation.
      if (f.level === 'error' && /^not all\b/i.test(String(f.sourceQuote || '').trim()) &&
          /都不|全部不|全都不|一个都不/.test(f.from || '') && /并非|不全|不是所有|不是全部/.test(f.to || '') &&
          String(data.chinese || '').includes(f.sourceQuote)) {
        f.explanation = `原文“${f.sourceQuote}”中的 not all 表示“并非全部”，只能保证至少有一个不是，不能据此断言“有些是、有些不是”。译稿“${f.from}”强化成了全部否定；虽然全部不是与原文不矛盾，但原文没有断言这个更强的结论，应恢复原文的否定范围。`;
        f.synonyms = []; f.examples = []; delete f.idiom;
      }
      if (f.level === 'error' && f.category === '漏译' && f.from && f.to &&
          String(data.draft || '').includes(f.from) && !f.to.includes(f.from)) {
        // The cited draft fragment locates the omission; it is not text to delete.
        f = { ...f, operation: 'insert' };
      }
      return f;
    }),
  })) };
}
