#!/usr/bin/env bash
# Installed as /usr/local/sbin/bts-release (root owned). The CI key can only upload a release.
set -euo pipefail
umask 022

ARCHIVE="${1:?Usage: bts-release archive.tgz commit-sha}"
SHA="${2:?Missing commit SHA}"
[[ $# == 2 && "$SHA" =~ ^[a-f0-9]{40}$ && -f "$ARCHIVE" && ! -L "$ARCHIVE" ]] || exit 64
[[ $EUID == 0 ]] || { echo 'Run with sudo' >&2; exit 77; }

# Overrides are used only by the isolated Linux regression test; sudo resets CI's environment.
DEPLOY_ROOT="${BTS_DEPLOY_ROOT:-/var/www}"
APP="$DEPLOY_ROOT/bts"
RELEASES="$DEPLOY_ROOT/bts-releases"
SHARED="$DEPLOY_ROOT/bts-shared"
STATE="$DEPLOY_ROOT/.bts-deploy"
HEALTH_URL="${BTS_HEALTH_URL:-http://127.0.0.1:8787}"
mkdir -p "$RELEASES" "$SHARED" "$STATE"
chmod 700 "$STATE"
exec 9>"$STATE/deploy.lock"
flock -w 300 9 || { echo 'Another deployment is still running' >&2; exit 75; }
[[ -e "$APP/.env" || -e "$SHARED/.env" ]] || { echo 'Existing server .env is missing' >&2; exit 78; }

STAGE="$(mktemp -d "$RELEASES/.staging-$SHA-XXXXXX")"
OLD=""
SWITCHED=0
COMMITTED=0
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ $SWITCHED == 1 && $COMMITTED == 0 && -n "$OLD" ]]; then
    echo 'Release failed; restoring previous code' >&2
    ln -s "$OLD" "$STATE/rollback-link"
    mv -Tf "$STATE/rollback-link" "$APP"
    if ! systemctl restart bts; then echo 'Rollback restart failed; inspect bts service' >&2; fi
    if ! curl --retry 3 --retry-connrefused --retry-delay 1 -fsS --max-time 10 "$HEALTH_URL/api/health" >/dev/null; then
      echo 'Rollback needs a health check; inspect bts service' >&2
    fi
  fi
  if [[ -n "$STAGE" && "$STAGE" == "$RELEASES/"* ]]; then rm -rf -- "$STAGE"; fi
  rm -f -- "$STATE/new-link" "$STATE/rollback-link" "$STATE/env-link"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Validate the tar before extracting as root: only runtime files, no links or path traversal.
python3 - "$ARCHIVE" "$STAGE" "$SHA" <<'PY'
import json, os, pathlib, sys, tarfile
archive, stage, sha = sys.argv[1:]
fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as stream, tarfile.open(fileobj=stream, mode='r:gz') as bundle:
    members = bundle.getmembers()
    if len(members) > 10000 or sum(m.size for m in members) > 256 * 1024 * 1024:
        raise ValueError('Release archive is too large')
    for m in members:
        p = pathlib.PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts or not (m.isfile() or m.isdir()):
            raise ValueError('Unsafe release archive entry')
        allowed = p.parts and (p.parts[0] in ('dist', 'server', 'src') or
                  p.parts[:2] == ('public', 'corpus') or
                  (str(p) == 'public' and m.isdir()) or str(p) == 'package.json')
        if not allowed:
            raise ValueError('Unexpected release archive entry')
        m.uid = m.gid = 0
        m.uname = m.gname = ''
        m.mode = 0o755 if m.isdir() else 0o644
    bundle.extractall(stage, members=members)
root = pathlib.Path(stage)
for file in ('server/index.mjs', 'dist/index.html', 'dist/teacher.html', 'package.json'):
    if not (root / file).is_file():
        raise ValueError('Incomplete release: ' + file)
if json.loads((root / 'dist/release.json').read_text())['commit'] != sha:
    raise ValueError('Release commit does not match requested commit')
PY
node --check "$STAGE/server/index.mjs"

# Keep server-only corpus files; versioned files in the tested archive take precedence.
if [[ -d "$APP/public/corpus" ]]; then
  mkdir -p "$STAGE/public/corpus" "$STAGE/dist/corpus"
  rsync -a --ignore-existing "$APP/public/corpus/" "$STAGE/public/corpus/"
  rsync -a --ignore-existing "$APP/public/corpus/" "$STAGE/dist/corpus/"
