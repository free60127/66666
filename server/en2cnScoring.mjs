import { createEvidenceScoring, dedupeExactErrors, normalizeEvidenceOverall } from './scoringEvidence.mjs';
export const EN2CN_DIMENSIONS = ['理解准确', '表达地道', '语体得当', '流畅度', '完整性'];
export const EN2CN_MAX = { 理解准确: 40, 表达地道: 15, 语体得当: 10, 流畅度: 10, 完整性: 25 };
const scoring = createEvidenceScoring({ dimensions: EN2CN_DIMENSIONS, maxima: EN2CN_MAX, version: 'en2cn-evidence-v4',
  extraProblem(data, f, d, label) {
    const problems = [];
    if (/误译|数字|专名/.test(f.category || '') && label !== '理解准确') problems.push('事实误译应归理解准确');
    if (/漏译|增译/.test(f.category || '') && label !== '完整性') problems.push('信息缺失或新增应归完整性');
    const words = (s) => (String(s || '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
    if (label === '完整性' && Number(d.points) > 8 && words(data.chinese) > 0 && words(f.sourceQuote || d.sourceQuote) / words(data.chinese) < 1 / 3) {
      problems.push('局部漏增译完整性扣分超过8分：请按全文影响范围复核，不能把其他误译再次算作缺失');
    }
    return problems;
  },
});
export const normalizeEn2cnOverall = normalizeEvidenceOverall;
export const en2cnScoreProblems = scoring.problems;
export const reconcileEn2cnOverall = scoring.reconcile;
export function dedupeEn2cnFindings(data) { return data?.direction === 'en2cn' ? dedupeExactErrors(data) : data; }

export const EN2CN_SCORE_EVIDENCE_RULES = `
【英译汉扣分账本，必须输出】
每条 error finding 新增 severity（minor/major/critical：细节、重要、关键反转或严重结构错误）、sourceQuote（英文原文中逐字存在、精确对应本条错误的短片段）和 primaryDimension（理解准确/表达地道/语体得当/流畅度/完整性之一）。improve/study 不扣分。
误译、数字、专名误读归理解准确；真正未表达的信息或无依据新增归完整性。已表达但译错不是漏译。表达地道/语体得当/流畅度只记录独立存在的中文语言错误，不能因同一事实错误再次扣分。
先完成 sentences，再输出 overall，避免先评分后凑错误。overall.scoreBreakdown 每一项新增 deductions 数组，每条为 {"sourceQuote":"对应finding的英文原文引用","from":"对应finding的初稿片段","points":2}，sourceQuote/from 必须逐字照抄所对应的 error finding 字段，不用易错的数组编号作为唯一依据。
英译汉的满分权重为理解准确40、表达地道15、语体得当10、流畅度10、完整性25，总计100。信息准确和完整共占65分，避免严重误译只扣20分而其余通顺就获得高分。没有真实错误的分项 deductions=[]、得该项满分，只有可选建议时不得凭感觉扣分。
扣分严重程度结合影响范围判断，不按错误数量机械计分；同一条 finding、同一处原文信息只能归一个分项且扣一次，合并重复错误。引文嵌套不等于重复：必要条件、情态、否定等不同根因必须各自保留；真正同一根因才合并。每项 score=max(0,max-本项扣分合计)，总分为五项之和。
理解准确的单条扣分按"读者会得出什么相反结论"分级，不把所有误译按相近分值处理：minor：个别词的搭配或轻重偏差、不改变句子命题的细节失真扣1–3分；major：数字、时间、地点、指代错位等重要事实错误扣4–8分；critical：否定、因果、条件、建议或结论与原文方向相反（立场/语义反转，如把不建议译成建议、把必要条件译成充分条件、把未证实译成已证实）每处至少10分、通常12–18分；多处方向性反转或全篇主旨误读可在40分预算内继续叠加。不得以"影响范围有限"为由把立场反转压成局部小错；影响范围用于完整性分配，不用于降低方向性错误的定性。
全部错误均保留独立扣分依据；合计超过该项满分时该项记0，不降低严重性来凑预算；不能负分，也不能为了压低总分把理解错误改作表达、语体、流畅度或完整性再扣一次。逐句只有理解准确error时，其余四项不得另造整句扣分；完整性必须引用独立的漏译/增译finding，不能拿误译整句充当遗漏。返回前重新求和，不照抄旧分数。
英译汉以本扣分账本及独立维度规则为准，不为符合通用总分分档而编造额外扣分。理解准确严重失分时，总评必须明确指出核心信息失真；存在方向性反转扣分时，总评开头就应点明"关键立场/事实译反、需重译相关句"，不得只给温和措辞；总分仍是五项相加的学习参考，不用总分达到60来宣称及格或已准确完成翻译任务。
完整性依据全文缺失的信息占比及重要性判断；漏掉一个普通分句不能视为大部分全文缺失，不得为把总分压进某档而把大部分完整性分扣在一个局部漏译上。对照全文中已准确保留的事实，按实际影响范围分配扣分。
局部漏译或无依据增译（对应原文不足全文三分之一）单条完整性扣分不得超过8分，通常1–3分为局部细节、4–6分为重要信息、7–8分为严重局部影响；这是复核上限，不是每条默认扣8分。大范围缺失可更高，但 sourceQuote 必须完整覆盖缺失的原文范围，不能拿一个词当成整段缺失的证据。已表达但译反的事实只能算理解错误，不得在完整性点评中再次宣称这些内容“漏掉了”。
中文可用被字句、合理指代、省略可推知主语、拆分或合并句子；句号改分号、不是改并非、同义词替换等正常异译属于可选建议。除非有独立语义/语体错误，不得扣分。`;
