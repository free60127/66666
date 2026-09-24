import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { joinClass, leaveClass, memberships, pendingClassReports, retryClassReports } from '../classroom.js';
import './ClassJoinModal.css';

export default function ClassJoinModal({ onClose }) {
  const [rooms, setRooms] = useState(memberships);
  const [form, setForm] = useState({ code: '', name: '', studentNo: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(pendingClassReports);
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
      {pending > 0 && <p role="status">有 {pending} 次练习待上报。<button type="button" onClick={async () => { await retryClassReports(); setPending(pendingClassReports()); }}>重试上报</button></p>}
      {rooms.length > 0 && <div className="class-joined"><h3>已加入的班级</h3>{rooms.map((room) => <div key={room.classId} className="class-joined-row"><span>{room.className} · {room.name}（{room.studentNo}）</span><button type="button" onClick={() => { if (window.confirm('退出「' + room.className + '」？此设备之后不会再向该班级提交成绩。')) { leaveClass(room.classId); setRooms(memberships()); } }}>退出</button></div>)}</div>}
      <p className="class-join-note">姓名和学号仅用于班级名单；同一学号换设备时可用相同姓名重新加入。班级邀请码请勿公开传播。</p>
    </div>
  </div>;
}
