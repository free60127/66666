/**
 * 浏览器用户旅程：桌面、安卓与 iPhone 触屏仿真。
 * 本机用 mock 模型跑生成、收藏和历史；BASE=... 时只做只读检查。
 * 与 qa-probe-mobile-desktop.mjs 的几何检查互补。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

let chromium;
try {
  ({ chromium } = await import('./shotter/node_modules/playwright/index.mjs'));
} catch {
  console.error('缺少 Playwright：请安装 tools/shotter 的依赖');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = Number(process.env.SIM_PORT || 8921);
const MOCK_PORT = Number(process.env.SIM_MOCK_PORT || 9879);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}/`;
const LIVE = Boolean(process.env.BASE);
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const analysis = {
  title: '测试作业', chinese: '我在一家小酒店吃过午饭后寻找提包。',
  draft: 'I searched my bag after lunch.',
  ai: 'After lunch at a village pub, I looked for my bag.',
  original: 'After I had had lunch at a village pub, I looked for my bag.',
  overall: { score: 82, issues: 1, summary: '搭配需要改进。', highlights: ['句式完整'], advice: ['复习 look for'] },
  sentences: [{
    cn: '我在一家小酒店吃过午饭后寻找提包。', draft: 'I searched my bag after lunch.',
    ai: 'After lunch, I looked for my bag.', original: 'After lunch, I looked for my bag.',
    findings: [{ category: '搭配', from: 'searched my bag', to: 'looked for my bag', level: 'error', explanation: 'look for 表示寻找' }],
  }],
  vocabularyNotes: [{ word: 'look for', phonetic: '/lʊk fɔː/', type: '短语', meaning: '寻找', note: '常用搭配' }],
  idiomHighlights: [{ idiom: 'have a good meal', common: 'eat well', explanation: '吃得好', example: 'Did you have a good meal?' }],
};
const quiz = {
  title: '收藏知识点自测',
  questions: [{ type: '选择', question: '哪个表达更合适？', options: ['A. searched my bag', 'B. looked for my bag'], answer: 'B', explanation: 'look for 表示寻找', source: 'look for' }],
};
const lessonFixture = {
  book: 10, lesson: 1, title_cn: '探针课文', title_en: 'Probe lesson', section: '练习',
  chinese: '探针使用的中文提示。', english: 'The English reference for this probe.',
};

let server;
let mock;
if (!LIVE) {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* malformed mock request */ }
      const system = (payload.messages || []).find((message) => message.role === 'system');
      const content = String(system?.content || '').startsWith('你是英语自测题出题老师') ? quiz : analysis;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  server = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), AI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, AI_API_KEY: 'mock-sim', ALLOW_PRIVATE_BASE_URL: '1' },
    stdio: 'ignore',
  });
  let ready = false;
  for (let n = 0; n < 40 && !ready; n += 1) {
    try { ready = (await fetch(`${BASE}api/health`)).ok; } catch { /* starting */ }
    if (!ready) await sleep(300);
  }
  if (!ready) throw new Error('本机后端启动超时');
}

