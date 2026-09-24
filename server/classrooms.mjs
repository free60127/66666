import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { rateLimit } from './kv.mjs';

const P = 'bts:class:';
const key = (id) => P + id;
const studentKey = (id, sid) => P + id + ':stu:' + sid;
const read = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
const fail = (status, error) => ({ ok: false, status, error });
const ok = (data = {}, status = 200) => ({ ok: true, status, ...data });
const matchSecret = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** 班级独立于个人同步码。教师会话授权读写，学生凭邀请码加入、随机密钥上报。 */
export function createClassrooms({ kv, accounts, findJob }) {
  const locks = new Map();
  async function serial(id, fn) {
    const previous = locks.get(id) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    locks.set(id, next);
    await previous;
    try { return await fn(); } finally { release(); if (locks.get(id) === next) locks.delete(id); }
  }
  async function teacher(token) {
    const result = await accounts.me(token);
    return result.ok && result.user.role === 'teacher' ? result.user : null;
  }
  async function owned(token, id) {
    const user = await teacher(token);
    if (!user) return { error: fail(403, '请先登录教师账号') };
    const room = read(await kv.get(key(id)));
    if (!room || room.teacherUserId !== user.id) return { error: fail(404, '班级不存在') };
    return { room, user };
  }
  async function byStudent(id, sid) {
    if (!/^[a-f0-9]{32}$/.test(String(id)) || !/^[a-f0-9]{64}$/.test(String(sid))) return null;
    return read(await kv.get(studentKey(id, sid)));
  }
  return {
    async list(token) {
      const user = await teacher(token);
      if (!user) return fail(403, '请先登录教师账号');
      const count = Number(await kv.get('bts:teacher:' + user.id + ':class-count')) || 0;
      const ids = await Promise.all(Array.from({ length: Math.min(count, 20) }, (_, i) => kv.get('bts:teacher:' + user.id + ':class:' + (i + 1))));
      const rooms = await Promise.all(ids.filter(Boolean).map(async (id) => read(await kv.get(key(id)))));
      return ok({ classes: rooms.filter(Boolean).map(({ id, name, inviteCode, createdAt, archivedAt, studentCount }) => ({ id, name, inviteCode, createdAt, archivedAt, studentCount: studentCount || 0 })).reverse() });
    },
    async create(token, name) {
      const user = await teacher(token);
      if (!user) return fail(403, '请先登录教师账号');
      const clean = String(name || '').trim();
      if (!clean || clean.length > 40) return fail(400, '班级名称应为 1 至 40 字');
      return serial('teacher:' + user.id, async () => {
        const countKey = 'bts:teacher:' + user.id + ':class-count';
        const count = Number(await kv.get(countKey)) || 0;
        if (count >= 20) return fail(400, '每位教师最多建立 20 个班级');
        const id = randomBytes(16).toString('hex');
        let inviteCode = '';
        for (let i = 0; i < 15; i += 1) {
          const candidate = String(randomInt(0, 1000000)).padStart(6, '0');
          if (await kv.setNx(P + 'invite:' + candidate, id)) { inviteCode = candidate; break; }
        }
        if (!inviteCode) return fail(503, '暂时无法分配邀请码，请重试');
        const room = { id, name: clean, teacherUserId: user.id, inviteCode, createdAt: Date.now(), archivedAt: 0, studentCount: 0 };
        await kv.set(key(id), JSON.stringify(room));
        await kv.set('bts:teacher:' + user.id + ':class:' + (count + 1), id);
        await kv.set(countKey, String(count + 1));
        return ok({ class: room }, 201);
      });
    },
    async archive(token, id) {
      const ownedRoom = await owned(token, id);
      if (ownedRoom.error) return ownedRoom.error;
      const room = ownedRoom.room;
      if (!room.archivedAt) {
        room.archivedAt = Date.now();
        await kv.set(key(id), JSON.stringify(room));
        await kv.del(P + 'invite:' + room.inviteCode);
      }
      return ok({ class: room });
    },
    async detail(token, id) {
      const ownedRoom = await owned(token, id);
      if (ownedRoom.error) return ownedRoom.error;
      const room = ownedRoom.room;
      const count = Number(await kv.get(P + id + ':stu-count')) || 0;
      const ids = await Promise.all(Array.from({ length: Math.min(count, 60) }, (_, i) => kv.get(P + id + ':stu-slot:' + (i + 1))));
      const students = await Promise.all(ids.filter(Boolean).map(async (sid) => read(await kv.get(studentKey(id, sid)))));
      return ok({ class: room, students: students.filter(Boolean).map(({ studentKey: _secret, ...publicData }) => publicData) });
    },
    async join({ code, name, studentNo, ip }) {
      // 学校机房通常共用出口 IP，额度要容纳整班同时扫码入班。
      const limited = await rateLimit(kv, P + 'rate:join:' + ip, 600, 100);
      if (limited.failed) return fail(503, '服务暂时不可用');
      if (limited.over) return fail(429, '尝试过于频繁，请稍后再试');
      const cleanCode = String(code || '').trim();
      const cleanName = String(name || '').trim();
      const cleanNo = String(studentNo || '').trim();
      if (!/^\d{6}$/.test(cleanCode)) return fail(400, '请输入 6 位班级邀请码');
      if (!cleanName || cleanName.length > 30 || !cleanNo || cleanNo.length > 30) return fail(400, '姓名和学号均应为 1 至 30 字');
      const id = await kv.get(P + 'invite:' + cleanCode);
      if (!id) return fail(404, '邀请码不存在或班级已归档');
      return serial('class:' + id, async () => {
        const room = read(await kv.get(key(id)));
        if (!room || room.archivedAt || room.inviteCode !== cleanCode) return fail(404, '邀请码不存在或班级已归档');
        const noKey = P + id + ':student-no:' + cleanNo;
        const existingId = await kv.get(noKey);
        if (existingId) {
          const existing = await byStudent(id, existingId);
          if (!existing || existing.name !== cleanName) return fail(409, '该学号已被其他姓名使用，请联系教师');
          return ok({ classId: id, className: room.name, studentKey: existingId, student: { name: cleanName, studentNo: cleanNo } });
        }
        const countKey = P + id + ':stu-count';
        const count = Number(await kv.get(countKey)) || 0;
        if (count >= 60) return fail(400, '班级人数已达上限');
        const sid = randomBytes(32).toString('hex');
        const student = { studentKey: sid, name: cleanName, studentNo: cleanNo, joinedAt: Date.now(), lastActiveAt: 0, subs: [] };
        await kv.set(studentKey(id, sid), JSON.stringify(student));
        await kv.set(noKey, sid);
        await kv.set(P + id + ':stu-slot:' + (count + 1), sid);
        await kv.set(countKey, String(count + 1));
        room.studentCount = count + 1;
        await kv.set(key(id), JSON.stringify(room));
        return ok({ classId: id, className: room.name, studentKey: sid, student: { name: cleanName, studentNo: cleanNo } }, 201);
      });
    },
    async submit({ classId, studentKey: sid, jobId, deleteToken, ip }) {
      const limited = await rateLimit(kv, P + 'rate:submit:' + ip, 60, 180);
      if (limited.failed) return fail(503, '服务暂时不可用');
      if (limited.over) return fail(429, '提交过于频繁，请稍后再试');
      if (!/^[a-f0-9]{32}$/.test(String(classId)) || !/^[a-f0-9]{64}$/.test(String(sid)) || !/^[a-f0-9-]{8,64}$/.test(String(jobId))) return fail(400, '提交参数不正确');
      const room = read(await kv.get(key(classId)));
      if (!room || room.archivedAt) return fail(404, '班级不存在或已归档');
      const job = await findJob(jobId);
      if (!job || job.kind !== 'analyze' || job.status !== 'done' || !job.data || !job.deleteToken || !matchSecret(job.deleteToken, deleteToken)) return fail(403, '需要本次已完成练习的创建凭据');
      return serial('student:' + classId + ':' + sid, async () => {
        const student = await byStudent(classId, sid);
        if (!student) return fail(403, '未加入该班级');
        if (student.subs.some((sub) => sub.jobId === jobId)) return ok({ duplicate: true });
        const rawScore = job.data.overall?.score;
        const score = rawScore == null || rawScore === '' ? NaN : Number(rawScore);
        const sub = { jobId, title: String(job.data.title || job.title || '回译练习').slice(0, 100), lesson: String(job.meta?.lessonId || job.data.lessonNo || '').slice(0, 40), score: Number.isFinite(score) ? score : null, at: Number(job.finishedAt || job.updatedAt || Date.now()) };
        student.subs.push(sub);
        if (student.subs.length > 500) student.subs.shift();
        student.lastActiveAt = Date.now();
        await kv.set(studentKey(classId, sid), JSON.stringify(student));
        return ok({ submission: sub }, 201);
      });
    },
  };
}
