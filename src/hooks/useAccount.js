/**
 * 账号（可选功能）：只是"帮你记住同步码"的一层 —— 换设备时不用手抄 32 位同步码。
 * 登录后用密码解开账号里存的同步码 → 存到本机 → 之后完全走原有的同步流程。
 * 服务端没配持久存储时账号功能是关闭的，所以这块出问题也不影响主流程。
 *
 * 抽出来的原因：这是一整套独立状态（账号 / 验证码流程 / 绑定同步码）+ 9 个异步动作，
 * 与编辑逻辑毫无关系，却在 App 里占了 177 行。
 */
import { useEffect, useState } from 'react'
import * as acct from '../account.js';
import { saveSyncCode } from '../sync.js'

export function useAccount({ syncCode, setSyncCode, setSyncLost, runSync, flash }) {
  const [account, setAccount] = useState(acct.loadAccount);
  const [accountsOn, setAccountsOn] = useState(false); // 服务端是否启用了账号功能
  const [accountHasSync, setAccountHasSync] = useState(false); // 账号里是否已存有同步码（没存就得绑，否则多设备各用各的）
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login'); // login | register | forgot
  const [authBusy, setAuthBusy] = useState(false);
  const [authTip, setAuthTip] = useState('');
  const [authForm, setAuthForm] = useState({ email: '', password: '', nickname: '', code: '', syncCode: '' });
  const [bindPw, setBindPw] = useState(''); // 「把本机同步码存进账号」时要现输一次密码（密码不落盘）

  /* ---------- 账号 ----------
   * 账号的作用只有一个：**换设备时不用抄同步码**。
   * 登录后用密码解开账号里存的同步码 → 存到本机 → 之后完全走原有的同步流程。
   * 没有账号时一切照旧，所以这块出问题也不影响主流程。 */
  useEffect(() => {
    let alive = true;
    (async () => {
      const on = await acct.accountAvailable();
      if (!alive) return;
      setAccountsOn(on);
      if (!on) return;
      const saved = acct.loadAccount();
      if (!saved) return;
      // 本地令牌可能已过期/被踢：校验一次，失效就清掉，别显示一个假的"已登录"
      const r = await acct.verifySession(saved.token);
      if (!alive) return;
      if (!r.ok) { setAccount(null); return; }
      setAccount({ token: saved.token, user: r.user || saved.user });
      setAccountHasSync(Boolean(r.hasSync));
    })();
    return () => { alive = false; };
  }, []);

  const authField = (k) => (e) => setAuthForm((f) => ({ ...f, [k]: e.target.value }));
  const openAuth = (mode = 'login') => {
    setAuthMode(mode);
    setAuthTip('');
    setAuthForm({ email: '', password: '', nickname: '', code: '' });
    setAuthOpen(true);
  };

  /** 登录/注册成功后：账号里带回同步码就切过去并同步一次。 */
  const applyAccountSync = async (code) => {
    if (!code) return;
    if (code === syncCode) {
      // 码相同也要跑一次同步 —— 用户点"登录"的意图就是"把数据对上"。
      // 原先这里直接 return，导致本机攒着没推上去的数据在登录后依然不动。
      flash('已登录；正在同步…', 2600);
      await runSync(true);
      return;
    }
    if (syncCode && !window.confirm(
      '账号里存着另一串同步码。\n\n'
      + '用账号里的那串吗？\n\n'
      + '本机数据不会丢 —— 两边的课文库 / 收藏 / 历史会自动合并，'
      + '然后一起传到账号的那串码上。\n'
      + '（如果两台设备本来就该同步，选「确定」）'
    )) return;
    saveSyncCode(code);
    setSyncCode(code);
    setSyncLost(false);
    flash('已从账号取回同步码，正在同步…', 3000);
    await runSync(true, code); // runSync 闭包里的 syncCode 还是旧的，显式传新码
  };

  const doSignIn = async () => {
    if (authBusy) return;
    setAuthBusy(true); setAuthTip('');
    try {
      const r = await acct.signIn({ email: authForm.email.trim(), password: authForm.password });
      if (!r.ok) { setAuthTip(r.error || '登录失败'); return; }
      const acc = acct.loadAccount();
      setAccount(acc);
      setAccountHasSync(r.hasSync);
      setAuthOpen(false);
      flash('已登录：' + r.user.email, 3200);

      // 账号里从没存过同步码，而本机有 —— 立刻绑上去。
      // 不绑的后果很隐蔽：两台设备各自保留自己的码，各同步各的，永远碰不上面（实测复现过）。
      // 此刻手上正好有密码，不用再让用户输一次。
      if (!r.hasSync && syncCode && acc) {
        const b = await acct.bindSyncCode(acc.token, syncCode, authForm.password);
        setAccountHasSync(b.ok);
        flash(b.ok
          ? '已把本机同步码存进账号 —— 别的设备登录后会用它'
          : '同步码存入账号失败：' + (b.error || '未知原因'), 5000);
      }

      if (r.syncError) flash(r.syncError, 6000);
      await applyAccountSync(r.syncCode);
    } catch (e) {
      setAuthTip(e.message || '网络错误');
    } finally { setAuthBusy(false); }
  };

  const doSignUp = async () => {
    if (authBusy) return;
    setAuthBusy(true); setAuthTip('');
    try {
      // 本机已有同步码就顺手加密存进账号 —— 这样别的设备一登录就能取回
      const r = await acct.signUp({
        email: authForm.email.trim(),
        password: authForm.password,
        nickname: authForm.nickname.trim(),
        syncCode,
      });
      if (!r.ok) { setAuthTip(r.error || '注册失败'); return; }
      setAccount(acct.loadAccount());
      setAccountHasSync(Boolean(syncCode));
      setAuthOpen(false);
      flash(syncCode ? '注册成功；本机同步码已存进账号' : '注册成功', 3600);
    } catch (e) {
      setAuthTip(e.message || '网络错误');
    } finally { setAuthBusy(false); }
  };

  const doForgot = async () => {
    if (authBusy) return;
    setAuthBusy(true); setAuthTip('');
    try {
      const r = await acct.requestResetCode(authForm.email.trim());
      if (!r.ok) { setAuthTip(r.error || '发送失败'); return; }
      setAuthMode('reset');
      setAuthTip('验证码已发到邮箱（15 分钟内有效）。没收到就看看垃圾邮件。');
    } catch (e) {
      setAuthTip(e.message || '网络错误');
    } finally { setAuthBusy(false); }
  };

  const doReset = async () => {
    if (authBusy) return;
    setAuthBusy(true); setAuthTip('');
    try {
      const r = await acct.resetPassword({
        email: authForm.email.trim(),
        code: authForm.code.trim(),
        newPassword: authForm.password,
        syncCode: (authForm.syncCode || '').trim() || syncCode || '',
      });
      if (!r.ok) { setAuthTip(r.error || '重置失败'); return; }
      setAccount(null);
      setAccountHasSync(false);
      setAuthMode('login');
      // 必须把「同步码会失效」这件事说清楚 ——
      // 用户最容易把"同步码解不开"误解成"我的课文库和收藏被删了"，其实数据一直在本机。
      setAuthTip('密码已重置。\n\n⚠️ 旧密码加密的同步码无法自动解锁 —— 如果这台设备上有同步码，'
        + '登录后点「存入账号」重新绑一次即可，本机的课文库和收藏一直都在。');
      flash('密码已重置，请用新密码登录', 4000);
    } catch (e) {
      setAuthTip(e.message || '网络错误');
    } finally { setAuthBusy(false); }
  };

  const doSignOut = async () => {
    if (!account) return;
    if (!window.confirm('退出登录？\n\n本机的课文库、收藏和同步码都不受影响，只是换设备时要重新登录。')) return;
    await acct.signOut(account.token);
    setAccount(null);
    setAccountHasSync(false);
    flash('已退出登录（本机数据保留）', 3000);
  };

  /**
   * 退出所有设备。
   * 会话令牌是存在浏览器里的（防得住 XSS 之外的东西有限），所以给一个"一键止血"：
   * 服务端把会话世代号 +1，所有已签发的令牌立刻作废，连当前这台也一起下线。
   */
  const doSignOutEverywhere = async () => {
    if (!account) return;
    if (!window.confirm('退出所有设备？\n\n其它设备上已登录的账号会立刻下线，需要重新输入密码。\n本机的课文库、收藏和同步码不受影响。')) return;
    const r = await acct.signOutEverywhere(account.token);
    setAccount(null);
    setAccountHasSync(false);
    flash(r.ok ? '已退出所有设备，请重新登录' : ('操作失败：' + (r.error || '未知原因')), 4000);
  };

  /** 把本机当前同步码加密存进账号。密码不落盘，所以每次都要现输。 */
  const doBindSync = async () => {
    if (!account || !syncCode || !bindPw) return;
    setAuthBusy(true);
    try {
      const r = await acct.bindSyncCode(account.token, syncCode, bindPw);
      setBindPw('');
      flash(r.ok ? '同步码已存进账号，别的设备登录即可取回' : (r.error || '存入失败'), 4000);
    } finally { setAuthBusy(false); }
  };


  return {
    account, setAccount, accountsOn, accountHasSync, setAccountHasSync,
    authOpen, setAuthOpen, authMode, setAuthMode, authBusy, authTip, setAuthTip, authForm, bindPw, setBindPw,
    authField, openAuth, doSignIn, doSignUp, doForgot, doReset, doSignOut, doSignOutEverywhere, doBindSync,
  };
}
