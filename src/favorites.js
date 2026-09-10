/**
 * 收藏夹：把作业里的知识点（错题/辨析、核心词、习语）存到本机 localStorage，
 * 之后不用打开整份作业就能快速复习。无需数据库；支持导出/导入 JSON 备份。
 */

export const FAV_KEY = 'bt-favorites';
export const FAV_MAX = 2000;
export const FAV_KIND_LABEL = { finding: '错题/辨析', vocab: '核心词', idiom: '习语' };

function store() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadFavorites() {
  const s = store();
  if (!s) return [];
  try {
    const arr = JSON.parse(s.getItem(FAV_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((x) => x && x.id && x.title) : [];
  } catch { return []; }
}

export function saveFavorites(arr) {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(FAV_KEY, JSON.stringify((Array.isArray(arr) ? arr : []).slice(0, FAV_MAX)));
    return true;
  } catch { return false; }
}

export function favKey(parts) {
  return (Array.isArray(parts) ? parts : [parts])
    .filter(Boolean)
    .join('|')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function synWords(synonyms) {
  return (Array.isArray(synonyms) ? synonyms : [])
    .map((x) => (typeof x === 'string' ? x : x && x.word))
    .filter(Boolean);
}
function exLines(examples, keyA = 'en', keyB = 'example') {
  return (Array.isArray(examples) ? examples : [])
    .map((x) => x && (x[keyA] || x[keyB]))
    .filter(Boolean);
}
function wrapPhonetic(p) {
  const v = String(p || '').trim();
  if (!v) return '';
  return v.startsWith('/') ? v : '/' + v + '/';
}

/** 词根词缀拆解 → 一行文本（morphology 可能是对象，也可能是模型直接给的字符串） */
export function morphologyText(m) {
  if (!m) return '';
  if (typeof m === 'string') return m.trim();
  return [
    m.parts ? '拆解：' + m.parts : '',
    m.image ? '记忆画面：' + m.image : '',
    m.family ? '同根词：' + m.family : '',
  ].filter(Boolean).join('；');
}

/** 判断一个 vocabularyNote 是否真的有可展示的词根词缀内容 */
export function hasMorphology(m) {
  if (!m) return false;
  if (typeof m === 'string') return Boolean(m.trim());
  return Boolean((m.parts && String(m.parts).trim()) || (m.image && String(m.image).trim()) || (m.family && String(m.family).trim()));
}

export function favFromFinding(finding, result) {
  const f = finding || {};
  const syns = synWords(f.synonyms);
  const exs = exLines(f.examples);
  return {
    id: favKey(['finding', result && result.title, f.category, f.from, f.to]),
    kind: 'finding',
    title: (f.from ? f.from + ' → ' + f.to : f.to) || f.category || '知识点',
    category: f.category || '',
    level: f.level || '',
    body: f.explanation || '',
    extra: [
      Array.isArray(f.dimensions) && f.dimensions.length ? '维度：' + f.dimensions.join('、') : '',
      f.idiom ? '习语：' + f.idiom : '',
      syns.length ? '近义词：' + syns.join('、') : '',
      exs.length ? '例句：' + exs.join(' / ') : '',
    ].filter(Boolean).join('\n'),
    source: (result && result.title) || '',
    sourceLevel: (result && result.aiLevel) || '',
  };
}

export function favFromVocab(v, result) {
  const word = (v && v.word) || '';
  return {
    id: favKey(['vocab', result && result.title, word]),
    kind: 'vocab',
    title: word + (v && v.phonetic ? '  ' + wrapPhonetic(v.phonetic) : ''),
    category: (v && v.type) || '词汇',
    level: '',
    body: [v && v.meaning, v && v.note].filter(Boolean).join('\n'),
    extra: [
      Array.isArray(v && v.dimensions) && v.dimensions.length ? '维度：' + v.dimensions.join('、') : '',
      hasMorphology(v && v.morphology) ? '词根词缀：' + morphologyText(v.morphology) : '',
      synWords(v && v.synonyms).length ? '近义词：' + synWords(v && v.synonyms).join('、') : '',
      exLines(v && v.examples).length ? '例句：' + exLines(v && v.examples).join(' / ') : '',
    ].filter(Boolean).join('\n'),
    source: (result && result.title) || '',
    sourceLevel: (result && result.aiLevel) || '',
  };
}

export function favFromIdiom(it, result) {
  const x = it || {};
  return {
    id: favKey(['idiom', result && result.title, x.idiom]),
    kind: 'idiom',
    title: x.idiom || '习语',
    category: '习语',
    level: '',
    body: [x.common ? '普通说法：' + x.common : '', x.explanation].filter(Boolean).join('\n'),
    extra: [
      x.example ? '例句：' + x.example : '',
      x.situation ? '场景：' + x.situation : '',
    ].filter(Boolean).join('\n'),
    source: (result && result.title) || '',
    sourceLevel: (result && result.aiLevel) || '',
  };
}

/** 收藏夹弹窗的筛选：按类型 + 关键词（标题/正文/补充/分类/来源） */
export function filterFavorites(list, { kind = 'all', query = '' } = {}) {
  const arr = Array.isArray(list) ? list : [];
  const q = String(query || '').trim().toLowerCase();
  return arr.filter((x) => {
    if (!x) return false;
    if (kind !== 'all' && x.kind !== kind) return false;
    if (!q) return true;
    return [x.title, x.body, x.extra, x.category, x.source]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q);
  });
}

/** 合并导入的收藏（按 id 去重，新的在前） */
export function mergeFavorites(incoming, current) {
  const cur = Array.isArray(current) ? current : [];
  const add = (Array.isArray(incoming) ? incoming : []).filter((x) => x && x.id && x.title);
  const fresh = add.filter((x) => !cur.some((y) => y.id === x.id));
  return { merged: [...fresh, ...cur], added: fresh.length };
}

/** 把收藏导出为纯文本（用于「复制全部」） */
export function favoritesToText(list) {
  return (Array.isArray(list) ? list : []).map((x, i) => [
    (i + 1) + '. [' + (FAV_KIND_LABEL[x.kind] || x.kind) + (x.category ? ' / ' + x.category : '') + '] ' + x.title,
    x.body || '',
    x.extra || '',
    x.source ? '（来自：' + x.source + '）' : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}
