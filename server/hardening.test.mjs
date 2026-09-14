/**
 * 资源保护回归测试：限流桶有界 + 任务并发闸门。
 *
 * 为什么要有：限流原来只管"每分钟多少次"，它**不是**资源保护 ——
 *   · 桶表只在"命中已存在的桶"时清理，换 IP 刷就永远不触发 → 实测 6 万桶、内存不回落；
 *   · 没有并发上限 → 实测一个 IP 一分钟能同时投 60 个模型任务，
 *     而 OCR 单请求 body 上限 20MB（12MB 图片的 dataURL ≈ 16MB），几个并发就能顶满 512MB 触发 OOM。
 * 这两条在测试环境都"看不见"（单实例、临时磁盘、没有真实配额），所以必须显式钉住。
 *
 * 跑法：node server/hardening.test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8961;
const MOCK_PORT = 8962;
const BUCKET_MAX = 5;          // 故意设得很小，便于在几秒内打出边界
const INFLIGHT = 1;            // 同时只允许 1 个任务在跑
const QUEUE = 0;               // 不允许排队 → 第 2 个任务应被明确拒绝

// 模型接口故意很慢：保证第 1 个任务还在跑时第 2 个就到了
let mockHits = 0;
const mock = http.createServer((req, res) => {
  mockHits += 1;
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  }, 2500);
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const app = spawn(process.execPath, ['server/index.mjs'], {
  env: {
    ...process.env, PORT: String(PORT),
    AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, AI_API_KEY: 'k',
    ALLOW_PRIVATE_BASE_URL: '1',
    TRUST_PROXY_HOPS: '1',
    RATE_LIMIT_PER_MIN: '100000',      // 别让"次数限流"干扰本测试
    RATE_BUCKET_MAX: String(BUCKET_MAX),
    MAX_INFLIGHT_JOBS: String(INFLIGHT),
    MAX_QUEUED_JOBS: String(QUEUE),
  },
  stdio: 'ignore',
});
let up = false;
for (let i = 0; i < 40 && !up; i += 1) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* 等 */ }
  if (!up) await sleep(300);
}
if (!up) { console.error('服务端启动超时'); process.exit(1); }

const status = async () => (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();

console.log('=== 资源保护回归测试 ===\n');

/* ---------- 1. 限流桶表有界 ---------- */
{
  const before = (await status()).rateLimit.buckets;
  // 每个请求换一个来源 IP（模拟 IPv6 轮换 / 代理池）—— 正是原来能撑爆表的那条路
  const N = BUCKET_MAX * 4;
  for (let i = 0; i < N; i += 1) {
    await fetch(`http://127.0.0.1:${PORT}/api/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.1.${Math.floor(i / 250)}.${i % 250}, 203.0.113.9` },
      body: JSON.stringify({ title: 'x' }),
    });
  }
  const after = await status();
  check('限流桶数不超过上限（轮换 IP 打不爆）', after.rateLimit.buckets <= BUCKET_MAX,
    `起始 ${before} → 打完 ${N} 个不同 IP 后 ${after.rateLimit.buckets}（上限 ${after.rateLimit.bucketMax}）`);
  check('上限可以从环境变量配置并生效', after.rateLimit.bucketMax === BUCKET_MAX, String(after.rateLimit.bucketMax));
  check('status 暴露桶数，便于线上观测', typeof after.rateLimit.buckets === 'number');
}

/* ---------- 2. 并发闸门 ---------- */
{
  mockHits = 0;
  const st = await status();
  check('status 暴露并发上限配置', st.concurrency.maxInflight === INFLIGHT && st.concurrency.maxQueued === QUEUE,
    JSON.stringify(st.concurrency));

  const submit = () => fetch(`http://127.0.0.1:${PORT}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 't', chinese: '中文', draft: 'draft' }),
  }).then((r) => r.json());

  const first = await submit();
  await sleep(300);                       // 让第 1 个任务真正跑起来（它要 2.5 秒才结束）
  const second = await submit();
  check('两个任务都被受理（拒绝发生在执行阶段，接口本身仍是异步的）',
    Boolean(first.jobId) && Boolean(second.jobId), `${first.jobId ? 'ok' : first.error} / ${second.jobId ? 'ok' : second.error}`);

  const readJob = async (id) => (await (await fetch(`http://127.0.0.1:${PORT}/api/analyze/${id}`)).json()).job;
  const secondJob = await readJob(second.jobId);
  check('超出并发的任务被明确判失败，而不是排队堆内存', secondJob.status === 'error' && /正忙|繁忙/.test(secondJob.error || ''),
    `${secondJob.status}: ${String(secondJob.error || '').slice(0, 40)}`);
  check('被拒的任务没有真的打到模型接口（省下的就是钱和内存）', mockHits <= 1, `mockHits=${mockHits}`);

  // 第 1 个任务跑完后名额要释放出来，不能把后续请求永久卡住
  await sleep(2600);
  const third = await submit();
  const thirdJob = await readJob(third.jobId);
  check('名额会释放：前一个任务结束后新任务能正常跑', thirdJob.status !== 'error' || !/正忙|繁忙/.test(thirdJob.error || ''),
    `${thirdJob.status}: ${String(thirdJob.error || '').slice(0, 40)}`);
}

app.kill();
mock.close();

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
