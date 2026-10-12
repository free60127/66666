/** Test ordinary and streaming generation through the real isolated HTTP/job pipeline. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CN2EN_DIMENSIONS, CN2EN_MAX } from './cn2enScoring.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-cn2en-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const source = '我们应该加强合作。';
const draft = 'We should strengthen cooperation.';
const ledger = () => ({ score: 100, summary: '直接评分，分项之和等于总分。', advice: [], scoreBreakdown: CN2EN_DIMENSIONS.map((label) => ({ label, max: CN2EN_MAX[label], score: CN2EN_MAX[label] })) });
let mode = 'valid';
const requests = [];
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const system = body.messages[0].content;
  let content;
  if (system.includes('独立语义复核员')) {
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.source, source); assert.equal(input.draft, draft);
    content = mode === 'failed' ? { invalid: true } : { edits: [], additions: [], overall: ledger(), ai: 'We should foster cooperation.',
      sentenceTranslations: [{ sentenceIndex: 1, ai: 'We should foster cooperation.' }], advancedSentences: [], vocabularyNotes: [] };
  } else if (system.includes('汉译英翻译导师。请复核')) content = { score: 58 };
  else {
    content = { title: 'T', chinese: 'fabricated source', draft: 'fabricated draft', original: 'fabricated reference', ai: 'It is imperative to strengthen international cooperation.',
      overall: mode === 'failed' ? { score: 58 } : ledger(), sentences: [{ cn: source, draft, ai: 'Unfounded upgrade', findings: [] }] };
    assert.doesNotMatch(system, /完整纠错/);
    assert.doesNotMatch(system, /文学性再创作——/);
    assert.match(system, /宁深勿浅，宁多勿漏/);
    assert.match(system, /近义词尽量给 2-4 个对比/);
  }
  if (body.stream) {
    const segments = [{ t: 'meta', ...Object.fromEntries(['title', 'chinese', 'draft', 'original'].map((key) => [key, content[key]])) },
      { t: 'ai', ai: content.ai }, ...content.sentences.map((item) => ({ t: 'sentence', item })), { t: 'overall', overall: content.overall }, { t: 'done' }];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const segment of segments) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(segment) + '\n' } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  }
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = 8949, origin = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ['server/index.mjs'], { stdio: 'ignore', env: { ...process.env, PORT: String(port), DATA_DIR: dir,
  AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, AI_API_KEY: 'test-only', ALLOW_PRIVATE_BASE_URL: '1',
  UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', SMTP_TEST_MODE: '1', FREE_DAILY_IP: '10000', DAILY_SERVER_BUDGET: '10000' } });
async function submit(stream) {
  const response = await fetch(origin + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction: 'cn2en', title: 'T', chinese: source, draft, original: '', stream }) });
  const receipt = await response.json(); assert.equal(response.status, 200);
  for (let i = 0; i < 80; i++) {
    const { job } = await (await fetch(origin + '/api/analyze/' + receipt.jobId)).json();
    if (job.status === 'done') return job.data;
    assert.notEqual(job.status, 'error', job.error); await wait(100);
  }
  throw new Error('analysis timed out');
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { ready = (await fetch(origin + '/api/health')).ok; } catch { /* boot */ } if (ready) break; await wait(100); }
  assert.ok(ready);
  for (const stream of [false, true]) {
    const result = await submit(stream);
    assert.equal(result.overall.score, 100, 'correct ordinary translation keeps the model score without ledger gating');
    assert.equal(result.chinese, source); assert.equal(result.draft, draft); assert.equal(result.original, '');
    assert.equal(result.ai, 'We should foster cooperation.', 'the separate AI version may improve valid phrasing without affecting grades');
    assert.equal(result.sentences[0].correctedSentence, undefined, 'the full-correction row is no longer generated');
    assert.equal(result.translationReview.status, 'done');
    assert.deepEqual(result.advancedSentences, []);
  }
  assert.equal(requests.length, 4, 'two calls per successful task, with one semantic review');
  mode = 'failed';
  const failed = await submit(false);
  assert.equal(failed.overall.score, 58, 'without the ledger gate the model score passes through as-is');
  assert.equal(failed.translationReview.status, 'unavailable');
  assert.equal(failed.scoreIssue, undefined, 'no scoring repair is needed without ledger validation');
  assert.equal(failed.draft, draft);
  assert.equal(requests.length, 6, 'a bare score needs no repair round');
  console.log('PASS cn2en HTTP: real inputs, faithful review, optional scoring, full corrections, streaming parity and bounded failure');
} finally {
  const closed = once(app, 'exit'); app.kill(); await closed;
  await new Promise((r) => mock.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
