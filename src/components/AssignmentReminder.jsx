import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import './AssignmentReminder.css';

export default function AssignmentReminder({ tasks, onStart, onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!tasks.length) return null;
  return <div className="modal-mask" onClick={onClose}>
    <div className="modal assignment-reminder" role="dialog" aria-modal="true" aria-label="待完成的班级作业" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head"><h2>待完成的班级作业</h2><button className="icon-btn" aria-label="关闭提醒" onClick={onClose}><X size={18} /></button></div>
      <p>你有 {tasks.length} 份作业待完成。完成后，下次进入就不会再提醒这份作业。</p>
      <div className="assignment-reminder-list">{tasks.map((task) => <div className="assignment-reminder-item" key={task.classId + ':' + task.id}>
        <div><strong>{task.title}</strong><span>{task.className}{task.lessonTitle ? ' · ' + task.lessonTitle : ''}</span><small>截止 {new Date(task.dueAt).toLocaleString('zh-CN')}</small></div>
        <button className="primary-btn" onClick={() => onStart(task)}>开始作业</button>
      </div>)}</div>
      <button className="ghost-btn assignment-reminder-later" onClick={onClose}>稍后再做</button>
    </div>
  </div>;
}
