/** 账号云同步：登录会话访问账号快照，旧码仅留作升级迁移凭据。 */
import { readAccountChanges, patchAccountData } from './api.js';
import { mergeSnapshot, mergeHistory } from './syncMerge.js';
import { applySnapshotPatch, diffSnapshot, snapshotData } from './syncDelta.js';

const CODE_KEY = 'bt-sync-code';
const META_KEY = 'bt-sync-meta';
// 与服务端 SNAPSHOT_LIMITS 同值（server/sync.mjs）。推送前先把超限条目摘掉：
// 服务端对单条超限的收藏/历史是**静默丢弃**的——不摘的话该条目每次同步都会
// 推上去又被丢掉（无限空推新版本），而且换设备登录后它就永久丢了。
const SYNC_FAVORITE_BYTES = 20000;
const SYNC_HISTORY_BYTES = 2000;
const jsonBytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
/** 摘掉单条体积超限的条目（本地保留，只是不参与云同步）。返回各集合被摘掉的条数。 */
function dropOversized(data) {
  const dropped = { favorites: 0, history: 0 };
  if (Array.isArray(data.favorites)) {
    const kept = data.favorites.filter((f) => jsonBytes(f) <= SYNC_FAVORITE_BYTES);
    dropped.favorites = data.favorites.length - kept.length;
    data.favorites = kept;
  }
  if (Array.isArray(data.history)) {
    const kept = data.history.filter((h) => jsonBytes(h) <= SYNC_HISTORY_BYTES);
    dropped.history = data.history.length - kept.length;
    data.history = kept;
  }
  return dropped;
}

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

export async function syncOnce({ token, local, device, baseline, maxAttempts = 3 }) {
  if (!token) return { ok: false, error: '请先登录账号' };
  // A baseline belongs to one login session. First access (or a compacted journal) restores a full snapshot.
  let remote = baseline?.token === token ? baseline : null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await readAccountChanges(token, remote?.version ?? -1);
    if (response.mode === 'full') remote = { token, version: response.version, data: snapshotData(response.data) };
    else {
      if (!remote) throw new Error('同步基线不存在，请重新同步');
      for (const frame of response.changes || []) {
        if (frame.version !== remote.version + 1) throw new Error('同步版本不连续，请刷新页面');
        remote = { ...remote, version: frame.version, data: applySnapshotPatch(remote.data, frame.ops) };
      }
      if (remote.version !== response.version) throw new Error('同步版本不正确，请刷新页面');
    }
    const payload = mergeSnapshot(local, remote.data);
    const data = snapshotData(payload);
    // The UI displays only 20 jobs; that display limit must not repeatedly delete the server archive.
    data.history = mergeHistory(payload.history, remote.data.history, 200, payload.deletedHistory);
    const dropped = dropOversized(data);
    const ops = diffSnapshot(remote.data, data);
    if (!ops.length) return { ok: true, version: remote.version, merged: payload, baseline: remote,
      added: payload.added, legacyPending: response.legacyPending, dropped };
    const r = await patchAccountData(token, {
      baseVersion: remote.version,
      device: device || deviceId(),
      ops,
    });
    if (r.ok) {
      remote = { token, version: r.data.version, data: applySnapshotPatch(remote.data, r.data.ops) };
      return { ok: true, version: remote.version, merged: mergeSnapshot(payload, remote.data), baseline: remote,
        added: payload.added, legacyPending: response.legacyPending, dropped };
    }
    if (r.status === 409) continue;
    return { ok: false, error: (r.data && r.data.error) || ('同步失败：HTTP ' + r.status) };
  }
  return { ok: false, error: '云端数据变动频繁，请稍后再试' };
}
