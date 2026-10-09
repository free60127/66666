/** Optional real Redis transport test. Uses a unique, disposable namespace only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUpstashStore, emptySnapshot, sanitizeSnapshot } from '../server/sync.mjs';
import { createUpstashKv } from '../server/kv.mjs';
import { createAccountData } from '../server/account-data.mjs';
import { applySnapshotPatch, diffSnapshot } from '../src/syncDelta.js';

const config = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
assert.ok(config.url && config.token, 'Redis test requires private environment configuration');
const id = 'qa-delta-' + randomUUID();
const prefix = 'bts:qa-delta:' + id + ':';
const store = createUpstashStore({ ...config, prefix });
const kv = createUpstashKv(config);
const service = () => createAccountData({ kv, store, legacyStore: store });
const data = sanitizeSnapshot({ ...emptySnapshot(), libraries: [{ id: 'lib', name: 'QA', createdAt: 1,
  sections: [], lessons: Array.from({ length: 100 }, (_, i) => ({ lid: 'l-' + i, lesson: i + 1,
    title_cn: 'Test ' + i, english: 'English'.repeat(900), chinese: 'Test', createdAt: 1 })) }] }).data;
const originalFetch = globalThis.fetch;
let traffic = { calls: 0, uploadBytes: 0, downloadBytes: 0 };
globalThis.fetch = async (url, options) => {
  const response = await originalFetch(url, options);
  if (String(url).startsWith(config.url)) {
    traffic.calls += 1; traffic.uploadBytes += Buffer.byteLength(options.body || '');
    traffic.downloadBytes += Buffer.byteLength(await response.clone().text());
  }
  return response;
};
try {
  await store.write(id, { version: 1, updatedAt: 1, legacyCodes: ['test-legacy'], data });
  let manager = service();
  assert.equal((await manager.readChanges(id, -1)).mode, 'full');
  traffic = { calls: 0, uploadBytes: 0, downloadBytes: 0 };
  let current = data; let version = 1;
  for (let i = 0; i < 10; i += 1) {
    const next = structuredClone(current);
    next.progress['10|1'] = { n: i + 1, best: 90, last: 90, at: i + 1, ms: 10 };
    const previous = version;
    const result = await manager.patch(id, { baseVersion: version, ops: diffSnapshot(current, next) });
    assert.equal(result.ok, true); version = result.version;
    const read = await manager.readChanges(id, previous);
    assert.equal(read.mode, 'delta'); assert.equal(read.changes.length, 1);
    current = applySnapshotPatch(current, result.ops);
    assert.equal((await manager.readChanges(id, version)).changes.length, 0);
  }
  console.log(JSON.stringify({ snapshotBytes: Buffer.byteLength(JSON.stringify(data)), tenUpdates: traffic }));
  assert.ok(traffic.uploadBytes < 40000); assert.ok(traffic.downloadBytes < 15000);
  manager = service();
  const restored = await manager.readChanges(id, -1);
  assert.deepEqual(restored.data, current);
  assert.ok(Array.isArray(restored.data.favorites)); assert.deepEqual(restored.data.libraries[0].sections, []);
  const raceOps = [{ op: 'set', path: ['days'], value: ['2026-10-09'] }];
  const pair = await Promise.all([manager.patch(id, { baseVersion: version, ops: raceOps }), manager.patch(id, { baseVersion: version, ops: raceOps })]);
  assert.deepEqual(pair.map((r) => r.status || 200).sort(), [200, 409]);
  let doc = await store.read(id);
  for (let i = 0; i < 34; i += 1) {
    const result = await manager.patch(id, { baseVersion: doc.version,
      ops: [{ op: 'set', path: ['progress', '10|1', 'n'], value: doc.data.progress['10|1'].n + 1 }] });
    assert.equal(result.ok, true); doc = { ...doc, version: result.version, data: applySnapshotPatch(doc.data, result.ops) };
  }
  assert.equal((await manager.readChanges(id, 1)).mode, 'full');
  assert.equal(doc.data.progress['10|1'].n, 44); assert.deepEqual(doc.legacyCodes, ['test-legacy']);
  assert.equal((await store.read(id)).data.progress['10|1'].n, 44);
  const deletedData = structuredClone(doc.data); deletedData.deletedLessons = ['lib|l-0'];
  assert.equal((await manager.patch(id, { baseVersion: doc.version, ops: diffSnapshot(doc.data, deletedData) })).ok, true);
  assert.equal((await store.read(id)).data.libraries[0].lessons.length, 99);
  await manager.remove(id);
  assert.equal((await store.read(id)).deleted, true);
  console.log('PASS real Redis Lua: atomic delta, restart, empty arrays, compaction, tombstones and deletion');
} finally {
  globalThis.fetch = originalFetch;
  await store.remove(id);
  await kv.del('bts:user-data-deleted:' + id);
}
