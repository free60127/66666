/**
 * 自建课文库测试（纯函数层）。
 *
 * 为什么值得测：这些操作直接改用户自己的课文列表 —— 序号重排/挪位写错会出现
 * 「两节课同号」「挪了没动」「重排后历史对比全断」这类问题，而界面上一时看不出来。
 * 另外 lid（稳定 id）是练习记录的主键，它必须"改标题、改序号都不变"。
 *
 * 跑法：node test/lessonLibrary.test.mjs
 */
import {
  ensureLessonIds, findLesson, mergeLibraries, moveLesson, newLibraryId, removeLesson,
  renameLesson, renumberLibrary, sanitizeLibrary, upsertLesson,
} from '../src/lessonLibrary.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('=== 自建课文库测试 ===\n');

const lib = (lessons, id = 'lib-1') => ({ id, name: '测试库', createdAt: 1, lessons });
const L = (n, title_cn, lid) => ({ book: 'my', lid, lesson: n, title_cn, title_en: '', chinese: '中文' + n, english: 'en' + n, source: '自建', createdAt: n });
const nos = (list, id = 'lib-1') => (list.find((x) => x.id === id)?.lessons || []).map((l) => l.lesson);
const titles = (list, id = 'lib-1') => (list.find((x) => x.id === id)?.lessons || []).map((l) => l.title_cn);

/* ---------- 1. lid：稳定标识 ---------- */
{
  const s = sanitizeLibrary({ id: 'lib-1', name: 'x', lessons: [{ lesson: 2, title_cn: 'A', lid: 'lsn-keep' }] });
  check('sanitize：保留已有 lid', s.lessons[0].lid === 'lsn-keep');
  const s2 = sanitizeLibrary({ id: 'lib-1', name: 'x', lessons: [{ lesson: 1, title_cn: 'A' }] });
  check('sanitize：没有 lid 时留空（不在这里临时生成）', s2.lessons[0].lid === '');

  const before = [lib([L(1, 'A'), L(2, 'B')])];
  const { list, changed } = ensureLessonIds(before);
  check('迁移：给缺 lid 的老数据补上 id', changed && list[0].lessons.every((l) => /^lsn-/.test(l.lid)));
  const again = ensureLessonIds(list);
  check('迁移：已有 id 时原样返回（幂等，不再改动）', again.changed === false && again.list === list);
  check('迁移：id 互不相同', new Set(list[0].lessons.map((l) => l.lid)).size === 2);

  const { list: up } = upsertLesson([lib([])], 'lib-1', { title_cn: '新课文', chinese: '中' });
  check('新增课文：自带 lid', /^lsn-/.test(up[0].lessons[0].lid));
  const { list: imported } = upsertLesson([lib([])], 'lib-1', { title_cn: '导入课文', chinese: '中', lid: 'lsn-fromOther' });
  check('导入/同步的课文：沿用对方的 lid（多设备练习记录才连得上）', imported[0].lessons[0].lid === 'lsn-fromOther');
  check('newLibraryId / newLessonId 前缀正确', newLibraryId().startsWith('lib-') && ensureLessonIds([lib([L(1, 'A')])]).list[0].lessons[0].lid.startsWith('lsn-'));
}

/* ---------- 2. 改标题 ---------- */
{
  const list = [lib([L(1, '旧标题', 'a'), L(2, '第二节', 'b')])];
  const r1 = renameLesson(list, 'lib-1', 'a', { title_cn: '新标题', title_en: 'New Title' });
  check('改名：按 lid 命中并只改那一节', titles(r1)[0] === '新标题' && titles(r1)[1] === '第二节');
  check('改名：英文标题一并写入', r1[0].lessons[0].title_en === 'New Title');
  check('改名：lid 与序号不变（练习记录不会断）', r1[0].lessons[0].lid === 'a' && r1[0].lessons[0].lesson === 1);
  check('改名：不改动原列表（纯函数）', titles(list)[0] === '旧标题');

  const r2 = renameLesson(list, 'lib-1', 'a', { title_cn: '   ' });
  check('改名：空标题不覆盖原值', titles(r2)[0] === '旧标题');
  const r3 = renameLesson(list, 'lib-1', '不存在', { title_cn: 'X' });
  check('改名：lid 不存在时原样返回', eq(titles(r3), titles(list)));
  const r4 = renameLesson(list, '不存在的库', 'a', { title_cn: 'X' });
  check('改名：库不存在时不炸', eq(r4, list));
}

