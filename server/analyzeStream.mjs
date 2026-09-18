/**
 * 回译作业解析的**流式协议**与解析（服务端）。
 *
 * 一次作业解析的返回是一个很大的嵌套 JSON（overall + 逐句 sentences + 词汇 + 习语 + 句式…），
 * 全写完要 30–120 秒 —— 学生盯着一个转圈等一分钟，这是这个应用最难受的一分钟。
 * 所以约定模型**一行一个 JSON 对象**（NDJSON），一段一段往外送：
 *
 *   {"t":"meta","title":"…","chinese":"…","draft":"…","original":"…"}
 *   {"t":"ai","ai":"整体润色后的段落"}
 *   {"t":"overall","overall":{…与一次性 JSON 里的 overall 完全同构…}}
 *   {"t":"sentence","item":{…一句一个对象，字段与 sentences[] 的元素完全一致…}}
 *   {"t":"vocab","item":{…}}      {"t":"idiom","item":{…}}
 *   {"t":"advanced","item":"…"}   {"t":"bonus","item":"…"}
 *   {"t":"done"}
 *
 * 行切分与容错在 server/ndjson.mjs；这里只管"哪些段合法、怎么折成一份结果"。
 * 字段搬运规则必须与浏览器侧 src/resultFold.js **完全一致** ——
 * 否则会出现"边生成边看到的"和最后存下来的不是一个东西（test/resultFold.test.mjs 交叉钉住）。
 */
import { createNdjsonReader } from './ndjson.mjs';

/** 合法的段类型 → 前端进度条上显示的名字 */
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
const TYPES = new Set(Object.keys(SEGMENT_LABEL));

/** 逐块喂数据 → 新完成的段（已按 index 落位，重复到达的段覆盖旧的，不会长出两份） */
export function createResultReader() {
  let index = 0;
  return createNdjsonReader({
    onObject: (obj) => {
      if (!obj || typeof obj.t !== 'string' || !TYPES.has(obj.t)) return null;
      const seg = { ...obj, __i: index };
      index += 1;
      return seg;
    },
  });
}

/**
 * 把段折成一份（可能不完整的）结果对象 —— 与 src/resultFold.js 同构。
 * 只做字段搬运，**不做质量收敛**（收敛统一交给 sanitizeOverall / sanitizeSentences）。
 */
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
    switch (seg.t) {
      case 'meta':
        for (const k of ['title', 'chinese', 'draft', 'original']) {
          if (typeof seg[k] === 'string' && seg[k] !== '') out[k] = seg[k];
        }
        break;
      case 'ai':
        if (typeof seg.ai === 'string') out.ai = seg.ai;
        break;
      case 'overall':
        if (seg.overall && typeof seg.overall === 'object' && !Array.isArray(seg.overall)) out.overall = seg.overall;
        break;
      case 'sentence':
        if (seg.item && typeof seg.item === 'object' && !Array.isArray(seg.item)) out.sentences.push(seg.item);
        break;
      case 'vocab':
        if (seg.item && typeof seg.item === 'object' && !Array.isArray(seg.item)) out.vocabularyNotes.push(seg.item);
        break;
      case 'idiom':
        if (seg.item && typeof seg.item === 'object' && !Array.isArray(seg.item)) out.idiomHighlights.push(seg.item);
        break;
      case 'advanced':
        if (typeof seg.item === 'string' && seg.item.trim()) out.advancedSentences.push(seg.item);
        break;
      case 'bonus':
        if (typeof seg.item === 'string' && seg.item.trim()) out.bonusExpressions.push(seg.item);
        break;
      default:
        break;   // done 与认不出的段：忽略（后端以后加段类型也不会炸老前端）
    }
  }
  return out;
}

/**
 * 收尾：决定这次解析的**最终内容**。
 *
 * 优先用流式收到的段（"看到的"就是"存下来的"）；一段都没认出来时
 * （模型没按一行一段来），退回把全文当整段 JSON 解析 —— 与出题/批改同一个兜底。
 *
 * @returns {{parsed: object|null, mode: 'stream'|'fallback'|'empty'}}
 */
export function finalizeResult({ segments, rawText, parseLoose }) {
  const folded = foldSegments(segments);
  // "有效"的判据：至少有一句逐句解析，或有整体评价 —— 只有 meta 回显不算结果
  if (folded.sentences.length || folded.overall) return { parsed: folded, mode: 'stream' };
  let parsed = null;
  try { parsed = parseLoose ? parseLoose(rawText) : null; } catch { parsed = null; }
  if (parsed && typeof parsed === 'object') return { parsed, mode: 'fallback' };
  return { parsed: null, mode: 'empty' };
}