const browser = await chromium.launch();
const profiles = [
  ['桌面 1360×900', { viewport: { width: 1360, height: 900 } }],
  ['安卓 360×800', { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' }],
  ['iPhone 390×844', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }],
];

async function newPage(options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  return { context, page, errors };
}

async function boot(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('.editor').waitFor();
  await page.locator('.status-chip').waitFor();
}

async function openSidebar(page) {
  if (!(await page.locator('.sidebar').isVisible())) await page.locator('.side-toggle').click();
}

async function openMoreAction(page, label) {
  await page.locator('.more-btn').click();
  await page.locator('.more-item').filter({ hasText: label }).first().click();
}

async function closeModal(page) {
  if (await page.locator('.modal-mask').count()) await page.keyboard.press('Escape');
}

async function pickLesson(page) {
  await openSidebar(page);
  const hasCorpus = await page.locator('.lesson-group-title.foldable').first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  if (!hasCorpus) {
    if (await page.locator('.sidebar-close').isVisible()) await page.locator('.sidebar-close').click();
    await page.locator('.modebar-seg[aria-label="练习模式"] button', { hasText: '自由模式' }).click();
    return '自由模式（本机未提供语料）';
  }
  await page.locator('.lesson-search input').fill('1'); // 搜索时折叠组自动展示命中的课文
  const item = page.locator('.lesson-item').first();
  await item.waitFor();
  await item.click();
  await page.waitForFunction(() => Boolean(document.querySelector('.topbar-title')?.value));
  return page.locator('.topbar-title').inputValue();
}

async function generate(page) {
  await page.locator('.big-textarea').nth(0).fill('我在一家小酒店吃过午饭后寻找提包。');
  await page.locator('.big-textarea').nth(1).fill('I searched my bag after lunch.');
  await page.locator('.primary-btn.big').click();
  await page.locator('.result-sheet').waitFor({ timeout: 60000 });
  await page.locator('.sheet-glance').waitFor({ timeout: 60000 });
}

async function journey(name, options) {
  const { context, page, errors } = await newPage(options);
  const mobile = Boolean(options.isMobile);
  try {
    await boot(page);
    check(`[${name}] 首屏直接进入编辑器`, await page.locator('.modal-mask').count() === 0);
    check(`[${name}] 默认汉译英`, (await page.locator('.modebar-seg[aria-label="练习方向"] button.active').textContent()).trim() === '汉译英');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`[${name}] 首屏没有横向滚动`, width <= options.viewport.width + 1, `${width}/${options.viewport.width}`);
    if (mobile) {
      await openSidebar(page);
      check(`[${name}] 触屏侧栏可展开`, await page.locator('.sidebar').isVisible());
      await page.locator('.sidebar-close').click();
      await page.locator('.more-btn').click();
      const menu = await page.locator('.more-menu').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: window.innerWidth, text: el.innerText };
      });
      check(`[${name}] 更多菜单不越界且入口可见`, menu.left >= 0 && menu.right <= menu.width + 1 && menu.text.includes('收藏夹') && menu.text.includes('历史结果'));
      await page.keyboard.press('Escape');
    }
    if (LIVE) {
      check(`[${name}] 无页面脚本错误`, errors.length === 0, errors.join(' | '));
      return;
    }
    const title = await pickLesson(page);
    check(`[${name}] 可进入课文或自由练习`, Boolean(title) && (title.startsWith('自由模式') || await page.locator('.big-textarea').nth(0).inputValue() !== ''), title);
    if (mobile) check(`[${name}] 选课后侧栏自动收起`, !(await page.locator('.sidebar').isVisible()));
    await generate(page);
    check(`[${name}] 生成结果有评分和逐句解析`, await page.locator('.sheet-glance').count() > 0 && await page.locator('.finding-top').count() > 0);
    const resultWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`[${name}] 结果页没有横向滚动`, resultWidth <= options.viewport.width + 1, `${resultWidth}/${options.viewport.width}`);
    await page.locator('.fav-star').first().click();
    await openMoreAction(page, '收藏夹');
    check(`[${name}] 收藏进入收藏夹`, await page.locator('.fav-item').count() > 0);
    await closeModal(page);
    await openMoreAction(page, '历史结果');
    check(`[${name}] 作业进入历史`, await page.locator('.history-item').count() > 0);
    await closeModal(page);
    if (name.startsWith('桌面')) {
      await openMoreAction(page, '收藏夹');
      await page.locator('.fav-quiz .primary-btn').click();
      await page.locator('.quiz-sheet').waitFor({ timeout: 60000 });
      check(`[${name}] 收藏知识点可生成自测`, await page.locator('.quiz-question').count() > 0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.status-chip').waitFor();
      const stored = await page.evaluate(() => ({ favorites: localStorage.getItem('bt-favorites'), history: localStorage.getItem('bt-history') }));
      check(`[${name}] 刷新后收藏与历史仍在`, Boolean(stored.favorites && stored.history));
    } else {
      await page.setViewportSize({ width: options.viewport.width, height: 420 });
      await openMoreAction(page, '收藏夹');
      const modal = await page.locator('.fav-modal').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { bottom: r.bottom, height: window.innerHeight, scrollable: el.scrollHeight > el.clientHeight };
      });
      check(`[${name}] 键盘高度下弹窗可滚动`, modal.bottom <= modal.height + 1 && modal.scrollable);
      await closeModal(page);
    }
    check(`[${name}] 全程无页面脚本错误`, errors.length === 0, errors.join(' | '));
  } finally {
    await context.close();
  }
}

