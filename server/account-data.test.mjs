/** 账号学习数据迁移与鉴权回归，隔离文件存储，不访问生产 Redis。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createFileKv } from './kv.mjs';
import { createFileStore, emptySnapshot } from './sync.mjs';
import { createAccounts } from './accounts.mjs';
import { createAccountData } from './account-data.mjs';
import { sealText } from '../src/secretBox.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-data-test-'));
const kv = createFileKv(path.join(dir, 'kv'));
const oldStore = createFileStore(path.join(dir, 'sync'));
const store = createFileStore(path.join(dir, 'user-data'));
const sent = [];
const accounts = createAccounts({ kv, env: { EMAIL_VERIFY: '0' }, mail: async (mail) => { sent.push(mail); return { ok: true }; } });
const password = 'migration-pass-123';
const code = 'c'.repeat(32);
const fixture = { ...emptySnapshot(), libraries: [{ id: 'lib-1', name: '我的分组库', createdAt: 1, sections: ['第一组', '空组'], sectionsUpdatedAt: 100,
  lessons: [{ lid: 'lesson-1', lesson: 2, title_cn: '课文标题', chinese: '中文', english: 'English', section: '第一组' }] }],
  favorites: [{ id: 'f-1', title: '旧收藏' }], history: Array.from({ length: 80 }, (_, i) => ({ jobId: 'job-' + i, time: i })),
  progress: { '10|1': { n: 3, best: 90, last: 80, at: 1, ms: 50 } }, days: ['2026-10-09'], deletedFavorites: ['deleted-fav'] };
await oldStore.write(code, { version: 1, updatedAt: 1, data: fixture });
await accounts.register({ email: 'old@example.com', password, sync: await sealText(code, password), ip: '127.0.0.1' });
const port = 8957;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, PORT: String(port), DATA_DIR: dir,
  UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', SMTP_TEST_MODE: '1', EMAIL_VERIFY: '0' }, stdio: 'ignore' });
const request = async (url, body, token) => {
  const r = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, ...await r.json() };
};
try {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal((await request('/api/account-data')).status, 401);
  const login = await request('/api/auth/login', { email: 'old@example.com', password });
  assert.equal(login.status, 200); assert.equal(login.legacyPending, false); assert.equal(login.sync, undefined);
  const data = await request('/api/account-data', undefined, login.token);
  assert.equal(data.data.history.length, 80); assert.deepEqual(data.data.libraries[0].sections, ['第一组', '空组']);
  assert.equal(data.data.libraries[0].lessons[0].section, '第一组'); assert.equal(data.data.progress['10|1'].n, 3);
  assert.equal(data.data.favorites[0].id, 'f-1'); assert.deepEqual(data.data.deletedFavorites, ['deleted-fav']);
  console.log('PASS 旧账号登录自动迁移全部字段、分组和完整历史，不下发同步码');
  assert.equal((await request('/api/sync/' + code)).status, 410);
  assert.equal((await request('/api/sync/new', {})).status, 410);
  const repeated = await request('/api/account-data/migrate', { code }, login.token);
  assert.equal(repeated.version, data.version); assert.equal(repeated.data.history.length, 80);
  const other = await request('/api/auth/register', { email: 'new@example.com', password });
  assert.equal((await request('/api/account-data/migrate', { code }, other.token)).status, 409);
  assert.equal((await request('/api/account-data', undefined, other.token)).data.history.length, 0);
  const spoof = await request('/api/account-data', { userId: login.user.id, baseVersion: 0, data: { ...emptySnapshot(), favorites: [{ id: 'other-fav' }] } }, other.token);
  assert.equal(spoof.status, 200);
  assert.equal((await request('/api/account-data', undefined, login.token)).data.favorites.length, 1);
  console.log('PASS 无登录无法访问、客户端伪造 userId 无效、旧数据不能被另一账号重复认领');
  assert.equal((await request('/api/account-data/delta')).status, 401);
  assert.equal((await request('/api/account-data/delta?since=NaN', undefined, other.token)).status, 400);
  const incrementalBase = await request('/api/account-data/delta', undefined, other.token);
  assert.equal(incrementalBase.mode, 'full');
  assert.equal((await request('/api/account-data/delta?since=1', undefined, other.token)).changes.length, 0);
  const incremental = await request('/api/account-data/delta', { baseVersion: 1, userId: login.user.id,
    ops: [{ op: 'set', path: ['progress', '10|2'], value: { n: 1, best: 88, last: 88, at: 2, ms: 10 } }] }, other.token);
  assert.equal(incremental.status, 200); assert.equal(incremental.data, undefined);
  assert.equal((await request('/api/account-data/delta?since=1', undefined, other.token)).changes.length, 1);
  assert.equal((await request('/api/account-data', undefined, login.token)).data.progress['10|2'], undefined);
  console.log('PASS 增量 HTTP 接口鉴权、版本参数校验、账号隔离和旧完整读取兼容');
  const payload = { baseVersion: data.version, data: { ...data.data, history: data.data.history.slice(0, 20) } };
  const pair = await Promise.all([request('/api/account-data', payload, login.token), request('/api/account-data', payload, login.token)]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await request('/api/account-data', undefined, login.token)).data.history.length, 80);
  console.log('PASS 并发写入有版本冲突，客户端显示缓存不会截断云端历史');
  const changed = await request('/api/auth/change-password', { oldPassword: password, newPassword: 'changed-pass-123' }, login.token);
  assert.equal(changed.status, 200); assert.equal((await request('/api/account-data', undefined, login.token)).status, 401);
  assert.equal((await request('/api/account-data', undefined, changed.token)).data.history.length, 80);
  await accounts.forgot({ email: 'old@example.com', ip: '127.0.0.2' });
  const resetCode = sent.at(-1).text.match(/验证码是：(\d{8})/)[1];
  assert.equal((await request('/api/auth/reset-password', { email: 'old@example.com', code: resetCode, newPassword: password })).status, 200);
  const resetLogin = await request('/api/auth/login', { email: 'old@example.com', password });
  assert.equal((await request('/api/account-data', undefined, resetLogin.token)).data.history.length, 80);
  console.log('PASS 修改和重置密码后数据仍属于同一账号，旧会话失效');
  const deletion = await request('/api/auth/delete-account', { password }, resetLogin.token);
  assert.equal(deletion.status, 200); assert.equal((await request('/api/account-data', undefined, resetLogin.token)).status, 401);
  assert.equal(await oldStore.read(code), null); assert.equal((await store.read(login.user.id)).deleted, true);
  const manager = createAccountData({ kv, store, legacyStore: oldStore });
  assert.equal((await manager.write(login.user.id, { baseVersion: 0, data: fixture })).status, 401);
  console.log('PASS 注销删除账号快照及已迁移旧快照，迟到请求不能复活数据');
  const unclaimed = 'd'.repeat(32);
  await oldStore.write(unclaimed, { version: 1, data: fixture });
  assert.equal((await request('/api/account-data/migrate', { code: unclaimed }, other.token)).status, 200);
  assert.equal((await request('/api/account-data', undefined, other.token)).data.favorites.length, 2);
  console.log('PASS 无账号旧数据登录后可认领，并与已有账号数据合并');
  const overflowing = 'f'.repeat(32);
  await oldStore.write(overflowing, { version: 1, data: { ...emptySnapshot(), history: Array.from({ length: 200 }, (_, i) => ({ jobId: 'overflow-' + i, time: i })) } });
  assert.equal((await request('/api/account-data/migrate', { code: overflowing }, other.token)).status, 413);
  assert.equal((await oldStore.read(overflowing)).data.history.length, 200);
  assert.equal((await request('/api/account-data', undefined, other.token)).data.history.length, 80);
  console.log('PASS 迁移合并超限时保留原数据并明确报错，不静默截断历史');
  const pendingCode = 'a'.repeat(32);
  await oldStore.write(pendingCode, { version: 1, data: fixture });
  const pendingAccount = await accounts.register({ email: 'pending@example.com', password, sync: await sealText(pendingCode, password), ip: '127.0.0.3' });
  assert.equal((await request('/api/auth/delete-account', { password }, pendingAccount.token)).status, 200);
  assert.equal(await oldStore.read(pendingCode), null);
  console.log('PASS 尚未迁移的旧账号注销时同步清理可解锁的旧数据');
} finally {
  child.kill();
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}
