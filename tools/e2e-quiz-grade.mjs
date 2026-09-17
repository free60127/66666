/**
 * 自测卷"真能做 + 真能批改"的 e2e：真实浏览器 + 假模型，把整条链路走一遍。
 *
 * 为什么必须跑真机：这一段横跨三件事 —— 浏览器里的交互（点选项/输入/核对）、
 * 服务端的批改任务（mode=grade 提交→轮询）、以及两者的**题号映射**（批次位置 ↔ 卷子题号）。
 * 单测里三者都是假的，接错的地方恰恰只在真机上暴露：点评贴到别的题上、
 * 批改按钮点了没反应、或者本地判过的题又被送去花一次钱。
 *
 * 跑法：node tools/e2e-quiz-grade.mjs   （先 npm run build；用 tools/shotter 下的 Playwright）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs';

const PORT = Number(process.env.E2E_PORT || 8833);
const MOCK = Number(process.env.E2E_MOCK || 9833);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 假模型出的卷子：选择 / 填空 / 改错 / 翻译 各一道（正好覆盖四种判分方式） */
const QUIZ = {
  title: '收藏知识点自测（4 题）',
  level: '四六级',
  count: 4,
  questions: [
    {
      type: '选择',
      question: '当那人试图让快艇转弯时，方向盘脱手了。\nWhen the man tried to ___ the speedboat round, the steering wheel slipped from his grasp.',
      options: ['A. swerve', 'B. swing', 'C. sway', 'D. sweep'],
      answer: 'B',
      explanation: 'swing round 是"（车船）转弯"的固定说法。',
      source: 'swing round',
    },
    {
      type: '填空',
      question: '根据中文提示填空：我刚收到母校的一封信。\nI have just received a letter from my ____.',
      options: [],
      answer: 'old school',
      explanation: '母校 = old school。',
      source: 'old school',
    },
    {
      type: '改错',
      question: '改正下面句子中的错误：When the man tried to swing the speedboat round, the controller slipped from his hands.',
      options: [],
      answer: 'When the man tried to swing the speedboat round, the steering wheel slipped from his grasp.',
      explanation: '快艇上的是舵轮 steering wheel，不是 controller。',
      source: 'steering wheel',
    },
    {
      type: '翻译',
      question: '把这句话译成英文：「他绝望地向他的伙伴挥手。」',
      options: [],
      answer: 'He waved desperately to his companion.',
      explanation: '绝望地 = desperately（副词）。',
      source: 'desperately',
    },
  ],
};

