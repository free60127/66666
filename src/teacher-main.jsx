import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, authBecomeTeacher, authLogin, authMe, authTeacherRegister } from './api.js';
import { clearAccount, loadAccount, saveAccount } from './account.js';
import { TeacherCorpusPanel, TeacherHomeworkPanel, TeacherStatsPanel, TeacherTeamPanel } from './components/TeacherExtensions.jsx';
import './teacher.css';

const date = (timestamp) => timestamp ? new Date(timestamp).toLocaleString('zh-CN') : '—';
const authHeaders = (token) => ({ Authorization: 'Bearer ' + token });
const classRequest = (path, token, method = 'GET', payload) => api('/api/classes' + path, {
  method, headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
  ...(payload ? { body: JSON.stringify(payload) } : {}),
});
const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};
const resultUrl = (jobId) => import.meta.env.BASE_URL + 'index.html#job=' + encodeURIComponent(jobId);

function TeacherApp() {
  const [account, setAccount] = useState(null);
  const [ready, setReady] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ email: '', password: '', nickname: '' });
  const [classes, setClasses] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState('scores');
  const [commentTarget, setCommentTarget] = useState(null);
  const [commentText, setCommentText] = useState('');
  const token = account?.token || '';

  useEffect(() => {
    const saved = loadAccount();
    if (!saved) { setReady(true); return; }
    authMe(saved.token).then((r) => {
      if (r.ok) setAccount({ token: saved.token, user: r.data.user });
      else clearAccount();
    }).catch(() => setMessage('网络连接失败，请稍后刷新')).finally(() => setReady(true));
  }, []);

  const reloadClasses = useCallback(async (t) => {
    const data = await classRequest('', t);
    setClasses(data.classes || []);
    return data.classes || [];
  }, []);
  useEffect(() => { if (token && account?.user?.role === 'teacher') reloadClasses(token).catch((error) => setMessage(error.message)); }, [token, account?.user?.role, reloadClasses]);
  useEffect(() => {
    if (!selectedId || !token) { setDetail(null); return; }
    let active = true;
    classRequest('/' + selectedId, token).then((data) => { if (active) setDetail(data); }).catch((error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [selectedId, token]);
  useEffect(() => { setTab('scores'); setCommentTarget(null); }, [selectedId]);

  const act = async (fn) => {
    setBusy(true); setMessage('');
    try { await fn(); } catch (error) { setMessage(error.message || '操作失败'); }
    finally { setBusy(false); }
  };
  const signIn = (event) => {
    event.preventDefault();
    void act(async () => {
      const raw = authMode === 'register'
        ? await authTeacherRegister(authForm)
        : await authLogin(authForm);
      if (!raw.ok) throw new Error(raw.data?.error || '登录失败');
      saveAccount(raw.data.token, raw.data.user);
      setAccount({ token: raw.data.token, user: raw.data.user });
      setMessage(raw.data.user.role === 'teacher' ? '' : '这个账号尚未启用教师身份，点击下方按钮即可启用。');
    });
  };
  const becomeTeacher = () => void act(async () => {
    const raw = await authBecomeTeacher(token);
    if (!raw.ok) throw new Error(raw.data?.error || '启用失败');
    saveAccount(token, raw.data.user);
    setAccount({ token, user: raw.data.user });
  });
  const createClass = (event) => {
    event.preventDefault();
    void act(async () => {
      const data = await classRequest('', token, 'POST', { name: newName });
      setNewName('');
      await reloadClasses(token);
      setSelectedId(data.class.id);
      setMessage('班级已建立，把邀请码发给学生即可。');
    });
  };
  const archive = (room) => {
    if (!window.confirm('归档「' + room.name + '」？学生将不能再加入或提交，已有成绩仍可查看。')) return;
    void act(async () => {
      await classRequest('/' + room.id + '/archive', token, 'POST');
      await reloadClasses(token);
      if (selectedId === room.id) setDetail(await classRequest('/' + room.id, token));
    });
  };
  const reloadDetail = async () => {
    await reloadClasses(token);
    if (selectedId) setDetail(await classRequest('/' + selectedId, token));
  };
  const refresh = () => void act(reloadDetail);
  const saveComment = (event) => {
    event.preventDefault();
    if (!commentTarget) return;
    void act(async () => {
      await classRequest('/' + selectedId + '/comments', token, 'POST', { studentNo: commentTarget.studentNo, jobId: commentTarget.jobId, comment: commentText });
      setCommentTarget(null);
      await reloadDetail();
      setMessage('教师评语已保存，学生打开该结果时会在顶部看到。');
    });
  };
  const copyCode = async (code) => {
    try { await navigator.clipboard.writeText(code); setMessage('邀请码已复制'); }
    catch { setMessage('邀请码：' + code); }
  };
  // 学生从微信/QQ 点链接直接进站并预填邀请码，比抄 6 位数省事得多
  const copyJoinLink = async () => {
    const link = new URL(import.meta.env.BASE_URL + 'index.html#join=' + detail.class.inviteCode, window.location.href).href;
    try { await navigator.clipboard.writeText(link); setMessage('入班链接已复制，发到班级群即可（学生打开后自动填好邀请码）'); }
    catch { setMessage('入班链接：' + link); }
  };
  const scoreClass = (score) => (score == null ? '' : score >= 90 ? ' good' : score < 60 ? ' low' : '');
  const students = useMemo(() => detail?.students || [], [detail]);
  const lessons = useMemo(() => [...new Set(students.flatMap((student) => (student.subs || []).map((sub) => sub.title || '回译练习')))], [students]);
  const latest = (student, title) => (student.subs || []).filter((sub) => sub.title === title).sort((a, b) => b.at - a.at)[0];
  const exportCsv = () => {
    if (!detail) return;
    const rows = [['班级', '姓名', '学号', '课文', '课文编号', '作业编号', '分数', '是否迟交', '教师评语', '提交时间', '结果链接']];
    for (const student of students) {
      if (!student.subs?.length) rows.push([detail.class.name, student.name, student.studentNo, '', '', '', '', '', '', '', '']);
      for (const sub of student.subs || []) rows.push([detail.class.name, student.name, student.studentNo, sub.title, sub.lesson, sub.hwId, sub.score, sub.late ? '是' : '否', sub.teacherComment?.text, date(sub.at), new URL(resultUrl(sub.jobId), window.location.href).href]);
    }
    const blob = new Blob(['\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = detail.class.name + '-成绩.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!ready) return <main className="teacher-center">正在检查登录状态…</main>;
  return <div className="teacher-app">
    <header className="teacher-top"><div><strong>回译本 · 教师后台</strong><span>班级练习与成绩</span></div><nav><a href={import.meta.env.BASE_URL}>学生端</a>{account && <button onClick={() => { clearAccount(); setAccount(null); setClasses([]); setSelectedId(''); }}>退出登录</button>}</nav></header>
    {message && <div className="teacher-notice" role="status">{message}<button aria-label="关闭提示" onClick={() => setMessage('')}>×</button></div>}
    {!account ? <main className="teacher-auth card"><h1>{authMode === 'register' ? '注册教师账号' : '教师登录'}</h1><p>教师注册开放。学生无需注册，在学生端输入邀请码即可加入。</p>
      <form onSubmit={signIn}>
        {authMode === 'register' && <label>称呼<input required maxLength={20} value={authForm.nickname} onChange={(e) => setAuthForm({ ...authForm, nickname: e.target.value })} /></label>}
        <label>邮箱<input required type="email" autoComplete="email" value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} /></label>
        <label>密码<input required type="password" minLength={8} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} /></label>
        <button className="teacher-primary" disabled={busy}>{busy ? '请稍候…' : authMode === 'register' ? '注册并进入' : '登录'}</button>
      </form><button className="teacher-link" onClick={() => setAuthMode(authMode === 'register' ? 'login' : 'register')}>{authMode === 'register' ? '已有账号？登录' : '没有账号？开放注册'}</button>
    </main> : account.user.role !== 'teacher' ? <main className="teacher-auth card"><h1>启用教师身份</h1><p>已登录 {account.user.email}。启用后即可建立班级，原有学习数据照常保留。</p><button className="teacher-primary" disabled={busy} onClick={becomeTeacher}>启用教师身份</button></main> :
      <main className="teacher-layout"><aside className="teacher-sidebar card"><h2>我的班级</h2><form onSubmit={createClass} className="teacher-create"><input aria-label="新班级名称" placeholder="如：高一 3 班" maxLength={40} required value={newName} onChange={(e) => setNewName(e.target.value)} /><button disabled={busy}>建班</button></form>
        {classes.length === 0 && <p className="teacher-muted">还没有班级，先创建一个。</p>}
        {classes.map((room) => <button key={room.id} className={'teacher-room ' + (selectedId === room.id ? 'active' : '')} onClick={() => setSelectedId(room.id)}><span>{room.name}</span><small>{room.archivedAt ? '已归档' : `${room.studentCount} 人 · 邀请码 ${room.inviteCode}`}</small></button>)}
      </aside><section className="teacher-content">{!detail ? <div className="card teacher-empty">选择一个班级查看名单和成绩</div> : <>
        <div className="card teacher-class-head"><div><h1>{detail.class.name}</h1><p>{detail.class.archivedAt ? '已归档' : `邀请码 ${detail.class.inviteCode} · 学生在「更多 → 加入教师班级」输入`} · {students.length} 名学生</p></div><div className="teacher-actions"><button onClick={refresh} disabled={busy}>刷新数据</button>{!detail.class.archivedAt && <button onClick={() => copyCode(detail.class.inviteCode)}>复制邀请码</button>}{!detail.class.archivedAt && <button onClick={copyJoinLink}>复制入班链接</button>}<button onClick={exportCsv}>导出 CSV</button>{!detail.class.archivedAt && detail.class.teacherUserId === account.user.id && <button className="teacher-danger" onClick={() => archive(detail.class)}>归档</button>}</div></div>
        <div className="teacher-tabs" role="tablist" aria-label="班级管理">{[['scores', '成绩'], ['homework', '作业'], ['corpus', '共享课文'], ['stats', '错题统计'], ['team', '协作教师']].map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
        {tab === 'scores' && <>
        <div className="card"><h2>成绩总览</h2><p className="teacher-muted">按学生与课文显示最近一次成绩。点击分数查看完整批改。</p><div className="teacher-scroll"><table><thead><tr><th>姓名</th><th>学号</th><th>加入时间</th><th>最近活跃</th>{lessons.map((lesson) => <th key={lesson}>{lesson}</th>)}</tr></thead><tbody>{students.map((student) => <tr key={student.studentNo}><td>{student.name}</td><td>{student.studentNo}</td><td>{date(student.joinedAt)}</td><td>{date(student.lastActiveAt)}</td>{lessons.map((lesson) => { const sub = latest(student, lesson); return <td key={lesson}>{sub ? <a className={'score-badge' + scoreClass(sub.score)} href={resultUrl(sub.jobId)} target="_blank" rel="noreferrer" title={`${date(sub.at)} · 查看完整批改`}>{sub.score ?? '查看'}</a> : '—'}</td>; })}</tr>)}</tbody></table></div>{students.length === 0 && <p className="teacher-muted">暂无学生。请复制邀请码给学生。</p>}</div>
        <div className="card"><h2>最近提交</h2><div className="teacher-scroll"><table><thead><tr><th>提交时间</th><th>姓名</th><th>学号</th><th>课文</th><th>分数</th><th>批改详情</th><th>教师评语</th></tr></thead><tbody>{students.flatMap((student) => (student.subs || []).map((sub) => ({ ...sub, name: student.name, studentNo: student.studentNo }))).sort((a, b) => b.at - a.at).slice(0, 100).map((sub) => <tr key={sub.jobId}><td>{date(sub.at)}</td><td>{sub.name}</td><td>{sub.studentNo}</td><td>{sub.title}</td><td><span className={'score-badge' + scoreClass(sub.score)}>{sub.score ?? '—'}</span></td><td><a href={resultUrl(sub.jobId)} target="_blank" rel="noreferrer">查看结果</a></td><td><button className="teacher-link" onClick={() => { setCommentTarget(sub); setCommentText(sub.teacherComment?.text || ''); }}>{sub.teacherComment ? '修改评语' : '写评语'}</button></td></tr>)}</tbody></table></div>
          {commentTarget && <form className="teacher-comment-form" onSubmit={saveComment}><h3>给 {commentTarget.name} 的「{commentTarget.title}」写评语</h3><textarea value={commentText} maxLength={1000} onChange={(event) => setCommentText(event.target.value)} placeholder="写给学生的具体建议" /><div className="teacher-actions"><button className="teacher-primary" disabled={busy}>保存评语</button><button type="button" onClick={() => setCommentTarget(null)}>取消</button></div></form>}
        </div>
        </>}
        {tab === 'homework' && <TeacherHomeworkPanel detail={detail} token={token} request={classRequest} onChanged={reloadDetail} onError={setMessage} resultUrl={resultUrl} />}
        {tab === 'corpus' && <TeacherCorpusPanel detail={detail} token={token} request={classRequest} onChanged={reloadDetail} onError={setMessage} />}
        {tab === 'stats' && <TeacherStatsPanel detail={detail} />}
        {tab === 'team' && <TeacherTeamPanel detail={detail} token={token} user={account.user} request={classRequest} onChanged={reloadDetail} onError={setMessage} />}
      </>}</section></main>}
  </div>;
}

createRoot(document.getElementById('root')).render(<TeacherApp />);
