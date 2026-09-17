/**
 * 错误训练逻辑测试。
 *
 * 为什么值得测：这一层的输入是**三份不同来源的数据**（逐课进度 / 历史记录 / 结果缓存），
 * 出错的形态都很隐蔽 —— 错题归错课、把"对照学习"当错误算进去、
 * 历史超过 20 条之后老课的错题凭空消失……这些都不会报错，
 * 只会让用户觉得"练了也没用，出的题跟我犯的错没关系"。
 *
 * 跑法：node test/drill.test.mjs
 */
import { buildLocalDrill, collectDrills, drillsToPoints, errorId, lessonName, materialsToText, pickDrillPoints, summarizeDrills } from '../src/drill.js';
import { DRILL_USED_MAX, loadDrillUsed, markDrillUsed } from '../src/storage.js';
import { lessonKeyOf } from '../src/lessonLabel.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const LESSONS = [
  { book: 2, lesson: 1, title_cn: '私人谈话', title_en: 'A private conversation' },
  { book: 2, lesson: 2, title_cn: '早餐还是午餐？', title_en: 'Breakfast or lunch?' },
  { book: 2, lesson: 3, title_cn: '请给我寄一张明信片', title_en: 'Please send me a card' },
];
const keyOf = (l) => lessonKeyOf(l, null);

/** 造一份"结果对象"，和真实结果缓存同形状 */
const result = (findings) => ({ sentences: [{ cn: '上周我去看戏。', draft: 'I go to the theatre.', ai: 'I went to the theatre.', findings }] });
const err = (category, from, to, explanation) => ({ category, level: 'error', from, to, explanation });
const imp = (category, from, to) => ({ category, level: 'improve', from, to, explanation: '更地道' });

const HISTORY = [
  { jobId: 'j1', lessonKey: 'lesson:2-1', title: 'Lesson 1', time: 100 },
  { jobId: 'j2', lessonKey: 'lesson:2-2', title: 'Lesson 2', time: 200 },
];
const CACHE = {
  j1: result([err('时态', 'I go', 'I went', '过去的事要用过去时'), err('冠词', 'a theatre', 'the theatre'), imp('地道程度', 'very good', 'excellent')]),
  j2: result([err('搭配', 'depend of', 'depend on', 'depend 接 on')]),
};

/* ---------- 课名与 key ---------- */
{
  check('课名带课号与中文标题', lessonName(LESSONS[0]) === '01 私人谈话', lessonName(LESSONS[0]));
  check('内置库的 key 是 lesson:<册>-<课>', keyOf(LESSONS[1]) === 'lesson:2-2', keyOf(LESSONS[1]));
  check('自建库用稳定 lid（不是序号）', lessonKeyOf({ lid: 'L9', lesson: 3 }, { id: 'lib1' }) === 'lesson:my-lib1-L9');
}

/* ---------- 收集 ---------- */
{
  const rows = collectDrills({ lessons: LESSONS, keyOf, progress: { 'lesson:2-1': { n: 1, at: 100 }, 'lesson:2-2': { n: 2, at: 200 } }, history: HISTORY, loadResult: (id) => CACHE[id] });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  check('只列出练过的课（没练过的不出现）', rows.length === 2 && !byKey['lesson:2-3'], rows.map((r) => r.key).join(','));
  check('第 1 课的错题归到第 1 课', byKey['lesson:2-1'].errors.length === 2, String(byKey['lesson:2-1'].errors.length));
  check('"可提升"与"错误"分开记（不能把 improve 算成错）',
    byKey['lesson:2-1'].improves.length === 1 && byKey['lesson:2-1'].errors.every((e) => e.cat !== '地道程度'));
  check('错题带上原句（模型要知道当时想说什么）', byKey['lesson:2-1'].errors[0].cn.includes('看戏'), byKey['lesson:2-1'].errors[0].cn);
  check('按错误数从多到少排（第 1 课 2 处 > 第 2 课 1 处）', rows[0].key === 'lesson:2-1', rows.map((r) => `${r.key}:${r.errors.length}`).join(' '));
  check('按类型汇总（给界面显示用）', byKey['lesson:2-1'].byCategory['时态'] === 1 && byKey['lesson:2-1'].byCategory['冠词'] === 1);
  check('练过次数来自进度表', byKey['lesson:2-2'].attempts === 2, String(byKey['lesson:2-2'].attempts));

  // 历史只有 20 条：老课的结果缓存没了，但进度还在 —— 仍要列出来（不然用户以为"我明明练过"）
  const oldOnly = collectDrills({ lessons: LESSONS, keyOf, progress: { 'lesson:2-3': { n: 1, at: 50 } }, history: [], loadResult: () => null });
  check('历史里没有、但进度表里有的课仍然列出（标为无错题）',
    oldOnly.length === 1 && oldOnly[0].key === 'lesson:2-3' && oldOnly[0].errors.length === 0, JSON.stringify(oldOnly.map((r) => r.key)));

  check('空输入不炸', collectDrills({}).length === 0 && collectDrills().length === 0);
  check('结果缓存是脏数据时跳过（不能让整页崩）',
    collectDrills({ lessons: LESSONS, keyOf, progress: { 'lesson:2-1': { n: 1 } }, history: HISTORY, loadResult: () => ({ sentences: 'junk' }) }).length === 1);

  const s = summarizeDrills(collectDrills({ lessons: LESSONS, keyOf, progress: { 'lesson:2-1': { n: 1 }, 'lesson:2-2': { n: 1 } }, history: HISTORY, loadResult: (id) => CACHE[id] }));
  check('汇总：课数 / 错误数 / 类型榜', s.lessons === 2 && s.errors === 3 && s.byCategory[0].cat === '时态', JSON.stringify(s));
}

