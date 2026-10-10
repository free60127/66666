/** Daily quota reservations; midnight is defined in Asia/Shanghai (UTC+8). */
export const usageDay = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

export async function reserveDailyQuota(kv, pools, now = Date.now()) {
  const resetAt = Date.parse(usageDay(now) + 'T00:00:00+08:00') + 86400000;
  try {
    const result = await kv.reserveQuota(pools, Math.max(1, Math.ceil((resetAt - now) / 1000)));
    return { ...result, resetAt, failed: false };
  } catch {
    // A broken quota store must not turn paid site keys into unlimited public keys.
    return { blocked: 0, counts: [], resetAt, failed: true };
  }
}
