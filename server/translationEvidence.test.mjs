import assert from 'node:assert/strict';
import { applyCn2enReview } from './cn2enReview.mjs';
import { dedupeExactErrors } from './scoringEvidence.mjs';

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
assert.throws(() => applyCn2enReview(ledger, { edits: [], additions: [], sentenceTranslations: [{ sentenceIndex: 1, ai: correction, correctedSentence: {} }] }), /对照译文无效/);
assert.equal(ledger.ai, undefined, 'invalid review does not partially apply');
const styleOnly = applyCn2enReview({ ...ledger, sentences: [{ cn: source, draft, findings: [] }] }, { edits: [], additions: [], ai: correction,
  sentenceTranslations: [{ sentenceIndex: 1, ai: correction }] });
assert.equal(styleOnly.sentences[0].ai, correction, 'the AI version stays independent of corrections');
const duplicateData = { ...ledger, sentences: [{ findings: [condition, { ...condition, from: draft, sourceQuote: source, to: correction }] }] };
const merged = applyCn2enReview(duplicateData, { edits: [], additions: [], duplicates: [{ findingIndex: 2, duplicateOf: 1, reason: '经语义核对只重复条件反转，没有其它根因。' }] });
assert.equal(merged.sentences[0].findings.length, 1);
assert.throws(() => applyCn2enReview(duplicateData, { edits: [], additions: [], duplicates: [{ findingIndex: 2, duplicateOf: 1, reason: '' }] }), /合并编号无效/);
console.log('PASS cn2en review: atomic edits, AI version independent, corrections stripped, explicit merges');
