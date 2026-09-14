/**
 * 云同步 / 备份导入的**纯合并函数**（不碰网络、不碰 localStorage）。
 *
 * 为什么单独成文件：这些逻辑是整个同步里最容易出错、也最该被测试的部分，
 * 而 `sync.js` 依赖 `api.js`（用了 Vite 专有的 `import.meta.env`），在纯 Node 里根本 import 不进来 ——
 * 于是最该测的代码反而没法测。拆出来之后 `test/historyDelete.test.mjs` 可以直接断言。
 *
 * `sync.js` 会把这些再导出一次，所以调用方（App.jsx / hooks）不用改 import 路径。
 */
import { mergeFavorites } from './favorites.js';
import { mergeLibraries } from './lessonLibrary.js';
import { mergeProgress } from './lessonProgress.js';
import { mergeDays } from './studyStreak.js';
import {
  DELETED_FAVORITES_MAX, DELETED_LIBRARIES_MAX, DELETED_LESSONS_MAX, lessonTombstoneKey,
} from './storage.js';

export const HISTORY_LIMIT = 20;
export const DELETED_LIMIT = 500;
/** 三类新增墓碑的上限与 storage.js 保持一致（改一处就够） */
export const DELETED_LIBRARIES_LIMIT = DELETED_LIBRARIES_MAX;
export const DELETED_LESSONS_LIMIT = DELETED_LESSONS_MAX;
export const DELETED_FAVORITES_LIMIT = DELETED_FAVORITES_MAX;

/**
 * 历史记录合并：按 jobId 去重、按时间倒序、只留最近 N 条。
 * @param {string[]} deletedIds 墓碑（已删除的作业号）：这些一律不并回来。
 *   没有这道过滤，用户删掉的记录会在下一次同步时被云端的旧副本"复活"。
 */
export function mergeHistory(localHistory, remoteHistory, limit = HISTORY_LIMIT, deletedIds = []) {
  const dead = deletedIds instanceof Set ? deletedIds : new Set(Array.isArray(deletedIds) ? deletedIds : []);
  const seen = new Set();
  const merged = [];
  const all = [...(Array.isArray(localHistory) ? localHistory : []), ...(Array.isArray(remoteHistory) ? remoteHistory : [])];
  for (const item of all) {
    if (!item || !item.jobId || seen.has(item.jobId) || dead.has(item.jobId)) continue;
    seen.add(item.jobId);
    merged.push(item);
  }
  return merged.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0)).slice(0, limit);
}

/**
 * 墓碑合并：两边并集（删除是不可逆操作，取并集才不会"复活"）。
 *
 * ⚠️ 超限时的取舍：**本机的墓碑一条都不能丢**。
 * 原来是 `[...local, ...remote].slice(-limit)` —— 本机条目排在最前面，一旦远端墓碑
 * 已经堆到上限，本机刚删的那条会被直接从队首挤掉；被挤掉的墓碑随后又会被推回云端，
 * 于是"本机删了、云端还留着"，那条记录下次同步照样复活。
 * 现在的规则：先全额保留本机，剩余名额留给远端（远端也优先保留更新的那批）。
 */
export function mergeDeleted(localDeleted, remoteDeleted, limit = DELETED_LIMIT) {
  const uniq = (arr) => {
    const out = [];
    const seen = new Set();
    for (const id of Array.isArray(arr) ? arr : []) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const local = uniq(localDeleted).slice(-limit);
  const seen = new Set(local);
  const room = Math.max(0, limit - local.length);
  const remote = uniq(remoteDeleted).filter((id) => !seen.has(id));
  return [...local, ...(room > 0 ? remote.slice(-room) : [])];
}

/**
 * 墓碑过滤：整库被删的、以及被单独删掉的课文，都不再从云端并回来。
 * 课文用 `libId|lid` 作键（lid 是稳定 id：改标题、改序号都不变，所以墓碑不会失效）。
 */
export function applyLibraryTombstones(libraries, deletedLibraries, deletedLessons) {
  const deadLibs = new Set(Array.isArray(deletedLibraries) ? deletedLibraries : []);
  const deadLessons = new Set(Array.isArray(deletedLessons) ? deletedLessons : []);
  return (Array.isArray(libraries) ? libraries : [])
    .filter((lib) => lib && !deadLibs.has(lib.id))
    .map((lib) => {
      const lessons = Array.isArray(lib.lessons) ? lib.lessons : [];
      // 没有 lid 的课文（极老的数据）不参与墓碑匹配：空 key（"lib-1|"）要是能命中，
      // 一条脏墓碑就能把整个库里所有无 lid 的课文一次性删光。宁可漏删，不可误删。
      const kept = lessons.filter((l) => !l.lid || !deadLessons.has(lessonTombstoneKey(lib.id, l.lid)));
      return kept.length === lessons.length ? lib : { ...lib, lessons: kept };
    });
}

/**
 * 把云端快照合并进本地数据。纯函数，不碰存储。
 * @returns {{libraries, favorites, history, deletedHistory, added: {...}}}
 */
export function mergeSnapshot(local, remote) {
  // 墓碑先合并（本机优先），再拿它去过滤合并结果 —— 顺序不能反，
  // 否则"这次合并刚并回来的东西"会绕过墓碑。
  const deletedLibraries = mergeDeleted(local.deletedLibraries, remote && remote.deletedLibraries, DELETED_LIBRARIES_LIMIT);
  const deletedLessons = mergeDeleted(local.deletedLessons, remote && remote.deletedLessons, DELETED_LESSONS_LIMIT);
  const deletedFavorites = mergeDeleted(local.deletedFavorites, remote && remote.deletedFavorites, DELETED_FAVORITES_LIMIT);

  const { list: rawLibraries, libsAdded, lessonsAdded } = mergeLibraries(local.libraries, remote && remote.libraries);
  const libraries = applyLibraryTombstones(rawLibraries, deletedLibraries, deletedLessons);
  // 收藏合并会把「复习进度（ease/interval/due/reps）」一起并过来：同一张卡在两台设备上都复习过时，
  // 以复习得更新的那份为准 —— 否则后同步的那台会把另一台的进度顶掉。
  const { merged: rawFavorites, added: favAdded, updated: favUpdated } = mergeFavorites((remote && remote.favorites) || [], local.favorites);
  const deadFavorites = new Set(deletedFavorites);
  const favorites = rawFavorites.filter((f) => f && !deadFavorites.has(f.id));

  const deletedHistory = mergeDeleted(local.deletedHistory, remote && remote.deletedHistory);
  const history = mergeHistory(local.history, remote && remote.history, HISTORY_LIMIT, deletedHistory);
  const progress = mergeProgress(local.progress, remote && remote.progress);
  const days = mergeDays(local.days, remote && remote.days);
  return {
    libraries,
    favorites,
    history,
    deletedHistory,
    deletedLibraries,
    deletedLessons,
    deletedFavorites,
    progress,
    days,
    added: {
      libsAdded,
      lessonsAdded,
      favAdded,
      favUpdated: favUpdated || 0,
      histAdded: Math.max(0, history.length - (Array.isArray(local.history) ? local.history.length : 0)),
    },
  };
}
