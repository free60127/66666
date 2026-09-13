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
export { DELETED_LIMIT, HISTORY_LIMIT, mergeDeleted, mergeHistory, mergeSnapshot } from './syncMerge.js';

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
  let recovered = false;
  try {
    remote = await pullCloudSync(code);
  } catch (e) {
    // 404 = 云端没有这串码。以前这里直接返回失败，把用户卡死：
    // 换过存储后端（或免费托管的临时磁盘被清）之后，老用户的码在云端就"不存在"了，
    // 但他们本机数据完好、每台设备用的是同一串码 —— 结果就是**两台设备都推不上去也拉不下来**，
    // 一直显示"云端找不到这串同步码"，怎么点都不动。
    //
    // 现在改成当成"空云端"继续走：本机数据会被推上去，把这串码在云端重建起来，
    // 其它设备下一次同步就自动恢复了（码不用换，别的设备什么都不用改）。
    //
    // 打错码的担忧不成立：手填新码时界面会先探一次（见 useExistingCode），
    // 不存在的码在输入那一刻就被拦下了，走不到这里。
    if (e && e.status === 404) {
      remote = { version: 0, updatedAt: 0, data: { libraries: [], favorites: [], history: [], deletedHistory: [] } };
      recovered = true;
    } else {
      throw e;
    }
  }
  let baseVersion = remote.version;
  let payload = mergeSnapshot(local, remote.data);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const r = await pushCloudSync(code, {
      baseVersion,
      device: device || deviceId(),
      data: {
        libraries: payload.libraries,
        favorites: payload.favorites,
        history: payload.history,
        // 墓碑一起推上去：其它设备才会知道"这条已被删除"，否则它们本机的旧副本会把它并回来
        deletedHistory: payload.deletedHistory,
      },
    });
    if (r.ok) return { ok: true, version: r.data.version, merged: payload, added: payload.added, recovered };
    if (r.status === 409 && r.data) {
      // 其它设备抢先写了：拿云端最新数据重新合并后再推
      baseVersion = r.data.version;
      recovered = false; // 已经有人在写这串码了，不算"重建"
      payload = mergeSnapshot(
        { libraries: payload.libraries, favorites: payload.favorites, history: payload.history, deletedHistory: payload.deletedHistory },
        r.data.data,
      );
      continue;
    }
    return { ok: false, error: (r.data && r.data.error) || ('同步失败：HTTP ' + r.status) };
  }
  return { ok: false, error: '云端数据变动频繁，请稍后再试' };
}
