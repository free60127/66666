/**
 * 批改的**流式协议**与解析（服务端）。
 *
 * 一次批改的返回是一个 grades 数组，数组要等到 `]` 打完才能 parse —— 那跟一次性返回没区别。
 * 所以约定模型**一行一道题**（NDJSON），收满一行就把这一道题的判定贴到界面上：
 *
 *   {"index":0,"verdict":"close","comment":"desperately 是副词…","better":"…"}
 *   {"index":1,"verdict":"right","comment":"…","better":""}
 *
 * 行切分与容错在 server/ndjson.mjs（与作业解析共用同一份）；这里只管
 * "哪些行算判定、题号越界怎么办、同一题号重复了听谁的"。
 * 与姊妹项目「单词本」的 server/stream.mjs 同构（那边一行一段词条）。
 *
 * 硬规则：**同一 index 先到先得**（与一次性解析的 sanitizeGrades 一致），越界 index 丢掉 ——
 * 宁可少一道题的点评，也不能把点评贴到别的题上。
 */
import { createNdjsonReader } from './ndjson.mjs';
import { sanitizeGrades } from './questionShape.mjs';

/**
 * 逐块喂数据，吐出**新完成的判定**（已按 sanitizeGrades 的规则清洗过）。
 *
 * @param {object} o
 * @param {number} o.itemCount 这一批一共几道题（题号 0..itemCount-1，越界即丢）
 */
export function createGradeReader({ itemCount = 0 } = {}) {
  const seen = new Set();
  const local = { dup: 0, outOfRange: 0 };
  const reader = createNdjsonReader({
    onObject: (obj) => {
      // 用与一次性解析**同一个**清洗函数：verdict 只留三档、题号越界丢掉、长文本截断
      const one = sanitizeGrades({ grades: [obj] }, itemCount)[0];
      if (!one) {
        const i = Number(obj && obj.index);
        if (Number.isInteger(i) && (i < 0 || i >= itemCount)) local.outOfRange += 1;
        return null;
      }
      if (seen.has(one.index)) { local.dup += 1; return null; }
      seen.add(one.index);
      return one;
    },
  });

  // 行数/坏行来自通用解析器，重复与越界是批改特有的 —— 用取值器拼成一个 stats，不会各写一份计数
  const stats = {
    get lines() { return reader.stats.lines; },
    get bad() { return reader.stats.bad; },
    get dup() { return local.dup; },
    get outOfRange() { return local.outOfRange; },
  };

  return {
    stats,
    feed: reader.feed,
    flush: reader.flush,
    get leftover() { return reader.leftover; },
    get indexes() { return [...seen]; },
  };
}

/**
 * 收尾：决定这次批改的**最终结果**。
 *
 * 优先用流式收到的那些判定（"看到的"就是"存下来的"）；一行都没解析出来时
 * （模型没按一行一道题来），退回把全文当 JSON 解析 —— 与出题那条链路同一个兜底。
 *
 * @returns {{grades: Array<object>, mode: 'stream'|'fallback'|'empty'}}
 */
export function finalizeGrades({ grades, rawText, parseLoose, itemCount }) {
  const streamed = sanitizeGrades({ grades: Array.isArray(grades) ? grades : [] }, itemCount);
  if (streamed.length) return { grades: streamed, mode: 'stream' };
  let parsed = null;
  try { parsed = parseLoose ? parseLoose(rawText) : null; } catch { parsed = null; }
  const fallback = sanitizeGrades(parsed, itemCount);
  return { grades: fallback, mode: fallback.length ? 'fallback' : 'empty' };
}
