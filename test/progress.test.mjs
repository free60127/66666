/**
 * 「同一课文二次练习对比」测试（纯函数）。
 *
 * 为什么值得测：这块 UI 的结论是"你进步了 / 这类错还在"——
 * 认错课文（把别人的练习当成你的上次）比不显示更糟，所以匹配规则与差值都要有断言兜着。
 *
 * 跑法：node test/progress.test.mjs
 */
import { compareWithPrevious, legacyLessonKey, normalizeLessonKey, sameLesson, scoreOf, tallyCategories } from '../src/progress.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const T0 = 1_700_000_000_000;
const DAY = 86400000;

console.log('=== 同课练习对比测试 ===\n');

/** 造一份结果：cats 形如 { 拼写: { error: 2, improve: 1, study: 1 } } */
function mkResult({ title = 'Lesson 18 · He often does this!', lessonKey, score, issues, durationMs = 0, cats = {}, sentences = 1 } = {}) {
  const findings = [];
  for (const [category, spec] of Object.entries(cats)) {
    for (let i = 0; i < (Number(spec.error) || 0); i += 1) findings.push({ category, level: 'error' });
    for (let i = 0; i < (Number(spec.improve) || 0); i += 1) findings.push({ category, level: 'improve' });
    for (let i = 0; i < (Number(spec.study) || 0); i += 1) findings.push({ category, level: 'study' });
  }
  return {
    ...(lessonKey ? { lessonKey } : {}),
    title,
    durationMs,
    overall: score == null ? {} : { score, issues: issues == null ? findings.length : issues },
    sentences: Array.from({ length: Math.max(1, sentences) }, (_, i) => ({ cn: 's' + i, draft: '', ai: '', findings: i === 0 ? findings : [] })),
  };
}
const reader = (cache) => (jobId) => (jobId in cache ? cache[jobId] : null);

/* ---------- 1. 类型统计 ---------- */
{
  const t = tallyCategories([mkResult({ cats: { 拼写: { error: 2, improve: 1 }, 语法: { error: 1 }, 对照: { study: 3 } } })]);
  check('统计：按类型汇总并按总数排序', eq(t.list.map((x) => [x.cat, x.total]), [['拼写', 3], ['语法', 1]]));
  check('统计：必改 / 可提升分别计数', t.errors === 3 && t.improves === 1);
  check('统计：对照学习(study)不算问题', !t.list.some((x) => x.cat === '对照'));
  check('统计：句数与用到的结果数', t.sentences === 1 && t.used === 1);

  const multi = tallyCategories([
    mkResult({ lessonKey: 'lesson:2-18', cats: { 拼写: { error: 1 } } }),
    mkResult({ lessonKey: 'lesson:2-19', cats: { 拼写: { error: 2 }, 时态: { improve: 1 } } }),
  ]);
  check('统计：多份结果合并累加', multi.errors === 3 && multi.improves === 1 && multi.used === 2);

  const dirty = tallyCategories([null, 'x', {}, { sentences: [] }, { sentences: [null, { findings: 'oops' }, { findings: [{ category: '' }, { category: '拼写' }] }] }]);
  check('统计：脏数据不炸，缺字段按必改处理', dirty.errors === 1 && dirty.used === 1);
  check('统计：非数组输入返回空结构', tallyCategories(null).list.length === 0 && tallyCategories(undefined).used === 0);
}

/* ---------- 2. 分数 ---------- */
{
  check('分数：正常取值', scoreOf({ overall: { score: 78 } }) === 78);
  check('分数：字符串数字也算', scoreOf({ overall: { score: '78' } }) === 78);
  check('分数：缺分数 → null（不是 0 分）', scoreOf({ overall: {} }) === null && scoreOf(null) === null);
  check('分数：脏值 → null', scoreOf({ overall: { score: 'abc' } }) === null && scoreOf({ overall: { score: NaN } }) === null);
}

