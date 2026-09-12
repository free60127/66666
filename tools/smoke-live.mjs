/**
 * 线上冒烟：拿真实浏览器打开**已部署**的站点，跑一遍关键路径。
 *
 * 为什么单独一条：单测与 e2e 跑的都是本机构建产物，部署链路（VITE_BASE 前缀、
 * VITE_API_BASE 注入、跨域、Pages 缓存）出问题时它们全是绿的。
 * 每次重构/发版后跑一遍，能立刻发现"构建成功但线上白屏/接口 404"。
 *
 * 跑法：
 *   node tools/smoke-live.mjs                       # 默认打 GitHub Pages
 *   BASE=http://127.0.0.1:8912/ node tools/smoke-live.mjs
 *   API=https://xxx.onrender.com node tools/smoke-live.mjs
 */
const BASE = process.env.BASE || 'https://free60127.github.io/66666/';
const API = process.env.API || 'https://back-translate-studio.onrender.com';

// 本机 playwright 装在 tools/shotter 下（源码里不去装它）；CI 里 npm i playwright 后用裸模块名
let chromium;
try {
  ({ chromium } = await import('file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs'));
} catch {
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('缺少 playwright：本机 `cd tools/shotter && npm i`，CI 里 `npm i playwright` 后再跑');
    process.exit(2);
  }
}

const R = [];
const ok = (n, c, d = '') => { R.push({ n, c }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 后端接口（线上地址） ---------- */
try {
  const r = await fetch(API + '/api/status');
  const j = await r.json();
  ok('后端 /api/status 可达', r.ok, `HTTP ${r.status}`);
  ok('任务保留策略已生效', j?.jobs?.max >= 1000, `ttlDays=${j?.jobs?.ttlDays} max=${j?.jobs?.max}`);
  ok('限流信任跳数为 1（XFF 伪造不可绕过）', j?.rateLimit?.trustProxyHops === 1, JSON.stringify(j?.rateLimit));
} catch (e) {
  ok('后端 /api/status 可达', false, e.message);
}

/* ---------- 2. 前端页面 ---------- */
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.status-chip', { timeout: 45000 });
  ok('页面渲染出主界面（未白屏）', true, BASE);

  // 首屏资源不能 404（VITE_BASE 配错时这里会挂）
  const failed = [];
  page.on('response', (res) => { if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`); });
  await page.reload({ waitUntil: 'networkidle' });
  ok('刷新后无 4xx/5xx 资源', failed.length === 0, failed.slice(0, 3).join(' | '));

  // 离线示例 → 结果页（不依赖后端 AI Key，能验证结果页整棵树）
  await page.getByRole('button', { name: /离线示例|先看离线示例/ }).first().click();
  await page.waitForSelector('.result-sheet, .sheet, .result-page', { timeout: 20000 }).catch(() => {});
  const hasResult = await page.locator('text=逐句解析').first().isVisible().catch(() => false);
  ok('离线示例能进结果页', hasResult);

  // 侧栏 / 收藏夹 / 历史 / 自建库：四个入口都能打开
  await page.getByRole('button', { name: /编辑器/ }).first().click().catch(() => {});
  await sleep(300);
  const openers = [
    ['收藏', /收藏/],
    ['历史', /历史/],
    ['课文库', /课文库|我的课文/],
  ];
  for (const [name, re] of openers) {
    const btn = page.getByRole('button', { name: re }).first();
    const exists = await btn.count();
    if (!exists) { ok(`${name}入口存在`, false); continue; }
    await btn.click();
    await sleep(400);
    const modal = await page.locator('[role="dialog"], .modal').first().isVisible().catch(() => false);
    ok(`${name}弹窗可打开`, modal);
    await page.keyboard.press('Escape');
    await sleep(250);
  }

  ok('控制台无错误', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 200));
} catch (e) {
  ok('线上冒烟执行未抛错', false, e.message);
} finally {
  await browser.close();
}

const pass = R.filter((x) => x.c).length;
console.log('\n' + '='.repeat(60));
console.log(`${pass === R.length ? '✅' : '❌'} ${pass} / ${R.length} 项通过  （${BASE}）`);
process.exit(pass === R.length ? 0 : 1);
