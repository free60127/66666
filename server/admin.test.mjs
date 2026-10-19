/** 管理统计：密钥门槛、三项核心指标、游客去重与批改计数埋点。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-admin-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const source = 'Nice weather today.';
const draft = '今天天气真好。';
let requests = 0;
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  JSON.parse(raw); requests++;
  const content = { title: 'T', chinese: source, draft, ai: '今天天气不错。', original: '',
    overall: { score: 98, summary: '很好。', advice: [], scoreBreakdown: [
      { label: '理解准确', score: 40, max: 40, comment: 'ok' }, { label: '表达地道', score: 15, max: 15, comment: 'ok' },
      { label: '语体得当', score: 10, max: 10, comment: 'ok' }, { label: '流畅度', score: 10, max: 10, comment: 'ok' },
      { label: '完整性', score: 23, max: 25, comment: 'ok' }] },
    sentences: [{ cn: source, draft, ai: '今天天气不错。', findings: [] }] };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = 8951, origin = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ['server/index.mjs'], { stdio: 'ignore', env: { ...process.env,
  PORT: String(port), DATA_DIR: dir, AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, AI_API_KEY: 'test-only',
  ADMIN_KEY: 'secret-key-123', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', ALLOW_PRIVATE_BASE_URL: '1',
  SMTP_TEST_MODE: '1', EMAIL_VERIFY: '0', FREE_DAILY_IP: '10000', FREE_DAILY_ACCOUNT: '10000', DAILY_SERVER_BUDGET: '10000' } });
async function get(p, headers = {}) {
  const r = await fetch(origin + p, { headers });
  return { status: r.status, body: await r.json() };
}
async function analyze() {
  const r = await fetch(origin + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction: 'en2cn', title: 'T', chinese: source, draft, level: '四六级' }) });
  const { jobId } = await r.json(); assert.equal(r.status, 200);
  for (let i = 0; i < 80; i++) {
    const { job } = await (await fetch(origin + '/api/analyze/' + jobId)).json();
    if (job.status === 'done') return job.data;
    assert.notEqual(job.status, 'error', job.error); await wait(100);
  }
  throw new Error('analyze timed out');
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { ready = (await fetch(origin + '/api/health')).ok; } catch { /* boot */ } if (ready) break; await wait(100); }
  assert.ok(ready);

  // 未配置/密钥错误一律拒绝
  const noServer = { status: null, body: null };
  assert.equal((await get('/api/admin/stats', { 'x-admin-key': 'wrong' })).status, 403);
  const ok = await get('/api/admin/stats', { 'x-admin-key': 'secret-key-123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.users.total, 0, 'no accounts yet');
  assert.equal(ok.body.guests.total, 0);
  assert.equal(ok.body.grading.total, 0);

  // 一次游客批改 → 游客去重 +1、批改 +1
  const done = await analyze();
  assert.equal(done.overall.score, 98);
  const stats = await get('/api/admin/stats', { 'x-admin-key': 'secret-key-123' });
  assert.equal(stats.body.guests.total, 1, 'one unique guest IP');
  assert.equal(stats.body.guests.today, 1);
  assert.equal(stats.body.grading.total, 1);
  assert.equal(stats.body.grading.today, 1);
  assert.ok(stats.body.jobs.retained >= 1);
  assert.ok(stats.body.storage.keys > 0);

  // 同一 IP 再批改：游客数不涨，批改次数涨
  await analyze();
  const stats2 = await get('/api/admin/stats', { 'x-admin-key': 'secret-key-123' });
  assert.equal(stats2.body.guests.total, 1, 'same IP is not counted twice');
  assert.equal(stats2.body.grading.total, 2);

  // 注册一个账号：今日新增注册 +1，用户总数 +1
  const reg = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'student@test.com', password: 'password123', nickname: '测试' }) });
  assert.equal(reg.status, 201, JSON.stringify(await reg.json()));
  const stats3 = await get('/api/admin/stats', { 'x-admin-key': 'secret-key-123' });
  assert.equal(stats3.body.users.total, 1);
  assert.equal(stats3.body.users.today, 1, 'today registrations counted');

  // 趋势：批改与新增用户两个序列都包含今天
  const trends = await get('/api/admin/trends?days=30', { 'x-admin-key': 'secret-key-123' });
  assert.equal(trends.status, 200);
  const today = stats3.body.day;
  const gToday = trends.body.gradings.find((p) => p.day === today);
  const uToday = trends.body.newUsers.find((p) => p.day === today);
  assert.ok(gToday && gToday.n >= 2, 'grading trend includes today');
  assert.ok(uToday && uToday.n >= 1, 'new-user trend includes today');
  assert.equal(trends.body.gradings.length, 30);

  // 明细：两份批改、方向与分数齐全
  const gradings = await get('/api/admin/gradings?limit=100', { 'x-admin-key': 'secret-key-123' });
  assert.equal(gradings.status, 200);
  assert.equal(gradings.body.total, 2);
  assert.equal(gradings.body.rows.length, 2);
  assert.equal(gradings.body.rows[0].d, 'en2cn');
  assert.equal(gradings.body.rows[0].s, 98);
  assert.ok(gradings.body.rows[0].t > 0);

  // 限流桶正常工作（31 次连续查询后应有一次 429）
  let saw429 = false;
  for (let i = 0; i < 35; i++) {
    const r = await get('/api/admin/stats', { 'x-admin-key': 'secret-key-123' });
    if (r.status === 429) { saw429 = true; break; }
  }
  assert.ok(saw429, 'admin stats must be rate limited');
  console.log('PASS admin stats: key gate, guest dedupe, grading counters, rate limited');
} finally {
  const closed = once(app, 'exit'); app.kill(); await closed;
  await new Promise((r) => mock.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
