/** Real HTTP and browser quota/class-key journeys, with isolated storage and fake AI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';


const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-class-quota-'));
const seen = [];
let delay = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: '测试练习', overall: { score: 85, issues: 0, summary: '正确', highlights: [], advice: [] },
        sentences: [{ cn: '我今天读书。', draft: 'I read today.', ai: 'I read today.', original: 'I read today.', findings: [] }],
        questions: [{ type: '选择', question: 'Choose', options: ['A. read', 'B. reads'], answer: 'A', explanation: 'Correct' }],
      }) } }] }));
    }, delay);
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const provider = `http://127.0.0.1:${mock.address().port}`;
// Test-only transport interception: keep production's fixed DeepSeek destination
// and assertions intact while guaranteeing no real teacher key/model is contacted.
const preload = path.join(dir, 'mock-provider.mjs');
fs.writeFileSync(preload, `const original = globalThis.fetch;
globalThis.fetch = (url, options) => original(String(url).replace('https://api.deepseek.com', ${JSON.stringify(provider)}), options);`);
const probe = http.createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const server = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'server/index.mjs'], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, EMAIL_VERIFY: '0',
    UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', AI_BASE_URL: provider + '/v1', AI_API_KEY: 'site-fake',
    ALLOW_PRIVATE_BASE_URL: '1', TRUST_PROXY_HOPS: '1', RATE_LIMIT_PER_MIN: '200',
    FREE_DAILY_ACCOUNT: '3', FREE_DAILY_IP: '2', DAILY_SERVER_BUDGET: '100', CLASS_KEY_DAILY: '3',
    MAX_INFLIGHT_JOBS: '4', MAX_QUEUED_JOBS: '0' }, stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;
const request = async (url, body, token = '', ip = '192.0.2.1') => {
  const r = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...await r.json(), status: r.status };
};
const complete = async (route, reply) => {
  assert.equal(reply.status, 200, JSON.stringify(reply));
  for (let i = 0; i < 100; i++) {
    const r = await request(route + '/' + reply.jobId);
    if (r.job?.status === 'done') return r;
    assert.notEqual(r.job?.status, 'error', JSON.stringify(r));
    if (r.job?.error) throw new Error(r.job.error);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('mock job timeout');
};
const payload = { chinese: '我今天读书。', draft: 'I read today.', model: 'deepseek-chat' };
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(base + '/api/health')).ok; } catch { /* starting */ }
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready);
  const beforeAttack = seen.length;
  assert.equal((await request('/api/ocr', { image: 'not-an-image' })).status, 400);
  const attack = await request('/api/ocr', { image: 'data:image/png;base64,aGVsbG8=', visionBaseUrl: 'https://8.8.8.8/v1' });
  assert.equal(attack.status, 400); assert.match(attack.error, /必须同时填写/);
  assert.equal(seen.length, beforeAttack);
  assert.equal((await request('/api/status')).usage.serverKey, 0);
  console.log('PASS OCR 自定义视觉地址不能携带站点密钥，也不扣额度');
  const teacher = await request('/api/auth/teacher-register', { email: 'teacher@example.com', password: 'class-pass-123' });
  assert.equal(teacher.status, 201);
  const room = (await request('/api/classes', { name: '额度测试班' }, teacher.token)).class;
  const student = await request('/api/classes/join', { code: room.inviteCode, name: '学生', studentNo: 'Q001' });
  const membership = { classId: room.id, studentKey: student.studentKey };
  assert.equal((await request(`/api/classes/${room.id}/apikey`, { apiKey: 'sk-class-fake' }, teacher.token)).status, 200);
  const publicDashboard = await request(`/api/classes/${room.id}/student-dashboard`, { studentKey: student.studentKey });
  assert.equal(publicDashboard.hasClassKey, true);
  assert(!JSON.stringify(publicDashboard).includes('sk-class-fake'));
  await complete('/api/analyze', await request('/api/analyze', { ...payload, classes: [membership], baseUrl: 'https://attacker.invalid' }));
  assert.equal(seen.at(-1).auth, 'Bearer sk-class-fake');
  assert.equal(seen.at(-1).body.model, 'deepseek-chat');
  await complete('/api/generate-material', await request('/api/generate-material', { topic: '读书', classes: [membership] }));
  assert.equal(seen.at(-1).auth, 'Bearer sk-class-fake');
  await complete('/api/quiz', await request('/api/quiz', { points: ['read'], count: 1, classes: [membership] }));
  assert.equal(seen.at(-1).auth, 'Bearer sk-class-fake');
  const blocked = await request('/api/ocr', { image: 'data:image/png;base64,aGVsbG8=', classes: [membership] });
  assert.equal(blocked.status, 429); assert.match(blocked.error, /班级/);
  assert.equal((await request('/api/status')).usage.serverKey, 0);
  await complete('/api/analyze', await request('/api/analyze', { ...payload, classes: [membership], apiKey: 'sk-own-fake' }));
  assert.equal(seen.at(-1).auth, 'Bearer sk-own-fake');
  // Own vision key must bypass an exhausted class/site pool too.
  const ownVision = await request('/api/ocr', { image: 'data:image/png;base64,aGVsbG8=', classes: [membership], visionApiKey: 'sk-vision-fake', visionBaseUrl: provider + '/v1' });
  await complete('/api/ocr', ownVision);
  assert.equal(seen.at(-1).auth, 'Bearer sk-vision-fake');
  const visionRoom = (await request('/api/classes', { name: '识别测试班' }, teacher.token)).class;
  const visionStudent = await request('/api/classes/join', { code: visionRoom.inviteCode, name: '识别学生', studentNo: 'V001' });
  await request(`/api/classes/${visionRoom.id}/apikey`, { apiKey: 'sk-class-vision-fake' }, teacher.token);
  await complete('/api/ocr', await request('/api/ocr', {
    image: 'data:image/png;base64,aGVsbG8=',
    classes: [{ classId: visionRoom.id, studentKey: visionStudent.studentKey }],
    visionBaseUrl: 'https://attacker.invalid',
  }));
  assert.equal(seen.at(-1).auth, 'Bearer sk-class-vision-fake');
  assert.equal(seen.at(-1).body.model, 'deepseek-flash');
  assert.ok(seen.at(-1).body.messages[0].content.some((item) => item.type === 'image_url'));
  assert.equal((await request('/api/status')).usage.serverKey, 0);
  console.log('PASS 教师 Key 实际送达模型：批改/素材/自测/识别共用班级额度；个人/视觉 Key 优先；不泄露密钥且不能劫持地址');

  await complete('/api/analyze', await request('/api/analyze', { ...payload, classes: [{ ...membership, studentKey: 'f'.repeat(64) }] }));
  assert.equal(seen.at(-1).auth, 'Bearer site-fake');
  const user = await request('/api/auth/register', { email: 'student@example.com', password: 'student-pass-123' });
  for (let i = 0; i < 3; i++) await complete('/api/analyze', await request('/api/analyze', payload, user.token));
  assert.equal((await request('/api/analyze', payload, user.token)).status, 429);
  assert.equal((await request('/api/analyze', payload, 'invalid-token')).status, 401);
  assert.equal((await request('/api/analyze', { chinese: '空初稿' })).status, 400);
  assert.equal((await request('/api/status')).usage.serverKey, 4);
  console.log('PASS 非成员回落站点 Key、账号独立 3 次、失效登录 401、无效输入和超额请求不扣全网额度');

  await request(`/api/classes/${room.id}/apikey`, { apiKey: '' }, teacher.token);
  await complete('/api/analyze', await request('/api/analyze', { ...payload, classes: [membership] }, '', '192.0.2.3'));
  assert.equal(seen.at(-1).auth, 'Bearer site-fake');
  await request(`/api/classes/${room.id}/apikey`, { apiKey: 'sk-restored-fake' }, teacher.token);
  await request(`/api/classes/${room.id}/archive`, {}, teacher.token);
  await complete('/api/analyze', await request('/api/analyze', { ...payload, classes: [membership] }, '', '192.0.2.4'));
  assert.equal(seen.at(-1).auth, 'Bearer site-fake');
  console.log('PASS 清除/归档班级后不再使用教师 Key');

  // Browser submits the real frontend request, so this catches omitted Authorization.
  if (!process.argv.includes('--http-only')) {
    const { chromium, devices } = await import('./shotter/node_modules/playwright/index.mjs');
    browser = await chromium.launch();
    for (const profile of [{ viewport: { width: 1360, height: 900 } }, devices['Pixel 7'], devices['iPhone 13']]) {
      const context = await browser.newContext(profile);
      const page = await context.newPage();
      await page.addInitScript(({ token, user }) => { localStorage.setItem('bt-goal', 'cet'); localStorage.setItem('bt-acct-token', token); localStorage.setItem('bt-acct-user', JSON.stringify(user)); }, user);
      await page.goto(base);
      await page.getByRole('button', { name: '自由模式', exact: true }).click();
      await page.locator('textarea').nth(0).fill(payload.chinese);
      await page.locator('textarea').nth(1).fill(payload.draft);
      const response = page.waitForResponse((r) => r.url().endsWith('/api/analyze') && r.request().method() === 'POST');
      await page.getByRole('button', { name: '生成完整回译训练作业' }).click();
      const r = await response;
      assert.equal(r.status(), 429);
      assert.equal(r.request().headers().authorization, 'Bearer ' + user.token);
      await page.getByText(/今日免费额度已用完/).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await context.close();
    }
    console.log('PASS 桌面/Pixel/iPhone 浏览器：登录练习携带身份、超额提示可见、页面不横向溢出');
  }

  delay = 1500;
  const before = (await request('/api/status')).usage.serverKey;
  const batch = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/api/analyze', payload, '', '198.51.100.' + i)));
  assert.equal(batch.filter((r) => r.status === 200).length, 4);
  assert.equal(batch.filter((r) => r.status === 503).length, 4);
  assert.equal((await request('/api/status')).usage.serverKey, before + 4);
  console.log('PASS 并发队列满：4 接纳/4 拒绝，只扣 4 次额度');
} finally {
  await browser?.close();
  const exited = server.exitCode === null ? new Promise((r) => server.once('exit', r)) : Promise.resolve();
  server.kill(); await exited;
  await new Promise((r) => mock.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