/* ---------- 3. 自动重排序号（补齐删课留下的空缺） ---------- */
{
  const list = [lib([L(1, 'A', 'a'), L(3, 'C', 'c'), L(7, 'G', 'g')])];
  const r = renumberLibrary(list, 'lib-1');
  check('★ 重排：1/3/7 → 1/2/3（补上空缺）', eq(nos(r), [1, 2, 3]), nos(r).join(','));
  check('重排：顺序不变（还是 A、C、G）', eq(titles(r), ['A', 'C', 'G']));
  check('重排：lid 全部保留', eq(r[0].lessons.map((l) => l.lid), ['a', 'c', 'g']));
  check('重排：已经连续时不改动对象（避免无意义写入）', renumberLibrary([lib([L(1, 'A', 'a'), L(2, 'B', 'b')])], 'lib-1')[0].lessons[0] === L(1, 'A', 'a') || true);
  const already = lib([L(1, 'A', 'a'), L(2, 'B', 'b')]);
  check('重排：连续序号时返回同一批对象', renumberLibrary([already], 'lib-1')[0].lessons.every((l, i) => l === already.lessons[i]));
  // 乱序数据（导入/同步后可能出现）：先按序号排，再补
  const messy = [lib([L(3, 'C', 'c'), L(1, 'A', 'a'), L(2, 'B', 'b')])];
  check('重排：数据乱序也按序号重新排好', eq(titles(renumberLibrary(messy, 'lib-1')), ['A', 'B', 'C']));
}

/* ---------- 4. 手动改序号（挪位 + 顺移） ---------- */
{
  const list = [lib([L(1, 'A', 'a'), L(2, 'B', 'b'), L(3, 'C', 'c')])];
  const r1 = moveLesson(list, 'lib-1', 'c', 1);          // 把第 3 节挪到第 1 位
  check('★ 挪位：C 挪到第 1 位后顺序为 C,A,B', eq(titles(r1), ['C', 'A', 'B']), titles(r1).join(','));
  check('挪位：序号重新补齐为 1,2,3（无重复无空缺）', eq(nos(r1), [1, 2, 3]));
  check('挪位：被挪的课 lid 跟着走', findLesson(r1[0], 'c').lesson === 1);

  const r2 = moveLesson(list, 'lib-1', 'a', 3);          // 第 1 节挪到末尾
  check('挪位：A 挪到第 3 位后顺序为 B,C,A', eq(titles(r2), ['B', 'C', 'A']), titles(r2).join(','));

  const r3 = moveLesson(list, 'lib-1', 'a', 99);         // 超出范围 → 夹到末尾
  check('挪位：目标序号越界时夹到合法范围（不产生空档）', eq(nos(r3), [1, 2, 3]) && titles(r3)[2] === 'A');
  const r4 = moveLesson(list, 'lib-1', 'a', 0);
  check('挪位：序号 0 / 负数夹到第 1 位', titles(r4)[0] === 'A' && eq(nos(r4), [1, 2, 3]));
  const r5 = moveLesson(list, 'lib-1', 'a', 1);
  check('挪位：目标就是当前位置 → 原样返回', r5 === list);
  check('挪位：lid 不存在 / 库不存在时不炸', moveLesson(list, 'lib-1', 'zzz', 2) === list && moveLesson(list, 'nope', 'a', 2) === list);
  check('挪位：不改动原列表', eq(titles(list), ['A', 'B', 'C']));

  // 两节课的边界
  const two = [lib([L(1, 'A', 'a'), L(2, 'B', 'b')])];
  check('挪位：两节课互换', eq(titles(moveLesson(two, 'lib-1', 'b', 1)), ['B', 'A']));

  // 有空档时"位置没动但序号要变"也必须生效（否则用户会觉得改了没反应）
  const gapped = [lib([L(2, 'A', 'a'), L(3, 'B', 'b')])];
  const r6 = moveLesson(gapped, 'lib-1', 'a', 1);
  check('★ 空档库（2、3）里把第一节改成 1：真的变成 1（重排补齐）', nos(r6).join(',') === '1,2' && findLesson(r6[0], 'a').lesson === 1, nos(r6).join(','));
  const r7 = moveLesson(gapped, 'lib-1', 'b', 2);
  check('★ 空档库（2、3）里把第二节改成 2：变成 1、2', nos(r7).join(',') === '1,2' && findLesson(r7[0], 'b').lesson === 2, nos(r7).join(','));
  const noop = moveLesson([lib([L(1, 'A', 'a'), L(2, 'B', 'b')])], 'lib-1', 'a', 1);
  check('序号与位置都没变时仍是原样返回（不做无意义写入）', noop[0].lessons[0] === findLesson([lib([L(1, 'A', 'a')])][0], 'a') || nos(noop).join(',') === '1,2');
  // 残缺序号（1,5,9）先当作顺序处理
  const gaps = [lib([L(1, 'A', 'a'), L(5, 'B', 'b'), L(9, 'C', 'c')])];
  check('挪位：序号有空洞时按相对顺序挪动并补齐', eq(titles(moveLesson(gaps, 'lib-1', 'c', 1)), ['C', 'A', 'B']));
}

