import { dedupeExactErrors } from './scoringEvidence.mjs';

export const EN2CN_DIMENSIONS = ['理解准确', '表达地道', '语体得当', '流畅度', '完整性'];
export const EN2CN_MAX = { 理解准确: 40, 表达地道: 15, 语体得当: 10, 流畅度: 10, 完整性: 25 };

export function normalizeEn2cnOverall(raw) {
  const overall = raw?.overall && typeof raw.overall === 'object' ? raw.overall : raw || {};
  const rows = overall.scoreBreakdown;
  return { ...overall, scoreBreakdown: rows && !Array.isArray(rows) && typeof rows === 'object'
    ? Object.entries(rows).map(([label, row]) => ({ ...(row && typeof row === 'object' ? row : { score: row }), label })) : rows };
}

/** 合并完全相同的重复条目；嵌套引文是否同根因交由语义复核判定。 */
export function dedupeEn2cnFindings(data) { return data?.direction === 'en2cn' ? dedupeExactErrors(data) : data; }

/** 英译汉评分校准指南（原扣分账本的校准内核；账本机制已于 2026-10-12 移除）。 */
export const EN2CN_SCORING_GUIDE = `
【英译汉评分权重与校准】
每条 error finding 附 sourceQuote（英文原文中逐字存在、精确对应本条错误的短片段）和 primaryDimension（理解准确/表达地道/语体得当/流畅度/完整性之一）。improve/study 是可选建议，不扣分。
英译汉满分权重为理解准确40、表达地道15、语体得当10、流畅度10、完整性25，总计100，分项之和必须等于总分。信息准确和完整共占65分，严重误译不得因其余通顺而获得高分。
误译、数字、专名误读归理解准确；真正未表达的信息或无依据新增归完整性，已表达但译错不是漏译。表达地道/语体得当/流畅度只记录独立存在的中文语言错误，同一事实错误不跨维度重复扣分；不因简单句、常见词、被字句、合理省略或与参考译文措辞不同而扣分。
扣分轻重按"读者会得出什么相反结论"判断，不按错误数量机械计分：个别词的搭配或轻重偏差等细节失真，单项小幅扣分；数字、时间、地点、指代错位等重要事实错误，中等扣分；否定、因果、条件、建议或结论与原文方向相反（立场/语义反转，如把不建议译成建议、把必要条件译成充分条件、把未证实译成已证实）必须重扣，不得以"影响范围有限"降级。多处方向性反转或全篇主旨误读应把理解准确分压到低分段。
不能为了压低总分把理解错误改作表达、语体、流畅度或完整性再扣一次；同一处原文信息只能扣一次。完整性依据全文缺失信息的占比与重要性分配：局部漏译通常小扣，大范围缺失才大扣；已表达但译反的事实不得在完整性中再次宣称"漏掉了"。
理解准确严重失分时，总评必须明确指出核心信息失真；存在立场/语义反转时，总评开头就点明"关键立场/事实译反、需重译相关句"，不得只给温和措辞。总分是五项相加的学习参考，不用总分达到60来宣称及格或已准确完成翻译任务。返回前重新求和，不照抄旧分数。`;
