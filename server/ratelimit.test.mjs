/**
 * 限流 + 客户端 IP 解析测试。
 *
 * 背景（P0）：限流原来取 `X-Forwarded-For` 的**最左**值 —— 而最左恰恰是客户端自己
 * 能随便写的。PoC：阈值 5 次/分钟下，固定 XFF 的正常用户第 6 次被拦，
 * 每次换一个伪造 XFF 的攻击者却 200 到底，等于限流不存在（每个请求都在真花钱）。
 * 登录失败锁定也用同一个 IP，同样被绕过。
 *
 * 跑法：node server/ratelimit.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { resolveClientIp, trustProxyHops, trustCloudflareHeader } from './client-ip.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('=== 限流 / 客户端 IP 测试 ===\n');

/* ---------- 1. 纯函数：IP 解析规则 ---------- */
{
  check('直连（hops=0）：忽略 XFF，用 socket', resolveClientIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, socketIp: '10.0.0.9', hops: 0 }) === '10.0.0.9');
  check('1 跳代理：取最右一跳（代理追加的真实 IP）', resolveClientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socketIp: '10.0.0.9', hops: 1 }) === '5.6.7.8');
  check('1 跳代理：单值头也取它', resolveClientIp({ headers: { 'x-forwarded-for': '203.0.113.7' }, socketIp: '10.0.0.9', hops: 1 }) === '203.0.113.7');
  check('2 跳代理：取右起第二跳', resolveClientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.9.9.9' }, socketIp: '10.0.0.9', hops: 2 }) === '5.6.7.8');
  check('头比跳数短 → 不采信，退回 socket（伪造的单值头无效）', resolveClientIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, socketIp: '10.0.0.9', hops: 2 }) === '10.0.0.9');
  check('没有 XFF → socket', resolveClientIp({ headers: {}, socketIp: '10.0.0.9', hops: 1 }) === '10.0.0.9');
  check('空格 / 空项被清理', resolveClientIp({ headers: { 'x-forwarded-for': ' 1.2.3.4 ,, 5.6.7.8 ' }, socketIp: '', hops: 1 }) === '5.6.7.8');
  check('全空 → unknown（不会把空串当桶名）', resolveClientIp({ headers: {}, socketIp: '', hops: 0 }) === 'unknown');
  check('CF 头默认不信任（源站可能被直连）', resolveClientIp({ headers: { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' }, socketIp: '10.0.0.9', hops: 1, trustCf: false }) === '1.2.3.4');
  check('显式信任 CF 时优先用它', resolveClientIp({ headers: { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' }, socketIp: '10.0.0.9', hops: 1, trustCf: true }) === '9.9.9.9');

  check('跳数默认值：托管平台 1 跳', trustProxyHops({}, true) === 1);
  check('跳数默认值：本机直连 0 跳', trustProxyHops({}, false) === 0);
  check('跳数默认值：TRUST_PROXY=1 → 1 跳', trustProxyHops({ TRUST_PROXY: '1' }, false) === 1);
  check('跳数显式配置优先（含 0）', trustProxyHops({ TRUST_PROXY_HOPS: '2' }, true) === 2 && trustProxyHops({ TRUST_PROXY_HOPS: '0' }, true) === 0);
  check('跳数配置成垃圾值 → 回退默认', trustProxyHops({ TRUST_PROXY_HOPS: 'abc' }, true) === 1);
  check('CF 开关只认 "1"', trustCloudflareHeader({ TRUST_CF_CONNECTING_IP: '1' }) === true && trustCloudflareHeader({ TRUST_CF_CONNECTING_IP: 'true' }) === false);
}

/* ---------- 2. 端到端：HTTP 层真的按解析出来的 IP 计数 ---------- */
const MAX = 5;
const MOCK_PORT = 9883;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-rl-'));

let nextPort = 8941;
const boot = async (extraEnv = {}) => {
  const port = (nextPort += 1);
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR,
    RATE_LIMIT_PER_MIN: String(MAX),
    AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    AI_API_KEY: 'mock',
    ...extraEnv,
  };
  // 捕获 stdout/stderr：既要断言启动警告，也要避免测试输出被日志淹没
  const proc = spawn(process.execPath, ['server/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += String(d); });
  proc.stderr.on('data', (d) => { logs += String(d); });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { port, proc, logs: () => logs }; } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('服务端启动超时（端口 ' + port + '）');
};
const stop = (s) => new Promise((r) => { if (!s) return r(); s.proc.once('exit', r); s.proc.kill(); setTimeout(r, 1200); });

/** 连续打 n 次 /api/match（纯本地计算，不烧模型额度），返回状态码数组 */
const series = async (port, n, headerAt = () => ({})) => {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const r = await fetch(`http://127.0.0.1:${port}/api/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headerAt(i) },
      body: JSON.stringify({ title: 'Lesson 18', chinese: '我在一家乡村小酒店吃过午饭后，就找我的提包。' }),
    });
    out.push(r.status);
  }
  return out;
};
let srv = null;
try {
  /* 2a. 1 跳代理（模拟 Render） */
  srv = await boot({ TRUST_PROXY_HOPS: '1' });
  const st = await (await fetch(`http://127.0.0.1:${srv.port}/api/status`)).json();
  check('/api/status 暴露限流与跳数配置', st.rateLimit && st.rateLimit.perMin === MAX && st.rateLimit.trustProxyHops === 1, JSON.stringify(st.rateLimit));

  const fixed = await series(srv.port, MAX + 1, () => ({ 'x-forwarded-for': '203.0.113.7' }));
  check('固定 XFF 的正常用户：超出阈值被拦', eq(fixed, [...Array(MAX).fill(200), 429]), fixed.join(','));

  // ★ 核心回归：右端真实 IP 不变、只改左端伪造值 —— 必须仍然按"真实 IP"计数
  // （修复前：每个伪造值各开一个新桶，6 次全放行 = 限流不存在）
  const spoofedLeft = await series(srv.port, MAX + 1, (i) => ({ 'x-forwarded-for': `10.9.9.${i}, 203.0.113.77` }));
  check('★ 每次换伪造的最左端 XFF：仍然按真实 IP 限流（PoC 场景）', eq(spoofedLeft, [...Array(MAX).fill(200), 429]), spoofedLeft.join(','));

  const noHeader = await series(srv.port, MAX + 1);
  check('不带 XFF 的直连：按 socket 计数并被拦', eq(noHeader, [...Array(MAX).fill(200), 429]), noHeader.join(','));

  const clientA = await series(srv.port, MAX, () => ({ 'x-forwarded-for': '198.51.100.1' }));
  const clientB = await series(srv.port, MAX, () => ({ 'x-forwarded-for': '198.51.100.2' }));
  check('两个真正不同的客户端各自计数（不互相误伤）', clientA.every((s) => s === 200) && clientB.every((s) => s === 200), `A=${clientA.join(',')} B=${clientB.join(',')}`);

  await stop(srv);

  /* 2b. 直连部署（hops=0）：伪造 XFF 一律无效 */
  srv = await boot({ TRUST_PROXY_HOPS: '0' });
  const spoofDirect = await series(srv.port, MAX + 1, (i) => ({ 'x-forwarded-for': `10.2.2.${i}` }));
  check('直连部署（0 跳）：伪造 XFF 不能绕过限流', eq(spoofDirect, [...Array(MAX).fill(200), 429]), spoofDirect.join(','));
  await stop(srv);

  /* 2c. 信任 Cloudflare 头时：CF-Connecting-IP 才是桶名 */
  srv = await boot({ TRUST_PROXY_HOPS: '1', TRUST_CF_CONNECTING_IP: '1' });
  const cfFixed = await series(srv.port, MAX + 1, (i) => ({ 'x-forwarded-for': `10.3.3.${i}`, 'cf-connecting-ip': '203.0.113.55' }));
  check('信任 CF 头：换 XFF 无效，按 CF-Connecting-IP 计数', eq(cfFixed, [...Array(MAX).fill(200), 429]), cfFixed.join(','));
  const cfVary = await series(srv.port, MAX + 1, (i) => ({ 'cf-connecting-ip': `203.0.113.${100 + i}` }));
  check('信任 CF 头：不同 CF IP 各自计数（前 5 次放行）', cfVary.slice(0, MAX).every((s) => s === 200), cfVary.join(','));
  await stop(srv);

  /* 2d. 配错/伪造的短头：hops=2 时单值头不采信，全部落到 socket 桶 */
  srv = await boot({ TRUST_PROXY_HOPS: '2' });
  const shortHeader = await series(srv.port, MAX + 1, (i) => ({ 'x-forwarded-for': `10.4.4.${i}` }));
  check('hops=2 时单值伪造头不采信（退回 socket，不能制造新桶）', eq(shortHeader, [...Array(MAX).fill(200), 429]), shortHeader.join(','));
  const properChain = await series(srv.port, MAX, (i) => ({ 'x-forwarded-for': `10.5.5.${i}, 203.0.113.88, 172.16.0.1` }));
  check('hops=2 时按右起第二跳（真实客户端）计数', properChain.every((s) => s === 200), properChain.join(','));
  const properChainAgain = await series(srv.port, 1, () => ({ 'x-forwarded-for': `10.6.6.6, 203.0.113.88, 172.16.0.1` }));
  check('同一真实客户端用满额度后被拦（与伪造的左端无关）', eq(properChainAgain, [429]), properChainAgain.join(','));

  // ★ 跳数配多了是**静默失效**（fail-open）：这里把这个危险方向钉成断言，
  //   让以后改这段代码的人一眼看到"多信一跳 = 客户端可控段变成 IP"。
  const failOpen = await series(srv.port, 7, (i) => ({ 'x-forwarded-for': `1.1.1.${i}, 203.0.113.7` }));
  check('★ 文档化：hops=2 但实际只有 1 层时，2 段头会取【最左】（客户端可控）→ 每次换一个假值即可绕过',
    eq(failOpen, Array(7).fill(200)), '状态码 ' + failOpen.join(','));

  // 启动时必须把这件事喊出来（不能静默）
  const logs = srv.logs();
  check('启动警告：信任 ≥2 跳时打印醒目提示（含 fail-open 说明）',
    /信任 2 跳代理/.test(logs) && /fail-open/.test(logs), logs.split(String.fromCharCode(10)).filter((l) => l.includes('⚠️')).join(' | ').slice(0, 120));
  await stop(srv);

  /* 2e. hops=1 / 0 时不该出现这条警告（避免狼来了） */
  srv = await boot({ TRUST_PROXY_HOPS: '1' });
  await sleep(300);
  check('hops=1 时不打多跳警告', !/信任 1 跳代理/.test(srv.logs()));
} catch (e) {
  check('脚本执行未抛错', false, e && e.message);
} finally {
  await stop(srv);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  console.log('\n' + '='.repeat(60));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
  if (failed.length) {
    for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? '  — ' + f.detail : ''));
    process.exitCode = 1;
  }
}
