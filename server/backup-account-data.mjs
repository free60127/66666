/** 私有运维工具：备份迁移涉及的 Redis 键，只输出数量。备份含个人数据，权限为 0600。 */
import fs from 'node:fs';
import path from 'node:path';

const envFile = path.resolve(process.argv[2] || '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) throw new Error('需要配置持久存储');
const command = async (body) => {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const reply = await r.json();
  if (!r.ok || reply.error) throw new Error('备份存储访问失败');
  return reply.result;
};
const keys = new Set();
for (const prefix of ['bts:acct:user:', 'bts:acct:email:', 'bts:sync:', 'bts:user-data:', 'bts:legacy-owner:', 'bts:user-data-deleted:']) {
  let cursor = '0';
  do {
    const result = await command(['SCAN', cursor, 'MATCH', prefix + '*', 'COUNT', '500']);
    cursor = String(result[0]);
    result[1].filter((k) => !k.endsWith(':lock')).forEach((k) => keys.add(k));
  } while (cursor !== '0');
}
const list = [...keys];
const records = [];
for (let i = 0; i < list.length; i += 100) {
  const chunk = list.slice(i, i + 100);
  const values = await command(['MGET', ...chunk]);
  values.forEach((value, j) => { if (value !== null) records.push({ key: chunk[j], value }); });
}
const docs = (prefix) => records.filter((r) => r.key.startsWith(prefix)).map((r) => JSON.parse(r.value));
const users = docs('bts:acct:user:');
const legacy = docs('bts:sync:');
const data = docs('bts:user-data:');
if (!process.argv.includes('--audit')) {
  const outputDir = path.resolve(process.argv[3] || 'backups');
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const file = path.join(outputDir, 'account-migration-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), records }), { mode: 0o600, flag: 'wx' });
  console.log('Private backup saved:', file);
}
console.log(JSON.stringify({ records: records.length, accounts: users.length, pendingLegacyAccounts: users.filter((u) => u.syncEnc).length,
  legacySnapshots: legacy.length, claimedLegacySnapshots: legacy.filter((d) => d.migratedTo).length,
  accountSnapshots: data.filter((d) => !d.deleted).length, deletedSnapshots: data.filter((d) => d.deleted).length }));
