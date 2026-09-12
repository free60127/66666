/**
 * B6（同课二次练习对比）+ B7（收藏 SM-2 复习 + 跨设备进度合并）真实链路验证。
 *
 * 自带 mock LLM（分数逐次变化）与本地后端，跑在真实 Chromium 上 ——
 * 这两块功能依赖"两次练习""两台设备"这类跨时间/跨设备的状态，纯单测覆盖不到。
 *
 * 跑法（playwright 见 tools/shotter/node_modules）：
 *   node tools/e2e-b6b7.mjs
 * 也可以指向已在跑的实例：BASE=https://your-site/ node tools/e2e-b6b7.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// playwright 装在 tools/shotter 下（本机跑真实浏览器用）；CI 里没装 —— 给出明确提示而不是
// 一句 ERR_MODULE_NOT_FOUND。
let chromium;
try {
  ({ chromium } = await import('file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs'));
} catch {
  console.error('缺少 playwright：本机跑 `cd tools/shotter && npm i` 后再执行本脚本（CI 不跑这条链路）。');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.E2E_PORT || 8912);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}/`;

// 自带后端：AI_BASE_URL 指向下面的 mock，并放开"私有地址"限制（安全策略默认禁止）
let server = null;
if (!process.env.BASE) {
  server = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), AI_BASE_URL: 'http://127.0.0.1:9877/v1', AI_API_KEY: 'mock-e2e', ALLOW_PRIVATE_BASE_URL: '1' },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* 还没起来 */ }
    if (!up) await sleep(500);
  }
  if (!up) { console.error('后端启动超时'); process.exit(1); }
}
const R = [];
const ok = (n, c, d = '') => { R.push({ n, c }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

/* ---------- 内嵌 mock LLM：第一次分数低、后面分数高 ---------- */
let analyzeCalls = 0;
const variant = () => {
  analyzeCalls += 1;
  const first = analyzeCalls === 1;
  const findings = first
    ? [
        { category: '拼写', from: 'searched', to: 'looked for', level: 'error', explanation: '搭配错误' },
        { category: '拼写', from: 'bar', to: 'pub', level: 'error', explanation: '选词不当' },
        { category: '时态', from: 'was searching', to: 'had been searching', level: 'error', explanation: '时态' },
        { category: '地道程度', from: 'boss', to: 'landlord', level: 'improve', explanation: '更地道' },
      ]
    : [
        { category: '拼写', from: 'searched', to: 'looked for', level: 'error', explanation: '搭配错误' },
        { category: '地道程度', from: 'boss', to: 'landlord', level: 'improve', explanation: '更地道' },
      ];
  return {
    title: 'Lesson 18 · He often does this!',
    chinese: '我在一家乡村小酒店吃过午饭后，就找我的提包。',
    draft: 'I was searching my bag after having lunch at a little village bar.',
    ai: 'After having lunch at a village pub, I looked for my bag.',
    original: 'After I had had lunch at a village pub, I looked for my bag.',
    overall: { score: first ? 70 : 86, issues: findings.length, summary: first ? '多处搭配与时态问题。' : '进步明显。', highlights: ['句式完整'], advice: ['复习 search for'] },
    sentences: [{ cn: '我在一家乡村小酒店吃过午饭后，就找我的提包。', draft: 'I was searching my bag...', ai: 'After having lunch...', original: 'After I had had lunch...', findings }],
    vocabularyNotes: [{ word: 'look for', phonetic: '/lʊk fɔː/', type: '短语', meaning: '寻找', note: '比 search 更常用', examples: [{ en: 'I looked for my bag.', example: '我在找包。' }] }],
    idiomHighlights: [{ idiom: 'have a good meal', common: 'eat well', explanation: '吃得好', example: 'Did you have a good meal?', situation: '餐厅寒暄' }],
  };
};
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const first = (payload.messages || []).find((m) => m.role === 'user');
    const content = first && first.content;
    if (Array.isArray(content)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'mock ocr' } }] })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(variant()) } }] }));
  });
});
await new Promise((r) => mock.listen(9877, '127.0.0.1', r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const favStore = () => page.evaluate(() => JSON.parse(localStorage.getItem('bt-favorites') || '[]'));
const historyStore = () => page.evaluate(() => JSON.parse(localStorage.getItem('bt-history') || '[]'));
const gen = async () => {
  await page.click('.primary-btn.big');
  await page.waitForSelector('.result-sheet', { timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector('.busy, .progress'), null, { timeout: 90000 }).catch(() => {});
};

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.status-chip', { timeout: 30000 });
  await page.waitForFunction(() => /AI 已配置/.test(document.querySelector('.status-chip')?.textContent || ''), null, { timeout: 60000 });
  ok('前置：后端连上且已配置模型', true);

  // 确认默认就是「课文模式 · 第 2 册 Lesson 18」（B6 的 lessonKey 依赖它）
  const lessonKey = await page.evaluate(() => {
    const active = document.querySelector('.lesson-item.active');
    return active ? active.textContent.trim().slice(0, 20) : '';
  });
  console.log('   当前课文条目：', lessonKey || '(未高亮)');

  await page.fill('.big-textarea >> nth=0', '我在一家乡村小酒店吃过午饭后，就找我的提包。');
  await page.fill('.big-textarea >> nth=1', 'I was searching my bag after having lunch at a little village bar.');

  /* ---------- 计时器（hooks/useTimer.js 的回归守卫） ---------- */
  {
    const before = await page.locator('.timer-display').innerText();
    await page.click('.timer-box >> text=开始计时');
    await sleep(2200);
    const running = await page.locator('.timer-display').innerText();
    ok('计时器：开始后时间在走', /00:0[12]/.test(running.trim()) && running.trim() !== before.trim(), `${before} → ${running}`);
    await page.click('.timer-box >> text=暂停');
    await sleep(300);
    const paused = await page.locator('.timer-display').innerText();
    await sleep(1200);
    const stillPaused = await page.locator('.timer-display').innerText();
    ok('计时器：暂停后不再增长', paused.trim() === stillPaused.trim(), `${paused} / ${stillPaused}`);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-timer') || 'null'));
    ok('计时器：暂停状态与累计值已落盘', stored && stored.running === false && stored.accumulated > 1000 && /^lesson:/.test(stored.lessonKey || ''), JSON.stringify(stored));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.timer-display');
    const afterReload = await page.locator('.timer-display').innerText();
    ok('计时器：刷新后继续显示同一课的累计用时', afterReload.trim() === paused.trim(), `${paused} → ${afterReload}`);
    // 刷新会清空编辑区，重新填一遍再进入后面的生成流程
    await page.fill('.big-textarea >> nth=0', '我在一家乡村小酒店吃过午饭后，就找我的提包。');
    await page.fill('.big-textarea >> nth=1', 'I was searching my bag after having lunch at a little village bar.');
  }

  /* ---------- 第一次练习：不该出现对比块 ---------- */
  await gen();
  ok('B6：首次练习不显示「与上次对比」（没有可比的上一次）', await page.locator('.practice-compare').count() === 0);
  const score1 = await page.locator('.score-ring strong').first().innerText();
  ok('B6：第一次得分 70（mock 第一次返回低分）', score1.trim() === '70', score1);
  ok('B6：结果页有可收藏的 ☆', await page.locator('.fav-star').count() > 0, String(await page.locator('.fav-star').count()));

  // 结果页各板块是否真的渲染出来（App.jsx 拆分后，这条是防"组件搬丢了"的哨兵）
  {
    const parts = await page.evaluate(() => ({
      sections: [...document.querySelectorAll('.sheet-section h2')].map((h) => h.textContent.trim()),
      sentences: document.querySelectorAll('.sentence-card').length,
      vocab: document.querySelectorAll('.vocab-word').length,
      idiom: document.querySelectorAll('.idiom-badge').length,
      stars: document.querySelectorAll('.fav-star').length,
    }));
    const want = ['中文', '原稿', 'AI 修正版', '原文'];
    const hasAll = want.every((w) => parts.sections.some((x) => x.includes(w)));
    ok('结果页：中文/原稿/AI 修正/原文 四段都在', hasAll, parts.sections.join(' | '));
    ok('结果页：逐句解析 / 词汇 / 习语 / 收藏星标都渲染', parts.sentences >= 1 && parts.vocab >= 1 && parts.idiom >= 1 && parts.stars >= 3, JSON.stringify(parts));
  }

  /* ---------- 另外两条任务链路：AI 素材 + 收藏自测题 ---------- */
  {
    await page.click('.result-toolbar >> text=返回编辑');
    await page.waitForSelector('.editor');
    await page.click('text=AI 生成训练素材');
    await page.waitForSelector('.material-modal');
    await page.fill('.material-modal textarea', '城市通勤的一天');
    await page.click('.material-modal >> text=生成素材');
    await page.waitForFunction(() => {
      const el = document.querySelector('.big-textarea');
      return el && el.value && el.value.length > 5;
    }, null, { timeout: 60000 });
    const cn = await page.locator('.big-textarea').first().inputValue();
    ok('AI 素材：生成后回填中文与原文（mock 链路）', cn.includes('中') || cn.length > 0, cn.slice(0, 20));
    // 素材生成会把模式切到「自由模式」；后面的同课对比要课文模式才有 lessonKey
    await page.click('.mode-tabs >> text=课文模式');

  }

  const h1 = await historyStore();
  ok('B6：历史条目带上 lessonKey 与练习时间', h1.length === 1 && /^lesson:\d+-\d+$/.test(h1[0].lessonKey || '') && h1[0].time > 0, JSON.stringify({ key: h1[0]?.lessonKey, time: h1[0]?.time }));

  /* ---------- 第二次练习：出现对比块 ---------- */
  // 上一段刚做完素材生成，此时可能已经在编辑页；在结果页就先返回
  await page.click('.result-toolbar >> text=返回编辑').catch(() => {});
  await page.waitForSelector('.big-textarea');
  await page.fill('.big-textarea >> nth=0', '我在一家乡村小酒店吃过午饭后，就找我的提包。');
  await page.fill('.big-textarea >> nth=1', 'I was searching my bag after having lunch at a little village bar.');
  await gen();

  const cmpCount = await page.locator('.practice-compare').count();
  ok('B6：第二次练习出现「与上次对比」', cmpCount === 1, String(cmpCount));
  if (cmpCount) {
    const text = await page.locator('.practice-compare').innerText();
    ok('B6：对比块显示分数变化 +16', /\+16/.test(text.replace(/\s+/g, '')), text.replace(/\n/g, ' | ').slice(0, 160));
    ok('B6：对比块列出上次的常犯类型与状态', /拼写/.test(text) && /(已改掉|少了|持平|多了)/.test(text));
    ok('B6：上一句提示语（改掉了 N 类）', /改掉/.test(text));
  }
  const score2 = await page.locator('.score-ring strong').first().innerText();
  ok('B6：第二次得分 86', score2.trim() === '86', score2);

  /* ---------- 打开更早那一条历史：不该和自己比 ---------- */
  await page.click('.topbar >> text=历史结果');
  await page.waitForSelector('.history-item');
  const items = page.locator('.history-item');
  await items.nth(await items.count() - 1).click(); // 最后一条 = 最早那次
  await page.waitForSelector('.result-sheet');
  await sleep(400);
  ok('B6：打开更早那次练习时不给它编一个「上次」', await page.locator('.practice-compare').count() === 0);
  ok('B6：更早那次的分数仍是 70', (await page.locator('.score-ring strong').first().innerText()).trim() === '70');

  /* ---------- 回到最新一次，做收藏 + 复习 ---------- */
  await page.click('.topbar >> text=历史结果');
  await page.waitForSelector('.history-item');
  await page.locator('.history-item').first().click();
  await page.waitForSelector('.result-sheet');
  await page.locator('.fav-star').first().click();
  await sleep(300);
  let favs = await favStore();
  ok('B7：收藏后立即带上排期字段', favs.length === 1 && favs[0].ease === 2.5 && favs[0].interval === 0 && favs[0].reps === 0, JSON.stringify(favs[0] && { ease: favs[0].ease, interval: favs[0].interval, reps: favs[0].reps }));
  ok('B7：新收藏当天即到期', favs[0] && favs[0].due <= Date.now());
  const dueText = await page.locator('.due-btn').innerText();
  ok('B7：工具栏出现「今日待复习 (1)」', /今日待复习/.test(dueText) && /\(1\)/.test(dueText), dueText);

  await page.click('.due-btn');
  await page.waitForSelector('.fav-review');
  ok('B7：进入复习，进度显示 1 / 1', /1\s*\/\s*1/.test(await page.locator('.fav-review-progress').innerText()));
  ok('B7：翻面前不显示答案', await page.locator('.fav-review .fav-body').count() === 0);
  await page.click('.fav-review >> text=显示答案');
  await sleep(200);
  ok('B7：翻面后显示答案正文', await page.locator('.fav-review .fav-body').count() === 1);
  const gradeLabels = await page.locator('.grade-btn').allInnerTexts();
  ok('B7：三档评分（忘了 / 一般 / 简单）', gradeLabels.length === 3 && /忘了/.test(gradeLabels[0]) && /一般/.test(gradeLabels[1]) && /简单/.test(gradeLabels[2]), gradeLabels.join(' / ').replace(/\n/g, ' '));
  ok('B7：评分按钮预告下次间隔', /天后再见/.test(gradeLabels[0]));

  await page.click('.grade-btn.easy');
  await sleep(300);
  ok('B7：评分后进入完成态', /今日复习完成/.test(await page.locator('.fav-review').innerText()));
  favs = await favStore();
  ok('B7：「简单」→ 2 天后复习、reps=1、难度因子上调', favs[0] && favs[0].interval === 2 && favs[0].reps === 1 && favs[0].ease > 2.5, JSON.stringify({ interval: favs[0]?.interval, reps: favs[0]?.reps, ease: favs[0]?.ease }));
  ok('B7：due 排到未来（约 2 天后）', favs[0] && favs[0].due > Date.now() + 86400000);
  ok('B7：记住这次评分等级', favs[0] && favs[0].lastGrade === 'easy');

  await page.click('.fav-review >> text=回到收藏列表');
  await sleep(200);
  ok('B7：收藏列表显示到期状态', await page.locator('.fav-item .fav-due').count() === 1, (await page.locator('.fav-item .fav-due').first().innerText().catch(() => '')));
  await page.click('.fav-modal .icon-btn >> nth=0');
  await sleep(200);
  ok('B7：复习完「今日待复习」计数清零', !/\(\d+\)/.test(await page.locator('.due-btn').innerText()), await page.locator('.due-btn').innerText());

  /* ---------- 第三条任务链路：收藏自测题（AI 返回不合格 → 本地题库兜底） ---------- */
  {
    await page.click('.topbar >> text=收藏夹');
    await page.waitForSelector('.fav-modal');
    await page.click('.fav-modal >> text=生成自测题');
    await page.waitForSelector('.quiz-sheet', { timeout: 60000 });
    const quizText = await page.locator('.quiz-sheet').innerText();
    ok('自测题：能从收藏出题（AI 不合格时本地兜底）', /题/.test(quizText) && quizText.length > 20, quizText.slice(0, 40).split(String.fromCharCode(10)).join(' '));
    await page.click('.quiz-sheet >> text=返回编辑');
    await page.waitForSelector('.editor', { timeout: 30000 });
  }

  /* ---------- 刷新后仍是同一份数据（持久化） ---------- */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.due-btn');
  const favsAfter = await favStore();
  ok('B7：刷新后复习进度还在', favsAfter[0] && favsAfter[0].interval === 2 && favsAfter[0].reps === 1 && favsAfter[0].lastGrade === 'easy');
  await page.click('.topbar >> text=历史结果');
  await page.waitForSelector('.history-item');
  await page.locator('.history-item').first().click();
  await page.waitForSelector('.result-sheet');
  await sleep(400);
  ok('B6：刷新后重新打开结果仍能给出对比', await page.locator('.practice-compare').count() === 1);
  const cmpText2 = await page.locator('.practice-compare').innerText();
  ok('B6：对比内容含上次时段（今天）', /今天/.test(cmpText2), cmpText2.split('\n')[0]);

  ok('无控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  /* ---------- B7 跨设备：两台设备都复习过同一张卡，进度不能互相顶掉 ---------- */
  // A 端：生成同步码并把「简单」进度推上去
  await page.click('.side-footer >> text=备份');
  await page.waitForSelector('.modal');
  await page.click('.modal >> text=生成新同步码');
  await page.waitForFunction(() => /^[a-f0-9]{32}$/.test(localStorage.getItem('bt-sync-code') || ''), null, { timeout: 30000 });
  const code = await page.evaluate(() => localStorage.getItem('bt-sync-code'));
  await page.click('.modal >> text=立即同步');
  await sleep(1500);
  await page.click('.modal-head .icon-btn');
  ok('B7 跨设备：A 端生成同步码并推送', Boolean(code), code);

  // B 端：手上是同一张卡（还没复习过），先复习（忘了），再把同步码填进来
  const favorite = (await favStore())[0];
  const ctxB = await browser.newContext({ viewport: { width: 1360, height: 950 } });
  const pageB = await ctxB.newPage();
  await pageB.addInitScript((fav) => {
    localStorage.setItem('bt-favorites', JSON.stringify([{ ...fav, ease: 2.5, interval: 0, reps: 0, due: Date.now() - 1000, lastReviewed: 0, lastGrade: '' }]));
  }, favorite);
  await pageB.goto(BASE, { waitUntil: 'domcontentloaded' });
  await pageB.waitForSelector('.due-btn');
  ok('B7 跨设备：B 端的同一张卡也在待复习里', /\(1\)/.test(await pageB.locator('.due-btn').innerText()));
  await pageB.click('.due-btn');
  await pageB.waitForSelector('.fav-review');
  await pageB.click('.fav-review >> text=显示答案');
  await pageB.click('.grade-btn.forgot');
  await pageB.click('.fav-review >> text=回到收藏列表');
  await pageB.click('.fav-modal .icon-btn >> nth=0');
  const favB = await pageB.evaluate(() => JSON.parse(localStorage.getItem('bt-favorites') || '[]')[0]);
  ok('B7 跨设备：B 端评分「忘了」', favB && favB.lastGrade === 'forgot' && favB.interval === 1 && favB.reps === 0, JSON.stringify({ grade: favB?.lastGrade, interval: favB?.interval }));

  await pageB.click('.side-footer >> text=备份');
  await pageB.waitForSelector('.modal');
  await pageB.fill('input[aria-label="输入已有同步码"]', code);
  await pageB.click('.modal >> text=使用该码');
  await sleep(2500);
  const favB2 = await pageB.evaluate(() => JSON.parse(localStorage.getItem('bt-favorites') || '[]')[0]);
  ok('B7 跨设备：B 端同步后自己的新进度没被云端旧进度顶掉', favB2 && favB2.lastGrade === 'forgot' && favB2.reps === 0, JSON.stringify({ grade: favB2?.lastGrade, reps: favB2?.reps, due: favB2?.due }));

  // A 端再同步一次：应该采纳 B 端更新的复习进度
  await page.click('.side-footer >> text=备份');
  await page.waitForSelector('.modal');
  await page.click('.modal >> text=立即同步');
  await sleep(2500);
  const favA2 = await favStore();
  ok('B7 跨设备：A 端采纳了 B 端更新的复习进度（不再各记各的）', favA2[0] && favA2[0].lastGrade === 'forgot' && favA2[0].interval === 1 && favA2[0].reps === 0, JSON.stringify({ grade: favA2[0]?.lastGrade, interval: favA2[0]?.interval, reps: favA2[0]?.reps }));
  await ctxB.close();

  /* ---------- 账号：注册 → 已登录态（hooks/useAccount.js 的回归守卫） ---------- */
  {
    // 上一步（跨设备同步）可能留着备份弹窗，先关掉再打开
    if (await page.locator('.modal').count()) { await page.click('.modal-head .icon-btn'); await sleep(300); }
    await page.click('.side-footer >> text=备份');
    await page.waitForSelector('.modal');
    await page.click('.modal >> text=注册');
    await page.waitForSelector('.auth-modal');
    const email = `e2e-${Date.now()}@example.com`;
    await page.fill('.auth-modal input[type="email"]', email);
    await page.fill('.auth-modal input[placeholder="怎么称呼你"]', 'E2E');
    await page.fill('.auth-modal input[type="password"]', 'e2e-password-123');
    await page.click('.auth-modal .primary-btn');
    await page.waitForFunction(() => document.querySelector('.auth-modal') === null, null, { timeout: 45000 });
    const acc = await page.evaluate(() => ({
      token: localStorage.getItem('bt-acct-token') || '',
      user: JSON.parse(localStorage.getItem('bt-acct-user') || 'null'),
    }));
    ok('账号：注册成功后本机记住登录态（令牌 + 用户）', acc.token.length > 10 && acc.user && acc.user.email, JSON.stringify({ email: acc.user && acc.user.email, tokenLen: acc.token.length }));
    const backupText = await page.locator('.modal').innerText();
    ok('账号：备份弹窗显示已登录', backupText.includes(email), backupText.split(String.fromCharCode(10)).slice(0, 6).join(' | '));
    await page.click('.modal-head .icon-btn');
    await sleep(200);
  }

  /* ---------- 分享链接：对方设备上没有你的本机缓存，也要能打开 ---------- */
  const shareJob = await page.evaluate(() => (location.hash.match(/^#job=([A-Za-z0-9-]+)/) || [])[1] || '');
  const ctxC = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const pageC = await ctxC.newPage();
  await pageC.goto(BASE + '#job=' + shareJob, { waitUntil: 'domcontentloaded' });
  await pageC.waitForSelector('.result-sheet', { timeout: 45000 });
  const cachedC = await pageC.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('bt-result-')));
  ok('分享链接：接收方设备没有任何本机缓存也能打开', cachedC.length === 0, cachedC.join(','));
  ok('分享链接：内容与分享者一致（评分 86）', (await pageC.locator('.score-ring strong').first().innerText()).trim() === '86');
  ok('分享链接：接收方看不到「与上次对比」（他自己没练过这一课）', await pageC.locator('.practice-compare').count() === 0);
  await ctxC.close();

  // 链接的有效期 = 服务端任务保留期
  const stat = await (await fetch(BASE + 'api/status')).json();
  ok('分享链接：服务端保留期 ≥ 1 年', Number(stat.jobs?.ttlDays) >= 365, JSON.stringify(stat.jobs));
  if (!process.env.BASE && shareJob) {
    const file = path.join('data', 'kv', 'bts_job_' + shareJob.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    const days = (envelope.e - Date.now()) / 86400000;
    ok('分享链接：这条结果的过期时间在 1 年以上（不再 7 天）', days > 365, days.toFixed(1) + ' 天');
  }
} catch (e) {
  ok('脚本执行未抛错', false, e && e.message);
} finally {
  console.log('\n' + '='.repeat(60));
  const f = R.filter((x) => !x.c).length;
  console.log(f ? `❌ ${f} / ${R.length} 项失败` : `✅ 全部 ${R.length} 项通过`);
  if (f) { for (const x of R) if (!x.c) console.log('   FAILED: ' + x.n); }
  if (errors.length) console.log('控制台错误：', errors.slice(0, 5));
  await browser.close();
  mock.close();
  if (server) server.kill();
  process.exit(f ? 1 : 0);
}
