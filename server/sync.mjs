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

/**
 * 快照的结构限额。
 * 只卡总字节数是不够的：2MB 里可以塞进几万个极小元素，解析、合并和前端渲染都会被拖垮。
 * 所以条数与单条体积都要卡。限额都远高于真实用量，正常用户碰不到。
 */
export const SNAPSHOT_LIMITS = Object.freeze({
  libraries: 100,
  lessonsPerLibrary: 1000,
  favorites: 5000,
  history: 200,
  libraryIdChars: 64,
  libraryNameChars: 80,
  lessonTitleChars: 300,
  lessonFieldChars: 40000, // chinese / english 单字段上限（真实课文约 1-3 千字符）
  favoriteBytes: 20000,    // 单条收藏的 JSON 体积
  historyBytes: 2000,      // 单条历史的 JSON 体积
});

export const newSyncCode = () => randomBytes(16).toString('hex');
export const isValidSyncCode = (code) => CODE_RE.test(String(code || ''));

export const emptySnapshot = () => ({ libraries: [], favorites: [], history: [] });

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const jsonBytes = (v) => {
  try { return JSON.stringify(v).length; } catch { return Infinity; }
};
const boundedString = (v, max) => String(v == null ? '' : v).slice(0, max);

/**
 * 校验并重建同步快照：只保留认识的字段、卡条数与单条体积。
 * 超限时**明确拒绝**而不是悄悄截断 —— 静默丢用户数据比报错更糟。
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
export function sanitizeSnapshot(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: '同步数据必须是一个 JSON 对象' };
  const L = SNAPSHOT_LIMITS;

  for (const [key, max] of [['libraries', L.libraries], ['favorites', L.favorites], ['history', L.history]]) {
    const v = raw[key];
    if (v !== undefined && !Array.isArray(v)) return { ok: false, error: `${key} 必须是数组` };
    if (Array.isArray(v) && v.length > max) {
      return { ok: false, error: `${key} 条目过多（上限 ${max}，收到 ${v.length}）` };
    }
  }

  const libraries = [];
  for (const lib of Array.isArray(raw.libraries) ? raw.libraries : []) {
    if (!isPlainObject(lib)) continue;
    const id = boundedString(lib.id, L.libraryIdChars + 1);
    if (!id || id.length > L.libraryIdChars) continue; // 没有可用 id 的库直接丢弃（无法合并）
    const lessonsRaw = Array.isArray(lib.lessons) ? lib.lessons : [];
    if (lessonsRaw.length > L.lessonsPerLibrary) {
      return { ok: false, error: `课文库「${boundedString(lib.name, 20)}」课文过多（上限 ${L.lessonsPerLibrary}）` };
    }
    const lessons = [];
    for (const lesson of lessonsRaw) {
      if (!isPlainObject(lesson)) continue;
      const chinese = String(lesson.chinese == null ? '' : lesson.chinese);
      const english = String(lesson.english == null ? '' : lesson.english);
      if (chinese.length > L.lessonFieldChars || english.length > L.lessonFieldChars) {
        return { ok: false, error: `课文「${boundedString(lesson.title_cn, 20)}」内容过长（单字段上限 ${L.lessonFieldChars} 字符）` };
      }
      lessons.push({
        book: 'my',
        lesson: Number(lesson.lesson) || 0,
        title_cn: boundedString(lesson.title_cn, L.lessonTitleChars),
        title_en: boundedString(lesson.title_en, L.lessonTitleChars),
        chinese,
        english,
        source: boundedString(lesson.source || '自建', 20),
        createdAt: Number(lesson.createdAt) || Date.now(),
      });
    }
    libraries.push({
      id,
      name: boundedString(lib.name || '未命名库', L.libraryNameChars),
      createdAt: Number(lib.createdAt) || Date.now(),
      lessons,
    });
  }

  const favRaw = Array.isArray(raw.favorites) ? raw.favorites : [];
  const hisRaw = Array.isArray(raw.history) ? raw.history : [];
  const favorites = favRaw
    .filter((f) => isPlainObject(f) && typeof f.id === 'string' && f.id.length <= 200 && jsonBytes(f) <= L.favoriteBytes);
  const history = hisRaw
    .filter((h) => isPlainObject(h) && typeof h.jobId === 'string' && h.jobId.length <= 64 && jsonBytes(h) <= L.historyBytes);
  // 被丢弃的条数要能观测到：不静默吞掉（单条超限的是派生/缓存类数据，丢弃比整单拒绝更合理）
  const dropped = { favorites: favRaw.length - favorites.length, history: hisRaw.length - history.length };

  const data = { libraries, favorites, history };
  if (jsonBytes(data) > MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: `同步数据过大（上限 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)}MB）` };
  }
  return { ok: true, data, dropped };
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
