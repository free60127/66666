/** User journeys against the real local app and a deterministic model; never uses a paid API. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from './shotter/node_modules/playwright/index.mjs';
import { startWritingServer } from '../test/fixtures/writingServer.mjs';

const app = await startWritingServer(8977);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const out = 'tmp/learning-flow'; fs.mkdirSync(out, { recursive: true });
const essay = 'Dear John, I am writing to invite you to our school event next Friday. We will discuss the benefits of reading and share our favourite books. Please let me know if you can come. Yours, Li Ming.';
await context.addInitScript(({ essay }) => {
  if (localStorage.getItem('learning-test-init')) return;
  localStorage.setItem('learning-test-init', '1');
  localStorage.setItem('bt-goal', 'skip'); localStorage.setItem('bt-guide-done', '1');
  localStorage.setItem('bt-writing-open', '1');
  localStorage.setItem('bt-writing-studio', JSON.stringify({ topic: { id: 'custom', question: 'Write an email inviting a friend to a school event in about 100 words.', zh: '邀请邮件', label: '自定义题目' }, essay }));
}, { essay });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', (dialog) => dialog.accept());
const home = () => page.getByRole('button', { name: '学习首页', exact: true }).click();
const continueCard = (text) => page.locator('.learning-home-cards article').filter({ hasText: text }).getByRole('button', { name: '继续学习', exact: true }).click();
try {
  await page.goto(app.origin);
  await page.getByRole('textbox', { name: '我的作文', exact: true }).waitFor();
  assert.equal(await page.getByLabel('写作题型', { exact: true }).inputValue(), 'letter');
  await page.getByRole('tab', { name: /按段带写/ }).click();
  await page.getByRole('textbox', { name: '称呼与来意', exact: true }).waitFor();
  assert.equal(app.requests.length, 0, 'routing and local guidance must not call AI');
  await page.getByRole('tab', { name: /直接开写/ }).click();
  await page.getByRole('textbox', { name: '我的作文', exact: true }).fill(essay + ' Last unsaved edit.');
  await home();
  await continueCard('继续写作');
  assert.equal(await page.getByRole('textbox', { name: '我的作文', exact: true }).inputValue(), essay + ' Last unsaved edit.');
  console.log('PASS 本地识别书信和字数，切到首页再继续保留最后输入，未调用 AI');

  await page.getByRole('button', { name: '提交批改', exact: true }).click();
  await page.locator('.result-sheet .score-row').first().waitFor({ timeout: 15000 });
  const firstJob = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-history'))[0].jobId);
  await page.getByRole('button', { name: '继续修改本篇' }).click();
  await page.getByRole('textbox', { name: '我的作文', exact: true }).fill(essay + ' We hope you will enjoy this experience.');
  await page.getByRole('button', { name: '提交批改', exact: true }).click();
  await page.getByRole('heading', { name: '原稿与修改稿对比', exact: true }).waitFor({ timeout: 15000 });
  assert.equal(app.requests.length, 2, 'comparison must reuse reports');
  await page.getByText('展开原稿与本次正文', { exact: true }).click();
  assert.ok((await page.locator('.pc-drafts').innerText()).includes('Last unsaved edit.'));
  const secondJob = await page.evaluate(() => JSON.parse(localStorage.getItem('bt-history'))[0].jobId);
  const saved = await (await fetch(app.origin + '/api/analyze/' + secondJob)).json();
  assert.equal(saved.job.data.writingTopic.parentJobId, firstJob);
  await page.reload();
  await page.getByRole('heading', { name: '原稿与修改稿对比', exact: true }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: out + '/revision-desktop.png', fullPage: true });
  console.log('PASS 原稿、修改稿在刷新后保持关联，已有报告对比不增加 AI 调用');

  // Simulate an already generated quiz, without calling the real generator or spending quota.
  await page.evaluate(() => {
    const quiz = { _sessionId: 'browser-quiz', title: '我的语法自测', questions: [{ type: '填空', question: 'I ___ a student.', answer: 'am', explanation: 'I 搭配 am。' }] };
    localStorage.setItem('bt-quiz-current', quiz._sessionId);
    localStorage.setItem('bt-quiz-session:' + quiz._sessionId, JSON.stringify({ quiz, answers: {}, verdicts: {}, savedAt: Date.now() }));
    localStorage.setItem('bt-favorites', JSON.stringify([{ id: 'recall-1', kind: 'finding', title: 'He go home. → He goes home.', body: '注意主谓一致', due: 1 }]));
  });
  await page.goto(app.origin); await page.getByRole('button', { name: '学习首页', exact: true }).waitFor();
  await home(); await continueCard('继续自测');
  await page.getByPlaceholder('填入空格处的内容…').fill('am');
  await home(); await continueCard('继续自测');
  assert.equal(await page.getByPlaceholder('填入空格处的内容…').inputValue(), 'am');
  await page.reload(); await home(); await continueCard('继续自测');
  assert.equal(await page.getByPlaceholder('填入空格处的内容…').inputValue(), 'am');
  await page.getByRole('button', { name: '核对', exact: true }).click();
  await home();
  await page.getByText('最近一次正确率', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('bt-lesson-progress'))['quiz:browser-quiz'].last), 100);
  assert.equal(app.requests.length, 2);
  console.log('PASS 自测离开与刷新恢复，完成后记录成绩摘要，无额外 AI 请求');

  await continueCard('复习今天到期');
  assert.equal(await page.locator('.fav-card').getByText('He goes home.', { exact: false }).count(), 0);
  await page.getByRole('button', { name: /显示答案/ }).click();
  await page.locator('.fav-card').getByText('He goes home.', { exact: false }).waitFor();
  await page.getByRole('button', { name: '退出复习', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 }); await home();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'mobile homepage must fit the viewport');
  await page.screenshot({ path: out + '/home-mobile.png', fullPage: true });
  console.log('PASS 旧收藏翻面前不泄露答案，手机学习首页无横向溢出');
  await page.getByLabel('学习重点', { exact: true }).selectOption('translation');
  await page.getByRole('button', { name: '进入翻译练习', exact: true }).click();
  await page.getByRole('group', { name: '练习方向', exact: true }).waitFor();
  assert.equal(await page.locator('.ws-essay').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS 首页进入原有翻译训练，写作/自测状态不串入翻译，浏览器无异常');
} catch (error) {
  await page.screenshot({ path: out + '/failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); await app.stop(); }
