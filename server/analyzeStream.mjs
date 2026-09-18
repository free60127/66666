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
 *   {"t":"sentence","item":{…一句一个对象…}}   {"t":"vocab","item":{…}}   {"t":"idiom","item":{…}}
 *   {"t":"advanced","item":"…"}   {"t":"bonus","item":"…"}   {"t":"done"}
 *
 * 行切分与容错在 server/ndjson.mjs；**段形状的归一与折叠直接复用浏览器侧那一份**
 * （src/resultFold.js）—— 两端共用同一个函数，就不会出现"边生成边看到的"和
 * 最后存下来的不是同一个东西。这里只补服务端特有的两件事：
 *   1) createResultReader：把模型输出的行变成段（宽容走形写法，见 normalizeSegment）；
 *   2) finalizeResult：收尾时用整段 JSON 再兜一次底，把流式期间没拿到的块补齐。
 */
import { createNdjsonReader } from './ndjson.mjs';
import { SEGMENT_TYPES, SEGMENT_LABEL, foldSegments, normalizeSegment, hasContent } from '../src/resultFold.js';

export { SEGMENT_LABEL, foldSegments, normalizeSegment };

const TYPES = new Set(SEGMENT_TYPES);

/**
 * 逐块喂数据 → 新完成的段（按 index 落位，重复到达的段不会长出两份）。
 * 段形状在这里就归一：真模型会把 overall 平铺、把 vocab 写成不带 item 的样子、
 * 偶尔漏掉 t —— 归一之后下游（折叠 / 落库）只面对一种形状。
 */
/** 这一段是不是"标准形状"（漏 t / 平铺 / 少一层容器都算走形） */
function shapeOk(obj) {
  const t = obj.t;
  if (t === 'overall') return Boolean(obj.overall && typeof obj.overall === 'object' && !Array.isArray(obj.overall));
  if (t === 'sentence' || t === 'vocab' || t === 'idiom') return Boolean(obj.item && typeof obj.item === 'object' && !Array.isArray(obj.item));
  if (t === 'advanced' || t === 'bonus') return typeof obj.item === 'string';
  if (t === 'ai') return typeof obj.ai === 'string';
  if (t === 'meta') return typeof obj.title === 'string' || typeof obj.chinese === 'string' || typeof obj.draft === 'string';
  return false;   // 认不出的 t 也算走形（其实已经被 guessType 拦下）
}

export function createResultReader() {
  let index = 0;
  const stats = { seg: 0, repaired: 0 };
  const reader = createNdjsonReader({
    onObject: (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      const canonical = normalizeSegment(obj);
      if (!canonical) return null;
      // 「走形」计数：漏 t、平铺 overall、item 没包起来、advanced 写成 text…都算。
      // 长期偏高说明提示词要再收（或该换模型），但内容一条都不会丢。
      if (!shapeOk(obj)) stats.repaired += 1;
      stats.seg += 1;
      const seg = { ...canonical, __i: index };
      index += 1;
      return seg;
    },
  });
  return {
    stats: {
      get lines() { return reader.stats.lines; },
      get bad() { return reader.stats.bad; },
      get seg() { return stats.seg; },
      get repaired() { return stats.repaired; },
    },
    feed: reader.feed,
    flush: reader.flush,
    get leftover() { return reader.leftover; },
  };
}

/**
 * 收尾：决定这次解析的**最终内容**。
 *
 * 以流式收到的段为准（"看到的"就是"存下来的"）；然后把整段文本再当 JSON 解析一次，
 * 只为**补空**（流式期间漏掉的 overall / 词汇 / 习语等）—— 真模型偶尔会把
 * 一部分内容按"一行一段"写、另一部分又整体输出一遍，这里两边都不浪费。
 *
 * @returns {{parsed: object|null, mode: 'stream'|'fallback'|'empty'}}
 */
export function finalizeResult({ segments, rawText, parseLoose }) {
  const folded = foldSegments(segments);
  const streamedOk = hasContent(folded.sentences) || hasContent(folded.overall);
  let whole = null;
  try { whole = parseLoose ? parseLoose(rawText) : null; } catch { whole = null; }
  if (!whole || typeof whole !== 'object') return streamedOk ? { parsed: folded, mode: 'stream' } : { parsed: null, mode: 'empty' };
  if (!streamedOk) return { parsed: whole, mode: 'fallback' };
  const merged = { ...folded };
  for (const k of ['title', 'chinese', 'draft', 'original', 'ai', 'overall', 'sentences', 'vocabularyNotes', 'idiomHighlights', 'advancedSentences', 'bonusExpressions']) {
    if (!hasContent(merged[k]) && hasContent(whole[k])) merged[k] = whole[k];
  }
  return { parsed: merged, mode: 'stream' };
}

export { TYPES };