fi

# On first deployment, move mutable state out of the code directories once.
if [[ ! -e "$SHARED/.env" ]]; then
  chown --reference="$APP" "$SHARED"
  chmod 750 "$SHARED"
  cp -p "$APP/.env" "$SHARED/.env"
fi
if [[ ! -L "$APP/.env" ]]; then
  ln -s "$SHARED/.env" "$STATE/env-link"
  mv -Tf "$STATE/env-link" "$APP/.env"
fi
if [[ ! -e "$SHARED/data" ]]; then
  if [[ -d "$APP/data" ]]; then mv "$APP/data" "$SHARED/data"; else mkdir "$SHARED/data"; fi
fi
if [[ ! -L "$APP/data" && ! -e "$APP/data" ]]; then ln -s "$SHARED/data" "$APP/data"; fi
ln -s "$SHARED/.env" "$STAGE/.env"
ln -s "$SHARED/data" "$STAGE/data"

# Retain assets from the last three versions for browsers already open, without accumulating forever.
python3 - "$RELEASES" "$APP" "$STAGE" <<'PY'
import json, pathlib, re, shutil, sys
root, app, stage = map(pathlib.Path, sys.argv[1:])
older = [p for p in root.iterdir() if not p.is_symlink() and p.is_dir() and
         re.fullmatch(r'(?:[a-f0-9]{40}-\d{14}-[A-Za-z0-9]+|legacy-\d{14})', p.name)]
older.sort(key=lambda p: p.stat().st_mtime_ns, reverse=True)
for p in [app, *older[:3]]:
    source = p / 'dist/assets'
    if not source.is_dir():
        continue
    manifest = p / 'dist/release.json'
    names = json.loads(manifest.read_text()).get('assets', []) if manifest.is_file() else [f.name for f in source.iterdir() if f.is_file()]
    for name in names:
        if not isinstance(name, str) or pathlib.Path(name).name != name or name in ('.', '..'):
            continue
        target = stage / 'dist/assets' / name
        original = source / name
        if original.is_file() and not original.is_symlink() and not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, target)
PY

if [[ -L "$APP" ]]; then
  OLD="$(readlink -f "$APP")"
elif [[ -d "$APP" ]]; then
  OLD="$RELEASES/legacy-$(date -u +%Y%m%d%H%M%S)"
  mv "$APP" "$OLD"
  ln -s "$OLD" "$APP"
else
  echo 'Existing application directory is missing' >&2
  exit 78
fi
NEW="$RELEASES/$SHA-$(date -u +%Y%m%d%H%M%S)-${STAGE##*-}"
mv "$STAGE" "$NEW"
STAGE=""
ln -s "$NEW" "$STATE/new-link"
SWITCHED=1
mv -Tf "$STATE/new-link" "$APP"
systemctl restart bts

READY=0
for attempt in {1..30}; do
  if systemctl is-active --quiet bts &&
     curl -fsS --max-time 5 "$HEALTH_URL/api/health" | python3 -c 'import json,sys; assert json.load(sys.stdin).get("ok") is True' 2>/dev/null &&
     curl -fsS --max-time 5 "$HEALTH_URL/release.json" | python3 -c 'import json,sys; assert json.load(sys.stdin).get("commit") == sys.argv[1]' "$SHA" 2>/dev/null &&
     curl -fsS --max-time 5 "$HEALTH_URL/teacher.html" >/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
[[ $READY == 1 ]] || { echo 'New release failed health checks' >&2; exit 1; }
printf '%s\n' "$OLD" >"$STATE/previous-release"
COMMITTED=1
echo "Deployed $SHA; previous release: $OLD"

# Keep three code releases plus the current and previous release; never delete shared data.
python3 - "$RELEASES" "$NEW" "$OLD" <<'PY'
import pathlib, re, shutil, sys
root = pathlib.Path(sys.argv[1]).resolve()
protected = {pathlib.Path(p).resolve() for p in sys.argv[2:]}
releases = [p for p in root.iterdir() if p.is_dir() and not p.is_symlink() and
            re.fullmatch(r'(?:[a-f0-9]{40}-\d{14}-[A-Za-z0-9]+|legacy-\d{14})', p.name)]
releases.sort(key=lambda p: p.stat().st_mtime_ns, reverse=True)
for p in releases[3:]:
    if p.resolve().parent == root and p.resolve() not in protected:
        shutil.rmtree(p)
PY
