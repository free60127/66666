import assert from 'node:assert/strict';
import { startWritingServer, writingModelBreakdown, writingModelEssay, writingRepairedEssay, writingOverall } from '../test/fixtures/writingServer.mjs';

const app = await startWritingServer();
const post = async (kind, payload) => {
  const response = await fetch(app.origin + '/api/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { ...await response.json(), httpStatus: response.status };
};
async function submit(kind, payload, errorExpected = false) {
  const created = await post(kind, payload);
  assert.equal(created.httpStatus, 200);
  for (let i = 0; i < 80; i++) {
    const { job } = await (await fetch(app.origin + '/api/' + kind + '/' + created.jobId)).json();
    if (job.status === 'done' || job.status === 'error') {
      assert.equal(job.status, errorExpected ? 'error' : 'done', job.error);
      return { job, created };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Writing job did not finish');
}
const input = { direction: 'writing', title: '写作练习', chinese: 'Summarize the reading and discuss learning to cook.',
  draft: 'Students should learn to cook because it helps them live independently and choose healthy meals. This practical skill also allows them to save money.',
  material: 'The reading explains how cooking develops independence.', imageDesc: 'The chart shows that 60% of students cook at home.',
  targetWords: 300, book: 2, lessonId: 18, level: '专八', writingTopic: { parentJobId: 'previous-job', rootJobId: 'first-job', sourceTopicKey: 'writing:task-a', taskType: 'material' } };
try {
  const invalid = await post('analyze', { direction: 'writing', chinese: 'Question' });
  assert.equal(invalid.httpStatus, 400); assert.match(invalid.error, /作文/);
  assert.equal((await post('writing-brief', {})).httpStatus, 400);
  assert.equal(app.requests.length, 0, 'invalid input never reaches the model');
  console.log('PASS 写作空输入在调用模型前被拒绝');

  const first = await submit('analyze', input);
  assert.equal(first.job.data.direction, 'writing');
  assert.equal(first.job.data.chinese, input.chinese); assert.equal(first.job.data.draft, input.draft);
  assert.equal(first.job.data.original, writingModelEssay);
  assert.equal(first.job.data.material, input.material); assert.equal(first.job.data.imageDesc, input.imageDesc);
  assert.equal(first.job.data.targetWords, 300);
  assert.deepEqual(first.job.data.writingTopic, input.writingTopic, 'revision references survive a shared report read');
  assert.deepEqual(first.job.data.meta, { book: null, lessonId: null });
  assert.deepEqual(first.job.data.overall.scoreBreakdown, writingOverall.scoreBreakdown);
  assert.deepEqual(first.job.data.modelBreakdown, writingModelBreakdown.map(({ function: fn, ...rest }) => ({ fn, ...rest })),
    'breakdown entries normalize function→fn and survive a shared read');
  assert.equal(first.job.deleteToken, undefined, 'shared reads do not disclose delete credentials');
  assert.equal(app.requests.length, 1, 'writing does not run translation semantic reviews');
  assert.match(app.requests[0].messages[1].content, /The reading explains/);
  assert.match(app.requests[0].messages[1].content, /60%/);
  console.log('PASS 写作批改保留题目、材料、配图说明、四维评分、AI 范文与范文赏析，不串课文语料');

  const streamed = await submit('analyze', { ...input, stream: true });
  assert.deepEqual(streamed.job.data, first.job.data);
  console.log('PASS NDJSON 流式批改与非流式最终结果一致');

  app.setMode('no-overall');
  const repaired = await submit('analyze', input);
  assert.equal(repaired.job.data.overall.score, 90);
  const repair = app.requests.at(-1);
  assert.match(repair.messages[0].content, /写作教练/);
  assert.match(repair.messages[1].content, /The reading explains/);
  assert.match(repair.messages[1].content, /60%/);
  assert.match(repair.messages[1].content, /300/);
  assert.doesNotMatch(repair.messages[1].content, /完整中文提示/);
  console.log('PASS 作文没有语言错误但漏写评分时，仍能带完整审题依据补救评分');

  app.setMode('normal');
  const brief = await submit('writing-brief', { topic: input.chinese, material: input.material, imageDesc: input.imageDesc, level: '专八' });
  assert.equal(brief.job.data.outline.length, 4); assert.ok(brief.job.data.stance);
  assert.match(app.requests.at(-1).messages[1].content, /The reading explains/);
  assert.equal(brief.job.data.paragraphs.length, 4);
  assert.ok(brief.job.data.paragraphs.every((paragraph) => paragraph.steps.length === 2 && paragraph.steps[0].pattern));
  const selectedAngle = '以学生需求为出发点，主张混合式学习';
  const switched = await submit('writing-brief', { topic: input.chinese, material: input.material, imageDesc: input.imageDesc, angle: selectedAngle, targetWords: 300 });
  assert.equal(switched.job.data.selectedAngle, selectedAngle);
  assert.ok(switched.job.data.paragraphs.every((paragraph) => paragraph.steps[0].idea.includes(selectedAngle)));
  assert.ok(app.requests.at(-1).messages[1].content.includes(selectedAngle));
  assert.match(app.requests.at(-1).messages[1].content, /建议词数：300/);
  assert.match(app.requests.at(-1).messages[0].content, /纯客观图表题不添加/);
  console.log('PASS 切换立场带入模型请求，并返回四段独立思路、关键词和参考句式');
  const wrongKind = await fetch(app.origin + '/api/writing-brief/' + first.created.jobId);
  assert.equal(wrongKind.status, 404);
  app.setMode('bad-brief');
  const failed = await submit('writing-brief', { topic: 'Question' }, true);
  assert.match(failed.job.error, /不完整/);
  console.log('PASS 写作指导支持完整材料，拒绝跨类型任务和空模型响应');

  /* ---------- 范文克隆检测与零锚重写 ----------
   * 线上事故：模型逐句读完学生作文再写"独立范文"，结果 6 句抄 5 句，
   * 赏析笔记自己写着"与学生的句子相同"。fixture 的 cloned-essay 模式复现该形状。 */
  app.setMode('cloned-essay');
  const requestsBeforeClone = app.requests.length;
  const cloned = await submit('analyze', input);
  assert.equal(app.requests.length - requestsBeforeClone, 2, '克隆检测触发恰好一次补救请求');
  const repairReq = app.requests.at(-1);
  assert.match(repairReq.messages[0].content, /满分范文作者/);
  assert.doesNotMatch(repairReq.messages[1].content, /live independently/, '零锚：补救请求不得包含学生作文任何片段');
  assert.match(repairReq.messages[1].content, /The reading explains/);
  assert.match(repairReq.messages[1].content, /60%/);
  assert.match(repairReq.messages[1].content, /300/);
  assert.equal(cloned.job.data.original, writingRepairedEssay);
  assert.deepEqual(cloned.job.data.modelBreakdown, [], '旧赏析对不上新范文，随之清空');
  console.log('PASS 范文照抄学生作文时自动零锚重写：补救请求不含学生文本，赏析随之清空');
} finally { await app.stop(); }