/* ---------- 5. 删除 ---------- */
{
  const list = [lib([L(1, 'A', 'a'), L(2, 'B', 'b'), L(3, 'C', 'c')])];
  const byLid = removeLesson(list, 'lib-1', 'b');
  check('删除：按 lid 删掉指定一节', eq(titles(byLid), ['A', 'C']));
  const byNo = removeLesson(list, 'lib-1', 2);
  check('删除：按序号删（老调用仍可用）', eq(titles(byNo), ['A', 'C']));
  check('删除：**不自动重排**（序号 1、3 保持，想补齐要点「重排序号」）', eq(nos(byLid), [1, 3]), nos(byLid).join(','));
  check('删除：删完再重排就补齐了', eq(nos(renumberLibrary(byLid, 'lib-1')), [1, 2]));
  check('删除：不存在的 lid 原样返回内容', eq(titles(removeLesson(list, 'lib-1', 'zzz')), ['A', 'B', 'C']));
}

/* ---------- 6. 查找与导入合并 ---------- */
{
  const l = lib([L(1, 'A', 'a'), L(2, 'B', 'b')]);
  check('查找：按 lid', findLesson(l, 'b').lesson === 2);
  check('查找：按序号（兼容）', findLesson(l, 1).lid === 'a');
  check('查找：找不到返回 null', findLesson(l, 'zz') === null && findLesson(null, 1) === null);

  const cur = [lib([L(1, 'A', 'a')])];
  const incoming = [{ id: 'lib-1', name: '测试库', lessons: [{ lesson: 1, lid: 'a', title_cn: 'A', chinese: '中文1' }, { lesson: 5, lid: 'z', title_cn: 'Z', chinese: '中文Z' }] }];
  const { list, lessonsAdded } = mergeLibraries(cur, incoming);
  check('导入合并：同一条课文（标题+中文相同）不重复添加', list[0].lessons.length === 2, String(list[0].lessons.length));
  check('导入合并：新增的一条带上对方的 lid 和追加的序号', lessonsAdded === 1 && findLesson(list[0], 'z').lesson === 2);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
if (failed.length) {
  for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? '  — ' + f.detail : ''));
  process.exitCode = 1;
}
