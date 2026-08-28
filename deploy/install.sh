#!/usr/bin/env bash
#
# Install reviewpassd on the inference host, beside the self-hosted runners.
#
#   ./deploy/install.sh user@your-inference-host
#
# Builds locally, ships the bundle, installs native deps on the host, and
# enables the service. Re-running it is a safe upgrade.
set -euo pipefail

HOST="${1:?usage: ./deploy/install.sh user@host}"
PREFIX="${REVIEWPASS_PREFIX:-/opt/reviewpass}"
STATE="${REVIEWPASS_STATE:-/var/lib/reviewpass}"

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

echo "==> building bundles"
npm run build >/dev/null
npm run build:daemon >/dev/null
ls -la dist/

echo "==> creating directories on ${HOST}"
ssh "$HOST" "
  set -e
  id -u reviewpass >/dev/null 2>&1 || useradd --system --home-dir '${STATE}' --shell /usr/sbin/nologin reviewpass
  mkdir -p '${PREFIX}' '${STATE}/mirrors' '${STATE}/work' /etc/reviewpass
  chown -R reviewpass:reviewpass '${STATE}'
"

echo "==> shipping files"
# better-sqlite3 is native, so package.json goes too and the host builds it.
scp -q dist/reviewpassd.cjs dist/index.cjs "$HOST:${PREFIX}/dist-staging" 2>/dev/null || {
  ssh "$HOST" "mkdir -p '${PREFIX}/dist'"
  scp -q dist/reviewpassd.cjs "$HOST:${PREFIX}/dist/reviewpassd.cjs"
  scp -q dist/index.cjs "$HOST:${PREFIX}/dist/index.cjs"
}
scp -q package.json "$HOST:${PREFIX}/package.json"
scp -q deploy/reviewpassd.service "$HOST:/etc/systemd/system/reviewpassd.service"

echo "==> installing native dependencies on the host"
ssh "$HOST" "
  set -e
  cd '${PREFIX}'
  # Only the modules the bundle keeps external need to exist here.
  npm install --omit=dev --no-audit --no-fund better-sqlite3 sqlite-vec >/dev/null
  chown -R reviewpass:reviewpass '${PREFIX}'
"

echo "==> generating a shared secret if none exists"
ssh "$HOST" "
  if [ ! -f /etc/reviewpass/reviewpassd.env ]; then
    printf 'REVIEWPASS_TOKEN=%s\n' \"\$(head -c 32 /dev/urandom | base64 | tr -d '=+/')\" > /etc/reviewpass/reviewpassd.env
    chmod 600 /etc/reviewpass/reviewpassd.env
    echo '    created /etc/reviewpass/reviewpassd.env'
  else
    echo '    keeping existing /etc/reviewpass/reviewpassd.env'
  fi
"

echo "==> starting the service"
ssh "$HOST" "
  systemctl daemon-reload
  systemctl enable --now reviewpassd
  sleep 2
  systemctl is-active reviewpassd
  curl -sf http://127.0.0.1:8787/health || { journalctl -u reviewpassd -n 30 --no-pager; exit 1; }
"

echo
echo "reviewpassd is running. Add the secret to your repository:"
ssh "$HOST" "grep REVIEWPASS_TOKEN /etc/reviewpass/reviewpassd.env"
echo
echo "  gh secret set REVIEWPASS_DAEMON_TOKEN --body '<the value above>'"
