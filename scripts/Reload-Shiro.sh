#!/usr/bin/env bash
set -Eeuo pipefail

# The one command for "I changed Shiro's code, make it live".
#
# Deliberately NOT `systemctl restart shiro.target`: that would also bounce the
# dedicated Chromium profile, killing every fleet tab for a code change that
# never touched the browser. What a code update actually needs is:
#   1. prepare re-run  (profile patch re-rendered, bridge peer re-linked,
#                       extension re-deployed to the runtime dir)
#   2. relay restart   (relay/chatgpt-bridge source)
#   3. backend restart (engine + bridge source)
# Chromium keeps running; if the extension itself changed, reload it in place
# through the relay's own route afterwards (see the note this script prints).

usage() {
  cat <<'EOF'
Usage: Reload-Shiro.sh [--backend-only] [--rebuild]

  --backend-only   Restart only the backend (bridge/engine change; relay untouched)
  --rebuild        Force a full engine rebuild during prepare
EOF
}

backend_only=0
rebuild=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-only) backend_only=1; shift ;;
    --rebuild) rebuild=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

if ! systemctl --user is-enabled shiro.target >/dev/null 2>&1; then
  echo 'Shiro is not systemd-managed; falling back to a full stop/start.' >&2
  bash "$script_dir/Stop-Shiro.sh"
  exec bash "$script_dir/Start-Shiro.sh" --no-open $([[ "$rebuild" -eq 1 ]] && echo --rebuild)
fi

[[ "$rebuild" -eq 1 ]] && rm -f -- "$repo_root/engine/.shiro-build-ready"

echo 'Re-running the runtime prepare step...'
systemctl --user restart shiro-prepare.service

if [[ "$backend_only" -eq 1 ]]; then
  echo 'Restarting the backend...'
  systemctl --user restart shiro-backend.service
else
  echo 'Restarting the relay and the backend...'
  systemctl --user restart shiro-relay.service shiro-backend.service
fi

mcp_port="${SHIRO_BRIDGE_PORT:-23157}"
for _ in {1..180}; do
  curl --fail --silent --max-time 2 "http://127.0.0.1:$mcp_port/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if curl --fail --silent --max-time 2 "http://127.0.0.1:$mcp_port/health" >/dev/null 2>&1; then
  echo 'Shiro reloaded and healthy.'
else
  echo 'Reload finished but the bridge is not healthy yet; check: systemctl --user status shiro-backend' >&2
  exit 1
fi

echo 'Note: if the browser extension changed, reload it in place via the relay'
echo '      (POST /browser/extension/reload) instead of restarting Chromium.'
