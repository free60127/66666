#!/usr/bin/env bash
# Test the real deployment transaction with fake systemctl/curl in an isolated directory.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Use sudo for the isolated deployment regression' >&2; exit 77; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d /tmp/bts-release-test-XXXXXX)"
trap '[[ "$TEST_ROOT" == /tmp/bts-release-test-* ]] && rm -rf -- "$TEST_ROOT"' EXIT
export BTS_DEPLOY_ROOT="$TEST_ROOT/site"
export BTS_HEALTH_URL='http://fixture.invalid'
mkdir -p "$BTS_DEPLOY_ROOT/bts/dist/assets" "$BTS_DEPLOY_ROOT/bts/server" "$BTS_DEPLOY_ROOT/bts/data" "$TEST_ROOT/bin"
printf 'TEST_CONFIG=keep-this\n' > "$BTS_DEPLOY_ROOT/bts/.env"
chmod 600 "$BTS_DEPLOY_ROOT/bts/.env"
printf 'student-record\n' > "$BTS_DEPLOY_ROOT/bts/data/student.json"
printf 'old-browser-chunk\n' > "$BTS_DEPLOY_ROOT/bts/dist/assets/legacy.js"
printf 'legacy index\n' > "$BTS_DEPLOY_ROOT/bts/dist/index.html"
printf 'legacy teacher\n' > "$BTS_DEPLOY_ROOT/bts/dist/teacher.html"
mkdir -p "$BTS_DEPLOY_ROOT/bts/public/corpus"
printf '{"private":true}\n' > "$BTS_DEPLOY_ROOT/bts/public/corpus/server-only.json"

cat > "$TEST_ROOT/bin/systemctl" <<'SH'
#!/usr/bin/env bash
if [[ $1 == restart ]]; then
  printf 'restart\n' >> "$BTS_DEPLOY_ROOT/restarts"
  [[ ! -f "$BTS_DEPLOY_ROOT/bts/server/fail-start" ]]
else
  exit 0
fi
SH
cat > "$TEST_ROOT/bin/curl" <<'SH'
#!/usr/bin/env bash
url="${@: -1}"
case "$url" in
  */api/health) [[ ! -f "$BTS_DEPLOY_ROOT/bts/server/fail-health" ]] || exit 22; printf '{"ok":true}\n' ;;
  */release.json) cat "$BTS_DEPLOY_ROOT/bts/dist/release.json" ;;
  */teacher.html) cat "$BTS_DEPLOY_ROOT/bts/dist/teacher.html" ;;
  *) exit 22 ;;
esac
SH
printf '#!/usr/bin/env bash\nexit 0\n' > "$TEST_ROOT/bin/sleep"
chmod +x "$TEST_ROOT/bin/"*
export PATH="$TEST_ROOT/bin:$PATH"

make_release() {
  local sha="$1" fault="${2:-}"
  local dir="$TEST_ROOT/package-$sha"
  mkdir -p "$dir/dist/assets" "$dir/server" "$dir/src" "$dir/public/corpus"
  printf '{"type":"module"}\n' > "$dir/package.json"
  printf 'export const fixture = true;\n' > "$dir/server/index.mjs"
  printf 'new browser chunk\n' > "$dir/dist/assets/new-$sha.js"
  printf 'student page\n' > "$dir/dist/index.html"
  printf 'teacher page\n' > "$dir/dist/teacher.html"
  printf '{"commit":"%s","assets":["new-%s.js"]}\n' "$sha" "$sha" > "$dir/dist/release.json"
  if [[ -n "$fault" ]]; then touch "$dir/server/$fault"; fi
  tar -czf "$TEST_ROOT/$sha.tgz" -C "$dir" dist server src public/corpus package.json
}
expect_failure() {
  if bash "$SCRIPT_DIR/server-release.sh" "$@" > "$TEST_ROOT/expected-failure.log" 2>&1; then
    cat "$TEST_ROOT/expected-failure.log"
    echo 'Expected release to fail' >&2
    exit 1
  fi
}
assert_preserved() {
  grep -qx 'TEST_CONFIG=keep-this' "$BTS_DEPLOY_ROOT/bts/.env"
  grep -qx 'student-record' "$BTS_DEPLOY_ROOT/bts/data/student.json"
  grep -qx 'written-after-release' "$BTS_DEPLOY_ROOT/bts/data/new-record.json"
  [[ $(stat -c %a "$BTS_DEPLOY_ROOT/bts-shared/.env") == 600 ]]
}

GOOD=$(printf 'a%.0s' {1..40})
START_FAIL=$(printf 'b%.0s' {1..40})
HEALTH_FAIL=$(printf 'c%.0s' {1..40})
make_release "$GOOD"
expect_failure "$TEST_ROOT/$GOOD.tgz" bad-sha
[[ ! -L "$BTS_DEPLOY_ROOT/bts" ]]
echo 'PASS invalid commit cannot replace current app'

python3 - "$TEST_ROOT/unsafe.tgz" <<'PY'
import io, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as bundle:
    entry = tarfile.TarInfo('../escape')
    entry.size = 4
    bundle.addfile(entry, io.BytesIO(b'evil'))
PY
expect_failure "$TEST_ROOT/unsafe.tgz" "$GOOD"
[[ ! -e "$BTS_DEPLOY_ROOT/bts-releases/escape" && ! -L "$BTS_DEPLOY_ROOT/bts" ]]
echo 'PASS unsafe archive rejected before application changes'

bash "$SCRIPT_DIR/server-release.sh" "$TEST_ROOT/$GOOD.tgz" "$GOOD"
[[ -L "$BTS_DEPLOY_ROOT/bts" && -L "$BTS_DEPLOY_ROOT/bts/.env" && -L "$BTS_DEPLOY_ROOT/bts/data" ]]
grep -qx 'old-browser-chunk' "$BTS_DEPLOY_ROOT/bts/dist/assets/legacy.js"
[[ -f "$BTS_DEPLOY_ROOT/bts/public/corpus/server-only.json" && -f "$BTS_DEPLOY_ROOT/bts/dist/corpus/server-only.json" ]]
printf 'written-after-release\n' > "$BTS_DEPLOY_ROOT/bts/data/new-record.json"
assert_preserved
PREVIOUS="$(readlink -f "$BTS_DEPLOY_ROOT/bts")"
echo 'PASS successful switch preserves config, data, private corpus and existing browser assets'

make_release "$START_FAIL" fail-start
expect_failure "$TEST_ROOT/$START_FAIL.tgz" "$START_FAIL"
[[ $(readlink -f "$BTS_DEPLOY_ROOT/bts") == "$PREVIOUS" ]]
assert_preserved
echo 'PASS startup failure rolls code back without losing new student data'

make_release "$HEALTH_FAIL" fail-health
expect_failure "$TEST_ROOT/$HEALTH_FAIL.tgz" "$HEALTH_FAIL"
[[ $(readlink -f "$BTS_DEPLOY_ROOT/bts") == "$PREVIOUS" ]]
assert_preserved
echo 'PASS health-check failure rolls code back without losing new student data'

MISMATCH=$(printf 'd%.0s' {1..40})
expect_failure "$TEST_ROOT/$GOOD.tgz" "$MISMATCH"
[[ $(readlink -f "$BTS_DEPLOY_ROOT/bts") == "$PREVIOUS" ]]
assert_preserved
echo 'PASS artifact commit mismatch cannot replace current app'
