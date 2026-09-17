/**
 * 真实用户模拟探针：把"电脑端用户"和"手机端用户"会做的事**真做一遍**，
 * 顺带把边界/异常路径也压一遍，把看着像 bug 的地方量出来。
 *
 * 跑法（需先 npm run build，或让脚本自己起后端）：
 *   node tools/qa-user-sim.mjs
 *   BASE=https://back-translate-studio.onrender.com/ node tools/qa-user-sim.mjs   # 打真站（只跑只读部分）
 *
 * 与另外两个脚本的分工：
 *   · e2e-b6b7.mjs            —— 功能是否正确（同课对比 / SM-2 / 跨设备合并）
 *   · qa-probe-mobile-desktop —— 布局几何是否成立
 *   · qa-user-sim.mjs（本文件）—— 像人一样走完整流程 + 边界与异常输入
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

let chromium;
try {
  ({ chromium } = await import('file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs'));
} catch {
  console.error('缺少 playwright：cd tools/shotter && npm i');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.SIM_PORT || 8921);
const MOCK_PORT = Number(process.env.SIM_MOCK_PORT || 9879);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}/`;
const LIVE = Boolean(process.env.BASE);

/* ---------- 后端 ---------- */
let server = null;
if (!LIVE) {
  server = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, AI_API_KEY: 'mock-sim', ALLOW_PRIVATE_BASE_URL: '1' },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* 等 */ }
    if (!up) await sleep(500);
  }
  if (!up) { console.error('后端启动超时'); process.exit(1); }
}

/* ---------- 可遥控的 mock 模型 ---------- */
const ctl = { fail: 0, delayMs: 0, analyzeCalls: 0 };
const ANALYZE = (score = 86) => ({
  title: 'Lesson 18 · He often does this!',
  chinese: '我在一家乡村小酒店吃过午饭后，就找我的提包。',
  draft: 'I was searching my bag after having lunch at a little village bar.',
  ai: 'After having lunch at a village pub, I looked for my bag.',
  original: 'After I had had lunch at a village pub, I looked for my bag.',
  overall: { score, issues: 2, summary: '总体不错，时态与搭配各有一处问题。', highlights: ['句式完整', '用词准确'], advice: ['复习 search for 与 pub 的用法'] },
  sentences: [{
    cn: '我在一家乡村小酒店吃过午饭后，就找我的提包。',
    draft: 'I was searching my bag after having lunch at a little village bar.',
    ai: 'After having lunch at a village pub, I looked for my bag.',
    original: 'After I had had lunch at a village pub, I looked for my bag.',
    findings: [
      { category: '搭配', from: 'searched my bag', to: 'looked for my bag', level: 'error', explanation: 'search 是及物动词，search sth 意为搜查某处' },
      { category: '地道程度', from: 'bar', to: 'pub', level: 'improve', explanation: '英式英语里 pub 更贴切' },
    ],
  }],
  vocabularyNotes: [{ word: 'look for', phonetic: '/lʊk fɔː/', type: '短语', meaning: '寻找', note: '比 search 更常用', examples: [{ en: 'I looked for my bag.', example: '我在找包。' }] }],
  idiomHighlights: [{ idiom: 'have a good meal', common: 'eat well', explanation: '吃得好', example: 'Did you have a good meal?', situation: '餐厅寒暄' }],
});
const QUIZ = {
  title: '回译本 · 收藏知识点自测（2 题）',
  questions: [
    { type: '填空', question: 'After having lunch, I ____ my bag.', options: ['looked for', 'searched for', 'looked at', 'found'], answer: 'looked for', explanation: 'look for 才是"寻找"', source: 'look for' },
    { type: '选择', question: '哪个更地道？', options: ['A. bar', 'B. pub'], answer: 'B', explanation: 'pub 更贴切', source: 'bar → pub' },
  ],
};
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (ctl.fail) { res.writeHead(ctl.fail, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock upstream failure' } })); return; }
    if (ctl.delayMs) await sleep(ctl.delayMs);
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    const sys = (payload.messages || []).find((m) => m.role === 'system');
    const sysText = typeof sys?.content === 'string' ? sys.content : '';
    const first = (payload.messages || []).find((m) => m.role === 'user');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (Array.isArray(first?.content)) { res.end(JSON.stringify({ choices: [{ message: { content: 'mock ocr 识别文本' } }] })); return; }
    let content;
    if (sysText.startsWith('你是英语自测题出题老师')) content = QUIZ;
    else if (sysText.startsWith('你是英语老师，正在给一个学生做')) content = { title: '错误训练 · 2 题', questions: QUIZ.questions };
    else { ctl.analyzeCalls += 1; content = ANALYZE(70 + ctl.analyzeCalls); }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
});
if (!LIVE) await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

/* ---------- 断言 ---------- */
const R = [];
const ok = (n, c, d = '') => { R.push({ n, c, d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const note = (s) => console.log(`      · ${s}`);
const head = (s) => console.log(`\n---------- ${s} ----------`);

const browser = await chromium.launch();

/** 忽略与本次检查无关的噪声（离线字体、favicon 之类） */
const IGNORE = [/favicon/i, /Failed to load resource: the server responded with a status of 404/i, /ERR_INTERNET_DISCONNECTED/i];
const watchErrors = (page) => {
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.some((re) => re.test(m.text()))) errs.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  return errs;
};

/**
 * 点顶栏上的次要入口（历史结果 / 收藏夹 / 今日待复习）。
 * 桌面端这些按钮平铺在顶栏；手机端已经收进右上角的 ⋮ 菜单 —— 两种情况都要能点到。
 */
async function openTopAction(page, label) {
  const direct = page.locator('.topbar .ghost-btn, .topbar .due-btn').filter({ hasText: label }).first();
  if (await direct.count() && await direct.isVisible().catch(() => false)) { await direct.click(); return 'topbar'; }
  await page.click('.more-btn');
  await sleep(300);
  await page.locator('.more-item').filter({ hasText: label }).first().click();
  return 'more-menu';
}

/** 收起手机端浮层侧栏（它会盖住顶栏按钮，点别的东西之前必须先收起来） */
async function ensureSidebarClosed(page) {
  const open = await page.evaluate(() => {
    const s = document.querySelector('.sidebar');
    if (!s) return false;
    const cs = getComputedStyle(s);
    if (cs.display === 'none' || cs.position !== 'fixed') return false;
    return s.getBoundingClientRect().width > 0;
  });
  if (!open) return;
  const btn = await page.$('.sidebar-close');
  if (btn) await btn.click().catch(() => {}); else await page.keyboard.press('Escape');
  await sleep(350);
}

async function openSidebar(page) {
  const state = await page.evaluate(() => {
    const s = document.querySelector('.sidebar');
    if (!s) return 'missing';
    const cs = getComputedStyle(s);
    if (cs.display === 'none') return 'closed';
    if (cs.position === 'fixed') return 'open';
    return parseFloat(cs.marginLeft) < 0 ? 'collapsed' : 'open';
  });
  if (state === 'open' || state === 'missing') return;
  const t = await page.$('.side-toggle');
  if (t) await t.click().catch(() => {});
  await sleep(350);
}
async function closeAnyModal(page) {
  for (let i = 0; i < 3; i += 1) {
    if (!(await page.$('.modal-mask'))) return;
    await page.keyboard.press('Escape');
    await sleep(200);
  }
}
/** 等应用"活着且可交互"（状态栏出现即为就绪） */
async function boot(page) {
  await page.waitForSelector('.status-chip', { timeout: 30000 });
  await page.waitForSelector('.editor, .result', { timeout: 30000 });
}
/** 填内容并生成，返回是否等到结果页 */
/**
 * 拿到一个结果页。
 *
 * ⚠️ 指向真站（BASE=…）时**绝不能真的调模型** —— 那花的是站长的钱，
 * 而且真模型一次批改常常超过 60 秒。所以 LIVE 模式改走「离线示例」
 * （loadDemo：不走网络，直接进结果页），流程与断言完全一致。
 */
async function generate(page, { chinese, draft, title } = {}) {
  if (LIVE) throw new Error('LIVE 模式不应调用生成（会花站长的钱）');
  if (title !== undefined) await page.fill('.title-field input', title);
  await page.fill('.big-textarea >> nth=0', chinese ?? '我在一家乡村小酒店吃过午饭后，就找我的提包。');
  await page.fill('.big-textarea >> nth=1', draft ?? 'I was searching my bag after having lunch at a little village bar.');
  await page.click('.primary-btn.big');
  await page.waitForSelector('.result', { timeout: 60000 });
}

/**
 * 侧栏能不能滚到最后一课 —— 用 elementFromPoint 判定"真的看得见"。
 *
 * 为什么不能用 getBoundingClientRect 判断：课时列表被挤成 0 高时，
 * 里面每个 .lesson-item 自己的 rect 依然是"正常"的（有几 px 高、坐标也在视口内），
 * 只是被 0 高的祖先裁掉了 —— 用 rect 判定会**假通过**（踩过：列表高 0px 却报"末课可见"）。
 * elementFromPoint 取该点最上层的真实元素，被裁掉就命不中，这才是可信的判据。
 */
async function reachLastLesson(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('.lesson-item')];
    if (!items.length) return { ok: false, why: '没有课时' };
    const last = items[items.length - 1];
    last.scrollIntoView({ block: 'nearest' });
    const r = last.getBoundingClientRect();
    const cx = r.left + Math.min(20, r.width / 2);
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const visible = r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1
      && Boolean(hit) && (last === hit || last.contains(hit) || hit.contains(last));
    return {
      ok: visible,
      why: `末课 y=${Math.round(r.top)}→${Math.round(r.bottom)}（视口高 ${window.innerHeight}）· 该点命中 ${hit ? (hit.className || hit.tagName).toString().slice(0, 24) : 'null'}`,
    };
  });
}

