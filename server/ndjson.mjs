/**
 * NDJSON（一行一个 JSON 对象）解析 —— 流式生成的通用底座。
 *
 * 为什么不是"流式吐 JSON"：一次生成的返回是一个大 JSON（数组/嵌套对象），
 * 非要等最后一个括号打完才能 parse —— 那跟一次性返回没有区别。
 * 所以约定模型**一行一个 JSON 对象**，收一行就能往外送一块内容。
 *
 * 三条硬规则（各调用方的解析器据此容错）：
 *   1. 只处理**完整行**（以换行结束）—— 残行留在缓冲里等下一块数据，天然容忍任意截断；
 *   2. 认不出的行（围栏 ```、说明文字、坏 JSON）**直接跳过**并计数，绝不抛错；
 *   3. 认不认这一行、以及同一份内容重复到达怎么办，由调用方在 `onObject` 里决定
 *      （批改是"同题号先到先得"，逐句解析是"每种段落各自去重"）。
 *
 * 两个调用方：server/gradeStream.mjs（一行一道题的判定）、
 * server/analyzeStream.mjs（一行一段作业解析）。
 */
export function createNdjsonReader({ onObject } = {}) {
  let buffer = '';
  const stats = { lines: 0, bad: 0 };

  const parseLine = (line) => {
    const s = String(line == null ? '' : line).trim();
    if (!s) return null;
    // 模型偶尔会加围栏、或来一句"好的，下面开始：" —— 一律跳过
    if (s.startsWith('```') || s.startsWith('//') || s.startsWith('#')) { stats.bad += 1; return null; }
    if (!s.startsWith('{')) { stats.bad += 1; return null; }
    let obj;
    try { obj = JSON.parse(s); } catch { stats.bad += 1; return null; }
    const accepted = onObject ? onObject(obj) : obj;
    if (accepted === null || accepted === undefined) { stats.bad += 1; return null; }
    stats.lines += 1;
    return accepted;
  };

  return {
    stats,
    /** 逐块喂数据 → 本次**新完成**的对象数组 */
    feed(chunk) {
      buffer += String(chunk == null ? '' : chunk);
      const out = [];
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const obj = parseLine(line);
        if (obj) out.push(obj);
        idx = buffer.indexOf('\n');
      }
      return out;
    },
    /** 收尾：把缓冲里的残行也算上（模型最后一行常常没有换行） */
    flush() {
      const rest = buffer;
      buffer = '';
      const obj = parseLine(rest);
      return obj ? [obj] : [];
    },
    get leftover() { return buffer; },
  };
}
