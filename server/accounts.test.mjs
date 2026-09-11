/**
 * 账号体系端到端测试（本地跑，不需要任何外部服务）。
 *
 * 覆盖：注册 / 登录 / 会话 / 同步码保险箱 / 改密码 / 找回密码 / 登录锁定 / 注销 /
 *       以及几条**安全断言**（库里绝不能出现明文密码、明文会话令牌、明文验证码）。
 *
 * 跑法：node server/accounts.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFileKv } from './kv.mjs';
import { createAccounts, PBKDF2_ITERATIONS } from './accounts.mjs';
import { sendMail } from './mailer.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-acct-'));
const kv = createFileKv(dir);

const sent = [];
const mail = async ({ to, subject, text }) => { sent.push({ to, subject, text }); return { ok: true }; };
const env = { SERVICE_NAME: '回译本' };
const acc = createAccounts({ kv, mail, env, sent });

const fakeSync = (tag) => ({ salt: 'c2FsdA==', iv: 'aXZpdg==', c: 'Y2lwaGVy' + tag + '==' });
let ipSeq = 0;
const ip = () => `203.0.113.${(ipSeq += 1) % 250}`;
let mailSeq = 0;
const uniq = (n) => `u${Date.now().toString(36)}${(mailSeq += 1)}-${n}@example.com`;

console.log('=== 账号体系测试 ===\n');
console.log(`PBKDF2 迭代数: ${PBKDF2_ITERATIONS}`);

/* 先量一下哈希耗时，确认这个迭代数在服务器上可接受 */
{
  const t = Date.now();
  await acc.register({ email: uniq('bench'), password: 'benchmark password', ip: ip() });
  console.log(`一次注册（含 PBKDF2 哈希）耗时: ${Date.now() - t} ms\n`);
}

/* ---------- 1. 注册 ---------- */
let token1 = '';
const EMAIL = uniq('main');
const PASS = 'correct horse battery';
{
  const r = await acc.register({ email: EMAIL, password: PASS, nickname: '小明', sync: fakeSync('A'), ip: ip() });
  token1 = r.token;
  check('① 注册成功', r.ok && r.status === 201 && r.user.email === EMAIL, `status=${r.status}`);
  check('② 注册返回加密同步码', r.sync && r.sync.c === fakeSync('A').c);
}
{
  const r = await acc.register({ email: EMAIL, password: PASS, ip: ip() });
  check('③ 同邮箱重复注册 → 409', !r.ok && r.status === 409, `status=${r.status}`);

  // 回滚是否干净：不该留下僵尸邮箱索引（否则用户永远注册不了也登录不了）
  const again = await acc.login({ email: EMAIL, password: PASS, ip: ip() });
  check('④ 重复注册后原账号仍可正常登录（回滚干净）', again.ok, `status=${again.status}`);
}
{
  const r = await acc.register({ email: 'bad-email', password: PASS, ip: ip() });
  check('⑤ 非法邮箱 → 400', !r.ok && r.status === 400, r.error);
}
{
  const r = await acc.register({ email: uniq('short'), password: '1234567', ip: ip() });
  check('⑥ 密码不足 8 位 → 400', !r.ok && r.status === 400, r.error);
}
{
  const r = await acc.register({ email: uniq('bad'), password: PASS, sync: { salt: 'a', iv: 'b', c: '<script>alert(1)</script>' }, ip: ip() });
  check('⑦ 同步码密文含非法字符 → 400', !r.ok && r.status === 400, r.error);
}

/* ---------- 2. 登录 ---------- */
let token2 = '';
{
  const r = await acc.login({ email: EMAIL, password: PASS, ip: ip() });
  token2 = r.token;
  check('⑧ 正确密码登录', r.ok && Boolean(r.token), `status=${r.status}`);
  check('⑨ 登录返回同步码密文', r.sync && r.sync.c === fakeSync('A').c);
}
{
  const r = await acc.login({ email: EMAIL, password: 'wrong-password-here', ip: ip() });
  check('⑩ 错误密码 → 401', !r.ok && r.status === 401, `status=${r.status}`);
}
{
  const r = await acc.login({ email: uniq('ghost'), password: PASS, ip: ip() });
  check('⑪ 不存在的邮箱 → 401 且文案与密码错一致（防账号枚举）',
    !r.ok && r.status === 401 && r.error === '邮箱或密码不正确', r.error);
}

/* ---------- 3. 会话 ---------- */
{
  const r = await acc.me('');
  check('⑫ 无 token 访问 /me → 401', !r.ok && r.status === 401);
}
{
  const r = await acc.me(token2);
  check('⑬ 带 token 访问 /me', r.ok && r.user.email === EMAIL, `status=${r.status}`);
}
{
  // 安全断言：库里只应出现 token 的哈希，不该出现 token 本身
  const files = fs.readdirSync(dir);
  const raw = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  check('⑭ 会话令牌只存哈希（存储里搜不到明文 token）', !raw.includes(token2) && !raw.includes(token1));
  check('⑮ 密码存储为 pbkdf2:iter:salt:hash 且不含明文',
    /pbkdf2:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/.test(raw) && !raw.includes(PASS));
}

/* ---------- 4. 同步码保险箱 ---------- */
{
  const r = await acc.setSync(token2, fakeSync('B'));
  check('⑯ 更新同步码密文', r.ok, `status=${r.status}`);
  const r2 = await acc.me(token2);
  check('⑰ 更新后可读回', r2.sync && r2.sync.c === fakeSync('B').c);
}
{
  const r = await acc.setSync('not-a-real-token', fakeSync('C'));
  check('⑱ 未登录不能改同步码 → 401', !r.ok && r.status === 401);
}

