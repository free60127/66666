/**
 * 错误训练 e2e：真实浏览器走一遍"选课 → 上传材料 → 出题 → 试卷"。
 *
 * 为什么必须跑真机：这一条链路横跨三份本地数据（逐课进度 / 历史记录 / 结果缓存），
 * 任何一处 key 不一致都会表现成"选中的课里没有错题"—— 单测覆盖不到这种装配错误。
 *
 * 跑法：node tools/e2e-drill.mjs   （需要 tools/shotter 下的 Playwright；先 npm run build）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs';

const PORT = Number(process.env.E2E_PORT || 8821);
const MOCK = Number(process.env.E2E_MOCK || 9821);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* mock 模型：批改与出题共用。出题时返回**贴着错题**的卷子。 */
const DRILL_QUIZ = {
  title: '错误训练 · 你在第 2 册犯的错（3 题）',
  questions: [
    { type: '改错', question: '改错：I go to the theatre last week.', options: [], answer: 'I went to the theatre last week.', explanation: '你上次把 go 写成了现在时，过去的事要用过去时。', source: '时态' },
    { type: '填空', question: '填空：It depends ___ the weather.', options: [], answer: 'on', explanation: 'depend 固定接 on，你上次写成了 depend of。', source: '搭配' },
    { type: '选择', question: '选出正确的一句：', options: ['A. I went to a theatre.', 'B. I went to the theatre.', 'C. I go to theatre.', 'D. I went theatre.'], answer: 'B', explanation: '特指那家剧院要用 the，你上次漏了冠词。', source: '冠词' },
  ],
};
const mock = http.createServer((q, r) => {
  let b = '';
  q.on('data', (c) => { b += c; });
  q.on('end', () => {
    const isDrill = /错题清单/.test(b);
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(isDrill ? DRILL_QUIZ : { findings: [] }) } }] }));
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
const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
// 造数据：第 1、2 课练过（进度 + 历史 + 结果缓存），第 3 课练过但历史已被挤掉
await ctx.addInitScript(() => {
  const findings1 = [
    { category: '时态', level: 'error', from: 'I go', to: 'I went', explanation: '过去的事要用过去时' },
    { category: '冠词', level: 'error', from: 'a theatre', to: 'the theatre', explanation: '特指用 the' },
    { category: '地道程度', level: 'improve', from: 'very good', to: 'excellent', explanation: '更地道' },
  ];
  const findings2 = [{ category: '搭配', level: 'error', from: 'depend of', to: 'depend on', explanation: 'depend 接 on' }];
  const mk = (findings) => ({ sentences: [{ cn: '上周我去看戏。', draft: 'I go to the theatre last week.', ai: 'I went to the theatre last week.', findings }] });
  localStorage.setItem('bt-lesson-progress', JSON.stringify({
    'lesson:2-1': { n: 1, best: 80, last: 80, at: Date.now() - 86400000, ms: 60000 },
    'lesson:2-2': { n: 2, best: 90, last: 90, at: Date.now() - 3600000, ms: 120000 },
    'lesson:2-3': { n: 1, best: 70, last: 70, at: Date.now() - 5 * 86400000, ms: 60000 },
  }));
  localStorage.setItem('bt-history', JSON.stringify([
    { jobId: 'jobA', title: 'Lesson 1 · A private conversation', time: Date.now() - 86400000, lessonKey: 'lesson:2-1' },
    { jobId: 'jobB', title: 'Lesson 2 · Breakfast or lunch?', time: Date.now() - 3600000, lessonKey: 'lesson:2-2' },
  ]));
  localStorage.setItem('bt-result-jobA', JSON.stringify(mk(findings1)));
  localStorage.setItem('bt-result-jobB', JSON.stringify(mk(findings2)));
  localStorage.setItem('bt-book', '2');
  localStorage.setItem('bt-lesson', '1');
  // 明确钉住方向（默认就是汉译英；方向选择页已删，进站不再拦人）
  localStorage.setItem('bt-direction', 'cn2en');
});
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.drill-entry', { timeout: 30000 });

  const entry = await page.evaluate(() => document.querySelector('.drill-entry').textContent.replace(/\s+/g, ' ').trim());
  ok('侧栏出现「错误训练」入口，并显示可训练错题数', /错误训练/.test(entry) && /3/.test(entry), entry);

  const pos = await page.evaluate(() => {
    const top = (s) => { const el = document.querySelector(s); return el ? el.getBoundingClientRect().top : null; };
    return { streak: top('.streak-row'), drill: top('.drill-entry'), prog: top('.book-progress') };
  });
  ok('位置在「连续天数」与「进度条」之间',
    pos.drill != null && (pos.streak == null || pos.drill > pos.streak) && (pos.prog == null || pos.drill < pos.prog),
    JSON.stringify(pos));

  await page.locator('.drill-entry').click();
  await page.waitForSelector('.drill-modal', { timeout: 8000 });

  const modal = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.drill-list .drill-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
    checked: document.querySelectorAll('.drill-modal input[type=checkbox]:checked').length,
    summary: document.querySelector('.drill-toolbar') ? document.querySelector('.drill-toolbar').textContent.replace(/\s+/g, ' ').trim() : '',
  }));
  ok('列出练过的课并标注错题数', modal.rows.length >= 3 && modal.rows.some((r) => /2 处错误/.test(r)), modal.rows.slice(0, 3).join(' | '));
  ok('默认已勾好错得最多的课（一进来就能出题）', modal.checked >= 1, `勾选 ${modal.checked} 课`);
  ok('显示"已选 N 课 · M 处错误"', /处错误/.test(modal.summary), modal.summary);

  const missing = await page.evaluate(() => {
    const d = document.querySelector('.drill-missing');
    return d ? { text: d.textContent.replace(/\s+/g, ' ').trim().slice(0, 90) } : null;
  });
  ok('找不到作业记录的课单独列出，并提供上传 PDF', Boolean(missing) && /上传该课 PDF/.test(missing.text), missing ? missing.text : '(没有这一栏)');

  // 上传一个真实（未压缩文字层）的 PDF → 变成出题素材
  const content = 'BT /F1 12 Tf 72 720 Td (Lesson three: please send me a postcard when you are on holiday) Tj ET';
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  for (const o of objs) pdf += o;
  pdf += 'trailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n';

  // 这一栏默认是折叠的（次要路径，不抢主流程的注意力）—— 先展开再点
  await page.locator('.drill-missing summary').click();
  await page.waitForTimeout(300);
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.drill-missing button:has-text("上传该课 PDF")').first().click(),
  ]);
  await fc.setFiles({ name: 'lesson3.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf, 'latin1') });
  await page.waitForTimeout(1500);
  const afterUpload = await page.evaluate(() => document.querySelector('.drill-modal').textContent.replace(/\s+/g, ' '));
  ok('上传 PDF 后成为出题素材，并说明它不是错题',
    /已上传 1 份材料/.test(afterUpload) && /不是.*错题|不会被当成错误/.test(afterUpload), '');

  await page.locator('.drill-modal button:has-text("开始出题")').click();
  await page.waitForSelector('.quiz-item', { timeout: 60000 });
  const quiz = await page.evaluate(() => ({
    title: document.querySelector('.sheet-title h1') ? document.querySelector('.sheet-title h1').textContent.trim() : '',
    count: document.querySelectorAll('.quiz-list .quiz-item').length,
    first: document.querySelector('.quiz-question') ? document.querySelector('.quiz-question').textContent.trim().slice(0, 40) : '',
    // 答案区**一直在 DOM 里**（导出 PDF 要印），屏幕上是加 hidden 类藏起来 —— 所以查类名，不是查存在性
    answersHidden: Boolean(document.querySelector('.quiz-answers') && document.querySelector('.quiz-answers').classList.contains('hidden')),
  }));
  ok('生成针对性训练卷（题量/题干正确）', quiz.count === 3 && /改错|填空/.test(quiz.first), `${quiz.title} · ${quiz.count} 题`);
  ok('默认不显示答案（先做题）', quiz.answersHidden);

  await page.locator('button:has-text("显示答案")').click();
  await page.waitForSelector('.quiz-answers', { timeout: 8000 });
  const ans = await page.evaluate(() => document.querySelector('.quiz-answers').textContent.replace(/\s+/g, ' '));
  ok('解析里点出"你上次错在哪"（这是与普通自测题的区别）', /你上次/.test(ans), ans.slice(0, 60));

  ok('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  ok('e2e 执行未抛错', false, String(e.message || e).slice(0, 200));
} finally {
  await browser.close();
  server.kill();
  mock.close();
}

console.log('\n' + '='.repeat(62));
const failed = R.filter((x) => !x.c);
console.log(failed.length ? `❌ ${failed.length}/${R.length} 项失败` : `✅ 全部 ${R.length} 项通过`);
process.exit(failed.length ? 1 : 0);
