import React, { useState } from 'react';

const localDateTime = (value) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const dateText = (value) => value ? new Date(value).toLocaleString('zh-CN') : '—';
const initialHomework = () => ({ title: '', type: 'free', prompt: '', reference: '', book: 10, lessonNo: 1, sharedLessonId: '', dueAt: localDateTime(Date.now() + 86400000) });

export function TeacherHomeworkPanel({ detail, token, request, onChanged, onError, resultUrl }) {
  const [form, setForm] = useState(initialHomework);
  const [busy, setBusy] = useState(false);
  const room = detail.class;
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await request('/' + room.id + '/homeworks', token, 'POST', { ...form, dueAt: new Date(form.dueAt).getTime() });
      setForm(initialHomework());
      await onChanged();
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  const toggleClosed = async (hw) => {
    setBusy(true);
    try { await request('/' + room.id + '/homeworks/' + hw.id, token, 'POST', { closed: !hw.closedAt }); await onChanged(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  return <section className="card teacher-extension"><h2>布置作业</h2>
    {!room.archivedAt && <form className="teacher-form" onSubmit={submit}>
      <label>作业标题<input required maxLength={80} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：Lesson 18 回译" /></label>
      <label>内容来源<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option value="free">自由题目</option><option value="builtin">内置课文</option><option value="shared">班级共享课文</option></select></label>
      {form.type === 'builtin' && <div className="teacher-form-pair"><label>册号<input type="number" min="1" max="10" required value={form.book} onChange={(event) => setForm({ ...form, book: event.target.value })} /></label><label>课文编号<input type="number" min="1" max="200" required value={form.lessonNo} onChange={(event) => setForm({ ...form, lessonNo: event.target.value })} /></label></div>}
      {form.type === 'shared' && <label>共享课文<select required value={form.sharedLessonId} onChange={(event) => setForm({ ...form, sharedLessonId: event.target.value })}><option value="">请选择</option>{detail.corpus.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.title}</option>)}</select></label>}
      {form.type === 'free' && <><label>中文提示<textarea required maxLength={8000} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="学生将根据这段中文完成回译" /></label><label>英文参考（可选）<textarea maxLength={8000} value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} /></label></>}
      <label>截止时间<input type="datetime-local" required value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} /></label>
      <button className="teacher-primary" disabled={busy}>{busy ? '保存中…' : '发布作业'}</button>
    </form>}
    <h3>作业与完成情况</h3>
    {!detail.homeworks.length && <p className="teacher-muted">还没有作业。</p>}
    {detail.homeworks.map((hw) => {
      const completed = detail.students.filter((student) => student.subs.some((sub) => sub.hwId === hw.id)).length;
      return <details className="teacher-hw" key={hw.id}><summary><strong>{hw.title}</strong><span>{completed}/{detail.students.length} 已交 · 截止 {dateText(hw.dueAt)}{hw.closedAt ? ' · 已结束' : ''}</span></summary>
        <div className="teacher-hw-inner"><p>{hw.type === 'builtin' ? `内置课文：第 ${hw.book} 册，第 ${hw.lessonNo} 课` : hw.type === 'shared' ? '班级共享课文' : '自由题目'} · {hw.prompt.slice(0, 100)}{hw.prompt.length > 100 ? '…' : ''}</p>
          <button type="button" disabled={busy} onClick={() => toggleClosed(hw)}>{hw.closedAt ? '重新开放' : '结束收集'}</button>
          <div className="teacher-scroll"><table><thead><tr><th>学生</th><th>学号</th><th>状态</th><th>最近成绩</th><th>结果</th></tr></thead><tbody>{detail.students.map((student) => {
            const sub = student.subs.filter((entry) => entry.hwId === hw.id).sort((a, b) => b.at - a.at)[0];
            return <tr key={student.studentNo}><td>{student.name}</td><td>{student.studentNo}</td><td>{sub ? sub.late ? '迟交' : '已完成' : '未完成'}</td><td>{sub?.score ?? '—'}</td><td>{sub && <a href={resultUrl(sub.jobId)} target="_blank" rel="noreferrer">查看批改</a>}</td></tr>;
          })}</tbody></table></div>
        </div>
      </details>;
    })}
  </section>;
}