async function delayedInitialSelection(path) {
  const { context, page } = await newPage(profiles[0][1]);
  try {
    await page.route('**/api/lessons', async (route) => {
      if (path === '课表') await sleep(1800);
      await route.fulfill({ json: { lessons: [lessonFixture] } });
    });
    await page.route('**/api/lessons/10/1', async (route) => {
      if (path === '课文详情') await sleep(1800);
      await route.fulfill({ json: lessonFixture });
    });
    const detailRequest = path === '课文详情'
      ? page.waitForRequest((request) => /\/api\/lessons\/\d+\/\d+/.test(request.url()), { timeout: 20000 })
      : null;
    await boot(page);
    if (detailRequest) await detailRequest;
    await page.locator('.topbar-title').fill('正在编辑的标题');
    await page.locator('.big-textarea').nth(0).fill('正在编辑的中文');
    await page.locator('.big-textarea').nth(1).fill('Draft in progress');
    await sleep(2500);
    const state = await page.evaluate(() => ({
      title: document.querySelector('.topbar-title')?.value,
      source: document.querySelectorAll('.big-textarea')[0]?.value,
      draft: document.querySelectorAll('.big-textarea')[1]?.value,
    }));
    check(`[首屏竞态] ${path}迟到不覆盖输入`, state.title === '正在编辑的标题' && state.source === '正在编辑的中文' && state.draft === 'Draft in progress', JSON.stringify(state));
  } finally {
    await context.close();
  }
}

async function unsavedDraftJourney() {
  const { context, page } = await newPage(profiles[0][1]);
  try {
    await boot(page);
    await page.waitForTimeout(900);
    await page.locator('.sidebar .primary-btn').first().click();
    if (await page.locator('.modal[aria-label="新建回译作业"]').count()) {
      await page.locator('.modal[aria-label="新建回译作业"] button', { hasText: /不保存，直接新建|新建空白作业/ }).first().click();
    }
    await page.locator('.topbar-title').fill('草稿保存回归');
    await page.locator('.big-textarea').nth(0).fill('一段自定义中文。');
    await page.locator('.big-textarea').nth(1).fill('My unfinished draft.');
    await page.locator('.sidebar .primary-btn').first().click();
    const beforeSave = await page.locator('.modal[aria-label="新建回译作业"]').innerText();
    check('[初稿] 首次新建明确说明初稿不会入库', beforeSave.includes('不会存进课文库') && beforeSave.includes('仅存课文并新建'));
    await page.locator('.modal[aria-label="新建回译作业"] button', { hasText: '返回编辑器' }).click();
    await openMoreAction(page, '保存到课文库');
    await page.locator('.modal[aria-label="保存到课文库"] input[placeholder*="例如"]').fill('草稿回归库');
    await page.locator('.modal[aria-label="保存到课文库"] .modal-actions .primary-btn').click();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-lesson-libraries') || '[]'));
    check('[初稿] 课文库保存成功且未伪装存储初稿', stored.length === 1 && stored[0].lessons.length === 1 && !('draft' in stored[0].lessons[0]));
    await page.locator('.sidebar .primary-btn').first().click();
    const afterSave = await page.locator('.modal[aria-label="新建回译作业"]').innerText();
    check('[初稿] 保存材料后仍提示初稿未保存', afterSave.includes('不会存进课文库') && afterSave.includes('清空') && !afterSave.includes('这份内容已经在课文库里、且没有改动'));
    await page.locator('.modal[aria-label="新建回译作业"] button', { hasText: '返回编辑器' }).click();
    check('[初稿] 返回编辑器保留原文', await page.locator('.big-textarea').nth(1).inputValue() === 'My unfinished draft.');
    await page.locator('.sidebar .primary-btn').first().click();
    await page.locator('.modal[aria-label="新建回译作业"] .modal-actions .primary-btn').click();
    check('[初稿] 明确选择清空后才新建', await page.locator('.big-textarea').nth(1).inputValue() === '');
    await page.locator('.modebar-seg[aria-label="练习方向"] button', { hasText: '英译汉' }).click();
    await page.locator('.lib-tab').first().click();
    await page.locator('.lesson-item').first().click();
    await page.locator('.sidebar .primary-btn').first().click();
    const reverse = await page.locator('.modal[aria-label="新建回译作业"]').innerText();
    check('[初稿] 英译汉载入已存课文不会误报未保存', reverse.includes('课文材料已经在课文库里') && reverse.includes('新建空白作业'));
  } finally {
    await context.close();
  }
}

