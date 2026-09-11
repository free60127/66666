/**
 * 极简 SMTP 客户端（Node 内置 tls，零依赖）。
 *
 * 用途只有一个：**找回密码发验证码**。别拿它做日常通知 ——
 * QQ 免费邮箱有每日发信量上限，而且 QQ SMTP 发出的信容易被判垃圾邮件。
 *
 * 为什么是 QQ 邮箱：个人免费、零资质、零审核。
 * 手机短信要企业实名（阿里云已公告不支持个人自用资质），微信/QQ 登录要企业开发者认证，
 * 只有"用自己的邮箱当 SMTP"这条路是个人今天就能走通的。
 *
 * 配置（.env）：
 *   SMTP_USER  例如 3338095791@qq.com
 *   SMTP_PASS  QQ 邮箱「授权码」（QQ 邮箱设置→账户 里开通，不是 QQ 密码）
 *   SMTP_HOST  缺省 smtp.qq.com
 *   SMTP_PORT  缺省 465（TLS）
 *   SMTP_FROM  缺省同 SMTP_USER
 *
 * 未配置时 sendMail 返回 {ok:false}，找回接口据此返回 503，不影响其它功能。
 * 测试钩子：SMTP_TEST_MODE=1 时不真发，而是推进 sent[] 数组。
 */
import tls from 'node:tls';

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
/** 邮件头里绝不允许出现换行（防头注入）。 */
const headerValue = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');

const buildMessage = ({ from, to, subject, text, html }) => {
  const useHtml = typeof html === 'string' && html;
  const content = useHtml ? html : String(text || '');
  const body = Buffer.from(content, 'utf8').toString('base64');
  return [
    'From: ' + headerValue(from),
    'To: ' + headerValue(to),
    'Subject: =?UTF-8?B?' + b64(headerValue(subject)) + '?=',
    'MIME-Version: 1.0',
    'Content-Type: ' + (useHtml ? 'text/html' : 'text/plain') + '; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    (body.match(/.{1,76}/g) || []).join('\r\n'),
  ].join('\r\n');
};

/** 发一封邮件。返回 {ok:true} 或 {ok:false, error}。 */
export async function sendMail({ to, subject, text, html, env = process.env, sent }) {
  const from = env.SMTP_FROM || env.SMTP_USER || '';
  const message = buildMessage({ from, to, subject, text, html });

  if (env.SMTP_TEST_MODE === '1') {
    if (Array.isArray(sent)) sent.push({ to, subject, text, html, raw: message });
    return { ok: true, test: true };
  }
  if (!env.SMTP_USER || !env.SMTP_PASS) return { ok: false, error: 'smtp not configured' };

  const host = env.SMTP_HOST || 'smtp.qq.com';
  const port = Number(env.SMTP_PORT || 465);
  const timeoutMs = 20000;

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { socket.destroy(); } catch (_) {} resolve(r); } };

    let socket;
    try {
      socket = tls.connect({ host, port, servername: host }, () => { /* TLS 握手完成，开始对话 */ });
    } catch (e) {
      return done({ ok: false, error: 'connect failed: ' + e.message });
    }
    socket.setTimeout(timeoutMs, () => done({ ok: false, error: `SMTP 超时（${timeoutMs / 1000} 秒）` }));
    socket.on('error', (e) => done({ ok: false, error: String(e && e.message) }));

    let buffer = '';
    const queue = [];          // 已到达但还没被消费的完整行
    let waiter = null;         // 正在等行的那个 read()

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (waiter) { const w = waiter; waiter = null; w(line); } else { queue.push(line); }
      }
    });

    const readLine = () => (queue.length ? Promise.resolve(queue.shift())
      : new Promise((res, rej) => {
        waiter = res;
        socket.setTimeout(timeoutMs, () => rej(new Error('SMTP read timeout')));
      }));

    const write = (line) => { socket.write(line + '\r\n'); };
    const expect = (line, code, label) => {
      if (Number(String(line).slice(0, 3)) !== code) throw new Error(`SMTP ${label} failed: ${line}`);
    };

    (async () => {
      try {
        expect(await readLine(), 220, 'greeting');

        write('EHLO hyt-studio');
        let line = await readLine();
        while (line.length >= 4 && line[3] === '-') line = await readLine(); // 多行响应
        expect(line, 250, 'EHLO');

        write('AUTH LOGIN');
        expect(await readLine(), 334, 'AUTH');
        write(b64(env.SMTP_USER));
        expect(await readLine(), 334, 'AUTH user');
        write(b64(env.SMTP_PASS));
        expect(await readLine(), 235, 'AUTH login');

        write('MAIL FROM:<' + from + '>');
        expect(await readLine(), 250, 'MAIL FROM');
        write('RCPT TO:<' + to + '>');
        expect(await readLine(), 250, 'RCPT TO');
        write('DATA');
        expect(await readLine(), 354, 'DATA');
        // 正文里以 . 开头的行必须转义成 ..（RFC 5321）
        write(message.replace(/^\./gm, '.$&'));
        write('.');
        expect(await readLine(), 250, 'DATA end');

        write('QUIT');
        done({ ok: true });
      } catch (e) {
        done({ ok: false, error: String((e && e.message) || e) });
      }
    })();
  });
}
