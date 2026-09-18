/**
 * 主页「生成回译作业」的流式验收（真实浏览器 + 假模型）。
 *
 * 要证明的只有一件事，但它必须用真机证明：
 * **模型还没写完，结果页已经出来了，而且是边收边长出来的。**
 *
 * 所以假模型带一道**闸门**：先吐 meta + ai + overall + 第 1 句，然后停住等测试放行。
 * 测试在闸门关着的时候去浏览器里检查：结果页已经到了、第 1 句解析已经画出来了、
 * 顶部写着"正在生成"。放行后才补第 2 句与词汇/习语/句式，并断言横幅消失、内容补齐、
 * 结果进了历史 —— 全程不看 sleep 计时，是确定性的。
 *
 * 跑法：node tools/e2e-analyze-stream.mjs   （先 npm run build；用 tools/shotter 下的 Playwright）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs';

const PORT = Number(process.env.E2E_PORT || 8844);
const MOCK = Number(process.env.E2E_MOCK || 9844);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 假模型：一行一段地吐作业解析 ---------- */
const gate = { open: false, waiters: [] };
const openGate = () => { gate.open = true; gate.waiters.splice(0).forEach((f) => f()); };
const waitGate = () => (gate.open ? Promise.resolve() : new Promise((r) => gate.waiters.push(r)));
const state = { streamed: 0, sawStream: false, sawStreamFormat: false, segmentsAtGate: 0, sawJsonFormat: false };

const SEG = {
  meta: { t: 'meta', title: 'Lesson 18 · He often does this!', chinese: '我在村口的酒馆吃完午饭，就开始找我的包。', draft: 'After I had lunch at a village pub, I looked for my bag.', original: '' },
  ai: { t: 'ai', ai: 'After I had had lunch at a village pub, I began looking for my bag.' },
  overall: { t: 'overall', overall: { score: 86, issues: 2, summary: '整体不错，时态与搭配各有一处可改。', highlights: ['句子结构完整'], advice: ['复习过去完成时', '复习 search for 的搭配'], scoreBreakdown: [{ label: '语法与时态', score: 16, max: 20, comment: '过去完成时漏了 had' }] } },
  s1: { t: 'sentence', item: { cn: '我在村口的酒馆吃完午饭，就开始找我的包。', draft: 'After I had lunch at a village pub, I looked for my bag.', ai: 'After I had had lunch at a village pub, I began looking for my bag.', original: '', findings: [{ category: '时态', from: 'After I had lunch', to: 'After I had had lunch', level: 'error', explanation: '两个过去的动作有先后，先发生的用过去完成时。', dimensions: ['固定搭配'], synonyms: [] }] } },
  s2: { t: 'sentence', item: { cn: '包不见了。', draft: 'My bag was lost.', ai: 'My bag was gone.', original: '', findings: [{ category: '词义', from: 'was lost', to: 'was gone', level: 'improve', explanation: 'was gone 更强调"不见了"的状态。', dimensions: ['语域'], synonyms: [] }] } },
  vocab: { t: 'vocab', item: { word: 'pub', phonetic: '/pʌb/', type: '名词', meaning: '酒馆', note: '英式英语里指提供酒水的小店。', examples: [] } },
  idiom: { t: 'idiom', item: { situation: '东西不见了', common: 'lost', idiom: 'gone', example: 'My bag was gone.', explanation: 'gone 比 lost 更口语、更有画面感。' } },
  advanced: { t: 'advanced', item: 'After I had had lunch… · 中文点拨：过去完成时拉开两个动作的先后' },
  bonus: { t: 'bonus', item: 'look for · 中文说明：寻找（强调动作）' },
  done: { t: 'done' },
};

const delta = (obj) => `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(obj) + '\n' } }] })}\n\n`;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    const sys = String((payload.messages || []).find((m) => m.role === 'system')?.content || '');
    state.sawStream = payload.stream === true;
    state.sawStreamFormat = /一行一段/.test(sys);
    state.sawJsonFormat = Boolean(payload.response_format);
    if (!payload.stream) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '这次验收只测流式' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const emit = (obj) => { state.streamed += 1; res.write(delta(obj)); };
    // meta 故意劈成两半发：验"残行留在缓冲里等下一块"
    const metaLine = JSON.stringify(SEG.meta) + '\n';
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: metaLine.slice(0, 25) } }] })}\n\n`);
    await sleep(80);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: metaLine.slice(25) } }] })}\n\n`);
    state.streamed = 1;
    await sleep(60); emit(SEG.ai);
    await sleep(60); emit(SEG.overall);
    await sleep(60); emit(SEG.s1);
    state.segmentsAtGate = state.streamed;   // 闸门前的段数（测试据此判断"还没写完"）
    await waitGate();                        // ← 停住，等浏览器那边确认已经看到第 1 句
    emit(SEG.s2); emit(SEG.vocab); emit(SEG.idiom); emit(SEG.advanced); emit(SEG.bonus); emit(SEG.done);
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

