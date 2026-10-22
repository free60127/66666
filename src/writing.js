import { hasWritingBrief, normalizeWritingBrief } from './writingGuidance.js';

/** Shared writing draft identity and text helpers. Existing single-draft storage is retained. */
export const WRITING_STORE_KEY = 'bt-writing-studio';

export function writingTopicKey(topic) {
  if (!topic || typeof topic.question !== 'string' || !topic.question.trim()) return 'writing';
  if (typeof topic.id === 'string' && /^[\w-]+$/.test(topic.id) && topic.id !== 'custom') return 'writing:' + topic.id;
  let hash = 2166136261;
  for (const char of topic.question.trim()) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return 'writing:custom-' + (hash >>> 0).toString(36);
}

export const countWritingWords = (text) => (String(text || '').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
export const writingMaterial = (topic) => topic?.material || topic?.excerpt || '';
export const writingTargetWords = (topic, level) => topic?.words || ({ 小初: 80, 高考英语: 120, 四六级: 180, '考研/专四': 220, 专八: 300 }[level] || 180);

export function splitWritingParagraphs(text) {
  const paragraphs = String(text || '').split(/\n\s*\n/);
  return [paragraphs[0] || '', paragraphs[1] || '', paragraphs[2] || '', paragraphs.slice(3).join('\n\n')];
}

export function loadWritingState() {
  try {
    const value = JSON.parse(localStorage.getItem(WRITING_STORE_KEY) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const topic = value.topic && typeof value.topic.question === 'string' && value.topic.question.trim() ? value.topic : null;
    const brief = normalizeWritingBrief(value.brief);
    return {
      topic,
      mode: value.mode === 'guided' ? 'guided' : 'direct',
      essay: typeof value.essay === 'string' ? value.essay : '',
      segs: Array.isArray(value.segs) && value.segs.length === 4 ? value.segs.map((s) => typeof s === 'string' ? s : '') : ['', '', '', ''],
      savedAt: Number(value.savedAt) || 0,
      brief: hasWritingBrief(brief) ? brief : null,
      angle: typeof value.angle === 'string' ? value.angle.slice(0, 400) : '',
      briefOpen: typeof value.briefOpen === 'boolean' ? value.briefOpen : value.mode === 'guided',
      drafts: value.drafts && typeof value.drafts === 'object' && !Array.isArray(value.drafts) ? value.drafts : {},
    };
  } catch { return null; }
}
