/**
 * 历史「删除某次作业」测试（本机 + 服务端 + 云端墓碑）。
 *
 * 为什么必须有：删除看起来简单，实际有三处会"复活"它，而且用户只会看到"删了又出现"：
 *   1) 生成中的任务跑完之后还会 saveJob 一次（写 status / 结果）→ 把刚删的记录写回 KV
 *   2) 云同步的历史合并是**并集**（按 jobId 去重）→ 下次同步从云端把旧副本并回来
 *   3) 其它设备的本机旧副本 → 同样会并回来
 * 前两条在这里做成可回归的断言；第三条靠墓碑随快照同步（见 sanitizeSnapshot 的断言）。
 *
 * 跑法：node server/delete.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { sanitizeSnapshot, emptySnapshot, SNAPSHOT_LIMITS } from './sync.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8934;
const MOCK_PORT = 9884;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-del-'));

console.log('=== 历史删除测试 ===\n');

/* ---------- 假模型：**故意慢** 400ms，好让"删除"发生在任务跑完之前 ---------- */
const mock = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    setTimeout(() => {
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
    }, 400);
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
  DATA_DIR,
};
const server = spawn(process.execPath, ['server/index.mjs'], { env, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 50 && !up; i += 1) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* 还没起来 */ }
  if (!up) await sleep(300);
}
if (!up) { console.error('服务端启动超时'); process.exit(1); }

const base = `http://127.0.0.1:${PORT}`;
const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const createJob = async () => {
  const r = await fetch(base + '/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'T', chinese: '中', draft: 'd' }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const del = (jobId, token) => j('/api/analyze/' + jobId, {
  method: 'DELETE',
  headers: token ? { 'X-Delete-Token': token } : {},
});

try {
  /* ---------- 1. 创建任务返回删除凭据 ---------- */
  const created = await createJob();
  const jobId = created.body.jobId;
  const token = created.body.deleteToken;
  check('创建任务返回 jobId', created.status === 200 && !!jobId, jobId);
  check('创建任务返回 deleteToken', typeof token === 'string' && token.length >= 16);

  /* ---------- 2. 读取接口不能泄露删除凭据 ---------- */
  const got = await j('/api/analyze/' + jobId);
  check('GET 能读到任务', got.status === 200 && got.body.job?.jobId === jobId);
  check('GET **不**返回 deleteToken（分享链接不该附带删除权）', got.body.job && got.body.job.deleteToken === undefined && !JSON.stringify(got.body).includes(token));

  /* ---------- 3. 凭据不对不给删 ---------- */
  const noToken = await del(jobId, '');
  check('不带凭据删除 → 403', noToken.status === 403, JSON.stringify(noToken.body));
  const badToken = await del(jobId, 'f'.repeat(32));
  check('凭据错误删除 → 403', badToken.status === 403);
  check('403 之后任务还在', (await j('/api/analyze/' + jobId)).status === 200);

  /* ---------- 4. 正确凭据删除 ---------- */
  const okDel = await del(jobId, token);
  check('带正确凭据删除 → 200', okDel.status === 200 && okDel.body.ok === true);
  check('删除后 GET → 404', (await j('/api/analyze/' + jobId)).status === 404);
  check('重复删除 → 404（幂等地表现为"已不存在"）', (await del(jobId, token)).status === 404);

  /* ---------- 5. 关键：跑完的任务不能把删掉的记录写回来 ---------- */
  await sleep(1200); // 假模型 400ms + 收尾写入，早已跑完
  const afterFinish = await j('/api/analyze/' + jobId);
  check('任务跑完后记录仍是删除状态（拦住收尾 saveJob 的"复活"）', afterFinish.status === 404, '状态码 ' + afterFinish.status);

  /* ---------- 6. 老任务（本功能上线前创建，没有 token）仍可删除 ---------- */
  const legacyId = '11111111-2222-3333-4444-555555555555';
  const legacyJob = { jobId: legacyId, kind: 'analyze', title: '老记录', status: 'done', createdAt: Date.now(), data: { title: '老记录' }, error: null };
  // 文件 KV 的落盘位置：<DATA_DIR>/kv/ + 键名里的非 [A-Za-z0-9._-] 字符换成下划线
  const kvDir = path.join(DATA_DIR, 'kv');
  fs.mkdirSync(kvDir, { recursive: true });
  fs.writeFileSync(path.join(kvDir, 'bts_job_' + legacyId + '.json'), JSON.stringify({ v: JSON.stringify(legacyJob), e: 0 }));
  const legacyBefore = await j('/api/analyze/' + legacyId);
  check('老记录（无 token）能被读到', legacyBefore.status === 200, '状态码 ' + legacyBefore.status);
  const legacyDel = await del(legacyId, '');
  check('老记录不带凭据也能删（否则永远删不掉）', legacyDel.status === 200);
  check('老记录删除后 GET → 404', (await j('/api/analyze/' + legacyId)).status === 404);

  /* ---------- 7. 云同步快照要接受并保留墓碑 ---------- */
  const snap = sanitizeSnapshot({ ...emptySnapshot(), history: [{ jobId, title: 'T', time: Date.now() }], deletedHistory: [jobId, legacyId, jobId, 42, ''] });
  check('sanitize 接受 deletedHistory 字段', snap.ok === true, snap.ok ? '' : snap.error);
  check('墓碑去重、丢掉非字符串', snap.ok && JSON.stringify(snap.data.deletedHistory) === JSON.stringify([jobId, legacyId]), snap.ok ? JSON.stringify(snap.data.deletedHistory) : '');
  const tooMany = sanitizeSnapshot({ ...emptySnapshot(), deletedHistory: Array.from({ length: SNAPSHOT_LIMITS.deletedHistory + 1 }, (_, i) => 'id-' + i) });
  check('墓碑超上限 → 明确拒绝（不静默截断）', tooMany.ok === false, tooMany.ok ? '' : tooMany.error);
  const notArray = sanitizeSnapshot({ ...emptySnapshot(), deletedHistory: 'oops' });
  check('墓碑不是数组 → 拒绝', notArray.ok === false);
} catch (e) {
  check('测试执行未抛异常', false, String(e && e.message));
} finally {
  server.kill();
  mock.close();
  await sleep(200);
}

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
for (const f of failed) console.log('   FAILED:', f.name, f.detail ? '— ' + f.detail : '');
process.exit(failed.length ? 1 : 0);
