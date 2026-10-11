import assert from 'node:assert/strict';
import { needsEn2cnReview, applyEn2cnReview, buildEn2cnReviewMessage } from './en2cnReview.mjs';
import { dedupeEn2cnFindings, EN2CN_DIMENSIONS, EN2CN_MAX, reconcileEn2cnOverall, en2cnScoreProblems } from './en2cnScoring.mjs';
import { normalizeEn2cnFeedback } from './en2cnFeedback.mjs';

const original = { category: '数字误译', level: 'improve', from: '20个百分点', to: '20%', explanation: '原文是相对降幅。' };
const data = { direction: 'en2cn', chinese: 'Costs fell by 20 percent. The buses stayed in service.',
  draft: '费用下降了20个百分点。公交车继续运行。所有人都免费乘车。',
  sentences: [{ cn: 'Costs fell by 20 percent.', draft: '费用下降了20个百分点。', findings: [original] },
    { cn: 'The buses stayed in service.', draft: '公交车继续运行。', findings: [] }], overall: { score: 100 } };
const numeric = { ...original, level: 'error', sourceQuote: 'fell by 20 percent', primaryDimension: '理解准确' };
const added = { category: '增译', level: 'error', from: '所有人都免费乘车。', to: '（删除此句）',
  explanation: '全文没有免费乘车的承诺。', sourceQuote: 'The buses stayed in service.', primaryDimension: '完整性' };
const ledger = { score: 91, scoreBreakdown: EN2CN_DIMENSIONS.map((label) => ({ label, max: EN2CN_MAX[label],
  score: EN2CN_MAX[label] - (label === '理解准确' ? 4 : label === '完整性' ? 5 : 0),
  deductions: label === '理解准确' ? [{ sourceQuote: numeric.sourceQuote, from: numeric.from, points: 4 }]
    : label === '完整性' ? [{ sourceQuote: added.sourceQuote, from: added.from, points: 5 }] : [] })) };
const review = { edits: [{ findingIndex: 1, finding: numeric }], additions: [{ extra: true, finding: added }], overall: ledger };
const result = applyEn2cnReview(data, review);
result.overall = reconcileEn2cnOverall(result);
assert.equal(result.sentences[0].findings[0].level, 'error');
assert.equal(result.sentences[2].findings[0].from, added.from);
assert.equal(result.overall.score, 91);
assert.deepEqual(en2cnScoreProblems(result), []);
assert.equal(data.sentences[0].findings[0].level, 'improve', 'input remains unchanged');
assert.ok(needsEn2cnReview(data));
assert.equal(needsEn2cnReview({ ...data, direction: 'cn2en' }), false);
assert.equal(needsEn2cnReview({ direction: 'en2cn', chinese: 'Birds sing.', draft: '鸟儿鸣叫。',
  sentences: [{ draft: '鸟儿鸣叫。', findings: [] }] }), false);
assert.ok(needsEn2cnReview({ direction: 'en2cn', chinese: 'Birds sing.', draft: '鸟儿鸣叫。明天免票。',
  sentences: [{ draft: '鸟儿鸣叫。', findings: [] }] }), 'uncovered draft tail triggers review');
assert.match(buildEn2cnReviewMessage(data), /所有人都免费乘车/);
assert.equal(applyEn2cnReview(data, { edits: [], additions: [], overall: null }).overall.score, 100);
assert.throws(() => applyEn2cnReview(data, { ...review, edits: [{ findingIndex: 1 }] }), /条目无效/);
assert.throws(() => applyEn2cnReview(data, { ...review, edits: [{ findingIndex: 2, finding: numeric }] }), /编号无效/);
assert.throws(() => applyEn2cnReview(data, { ...review, edits: [review.edits[0], review.edits[0]] }), /编号无效/);
assert.throws(() => applyEn2cnReview(data, { ...review, edits: [{ findingIndex: 1, finding: { ...numeric, from: '捏造译稿' } }] }), /初稿引用无效/);
assert.throws(() => applyEn2cnReview(data, { ...review, edits: [{ findingIndex: 1, finding: { ...numeric, sourceQuote: 'not in source' } }] }), /原文引用无效/);
assert.throws(() => applyEn2cnReview(result, { edits: [{ findingIndex: 1, remove: true, reason: 'ignore' }], additions: [] }), /不能无依据删除错误/);
const removed = applyEn2cnReview(data, { edits: [{ findingIndex: 1, remove: true, reason: '只是同义改写' }], additions: [], overall: null });
assert.equal(removed.sentences[0].findings.length, 0);
const accepted = applyEn2cnReview(result, { edits: [{ findingIndex: 1, finding: { ...numeric, level: 'study', to: numeric.from,
  explanation: '经核对原译成立，仅用于学习对照。' } }], additions: [], overall: null });
