/**
 * 流式批改的服务端端到端测试（/api/quiz mode=grade stream=1 + SSE）。
 *
 * 为什么必须跑真链路：流式的价值全在"**先到先得**"——第一道题的点评必须在第二道题
 * 还没生成出来之前就送到浏览器。这件事在单测里假不出来：它横跨
 * 假模型的写节奏、服务端的边收边解析、SSE 的推送、以及 job.grades 的可见性。
 * 所以这里用一个**带闸门**的假模型：发完第一行就停住，等测试收到 SSE 的第一条判定后
 * 才放行第二行 —— 完全不依赖 sleep 计时，判定"是不是真的流式"是确定性的。
 *
 * 跑法：node server/gradestream.test.mjs
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
const MOCK_PORT = 9895;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-gradestream-'));
const BASE = `http://127.0.0.1:${PORT}`;

console.log('=== 流式批改（NDJSON + SSE）端到端测试 ===\n');

/* ---------- 假模型：按 SSE 分块吐"一行一道题"，第二行卡在闸门后面 ---------- */
const gate = { open: false, waiters: [] };
const openGate = () => { gate.open = true; gate.waiters.splice(0).forEach((f) => f()); };
const waitGate = () => (gate.open ? Promise.resolve() : new Promise((r) => gate.waiters.push(r)));
const mockState = { streaming: false, sentLines: 0, sawStreamFlag: false, sawResponseFormat: false, userText: '', systemText: '', forceWholeJson: false };

const chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    mockState.sawStreamFlag = payload.stream === true;
    mockState.sawResponseFormat = Boolean(payload.response_format);
    mockState.systemText = String((payload.messages || []).find((m) => m.role === 'system')?.content || '');
    mockState.userText = String((payload.messages || []).find((m) => m.role === 'user')?.content || '');
    if (!payload.stream) {
      // 非流式（对照组）：一次性返回完整 JSON
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ grades: [{ index: 0, verdict: 'right', comment: '一次性', better: '' }] }) } }] }));
      return;
    }
    mockState.streaming = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (mockState.forceWholeJson) {
      // 模拟"模型不按一行一题来"：把整段 JSON 一次吐出来 → 服务端应落到 fallback
      const whole = JSON.stringify({ grades: [{ index: 0, verdict: 'right', comment: '整段 JSON', better: '' }] });
      res.write(chunk(whole));
      res.write('data: [DONE]' + String.fromCharCode(10) + String.fromCharCode(10));
      res.end();
      return;
    }
    const line0 = JSON.stringify({ index: 0, verdict: 'right', comment: '第一题：改对了', better: '' }) + '\n';
    const line1 = JSON.stringify({ index: 1, verdict: 'close', comment: '第二题：差一点', better: 'better-1' }) + '\n';
    // 故意把第一行劈成两半发：验"残行留在缓冲里等下一块"
    res.write(chunk(line0.slice(0, 20)));
    await sleep(60);
    res.write(chunk(line0.slice(20)));
    mockState.sentLines = 1;
    await waitGate();                       // ← 卡住：等测试确认"第一条判定已经到了"
    res.write(chunk(line1));
    mockState.sentLines = 2;
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const env = { ...process.env, PORT: String(PORT), AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, AI_API_KEY: 'mock', ALLOW_PRIVATE_BASE_URL: '1', DATA_DIR };
let server = null;

/** 读 SSE：每解析出一个事件就回调（返回一个可 break 的循环） */
async function readSse(url, onEvent, { stopAfter = 999 } = {}) {
  const res = await fetch(url);
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let n = 0;
  while (n < stopAfter) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx >= 0 && n < stopAfter) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      idx = buf.indexOf('\n\n');
      const ev = { event: 'message', data: '', id: '' };
      for (const l of raw.split('\n')) {
        if (l.startsWith('event:')) ev.event = l.slice(6).trim();
        else if (l.startsWith('data:')) ev.data += l.slice(5).trim();
        else if (l.startsWith('id:')) ev.id = l.slice(3).trim();
      }
      if (ev.event !== 'message' || ev.data) { n += 1; await onEvent(ev); }
    }
  }
  try { await reader.cancel(); } catch { /* 已结束 */ }
}

