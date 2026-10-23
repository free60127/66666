/** Real-browser regressions for assignment identity, concurrent drafts and late grading. No paid calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from './shotter/node_modules/playwright/index.mjs';
import { startWritingServer } from '../test/fixtures/writingServer.mjs';
import { WRITING_EXAM_BANK } from '../src/writingExamBank.js';

const app = await startWritingServer(8968);
const browser = await chromium.launch();
const [a, b] = WRITING_EXAM_BANK;
const essay = 'Students should learn to cook because this practical skill helps them live independently. Cooking at home is also an effective way to stay healthy and save money.';
const errors = [];
const contexts = [];
const out = 'tmp/writing-regressions';
fs.mkdirSync(out, { recursive: true });
async function fresh(extra = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  await context.addInitScript(({ a, essay, extra, origin }) => {
    if (window.location.origin !== origin) return;
    if (localStorage.getItem('regression-initialized')) return;
    localStorage.setItem('regression-initialized', '1');
    localStorage.setItem('bt-goal', 'skip'); localStorage.setItem('bt-guide-done', '1');
    localStorage.setItem('bt-writing-open', '1');
    localStorage.setItem('bt-writing-studio', JSON.stringify({ topic: a, essay }));
    for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, JSON.stringify(value));
  }, { a, essay, extra, origin: app.origin });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error' && msg.text().includes('渲染崩溃')) errors.push(msg.text()); });
    page.on('dialog', dialog => dialog.accept());
  });
  const page = await context.newPage();
  await page.goto(app.origin); await page.locator('.ws-essay').waitFor();
  return { page, context };
}
const choose = async (page, topic) => {
  await page.getByRole('button', { name: '返回题库', exact: true }).click();
  await page.locator('.ws-card').filter({ has: page.getByRole('heading', { name: topic.zh, exact: true }) }).getByRole('button', { name: '写这篇', exact: true }).click();
};
const saved = (page, text) => page.waitForFunction(text => Object.keys(localStorage)
  .filter(key => key.startsWith('bt-writing-draft:')).some(key => JSON.parse(localStorage.getItem(key)).essay === text), text);
const report = page => page.locator('.result-sheet .score-row').first().waitFor({ timeout: 15000 });
async function check(name, run) {
  await run(); console.log('PASS ' + name);
}
try {
  await check('不同题目跨标签页保存，不覆盖另一页刚写的正文', async () => {
    const { page, context } = await fresh();
    const other = await context.newPage(); await other.goto(app.origin); await other.locator('.ws-essay').waitFor();
    await page.locator('.ws-essay').fill(essay + ' LATEST A.'); await saved(page, essay + ' LATEST A.');
    await choose(other, b); await other.locator('.ws-essay').fill('Independent B.'); await saved(other, 'Independent B.');
    await page.reload(); await page.locator('.ws-essay').waitFor();
    assert.equal(await page.locator('.ws-essay').inputValue(), essay + ' LATEST A.');
    await choose(other, a); assert.equal(await other.locator('.ws-essay').inputValue(), essay + ' LATEST A.');
    await choose(page, b); assert.equal(await page.locator('.ws-essay').inputValue(), 'Independent B.');
    await context.close();
  });
  await check('同题并行编辑保留两个版本，可载入另一版本', async () => {
    const { page, context } = await fresh();
    await page.locator('.ws-essay').fill(essay + ' Shared base.'); await saved(page, essay + ' Shared base.');
    const other = await context.newPage(); await other.goto(app.origin); await other.locator('.ws-essay').waitFor();
    await page.locator('.ws-essay').fill('Version from first tab.'); await saved(page, 'Version from first tab.');
    await other.locator('.ws-essay').fill('Version from second tab.'); await saved(other, 'Version from second tab.');
    await page.locator('.ws-draft-copies summary').click();
    await page.locator('.ws-draft-copies').getByText('Version from second tab.', { exact: true }).waitFor();
    await page.locator('.ws-draft-copies').getByRole('button', { name: '载入此版本' }).click();
    assert.equal(await page.locator('.ws-essay').inputValue(), 'Version from second tab.');
    if (await page.locator('.ws-draft-copies').getAttribute('open') === null) await page.locator('.ws-draft-copies summary').click();
    await page.locator('.ws-draft-copies').getByText('Version from first tab.', { exact: true }).waitFor();
    await page.screenshot({ path: out + '/concurrent-versions.png' });
    await context.close();
  });
  await check('同题干两份班级作业隔离、刷新保持 300 词、提交材料对应当前作业', async () => {
    const { page, context } = await fresh({ 'bts-class-memberships': [{ classId: 'qa-class', studentKey: 'qa-student', className: 'QA class', name: 'Test', studentNo: '1' }] });
    const first = { id: 'hw-a', title: 'Assignment A', type: 'writing', prompt: 'Discuss online learning.', material: 'Material A.', targetWords: 300, dueAt: Date.now() + 1000000 };
    const second = { ...first, id: 'hw-b', title: 'Assignment B', material: 'Material B.', targetWords: 150 };
    await page.route('**/api/classes/qa-class/student-dashboard', route => route.fulfill({ json: { class: { id: 'qa-class', name: 'QA class' }, student: { subs: [] }, homeworks: [first, second], corpus: [] } }));
    const start = async title => {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await page.getByRole('button', { name: '加入教师班级', exact: true }).click();
      await page.locator('.class-task-row').filter({ hasText: title }).getByRole('button', { name: '开始作业' }).click();
      await page.locator('.ws-topbar-zh').filter({ hasText: title }).waitFor();
    };
    await start('Assignment A'); await page.locator('.ws-essay').fill(essay + ' A ONLY.');
    await page.reload(); await page.locator('.ws-essay').waitFor();
    assert.ok((await page.locator('.ws-side').innerText()).includes('300 词'));
    assert.equal(await page.locator('.ws-essay').inputValue(), essay + ' A ONLY.');
    await start('Assignment B'); assert.equal(await page.locator('.ws-essay').inputValue(), '');
    assert.ok((await page.locator('.ws-material').innerText()).includes('Material B.'));
    await page.locator('.ws-essay').fill(essay + ' B ONLY.');
    await start('Assignment A'); assert.equal(await page.locator('.ws-essay').inputValue(), essay + ' A ONLY.');
    await start('Assignment B'); assert.equal(await page.locator('.ws-essay').inputValue(), essay + ' B ONLY.');
    await page.getByRole('button', { name: '学习首页', exact: true }).click();
    await page.locator('.learning-home-cards article').filter({ hasText: '继续写作：Assignment B' }).getByRole('button', { name: '继续学习', exact: true }).click();
    assert.equal(await page.locator('.ws-essay').inputValue(), essay + ' B ONLY.');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('bts-active-homework')).hwId), 'hw-b');
    assert.equal(await page.getByText(/题目已锁定/).count(), 1);
    const request = page.waitForRequest(r => r.url().endsWith('/api/analyze') && r.method() === 'POST');
    await page.getByRole('button', { name: '提交批改', exact: true }).click();
    const body = (await request).postDataJSON();
    assert.equal(body.chinese, second.prompt); assert.equal(body.material, second.material); assert.equal(body.targetWords, 150); assert.equal(body.draft, essay + ' B ONLY.');
    await report(page);
    assert.equal(await page.evaluate(() => localStorage.getItem('bts-active-homework')), null);
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    await page.getByRole('button', { name: '返回题库', exact: true }).waitFor();
    await page.getByRole('button', { name: '自由模式', exact: true }).click();
    await page.getByRole('button', { name: '写作模式', exact: true }).click();
    assert.equal(await page.getByText(/题目已锁定/).count(), 0);
    await context.close();
  });
  for (const stream of [false, true]) await check(`批改迟到不打断新作文，旧结果进入历史（流式=${stream}）`, async () => {
    const { page, context } = await fresh({ 'bt-stream-results': stream });
    if (stream) {
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
      const modal = page.getByRole('dialog', { name: 'AI 接入设置' });
      await modal.getByRole('checkbox', { name: /边生成边显示/ }).check();
      await modal.getByRole('button', { name: '取消', exact: true }).click();
    }
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/analyze/**', async route => { await gate; await route.continue().catch(() => {}); });
    const submitted = page.waitForResponse(r => r.url().endsWith('/api/analyze') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '提交批改', exact: true }).click(); await submitted;
    await choose(page, b); await page.locator('.ws-essay').fill('Still writing topic B.'); release();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('bt-history') || '[]').some(row => row.status === 'done'), null, { timeout: 15000 });
    assert.equal(await page.locator('.result-sheet').count(), 0);
    assert.equal(await page.locator('.ws-essay').inputValue(), 'Still writing topic B.');
    await page.reload(); await page.locator('.ws-essay').waitFor();
    assert.equal(await page.locator('.ws-essay').inputValue(), 'Still writing topic B.');
    assert.equal(await page.locator('.result-sheet').count(), 0);
    await context.close();
  });
  await check('班级作文批改中刷新恢复同一任务，完成后解除题目锁定', async () => {
    const active = { classId: 'qa-class', hwId: 'qa-hw', at: Date.now(), kind: 'writing', prompt: 'Discuss online learning.', title: 'Pending assignment', targetWords: 300 };
    const { page, context } = await fresh({ 'bts-active-homework': active });
    let allow = false, posts = 0;
    page.on('request', r => { if (r.url().endsWith('/api/analyze') && r.method() === 'POST') posts += 1; });
    await page.route('**/api/analyze/*', route => allow ? route.continue() : route.fulfill({ json: { job: { status: 'running' } } }));
    await page.locator('.ws-essay').fill(essay);
    await page.getByRole('button', { name: '提交批改', exact: true }).click();
    await page.waitForFunction(() => location.hash.startsWith('#job='));
    await page.reload(); await page.locator('.ws-essay').waitFor(); allow = true;
    await report(page); assert.equal(posts, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('bts-active-homework')), null);
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    await page.getByRole('button', { name: '返回题库', exact: true }).waitFor();
    assert.equal(await page.locator('.ws-essay').inputValue(), essay);
    await context.close();
  });
  await check('自定义标题刷新保留；历史继续修改创建副本，保留当前 B', async () => {
    const { page, context } = await fresh();
    const title = page.locator('input[placeholder="英语写作 · 作业标题"]');
    await title.fill('My saved writing title');
    await page.reload(); await page.locator('.ws-essay').waitFor(); assert.equal(await title.inputValue(), 'My saved writing title');
    await page.getByRole('button', { name: '提交批改', exact: true }).click(); await report(page);
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    await choose(page, b); await page.locator('.ws-essay').fill('Current topic B essay.');
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: /历史结果/ }).click(); await page.locator('.history-open').first().click(); await report(page);
    await page.getByRole('button', { name: '继续修改本篇', exact: true }).click();
    await page.locator('.ws-essay').waitFor(); assert.equal(await page.locator('.ws-essay').inputValue(), essay);
    assert.equal(await title.inputValue(), 'My saved writing title');
    assert.equal(await page.locator('.ws-topic-q').innerText(), a.question);
    await choose(page, b); assert.equal(await page.locator('.ws-essay').inputValue(), 'Current topic B essay.');
    await context.close();
  });
  await check('空间不足警告、导出含未保存正文、导入恢复不覆盖新草稿', async () => {
    const { page, context } = await fresh();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('bt-writing-draft:')) throw new DOMException('Quota full', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await page.locator('.ws-essay').fill('Unsaved text included in backup.');
    await page.getByRole('alert').filter({ hasText: '草稿未能保存' }).waitFor();
    const backup = async p => {
      await p.getByRole('button', { name: '更多', exact: true }).click();
      await p.getByRole('button', { name: '备份 / 恢复', exact: true }).click();
    };
    await backup(page);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出备份文件', exact: true }).click();
    const download = await downloading; const file = out + '/backup.json'; await download.saveAs(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(data.writingDrafts.some(row => row.essay === 'Unsaved text included in backup.'));
    const freshBrowser = await fresh(); const secondPage = freshBrowser.page;
    await secondPage.locator('.ws-essay').fill('Newer local text.'); await saved(secondPage, 'Newer local text.');
    await backup(secondPage);
    await secondPage.getByRole('dialog', { name: '备份与恢复' }).locator('input[type="file"]').setInputFiles(file);
    await secondPage.getByText(/导入完成：/).waitFor();
    await secondPage.keyboard.press('Escape');
    assert.equal(await secondPage.locator('.ws-essay').inputValue(), 'Newer local text.');
    await secondPage.locator('.ws-draft-copies summary').click();
    await secondPage.locator('.ws-draft-copies').getByText('Unsaved text included in backup.', { exact: true }).waitFor();
    await context.close(); await freshBrowser.context.close();
  });
  for (const englishToChinese of [false, true]) await check(`翻译与写作往返保留双方正文及方向（英译汉=${englishToChinese}）`, async () => {
    const { page, context } = await fresh();
    await page.getByRole('button', { name: '自由模式', exact: true }).click();
    if (englishToChinese) await page.getByRole('button', { name: '英译汉', exact: true }).click();
    const inputs = page.locator('.big-textarea');
    const source = englishToChinese ? 'Translate this sentence.' : '请翻译这一句话。';
    const draft = englishToChinese ? '请翻译这一句话。' : 'Translate this sentence.';
    await inputs.nth(0).fill(source); await inputs.nth(1).fill(draft);
    await page.getByRole('button', { name: '写作模式', exact: true }).click();
    assert.equal(await page.locator('.ws-essay').inputValue(), essay);
    const request = page.waitForRequest(r => r.url().endsWith('/api/analyze') && r.method() === 'POST');
    await page.getByRole('button', { name: '提交批改', exact: true }).click();
    const body = (await request).postDataJSON(); assert.equal(body.direction, 'writing'); assert.equal(body.draft, essay); assert.equal(body.original, undefined); assert.equal(body.book, undefined);
    await report(page); await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    await page.getByRole('button', { name: '自由模式', exact: true }).click();
    assert.equal(await inputs.nth(0).inputValue(), source); assert.equal(await inputs.nth(1).inputValue(), draft);
    assert.equal(await page.evaluate(() => localStorage.getItem('bt-direction') || 'cn2en'), englishToChinese ? 'en2cn' : 'cn2en');
    await context.close();
  });
  assert.deepEqual(errors, []);
  console.log('PASS 无页面运行异常');
} finally {
  for (const context of contexts) await context.close();
  await browser.close(); await app.stop();
}
