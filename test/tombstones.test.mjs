/**
 * 删除墓碑测试（课文库 / 课文 / 收藏）。
 *
 * 为什么值得单独一个文件：这三类删除原来**没有任何墓碑**，而云同步的合并是并集 ——
 * 实测"删掉一篇课文 → 与云端旧快照合并 → 课文回来"，「清空收藏」也一样被整批回滚。
 * 历史早就修过同一个坑（见 historyDelete.test.mjs），这里是把它推广到另外三类之后的防线。
 *
 * 跑法：node test/tombstones.test.mjs
 */
import {
  DELETED_FAVORITES_LIMIT, DELETED_LIBRARIES_LIMIT, DELETED_LESSONS_LIMIT,
  applyLibraryTombstones, mergeDeleted, mergeSnapshot,
} from '../src/syncMerge.js';
import { lessonTombstoneKey } from '../src/storage.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('=== 删除墓碑测试 ===\n');

const lesson = (lid, title) => ({ book: 'my', lid, lesson: 1, title_cn: title, chinese: '中' + lid, english: 'en', source: '自建', createdAt: 1 });
const lib = (id, lessons) => ({ id, name: '库' + id, createdAt: 1, lessons });
const fav = (id) => ({ id, kind: '核心词', title: id, body: '', createdAt: 1 });
const emptyLocal = (over = {}) => ({ libraries: [], favorites: [], history: [], deletedHistory: [], ...over });

/* ---------- 1. 课文库删除不被复活 ---------- */
{
  const local = emptyLocal({ libraries: [], deletedLibraries: ['lib-1'] });           // 用户已删掉整个库
  const remote = { libraries: [lib('lib-1', [lesson('lsn-a', 'A')])], favorites: [], history: [] };
  const r = mergeSnapshot(local, remote);
  check('删掉整个课文库后，同步不会把它并回来', r.libraries.length === 0, `len=${r.libraries.length}`);
  check('墓碑被带出来（供推送给其它设备）', r.deletedLibraries.includes('lib-1'));
}

/* ---------- 2. 单篇课文删除不被复活 ---------- */
{
  const key = lessonTombstoneKey('lib-1', 'lsn-a');
  const local = emptyLocal({ libraries: [lib('lib-1', [lesson('lsn-b', 'B')])], deletedLessons: [key] });
  const remote = { libraries: [lib('lib-1', [lesson('lsn-a', 'A'), lesson('lsn-b', 'B')])], favorites: [], history: [] };
  const r = mergeSnapshot(local, remote);
  const lids = r.libraries[0].lessons.map((l) => l.lid);
  check('删掉的课文不会被并回来', !lids.includes('lsn-a'), lids.join(','));
  check('同库里没删的课文照常在（墓碑没有误伤）', lids.includes('lsn-b'), lids.join(','));
}

/* ---------- 3. 收藏删除 / 清空不被复活 ---------- */
{
  const local = emptyLocal({ favorites: [], deletedFavorites: ['f1', 'f2'] });
  const remote = { libraries: [], favorites: [fav('f1'), fav('f2'), fav('f3')], history: [] };
  const r = mergeSnapshot(local, remote);
  const ids = r.favorites.map((f) => f.id);
  check('取消收藏 / 清空收藏后，同步不会把它们并回来', !ids.includes('f1') && !ids.includes('f2'), ids.join(','));
  check('没删过的收藏照常并进来', ids.includes('f3'), ids.join(','));
}

/* ---------- 4. 墓碑只增不减：两边都删过也要取并集 ---------- */
{
  const r = mergeDeleted(['a', 'b'], ['b', 'c']);
  check('墓碑合并取并集并去重', JSON.stringify([...r].sort()) === JSON.stringify(['a', 'b', 'c']), r.join(','));
}

/* ---------- 5. 墓碑堆满时，本机新墓碑不能被远端挤掉 ---------- */
{
  // 这是修复前的真实缺陷：`[...local, ...remote].slice(-limit)` 会把排在队首的本机条目挤掉，
  // 于是"刚删的那条"在下一次同步里又活了回来。
  const remote = Array.from({ length: DELETED_FAVORITES_LIMIT }, (_, i) => 'r' + i);
  const r = mergeDeleted(['just-deleted'], remote, DELETED_FAVORITES_LIMIT);
  check('远端墓碑堆满时，本机刚删的那条仍在', r.includes('just-deleted'), `len=${r.length}`);
  check('总数不超过上限', r.length <= DELETED_FAVORITES_LIMIT, `len=${r.length}`);
}

/* ---------- 6. 老快照（没有这三个字段）不能炸、行为不变 ---------- */
{
  const local = emptyLocal({ libraries: [lib('lib-1', [lesson('lsn-a', 'A')])], favorites: [fav('f1')] });
  const remote = { libraries: [lib('lib-1', [lesson('lsn-b', 'B')])], favorites: [fav('f2')], history: [] };
  const r = mergeSnapshot(local, remote);
  check('老快照合并照常工作', r.libraries[0].lessons.length === 2 && r.favorites.length === 2, `lessons=${r.libraries[0].lessons.length} favs=${r.favorites.length}`);
  check('缺字段时墓碑默认为空数组', Array.isArray(r.deletedLibraries) && r.deletedLibraries.length === 0);
}

/* ---------- 7. 墓碑过滤器本身 ---------- */
{
  const libs = [lib('lib-1', [lesson('lsn-a', 'A'), lesson('lsn-b', 'B')]), lib('lib-2', [lesson('lsn-c', 'C')])];
  const out = applyLibraryTombstones(libs, ['lib-2'], [lessonTombstoneKey('lib-1', 'lsn-a')]);
  check('过滤器：整库 + 单课同时生效', out.length === 1 && out[0].lessons.length === 1 && out[0].lessons[0].lid === 'lsn-b',
    JSON.stringify(out.map((l) => [l.id, l.lessons.map((x) => x.lid)])));
  check('过滤器不改动原数组（纯函数）', libs[0].lessons.length === 2);
  check('没有 lid 的课文不会被误删', applyLibraryTombstones([lib('lib-1', [{ book: 'my', lid: '', lesson: 1 }])], [], ['lib-1|'])[0].lessons.length === 1);
}

/* ---------- 8. 上限常量与 storage 侧一致 ---------- */
{
  check('三类上限都是正数且量级合理',
    DELETED_LIBRARIES_LIMIT === 200 && DELETED_LESSONS_LIMIT === 1000 && DELETED_FAVORITES_LIMIT === 1000,
    `${DELETED_LIBRARIES_LIMIT}/${DELETED_LESSONS_LIMIT}/${DELETED_FAVORITES_LIMIT}`);
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
