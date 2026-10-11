import assert from 'node:assert/strict';
import { CN2EN_DIMENSIONS, CN2EN_MAX, cn2enScoreProblems, reconcileCn2enOverall } from './cn2enScoring.mjs';
import { applyCn2enReview } from './cn2enReview.mjs';
import { EVIDENCE_POLICY, dedupeExactErrors } from './scoringEvidence.mjs';

const emptyLedger = () => ({ score: 100, scoreBreakdown: CN2EN_DIMENSIONS.map((label) => ({ label, max: CN2EN_MAX[label], score: CN2EN_MAX[label], deductions: [] })) });
const source = '只有审查通过，项目才可能继续。';
const draft = 'As long as the review passes, the project will continue.';
const condition = { category: '逻辑', level: 'error', severity: 'critical', from: 'As long as the review passes', to: 'Only if the review passes',
  sourceQuote: '只有审查通过', primaryDimension: '语境与逻辑', explanation: '必要条件变成充分条件。' };
const modality = { category: '逻辑', level: 'error', severity: 'major', from: draft, to: 'The project may continue only if the review passes.',
  sourceQuote: source, primaryDimension: '语境与逻辑', explanation: '可能变成必然，独立于条件错误。' };
const data = () => ({ direction: 'cn2en', gradingPolicyVersion: EVIDENCE_POLICY, chinese: source, draft,
  sentences: [{ cn: source, draft, findings: [condition, modality] }], overall: emptyLedger() });
const charge = (f, points) => ({ sourceQuote: f.sourceQuote, from: f.from, points });
const ledger = data();
ledger.overall.scoreBreakdown[2].deductions = [charge(condition, 12), charge(modality, 5)];
ledger.overall = reconcileCn2enOverall(ledger);
assert.equal(ledger.overall.score, 83);
assert.deepEqual(cn2enScoreProblems(ledger), []);
assert.equal(ledger.overall.taskAssessment.status, 'needs-revision');
assert.equal(dedupeExactErrors(ledger).sentences[0].findings.length, 2, 'independent nested roots must survive');
const exact = { ...ledger, sentences: [{ findings: [condition, { ...condition }, modality] }] };
assert.equal(dedupeExactErrors(exact).sentences[0].findings.length, 2);

const optional = { ...data(), sentences: [{ findings: [{ ...condition, level: 'improve' }] }], overall: emptyLedger() };
optional.overall.score = 88; optional.overall.scoreBreakdown[2].score = 23;
optional.overall.scoreBreakdown[2].deductions = [charge(condition, 12)];
const accepted = reconcileCn2enOverall(optional);
assert.equal(accepted.score, 100, 'optional stylistic changes have no deduction');
assert.equal(accepted.scoringVersion, 'cn2en-evidence-v1');
assert.ok(cn2enScoreProblems(data()).includes('真实错误未体现于扣分依据'), 'a valid-looking total cannot hide uncharged errors');
assert.ok(cn2enScoreProblems({ ...data(), overall: { score: 100 } }).length);
const fabricated = structuredClone(ledger);
fabricated.overall.scoreBreakdown[2].deductions[0].sourceQuote = '无依据的新原文';
assert.equal(reconcileCn2enOverall(fabricated).score, 83, 'unknown citations must not be silently deleted');
assert.ok(cn2enScoreProblems(fabricated).length);
const fakeOptional = { ...optional, sentences: [{ findings: [{ ...condition, level: 'study', from: 'not in the student draft' }] }] };
assert.ok(cn2enScoreProblems(fakeOptional).includes('逐句条目引用了初稿中不存在的片段'));
const weak = structuredClone(ledger);
weak.overall.scoreBreakdown[2].deductions[0].points = 3;
assert.ok(cn2enScoreProblems(weak).includes('扣分低于错误严重性下限'));
const missingSeverity = structuredClone(ledger); delete missingSeverity.sentences[0].findings[0].severity;
assert.ok(cn2enScoreProblems(missingSeverity).includes('错误缺少维度或严重性'));
const invalidSeverity = structuredClone(ledger); invalidSeverity.sentences[0].findings[0].severity = 'constructor';
assert.ok(cn2enScoreProblems(invalidSeverity).includes('错误缺少维度或严重性'));
const wrongDimension = structuredClone(ledger);
wrongDimension.sentences[0].findings[0].primaryDimension = '词汇准确';
wrongDimension.overall.scoreBreakdown[0].deductions = [charge(condition, 12)];
wrongDimension.overall.scoreBreakdown[2].deductions.shift();
assert.ok(cn2enScoreProblems(wrongDimension).includes('事实、范围或逻辑错误应归语境与逻辑'));
const overflow = data();
overflow.sentences[0].findings[1].severity = 'critical';
overflow.overall.scoreBreakdown[2].deductions = [charge(condition, 20), charge(modality, 20)];
overflow.overall = reconcileCn2enOverall(overflow);
assert.equal(overflow.overall.score, 65); assert.equal(overflow.overall.scoreBreakdown[2].score, 0);
assert.deepEqual(cn2enScoreProblems(overflow), [], 'dimension clamping preserves evidence and avoids duplicate deductions elsewhere');

const correction = 'Only if the review passes may the project continue.';
const reviewed = applyCn2enReview(ledger, { edits: [], additions: [], ai: correction,
  sentenceTranslations: [{ sentenceIndex: 1, ai: correction, correctedSentence: correction }], vocabularyNotes: [], idiomHighlights: [], bonusExpressions: [] });
assert.equal(reviewed.sentences[0].correctedSentence, correction);
assert.equal(reviewed.chinese, source); assert.equal(reviewed.draft, draft);
assert.equal(ledger.sentences[0].correctedSentence, undefined, 'review is immutable');
assert.throws(() => applyCn2enReview(ledger, { edits: [], additions: [], sentenceTranslations: [{ sentenceIndex: 1, ai: correction, correctedSentence: {} }] }), /对照译文无效/);
assert.equal(ledger.ai, undefined, 'invalid review does not partially apply');
const styleOnly = applyCn2enReview({ ...ledger, sentences: [{ cn: source, draft, findings: [] }] }, { edits: [], additions: [], ai: correction,
  sentenceTranslations: [{ sentenceIndex: 1, ai: correction, correctedSentence: correction }] });
assert.equal(styleOnly.sentences[0].correctedSentence, draft, 'no mandatory changes without a real error');
assert.equal(styleOnly.sentences[0].ai, correction, 'protecting the minimal correction must not erase the separate AI version');
const duplicateData = { ...ledger, sentences: [{ findings: [condition, { ...condition, from: draft, sourceQuote: source, to: correction }] }] };
const merged = applyCn2enReview(duplicateData, { edits: [], additions: [], duplicates: [{ findingIndex: 2, duplicateOf: 1, reason: '经语义核对只重复条件反转，没有其它根因。' }] });
assert.equal(merged.sentences[0].findings.length, 1);
assert.throws(() => applyCn2enReview(duplicateData, { edits: [], additions: [], duplicates: [{ findingIndex: 2, duplicateOf: 1, reason: '' }] }), /合并编号无效/);
console.log('PASS translation evidence: optional grading, independent roots, citations, severity, clamping, atomic corrections and explicit merges');
