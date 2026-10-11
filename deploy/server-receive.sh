#!/usr/bin/env bash
# Forced SSH command for the dedicated GitHub Actions key. No shell/scp/forwarding access.
set -euo pipefail
umask 077
[[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([a-f0-9]{40})$ ]] || { echo 'Only deploy <commit-sha> is allowed' >&2; exit 64; }
SHA="${BASH_REMATCH[1]}"
ARCHIVE="$(mktemp /var/lib/bts-deploy/incoming/release-XXXXXX.tgz)"
trap 'rm -f -- "$ARCHIVE"' EXIT
# Bound compressed uploads to 128 MiB.
ulimit -f 131072
cat >"$ARCHIVE"
sudo -n /usr/local/sbin/bts-release "$ARCHIVE" "$SHA"
