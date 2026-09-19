/**
 * DOCX 作业文本解析 + 导入内容判定。
 *
 * 从 App.jsx 拆出来的原因：旧解析器只会"找到第一段英文当初稿"，遇到
 * 「中文 + 标准答案」「原文 + 初稿两段英文」这类常见文档就会静默出错
 * （初稿和原文填成同一段，批改失去意义）。这里升级为：
 *   1) 按语言切成"中文块 / 英文段"并保留全部英文段（不再只取第一段）；
 *   2) 标记词（原文 / 参考译文 / 初稿 / 标准答案 …）会给紧随其后的英文段打上角色标签；
 *   3) textSimilarity 判断导入的英文与课文标准答案是否基本一致——
 *      一致则说明用户导的是参考译文而非初稿，由上层引导用户选择处理方式。
 * 纯函数、无副作用，test/docxParse.test.mjs 覆盖。
 */

export function isMarker(line) {
  return /^(标题|中文|中文译文|译文|原稿|初稿|英文初稿|学生译本|参考译文|参考答案|标准答案|英文原文|AI\s*(润色|修正)|原文|原版|逐句|详细错误|分析|translation|reference|chinese|english)\s*[:：]?$/i.test(String(line || '').trim());
}

export function isMostlyEnglish(line) {
  const words = (String(line || '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []);
  const letters = words.join('').length;
  const han = (String(line || '').match(/[\u4e00-\u9fff]/g) || []).length;
  // 短句也要能识别：至少 2 个英文单词、字母数 >=3，且英文显著多于中文
  return words.length >= 2 && letters >= 3 && letters > han * 2;
}

/**
 * 把 DOCX 提取出的纯文本解析为 { title, chinese, blocks }。
 * blocks = 按出现顺序的英文段落（**每个英文段落独立成块**——"原文+初稿"连排的文档
 * 必须能被拆开，角色才有的分配），段前若有标记词（原文 / 初稿 / 参考译文…），记为 block.label。
 * 中文行（无论出现在英文前还是后）统一归入 chinese。
 * 不再对"缺中文/缺英文"抛错——由调用方结合练习方向决定怎么提示。
 */
export function parseDocxText(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
  if (!lines.length) throw new Error('DOCX 内容为空');
  const title = lines[0];
  const chineseLines = [];
  const blocks = [];
  let pendingLabel = '';
  for (const line of lines.slice(1)) {
    if (isMarker(line)) {
      pendingLabel = line.replace(/\s*[:：]\s*$/, '').trim();
      continue;
    }
    if (isMostlyEnglish(line)) {
      const label = pendingLabel;
      pendingLabel = '';
      blocks.push({ text: line, label });
      continue;
    }
    pendingLabel = '';
    chineseLines.push(line);
  }
  return { title, chinese: chineseLines.join('\n').trim(), blocks };
}

/**
 * 归一化 token Dice 相似度（0—1）。中英文混排都适用：
 * 英文按单词、中文按字符二元组取 token；相同文本 = 1，无关文本趋近 0。
 * 用于判断"导入的英文是否其实是标准答案"。
 */
export function textSimilarity(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
  const tokens = (s) => {
    const set = new Set();
    for (const w of s.split(' ')) if (w) set.add(w);
    const cjk = s.replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    for (let i = 0; i < cjk.length - 1; i++) set.add(cjk.slice(i, i + 2));
    return set;
  };
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = tokens(x);
  const B = tokens(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/** 判定"导入的英文其实是标准答案"的相似度阈值（85%，容忍个别排版差异） */
export const REFERENCE_SIM_THRESHOLD = 0.85;