/**
 * 等课表真的加载出来再搜索：真站冷启动要 30-60 秒，提前输入会搜到空列表。
 *
 * 用 state:'attached' 而不是默认的 visible —— 手机上侧栏是 `.collapsed{display:none}`，
 * 课表其实已经加载好了（96 个 .lesson-item 都在 DOM 里），只是"不可见"，
 * 等 visible 会一直等到超时（实测 90 秒后报错，日志里还写着"resolved to 96 elements"）。
 */
async function waitLessonList(page) {
  await page.waitForSelector('.lesson-item', { state: 'attached', timeout: 90000 });
}

/* ==================================================================
 * 一、电脑端用户：走一遍完整真实旅程
 * ================================================================== */
async function desktopJourney() {
  head('电脑端用户（1360×950）');
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
  const page = await ctx.newPage();
  const errs = watchErrors(page);
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await boot(page);

  const first = await page.evaluate(() => ({
    masks: [...document.querySelectorAll('.modal-mask')].filter((m) => m.getBoundingClientRect().width > 0).length,
    editor: Boolean(document.querySelector('.editor')),
    sidebar: getComputedStyle(document.querySelector('.sidebar')).marginLeft,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  ok('[桌面] 首屏直接可用、无遮罩', first.masks === 0 && first.editor, `遮罩=${first.masks} 编辑器=${first.editor}`);
  ok('[桌面] 首屏无横向溢出', first.overflow <= 1, `超出 ${first.overflow}px`);

  // 搜索课文 → 打开
  await waitLessonList(page);
  await page.fill('.lesson-search input', '18');
  await sleep(300);
  const hits = await page.locator('.lesson-item').count();
  ok('[桌面] 搜索课号能命中列表', hits > 0, `命中 ${hits} 条`);
  await page.click('.lesson-item >> nth=0');
  await sleep(400);
  const filled = await page.evaluate(() => ({
    title: document.querySelector('.title-field input')?.value || '',
    cn: document.querySelectorAll('.big-textarea')[0]?.value || '',
    draft: document.querySelectorAll('.big-textarea')[1]?.value || '',
    original: document.querySelector('.original-textarea')?.value || '',
    foldNote: document.querySelector('.fold-note')?.innerText.trim() || '',
    matched: Boolean(document.querySelector('.match-banner')),
  }));
  // 语义：选课只带出「标题 + 中文 + 英文原文」，**初稿必须留空**让用户自己写 ——
  // 初稿若被自动填上，回译训练就失去意义了（这条断言是故意写成"必须为空"的）。
  ok('[桌面] 选课带出标题与中文', Boolean(filled.title && filled.cn), `标题="${filled.title.slice(0, 24)}" 中文 ${filled.cn.length} 字`);
  ok('[桌面] 选课不带出初稿（留白给用户写）', filled.draft === '', filled.draft ? `初稿被自动填了 ${filled.draft.length} 字` : '');
  ok('[桌面] 内置课文能匹配到原文', filled.matched || Boolean(filled.original) || /已自动带入/.test(filled.foldNote),
    filled.matched ? '出现匹配横幅' : `fold 提示="${filled.foldNote.slice(0, 40)}"`);

  if (LIVE) {
    // 真站上「离线示例」按钮只在没配 Key 时才渲染，而生成要花站长的钱 ——
    // 真站只跑不花钱的部分（首屏 / 布局 / 搜索选课），结果页相关的检查由本机 mock 覆盖。
    note('LIVE 模式：只跑不花钱的检查；结果页/生成相关断言请用本机 mock 跑（node tools/qa-user-sim.mjs）');
    ok('[桌面·真站] 全程零 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();
    return;
  }

  // 生成（初稿要自己写：选课只给中文与原文）
  await page.fill('.big-textarea >> nth=1', 'I was searching my bag after having lunch at a little village bar.');
  await page.click('.primary-btn.big');
  const progressShown = await page.waitForSelector('.progress-box', { timeout: 8000 }).then(() => true).catch(() => false);
  await page.waitForSelector('.result', { timeout: 60000 });
  ok('[桌面] 点生成后先出现进度条再出结果', progressShown, progressShown ? '' : '没看到 .progress-box');

  const res = await page.evaluate(() => ({
    glance: document.querySelector('.sheet-glance')?.innerText.replace(/\n/g, ' ') || '',
    sentences: document.querySelectorAll('.sheet-section.analysis .finding-diff, .v-row').length,
    findings: document.querySelectorAll('.finding-top').length,
    refs: Boolean(document.querySelector('.refs')),
    vocab: Boolean(document.querySelector('.sheet-section.vocab')),
    idiom: Boolean(document.querySelector('.sheet-section.idiom')),
    summary: Boolean(document.querySelector('.sheet-section.summary')),
  }));
  ok('[桌面] 结果页给出评分速览', /\d/.test(res.glance), res.glance.slice(0, 60));
  ok('[桌面] 结果页有逐句解析 + 词汇 + 习语 + 总结', res.findings > 0 && res.vocab && res.idiom && res.summary,
    `findings=${res.findings} 词汇=${res.vocab} 习语=${res.idiom} 总结=${res.summary}`);

  // 收藏一个词
  const starBefore = await page.locator('.fav-star').count();
  if (starBefore > 0) {
    await page.click('.fav-star >> nth=0');
    await sleep(400);
    const favCount = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.ghost-btn')].find((x) => /收藏夹/.test(x.textContent));
      const m = (b?.textContent || '').match(/\((\d+)\)/);
      return m ? Number(m[1]) : 0;
    });
    ok('[桌面] 结果页点★能收进收藏夹（顶栏计数 +1）', favCount >= 1, `收藏夹计数=${favCount}`);
  } else {
    ok('[桌面] 结果页有可收藏的★入口', false, '页面上找不到 .fav-star');
  }

  // 收藏夹弹窗
  await page.click('.ghost-btn >> text=收藏夹');
  await sleep(400);
  const favModal = await page.evaluate(() => ({
    open: Boolean(document.querySelector('.modal-mask')),
    items: document.querySelectorAll('.fav-row, .fav-item').length,
    text: (document.querySelector('.modal')?.innerText || '').slice(0, 80).replace(/\n/g, ' '),
  }));
  ok('[桌面] 收藏夹弹窗能打开并列出条目', favModal.open && favModal.items > 0, `条目=${favModal.items} "${favModal.text}"`);
  await closeAnyModal(page);
  ok('[桌面] Esc 能关掉弹窗', !(await page.$('.modal-mask')), '');

  // 历史结果 → 重新载入
  await page.click('.ghost-btn >> text=历史结果');
  await sleep(400);
  const histCount = await page.locator('.history-item').count();
  ok('[桌面] 历史结果里记下了这一次练习', histCount > 0, `${histCount} 条`);
  if (histCount > 0) {
    await page.click('.history-open >> nth=0');
    await page.waitForSelector('.result', { timeout: 20000 });
    const restored = await page.evaluate(() => Boolean(document.querySelector('.sheet-glance')));
    ok('[桌面] 从历史点开能还原结果页', restored, '');
  }
  await closeAnyModal(page);

  // 自测题
  await page.click('.ghost-btn >> text=收藏夹');
  await sleep(400);
  const quizBtn = page.locator('.modal button', { hasText: /出题|自测/ }).first();
  if (await quizBtn.count()) {
    await quizBtn.click();
    const gotQuiz = await page.waitForSelector('.quiz-sheet', { timeout: 60000 }).then(() => true).catch(() => false);
    ok('[桌面] 能从收藏夹出题（AI 不合格时本地兜底）', gotQuiz, '');
    if (gotQuiz) {
      const q = await page.evaluate(() => ({ n: document.querySelectorAll('.quiz-question').length, ansHidden: document.querySelector('.quiz-answers')?.classList.contains('hidden') }));
      ok('[桌面] 自测题先藏答案、能核对答案', q.n > 0, `题目=${q.n} 答案默认隐藏=${q.ansHidden}`);
      await page.click('text=返回编辑').catch(() => {});
      await sleep(300);
    }
  } else {
    ok('[桌面] 收藏夹里有出题入口', false, '没找到出题按钮');
  }
  await closeAnyModal(page);

  // 刷新持久化
  await page.reload({ waitUntil: 'domcontentloaded' });
  await boot(page);
  const afterReload = await page.evaluate(() => ({
    fav: [...document.querySelectorAll('.ghost-btn')].find((x) => /收藏夹/.test(x.textContent))?.textContent || '',
    hist: [...document.querySelectorAll('.ghost-btn')].find((x) => /历史结果/.test(x.textContent))?.textContent || '',
  }));
  ok('[桌面] 刷新后收藏夹/历史都还在（localStorage 落盘）', /\(\d+\)/.test(afterReload.fav) && /\(\d+\)/.test(afterReload.hist),
    `${afterReload.fav.trim()} / ${afterReload.hist.trim()}`);

  ok('[桌面] 全程零 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

/* ==================================================================
 * 二、手机端用户：触屏走一遍
 * ================================================================== */
async function mobileJourney() {
  head('手机端用户（390×844 触屏）');
  const W = 390;
  const ctx = await browser.newContext({
    viewport: { width: W, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  const errs = watchErrors(page);
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await boot(page);

  const overflowOf = () => page.evaluate((w) => {
    const bad = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > w + 1 || r.left < -1)) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed') return;
        bad.push({ cls: el.className.toString().slice(0, 34), right: Math.round(r.right), left: Math.round(r.left) });
      }
    });
    return { doc: document.documentElement.scrollWidth, bad: bad.slice(0, 8) };
  }, W);

  const firstOver = await overflowOf();
  ok('[手机] 首屏无横向溢出', firstOver.doc <= W + 1 && firstOver.bad.length === 0,
    `scrollWidth=${firstOver.doc}/${W}` + (firstOver.bad.length ? ' 越界元素: ' + firstOver.bad.map((b) => `${b.cls}(${b.left}→${b.right})`).join(', ') : ''));

  /* ---- 安全区：viewport-fit 与 env() 是配套的，少一个就全废 ----
     缺 viewport-fit=cover 时 env(safe-area-inset-*) 恒为 0，
     styles.css 里所有 env() 内边距会变成死代码（这个坑踩了很久）。
     这里守两件事：声明在不在、以及"非刘海设备上 env=0 时布局不受影响"。 */
  {
    const vp = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.content || '');
    ok('[手机] viewport 声明了 viewport-fit=cover（否则 env(safe-area-inset-*) 恒为 0）',
      /viewport-fit\s*=\s*cover/.test(vp), vp);
    const safe = await page.evaluate(() => {
      const px = (el, prop) => (el ? Math.round(parseFloat(getComputedStyle(el)[prop]) || 0) : -1);
      return {
        topbarTop: px(document.querySelector('.topbar'), 'paddingTop'),
        editorBottom: px(document.querySelector('.editor') || document.querySelector('.result'), 'paddingBottom'),
        doc: document.documentElement.scrollWidth,
      };
    });
    // 本机（无刘海）env() = 0 → 内边距就是基准值，且不能因此溢出
    ok('[手机] 安全区内边距接上了且非刘海设备不受影响',
      safe.topbarTop === 8 && safe.editorBottom >= 16 && safe.doc <= W + 1,
      `顶栏 padding-top=${safe.topbarTop}px（期望 8）· 内容 padding-bottom=${safe.editorBottom}px · scrollWidth=${safe.doc}`);
  }

  // 侧栏：开 → 选课 → 自动收起
  await openSidebar(page);          // 手机上侧栏默认收起，得先展开才看得到课表
  await waitLessonList(page);
  const sidebarOpen = await page.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().width > 0);
  ok('[手机] 侧栏能展开（浮层）', sidebarOpen, '');
  await page.fill('.lesson-search input', '5');
  await sleep(300);
  await page.click('.lesson-item >> nth=0');
  await sleep(600);
  const closedAfterPick = await page.evaluate(() => {
    const s = document.querySelector('.sidebar');
    return !(s.getBoundingClientRect().width > 0 && getComputedStyle(s).position === 'fixed');
  });
  ok('[手机] 选完课侧栏自动收起（不挡内容）', closedAfterPick, closedAfterPick ? '' : '侧栏仍覆盖屏幕');

  /* ---- 侧栏在手机上必须真的能用 ----
     背景：加了「连续天数 / 错误训练 / 本册进度」之后，侧栏上半部分在手机上要占 400px+，
     而课时列表是 flex 子项（能被压扁），结果被挤成 0 高 —— 用户看到进度条下面一片空白，
     滑也滑不动（侧栏自己不溢出，所以连滚动条都没有）。这条断言就是钉死它。 */
  {
    await openSidebar(page);
    await sleep(400);

    /* ---- 手机端顶栏瘦身：次要入口收进 ⋮ ----
     原来四个按钮 + 状态条换行后占掉 200px（约 1/4 屏幕）。 */
  {
    // 侧栏浮层开着时，它的遮罩会挡住顶栏（这是应用本身的正确行为），先收起来再点 ⋮
    await ensureSidebarClosed(page);
    const bar = await page.evaluate(() => {
      const t = document.querySelector('.topbar');
      const more = document.querySelector('.more-btn');
      const ghost = [...document.querySelectorAll('.topbar .ghost-btn, .topbar .due-btn')]
        .filter((b) => b.getBoundingClientRect().width > 0).length;
      return { h: Math.round(t.getBoundingClientRect().height), more: Boolean(more && more.getBoundingClientRect().width > 0), ghost };
    });
    ok('[手机] 顶栏次要入口已收进 ⋮（顶栏明显变矮）', bar.more && bar.ghost === 0 && bar.h <= 120,
      `顶栏高 ${bar.h}px · 平铺按钮 ${bar.ghost} 个 · ⋮ 可见=${bar.more}`);
    await page.click('.more-btn');
    await sleep(300);
    const menu = await page.evaluate(() => {
      const m = document.querySelector('.more-menu');
      if (!m) return null;
      const items = [...m.querySelectorAll('.more-item')].map((b) => b.innerText.split(String.fromCharCode(10)).join(' ').trim());
      const r = m.getBoundingClientRect();
      return { items, w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, fields: [...m.querySelectorAll('.more-field span')].map((x) => x.innerText.trim()) };
    });
    ok('[手机] ⋮ 菜单能打开，含历史/收藏/复习/设置/备份',
      Boolean(menu) && ['历史结果', '收藏夹', '今日待复习', 'AI 设置', '备份'].every((k) => menu.items.some((t) => t.includes(k))),
      menu ? menu.items.join(' | ').slice(0, 110) : '菜单没打开');
    ok('[手机] ⋮ 菜单不超出屏幕', Boolean(menu) && menu.left >= 0 && menu.right <= menu.vw + 1,
      menu ? `菜单 ${menu.w}px 位置 ${menu.left}→${menu.right}，视口 ${menu.vw}` : '');
    ok('[手机] 低频设置（润色等级 / 识别模式）也挪进了 ⋮',
      Boolean(menu) && menu.fields.includes('润色等级') && menu.fields.includes('识别模式'),
      menu ? menu.fields.join(' / ') : '');
    // 点一下"练习方向"这一项：切方向并自动收起菜单
    const before = await page.evaluate(() => document.querySelector('.dir-tabs button.active')?.innerText.trim() || '');
    await page.locator('.more-item').filter({ hasText: '练习方向' }).first().click();
    await sleep(400);
    const after = await page.evaluate(() => ({
      dir: document.querySelector('.dir-tabs button.active')?.innerText.trim() || '',
      menuOpen: Boolean(document.querySelector('.more-menu')),
    }));
    ok('[手机] ⋮ 里能切练习方向，且点完自动收起菜单',
      after.dir !== before && !after.menuOpen, `${before} → ${after.dir}，菜单还开着=${after.menuOpen}`);
    // 切回来，免得影响后面的断言（后面的流程按汉译英写的）
    await page.click('.more-btn'); await sleep(250);
    await page.locator('.more-item').filter({ hasText: '练习方向' }).first().click();
    await sleep(400);
    // 上面为了点 ⋮ 把侧栏收起来了，这里再打开 —— 紧接着的几条断言都要求侧栏是展开的
    await openSidebar(page);
    await sleep(400);
  }

  /* ---- 课文库的 9 个库标签必须在手机上真的看得见 ----
     上一轮把「9 个库排 3 行」改成「一排横向滑动」省高度时，把它们整个搞丢过一次
     （用户截图：课文库下面是空的）。这条断言就是那次回归的守卫。 */
    {
    const tabs = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.book-tabs button')];
      const el = document.querySelector('.book-tabs');
      const box = el ? el.getBoundingClientRect() : null;
      const first = btns[0] ? btns[0].getBoundingClientRect() : null;
      return {
        n: btns.length,
        visible: btns.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length,
        boxW: box ? Math.round(box.width) : -1,
        boxH: box ? Math.round(box.height) : -1,
        scrollW: el ? el.scrollWidth : -1,
        firstLabel: btns[0] ? btns[0].innerText.trim() : '',
        firstW: first ? Math.round(first.width) : -1,
      };
    });
    ok('[手机] 课文库的 9 个库标签可见（否则手机上切不了库）',
      tabs.n >= 9 && tabs.visible === tabs.n && tabs.boxH > 0 && tabs.firstW > 0,
      `共 ${tabs.n} 个、可见 ${tabs.visible} 个 · 容器 ${tabs.boxW}×${tabs.boxH} · scrollWidth=${tabs.scrollW} · 首个"${tabs.firstLabel}"宽 ${tabs.firstW}`);
    }


    /* 侧栏里**只能有一个滚动区**：曾经 .sidebar 和 .side-section 都设了 overflow-y:auto，
       用户在窄屏上看到两三条滚动条叠在一起（截图反馈"太丑了"）。 */
    const scrollables = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.sidebar, .sidebar *').forEach((el) => {
        const cs = getComputedStyle(el);
        const scrollable = /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2;
        if (scrollable) out.push((el.className || el.tagName).toString().slice(0, 30));
      });
      return out;
    });
    ok('[手机] 侧栏里只有一条滚动条（不叠滚动条）', scrollables.length <= 1,
      scrollables.length ? `可滚动的有 ${scrollables.length} 个：${scrollables.join(' / ')}` : '无（内容没超，也是一种正常状态）');

    const geom = await page.evaluate(() => {
      const list = document.querySelector('.lesson-list');
      const sec = document.querySelector('.side-section');
      const sb = document.querySelector('.sidebar');
      const r = list?.getBoundingClientRect();
      return {
        listH: Math.round(r?.height || 0),
        items: document.querySelectorAll('.lesson-item').length,
        secScroll: sec ? sec.scrollHeight - sec.clientHeight : 0,
        sbScroll: sb ? sb.scrollHeight - sb.clientHeight : 0,
      };
    });
    ok('[手机] 侧栏课时列表有可用高度（没被上面的区块挤成 0）', geom.listH >= 120,
      `列表高 ${geom.listH}px · ${geom.items} 课 · 可滚空间：侧栏 ${geom.sbScroll}px / 内容区 ${geom.secScroll}px`);

    // 能滚到最后一课（这是"能不能用"的最终判据）
    const reach = await reachLastLesson(page);
    ok('[手机] 侧栏能滚到最后一课', reach.ok, reach.why);
    await ensureSidebarClosed(page);
  }

  if (LIVE) {
    note('LIVE 模式：手机端只跑布局/触屏检查（不生成，不花钱）');
    ok('[手机·真站] 全程零 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();
    return;
  }

  // 生成
  await generate(page);
  ok('[手机] 能在手机上走完生成链路', Boolean(await page.$('.result')), '');

  const resOver = await overflowOf();
  ok('[手机] 结果页无横向溢出', resOver.doc <= W + 1 && resOver.bad.length === 0,
    `scrollWidth=${resOver.doc}/${W}` + (resOver.bad.length ? ' 越界: ' + resOver.bad.map((b) => `${b.cls}(${b.left}→${b.right})`).join(', ') : ''));

  // 手机上"第一屏就能看见错在哪"
  const glance = await page.evaluate(() => {
    const g = document.querySelector('.sheet-glance');
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
  });
  ok('[手机] 评分速览在第一屏内', Boolean(glance && glance.bottom <= glance.vh),
    glance ? `速览 y=${glance.top}→${glance.bottom}，视口高 ${glance.vh}` : '没有 .sheet-glance');

  // 触摸目标
  const small = await page.evaluate(() => {
    const sel = '.icon-btn, .fav-star, .ghost-btn, .side-toggle, .book-tabs button, .glance-jump button, .refs-toggle, .fold-toggle';
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.width < 44 || r.height < 44) out.push({ cls: el.className.toString().slice(0, 30), t: (el.textContent || '').trim().slice(0, 10), w: Math.round(r.width), h: Math.round(r.height) });
    });
    return out.slice(0, 30);
  });
  // 列表项（.lesson-item）按"整行点"算，高度由行高决定，不按 44px 卡
  ok('[手机] 触摸目标均 ≥44×44', small.length === 0,
    small.length ? `${small.length} 处偏小：` + small.slice(0, 8).map((s) => `${s.cls || s.t}(${s.w}×${s.h})`).join(' / ') : '');

  // 输入字号
  const tiny = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input, textarea, select').forEach((el) => {
      if (!el.offsetParent && el.offsetWidth === 0) return;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs > 0 && fs < 16) out.push(`${el.tagName}.${el.className.toString().slice(0, 20)}=${fs}px`);
    });
    return out;
  });
  ok('[手机] 输入控件字号 ≥16px（防 iOS 聚焦整页放大）', tiny.length === 0, tiny.slice(0, 6).join(' / '));

  // 矮视口（≈软键盘弹出后剩下的高度）：弹窗底部按钮要么在视口内，要么内部能滚到
  await page.setViewportSize({ width: 390, height: 420 });
  await openTopAction(page, '收藏夹').catch(() => {});
  await sleep(400);
  const reach = await page.evaluate(() => {
    const m = document.querySelector('.modal');
    if (!m) return null;
    return {
      modalH: Math.round(m.getBoundingClientRect().height), vh: window.innerHeight,
      modalBottom: Math.round(m.getBoundingClientRect().bottom),
      scrollable: m.scrollHeight > m.clientHeight + 1,
      overflowY: getComputedStyle(m).overflowY,
    };
  });
  if (reach) {
    // 两种可接受：整块塞得下（bottom ≤ 视口高），或者内部可滚（用户滑得到底）
    const fits = reach.modalBottom <= reach.vh + 1;
    ok('[手机] 矮视口（≈软键盘）下弹窗不会超出屏幕且能滚到底',
      fits && (reach.scrollable || reach.modalH <= reach.vh + 1),
      `弹窗 ${reach.modalH}px / 视口 ${reach.vh}px，bottom=${reach.modalBottom}，内部可滚=${reach.scrollable}（overflow-y=${reach.overflowY}）`);
  }
  await closeAnyModal(page);
  await page.setViewportSize({ width: 390, height: 844 });

  ok('[手机] 全程零 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  /* 小屏手机（iPhone SE 一代 / 老安卓 320px）：最容易被忽略的一档 */
  {
    const W2 = 320;
    const barOn = async () => page.evaluate(() => {
      const t = document.querySelector('.topbar');
      return t ? { h: Math.round(t.getBoundingClientRect().height), overflow: t.scrollWidth > t.clientWidth + 1 } : null;
    });
    const bar390 = await barOn();
    note(`顶栏高度：390px 宽 → ${bar390?.h}px（占 844 视口 ${Math.round((bar390?.h || 0) / 844 * 100)}%）`);
    await page.setViewportSize({ width: W2, height: 568 });
    await sleep(400);
    const narrow = await page.evaluate((w) => {
      const bad = [];
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 1 && getComputedStyle(el).position !== 'fixed') bad.push(el.className.toString().slice(0, 30));
      });
      return { doc: document.documentElement.scrollWidth, bad: bad.slice(0, 6) };
    }, W2);
    ok('[手机 320px] 结果页不横向溢出', narrow.doc <= W2 + 1 && narrow.bad.length === 0,
      `scrollWidth=${narrow.doc}/${W2}` + (narrow.bad.length ? ' 越界: ' + narrow.bad.join(', ') : ''));
    const bar = await barOn();
    ok('[手机 320px] 顶栏不横向溢出', Boolean(bar) && !bar.overflow, bar ? `顶栏高 ${bar.h}px（占 568 视口 ${Math.round(bar.h / 568 * 100)}%）溢出=${bar.overflow}` : '没有顶栏');
    await openTopAction(page, '收藏夹').catch(() => {});
    await sleep(400);
    const modalFit = await page.evaluate(() => {
      const m = document.querySelector('.modal');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { w: Math.round(r.width), left: Math.round(r.left), vw: window.innerWidth };
    });
    ok('[手机 320px] 弹窗宽度不超出屏幕',
      Boolean(modalFit) && modalFit.left >= -1 && modalFit.left + modalFit.w <= modalFit.vw + 1,
      modalFit ? `弹窗 ${modalFit.w}px，left=${modalFit.left}，视口 ${modalFit.vw}` : '弹窗没打开');
    await closeAnyModal(page);
    await page.setViewportSize({ width: W, height: 844 });
  }
  await ctx.close();
}

