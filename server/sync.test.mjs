/**
 * 同步存储层测试：重点是**原子性**。
 *
 * 为什么必须有这个测试：前端有 409 重试，但「先读版本 → 判断 → 再写」这种写法下，
 * 两个并发请求可能**都通过检查**、都不收到 409，后写的静静覆盖先写的 ——
 * 前端的重试永远救不了，只有服务端能测出来。
 *
 * 跑法：node server/sync.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createFileStore, createUpstashStore, emptySnapshot, sanitizeSnapshot } from './sync.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const doc = (version, tag) => ({
  version, updatedAt: Date.now(), device: 'test',
  data: { libraries: [], favorites: [{ id: tag, kind: '核心词', title: tag, body: '', createdAt: 1 }], history: [] },
});

console.log('=== 同步存储层测试 ===\n');

/* ---------- 1. 文件驱动：并发 CAS ---------- */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sync-'));
  const store = createFileStore(dir);
  const CODE = 'a'.repeat(32);
  await store.write(CODE, doc(1, 'initial'));

  // 20 个并发请求，全都基于同一个版本 1 提交 —— 只能有一个赢
  const N = 20;
  const rs = await Promise.all(
    Array.from({ length: N }, (_, i) => store.compareAndSwap(CODE, 1, doc(2, 'w' + i)))
  );
  const won = rs.filter((r) => r.ok).length;
  const lost = rs.filter((r) => !r.ok).length;
  check('① 20 个并发同版本提交，恰好 1 个成功', won === 1 && lost === N - 1, `成功 ${won} / 冲突 ${lost}`);

  const cur = await store.read(CODE);
  check('② 最终版本只前进了一格（没有丢更新）', cur.version === 2, `version=${cur.version}`);
  check('③ 存的是那个赢家的数据', cur.data.favorites[0].id === 'w' + rs.findIndex((r) => r.ok), cur.data.favorites[0].id);
  check('④ 冲突方拿得到云端最新数据（供前端合并重试）',
    rs.filter((r) => !r.ok).every((r) => r.current && r.current.version === 2));

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------- 2. 文件驱动：落盘原子性 ---------- */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-sync-'));
  const store = createFileStore(dir);
  const CODE = 'b'.repeat(32);
  await store.write(CODE, doc(1, 'x'));
  const files = fs.readdirSync(dir);
  check('⑤ 写完不留临时文件', files.every((f) => !f.includes('.tmp')), files.join(', '));
  check('⑥ 文件内容始终是完整 JSON', (() => { try { JSON.parse(fs.readFileSync(path.join(dir, CODE + '.json'), 'utf8')); return true; } catch { return false; } })());

  // 损坏的文件应被当成"不存在"，从而可被重建（而不是让用户永远报错）
  fs.writeFileSync(path.join(dir, CODE + '.json'), '{"version":2,"data":{');
  check('⑦ 损坏 JSON 被当作不存在（可重建）', (await store.read(CODE)) === null);
  const rebuilt = await store.compareAndSwap(CODE, 0, doc(1, 'rebuilt'));
  check('⑧ 损坏后能重新写入', rebuilt.ok && (await store.read(CODE)).data.favorites[0].id === 'rebuilt');

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------- 3. Upstash 驱动：命令格式与 CAS 解析（对着本地 mock 测） ---------- */
function mockUpstash({ evalBroken = false } = {}) {
  const mem = new Map();
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const cmd = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(cmd[0]);
    const reply = (result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })); };
    const [op, key] = cmd;
    if (op === 'GET') return reply(mem.has(key) ? mem.get(key) : null);
    if (op === 'SET') {
      const nx = cmd.includes('NX');
      if (nx && mem.has(key)) return reply(null);
      mem.set(key, cmd[2]);
      return reply('OK');
    }
    if (op === 'DEL') { mem.delete(key); return reply(1); }
    if (op === 'EVAL') {
      if (evalBroken) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'ERR unknown command EVAL' })); }
      // 该脚本只做一件事：版本对得上才 SET。mock 按同样的语义执行。
      const k = cmd[3], base = Number(cmd[4]), next = cmd[5];
      const raw = mem.has(k) ? mem.get(k) : null;
      let cur = 0;
      if (raw) { try { cur = Number(JSON.parse(raw).version) || 0; } catch { cur = 0; } }
      if (base >= 0 && cur !== base) return reply([0, raw || '']);
      mem.set(k, next);
      return reply([1, next]);
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown command ' + op }));
  });
  return { server, mem, seen, url: () => `http://127.0.0.1:${server.address().port}` };
}

