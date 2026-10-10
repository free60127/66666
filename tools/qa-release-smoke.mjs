/** Read-only live smoke, or isolated local DOCX and responsive footer checks. */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import { chromium, devices } from './shotter/node_modules/playwright/index.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-release-'));
let server, browser;
let base = process.env.BASE;
try {
  if (!base) {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    base = `http://127.0.0.1:${port}/`;
    server = spawn(process.execPath, ['server/index.mjs'], { stdio: 'ignore', env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir,
      UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', SMTP_TEST_MODE: '1', EMAIL_VERIFY: '1',
    } });
    let ready = false;
    for (let n = 0; n < 60 && !ready; n++) {
      try { ready = (await fetch(base + 'api/health')).ok; } catch { /* starting */ }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, 'isolated server startup');
  }
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX release smoke</w:t></w:r></w:p><w:p><w:r><w:t>今天我在花园里观察机器人。</w:t></w:r></w:p><w:p><w:r><w:t>Today I watched a robot in the garden.</w:t></w:r></w:p></w:body></w:document>');
  const docx = await zip.generateAsync({ type: 'nodebuffer' });
  browser = await chromium.launch();
  for (const [name, options] of [['desktop', { viewport: { width: 1360, height: 900 } }], ['Pixel', devices['Pixel 7']], ['iPhone', devices['iPhone 13']]]) {
    const context = await browser.newContext(options);
    await context.addInitScript(() => localStorage.setItem('bt-goal', 'cet'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.locator('.editor').waitFor();
    const footer = page.locator('.site-footer a');
    await footer.scrollIntoViewIfNeeded();
    assert.ok(await footer.isVisible(), name + ' student footer');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' student overflow');
    if (!process.env.BASE) {
      await page.locator('input[type=file][accept*=".docx"]').setInputFiles({ name: 'release-smoke.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some((element) => element.value === 'Today I watched a robot in the garden.'));
      assert.ok(await page.locator('textarea').evaluateAll((elements) => elements.some((element) => element.value === '今天我在花园里观察机器人。')), name + ' DOCX Chinese');
    }
    await page.goto(base + 'teacher.html');
    await page.getByRole('button', { name: '没有账号？开放注册' }).click();
    await page.getByLabel('邮箱验证码').waitFor();
    await page.locator('.teacher-site-footer a').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('.teacher-site-footer a').isVisible(), name + ' teacher footer');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' teacher overflow');
    assert.deepEqual(errors, [], name + ' script errors');
    console.log(`PASS ${name}: student/teacher footer, registration, responsive fit${process.env.BASE ? '' : ', real DOCX import'}`);
    await context.close();
  }
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once('exit', resolve));
    server.kill(); await stopped;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
