/** 登录会话、密码和注销；账号数据同步由 useCloudSync 管理。 */
import { useEffect, useRef, useState } from 'react';
import * as acct from '../account.js';
import { reconcileAccountClasses } from '../classroom.js';

export function useAccount({ flash, beforeSignOut }) {
  const [account, setAccount] = useState(acct.loadAccount);
  const [accountsOn, setAccountsOn] = useState(false);
  const [recoveryOn, setRecoveryOn] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authBusy, setAuthBusy] = useState(false);
  const [authTip, setAuthTip] = useState('');
  const [authForm, setAuthForm] = useState({ email: '', password: '', nickname: '', code: '' });
  const [manageForm, setManageForm] = useState({ oldPassword: '', newPassword: '', password: '' });
  const flashRef = useRef(flash);
  flashRef.current = flash;
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const config = await acct.accountConfig();
        const on = Boolean(config.enabled);
        if (!alive) return;
        setAccountsOn(on);
        setRecoveryOn(Boolean(config.recoveryEnabled));
        const saved = acct.loadAccount();
        if (!on || !saved) return;
        const r = await acct.verifySession(saved.token);
        if (!alive) return;
        if (!r.ok) { if (r.status === 401) setAccount(null); return; }
        setAccount({ token: saved.token, user: r.user });
        const failures = await reconcileAccountClasses(saved.token, r.classMembers, r.user.id);
        if (alive && failures.length) flashRef.current('部分班级尚未连接账号：' + failures.join('、'), 6000);
      } catch (error) { if (alive) flashRef.current('账号连接暂未完成：' + error.message, 5000); }
    })();
    return () => { alive = false; };
  }, []);

  const authField = (key) => (event) => setAuthForm((form) => ({ ...form, [key]: event.target.value }));
  const manageField = (key) => (event) => setManageForm((form) => ({ ...form, [key]: event.target.value }));
  const openAuth = (mode = 'login') => {
    setAuthMode(mode); setAuthTip(mode === 'forgot' && !recoveryOn ? '邮件找回暂未启用，请联系网站管理员。' : '');
    setAuthForm({ email: '', password: '', nickname: '', code: '' }); setAuthOpen(true);
  };
  const authenticate = async (register) => {
    if (authBusy) return;
    setAuthBusy(true); setAuthTip('');
    try {
      const r = await (register ? acct.signUp : acct.signIn)({ email: authForm.email.trim(), password: authForm.password, nickname: authForm.nickname.trim() });
      if (!r.ok) { setAuthTip(r.error || '登录失败'); return; }
      setAccount(acct.loadAccount()); setAuthOpen(false);
      if (r.migrationError) flash(r.migrationError, 7000);
      else flash(register ? '注册成功，学习数据将自动保存到账号' : '登录成功，正在恢复学习数据', 3500);
    } catch (error) { setAuthTip(error.message || '网络错误'); }
    finally { setAuthBusy(false); }
  };
  const doSignIn = () => authenticate(false);
  const doSignUp = () => authenticate(true);
  const doForgot = async () => {
    if (authBusy || !recoveryOn) return;
    setAuthBusy(true); setAuthTip('');
    try {
      const r = await acct.requestResetCode(authForm.email.trim());
      if (!r.ok) { setAuthTip(r.error); return; }
      setAuthMode('reset'); setAuthTip('验证码已发到邮箱，15 分钟内有效。');
    } catch (error) { setAuthTip(error.message); }
    finally { setAuthBusy(false); }
  };
  const doReset = async () => {
    if (authBusy) return;
    setAuthBusy(true); setAuthTip('');
    try {
      const r = await acct.resetPassword({ email: authForm.email.trim(), code: authForm.code.trim(), newPassword: authForm.password });
      if (!r.ok) { setAuthTip(r.error); return; }
      setAccount(null); setAuthMode('login');
      setAuthTip('密码已重置，请使用新密码登录。已归入账号的学习数据不受影响。');
    } catch (error) { setAuthTip(error.message); }
    finally { setAuthBusy(false); }
  };
  const logout = async (all) => {
    if (!account || authBusy || !window.confirm(all ? '退出所有设备？其它设备需要重新登录。' : '退出登录？学习数据保存在账号及本机的独立缓存中。')) return;
    setAuthBusy(true);
    try {
      await beforeSignOut?.();
      const r = await (all ? acct.signOutEverywhere : acct.signOut)(account.token);
      if (!r.ok) { flash(r.error || '操作失败', 5000); return; }
      setAccount(null);
    } catch (error) { flash(error.message, 5000); }
    finally { setAuthBusy(false); }
  };
  const doChangePassword = async () => {
    if (!account || authBusy) return;
    setAuthBusy(true);
    try {
      const r = await acct.changePassword({ token: account.token, oldPassword: manageForm.oldPassword, newPassword: manageForm.newPassword });
      if (!r.ok) { flash(r.error, 5000); return; }
      setAccount(acct.loadAccount()); setManageForm({ oldPassword: '', newPassword: '', password: '' });
      flash('密码已修改，其它设备需要重新登录。学习数据保持完整。', 5000);
    } catch (error) { flash(error.message, 5000); }
    finally { setAuthBusy(false); }
  };
  const doDeleteAccount = async () => {
    if (!account || authBusy || !window.confirm('注销账号并删除账号中的课文库、收藏、历史和进度？此操作无法撤销。已提交给教师的班级成绩仍保留。')) return;
    setAuthBusy(true);
    try {
      const r = await acct.deleteAccount({ token: account.token, password: manageForm.password });
      if (!r.ok) { flash(r.error, 5000); return; }
      setAccount(null);
    } catch (error) { flash(error.message, 5000); }
    finally { setAuthBusy(false); }
  };
  return { account, setAccount, accountsOn, recoveryOn, authOpen, setAuthOpen, authMode, authBusy, authTip, setAuthTip,
    authForm, authField, openAuth, doSignIn, doSignUp, doForgot, doReset,
    doSignOut: () => logout(false), doSignOutEverywhere: () => logout(true),
    manageForm, manageField, doChangePassword, doDeleteAccount };
}
