import { api, TIMEOUT } from './api.js';
import { loadAccount } from './account.js';

const MEMBER_KEY = 'bts-class-memberships';
const MEMBER_OWNER_KEY = 'bts-class-member-owner';
const PENDING_KEY = 'bts-class-pending';
const FAILED_KEY = 'bts-class-failed';
const ACTIVE_HW_KEY = 'bts-active-homework';
// 进行中的班级任务存 localStorage 并带 24h 过期：学生"开始作业"后关掉标签页
// （手机切后台被回收更常见）是常态，sessionStorage 会把作业归属弄丢，
// 完成的练习就不再计入那份作业 —— 教师端显示"未完成"，学生白做。
const ACTIVE_HW_TTL = 24 * 3600 * 1000;
const parse = (key) => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };
const notifyMembershipsChanged = () => window.dispatchEvent(new Event('bts:class-memberships-changed'));
export const memberships = () => parse(MEMBER_KEY).filter((m) => m?.classId && m?.studentKey);
export const pendingClassReports = () => parse(PENDING_KEY).length;
export const failedClassReports = () => parse(FAILED_KEY);
export const clearFailedClassReports = () => localStorage.removeItem(FAILED_KEY);
export const activeHomework = () => {
  try {
    const task = JSON.parse(localStorage.getItem(ACTIVE_HW_KEY) || 'null');
    if (!task?.classId || Date.now() - (task.at || 0) > ACTIVE_HW_TTL) return null;
    return task;
  } catch { return null; }
};
/** 记录进行中的班级任务（作业带 hwId；共享课文练习带 sharedLessonId；title/prompt 用于守卫与上报标识）。 */
export const activateHomework = (classId, hwId, extra = {}) => {
  localStorage.setItem(ACTIVE_HW_KEY, JSON.stringify({
    classId, hwId: hwId || null,
    title: String(extra.title || '').slice(0, 120), prompt: String(extra.prompt || '').slice(0, 8000),
    sharedLessonId: extra.sharedLessonId || null, at: Date.now(),
  }));
};
export const clearActiveHomework = () => localStorage.removeItem(ACTIVE_HW_KEY);
export const studentDashboard = (member) => api('/api/classes/' + member.classId + '/student-dashboard', { method: 'POST', body: JSON.stringify({ studentKey: member.studentKey }) }, TIMEOUT.wake);
export const pendingAssignments = (dashboards, now = Date.now()) => dashboards.flatMap((dashboard) => {
  if (!dashboard || dashboard.class?.archivedAt) return [];
  return (dashboard.homeworks || []).filter((hw) => !hw.closedAt && hw.dueAt > now
    && !(dashboard.student?.subs || []).some((sub) => sub.hwId === hw.id))
    .map((hw) => ({ ...hw, classId: dashboard.class.id, className: dashboard.class.name, hwId: hw.id }));
}).sort((a, b) => a.dueAt - b.dueAt);
const bindClassToAccount = (token, member) => api('/api/auth/bind-class', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(member),
});
export const joinClass = async ({ code, name, studentNo }) => {
  const before = memberships();
  const data = await api('/api/classes/join', { method: 'POST', body: JSON.stringify({ code, name, studentNo }) });
  const known = before.filter((m) => m.classId !== data.classId);
  // 上限 5 个班：超出时自动退出**最早**加入的班，但必须把这件事告诉用户，
  // 不能静默丢弃（被退出的班的成绩仍保留在教师端）。
  const merged = [...known, { classId: data.classId, className: data.className, studentKey: data.studentKey, name, studentNo }].slice(-5);
  localStorage.setItem(MEMBER_KEY, JSON.stringify(merged));
  notifyMembershipsChanged();
  const droppedNames = before.filter((m) => !merged.some((x) => x.classId === m.classId)).map((m) => m.className);
  // 已登录账号：把班级成员身份绑到账号上 —— 换设备登录后自动恢复，不用再输邀请码。
  const acct = loadAccount();
  let bindingError = '';
  if (acct?.token) {
    try {
      for (const old of before.filter((m) => !merged.some((x) => x.classId === m.classId))) {
        await api('/api/auth/unbind-class', { method: 'POST', headers: { Authorization: 'Bearer ' + acct.token }, body: JSON.stringify({ classId: old.classId }) });
      }
      await bindClassToAccount(acct.token, { classId: data.classId, studentKey: data.studentKey });
    }
    catch (error) { bindingError = error.message || '账号绑定失败'; }
  }
  void retryClassReports();
  return { ...data, droppedNames, bindingError };
};
export const leaveClass = async (classId) => {
  const acct = loadAccount();
  if (acct?.token) await api('/api/auth/unbind-class', {
    method: 'POST', headers: { Authorization: 'Bearer ' + acct.token }, body: JSON.stringify({ classId }),
  });
  localStorage.setItem(MEMBER_KEY, JSON.stringify(memberships().filter((m) => m.classId !== classId)));
  notifyMembershipsChanged();
};

