/** Real browser flows against an isolated server/mock model; no production writes or AI calls. */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, webkit, devices } from './shotter/node_modules/playwright/index.mjs';
import { PDFDocument } from 'pdf-lib';

const port = 8945, modelPort = 8946, base = `http://127.0.0.1:${port}/`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-generation-mobile-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = { title: '手机导出测试', direction: 'en2cn', chinese: 'The sea erodes the coast.', draft: '海水侵蚀海岸。',
  ai: '海水不断侵蚀海岸。', original: '海水侵蚀着海岸。', overall: { score: 88, summary: '含义准确，表达清楚。', highlights: ['含义准确'], advice: ['关注上下文'] },
  sentences: [{ cn: 'The sea erodes the coast.', draft: '海水侵蚀海岸。', ai: '海水不断侵蚀海岸。', original: '海水侵蚀着海岸。', findings: [] }] };
const requests = [], waiters = [];
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  await new Promise((resolve) => waiters.push(resolve));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sample) } }] }));
});
await new Promise((r) => model.listen(modelPort, '127.0.0.1', r));
const server = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, PORT: String(port),
  DATA_DIR: dir, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', AI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
  AI_API_KEY: 'mock-generation', ALLOW_PRIVATE_BASE_URL: '1', FREE_DAILY_IP: '100' }, stdio: 'ignore' });
const browsers = [];
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + 'api/health')).ok) break; } catch { /* startup */ } await sleep(200); }
  const desktop = await chromium.launch(); browsers.push(desktop);
  const context = await desktop.newContext();
  await context.addInitScript(() => { localStorage.setItem('bt-guide-done', '1'); });
  let page = await context.newPage();
  await page.goto(base);
  await page.locator('.goal-skip').click({ timeout: 2000 }).catch(() => {});
  await page.getByRole('button', { name: '自由模式', exact: true }).click();
  await page.locator('.editor-grid .big-textarea').nth(0).fill('题目');
  await page.locator('.editor-grid .big-textarea').nth(1).fill('My translation.');
  assert.equal(await page.locator('.generation-preference input').isChecked(), false);
  await page.locator('.action-dock .primary-btn').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('bt-history') || '[]')[0]?.status === 'pending');
  while (!requests.length) await sleep(20);
  assert.notEqual(requests[0].stream, true);
  assert.equal(await page.locator('.result-sheet').count(), 0);
  assert.match(requests[0].messages[0].content, /可选润色和学习点不扣分/);
  const jobId = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-history'))[0].jobId);
  await page.close();
  page = await context.newPage(); await page.goto(base);
  await page.locator('.progress-box').waitFor();
  assert.equal(requests.length, 1, '恢复不得重新调用模型');
  waiters.splice(0).forEach((r) => r());
  await page.locator('.result-sheet').waitFor({ timeout: 15000 });
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-history')));
  assert.equal(history.length, 1); assert.equal(history[0].jobId, jobId); assert.equal(history[0].status, 'done');
  assert.equal(requests.length, 1);
  console.log('PASS 默认一次性出结果；关闭页面后从裸首页恢复同一任务，不重复提交/计费');
  await context.close();

  const safari = await webkit.launch(); browsers.push(safari);
  for (const [name, browser, options] of [
    ['Android Chrome', desktop, devices['Pixel 7']], ['iPhone Safari WebKit', safari, devices['iPhone 13']],
    ['微信 UA 仿真', desktop, { ...devices['iPhone 13'], userAgent: devices['iPhone 13'].userAgent + ' MicroMessenger/8.0' }],
  ]) {
    const ctx = await browser.newContext({ ...options, acceptDownloads: true });
    const p = await ctx.newPage(); const errors = [];
    p.on('pageerror', (error) => errors.push(error.message));
    await p.goto(base + '#job=' + jobId);
    await p.locator('.result-sheet').waitFor();
    const downloadEvent = p.waitForEvent('download', { timeout: 45000 });
    await p.getByRole('button', { name: '导出 PDF', exact: true }).click();
    const download = await downloadEvent;
    const saved = path.join(dir, name.replace(/\W/g, '_') + '.pdf'); await download.saveAs(saved);
    const pdf = await PDFDocument.load(fs.readFileSync(saved));
    assert.ok(pdf.getPageCount() > 0); assert.ok(download.suggestedFilename().endsWith('.pdf'));
    await p.locator('.pdf-download-link').waitFor();
    if (name.includes('微信')) assert.match(await p.locator('.pdf-export-status').textContent(), /在浏览器打开/);
    const secondEvent = p.waitForEvent('download', { timeout: 15000 });
    await p.locator('.pdf-download-link').click(); await secondEvent;
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    console.log(`PASS ${name}：生成真实 PDF、再次下载链接、无横向溢出或页面异常`);
    await ctx.close();
  }
} finally {
  waiters.splice(0).forEach((r) => r());
  for (const browser of browsers) await browser.close();
  server.kill(); model.close();
}
