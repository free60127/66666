/**
 * 重制宣传片用的产品截图（把教材原文换成 AI 原创内容）。
 *
 * 背景：原来的截图里是某套教材的课文原文与译文 —— 那是受版权保护的内容，
 * 放进要公开发出去的宣传片里有实际风险。产品的「AI 生成训练素材」产出的文章是
 * AI 原创、没有版权问题，所以改用它来做演示素材。
 *
 * 跑法（需要先起服务端：node server/index.mjs）：
 *   node tools/make-demo-assets.mjs [主题]
 *
 * 产出：remotion-demo/assets/{editor,result-top,result-score,result-sentences,result-vocab}.png
 *       remotion-demo/assets/demo-content.json（本次用的题目与文本，便于复查）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.DEMO_BASE || 'http://localhost:8787';
const OUT = path.join(ROOT, 'remotion-demo', 'assets');
const TOPIC = process.argv[2] || '城市通勤的早晨';
const LEVEL = process.env.DEMO_LEVEL || '四六级';
const CONTENT = path.join(OUT, 'demo-content.json');
const REUSE = process.argv.includes('--reuse'); // 复用已生成的素材，只重截图

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());

function readEnv() {
  const f = path.join(ROOT, '.env');
  const out = { ...process.env };
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function poll(url, label, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    await sleep(3000);
    const r = await get(url);
    const j = r.job;
    if (j?.status === 'done') return j.data;
    if (j?.status === 'error') throw new Error(`${label} 失败：${j.error}`);
    if (i % 5 === 4) process.stdout.write(`\r  ${label}… 已等 ${(i + 1) * 3} 秒`);
  }
  throw new Error(`${label} 超时`);
}

/**
 * 造一份"学习者初稿"。
 * 直接把原文当草稿的话，逐句解析里一条错误都没有 —— 而演示要展示的恰恰是纠错能力。
 * 所以让模型按中国学生常见的问题改写：时态、搭配、语域、中式表达。
 */
async function makeDraft(env, original) {
  const key = env.AI_API_KEY;
  if (!key) throw new Error('.env 里没有 AI_API_KEY');
  const base = (env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: env.AI_MODEL || 'deepseek-chat',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: '你是英语写作老师。用户给你一段地道的英文，你要把它改写成**一个中国大学生可能写出的初稿**：'
            + '保持原意和段落结构，但要自然地引入 6-9 处常见问题 —— 时态/单复数错误、搭配不当、'
            + '用词过于简单或书面语口语混用、中式英语。改写后要仍然像一篇**通顺的**学生作文，'
            + '不要故意写病句，也不要加注释。只输出改写后的英文正文。',
        },
        { role: 'user', content: original },
      ],
    }),
  });
  if (!r.ok) throw new Error('生成初稿失败 ' + r.status + '：' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return String(d?.choices?.[0]?.message?.content || '').trim();
}

/**
 * 收起左侧课文库。
 * 宣传片里没必要露出"内置了某套教材"这件事 —— 侧栏会列出整套课文的目录，
 * 而那正是这次要把品牌和画面都清理干净的东西。
 */
async function collapseSidebar(page) {
  const btn = page.locator('.side-toggle');
  if (!(await btn.count())) return;
  const label = await btn.getAttribute('aria-label');
  if (label && label.includes('收起')) { await btn.click(); await sleep(700); }
}

async function loadChromium() {
  const p = path.join(ROOT, 'tools', 'shotter', 'node_modules', 'playwright', 'index.mjs');
  const spec = fs.existsSync(p) ? 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '') : 'playwright';
  const { chromium } = await import(spec);
  return chromium;
}

/**
 * 滚到某个区块。
 *
 * 坑：结果页的滚动容器是 `.result` 这个 div（CSS 里 overflow-y:auto），**不是 window** ——
 * 所以 window.scrollTo 完全没作用，四张截图会一模一样（第一版就是这样，靠比 md5 才发现）。
 * 用 scrollIntoView 让它自己去找最近的滚动祖先，再往回退一点调整构图。
 */
async function focusSection(page, selector, offset = 90) {
  const found = await page.evaluate(({ sel, off }) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: 'start', behavior: 'instant' });
    // 找到真正在滚的那个祖先，把标题上方留出呼吸空间
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 4) {
        p.scrollTop = Math.max(0, p.scrollTop - off);
        return true;
      }
      p = p.parentElement;
    }
    return true;
  }, { sel: selector, off: offset });
  await sleep(700);
  return found;
}

console.log('=== 重制宣传片素材 ===\n');

