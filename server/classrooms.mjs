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
export function createClassrooms({ kv, accounts, findJob, lessonLookup }) {
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
    if (!room || (room.teacherUserId !== user.id && !(room.teachers || []).includes(user.id))) return { error: fail(404, '班级不存在') };
    return { room, user };
  }
  async function owner(token, id) {
    const access = await owned(token, id);
    if (access.error) return access;
    if (access.room.teacherUserId !== access.user.id) return { error: fail(403, '只有班级创建者可以管理协作教师或归档') };
    return access;
  }
  async function slotItems(id, kind, max) {
    const count = Number(await kv.get(P + id + ':' + kind + '-count')) || 0;
    const ids = await Promise.all(Array.from({ length: Math.min(count, max) }, (_, i) => kv.get(P + id + ':' + kind + '-slot:' + (i + 1))));
    return (await Promise.all(ids.filter(Boolean).map(async (itemId) => read(await kv.get(P + id + ':' + kind + ':' + itemId))))).filter(Boolean);
  }
  function titledHomeworks(items) {
    return items.map((hw) => {
      if (hw.type !== 'builtin' || hw.lessonTitle) return hw;
      const lesson = lessonLookup?.(hw.book, hw.lessonNo);
      return { ...hw, lessonTitle: String(lesson?.title_cn || lesson?.title_en || `第 ${hw.lessonNo} 课`).slice(0, 100) };
    });
  }
  function aggregateMistakes(students) {
    const categories = new Map();
    const patterns = new Map();
    for (const student of students) {
      for (const entry of student.errorCategories || []) {
        const item = categories.get(entry.category) || { category: entry.category, count: 0, students: 0 };
        item.count += entry.count;
        item.students += 1;
        categories.set(entry.category, item);
      }
      for (const entry of student.errorPatterns || []) {
        const id = JSON.stringify([entry.category, entry.from, entry.to]);
        const item = patterns.get(id) || { category: entry.category, from: entry.from, to: entry.to, count: 0, students: 0 };
        item.count += entry.count;
        item.students += 1;
        patterns.set(id, item);
      }
    }
    return {
      categories: [...categories.values()].sort((a, b) => b.count - a.count).slice(0, 20),
      patterns: [...patterns.values()].sort((a, b) => b.count - a.count).slice(0, 30),
    };
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
      return ok({ classes: rooms.filter((room) => room && (room.teacherUserId === user.id || (room.teachers || []).includes(user.id))).map(({ id, name, inviteCode, createdAt, archivedAt, studentCount }) => ({ id, name, inviteCode, createdAt, archivedAt, studentCount: studentCount || 0 })).reverse() });
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
      const ownedRoom = await owner(token, id);
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
      const [homeworks, corpus, teachers] = await Promise.all([
        slotItems(id, 'hw', 100), slotItems(id, 'corpus', 100),
        Promise.all([room.teacherUserId, ...(room.teachers || [])].map((teacherId) => accounts.publicUserById(teacherId))),
      ]);
      const validStudents = students.filter(Boolean);
      return ok({ class: room, students: validStudents.map(({ studentKey: _secret, ...publicData }) => publicData), homeworks: titledHomeworks(homeworks), corpus, teachers: teachers.filter(Boolean), mistakeStats: aggregateMistakes(validStudents) });
    },
    async addTeacher(token, id, email) {
      const access = await owner(token, id);
      if (access.error) return access.error;
      if (access.room.archivedAt) return fail(400, '已归档班级不能添加教师');
      const colleague = await accounts.findTeacherByEmail(email);
      if (!colleague) return fail(404, '未找到该邮箱的教师账号；请对方先注册或启用教师身份');
      if (colleague.id === access.user.id) return fail(400, '你已是班级创建者');
      return serial('class:' + id, () => serial('teacher:' + colleague.id, async () => {
        const room = read(await kv.get(key(id)));
        if ((room.teachers || []).includes(colleague.id)) return ok({ teachers: room.teachers });
        if ((room.teachers || []).length >= 5) return fail(400, '一个班级最多添加 5 位协作教师');
        const countKey = 'bts:teacher:' + colleague.id + ':class-count';
        const count = Number(await kv.get(countKey)) || 0;
        const slots = await Promise.all(Array.from({ length: Math.min(count, 20) }, (_, i) => kv.get('bts:teacher:' + colleague.id + ':class:' + (i + 1))));
        const vacant = slots.findIndex((slot) => !slot);
        if (count >= 20 && vacant < 0) return fail(400, '该教师的班级数量已达上限');
        room.teachers = [...(room.teachers || []), colleague.id];
        await kv.set('bts:teacher:' + colleague.id + ':class:' + (vacant >= 0 ? vacant + 1 : count + 1), id);
        if (vacant < 0) await kv.set(countKey, String(count + 1));
        await kv.set(key(id), JSON.stringify(room));
        return ok({ teacher: colleague });
      }));
    },
    async removeTeacher(token, id, colleagueId) {
      const access = await owner(token, id);
      if (access.error) return access.error;
      if (colleagueId === access.user.id) return fail(400, '不能移除班级创建者');
      return serial('class:' + id, () => serial('teacher:' + colleagueId, async () => {
        const room = read(await kv.get(key(id)));
        room.teachers = (room.teachers || []).filter((value) => value !== colleagueId);
        await kv.set(key(id), JSON.stringify(room));
        const count = Number(await kv.get('bts:teacher:' + colleagueId + ':class-count')) || 0;
        const slots = await Promise.all(Array.from({ length: Math.min(count, 20) }, (_, i) => kv.get('bts:teacher:' + colleagueId + ':class:' + (i + 1))));
        const slot = slots.indexOf(id);
        if (slot >= 0) await kv.set('bts:teacher:' + colleagueId + ':class:' + (slot + 1), '');
        return ok();
      }));
    },
    async createHomework(token, id, payload) {
      const access = await owned(token, id);
      if (access.error) return access.error;
      if (access.room.archivedAt) return fail(400, '已归档班级不能布置作业');
      const title = String(payload.title || '').trim();
      const type = String(payload.type || 'free');
      const dueAt = Number(payload.dueAt);
      if (!title || title.length > 80) return fail(400, '作业标题应为 1 至 80 字');
      if (!Number.isFinite(dueAt) || dueAt <= Date.now()) return fail(400, '截止时间必须晚于当前时间');
      let prompt = String(payload.prompt || '').trim();
      let reference = String(payload.reference || '').trim();
      let book = null;
      let lessonNo = null;
      let lessonTitle = '';
      let sharedLessonId = null;
      if (type === 'builtin') {
        book = Number(payload.book);
        lessonNo = Number(payload.lessonNo);
        const lesson = lessonLookup?.(book, lessonNo);
        if (!lesson) return fail(400, '指定的内置课文不存在');
        prompt = String(lesson.chinese || '').trim();
        reference = String(lesson.english || '').trim();
        lessonTitle = String(lesson.title_cn || lesson.title_en || `第 ${lessonNo} 课`).slice(0, 100);
      } else if (type === 'shared') {
        sharedLessonId = String(payload.sharedLessonId || '');
        const lesson = read(await kv.get(P + id + ':corpus:' + sharedLessonId));
        if (!lesson) return fail(400, '指定的共享课文不存在');
        prompt = lesson.chinese;
        reference = lesson.english;
        lessonTitle = lesson.title;
      } else if (type !== 'free') return fail(400, '作业类型不正确');
      if (!prompt || prompt.length > 8000 || reference.length > 8000) return fail(400, '中文提示必填，内容最多 8000 字');
      return serial('homeworks:' + id, async () => {
        const countKey = P + id + ':hw-count';
        const count = Number(await kv.get(countKey)) || 0;
        if (count >= 100) return fail(400, '每班最多布置 100 份作业');
        const hw = { id: randomBytes(12).toString('hex'), title, type, prompt, reference, book, lessonNo, lessonTitle, sharedLessonId, dueAt, createdAt: Date.now(), teacherUserId: access.user.id, closedAt: 0 };
        await kv.set(P + id + ':hw:' + hw.id, JSON.stringify(hw));
        await kv.set(P + id + ':hw-slot:' + (count + 1), hw.id);
        await kv.set(countKey, String(count + 1));
        return ok({ homework: hw }, 201);
      });
    },
    async updateHomework(token, id, hwId, payload) {
      const access = await owned(token, id);
      if (access.error) return access.error;
      const hw = read(await kv.get(P + id + ':hw:' + hwId));
      if (!hw) return fail(404, '作业不存在');
      if (payload.title !== undefined) {
        const title = String(payload.title || '').trim();
        if (!title || title.length > 80) return fail(400, '作业标题应为 1 至 80 字');
        hw.title = title;
      }
      if (payload.dueAt !== undefined) {
        const dueAt = Number(payload.dueAt);
        if (!Number.isFinite(dueAt) || dueAt <= 0) return fail(400, '截止时间不正确');
        hw.dueAt = dueAt;
      }
      if (payload.closed !== undefined) hw.closedAt = payload.closed ? Date.now() : 0;
      await kv.set(P + id + ':hw:' + hwId, JSON.stringify(hw));
      return ok({ homework: hw });
    },
    async saveCorpusLesson(token, id, lessonId, payload) {
      const access = await owned(token, id);
      if (access.error) return access.error;
      if (access.room.archivedAt) return fail(400, '已归档班级不能修改共享语料');
      const title = String(payload.title || '').trim();
      const chinese = String(payload.chinese || '').trim();
      const english = String(payload.english || '').trim();
      if (!title || title.length > 100 || !chinese || chinese.length > 8000 || !english || english.length > 8000) return fail(400, '课文标题、中文和英文均必填，正文最多 8000 字');
      return serial('corpus:' + id, async () => {
        const existing = lessonId ? read(await kv.get(P + id + ':corpus:' + lessonId)) : null;
        if (lessonId && !existing) return fail(404, '共享课文不存在');
        const countKey = P + id + ':corpus-count';
        const count = Number(await kv.get(countKey)) || 0;
        const slots = !existing ? await Promise.all(Array.from({ length: Math.min(count, 100) }, (_, i) => kv.get(P + id + ':corpus-slot:' + (i + 1)))) : [];
        const vacant = slots.findIndex((slot) => !slot);
        if (!existing && count >= 100 && vacant < 0) return fail(400, '每班最多保存 100 篇共享课文');
        const lesson = { id: existing?.id || randomBytes(12).toString('hex'), title, chinese, english, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
        await kv.set(P + id + ':corpus:' + lesson.id, JSON.stringify(lesson));
        if (!existing) {
          await kv.set(P + id + ':corpus-slot:' + (vacant >= 0 ? vacant + 1 : count + 1), lesson.id);
          if (vacant < 0) await kv.set(countKey, String(count + 1));
        }
        return ok({ lesson }, existing ? 200 : 201);
      });
    },
    async removeCorpusLesson(token, id, lessonId) {
      const access = await owned(token, id);
      if (access.error) return access.error;
      return serial('corpus:' + id, async () => {
        await kv.del(P + id + ':corpus:' + lessonId);
        const count = Number(await kv.get(P + id + ':corpus-count')) || 0;
        const slots = await Promise.all(Array.from({ length: Math.min(count, 100) }, (_, i) => kv.get(P + id + ':corpus-slot:' + (i + 1))));
        const slot = slots.indexOf(lessonId);
        if (slot >= 0) await kv.set(P + id + ':corpus-slot:' + (slot + 1), '');
        return ok();
      });
    },
    async studentDashboard(classId, sid) {
      const student = await byStudent(classId, sid);
      if (!student) return fail(403, '请先加入该班级');
      const room = read(await kv.get(key(classId)));
      if (!room) return fail(404, '班级不存在');
      const [homeworks, corpus] = await Promise.all([slotItems(classId, 'hw', 100), slotItems(classId, 'corpus', 100)]);
      return ok({ class: { id: room.id, name: room.name, archivedAt: room.archivedAt }, student: { name: student.name, studentNo: student.studentNo, subs: student.subs }, homeworks: titledHomeworks(homeworks), corpus });
    },
    async comment(token, id, { studentNo, jobId, comment }) {
      const access = await owned(token, id);
      if (access.error) return access.error;
      const text = String(comment || '').trim();
      if (text.length > 1000) return fail(400, '评语最多 1000 字');
      const sid = await kv.get(P + id + ':student-no:' + String(studentNo || '').trim());
      if (!sid) return fail(404, '学生不存在');
      return serial('student:' + id + ':' + sid, async () => {
        const student = await byStudent(id, sid);
        const sub = student?.subs.find((item) => item.jobId === jobId);
        if (!sub) return fail(404, '该学生没有这次提交');
        const entry = text ? { text, teacher: access.user.nickname || access.user.email, at: Date.now() } : null;
        sub.teacherComment = entry;
        await kv.set(studentKey(id, sid), JSON.stringify(student));
        return serial('comment:' + jobId, async () => {
          const commentKey = 'bts:job-comments:' + jobId;
          const entries = read(await kv.get(commentKey)) || [];
          const next = entries.filter((item) => item.classId !== id);
          if (entry) next.push({ classId: id, className: access.room.name, ...entry });
          await kv.set(commentKey, JSON.stringify(next));
          return ok({ teacherComment: entry });
        });
      });
    },
    async comments(jobId) {
      const entries = read(await kv.get('bts:job-comments:' + jobId));
      return Array.isArray(entries) ? entries.map(({ classId: _id, ...entry }) => entry) : [];
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
    async submit({ classId, studentKey: sid, jobId, deleteToken, hwId, ip }) {
      const limited = await rateLimit(kv, P + 'rate:submit:' + ip, 60, 180);
      if (limited.failed) return fail(503, '服务暂时不可用');
      if (limited.over) return fail(429, '提交过于频繁，请稍后再试');
      if (!/^[a-f0-9]{32}$/.test(String(classId)) || !/^[a-f0-9]{64}$/.test(String(sid)) || !/^[a-f0-9-]{8,64}$/.test(String(jobId))) return fail(400, '提交参数不正确');
      const room = read(await kv.get(key(classId)));
      if (!room || room.archivedAt) return fail(404, '班级不存在或已归档');
      const hw = hwId ? read(await kv.get(P + classId + ':hw:' + hwId)) : null;
      if (hwId && !hw) return fail(400, '这份作业不存在');
      const job = await findJob(jobId);
      if (!job || job.kind !== 'analyze' || job.status !== 'done' || !job.data || !job.deleteToken || !matchSecret(job.deleteToken, deleteToken)) return fail(403, '需要本次已完成练习的创建凭据');
      if (hw && (job.prompt !== hw.prompt || job.direction !== 'cn2en' || job.createdAt < hw.createdAt)) return fail(400, '这次练习与指定作业不一致，请从班级作业重新开始');
      if (hw?.closedAt && job.createdAt > hw.closedAt) return fail(400, '这份作业已结束');
      return serial('student:' + classId + ':' + sid, async () => {
        const student = await byStudent(classId, sid);
        if (!student) return fail(403, '未加入该班级');
        if (student.subs.some((sub) => sub.jobId === jobId)) return ok({ duplicate: true });
        const rawScore = job.data.overall?.score;
        const score = rawScore == null || rawScore === '' ? NaN : Number(rawScore);
        const sub = { jobId, title: String(job.data.title || job.title || '回译练习').slice(0, 100), lesson: String(job.meta?.lessonId || job.data.lessonNo || '').slice(0, 40), score: Number.isFinite(score) ? score : null, at: Number(job.finishedAt || job.updatedAt || Date.now()), hwId: hw?.id || null, late: Boolean(hw && job.createdAt > hw.dueAt) };
        const findings = (Array.isArray(job.data.sentences) ? job.data.sentences : []).flatMap((sentence) => Array.isArray(sentence.findings) ? sentence.findings : []);
        student.errorCategories ||= [];
        student.errorPatterns ||= [];
        let mistakeCount = 0;
        for (const finding of findings.slice(0, 100)) {
          if (!['error', 'improve'].includes(finding.level)) continue;
          mistakeCount += 1;
          const category = String(finding.category || '其他').trim().slice(0, 40);
          const categoryItem = student.errorCategories.find((item) => item.category === category);
          if (categoryItem) categoryItem.count += 1;
          else student.errorCategories.push({ category, count: 1 });
          const from = String(finding.from || '').trim().slice(0, 100);
          const to = String(finding.to || '').trim().slice(0, 100);
          if (!from || !to) continue;
          const pattern = student.errorPatterns.find((item) => item.category === category && item.from === from && item.to === to);
          if (pattern) pattern.count += 1;
          else if (student.errorPatterns.length < 100) student.errorPatterns.push({ category, from, to, count: 1 });
        }
        sub.mistakeCount = mistakeCount;
        student.subs.push(sub);
        if (student.subs.length > 500) student.subs.shift();
        student.lastActiveAt = Date.now();
        await kv.set(studentKey(classId, sid), JSON.stringify(student));
        return ok({ submission: sub }, 201);
      });
    },
  };
}
