/**
 * API Key 归一化测试。
 *
 * 为什么要单独一条：线上实测踩到了 —— 在部署平台的环境变量框里粘贴 Key 时，
 * 把界面上的"必填"标记一起粘了进去（实际值 `sk-…dff 必`，比正常值多两个字符）。
 * 表现不是"认证失败"，而是 undici 的 fetch 直接抛
 *
 *     Cannot convert argument to a ByteString because the character at index 43 …
 *
 * 用户看到的是一句完全不知所云的英文；而 `/api/status` 的 hasKey 仍是 true，
 * 从状态接口完全看不出问题。所以这里用**脏 key 起服务**，断言真正发往模型接口的
 * Authorization 头是干净的，并且任务能正常跑完。
 *
 * 跑法：node server/apikey.test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8971;
const MOCK_PORT = 8985;   // 故意离 PORT 远一点：第二/第三个实例用 PORT+1 / PORT+2
const CLEAN = 'sk-d7a06c268f284b9e8454921231912dff';
const DIRTY = CLEAN + ' 必';           // 线上实测到的形态：干净 key + 空格 + "必"
const DIRTY_TAB = ' ' + CLEAN + '\n';  // 另一种常见形态：首尾空白

/** 桩模型接口：记录收到的 Authorization 头 */
const seen = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ auth: req.headers.authorization || '(无)', bytes: body.length });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

console.log('=== API Key 归一化测试 ===\n');

/* ---------- 0. 先确认这个错误真的会发生在"不归一化"的情况下 ---------- */
{
  let msg = '';
  try {
    void new Headers({ Authorization: 'Bearer ' + DIRTY });
  } catch (e) { msg = e.message; }
  check('复现：脏 key 直接放进请求头会抛 ByteString 错（就是线上那句）',
    /ByteString/.test(msg) && /index 43/.test(msg), msg.slice(0, 80));
}

/* ---------- 1. 脏 key 起服务：发出去必须是干净的，且任务能跑完 ---------- */
{
  seen.length = 0;
  const app = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env, PORT: String(PORT),
      AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      AI_API_KEY: DIRTY,                 // ← 故意脏
      ALLOW_PRIVATE_BASE_URL: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  app.stdout.on('data', (d) => { logs += d.toString(); });
  app.stderr.on('data', (d) => { logs += d.toString(); });

  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* 等 */ }
    if (!up) await sleep(300);
  }
  check('服务端能起来（脏 key 不该让进程起不来）', up);

  const status = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
  check('hasKey 仍然是 true（归一到非空）', status.hasKey === true);

  // 等启动横幅把警告打出来
  await sleep(300);
  check('启动日志里有明确的警告，不是静默清理', /AI_API_KEY 里混进了非 ASCII/.test(logs), logs.split('\n').filter((l) => l.includes('⚠️'))[0] || '(没找到警告)');

  // 匿名访客提交（不带自己的 key → 用服务端那把脏的）
  const resp = await fetch(`http://127.0.0.1:${PORT}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 't', chinese: '中文', draft: 'draft' }),
  }).then((r) => r.json());
  check('任务被受理', Boolean(resp.jobId), JSON.stringify(resp).slice(0, 80));

  let job = null;
  for (let i = 0; i < 40; i += 1) {
    job = (await (await fetch(`http://127.0.0.1:${PORT}/api/analyze/${resp.jobId}`)).json()).job;
    if (job && (job.status === 'done' || job.status === 'error')) break;
    await sleep(200);
  }
  check('任务正常跑完（不再报 ByteString 错）', job && job.status === 'done' && !/ByteString/.test(job.error || ''),
    job ? `${job.status}: ${String(job.error || '').slice(0, 60)}` : '(无响应)');
  check('真正发往模型接口的 Authorization 是干净的 key',
    seen.length > 0 && seen[0].auth === 'Bearer ' + CLEAN,
    `收到 ${seen.length} 次请求，auth=${(seen[0] && seen[0].auth || '').replace(/sk-(.{6}).*/, 'sk-$1…')}`);
  check('请求体非空（确实发起了真实调用）', Boolean(seen[0] && seen[0].bytes > 10), `bytes=${seen[0] && seen[0].bytes}`);

  app.kill();
}

/* ---------- 2. 首尾空白形态同样被清理 ---------- */
{
  seen.length = 0;
  const app = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env, PORT: String(PORT + 1),
      AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      AI_API_KEY: DIRTY_TAB,             // 前后空格 + 换行
      ALLOW_PRIVATE_BASE_URL: '1',
    },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { up = (await fetch(`http://127.0.0.1:${PORT + 1}/api/health`)).ok; } catch { /* 等 */ }
    if (!up) await sleep(300);
  }
  check('第二个实例（首尾空白场景）正常启动', up);
  await fetch(`http://127.0.0.1:${PORT + 1}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 't', chinese: '中文', draft: 'draft' }),
  });
  await sleep(1500);
  check('首尾空白/换行也被清理', seen.length > 0 && seen[0].auth === 'Bearer ' + CLEAN,
    `auth=${(seen[0] && seen[0].auth || '').replace(/sk-(.{6}).*/, 'sk-$1…')}`);
  app.kill();
}

/* ---------- 3. 干净的 key 不受影响（不能把正常配置改坏） ---------- */
{
  seen.length = 0;
  const app = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env, PORT: String(PORT + 2),
      AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      AI_API_KEY: CLEAN,
      ALLOW_PRIVATE_BASE_URL: '1',
    },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { up = (await fetch(`http://127.0.0.1:${PORT + 2}/api/health`)).ok; } catch { /* 等 */ }
    if (!up) await sleep(300);
  }
  check('第三个实例（干净 key 场景）正常启动', up);
  await fetch(`http://127.0.0.1:${PORT + 2}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 't', chinese: '中文', draft: 'draft' }),
  });
  await sleep(1500);
  check('干净的 key 原样发出（未被改动）', seen.length > 0 && seen[0].auth === 'Bearer ' + CLEAN,
    `auth=${(seen[0] && seen[0].auth || '').replace(/sk-(.{6}).*/, 'sk-$1…')}`);
  app.kill();
}

mock.close();
console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
