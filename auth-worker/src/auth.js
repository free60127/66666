/**
 * 账号认证（D1 版）：注册 / 登录 / 登出 / 会话 / 同步码保险箱 / 找回密码
 *
 * 移植自 study platform 的 workers/src/auth.js（已线上验证），针对回译本做的改动：
 *   - recovery_encrypted → sync_encrypted（存的是**同步码**的密文，语义一致）
 *   - 去掉学习平台特有的 R2 证据/任务图片清理
 *   - 迭代数改为可按环境变量调整（Workers 免费版 CPU 10ms 是硬约束）
 *
 * 三条不能动的前提：
 *  1) **密码：PBKDF2(SHA-256) → 256 bit**，存成 `pbkdf2:iter:salt:hash`。
 *     迭代数写进串里，以后调高不会让存量账号失效（verify 用串里那个 iter）。
 *  2) **会话：库里只存 token 的 SHA-256 哈希**。D1 被拖走也拿不到可用令牌。
 *  3) **同步码保险箱：用「密码派生密钥」加密，服务端不可读**。
 *     服务端只能存/取密文，数据库泄露不会连坐任何用户的云端数据；
 *     代价是「重置密码后同步码会丢」—— 所以找回邮件里必须写清这一点。
 */
import { sendEmail, generateResetCode } from './smtp.js';
import { json, bearerToken, safeParseJson, readJsonBody, MAX_AUTH_BODY, timingSafeEqual } from './http.js';
import { rateWindow, clientIp } from './rate-limit.js';

/**
 * 密码哈希迭代数。
 *
 * Workers **免费版 CPU 只有 10 ms/请求**，150k 轮会直接 500（study platform 实测过）。
 * 10k 轮配 8 位以上密码 + 登录限流，足够防在线爆破。
 * 升级到 Workers Paid（$5/月，CPU 30 s 起）后把这里调大即可，存量账号不受影响
 * （verify 用哈希串里记录的迭代数，不会因为改这个值而集体登录失败）。
 *
 * 不用环境变量：模块顶层的常量在 Worker 启动时求值一次，
 * 而 env 是每次请求才注入的 —— 试图从 env 读会读到 undefined。
 */
const PBKDF2_ITERATIONS = 10000;

const SESSION_DAYS = 30;
const RESET_TTL_MS = 15 * 60 * 1000;

const LOGIN_IP_MAX = 30;          // 每 IP 每 10 分钟
const LOGIN_EMAIL_FAIL_MAX = 8;   // 每邮箱连续失败
const LOGIN_EMAIL_LOCK_MS = 15 * 60 * 1000;

/* ---------- 基础工具 ---------- */
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
const randomHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normalizeEmail = (body) => String(body.email || '').trim().toLowerCase();

/** 参数校验：邮箱格式 + 密码长度。 */
function validate(body) {
  const email = normalizeEmail(body);
  const password = String(body.password || '');
  const nickname = String(body.nickname || '').trim().slice(0, 20);
  if (!EMAIL_RE.test(email)) return { error: '邮箱格式不正确' };
  if (password.length < 8) return { error: '密码至少 8 位' };
  if (password.length > 128) return { error: '密码过长（最多 128 位）' };
  return { email, password, nickname };
}
function passwordError(body) {
  const p = String(body.newPassword || '');
  if (p.length < 8) return '密码至少 8 位';
  if (p.length > 128) return '密码过长（最多 128 位）';
  return '';
}

/* ---------- 密码哈希 ---------- */
async function hashPassword(password, saltBytes, iterations) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const iter = iterations || PBKDF2_ITERATIONS;
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']),
    256
  );
  return { salt, hash: new Uint8Array(bits) };
}

async function verifyPassword(password, stored) {
  try {
    const [algo, iter, saltB64, hashB64] = String(stored).split(':');
    if (algo !== 'pbkdf2' || !iter) return false;
    // 必须用哈希串里存的迭代数 —— 否则调高默认值会让全部存量账号登录失败
    const result = await hashPassword(password, unb64(saltB64), Number(iter));
    const expect = unb64(hashB64);
    if (result.hash.length !== expect.length) return false;
    let diff = 0;
    for (let i = 0; i < result.hash.length; i += 1) diff |= result.hash[i] ^ expect[i];
    return diff === 0;
  } catch (_) { return false; }
}

