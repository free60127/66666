/**
 * 流式分段 → "部分结果"的折叠。
 *
 * **服务端与浏览器共用这一份**（server/analyzeStream.mjs 直接 import 它）：
 * 折叠规则一旦有两份实现就会漂移，而漂移的表现是"边生成边看到的"和"存进历史的"
 * 不是同一个东西 —— 那种不一致只有用户回头看历史时才会发现。
 * 这里只依赖标准 JS，两端都能跑（服务端再套一层 sanitizeOverall / sanitizeSentences 做质量收敛）。
 *
 * ⚠️ 对形状**必须宽容**（线上实测）：真模型不总是照着示例写 ——
 * 它会把 overall 的字段平铺在段上（`{"t":"overall","score":86,…}`）而不是包一层 `overall`，
 * 会写成 `{"t":"vocab","word":"pub",…}` 而不是包一层 `item`，偶尔还会漏掉 `t`。
 * 只要按字段能认出来就照样收下 —— 否则综合评分/练习建议/词汇/习语会**整块消失**，
 * 而界面上只表现为"这一块没生成"，用户根本不知道是格式没对上。
 */
export const SEGMENT_TYPES = ['meta', 'ai', 'overall', 'sentence', 'vocab', 'idiom', 'advanced', 'bonus', 'done'];
const TYPES = SEGMENT_TYPES;
const OVERALL_KEYS = ['score', 'scoreBreakdown', 'issues', 'summary', 'highlights', 'advice'];
const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k];
  return out;
};
const omitMeta = (o) => {
  const out = { ...o };
  delete out.t; delete out.__i; delete out.item;
  return out;
};
/** 这个字段算不算"有内容"（收尾合并时判空用） */
export const hasContent = (v) => (Array.isArray(v) ? v.length > 0 : (v && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v)));

/** 认不出 t 时按字段猜段类型；返回空串表示"不是段"（整段 JSON 或垃圾行） */
function guessType(o) {
  // 一整份完整结果（不是分段）：交给收尾的"整段 JSON 兜底"处理，别当成某一段
  if (Array.isArray(o.sentences) || (o.overall && typeof o.overall === 'object')) return '';
  if (o.cn || Array.isArray(o.findings)) return 'sentence';
  if (o.word) return 'vocab';
  if (o.idiom && (o.common || o.situation || o.example || o.explanation)) return 'idiom';
  if (OVERALL_KEYS.some((k) => o[k] !== undefined)) return 'overall';
  if (typeof o.ai === 'string' && o.ai) return 'ai';
  if (o.title || o.chinese || o.draft || o.original) return 'meta';
  if (typeof o.text === 'string' && o.text) return 'advanced';
  if (typeof o.value === 'string' && o.value) return 'advanced';
  return '';
}

/**
 * 把一段（可能是走形写法）归一成标准形状：
 *   { t:'overall', overall:{…} } / { t:'sentence', item:{…} } / { t:'ai', ai:'…' } …
 * 认不出来返回 null（调用方计入 bad）。
 */
export function normalizeSegment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = TYPES.includes(raw.t) ? raw.t : guessType(raw);
  if (!t) return null;
  if (t === 'done') return { t: 'done' };
  if (t === 'meta') {
    const meta = pick(raw, ['title', 'chinese', 'draft', 'original']);
    return Object.keys(meta).length ? { t: 'meta', ...meta } : null;
  }
  if (t === 'ai') {
    const text = typeof raw.ai === 'string' && raw.ai ? raw.ai : (typeof raw.text === 'string' ? raw.text : '');
    return text ? { t: 'ai', ai: text } : null;
  }
  if (t === 'overall') {
    const nested = raw.overall && typeof raw.overall === 'object' && !Array.isArray(raw.overall) ? raw.overall : null;
    const overall = nested || pick(raw, OVERALL_KEYS);
    return Object.keys(overall).length ? { t: 'overall', overall } : null;
  }
  if (t === 'sentence' || t === 'vocab' || t === 'idiom') {
    const nested = raw.item && typeof raw.item === 'object' && !Array.isArray(raw.item) ? raw.item : null;
    const item = nested || omitMeta(raw);
    const ok = t === 'sentence'
      ? (item.cn || item.draft || item.ai || (Array.isArray(item.findings) && item.findings.length))
      : (t === 'vocab' ? item.word : item.idiom);
    return ok ? { t, item } : null;
  }
  // advanced / bonus：元素是**字符串**
  const s = typeof raw.item === 'string' ? raw.item
    : (typeof raw.text === 'string' ? raw.text : (typeof raw.value === 'string' ? raw.value : (typeof raw.content === 'string' ? raw.content : '')));
  return String(s).trim() ? { t, item: s } : null;
}

export function foldSegments(segments) {
  const out = { sentences: [], vocabularyNotes: [], idiomHighlights: [], advancedSentences: [], bonusExpressions: [] };
  const sorted = (Array.isArray(segments) ? segments : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (Number(a.__i) || 0) - (Number(b.__i) || 0));
  // 同一序号只认第一条：断线重连时服务端会重放，直接 push 会折出重复的句子
  const seen = new Set();
  const list = [];
  for (const seg of sorted) {
    const i = Number(seg.__i);
    if (Number.isFinite(i)) {
      if (seen.has(i)) continue;
      seen.add(i);
    }
    list.push(seg);
  }
  for (const seg of list) {
    const s = normalizeSegment(seg);
    if (!s) continue;
    switch (s.t) {
      case 'meta':
        for (const k of ['title', 'chinese', 'draft', 'original']) {
          if (typeof s[k] === 'string' && s[k] !== '') out[k] = s[k];
        }
        break;
      case 'ai': out.ai = s.ai; break;
      case 'overall': out.overall = s.overall; break;
      case 'sentence': out.sentences.push(s.item); break;
      case 'vocab': out.vocabularyNotes.push(s.item); break;
      case 'idiom': out.idiomHighlights.push(s.item); break;
      case 'advanced': out.advancedSentences.push(s.item); break;
      case 'bonus': out.bonusExpressions.push(s.item); break;
      default: break;   // done：忽略
    }
  }
  return out;
}

/** 段类型 → 进度文案（结果页顶部那行"正在生成：逐句解析 3"） */
export const SEGMENT_LABEL = {
  meta: '标题与原文',
  ai: '整体润色',
  overall: '整体评价',
  sentence: '逐句解析',
  vocab: '词汇深度辨析',
  idiom: '地道习语',
  advanced: '高级句式',
  bonus: '加分表达',
  done: '完成',
};
