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
const rooms = createClassrooms({ kv, accounts, findJob: async (id) => jobs.get(id), lessonLookup: (book, no) => book === 10 && no === 1 ? { title_cn: '内置第一课', chinese: '内置中文', english: 'Builtin English' } : null });

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

const advanced = (await rooms.create(teacher.token, '协作班级')).class;
assert.equal((await rooms.addTeacher(other.token, advanced.id, teacher.user.email)).status, 404);
assert.equal((await rooms.addTeacher(teacher.token, advanced.id, other.user.email)).status, 200);
assert.equal((await rooms.detail(other.token, advanced.id)).teachers.length, 2);
assert.equal((await rooms.list(other.token)).classes.some((room) => room.id === advanced.id), true);
assert.equal((await rooms.archive(other.token, advanced.id)).status, 403);

const shared = (await rooms.saveCorpusLesson(other.token, advanced.id, null, { title: '共享课文', chinese: '共享中文', english: 'Shared English' })).lesson;
assert.equal((await rooms.saveCorpusLesson(other.token, advanced.id, shared.id, { title: '共享课文更新', chinese: '共享中文', english: 'Shared English' })).lesson.id, shared.id);
const dueAt = Date.now() + 86400000;
const homework = (await rooms.createHomework(teacher.token, advanced.id, { title: '自由作业', type: 'free', prompt: '请回译这句话', dueAt })).homework;
const builtinHomework = (await rooms.createHomework(teacher.token, advanced.id, { title: '内置作业', type: 'builtin', book: 10, lessonNo: 1, dueAt })).homework;
assert.equal(builtinHomework.prompt, '内置中文');
assert.equal(builtinHomework.lessonTitle, '内置第一课');
assert.equal((await rooms.createHomework(other.token, advanced.id, { title: '共享作业', type: 'shared', sharedLessonId: shared.id, dueAt })).homework.reference, 'Shared English');
assert.equal((await rooms.createHomework(other.token, advanced.id, { title: '坏课文', type: 'builtin', book: 99, lessonNo: 1, dueAt })).status, 400);
const pupil = await rooms.join({ code: advanced.inviteCode, name: '小红', studentNo: '302', ip: 'pupil' });
assert.equal((await rooms.studentDashboard(advanced.id, 'f'.repeat(64))).status, 403);
assert.equal((await rooms.studentDashboard(advanced.id, pupil.studentKey)).homeworks.length, 3);
const job2 = '22345678-1234-1234-1234-123456789abc';
jobs.set(job2, { jobId: job2, kind: 'analyze', status: 'done', deleteToken: 'secret456', title: '自由作业', prompt: homework.prompt, direction: 'cn2en', createdAt: homework.createdAt + 1, data: { title: '自由作业', overall: { score: 75 }, sentences: [{ findings: [{ level: 'error', category: '搭配', from: 'search my bag', to: 'look for my bag' }] }] }, finishedAt: Date.now() });
const workSubmission = { classId: advanced.id, studentKey: pupil.studentKey, jobId: job2, deleteToken: 'secret456', hwId: homework.id, ip: 'pupil' };
jobs.get(job2).prompt = '其他题目';
assert.equal((await rooms.submit(workSubmission)).status, 400);
jobs.get(job2).prompt = homework.prompt;
assert.equal((await rooms.submit(workSubmission)).submission.hwId, homework.id);
const detail = await rooms.detail(teacher.token, advanced.id);
assert.equal(detail.students[0].subs[0].mistakeCount, 1);
assert.equal(detail.mistakeStats.categories[0].category, '搭配');
assert.equal(detail.mistakeStats.patterns[0].students, 1);
assert.equal((await rooms.comment(other.token, advanced.id, { studentNo: '302', jobId: job2, comment: '注意 look for 的搭配。' })).status, 200);
assert.equal((await rooms.comments(job2))[0].text, '注意 look for 的搭配。');
assert.equal((await rooms.studentDashboard(advanced.id, pupil.studentKey)).student.subs[0].teacherComment.text, '注意 look for 的搭配。');
assert.equal((await rooms.updateHomework(teacher.token, advanced.id, homework.id, { closed: true })).homework.closedAt > 0, true);
assert.equal((await rooms.removeTeacher(teacher.token, advanced.id, other.user.id)).status, 200);
assert.equal((await rooms.detail(other.token, advanced.id)).status, 404);
assert.equal((await rooms.removeTeacher(teacher.token, advanced.id, teacher.user.id)).status, 400);
assert.equal((await rooms.addTeacher(teacher.token, advanced.id, other.user.email)).status, 200);
assert.equal((await rooms.list(other.token)).classes.filter((room) => room.id === advanced.id).length, 1);
assert.equal((await rooms.removeCorpusLesson(teacher.token, advanced.id, shared.id)).status, 200);
assert.equal((await rooms.saveCorpusLesson(teacher.token, advanced.id, null, { title: '替换课文', chinese: '新中文', english: 'New English' })).status, 201);
assert.equal((await rooms.detail(teacher.token, advanced.id)).corpus.length, 1);
console.log('✅ 教师班级阶段 1–3：权限、邀请、作业、共享语料、协作教师、评语、错题汇总测试通过');
