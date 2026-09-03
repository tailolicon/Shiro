#!/usr/bin/env bash
set -Eeuo pipefail

# First-time (and manual) entry point for the ChatGPT-Web-drives-Shiro path.
# Collects the tunnel ID and runtime API key, stores them under .ShiroRuntime,
# then hands off to Start-Shiro.sh, which auto-starts the tunnel in the
# background from then on — including from the desktop launcher.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
project_root="$repo_root"
web_port=3080
mcp_port=23157

usage() {
  cat <<'EOF'
Usage: Start-Shiro-Tunnel.sh [options]

  --project-root PATH    Lock Shiro tools to PATH (default: this repository)
  --web-port PORT        DSH web UI port (default: 3080)
  --mcp-port PORT        Shiro MCP/health port (default: 23157)
  -h, --help             Show this help

Environment:
  SHIRO_TUNNEL_CLIENT       Tunnel client binary override
  CONTROL_PLANE_TUNNEL_ID   OpenAI tunnel ID (tunnel_...)
  CONTROL_PLANE_API_KEY     Runtime API key; when set, the tunnel runs in the
                            foreground with the key kept in memory only
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) project_root="${2:?--project-root needs a path}"; shift 2 ;;
    --web-port) web_port="${2:?--web-port needs a value}"; shift 2 ;;
    --mcp-port) mcp_port="${2:?--mcp-port needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

runtime_root="$(cd -- "$repo_root/.." && pwd)/.ShiroRuntime"
state_root="$runtime_root/state"
tunnel_id_file="$state_root/tunnel-id.txt"
api_key_file="$state_root/runtime-api-key.txt"
tunnel_client="${SHIRO_TUNNEL_CLIENT:-$runtime_root/tunnel/tunnel-client}"

if [[ ! -x "$tunnel_client" ]]; then
  cat >&2 <<EOF
OpenAI tunnel client is missing or not executable: $tunnel_client

Install the pinned, checksum-verified client first:

  npm run tunnel:install

or set SHIRO_TUNNEL_CLIENT to an existing binary.
EOF
  exit 1
fi

mkdir -p -- "$state_root"

if [[ -z "${CONTROL_PLANE_TUNNEL_ID:-}" && ! -s "$tunnel_id_file" ]]; then
  read -r -p 'OpenAI tunnel ID (tunnel_...): ' tunnel_id_input
  if [[ ! "$tunnel_id_input" =~ ^tunnel_[a-z0-9]{32}$ ]]; then
    echo 'The tunnel ID does not match the expected tunnel_... format.' >&2
    exit 1
  fi
  (umask 177 && printf '%s' "$tunnel_id_input" >"$tunnel_id_file")
fi

if [[ -z "${CONTROL_PLANE_API_KEY:-}" && ! -s "$api_key_file" ]]; then
  read -r -s -p 'OpenAI runtime API key (stored with 0600 permissions outside Git): ' api_key_input
  echo
  [[ -n "$api_key_input" ]] || { echo 'The runtime API key is required.' >&2; exit 1; }
  (umask 177 && printf '%s' "$api_key_input" >"$api_key_file")
  unset api_key_input
fi

"$script_dir/Start-Shiro.sh" \
  --project-root "$project_root" \
  --web-port "$web_port" \
  --mcp-port "$mcp_port" \
  --no-open

if [[ -n "${CONTROL_PLANE_API_KEY:-}" ]]; then
  # Memory-only key: run in the foreground so the key never touches disk.
  echo 'Shiro Secure MCP Tunnel is running in the foreground. Keep this terminal open (Ctrl+C to stop).'
  exec "$script_dir/Run-Shiro-Tunnel.sh" "$mcp_port"
fi

echo 'Shiro Secure MCP Tunnel setup is complete; the tunnel now starts with Shiro automatically.'
