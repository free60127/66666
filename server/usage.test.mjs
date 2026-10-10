/**
 * 公共额度闸门测试：真实 HTTP + 假模型，不花一分钱 AI 额度。
 *
 * 覆盖：
 *   ① 未登录按 IP 计：免费额度用完返回 429（文案可操作）
 *   ② 自带 Key 不计数、不受限
 *   ③ 全局熔断：预算耗尽后全网 429
 *   ④ /api/status 暴露 usage（今日站点 Key 次数 / 预算）
 *
 * 跑法：node server/usage.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createFileKv, createUpstashKv } from './kv.mjs';
import { reserveDailyQuota, usageDay } from './usage.mjs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const probe = http.createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const PORT = probe.address().port;
await new Promise((r) => probe.close(r));
let MOCK_PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-usage-'));

/* ---------- 假模型：任何 Key 都接受（自带 Key 的豁免由闸门逻辑保证，不靠模型） ---------- */
const mock = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: '模拟批改', overall: { score: 80, issues: 0, summary: '不错', highlights: [], advice: [] },
      sentences: [{ cn: '今天天气很好。', draft: 'The weather is nice.', ai: 'The weather is nice.', original: 'The weather is nice.', findings: [] }],
    }) } }] }));
  });
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));

MOCK_PORT = mock.address().port;

/* ---------- 被测服务器：XFF 可信 + 收紧的额度（便于断言） ---------- */
const server = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
    AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, AI_API_KEY: 'site-key',
    FREE_DAILY_IP: '2', FREE_DAILY_ACCOUNT: '5', DAILY_SERVER_BUDGET: '4', CLASS_KEY_DAILY: '3', TRUST_PROXY_HOPS: '1', EMAIL_VERIFY: '0', ALLOW_PRIVATE_BASE_URL: '1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let startupError = '';
server.stderr.on('data', (chunk) => { startupError += chunk; });
const post = (path, body, ip, apiKey) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(apiKey ? { 'X-Api-Key': apiKey } : {}) },
  body: JSON.stringify(body),
});
const codeOf = async (r) => { const j = await r.json().catch(() => ({})); return { status: r.status, error: j.error || '' }; };

// Concurrent attempts, zero limit, day rollover and store outage.
const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-quota-unit-'));
try {
  const kv = createFileKv(unitDir);
  const now = Date.parse('2026-10-10T15:59:59Z');
  assert.equal(usageDay(now), '2026-10-10');
  assert.equal(usageDay(now + 1000), '2026-10-11');
  const pools = [{ key: 'personal', limit: 3 }, { key: 'global', limit: 5 }];
  const replies = await Promise.all(Array.from({ length: 20 }, () => reserveDailyQuota(kv, pools)));
  assert.equal(replies.filter((r) => !r.blocked).length, 3);
  assert.equal(await kv.get('global'), '3');
  assert.equal((await reserveDailyQuota(kv, [{ key: 'zero', limit: 0 }])).blocked, 1);
  assert.equal(await kv.get('zero'), null);
  assert.equal((await reserveDailyQuota({ reserveQuota() { throw new Error('offline'); } }, pools)).failed, true);
  // Verify Redis transport uses a single EVAL, and preserves failed-store semantics.
  const oldFetch = globalThis.fetch;
  let command;
  try {
    globalThis.fetch = async (_url, opts) => { command = JSON.parse(opts.body); return new Response(JSON.stringify({ result: [0, 1, 1] })); };
    const redis = createUpstashKv({ url: 'https://mock.invalid', token: 'fake' });
    assert.equal((await reserveDailyQuota(redis, pools, now)).blocked, 0);
    assert.equal(command[0], 'EVAL'); assert.equal(command[2], '2'); assert.equal(command[5], '1');
  } finally { globalThis.fetch = oldFetch; }
  check('并发/零额度/北京时间跨日/存储故障/Redis 单命令', true);
} finally { fs.rmSync(unitDir, { recursive: true, force: true }); }
let ok = true;
try {
  for (let n = 0; n < 60; n += 1) {
    if (server.exitCode !== null) throw new Error('server exited: ' + startupError.slice(-1200));
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  const payload = { chinese: '今天天气很好，我们去公园吧。', draft: 'The weather is nice today. Let us go to the park.', direction: 'cn2en' };

  /* ① 未登录按 IP：前 2 次放行（站点 Key 代跑），第 3 次 429 */
  const r1 = await codeOf(await post('/api/analyze', payload, '9.9.9.1'));
  const r2 = await codeOf(await post('/api/analyze', payload, '9.9.9.1'));
  const r3 = await codeOf(await post('/api/analyze', payload, '9.9.9.1'));
  check('① 未登录免费额度 2 次/IP：第 3 次 429', r1.status === 200 && r2.status === 200 && r3.status === 429, `r1=${r1.status} r2=${r2.status} r3=${r3.status} msg=${r3.error.slice(0, 40)}`);
  check('① 429 文案可操作（提及免费额度/自带 Key）', /免费体验|免费额度/.test(r3.error) && /Key/.test(r3.error));

  /* ② 自带 Key：完全不限，也不占全网预算 */
  const own = [];
  for (let i = 0; i < 4; i += 1) own.push((await codeOf(await post('/api/analyze', { ...payload, apiKey: 'own-key-1' }, '9.9.9.1'))).status);
  check('② 自带 Key 连续 4 次全部放行', own.every((s) => s === 200), own.join(','));

  /* ③ 被拒绝的请求不会占用预算；新 IP 可再用 2 次，随后全网熔断。 */
  const n1 = await codeOf(await post('/api/analyze', payload, '9.9.9.2'));
  const n2 = await codeOf(await post('/api/analyze', payload, '9.9.9.2'));
  check('③ 超额请求不吞全网额度：另一个 IP 仍可使用两次', n1.status === 200 && n2.status === 200, `n1=${n1.status} n2=${n2.status} msg=${n1.error.slice(0, 40)}`);
  const n3 = await codeOf(await post('/api/analyze', payload, '9.9.9.3'));
  check('③ 熔断文案区分全网额度', n3.status === 429 && /全网免费额度/.test(n3.error));

  /* ④ /api/status 暴露 usage */
  const st = await fetch(`http://127.0.0.1:${PORT}/api/status`).then((r) => r.json());
  check('④ status.usage 今日计数与预算', typeof st.usage?.serverKey === 'number' && st.usage.budget === 4 && st.usage.day.length === 10, JSON.stringify(st.usage));
} catch (e) {
  ok = false;
  console.error('测试异常:', e.message);
} finally {
  const exited = server.exitCode === null && server.signalCode === null ? new Promise((resolve) => server.once('exit', resolve)) : Promise.resolve();
  server.kill();
  await exited;
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

for (const r of results) if (!r.ok) { ok = false; }
console.log(ok ? '✅ 公共额度闸门：IP 额度 / 自带 Key 豁免 / 全网熔断 / status usage 测试通过' : '❌ 有失败项');
process.exit(ok ? 0 : 1);
