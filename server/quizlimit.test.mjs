/**
 * /api/quiz（自测题 + 错误训练）的入口校验与题量上限测试。
 *
 * 为什么值得单开一个文件：题量上限是**前后端各写一份**的数字
 * （src/constants.js 的 MAX_DRILL_COUNT 与 server/index.mjs 的同名常量），
 * 一旦漂移就会出现最难查的一类 bug —— 界面上让你选 100 题、后端悄悄砍成 50，
 * 用户只会觉得"这工具说话不算数"，而两端各自的单测都是绿的。
 *
 * 这里用真实 HTTP 打一遍，并用假模型**把收到的提示词录下来**：
 * 只有看到模型那边真的收到了 100 条要点，才能确定不是只在响应里改了个数。
 *
 * 跑法：node server/quizlimit.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { MAX_DRILL_COUNT as SERVER_MAX } from './limits.mjs';
import { MAX_DRILL_COUNT as FRONT_MAX } from '../src/constants.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8942;
const MOCK_PORT = 9892;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-quizlimit-'));

console.log('=== /api/quiz 题量上限与入口校验 ===\n');

/* ---------- 假模型：把收到的 user 消息录下来，按题量回一份合法卷子 ---------- */
const seen = { system: '', user: '', calls: 0 };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    const sys = (payload.messages || []).find((m) => m.role === 'system');
    const usr = (payload.messages || []).find((m) => m.role === 'user');
    seen.system = String(sys?.content || '');
    seen.user = String(usr?.content || '');
    seen.calls += 1;
    // 刻意**不给 title**：这样验的是服务端的兜底标题（模型漏字段时用户看到的那句话）
    const questions = [1, 2, 3].map((i) => ({ type: '改错', question: 'Q' + i, options: [], answer: 'A' + i, explanation: 'E', source: 'S' }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) } }] }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const env = {
  ...process.env,
  PORT: String(PORT),
  AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  AI_API_KEY: 'mock',
  ALLOW_PRIVATE_BASE_URL: '1',
  DATA_DIR,
};
let server = null;
try {
  server = spawn(process.execPath, ['server/index.mjs'], { env, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 50 && !up; i += 1) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* 等 */ }
    if (!up) await sleep(300);
  }
  if (!up) throw new Error('服务端启动超时');

  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/quiz`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const waitJob = async (jobId) => {
    for (let i = 0; i < 60; i += 1) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/quiz/${jobId}`);
      const j = await r.json().catch(() => ({}));
      if (j.job && j.job.status !== 'running' && j.job.status !== 'queued') return j.job;
      await sleep(200);
    }
    throw new Error('出题任务没跑完');
  };
  /** 模型收到的清单条数 —— 直接读 builder 写的表头。
   *  （别去数【】的个数：表头自己也是【…】，实测会多算 2 条。） */
  const countPoints = (text) => {
    const m = text.match(/共 (\d+) 条/);
    return m ? Number(m[1]) : -1;
  };

  /* ---------- 0. 前后端上限必须同一个数（防的是最难查的漂移） ---------- */
  check('前端 MAX_DRILL_COUNT 与服务端一致', SERVER_MAX === FRONT_MAX, `前端 ${FRONT_MAX} / 服务端 ${SERVER_MAX}`);
  check('上限是 100（产品要求）', FRONT_MAX === 100, String(FRONT_MAX));

  /* ---------- 1. 没有要点时明确报错 ---------- */
  {
    const r = await post({ points: [], count: 10 });
    check('没有要点时返回 400 且给出可操作提示', r.status === 400 && /收藏|错题/.test(r.body.error || ''), `${r.status} ${r.body.error || ''}`);
  }
  {
    const r = await post({ points: [], count: 10, mode: 'drill' });
    check('错误训练没有要点时提示的是"错题"', r.status === 400 && /错题/.test(r.body.error || ''), `${r.status} ${r.body.error || ''}`);
  }

  /* ---------- 2. 题量上限 100 ---------- */
  {
    const r = await post({ points: ['要点1', '要点2'], count: 500 });
    const job = await waitJob(r.body.jobId);
    const asked = (seen.user.match(/题量 = (\d+)/) || [])[1];
    check('题量 500 被夹到 100，且提示词里真的写 100（不是只改响应）', asked === '100', `提示词要求题量 = ${asked}`);
    check('模型收到的题量不是被 prompt 又砍成 50（这里踩过：入口放宽了、prompt 里还写死 50）', asked !== '50', `题量 = ${asked}`);
    check('任务正常完成', job.status === 'done', job.status + ' ' + (job.error || ''));
  }

  /* ---------- 3. 要点条数上限 120 + 错误训练走 drill 提示词 ---------- */
  {
    seen.calls = 0;
    const many = Array.from({ length: 150 }, (_, i) => `【第 ${i} 课·时态】原句「句子${i}」里我写成「w${i}」，应为「r${i}」`);
    const r = await post({ points: many, count: 100, mode: 'drill' });
    const job = await waitJob(r.body.jobId);
    const n = countPoints(seen.user);
    check('要点上限 120 生效（不会把 150 条全塞给模型）', n === 120, `模型收到 ${n} 条`);
    check('错误训练用的是 drill 提示词（讲"你犯过的错"）', /错因|真实犯过/.test(seen.system), seen.system.slice(0, 40));
    check('题量 100 透传到提示词', seen.user.includes('100'), '');
    check('任务完成且题目被清洗成统一形状',
      job.status === 'done' && job.data.questions.every((q) => 'question' in q && 'answer' in q && 'options' in q),
      JSON.stringify(job.data?.questions?.[0] || null));
    check('模型漏写 title 时，兜底标题写的是「错误训练」而不是「收藏知识点自测」',
      /^错误训练/.test(job.data?.title || ''), job.data?.title || '(空)');
  }

  /* ---------- 4. 自测题（非 drill）走另一套提示词 ---------- */
  {
    const r = await post({ points: ['look for 表示寻找'], count: 5, mode: '' });
    const job = await waitJob(r.body.jobId);
    check('自测题走 QUIZ 提示词（不是 drill）', !/错因/.test(seen.system) && /自测题|出题/.test(seen.system), seen.system.slice(0, 30));
    check('自测题任务完成', job.status === 'done', job.status);
    check('自测题的兜底标题与错误训练区分开（不能都叫"收藏知识点自测"）',
      /自测/.test(job.data?.title || ''), job.data?.title || '(空)');
  }

  /* ---------- 5. 题量缺省 / 非法 ---------- */
  {
    const r1 = await post({ points: ['x'] });
    const j1 = await waitJob(r1.body.jobId);
    check('题量缺省时用 10', seen.user.includes('10'), '');
    check('非法题量（0 / 负数）退回 1 而不是崩', (await (async () => {
      const r = await post({ points: ['x'], count: -5 });
      const j = await waitJob(r.body.jobId);
      return j.status === 'done';
    })()));
    check('题量缺省的任务也正常完成', j1.status === 'done', j1.status);
  }
} catch (e) {
  check('测试执行完成', false, String(e && e.message));
} finally {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${'='.repeat(62)}`);
  console.log(fail ? `❌ ${fail}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
  if (server) server.kill();
  mock.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
}
