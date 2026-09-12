# 回译本 · 账号服务

Cloudflare Worker + D1，只做一件事：**账号与会话**。

```
回译本前端 ──登录/注册/找回──▶ hyt-auth（本 Worker，D1）
     │
     └──模型批改──▶ Render 上的 Node 后端（长任务，不动）
     └──云同步───▶ Upstash KV（不动）
```

## 为什么要独立成一个 Worker

| | 为什么 |
|---|---|
| **不放进 Node 后端** | Render 免费版 15 分钟无访问就休眠，登录要等冷启动；Workers 永不冷启动 |
| **不碰模型调用** | 模型是 30–120 秒的长任务，超出 Workers「响应后只剩 30 秒」的限制。账号请求全是短查询，稳稳落在免费版 10 ms CPU 配额内 |
| **同步数据不放 D1** | 账号约 1.1 KB/人，同步快照 20–100 KB/人。免费版单库 500 MB：放账号能装 **47 万人**，放同步只能装 **1 万人** —— 差 40 倍 |

## 容量（免费额度，官方文档）

| 资源 | 免费额度 | 换算 |
|---|---|---|
| Workers 请求 | 100,000 / 天 | 按每人每天 2 次账号请求 → **约 5 万日活** |
| Workers CPU | 10 ms / 请求 | PBKDF2 10k 轮实测可过 |
| D1 行读取 | 500 万 / 天 | 约 3 行/请求 → 160 万次/天，不是瓶颈 |
| D1 单库 | 500 MB | ÷ 1.1 KB → **约 47 万账号** |

**结论：免费版能撑到约 5 万日活。** 真超了，Workers Paid（$5/月）把请求提到千万级、CPU 提到 30 秒。

---

## 一次性配置（三步）

### 第 1 步：建 D1 数据库

在 Cloudflare 控制台：**Workers & Pages → D1 → Create database**，名字填 `hyt-auth-db`。
建好后复制 **Database ID**，粘到 `wrangler.jsonc` 里的 `PASTE_DATABASE_ID_HERE`。

> 也可以用命令行：`npx wrangler d1 create hyt-auth-db`

### 第 2 步：配 SMTP（找回密码用）

**QQ 邮箱 + 授权码，个人免费、零资质。** 这是唯一一条个人能走通的"邮箱验证"路径 ——
手机短信要企业实名（阿里云已公告不支持个人自用资质），微信/QQ 登录要企业开发者认证。

1. QQ 邮箱 → 设置 → 账户 → 开启 **IMAP/SMTP 服务** → 生成**授权码**（16 位，不是 QQ 密码）
2. 写进 Worker 的 secret：

```bash
cd auth-worker
npx wrangler secret put SMTP_USER   # 例如 3338095791@qq.com
npx wrangler secret put SMTP_PASS   # 上一步的授权码
```

> 注意：QQ 免费邮箱有每日发信上限，且发出的信**容易进垃圾箱**（尤其中转非 QQ 邮箱）。
> 所以只用在"找回密码"这一件事上，别拿它做日常通知。

### 第 3 步：部署

**方式 A —— 本地部署（需要先 `npx wrangler login`）**

```bash
cd auth-worker
npx wrangler d1 migrations apply hyt-auth-db --remote   # 建表
npx wrangler deploy
```

**方式 B —— GitHub Actions（不用本地登录）**

在仓库 Settings → Secrets 里加两个值（可以从 study platform 仓库直接抄）：

- `CF_API_TOKEN` —— Cloudflare API Token，用 **Edit Cloudflare Workers** 模板 + 加一条 **D1 Edit**
- `CF_ACCOUNT_ID` —— 在 Cloudflare 控制台右侧栏能看到

然后 push 到 `main`（或手动触发 `部署账号 Worker` 工作流）即可。

---

## 本地开发与测试

```bash
cd auth-worker

# 端到端测试（用 Node 24 内置的 node:sqlite 当 D1 替身，不需要 Cloudflare）
node tests/auth.test.mjs

# 本地起 Worker（含本地 D1）
npx wrangler dev
npx wrangler d1 migrations apply hyt-auth-db --local
```

`tests/auth.test.mjs` 覆盖 44 项，含几条**安全断言**：库里不能出现明文密码、不能出现明文会话令牌。

---

## API

所有接口都在 `/api/auth/*`。需要登录的传 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | `{email, password, nickname?, sync?}` → `{token, user, sync}` |
| POST | `/api/auth/login` | `{email, password}` → `{token, user, sync}` |
| POST | `/api/auth/logout` | 删除当前会话 |
| GET | `/api/auth/me` | 当前用户 + 同步码密文 |
| POST | `/api/auth/sync` | `{sync}` 绑定/更新同步码密文 |
| POST | `/api/auth/change-password` | `{oldPassword, newPassword, sync}` |
| POST | `/api/auth/delete-account` | `{password}` |
| POST | `/api/auth/forgot` | `{email}` 发验证码 |
| POST | `/api/auth/reset-password` | `{email, code, newPassword, sync?}` |
| POST | `/api/auth/admin-reset-code` | 管理员兜底，需 `ADMIN_TOKEN` |
| GET | `/api/health` | 健康检查（不含敏感信息） |

`sync` 的格式是 `{salt, iv, c}`（均 base64）—— **客户端用「密码派生密钥」AES-GCM 加密后的同步码**。

---

## 三条不能动的设计前提

### 1. 同步码用密码派生密钥加密，服务端**解不开**

服务端只做格式校验与存取。数据库泄露也不会连坐任何用户的云端数据 ——
攻击者拿到的只是一堆没有密码就无法解密的密文。

**代价**：重置密码后同步码会丢（服务端没有旧密码，代劳不了）。
所以找回邮件里明确写了这一点，客户端也需要在改密码时**用新密码重新加密**同步码一起提交。

### 2. 会话令牌在库里只存 SHA-256 哈希

D1 被拖走也拿不到可用的会话令牌。

### 3. 密码是 PBKDF2(SHA-256)，迭代数写进哈希串

存成 `pbkdf2:iter:salt:hash`。以后调大迭代数**不会**让存量账号集体登录失败 ——
验证时用的是哈希串里记录的那个 iter。

当前 10000 轮，因为 **Workers 免费版 CPU 只有 10 ms**（150k 轮会直接 500，study platform 实测过）。
升级到 Paid 计划后把 `src/auth.js` 里的 `PBKDF2_ITERATIONS` 调大即可。

---

## 环境变量

| 名称 | 类型 | 说明 |
|---|---|---|
| `ALLOWED_ORIGINS` | var | CORS 白名单，逗号分隔。**别填 `*`** |
| `SERVICE_NAME` | var | 邮件标题里的服务名 |
| `SMTP_HOST` / `SMTP_PORT` | var | 缺省 `smtp.qq.com` / `465` |
| `SMTP_USER` / `SMTP_PASS` | **secret** | QQ 邮箱 + 授权码 |
| `SMTP_FROM` | secret | 缺省同 `SMTP_USER` |
| `ADMIN_TOKEN` | **secret** | 管理员兜底接口用 |
| `DB` | binding | D1 数据库 |
