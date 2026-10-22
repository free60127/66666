/** The server and editor share the same bounded writing-guide shape. Old guides remain readable. */
export const WRITING_PARAGRAPH_KEYS = ['intro', 'body1', 'body2', 'concl'];

const text = (value, max = 800) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const strings = (value, max, length = 800) => Array.isArray(value)
  ? [...new Set(value.map((item) => text(item, length)).filter(Boolean))].slice(0, max) : [];

export function normalizeWritingBrief(value, requestedAngle = '') {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const outline = Array.isArray(data.outline) ? data.outline.slice(0, 4).map((item) => text(item)) : [];
  const source = Array.isArray(data.paragraphs) ? data.paragraphs : [];
  const paragraphs = WRITING_PARAGRAPH_KEYS.map((key, i) => {
    const item = source.find((p) => p?.key === key) || (source[i]?.key ? null : source[i]);
    const goal = text(item?.goal) || outline[i] || '';
    const steps = (Array.isArray(item?.steps) ? item.steps : []).slice(0, 4).map((step) => ({
      idea: text(step?.idea, 600),
      keywords: strings(step?.keywords, 6, 80),
      pattern: text(step?.pattern, 1200),
    })).filter((step) => step.idea || step.pattern);
    if (!steps.length && goal) steps.push({ idea: goal, keywords: [], pattern: '' });
    return { key, goal, steps };
  });
  const selectedAngle = text(requestedAngle, 400) || text(data.selectedAngle, 400);
  return {
    stance: text(data.stance, 1800),
    selectedAngle,
    angles: strings([selectedAngle, ...strings(data.angles, 4, 400)], 5, 400),
    outline: paragraphs.map((p) => p.goal),
    paragraphs,
    pitfalls: strings(data.pitfalls, 6),
    patterns: strings(data.patterns, 8, 1200),
  };
}

export function hasWritingBrief(value) {
  return !!(value?.stance || value?.paragraphs?.some((p) => p.goal || p.steps?.length));
}
