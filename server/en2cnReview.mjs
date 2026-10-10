import { EN2CN_DIMENSIONS, EN2CN_SCORE_EVIDENCE_RULES, normalizeEn2cnOverall } from './en2cnScoring.mjs';

export function needsEn2cnReview(data) {
  const risk = /\b(?:not|no|none|neither|unless|only|less|fewer|percent|percentage|might|may|could|would|had|without|rather|except)\b|\d/i;
  return data?.direction === 'en2cn' && (risk.test(data.chinese || '') ||
    (data.sentences || []).some((s) => (s.findings || []).some((f) => f.level === 'improve')) ||
    String(data.draft || '').split(/[。！？\n]/).filter((s) => s.trim()).some((s) =>
      !(data.sentences || []).some((row) => String(row.draft || '').includes(s.trim()))));
}

export const EN2CN_REVIEW_PROMPT = `你是英译汉批改的独立语义复核员。重新读完整英文原文和中文译稿，再检查第一轮记录；不要因第一轮已经判定就附和它。仅复核，不重新生成词汇、习语或整篇译文。
重点逐项核对数字/单位/百分比与百分点、否定范围、必要充分条件、比较方向、施事与指代、时间、情态和证据强度。源文和译文双向检查：原文的每个实质信息是否已表达，以及译稿的每个事实是否有原文依据，尤其不要漏掉译稿末尾新增的承诺。
百分比与百分点、相对降幅与降至某值是不同数量，不是可选润色；改变数值口径应为error。not all表示并非全部，至少一个不是，不保证另有一些是；也不能把它强化成一个都不是。仅与原文不矛盾不等于忠实传达，擅自增加肯定或否定、增强确定性也需指出。未证明A不等于证明非A，未显著不等于零效应，不支持取消不等于赞成继续。
必须纠正第一轮解释中的不当推导；但不要把合法中文省略、问句正反表达、同义词、拆合句视为错误。不仅要判断level，解释本身也不得额外承诺原文没有的事实。修正后的to必须忠实自然，代入上下文后仍成立。
只输出JSON：
{"edits":[{"findingIndex":1,"finding":{"category":"误译","level":"error","from":"现有初稿片段","to":"正确中文","explanation":"基于原文的准确说明","sourceQuote":"英文原文逐字引用","primaryDimension":"理解准确"}}],"additions":[{"sentenceIndex":1,"finding":同上}],"overall":完整评分对象或null}
findingIndex为输入编号，仅用来定位原有条目；每个编号最多一次修改。删除没有学习价值的原可选建议可用{"findingIndex":1,"remove":true,"reason":"理由"}，不得直接删除error；误判的error改为study并说明原译成立。新增只限确实漏判的error，不补同义词润色。
additions优先用sentenceIndex定位已有源句；整句漏译而第一轮没有该句时用sourceSentence（英文原文中完整的句子）代替；新增无依据事实用extra:true，sourceQuote引用邻近源文作定位，并明确说明全文不存在这项信息。
error的from必须逐字存在于完整初稿，sourceQuote必须逐字存在于完整英文；漏译的from引用相邻初稿，to为补译内容。若首次漏译记录用了“学生译稿无对应句”等不存在于译稿的占位符，必须改成实际相邻初稿片段；该片段只定位插入位置，不要让补译替换掉相邻句。所有修订保留准确的原文引用。未发现需要修改时edits=[]、additions=[]，不要凑条目。
如果修改了error的内容/等级、添加了error，或者输入指出评分需复核，同时给出完整overall；未改变错误也无评分问题则overall=null。overall包括score、scoreBreakdown、summary、highlights、advice、issues；五项名称、满分和扣分依据遵守下文规则，deductions引用修改之后的finding的sourceQuote/from（不能用旧数组编号）。亮点只能来自原初稿。评分按全部原有和修订后的error计算，不能只给新增问题扣分。
` + EN2CN_SCORE_EVIDENCE_RULES;

export function buildEn2cnReviewMessage(data, scoreProblems = []) {
  let index = 0;
  return JSON.stringify({ source: data.chinese, draft: data.draft, scoreProblems,
    sentences: (data.sentences || []).map((s, i) => ({ sentenceIndex: i + 1, source: s.cn, draft: s.draft,
      findings: (s.findings || []).map((f) => ({ findingIndex: ++index, category: f.category, level: f.level,
        from: f.from, to: f.to, explanation: f.explanation, sourceQuote: f.sourceQuote, primaryDimension: f.primaryDimension })) })),
    overall: data.overall });
}

/** Validate citations and identifiers before applying a second model's changes. */
export function applyEn2cnReview(data, review) {
  if (!review || !Array.isArray(review.edits) || !Array.isArray(review.additions) || review.edits.length + review.additions.length > 80) throw new Error('语义复核格式无效');
  const sentences = (data.sentences || []).map((s) => ({ ...s, findings: [...(s.findings || [])] }));
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
    } else ref.s.findings[ref.i] = validFinding(change.finding, ref.f);
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
      sentence = { cn: addition.sourceSentence, draft: '（学生译稿中缺少对应信息）', ai: '', original: '', findings: [] };
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
  return { ...data, sentences, overall: { ...overall, issues: sentences.reduce((n, s) => n + s.findings.length, 0) },
    translationReview: { status: 'done', edited: review.edits.length, added: addedCount } };
}
