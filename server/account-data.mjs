/** 学习数据以 userId 为主键；旧同步码仅用于一次性认领，迁移可重试且不会覆盖已有数据。 */
import { createHash, webcrypto } from 'node:crypto';
import { emptySnapshot, isValidSyncCode, sanitizeSnapshot, SNAPSHOT_LIMITS, MAX_SNAPSHOT_BYTES } from './sync.mjs';
import { mergeSnapshot, mergeHistory, applyLibraryTombstones } from '../src/syncMerge.js';
import { applySnapshotPatch, diffSnapshot } from '../src/syncDelta.js';

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
  // Bound the process cache; Redis remains authoritative through atomic version checks.
  const cache = new Map();
  let cacheBytes = 0;
  const remember = (id, doc) => {
    if (cache.has(id)) { cacheBytes -= cache.get(id).bytes; cache.delete(id); }
    const bytes = Buffer.byteLength(JSON.stringify(doc || null));
    if (!doc || doc.deleted || bytes > 2.5 * 1024 * 1024) return;
    cache.set(id, { doc, bytes, at: Date.now() }); cacheBytes += bytes;
    while (cache.size > 64 || cacheBytes > 16 * 1024 * 1024) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
    }
  };
  const cached = (id) => {
    const item = cache.get(id);
    if (!item || Date.now() - item.at > 10 * 60 * 1000) return null;
    cache.delete(id); cache.set(id, item);
    return item.doc;
  };
  const applyFrames = (doc, result) => {
    let next = doc || { version: 0, data: emptySnapshot() };
    for (const frame of result.frames || []) {
      if (frame.version !== next.version + 1) throw new Error('云端增量版本不连续');
      next = { ...next, version: frame.version, data: applySnapshotPatch(next.data, JSON.parse(frame.opsRaw)) };
    }
    if (next.version !== result.version) throw new Error('云端增量版本不正确');
    return { ...next, updatedAt: result.updatedAt };
  };
  return {
    async read(userId) { return { ok: true, ...publicDoc(await store.read(userId)) }; },
    async readChanges(userId, since) {
      if (!Number.isSafeInteger(since) || since < -1) return fail(400, '数据版本不正确');
      const result = await store.readChanges(userId, since);
      if (result.kind === 'full') {
        remember(userId, result.doc);
        return { ok: true, mode: 'full', ...publicDoc(result.doc) };
      }
      const previous = cached(userId);
      if ((previous?.version || 0) === since) remember(userId, applyFrames(previous, result));
      return { ok: true, mode: 'delta', version: result.version, updatedAt: result.updatedAt,
        changes: (result.frames || []).map((f) => ({ version: f.version, ops: JSON.parse(f.opsRaw) })) };
    },
    async patch(userId, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, '增量请求格式不正确');
      const { baseVersion, ops, device } = input;
      if (await kv.get(deletedKey(userId))) return fail(401, '账号已注销');
      if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) return fail(400, '数据版本不正确');
      let current = cached(userId);
      if (!current || current.version !== baseVersion) current = await store.read(userId);
      if (current?.deleted) return fail(401, '账号已注销');
      if ((current?.version || 0) !== baseVersion) return { ...fail(409, '其它设备已更新，请重新合并'), version: current?.version || 0 };
      let proposed;
      try { proposed = applySnapshotPatch(current?.data || emptySnapshot(), ops); }
      catch (error) { return fail(400, error.message); }
      const check = sanitizeSnapshot(proposed);
      if (!check.ok) return fail(413, check.error);
      // The patch is already based on this exact version; merging an old snapshot again would undo edits.
      const deadFavorites = new Set(check.data.deletedFavorites);
      const merged = { data: { ...check.data,
        libraries: applyLibraryTombstones(check.data.libraries, check.data.deletedLibraries, check.data.deletedLessons),
        favorites: check.data.favorites.filter((f) => !deadFavorites.has(f.id)),
        history: mergeHistory([], check.data.history, SNAPSHOT_LIMITS.history, check.data.deletedHistory) } };
      if (Buffer.byteLength(JSON.stringify(merged.data)) > MAX_SNAPSHOT_BYTES) return fail(413, '学习数据过大（上限 2MB）');
      const canonical = diffSnapshot(current?.data || emptySnapshot(), merged.data);
      if (!canonical.length) {
        const latest = await store.readChanges(userId, baseVersion);
        const version = latest.kind === 'full' ? latest.doc?.version || 0 : latest.version;
        if (version !== baseVersion) return { ...fail(409, '其它设备已更新，请重新合并'), version };
        remember(userId, current);
        return { ok: true, version: baseVersion, ops: [] };
      }
      const next = { ...current, version: baseVersion + 1, updatedAt: Date.now(),
        device: String(device || '').slice(0, 40), data: merged.data };
      let saved = await store.patch(userId, baseVersion, canonical, next);
      // Compact occasionally, instead of sending the full snapshot on every write.
      if (!saved.ok && saved.compact) {
        const compacted = await store.compareAndSwap(userId, baseVersion, current);
        if (compacted.ok) saved = await store.patch(userId, baseVersion, canonical, next);
      }
      if (!saved.ok) return saved.deleted ? fail(401, '账号已注销')
        : { ...fail(409, '其它设备已更新，请重新合并'), version: saved.version };
      remember(userId, next);
      if (saved.compact) {
        try { await store.compareAndSwap(userId, next.version, next); }
        catch { console.warn('账号增量日志整理暂未完成，将在下一次同步重试'); }
      }
      return { ok: true, version: next.version, updatedAt: next.updatedAt, ops: canonical };
    },
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
      if (cas.ok) remember(userId, next);
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
        if ((await store.compareAndSwap(userId, current?.version || 0, next)).ok) {
          remember(userId, next);
          return { ok: true, migrated: true, ...publicDoc(next) };
        }
      }
      return fail(503, '数据正在更新，请稍后再试；旧数据已保留');
    },
    async remove(userId) {
      await kv.set(deletedKey(userId), '1');
      remember(userId, null);
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
