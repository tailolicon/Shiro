#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
runtime_root="$(cd -- "$repo_root/.." && pwd)/.ShiroRuntime"
state_root="$runtime_root/state"

stop_registered() {
  local name="$1"
  local pid_file="$2"
  local expected_cwd="$3"
  local expected_cmd="$4"
  [[ -f "$pid_file" ]] || { echo "$name is not registered."; return; }

  local pid
  pid="$(<"$pid_file")"
  if [[ ! "$pid" =~ ^[0-9]+$ || ! -d "/proc/$pid" ]]; then
    rm -f -- "$pid_file"
    echo "$name is already stopped."
    return
  fi

  local owner cwd cmdline
  owner="$(stat -c '%u' "/proc/$pid")"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  # A process launched through `sg docker` (first session after install) is
  # non-dumpable, so its /proc cwd link is unreadable even for its owner.
  # Fall back to matching the registered command line in that case.
  cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  if [[ "$owner" != "$(id -u)" ]] \
    || { [[ "$cwd" != "$expected_cwd" ]] && [[ "$cmdline" != *"$expected_cmd"* ]]; }; then
    echo "Refusing to stop PID $pid: it is not the registered $name process." >&2
    return 1
  fi

  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  rm -f -- "$pid_file"
  echo "$name stopped."
}

stop_registered 'Secure MCP Tunnel' "$state_root/tunnel-process-id.txt" "$repo_root" 'tunnel-client run'
stop_registered 'Shiro backend' "$state_root/backend-process-id.txt" "$repo_root/engine" 'dsh --profile web'
stop_registered 'ChatGPT relay' "$state_root/chatgpt-relay-process-id.txt" "$repo_root/relay/chatgpt-bridge" 'node src/index.js --server'

chrome_profile="$runtime_root/chrome-profile"
mapfile -t chrome_pids < <(pgrep -u "$(id -u)" -f -- "--user-data-dir=$chrome_profile" || true)
if [[ "${#chrome_pids[@]}" -gt 0 ]]; then
  kill "${chrome_pids[@]}" 2>/dev/null || true
  echo 'Dedicated Shiro Chromium profile stopped.'
fi
rm -f -- "$state_root/chromium-process-id.txt"
