import assert from 'node:assert/strict';
import { createAccounts } from './accounts.mjs';
import { createClassrooms } from './classrooms.mjs';

const entries = new Map();
const kv = {
  async get(k) { return entries.get(k) ?? null; },
  async set(k, v) { entries.set(k, String(v)); },
  async setNx(k, v) { if (entries.has(k)) return false; entries.set(k, String(v)); return true; },
  async del(k) { entries.delete(k); },
  async incrBy(k, n) { const value = Number(entries.get(k) || 0) + n; entries.set(k, String(value)); return value; },
};
const accounts = createAccounts({ kv, mail: async () => ({ ok: true }) });
const jobs = new Map();
const rooms = createClassrooms({ kv, accounts, findJob: async (id) => jobs.get(id) });

const teacher = await accounts.register({ email: 'teacher@example.com', password: 'testpass123', ip: 'teacher', role: 'teacher' });
const other = await accounts.register({ email: 'student@example.com', password: 'testpass123', ip: 'student' });
assert.equal(teacher.user.role, 'teacher');
assert.equal(other.user.role, 'student');
assert.equal((await rooms.create(other.token, '无权班级')).status, 403);
const created = await rooms.create(teacher.token, '高一三班');
assert.equal(created.status, 201);
assert.match(created.class.inviteCode, /^\d{6}$/);
assert.equal((await rooms.detail(other.token, created.class.id)).status, 403);
assert.equal((await rooms.list(teacher.token)).classes.length, 1);

const joined = await rooms.join({ code: created.class.inviteCode, name: '小明', studentNo: '301', ip: 'a' });
assert.equal(joined.status, 201);
assert.equal((await rooms.join({ code: created.class.inviteCode, name: '小明', studentNo: '301', ip: 'b' })).studentKey, joined.studentKey);
assert.equal((await rooms.join({ code: created.class.inviteCode, name: '别名', studentNo: '301', ip: 'c' })).status, 409);
assert.equal((await rooms.detail(teacher.token, created.class.id)).students.length, 1);
assert.equal((await rooms.detail(teacher.token, created.class.id)).students[0].studentKey, undefined);

const jobId = '12345678-1234-1234-1234-123456789abc';
jobs.set(jobId, { jobId, kind: 'analyze', status: 'done', deleteToken: 'secret123', title: 'Lesson 1', data: { title: '第一课', overall: { score: 87 } }, finishedAt: Date.now() });
const submission = { classId: created.class.id, studentKey: joined.studentKey, jobId, deleteToken: 'secret123', ip: 'd' };
assert.equal((await rooms.submit({ ...submission, deleteToken: 'wrong' })).status, 403);
assert.equal((await rooms.submit({ ...submission, studentKey: 'f'.repeat(64) })).status, 403);
assert.equal((await rooms.submit(submission)).submission.score, 87);
assert.equal((await rooms.submit(submission)).duplicate, true);
assert.equal((await rooms.detail(teacher.token, created.class.id)).students[0].subs.length, 1);
assert.equal((await rooms.archive(teacher.token, created.class.id)).status, 200);
assert.equal((await rooms.join({ code: created.class.inviteCode, name: '小红', studentNo: '302', ip: 'e' })).status, 404);
assert.equal((await rooms.submit(submission)).status, 404);

const promoted = await accounts.becomeTeacher(other.token);
assert.equal(promoted.user.role, 'teacher');
assert.equal((await rooms.create(other.token, '第二个班')).status, 201);
console.log('✅ 教师班级：权限、邀请、同学号合并、凭据核对、幂等上报、归档测试通过');
