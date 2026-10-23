import { hasWritingBrief, normalizeWritingBrief } from './writingGuidance.js';
import { questionWordTarget } from './writingTask.js';

/** Shared writing draft identity and text helpers. Existing single-draft storage is retained. */
export const WRITING_STORE_KEY = 'bt-writing-studio';
export const WRITING_DRAFT_PREFIX = 'bt-writing-draft:';
const CURRENT_KEY = 'bt-writing-current';

const hashText = (value) => {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
};

export function writingTopicKey(topic) {
  if (!topic || typeof topic.question !== 'string' || !topic.question.trim()) return 'writing';
  if (topic.classId && topic.hwId) return 'writing:assigned:' + encodeURIComponent(topic.classId) + ':' + encodeURIComponent(topic.hwId);
  // Old assignments have no trustworthy homework ID. Keep them separate from new assignments.
  if (topic.id === 'assigned') return 'writing:legacy-assigned-' + hashText(topic.question.trim());
  if (typeof topic.draftKey === 'string' && topic.draftKey.startsWith('writing:')) return topic.draftKey;
  if (typeof topic.id === 'string' && /^[\w-]+$/.test(topic.id) && topic.id !== 'custom') return 'writing:' + topic.id;
  return 'writing:custom-' + hashText(topic.question.trim());
}

export const countWritingWords = (text) => (String(text || '').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
export const writingMaterial = (topic) => topic?.material || topic?.excerpt || '';
export const writingTargetWords = (topic, level) => topic?.words || questionWordTarget(topic?.question) || ({ 小初: 80, 高考英语: 120, 四六级: 180, '考研/专四': 220, 专八: 300 }[level] || 180);
export const writingSourceKey = (topic) => topic?.sourceTopicKey || writingTopicKey(topic);

export function revisionTopic(result, jobId) {
  const source = result.writingTopic || {};
  return { ...source, classId: undefined, hwId: undefined, id: 'custom',
    draftKey: 'writing:revision-' + (jobId || Date.now()),
    sourceTopicKey: source.sourceTopicKey || result.lessonKey || writingTopicKey({ ...source, question: result.chinese }),
    parentJobId: jobId || '', rootJobId: source.rootJobId || jobId || '',
    question: result.chinese, material: result.material || '', imageDesc: result.imageDesc || '',
    zh: result.workTitle || result.title || '作文修改', label: '历史作文修改', words: result.targetWords || source.words || null };
}

export function splitWritingParagraphs(text) {
  const paragraphs = String(text || '').split(/\n\s*\n/);
  return [paragraphs[0] || '', paragraphs[1] || '', paragraphs[2] || '', paragraphs.slice(3).join('\n\n')];
}

export function normalizeWritingDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawTopic = value.topic;
  const topic = rawTopic && typeof rawTopic.question === 'string' && rawTopic.question.trim()
    ? { ...Object.fromEntries(['id', 'draftKey', 'sourceTopicKey', 'parentJobId', 'rootJobId', 'taskType', 'classId', 'hwId', 'exam', 'label', 'zh', 'topic', 'level', 'qtype', 'question', 'material', 'excerpt', 'image', 'imageDesc']
      .filter((key) => typeof rawTopic[key] === 'string').map((key) => [key, rawTopic[key]])),
      words: Number.isFinite(Number(rawTopic.words)) && Number(rawTopic.words) > 0 ? Number(rawTopic.words) : null } : null;
  const brief = normalizeWritingBrief(value.brief);
  return {
    topic,
    mode: value.mode === 'guided' ? 'guided' : 'direct',
    essay: typeof value.essay === 'string' ? value.essay : '',
    segs: Array.isArray(value.segs) && value.segs.length === 4 ? value.segs.map((s) => typeof s === 'string' ? s : '') : ['', '', '', ''],
    savedAt: Number.isFinite(Number(value.savedAt)) ? Number(value.savedAt) : 0,
    brief: hasWritingBrief(brief) ? brief : null,
    angle: typeof value.angle === 'string' ? value.angle.slice(0, 400) : '',
    briefOpen: typeof value.briefOpen === 'boolean' ? value.briefOpen : value.mode === 'guided',
    workTitle: typeof value.workTitle === 'string' ? value.workTitle : topic?.zh || '',
    writer: typeof value.writer === 'string' ? value.writer : '',
    clock: value.clock && typeof value.clock === 'object' && !Array.isArray(value.clock)
      ? Object.fromEntries(Object.entries(value.clock).filter(([k, n]) => /^[a-zA-Z0-9-]+$/.test(k) && Number.isSafeInteger(n) && n > 0)) : {},
  };
}

const read = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const newerFirst = (a, b) => b.savedAt - a.savedAt || b.writer.localeCompare(a.writer);
export const newWritingWriter = () => globalThis.crypto.randomUUID();
export const writingDraftFingerprint = (draft) => {
  const clean = normalizeWritingDraft(draft);
  if (!clean) return '';
  delete clean.savedAt; delete clean.writer; delete clean.clock;
  return JSON.stringify(clean);
};

