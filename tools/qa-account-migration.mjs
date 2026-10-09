/** 浏览器回归：旧数据迁移、手机恢复、退出隔离、密码管理。完全隔离生产存储。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, devices } from './shotter/node_modules/playwright/index.mjs';
import { createFileKv } from '../server/kv.mjs';
import { createFileStore, emptySnapshot } from '../server/sync.mjs';
import { createAccounts } from '../server/accounts.mjs';
import { sealText } from '../src/secretBox.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-browser-migration-'));
const password = 'migration-pass-123';
const email = 'migration-browser@example.com';
const code = 'e'.repeat(32);
const fixture = { ...emptySnapshot(), libraries: [{ id: 'qa-library', name: '迁移课文库', createdAt: 1,
  sections: ['旧分组'], sectionsUpdatedAt: 2,
  lessons: [{ lid: 'qa-lesson', lesson: 1, title_cn: '迁移课文标题', chinese: '旧云端中文提示'.repeat(3000), english: 'Legacy English reference.'.repeat(1000), section: '旧分组' }] }],
  favorites: [{ id: 'qa-favorite', title: '迁移收藏', kind: 'word', body: '测试释义' }],
  history: [{ jobId: 'legacy-job', title: '迁移历史', time: 1 }], days: ['2026-10-09'] };
const kv = createFileKv(path.join(dir, 'kv'));
await createFileStore(path.join(dir, 'sync')).write(code, { version: 1, data: fixture });
await createAccounts({ kv }).register({ email, password, sync: await sealText(code, password), ip: '127.0.0.1' });
const port = 8968;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, PORT: String(port), DATA_DIR: dir,
  UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', AI_API_KEY: '' }, stdio: 'ignore' });
let browser;
const login = async (page, pass = password) => {
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  const auth = page.getByRole('dialog', { name: '账号' });
  await auth.getByLabel('邮箱').fill(email);
  await auth.getByLabel('密码').fill(pass);
  await auth.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '我的账号' }).waitFor();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('bt-lesson-libraries') || '[]').some((l) => l.id === 'qa-library'));
};
try {
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    try { ready = (await fetch(base + '/api/health')).ok; } catch { /* starting */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready);
  browser = await chromium.launch();
  const desktop = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await desktop.newPage();
  await page.goto(base);
  const skip = page.getByRole('button', { name: '先随便看看，不选' });
  if (await skip.isVisible()) await skip.click();
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await page.getByRole('button', { name: '忘记密码' }).click();
  await page.getByText('邮件找回暂未启用，请联系网站管理员。').waitFor();
  assert.ok(await page.getByRole('button', { name: '发送验证码' }).isDisabled());
  await page.getByRole('dialog', { name: '账号' }).getByRole('button', { name: '关闭' }).click();
  await login(page);
  const restored = await page.evaluate(() => ({ libs: JSON.parse(localStorage.getItem('bt-lesson-libraries')), code: localStorage.getItem('bt-sync-code') }));
  assert.deepEqual(restored.libs[0].sections, ['旧分组']); assert.equal(restored.code, null);
  await page.getByRole('button', { name: '我的账号' }).click();
  const backup = page.getByRole('dialog', { name: '备份与恢复' });
  await backup.getByRole('button', { name: '立即同步' }).click();
  await backup.getByText('同步完成，学习数据已保存到账号').waitFor();
  let idleWrites = 0;
  page.on('request', (r) => { if (r.url().startsWith(base + '/api/account-data') && r.method() === 'POST') idleWrites++; });
  await new Promise((resolve) => setTimeout(resolve, 6500));
  assert.ok(idleWrites <= 1, '无编辑时不会因合并时间戳不断上传');
  assert.equal(await backup.getByRole('textbox', { name: '旧版数据迁移凭据' }).isVisible(), false);
  console.log('PASS 桌面：旧账号登录自动恢复课文、分组，无需输入同步码');

  page.once('dialog', (d) => d.accept());
  await backup.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '登录 / 注册' }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('bt-lesson-libraries') || '[]').length), 0);
  await login(page);
  await page.getByRole('button', { name: '我的账号' }).click();
  await backup.locator('summary', { hasText: '修改密码' }).click();
  await backup.getByLabel('当前密码').fill(password);
  await backup.getByLabel('新密码', { exact: true }).fill('updated-pass-123');
  await backup.getByRole('button', { name: '保存新密码' }).click();
  await backup.waitFor({ state: 'detached' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('bt-lesson-libraries') || '[]').length > 0);
  console.log('PASS 桌面：退出隐藏私人数据，再登录恢复；修改密码不丢数据');

  await page.getByRole('button', { name: '我的账号' }).click();
  await backup.getByRole('button', { name: '立即同步' }).click();
  await backup.getByText('同步完成，学习数据已保存到账号').waitFor();
  await backup.getByRole('button', { name: '关闭', exact: true }).first().click();
  await page.locator('.lib-tab').filter({ hasText: '迁移课文库' }).click();
  const editButton = page.getByRole('button', { name: '编辑这节课' }).first();
  if (!(await editButton.isVisible())) await page.getByText('旧分组', { exact: true }).click();
  await editButton.click();
  const editor = page.getByRole('dialog', { name: '编辑课文', exact: true });
  await editor.getByLabel('标题（中文）', { exact: true }).fill('增量修改后的标题');
  const saved = page.waitForResponse((r) => r.url() === base + '/api/account-data/delta' && r.request().method() === 'POST' && r.status() === 200);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  const response = await saved;
  const upload = response.request().postData();
  assert.ok(Buffer.byteLength(upload) < 2048, '改标题只上传增量，不重传大课文');
  assert.equal(upload.includes('Legacy English reference.'), false);
  assert.ok(Buffer.byteLength(await response.text()) < 2048);
  const token = await page.evaluate(() => localStorage.getItem('bt-acct-token'));
  const stored = await (await fetch(base + '/api/account-data', { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(stored.data.libraries[0].lessons[0].title_cn, '增量修改后的标题');
  assert.equal(stored.data.libraries[0].lessons[0].english, fixture.libraries[0].lessons[0].english);
  console.log('PASS 桌面真实编辑课文：上传与返回均小于 2KB，未重传课文正文');

  for (const name of ['Pixel 7', 'iPhone 13']) {
    const context = await browser.newContext(devices[name]);
    const mobile = await context.newPage();
    await mobile.goto(base);
    const mobileSkip = mobile.getByRole('button', { name: '先随便看看，不选' });
    if (await mobileSkip.isVisible()) await mobileSkip.click();
    const close = mobile.getByRole('button', { name: '收起侧栏' });
    if (await close.isVisible()) await close.click();
    await login(mobile, 'updated-pass-123');
    assert.equal(await mobile.evaluate(() => JSON.parse(localStorage.getItem('bt-lesson-libraries'))[0].lessons[0].title_cn), '增量修改后的标题');
    await mobile.getByRole('button', { name: '我的账号' }).click();
    await mobile.getByRole('dialog', { name: '备份与恢复' }).getByText('账号云同步').waitFor();
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' no horizontal overflow');
    console.log(`PASS ${name}：新设备只凭账号密码恢复数据，账号管理没有横向溢出`);
    await context.close();
  }
} finally {
  await browser?.close(); server.kill();
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}