assert.equal(accepted.sentences[0].findings[0].level, 'study', 'a false error may be explicitly accepted without inventing a replacement');
const scope = { direction: 'en2cn', chinese: 'Not all the tools are new.', draft: '工具都不是新的。', sentences: [{ findings: [{
  level: 'error', category: '逻辑', from: '工具都不是新的', to: '并非所有工具都是新的', sourceQuote: 'Not all the tools are new', explanation: '有些新有些旧',
}] }] };
assert.match(normalizeEn2cnFeedback(scope).sentences[0].findings[0].explanation, /不能据此断言/);
const cn2en = { ...scope, direction: 'cn2en' };
assert.equal(normalizeEn2cnFeedback(cn2en), cn2en, 'Chinese-to-English feedback is unchanged');
const omitted = normalizeEn2cnFeedback({ ...data, sentences: [{ findings: [{ ...added, category: '漏译', from: '公交车继续运行。', to: '报告未计入间接成本。' }] }] });
assert.equal(omitted.sentences[0].findings[0].operation, 'insert');
const overlapping = applyEn2cnReview(result, { edits: [], additions: [{ sentenceIndex: 1, finding: { ...numeric,
  from: '费用下降了20个百分点。', sourceQuote: 'Costs fell by 20 percent.', to: '费用下降了20%。' } }], overall: null });
assert.equal(overlapping.sentences[0].findings.length, 2, 'overlap alone cannot prove two findings equivalent');
assert.equal(overlapping.translationReview.added, 1);
const safeShape = applyEn2cnReview(data, { ...review, edits: [{ findingIndex: 1, finding: { ...numeric, synonyms: 'wrong shape', examples: { invalid: true } } }] });
assert.equal(safeShape.sentences[0].findings[0].synonyms, undefined, 'review cannot inject malformed learning-card fields');
// Real-model regression: whole-sentence completeness charges repeated two
// understanding errors, causing otherwise valid scoring to be discarded.
const pair = { direction: 'en2cn', chinese: 'Only members qualify; approval does not guarantee funding.',
  draft: '会员都一定合格；批准就保证得到资助。', sentences: [{ findings: [
    { category: '误译', level: 'error', from: '会员都一定合格', sourceQuote: 'Only members qualify', primaryDimension: '理解准确' },
    { category: '误译', level: 'error', from: '批准就保证得到资助', sourceQuote: 'approval does not guarantee funding', primaryDimension: '理解准确' },
  ] }] };
pair.overall = { score: 12, scoreBreakdown: EN2CN_DIMENSIONS.map((label) => ({ label, max: EN2CN_MAX[label], score: 0,
  deductions: label === '理解准确' ? pair.sentences[0].findings.map((f) => ({ sourceQuote: f.sourceQuote, from: f.from, points: 5 }))
    : label === '完整性' ? [{ sourceQuote: pair.chinese, from: pair.draft, points: 8 }] : [] })) };
const bounded = reconcileEn2cnOverall(pair);
assert.deepEqual(bounded, pair.overall, 'unknown broad charges require semantic review rather than automatic deletion');
const reviewedPair = structuredClone(pair);
reviewedPair.overall.scoreBreakdown[4].deductions = [];
const repairedPair = reconcileEn2cnOverall(reviewedPair);
assert.equal(repairedPair.score, 90);
assert.deepEqual(en2cnScoreProblems({ ...reviewedPair, overall: repairedPair }), []);
const unknownCharge = structuredClone(pair);
unknownCharge.overall.scoreBreakdown[4].deductions[0].sourceQuote = 'Invented source';
assert.deepEqual(reconcileEn2cnOverall(unknownCharge), unknownCharge.overall, 'unknown citations still need model repair');
const missingCharge = structuredClone(pair);
missingCharge.overall.scoreBreakdown[0].deductions.pop();
assert.deepEqual(reconcileEn2cnOverall(missingCharge), missingCharge.overall, 'removing duplicates cannot conceal an unscored real error');
for (const source of [
  'The decision, which the committee announced, worried researchers who work abroad.',
  'The proposal was rejected after questions about feasibility were raised.',
  'The report indicates an association.',
  'The town changed its rules. This prompted protests.',
  'The rapid growth of distance courses has made education accessible.',
  'The policy was designed to reduce emissions.',
  'Leo bought a little bread.',
  'A few people attended.',
]) {
  const task = { direction: 'en2cn', chinese: source, draft: '成立的中文译法。', sentences: [{ draft: '成立的中文译法。', findings: [] }] };
  assert.ok(needsEn2cnReview(task), 'structure/stance risks must not depend on first-pass detection: ' + source);
  assert.equal(needsEn2cnReview({ ...task, direction: 'cn2en' }), false);
}
const contradictory = { ...data, ai: '费用下降了20个百分点。', advancedSentences: ['after 表示由于'],
  sentences: [{ ...data.sentences[0], ai: '费用下降了20个百分点。' }, data.sentences[1]] };
