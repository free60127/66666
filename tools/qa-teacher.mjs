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
    title: '测试练习 · 自我介绍 (Hello, I am a college student from Liaoning Province and I want to improve my English.)',
    overall: { score: 88, issues: 1, summary: '表达清楚', highlights: ['结构完整'], advice: ['注意搭配'] },
    sentences: [{ cn: '我今天读书。', draft: 'I read a book today.', ai: 'I read a book today.', original: 'I read a book today.', findings: [{ level: 'error', category: '搭配', from: 'read a book', to: 'read books', explanation: '根据语境选择表达。' }] }],
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
  await teacher.getByRole('tab', { name: '共享课文' }).click();
  await teacher.getByLabel('课文标题').fill('班级共读');
  await teacher.getByLabel('中文提示').fill('我今天读书。');
  await teacher.getByLabel('英文原文').fill('I read a book today.');
  await teacher.getByRole('button', { name: '加入共享库' }).click();
  await teacher.getByText('班级共读').first().waitFor();
  await teacher.getByRole('tab', { name: '作业' }).click();
  await teacher.getByLabel('作业标题').fill('今日作业');
  await teacher.getByLabel('中文提示').fill('我今天读书。');
  await teacher.getByRole('button', { name: '发布作业' }).click();
  await teacher.getByText('今日作业').first().waitFor();

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
  await student.getByText('班级共读').waitFor();
  const studentState = await studentContext.storageState();
  for (const [name, device] of [['安卓', devices['Pixel 7']], ['苹果尺寸', devices['iPhone 13']]]) {
    const mobileContext = await browser.newContext({ ...device, storageState: studentState });
    const mobile = await mobileContext.newPage();
    await mobile.goto(base);
    await mobile.getByRole('dialog', { name: '待完成的班级作业' }).waitFor();
    if (await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error(name + '作业提醒横向溢出');
    await mobileContext.close();
  }
  await student.reload();
  await student.getByRole('dialog', { name: '待完成的班级作业' }).waitFor();
  await student.getByText('今日作业').first().waitFor();
  await student.getByRole('button', { name: '开始作业' }).click();
  if ((await student.locator('.topbar-title').inputValue()) !== '今日作业') throw new Error('作业内容未载入编辑器');
  await student.locator('.editor-grid .big-textarea').nth(1).fill('I read a book today.');
  await student.locator('.primary-btn.big').click();
  await student.locator('.result-sheet').waitFor({ timeout: 60000 });
  await teacher.getByRole('button', { name: '刷新数据' }).click();
  await teacher.getByRole('tab', { name: '成绩' }).click();
  await teacher.getByText('小明', { exact: true }).first().waitFor();
  await teacher.getByRole('link', { name: '88' }).waitFor({ timeout: 15000 });
  const link = await teacher.getByRole('link', { name: '88' }).getAttribute('href');
  if (!link.includes('#job=')) throw new Error('成绩未链接到分享结果页');
  const downloadPromise = teacher.waitForEvent('download');
  await teacher.getByRole('button', { name: '导出 CSV' }).click();
  const download = await downloadPromise;
  if (!download.suggestedFilename().endsWith('.csv')) throw new Error('CSV 导出失败');
  await teacher.getByRole('button', { name: '写评语' }).click();
  await teacher.getByPlaceholder('写给学生的具体建议').fill('老师建议：继续练习搭配。');
  await teacher.getByRole('button', { name: '保存评语' }).click();
  await teacher.getByText('教师评语已保存').waitFor();
  await student.bringToFront();
  await student.evaluate(() => window.dispatchEvent(new Event('focus')));
  await student.getByText('老师建议：继续练习搭配。').waitFor({ timeout: 15000 });
  await student.reload();
  await student.getByText('老师建议：继续练习搭配。').waitFor({ timeout: 15000 });
  if (await student.getByRole('dialog', { name: '待完成的班级作业' }).isVisible()) throw new Error('已交作业仍反复提醒');
  await student.locator('.more-btn').click();
  await student.getByRole('button', { name: '加入教师班级' }).click();
  await student.getByRole('heading', { name: '教师评语（1）' }).waitFor();
  await student.getByRole('link', { name: '查看完整批改' }).waitFor();
  await student.getByRole('button', { name: '关闭', exact: true }).click();
  await teacher.getByRole('tab', { name: '作业' }).click();
  await teacher.getByText('1/1 已交').waitFor();
  await teacher.getByLabel('内容来源').selectOption('builtin');
  await teacher.getByLabel('课文库').locator('option[value="10"]').waitFor({ state: 'attached' });
  const lessonOptions = await teacher.getByLabel('选择课文').locator('option').allTextContents();
  if (!lessonOptions.some((option) => /第 \d+ 课 · .+/.test(option))) throw new Error('内置课文下拉框没有标题');
  await teacher.getByLabel('内容来源').selectOption('free');
  await teacher.getByLabel('作业标题').fill('第二份作业');
  await teacher.getByLabel('中文提示').fill('我今天读书。');
  await teacher.getByRole('button', { name: '发布作业' }).click();
  await teacher.getByText('第二份作业').first().waitFor();
  await student.reload();
  await student.getByRole('dialog', { name: '待完成的班级作业' }).waitFor();
  await student.getByText('第二份作业').first().waitFor();
  await student.getByRole('button', { name: '稍后再做' }).click();
  await student.reload();
  await student.getByRole('dialog', { name: '待完成的班级作业' }).waitFor();
  await teacher.getByRole('tab', { name: '错题统计' }).click();
  await teacher.getByText('搭配').first().waitFor();
  console.log('PASS 教师注册 → 建班 → 作业进站提醒 → 学生提交 → 评语回显 → 内置课文标题 → CSV');

  const colleagueContext = await browser.newContext();
  const colleague = await colleagueContext.newPage();
  await colleague.goto(base + 'teacher.html');
  await colleague.getByRole('button', { name: '没有账号？开放注册' }).click();
  await colleague.getByLabel('称呼').fill('协作教师');
  await colleague.getByLabel('邮箱').fill('colleague-qa@example.com');
  await colleague.getByLabel('密码').fill('teacher-pass-123');
  await colleague.getByRole('button', { name: '注册并进入' }).click();
  await colleague.getByRole('heading', { name: '我的班级' }).waitFor();
  await teacher.getByRole('tab', { name: '协作教师' }).click();
  await teacher.getByLabel('协作教师邮箱').fill('colleague-qa@example.com');
  await teacher.getByRole('button', { name: '添加' }).click();
  await teacher.getByText('colleague-qa@example.com').waitFor();
  await colleague.reload();
  await colleague.locator('.teacher-room').first().waitFor();
  console.log('PASS 班级创建者添加协作教师，对方可看到共享班级');

  const teacherState = await teacherContext.storageState();
  await teacher.getByRole('tab', { name: '成绩' }).click();
  if (await teacher.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error('桌面成绩页横向溢出');
  for (const [name, device] of [['安卓', devices['Pixel 7']], ['苹果尺寸', devices['iPhone 13']]]) {
    const context = await browser.newContext({ ...device, storageState: teacherState });
    const page = await context.newPage();
    await page.goto(base + 'teacher.html');
    await page.locator('.teacher-room').first().click();
    await page.getByRole('heading', { name: '测试班级' }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error(name + '教师班级页横向溢出');
    const tableScroll = await page.locator('.teacher-scroll').first().evaluate((el) => el.scrollWidth > el.clientWidth);
    if (!tableScroll) throw new Error(name + '成绩表未在卡片内部滚动');
    await page.getByRole('tab', { name: '作业' }).click();
    await page.getByLabel('内容来源').selectOption('builtin');
    await page.getByLabel('选择课文').locator('option').nth(1).waitFor({ state: 'attached' });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error(name + '布置作业表单横向溢出');
    console.log('PASS ' + name + '触屏尺寸班级页无横向溢出');
    await context.close();
  }
  await studentContext.close();
  await colleagueContext.close();
  await teacherContext.close();
} finally {
  if (browser) await browser.close();
  server.kill();
  await new Promise((resolve) => model.close(resolve));
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir(), 'bts-teacher-'))) fs.rmSync(dir, { recursive: true, force: true });
}
