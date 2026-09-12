/**
 * 回译本 · 账号服务（Cloudflare Worker）
 *
 * 只做一件事：账号与会话。**不碰模型调用**（那是长任务，留在 Render 上的 Node 后端）。
 * 这样这个 Worker 每次请求都是短平快的 D1 查询 + 一次 PBKDF2，
 * 稳稳落在 Workers 免费版 10 ms CPU 配额内。
 *
 * 路由：
 *   GET  /api/health               健康检查
 *   POST /api/auth/register        注册（可选同时提交加密同步码）
 *   POST /api/auth/login           登录 → 返回 token + 加密同步码
 *   POST /api/auth/logout          登出
 *   GET  /api/auth/me              当前用户 + 加密同步码
 *   POST /api/auth/sync            绑定/更新加密同步码（换设备后回填用）
 *   POST /api/auth/change-password 改密码（必须同时提交用新密码重加密的同步码）
 *   POST /api/auth/delete-account  注销账号
 *   POST /api/auth/forgot          发重置验证码到邮箱
 *   POST /api/auth/reset-password  校验验证码 + 设新密码
 *   POST /api/auth/admin-reset-code 管理员兜底生成重置码（需要 ADMIN_TOKEN）
 *
 * 跨域：回译本前端与本站不同源（Render / localhost），
 * 因此必须按 ALLOWED_ORIGINS 白名单回显 Origin —— 不能用 *。
 */
import { handleAuth } from './auth.js';
import { json } from './http.js';

const ALLOWED_ORIGINS = (env) =>
  String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** 只对白名单来源回显 CORS 头；其余不带 CORS 头，浏览器自行拦截。 */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin || !ALLOWED_ORIGINS(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const response = await route(request, env);
    for (const [k, v] of Object.entries(corsHeaders(request, env))) {
      response.headers.set(k, v);
    }
    // 账号响应一律不缓存（否则代理可能把某个用户的会话响应发给别人）
    if (new URL(request.url).pathname.startsWith('/api/')) {
      response.headers.set('Cache-Control', 'no-store');
    }
    return response;
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (path === '/api/health') {
    return json({
      ok: true,
      service: env.SERVICE_NAME || '回译本',
      db: Boolean(env.DB),
      smtp: Boolean(env.SMTP_USER && env.SMTP_PASS),
      time: Date.now(),
    });
  }

  if (path.startsWith('/api/auth/')) {
    try {
      return await handleAuth(request, env, path);
    } catch (error) {
      // 未预期异常只在服务端日志留全量，不回显内部信息
      console.error('auth error:', error && error.stack ? error.stack : error);
      return json({ error: '服务器内部错误，请稍后重试' }, 500);
    }
  }

  if (path.startsWith('/api/')) {
    return json({ error: 'unknown api' }, 404);
  }
  return json({ error: 'not found' }, 404);
}