/* ---------- 会话 ---------- */
const newSessionToken = () => randomHex(32);
const sessionExpiry = () => Date.now() + SESSION_DAYS * 24 * 3600 * 1000;

/** token → SHA-256 hex（库里只存这个）。 */
async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
const sha256Hex = hashToken;

/* ---------- 同步码保险箱 ----------
 * 客户端把同步码用「密码派生密钥」AES-GCM 加密后传上来，形如 {salt, iv, c}（均 base64url）。
 * 服务端只做格式校验与存取，**永远解不开**。 */
function sanitizeSync(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined; // undefined = 非法
  const salt = String(value.salt || '');
  const iv = String(value.iv || '');
  const c = String(value.c || '');
  if (!salt || !iv || !c) return undefined;
  if (salt.length > 64 || iv.length > 64 || c.length > 8192) return undefined;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(salt + iv + c)) return undefined;
  return { salt, iv, c };
}

/* ---------- 登录限流与锁定 ---------- */
async function loginIpCheck(env, request) {
  if (!env || !env.DB) return { ok: true, failed: false };
  const r = await rateWindow(env.DB, 'rate:login:ip:' + clientIp(request), 600000, LOGIN_IP_MAX);
  if (r.failed) return { ok: false, failed: true, error: '服务繁忙，请稍后再试' };
  if (r.count > LOGIN_IP_MAX) return { ok: false, failed: false, error: '尝试过于频繁，请稍后再试' };
  return { ok: true, failed: false };
}

async function loginEmailCheck(db, email) {
  try {
    const row = await db.prepare('SELECT locked_until FROM login_fails WHERE email = ?').bind(email).first();
    if (row && row.locked_until > Date.now()) {
      return { ok: false, failed: false, error: '登录尝试过多，请 15 分钟后再试' };
    }
  } catch (error) {
    console.error('loginEmailCheck error:', error);
    return { ok: false, failed: true, error: '服务繁忙，请稍后再试' };
  }
  return { ok: true, failed: false };
}

async function recordLoginFail(db, email) {
  // 单语句原子 UPSERT：原「先查后改」并发下会互相覆盖丢失计数。
  // 仅当「曾锁定且已过期」才重新计数；locked_until=0（从未锁定）继续累计。
  try {
    const now = Date.now();
    const lockUntil = now + LOGIN_EMAIL_LOCK_MS;
    await db.prepare(
      'INSERT INTO login_fails (email, fail_count, locked_until, updated_at) VALUES (?1, 1, 0, ?2) '
      + 'ON CONFLICT(email) DO UPDATE SET '
      + 'fail_count = CASE WHEN login_fails.locked_until > 0 AND login_fails.locked_until < ?3 THEN 1 ELSE login_fails.fail_count + 1 END, '
      + 'locked_until = CASE WHEN login_fails.locked_until > ?4 THEN login_fails.locked_until '
      + 'WHEN (CASE WHEN login_fails.locked_until > 0 AND login_fails.locked_until < ?3 THEN 1 ELSE login_fails.fail_count + 1 END) >= ?5 THEN ?6 ELSE 0 END, '
      + 'updated_at = ?3'
    ).bind(email, now, now, now, LOGIN_EMAIL_FAIL_MAX, lockUntil).run();
  } catch (error) {
    console.error('recordLoginFail error:', error);
  }
}

async function recordLoginSuccess(db, email) {
  try { await db.prepare('DELETE FROM login_fails WHERE email = ?').bind(email).run(); } catch (_) {}
}

/** 认证请求体：超限 → {tooLarge:true}（调用方 413）；非法 JSON → null（调用方 400）。 */
async function readAuthJson(request) {
  try { return { body: await readJsonBody(request, MAX_AUTH_BODY) }; }
  catch { return { tooLarge: true }; }
}