// E2E_BREAK_GRADE=1：让批改接口直接 500 —— 验"AI 用不了"时主观题会不会退回自评
const BREAK_GRADE = process.env.E2E_BREAK_GRADE === '1';
const seen = { gradeUser: '', gradeSystem: '', quizCalls: 0, gradeCalls: 0 };
const mock = http.createServer((q, r) => {
  let b = '';
  q.on('data', (c) => { b += c; });
  q.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(b || '{}'); } catch { /* 忽略 */ }
    const sys = String((payload.messages || []).find((m) => m.role === 'system')?.content || '');
    const usr = String((payload.messages || []).find((m) => m.role === 'user')?.content || '');
    let out;
    if (/批改/.test(sys)) {
      // 批改：按题号回。故意**打乱顺序**，验的是"点评不会贴错题"
      seen.gradeCalls += 1;
      if (BREAK_GRADE) {
        r.writeHead(500, { 'Content-Type': 'application/json' });
        r.end(JSON.stringify({ error: '模型服务不可用（e2e 模拟）' }));
        return;
      }
      seen.gradeUser = usr;
      seen.gradeSystem = sys;
      const idx = [...usr.matchAll(/【第 (\d+) 题/g)].map((m) => Number(m[1]));
      out = { grades: idx.map((i) => (i === 0
        ? { index: i, verdict: 'right', comment: 'AI 复核：改对了，controller → steering wheel 是这道题的关键。', better: '' }
        : { index: i, verdict: 'close', comment: 'AI 点评：desperately 是副词，不要写成 desperate。', better: 'He waved desperately to his companion.' })).reverse() };
    } else {
      seen.quizCalls += 1;
      out = QUIZ;
    }
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
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
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
await ctx.addInitScript(() => {
  const now = Date.now();
  localStorage.setItem('bt-favorites', JSON.stringify([
    { id: 'f1', kind: 'finding', category: '词义', title: 'swerve → swing round', body: '让快艇转弯用 swing round', createdAt: now - 86400000, ease: 2.5, interval: 0, due: now, reps: 0 },
    { id: 'f2', kind: 'vocab', category: '核心词', title: 'desperately', body: '绝望地（副词）', createdAt: now - 86400000, ease: 2.5, interval: 0, due: now, reps: 0 },
  ]));
  localStorage.setItem('bt-direction', 'cn2en');
});
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

const item = (i) => page.locator('.quiz-item').nth(i);
const stat = () => page.locator('.quiz-grade-stat').innerText();

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar', { timeout: 30000 });

  /* ---------- 1. 出题（走真后端 + 假模型） ---------- */
  await page.locator('.topbar button:has-text("收藏夹")').first().click();
  await page.waitForSelector('.fav-modal', { timeout: 8000 });
  await page.locator('.fav-quiz button:has-text("生成自测题")').click();
  await page.waitForSelector('.quiz-sheet', { timeout: 20000 });
  ok('生成的卷子进入"可做题"形态（四个选项是按钮，不是文本）',
    await page.locator('.quiz-item').nth(0).locator('button.quiz-opt').count() === 4,
    String(await page.locator('.quiz-item').nth(0).locator('button.quiz-opt').count()));
  ok('填空题有输入框', await page.getByPlaceholder('填入空格处的内容…').count() === 1);
  ok('改错题有输入框', await page.getByPlaceholder('写出改好的整句…').count() === 1);
  ok('翻译题有输入框', await page.getByPlaceholder('用英文写下你的答案…').count() === 1);
  ok('底部有批改按钮', await page.locator('.quiz-grade-bar button:has-text("批改")').count() === 1);
  ok('没做题时底部提示先做题', /共 4 题/.test(await stat()), await stat());

  /* ---------- 2. 选择题：点一下立刻判 ---------- */
  await page.locator('.quiz-item').nth(0).locator('button.quiz-opt').nth(1).click();   // B. swing
  await page.waitForTimeout(200);
  ok('★ 点选项立刻出判定（不用先按批改）', await item(0).locator('.quiz-verdict.right').count() === 1);
  ok('选中的选项被标绿、且锁住', await item(0).locator('.quiz-opt.right').count() === 1 && await item(0).locator('.quiz-opt').nth(1).isDisabled());
  ok('判定里给出解析', /固定说法/.test(await item(0).innerText()));

  /* ---------- 3. 填空 + 核对 ---------- */
  await page.getByPlaceholder('填入空格处的内容…').fill('Old School.');
  await item(1).locator('button:has-text("核对")').click();
  await page.waitForTimeout(200);
  ok('填空写对（大小写/标点无关）→ 对', await item(1).locator('.quiz-verdict.right').count() === 1);

  /* ---------- 4. 改错：写一个"改对一半"的答案 → 接近（本地）+ AI 复核 ---------- */
  await page.getByPlaceholder('写出改好的整句…').fill('When the man tried to swing the speedboat round, the steering wheel slipped from his hands.');
  await item(2).locator('button:has-text("核对")').click();
  await page.waitForTimeout(200);
  ok('改错改对主要错误、留了一处 → 先判「接近」（不武断判错）', await item(2).locator('.quiz-verdict.close').count() === 1);

  /* ---------- 5. 翻译（主观题）→ 底部批改 ---------- */
  await page.getByPlaceholder('用英文写下你的答案…').fill('He waved desperate to his companion.');
  await page.locator('.quiz-grade-bar button:has-text("批改")').click();
  await page.waitForFunction(() => /AI 批改/.test(document.body.innerText), null, { timeout: 30000 });
  await page.waitForTimeout(300);

  // 这一批断言都依赖"AI 真回话了"；E2E_BREAK_GRADE=1 时走的是第 9 阶段的自评兜底
  if (!BREAK_GRADE) {
    ok('★ 主观题拿到 AI 判定与点评（点选项之外的那一半）', /AI 点评：desperately 是副词/.test(await item(3).innerText()));
    ok('AI 给出更好的表达', /He waved desperately to his companion\./.test(await item(3).innerText()));
    ok('★ 本地判「接近」的改错题也被 AI 复核了（题号没错位）',
      /AI 复核：改对了/.test(await item(2).innerText()) && await item(2).locator('.quiz-verdict.right').count() === 1,
      (await item(2).innerText()).replace(/\n/g, ' | ').slice(0, 120));
    ok('点评没有跑到别的题上（第 1、2 题仍是本地判定）',
      /本地判定/.test(await item(0).innerText()) && /本地判定/.test(await item(1).innerText()));
    ok('模型收到的是学生的作答（不是空）', /He waved desperate to his companion\./.test(seen.gradeUser), '');
    ok('本地已判对的题没有被送进模型（省一次调用）', !/Old School/.test(seen.gradeUser) && !/A\. swerve/.test(seen.gradeUser));
    ok('只发起了 1 次批改调用（主观题 + 存疑题一次批量）', seen.gradeCalls === 1, `批改调用 ${seen.gradeCalls} 次`);

    const s = await stat();
    ok('底部汇总按题统计：对 3 · 接近 1', /对 3/.test(s) && /接近 1/.test(s) && /错 0/.test(s), s.replace(/\s+/g, ' '));
  }
  // 留一张"批改完"的截图（AI 点评、判定标签、底部得分都在这一屏里）
  await item(3).scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'tools/shotter/ux-shots/quiz-grade-done.png' });

  /* ---------- 6. 重做 ---------- */
  if (!BREAK_GRADE) {
    await page.locator('.quiz-grade-bar button:has-text("重做")').click();
    await page.waitForTimeout(200);
    ok('重做清空判定与作答', await page.locator('.quiz-verdict').count() === 0 && /共 4 题/.test(await stat()));
  }

  /* ---------- 7. 打印版仍然可用 ---------- */
  await page.locator('.result-toolbar button:has-text("显示答案")').click();
  await page.waitForTimeout(200);
  ok('「显示答案」仍能放出卷末答案与解析（导出 PDF 用）', await page.locator('.quiz-answers:not(.hidden)').count() === 1);

  ok('全程没有 JS 报错', errors.length === 0, errors.slice(0, 2).join(' / '));
  await page.screenshot({ path: 'tools/shotter/ux-shots/quiz-grade.png', fullPage: false });

  /* ---------- 8. 手机端（390×844）：这套交互在触屏上也得能用 ---------- */
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await m.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('bt-favorites', JSON.stringify([
      { id: 'f1', kind: 'finding', category: '词义', title: 'swerve → swing round', body: '让快艇转弯用 swing round', createdAt: now - 86400000, ease: 2.5, interval: 0, due: now, reps: 0 },
    ]));
    localStorage.setItem('bt-direction', 'cn2en');
  });
  const mp = await m.newPage();
  const mErrors = [];
  mp.on('pageerror', (e) => mErrors.push(String(e.message)));
  await mp.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mp.waitForSelector('.topbar', { timeout: 30000 });
  // 手机端顶栏只留"当前在哪 + 状态"，收藏夹收进了右上角 ⋮（桌面端才是平铺的）
  await mp.locator('.more-btn').click();
  await mp.locator('.more-item:has-text("收藏夹")').click();
  await mp.waitForSelector('.fav-modal', { timeout: 8000 });
  await mp.locator('.fav-quiz button:has-text("生成自测题")').click();
  await mp.waitForSelector('.quiz-sheet', { timeout: 20000 });
  await mp.locator('.quiz-item').nth(0).locator('button.quiz-opt').nth(1).tap();
  await mp.waitForTimeout(250);
  const fit = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  ok('手机端不横向溢出', fit.sw <= fit.w + 1, JSON.stringify(fit));
  ok('手机端选项点得动、判定立刻出现', await mp.locator('.quiz-item').nth(0).locator('.quiz-verdict.right').count() === 1);
  ok('手机端底部批改条在视口里（不用滚到底找按钮）', await mp.locator('.quiz-grade-bar button:has-text("批改")').isVisible());
  await mp.locator('.quiz-grade-bar button:has-text("批改")').scrollIntoViewIfNeeded();
  await mp.waitForTimeout(200);
  await mp.screenshot({ path: 'tools/shotter/ux-shots/quiz-grade-mobile.png' });
  ok('手机端没有 JS 报错', mErrors.length === 0, mErrors.slice(0, 2).join(' / '));
  await m.close();

  /* ---------- 9. AI 不可用（E2E_BREAK_GRADE=1）：主观题退回自评 ---------- */
  if (BREAK_GRADE) {
    const b = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    await b.addInitScript(() => {
      const now = Date.now();
      localStorage.setItem('bt-favorites', JSON.stringify([
        { id: 'f1', kind: 'finding', category: '词义', title: 'swerve → swing round', body: '让快艇转弯用 swing round', createdAt: now - 86400000, ease: 2.5, interval: 0, due: now, reps: 0 },
      ]));
      localStorage.setItem('bt-direction', 'cn2en');
    });
    const bp = await b.newPage();
    const bErrors = [];
    bp.on('pageerror', (e) => bErrors.push(String(e.message)));
    await bp.goto(BASE, { waitUntil: 'domcontentloaded' });
    await bp.waitForSelector('.topbar', { timeout: 30000 });
    await bp.locator('.topbar button:has-text("收藏夹")').first().click();
    await bp.waitForSelector('.fav-modal', { timeout: 8000 });
    await bp.locator('.fav-quiz button:has-text("生成自测题")').click();
    await bp.waitForSelector('.quiz-sheet', { timeout: 20000 });
    // 客观题先本地判（AI 挂了也不该影响它们）
    await bp.locator('.quiz-item').nth(0).locator('button.quiz-opt').nth(1).click();
    await bp.getByPlaceholder('填入空格处的内容…').fill('old school');
    await bp.locator('.quiz-item').nth(1).locator('button:has-text("核对")').click();
    // 主观题交给批改 → 服务端 500 → 应该退回自评而不是一直转圈
    await bp.getByPlaceholder('用英文写下你的答案…').fill('He waved desperate to his companion.');
    await bp.locator('.quiz-grade-bar button:has-text("批改")').click();
    await bp.waitForSelector('.quiz-verdict.pending', { timeout: 30000 });
    const tip = await bp.locator('.quiz-grade-tip').innerText();
    ok('★ AI 挂了不转圈：主观题退回自评，并说明原因', /AI 批改暂时用不了/.test(tip), tip.replace(/\s+/g, ' ').slice(0, 80));
    ok('★ 本地判过的客观题不受影响（1 对 + 1 对还在）', /已批改 2/.test(await bp.locator('.quiz-grade-stat').innerText()), (await bp.locator('.quiz-grade-stat').innerText()).replace(/\s+/g, ' '));
    ok('自评题目里给出标准答案供对照', /He waved desperately to his companion\./.test(await bp.locator('.quiz-item').nth(3).innerText()));
    await bp.locator('.quiz-item').nth(3).locator('button:has-text("我写对了")').click();
    await bp.waitForTimeout(200);
    const after = await bp.locator('.quiz-grade-stat').innerText();
    ok('自评结果计入总分（对 3 · 另一道仍待自评）', /对 3/.test(after) && /待自评 1/.test(after), after.replace(/\s+/g, ' '));
    ok('AI 挂掉这条路径也没有 JS 报错', bErrors.length === 0, bErrors.slice(0, 2).join(' / '));
    await bp.screenshot({ path: 'tools/shotter/ux-shots/quiz-grade-selfjudge.png' });
    await b.close();
  }

  /* ---------- 10. 错误训练出的卷子也必须能做（用户截图里就是这一张） ----------
   * 自测题与错误训练**共用同一个试卷组件**，但这条链路的入口、埋点、数据来源全不一样；
   * 只在自测题那条路上验过，等于没验"从错误训练进来的卷子"。 */
  if (!BREAK_GRADE) {
    const d = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await d.addInitScript(() => {
      const findings1 = [
        { category: '时态', level: 'error', from: 'They had hardly time', to: 'They had hardly had time', explanation: '过去完成时' },
        { category: '搭配', level: 'error', from: 'sign their names in', to: 'sign their names on', explanation: 'on a album 用 on' },
      ];
      const mk = (findings) => ({ sentences: [{ cn: '他们几乎没有时间。', draft: 'They had hardly time.', ai: 'They had hardly had time.', findings }] });
      localStorage.setItem('bt-lesson-progress', JSON.stringify({ 'lesson:4-85': { n: 1, best: 70, last: 70, at: Date.now() - 86400000, ms: 60000 } }));
      localStorage.setItem('bt-history', JSON.stringify([{ jobId: 'jobD1', title: 'Lesson 85 · Never too old to learn', time: Date.now() - 86400000, lessonKey: 'lesson:4-85' }]));
      localStorage.setItem('bt-result-jobD1', JSON.stringify(mk(findings1)));
      localStorage.setItem('bt-book', '4');
      localStorage.setItem('bt-direction', 'cn2en');
    });
    const dp = await d.newPage();
    const dErrors = [];
    dp.on('pageerror', (e) => dErrors.push(String(e.message)));
    await dp.goto(BASE, { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('.drill-entry', { timeout: 30000 });
    await dp.locator('.drill-entry').click();
    await dp.waitForSelector('.drill-modal', { timeout: 8000 });
    await dp.locator('.drill-modal button:has-text("开始出题")').click();
    await dp.waitForSelector('.quiz-sheet', { timeout: 30000 });
    ok('错误训练出的卷子同样是可做的（选项是按钮）',
      await dp.locator('.quiz-item').nth(0).locator('button.quiz-opt').count() === 4,
      String(await dp.locator('.quiz-item').nth(0).locator('button.quiz-opt').count()));
    await dp.locator('.quiz-item').nth(0).locator('button.quiz-opt').nth(1).click();
    await dp.waitForTimeout(200);
    ok('错误训练卷子点选项立刻出判定', await dp.locator('.quiz-item').nth(0).locator('.quiz-verdict.right').count() === 1);
    ok('错误训练卷子底部也有批改条', await dp.locator('.quiz-grade-bar button:has-text("批改")').isVisible());
    ok('错误训练这条路也没有 JS 报错', dErrors.length === 0, dErrors.slice(0, 2).join(' / '));
    await dp.screenshot({ path: 'tools/shotter/ux-shots/quiz-grade-drill.png' });
    await d.close();
  }
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
