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
  deletedHistory: 500,     // 已删除的作业号（墓碑）：防止"并集合并"把用户删掉的记录从云端复活
  progress: 2000,          // 逐课进度：lessonKey → {n,best,last,at,ms}（客户端上限也是 2000）
  progressKeyChars: 64,
  days: 400,               // 学习日期（连续天数）：YYYY-MM-DD 去重列表
  libraryIdChars: 64,
  libraryNameChars: 80,
  lessonTitleChars: 300,
  lessonFieldChars: 40000, // chinese / english 单字段上限（真实课文约 1-3 千字符）
  favoriteBytes: 20000,    // 单条收藏的 JSON 体积
  historyBytes: 2000,      // 单条历史的 JSON 体积
});

export const newSyncCode = () => randomBytes(16).toString('hex');
export const isValidSyncCode = (code) => CODE_RE.test(String(code || ''));

export const emptySnapshot = () => ({ libraries: [], favorites: [], history: [], deletedHistory: [], progress: {}, days: [] });

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

  for (const [key, max] of [['libraries', L.libraries], ['favorites', L.favorites], ['history', L.history], ['deletedHistory', L.deletedHistory]]) {
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

  // 墓碑（已删除的作业号）：只留**字符串**形状合法的去重值。
  // 它不参与渲染，只是"别再并回来"的标记；客户端传来的永远是字符串，非字符串一律丢弃。
  const deletedSet = new Set();
  for (const id of Array.isArray(raw.deletedHistory) ? raw.deletedHistory : []) {
    if (typeof id !== 'string') continue;
    const s = boundedString(id, L.libraryIdChars + 1);
    if (s && s.length <= L.libraryIdChars) deletedSet.add(s);
  }
  const deletedHistory = [...deletedSet];

  // 逐课进度：对象（lessonKey → 计数/分数），只保留形状正确的数字字段。
  // 它决定"我完成了多少课"，客户端算好后同步过来；换设备登录同一同步码即可看到。
  const progressRaw = isPlainObject(raw.progress) ? raw.progress : {};
  const progressEntries = Object.entries(progressRaw);
  if (progressEntries.length > L.progress) {
    return { ok: false, error: `progress 条目过多（上限 ${L.progress}，收到 ${progressEntries.length}）` };
  }
  const numOr0 = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  const progress = {};
  for (const [k, v] of progressEntries) {
    if (!k || k.length > L.progressKeyChars || !isPlainObject(v)) continue;
    progress[k] = {
      n: Math.floor(numOr0(v.n)),
      best: numOr0(v.best),
      last: numOr0(v.last),
      at: numOr0(v.at),
      ms: numOr0(v.ms),
    };
  }

  // 学习日期（连续天数用）：只收 YYYY-MM-DD 形状、去重、按条数上限截断最近的天
  if (raw.days !== undefined && !Array.isArray(raw.days)) return { ok: false, error: 'days 必须是数组' };
  const daySet = new Set();
  for (const d of Array.isArray(raw.days) ? raw.days : []) {
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) daySet.add(d);
  }
  const days = [...daySet].sort().reverse().slice(0, L.days);

  const data = { libraries, favorites, history, deletedHistory, progress, days };
  if (jsonBytes(data) > MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: `同步数据过大（上限 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)}MB）` };
  }
  return { ok: true, data, dropped };
}

/**
 * 原子比较并写入的 Lua 脚本。
 *
 * 为什么非要用 Lua：HTTP 层的「先 GET 读版本 → 比较 → 再 SET 写」不是原子的 ——
 * 两次调用之间隔着一次网络往返（几十毫秒），两台设备同时提交时都可能读到同一个版本、
 * 都通过检查、然后后写的把先写的覆盖掉，**先写的那次更新就永久丢了**。
 * 前端的 409 重试救不了这种情况，因为两边都没收到 409。
 *
 * 放在 Redis 里执行就没有这个窗口：读、比较、写是同一个原子操作。
 * 返回 {1, 新文档} 表示成功；{0, 云端当前文档} 表示版本对不上，调用方据此回 409。
 */