export function TeacherCorpusPanel({ detail, token, request, onChanged, onError }) {
  const [form, setForm] = useState({ id: '', title: '', chinese: '', english: '' });
  const [busy, setBusy] = useState(false);
  const room = detail.class;
  const save = async (event) => {
    event.preventDefault(); setBusy(true);
    try {
      await request('/' + room.id + '/corpus' + (form.id ? '/' + form.id : ''), token, 'POST', form);
      setForm({ id: '', title: '', chinese: '', english: '' });
      await onChanged();
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  const remove = async (lesson) => {
    if (!window.confirm('移除共享课文「' + lesson.title + '」？已有作业与成绩仍会保留。')) return;
    setBusy(true);
    try { await request('/' + room.id + '/corpus/' + lesson.id, token, 'DELETE'); await onChanged(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  return <section className="card teacher-extension"><h2>班级共享语料库</h2><p className="teacher-muted">教师在这里提供课文，班内学生可直接载入练习，也可将它指定为作业。</p>
    {!room.archivedAt && <form className="teacher-form" onSubmit={save}><label>课文标题<input required maxLength={100} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label>中文提示<textarea required maxLength={8000} value={form.chinese} onChange={(event) => setForm({ ...form, chinese: event.target.value })} /></label><label>英文原文<textarea required maxLength={8000} value={form.english} onChange={(event) => setForm({ ...form, english: event.target.value })} /></label><div className="teacher-actions"><button className="teacher-primary" disabled={busy}>{busy ? '保存中…' : form.id ? '保存修改' : '加入共享库'}</button>{form.id && <button type="button" onClick={() => setForm({ id: '', title: '', chinese: '', english: '' })}>取消编辑</button>}</div></form>}
    <div className="teacher-corpus-list">{detail.corpus.map((lesson) => <div key={lesson.id}><strong>{lesson.title}</strong><span>{lesson.chinese.slice(0, 80)}{lesson.chinese.length > 80 ? '…' : ''}</span>{!room.archivedAt && <div className="teacher-actions"><button onClick={() => setForm(lesson)}>编辑</button><button className="teacher-danger" disabled={busy} onClick={() => remove(lesson)}>移除</button></div>}</div>)}{!detail.corpus.length && <p className="teacher-muted">暂无共享课文。</p>}</div>
  </section>;
}

export function TeacherStatsPanel({ detail }) {
  const stats = detail.mistakeStats || { categories: [], patterns: [] };
  return <section className="card teacher-extension"><h2>全班错题统计</h2><p className="teacher-muted">从学生上报的逐句批改中汇总错误与改进点；历史记录从启用此功能后的提交开始计入。</p>
    <div className="teacher-stats-grid"><div><h3>问题类别</h3>{stats.categories.length ? <div className="teacher-scroll"><table><thead><tr><th>类别</th><th>次数</th><th>涉及学生</th></tr></thead><tbody>{stats.categories.map((entry) => <tr key={entry.category}><td>{entry.category}</td><td>{entry.count}</td><td>{entry.students}</td></tr>)}</tbody></table></div> : <p className="teacher-muted">暂无错误记录。</p>}</div>
      <div><h3>高频表达问题</h3>{stats.patterns.length ? <div className="teacher-scroll"><table><thead><tr><th>类别</th><th>原表达</th><th>建议表达</th><th>次数</th><th>学生</th></tr></thead><tbody>{stats.patterns.map((entry, index) => <tr key={index}><td>{entry.category}</td><td>{entry.from}</td><td>{entry.to}</td><td>{entry.count}</td><td>{entry.students}</td></tr>)}</tbody></table></div> : <p className="teacher-muted">暂无高频问题。</p>}</div></div>
  </section>;
}

export function TeacherTeamPanel({ detail, token, user, request, onChanged, onError }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = detail.class.teacherUserId === user.id;
  const invite = async (event) => {
    event.preventDefault(); setBusy(true);
    try { await request('/' + detail.class.id + '/teachers', token, 'POST', { email }); setEmail(''); await onChanged(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  const remove = async (teacher) => {
    if (!window.confirm('移除协作教师「' + (teacher.nickname || teacher.email) + '」？')) return;
    setBusy(true);
    try { await request('/' + detail.class.id + '/teachers/' + teacher.id, token, 'DELETE'); await onChanged(); }
    catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  return <section className="card teacher-extension"><h2>协作教师</h2><p className="teacher-muted">同一班级可由多位教师查看名单、布置作业、共享课文并写评语。只有创建者可以管理成员或归档。</p>
    {owner && !detail.class.archivedAt && <form className="teacher-create" onSubmit={invite}><input type="email" required aria-label="协作教师邮箱" placeholder="已注册教师的邮箱" value={email} onChange={(event) => setEmail(event.target.value)} /><button disabled={busy}>添加</button></form>}
    {detail.teachers.map((teacher) => <div className="teacher-team-row" key={teacher.id}><span>{teacher.nickname || teacher.email} · {teacher.email}{teacher.id === detail.class.teacherUserId ? '（创建者）' : ''}</span>{owner && teacher.id !== detail.class.teacherUserId && <button disabled={busy} onClick={() => remove(teacher)}>移除</button>}</div>)}
  </section>;
}
