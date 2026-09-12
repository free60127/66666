/**
 * 公共 HTTP / 安全工具。
 * 与 study platform 的 workers/src/http.js 保持同一套语义（常量时间比较、UTF-8 字节数校验）。
 */

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export const methodNotAllowed = () => json({ error: 'method not allowed' }, 405);

/** D1 里存的 JSON 损坏时不直接 500。 */
export const safeParseJson = (text, fallback = null) => {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch (_) { return fallback; }
};

/** 认证请求体上限（恢复码/同步码密文远小于这个数）。 */
export const MAX_AUTH_BODY = 64 * 1024;

/**
 * 读取并解析 JSON body。
 * 注意用 **UTF-8 字节数** 判超限，不能用 text.length ——
 * 中文一个字 3 字节，用字符数校验会被绕过。
 */
export async function readJsonBody(request, max = MAX_AUTH_BODY) {
  const cl = Number(request.headers.get('content-length') || 0);
  if (cl > max) throw new Error('payload too large');
  let text;
  try { text = await request.text(); } catch { return null; }
  if (new TextEncoder().encode(text).byteLength > max) throw new Error('payload too large');
  try { return JSON.parse(text); } catch { return null; }
}

/** Authorization: Bearer <token> */
export function bearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.replace(/^Bearer\s+/i, '');
}

/** 恒定时间字符串比较：不做短路返回，防通过响应耗时逐字符猜测。 */
export function timingSafeEqual(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  let diff = sa.length === sb.length ? 0 : 1;
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}
