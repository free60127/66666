/**
 * 极简 SMTP 客户端（Cloudflare Workers TCP sockets）。
 *
 * 用途只有一个：**找回密码发验证码**。别拿它做日常通知 ——
 * QQ 免费邮箱有每日发信量上限，而且 QQ SMTP 发出的信容易被判垃圾邮件。
 *
 * 为什么是 QQ 邮箱：个人免费、零资质、零审核。
 * 手机短信要企业实名（阿里云已公告不支持个人自用资质），微信/QQ 登录要企业开发者认证，
 * 只有"用自己的邮箱当 SMTP"这条路是个人今天就能走通的。
 *
 * 配置（用 wrangler secret put，别写进代码）：
 *   SMTP_USER  例如 3338095791@qq.com
 *   SMTP_PASS  QQ 邮箱「授权码」（在 QQ 邮箱设置→账户里开通，不是 QQ 密码）
 *   SMTP_HOST  缺省 smtp.qq.com
 *   SMTP_PORT  缺省 465（TLS）
 *   SMTP_FROM  缺省同 SMTP_USER
 *
 * 未配置时 sendEmail 返回 {ok:false}，forgot 接口据此返回 503，不影响其它功能。
 * 测试钩子：env.SMTP_TEST_MODE 时邮件 push 到 env.SMTP_SENT 而不真发。
 */

// cloudflare:sockets 只在 Workers 运行时可用；Node 下动态 import 失败则置 null。
let connect = null;
try { ({ connect } = await import('cloudflare:sockets')); } catch (_) { connect = null; }

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

async function readLine(reader, buffer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const nl = buffer.indexOf(10);
    if (nl >= 0) {
      const bytes = buffer.splice(0, nl + 1);
      return DECODER.decode(new Uint8Array(bytes)).replace(/\r?\n$/, '');
    }
    if (Date.now() > deadline) throw new Error('SMTP read timeout');
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('SMTP read timeout')), timeoutMs)),
    ]);
    if (done) throw new Error('SMTP connection closed');
    buffer.push(...value);
  }
}

async function expectCode(line, wanted, label) {
  const code = Number(line.slice(0, 3));
  if (code !== wanted) throw new Error(`SMTP ${label} failed: ${line}`);
}

const b64 = (s) => {
  const bytes = ENCODER.encode(s);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
};

const wrapBase64 = (value) => value.match(/.{1,76}/g)?.join('\r\n') || '';
/** 邮件头里绝不允许出现换行（防头注入）。 */
const headerValue = (value) => String(value || '').replace(/[\r\n]+/g, ' ');

const buildMessage = ({ from, to, subject, text, html }) => {
  const useHtml = typeof html === 'string' && html;
  const content = useHtml ? html : String(text || '');
  return [
    'From: ' + headerValue(from),
    'To: ' + headerValue(to),
    'Subject: =?UTF-8?B?' + b64(headerValue(subject)) + '?=',
    'MIME-Version: 1.0',
    'Content-Type: ' + (useHtml ? 'text/html' : 'text/plain') + '; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(b64(content)),
  ].join('\r\n');
};

/** 发送一封邮件。返回 {ok:true} 或 {ok:false, error}。 */
export async function sendEmail(env, { to, subject, text, html }) {
  const from = env.SMTP_FROM || env.SMTP_USER || '';
  if (env.SMTP_TEST_MODE) {
    if (!env.SMTP_SENT) env.SMTP_SENT = [];
    env.SMTP_SENT.push({ to, subject, text, html, raw: buildMessage({ from, to, subject, text, html }) });
    return { ok: true, test: true };
  }
  if (!connect) return { ok: false, error: 'sockets unavailable' };
  if (!env.SMTP_USER || !env.SMTP_PASS) return { ok: false, error: 'smtp not configured' };

  const host = env.SMTP_HOST || 'smtp.qq.com';
  const port = Number(env.SMTP_PORT || 465);
  let socket = null;
  let writer = null;
  let reader = null;
  try {
    socket = connect({ hostname: host, port }, { secureTransport: 'on' });
    await socket.opened; // 连接 + TLS 握手完成
    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();
    const buffer = [];
    let step = 'connect';
    const write = async (line) => { await writer.write(ENCODER.encode(line + '\r\n')); };
    const read = async () => {
      try { return await readLine(reader, buffer, 15000); } catch (e) { throw new Error(step + ': ' + e.message); }
    };

    step = 'greeting';
    await expectCode(await read(), 220, 'greeting');

    step = 'ehlo';
    await write('EHLO hyt-auth');
    let line = await read();
    while (line.length >= 4 && line[3] === '-') line = await read();
    await expectCode(line, 250, 'EHLO');

    step = 'auth-login';
    await write('AUTH LOGIN');
    await expectCode(await read(), 334, 'AUTH');
    step = 'auth-user';
    await write(b64(env.SMTP_USER));
    await expectCode(await read(), 334, 'AUTH user');
    step = 'auth-pass';
    await write(b64(env.SMTP_PASS));
    await expectCode(await read(), 235, 'AUTH login');

    step = 'mail-from';
    await write('MAIL FROM:<' + from + '>');
    await expectCode(await read(), 250, 'MAIL FROM');
    step = 'rcpt-to';
    await write('RCPT TO:<' + to + '>');
    await expectCode(await read(), 250, 'RCPT TO');
    step = 'data';
    await write('DATA');
    await expectCode(await read(), 354, 'DATA');
    step = 'data-body';
    await write(buildMessage({ from, to, subject, text, html }).replace(/^\./gm, '.$&'));
    step = 'data-dot';
    await write('.');
    await expectCode(await read(), 250, 'DATA end');

    step = 'quit';
    await write('QUIT');
    await read().catch(() => {});
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    try { reader?.releaseLock(); } catch (_) {}
    try { writer?.releaseLock(); } catch (_) {}
    try { await socket?.close(); } catch (_) {}
  }
}

/** 8 位数字找回码（用 CSPRNG，不要用 Math.random）。 */
export function generateResetCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 100000000;
  return String(n).padStart(8, '0');
}
