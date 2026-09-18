/**
 * 「整体评价缺失」的自愈验收（真实浏览器 + 假模型）。
 *
 * 线上实测：真模型偶尔整块不写 overall（或只写个省略号占位），结果页就变成
 * "综合评分 - 、练习建议空"。这个脚本用假模型**故意不吐 overall**，验两条退路：
 *   · 默认：服务端发现缺失 → 补一次"只问 overall"的小请求 → 分数与建议补上；
 *   · E2E_OVERALL=broken：补救请求也失败 → 用逐句批改统计出**本地估算**并在界面上标注
 *     （绝不假装那是 AI 的判断）。
 *
 * 跑法：node tools/e2e-overall-repair.mjs
 *      E2E_OVERALL=broken node tools/e2e-overall-repair.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs';

const BROKEN = process.env.E2E_OVERALL === 'broken';
const PORT = Number(process.env.E2E_PORT || 8855);
const MOCK = Number(process.env.E2E_MOCK || 9855);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { main: 0, repair: 0, repairSystem: '', repairUser: '' };

/* ---------- 假模型：主请求**不给 overall**；补救请求按模式返回 ---------- */
const SEG_NO_OVERALL = [
  { t: 'meta', title: 'Lesson 3 · Please send me a card', chinese: '我在村口的酒馆吃完午饭，就开始找我的包。', draft: 'After I had lunch at a village pub, I looked for my bag.', original: '' },
  { t: 'ai', ai: 'After I had had lunch at a village pub, I began looking for my bag.' },
  { t: 'sentence', item: { cn: '我在村口的酒馆吃完午饭，就开始找我的包。', draft: 'After I had lunch…', ai: 'After I had had lunch…', original: '', findings: [{ category: '时态', from: 'After I had lunch', to: 'After I had had lunch', level: 'error', explanation: '两个过去动作有先后，先发生的用过去完成时。' }] } },
  { t: 'vocab', item: { word: 'pub', phonetic: '/pʌb/', meaning: '酒馆' } },
  { t: 'idiom', item: { situation: '东西不见', common: 'lost', idiom: 'gone' } },
  { t: 'advanced', item: 'After I had had lunch… · 中文点拨：过去完成时' },
  { t: 'bonus', item: 'look for · 中文说明：寻找' },
  { t: 'done' },
];

const delta = (obj) => `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(obj) + '\n' } }] })}\n\n`;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    const sys = String((payload.messages || []).find((m) => m.role === 'system')?.content || '');
    const usr = String((payload.messages || []).find((m) => m.role === 'user')?.content || '');
    if (/整体评价（overall）缺失/.test(sys)) {
      state.repair += 1;
      state.repairSystem = sys;
      state.repairUser = usr;
      if (BROKEN) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '补救接口挂了（e2e 模拟）' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        score: 88,
        scoreBreakdown: [{ label: '语法与时态', score: 17, max: 20, comment: '过去完成时漏了 had' }],
        issues: 2,
        summary: '补救出来的整体评价：整体不错，主要问题在时态。',
        highlights: ['句子结构完整'],
        advice: ['重点复习过去完成时'],
      }) } }] }));
      return;
    }
    state.main += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    for (const seg of SEG_NO_OVERALL) res.write(delta(seg));   // 故意**没有** overall 这一段
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));

const server = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), AI_BASE_URL: `http://127.0.0.1:${MOCK}/v1`, AI_API_KEY: 'mock-e2e', ALLOW_PRIVATE_BASE_URL: '1' },
  stdio: 'ignore',
});
let up = false;
for (let i = 0; i < 40 && !up; i += 1) {
  try { up = (await fetch(`${BASE}api/health`)).ok; } catch { /* 等 */ }
  if (!up) await sleep(400);
}
if (!up) { console.error('后端启动超时'); process.exit(1); }

const R = [];
const ok = (n, c, d = '') => { R.push({ n, c }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar', { timeout: 30000 });
  await page.locator('.big-textarea').nth(0).fill('我在村口的酒馆吃完午饭，就开始找我的包。');
  await page.locator('.big-textarea').nth(1).fill('After I had lunch at a village pub, I looked for my bag.');
  await page.locator('.actions-bar button.primary-btn').click();
  await page.waitForSelector('.result-sheet', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.stream-banner'), null, { timeout: 30000 });

  const ring = await page.locator('.score-ring').innerText();
  const advice = await page.locator('.overall-card .advice').innerText().catch(() => '');
  const summary = await page.locator('.overall-card p').first().innerText().catch(() => '');

  ok('模型确实没给整体评价（主请求里没有 overall 段）', state.main === 1, `主请求 ${state.main} 次`);
  ok('★ 服务端自动补了一次"只问 overall"的小请求', state.repair === 1, `补救请求 ${state.repair} 次`);
  ok('补救请求带上了逐句批改记录（不是空手要分数）', /逐句批改记录/.test(state.repairUser) && /时态/.test(state.repairUser), state.repairUser.slice(0, 80).replace(/\n/g, ' '));

  if (BROKEN) {
    ok('★ 补救失败时改用本地估算，并**如实标注**（不假装是 AI 判断）', /本地估算/.test(ring), ring.replace(/\n/g, ' '));
    ok('本地估算给出了分数（不是 "-"）', /[0-9]/.test(ring) && !/^-/.test(ring.trim()), ring.replace(/\n/g, ' '));
    ok('本地估算把问题分布讲清楚了', /必改/.test(summary) && /时态/.test(summary + advice), (summary + ' | ' + advice).replace(/\n/g, ' ').slice(0, 120));
    ok('本地估算也给出练习建议', /重点复习/.test(advice), advice.replace(/\n/g, ' ').slice(0, 80));
  } else {
    ok('★ 补救请求把评分补上了（不再是 "-"）', /88/.test(ring), ring.replace(/\n/g, ' '));
    ok('补救请求把练习建议补上了', /重点复习过去完成时/.test(advice), advice.replace(/\n/g, ' ').slice(0, 80));
    ok('补救的整体评价展示在页面上', /补救出来的整体评价/.test(summary), summary.slice(0, 60));
    ok('补救不算"本地估算"（那是 AI 给的）', !/本地估算/.test(ring), ring.replace(/\n/g, ' '));
  }

  ok('逐句解析等内容不受影响（11 句群里的那 1 句还在）', await page.locator('.sentence-card').count() === 1);
  ok('全程没有 JS 报错', errors.length === 0, errors.slice(0, 2).join(' / '));
  await page.screenshot({ path: BROKEN ? 'tools/shotter/ux-shots/overall-local.png' : 'tools/shotter/ux-shots/overall-repaired.png' });
} catch (e) {
  ok('e2e 执行完成', false, String((e && e.message) || e).slice(0, 200));
} finally {
  await browser.close();
  server.kill();
  mock.close();
}

const fail = R.filter((x) => !x.c).length;
console.log(`\n${'='.repeat(62)}`);
console.log(fail ? `❌ ${fail}/${R.length} 项失败` : `✅ 全部 ${R.length} 项通过`);
process.exit(fail ? 1 : 0);
