#!/usr/bin/env bash
# 手动发布：本机构建 → 打包上传 → 与 CI 相同的切换 / 检查 / 回滚
# 用法（项目根目录）：deploy/deploy.sh root@服务器IP
# 依赖：本机 Git Bash（tar/ssh Windows 自带）；服务器已按 deploy/README.md 初始化
set -euo pipefail

DEPLOY_HOST="${1:?用法: deploy/deploy.sh bts-server}"
SHA="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo '请先提交所有已跟踪文件的修改，再发布，保证版本号对应实际代码。' >&2
  exit 1
fi

echo "==> 本机构建前端…"
VITE_BASE=/ VITE_API_BASE='' npm run build
node tools/package-release.mjs "$SHA"

echo "==> 上传版本 $SHA …"
REMOTE_ARCHIVE="$(ssh "$DEPLOY_HOST" 'mktemp /tmp/bts-manual-release-XXXXXX.tgz')"
[[ "$REMOTE_ARCHIVE" =~ ^/tmp/bts-manual-release-[A-Za-z0-9]+\.tgz$ ]] || exit 1
scp tmp/bts-release.tgz "$DEPLOY_HOST:$REMOTE_ARCHIVE"

echo "==> 切换版本并检查服务…"
ssh "$DEPLOY_HOST" "sudo /usr/local/sbin/bts-release '$REMOTE_ARCHIVE' '$SHA'; result=\$?; rm -f -- '$REMOTE_ARCHIVE'; exit \$result"

echo "==> 完成。验证：https://huiyiben.cn/release.json"
