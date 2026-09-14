/**
 * 练习方向（汉译英 / 英译汉）的真实浏览器验证。
 *
 * 为什么单独一条：方向是**横切**整个界面的维度 —— 编辑器三栏、生成按钮、结果页四栏、
 * 选课映射、OCR 语言、侧栏文案都要跟着翻。纯单测只能钉住文案表本身（test/direction.test.mjs），
 * 钉不住"界面上真的换了"这件事。这里自带 mock 模型与本地后端，跑真实 Chromium。
 *
 * 跑法：node tools/e2e-direction.mjs
 *   （需要 tools/shotter/node_modules 里的 playwright；先 npm run build 生成 dist）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
const { chromium } = await import('file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8991;
const MOCK = 8992;

// mock 模型：按"当前是哪个方向"返回对应的四栏内容（靠 prompt 里出现的字样判断）
const mock = http.createServer((q, r) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    const isEn2Cn = /英译汉/.test(b);
    const data = isEn2Cn
      ? {
        title: '英译汉示例', chinese: 'The quick brown fox jumps over the lazy dog.',
        draft: '快速的棕色狐狸跳过懒狗。', ai: '一只敏捷的棕色狐狸从那只懒狗身上一跃而过。',
        original: '一只敏捷的棕色狐狸跃过那只懒狗。',
        overall: { score: 78, issues: 1, summary: '理解准确，中文略生硬。', highlights: ['意思没跑偏'], advice: ['注意定冠词的处理'] },
        sentences: [{ cn: 'The quick brown fox jumps over the lazy dog.', draft: '快速的棕色狐狸跳过懒狗。', ai: '一只敏捷的棕色狐狸从那只懒狗身上一跃而过。', original: '一只敏捷的棕色狐狸跃过那只懒狗。', findings: [{ category: '欧化', from: '快速的棕色狐狸', to: '一只敏捷的棕色狐狸', level: 'error', explanation: '中文习惯用量词，且"快速的"偏欧化。' }] }],
        vocabularyNotes: [{ word: 'quick', phonetic: '/kwɪk/', type: '形容词', meaning: '敏捷的', note: '译"敏捷"比"快速"更贴合动物动作。' }],
        idiomHighlights: [], advancedSentences: ['把 over 处理成"从…身上一跃而过"更有画面'], bonusExpressions: [],
      }
      : {
        title: '汉译英示例', chinese: '上星期我去看戏。', draft: 'Last week I go to the theatre.',
        ai: 'Last week I went to the theatre.', original: 'Last week I went to the theatre.',
        overall: { score: 70, issues: 1, summary: '时态有问题。', highlights: [], advice: [] },
        sentences: [{ cn: '上星期我去看戏。', draft: 'Last week I go to the theatre.', ai: 'Last week I went to the theatre.', original: 'Last week I went to the theatre.', findings: [{ category: '时态', from: 'I go', to: 'I went', level: 'error', explanation: '上星期是过去时间。' }] }],
        vocabularyNotes: [], idiomHighlights: [], advancedSentences: [], bonusExpressions: [],
      };
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }));
  });
});
await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));
const srv = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), AI_BASE_URL: `http://127.0.0.1:${MOCK}/v1`, AI_API_KEY: 'k', ALLOW_PRIVATE_BASE_URL: '1' },
  stdio: 'ignore',
});
for (let i = 0; i < 40; i += 1) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch { /* wait */ } await sleep(400); }

