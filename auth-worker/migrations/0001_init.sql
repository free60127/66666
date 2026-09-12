-- 0001_init.sql：账号 + 会话 + 找回密码 + 限流
--
-- 设计要点（照搬 study platform 验证过的方案）：
--  1) D1 只存**账号与会话**；学习数据（同步快照）在别处（Upstash/KV）。
--     存储密度差 40 倍以上，混在一起会白白浪费掉 500 MB 里的 96%。
--  2) sync_encrypted 存的是「用**密码派生密钥**加密后的同步码」——
--     服务端只能存/取，**无法解密**。数据库泄露也不会连坐用户的云端数据。
--  3) sessions 只存 token 的 SHA-256 哈希：库被拖走也拿不到可用会话令牌。

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                 -- 32 位 hex（16 字节随机）
  email TEXT NOT NULL UNIQUE,          -- 统一小写
  password_hash TEXT NOT NULL,         -- pbkdf2:iter:salt_b64:hash_b64（迭代数写进串里，便于以后升级）
  nickname TEXT NOT NULL DEFAULT '',
  sync_encrypted TEXT,                 -- JSON {salt,iv,c}：密码派生 AES-GCM 加密的同步码
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,              -- 会话令牌的 SHA-256 hex（不是令牌本身）
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL          -- unix 毫秒（30 天）
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 登录失败锁定：按邮箱。
-- 用 D1 而不是 KV —— SQLite 强一致，连续失败请求打到不同边缘节点也能正确累计
-- （KV 方案线上实测失效，会互相覆盖）。
CREATE TABLE IF NOT EXISTS login_fails (
  email TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 找回密码一次性码：每邮箱一行（新码覆盖旧码）；只存 SHA-256 哈希，15 分钟有效。
CREATE TABLE IF NOT EXISTS reset_tokens (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 通用滚动窗口限流（注册/登录/找回各自分键）。
CREATE TABLE IF NOT EXISTS rate (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0
);