/** 完成后自动上报。失败时保存待发送队列，下一次打开应用可重试。 */
export async function reportCompletedJob(jobId, deleteToken, assignment = activeHomework()) {
  if (!jobId || !deleteToken) return;
  const members = memberships();
  if (!members.length) return;
  const pending = parse(PENDING_KEY);
  for (const member of members) {
    if (!pending.some((p) => p.jobId === jobId && p.classId === member.classId)) {
      // hwId/hwTitle/sharedLessonId 只带给匹配的班：作业上报要能定位到作业，
      // 失败提示要能说出"哪份作业"，共享课文上报要能让服务端核实用课文名替代 AI 标题。
      pending.push({
        classId: member.classId, studentKey: member.studentKey, jobId, deleteToken,
        ...(assignment?.classId === member.classId
          ? { hwId: assignment.hwId, hwTitle: assignment.title || '', sharedLessonId: assignment.sharedLessonId || null }
          : {}),
      });
    }
  }
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending.slice(-100)));
  await retryClassReports();
}

/** 登录/换设备登录后：账号里的班级身份优先；本机独有班级再绑定到账号。 */
export function mergeClassMembers(list, preserveLocal = true) {
  if (!Array.isArray(list)) return;
  const cur = preserveLocal ? memberships() : [];
  const canonical = list.filter((m) => m?.classId && m?.studentKey)
    .map((m) => ({ classId: m.classId, className: m.className || m.classId, studentKey: m.studentKey, name: m.name || '', studentNo: m.studentNo || '' }));
  const merged = [...canonical, ...cur.filter((m) => !canonical.some((c) => c.classId === m.classId))].slice(0, 5);
  if (JSON.stringify(merged) !== JSON.stringify(memberships())) {
    localStorage.setItem(MEMBER_KEY, JSON.stringify(merged));
    notifyMembershipsChanged();
    void retryClassReports();
  }
}

export async function reconcileAccountClasses(token, remote = [], userId = '') {
  // 同一台设备换了账号时，旧账号的本地班级不能自动挂到新账号名下。
  const owner = localStorage.getItem(MEMBER_OWNER_KEY) || '';
  const preserveLocal = !owner || !userId || owner === userId;
  const localOnly = preserveLocal ? memberships().filter((m) => !remote.some((r) => r.classId === m.classId)) : [];
  mergeClassMembers(remote, preserveLocal);
  if (userId) localStorage.setItem(MEMBER_OWNER_KEY, userId);
  // 兼容过去「先入班后注册」的设备；绑定失败仍保留本地班级，可在下次登录重试。
  const failures = [];
  for (const member of localOnly) {
    try { await bindClassToAccount(token, member); }
    catch (error) { failures.push(member.className || member.classId); }
  }
  return failures;
}

let retrying = false;
export async function retryClassReports() {
  if (retrying) return;
  retrying = true;
  try {
    const pending = parse(PENDING_KEY);
    const completed = new Set();
    const failed = failedClassReports();
    for (const item of pending) {
      const id = item.classId + ':' + item.jobId;
      if (!memberships().some((m) => m.classId === item.classId && m.studentKey === item.studentKey)) { completed.add(id); continue; }
      try {
        await api('/api/classes/submit', { method: 'POST', body: JSON.stringify(item) });
        completed.add(id);
      } catch (error) {
        // 4xx（限流除外）是永久拒绝；一直重试会让界面永远显示“待上报”。
        if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          completed.add(id);
          failed.push({ classId: item.classId, jobId: item.jobId, hwTitle: item.hwTitle || '', reason: error.message });
        }
      }
    }
    localStorage.setItem(PENDING_KEY, JSON.stringify(parse(PENDING_KEY).filter((item) => !completed.has(item.classId + ':' + item.jobId))));
    localStorage.setItem(FAILED_KEY, JSON.stringify(failed.slice(-20)));
  } finally { retrying = false; }
}