/* ---------- 1~3. 素材与批改（或复用） ---------- */
let content;
if (REUSE && fs.existsSync(CONTENT)) {
  content = JSON.parse(fs.readFileSync(CONTENT, 'utf8'));
  console.log(`复用已有素材：《${content.title}》  jobId=${content.jobId}\n`);
} else {
  console.log(`主题：${TOPIC}    等级：${LEVEL}\n`);
  console.log('[1/4] 生成 AI 原创文章…');
  const jm = await post('/api/generate-material', { topic: TOPIC, level: '中级', style: '生活故事' });
  if (!jm.jobId) throw new Error('提交素材任务失败：' + JSON.stringify(jm));
  const mat = await poll('/api/generate-material/' + jm.jobId, '素材');
  console.log(`\r  ✓ 《${mat.title}》 ${mat.original.length} 字符，中文 ${mat.chinese.length} 字符`);

  console.log('[2/4] 生成学习者初稿（带常见错误，否则演示不出纠错能力）…');
  const draft = await makeDraft(readEnv(), mat.original);
  console.log(`  ✓ 初稿 ${draft.length} 字符`);

  console.log('[3/4] 走一次真实批改…');
  const ja = await post('/api/analyze', { title: mat.title, chinese: mat.chinese, draft, original: mat.original, level: LEVEL });
  if (!ja.jobId) throw new Error('提交批改任务失败：' + JSON.stringify(ja));
  const job = await poll('/api/analyze/' + ja.jobId, '批改');
  console.log(`\r  ✓ 完成：${(job.sentences || []).length} 句、${(job.vocabularyNotes || []).length} 个词汇点`);

  content = { topic: TOPIC, level: LEVEL, title: mat.title, chinese: mat.chinese, original: mat.original, draft, jobId: ja.jobId };
  // 立刻落盘：后面截图万一失败，素材不用重新花钱生成
  fs.writeFileSync(CONTENT, JSON.stringify(content, null, 2));
  console.log(`  ✓ 素材已存 ${path.relative(ROOT, CONTENT)}`);
}

/* ---------- 4. 截图 ---------- */
console.log('[4/4] 截图…');
const chromium = await loadChromium();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('dialog', (d) => d.accept());

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name) });
  console.log(`  ✓ ${name.padEnd(24)} ${Math.round(fs.statSync(path.join(OUT, name)).size / 1024)} KB`);
};

// —— 编辑区 ——
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /\d+\s*课/.test(document.body.innerText), null, { timeout: 60000 });
await sleep(1500);
await page.getByRole('button', { name: '自由模式' }).first().click().catch(() => {});
await sleep(400);
// 光切模式标签不够 —— 课文匹配提示条还在，会露出教材的课次与标题
// （而且和"自由回译训练"的标题自相矛盾）。点提示条里的「改用自由模式」清掉它。
await page.getByRole('button', { name: '改用自由模式' }).first().click().catch(() => {});
await sleep(600);
const tas = page.locator('textarea');
if (await tas.count() >= 2) { await tas.nth(0).fill(content.chinese); await tas.nth(1).fill(content.draft); }
const titleBox = page.locator('#bt-title');
if (await titleBox.count()) await titleBox.fill(content.title);
await sleep(700);
await collapseSidebar(page);
await page.evaluate(() => document.querySelector('.editor')?.scrollTo({ top: 0 }));
await sleep(300);
await shot('editor.png');

// —— 结果页 ——
// 关键：从 '/' 跳到 '/#job=xxx' 只是 hash 变化，浏览器**不会重新加载页面**，
// React 就不会重新挂载，读 hash 的那个 effect 根本不会跑（第一版就栽在这）。
// 先跳一次 about:blank 强制整页加载。
await page.goto('about:blank');
await page.goto(BASE + '/#job=' + content.jobId, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForSelector('.sheet', { timeout: 40000 });
} catch (e) {
  const txt = await page.evaluate(() => document.body.innerText).catch(() => '(取不到)');
  console.log('  ✗ 结果页没渲染出来，当前正文：\n' + txt.slice(0, 400));
  throw e;
}
await sleep(3000);
await collapseSidebar(page);   // 整页重载后 React 状态重置，要再收一次
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
await sleep(500);
await shot('result-top.png');

await focusSection(page, '.sheet-section.summary', 120);
await shot('result-score.png');

await focusSection(page, '.findings', 90);
await shot('result-sentences.png');

await focusSection(page, '.sheet-section.vocab', 90);
await shot('result-vocab.png');

await browser.close();
console.log('\n完成。素材内容见 remotion-demo/assets/demo-content.json，可复查确认无版权内容。');
