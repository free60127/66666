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
 *   SMOKE_GENERATE=1 node tools/smoke-live.mjs      # 额外跑一次**真实生成**（见下）
 *
 * 关于 SMOKE_GENERATE：默认关闭。
 * 「访客不填 Key 就能用」是这个站的核心承诺，而它只有真跑一次生成才能验证 ——
 * 实测踩过：部署平台的 AI_API_KEY 里混进了界面上的"必填"标记（值成了 `sk-…dff 必`），
 * 此时 /api/status 的 hasKey 依然是 true、页面也显示"AI 已配置"，
 * 但一生成就报一句不知所云的 `Cannot convert argument to a ByteString…`。
 * 因为每次运行都会真实消耗一次模型调用，所以做成显式开关，按需打开（例如发版后手工跑一次）。
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
let hasKey = null; // 后面「离线示例」那一步要用：那个入口只在**没配 Key** 时才显示
try {
  const r = await fetch(API + '/api/status');
  const j = await r.json();
  ok('后端 /api/status 可达', r.ok, `HTTP ${r.status}`);
  ok('任务保留策略已生效', j?.jobs?.max >= 1000, `ttlDays=${j?.jobs?.ttlDays} max=${j?.jobs?.max}`);
  ok('限流信任跳数为 1（XFF 伪造不可绕过）', j?.rateLimit?.trustProxyHops === 1, JSON.stringify(j?.rateLimit));
  // 零成本但很关键：服务端没配 Key 时，访客会被要求自带 Key（"打开就能用"这个承诺就没了）
  hasKey = j?.hasKey === true;
  ok('服务端已配置 AI Key（访客零配置可用）', hasKey === true, `hasKey=${j?.hasKey}`);
  // 本轮新增的可观测字段：并发闸门与限流桶上限（用来确认线上跑的是新版本）
  ok('并发闸门已生效', typeof j?.concurrency?.maxInflight === 'number', JSON.stringify(j?.concurrency));
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

  // 离线示例 → 结果页（验证结果页整棵树）。
  // ⚠️ 这个入口只在**没配服务端 Key** 时渲染（`{!hasAiKey && <button>离线示例</button>}`）。
  // 线上原先 hasKey:false，所以这条一直在跑；配好 Key 之后按钮按设计消失，
  // 硬等它会把整段冒烟卡死（连带后面的侧栏/弹窗检查一起中断）。
  // 所以按 hasKey 分流：配了 Key 就跳过并说明，结果页那条路径交给 SMOKE_GENERATE。
  if (hasKey) {
    console.log('      （跳过「离线示例」：线上已配置 AI Key，该入口按设计隐藏）');
  } else {
    const demo = page.getByRole('button', { name: /离线示例|先看离线示例/ }).first();
    if (await demo.count()) {
      await demo.click();
      await page.waitForSelector('.result-sheet, .sheet, .result-page', { timeout: 20000 }).catch(() => {});
      ok('离线示例能进结果页', await page.locator('text=逐句解析').first().isVisible().catch(() => false));
    } else {
      ok('离线示例入口存在（未配 Key 时应显示）', false, '找不到按钮');
    }
  }

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

  /* ---------- 3. 匿名访客真实生成（SMOKE_GENERATE=1 时才跑） ---------- */
  if (process.env.SMOKE_GENERATE === '1') {
    // 全新上下文 = 全新访客：没有 localStorage，也不会填任何 Key
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const fp = await fresh.newPage();
    const ferr = [];
    fp.on('pageerror', (e) => ferr.push(e.message));
    try {
      await fp.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await fp.waitForSelector('.status-chip', { timeout: 45000 });
      await fp.waitForFunction(() => /AI 已配置/.test(document.querySelector('.status-chip')?.textContent || ''), null, { timeout: 90000 });
      await fp.waitForSelector('.lesson-item', { timeout: 60000 }).catch(() => {});
      const lessons = await fp.evaluate(() => document.querySelectorAll('.lesson-item').length);
      ok('[生成] 课文列表来自后端（跨域时同时验证 CORS）', lessons > 5, `${lessons} 条`);

      await fp.fill('.big-textarea >> nth=0', '上星期我去看戏。');
      await fp.fill('.big-textarea >> nth=1', 'Last week I go to the theatre.');
      await fp.click('.primary-btn.big');
      await fp.waitForSelector('.result-sheet', { timeout: 240000 }).catch(() => {});
      const got = await fp.evaluate(() => ({
        has: Boolean(document.querySelector('.result-sheet')),
        score: (document.querySelector('.score-ring strong')?.textContent || '').trim(),
        err: (document.querySelector('.error-banner')?.textContent || '').trim().slice(0, 160),
      }));
      ok('[生成] 访客不填 Key 直接生成能拿到真实结果', got.has && Boolean(got.score),
        got.has ? `评分 ${got.score}` : `错误：${got.err}`);
    } catch (e) {
      ok('[生成] 访客不填 Key 直接生成能拿到真实结果', false, e.message.slice(0, 120));
    } finally {
      await fresh.close();
    }
  } else {
    console.log('      （跳过真实生成：加 SMOKE_GENERATE=1 可开启，会消耗一次模型调用）');
  }
} catch (e) {
  ok('线上冒烟执行未抛错', false, e.message);
} finally {
  await browser.close();
}

const pass = R.filter((x) => x.c).length;
console.log('\n' + '='.repeat(60));
console.log(`${pass === R.length ? '✅' : '❌'} ${pass} / ${R.length} 项通过  （${BASE}）`);
process.exit(pass === R.length ? 0 : 1);