const cards = () => page.locator('.sentence-card').count();

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar', { timeout: 30000 });
  await page.locator('.big-textarea').nth(0).fill('我在村口的酒馆吃完午饭，就开始找我的包。\n包不见了。');
  await page.locator('.big-textarea').nth(1).fill('After I had lunch at a village pub, I looked for my bag. My bag was lost.');

  /* ---------- 1. 点生成 ---------- */
  await page.locator('.actions-bar button.primary-btn').click();

  /* ---------- 2. 闸门还关着：结果页必须已经出来了 ---------- */
  await page.waitForSelector('.result-sheet', { timeout: 30000 });
  ok('★ 模型还没写完，结果页已经自动出现了（不再对着转圈干等）', state.streamed === state.segmentsAtGate && state.segmentsAtGate > 0, `模型已发 ${state.streamed} 段（闸门前 ${state.segmentsAtGate} 段）`);
  ok('★ 顶部显示"正在生成"横幅', await page.locator('.stream-banner').isVisible());
  const banner = await page.locator('.stream-banner').innerText();
  ok('横幅写清正在生成哪一块', /正在生成：/.test(banner), banner.replace(/\s+/g, ' '));
  // 等第 1 句真的画出来再断言 —— 此刻闸门仍关着（模型后面几段还没生成），
  // 这就是"边生成边显示"与"等完一次性显示"的分界线
  await page.waitForFunction(() => document.querySelectorAll('.sentence-card').length >= 1, null, { timeout: 20000 });
  ok('★ 先到的内容已经画出来了：第 1 句解析（模型此刻仍停在闸门后）',
    await cards() === 1 && state.streamed === state.segmentsAtGate,
    `已画 ${await cards()} 个句群 · 模型已发 ${state.streamed} 段`);
  const early = await page.locator('.result-sheet').innerText();
  ok('整体评分与润色段落也先到了', /86/.test(early) && /After I had had lunch/.test(early));
  ok('还没到的部分不会画成空壳（词汇区此时不存在）', await page.locator('.sheet-section.vocab').count() === 0);
  await page.screenshot({ path: 'tools/shotter/ux-shots/analyze-stream-mid.png' });

  /* ---------- 3. 放行：剩下的一次性到齐 ---------- */
  openGate();
  await page.waitForFunction(() => !document.querySelector('.stream-banner'), null, { timeout: 30000 });
  ok('生成完成后横幅自动消失', await page.locator('.stream-banner').count() === 0);
  await page.waitForFunction(() => document.querySelectorAll('.sentence-card').length === 2, null, { timeout: 10000 });
  ok('★ 第 2 句解析补上了（内容真是边收边长出来的）', await cards() === 2, `共 ${await cards()} 个句群`);
  ok('词汇 / 习语 / 高级句式 / 加分表达都已就位',
    await page.locator('.sheet-section.vocab').count() === 1
    && await page.locator('.sheet-section.idiom').count() === 1
    && await page.locator('.sheet-section.summary').count() === 1);
  ok('「取消等待」按钮随横幅一起消失（不再有无处可点的按钮）', await page.locator('.stream-banner button').count() === 0);

  /* ---------- 4. 服务端与前端收敛成同一份 ---------- */
  const jobId = await page.evaluate(() => (location.hash.match(/job=([A-Za-z0-9-]+)/) || [])[1] || '');
  ok('任务号写进了地址栏（超时/刷新还能找回这次作业）', Boolean(jobId), jobId);
  const job = await (await fetch(`${BASE}api/analyze/${jobId}`)).json();
  ok('服务端结果是完整的两句（不是边生成边存了半截）',
    job.job.status === 'done' && job.job.data.sentences.length === 2 && job.job.data.vocabularyNotes.length === 1,
    `${job.job.status} · ${job.job.data.sentences.length} 句`);
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-history') || '[]'));
  ok('这次作业进了历史（与轮询那条路径的收尾完全一致）', history.length === 1 && history[0].jobId === jobId, JSON.stringify(history.map((h) => h.jobId)));
  const shown = await page.locator('.sentence-card').nth(1).innerText();
  ok('画出来的就是服务端存下来的那一句', shown.includes('My bag was gone.'), shown.replace(/\s+/g, ' ').slice(0, 60));

  /* ---------- 5. 请求侧：用对了提示词、没带冲突的 response_format ---------- */
  ok('请求带 stream=true', state.sawStream === true);
  ok('系统提示词追加了"一行一段"的格式说明', state.sawStreamFormat === true);
  ok('★ 流式请求没有带 response_format（带了就与一行一段冲突）', state.sawJsonFormat === false);

  /* ---------- 6. 手机端（390×844）也要能用 ---------- */
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  const mErrors = [];
  mp.on('pageerror', (e) => mErrors.push(String(e.message)));
  await mp.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mp.waitForSelector('.topbar', { timeout: 30000 });
  await mp.locator('.big-textarea').nth(0).fill('我在村口的酒馆吃完午饭，就开始找我的包。');
  await mp.locator('.big-textarea').nth(1).fill('After I had lunch at a village pub, I looked for my bag.');
  await mp.locator('.actions-bar button.primary-btn').click();
  await mp.waitForSelector('.result-sheet', { timeout: 30000 });
  const fit = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  ok('手机端不横向溢出', fit.sw <= fit.w + 1, JSON.stringify(fit));
  ok('手机端也有"正在生成"横幅', await mp.locator('.stream-banner').isVisible());
  await mp.screenshot({ path: 'tools/shotter/ux-shots/analyze-stream-mobile.png' });
  openGate();   // 让请求收尾，避免测试结束时挂着连接
  ok('手机端没有 JS 报错', mErrors.length === 0, mErrors.slice(0, 2).join(' / '));
  await m.close();

  ok('全程没有 JS 报错', errors.length === 0, errors.slice(0, 2).join(' / '));
  await page.screenshot({ path: 'tools/shotter/ux-shots/analyze-stream-done.png' });
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