/* ---------- 3. 同一课怎么认 ---------- */
{
  check('课标识：lesson:2-18 有效', normalizeLessonKey(' lesson:2-18 ') === 'lesson:2-18');
  check('课标识：free / demo 保留自身语义', normalizeLessonKey('free') === 'free' && normalizeLessonKey('demo') === 'demo');
  check('课标识：认不出的值一律当没有', normalizeLessonKey('乱七八糟') === '' && normalizeLessonKey('lesson:') === '' && normalizeLessonKey(null) === '');
  check('老数据：Lesson 18 标题能反推', legacyLessonKey('Lesson 18 · He often does this!') === 'title:lesson 18 · he often does this!');
  check('老数据：非课文标题不反推', legacyLessonKey('我的英语作文') === '' && legacyLessonKey('') === '');

  const a = mkResult({ lessonKey: 'lesson:2-18' });
  const b = mkResult({ lessonKey: 'lesson:2-18', score: 80 });
  const c = mkResult({ lessonKey: 'lesson:2-19' });
  check('同一课：lessonKey 相同 → true', sameLesson(a, b) === true);
  check('同一课：不同课 → false', sameLesson(a, c) === false);
  check('同一课：自由练习之间不算同一课', sameLesson(mkResult({ lessonKey: 'free' }), mkResult({ lessonKey: 'free' })) === false);
  check('同一课：示例之间不算同一课', sameLesson(mkResult({ lessonKey: 'demo' }), mkResult({ lessonKey: 'demo' })) === false);
  check('同一课：老数据同标题 → true（兼容历史记录）', sameLesson(mkResult({}), mkResult({ score: 90 })) === true);
  check('同一课：一边有 key 一边没有 → false（不猜）', sameLesson(a, mkResult({})) === false);
}

/* ---------- 4. 对比：正常路径 ---------- */
{
  const history = [
    { jobId: 'now', time: T0, title: 'Lesson 18 · He often does this!', lessonKey: 'lesson:2-18', durationMs: 600000 },
    { jobId: 'other', time: T0 - DAY, title: 'Lesson 5 · 别的课', lessonKey: 'lesson:2-5', durationMs: 0 },
    { jobId: 'prev', time: T0 - 3 * DAY, title: 'Lesson 18 · He often does this!', lessonKey: 'lesson:2-18', durationMs: 900000 },
  ];
  const cache = {
    now: mkResult({ lessonKey: 'lesson:2-18', score: 86, durationMs: 600000, cats: { 拼写: { error: 1 }, 语法: { error: 2 } } }),
    other: mkResult({ lessonKey: 'lesson:2-5', score: 50, cats: { 拼写: { error: 9 } } }),
    prev: mkResult({ lessonKey: 'lesson:2-18', score: 78, durationMs: 900000, cats: { 拼写: { error: 4 }, 语法: { error: 2 }, 时态: { error: 1 } } }),
  };
  const cur = cache.now;
  const cmp = compareWithPrevious({ history, result: cur, jobId: 'now', readResult: reader(cache), now: T0 });

  check('对比：跳过别的课文，找到上一次同课', cmp && cmp.prev.jobId === 'prev');
  check('对比：上次时间换算成天数', cmp.prev.daysAgo === 3);
  check('对比：分数差 +8', cmp.score.prev === 78 && cmp.score.now === 86 && cmp.score.delta === 8);
  check('对比：必改错误差 -4（少了 4 处）', cmp.errors.prev === 7 && cmp.errors.now === 3 && cmp.errors.delta === -4);
  check('对比：上次的常犯类型排在前面', eq(cmp.items.map((x) => x.cat), ['拼写', '语法', '时态']));
  check('对比：拼写 4 → 1 = 少了', cmp.items[0].state === 'down' && cmp.items[0].delta === -3);
  check('对比：语法 2 → 2 = 持平', cmp.items[1].state === 'same' && cmp.items[1].delta === 0);
  check('对比：时态 1 → 0 = 已改掉', cmp.items[2].state === 'fixed' && cmp.items[2].now === 0);
  check('对比：改掉的类型计数', cmp.fixed === 1 && cmp.worse === 0 && cmp.tried === 3);
  check('对比：用时差 -5 分钟（快了）', cmp.duration && cmp.duration.delta === -300000);

  // 自己不算"上次"
  const selfOnly = compareWithPrevious({ history: [history[0]], result: cur, jobId: 'now', readResult: reader(cache), now: T0 });
  check('对比：只有自己一条历史 → 不显示对比', selfOnly === null);

  // 完全不认识的 jobId（分享链接）：靠指纹跳过自己那份缓存
  const shared = compareWithPrevious({
    history: [{ jobId: 'now', time: T0, title: cur.title, lessonKey: 'lesson:2-18' }],
    result: cur,
    jobId: '',
    readResult: reader(cache),
    now: T0,
  });
  check('对比：没有 jobId 时靠指纹跳过自己', shared === null);
}

