/**
 * 批改流式协议测试（server/gradeStream.mjs）。
 *
 * 为什么值得测：流式解析的输入是**被切碎的模型输出** —— 断在半个 JSON 中间、
 * 夹一句"好的，下面开始批改"、围栏、末尾少一个换行，全是真实出现过的形态。
 * 解析器一旦抛错，整次批改就白花钱；而把题号认错，点评会贴到别的题上（学生根本看不出来）。
 *
 * ⚠️ 这个文件与 server/gradeSse.test.mjs 是**两个不同的文件**：一个只测纯解析
 * （无端口无进程、毫秒级），一个跑真链路（起服务 + SSE）。曾经这两个文件只差大小写
 * （gradeStream / gradestream），在 Windows 上被当成同一个文件覆盖掉了，
 * 而 CI（Linux，大小写敏感）按 package.json 点名字时找不到其中一个 —— 整条流水线直接红。
 * 所以命名上刻意让它们一眼能分清。
 *
 * 跑法：node server/gradeStream.test.mjs
 */
import { createGradeReader, finalizeGrades } from './gradeStream.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const line = (i, verdict = 'right', comment = 'c' + i, better = '') => JSON.stringify({ index: i, verdict, comment, better });

console.log('=== 批改流式协议（NDJSON）测试 ===\n');

/* ---------- 1. 正常：一行一道题 ---------- */
{
  const r = createGradeReader({ itemCount: 3 });
  const got = r.feed(line(0) + '\n' + line(1, 'close') + '\n' + line(2, 'wrong') + '\n');
  check('三行 → 三条判定，顺序不乱', got.length === 3 && got.map((g) => g.index).join(',') === '0,1,2', JSON.stringify(got.map((g) => g.index)));
  check('档位原样保留', got[1].verdict === 'close' && got[2].verdict === 'wrong');
  check('尾部残行不留下垃圾', r.leftover === '', JSON.stringify(r.leftover));
}

/* ---------- 2. 断在半个 JSON 中间（流式的主要形态） ---------- */
{
  const r = createGradeReader({ itemCount: 2 });
  const one = line(0);
  const cut = Math.floor(one.length / 2);
  const got1 = r.feed(one.slice(0, cut));
  check('半个 JSON：什么都不吐，也不报错', got1.length === 0);
  check('残行留在缓冲里等下一块', r.leftover === one.slice(0, cut), r.leftover.slice(0, 20));
  const got2 = r.feed(one.slice(cut) + '\n' + line(1).slice(0, 5));
  check('补齐后立刻吐出第 1 条', got2.length === 1 && got2[0].index === 0);
  const got3 = r.feed(line(1).slice(5) + '\n');
  check('第 2 条随后到齐', got3.length === 1 && got3[0].index === 1);
}

/* ---------- 3. 脏输出：围栏 / 说明文字 / 坏 JSON / 空行 ---------- */
{
  const r = createGradeReader({ itemCount: 2 });
  const got = r.feed(['```json', '好的，下面开始批改：', '', '{坏掉的 json', line(0), '```', line(1)].join('\n') + '\n');
  check('围栏、说明、坏行全部跳过，好行照收', got.length === 2 && r.stats.bad >= 3, `bad=${r.stats.bad}`);
}

/* ---------- 4. 题号：越界丢掉、重复先到先得 ---------- */
{
  const r = createGradeReader({ itemCount: 2 });
  const got = r.feed([line(9), line(-1), line(0, 'right', '第一次'), line(0, 'wrong', '第二次'), line(1)].join('\n') + '\n');
  check('越界题号（9 / -1）丢掉', got.every((g) => g.index >= 0 && g.index < 2) && r.stats.outOfRange === 2, JSON.stringify(r.stats));
  check('同一题号先到先得（不会把点评换掉）', got.find((g) => g.index === 0).comment === '第一次' && r.stats.dup === 1, JSON.stringify(got.map((g) => [g.index, g.comment])));
}

/* ---------- 5. 非法档位 / 超长点评走 sanitizeGrades 的同一套规则 ---------- */
{
  const r = createGradeReader({ itemCount: 1 });
  const got = r.feed(JSON.stringify({ index: 0, verdict: '基本正确但有小问题', comment: 'x'.repeat(2000) }) + '\n');
  check('非法档位归到 close', got[0] && got[0].verdict === 'close');
  check('超长点评截断到 800', got[0] && got[0].comment.length === 800);
}

/* ---------- 6. 末尾没有换行（模型最后一行常见） ---------- */
{
  const r = createGradeReader({ itemCount: 1 });
  check('未换行的尾行在 feed 阶段不吐', r.feed(line(0)).length === 0);
  const tail = r.flush();
  check('flush 时把尾行收下', tail.length === 1 && tail[0].index === 0);
  check('flush 之后缓冲清空（不会重复吐）', r.leftover === '' && r.flush().length === 0);
}

/* ---------- 7. finalizeGrades：流式优先，整段 JSON 兜底 ---------- */
{
  const parseLoose = (t) => JSON.parse(String(t).replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
  const streamed = finalizeGrades({ grades: [{ index: 0, verdict: 'right', comment: 'a', better: '' }], rawText: 'whatever', parseLoose, itemCount: 2 });
  check('有流式结果时用它，mode=stream', streamed.mode === 'stream' && streamed.grades.length === 1);

  const fallback = finalizeGrades({
    grades: [],
    rawText: JSON.stringify({ grades: [{ index: 0, verdict: 'wrong', comment: '整段解析', better: '' }] }),
    parseLoose,
    itemCount: 2,
  });
  check('一行都没解析出来时退回整段 JSON（mode=fallback）', fallback.mode === 'fallback' && fallback.grades[0].comment === '整段解析');

  const empty = finalizeGrades({ grades: [], rawText: '模型今天不想说话', parseLoose, itemCount: 2 });
  check('彻底没有结果时 mode=empty（调用方据此报错重试）', empty.mode === 'empty' && empty.grades.length === 0);
}

/* ---------- 8. 坏输入不炸 ---------- */
{
  const r = createGradeReader({ itemCount: 2 });
  check('null / undefined / 非字符串都不炸', r.feed(null).length === 0 && r.feed(undefined).length === 0 && r.feed(12345).length === 0);
  check('itemCount 缺省时任何题号都算越界（不会瞎贴）', createGradeReader().feed(line(0) + '\n').length === 0);
  check('finalizeGrades 坏输入不炸', finalizeGrades({ grades: null, rawText: null, parseLoose: null, itemCount: 0 }).mode === 'empty');
}

const failed = results.filter((x) => !x.ok);
console.log('\n' + '='.repeat(62));
console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
if (failed.length) {
  for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? '  — ' + f.detail : ''));
  process.exitCode = 1;
}
