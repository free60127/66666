/**
 * 流式分段 → "部分结果"的折叠（浏览器侧）。
 *
 * 与 server/analyzeStream.mjs 的 foldSegments **同构**：字段搬运规则必须一致，
 * 否则会出现"边生成边看到的"和最后存下来的不是一个东西。
 * 两边各留一份是刻意的 —— 服务端那份要跟着 sanitizeOverall / sanitizeSentences 走，
 * 这份只负责让结果页尽早画出来；test/resultFold.test.mjs 里有交叉断言钉住"两边结果一致"。
 *
 * 只做字段搬运，**不做质量收敛**（收敛统一由服务端负责，最终结果由 done 事件覆盖）。
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