const aligned = applyEn2cnReview(contradictory, { edits: [], additions: [], overall: null,
  ai: '费用下降了20%。公交车继续运行。', sentenceTranslations: [{ sentenceIndex: 1, ai: '费用下降了20%。' }],
  advancedSentences: ['after → 在……之后 · 中文点拨：先后不自动等于因果。'] });
assert.equal(aligned.sentences[0].ai, '费用下降了20%。', 'review correction reaches the displayed sentence translation');
assert.equal(aligned.ai, '费用下降了20%。公交车继续运行。');
assert.equal(contradictory.sentences[0].ai, '费用下降了20个百分点。', 'review remains atomic and immutable');
assert.match(buildEn2cnReviewMessage(contradictory), /after 表示由于/, 'review sees potentially conflicting teaching material');
const staleIdiom = { ...data, sentences: [{ ...data.sentences[0], findings: [{ ...numeric, idiom: '先斩后奏', examples: [{ cn: '错误例子' }] }] }] };
assert.match(buildEn2cnReviewMessage(staleIdiom), /先斩后奏/);
const cleared = applyEn2cnReview(staleIdiom, { edits: [{ findingIndex: 1, finding: numeric, clearLearning: true }], additions: [] });
assert.equal(cleared.sentences[0].findings[0].idiom, undefined);
assert.deepEqual(cleared.sentences[0].findings[0].examples, []);
assert.equal(staleIdiom.sentences[0].findings[0].idiom, '先斩后奏');
const falseError = applyEn2cnReview({ ...result, ai: '费用下降了20个百分点。' }, {
  edits: [{ findingIndex: 1, finding: { ...numeric, level: 'study', to: numeric.from, explanation: '学生原译成立；仅修正AI对照的误读。' } }],
  additions: [], overall: null, ai: '费用下降了20%。',
});
assert.equal(reconcileEn2cnOverall(falseError).score, 95, 'accepting the student and correcting AI removes only the false student deduction');
for (const extension of [
  { ai: '' }, { ai: {} }, { sentenceTranslations: [{ sentenceIndex: 0, ai: '中文' }] },
  { sentenceTranslations: [{ sentenceIndex: 1, ai: '中文' }, { sentenceIndex: 1, ai: '重复' }] },
  { advancedSentences: [{ invalid: true }] },
]) assert.throws(() => applyEn2cnReview(contradictory, { edits: [], additions: [], ...extension }), /语义复核/);
// Same-proposition duplicates: a wider same-dimension finding merges into the
// precise one (real-model regression: one negation reversal listed twice, which
// used to pass the ledger and could leave scoring unavailable).
const dupSource = 'The report calls for a review of the decision; it does not recommend stopping all work.';
const dupDraft = '报告要求重新审议这一决定，并建议全面停工。';
const narrowDup = { category: '误译', level: 'error', from: '并建议全面停工', to: '但并不建议停止全部工程',
  sourceQuote: 'it does not recommend stopping all work', primaryDimension: '理解准确', explanation: '否定漏掉，立场反转。' };
const wideDup = { category: '连贯', level: 'error', from: dupDraft, to: '报告要求对这一决定进行复议；报告并不建议停止全部工程。',
  sourceQuote: dupSource, primaryDimension: '理解准确', explanation: '同一次否定反转的整句重复。' };
const dupData = { direction: 'en2cn', chinese: dupSource, draft: dupDraft,
  sentences: [{ cn: dupSource, draft: dupDraft, findings: [narrowDup, wideDup] }] };
