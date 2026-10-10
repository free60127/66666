/** Verification-enabled teacher/student registration UI, no actual email sent. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, devices } from './shotter/node_modules/playwright/index.mjs';
import { createFileKv } from '../server/kv.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-verify-ui-'));
const kv = createFileKv(path.join(dir, 'kv'));
const base = 'http://127.0.0.1:8949';
const server = spawn(process.execPath, ['server/index.mjs'], { stdio: 'ignore', env: { ...process.env,
  PORT: '8949', DATA_DIR: dir, EMAIL_VERIFY: '1', SMTP_TEST_MODE: '1',
  UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', AI_API_KEY: '',
} });
let browser;
const setCode = (email) => kv.set('bts:acct:verify:' + email, JSON.stringify({
  h: createHash('sha256').update('123456').digest('hex'), at: Date.now(),
}), 900);
try {
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    try { ready = (await fetch(base + '/api/health')).ok; } catch { /* starting */ }
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready);
  browser = await chromium.launch();
  const teacherPage = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await teacherPage.goto(base + '/teacher.html');
  await teacherPage.getByRole('button', { name: '没有账号？开放注册' }).click();
  await teacherPage.getByLabel('称呼').fill('验证老师');
  await teacherPage.getByLabel('邮箱', { exact: true }).fill('teacher-verify@example.com');
  await teacherPage.getByLabel('密码', { exact: true }).fill('teacher-pass-123');
  const sent = teacherPage.waitForResponse((r) => r.url().endsWith('/api/auth/verify-email'));
  await teacherPage.getByRole('button', { name: '获取注册验证码' }).click();
  assert.equal((await sent).status(), 200);
  await teacherPage.getByText(/验证码已发送/).waitFor();
  await setCode('teacher-verify@example.com');
  await teacherPage.getByLabel('邮箱验证码').fill('123456');
  await teacherPage.getByRole('button', { name: '注册并进入' }).click();
  await teacherPage.getByText('我的班级', { exact: true }).waitFor();
  assert.equal(await kv.get('bts:acct:verify:teacher-verify@example.com'), null);
  console.log('PASS 教师验证注册：发送验证码路由 → 输入验证码 → 创建账号 → 验证码销毁');

  const mobile = await browser.newContext(devices['Pixel 7']);
  await mobile.addInitScript(() => localStorage.setItem('bt-goal', 'cet'));
  const page = await mobile.newPage();
  await page.goto(base + '/index.html#join=123456');
  const dialog = page.getByRole('dialog', { name: '账号' });
  await dialog.getByRole('button', { name: '注册新账号' }).click();
  await dialog.getByLabel('邮箱', { exact: true }).fill('student-verify@example.com');
  await dialog.getByLabel('密码', { exact: true }).fill('student-pass-123');
  await dialog.getByLabel('昵称').fill('验证学生');
  const studentSent = page.waitForResponse((r) => r.url().endsWith('/api/auth/verify-email'));
  await dialog.getByRole('button', { name: '发送验证码' }).click();
  assert.equal((await studentSent).status(), 200);
  await setCode('student-verify@example.com');
  await dialog.getByLabel('邮箱验证码').fill('123456');
  await dialog.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByRole('dialog', { name: '加入班级' }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('bt-acct-user')).email), 'student-verify@example.com');
  console.log('PASS 手机学生验证注册：发送验证码 → 注册 → 自动续接入班深链');
} finally {
  await browser?.close();
  const exited = server.exitCode === null ? new Promise((r) => server.once('exit', r)) : Promise.resolve();
  server.kill(); await exited;
  fs.rmSync(dir, { recursive: true, force: true });
}
