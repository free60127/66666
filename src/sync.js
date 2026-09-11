/**
 * 云同步（同步码）。
 *
 * 模型：一串 32 位同步码 → 云端一份快照（课文库 / 收藏夹 / 历史）。
 * 多设备用同一串码即互通；合并逻辑复用「导入备份」那一套（按 id 合并、同名去重），
 * 所以同步是**合并**而不是覆盖，两台设备都改过也不会丢东西。
 *
 * 冲突处理：推送带 baseVersion 做乐观锁，服务端版本对不上就返回 409 + 云端最新数据，
 * 这里拿到后重新合并再推一次（最多 3 轮）。
 *
 * 安全：同步码本身就是凭证（拿到的人可读写），按密码对待，不要外传。
 */
import { createSyncCode, pullCloudSync, pushCloudSync } from './api.js';
import { mergeFavorites } from './favorites.js';
import { mergeLibraries } from './lessonLibrary.js';

const CODE_KEY = 'bt-sync-code';
const META_KEY = 'bt-sync-meta';
export const HISTORY_LIMIT = 20;

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

/** 历史记录合并：按 jobId 去重、按时间倒序、只留最近 N 条。 */
export function mergeHistory(localHistory, remoteHistory, limit = HISTORY_LIMIT) {
  const seen = new Set();
  const merged = [];
  const all = [...(Array.isArray(localHistory) ? localHistory : []), ...(Array.isArray(remoteHistory) ? remoteHistory : [])];
  for (const item of all) {
    if (!item || !item.jobId || seen.has(item.jobId)) continue;
    seen.add(item.jobId);
    merged.push(item);
  }
  return merged.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0)).slice(0, limit);
}

/**
 * 把云端快照合并进本地数据。纯函数，不碰存储。
 * @returns {{libraries, favorites, history, added: {libsAdded, lessonsAdded, favAdded, histAdded}}}
 */
export function mergeSnapshot(local, remote) {
  const { list: libraries, libsAdded, lessonsAdded } = mergeLibraries(local.libraries, remote && remote.libraries);
  const { merged: favorites, added: favAdded } = mergeFavorites((remote && remote.favorites) || [], local.favorites);
  const history = mergeHistory(local.history, remote && remote.history);
  return {
    libraries,
    favorites,
    history,
    added: {
      libsAdded,
      lessonsAdded,
      favAdded,
      histAdded: Math.max(0, history.length - (Array.isArray(local.history) ? local.history.length : 0)),
    },
  };
}

/** 生成一个新同步码并在云端建好空槽位。 */
export async function createNewSyncCode() {
  const r = await createSyncCode();
  if (!r || !r.code) throw new Error('服务器未返回同步码，请重试');
  return r.code;
}

/**
 * 与云端做一次双向同步：拉取 → 合并 → 推送（冲突自动重试）。
 * @returns {Promise<{ok: boolean, error?: string, version?: number, merged?: object, added?: object}>}
 */
export async function syncOnce({ code, local, device, maxAttempts = 3 }) {
  if (!code) return { ok: false, error: '还没有同步码' };
  let remote;
  try {
    remote = await pullCloudSync(code);
  } catch (e) {
    // 404 = 云端没有这串码：免费托管重新部署会清空磁盘，是最常见的原因。
    // 这和"网络故障"必须分开报，否则用户会以为是自己填错了码。
    if (e && e.status === 404) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        error: '云端找不到这串同步码的数据（服务端可能重新部署过）。本机数据不受影响，重新生成同步码即可恢复。',
      };
    }
    throw e;
  }
  let baseVersion = remote.version;
  let payload = mergeSnapshot(local, remote.data);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const r = await pushCloudSync(code, {
      baseVersion,
      device: device || deviceId(),
      data: { libraries: payload.libraries, favorites: payload.favorites, history: payload.history },
    });
    if (r.ok) return { ok: true, version: r.data.version, merged: payload, added: payload.added };
    if (r.status === 404) {
      return { ok: false, code: 'NOT_FOUND', error: '云端找不到这串同步码的数据（服务端可能重新部署过）' };
    }
    if (r.status === 409 && r.data) {
      // 其它设备抢先写了：拿云端最新数据重新合并后再推
      baseVersion = r.data.version;
      payload = mergeSnapshot({ libraries: payload.libraries, favorites: payload.favorites, history: payload.history }, r.data.data);
      continue;
    }
    return { ok: false, error: (r.data && r.data.error) || ('同步失败：HTTP ' + r.status) };
  }
  return { ok: false, error: '云端数据变动频繁，请稍后再试' };
}