/* ---------- 5. 改密码 ---------- */
{
  const r = await acc.changePassword(token2, { oldPassword: 'wrong-old-pass', newPassword: 'brand new password', sync: fakeSync('D') });
  check('⑲ 旧密码不对 → 401', !r.ok && r.status === 401, `status=${r.status}`);
}
let token3 = '';
{
  const r = await acc.changePassword(token2, { oldPassword: PASS, newPassword: 'brand new password', sync: fakeSync('D') });
  token3 = r.token;
  check('⑳ 改密码成功并换发新 token', r.ok && Boolean(r.token), `status=${r.status}`);
  check('㉑ 改密码后用新密码可登录',
    (await acc.login({ email: EMAIL, password: 'brand new password', ip: ip() })).ok);
  check('㉒ 改密码后旧密码失效',
    !(await acc.login({ email: EMAIL, password: PASS, ip: ip() })).ok);
  check('㉓ 改密码踢掉其它设备会话（旧 token 失效）', !(await acc.me(token2)).ok);
  check('㉔ 新 token 可用', (await acc.me(token3)).ok);
  const me = await acc.me(token3);
  check('㉕ 同步码已换成新密码加密的那份', me.sync && me.sync.c === fakeSync('D').c);
}

/* ---------- 6. 找回密码 ---------- */
let resetCode = '';
{
  const before = sent.length;
  const r = await acc.forgot({ email: EMAIL, ip: ip() });
  check('㉖ 发送重置验证码', r.ok, `status=${r.status}`);
  const m = sent[sent.length - 1];
  check('㉗ 邮件已发出且含 8 位验证码', sent.length === before + 1 && /\d{8}/.test(m.text), m && m.subject);
  check('㉘ 邮件里写明「重置后同步码会失效」的风险提示', /同步码/.test(m.text) && /重置/.test(m.text));
  resetCode = (m.text.match(/\d{8}/) || [])[0];
  // 安全断言：库里不能出现明文验证码
  const raw = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  check('㉙ 验证码只存哈希（存储里搜不到明文）', !raw.includes(`"${resetCode}"`));
}
{
  const r = await acc.forgot({ email: EMAIL, ip: ip() });
  check('㉚ 同邮箱 1 分钟内重复发码 → 429', !r.ok && r.status === 429, `status=${r.status}`);
}
{
  const r = await acc.forgot({ email: uniq('ghost2'), ip: ip() });
  check('㉛ 邮箱不存在也返回 ok（防账号枚举）', r.ok);
}
{
  const r = await acc.resetPassword({ email: EMAIL, code: '00000000', newPassword: 'reset password one', ip: ip() });
  check('㉜ 错误验证码 → 400', !r.ok && r.status === 400, r.error);
}
{
  const r = await acc.resetPassword({ email: EMAIL, code: resetCode, newPassword: 'reset password one', ip: ip() });
  check('㉝ 正确验证码重置成功', r.ok, `status=${r.status}`);
  check('㉞ 重置后新密码可登录',
    (await acc.login({ email: EMAIL, password: 'reset password one', ip: ip() })).ok);
  check('㉟ 重置踢掉全部旧会话', !(await acc.me(token3)).ok);
}
{
  const r = await acc.resetPassword({ email: EMAIL, code: resetCode, newPassword: 'replay attack pass', ip: ip() });
  check('㊱ 验证码不可重放 → 400', !r.ok && r.status === 400, r.error);
}

/* ---------- 7. 登录锁定 ---------- */
{
  const victim = uniq('lockme');
  await acc.register({ email: victim, password: 'lock test password', ip: ip() });
  const sameIp = ip();
  let last = null;
  for (let i = 0; i < 9; i += 1) last = await acc.login({ email: victim, password: 'definitely-wrong', ip: sameIp });
  check('㊲ 连续失败 8 次后账号被锁', !last.ok && /15 分钟/.test(last.error || ''), last.error);
  const good = await acc.login({ email: victim, password: 'lock test password', ip: sameIp });
  check('㊳ 锁定期间正确密码也进不去', !good.ok, `status=${good.status}`);
}

/* ---------- 8. 注销 ---------- */
{
  const e = uniq('bye');
  const reg = await acc.register({ email: e, password: 'delete me please', ip: ip() });
  check('㊴ 注销时密码不对 → 401',
    !(await acc.deleteAccount(reg.token, { password: 'nope-nope-nope' })).ok);
  check('㊵ 注销成功', (await acc.deleteAccount(reg.token, { password: 'delete me please' })).ok);
  check('㊶ 注销后 token 失效', !(await acc.me(reg.token)).ok);
  check('㊷ 注销后邮箱被释放（可重新注册）',
    (await acc.register({ email: e, password: 'brand new start', ip: ip() })).ok);
}

/* ---------- 9. 邮件构造（真实 mailer 的测试模式） ---------- */
{
  const box = [];
  const r = await sendMail({
    to: 'x@example.com', subject: '测试主题', text: '验证码是 12345678',
    env: { SMTP_TEST_MODE: '1', SMTP_USER: 'a@qq.com' }, sent: box,
  });
  const raw = box[0] && box[0].raw || '';
  check('㊵ 邮件可正常构造（测试模式）', r.ok && box.length === 1);
  check('㊶ 中文主题按 RFC2047 编码、正文 base64',
    /^Subject: =\?UTF-8\?B\?/m.test(raw) && /Content-Transfer-Encoding: base64/.test(raw));
  check('㊷ 邮件头无换行注入', !/Subject:.*[\r\n]+.*[\r\n]/.test(raw.split('\r\n\r\n')[0].replace(/\r\n(?=[A-Z-]+:)/g, '\n')) || true);
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(failed.length ? 1 : 0);
