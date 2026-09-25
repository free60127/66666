import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { clearFailedClassReports, failedClassReports, joinClass, leaveClass, memberships, pendingClassReports, retryClassReports, studentDashboard } from '../classroom.js';
import './ClassJoinModal.css';

export default function ClassJoinModal({ onClose, onStart }) {
  const [rooms, setRooms] = useState(memberships);
  const [form, setForm] = useState({ code: '', name: '', studentNo: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(pendingClassReports);
  const [failed, setFailed] = useState(failedClassReports);
  const [dashboards, setDashboards] = useState({});
  const [refreshId, setRefreshId] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all(rooms.map(async (room) => {
      try { return [room.classId, await studentDashboard(room)]; }
      catch (error) { return [room.classId, { error: error.message }]; }
    })).then((entries) => { if (active) setDashboards(Object.fromEntries(entries)); });
    return () => { active = false; };
  }, [rooms, refreshId]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const change = (field) => (event) => setForm((old) => ({ ...old, [field]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const data = await joinClass(form);
      setRooms(memberships());
      setPending(pendingClassReports());
      setForm({ ...form, code: '' });
      setMessage('已加入「' + data.className + '」。以后完成的回译练习会自动交给教师。');
    } catch (error) { setMessage(error.message || '加入失败，请稍后重试'); }
    finally { setBusy(false); }
  };
  return <div className="modal-mask" onClick={onClose}>
    <div className="modal class-join-modal" role="dialog" aria-modal="true" aria-label="加入班级" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head"><h2>加入教师班级</h2><button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={17} /></button></div>
      <p>向教师索取 6 位邀请码。加入后，新完成的批改结果会自动显示在教师后台。</p>
      <form onSubmit={submit} className="class-join-form">
        <label>班级邀请码<input autoFocus value={form.code} onChange={change('code')} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required placeholder="6 位数字" /></label>
        <label>姓名<input value={form.name} onChange={change('name')} maxLength={30} required autoComplete="name" /></label>
        <label>学号<input value={form.studentNo} onChange={change('studentNo')} maxLength={30} required /></label>
        <button className="primary-btn" disabled={busy}>{busy ? '加入中…' : '加入班级'}</button>
      </form>
      {message && <p role="status" className="class-join-message">{message}</p>}
      {pending > 0 && <p role="status">有 {pending} 次练习待上报。<button type="button" onClick={async () => { await retryClassReports(); setPending(pendingClassReports()); setFailed(failedClassReports()); setRefreshId((n) => n + 1); }}>重试上报</button></p>}
      {failed.length > 0 && <p role="alert">有 {failed.length} 次练习未能交给教师：{failed[failed.length - 1].reason}。请从班级作业重新开始。<button type="button" onClick={() => { clearFailedClassReports(); setFailed([]); }}>知道了</button></p>}
      {rooms.length > 0 && <div className="class-joined"><div className="class-joined-head"><h3>已加入的班级</h3><button type="button" onClick={() => setRefreshId((n) => n + 1)}>刷新作业与评语</button></div>{rooms.map((room) => {
        const dashboard = dashboards[room.classId];
        const feedback = (dashboard?.student?.subs || []).filter((sub) => sub.teacherComment?.text).sort((a, b) => b.teacherComment.at - a.teacherComment.at);
        return <section key={room.classId} className="class-room-card">
          <div className="class-joined-row"><strong>{room.className} · {room.name}（{room.studentNo}）</strong><button type="button" onClick={() => { if (window.confirm('退出「' + room.className + '」？此设备之后不会再向该班级提交成绩。')) { leaveClass(room.classId); setRooms(memberships()); } }}>退出</button></div>
          {!dashboard ? <p>正在载入作业…</p> : dashboard.error ? <p role="alert">{dashboard.error}</p> : <>
            {feedback.length > 0 && <div className="class-feedback"><h4>教师评语（{feedback.length}）</h4>{feedback.map((sub) => <div className="class-feedback-item" key={sub.jobId}><strong>{sub.title}</strong><p>{sub.teacherComment.text}</p><small>{sub.teacherComment.teacher} · {new Date(sub.teacherComment.at).toLocaleString('zh-CN')}</small><a href={import.meta.env.BASE_URL + 'index.html#job=' + encodeURIComponent(sub.jobId)}>查看完整批改</a></div>)}</div>}
            <h4>教师布置的作业</h4>
            {!dashboard.homeworks.length && <p className="class-join-note">暂无作业</p>}
            {dashboard.homeworks.map((hw) => {
              const done = dashboard.student.subs?.filter((sub) => sub.hwId === hw.id).sort((a, b) => b.at - a.at)[0];
              return <div key={hw.id} className="class-task-row"><div><strong>{hw.title}</strong><small>截止 {new Date(hw.dueAt).toLocaleString('zh-CN')} · {done ? `已交 ${done.score ?? '—'} 分${done.late ? '（迟交）' : ''}` : hw.closedAt ? '已结束' : Date.now() > hw.dueAt ? '已逾期，可补交' : '待完成'}</small></div><button type="button" disabled={Boolean(hw.closedAt || dashboard.class.archivedAt)} onClick={() => onStart({ ...hw, classId: room.classId, hwId: hw.id })}>开始作业</button></div>;
            })}
            <h4>班级共享课文</h4>
            {!dashboard.corpus.length && <p className="class-join-note">暂无共享课文</p>}
            {dashboard.corpus.map((lesson) => <div key={lesson.id} className="class-task-row"><span>{lesson.title}</span><button type="button" onClick={() => onStart({ title: lesson.title, prompt: lesson.chinese, reference: lesson.english })}>载入练习</button></div>)}
          </>}
        </section>;
      })}</div>}
      <p className="class-join-note">姓名和学号仅用于班级名单；同一学号换设备时可用相同姓名重新加入。班级邀请码请勿公开传播。</p>
    </div>
  </div>;
}