/* ---------- 压成给模型的要点 ---------- */
{
  const rows = collectDrills({ lessons: LESSONS, keyOf, progress: { 'lesson:2-1': { n: 1 }, 'lesson:2-2': { n: 1 } }, history: HISTORY, loadResult: (id) => CACHE[id] });
  const points = drillsToPoints(rows);
  check('每条要点都带课名/类型/原句/错法/错因',
    points.length === 4 && points[0].includes('01 私人谈话') && points[0].includes('时态') && points[0].includes('I go') && points[0].includes('I went'),
    points[0]);
  check('可提升点也进清单但标出来（不是当错误考）', points.some((p) => p.includes('可提升')), '');
  check('每课上限生效', drillsToPoints(rows, { maxPerLesson: 1 }).length === 2, String(drillsToPoints(rows, { maxPerLesson: 1 }).length));
  check('总量上限生效', drillsToPoints(rows, { max: 2 }).length === 2, String(drillsToPoints(rows, { max: 2 }).length));
  check('空输入返回空数组', drillsToPoints([]).length === 0 && drillsToPoints(null).length === 0);
  check('材料拼接带来源名', materialsToText([{ key: 'k', name: '第 2 课', text: 'text' }]).includes('第 2 课'));
}

/* ---------- 本地兜底出题（AI 失败时） ---------- */
{
  const rows = collectDrills({ lessons: LESSONS, keyOf, progress: { 'lesson:2-1': { n: 1 }, 'lesson:2-2': { n: 1 } }, history: HISTORY, loadResult: (id) => CACHE[id] });
  const quiz = buildLocalDrill(rows, 10);
  // 错题只有 4 条而要 10 题时**不轮着抄**：重复的题对复习没有增量，
  // 不如给 4 道不一样的（AI 那条链路不受影响，模型可以围绕同一错点换角度）
  check('兜底卷不重复：错题不够就有多少给多少', quiz.questions.length === 4, String(quiz.questions.length));
  check('兜底卷题目两两不同', new Set(quiz.questions.map((q) => q.question)).size === quiz.questions.length);
  check('兜底题是"改错"，答案是改对后的写法', quiz.questions[0].type === '改错' && quiz.questions[0].answer === 'I went', JSON.stringify(quiz.questions[0]));
  check('字段名与自测题一致（试卷页/复制/导 PDF 才能直接复用）',
    'question' in quiz.questions[0] && 'options' in quiz.questions[0] && 'explanation' in quiz.questions[0] && 'source' in quiz.questions[0],
    Object.keys(quiz.questions[0]).join(','));
  check('没有错题时兜底卷为空（调用方据此报错而不是给空卷）', buildLocalDrill([{ key: 'k', errors: [], improves: [] }], 5).questions.length === 0);
}

