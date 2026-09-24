import { api } from './api.js';

const MEMBER_KEY = 'bts-class-memberships';
const PENDING_KEY = 'bts-class-pending';
const parse = (key) => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };
export const memberships = () => parse(MEMBER_KEY).filter((m) => m?.classId && m?.studentKey);
export const pendingClassReports = () => parse(PENDING_KEY).length;
export const joinClass = async ({ code, name, studentNo }) => {
  const data = await api('/api/classes/join', { method: 'POST', body: JSON.stringify({ code, name, studentNo }) });
  const next = memberships().filter((m) => m.classId !== data.classId);
  next.push({ classId: data.classId, className: data.className, studentKey: data.studentKey, name, studentNo });
  localStorage.setItem(MEMBER_KEY, JSON.stringify(next.slice(-5)));
  void retryClassReports();
  return data;
};
export const leaveClass = (classId) => {
  localStorage.setItem(MEMBER_KEY, JSON.stringify(memberships().filter((m) => m.classId !== classId)));
};

/** 完成后自动上报。失败时保存待发送队列，下一次打开应用可重试。 */
export async function reportCompletedJob(jobId, deleteToken) {
  if (!jobId || !deleteToken) return;
  const members = memberships();
  if (!members.length) return;
  const pending = parse(PENDING_KEY);
  for (const member of members) {
    if (!pending.some((p) => p.jobId === jobId && p.classId === member.classId)) {
      pending.push({ classId: member.classId, studentKey: member.studentKey, jobId, deleteToken });
    }
  }
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending.slice(-100)));
  await retryClassReports();
}

let retrying = false;
export async function retryClassReports() {
  if (retrying) return;
  retrying = true;
  try {
    const pending = parse(PENDING_KEY);
    const completed = new Set();
    for (const item of pending) {
      const id = item.classId + ':' + item.jobId;
      if (!memberships().some((m) => m.classId === item.classId && m.studentKey === item.studentKey)) { completed.add(id); continue; }
      try {
        await api('/api/classes/submit', { method: 'POST', body: JSON.stringify(item) });
        completed.add(id);
      } catch { /* 网络恢复后重试 */ }
    }
    localStorage.setItem(PENDING_KEY, JSON.stringify(parse(PENDING_KEY).filter((item) => !completed.has(item.classId + ':' + item.jobId))));
  } finally { retrying = false; }
}
