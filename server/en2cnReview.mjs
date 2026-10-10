import { EN2CN_DIMENSIONS, EN2CN_SCORE_EVIDENCE_RULES, normalizeEn2cnOverall } from './en2cnScoring.mjs';
import { EN2CN_TRANSFER_RULES } from './en2cnPrinciples.mjs';

export function needsEn2cnReview(data) {
  const risk = /\b(?:not|no|none|neither|unless|only|less|fewer|percent|percentage|might|may|could|would|had|without|rather|except)\b|\d/i;
  const source = String(data?.chinese || '');
  // Route structural/stance risks even when the first pass reports no errors.
  const structure = /\b(?:who|whom|whose|which|after|before|until|despite|though|although|suggest\w*|indicat\w*|demonstrat\w*|prov\w*|designed|intended|requires?)\b|\b(?:has|have)\s+(?:\w+\s+)?made\b|\b(?:was|were|is|are|been)\s+(?:\w+\s+)?\w+(?:ed|en)\b|(?:[.!?]\s+)(?:This|These|That|It|They)\b/i;
  const longSentence = source.split(/[.!?]/).some((s) => (s.match(/\b[A-Za-z]+\b/g) || []).length >= 35);
  return data?.direction === 'en2cn' && (risk.test(source) || structure.test(source) || longSentence ||
    (data.sentences || []).some((s) => (s.findings || []).some((f) => f.level === 'improve')) ||
    String(data.draft || '').split(/[。！？\n]/).filter((s) => s.trim()).some((s) =>
      !(data.sentences || []).some((row) => String(row.draft || '').includes(s.trim()))));
}

export const EN2CN_REVIEW_PROMPT = `你是英译汉批改的独立语义复核员。重新读完整英文原文和中文译稿，再检查第一轮记录；不要因第一轮已经判定就附和它。仅复核，不另造词汇、习语；只在AI对照译文或句式点拨存在实际误读时修正这些内容。
重点逐项核对数字/单位/百分比与百分点、否定范围、必要充分条件、比较方向、施事与指代、时间、情态和证据强度。源文和译文双向检查：原文的每个实质信息是否已表达，以及译稿的每个事实是否有原文依据，尤其不要漏掉译稿末尾新增的承诺。
百分比与百分点、相对降幅与降至某值是不同数量，不是可选润色；改变数值口径应为error。not all表示并非全部，至少一个不是，不保证另有一些是；也不能把它强化成一个都不是。仅与原文不矛盾不等于忠实传达，擅自增加肯定或否定、增强确定性也需指出。未证明A不等于证明非A，未显著不等于零效应，不支持取消不等于赞成继续。
必须纠正第一轮解释中的不当推导；但不要把合法中文省略、问句正反表达、同义词、拆合句视为错误。不仅要判断level，解释本身也不得额外承诺原文没有的事实。修正后的to必须忠实自然，代入上下文后仍成立。
只输出JSON，先检查对照译文，再处理学生finding：
{"ai":"经核对的完整中文对照译文；输入ai正确则原样保留，有误则修正","sentenceTranslations":[{"sentenceIndex":1,"ai":"经核对的该源句中文对照译文"}],"edits":[{"findingIndex":1,"finding":{"category":"误译","level":"error","from":"现有初稿片段","to":"正确中文","explanation":"基于原文的准确说明","sourceQuote":"英文原文逐字引用","primaryDimension":"理解准确"}}],"additions":[{"sentenceIndex":1,"finding":同上}],"overall":完整评分对象或null}
ai和sentenceTranslations独立于edits，输入有ai时总是返回完整ai和各源句的sentenceTranslations；即使edits为空也不能跳过此项。输入无ai时可以省略。只纠正实际误读，不做同义改写。
findingIndex为输入编号，仅用来定位原有条目；每个编号最多一次修改。删除没有学习价值的原可选建议可用{"findingIndex":1,"remove":true,"reason":"理由"}，不得直接删除error；误判的error改为study并说明原译成立。新增只限确实漏判的error，不补同义词润色。
同义例句或idiom中的教学如有无依据推导、与原文矛盾，可在对应edit上加clearLearning:true并在finding.explanation说明依据，清除该条旧学习材料；正确的条目不清除。
additions优先用sentenceIndex定位已有源句；整句漏译而第一轮没有该句时用sourceSentence（英文原文中完整的句子）代替；新增无依据事实用extra:true，sourceQuote引用邻近源文作定位，并明确说明全文不存在这项信息。
error的from必须逐字存在于完整初稿，sourceQuote必须逐字存在于完整英文；漏译的from引用相邻初稿，to为补译内容。若首次漏译记录用了“学生译稿无对应句”等不存在于译稿的占位符，必须改成实际相邻初稿片段；该片段只定位插入位置，不要让补译替换掉相邻句。所有修订保留准确的原文引用。未发现需要修改时edits=[]、additions=[]，不要凑条目。
如果修改了error的内容/等级、添加了error，或者输入指出评分需复核，同时给出完整overall；未改变错误也无评分问题则overall=null。overall包括score、scoreBreakdown、summary、highlights、advice、issues；五项名称、满分和扣分依据遵守下文规则，deductions引用修改之后的finding的sourceQuote/from（不能用旧数组编号）。亮点只能来自原初稿。评分按全部原有和修订后的error计算，不能只给新增问题扣分。
复核还要核对输入的句式点拨，不得与修正后的说明矛盾。仅当句式点拨存在事实、关系、立场误读时可额外输出advancedSentences:[修正后全部句式点拨字符串，最多3条]；未修改的句式点拨字段不输出。这些字段不能替代findings和扣分账本。新增漏译源句的ai可在对应addition中提供。
【提交前的归属检查】所有error和扣分都针对学生draft，绝不针对AI译文。若解释说“原译正确、AI对照反而有误”，该学生finding必须降为study且不扣分，并通过ai/sentenceTranslations修正AI错误；不能保留level=error。反过来，学生和AI同时出现同一误读时，要保留学生error，并同时修正AI对照。例：学生写“B之后A”，AI写“因为B所以A”，原文只说明先后：学生不扣分，修正AI；学生也写“因为B所以A”时才给学生记error。发现现有ai含有已指出的因果/指代/否定误读，必须返回修正后的ai和对应sentenceTranslations，而不是仅修改说明。若idiom/例句与正确解释矛盾，使用clearLearning:true清掉它。
` + EN2CN_TRANSFER_RULES + EN2CN_SCORE_EVIDENCE_RULES;

