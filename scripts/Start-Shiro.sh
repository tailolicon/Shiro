#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
project_root="$repo_root"
web_port=3080
mcp_port=23157
relay_port=23158
rebuild=0
open_ui=1
open_browser=1
original_args=("$@")

usage() {
  cat <<'EOF'
Usage: Start-Shiro.sh [options]

  --project-root PATH  Lock Shiro tools to PATH (default: this repository)
  --web-port PORT      DSH web UI port (default: 3080)
  --mcp-port PORT      Shiro MCP/health port (default: 23157)
  --rebuild            Rebuild the DSH engine
  --no-open            Do not open the Shiro UI after startup
  --no-browser         Do not start the dedicated ChatGPT Chromium profile
  -h, --help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) project_root="${2:?--project-root needs a path}"; shift 2 ;;
    --web-port) web_port="${2:?--web-port needs a value}"; shift 2 ;;
    --mcp-port) mcp_port="${2:?--mcp-port needs a value}"; shift 2 ;;
    --rebuild) rebuild=1; shift ;;
    --no-open) open_ui=0; shift ;;
    --no-browser) open_browser=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

project_root="$(realpath -- "$project_root")"
runtime_root="$(cd -- "$repo_root/.." && pwd)/.ShiroRuntime"
state_root="$runtime_root/state"
log_root="$runtime_root/logs"
profile_root="$runtime_root/dsh-home/profiles/web"
relay_root="$repo_root/relay/chatgpt-bridge"
relay_env="$state_root/chatgpt-relay.env"
relay_extension_root="$runtime_root/chatgpt-extension"

for command in node npm pnpm git docker curl jq openssl setsid flock; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command is missing: $command" >&2; exit 1; }
done

# `usermod -aG docker` takes effect for new login sessions. During the current
# Omarchy session, re-enter through `sg` so first launch can continue without a
# logout while retaining ordinary non-root Docker access in all child tools.
if getent group docker | awk -F: -v user="${USER:-$(id -un)}" '$4 ~ "(^|,)" user "(,|$)" { found=1 } END { exit !found }'; then
  if ! id -nG | tr ' ' '\n' | grep -Fxq docker; then
    if command -v sg >/dev/null 2>&1; then
      printf -v quoted '%q ' "$0" "${original_args[@]}"
      exec sg docker -c "$quoted"
    fi
    if sudo -n -u "${USER:-$(id -un)}" -g docker true 2>/dev/null; then
      exec sudo -n -E -u "${USER:-$(id -un)}" -g docker -- \
        env "PATH=$PATH" "$0" "${original_args[@]}"
    fi
    echo 'Docker group membership is configured but not active. Log out and back in, then retry.' >&2
    exit 1
  fi
fi

if ! docker info >/dev/null 2>&1; then
  echo 'Docker is unavailable to this user. Run Install-Shiro-Omarchy.sh once, then retry.' >&2
  exit 1
fi

required=(
  "$repo_root/engine/package.json"
  "$repo_root/bridge/package.json"
  "$repo_root/plugins/auto-continue/package.json"
  "$repo_root/plugins/subagent-monitor/package.json"
  "$repo_root/plugins/memory/package.json"
  "$repo_root/research/awesome-dsh-plugin/package.json"
  "$relay_root/package.json"
)
for file in "${required[@]}"; do
  [[ -f "$file" ]] || { echo "Required Shiro file is missing: $file" >&2; exit 1; }
done

mkdir -p -- "$state_root" "$log_root"
exec 9>"$state_root/start.lock"
if ! flock -n 9; then
  echo 'Another Shiro startup is already running.' >&2
  exit 1
fi

node "$script_dir/Prepare-Shiro-Runtime.mjs" "$repo_root" "$relay_port" >/dev/null

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$relay_env" | tail -n 1
}

relay_api_token="$(env_value API_TOKEN)"
[[ -n "$relay_api_token" ]] || { echo 'Generated relay token is missing.' >&2; exit 1; }

export CI=true
if [[ ! -x "$repo_root/engine/node_modules/.bin/tsx" ]]; then
  echo 'Installing Shiro engine dependencies...'
  pnpm --dir "$repo_root/engine" install --frozen-lockfile
fi
if [[ ! -f "$repo_root/bridge/node_modules/@modelcontextprotocol/sdk/package.json" ]]; then
  echo 'Installing Shiro bridge dependencies...'
  pnpm --dir "$repo_root/bridge" install --frozen-lockfile=false
