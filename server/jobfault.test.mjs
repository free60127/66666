/**
 * 后台任务异常不能带走整个服务（P0 回归）。
 *
 * 背景：四条任务链路都是 `runXxxJob(jobId, …)` **即发即忘**地调用的，全程没有 .catch()。
 * 而 Node 15+ 对未处理的 Promise 拒绝默认是**直接结束进程** ——
 * 一次 KV 抖动就足以让整个服务重启，把所有正在跑的 30-120 秒任务一起带走
 * （用户看到「生成中」永远转圈，模型调用也已经花掉钱了）。
 *
 * 跑法：node server/jobfault.test.mjs
 * 原理：用 FAULT_INJECT=findJob:1 让任务入口的第一次 findJob 抛错（只影响这一次），
 *       如果没修，进程会当场退出；修好后进程存活、任务被标成 error 且有可读原因。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8951;
const MOCK_PORT = 9891;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-jobfault-'));

console.log('=== 任务异常兜底测试 ===\n');

const mock = http.createServer((req, res) => {
  req.on('data', () => { /* 请求体用不上，读掉即可 */ });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: 'T', chinese: '中', draft: 'd', ai: 'a', original: 'o',
      overall: { score: 80, issues: 1 },
      sentences: [{ cn: 'a', draft: 'b', ai: 'c', original: 'd', findings: [] }],
    }) } }] }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  AI_API_KEY: 'mock',
  ALLOW_PRIVATE_BASE_URL: '1',
  FAULT_INJECT: 'findJob:1', // 只让第 1 次 findJob 抛错
};
let server = null;
const stop = () => new Promise((r) => { if (!server) return r(); server.once('exit', r); server.kill(); setTimeout(r, 1200); });
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return { status: r.status, body: await r.json().catch(() => ({})) }; };

try {
  server = spawn(process.execPath, ['server/index.mjs'], { env, stdio: 'ignore' });
  let exited = false;
  server.on('exit', () => { exited = true; });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch { /* 还没起来 */ }
    await sleep(300);
  }
  check('服务端已启动', (await get('/api/health')).status === 200);

  // 触发任务（第一次 findJob 会抛错）
  const resp = await fetch(`http://127.0.0.1:${PORT}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'T', chinese: '中', draft: 'd' }),
  });
  const { jobId } = await resp.json();
  check('任务已受理', Boolean(jobId), jobId);

  await sleep(2500);

  // ① 进程必须还活着（修复前这里 Node 会因为 unhandledRejection 直接退出）
  check('★ 任务入口抛异常后**进程仍然存活**', !exited && (await get('/api/health').catch(() => ({ status: 0 }))).status === 200, exited ? '进程已退出' : 'alive');

  // ② 任务要落到 error（而不是一直 pending/running 让用户干等）
  const job = await get('/api/analyze/' + jobId);
  check('★ 该任务被标记为 error（用户看到明确失败，不是一直转圈）', job.body.job && job.body.job.status === 'error', JSON.stringify(job.body.job && { status: job.body.job.status }));
  check('错误信息可读且带原因', /服务端任务异常/.test(String(job.body.job && job.body.job.error || '')), String(job.body.job && job.body.job.error || '').slice(0, 60));

  // ③ 后续任务照常工作（故障是一次性的，服务没有被"带坏"）
  const resp2 = await fetch(`http://127.0.0.1:${PORT}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'T2', chinese: '中', draft: 'd' }),
  });
  const { jobId: jobId2 } = await resp2.json();
  let status2 = '';
  for (let i = 0; i < 40; i += 1) {
    const j = await get('/api/analyze/' + jobId2);
    status2 = (j.body.job && j.body.job.status) || '';
    if (status2 === 'done' || status2 === 'error') break;
    await sleep(250);
  }
  check('故障之后新任务能正常跑完（不是"服务半死"）', status2 === 'done', status2);
} catch (e) {
  check('脚本执行未抛错', false, e && e.message);
} finally {
  await stop();
  mock.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  console.log('\n' + '='.repeat(60));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
  if (failed.length) {
    for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? '  — ' + f.detail : ''));
    process.exitCode = 1;
  }
}
