/**
 * D1 的本地替身：用 Node 24 内置的 node:sqlite 实现 D1 的调用面。
 *
 * 为什么值得写：账号代码是安全敏感代码，靠"看着对"不够。
 * 有了这个 shim，注册/登录/找回/改密的**真实 SQL**（含 UPSERT、RETURNING、batch 事务）
 * 都能在本地跑一遍，而不是只做语法检查。
 *
 * 支持的 D1 接口：prepare(sql).bind(...).first() / .run() / .all()、batch([...])。
 */
import { DatabaseSync } from 'node:sqlite';

export function createD1(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');

  const makeStmt = (sql, params) => ({
    bind(...p) { return makeStmt(sql, p); },
    async first() {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? null : row;
    },
    async run() {
      const r = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
    },
    async all() {
      return { results: db.prepare(sql).all(...params) };
    },
    /** 给测试用：同步取全部行 */
    _all() { return db.prepare(sql).all(...params); },
  });

  return {
    prepare: (sql) => makeStmt(sql, []),
    /** D1 的 batch 是一个隐式事务：任一条失败整体回滚。 */
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const st of stmts) out.push(await st.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    /** 给测试用：直接执行 DDL / 查询 */
    exec: (sql) => db.exec(sql),
    query: (sql, ...p) => db.prepare(sql).all(...p),
  };
}