fi
if [[ ! -f "$relay_root/node_modules/express/package.json" ]]; then
  echo 'Installing the audited ChatGPT browser relay...'
  npm --prefix "$relay_root" ci --ignore-scripts=false
fi

echo 'Preparing the Shiro browser companion extension...'
node "$relay_root/scripts/extension-install.js" \
  --source "$relay_root/tools/chrome-bridge-extension" \
  --target "$relay_extension_root"

"$script_dir/Setup-Shiro-Runner.sh" "$repo_root"

echo 'Linking the Shiro runtime profile...'
pnpm --dir "$profile_root" install --frozen-lockfile=false --prefer-offline

build_marker="$repo_root/engine/.shiro-build-ready"
if [[ "$rebuild" -eq 1 || ! -f "$build_marker" ]]; then
  echo 'Building the Shiro engine...'
  DSH_CLIENT_TITLE=Shiro pnpm --dir "$repo_root/engine" build
  date --iso-8601=seconds >"$build_marker"
fi

relay_health() {
  curl --fail --silent --show-error --max-time 2 \
    -H "Authorization: Bearer $relay_api_token" \
    "http://127.0.0.1:$relay_port/health"
}

backend_health() {
  curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$mcp_port/health"
}

start_detached() {
  local pid_file="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  shift 3
  # 9>&- keeps children from inheriting the startup lock; otherwise the
  # detached relay/backend hold it and every later startup aborts.
  nohup setsid "$@" </dev/null >>"$stdout_file" 2>>"$stderr_file" 9>&- &
  local pid=$!
  printf '%s\n' "$pid" >"$pid_file"
}

if ! relay_health >/dev/null 2>&1; then
  relay_stdout="$log_root/chatgpt-relay.stdout.log"
  relay_stderr="$log_root/chatgpt-relay.stderr.log"
  : >"$relay_stdout"
  : >"$relay_stderr"
  start_detached "$state_root/chatgpt-relay-process-id.txt" "$relay_stdout" "$relay_stderr" \
    "$script_dir/Run-Shiro-Relay.sh"
  relay_pid="$(<"$state_root/chatgpt-relay-process-id.txt")"
  for _ in {1..60}; do
    relay_health >/dev/null 2>&1 && break
    if ! kill -0 "$relay_pid" 2>/dev/null; then
      echo 'ChatGPT browser relay exited early:' >&2
      tail -n 30 "$relay_stderr" >&2 || true
      exit 1
    fi
    sleep 0.5
  done
  relay_health >/dev/null 2>&1 || { echo "ChatGPT relay did not become ready. Logs: $log_root" >&2; exit 1; }
fi

current_health=''
if current_health="$(backend_health 2>/dev/null)"; then
  current_root="$(jq -r '.workspaceRoot // empty' <<<"$current_health")"
  if [[ "$current_root" != "$project_root" ]]; then
    echo "Port $mcp_port is already used by a Shiro instance locked to $current_root." >&2
    exit 1
  fi
else
  backend_stdout="$log_root/backend.stdout.log"
  backend_stderr="$log_root/backend.stderr.log"
  : >"$backend_stdout"
  : >"$backend_stderr"
  start_detached "$state_root/backend-process-id.txt" "$backend_stdout" "$backend_stderr" \
    "$script_dir/Run-Shiro-Backend.sh" "$project_root" "$web_port" "$mcp_port"
  backend_pid="$(<"$state_root/backend-process-id.txt")"
  echo 'Starting Shiro locally...'
  for _ in {1..180}; do
    if current_health="$(backend_health 2>/dev/null)"; then
      [[ "$(jq -r '.workspaceRoot // empty' <<<"$current_health")" == "$project_root" ]] && break
    fi
    if ! kill -0 "$backend_pid" 2>/dev/null; then
      echo 'Shiro backend exited early:' >&2
      tail -n 30 "$backend_stderr" >&2 || true
      exit 1
    fi
    sleep 0.5
  done
  current_health="$(backend_health 2>/dev/null || true)"
  # Not `${current_health:-{}}`: the first `}` closes the expansion, so bash
  # appends a literal `}` and jq is handed `{...}}`. It happened to still work --
  # jq prints the value before choking on the stray brace -- but it printed a
  # parse error on every start and would have become a false negative the moment
  # jq stopped emitting output ahead of the error.
  health_json="$current_health"
  [[ -n "$health_json" ]] || health_json='{}'
  [[ "$(jq -r '.workspaceRoot // empty' <<<"$health_json")" == "$project_root" ]] \
    || { echo "Shiro did not become ready. Logs: $log_root" >&2; exit 1; }
