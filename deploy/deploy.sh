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

# 不要在这里用 VITE_BASE=/ 之类前缀设值：Git Bash(MSYS) 会把以 / 开头的值换算成本机
# Git 安装根目录（曾把 base 变成 /Users/<user>/AppData/Local/Programs/Git，线上白屏；
# 且实测 export MSYS2_ENV_CONV_EXCL 拦不住，只有同命令行前缀形式有效）。
# vite 缺省 base 恰为 '/'（vite.config.js），API_BASE 缺省 ''（src/api.js 同源），本就无需设置；
# 构建后的产物自检兜底：引用必须是 /assets/ 开头，且不得混入本机盘符/用户路径。
echo "==> 本机构建前端…"
npm run build
grep -q 'src="/assets/' dist/index.html || { echo '构建产物异常：index.html 未引用 /assets/，拒绝发布。' >&2; exit 1; }
if grep -qE '(src|href)="(/(Users|[Cc]:/)|[A-Za-z]:/)' dist/index.html; then
  echo '构建产物异常：index.html 含本机路径，拒绝发布。' >&2
  exit 1
fi
node tools/package-release.mjs "$SHA"

echo "==> 上传版本 $SHA …"
REMOTE_ARCHIVE="$(ssh "$DEPLOY_HOST" 'mktemp /tmp/bts-manual-release-XXXXXX.tgz')"
[[ "$REMOTE_ARCHIVE" =~ ^/tmp/bts-manual-release-[A-Za-z0-9]+\.tgz$ ]] || exit 1
scp tmp/bts-release.tgz "$DEPLOY_HOST:$REMOTE_ARCHIVE"

echo "==> 切换版本并检查服务…"
ssh "$DEPLOY_HOST" "sudo /usr/local/sbin/bts-release '$REMOTE_ARCHIVE' '$SHA'; result=\$?; rm -f -- '$REMOTE_ARCHIVE'; exit \$result"

echo "==> 完成。验证：https://huiyiben.cn/release.json"
