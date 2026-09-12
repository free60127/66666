/**
 * 账号服务端到端测试（本地跑，不需要 Cloudflare）。
 *
 * 覆盖：注册 / 登录 / 会话 / 同步码保险箱 / 改密码 / 找回密码 / 账号锁定 / CORS /
 *       以及几条**安全断言**（库里绝不能出现明文密码或明文会话令牌）。
 *
 * 跑法：node tests/auth.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1 } from './d1-shim.mjs';
import worker from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 环境 ---------- */
const db = createD1(':memory:');
db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8'));

const env = {
  DB: db,
  SMTP_TEST_MODE: true,
  SMTP_SENT: [],
  SERVICE_NAME: '回译本',
  ADMIN_TOKEN: 'admin-secret-token',
  ALLOWED_ORIGINS: 'https://back-translate-studio.onrender.com,http://localhost:5173',
};
const ORIGIN = 'https://back-translate-studio.onrender.com';

let ipSeq = 0;
const nextIp = () => `203.0.113.${(ipSeq += 1) % 250}`;

async function call(method, p, { body, token, origin, ip } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (origin) headers.Origin = origin;
  headers['CF-Connecting-IP'] = ip || nextIp();
  const res = await worker.fetch(new Request('https://auth.test' + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, headers: res.headers };
}

/* ---------- 假同步码密文（模拟客户端 AES-GCM 产物） ---------- */
const fakeSync = (tag) => ({ salt: 'c2FsdA==', iv: 'aXZpdg==', c: 'Y2lwaGVy' + tag + '==' });

const EMAIL = 'student@example.com';
const PASS = 'correct horse battery';

console.log('=== 账号服务测试 ===\n');

/* ---------- 1. 注册 ---------- */
{
  const r = await call('POST', '/api/auth/register', { body: { email: EMAIL, password: PASS, nickname: '小明', sync: fakeSync('A') }, origin: ORIGIN });
  check('① 注册成功', r.status === 201 && r.data.token && r.data.user.email === EMAIL, `status=${r.status}`);
  check('② 注册返回加密同步码', r.data.sync && r.data.sync.c === fakeSync('A').c);
  check('③ CORS 回显白名单来源', r.headers.get('Access-Control-Allow-Origin') === ORIGIN);
  globalThis.TOKEN = r.data.token;
}
{
  const r = await call('POST', '/api/auth/register', { body: { email: EMAIL, password: PASS } });
  check('④ 同邮箱重复注册 → 409', r.status === 409, `status=${r.status}`);
}
{
  const r = await call('POST', '/api/auth/register', { body: { email: 'bad-email', password: PASS } });
  check('⑤ 非法邮箱 → 400', r.status === 400, r.data && r.data.error);
}
{
  const r = await call('POST', '/api/auth/register', { body: { email: 'short@example.com', password: '1234567' } });
  check('⑥ 密码不足 8 位 → 400', r.status === 400, r.data && r.data.error);
}
{
  const r = await call('POST', '/api/auth/register', { body: { email: 'xss@example.com', password: PASS, sync: { salt: 'a', iv: 'b', c: '<script>alert(1)</script>' } } });
  check('⑦ 同步码密文含非法字符 → 400', r.status === 400, r.data && r.data.error);
}
{
  const r = await call('POST', '/api/auth/register', { body: { email: 'evil@example.com', password: PASS }, origin: 'https://evil.example.com' });
  check('⑧ 非白名单来源不回显 CORS 头', r.headers.get('Access-Control-Allow-Origin') === null);
}

/* ---------- 2. 登录 ---------- */
let loginToken = '';
{
  const r = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASS } });
  loginToken = r.data.token;
  check('⑨ 正确密码登录', r.status === 200 && Boolean(r.data.token), `status=${r.status}`);
  check('⑩ 登录返回同步码密文', r.data.sync && r.data.sync.c === fakeSync('A').c);
}
{
  const r = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: 'wrong-password-here' } });
  check('⑪ 错误密码 → 401', r.status === 401, `status=${r.status}`);
}
{
  const r = await call('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: PASS } });
  check('⑫ 不存在的邮箱 → 401（且文案与密码错一致，防账号枚举）',
    r.status === 401 && r.data.error === '邮箱或密码不正确', r.data && r.data.error);
}

/* ---------- 3. 会话 ---------- */
{
  const r = await call('GET', '/api/auth/me', {});
  check('⑬ 无 token 访问 /me → 401', r.status === 401);
}
{
  const r = await call('GET', '/api/auth/me', { token: loginToken });
  check('⑭ 带 token 访问 /me', r.status === 200 && r.data.user.email === EMAIL, `status=${r.status}`);
}
{
  // 安全断言：库里存的必须是 token 的哈希，不是 token 本身
  const rows = db.query('SELECT token FROM sessions');
  const stored = rows.map((x) => x.token);
  check('⑮ 会话令牌只存哈希（库里查不到明文 token）',
    !stored.includes(loginToken) && stored.every((t) => /^[a-f0-9]{64}$/.test(t)),
    `${stored.length} 条会话记录`);
}
{
  // 安全断言：密码必须是 pbkdf2 格式，且不含明文
  const u = db.query('SELECT password_hash FROM users WHERE email = ?', EMAIL)[0];
  check('⑯ 密码存储为 pbkdf2:iter:salt:hash 且不含明文',
    /^pbkdf2:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(u.password_hash) && !u.password_hash.includes(PASS),
    u.password_hash.slice(0, 22) + '…');
}

/* ---------- 4. 同步码保险箱 ---------- */
{
  const r = await call('POST', '/api/auth/sync', { token: loginToken, body: { sync: fakeSync('B') } });
  check('⑰ 更新同步码密文', r.status === 200, `status=${r.status}`);
  const r2 = await call('GET', '/api/auth/me', { token: loginToken });
  check('⑱ 更新后可读回', r2.data.sync && r2.data.sync.c === fakeSync('B').c);
}
{
  const r = await call('POST', '/api/auth/sync', { body: { sync: fakeSync('C') } });
  check('⑲ 未登录不能改同步码 → 401', r.status === 401);
}

/* ---------- 5. 改密码 ---------- */
{
  const r = await call('POST', '/api/auth/change-password', {
    token: loginToken,
    body: { oldPassword: 'wrong-old-pass', newPassword: 'brand new password', sync: fakeSync('D') },
  });
  check('⑳ 旧密码不对 → 401', r.status === 401, `status=${r.status}`);
}
let secondToken = '';
{
  const s = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASS } });
  secondToken = s.data.token; // 第二台"设备"
  const r = await call('POST', '/api/auth/change-password', {
    token: loginToken,
    body: { oldPassword: PASS, newPassword: 'brand new password', sync: fakeSync('D') },
  });
  check('㉑ 改密码成功', r.status === 200, `status=${r.status}`);
  check('㉒ 改密码后用新密码可登录',
    (await call('POST', '/api/auth/login', { body: { email: EMAIL, password: 'brand new password' } })).status === 200);
  check('㉓ 改密码后旧密码失效',
    (await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASS } })).status === 401);
  check('㉔ 改密码踢掉其它设备会话',
    (await call('GET', '/api/auth/me', { token: secondToken })).status === 401);
  check('㉕ 当前设备会话保留',
    (await call('GET', '/api/auth/me', { token: loginToken })).status === 200);
  const me = await call('GET', '/api/auth/me', { token: loginToken });
  check('㉖ 同步码已换成新密码加密的那份', me.data.sync && me.data.sync.c === fakeSync('D').c);
}