export function buildEn2cnReviewMessage(data, scoreProblems = []) {
  let index = 0;
  return JSON.stringify({ source: data.chinese, draft: data.draft, scoreProblems,
    ai: data.ai, advancedSentences: data.advancedSentences,
    sentences: (data.sentences || []).map((s, i) => ({ sentenceIndex: i + 1, source: s.cn, draft: s.draft, ai: s.ai,
      findings: (s.findings || []).map((f) => ({ findingIndex: ++index, category: f.category, level: f.level,
        from: f.from, to: f.to, explanation: f.explanation, sourceQuote: f.sourceQuote, primaryDimension: f.primaryDimension,
        examples: f.examples, synonyms: f.synonyms, idiom: f.idiom })) })),
    overall: data.overall });
}

/** Validate citations and identifiers before applying a second model's changes. */
export function applyEn2cnReview(data, review) {
  if (!review || !Array.isArray(review.edits) || !Array.isArray(review.additions) || review.edits.length + review.additions.length > 80) throw new Error('语义复核格式无效');
  const sentences = (data.sentences || []).map((s) => ({ ...s, findings: [...(s.findings || [])] }));
  const corrected = {};
  const translation = (value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 50000) throw new Error('语义复核对照译文无效');
    return value;
  };
  if ('ai' in review) corrected.ai = translation(review.ai);
  if ('advancedSentences' in review) {
    if (!Array.isArray(review.advancedSentences) || review.advancedSentences.length > 3 ||
        review.advancedSentences.some((s) => typeof s !== 'string' || !s.trim() || s.length > 10000)) throw new Error('语义复核句式点拨无效');
    corrected.advancedSentences = [...review.advancedSentences];
  }
  if ('sentenceTranslations' in review) {
    if (!Array.isArray(review.sentenceTranslations) || review.sentenceTranslations.length > sentences.length) throw new Error('语义复核译文编号无效');
    const seen = new Set();
    for (const row of review.sentenceTranslations) {
      const i = row?.sentenceIndex;
      if (!Number.isInteger(i) || i < 1 || i > sentences.length || seen.has(i)) throw new Error('语义复核译文编号无效');
      seen.add(i); sentences[i - 1].ai = translation(row.ai);
    }
  }
  const existing = sentences.flatMap((s) => s.findings.map((f, i) => ({ s, f, i })));
  const validFinding = (f, previous = {}) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('语义复核条目无效');
    const merged = { ...previous };
    for (const key of ['category', 'level', 'from', 'to', 'explanation', 'sourceQuote', 'primaryDimension']) if (key in f) merged[key] = f[key];
    if (typeof merged.category !== 'string' || !merged.category.trim() || !['error', 'improve', 'study'].includes(merged.level) || typeof merged.from !== 'string' || !merged.from.trim() ||
      !String(data.draft || '').includes(merged.from) || typeof merged.to !== 'string' || !merged.to.trim() || (merged.level !== 'study' && merged.from.trim() === merged.to.trim()) ||
      typeof merged.explanation !== 'string' || !merged.explanation.trim()) throw new Error('语义复核初稿引用无效');
    if (merged.level === 'error' && (typeof merged.sourceQuote !== 'string' || !merged.sourceQuote.trim() || !String(data.chinese || '').includes(merged.sourceQuote) || !EN2CN_DIMENSIONS.includes(merged.primaryDimension))) throw new Error('语义复核原文引用无效');
    if (previous.explanation && previous.explanation !== merged.explanation) {
      // First-pass examples may teach the very interpretation the review corrected.
      merged.synonyms = []; merged.examples = []; merged.dimensions = []; delete merged.idiom;
    }
    return merged;
  };
  const edited = new Set();
  let addedCount = 0;
  for (const change of review.edits) {
    const index = Number(change?.findingIndex);
    const ref = Number.isInteger(index) && index > 0 ? existing[index - 1] : null;
    if (!ref || edited.has(index)) throw new Error('语义复核编号无效');
    edited.add(index);
    if (change.remove) {
      if (ref.f.level === 'error' || !change.reason) throw new Error('语义复核不能无依据删除错误');
      ref.s.findings[ref.i] = null;
    } else {
      const finding = validFinding(change.finding, ref.f);
      if (change.clearLearning === true) {
        finding.synonyms = []; finding.examples = []; finding.dimensions = []; delete finding.idiom;
      }
      ref.s.findings[ref.i] = finding;
    }
  }
  for (const addition of review.additions) {
    const finding = validFinding(addition?.finding);
    if (finding.level !== 'error') throw new Error('语义复核新增仅限真实错漏');
    let sentence;
    if (addition.extra === true) {
      sentence = { cn: '（原文无对应信息的译稿内容）', draft: finding.from, ai: '', original: '', findings: [] };
      sentences.push(sentence);
    } else if (addition.sourceSentence) {
      if (!String(data.chinese || '').includes(addition.sourceSentence)) throw new Error('语义复核源句无效');
      sentence = { cn: addition.sourceSentence, draft: '（学生译稿中缺少对应信息）', ai: addition.ai === undefined ? '' : translation(addition.ai), original: '', findings: [] };
      sentences.push(sentence);
    } else {
      const i = Number(addition.sentenceIndex);
      if (!Number.isInteger(i) || i < 1 || i > data.sentences.length) throw new Error('语义复核源句编号无效');
      sentence = sentences[i - 1];
    }
    const duplicate = sentences.some((s) => s.findings.some((f) => f && (
      (f.from === finding.from && f.to === finding.to && f.sourceQuote === finding.sourceQuote) ||
      // A review may repeat a clause-level error as a whole-sentence error.
      // Keep the existing entry when both source and draft spans cover it.
      (f.level === 'error' && f.primaryDimension === finding.primaryDimension && f.category === finding.category && f.sourceQuote &&
       (f.sourceQuote.includes(finding.sourceQuote) || finding.sourceQuote.includes(f.sourceQuote)) &&
       (f.from.includes(finding.from) || finding.from.includes(f.from)))
    )));
    if (!duplicate) { sentence.findings.push(finding); addedCount++; }
  }
  for (const sentence of sentences) sentence.findings = sentence.findings.filter(Boolean);
  const overall = { ...(review.overall ? normalizeEn2cnOverall(review.overall) : data.overall) };
  if (overall) {
    overall.summary = typeof overall.summary === 'string' ? overall.summary : String(data.overall?.summary || '');
    for (const key of ['advice', 'highlights']) overall[key] = Array.isArray(overall[key]) ? overall[key].filter((item) => typeof item === 'string') : [];
  }
  return { ...data, ...corrected, sentences, overall: { ...overall, issues: sentences.reduce((n, s) => n + s.findings.length, 0) },
    translationReview: { status: 'done', edited: review.edits.length, added: addedCount } };
}