const deduped = dedupeEn2cnFindings(dupData);
assert.equal(deduped.sentences[0].findings.length, 2, 'span nesting is not sufficient for automatic removal');
const merged = applyEn2cnReview(dupData, { edits: [], additions: [], duplicates: [{ findingIndex: 2, duplicateOf: 1, reason: '两条都仅指出同一次否定反转。' }] });
assert.equal(merged.sentences[0].findings.length, 1);
assert.equal(merged.translationReview.merged, 1);
assert.equal(dedupeEn2cnFindings({ ...dupData, sentences: [{ findings: [narrowDup, { ...narrowDup }] }] }).sentences[0].findings.length, 1, 'exact duplicates still merge');
assert.equal(dedupeEn2cnFindings({ ...dupData, direction: 'cn2en' }).sentences[0].findings.length, 2, 'cn2en is untouched');
const monthError = { category: '数字与单位', level: 'error', from: '七月开工', to: '六月开工',
  sourceQuote: 'in June', primaryDimension: '理解准确', explanation: '月份读错。' };
const monthChinese = "The committee's approval enabled work to begin in June; it does not recommend stopping all work.";
const monthDraft = '委员会的批准使工程得以在七月开工，并建议全面停工。';
const monthDeduped = dedupeEn2cnFindings({ direction: 'en2cn', chinese: monthChinese, draft: monthDraft,
  sentences: [{ findings: [monthError, narrowDup, { ...wideDup, from: monthDraft }] }] });
assert.equal(monthDeduped.sentences[0].findings.length, 3, 'an independent second error survives before semantic duplicate review');
const breakdown = (points, deductions) => ({ score: EN2CN_MAX['理解准确'] - points, scoreBreakdown: EN2CN_DIMENSIONS.map((label) => ({ label, max: EN2CN_MAX[label],
  score: EN2CN_MAX[label] - (label === '理解准确' ? points : 0), deductions: label === '理解准确' ? deductions : [] })) });
monthDeduped.overall = { ...breakdown(15, [
  { sourceQuote: monthError.sourceQuote, from: monthError.from, points: 5 },
  { sourceQuote: narrowDup.sourceQuote, from: narrowDup.from, points: 5 },
  { sourceQuote: monthChinese, from: monthDraft, points: 5, findingIndex: 2 },
]), score: 85 };
const monthReconciled = reconcileEn2cnOverall(monthDeduped);
assert.equal(monthReconciled.score, 85, 'a stale wide charge is not silently erased or rebound to a narrow error');
assert.ok(en2cnScoreProblems({ ...monthDeduped, overall: monthReconciled }).length > 0);
assert.ok(en2cnScoreProblems({ ...dupData,
  overall: { ...breakdown(15, [
    { sourceQuote: narrowDup.sourceQuote, from: narrowDup.from, points: 5 },
    { sourceQuote: wideDup.sourceQuote, from: wideDup.from, points: 10 },
  ]), score: 85 } }).length === 0, 'only semantic review can establish whether nested spans describe independent roots');
// A stale citation must not grab an unrelated error by array position.
const grab = { direction: 'en2cn', chinese: 'Alpha beta. Gamma delta.', draft: '甲乙。丙丁。',
  sentences: [{ findings: [
    { category: '误译', level: 'error', from: '甲乙', to: '甲丙', sourceQuote: 'Alpha beta', primaryDimension: '理解准确', explanation: 'a' },
    { category: '误译', level: 'error', from: '丙丁', to: '戊己', sourceQuote: 'Gamma delta', primaryDimension: '理解准确', explanation: 'b' },
  ] }] };
grab.overall = { ...breakdown(10, [
  { sourceQuote: 'Alpha beta. Gamma delta.', from: '甲乙。丙丁。', points: 5, findingIndex: 2 },
  { sourceQuote: 'Alpha beta', from: '甲乙', points: 5 },
]), score: 90 };
const grabProblems = en2cnScoreProblems(grab);
assert.ok(grabProblems.includes('理解准确引用了非错误或无效扣分'),
  'a stale wide citation cannot grab the second error via its array index');
// Review cannot re-add the same proposition under a different category label.
const crossCat = applyEn2cnReview(result, { edits: [], additions: [{ sentenceIndex: 1, finding: {
  category: '连贯', level: 'error', from: '费用下降了20个百分点。', to: '费用下降了20%。',
  sourceQuote: 'Costs fell by 20 percent.', primaryDimension: '理解准确', explanation: '整句重复。' } }], overall: null });
assert.equal(crossCat.translationReview.added, 1, 'a broader finding needs explicit semantic equivalence evidence');
console.log('PASS en2cn semantic review: numerical severity, unsupported tail, citations, bounded edits, optional removal, cn2en isolation');
