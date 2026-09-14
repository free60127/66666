/**
 * SSRF 回归测试：访客自带的 baseUrl 不能把服务端变成"打内网的跳板"。
 *
 * 为什么要有这个文件：这条防线原来只做**字面主机名正则**，实测有两条绕过路径
 * （IPv4 映射形式的 IPv6、以及域名解析到内网），而且内网响应会经 job.error
 * 原样回显给提交者 —— 不是盲 SSRF。原来的测试全在测"正常路径"，
 * 一条都没有从攻击者视角打过这个接口。
 *
 * 跑法：node server/ssrf.test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP_PORT = 8951;
const APP_PORT_OPEN = 8952;   // 第二个实例：ALLOW_PRIVATE_BASE_URL=1（用于验证"不跟随重定向"）
const SECRET_PORT = 8953;     // 假装是内网服务（云元数据 / 本机其它端口）
const MOCK_PORT = 8954;       // 正常模型接口
const EVIL_PORT = 8955;       // 攻击者的"公网"域名：307 跳内网

const SECRET = 'INTERNAL-SECRET-DO-NOT-LEAK';
let secretHits = 0;
let evilHits = 0;

/** 内网服务：返回机密串，并记录被访问次数 */
const secret = http.createServer((req, res) => {
  secretHits += 1;
  res.writeHead(418, { 'Content-Type': 'text/plain' });
  res.end(SECRET + ' path=' + req.url);
});
/** 攻击者服务器：通过校验后回 307 把 POST 带去内网 */
const evil = http.createServer((req, res) => {
  evilHits += 1;
  res.writeHead(307, { Location: `http://127.0.0.1:${SECRET_PORT}/internal-admin` });
  res.end();
});
const mock = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
});
await new Promise((r) => secret.listen(SECRET_PORT, '127.0.0.1', r));
await new Promise((r) => evil.listen(EVIL_PORT, '127.0.0.1', r));
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

function startServer(port, extraEnv) {
  const proc = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(port), AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, AI_API_KEY: 'server-key', ...extraEnv },
    stdio: 'ignore',
  });
  return proc;
}
async function waitUp(port) {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* 等 */ }
    await sleep(300);
  }
  return false;
}

const app = startServer(APP_PORT, {});
const appOpen = startServer(APP_PORT_OPEN, { ALLOW_PRIVATE_BASE_URL: '1' });
if (!(await waitUp(APP_PORT)) || !(await waitUp(APP_PORT_OPEN))) {
  console.error('服务端启动超时');
  process.exit(1);
}

const submit = async (port, baseUrl) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 't', chinese: '中', draft: 'en', baseUrl, apiKey: 'attacker-key' }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
/** 提交后等任务落定，把 error 文案取回来（内网响应会经这里回显） */
const settle = async (port, jobId) => {
  for (let i = 0; i < 40; i += 1) {
    const r = await fetch(`http://127.0.0.1:${port}/api/analyze/${jobId}`);
    const b = await r.json().catch(() => ({}));
    const st = b.job && b.job.status;
    if (st === 'done' || st === 'error') return b.job;
    await sleep(150);
  }
  return null;
};

console.log('=== SSRF 回归测试 ===\n');

/* ---------- 1. 私网字面量：各种形式都必须被拒 ---------- */
{
  const cases = [
    ['IPv4 回环', `http://127.0.0.1:${SECRET_PORT}/v1`],
    ['IPv6 回环', `http://[::1]:${SECRET_PORT}/v1`],
    ['IPv4 映射的 IPv6（点分）', `http://[::ffff:127.0.0.1]:${SECRET_PORT}/v1`],
    ['IPv4 映射的 IPv6（十六进制）', `http://[::ffff:7f00:1]:${SECRET_PORT}/v1`],
    ['IPv4 映射的云元数据地址', 'http://[::ffff:a9fe:a9fe]/v1'],
    ['完整写法的映射地址', `http://[0:0:0:0:0:ffff:7f00:1]:${SECRET_PORT}/v1`],
    ['localhost 名字', `http://localhost:${SECRET_PORT}/v1`],
    ['私有段 10.x', 'http://10.0.0.5:8080/v1'],
    ['私有段 192.168.x', 'http://192.168.1.1:8080/v1'],
    ['CGNAT 100.64/10', 'http://100.64.0.1:8080/v1'],
    ['ULA fc00::/7', 'http://[fd00::1]:8080/v1'],
    ['链路本地 fe80::/10', 'http://[fe80::1]:8080/v1'],
    ['file 协议', 'file:///etc/passwd'],
  ];
  for (const [name, url] of cases) {
    const r = await submit(APP_PORT, url);
    check(`拒绝 ${name}`, r.status === 400 && /不被允许/.test(r.body.error || ''), `HTTP ${r.status} ${String(r.body.error || '').slice(0, 30)}`);
  }
  check('上述尝试一次都没打到内网服务', secretHits === 0, `secretHits=${secretHits}`);
}

/* ---------- 2. 曾被绕过的那条：映射地址提交成功后，任务里不能出现内网响应 ---------- */
{
  // 用放行内网的实例复现"如果没有防护会怎样"：任务 error 会带上内网响应体
  // 注意时序：提交只返回任务号，模型调用是后台跑的 —— 要等任务落定再看 secretHits
  const probe = await submit(APP_PORT_OPEN, `http://[::ffff:127.0.0.1]:${SECRET_PORT}/v1`);
  const job = probe.body.jobId ? await settle(APP_PORT_OPEN, probe.body.jobId) : null;
  check('（对照组）放行内网时确实能打到内网服务 —— 说明这条链路是通的', probe.status === 200 && secretHits > 0, `HTTP ${probe.status}, secretHits=${secretHits}`);
  check('（对照组）内网响应会经 job.error 回显 —— 所以必须拦住', Boolean(job && /INTERNAL-SECRET/.test(job.error || '')), String(job && job.error || '').slice(0, 60));
  secretHits = 0; // 归零，下面的重定向用例单独计数
}

/* ---------- 3. 重定向：不能跟着 307 把 body 送去内网 ---------- */
{
  evilHits = 0;
  secretHits = 0;
  const r = await submit(APP_PORT_OPEN, `http://127.0.0.1:${EVIL_PORT}/v1`);
  const job = r.body.jobId ? await settle(APP_PORT_OPEN, r.body.jobId) : null;
  check('攻击者服务器确实收到了请求（先证明这条路径可走）', evilHits > 0, `evilHits=${evilHits}`);
  check('服务端没有跟随 307 去打内网', secretHits === 0, `secretHits=${secretHits}`);
  check('用户看到的是"不自动跟随重定向"的可操作提示', Boolean(job && /重定向/.test(job.error || '')), String(job && job.error || '').slice(0, 70));
}

/* ---------- 4. 正常路径不能被误伤 ---------- */
{
  // 注意：不能拿 MOCK_PORT 当"自定义地址" —— 那正是服务端自己配置的 AI_BASE_URL，
  // 命中"和你配置的一样 → 当成没填"，属于设计内的放行。换一个端口才是真正的自定义地址。
  const r = await submit(APP_PORT, `http://127.0.0.1:${SECRET_PORT}/v1`);
  check('未放行内网时，自定义地址指向本机同样被拒（策略一致）', r.status === 400, `HTTP ${r.status}`);
  const r2 = await submit(APP_PORT, '');
  check('不传 baseUrl（用服务端配置的接口）照常受理', r2.status === 200 && Boolean(r2.body.jobId), `HTTP ${r2.status}`);
}

app.kill();
appOpen.kill();
secret.close();
evil.close();
mock.close();

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
