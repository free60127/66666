/** 账号云同步：登录会话访问账号快照，旧码仅留作升级迁移凭据。 */
import { readAccountData, writeAccountData } from './api.js';
import { mergeSnapshot } from './syncMerge.js';

const CODE_KEY = 'bt-sync-code';
const META_KEY = 'bt-sync-meta';

export function loadSyncCode() {
  try { return localStorage.getItem(CODE_KEY) || ''; } catch { return ''; }
}
export function saveSyncCode(code) {
  try {
    if (code) localStorage.setItem(CODE_KEY, code);
    else localStorage.removeItem(CODE_KEY);
  } catch { /* ignore */ }
}
export function loadSyncMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch { return {}; }
}
export function saveSyncMeta(meta) {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta || {})); } catch { /* ignore */ }
}
/** 设备标识：只用来在同步记录里区分"最后是哪台设备写的"。 */
export function deviceId() {
  const meta = loadSyncMeta();
  if (meta.device) return meta.device;
  const id = Math.random().toString(36).slice(2, 10);
  saveSyncMeta({ ...meta, device: id });
  return id;
}

/* 纯合并函数已抽到 ./syncMerge.js —— 那个文件不依赖 api.js，可以在纯 Node 里被测试
   （sync.js 自己用了 Vite 专有的 import.meta.env，import 不进来）。
   这里再导出一次，调用方的 import 路径不用改。 */
export {
  DELETED_FAVORITES_LIMIT, DELETED_LIBRARIES_LIMIT, DELETED_LESSONS_LIMIT, DELETED_LIMIT,
  HISTORY_LIMIT, applyLibraryTombstones, mergeDeleted, mergeHistory, mergeSnapshot,
} from './syncMerge.js';

export async function syncOnce({ token, local, device, maxAttempts = 3 }) {
  if (!token) return { ok: false, error: '请先登录账号' };
  const remote = await readAccountData(token);
  let baseVersion = remote.version;
  let payload = mergeSnapshot(local, remote.data);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const r = await writeAccountData(token, {
      baseVersion,
      device: device || deviceId(),
      data: {
        libraries: payload.libraries,
        favorites: payload.favorites,
        history: payload.history,
        // 墓碑一起推上去：其它设备才会知道"这条已被删除"，否则它们本机的旧副本会把它并回来。
        // 四类都要推（历史 / 课文库 / 课文 / 收藏）—— 少推一类，那一类的删除就会在别的设备上复活。
        deletedHistory: payload.deletedHistory,
        deletedLibraries: payload.deletedLibraries || [],
        deletedLessons: payload.deletedLessons || [],
        deletedFavorites: payload.deletedFavorites || [],
        // 逐课进度：换设备也能看到"我练过哪些课"（历史只留 20 条，进度才是完整记录）
        progress: payload.progress || {},
        // 学习日期：连续天数跨设备一致
        days: payload.days || [],
      },
    });
    if (r.ok) return { ok: true, version: r.data.version, merged: mergeSnapshot(payload, r.data.data), added: payload.added, legacyPending: remote.legacyPending };
    if (r.status === 409 && r.data) {
      // 其它设备抢先写了：拿云端最新数据重新合并后再推
      baseVersion = r.data.version;
      payload = mergeSnapshot(
        {
          libraries: payload.libraries, favorites: payload.favorites, history: payload.history,
          deletedHistory: payload.deletedHistory,
          deletedLibraries: payload.deletedLibraries, deletedLessons: payload.deletedLessons, deletedFavorites: payload.deletedFavorites,
          progress: payload.progress, days: payload.days,
        },
        r.data.data,
      );
      continue;
    }
    return { ok: false, error: (r.data && r.data.error) || ('同步失败：HTTP ' + r.status) };
  }
  return { ok: false, error: '云端数据变动频繁，请稍后再试' };
}
