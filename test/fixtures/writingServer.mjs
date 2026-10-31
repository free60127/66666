/** Isolated local model and application for HTTP and browser writing regressions. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export const writingOverall = {
  score: 90, summary: '作文观点明确，论证可以进一步展开。', highlights: [], advice: ['补充具体例证。'], issues: 0,
  scoreBreakdown: [
    { label: '内容与任务', score: 26, max: 30, comment: '回应题目，可以增加例证。' },
    { label: '组织与衔接', score: 23, max: 25, comment: '段落清晰。' },
    { label: '词汇与表达', score: 23, max: 25, comment: '表达准确。' },
    { label: '语法与准确', score: 18, max: 20, comment: '语言基本准确。' },
  ],
};
export const writingModelEssay = 'An independent model essay answering the writing question.\n\nIts arguments are fully developed.';
/** 范文按功能的拆解：句子逐字取自 writingModelEssay；relatesTo=0 表示与学生句群无功能对应 */
export const writingModelBreakdown = [
  { function: '点题回应', sentence: 'An independent model essay answering the writing question.', note: '范文开篇直接回应题目任务。', relatesTo: 1 },
  { function: '收束全文', sentence: 'Its arguments are fully developed.', note: '结尾一句收束论证。', relatesTo: 0 },
];
/** 零锚重写补救调用的返回：与学生作文没有任何 ≥6 词的共享句子 */
export const writingRepairedEssay = 'Learning to prepare simple meals is a gateway skill for young adults stepping into university life. A student who can cook decides what to eat, how much to spend, and when to shop, and those small daily decisions gradually build real independence.\n\nBeyond nutrition, planning groceries teaches budgeting and self-restraint. Sharing the kitchen with roommates also turns cooking into a social ritual that strengthens friendships and eases the pressure of academic life.';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startWritingServer(port = 8956) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-writing-'));
  const requests = [];
  let mode = 'normal';
  const mock = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const system = body.messages[0].content;
      const user = body.messages[1].content;
      let content;
      if (system.includes('英语写作课老师')) {
        const requested = user.split('【学生选择的立场或分析角度】\n')[1]?.split('\n【角度要求结束】')[0];
        const angles = user.includes('题目配图描述')
          ? ['解释现状的合理性，再提出改善建议', '关注活动差异，分析影响因素', '从需求出发，提出社区服务建议']
          : ['肯定在线学习的灵活性，补充自律条件', '强调线下互动，主张混合式学习', '对比两种方式，按学习需求选择'];
        const selectedAngle = requested && !requested.startsWith('由你根据') ? requested : angles[0];
        const goals = ['引言：概括题目', '主体一：论点与例证', '主体二：补充论证', '结论：重申观点'];
        content = mode === 'bad-brief' ? {} : { stance: '明确题目任务，先概括材料，再表达观点。',
          selectedAngle, angles, outline: goals,
          paragraphs: ['intro', 'body1', 'body2', 'concl'].map((key, index) => ({ key, goal: goals[index], steps: [
            { idea: '围绕“' + selectedAngle + '”展开：' + goals[index], keywords: ['independent learning', 'practical benefits'], pattern: 'From my perspective, 【本段观点】 deserves careful consideration.' },
            { idea: '用材料中的具体例子说明，并与本段观点衔接。', keywords: ['for instance', 'learning experience'], pattern: 'For instance, 【材料中的具体例子】 illustrates this point.' },
          ] })),
          pitfalls: ['不要遗漏材料要求。'], patterns: [] };
      } else if (system.includes('请复核作文题目')) {
        content = writingOverall;
      } else if (system.includes('满分范文作者')) {
        // 零锚重写补救调用：只应看到题目与材料，不该看到学生作文
        content = { original: writingRepairedEssay };
      } else {
        const draft = user.split('【学生作文全文】\n')[1]?.split('\n【')[0] || 'Student essay.';
        const cloned = mode === 'cloned-essay';
        // cloned-essay 模式复现线上事故：范文逐字照抄学生草稿，赏析还自曝"与学生的句子相同"
        content = { title: '写作批改示例', chinese: 'Incorrect model echo', draft: 'Incorrect model echo',
          ai: draft, original: cloned ? draft : writingModelEssay, overall: mode === 'no-overall' ? {} : writingOverall,
          sentences: [{ cn: '学生表达了自己的观点。', draft, ai: draft, original: '', findings: [] }],
          modelBreakdown: cloned ? [
            { function: '点题回应', sentence: draft, note: '与学生的句子相同。', relatesTo: 1 },
          ] : writingModelBreakdown,
          vocabularyNotes: [], idiomHighlights: [], advancedSentences: [], bonusExpressions: [] };
      }
      if (body.stream && content.sentences) {
        const segments = [
          { t: 'meta', title: content.title, chinese: content.chinese, draft: content.draft, original: content.original },
          { t: 'ai', ai: content.ai }, ...content.sentences.map((item) => ({ t: 'sentence', item })),
          { t: 'overall', overall: content.overall },
          ...(content.modelBreakdown || []).map((item) => ({ t: 'breakdown', item })),
          { t: 'done' },
        ];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const segment of segments) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(segment) + '\n' } }] }) + '\n\n');
          await wait(15);
        }
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      }
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const app = spawn(process.execPath, ['server/index.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: String(port), DATA_DIR: dataDir, AI_API_KEY: 'writing-test-only', AI_MODEL: 'writing-test',
    AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
    ALLOW_PRIVATE_BASE_URL: '1', FREE_DAILY_IP: '10000', DAILY_SERVER_BUDGET: '10000', SMTP_TEST_MODE: '1',
  } });
  let logs = '';
  app.stdout.on('data', (s) => { logs += s; }); app.stderr.on('data', (s) => { logs += s; });
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (app.exitCode === null) { const exited = once(app, 'exit'); app.kill(); await exited; }
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
    if (!path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'bts-writing-')) throw new Error('Unexpected test data directory');
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  for (let i = 0; i < 80; i++) {
    if (app.exitCode !== null) { await stop(); throw new Error('Writing test server stopped: ' + logs); }
    try { if ((await fetch(origin + '/api/health')).ok) return { origin, requests, stop, setMode: (value) => { mode = value; } }; } catch { /* boot */ }
    await wait(100);
  }
  await stop(); throw new Error('Writing test server did not start: ' + logs);
}
