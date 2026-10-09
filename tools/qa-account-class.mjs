/** 本机真实浏览器回归：教师建班 → 深链入班 → 注册 → 换设备恢复 → 班级 Key。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from './shotter/node_modules/playwright/index.mjs';

const port = 8947;
const base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-account-qa-'));
const server = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dir,
    UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', AI_API_KEY: '' },
  stdio: 'ignore',
});
let browser;
const post = async (url, body, token = '') => {
  const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.ok, true, `${url}: ${JSON.stringify(data)}`);
  return data;
};
try {
  let ready = false;
  for (let i = 0; i < 50 && !ready; i += 1) {
    try { ready = (await fetch(base + '/api/health')).ok; } catch { /* starting */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(ready, true, 'local server started');
  const teacher = await post('/api/auth/teacher-register', { email: 'teacher-qa@example.com', password: 'testpass123', nickname: '测试老师' });
  const room = (await post('/api/classes', { name: '浏览器测试班' }, teacher.token)).class;
  browser = await chromium.launch();

  const desktop = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await desktop.newPage();
  await page.goto(`${base}/index.html#join=${room.inviteCode}`);
  await page.getByRole('dialog', { name: '账号' }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: '加入班级' }).count(), 0, '深链先显示登录');
  await page.getByRole('button', { name: '暂不登录，直接入班' }).click();
  const join = page.getByRole('dialog', { name: '加入班级' });
  await join.waitFor();
  assert.equal(await join.getByLabel('班级邀请码').inputValue(), room.inviteCode, '邀请码预填');
  await join.getByLabel('姓名').fill('测试学生');
  await join.getByLabel('学号').fill('QA001');
  await join.getByRole('button', { name: '加入班级' }).click();
  await join.getByText('已加入「浏览器测试班」').waitFor();
  await join.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await page.getByRole('button', { name: '注册新账号' }).click();
  await page.getByRole('dialog', { name: '账号' }).getByLabel('邮箱').fill('student-qa@example.com');
  await page.getByRole('dialog', { name: '账号' }).getByLabel('密码').fill('testpass123');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByRole('button', { name: '我的账号' }).waitFor();
  const studentToken = await page.evaluate(() => localStorage.getItem('bt-acct-token'));
  assert.ok(studentToken, '注册后保留会话');
  const memberReply = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + studentToken } }).then((response) => response.json());
  assert.equal(memberReply.classMembers[0].classId, room.id, '先入班后注册自动绑到账号');
  console.log('PASS 桌面：深链先登录/可跳过、入班预填、注册后自动绑定班级');

  const directContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const direct = await directContext.newPage();
  await direct.goto(`${base}/index.html#join=${room.inviteCode}`);
  await direct.getByRole('dialog', { name: '账号' }).waitFor();
  assert.equal(await direct.getByRole('dialog', { name: '加入班级' }).count(), 0);
  await direct.getByRole('button', { name: '注册新账号' }).click();
  await direct.getByRole('dialog', { name: '账号' }).getByLabel('邮箱').fill('second-student-qa@example.com');
  await direct.getByRole('dialog', { name: '账号' }).getByLabel('密码').fill('testpass123');
  await direct.getByRole('button', { name: '注册', exact: true }).click();
  await direct.getByRole('dialog', { name: '加入班级' }).waitFor();
  console.log('PASS 桌面：深链注册完成后自动续接入班');

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const mobile = await phone.newPage();
  await mobile.goto(base + '/');
  const goalSkip = mobile.getByRole('button', { name: '先随便看看，不选' });
  if (await goalSkip.isVisible()) await goalSkip.click();
  const sidebarClose = mobile.getByRole('button', { name: '收起侧栏' });
  if (await sidebarClose.isVisible()) await sidebarClose.click();
  await mobile.getByRole('button', { name: '登录 / 注册' }).click();
  await mobile.getByRole('dialog', { name: '账号' }).getByLabel('邮箱').fill('student-qa@example.com');
  await mobile.getByRole('dialog', { name: '账号' }).getByLabel('密码').fill('testpass123');
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await mobile.getByRole('button', { name: '我的账号' }).waitFor();
  await mobile.getByRole('button', { name: '更多' }).click();
  await mobile.getByRole('button', { name: '加入教师班级' }).click();
  await mobile.getByRole('dialog', { name: '加入班级' }).getByText('浏览器测试班 · 测试学生').waitFor();
  console.log('PASS 手机：登录后自动恢复班级身份，无需重输邀请码');

  const teacherContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await teacherContext.addInitScript(({ token, user }) => {
    localStorage.setItem('bt-acct-token', token);
    localStorage.setItem('bt-acct-user', JSON.stringify(user));
  }, { token: teacher.token, user: teacher.user });
  const teacherPage = await teacherContext.newPage();
  await teacherPage.goto(base + '/teacher.html');
  await teacherPage.getByRole('button', { name: /浏览器测试班/ }).click();
  await teacherPage.getByRole('button', { name: '配置班级 AI Key' }).click();
  await teacherPage.getByLabel('DeepSeek API Key').fill('sk-browser-qa');
  await teacherPage.getByRole('button', { name: '保存 Key' }).click();
  await teacherPage.getByRole('button', { name: '班级 AI Key：已配置' }).waitFor();
  const dashboard = await post(`/api/classes/${room.id}/student-dashboard`, { studentKey: memberReply.classMembers[0].studentKey });
  assert.equal(dashboard.hasClassKey, true);
  assert.equal(JSON.stringify(dashboard).includes('sk-browser-qa'), false, '密钥不下发学生端');
  await mobile.reload();
  await mobile.getByText('班级 AI 已配置').waitFor();
  console.log('PASS 班级 AI Key：学生端识别已配置状态且不返回密钥');

  await mobile.getByRole('button', { name: '更多' }).click();
  await mobile.getByRole('button', { name: '加入教师班级' }).click();
  mobile.once('dialog', (dialog) => dialog.accept());
  await mobile.getByRole('dialog', { name: '加入班级' }).getByRole('button', { name: '退出', exact: true }).click();
  await mobile.getByRole('dialog', { name: '加入班级' }).getByText('浏览器测试班 · 测试学生').waitFor({ state: 'detached' });
  const afterLeave = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + studentToken } }).then((response) => response.json());
  assert.equal(afterLeave.classMembers.length, 0, '退出班级同时解绑账号');
  console.log('PASS 手机：退出班级同步解绑账号，不会在下次登录时复活');

  // 同一浏览器切换账号：旧账号的本地班级不能误绑给新账号。
  const secondAccount = await direct.evaluate(() => ({ token: localStorage.getItem('bt-acct-token'), user: localStorage.getItem('bt-acct-user') }));
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('bt-acct-token', token);
    localStorage.setItem('bt-acct-user', user);
  }, secondAccount);
  await page.reload();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('bts-class-memberships') || '[]').length === 0);
  const secondMe = await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + secondAccount.token } }).then((response) => response.json());
  assert.equal(secondMe.classMembers.length, 0, '新账号不能继承前一人的班级');
  console.log('PASS 共用设备：切换账号后不把上一人的班级误绑到新账号');
} finally {
  await browser?.close();
  server.kill();
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}