/** 取当前会话用户（含同步码密文）。 */
async function sessionUser(db, request) {
  const token = bearerToken(request);
  if (!token) return null;
  return db.prepare(
    'SELECT s.token, u.id, u.email, u.nickname, u.sync_encrypted FROM sessions s '
    + 'JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
  ).bind(await hashToken(token), Date.now()).first();
}

/* ============================================================
   路由
   ============================================================ */
export async function handleAuth(request, env, path) {
  const db = env.DB;
  if (!db) return json({ error: 'database not configured' }, 500);

  if (path === '/api/auth/register' && request.method === 'POST') return register(db, env, request);
  if (path === '/api/auth/login' && request.method === 'POST') return login(db, env, request);
  if (path === '/api/auth/logout' && request.method === 'POST') return logout(db, request);
  if (path === '/api/auth/me' && request.method === 'GET') return me(db, request);
  if (path === '/api/auth/sync' && request.method === 'POST') return setSync(db, request);
  if (path === '/api/auth/change-password' && request.method === 'POST') return changePassword(db, request);
  if (path === '/api/auth/delete-account' && request.method === 'POST') return deleteAccount(db, request);
  if (path === '/api/auth/forgot' && request.method === 'POST') return forgot(db, env, request);
  if (path === '/api/auth/reset-password' && request.method === 'POST') return resetPassword(db, request);
  if (path === '/api/auth/admin-reset-code' && request.method === 'POST') return adminResetCode(db, env, request);
  return json({ error: 'method not allowed' }, 405);
}

/* ---------- 注册 ---------- */
async function register(db, env, request) {
  const rb = await readAuthJson(request);
  if (rb.tooLarge) return json({ error: '请求体过大（最大 64KB）' }, 413);
  const body = rb.body;
  if (!body) return json({ error: 'invalid json' }, 400);
  const v = validate(body);
  if (v.error) return json({ error: v.error }, 400);

  // 注册限流：IP 与邮箱双维度（防脚本刷号 / 防单邮箱被反复注册）
  const regIp = await rateWindow(db, 'rate:reg:ip:' + clientIp(request), 10 * 60 * 1000, 30);
  if (regIp.failed) return json({ error: '服务繁忙，请稍后再试' }, 503);
  if (regIp.count > 30) return json({ error: '注册太频繁，请稍后再试' }, 429);
  const regEmail = await rateWindow(db, 'rate:reg:email:' + v.email, 60 * 60 * 1000, 5);
  if (regEmail.failed) return json({ error: '服务繁忙，请稍后再试' }, 503);
  if (regEmail.count > 5) return json({ error: '该邮箱注册过于频繁，请稍后再试' }, 429);

  const sync = sanitizeSync(body.sync);
  if (sync === undefined) return json({ error: '同步码密文格式不正确' }, 400);

  const id = randomHex(16);
  const now = Date.now();
  const { salt, hash } = await hashPassword(v.password);
  const passwordHash = `pbkdf2:${PBKDF2_ITERATIONS}:${b64(salt)}:${b64(hash)}`;
  const token = newSessionToken();
  const tokenHash = await hashToken(token);

  try {
    // 用户 + 会话同一批次原子写入：不会出现"用户建了但会话没建"
    await db.batch([
      db.prepare('INSERT INTO users (id, email, password_hash, nickname, sync_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, v.email, passwordHash, v.nickname, sync ? JSON.stringify(sync) : null, now, now),
      db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(tokenHash, id, now, sessionExpiry()),
    ]);
  } catch (error) {
    const message = String((error && error.message) || '');
    if (/UNIQUE|unique/i.test(message)) return json({ error: '该邮箱已注册，请直接登录' }, 409);
    console.error('register db error:', error);
    return json({ error: 'internal error' }, 500);
  }
  return json({ ok: true, token, user: { id, email: v.email, nickname: v.nickname }, sync: sync || null }, 201);
}

/* ---------- 登录 ---------- */
async function login(db, env, request) {
  const rb = await readAuthJson(request);
  if (rb.tooLarge) return json({ error: '请求体过大（最大 64KB）' }, 413);
  const body = rb.body;
  if (!body) return json({ error: 'invalid json' }, 400);
  const v = validate(body);
  if (v.error) return json({ error: v.error }, 400);

  const ipCheck = await loginIpCheck(env, request);
  if (!ipCheck.ok) return json({ error: ipCheck.error }, ipCheck.failed ? 503 : 429);
  const emailCheck = await loginEmailCheck(db, v.email);
  if (!emailCheck.ok) return json({ error: emailCheck.error }, emailCheck.failed ? 503 : 429);

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(v.email).first();
  if (!user || !(await verifyPassword(v.password, user.password_hash))) {
    await recordLoginFail(db, v.email);
    // 不区分"邮箱不存在"和"密码错"，避免账号枚举
    return json({ error: '邮箱或密码不正确' }, 401);
  }
  await recordLoginSuccess(db, v.email);

  // 懒清理过期会话（顺带，避免 sessions 表无限增长）
  try { await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run(); } catch (_) {}

  const token = newSessionToken();
  const now = Date.now();
  await db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), user.id, now, sessionExpiry()).run();

  return json({
    ok: true,
    token,
    user: { id: user.id, email: user.email, nickname: user.nickname || '' },
    sync: user.sync_encrypted ? safeParseJson(user.sync_encrypted, null) : null,
  });
}

