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

export const HISTORY_LIMIT = 20;
export const DELETED_LIMIT = 500;

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

/** 墓碑合并：两边并集，保留最近 DELETED_LIMIT 条（删除是不可逆操作，取并集才不会"复活"）。 */
export function mergeDeleted(localDeleted, remoteDeleted, limit = DELETED_LIMIT) {
  const out = [];
  const seen = new Set();
  for (const id of [...(Array.isArray(localDeleted) ? localDeleted : []), ...(Array.isArray(remoteDeleted) ? remoteDeleted : [])]) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(-limit);
}

/**
 * 把云端快照合并进本地数据。纯函数，不碰存储。
 * @returns {{libraries, favorites, history, deletedHistory, added: {...}}}
 */
export function mergeSnapshot(local, remote) {
  const { list: libraries, libsAdded, lessonsAdded } = mergeLibraries(local.libraries, remote && remote.libraries);
  // 收藏合并会把「复习进度（ease/interval/due/reps）」一起并过来：同一张卡在两台设备上都复习过时，
  // 以复习得更新的那份为准 —— 否则后同步的那台会把另一台的进度顶掉。
  const { merged: favorites, added: favAdded, updated: favUpdated } = mergeFavorites((remote && remote.favorites) || [], local.favorites);
  const deletedHistory = mergeDeleted(local.deletedHistory, remote && remote.deletedHistory);
  const history = mergeHistory(local.history, remote && remote.history, HISTORY_LIMIT, deletedHistory);
  const progress = mergeProgress(local.progress, remote && remote.progress);
  return {
    libraries,
    favorites,
    history,
    deletedHistory,
    progress,
    added: {
      libsAdded,
      lessonsAdded,
      favAdded,
      favUpdated: favUpdated || 0,
      histAdded: Math.max(0, history.length - (Array.isArray(local.history) ? local.history.length : 0)),
    },
  };
}