const CAS_LUA = [
  "local raw = redis.call('GET', KEYS[1])",
  'local cur = 0',
  'if raw then',
  "  local ok, doc = pcall(cjson.decode, raw)",
  "  if ok and type(doc) == 'table' and doc['version'] then cur = tonumber(doc['version']) or 0 end",
  'end',
  'local base = tonumber(ARGV[1])',
  'if base >= 0 and cur ~= base then',
  "  return {0, raw or ''}",
  'end',
  "redis.call('SET', KEYS[1], ARGV[2])",
  'return {1, ARGV[2]}',
].join('\n');

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
  // EVAL 万一在这个实例上不可用（权限/版本差异），退回带短锁的实现，
  // 并且**只告警一次** —— 静默降级成非原子写入是最糟的结果。
  let casMode = 'lua';
  let warned = false;
  const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

  return {
    kind: 'upstash',
    durable: true,
    get casMode() { return casMode; },
    async read(code) {
      return parse(await call(['GET', prefix + code]));
    },
    async write(code, doc) {
      await call(['SET', prefix + code, JSON.stringify(doc)]);
    },
    /**
     * 原子「版本对得上才写」。
     * @returns {{ok:true} | {ok:false, current: object|null}}
     */
    async compareAndSwap(code, baseVersion, doc) {
      const key = prefix + code;
      const base = Number.isFinite(Number(baseVersion)) ? Number(baseVersion) : -1;
      if (casMode === 'lua') {
        try {
          const res = await call(['EVAL', CAS_LUA, '1', key, String(base), JSON.stringify(doc)]);
          if (Array.isArray(res) && Number(res[0]) === 1) return { ok: true };
          return { ok: false, current: parse(Array.isArray(res) ? res[1] : '') };
        } catch (e) {
          casMode = 'lock';
          if (!warned) { warned = true; console.warn('⚠️  Upstash 不支持 EVAL，已退回加锁写入（原子性稍弱但仍正确）：', e.message); }
        }
      }
      // 兜底：SET NX 抢短锁 → 读改写 → 释放。锁过期时间给足一次往返，且只有拿不到锁才重试。
      const lockKey = key + ':lock';
      for (let i = 0; i < 20; i += 1) {
        const got = await call(['SET', lockKey, '1', 'NX', 'EX', '5']);
        if (got !== null) {
          try {
            const cur = parse(await call(['GET', key]));
            const curV = cur && Number.isFinite(Number(cur.version)) ? Number(cur.version) : 0;
            if (base >= 0 && curV !== base) return { ok: false, current: cur };
            await call(['SET', key, JSON.stringify(doc)]);
            return { ok: true };
          } finally {
            await call(['DEL', lockKey]).catch(() => {});
          }
        }
        await new Promise((r) => setTimeout(r, 25 + i * 10));
      }
      return { ok: false, current: parse(await call(['GET', key])) };
    },
  };
}

/** 本地文件驱动：仅用于开发/自托管；托管平台上的磁盘通常是临时的。 */
export function createFileStore(dir) {
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  ensure();
  const fileOf = (code) => path.join(dir, code + '.json');
  /**
   * 原子落盘：先写临时文件再 rename。
   * 直接 writeFileSync 覆盖时进程被杀（部署重启、OOM）会留下**半截 JSON**，
   * 那份数据就永久坏了；rename 在同一文件系统内是原子的，要么旧的要么新的。
   */
  const writeAtomic = (file, text) => {
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* 清不掉就算了，别盖住原始错误 */ }
      // 目录可能在运行期被清掉（平台重置磁盘 / 手工清理）——自愈一次，别直接把 500 抛给用户
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        ensure();
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
        return;
      }
      throw e;
    }
  };
  const readRaw = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

  return {
    kind: 'file',
    durable: false,
    casMode: 'sync',
    async read(code) {
      try { return JSON.parse(readRaw(fileOf(code))); } catch { return null; }
    },
    async write(code, doc) {
      writeAtomic(fileOf(code), JSON.stringify(doc));
    },
    /**
     * 原子「版本对得上才写」。
     * 方法体内**没有任何 await** —— Node 是单线程，同步读改写之间不会让出事件循环，
     * 所以同一个进程里天然原子。
     */
    async compareAndSwap(code, baseVersion, doc) {
      const file = fileOf(code);
      const raw = readRaw(file);
      let cur = null;
      try { cur = raw ? JSON.parse(raw) : null; } catch { cur = null; } // 损坏文件当"不存在"，可被重建
      const curV = cur && Number.isFinite(Number(cur.version)) ? Number(cur.version) : 0;
      const base = Number.isFinite(Number(baseVersion)) ? Number(baseVersion) : -1;
      if (base >= 0 && curV !== base) return { ok: false, current: cur };
      writeAtomic(file, JSON.stringify(doc));
      return { ok: true };
    },
  };
}

/**
 * 按环境变量选择驱动。
 * 配了 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN 就用 Upstash，否则退回本地文件。
 * @param {string} dataDir 本地文件驱动的数据根目录（调用方传 `data/`，可用 DATA_DIR 环境变量整体搬走）
 */
export function createSyncStore(dataDir) {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (url && token) return createUpstashStore({ url, token });
  return createFileStore(path.join(dataDir, 'sync'));
}