/** One independent slot per topic and editing session. A tab never overwrites another tab's slot.
 * Vector revisions distinguish a normal continuation from concurrent edits, without relying on clocks.
 * Unchanged pages do not write on pagehide. Old storage remains readable for lossless migration. */
export function listWritingDrafts() {
  try {
    const legacy = read(WRITING_STORE_KEY);
    const old = Object.values(legacy?.drafts || {}).concat(legacy || []).map(normalizeWritingDraft).filter((v) => v?.topic);
    const records = Object.keys(localStorage).filter((key) => key.startsWith(WRITING_DRAFT_PREFIX))
      .map((key) => normalizeWritingDraft(read(key))).filter((v) => v?.topic && v.writer && v.clock[v.writer]);
    const groups = new Map();
    for (const row of old.sort(newerFirst)) {
      const key = writingTopicKey(row.topic);
      if (!groups.has(key)) groups.set(key, [row]);
    }
    for (const key of new Set(records.map((r) => writingTopicKey(r.topic)))) {
      const rows = records.filter((r) => writingTopicKey(r.topic) === key);
      groups.set(key, rows.filter((r) => !rows.some((other) => other !== r
        && Object.entries(r.clock).every(([writer, seq]) => (other.clock[writer] || 0) >= seq))).sort(newerFirst));
    }
    return [...groups.values()].flat().sort(newerFirst);
  } catch { return []; }
}

export function writingDraftVersions(key) { return listWritingDrafts().filter((r) => writingTopicKey(r.topic) === key); }

export function loadWritingState(key) {
  try {
    let tabCurrent;
    try { tabCurrent = JSON.parse(sessionStorage.getItem(CURRENT_KEY) || 'null'); } catch { /* use durable fallback */ }
    const target = key || (tabCurrent?.owner === (localStorage.getItem('bt-data-owner') || '') ? tabCurrent.key : null) || read(CURRENT_KEY)?.key;
    const drafts = target ? writingDraftVersions(target) : [];
    if (drafts.length) return drafts[0];
    if (key) return null;
    const legacy = normalizeWritingDraft(read(WRITING_STORE_KEY));
    return (legacy?.topic ? legacy : null) || listWritingDrafts()[0] || null;
  } catch { return null; }
}

export function rememberWritingTopic(topic) {
  const key = writingTopicKey(topic);
  localStorage.setItem(CURRENT_KEY, JSON.stringify({ key }));
  // Reloading tab A must reopen A even if tab B saved most recently.
  try { sessionStorage.setItem(CURRENT_KEY, JSON.stringify({ key, owner: localStorage.getItem('bt-data-owner') || '' })); } catch { /* localStorage remains usable */ }
}

export function saveWritingDraft(snapshot, base, writer = newWritingWriter()) {
  const clean = normalizeWritingDraft(snapshot);
  if (!clean?.topic) return null;
  if (base && writingDraftFingerprint(clean) === writingDraftFingerprint(base)) return base;
  const key = WRITING_DRAFT_PREFIX + encodeURIComponent(writingTopicKey(clean.topic)) + ':' + writer;
  const previous = normalizeWritingDraft(read(key));
  const clock = { ...(base?.clock || {}), [writer]: Math.max(base?.clock?.[writer] || 0, previous?.clock?.[writer] || 0) + 1 };
  const saved = { ...clean, writer, clock, savedAt: Date.now() };
  localStorage.setItem(key, JSON.stringify(saved));
  rememberWritingTopic(clean.topic);
  return saved;
}

export function exportWritingDrafts() {
  window.dispatchEvent(new Event('bts:flush-writing'));
  const detail = { drafts: [] };
  window.dispatchEvent(new CustomEvent('bts:collect-writing-drafts', { detail }));
  const drafts = listWritingDrafts();
  for (const current of detail.drafts) {
    const clean = normalizeWritingDraft(current);
    if (clean?.topic && !drafts.some((row) => writingDraftFingerprint(row) === writingDraftFingerprint(clean))) drafts.push(clean);
  }
  return drafts;
}

export function importWritingDrafts(values) {
  if (!Array.isArray(values)) return 0;
  let count = 0;
  for (const value of values) {
    const clean = normalizeWritingDraft(value);
    if (!clean?.topic) continue;
    const same = writingDraftVersions(writingTopicKey(clean.topic)).some((row) => writingDraftFingerprint(row) === writingDraftFingerprint(clean));
    if (same) continue;
    // Imports are independent copies: a backup must not silently replace newer local text.
    saveWritingDraft(clean, null);
    count += 1;
  }
  window.dispatchEvent(new Event('bts:writing-drafts-changed'));
  return count;
}
