/**
 * 收藏夹 + 间隔重复（SM-2）测试。
 *
 * 为什么值得测：复习进度是"跨设备同步"的数据 —— 算错一次，两台设备的排期就分叉了，
 * 而且用户看不出来（只会觉得"怎么又让我复习这个"）。这里的断言全是纯函数层面的。
 *
 * 跑法：node test/favorites.test.mjs
 */
import {
  FAV_EASE_MIN, FAV_EASE_MAX, FAV_INTERVAL_MAX,
  dueFavorites, dueLabel, dueOf, mergeFavoriteItem, mergeFavorites,
  newSchedule, nextDueAt, sm2Review, withSchedule,
} from '../src/favorites.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86400000;
const T0 = 1_700_000_000_000; // 固定"现在"，避免测试跟真实时间耦合

console.log('=== 收藏夹 / 间隔重复测试 ===\n');

/* ---------- 1. 初始排期 ---------- */
{
  const s = newSchedule(T0);
  check('新收藏：ease=2.5 / interval=0 / reps=0 / 当天到期', s.ease === 2.5 && s.interval === 0 && s.reps === 0 && s.due === T0);
  check('新收藏：lastGrade 为空（还没复习过）', s.lastGrade === '' && s.lastReviewed === 0);
}

/* ---------- 2. 老数据补齐调度字段 ---------- */
{
  const created = T0 - 5 * DAY;
  const legacy = { id: 'x', title: 'search for', kind: 'vocab', createdAt: created };
  const withS = withSchedule(legacy, T0);
  check('老收藏：补齐 ease/interval/reps', withS.ease === 2.5 && withS.interval === 0 && withS.reps === 0);
  check('老收藏：due 用收藏时间兜底（立刻可复习）', withS.due === created);
  check('老收藏：正文/来源字段原样保留', withS.title === 'search for' && withS.kind === 'vocab' && withS.createdAt === created);

  const bad = withSchedule({ id: 'y', title: 't', ease: 99, interval: -3, due: 'oops', reps: -2 }, T0);
  check('脏字段：ease 夹到上限 3.0', bad.ease === FAV_EASE_MAX);
  check('脏字段：负 interval → 0', bad.interval === 0);
  check('脏字段：负 reps → 0', bad.reps === 0);
  check('脏字段：due 非法 → 回落到此刻', bad.due === T0);

  const low = withSchedule({ id: 'z', title: 't', ease: 0.1 }, T0);
  check('脏字段：ease 不低于 1.3', low.ease === FAV_EASE_MIN);
}

/* ---------- 3. 三档评分的排期推进 ---------- */
{
  const base = { id: 'a', title: 'search for', createdAt: T0 - DAY };

  const f1 = sm2Review(base, 'forgot', T0);
  check('忘了：reps 归零、1 天后重来', f1.reps === 0 && f1.interval === 1 && f1.due === T0 + DAY);
  check('忘了：难度因子下调 0.2', Math.abs(f1.ease - 2.3) < 1e-9);
  check('忘了：记住这次评分', f1.lastGrade === 'forgot' && f1.lastReviewed === T0);

  const n1 = sm2Review(base, 'normal', T0);
  check('一般（首次）：1 天后', n1.interval === 1 && n1.reps === 1 && n1.due === T0 + DAY);
  const n2 = sm2Review(n1, 'normal', T0 + DAY);
  check('一般（第二次）：3 天后', n2.interval === 3 && n2.reps === 2 && n2.due === T0 + DAY + 3 * DAY);
  const n3 = sm2Review(n2, 'normal', T0 + 4 * DAY);
  check('一般（第三次起）：interval × ease', n3.interval === Math.round(3 * n2.ease) && n3.reps === 3);

  const e1 = sm2Review(base, 'easy', T0);
  check('简单（首次）：2 天后', e1.interval === 2 && e1.reps === 1);
  const e2 = sm2Review(e1, 'easy', T0 + 2 * DAY);
  check('简单（第二次）：6 天后', e2.interval === 6 && e2.reps === 2);
  const e3 = sm2Review(e2, 'easy', T0 + 8 * DAY);
  check('简单（第三次起）：interval × ease × 1.3', e3.interval === Math.round(6 * e2.ease * 1.3));
  check('简单：难度因子上调', e3.ease > e2.ease);

  const capped = sm2Review({ id: 'c', title: 't', ease: FAV_EASE_MAX, interval: 300, reps: 9 }, 'easy', T0);
  check('简单：ease 不超过 3.0', capped.ease === FAV_EASE_MAX);
  const floored = sm2Review({ id: 'c2', title: 't', ease: FAV_EASE_MIN, interval: 1, reps: 0 }, 'forgot', T0);
  check('忘了：ease 不低于 1.3', floored.ease === FAV_EASE_MIN);
  const far = sm2Review({ id: 'c3', title: 't', ease: 3, interval: 300, reps: 9 }, 'easy', T0);
  check('间隔上限 365 天（再熟也要回来看）', far.interval === FAV_INTERVAL_MAX);

  check('评分不可变：不改动传入的对象', base.ease === undefined && base.due === undefined && base.reps === undefined);
  const fallbackGrade = sm2Review(base, '随便传个值', T0);
  check('非法评分按「一般」处理', fallbackGrade.lastGrade === 'normal' && fallbackGrade.interval === 1);
}