/* ---------- 5. 对比：变糟 / 无历史 / 容错 ---------- */
{
  const history = [
    { jobId: 'p', time: T0 - DAY, lessonKey: 'lesson:3-7', title: 'Lesson 7 · 某课' },
  ];
  const worse = {
    p: mkResult({ lessonKey: 'lesson:3-7', score: 80, cats: { 拼写: { error: 1 }, 语法: { error: 1 } } }),
  };
  const cur = mkResult({ lessonKey: 'lesson:3-7', score: 70, cats: { 拼写: { error: 5 }, 语法: { error: 1 } } });
  const cmp = compareWithPrevious({ history, result: cur, jobId: '', readResult: reader(worse), now: T0 });
  check('对比：退步时差值带负号', cmp.score.delta === -10);
  check('对比：某类错变多 → up', cmp.items[0].state === 'up' && cmp.items[0].delta === 4);
  check('对比：退步计数', cmp.worse === 1 && cmp.fixed === 0);

  check('对比：没有历史 → null', compareWithPrevious({ history: [], result: cur, readResult: reader(worse), now: T0 }) === null);
  check('对比：结果为空 → null', compareWithPrevious({ history, result: null, readResult: reader(worse), now: T0 }) === null);
  check('对比：历史全是不相干课文 → null', compareWithPrevious({
    history: [{ jobId: 'x', time: T0 - DAY, lessonKey: 'lesson:1-1', title: 'Lesson 1 · 别的' }],
    result: cur,
    readResult: () => mkResult({ lessonKey: 'lesson:1-1' }),
    now: T0,
  }) === null);

  const boom = compareWithPrevious({ history, result: cur, readResult: () => { throw new Error('读缓存炸了'); }, now: T0 });
  check('对比：读缓存抛错时不炸，按"没有上次"处理', boom === null);

  // 老历史（没有 lessonKey）用标题兜底
  const legacyHistory = [{ jobId: 'old', time: T0 - 2 * DAY, title: 'Lesson 18 · He often does this!' }];
  const legacyCache = { old: mkResult({ score: 60, cats: { 拼写: { error: 2 } } }) };
  const legacyCmp = compareWithPrevious({
    history: legacyHistory,
    result: mkResult({ score: 75, cats: { 拼写: { error: 0 } } }),
    jobId: '',
    readResult: reader(legacyCache),
    now: T0,
  });
  check('对比：老历史没有 lessonKey 时按标题匹配', legacyCmp && legacyCmp.prev.jobId === 'old');
  check('对比：老数据也能算出"已改掉"', legacyCmp && legacyCmp.items[0].state === 'fixed' && legacyCmp.fixed === 1);

  // 上次只有"对照学习"，没有可对比的类型
  const onlyStudy = { s: mkResult({ lessonKey: 'lesson:4-4', score: 88, cats: { 对照: { study: 3 } } }) };
  const studyCmp = compareWithPrevious({
    history: [{ jobId: 's', time: T0 - DAY, lessonKey: 'lesson:4-4', title: 'Lesson 4 · x' }],
    result: mkResult({ lessonKey: 'lesson:4-4', score: 90, cats: {} }),
    readResult: reader(onlyStudy),
    now: T0,
  });
  check('对比：上次没有问题类型时只比分数', studyCmp && studyCmp.items.length === 0 && studyCmp.score.delta === 2 && studyCmp.tried === 0);
  check('对比：没有任何可比数据 → null', compareWithPrevious({
    history: [{ jobId: 's', time: T0 - DAY, lessonKey: 'lesson:4-4', title: 'Lesson 4 · x' }],
    result: mkResult({ lessonKey: 'lesson:4-4', score: undefined, cats: {} }),
    readResult: () => mkResult({ lessonKey: 'lesson:4-4', cats: {} }),
    now: T0,
  }) === null);

  // 历史顺序被打乱（同步/导入后可能出现）→ 仍取时间最近的那次
  const shuffled = [
    { jobId: 'older', time: T0 - 9 * DAY, lessonKey: 'lesson:5-5', title: 'Lesson 5 · x' },
    { jobId: 'newer', time: T0 - 2 * DAY, lessonKey: 'lesson:5-5', title: 'Lesson 5 · x' },
  ];
  const shuffledCache = { older: mkResult({ lessonKey: 'lesson:5-5', score: 40 }), newer: mkResult({ lessonKey: 'lesson:5-5', score: 65 }) };
  const shuffledCmp = compareWithPrevious({
    history: shuffled,
    result: mkResult({ lessonKey: 'lesson:5-5', score: 70 }),
    readResult: reader(shuffledCache),
    now: T0,
  });
  check('对比：历史顺序乱了也取最近的一次', shuffledCmp && shuffledCmp.prev.jobId === 'newer' && shuffledCmp.score.prev === 65);
  check('对比：脏历史条目被忽略', compareWithPrevious({ history: [null, {}, { jobId: '' }], result: mkResult({ lessonKey: 'lesson:5-5' }), readResult: () => null, now: T0 }) === null);

  // 「上次」必须早于这一次：从历史点开旧作业时，比它晚的练习不能当"上次"
  const laterHistory = [
    { jobId: 'later', time: T0 + DAY, lessonKey: 'lesson:6-6', title: 'Lesson 6 · x' },
    { jobId: 'earlier', time: T0 - 2 * DAY, lessonKey: 'lesson:6-6', title: 'Lesson 6 · x' },
  ];
  const laterCache = {
    later: mkResult({ lessonKey: 'lesson:6-6', score: 95 }),
    earlier: mkResult({ lessonKey: 'lesson:6-6', score: 55 }),
  };
  const midAttempt = { ...mkResult({ lessonKey: 'lesson:6-6', score: 75 }), attemptTime: T0 };
  const midCmp = compareWithPrevious({ history: laterHistory, result: midAttempt, readResult: reader(laterCache), now: T0 });
  check('对比：只认比这次更早的练习，之后的不算上次', midCmp && midCmp.prev.jobId === 'earlier' && midCmp.score.delta === 20);

  const onlyLater = compareWithPrevious({
    history: laterHistory,
    result: { ...midAttempt, attemptTime: T0 - 5 * DAY },
    readResult: reader(laterCache),
    now: T0,
  });
  check('对比：这次的更早之前没有练习 → 不显示对比', onlyLater === null);

  // 打开历史里那条旧作业（jobId 命中）时，用它的历史时间做截断
  const historyOpened = compareWithPrevious({
    history: laterHistory,
    result: mkResult({ lessonKey: 'lesson:6-6', score: 95 }),
    jobId: 'later',
    readResult: reader(laterCache),
    now: T0 + 2 * DAY,
  });
  check('对比：从历史点开旧作业时，拿它之前的那次做对比', historyOpened && historyOpened.prev.jobId === 'earlier' && historyOpened.score.delta === 40);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
if (failed.length) {
  for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? '  — ' + f.detail : ''));
  process.exitCode = 1;
}
