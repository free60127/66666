/**
 * 历史删除的「防复活」测试（纯函数层）。
 *
 * 为什么必须有：云同步的历史合并是**并集**（按 jobId 去重后合并两边）。
 * 只在本机把记录删掉、不留墓碑的话，下一次同步就会从云端把这条记录原样并回来 ——
 * 用户看到的现象是"删了又出现"，而且他没有任何办法让它真的消失。
 *
 * 跑法：node test/historyDelete.test.mjs
 */
import { mergeDeleted, mergeHistory, mergeSnapshot, DELETED_LIMIT } from '../src/syncMerge.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const T0 = 1_700_000_000_000;

console.log('=== 历史删除 / 防复活测试 ===\n');

const h = (jobId, time) => ({ jobId, title: 'T' + jobId, time });

/* ---------- 1. 没有墓碑时：并集行为不变 ---------- */
{
  const merged = mergeHistory([h('a', T0)], [h('b', T0 + 1000)]);
  check('无墓碑：两条都在（并集）', merged.length === 2, merged.map((x) => x.jobId).join(','));
  check('无墓碑：按时间倒序', merged[0].jobId === 'b');
}

/* ---------- 2. 本机删掉的那条：云端还在也不能并回来 ---------- */
{
  const merged = mergeHistory([], [h('gone', T0), h('keep', T0 + 1000)], 20, ['gone']);
  check('墓碑命中：云端的已删记录被过滤', merged.length === 1 && merged[0].jobId === 'keep', JSON.stringify(merged.map((x) => x.jobId)));
}

/* ---------- 3. 两边都有这条（本机还没删干净的情况）----------- */
{
  const merged = mergeHistory([h('gone', T0)], [h('gone', T0)], 20, new Set(['gone']));
  check('墓碑命中：本地那份也被过滤', merged.length === 0);
}

/* ---------- 4. 其它记录不受影响 ---------- */
{
  const local = [h('a', T0 + 3000), h('b', T0 + 2000)];
  const remote = [h('c', T0 + 1000), h('d', T0)];
  const merged = mergeHistory(local, remote, 20, ['zzz']);
  check('墓碑里没有的 id 不受影响', merged.length === 4, merged.map((x) => x.jobId).join(','));
}

/* ---------- 5. 墓碑合并：并集 + 去重 ---------- */
{
  const merged = mergeDeleted(['a', 'b'], ['b', 'c']);
  check('墓碑并集去重', JSON.stringify(merged) === JSON.stringify(['a', 'b', 'c']), JSON.stringify(merged));
  const withJunk = mergeDeleted(['a', 42, null, '', 'a'], undefined);
  check('墓碑丢掉非字符串与空值', JSON.stringify(withJunk) === JSON.stringify(['a']), JSON.stringify(withJunk));
}

/* ---------- 6. 墓碑上限：保留最近的 ---------- */
{
  const many = Array.from({ length: DELETED_LIMIT + 50 }, (_, i) => 'id' + i);
  const merged = mergeDeleted(many, []);
  check(`墓碑上限 ${DELETED_LIMIT}：超出部分从最早丢`, merged.length === DELETED_LIMIT && merged[merged.length - 1] === 'id' + (DELETED_LIMIT + 49), `长度 ${merged.length}`);
}

/* ---------- 7. mergeSnapshot：整条链路（借书签/收藏字段一起带上） ---------- */
{
  const local = { libraries: [], favorites: [], history: [h('keep', T0 + 1000)], deletedHistory: ['gone'] };
  const remote = { libraries: [], favorites: [], history: [h('gone', T0 + 2000), h('keep', T0 + 1000)], deletedHistory: [] };
  const out = mergeSnapshot(local, remote);
  check('mergeSnapshot：已删记录不出现', out.history.every((x) => x.jobId !== 'gone'), JSON.stringify(out.history.map((x) => x.jobId)));
  check('mergeSnapshot：墓碑被带出来（供推送）', JSON.stringify(out.deletedHistory) === JSON.stringify(['gone']));
}

/* ---------- 8. 另一台设备删的，本机也要认 ---------- */
{
  const local = { libraries: [], favorites: [], history: [h('x', T0)], deletedHistory: [] };
  const remote = { libraries: [], favorites: [], history: [], deletedHistory: ['x'] };
  const out = mergeSnapshot(local, remote);
  check('云端墓碑生效：本机旧副本被清掉', out.history.length === 0 && out.deletedHistory.includes('x'));
}

/* ---------- 9. 老数据没有 deletedHistory 字段也不崩 ---------- */
{
  const out = mergeSnapshot({ libraries: [], favorites: [], history: [h('a', T0)] }, { libraries: [], favorites: [], history: [] });
  check('老快照没有墓碑字段 → 不报错、行为不变', out.history.length === 1 && Array.isArray(out.deletedHistory));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
for (const f of failed) console.log('   FAILED:', f.name, f.detail ? '— ' + f.detail : '');
process.exit(failed.length ? 1 : 0);