/* ---------- 4. 到期筛选 ---------- */
{
  const list = [
    { id: 'old', title: 'a', createdAt: T0 - 10 * DAY },
    { id: 'yesterday', title: 'b', due: T0 - DAY },
    { id: 'today', title: 'c', due: T0 - 1000 },
    { id: 'tomorrow', title: 'd', due: T0 + DAY },
    { id: 'later', title: 'e', due: T0 + 5 * DAY },
    { id: 'broken', title: 'f' },
  ];
  const due = dueFavorites(list, T0).map((x) => x.id);
  check('待复习：含已过期 / 今天到期 / 缺字段的老收藏', eq(due, ['broken', 'old', 'yesterday', 'today']));
  check('待复习：按到期时间从早到晚（拖最久的先来）', dueOf({ due: T0 - 2 * DAY }) < dueOf({ due: T0 - DAY }));
  check('待复习：不含未来到期项', !due.includes('tomorrow') && !due.includes('later'));
  check('待复习：脏数据（null / 无 id）被忽略', dueFavorites([null, { title: 'no id' }, undefined], T0).length === 0);
  check('待复习：非数组输入不炸', dueFavorites(null, T0).length === 0);

  check('下一次到期：取最近的未来项', nextDueAt(list, T0) === T0 + DAY);
  check('下一次到期：全到期 → null', nextDueAt([{ id: 'a', title: 'a', due: T0 - DAY }], T0) === null);

  check('到期文案：已到期 = 待复习', dueLabel({ due: T0 - DAY }, T0) === '待复习');
  check('到期文案：1 天内 = 明天', dueLabel({ due: T0 + DAY / 2 }, T0) === '明天');
  check('到期文案：3 天后', dueLabel({ due: T0 + 3 * DAY }, T0) === '3 天后');
}

/* ---------- 5. 合并收藏（含跨设备复习进度） ---------- */
{
  const local = [{ id: 'k1', title: 'search for', body: '本地正文', createdAt: T0 - 3 * DAY, ...newSchedule(T0 - 3 * DAY) }];
  const remote = [{ id: 'k2', title: 'search for 的用法', createdAt: T0 - DAY, ...newSchedule(T0 - DAY) }];
  const r1 = mergeFavorites(remote, local);
  check('合并：新收藏加到最前面', r1.merged.map((x) => x.id).join(',') === 'k2,k1');
  check('合并：added 计数正确', r1.added === 1 && r1.updated === 0);

  // 关键用例：本地已存在同一条，但远端复习过（进度更新）→ 进度必须并过来
  const reviewed = { ...local[0], interval: 6, reps: 3, ease: 2.65, due: T0 + 6 * DAY, lastReviewed: T0, lastGrade: 'normal' };
  const r2 = mergeFavorites([reviewed], local);
  check('合并：远端复习过的进度被带上（不再被丢弃）', r2.merged[0].reps === 3 && r2.merged[0].interval === 6 && r2.merged[0].due === T0 + 6 * DAY);
  check('合并：updated 计数 1 条', r2.updated === 1 && r2.added === 0);
  check('合并：正文仍以本机为准（同步是合并不是覆盖）', r2.merged[0].body === '本地正文');

  // 反向：远端进度更旧 → 不动本地
  const stale = { ...local[0], body: '远端老正文', reps: 0, interval: 0, due: T0 - 3 * DAY, lastReviewed: 0 };
  const newerLocal = [{ ...local[0], reps: 2, interval: 3, due: T0 + 3 * DAY, lastReviewed: T0 - DAY, lastGrade: 'normal' }];
  const r3 = mergeFavorites([stale], newerLocal);
  check('合并：进度更旧的远端不覆盖本地更新的进度', r3.merged[0].reps === 2 && r3.merged[0].due === T0 + 3 * DAY && r3.updated === 0);
  check('合并：未改动时返回同一条目引用（不制造无意义写入）', r3.merged[0] === newerLocal[0]);

  // 都是老数据（没有调度字段）→ 不该被算成"更新过"
  const bare = [{ id: 'k9', title: 't', createdAt: T0 }];
  const r4 = mergeFavorites([{ id: 'k9', title: 't', createdAt: T0 }], bare);
  check('合并：双方都没有调度字段 → updated=0', r4.updated === 0);
  check('合并：补齐进来的调度字段不会丢掉本地字段', r4.merged[0].title === 't' && r4.merged[0].createdAt === T0);

  // 脏数据
  const r5 = mergeFavorites([null, { title: 'no id' }, { id: 'k3' }, { id: 'k3', title: 'dup' }, { id: 'k3', title: 'dup' }], []);
  check('合并：过滤脏数据、重复 id 只加一次', r5.added === 1 && r5.merged.length === 1);
  check('合并：非数组输入不炸', mergeFavorites(null, null).merged.length === 0);

  // 同一条合并两次（幂等）
  const once = mergeFavorites([reviewed], local).merged;
  const twice = mergeFavorites([reviewed], once).merged;
  check('合并：同一条重复合并是幂等的', eq(twice, once));

  // 排序依据：最近复习时间 > reps > due
  const olderReviewed = { id: 'a', title: 't', lastReviewed: T0 - DAY, reps: 5, due: T0 + DAY };
  const laterReviewed = { id: 'a', title: 't', lastReviewed: T0, reps: 1, due: T0 + DAY };
  check('合并冲突：以最近复习过的那份为准', mergeFavoriteItem(olderReviewed, laterReviewed).reps === 1);
  check('合并：mergeFavoriteItem 容错空值', mergeFavoriteItem(null, laterReviewed) === laterReviewed && mergeFavoriteItem(olderReviewed, null) === olderReviewed);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
if (failed.length) {
  for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? '  — ' + f.detail : ''));
  process.exitCode = 1;
}