/* ---------- 6. 找回密码 ---------- */
{
  const r = await call('POST', '/api/auth/forgot', { body: { email: EMAIL } });
  check('㉗ 发送重置验证码', r.status === 200, `status=${r.status}`);
  const mail = env.SMTP_SENT[env.SMTP_SENT.length - 1];
  check('㉘ 邮件已发出且含 8 位验证码', Boolean(mail) && /\d{8}/.test(mail.text), mail && mail.subject);
  check('㉙ 邮件里写明「重置后同步码会失效」的风险提示',
    Boolean(mail) && /同步码/.test(mail.text) && /重置/.test(mail.text));
  globalThis.RESET_CODE = (mail.text.match(/\d{8}/) || [])[0];
}
{
  const r = await call('POST', '/api/auth/forgot', { body: { email: EMAIL } });
  check('㉚ 同邮箱 1 分钟内重复发码 → 429', r.status === 429, `status=${r.status}`);
}
{
  const r = await call('POST', '/api/auth/forgot', { body: { email: 'ghost@example.com' } });
  check('㉛ 邮箱不存在也返回 ok（防账号枚举）', r.status === 200 && r.data.ok === true);
}
{
  const r = await call('POST', '/api/auth/reset-password', {
    body: { email: EMAIL, code: '00000000', newPassword: 'reset password one' },
  });
  check('㉜ 错误验证码 → 400', r.status === 400, r.data && r.data.error);
}
{
  const r = await call('POST', '/api/auth/reset-password', {
    body: { email: EMAIL, code: globalThis.RESET_CODE, newPassword: 'reset password one' },
  });
  check('㉝ 正确验证码重置成功', r.status === 200, `status=${r.status}`);
  check('㉞ 重置后新密码可登录',
    (await call('POST', '/api/auth/login', { body: { email: EMAIL, password: 'reset password one' } })).status === 200);
  check('㉟ 重置踢掉全部旧会话',
    (await call('GET', '/api/auth/me', { token: loginToken })).status === 401);
}
{
  const r = await call('POST', '/api/auth/reset-password', {
    body: { email: EMAIL, code: globalThis.RESET_CODE, newPassword: 'replay attack pass' },
  });
  check('㊱ 验证码不可重放 → 400', r.status === 400, r.data && r.data.error);
}

