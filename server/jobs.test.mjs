/**
 * 任务保留 / 自动清理 测试。
 *
 * 为什么必须有：分享链接只能从服务端的任务记录恢复，而这份记录同时决定了
 * "链接能活多久"和"会不会把存储写满"。两个方向都会出事：
 *   · 只留 7 天 → 发出去的链接一周后失效（已修）
 *   · 只留十年、没有条数上限 → 一直堆到 Upstash 免费额度 256MB 写满，
 *     而这个库是和云同步、账号**共用**的：写满之后同步和登录会一起失败
 * 这里用一个 JOB_MAX_COUNT=3 的小实例把淘汰逻辑跑成可回归的断言。
 *
 * 跑法：node server/jobs.test.mjs
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

const PORT = 8931;
const MOCK_PORT = 9881;
const MAX = 3; // 故意调得很小，让淘汰在测试里真的发生
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-jobs-'));

console.log('=== 任务保留 / 自动清理测试 ===\n');

/* ---------- 假模型：秒回一份最小结果 ---------- */
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            title: 'T', chinese: '中', draft: 'd', ai: 'a', original: 'o',
            overall: { score: 80, issues: 1 },
            sentences: [{ cn: 'a', draft: 'b', ai: 'c', original: 'd', findings: [] }],
          }),
        },
      }],
    }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

/* ---------- 被测服务端 ---------- */
const env = {
  ...process.env,
  PORT: String(PORT),
  AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  AI_API_KEY: 'mock',
  ALLOW_PRIVATE_BASE_URL: '1',
  JOB_MAX_COUNT: String(MAX),
  DATA_DIR, // 隔离数据目录，不碰仓库里的 data/
};
let server = null;
const boot = async () => {
  const s = spawn(process.execPath, ['server/index.mjs'], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return s; } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('服务端启动超时');
};
const stop = (s) => new Promise((r) => { if (!s) return r(); s.once('exit', r); s.kill(); setTimeout(r, 1500); });
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const makeJob = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'T', chinese: '中', draft: 'd' }),
  });
  const { jobId } = await r.json();
  for (let i = 0; i < 40; i += 1) {
    const j = await get('/api/analyze/' + jobId);
    if (j.body.job && j.body.job.status === 'done') return jobId;
    await sleep(200);
  }
  throw new Error('任务没跑完: ' + jobId);
};

try {
  server = await boot();

  const ids = [];
  for (let i = 0; i < MAX + 2; i += 1) ids.push(await makeJob());
  check(`连做 ${ids.length} 次批改（上限 ${MAX} 条）`, ids.every(Boolean), ids.map((x) => x.slice(0, 8)).join(','));

  const oldest = await get('/api/analyze/' + ids[0]);
  const second = await get('/api/analyze/' + ids[1]);
  const newest = await get('/api/analyze/' + ids[ids.length - 1]);
  check('超出上限的最旧任务已被自动删除', oldest.status === 404, 'HTTP ' + oldest.status);
  check('超出上限的第二旧任务也被删除', second.status === 404, 'HTTP ' + second.status);
  check('最近的任务仍在（分享链接照常能打开）', newest.status === 200 && newest.body.job.status === 'done');
  check('上限内的任务保留完整结果', Array.isArray(newest.body.job.data.sentences) && newest.body.job.data.sentences.length > 0);

  const mid = await get('/api/analyze/' + ids[2]);
  check('刚好卡在上限内的那条还在', mid.status === 200, 'HTTP ' + mid.status);

  const st = await get('/api/status');
  check('/api/status 报出保留期与上限', st.body.jobs && st.body.jobs.ttlDays >= 365 && st.body.jobs.max === MAX, JSON.stringify(st.body.jobs));
  check('已保留条数不超过上限', Number(st.body.jobs.retained) <= MAX, 'retained=' + st.body.jobs.retained);

  // 序号键也要跟着 TTL 走，不能无限堆积
  const seqFiles = fs.readdirSync(path.join(DATA_DIR, 'kv')).filter((n) => n.includes('jobseq') || n.includes('jobs_seq'));
  check('序号映射键数量受限（随淘汰一起删除）', seqFiles.length <= MAX + 2, String(seqFiles.length));

  /* ---------- 老链接续期：改大保留期后，已发出去的链接打开一次即可续命 ---------- */
  const keep = ids[ids.length - 1];
  const jobFile = path.join(DATA_DIR, 'kv', 'bts_job_' + keep + '.json');
  const envelope = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  envelope.e = Date.now() + 3600 * 1000; // 伪装成"旧链接：只剩 1 小时"
  fs.writeFileSync(jobFile, JSON.stringify(envelope));
  const before = (JSON.parse(fs.readFileSync(jobFile, 'utf8')).e - Date.now()) / 86400000;

  await stop(server);      // 重启：内存副本清空，强制走 KV 读取路径（续期就发生在那里）
  server = await boot();
  const reopened = await get('/api/analyze/' + keep);
  await sleep(500);
  const after = (JSON.parse(fs.readFileSync(jobFile, 'utf8')).e - Date.now()) / 86400000;
  check('老链接（仅剩 1 小时）重启后仍能打开', reopened.status === 200 && reopened.body.job.status === 'done', 'HTTP ' + reopened.status);
  check('打开一次即续期到新保留期', before < 0.1 && after > 365, `${before.toFixed(2)} 天 → ${after.toFixed(2)} 天`);

  const st2 = await get('/api/status');
  check('续期不影响条数统计', Number(st2.body.jobs.retained) <= MAX, 'retained=' + st2.body.jobs.retained);
} catch (e) {
  check('脚本执行未抛错', false, e && e.message);
} finally {
  await stop(server);
  mock.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也无所谓 */ }
  console.log('\n' + '='.repeat(60));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
  if (failed.length) {
    for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? '  — ' + f.detail : ''));
    process.exitCode = 1;
  }
}
