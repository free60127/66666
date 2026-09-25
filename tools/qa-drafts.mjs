/** 草稿回归：用独立服务和浏览器存储复现切课、慢请求、清空及写入失败。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from './shotter/node_modules/playwright/index.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port;
    socket.close(() => resolve(port));
  });
});

const port = await freePort();
const base = `http://127.0.0.1:${port}/`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-draft-qa-'));
const server = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' },
  stdio: 'ignore',
});
let browser;

async function setupPage() {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(base);
  await page.locator('.lesson-group-title.foldable').first().waitFor();
  await page.locator('.lesson-search input').fill('1');
  const rows = page.locator('.lesson-item');
  await rows.nth(1).waitFor();
  const first = Number(await rows.nth(0).locator('.lesson-no').textContent());
  const second = Number(await rows.nth(1).locator('.lesson-no').textContent());
  await rows.nth(0).click();
  await page.waitForFunction((n) => document.querySelector('.lesson-row.active .lesson-no')?.textContent.trim() === String(n).padStart(2, '0') && document.querySelector('.topbar-title')?.value !== '课文加载中…', first);
  return { context, page, rows, first, second, draft: page.locator('.editor-grid .big-textarea').nth(1) };
}

async function selectAndWait(page, row, number) {
  await row.click();
  await page.waitForFunction((n) => document.querySelector('.lesson-row.active .lesson-no')?.textContent.trim() === String(n).padStart(2, '0') && document.querySelector('.topbar-title')?.value !== '课文加载中…', number);
}

try {
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    try { ready = (await fetch(base + 'api/health')).ok; } catch { /* server starting */ }
    if (ready) break;
    await sleep(200);
  }
  assert.ok(ready, '本地测试服务未启动');
  browser = await chromium.launch();

  {
    const { context, page, rows, first, second, draft } = await setupPage();
    await draft.fill('QUICK_DRAFT_UNIQUE');
    await selectAndWait(page, rows.nth(1), second);
    await selectAndWait(page, rows.nth(0), first);
    assert.equal(await draft.inputValue(), 'QUICK_DRAFT_UNIQUE');
    console.log('PASS 快速切课后恢复原课草稿');
    await context.close();
  }

  {
    const { context, page, rows, first, second, draft } = await setupPage();
    await draft.fill('SLOW_DRAFT_UNIQUE');
    await page.route(`**/api/lessons/10/${second}`, async (route) => { await sleep(1500); await route.continue(); });
    await rows.nth(1).click();
    await page.getByText('课文加载中，请稍候…').waitFor();
    await sleep(1000);
    const during = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-drafts') || '{}'));
    assert.equal(during[`lesson:10-${second}`], undefined, '加载期间串写到了目标课文');
    await page.waitForFunction((n) => document.querySelector('.lesson-row.active .lesson-no')?.textContent.trim() === String(n).padStart(2, '0') && document.querySelector('.topbar-title')?.value !== '课文加载中…', second);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-drafts') || '{}'));
    assert.equal(after[`lesson:10-${second}`], undefined, '加载完成后仍串写到了目标课文');
    await selectAndWait(page, rows.nth(0), first);
    assert.equal(await draft.inputValue(), 'SLOW_DRAFT_UNIQUE');
    console.log('PASS 慢请求切课不串写且原课草稿保留');
    await context.close();
  }

  {
    const { context, page, rows, first, second, draft } = await setupPage();
    await draft.fill('DELETE_DRAFT_UNIQUE');
    await page.waitForFunction((key) => Boolean(JSON.parse(localStorage.getItem('bt-drafts') || '{}')[key]), `lesson:10-${first}`);
    await draft.fill('');
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem('bt-drafts') || '{}')[key], `lesson:10-${first}`);
    assert.equal(stored, undefined, '用户清空初稿后旧草稿仍在存储中');
    await selectAndWait(page, rows.nth(1), second);
    await selectAndWait(page, rows.nth(0), first);
    assert.equal(await draft.inputValue(), '');
    console.log('PASS 清空初稿后不恢复旧内容');
    await context.close();
  }

  {
    const { context, page, rows, first, draft } = await setupPage();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'bt-drafts') throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await draft.fill('QUOTA_DRAFT_UNIQUE');
    await page.getByRole('button', { name: '存草稿' }).click();
    assert.match(await page.locator('.fav-tip.toast').textContent(), /草稿未能保存/);
    await rows.nth(1).click();
    assert.equal(await page.locator('.lesson-row.active .lesson-no').textContent().then((v) => Number(v)), first, '保存失败后仍切换了课文');
    assert.equal(await draft.inputValue(), 'QUOTA_DRAFT_UNIQUE');
    console.log('PASS 存储失败时提示失败并阻止丢失草稿');
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  server.kill();
  if (path.resolve(dataDir).startsWith(path.resolve(os.tmpdir(), 'bts-draft-qa-'))) fs.rmSync(dataDir, { recursive: true, force: true });
}
