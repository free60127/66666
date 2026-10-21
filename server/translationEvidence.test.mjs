import assert from 'node:assert/strict';
import { applyCn2enReview } from './cn2enReview.mjs';
import { dedupeExactErrors, propagateRepeats } from './scoringEvidence.mjs';

const source = '只有审查通过，项目才可能继续。';
const draft = 'As long as the review passes, the project will continue.';
const condition = { category: '逻辑', level: 'error', from: 'As long as the review passes', to: 'Only if the review passes',
  sourceQuote: '只有审查通过', primaryDimension: '语境与逻辑', explanation: '必要条件变成充分条件。' };
const modality = { category: '逻辑', level: 'error', from: draft, to: 'The project may continue only if the review passes.',
  sourceQuote: source, primaryDimension: '语境与逻辑', explanation: '可能变成必然，独立于条件错误。' };
const ledger = { direction: 'cn2en', chinese: source, draft,
  sentences: [{ cn: source, draft, findings: [condition, modality] }], overall: { score: 72 } };
assert.equal(dedupeExactErrors(ledger).sentences[0].findings.length, 2, 'independent nested roots must survive');
const exact = { ...ledger, sentences: [{ findings: [condition, { ...condition }, modality] }] };
assert.equal(dedupeExactErrors(exact).sentences[0].findings.length, 2, 'exact duplicates merge, nested ones need review');

const correction = 'Only if the review passes may the project continue.';
const reviewed = applyCn2enReview(ledger, { edits: [], additions: [], ai: correction,
  sentenceTranslations: [{ sentenceIndex: 1, ai: correction, correctedSentence: correction }], vocabularyNotes: [], idiomHighlights: [], bonusExpressions: [] });
assert.equal(reviewed.sentences[0].correctedSentence, undefined, 'the full-correction row is stripped even if the review still emits it');
assert.equal(reviewed.chinese, source); assert.equal(reviewed.draft, draft);
assert.equal(ledger.sentences[0].correctedSentence, undefined, 'review is immutable');
const ignored = applyCn2enReview(ledger, { edits: [], additions: [], sentenceTranslations: [{ sentenceIndex: 1, ai: correction, correctedSentence: {} }] });
assert.equal(ignored.sentences[0].correctedSentence, undefined, 'a malformed correction payload is ignored, not stored');
assert.equal(ledger.ai, undefined, 'invalid review does not partially apply');
const styleOnly = applyCn2enReview({ ...ledger, sentences: [{ cn: source, draft, findings: [] }] }, { edits: [], additions: [], ai: correction,
  sentenceTranslations: [{ sentenceIndex: 1, ai: correction }] });
assert.equal(styleOnly.sentences[0].ai, correction, 'the AI version stays independent of corrections');
const duplicateData = { ...ledger, sentences: [{ findings: [condition, { ...condition, from: draft, sourceQuote: source, to: correction }] }] };
const merged = applyCn2enReview(duplicateData, { edits: [], additions: [], duplicates: [{ findingIndex: 2, duplicateOf: 1, reason: '经语义核对只重复条件反转，没有其它根因。' }] });
assert.equal(merged.sentences[0].findings.length, 1);
assert.throws(() => applyCn2enReview(duplicateData, { edits: [], additions: [], duplicates: [{ findingIndex: 2, duplicateOf: 1, reason: '' }] }), /合并编号无效/);

// 重复出现兜底：短词根在后续句群逐字再现时补 finding；常用词与长片段不传播
const repRoot = { category: '词义', level: 'error', from: 'the addresser', to: 'the conductor',
  sourceQuote: '售票员', primaryDimension: '词汇准确', explanation: '售票员应为 conductor。' };
const repData = { direction: 'cn2en', chinese: '售票员说。她指出。', draft: 'the addresser said. She noted the addresser again.',
  sentences: [
    { cn: '售票员说。', draft: 'the addresser said.', findings: [repRoot] },
    { cn: '她指出。', draft: 'She noted the addresser again.', findings: [] },
    { cn: '另一句。', draft: 'Nothing relevant here.', findings: [] },
  ] };
const propagated = propagateRepeats(repData);
assert.equal(propagated.sentences[1].findings.length, 1, 'the repeat occurrence gets a finding');
assert.match(propagated.sentences[1].findings[0].explanation, /同第1处/);
assert.equal(propagateRepeats(repData) === repData, false, 'changed data returns a new object');
const stopword = { ...repRoot, from: 'said', to: 'remarked' };
const withStop = { ...repData, sentences: [{ ...repData.sentences[0], findings: [stopword] }, repData.sentences[1], repData.sentences[2]] };
assert.equal(propagateRepeats(withStop).sentences[1].findings.length, 0, 'stoplisted words do not propagate');
const longRoot = { ...repRoot, from: 'the addresser said loudly', to: 'the conductor said' };
const withLong = { ...repData, sentences: [{ ...repData.sentences[0], findings: [longRoot] }, repData.sentences[1], repData.sentences[2]] };
assert.equal(propagateRepeats(withLong).sentences[1].findings.length, 0, 'long spans do not propagate');

console.log('PASS cn2en review: atomic edits, AI version independent, corrections stripped, explicit merges');
