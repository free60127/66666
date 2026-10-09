/** 学习数据以 userId 为主键；旧同步码仅用于一次性认领，迁移可重试且不会覆盖已有数据。 */
import { createHash, webcrypto } from 'node:crypto';
import { emptySnapshot, isValidSyncCode, sanitizeSnapshot, SNAPSHOT_LIMITS } from './sync.mjs';
import { mergeSnapshot, mergeHistory } from '../src/syncMerge.js';

const ownerKey = (code) => 'bts:legacy-owner:' + createHash('sha256').update(code).digest('hex');
const deletedKey = (userId) => 'bts:user-data-deleted:' + userId;
const fail = (status, error) => ({ ok: false, status, error });
const publicDoc = (doc) => ({ version: doc?.version || 0, updatedAt: doc?.updatedAt || 0, data: doc?.data || emptySnapshot() });

function mergeData(local, remote, historyLimit = SNAPSHOT_LIMITS.history) {
  const merged = mergeSnapshot(local || emptySnapshot(), remote || emptySnapshot());
  // 客户端的显示缓存只留 20 条历史；服务端保留完整限额，迁移不能因显示上限丢记录。
  merged.history = mergeHistory(local?.history, remote?.history, historyLimit, merged.deletedHistory);
  return sanitizeSnapshot(merged);
}

/** 只有用户登录时提供了正确密码，才能解开旧账号内保存的迁移凭据。密码不保存。 */
export async function openLegacySync(box, password) {
  try {
    if (!box?.salt || !box?.iv || !box?.c) return '';
    const source = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(box.salt, 'base64'), iterations: 210000, hash: 'SHA-256' }, source, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const bytes = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(box.iv, 'base64') }, key, Buffer.from(box.c, 'base64'));
    const code = new TextDecoder().decode(bytes);
    return isValidSyncCode(code) ? code : '';
  } catch { return ''; }
}

export function createAccountData({ kv, store, legacyStore }) {
  return {
    async read(userId) { return { ok: true, ...publicDoc(await store.read(userId)) }; },
    async write(userId, { baseVersion, data, device }) {
      if (await kv.get(deletedKey(userId))) return fail(401, '账号已注销');
      if (!Number.isInteger(baseVersion) || baseVersion < 0) return fail(400, '数据版本不正确');
      const check = sanitizeSnapshot(data);
      if (!check.ok) return fail(413, check.error);
      const current = await store.read(userId);
      if (current?.deleted) return fail(401, '账号已注销');
      if ((current?.version || 0) !== baseVersion) return { ...fail(409, '其它设备已更新，请重新合并'), ...publicDoc(current) };
      const merged = mergeData(check.data, current?.data);
      if (!merged.ok) return fail(413, merged.error);
      const next = { ...current, version: baseVersion + 1, updatedAt: Date.now(), device: String(device || '').slice(0, 40), data: merged.data };
      const cas = await store.compareAndSwap(userId, baseVersion, next);
      return cas.ok ? { ok: true, ...publicDoc(next) } : { ...fail(409, '其它设备已更新，请重新合并'), ...publicDoc(cas.current) };
    },
    async migratedOwner(code) { return kv.get(ownerKey(code)); },
    async migrate(userId, code) {
      if (await kv.get(deletedKey(userId))) return fail(401, '账号已注销');
      if (!isValidSyncCode(code)) return fail(400, '旧数据凭据格式不正确');
      let legacy = await legacyStore.read(code);
      if (!legacy) return fail(404, '没有找到旧云端数据；本机数据仍可同步到账号');
      await kv.setNx(ownerKey(code), userId);
      if (await kv.get(ownerKey(code)) !== userId) return fail(409, '这份旧数据已归入另一个账号，请使用原账号登录');
      // 先原子冻结旧槽位，防止迁移期间旧客户端写入导致漏数据；保留原快照便于失败后重试。
      for (let attempt = 0; !legacy.migratedTo && attempt < 10; attempt += 1) {
        const frozen = { ...legacy, version: legacy.version + 1, migratedTo: userId };
        const cas = await legacyStore.compareAndSwap(code, legacy.version, frozen);
        legacy = cas.ok ? frozen : cas.current;
        if (!legacy) return fail(503, '旧数据暂时不可读取，请稍后重试');
      }
      if (legacy.migratedTo !== userId) return fail(503, '旧数据仍在更新，请稍后重试');
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const current = await store.read(userId);
        if (current?.deleted) return fail(401, '账号已注销');
        if (current?.legacyCodes?.includes(code)) return { ok: true, migrated: true, ...publicDoc(current) };
        // 首次迁移超出容量时明确报错并保留源数据，不静默截断历史。
        const merged = mergeData(current?.data, legacy.data, Number.MAX_SAFE_INTEGER);
        if (!merged.ok) return fail(413, merged.error);
        const next = { ...current, version: (current?.version || 0) + 1, updatedAt: Date.now(), data: merged.data,
          legacyCodes: [...(current?.legacyCodes || []), code] };
        if ((await store.compareAndSwap(userId, current?.version || 0, next)).ok) return { ok: true, migrated: true, ...publicDoc(next) };
      }
      return fail(503, '数据正在更新，请稍后再试；旧数据已保留');
    },
    async remove(userId) {
      await kv.set(deletedKey(userId), '1');
      // 原子写空的注销标记，阻止注销前已通过鉴权的迟到请求把数据重新写回来。
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const doc = await store.read(userId);
        for (const code of doc?.legacyCodes || []) await legacyStore.remove(code);
        const removed = { version: (doc?.version || 0) + 1, updatedAt: Date.now(), deleted: true, data: emptySnapshot() };
        if ((await store.compareAndSwap(userId, doc?.version || 0, removed)).ok) return;
      }
      throw new Error('数据删除暂未完成，请重试');
      // 认领记录保留为不可复用标记，防止注销后旧凭据被重新认领。
    },
  };
}
