/**
 * 通用滚动窗口限流（D1 rate 表）。
 *
 * 为什么用 D1 而不是 KV：SQLite 强一致，同一次攻击的连续请求打到不同边缘节点
 * 也能正确累计；KV 最终一致，实测会被互相覆盖而失效。
 *
 * 单语句 UPSERT 完成"读+判断+写"，天然原子，不需要额外加锁。
 */

export async function rateWindow(db, key, windowMs, _max) {
  try {
    const now = Date.now();
    const end = now + windowMs;
    const row = await db.prepare(
      'INSERT INTO rate (key, count, until) VALUES (?1, 1, ?2) '
      + 'ON CONFLICT(key) DO UPDATE SET '
      + 'count = CASE WHEN rate.until <= ?3 THEN 1 ELSE rate.count + 1 END, '
      + 'until = CASE WHEN rate.until <= ?3 THEN ?4 ELSE rate.until END '
      + 'RETURNING count'
    ).bind(key, end, now, end).first();
    return { count: row ? Number(row.count) : 0, failed: false };
  } catch (error) {
    console.error('rateWindow error:', error);
    // 限流器故障时**保守拒绝**（调用方据此返回 503），
    // 不能"故障即放行" —— 那等于给攻击者一个关掉限流开关的按钮。
    return { count: 0, failed: true };
  }
}

/** 取客户端 IP（Cloudflare 会把真实来源写进 CF-Connecting-IP）。 */
export const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';