/* ---------- 登出 ---------- */
async function logout(db, request) {
  const token = bearerToken(request);
  if (!token) return json({ error: 'unauthorized' }, 401);
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await hashToken(token)).run();
  return json({ ok: true });
}

/* ---------- 当前用户 ---------- */
async function me(db, request) {
  const row = await sessionUser(db, request);
  if (!row) return json({ error: 'unauthorized' }, 401);
  return json({
    ok: true,
    user: { id: row.id, email: row.email, nickname: row.nickname || '' },
    sync: row.sync_encrypted ? safeParseJson(row.sync_encrypted, null) : null,
  });
}

/* ---------- 绑定 / 更新同步码保险箱 ---------- */
async function setSync(db, request) {
  const row = await sessionUser(db, request);
  if (!row) return json({ error: 'unauthorized' }, 401);
  const rb = await readAuthJson(request);
  if (rb.tooLarge) return json({ error: '请求体过大' }, 413);
  if (!rb.body) return json({ error: 'invalid json' }, 400);
  const sync = sanitizeSync(rb.body.sync);
  if (sync === undefined) return json({ error: '同步码密文格式不正确' }, 400);
  await db.prepare('UPDATE users SET sync_encrypted = ?, updated_at = ? WHERE id = ?')
    .bind(sync ? JSON.stringify(sync) : null, Date.now(), row.id).run();
  return json({ ok: true });
}

/* ---------- 改密码 ----------
 * 客户端必须同时提交「用新密码重新加密的同步码」，
 * 否则改完密码旧密文就解不开了（服务端没有旧密码，无法代劳）。 */
async function changePassword(db, request) {
  const row = await sessionUser(db, request);
  if (!row) return json({ error: 'unauthorized' }, 401);
  const rb = await readAuthJson(request);
  if (rb.tooLarge) return json({ error: '请求体过大' }, 413);
  const body = rb.body;
  if (!body) return json({ error: 'invalid json' }, 400);

  const err = passwordError(body);
  if (err) return json({ error: err }, 400);
  const oldPassword = String(body.oldPassword || '');
  if (!oldPassword) return json({ error: '请输入当前密码' }, 400);

  const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(row.id).first();
  if (!user || !(await verifyPassword(oldPassword, user.password_hash))) {
    return json({ error: '当前密码不正确' }, 401);
  }

  const sync = sanitizeSync(body.sync);
  if (sync === undefined) return json({ error: '同步码密文格式不正确' }, 400);

  const { salt, hash } = await hashPassword(String(body.newPassword));
  const now = Date.now();
  const passwordHash = `pbkdf2:${PBKDF2_ITERATIONS}:${b64(salt)}:${b64(hash)}`;

  // 改密码 + 清空其它设备会话（当前会话保留），同一个批次里完成
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, sync_encrypted = ?, updated_at = ? WHERE id = ?')
      .bind(passwordHash, sync ? JSON.stringify(sync) : row.sync_encrypted, now, row.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').bind(row.id, await hashToken(bearerToken(request))),
    db.prepare('DELETE FROM reset_tokens WHERE email = ?').bind(row.email),
  ]);
  return json({ ok: true });
}