/* ==================================================================
 * 三、边界与异常（bug 猎场）
 * ================================================================== */
async function edgeCases() {
  head('边界与异常路径');
  const newPage = async ({ seed, viewport = { width: 1360, height: 950 } } = {}) => {
    const ctx = await browser.newContext({ viewport });
    if (seed) await ctx.addInitScript(seed);
    const page = await ctx.newPage();
    const errs = watchErrors(page);
    page.on('dialog', (d) => d.accept());
    return { ctx, page, errs };
  };

  /* E1 空输入点生成 */
  {
    const { ctx, page, errs } = await newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    await page.click('.primary-btn.big');
    await sleep(1200);
    const s = await page.evaluate(() => ({
      banner: document.querySelector('.error-banner')?.innerText.replace(/\n/g, ' ') || '',
      result: Boolean(document.querySelector('.result')),
      stillEditor: Boolean(document.querySelector('.editor')),
    }));
    ok('[边界] 什么都不知道就点生成：给提示而不是静默/崩溃',
      s.stillEditor && !s.result && s.banner.length > 0, s.banner.slice(0, 70) || '(没有任何提示)');
    ok('[边界] 空输入不产生 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  /* E2 只有中文、没有初稿 */
  {
    const { ctx, page } = await newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    await page.fill('.big-textarea >> nth=0', '只有中文，没有英文初稿。');
    await page.click('.primary-btn.big');
    await sleep(1200);
    const s = await page.evaluate(() => ({
      banner: document.querySelector('.error-banner')?.innerText.replace(/\n/g, ' ') || '',
      result: Boolean(document.querySelector('.result')),
    }));
    ok('[边界] 只填中文点生成：提示缺初稿', !s.result && /初稿|英文|填/.test(s.banner), s.banner.slice(0, 70) || '(没有任何提示)');
    await ctx.close();
  }

  /* E3 超长输入 */
  {
    const { ctx, page, errs } = await newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    const longCn = '这是一段用于压力测试的中文。'.repeat(600); // ~7800 字
    const t0 = Date.now();
    await page.fill('.big-textarea >> nth=0', longCn);
    const typeMs = Date.now() - t0;
    await page.fill('.big-textarea >> nth=1', 'A very long draft. '.repeat(400));
    await sleep(300);
    const measured = await page.evaluate(() => {
      const el = document.querySelectorAll('.big-textarea')[0];
      return { len: el.value.length, scrollH: document.querySelector('.editor')?.scrollHeight || 0 };
    });
    note(`超长中文 ${measured.len} 字，填充耗时 ${typeMs}ms，编辑器 scrollHeight=${measured.scrollH}`);
    ok('[边界] 超长输入不卡死（填充 <5s）', typeMs < 5000, `${typeMs}ms`);
    ok('[边界] 超长输入不报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  /* E4 超长英文 token（真实模型偶尔吐出连写长词/URL） */
  {
    const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    const bad = await page.evaluate(() => {
      const w = 390;
      const out = [];
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 1 && getComputedStyle(el).position !== 'fixed') out.push(el.className.toString().slice(0, 30));
      });
      return out.slice(0, 6);
    });
    ok('[边界] 无内容时窄屏也不越界', bad.length === 0, bad.join(', '));
    await ctx.close();
  }

  /* E5 连点生成：会不会重复提交 */
  {
    const { ctx, page } = await newPage();
    let submits = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/(analyze|quiz|generate|jobs)/.test(r.url())) submits += 1; });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    await page.fill('.big-textarea >> nth=0', '中文内容');
    await page.fill('.big-textarea >> nth=1', 'English draft content here.');
    ctl.delayMs = 1500;
    await page.click('.primary-btn.big');
    await sleep(120);
    // 立刻再点 3 次（用户手抖 / 手机连击）
    for (let i = 0; i < 3; i += 1) await page.click('.primary-btn.big', { force: true }).catch(() => {});
    await page.waitForSelector('.result', { timeout: 60000 });
    ctl.delayMs = 0;
    ok('[边界] 连点生成只提交一次（不重复烧钱）', submits === 1, `实际提交 ${submits} 次`);
    await ctx.close();
  }

  /* E6 localStorage 里塞脏数据 */
  {
    const seed = () => {
      const junk = ['{', 'null', '"string"', '123', '[]', '[null,null]', '{"a":1}'];
      const keys = ['bt-history', 'bt-favorites', 'bt-lesson-libraries', 'bt-lesson-progress', 'bt-study-days', 'bt-timer', 'bt-history-deleted', 'bt-libs-deleted', 'bt-lessons-deleted', 'bt-favs-deleted', 'bt-studio-settings', 'bt-sync-meta', 'bt-book', 'bt-lesson', 'bt-direction', 'bt-polish-level', 'bt-result-x'];
      keys.forEach((k, i) => { try { localStorage.setItem(k, junk[i % junk.length]); } catch { /* ignore */ } });
    };
    const { ctx, page, errs } = await newPage({ seed });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const booted = await page.waitForSelector('.status-chip', { timeout: 30000 }).then(() => true).catch(() => false);
    const usable = await page.evaluate(() => Boolean(document.querySelector('.editor')) && document.querySelectorAll('.big-textarea').length >= 2);
    ok('[边界] localStorage 全是脏数据也能启动（不白屏）', booted && usable, `启动=${booted} 编辑器可用=${usable}`);
    ok('[边界] 脏数据不引发 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }

  /* E7 写入配额满（隐私模式/配额耗尽） */
  {
    const seed = () => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function patched(k, v) {
        if (String(k).startsWith('bt-')) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
        return orig.call(this, k, v);
      };
    };
    const { ctx, page, errs } = await newPage({ seed });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    await page.fill('.big-textarea >> nth=0', '配额满的时候也要能用');
    await page.fill('.big-textarea >> nth=1', 'It should still work when quota is full.');
    await page.click('.primary-btn.big');
    const got = await page.waitForSelector('.result', { timeout: 60000 }).then(() => true).catch(() => false);
    ok('[边界] 存储配额写满时仍能出结果（不白屏）', got, got ? '' : '结果页没出现');
    ok('[边界] 配额写满不引发未捕获异常', errs.filter((e) => !/Quota/i.test(e)).length === 0, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }

  /* E8 模型服务端 500 */
  {
    const { ctx, page } = await newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    await page.fill('.big-textarea >> nth=0', '中文');
    await page.fill('.big-textarea >> nth=1', 'English draft.');
    ctl.fail = 500;
    await page.click('.primary-btn.big');
    const gotErr = await page.waitForSelector('.error-banner', { timeout: 45000 }).then(() => true).catch(() => false);
    const msg = await page.evaluate(() => document.querySelector('.error-banner')?.innerText.replace(/\n/g, ' ') || '');
    ctl.fail = 0;
    ok('[边界] 模型报错时给出可读提示（不是转圈到死）', gotErr && msg.length > 4, msg.slice(0, 90) || '(没有错误提示)');
    const stillUsable = await page.evaluate(() => !document.querySelector('.primary-btn.big')?.disabled);
    ok('[边界] 失败后生成按钮恢复可用（能重试）', stillUsable, stillUsable ? '' : '按钮仍是 disabled');
    await ctx.close();
  }

  /* E9 标题里塞 HTML / emoji / 超长 */
  {
    const { ctx, page, errs } = await newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    const evil = '<img src=x onerror="window.__xss=1"> 标题 🎉 𝕬𝕭 ' + 'A'.repeat(300);
    await page.fill('.title-field input', evil);
    await page.fill('.big-textarea >> nth=0', '中文');
    await page.fill('.big-textarea >> nth=1', 'English draft.');
    await sleep(300);
    const s = await page.evaluate(() => ({
      xss: Boolean(window.__xss),
      imgs: document.querySelectorAll('.editor img, .title-row img').length,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }));
    ok('[安全] 标题里的 HTML 不会被当标签执行', !s.xss && s.imgs === 0, `xss=${s.xss} 注入的 img=${s.imgs}`);
    ok('[边界] 超长标题不撑破桌面布局', s.overflow <= 1, `超出 ${s.overflow}px`);
    ok('[边界] 特殊字符标题不报错', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  /* E10 生成中刷新页面 */
  {
    const { ctx, page } = await newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    await page.fill('.big-textarea >> nth=0', '中文');
    await page.fill('.big-textarea >> nth=1', 'English draft.');
    ctl.delayMs = 2500;
    await page.click('.primary-btn.big');
    await sleep(700);
    await page.reload({ waitUntil: 'domcontentloaded' });
    ctl.delayMs = 0;
    await boot(page);
    await sleep(1500);
    const s = await page.evaluate(() => ({
      stuck: Boolean(document.querySelector('.progress-box')),
      generateEnabled: !document.querySelector('.primary-btn.big')?.disabled,
      btnText: document.querySelector('.primary-btn.big')?.innerText.trim() || '',
    }));
    ok('[边界] 生成中刷新：回来不会卡在"正在生成"', !s.stuck && s.generateEnabled, `进度条残留=${s.stuck} 按钮="${s.btnText}"`);
    await ctx.close();
  }

  /* E11 #job= 指向不存在的作业 */
  {
    const { ctx, page } = await newPage();
    await page.goto(BASE + '#job=deadbeefdeadbeef', { waitUntil: 'domcontentloaded' });
    await boot(page);
    await sleep(2500);
    const s = await page.evaluate(() => ({
      banner: document.querySelector('.error-banner')?.innerText.replace(/\n/g, ' ') || '',
      toast: document.querySelector('.fav-tip, .toast')?.innerText.trim() || '',
    }));
    ok('[边界] 打不开的分享链接有明确说明', (s.banner + s.toast).length > 4, (s.banner || s.toast).slice(0, 80) || '(静默无提示)');
    await ctx.close();
  }

  /* E12 打印（导出 PDF）不会把按钮印进去 */
  {
    const { ctx, page } = await newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await boot(page);
    await generate(page);
    await page.emulateMedia({ media: 'print' });
    await sleep(300);
    const s = await page.evaluate(() => {
      const vis = (sel) => [...document.querySelectorAll(sel)].filter((el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0).length;
      return { topbar: vis('.topbar'), sidebar: vis('.sidebar'), back2top: vis('.back-to-top'), sheet: vis('.sheet'), result: vis('.result') };
    });
    ok('[打印] 打印版藏起顶栏/侧栏/回顶按钮', s.topbar === 0 && s.sidebar === 0 && s.back2top === 0, JSON.stringify(s));
    ok('[打印] 结果正文仍然可见（不是白纸）', s.sheet > 0, `sheet 可见块=${s.sheet}`);
    const pdf = await page.pdf({ format: 'A4', printBackground: true }).catch(() => null);
    ok('[打印] 能真的导出 PDF（有内容）', Boolean(pdf && pdf.length > 20000), pdf ? `${Math.round(pdf.length / 1024)} KB` : '导出失败');
    await ctx.close();
  }
}

/* ==================================================================
 * 四、核心功能真跑一遍（这些是最容易藏 bug 的地方）
 * ================================================================== */
async function coreFlows() {
  head('核心功能（真正点一遍，不是读代码）');
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 } });
  const page = await ctx.newPage();
  const errs = watchErrors(page);
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await boot(page);

  /* --- 1. 练习方向切换：界面文案必须跟着换，不能只是换个变量 --- */
  {
    const before = await page.evaluate(() => ({
      heads: [...document.querySelectorAll('.panel-head h2')].map((h) => h.innerText.trim()),
      btn: document.querySelector('.primary-btn.big')?.innerText.trim() || '',
      ph: document.querySelectorAll('.big-textarea')[0]?.placeholder || '',
    }));
    await page.click('.dir-tabs >> text=英译汉');
    await sleep(400);
    const after = await page.evaluate(() => ({
      active: document.querySelector('.dir-tabs button.active')?.innerText.trim() || '',
      heads: [...document.querySelectorAll('.panel-head h2')].map((h) => h.innerText.trim()),
      btn: document.querySelector('.primary-btn.big')?.innerText.trim() || '',
      ph: document.querySelectorAll('.big-textarea')[0]?.placeholder || '',
    }));
    ok('[方向] 切到英译汉后，两栏标题/按钮/占位符全跟着换',
      after.active.includes('英译汉') && after.heads.join() !== before.heads.join() && after.btn !== before.btn && after.ph !== before.ph,
      `标题 ${before.heads.join('|')} → ${after.heads.join('|')}；按钮 "${after.btn}"`);
    // 切回去：方向要能来回切，且被记住
    await page.click('.dir-tabs >> text=汉译英');
    await sleep(300);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await boot(page);
    const persisted = await page.evaluate(() => document.querySelector('.dir-tabs button.active')?.innerText.trim() || '');
    ok('[方向] 选择被记住（刷新后仍是上次那个）', persisted.includes('汉译英'), `刷新后=${persisted}`);
  }

  /* --- 2. 计时器 --- */
  {
    await page.click('.ghost-btn.sm >> text=开始计时');
    await sleep(2200);
    const t = await page.evaluate(() => document.querySelector('.timer-display')?.innerText.trim() || '');
    ok('[计时] 计时器能跑起来并显示秒数', /\d/.test(t) && t !== '0:00', `显示 "${t}"`);
    await page.click('.ghost-btn.sm >> text=暂停');
    await sleep(1200);
    const t2 = await page.evaluate(() => document.querySelector('.timer-display')?.innerText.trim() || '');
    ok('[计时] 暂停后不再继续走', t2 === t, `暂停前 "${t}" 暂停后 "${t2}"`);
  }

  /* --- 3. 自建课文库：存进去 → 选出来 → 改名 → 删掉 → 刷新不复活 --- */
  {
    await page.fill('.title-field input', 'QA 自测课文');
    await page.fill('.big-textarea >> nth=0', '这是一段用来测课文库的自定义中文。');
    await page.fill('.big-textarea >> nth=1', 'This is a custom Chinese passage for testing the library.');
    await page.click('.primary-btn.big');
    await page.waitForSelector('.result', { timeout: 60000 });

    // 保存入口在侧栏的「新建课文库 / 存进课文库」按钮上
    await openSidebar(page);
    await sleep(200);
    await page.click('.lib-add[aria-label="新建课文库"]');
    await sleep(400);
    const libModal = await page.evaluate(() => ({
      open: Boolean(document.querySelector('.modal[aria-label="保存到课文库"]')),
      preview: document.querySelector('.lib-preview')?.innerText.replace(/\n/g, ' ') || '',
    }));
    ok('[课文库] 「保存到课文库」弹窗打开并预览内容', libModal.open, libModal.preview.slice(0, 70));
    const nameInput = page.locator('.modal[aria-label="保存到课文库"] input').first();
    if (await nameInput.count()) await nameInput.fill('QA 库');
    await sleep(200);
    await page.click('.modal[aria-label="保存到课文库"] .primary-btn');
    await sleep(700);
    const libCreated = await page.evaluate(() => ({
      rows: document.querySelectorAll('.lib-row').length,
      names: [...document.querySelectorAll('.lib-name')].map((n) => n.innerText.trim()),
    }));
    ok('[课文库] 保存后侧栏「我的课文库」出现新库', libCreated.rows > 0, libCreated.names.join(' / ') || '(没有库)');

    if (libCreated.rows > 0) {
      // 选出来练
      await page.click('.lib-tab >> nth=0');
      await sleep(500);
      const pickable = await page.locator('.lesson-item').count();
      ok('[课文库] 库里那节课能在侧栏选出来', pickable > 0, `${pickable} 节可选`);
      if (pickable > 0) {
        await page.click('.lesson-item >> nth=0');
        await sleep(700);
        const filled = await page.evaluate(() => ({
          onEditor: Boolean(document.querySelector('.editor')),
          title: document.querySelector('.title-field input')?.value || '',
          cn: document.querySelectorAll('.big-textarea')[0]?.value || '',
          original: document.querySelector('.original-textarea')?.value || '',
        }));
        // 这里同时守住刚修的那个 bug：从结果页点侧栏课程，必须把视图切回编辑器
        ok('[课文库] 选中自建课文会切回编辑器并把内容带进去',
          filled.onEditor && (filled.cn.includes('自定义中文') || filled.title.includes('QA')),
          `到编辑器=${filled.onEditor} 标题="${filled.title}" 中文="${filled.cn.slice(0, 24)}" 原文 ${filled.original.length} 字`);
      }
      // 改名
      await page.click('.lesson-edit >> nth=0');
      await sleep(400);
      const editOpen = await page.evaluate(() => document.querySelector('.modal')?.innerText.slice(0, 40).replace(/\n/g, ' ') || '');
      ok('[课文库] 「改标题 / 改序号」能打开', editOpen.length > 0, editOpen);
      await closeAnyModal(page);
      // 删掉这节课
      const delBefore = await page.locator('.lesson-item').count();
      await page.click('.lesson-del >> nth=0').catch(() => {});
      await sleep(600);
      const delAfter = await page.locator('.lesson-item').count();
      ok('[课文库] 能删掉自建课文', delAfter < delBefore, `${delBefore} → ${delAfter} 节`);
      // 刷新后不复活（墓碑生效）
      await page.reload({ waitUntil: 'domcontentloaded' });
      await boot(page);
      await sleep(500);
      await page.click('.lib-tab >> nth=0').catch(() => {});
      await sleep(400);
      const afterReload = await page.locator('.lesson-item').count();
      ok('[课文库] 刷新后删掉的课文不会复活（墓碑生效）', afterReload <= delAfter, `刷新后 ${afterReload} 节（删除时 ${delAfter} 节）`);
    }
  }

  /* --- 4. 今日待复习：完整走一轮复习 --- */
  {
    // 先回到结果页收藏一条（收藏入口只在结果页的每条知识点右边）
    await page.click('.ghost-btn >> text=历史结果');
    await sleep(500);
    if (await page.locator('.history-open').count()) {
      await page.click('.history-open >> nth=0');
      await page.waitForSelector('.result', { timeout: 20000 });
      await sleep(400);
    }
    const hasStar = await page.locator('.fav-star').count();
    if (hasStar) { await page.click('.fav-star >> nth=0'); await sleep(500); }
    else note('结果页没有可收藏的★（本次 mock 结果的知识点为空？）');
    await page.click('.due-btn');
    await sleep(500);
    const inReview = await page.evaluate(() => ({
      title: document.querySelector('.modal-head h2')?.innerText.trim() || '',
      hasPanel: Boolean(document.querySelector('.fav-review')),
      reveal: Boolean([...document.querySelectorAll('.modal button')].find((b) => /显示答案/.test(b.textContent))),
    }));
    ok('[复习] 「今日待复习」能进入复习面板', inReview.hasPanel && inReview.reveal, `标题="${inReview.title}" 显示答案按钮=${inReview.reveal}`);
    if (inReview.reveal) {
      await page.click('.modal button >> text=显示答案');
      await sleep(300);
      const grades = await page.locator('.grade-btn').count();
      const gradeTexts = await page.evaluate(() => [...document.querySelectorAll('.grade-btn')].map((b) => b.innerText.replace(/\n/g, ' ')));
      ok('[复习] 翻面后给出 3 档评级且写明"几天后再见"', grades === 3 && gradeTexts.every((t) => /\d/.test(t)), gradeTexts.join(' | '));
      await page.click('.grade-btn >> nth=1');
      await sleep(500);
      const finished = await page.evaluate(() => document.querySelector('.modal')?.innerText.replace(/\n/g, ' ') || '');
      ok('[复习] 评完出现完成页并给出下次复习时间', /完成|下一次复习/.test(finished), finished.slice(0, 110));
    }
    await closeAnyModal(page);
  }

  /* --- 5. 错误训练：挑课出题 --- */
  {
    await openSidebar(page);
    await sleep(300);
    const entry = await page.evaluate(() => {
      const b = document.querySelector('.drill-entry');
      return b ? { text: b.innerText.replace(/\n/g, ' ').trim(), disabled: b.disabled } : null;
    });
    ok('[错误训练] 侧栏有入口', Boolean(entry), entry ? `"${entry.text}"` : '(没有 .drill-entry)');
    if (entry) {
      await page.click('.drill-entry');
      await sleep(500);
      const d = await page.evaluate(() => ({
        open: Boolean(document.querySelector('.drill-modal')),
        rows: document.querySelectorAll('.drill-row').length,
        picked: document.querySelectorAll('.drill-pick input:checked').length,
        toolbar: document.querySelector('.drill-toolbar')?.innerText.replace(/\n/g, ' ') || '',
        empty: Boolean(document.querySelector('.drill-empty')),
        missing: document.querySelector('.drill-missing summary')?.innerText.trim() || '',
        startDisabled: [...document.querySelectorAll('.modal button')].find((b) => /开始出题/.test(b.textContent))?.disabled,
      }));
      ok('[错误训练] 弹窗能打开', d.open, '');
      ok('[错误训练] 能列出练过的课并默认勾选错得最多的',
        d.empty || (d.rows > 0 && d.picked > 0), d.empty ? '显示"还没有可训练的错题"' : `${d.rows} 课可选 · 默认勾 ${d.picked} 课 · ${d.toolbar}`);
      if (d.missing) note(`未练过的课折叠提示："${d.missing.slice(0, 50)}"`);

      /* 题量：预设之外要能自定义，上限 100（用户明确要求） */
      {
        const sel = page.locator('.drill-count-pick select');
        await sel.selectOption('custom');
        await sleep(250);
        const hasInput = await page.locator('.drill-count-input').count();
        ok('[错误训练] 题量选「自定义…」后出现数字输入框', hasInput > 0, hasInput ? '' : '没有出现 .drill-count-input');
        if (hasInput) {
          await page.fill('.drill-count-input', '37');
          await sleep(250);
          const v37 = await page.evaluate(() => Number(document.querySelector('.drill-count-input')?.value));
          ok('[错误训练] 自定义题量能填到 37（不再只有 5/10/15/20）', v37 === 37, `输入框值=${v37}`);
          await page.fill('.drill-count-input', '500');
          await sleep(300);
          const clamped = await page.evaluate(() => Number(document.querySelector('.drill-count-input')?.value));
          ok('[错误训练] 题量上限 100：填 500 会被夹回（不会真去要 500 道）', clamped <= 100, `填 500 后 =${clamped}`);
        }
        await sel.selectOption('10');
        await sleep(200);
      }

      if (!d.empty && d.picked > 0) {
        await page.click('.modal button >> text=开始出题');
        const got = await page.waitForSelector('.quiz-sheet', { timeout: 60000 }).then(() => true).catch(() => false);
        const n = await page.locator('.quiz-question').count();
        ok('[错误训练] 能按错题真的出出题来', got && n > 0, `题目 ${n} 道`);
        ok('[错误训练] 出过题后把用掉的错题记账（下次才会避开）',
          await page.evaluate(() => {
            try { return Object.keys(JSON.parse(localStorage.getItem('bt-drill-used') || '{}')).length > 0; } catch { return false; }
          }), '应写入 bt-drill-used');
        if (got) {
          /* 再进来一次：弹窗要说明"这次有几道没练过"，去重效果必须看得见 */
          await page.click('text=返回编辑').catch(() => {});
          await sleep(500);
          await openSidebar(page);
          await sleep(300);
          await page.click('.drill-entry');
          await sleep(600);
          const plan2 = await page.evaluate(() => document.querySelector('.drill-plan')?.innerText.replace(/\n/g, ' ') || '');
          ok('[错误训练] 第二次进来会说明这次有几道没练过（去重可见）',
            plan2.length > 0, plan2.slice(0, 90) || '没有 .drill-plan');

          /* Esc 必须能关掉它 —— 这一条守的是"新加的弹窗忘了登记进 useModals"。
             同一个坑踩过两次（账号弹窗、错误训练弹窗）：漏登记的表现就是 Esc 无反应、
             Tab 也不会被圈在弹窗里，而肉眼完全看不出问题。 */
          await page.keyboard.press('Escape');
          await sleep(400);
          ok('[错误训练] Esc 能关掉弹窗（新弹窗没漏登记进 useModals）',
            !(await page.$('.drill-modal')), '按下 Esc 后弹窗仍在');
        }
      }
    }
    await closeAnyModal(page);
  }

  /* --- 6. 备份导出 --- */
  {
    await openSidebar(page);
    await sleep(200);
    await page.click('.side-footer button:has-text("备份")');
    await sleep(400);
    const sum = await page.evaluate(() => document.querySelector('.modal[aria-label="备份与恢复"] .lib-preview')?.innerText.replace(/\n/g, ' ') || '');
    ok('[备份] 弹窗能打开并汇总当前数据量', sum.length > 0, sum.slice(0, 70));
    const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await page.click('.modal button >> text=导出备份文件').catch(() => {});
    const file = await dl;
    ok('[备份] 能真的下载出备份文件', Boolean(file), file ? `文件名 ${file.suggestedFilename()}` : '没有触发下载');
    if (file) {
      // 文件名里的日期必须是**本地**日期：用 toISOString 会在北京时间 08:00 前写成前一天
      const today = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const localStamp = today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate());
      ok('[备份] 文件名日期用的是本地日期（不是 UTC）', file.suggestedFilename().includes(localStamp),
        `文件名 ${file.suggestedFilename()}，本地今天 ${localStamp}，UTC ${today.toISOString().slice(0, 10)}`);
      const p2 = await file.path();
      const txt = p2 ? await (await import('node:fs/promises')).readFile(p2, 'utf8').catch(() => '') : '';
      let shape = {};
      try { shape = JSON.parse(txt); } catch { /* 非法 JSON */ }
      ok('[备份] 备份文件是合法 JSON 且含课文库/收藏/历史',
        Boolean(shape && typeof shape === 'object' && ('favorites' in shape || 'libraries' in shape || 'history' in shape)),
        `顶层字段：${Object.keys(shape).join(', ') || '(解析失败)'}`);
    }
    await closeAnyModal(page);
  }

  ok('[核心流程] 全程零 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

/* ---------- 跑 ---------- */
try {
  await desktopJourney();
  await mobileJourney();
  if (!LIVE) { await coreFlows(); await edgeCases(); }
  else note('BASE 指向真站，跳过会写入数据的部分');
} catch (e) {
  console.error('\n探针自身异常：', e && e.stack ? e.stack : e);
  R.push({ n: '探针执行完成', c: false, d: String(e && e.message) });
} finally {
  const fail = R.filter((r) => !r.c).length;
  console.log(`\n========== 合计 ${R.length} 项：通过 ${R.length - fail} · 失败 ${fail} ==========`);
  if (fail) { console.log('失败清单：'); R.filter((r) => !r.c).forEach((r) => console.log('  ✗ ' + r.n + (r.d ? '  — ' + r.d : ''))); }
  await browser.close().catch(() => {});
  if (server) server.kill();
  if (!LIVE) mock.close();
  process.exit(fail ? 1 : 0);
}
