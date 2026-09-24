/** 教师端端到端：独立临时存储 + 本地假模型，不碰真实账号或 AI 额度。 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, devices } from './shotter/node_modules/playwright/index.mjs';

const port = 8996;
const modelPort = 8997;
const base = `http://127.0.0.1:${port}/`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-teacher-'));
const model = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    title: '测试练习',
    overall: { score: 88, issues: 1, summary: '表达清楚', highlights: ['结构完整'], advice: ['注意搭配'] },
    sentences: [{ cn: '我今天读书。', draft: 'I read a book today.', ai: 'I read a book today.', original: 'I read a book today.', findings: [] }],
  }) } }] }));
});
await new Promise((resolve) => model.listen(modelPort, '127.0.0.1', resolve));
const server = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dir, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', AI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, AI_API_KEY: 'mock-teacher', ALLOW_PRIVATE_BASE_URL: '1' },
  stdio: 'ignore',
});
let browser;
try {
  for (let n = 0; n < 60; n += 1) {
    try { if ((await fetch(base + 'api/health')).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const allowed = await fetch(base + 'api/auth/config', { headers: { Origin: 'https://free60127.github.io' } });
  if (allowed.headers.get('access-control-allow-origin') !== 'https://free60127.github.io') throw new Error('GitHub Pages 来源未获得 API 跨域许可');
  const denied = await fetch(base + 'api/auth/config', { headers: { Origin: 'https://untrusted.example' } });
  if (denied.headers.has('access-control-allow-origin')) throw new Error('未知站点不应获得 API 跨域许可');
  console.log('PASS GitHub Pages 来源获准访问 API，未知站点仍被拒绝');
  browser = await chromium.launch();
  const teacherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const teacher = await teacherContext.newPage();
  await teacher.goto(base + 'teacher.html');
  await teacher.getByRole('button', { name: '没有账号？开放注册' }).click();
  await teacher.getByLabel('称呼').fill('测试教师');
  await teacher.getByLabel('邮箱').fill('teacher-qa@example.com');
  await teacher.getByLabel('密码').fill('teacher-pass-123');
  await teacher.getByRole('button', { name: '注册并进入' }).click();
  await teacher.getByLabel('新班级名称').fill('测试班级');
  await teacher.getByRole('button', { name: '建班' }).click();
  await teacher.getByRole('heading', { name: '测试班级' }).waitFor();
  const codeText = await teacher.locator('.teacher-class-head p').textContent();
  const code = codeText.match(/\d{6}/)?.[0];
  if (!code) throw new Error('教师页未生成邀请码');

  const studentContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const student = await studentContext.newPage();
  await student.goto(base);
  await student.locator('.more-btn').click();
  await student.getByRole('button', { name: '加入教师班级' }).click();
  await student.getByLabel('班级邀请码').fill(code);
  await student.getByLabel('姓名', { exact: true }).fill('小明');
  await student.getByLabel('学号').fill('301');
  await student.getByRole('button', { name: '加入班级', exact: true }).click();
  await student.getByText('已加入「测试班级」').waitFor();
  await student.getByRole('dialog', { name: '加入班级' }).getByRole('button', { name: '关闭' }).click();
  await student.locator('.modebar-seg[aria-label="练习模式"] button', { hasText: '自由模式' }).click();
  await student.locator('.topbar-title').fill('测试练习');
  await student.locator('.editor-grid .big-textarea').nth(0).fill('我今天读书。');
  await student.locator('.editor-grid .big-textarea').nth(1).fill('I read a book today.');
  await student.locator('.primary-btn.big').click();
  await student.locator('.result-sheet').waitFor({ timeout: 60000 });
  await teacher.getByRole('button', { name: '刷新成绩' }).click();
  await teacher.getByText('小明', { exact: true }).first().waitFor();
  await teacher.getByRole('link', { name: '88' }).waitFor({ timeout: 15000 });
  const link = await teacher.getByRole('link', { name: '88' }).getAttribute('href');
  if (!link.includes('#job=')) throw new Error('成绩未链接到分享结果页');
  const downloadPromise = teacher.waitForEvent('download');
  await teacher.getByRole('button', { name: '导出 CSV' }).click();
  const download = await downloadPromise;
  if (!download.suggestedFilename().endsWith('.csv')) throw new Error('CSV 导出失败');
  console.log('PASS 教师注册 → 建班 → 学生加入 → 完成练习自动上报 → 成绩链接 → CSV');

  const teacherState = await teacherContext.storageState();
  for (const [name, device] of [['安卓', devices['Pixel 7']], ['苹果尺寸', devices['iPhone 13']]]) {
    const context = await browser.newContext({ ...device, storageState: teacherState });
    const page = await context.newPage();
    await page.goto(base + 'teacher.html');
    await page.locator('.teacher-room').first().click();
    await page.getByRole('heading', { name: '测试班级' }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error(name + '教师班级页横向溢出');
    console.log('PASS ' + name + '触屏尺寸班级页无横向溢出');
    await context.close();
  }
  await studentContext.close();
  await teacherContext.close();
} finally {
  if (browser) await browser.close();
  server.kill();
  await new Promise((resolve) => model.close(resolve));
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir(), 'bts-teacher-'))) fs.rmSync(dir, { recursive: true, force: true });
}
