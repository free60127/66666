import { createEvidenceScoring, normalizeEvidenceOverall } from './scoringEvidence.mjs';

export const CN2EN_DIMENSIONS = ['词汇准确', '语法与时态', '语境与逻辑', '流畅度', '地道程度'];
export const CN2EN_MAX = { 词汇准确: 20, 语法与时态: 25, 语境与逻辑: 35, 流畅度: 10, 地道程度: 10 };
const scoring = createEvidenceScoring({ dimensions: CN2EN_DIMENSIONS, maxima: CN2EN_MAX, version: 'cn2en-evidence-v1',
  extraProblem(_data, f, _deduction, label) {
    return /逻辑|语境|增译|漏译|事实|信息范围/.test(f.category || '') && label !== '语境与逻辑'
      ? ['事实、范围或逻辑错误应归语境与逻辑'] : [];
  },
});
export const normalizeCn2enOverall = normalizeEvidenceOverall;
export const reconcileCn2enOverall = scoring.reconcile;
export function cn2enScoreProblems(data) {
  const references = (data.sentences || []).flatMap((s) => s.findings || []).some((f) => !String(data.draft || '').includes(f.from));
  return [...scoring.problems(data), ...(references ? ['逐句条目引用了初稿中不存在的片段'] : [])];
}

export const CN2EN_SCORE_EVIDENCE_RULES = `
【汉译英扣分账本，必须输出】
先完成逐句检查，再评 overall。每条 error 必须有 sourceQuote（中文原文逐字片段）、primaryDimension（词汇准确/语法与时态/语境与逻辑/流畅度/地道程度之一）、severity（minor/major/critical）。from 必须逐字存在于学生初稿，包括 improve/study；不得用AI新写的句子冒充学生片段。漏译用相邻真实初稿定位并注明 operation="insert"，新增事实以相邻原文定位。
权重：词汇准确20、语法与时态25、语境与逻辑35、流畅度10、地道程度10，共100。逻辑关系、原文事实、否定条件、证据强度、漏增信息均归语境与逻辑；拼写/词义归词汇，形态与句法归语法。无依据加入international/factory/economic等限制改变信息范围，category为语境/增译，primaryDimension必须是语境与逻辑，不因错误由一个词造成就归词汇准确。每个真实错误只归一个主维度；不同条目即使引文嵌套也可能是独立错误，只有确实相同的根因才合并。不得因事实错误再扣语法/流畅/地道。
每项 scoreBreakdown 输出 deductions 数组，每条 {"sourceQuote":"对应error的原文引用","from":"对应error的初稿引用","points":2}。没有真实错误 deductions=[]、该项满分，improve/study 不扣分。不得为简单句、常见准确词、合法被动/并列句、没有习语或更贴近AI稿而扣分；等级影响讲解和学习素材，不影响忠实自然译文的得分。
minor 为细节/局部形态错误，每条1–3分；major 为重要事实或影响理解的语法错误，每条4–8分；critical 为关键否定/因果/必要条件/结论反转、大面积漏译或使句子主干无法成立的严重结构错误，每条至少10分，通常10–18。依具体语境判断，不能看到某个词就定为严重。每条error均须有扣分，不为配合总分档位改严重性。
每项 score=max(0,max-本项扣分合计)，扣分累计超过该项满分时该项记0，不再跨维度重复扣；总分为五项之和。先核对学生全文，避免遗漏相邻句已经表达的信息。存在critical时在总评指出需修正的核心含义，数值只作学习参考。
所有 explanation、ai 与学习例句都必须遵守原文，不把“应该”升级成“迫切必须”，不擅加可持续、全面、迅速等限定。错误处给最小必要修改；存在联动、倒装或逻辑重构时，修正必须写成能直接代入原句的完整替代句（写在to里），不用框架占位符。`;
