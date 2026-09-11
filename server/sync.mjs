/**
 * 云同步存储层。
 *
 * 免费额度下没有数据库，这里用最省事的模型：
 *   「同步码（32 位 hex） → 一份 JSON 快照」
 *
 * 两种驱动：
 *   1) Upstash Redis（REST API，零依赖，直接用 fetch）—— 生产用，数据持久
 *   2) 本地文件 data/sync/<code>.json —— 开发 / 自托管用
 *
 * 安全说明：同步码本身就是凭证，拿到码的人可以读写这份数据，
 * 所以码用 128 位随机数，不可猜；界面上也按"密码"对待（可随时换码）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const CODE_RE = /^[a-f0-9]{32}$/;
/** 单份快照上限（纯文本数据，正常远小于这个数） */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export const newSyncCode = () => randomBytes(16).toString('hex');
export const isValidSyncCode = (code) => CODE_RE.test(String(code || ''));

export const emptySnapshot = () => ({ libraries: [], favorites: [], history: [] });

/** 只保留认识的字段，避免把任意 JSON 塞进存储。 */
export function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const out = { libraries: arr(raw.libraries), favorites: arr(raw.favorites), history: arr(raw.history) };
  if (JSON.stringify(out).length > MAX_SNAPSHOT_BYTES) return null;
  return out;
}

/** Upstash Redis REST 驱动（用 JSON 数组形式发命令）。 */
export function createUpstashStore({ url, token, prefix = 'bts:sync:' }) {
  const endpoint = String(url).replace(/\/+$/, '');
  const call = async (command) => {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Upstash 请求失败 ' + r.status + '：' + text.slice(0, 200));
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Upstash 返回不是 JSON：' + text.slice(0, 200)); }
    if (parsed.error) throw new Error('Upstash 错误：' + parsed.error);
    return parsed.result;
  };
  return {
    kind: 'upstash',
    durable: true,
    async read(code) {
      const raw = await call(['GET', prefix + code]);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async write(code, doc) {
      await call(['SET', prefix + code, JSON.stringify(doc)]);
    },
  };
}

/** 本地文件驱动：仅用于开发/自托管；托管平台上的磁盘通常是临时的。 */
export function createFileStore(dir) {
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  ensure();
  const fileOf = (code) => path.join(dir, code + '.json');
  return {
    kind: 'file',
    durable: false,
    async read(code) {
      try { return JSON.parse(fs.readFileSync(fileOf(code), 'utf8')); } catch { return null; }
    },
    async write(code, doc) {
      try {
        fs.writeFileSync(fileOf(code), JSON.stringify(doc));
      } catch (e) {
        // 目录可能在运行期被清掉（平台重置磁盘 / 手工清理）——自愈一次，别直接把 500 抛给用户
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
          ensure();
          fs.writeFileSync(fileOf(code), JSON.stringify(doc));
          return;
        }
        throw e;
      }
    },
  };
}

/**
 * 按环境变量选择驱动。
 * 配了 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN 就用 Upstash，否则退回本地文件。
 */
export function createSyncStore(root) {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (url && token) return createUpstashStore({ url, token });
  return createFileStore(path.join(root, 'data', 'sync'));
}