/* ---------- 注销账号 ----------
 * 注意：这里只删除**账号侧**的数据（用户、会话、保险箱密文）。
 * 云端同步快照在同步服务那边，由客户端在注销前自行调用同步接口清空，
 * 或由管理员按同步码处理 —— 服务端拿不到同步码（它是加密的），删不了。 */
async function deleteAccount(db, request) {
  const row = await sessionUser(db, request);
  if (!row) return json({ error: 'unauthorized' }, 401);
  const rb = await readAuthJson(request);
  if (rb.tooLarge) return json({ error: '请求体过大' }, 413);
  const body = rb.body || {};

  const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(row.id).first();
  if (!user || !(await verifyPassword(String(body.password || ''), user.password_hash))) {
    return json({ error: '密码不正确，无法注销' }, 401);
  }

  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id),
    db.prepare('DELETE FROM reset_tokens WHERE email = ?').bind(row.email),
    db.prepare('DELETE FROM login_fails WHERE email = ?').bind(row.email),
    db.prepare('DELETE FROM users WHERE id = ?').bind(row.id),
  ]);
  return json({ ok: true });
}

/* ---------- 找回密码第 1 步：发验证码 ---------- */
async function forgot(db, env, request) {
  const rb = await readAuthJson(request);
  if (rb.tooLarge) return json({ error: '请求体过大' }, 413);
  const body = rb.body;
  if (!body) return json({ error: 'invalid json' }, 400);
  const email = normalizeEmail(body);
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);

  // 三重限流，且限流器故障一律拒绝（不能故障即放行）
  const rlEmail = await rateWindow(db, 'rate:forgot:' + email, 60000, 1);
  if (rlEmail.failed) return json({ error: '服务繁忙，请稍后再试' }, 503);
  if (rlEmail.count > 1) return json({ error: '发送太频繁，请 1 分钟后再试' }, 429);
  const rlIp = await rateWindow(db, 'rate:forgot:ip:' + clientIp(request), 10 * 60 * 1000, 10);
  if (rlIp.failed) return json({ error: '服务繁忙，请稍后再试' }, 503);
  if (rlIp.count > 10) return json({ error: '发送太频繁，请稍后再试' }, 429);
  const rlGlobal = await rateWindow(db, 'rate:forgot:global', 60000, 30);
  if (rlGlobal.failed) return json({ error: '系统繁忙，请稍后再试' }, 503);
  if (rlGlobal.count > 30) return json({ error: '系统繁忙，请稍后再试' }, 429);

  const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  // 邮箱不存在也返回 ok，避免账号枚举
  if (!user) return json({ ok: true });

  const code = generateResetCode();
  const now = Date.now();
  // 先入库再发信；发信失败回滚验证码（避免"用户收到码但库里没有"）
  try {
    await db.prepare('INSERT OR REPLACE INTO reset_tokens (email, code_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
      .bind(email, await sha256Hex(code), now + RESET_TTL_MS, now).run();
  } catch (error) {
    console.error('forgot reset_tokens error:', error);
    return json({ error: '服务繁忙，请稍后再试' }, 503);
  }

  const service = env.SERVICE_NAME || '回译本';
  const sent = await sendEmail(env, {
    to: email,
    subject: `${service} - 密码重置验证码`,
    text: `你的密码重置验证码是：${code}\n\n15 分钟内有效。\n\n`
      + `⚠️ 重要：重置密码后，用旧密码加密的「同步码」将无法自动解锁。\n`
      + `如果你还想找回原来的课文库和收藏，请先在还登录着的设备上导出备份，\n`
      + `或提前把同步码抄下来。\n`,
  });
  if (!sent.ok) {
    console.error('forgot smtp error:', sent.error);
    await db.prepare('DELETE FROM reset_tokens WHERE email = ?').bind(email).run().catch(() => {});
    return json({ error: '邮件发送失败，请稍后重试或联系管理员' }, 503);
  }
  return json({ ok: true });
}

