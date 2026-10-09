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
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const PORT = 8947;
const MOCK_PORT = 9897;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-usage-'));

/* ---------- 假模型：任何 Key 都接受（自带 Key 的豁免由闸门逻辑保证，不靠模型） ---------- */
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: '模拟批改', overall: { score: 80, issues: 0, summary: '不错', highlights: [], advice: [] },
      sentences: [{ cn: '今天天气很好。', draft: 'The weather is nice.', ai: 'The weather is nice.', original: 'The weather is nice.', findings: [] }],
    }) } }] }));
  });
});
await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

/* ---------- 被测服务器：XFF 可信 + 收紧的额度（便于断言） ---------- */
const server = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
    AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, AI_API_KEY: 'site-key',
    FREE_DAILY_IP: '2', FREE_DAILY_ACCOUNT: '5', DAILY_SERVER_BUDGET: '4', CLASS_KEY_DAILY: '3', TRUST_PROXY_HOPS: '1' },
  stdio: 'ignore',
});
const post = (path, body, ip, apiKey) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(apiKey ? { 'X-Api-Key': apiKey } : {}) },
  body: JSON.stringify(body),
});
const codeOf = async (r) => { const j = await r.json().catch(() => ({})); return { status: r.status, error: j.error || '' }; };

let ok = true;
try {
  for (let n = 0; n < 60; n += 1) {
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

  /* ③ 换一个 IP（仍无 Key）：站点 Key 已被自己的前 2 次占满（预算 4），+自带 Key 0 次与换 IP 1 次？ */
  //  预算=4：已用 2（9.9.9.1）→ 新 IP 第一次放行（第 3 次），第二次 429 触发全网熔断文案
  const n1 = await codeOf(await post('/api/analyze', payload, '9.9.9.2'));
  const n2 = await codeOf(await post('/api/analyze', payload, '9.9.9.2'));
  check('③ 全网熔断：第二个 IP 的站点 Key 请求 429', n1.status === 429 && n2.status === 429, `n1=${n1.status} n2=${n2.status} msg=${n1.error.slice(0, 40)}`);
  check('③ 熔断文案区分全网额度', /全网免费额度/.test(n1.error));

  /* ④ /api/status 暴露 usage */
  const st = await fetch(`http://127.0.0.1:${PORT}/api/status`).then((r) => r.json());
  check('④ status.usage 今日计数与预算', typeof st.usage?.serverKey === 'number' && st.usage.budget === 4 && st.usage.day.length === 10, JSON.stringify(st.usage));
} catch (e) {
  ok = false;
  console.error('测试异常:', e.message);
} finally {
  server.kill();
  mock.close();
}

for (const r of results) if (!r.ok) { ok = false; }
console.log(ok ? '✅ 公共额度闸门：IP 额度 / 自带 Key 豁免 / 全网熔断 / status usage 测试通过' : '❌ 有失败项');
process.exit(ok ? 0 : 1);
