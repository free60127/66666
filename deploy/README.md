# huiyiben.cn 上线部署手册

> 目标：把「回译本」从 Render 迁到你的阿里云服务器（2C2G，北京），用域名 huiyiben.cn 对外服务。
> 本目录 5 个文件就是全部物料：nginx 配置、systemd 服务、环境变量模板、一键发布脚本、本手册。

## 〇、先记住关键顺序（域名不是买了就能用）

```
① 域名实名审核（注册局审核中 → 通过，1~3 天，不用你操作）
② 申请「备案服务码」并提交 ICP 备案（阿里云控制台/APP，全线上）
③ 阿里云初审 1~2 天（可能电话核实）→ 管局审核 1~2 周 → 拿到备案号
④ 服务器装环境 + 用 IP 自测（②③等待期间就能做，见下）
⑤ 备案通过 → 域名解析到服务器 IP → 签 HTTPS 证书 → 正式上线
```

**为什么必须备案**：大陆服务器的 80/443 端口，未备案域名的访问会被阿里云直接拦截。
**备案期间注意**：域名**不要**提前解析到服务器 IP（初审会检查），解析这步留到第⑤步。

## 一、提交备案（第②步，等待期最长，越早越好）

1. 阿里云控制台搜「ICP 备案」→ 填主体信息（个人）。
2. 申请**备案服务码**：备案控制台里用你这台服务器申请（要求包月 ≥3 个月，你的付到 2027-03，满足）。
3. 网站信息填写注意：
   - 域名填 `huiyiben.cn`（只填主域，www 自动包含；没有其他子域不用多填）。
   - **网站名称有管局规范**：个人备案的名称不能像企业/商品/纯英文。可以先填「回译本」，初审时阿里云会明确告诉你能不能过、帮你改。
   - 服务内容/网站内容选「博客/个人空间」或「其他」类，备注写"个人英语学习工具，不含评论、支付等交互功能"。
4. 按提示完成 APP 人脸核验，然后等初审 + 管局。

## 二、服务器初始化（第④步，备案等待期做）

SSH 登录服务器后（`ssh root@服务器IP`），按顺序执行（Ubuntu 22.04）：

```bash
# 1. 基础软件：nginx + node 22 + certbot
apt update
apt install -y nginx curl certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v   # 确认 v22.x

# 2. 应用目录
mkdir -p /var/www/bts

# 3. systemd 服务（开机自启 + 崩溃自动拉起）
cp bts.service /etc/systemd/system/   # 如果 node 不在 /usr/bin/node，先改里面的 ExecStart 路径
# 4. nginx 站点配置
cp nginx-bts.conf.example /etc/nginx/sites-available/bts
ln -sf /etc/nginx/sites-available/bts /etc/nginx/sites-enabled/bts
rm -f /etc/nginx/sites-enabled/default   # 摘掉默认站，避免抢 80 端口
nginx -t && systemctl reload nginx

# 5. 阿里云控制台 → 安全组：放行 80、443 端口（22 保持只对自己的 IP 开放最好）
```

## 三、首次部署 + IP 自测（第④步）

在**本机项目根目录**（Git Bash）执行：

```bash
# 1. 上传环境变量模板，然后去服务器上填真实值
ssh root@服务器IP "mkdir -p /var/www/bts"
scp deploy/env.example root@服务器IP:/var/www/bts/.env
ssh root@服务器IP "nano /var/www/bts/.env"   # 填 Upstash 两个值（和 Render 上配的一样）

# 2. 一键构建 + 上传 + 重启
deploy/deploy.sh root@服务器IP

# 3. 用 IP 自测（不经过域名，不受备案限制）
curl -I http://服务器IP/          # 应返回 200
# 浏览器打开 http://服务器IP/ 能完整使用即可；云同步/账号功能正常说明 Upstash 生效
```

## 四、备案通过当天：解析 + HTTPS + 上线（第⑤步）

```bash
# 1. 阿里云控制台 → 云解析 DNS → huiyiben.cn → 添加记录：
#    记录类型 A，主机记录 @ 和 www 各一条，记录值 = 服务器公网 IP

# 2. 等 DNS 生效（几分钟）后，签 HTTPS 证书（certbot 会自动改好 nginx 并配自动续期）
certbot --nginx -d huiyiben.cn -d www.huiyiben.cn

# 3. 验证清单
curl -I https://huiyiben.cn/                 # 200
# 浏览器全流程过一遍：选课 → 生成批改 → 云同步码 → 收藏夹
```

上线后最后一件小事：把备案号挂到网站页脚（管局要求，格式如「京ICP备XXXXXXXX号」）。
拿到备案号后告诉我，我在页脚加上并链接到工信部网站。

## 五、日常发布 / 回滚

- **发布**：本机 `deploy/deploy.sh root@服务器IP`（构建 → 上传 → 自动重启，几秒钟）。
- **回滚**：`git checkout` 到任意旧提交，再跑一次 `deploy/deploy.sh` 即可——代码和线上随时可以对齐任意版本。
- **看日志**：`journalctl -u bts -f`；**重启**：`systemctl restart bts`。

## 六、环境变量说明（deploy/env.example）

| 变量 | 必填 | 说明 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **是** | 云同步/账号/任务持久化全靠它，值和 Render 上的一致，数据无缝衔接 |
| `SMTP_USER` / `SMTP_PASS` | 否 | 账号找回邮件；不配则邮件找回不可用，其余功能不受影响 |
| `PORT` | 否 | 默认 8787，nginx 已按此端口反代，不用改 |

AI Key 不用在服务器配：现在的模式是用户在自己浏览器里配自己的 key（服务器只代理转发）。
