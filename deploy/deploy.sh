#!/usr/bin/env bash
# 一键发布：本机构建 → 打包上传 → 服务器自动重启
# 用法（项目根目录）：deploy/deploy.sh root@服务器IP
# 依赖：本机 Git Bash（tar/ssh Windows 自带）；服务器已按 deploy/README.md 初始化
set -euo pipefail

HOST="${1:?用法: deploy/deploy.sh root@服务器IP}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/bts}"

echo "==> 本机构建前端…"
npm run build

echo "==> 打包并上传到 $HOST:$REMOTE_DIR …"
# dist = 前端成品（含语料静态副本）；server = 零依赖后端；src = 服务端运行时引用的共享模块；public/corpus = 服务端运行时语料
tar czf - dist server src public/corpus | ssh "$HOST" "mkdir -p $REMOTE_DIR && tar xzf - -C $REMOTE_DIR"

echo "==> 重启服务…"
ssh "$HOST" "sudo systemctl restart bts && sleep 2 && systemctl is-active bts"

echo "==> 完成。验证：浏览器打开 https://huiyiben.cn/（备案前用 http://服务器IP/ 自测）"