/* ---------- 7. 登录锁定 ---------- */
{
  const victim = 'lockme@example.com';
  await call('POST', '/api/auth/register', { body: { email: victim, password: 'lock test password' } });
  const ip = '198.51.100.9';
  let last = null;
  for (let i = 0; i < 9; i += 1) {
    last = await call('POST', '/api/auth/login', { body: { email: victim, password: 'definitely-wrong' }, ip });
  }
  check('㊲ 连续失败 8 次后账号被锁', last.status === 429 && /15 分钟/.test(last.data.error), last.data && last.data.error);
  const good = await call('POST', '/api/auth/login', { body: { email: victim, password: 'lock test password' }, ip });
  check('㊳ 锁定期间正确密码也进不去', good.status === 429, `status=${good.status}`);
}

/* ---------- 8. 管理端兜底 ---------- */
{
  const r = await call('POST', '/api/auth/admin-reset-code', { body: { email: EMAIL } });
  check('㊴ 无 ADMIN_TOKEN 不能生成重置码 → 401', r.status === 401);
  const r2 = await call('POST', '/api/auth/admin-reset-code', { token: 'admin-secret-token', body: { email: EMAIL } });
  check('㊵ 管理员可生成重置码', r2.status === 200 && /^\d{8}$/.test(r2.data.code));
  const r3 = await call('POST', '/api/auth/admin-reset-code', { token: 'admin-secret-tokeX', body: { email: EMAIL } });
  check('㊶ 错误 ADMIN_TOKEN 被拒', r3.status === 401);
}

/* ---------- 9. 其它 ---------- */
{
  const r = await call('GET', '/api/health', {});
  check('㊷ /api/health 正常', r.status === 200 && r.data.ok === true && r.data.db === true);
}
{
  const r = await call('GET', '/api/auth/me', { token: 'not-a-real-token' });
  check('㊸ 伪造 token → 401', r.status === 401);
}
{
  const r = await worker.fetch(new Request('https://auth.test/api/auth/login', {
    method: 'OPTIONS', headers: { Origin: ORIGIN },
  }), env);
  check('㊹ CORS 预检返回 204 且带白名单头',
    r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === ORIGIN);
}

console.log('\n' + '='.repeat(60));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