async function mobileDraftModal() {
  const { context, page } = await newPage(profiles[1][1]);
  try {
    await boot(page);
    await page.locator('.modebar-seg[aria-label="练习模式"] button', { hasText: '自由模式' }).click();
    await page.locator('.big-textarea').nth(0).fill('手机上的未完成练习。');
    await page.locator('.big-textarea').nth(1).fill('An unfinished mobile draft.');
    await openSidebar(page);
    await page.locator('.sidebar .primary-btn').first().click();
    const fit = await page.locator('.modal[aria-label="新建回译作业"]').evaluate((el) => {
      const modal = el.getBoundingClientRect();
      const actions = [...el.querySelectorAll('.modal-actions button')].map((button) => button.getBoundingClientRect());
      return { modalLeft: modal.left, modalRight: modal.right, buttonRight: Math.max(...actions.map((r) => r.right)), width: window.innerWidth };
    });
    check('[初稿·安卓] 新建弹窗和长按钮不横向溢出', fit.modalLeft >= -1 && fit.modalRight <= fit.width + 1 && fit.buttonRight <= fit.width + 1, JSON.stringify(fit));
    check('[初稿·安卓] 新建弹窗提示初稿将清空', (await page.locator('.modal[aria-label="新建回译作业"]').innerText()).includes('不会存进课文库'));
  } finally {
    await context.close();
  }
}

