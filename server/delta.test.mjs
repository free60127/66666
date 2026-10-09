import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileKv } from './kv.mjs';
import { createFileStore, emptySnapshot, sanitizeSnapshot } from './sync.mjs';
import { createAccountData } from './account-data.mjs';
import { applySnapshotPatch, diffSnapshot, materializeDocument } from '../src/syncDelta.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-delta-'));
const store = createFileStore(path.join(dir, 'data'));
const kv = createFileKv(path.join(dir, 'kv'));
const manager = () => createAccountData({ kv, store, legacyStore: createFileStore(path.join(dir, 'legacy')) });
const sample = sanitizeSnapshot({ ...emptySnapshot(), libraries: [{ id: 'lib', name: '大课文库', createdAt: 1,
  sections: ['组一', '空组'], sectionsUpdatedAt: 1, lessons: Array.from({ length: 100 }, (_, i) => ({
    lid: 'lsn-' + i, lesson: i + 1, title_cn: '课文' + i, chinese: '中文段落'.repeat(300), english: 'English '.repeat(300).trim(),
    createdAt: 1, section: '组一' })) }], history: Array.from({ length: 80 }, (_, i) => ({ jobId: 'job-' + (79 - i), time: 79 - i })) }).data;
const copy = (x) => structuredClone(x);
if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe cleanup path');
try {
  await store.write('u', { version: 1, updatedAt: 1, legacyCodes: ['legacy'], data: sample });
  let service = manager();
  const initial = await service.readChanges('u', -1);
  assert.equal(initial.mode, 'full'); assert.deepEqual(initial.data, sample);
  const next = copy(sample);
  next.progress['10|1'] = { n: 1, best: 90, last: 90, at: 2, ms: 30 };
  const ops = diffSnapshot(sample, next);
  assert.ok(JSON.stringify(ops).length < 300);
  assert.deepEqual(applySnapshotPatch(sample, ops), next);
  const first = await service.patch('u', { baseVersion: 1, ops });
  assert.equal(first.version, 2); assert.equal(first.data, undefined);
  assert.deepEqual((await store.read('u')).data, next);
  const changes = await service.readChanges('u', 1);
  assert.equal(changes.mode, 'delta'); assert.equal(changes.changes.length, 1);
  assert.ok(JSON.stringify(changes).length < 600);
  assert.equal(JSON.stringify(changes).includes('English'), false);
  assert.equal((await service.readChanges('u', 2)).changes.length, 0);
  const noChange = await service.patch('u', { baseVersion: 2, ops: [] });
  assert.equal(noChange.version, 2);
  console.log('PASS 大课文库仅更新进度时读写增量均小于 600 字节，无变化不增加版本');

  service = manager(); // restart loses the server cache, not the journal or data
  const edited = copy(next);
  edited.libraries[0].lessons[0].title_cn = '修改标题';
  edited.libraries[0].lessons[0].chinese = '';
  edited.libraries[0].lessons[0].createdAt = 3;
  const pair = await Promise.all([service.patch('u', { baseVersion: 2, ops: diffSnapshot(next, edited) }),
    service.patch('u', { baseVersion: 2, ops: diffSnapshot(next, edited) })]);
  assert.deepEqual(pair.map((x) => x.status || 200).sort(), [200, 409]);
  assert.equal((await store.read('u')).data.libraries[0].lessons[0].title_cn, '修改标题');
  assert.equal((await store.read('u')).data.libraries[0].lessons[0].chinese, '');
  assert.equal((await store.read('u')).data.history.length, 80);
  console.log('PASS 进程重启恢复增量；并发同版本只有一次成功；课文编辑及历史保留');

  let current = (await store.read('u')).data;
  const removed = copy(current);
  removed.deletedLessons = ['lib|lsn-0'];
  removed.deletedFavorites = ['fav-dead'];
  removed.deletedHistory = ['job-79'];
  const removal = await service.patch('u', { baseVersion: 3, ops: diffSnapshot(current, removed) });
  assert.equal(removal.ok, true);
  current = (await store.read('u')).data;
  assert.equal(current.libraries[0].lessons.length, 99);
  assert.equal(current.history.length, 79);
  assert.deepEqual(current.deletedFavorites, ['fav-dead']);
  assert.deepEqual(current.libraries[0].sections, ['组一', '空组']);
  console.log('PASS 墓碑删除与空分组通过增量同步，未修改课文和历史不丢失');

  const version = (await store.read('u')).version;
  for (const bad of [
    [{ op: 'set', path: ['progress', '__proto__', 'polluted'], value: true }],
    [{ op: 'set', path: ['libraries', 500, 'name'], value: '坏' }],
    [{ op: 'splice', path: ['libraries'], index: -1, deleteCount: 0, items: [] }],
    [{ op: 'set', path: ['passwordHash'], value: '坏' }],
  ]) assert.equal((await service.patch('u', { baseVersion: version, ops: bad })).status, 400);
  assert.equal({}.polluted, undefined);
  assert.equal((await store.read('u')).version, version);
  const tooLarge = [{ op: 'set', path: ['libraries', 0, 'lessons', 0, 'chinese'], value: 'x'.repeat(40001) }];
  assert.equal((await service.patch('u', { baseVersion: version, ops: tooLarge })).status, 413);
  console.log('PASS 非法路径、原型污染、越界与过大内容被拒绝，云端版本不改变');

  let v = version;
  for (let i = 0; i < 40; i += 1) {
    const changed = copy(current);
    changed.progress['10|1'].n += 1;
    const reply = await service.patch('u', { baseVersion: v, ops: diffSnapshot(current, changed) });
    assert.equal(reply.ok, true); v = reply.version; current = (await store.read('u')).data;
  }
  assert.equal((await store.read('u')).data.progress['10|1'].n, 41);
  assert.deepEqual((await store.read('u')).legacyCodes, ['legacy']);
  assert.equal((await service.readChanges('u', 1)).mode, 'full');
  const restarted = await manager().readChanges('u', -1);
  assert.deepEqual(restarted.data, current);
  console.log('PASS 增量日志定期整理，过旧设备完整恢复，旧迁移归属保留');

  const oldWrite = await service.write('u', { baseVersion: v, data: current });
  assert.equal(oldWrite.ok, true);
  assert.equal((await service.readChanges('u', v)).mode, 'full');
  assert.deepEqual((await store.read('u')).data, current);
  await service.remove('u');
  assert.equal((await service.patch('u', { baseVersion: v + 1, ops: [] })).status, 401);
  assert.equal((await store.read('u')).deleted, true);
  assert.throws(() => materializeDocument({ deltaFormat: 1, baseRaw: '{}', frames: [], version: 2 }));
  console.log('PASS 旧客户端完整读写兼容，注销后迟到增量不能复活数据');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
