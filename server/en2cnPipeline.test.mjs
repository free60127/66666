/** Exercise real HTTP/job persistence with an isolated model and storage. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { EN2CN_DIMENSIONS, EN2CN_MAX } from './en2cnScoring.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-en2cn-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const requests = [];
let mode = 'repair';
const source = 'Fewer than one in five residents use it. Many residents welcomed the plan.';
const draft = '五分之一以上的居民使用它。';
const findings = [
  { level: 'error', category: '误译', from: '五分之一以上', to: '不到五分之一', sourceQuote: 'Fewer than one in five', primaryDimension: '理解准确' },
  { level: 'error', category: '漏译', from: draft, to: draft + '许多居民对这个计划表示欢迎。', sourceQuote: 'Many residents welcomed the plan.', primaryDimension: '完整性' },
];
const overall = () => ({ score: 91, summary: '纠正比例并补充居民欢迎的信息。',
  scoreBreakdown: EN2CN_DIMENSIONS.map((label, i) => ({ label, max: EN2CN_MAX[label], score: EN2CN_MAX[label] - (i === 0 ? 4 : i === 4 ? 5 : 0),
    deductions: i === 0 ? [{ findingIndex: 1, points: 4 }] : i === 4 ? [{ findingIndex: 2, points: 5 }] : [] })), advice: ['先核对比例与信息完整性。'] });
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const system = body.messages[0].content;
  let content;
  if (system.includes('独立语义复核员')) {
    assert.match(body.messages[1].content, /Many residents welcomed the plan/);
    content = { edits: [], additions: [], overall: null };
    if (mode === 'semantic') content = { edits: [], additions: [{ sentenceIndex: 1, finding: {
      ...findings[1], explanation: '原文的居民欢迎信息尚未译出。',
    } }], overall: overall(), ai: '不到五分之一的居民使用它。许多居民欢迎这个计划。',
      sentenceTranslations: [{ sentenceIndex: 1, ai: '不到五分之一的居民使用它。许多居民欢迎这个计划。' }],
      advancedSentences: ['Fewer than one in five → 不到五分之一 · 中文点拨：保留数量上限。'] };
  } else if (system.includes('重做有证据的整体评价')) {
    content = mode === 'failed-review' ? { score: 58 } : overall();
    if (mode === 'repair-no-citation') content.scoreBreakdown.forEach((row) => { row.deductions = row.deductions.map((d) => ({ sourceQuote: findings[d.findingIndex - 1].sourceQuote, from: findings[d.findingIndex - 1].from, points: d.points })); });
  } else if (system.includes('自测题作答')) {
    assert.match(body.messages[1].content, /中文（zh）/);
    content = { grades: [{ index: 0, verdict: 'right', comment: '中文译文意思准确。', better: '' }] };
  } else if (system.includes('知识点收藏')) {
    assert.match(body.messages[1].content, /作答语言：中文/);
    content = { questions: [{ type: '翻译', question: '译成中文：Fewer than one in five use it.', answer: '不到五分之一的人使用它。', answerLanguage: 'zh', explanation: '比例不足五分之一。' }] };
  } else {
    assert.match(system, /扣分账本/);
    assert.doesNotMatch(body.messages[1].content, /5500|with 复合/);
    content = { title: '测试', chinese: 'wrong model echo', draft: 'wrong model echo', overall: mode === 'valid' ? overall() : { score: 58 }, sentences: [{ cn: source, draft, findings }] };
    if (mode === 'semantic') content.sentences[0].findings = findings.slice(0, 1);
    if (mode === 'repair-no-citation') content.sentences[0].findings = findings.map(({ sourceQuote: _quote, primaryDimension: _dimension, ...f }) => f);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const serverPort = 8948;
const app = spawn(process.execPath, ['server/index.mjs'], { stdio: 'ignore', env: { ...process.env,
  PORT: String(serverPort), DATA_DIR: dir, AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, AI_API_KEY: 'test-only',
  UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', ALLOW_PRIVATE_BASE_URL: '1', FREE_DAILY_IP: '10000', DAILY_SERVER_BUDGET: '10000',
} });
const origin = `http://127.0.0.1:${serverPort}`;
async function submit(kind, payload) {
  const response = await fetch(origin + '/api/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value));
  for (let i = 0; i < 80; i++) {
    const { job } = await (await fetch(origin + '/api/' + kind + '/' + value.jobId)).json();
    if (job.status === 'done') return job.data;
    assert.notEqual(job.status, 'error', job.error); await wait(100);
  }
  throw new Error('job did not complete');
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { ready = (await fetch(origin + '/api/health')).ok; } catch { /* boot */ } if (ready) break; await wait(100); }
  assert.ok(ready, 'server must start');
  const input = { direction: 'en2cn', title: 'T', chinese: source, draft, original: '测试参考译文', level: '四六级' };
  const repaired = await submit('analyze', input);
  assert.equal(repaired.overall.score, 91);
  assert.equal(repaired.chinese, source); assert.equal(repaired.draft, draft);
  assert.equal(requests.length, 3, 'one semantic review and one scoring repair at most');
  assert.match(requests[1].messages[1].content, /Many residents welcomed the plan/);
  mode = 'valid';
  const valid = await submit('analyze', input);
  assert.equal(valid.overall.score, 91); assert.equal(requests.length, 5, 'valid scoring skips scoring repair');
  assert.equal(valid.translationReview.status, 'done');
  mode = 'failed-review';
  const failed = await submit('analyze', input);
  assert.equal(failed.overall.score, null); assert.equal(failed.sentences[0].findings.length, 2);
  assert.equal(requests.length, 8, 'review is bounded even if invalid');
  mode = 'repair-no-citation';
  const recovered = await submit('analyze', { ...input, original: '' });
  assert.equal(recovered.overall.score, 91, 'repair cites a unique unchanged draft fragment even without first-pass metadata');
  assert.equal(recovered.original, '', 'free English tasks do not attach unrelated built-in references');
  assert.equal(requests.length, 11, 'missing citation metadata gets one repair');
  mode = 'semantic';
  const semantic = await submit('analyze', input);
  assert.equal(semantic.sentences[0].findings.length, 2, 'semantic review adds the missed source fact');
  assert.equal(semantic.translationReview.added, 1);
  assert.equal(semantic.overall.score, 91);
  assert.equal(semantic.ai, '不到五分之一的居民使用它。许多居民欢迎这个计划。');
  assert.equal(semantic.sentences[0].ai, semantic.ai, 'corrected teaching survives the HTTP/job pipeline');
  assert.match(semantic.advancedSentences[0], /保留数量上限/);
  assert.equal(requests.length, 13, 'reviewed valid ledger does not need a third model call');
  const quiz = await submit('quiz', { points: ['[作答语言：中文]不到五分之一'], count: 1 });
  assert.equal(quiz.questions[0].answerLanguage, 'zh');
  const grade = await submit('quiz', { mode: 'grade', items: [{ ...quiz.questions[0], userAnswer: '使用的人不到五分之一。' }] });
  assert.equal(grade.grades[0].verdict, 'right');
  console.log('PASS en2cn HTTP: bounded scoring review, unchanged source, valid scores, fallback, Chinese quiz and grading metadata');
} finally {
  const closed = once(app, 'exit'); app.kill(); await closed;
  await new Promise((r) => mock.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