/* ---------- 找回密码第 2 步：校验码 + 设新密码 ---------- */
async function resetPassword(db, request) {
  const rb = await readAuthJson(request);
  if (rb.tooLarge) return json({ error: '请求体过大' }, 413);
  const body = rb.body;
  if (!body) return json({ error: 'invalid json' }, 400);
  const email = normalizeEmail(body);
  const code = String(body.code || '').trim();
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  const err = passwordError(body);
  if (err) return json({ error: err }, 400);
  if (!/^\d{8}$/.test(code)) return json({ error: '验证码应为 8 位数字' }, 400);

  // 防暴力猜码：按邮箱与 IP 双维度限次
  const attemptIp = await rateWindow(db, 'rate:reset:ip:' + clientIp(request), 10 * 60 * 1000, 20);
  if (attemptIp.failed) return json({ error: '服务繁忙，请稍后再试' }, 503);
  if (attemptIp.count > 20) return json({ error: '尝试过于频繁，请稍后再试' }, 429);
  const attemptEmail = await rateWindow(db, 'rate:reset:' + email, 15 * 60 * 1000, 10);
  if (attemptEmail.failed) return json({ error: '服务繁忙，请稍后再试' }, 503);
  if (attemptEmail.count > 10) return json({ error: '尝试次数过多，请重新获取验证码' }, 429);

  const row = await db.prepare('SELECT code_hash, expires_at, used FROM reset_tokens WHERE email = ?').bind(email).first();
  if (!row || row.used || row.expires_at < Date.now()) {
    return json({ error: '验证码无效或已过期，请重新获取' }, 400);
  }
  // 恒定时间比较
  if (!timingSafeEqual(await sha256Hex(code), row.code_hash)) {
    return json({ error: '验证码不正确' }, 400);
  }

  const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!user) return json({ error: '账号不存在' }, 404);

  const sync = sanitizeSync(body.sync);
  if (sync === undefined) return json({ error: '同步码密文格式不正确' }, 400);

  const { salt, hash } = await hashPassword(String(body.newPassword));
  const now = Date.now();
  const passwordHash = `pbkdf2:${PBKDF2_ITERATIONS}:${b64(salt)}:${b64(hash)}`;

  // 改密码 + 标记验证码已用 + 踢掉全部旧会话 + 清失败计数，同一批次
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, sync_encrypted = ?, updated_at = ? WHERE id = ?')
      .bind(passwordHash, sync ? JSON.stringify(sync) : null, now, user.id),
    db.prepare('UPDATE reset_tokens SET used = 1 WHERE email = ?').bind(email),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    db.prepare('DELETE FROM login_fails WHERE email = ?').bind(email),
  ]);
  return json({ ok: true });
}

/* ---------- 管理员：手动生成重置码（用户在邮件里收不到时的兜底） ---------- */
async function adminResetCode(db, env, request) {
  const token = bearerToken(request);
  if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const rb = await readAuthJson(request);
  if (rb.tooLarge) return json({ error: '请求体过大' }, 413);
  const email = normalizeEmail(rb.body || {});
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);

  const code = generateResetCode();
  const now = Date.now();
  await db.prepare('INSERT OR REPLACE INTO reset_tokens (email, code_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
    .bind(email, await sha256Hex(code), now + RESET_TTL_MS, now).run();
  return json({ ok: true, email, code, expiresInMinutes: 15 });
}

export { sessionUser, hashToken };