{
  const m = mockUpstash();
  await new Promise((r) => m.server.listen(0, r));
  const store = createUpstashStore({ url: m.url(), token: 't', prefix: 'k:' });
  const CODE = 'c'.repeat(32);

  await store.write(CODE, doc(1, 'init'));
  check('⑨ Upstash 驱动：读取正常', (await store.read(CODE)).version === 1);

  const a = await store.compareAndSwap(CODE, 1, doc(2, 'A'));
  check('⑩ 版本匹配时 CAS 成功', a.ok === true);
  const b2 = await store.compareAndSwap(CODE, 1, doc(2, 'B'));
  check('⑪ 版本不匹配时 CAS 失败并带回云端数据',
    b2.ok === false && b2.current && b2.current.version === 2, JSON.stringify(b2.current && b2.current.version));
  check('⑫ 用的是 EVAL（原子路径）', m.seen.includes('EVAL'), m.seen.join(','));
  check('⑬ 冲突方没有覆盖赢家的数据', (await store.read(CODE)).data.favorites[0].id === 'A');

  m.server.close();
}


/* ---------- 逐课进度（progress）字段 ---------- */
{
  const ok1 = sanitizeSnapshot({ ...emptySnapshot(), progress: { 'lesson:2-18': { n: 3, best: 86, last: 72, at: 1700000000000, ms: 372000 } } });
  check('progress：正常快照被接受', ok1.ok === true, ok1.ok ? '' : ok1.error);
  check('progress：字段被原样保留', ok1.ok && ok1.data.progress['lesson:2-18'].best === 86);
  const dirty = sanitizeSnapshot({ ...emptySnapshot(), progress: { 'lesson:2-18': { n: '3', best: 'x', at: -5 }, bad: 'not-an-object', '': { n: 1 } } });
  check('progress：脏值被清理成合法数字', dirty.ok && dirty.data.progress['lesson:2-18'].n === 3 && dirty.data.progress['lesson:2-18'].best === 0 && dirty.data.progress['lesson:2-18'].at === 0);
  check('progress：非对象条目被丢弃', dirty.ok && !('bad' in dirty.data.progress) && !('' in dirty.data.progress));
  const huge = {}; for (let i = 0; i < 2001; i += 1) huge['lesson:2-' + i] = { n: 1 };
  const over = sanitizeSnapshot({ ...emptySnapshot(), progress: huge });
  check('progress：超上限明确拒绝（不静默截断）', over.ok === false, over.ok ? '' : over.error);
  const noField = sanitizeSnapshot({ ...emptySnapshot() });
  check('progress：老快照没有该字段也能通过（回退为空对象）', noField.ok === true && typeof noField.data.progress === 'object');
}


/* ---------- 学习日期（days，连续天数） ---------- */
{
  const ok1 = sanitizeSnapshot({ ...emptySnapshot(), days: ['2026-09-13', '2026-09-12'] });
  check('days：正常快照被接受', ok1.ok === true, ok1.ok ? '' : ok1.error);
  check('days：按倒序保留', ok1.ok && ok1.data.days[0] === '2026-09-13');
  const dirty = sanitizeSnapshot({ ...emptySnapshot(), days: ['2026-09-13', 'bad', '2026-9-1', 42, null, '2026-09-13'] });
  check('days：非法格式与非字符串被丢弃、重复被去掉', dirty.ok && JSON.stringify(dirty.data.days) === JSON.stringify(['2026-09-13']), dirty.ok ? JSON.stringify(dirty.data.days) : '');
  const notArr = sanitizeSnapshot({ ...emptySnapshot(), days: 'x' });
  check('days：不是数组 → 拒绝', notArr.ok === false);
  const many = Array.from({ length: 450 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`);
  const capped = sanitizeSnapshot({ ...emptySnapshot(), days: many });
  check('days：超上限时截断到 400 条（日期是幂等集合，截断安全）', capped.ok && capped.data.days.length <= 400, capped.ok ? String(capped.data.days.length) : capped.error);
  const noField = sanitizeSnapshot({ ...emptySnapshot() });
  check('days：老快照没有该字段也能通过', noField.ok === true && Array.isArray(noField.data.days));
}

/* ---------- 4. Upstash 驱动：EVAL 不可用时退回加锁（仍要正确） ---------- */
{
  const m = mockUpstash({ evalBroken: true });
  await new Promise((r) => m.server.listen(0, r));
  const store = createUpstashStore({ url: m.url(), token: 't', prefix: 'k:' });
  const CODE = 'd'.repeat(32);
  await store.write(CODE, doc(1, 'init'));

  const a = await store.compareAndSwap(CODE, 1, doc(2, 'A'));
  check('⑭ EVAL 不可用时仍能成功写入', a.ok === true);
  check('⑮ 已切到加锁模式并如实上报', store.casMode === 'lock', store.casMode);

  const N = 10;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => store.compareAndSwap(CODE, 2, doc(3, 'z' + i))));
  check('⑯ 加锁模式下并发也只允许一个赢', rs.filter((r) => r.ok).length === 1, `成功 ${rs.filter((r) => r.ok).length}/${N}`);
  check('⑰ 加锁模式没有残留锁键', ![...m.mem.keys()].some((k) => k.endsWith(':lock')), [...m.mem.keys()].join(','));
  check('⑱ 版本没有跳格', (await store.read(CODE)).version === 3);

  m.server.close();
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
