/** Language belongs to each learning item, not to the current editor mode. */
export function textLanguage(text) {
  const s = String(text || '');
  const zh = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const en = (s.match(/[A-Za-z]+/g) || []).length;
  return zh > en ? 'zh' : 'en';
}

export function answerLanguage(item) {
  if (item?.answerLanguage === 'zh' || item?.answerLanguage === 'en') return item.answerLanguage;
  return textLanguage(item?.answer);
}

/** Accept existing string cards and structured cards without rewriting saved favorites. */
export function expressionParts(item, direction) {
  if (item && typeof item === 'object') {
    return {
      source: String(item.source || item.en || ''),
      translation: String(item.translation || item.cn || ''),
      explanation: String(item.explanation || item.tip || ''),
    };
  }
  const raw = String(item || '').trim();
  const [head, ...tips] = raw.split(/[·•]\s*中文(?:点拨|说明|说拨)\s*[:：]?\s*/);
  if (direction === 'en2cn' || (head.includes('→') && textLanguage(head.split('→')[0]) === 'en')) {
    const arrow = head.indexOf('→');
    if (arrow >= 0) {
      const source = head.slice(0, arrow).trim();
      const rest = head.slice(arrow + 1).trim();
      const pieces = rest.split(/\s*→\s*|[：:]\s*/);
      return { source, translation: pieces.shift()?.trim() || '', explanation: [...pieces, ...tips].join('：').trim() };
    }
    return { source: '', translation: head.trim(), explanation: tips.join(' · ').trim() };
  }
  return { source: head.trim(), translation: '', explanation: tips.join(' · ').trim() };
}
