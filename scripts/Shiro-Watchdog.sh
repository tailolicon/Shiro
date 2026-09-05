#!/usr/bin/env bash
set -Eeuo pipefail

# Health-level supervision, one layer above systemd's process-level restarts.
#
# systemd already restarts a process that DIES. What it cannot see is the
# failure mode this repo actually hit: the backend process alive and green in
# systemctl while the MCP port served nothing (the working tree had been
# switched under it, so the bridge plugin never mounted). Only an HTTP check
# catches that, so a timer runs this script once a minute.
#
# Restart discipline: a unit is only restarted after TWO consecutive failed
# checks, and only while systemd reports it active -- an inactive unit is
# either deliberately stopped or already being handled by systemd itself.
# One failure is logged and remembered; recovery clears the counter. With the
# one-minute cadence a freshly (re)started backend gets at least a minute to
# come up before it is even probed again, and two minutes before the watchdog
# would act, which comfortably covers its ~10-30s boot.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
runtime_root="$(cd -- "$repo_root/.." && pwd)/.ShiroRuntime"
state_dir="${XDG_RUNTIME_DIR:-/tmp}/shiro-watchdog"
mkdir -p -- "$state_dir"

mcp_port="${SHIRO_BRIDGE_PORT:-23157}"
relay_env="$runtime_root/state/chatgpt-relay.env"
relay_port=''
relay_token=''
if [[ -s "$relay_env" ]]; then
  relay_port="$(sed -n 's/^PORT=//p' "$relay_env" | tail -n 1)"
  relay_token="$(sed -n 's/^API_TOKEN=//p' "$relay_env" | tail -n 1)"
fi

check() {
  local name="$1" unit="$2" fails_file="$state_dir/$1.fails" fails=0
  shift 2
  if ! systemctl --user is-active --quiet "$unit"; then
    rm -f -- "$fails_file"
    return 0
  fi
  if curl --fail --silent --output /dev/null --max-time 4 "$@"; then
    rm -f -- "$fails_file"
    return 0
  fi
  fails=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))
  if (( fails >= 2 )); then
    echo "shiro-watchdog: $name is active but unhealthy ($fails consecutive checks) -- restarting $unit"
    rm -f -- "$fails_file"
    systemctl --user restart "$unit"
  else
    printf '%s' "$fails" >"$fails_file"
    echo "shiro-watchdog: $name failed health check $fails/2"
  fi
}

check backend shiro-backend.service "http://127.0.0.1:$mcp_port/health"
if [[ -n "$relay_port" && -n "$relay_token" ]]; then
  check relay shiro-relay.service -H "authorization: Bearer $relay_token" "http://127.0.0.1:$relay_port/health"
fi