const R = [];
const ok = (n, c, d = '') => { R.push({ n, c }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// 切方向时若初稿非空会 window.confirm 问一句；Playwright 默认把原生对话框当"取消"，
// 于是切换被静默中止（这个坑踩过一次）——这里统一同意。
page.on('dialog', (d) => d.accept());

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.status-chip');

/* ---------- 1. 进站先选方向 ---------- */
await page.waitForSelector('.dir-modal', { timeout: 15000 }).catch(() => {});
const picker = await page.evaluate(() => {
  const m = document.querySelector('.dir-modal');
  if (!m) return null;
  return { cards: [...m.querySelectorAll('.dir-card')].map((c) => c.querySelector('strong').textContent.trim()), title: m.querySelector('h2').textContent.trim() };
});
ok('进站弹出方向选择页', Boolean(picker), picker ? `${picker.title} · 卡片 ${picker.cards.join('/')}` : '没出现');
ok('两个方向都可选（汉译英 / 英译汉）', Boolean(picker) && picker.cards.join() === '汉译英,英译汉', picker ? picker.cards.join() : '');

/* ---------- 2. 选"英译汉"后编辑器标签整体翻转 ---------- */
await page.locator('.dir-card', { hasText: '英译汉' }).click();
await sleep(400);
const editorText = await page.evaluate(() => ({
  panels: [...document.querySelectorAll('.panel-head h2')].map((h) => h.textContent.trim()),
  fold: document.querySelector('.fold-title')?.textContent.trim(),
  btn: [...document.querySelectorAll('button')].find((b) => /生成完整/.test(b.textContent))?.textContent.trim(),
  dirTabs: [...document.querySelectorAll('.dir-tabs button')].map((b) => b.textContent.trim() + (b.classList.contains('active') ? '(选中)' : '')),
}));
ok('源栏标题变成「英文原文」', editorText.panels.includes('英文原文'), editorText.panels.join(' | '));
ok('初稿栏标题变成「你的中文翻译」', editorText.panels.includes('你的中文翻译'), editorText.panels.join(' | '));
ok('标准答案栏变成「参考译文（标准答案）」', /参考译文/.test(editorText.fold || ''), editorText.fold || '');
ok('生成按钮变成翻译批改', /翻译批改/.test(editorText.btn || ''), editorText.btn || '');
ok('编辑器里出现方向开关且英译汉选中', editorText.dirTabs.join(' ').includes('英译汉(选中)'), editorText.dirTabs.join(' '));

/* ---------- 3. 选课：源栏应填英文、参考译文填中文 ---------- */
await page.locator('.book-tabs button').first().click();
await sleep(300);
await page.locator('.lesson-item').first().click();
await sleep(900);
// 参考译文栏是**条件渲染**（折叠时不进 DOM）—— 先展开再读，否则读到的是 null 而不是内容
await page.locator('.fold-toggle').first().click().catch(() => {});
await sleep(300);
const filled = await page.evaluate(() => {
  const ta = document.querySelectorAll('.big-textarea');
  const refTa = document.querySelector('.original-fold textarea');
  return { source: (ta[0]?.value || '').slice(0, 40), draft: (ta[1]?.value || '').slice(0, 20), ref: (refTa?.value || '').slice(0, 30) };
});
ok('英译汉选课后：源栏装的是英文', /[A-Za-z]{3,}/.test(filled.source) && !/[\u4e00-\u9fff]/.test(filled.source), filled.source || '(空)');
ok('英译汉选课后：参考译文栏装的是中文', /[\u4e00-\u9fff]/.test(filled.ref), filled.ref || '(空)');

/* ---------- 4. 生成 → 结果页标签也翻转 ---------- */
await page.fill('.big-textarea >> nth=1', '快速的棕色狐狸跳过懒狗。');
await page.locator('button:has-text("生成完整")').first().click();
await page.waitForSelector('.result-sheet', { timeout: 90000 });
await page.waitForFunction(() => !document.querySelector('.busy, .progress'), null, { timeout: 90000 }).catch(() => {});
await sleep(400);
const sheet = await page.evaluate(() => ({
  eyebrow: document.querySelector('.eyebrow')?.textContent.trim(),
  sections: [...document.querySelectorAll('.refs-body .section-heading h2, .refs-body h2')].map((h) => h.textContent.trim()),
  refsHint: document.querySelector('.refs-hint')?.textContent.trim(),
  analysisTitle: [...document.querySelectorAll('.sheet-section h2')].map((h) => h.textContent.trim()).find((t) => /逐句/.test(t)),
  score: document.querySelector('.score-ring strong')?.textContent.trim(),
}));
ok('结果页眉写的是翻译批改（不是回译）', /翻译批改/.test(sheet.eyebrow || ''), sheet.eyebrow || '');
ok('结果页四栏标签是英译汉那套', sheet.sections.join('|').includes('英文原文') && sheet.sections.join('|').includes('你的译稿') && sheet.sections.join('|').includes('AI 润色译文'), sheet.sections.join(' / '));
ok('对照材料提示条也换了', /英文原文/.test(sheet.refsHint || ''), sheet.refsHint || '');
ok('逐句解析标题换成"译文对比"', /译文对比/.test(sheet.analysisTitle || ''), sheet.analysisTitle || '');
ok('拿到真实评分', Boolean(sheet.score), sheet.score || '');

/* ---------- 5. 切回汉译英：标签跟着回来 ---------- */
// 上一段结束时已经在编辑页了；这里兜一下，让本段单独跑（或上一段被跳过时）也能工作
if (!(await page.$('.dir-tabs'))) {
  await page.locator('.result-toolbar >> text=返回编辑').first().click();
  await sleep(400);
}
// 切换前先把两栏的内容记下来：等会儿要验证它们**真的换了位置**，而不是只换了标签。
// （用户反馈的错觉正是"标签换了、内容没换"—— 那时要重新点一次课文才会重填。）
// 参考译文栏是**条件渲染**（折叠时不进 DOM）——读取前先确保它是展开的。
// 用 class 判断再点，别靠"猜它现在是开还是关"（之前就是猜错方向，读到空值）。
const ensureFoldOpen = async () => {
  await page.evaluate(() => {
    const fold = document.querySelector('.original-fold');
    if (fold && !fold.classList.contains('open')) document.querySelector('.fold-toggle')?.click();
  });
  await sleep(250);
};
await ensureFoldOpen();
const beforeSwitch = await page.evaluate(() => ({
  src: (document.querySelectorAll('.big-textarea')[0]?.value || '').trim(),
  ref: (document.querySelector('.original-fold textarea')?.value || '').trim(),
}));

await page.locator('.dir-tabs button', { hasText: '汉译英' }).click();
await sleep(450);
await ensureFoldOpen();
const back = await page.evaluate(() => ({
  panels: [...document.querySelectorAll('.panel-head h2')].map((h) => h.textContent.trim()),
  btn: [...document.querySelectorAll('button')].find((b) => /生成完整/.test(b.textContent))?.textContent.trim(),
  src: (document.querySelectorAll('.big-textarea')[0]?.value || '').trim(),
  ref: (document.querySelector('.original-fold textarea')?.value || '').trim(),
  fold: document.querySelector('.fold-title')?.textContent.trim(),
  foldNote: document.querySelector('.fold-note')?.textContent.trim() || '',
}));
ok('切回汉译英后面板标签恢复', back.panels.includes('中文提示') && back.panels.includes('你的英文初稿'), back.panels.join(' | '));
ok('生成按钮也切回回译', /回译/.test(back.btn || ''), back.btn || '');

/* 用户实测反馈的错位：切方向只换了标签，框里还是上一个方向的内容，
   要重新点一次课文才会重填 —— 看着就像"没换"。这里钉住"切换当下就对调"。 */
const hasCjk = (t) => /[一-鿿]/.test(String(t));
ok('切方向后题目栏换成中文（不用重新点课文）',
  hasCjk(back.src) && !/^[A-Za-z][A-Za-z\s,.'!?-]*$/.test(back.src), `题目 = ${back.src.slice(0, 30)}`);
ok('切方向后标准答案栏换成英文', /[A-Za-z]{4,}/.test(back.ref), `${back.fold} = ${back.ref.slice(0, 30)}`);
ok('对调是"互换"而不是复制（两栏内容确实换了位置）',
  Boolean(beforeSwitch.src && beforeSwitch.ref) && back.src === beforeSwitch.ref && back.ref === beforeSwitch.src,
  `题目 ${beforeSwitch.src.slice(0, 10)}… → ${back.src.slice(0, 10)}… ／ 答案 ${beforeSwitch.ref.slice(0, 10)}… → ${back.ref.slice(0, 10)}…`);

/* ---------- 6. 刷新后不再拦人（方向已记住） ---------- */
// 生成完 URL 上带着 #job=，刷新会被"分享链接恢复"送回结果页 —— 那里没有方向开关。
// 先清掉 hash，模拟"关掉页面重新打开"。
await page.evaluate(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname); });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.status-chip', { timeout: 20000 });
await sleep(700);
const afterReload = await page.evaluate(() => ({
  picker: Boolean(document.querySelector('.dir-modal')),
  active: [...document.querySelectorAll('.dir-tabs button')].find((b) => b.classList.contains('active'))?.textContent.trim(),
  saved: localStorage.getItem('bt-direction'),
}));
ok('选过之后刷新不再弹选择页', !afterReload.picker && afterReload.saved === 'cn2en', `bt-direction=${afterReload.saved} 弹窗=${afterReload.picker}`);
ok('刷新后仍停在所选方向', afterReload.active === '汉译英', afterReload.active || '');

/* ---------- 7. 9 个内置库都在侧栏 ---------- */
const tabs = await page.evaluate(() => [...document.querySelectorAll('.book-tabs button')].map((b) => b.textContent.trim()));
const want = ['第 1 册', '第 2 册', '第 3 册', '第 4 册', '四级', '六级', '英语（一）', '英语（二）', '专八'];
ok('侧栏列出全部 9 个内置库', want.every((w) => tabs.includes(w)), tabs.join(' / '));
const emptyTip = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.book-tabs button')].find((x) => x.textContent.trim() === '四级');
  return { title: b?.getAttribute('title') || '', empty: b?.classList.contains('empty') || false };
});
ok('没有语料的库标成"空"并说明该放哪个文件', emptyTip.empty && /cet4\.json/.test(emptyTip.title), emptyTip.title);

ok('全程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close(); srv.kill(); mock.close();
const failed = R.filter((x) => !x.c).length;
console.log(`\n${'='.repeat(60)}`);
console.log(failed ? `❌ ${failed}/${R.length} 项失败` : `✅ 全部 ${R.length} 项通过`);
process.exit(failed ? 1 : 0);
