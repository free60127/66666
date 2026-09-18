/**
 * 作业解析的流式协议 + 两端折叠一致性测试。
 *
 * 两件事必须钉住：
 *  1. **解析容错**：流式输入是被切碎的模型输出（断在半个 JSON 中间、夹说明文字、围栏、
 *     末尾少换行），解析器一旦抛错，整次生成就白花钱；
 *  2. **两端一致**：服务端折叠（server/analyzeStream.mjs）与浏览器折叠（src/resultFold.js）
 *     是同构的两份实现 —— 只要漂移，"边生成边看到的"就会和"存进历史的"不是同一个东西，
 *     而这种不一致只有用户回头看历史时才会发现。这里用同一批段交叉断言。
 *
 * 跑法：node server/analyzeStream.test.mjs
 */
import { createResultReader, finalizeResult, foldSegments as serverFold, SEGMENT_LABEL } from './analyzeStream.mjs';
import { foldSegments as clientFold } from '../src/resultFold.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const J = (o) => JSON.stringify(o);
const SEGS = [
  { t: 'meta', title: 'Lesson 18', chinese: '中文提示', draft: 'my draft', original: 'the original' },
  { t: 'ai', ai: 'Polished paragraph.' },
  { t: 'overall', overall: { score: 86, issues: 2, summary: '整体不错', highlights: ['时态准确'], advice: ['复习 search for'] } },
  { t: 'sentence', item: { cn: '第一句', draft: 'd1', ai: 'a1', findings: [{ category: '词义', from: 'x', to: 'y', level: 'error', explanation: 'e' }] } },
  { t: 'sentence', item: { cn: '第二句', draft: 'd2', ai: 'a2', findings: [] } },
  { t: 'vocab', item: { word: 'spoil', phonetic: '/spɔɪl/', meaning: '破坏' } },
  { t: 'idiom', item: { situation: '突然', common: 'suddenly', idiom: 'out of the blue' } },
  { t: 'advanced', item: 'Not until… · 中文点拨：倒装' },
  { t: 'bonus', item: 'at the mercy of · 中文说明：任凭…摆布' },
  { t: 'done' },
];

console.log('=== 作业解析流式协议测试 ===\n');

/* ---------- 1. 基本：一行一段，落位有序 ---------- */
{
  const r = createResultReader();
  const got = r.feed(SEGS.map(J).join('\n') + '\n');
  check('十行 → 十段，顺序不乱', got.length === SEGS.length && got.every((s, i) => s.t === SEGS[i].t), got.map((s) => s.t).join(','));
  check('段自带递增序号（重连重放时按序号落位，不会折出重复内容）', got.every((s, i) => s.__i === i), got.map((s) => s.__i).join(','));
}

/* ---------- 2. 断在半个 JSON 中间 ---------- */
{
  const r = createResultReader();
  const one = J(SEGS[3]);
  const cut = Math.floor(one.length / 2);
  check('半个 JSON：不吐也不炸', r.feed(one.slice(0, cut)).length === 0);
  check('残行留在缓冲里', r.leftover === one.slice(0, cut));
  const done = r.feed(one.slice(cut) + '\n' + J(SEGS[9]).slice(0, 4));
  check('补齐后立刻吐出这一段', done.length === 1 && done[0].t === 'sentence');
}

/* ---------- 3. 脏输出与未知段 ---------- */
{
  const r = createResultReader();
  const got = r.feed(['```json', '好的，下面开始分析：', '{坏 json', J({ t: '量子纠缠', a: 1 }), J(SEGS[1])].join('\n') + '\n');
  check('围栏 / 说明 / 坏 JSON / 认不出的段全部跳过，好段照收', got.length === 1 && got[0].t === 'ai' && r.stats.bad === 4, `bad=${r.stats.bad}`);
}

/* ---------- 4. 末尾没换行 ---------- */
{
  const r = createResultReader();
  check('未换行的尾段在 feed 阶段不吐', r.feed(J(SEGS[9])).length === 0);
  const tail = r.flush();
  check('flush 时收下尾段', tail.length === 1 && tail[0].t === 'done');
  check('flush 之后不重复吐', r.flush().length === 0);
}

/* ---------- 5. ★ 两端折叠必须一致 ---------- */
{
  const a = serverFold(SEGS);
  const b = clientFold(SEGS);
  check('★ 服务端折叠与浏览器折叠结果逐字节一致', J(a) === J(b), J(a) === J(b) ? '' : `server=${J(a).slice(0, 80)} client=${J(b).slice(0, 80)}`);
  check('元信息 / 润色段落 / 整体评价都搬到位', a.title === 'Lesson 18' && a.ai === 'Polished paragraph.' && a.overall.score === 86);
  check('逐句按顺序累积（2 句）', a.sentences.length === 2 && a.sentences[0].cn === '第一句' && a.sentences[1].cn === '第二句');
  check('词汇 / 习语 / 句式 / 加分表达各归各位', a.vocabularyNotes.length === 1 && a.idiomHighlights.length === 1 && a.advancedSentences.length === 1 && a.bonusExpressions.length === 1);
  check('done 段不会混进任何数组', !J(a).includes('"done"'));
}

/* ---------- 6. 乱序到达 / 重复到达（断线重连重放） ---------- */
{
  const shuffled = [SEGS[4], SEGS[3], SEGS[3], SEGS[0], SEGS[5]].map((s, i) => ({ ...s, __i: [4, 3, 3, 0, 5][i] }));
  const a = serverFold(shuffled);
  const b = clientFold(shuffled);
  check('按 __i 排序折叠：乱序到达也是对的顺序', a.sentences.length === 2 && a.sentences[0].cn === '第一句', a.sentences.map((s) => s.cn).join(','));
  check('乱序时两端同样一致', J(a) === J(b));
}

/* ---------- 7. finalizeResult：流式优先，整段 JSON 兜底 ---------- */
{
  const parseLoose = (t) => JSON.parse(String(t).replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
  const streamed = finalizeResult({ segments: SEGS, rawText: 'whatever', parseLoose });
  check('有段时用它（mode=stream）', streamed.mode === 'stream' && streamed.parsed.sentences.length === 2);

  const onlyMeta = finalizeResult({ segments: [{ t: 'meta', title: 't' }], rawText: J({ sentences: [{ cn: 'x' }] }), parseLoose });
  check('只有 meta 回显不算结果 → 退回整段 JSON', onlyMeta.mode === 'fallback' && onlyMeta.parsed.sentences.length === 1, JSON.stringify(onlyMeta.mode));

  const empty = finalizeResult({ segments: [], rawText: '模型今天不想说话', parseLoose });
  check('彻底没有结果时 mode=empty（调用方据此报错）', empty.mode === 'empty' && empty.parsed === null);
}

/* ---------- 8. 坏输入不炸 ---------- */
{
  const r = createResultReader();
  check('null / 数字 / 非字符串都不炸', r.feed(null).length === 0 && r.feed(42).length === 0 && r.feed(undefined).length === 0);
  check('foldSegments 坏输入返回空壳', serverFold(null).sentences.length === 0 && clientFold(undefined).vocabularyNotes.length === 0);
  check('段标签表覆盖所有段类型', SEGS.every((s) => SEGMENT_LABEL[s.t]), Object.keys(SEGMENT_LABEL).join(','));
}

const failed = results.filter((x) => !x.ok);
console.log('\n' + '='.repeat(62));
console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
if (failed.length) {
  for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? '  — ' + f.detail : ''));
  process.exitCode = 1;
}
