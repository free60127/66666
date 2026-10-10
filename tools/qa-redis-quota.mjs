/** Optional Redis integration: disposable namespace, never real user/quota keys. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUpstashKv } from '../server/kv.mjs';
import { reserveDailyQuota } from '../server/usage.mjs';

// Passing an env file lets a VPS run this without displaying credentials.
if (process.argv[2]) {
  for (const line of fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(UPSTASH_REDIS_REST_(?:URL|TOKEN))\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const kv = createUpstashKv({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
assert(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const prefix = 'bts:qa-quota:' + randomUUID() + ':';
const global = { key: prefix + 'global', limit: 5 };
const first = { key: prefix + 'a', limit: 3 };
const second = { key: prefix + 'b', limit: 5 };
try {
  const one = await Promise.all(Array.from({ length: 12 }, () => reserveDailyQuota(kv, [first, global])));
  assert(one.every((r) => !r.failed));
  assert.equal(one.filter((r) => !r.blocked).length, 3);
  assert.equal(await kv.get(global.key), '3');
  const two = await Promise.all(Array.from({ length: 8 }, () => reserveDailyQuota(kv, [second, global])));
  assert(two.every((r) => !r.failed));
  assert.equal(two.filter((r) => !r.blocked).length, 2);
  assert.equal(await kv.get(global.key), '5');
  assert.equal(await kv.get(first.key), '3');
  assert.equal(await kv.get(second.key), '2');
  console.log('PASS 真实 Upstash：并发只接纳 3+2 次，个人超额不吞全局额度，全局超额不扣个人额度');
} finally { await Promise.all([first, second, global].map((p) => kv.del(p.key))); }