fi

echo "Shiro is ready: http://127.0.0.1:$web_port/"
echo "Locked project root: $project_root"

# Auto-start the ChatGPT Secure MCP Tunnel once its credentials are on disk
# (Start-Shiro-Tunnel.sh stores them on first run), so opening Shiro is enough
# for ChatGPT Web to reach the local MCP bridge.
tunnel_client="${SHIRO_TUNNEL_CLIENT:-$runtime_root/tunnel/tunnel-client}"
if [[ -x "$tunnel_client" && -s "$state_root/tunnel-id.txt" && -s "$state_root/runtime-api-key.txt" ]]; then
  tunnel_ready() {
    [[ -s "$state_root/tunnel-health.url" ]] || return 1
    local health_url
    health_url="$(tr -d '\r\n' <"$state_root/tunnel-health.url")"
    [[ "$health_url" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || return 1
    curl --fail --silent --show-error --max-time 2 "$health_url/readyz" >/dev/null
  }

  if pgrep -u "$(id -u)" -f -- "$tunnel_client" >/dev/null 2>&1; then
    for _ in {1..20}; do
      tunnel_ready && break
      sleep 0.5
    done
    tunnel_ready \
      || { echo "Secure MCP Tunnel is running but not ready. Logs: $log_root" >&2; exit 1; }
    echo 'Secure MCP Tunnel is already running and ready.'
  else
    tunnel_stdout="$log_root/tunnel.stdout.log"
    tunnel_stderr="$log_root/tunnel.stderr.log"
    : >"$tunnel_stdout"
    : >"$tunnel_stderr"
    rm -f -- "$state_root/tunnel-health.url"
    start_detached "$state_root/tunnel-process-id.txt" "$tunnel_stdout" "$tunnel_stderr" \
      "$script_dir/Run-Shiro-Tunnel.sh" "$mcp_port"
    tunnel_pid="$(<"$state_root/tunnel-process-id.txt")"
    for _ in {1..120}; do
      tunnel_ready && break
      if ! kill -0 "$tunnel_pid" 2>/dev/null; then
        echo 'Secure MCP Tunnel exited early:' >&2
        tail -n 10 "$tunnel_stdout" "$tunnel_stderr" >&2 || true
        exit 1
      fi
      sleep 0.5
    done
    tunnel_ready \
      || { echo "Secure MCP Tunnel did not become ready. Logs: $log_root" >&2; exit 1; }
    echo 'Secure MCP Tunnel is ready; ChatGPT Web can reach Shiro.'
  fi
fi

clients="$(relay_health | jq -r '.clients // 0')"
if [[ "$open_browser" -eq 1 && "$clients" -lt 1 ]]; then
  chrome_profile="$runtime_root/chrome-profile"
  if ! pgrep -u "$(id -u)" -f -- "--user-data-dir=$chrome_profile" >/dev/null 2>&1; then
    echo 'Starting the dedicated ChatGPT Chromium profile...'
    nohup chromium \
      "--user-data-dir=$chrome_profile" \
      "--load-extension=$relay_extension_root" \
      --no-first-run --no-default-browser-check \
      --disable-background-timer-throttling --ozone-platform-hint=auto \
      --start-minimized https://chatgpt.com/ \
      </dev/null >>"$log_root/chromium.stdout.log" 2>>"$log_root/chromium.stderr.log" 9>&- &
    printf '%s\n' "$!" >"$state_root/chromium-process-id.txt"
  fi
  for _ in {1..40}; do
    clients="$(relay_health | jq -r '.clients // 0')"
    [[ "$clients" -ge 1 ]] && break
    sleep 0.5
  done
  if [[ "$clients" -lt 1 ]]; then
    echo "Connect the extension once at http://127.0.0.1:$relay_port/setup"
    # 9>&- like every other spawn here: xdg-open hands the URL to the user's
    # own browser, which then INHERITS the startup lock on fd 9 and holds it
    # for as long as that browser stays open. Observed: a personal Chrome kept
    # the lock for hours, so every later start died with "Another Shiro startup
    # is already running" while nothing was running at all.
    xdg-open "http://127.0.0.1:$relay_port/setup" >/dev/null 2>&1 9>&- &
  fi
fi

if [[ "$open_ui" -eq 1 ]]; then
  xdg-open "http://127.0.0.1:$web_port/" >/dev/null 2>&1 9>&- &
fi