const post = async (body) => {
  const r = await fetch(`${BASE}/api/quiz`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ITEMS = [
  { index: 0, type: '翻译', question: '把这句话译成英文：「他绝望地向他的伙伴挥手。」', options: [], answer: 'He waved desperately to his companion.', explanation: 'desperately 是副词', userAnswer: 'He waved desperately to his companion.' },
  { index: 1, type: '造句', question: '用 swing round 造一个句子', options: [], answer: 'He swung the boat round.', explanation: 'swing 的过去式', userAnswer: 'He swing the boat round.' },
];

try {
  server = spawn(process.execPath, ['server/index.mjs'], { env, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 50 && !up; i += 1) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* 等 */ }
    if (!up) await sleep(300);
  }
  if (!up) throw new Error('服务端启动超时');

  /* ---------- 1. 提交：stream=1 要回执给前端 ---------- */
  const r1 = await post({ mode: 'grade', stream: true, items: ITEMS, level: '四六级' });
  check('流式批改被受理，响应里带上 stream=true', r1.status === 200 && r1.body.stream === true && !!r1.body.jobId, JSON.stringify(r1.body).slice(0, 80));
  const jobId = r1.body.jobId;

  /* ---------- 2. 流式提示词：一行一道题 + 不能带 response_format ---------- */
  await sleep(150);
  check('用的是流式批改提示词（要求一行一道题）', /一行一道题/.test(mockState.systemText), mockState.systemText.slice(0, 24));
  check('请求里 stream=true', mockState.sawStreamFlag === true);
  check('★ 流式请求**没有**带 response_format（带了就与"一行一题"冲突）', mockState.sawResponseFormat === false);

  /* ---------- 3. SSE：第一条判定必须在第二行还没生成时就到 ---------- */
  const seen = [];
  let firstArrivedBeforeSecondLine = false;
  let sawDone = null;
  await readSse(`${BASE}/api/quiz/${jobId}/stream`, async (ev) => {
    if (ev.event === 'grade') {
      const payload = JSON.parse(ev.data);
      seen.push(payload);
      if (seen.length === 1) {
        // 闸门还关着 = 假模型的第二行还没写出来。此刻我们已经拿到第一条判定 → 真流式
        firstArrivedBeforeSecondLine = mockState.sentLines === 1;
        const jobNow = await (await fetch(`${BASE}/api/quiz/${jobId}`)).json();
        check('第一条判定到达时，任务仍在 running（不是等全部写完才一次性给）', jobNow.job.status === 'running', jobNow.job.status);
        openGate();                          // 放行第二行
      }
    } else if (ev.event === 'done') {
      sawDone = JSON.parse(ev.data);
    } else if (ev.event === 'error') {
      sawDone = { error: JSON.parse(ev.data).error };
    }
  }, { stopAfter: 6 });

  check('★ SSE 逐题推送：第二行还没生成，第一题的判定已经到了', firstArrivedBeforeSecondLine === true, `mock 已写行数=${mockState.sentLines}`);
  check('两条判定各自带题号与进度', seen.length === 2 && seen[0].grade.index === 0 && seen[1].grade.index === 1 && seen[1].total === 2, JSON.stringify(seen.map((x) => [x.grade.index, x.done, x.total])));
  check('点评内容原样送达', seen[0].grade.comment === '第一题：改对了' && seen[1].grade.better === 'better-1', JSON.stringify(seen.map((x) => x.grade.comment)));
  check('done 事件带回最终完整结果（前端据此收敛）', Boolean(sawDone && sawDone.job && Array.isArray(sawDone.job.data.grades)) && sawDone.job.data.grades.length === 2, JSON.stringify(sawDone && sawDone.job ? sawDone.job.data.grades.length : sawDone));

  /* ---------- 4. 跑完之后：轮询端点拿到的和流式看到的一致 ---------- */
  const jobFinal = await (await fetch(`${BASE}/api/quiz/${jobId}`)).json();
  check('任务已完成，data.grades 与流式推送一致', jobFinal.job.status === 'done' && jobFinal.job.data.grades.length === 2, jobFinal.job.status);
  check('落库的是同一份结果（不是两套）', JSON.stringify(jobFinal.job.data.grades.map((g) => g.comment)) === JSON.stringify(seen.map((x) => x.grade.comment)), JSON.stringify(jobFinal.job.data.grades.map((g) => g.comment)));

  /* ---------- 5. 已经跑完的任务再连 SSE：一次性重放 + done ---------- */
  const replay = [];
  await readSse(`${BASE}/api/quiz/${jobId}/stream`, (ev) => { replay.push(ev.event); }, { stopAfter: 4 });
  check('已完成的任务重连 SSE：先重放判定、再发 done', replay.join(',') === 'grade,grade,done', replay.join(','));

  /* ---------- 6. 断点续传：?from=1 只补没收到的那条 ---------- */
  const resumed = [];
  await readSse(`${BASE}/api/quiz/${jobId}/stream?from=1`, (ev) => { resumed.push(ev.event + ':' + (ev.event === 'grade' ? JSON.parse(ev.data).grade.index : '')); }, { stopAfter: 3 });
  check('从断点续传只补第 2 条（不重放已收到的）', resumed.join(',') === 'grade:1,done:', resumed.join(','));

  /* ---------- 7. 兜底：模型没按一行一题来（整段 JSON） ---------- */
  gate.open = true;
  mockState.streaming = false;
  mockState.forceWholeJson = true;   // 让假模型这次"忽略流式约定"：整段 JSON 一次吐出来
  const r2 = await post({ mode: 'grade', stream: true, items: [ITEMS[0]], level: '四六级' });
  const seen2 = [];
  await readSse(`${BASE}/api/quiz/${r2.body.jobId}/stream`, (ev) => { if (ev.event === 'grade') seen2.push(JSON.parse(ev.data)); }, { stopAfter: 4 });
  const job2 = await (await fetch(`${BASE}/api/quiz/${r2.body.jobId}`)).json();
  mockState.forceWholeJson = false;
  // 判据是**内容来自整段 JSON 的那条**（走流式解析的话会是"第一题：改对了"）
  check('★ 模型没按一行一题来时，退回整段 JSON 解析，结果照常拿到',
    job2.job.status === 'done' && job2.job.data.grades.length === 1 && job2.job.data.grades[0].comment === '整段 JSON',
    `${job2.job.status} / ${JSON.stringify(job2.job.data && job2.job.data.grades)}`);

  /* ---------- 8. 老前端不提 stream：行为与以前完全一样 ---------- */
  const r3 = await post({ mode: 'grade', items: [ITEMS[0]], level: '四六级' });
  check('不带 stream 的请求响应里 stream=false（老行为不变）', r3.body.stream === false, JSON.stringify(r3.body.stream));
  for (let i = 0; i < 30; i += 1) {
    const j = await (await fetch(`${BASE}/api/quiz/${r3.body.jobId}`)).json();
    if (j.job.status === 'done') { check('非流式批改照旧能拿到结果', j.job.data.grades.length === 1, j.job.status); break; }
    await sleep(200);
  }
} catch (e) {
  check('测试执行完成', false, String((e && e.message) || e).slice(0, 200));
} finally {
  const fail = results.filter((x) => !x.ok).length;
  console.log(`\n${'='.repeat(62)}`);
  console.log(fail ? `❌ ${fail}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
  if (server) server.kill();
  mock.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
}