console.log('\n' + '='.repeat(62));
/* ---------- 出题去重：同一批错题不要两次大规模重复 ----------
 * 用户的原话：「一篇课文有 17 个错误，第一次出题 10 道，第二次也出 10 道，
 * 希望第二次尽量避免和第一次大规模重复，要把剩下 7 道都包含在内。」
 * 下面这组用例就是照着这句话逐条写的。 */
{
  const mk = (n, key = 'lesson:2-9') => ({
    key,
    name: key.replace('lesson:', '') + ' 一课',   // 课名跟着 key 走，否则两条用例没法区分

    errors: Array.from({ length: n }, (_, i) => ({ cat: '时态', from: 'wrong' + i, to: 'right' + i, cn: '第' + i + '句', why: 'w' })),
    improves: [],
  });

  const one = [mk(17)];
  const first = pickDrillPoints(one, { count: 10 });
  check('首次出题：10 道全部是没练过的', first.points.length === 10 && first.fresh === 10 && first.reused === 0,
    `共 ${first.points.length} 道，全新 ${first.fresh}，复用 ${first.reused}`);

  const used = {};
  first.ids.forEach((id, i) => { used[id] = 1000 + i; });
  const second = pickDrillPoints(one, { count: 10, used });
  const leftover = first.ids.filter((id) => !second.ids.includes(id));
  check('第二次出题：把上次剩下的 7 道全包含进来',
    leftover.length === 7 && second.fresh === 7, `剩下 ${leftover.length} 道，其中全新 ${second.fresh} 道`);
  check('第二次出题：只有 3 道与上次重复（不是大规模重复）',
    second.ids.filter((id) => first.ids.includes(id)).length === 3,
    `重复 ${second.ids.filter((id) => first.ids.includes(id)).length} 道`);

  const used2 = { ...used };
  second.ids.forEach((id, i) => { used2[id] = 2000 + i; });
  const third = pickDrillPoints(one, { count: 10, used: used2 });
  check('第三次出题：10 道互不重复', new Set(third.ids).size === 10);
  check('第三次出题：优先给最早出过的（上一批先让路）',
    third.ids.filter((id) => first.ids.includes(id)).length === 7,
    `第三次里来自第一批的有 ${third.ids.filter((id) => first.ids.includes(id)).length} 道（应为 7）`);

  const two = [mk(30, 'lesson:2-1'), mk(30, 'lesson:2-2')];
  const rr = pickDrillPoints(two, { count: 10 });
  check('多课轮转：不会让"错得最多那课"把名额吃光',
    rr.points.filter((t) => t.includes('2-1')).length >= 3 && rr.points.filter((t) => t.includes('2-2')).length >= 3,
    `课A ${rr.points.filter((t) => t.includes('2-1')).length} 道 / 课B ${rr.points.filter((t) => t.includes('2-2')).length} 道`);

  check('题量上限 100 生效（传 500 只给 100）', pickDrillPoints([mk(150)], { count: 500 }).points.length === 100,
    String(pickDrillPoints([mk(150)], { count: 500 }).points.length));
  check('错题不够时有多少给多少', pickDrillPoints([mk(3)], { count: 10 }).points.length === 3);
  check('空输入 / 坏输入不炸', pickDrillPoints(null, { count: 5 }).points.length === 0
    && pickDrillPoints([], {}).points.length === 0
    && pickDrillPoints([mk(2)], { count: 0 }).points.length === 2);

  // 稳定 id：给同一课新增错题，不能让已有错题的 id 整体位移（否则"记账"全错位）
  const rowA = { key: 'lesson:2-1', name: 'A', errors: [{ cat: '时态', from: 'x', to: 'y', cn: '句子', why: '' }], improves: [] };
  const rowB = { key: 'lesson:2-1', name: 'A', errors: [{ cat: '时态', from: 'x', to: 'y', cn: '句子', why: '' }, { cat: '冠词', from: 'a', to: 'the', cn: '句子', why: '' }], improves: [] };
  check('id 稳定：同一课新增错题不会让旧错题的 id 位移',
    pickDrillPoints([rowA], { count: 1 }).ids[0] === pickDrillPoints([rowB], { count: 2 }).ids[0],
    pickDrillPoints([rowA], { count: 1 }).ids[0]);
  check('id 区分不同课 / 不同改动',
    errorId('lesson:2-1', { cat: '时态', from: 'x', to: 'y' }) !== errorId('lesson:2-2', { cat: '时态', from: 'x', to: 'y' })
    && errorId('k', { cat: '时态', from: 'x', to: 'y' }) !== errorId('k', { cat: '时态', from: 'x', to: 'z' }));

  const b1 = buildLocalDrill(one, 10);
  const bUsed = {};
  pickDrillPoints(one, { count: 10 }).ids.forEach((id, i) => { bUsed[id] = 1000 + i; });
  const b2 = buildLocalDrill(one, 10, { used: bUsed });
  const b1q = new Set(b1.questions.map((q) => q.question));
  check('兜底卷也避开出过的题（第二次只有 3 道与第一次重复）',
    b2.questions.filter((q) => b1q.has(q.question)).length === 3,
    `重复 ${b2.questions.filter((q) => b1q.has(q.question)).length} 道`);

  check('缺失 from/to 的错题不进改错卷（没法出题）',
    buildLocalDrill([{ key: 'k', name: 'K', errors: [{ cat: '时态', from: '', to: '' }], improves: [] }], 5).questions.length === 0);
}

/* ---------- 记账（storage）：出过的错题 ---------- */
{
  const base = { a: 100, b: 200 };
  const m1 = markDrillUsed(base, ['b', 'c'], 300);
  check('记账：记上新时间、不动别的', m1.a === 100 && m1.b === 300 && m1.c === 300, JSON.stringify(m1));
  check('记账：空 id / 脏 id 被忽略', Object.keys(markDrillUsed({}, [null, undefined, ''], 1)).length === 0);
  check('记账：不吃原对象（纯函数）', base.b === 200);
  const many = {};
  for (let i = 0; i < DRILL_USED_MAX + 50; i += 1) many['id' + i] = i + 1;
  const trimmed = markDrillUsed(many, ['newest'], 999999);
  check('记账：超过上限时丢最老的、保住最新的',
    Object.keys(trimmed).length === DRILL_USED_MAX && trimmed.newest === 999999,
    `剩 ${Object.keys(trimmed).length} 条（上限 ${DRILL_USED_MAX}）`);
  check('读取：没有 localStorage / 脏数据都退回空表（Node 里跑就是这条路径）',
    Object.keys(loadDrillUsed()).length === 0 && typeof loadDrillUsed() === 'object');
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