async function sectionJourney(name, options) {
  const { context, page, errors } = await newPage(options);
  try {
    await boot(page);
    await page.evaluate(() => localStorage.setItem('bt-lesson-libraries', JSON.stringify([
      { id: 'lib-group-probe', name: '分组回归库', createdAt: 1, sections: null,
        lessons: [1, 2, 3].map((no) => ({ book: 'my', lid: `lsn-group-${no}`, lesson: no,
          title_cn: `测试课文${no}`, title_en: '', chinese: `中文${no}`, english: `English ${no}` })) },
      { id: 'lib-other-probe', name: '第二自建库', createdAt: 2, sections: null,
        lessons: [{ book: 'my', lid: 'lsn-other-1', lesson: 1, title_cn: '另一库第一课',
          title_en: '', chinese: '另一库的中文', english: 'Other library' }] },
      { id: 'lib-empty-probe', name: '空白自建库', createdAt: 3, sections: null, lessons: [] },
    ])))
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.status-chip').waitFor();
    await openSidebar(page);
    await page.locator('.lib-tab', { hasText: '分组回归库' }).click();
    await openSidebar(page);
    check(`[${name}·分组] 选择自建库后内置库取消高亮`, await page.locator('.lib-row.active').count() === 1
      && await page.locator('.builtin-tab.active').count() === 0
      && await page.locator('.builtin-tab[aria-pressed="true"]').count() === 0);
    check(`[${name}·切库] 首次点击即载入该库第一课`, await page.locator('.topbar-title').inputValue() === '测试课文1'
      && await page.locator('.big-textarea').first().inputValue() === '中文1');
    await page.locator('.lib-tab', { hasText: '第二自建库' }).click();
    await openSidebar(page);
    check(`[${name}·切库] 换库后立即显示新库课文`, await page.locator('.topbar-title').inputValue() === '另一库第一课'
      && await page.locator('.big-textarea').first().inputValue() === '另一库的中文'
      && await page.locator('.lesson-row.active .lesson-title').textContent() === '另一库第一课');
    await page.locator('.lib-tab', { hasText: '空白自建库' }).click();
    await openSidebar(page);
    check(`[${name}·切库] 空库清除旧课文内容`, await page.locator('.topbar-title').inputValue() === ''
      && await page.locator('.big-textarea').first().inputValue() === ''
      && await page.locator('.match-banner').count() === 0);
    if (options.isMobile) await page.locator('.sidebar-close').click();
    await openMoreAction(page, '保存到课文库');
    check(`[${name}·切库] 保存弹窗默认选中当前自建库`, (await page.locator('.lib-option.active').innerText()).includes('空白自建库'));
    await closeModal(page);
    await openSidebar(page);
    await page.locator('.lib-tab', { hasText: '分组回归库' }).click();
    await openSidebar(page);
    await page.locator('.builtin-tab', { hasText: '回译课文' }).click();
    await openSidebar(page);
    check(`[${name}·分组] 切回内置库时只高亮内置库`, await page.locator('.builtin-tab.active').count() === 1
      && await page.locator('.lib-row.active').count() === 0);
    await page.locator('.lib-tab', { hasText: '分组回归库' }).click();
    await openSidebar(page);
    await page.getByRole('button', { name: '新建分组' }).click();
    await page.getByRole('dialog', { name: '新建分组' }).waitFor();
    await page.locator('.section-editor input[placeholder="例如：重点复习"]').fill('重点');
    await page.locator('.section-picker-row', { hasText: '测试课文2' }).locator('input').check();
    await page.locator('.section-picker-row', { hasText: '测试课文3' }).locator('input').check();
    const fit = await page.locator('.section-editor').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight };
    });
    check(`[${name}·分组] 弹窗位于视口内`, fit.left >= -1 && fit.right <= fit.width + 1 && fit.bottom <= fit.height + 1, JSON.stringify(fit));
    await page.getByRole('button', { name: '创建分组' }).click();
    const header = page.locator('.mylib-group', { hasText: '重点' });
    check(`[${name}·分组] 创建后立即显示分组和选中课文`, await header.count() === 1
      && (await page.locator('.lesson-list').innerText()).includes('测试课文2'));
    const afterCreate = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-lesson-libraries'))[0]);
    check(`[${name}·分组] 编号 2、3 已持久归组`, afterCreate.sections.includes('重点')
      && afterCreate.lessons.filter((lesson) => lesson.section === '重点').map((lesson) => lesson.lesson).join(',') === '2,3');
    await page.getByRole('button', { name: '新建分组' }).click();
    await page.keyboard.press('Escape');
    check(`[${name}·分组] Esc 可关闭分组弹窗`, await page.locator('.section-editor').count() === 0);
    await page.getByRole('button', { name: '新建分组' }).click();
    await page.locator('.section-editor input[placeholder="例如：重点复习"]').fill('空组');
    await page.getByRole('button', { name: '创建分组' }).click();
    check(`[${name}·分组] 没选课文的空组也立即可见`, await page.locator('.mylib-group', { hasText: '空组' }).count() === 1);
    await page.getByRole('button', { name: '解散分组 空组' }).click();
    await page.getByRole('button', { name: '修改分组 重点' }).click();
    await page.getByRole('dialog', { name: '修改分组' }).waitFor();
    await page.locator('.section-editor input[placeholder="例如：重点复习"]').fill('高频');
    await page.locator('.section-picker-row', { hasText: '测试课文1' }).locator('input').check();
    await page.locator('.section-picker-row', { hasText: '测试课文3' }).locator('input').uncheck();
    await page.getByRole('button', { name: '保存分组' }).click();
    const afterEdit = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-lesson-libraries'))[0]);
    check(`[${name}·分组] 改名并调整课文编号`, afterEdit.sections.includes('高频')
      && afterEdit.lessons.map((lesson) => lesson.section || '').join(',') === '高频,高频,');
    await page.getByRole('button', { name: '解散分组 高频' }).click();
    const afterDissolve = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-lesson-libraries'))[0]);
    check(`[${name}·分组] 解散后保留三节课及原编号`, afterDissolve.sections.length === 0
      && afterDissolve.lessons.map((lesson) => lesson.lesson).join(',') === '1,2,3'
      && afterDissolve.lessons.every((lesson) => !lesson.section));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.status-chip').waitFor();
    await openSidebar(page);
    await page.locator('.lib-tab', { hasText: '分组回归库' }).click();
    await openSidebar(page);
    check(`[${name}·分组] 刷新后仍有三节课`, await page.locator('.lesson-row').count() === 3);
    check(`[${name}·分组] 全程无脚本错误`, errors.length === 0, errors.join(' | '));
  } finally {
    await context.close();
  }
}

try {
  for (const [name, options] of profiles) {
    try { await journey(name, options); }
    catch (error) { check(`[${name}] 用户旅程完成`, false, error.message); }
  }
  if (!LIVE) {
    for (const path of ['课表', '课文详情']) {
      try { await delayedInitialSelection(path); }
      catch (error) { check(`[首屏竞态] ${path}探针执行`, false, error.message); }
    }
    try { await unsavedDraftJourney(); }
    catch (error) { check('[初稿] 探针执行', false, error.message); }
    try { await mobileDraftModal(); }
    catch (error) { check('[初稿·安卓] 探针执行', false, error.message); }
    for (const [name, options] of profiles) {
      try { await sectionJourney(name, options); }
      catch (error) { check(`[${name}·分组] 探针执行`, false, error.message); }
    }
  }
} finally {
  await browser.close();
  server?.kill();
  mock?.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n========== ${results.length - failed.length}/${results.length} 项通过 ==========`);
if (failed.length) for (const item of failed) console.log(`  ✗ ${item.name}: ${item.detail}`);
process.exit(failed.length ? 1 : 0);
