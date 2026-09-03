#!/usr/bin/env bash
set -Eeuo pipefail

# Foreground runner for OpenAI's Secure MCP Tunnel client. Start-Shiro.sh
# launches this detached once the tunnel ID and runtime API key are on disk;
# Start-Shiro-Tunnel.sh collects those pieces interactively the first time.

if [[ $# -gt 1 ]]; then
  echo 'usage: Run-Shiro-Tunnel.sh [MCP_PORT]' >&2
  exit 2
fi
mcp_port="${1:-23157}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
runtime_root="$(cd -- "$repo_root/.." && pwd)/.ShiroRuntime"
state_root="$runtime_root/state"
token_file="$state_root/bridge-token.txt"
tunnel_id_file="$state_root/tunnel-id.txt"
api_key_file="$state_root/runtime-api-key.txt"
health_url_file="$state_root/tunnel-health.url"
tunnel_client="${SHIRO_TUNNEL_CLIENT:-$runtime_root/tunnel/tunnel-client}"

[[ -x "$tunnel_client" ]] || { echo "OpenAI tunnel client is missing: $tunnel_client (run: npm run tunnel:install)" >&2; exit 1; }
[[ -s "$token_file" ]] || { echo "Shiro's local bridge token is missing." >&2; exit 1; }

if [[ -z "${CONTROL_PLANE_TUNNEL_ID:-}" ]]; then
  [[ -s "$tunnel_id_file" ]] || { echo "Tunnel ID is missing: $tunnel_id_file" >&2; exit 1; }
  CONTROL_PLANE_TUNNEL_ID="$(tr -d '[:space:]' <"$tunnel_id_file")"
fi
export CONTROL_PLANE_TUNNEL_ID
if [[ ! "$CONTROL_PLANE_TUNNEL_ID" =~ ^tunnel_[a-z0-9]{32}$ ]]; then
  echo 'The tunnel ID does not match the expected tunnel_... format.' >&2
  exit 1
fi

# Key resolution order: environment (memory only), then the 0600 key file.
if [[ -n "${CONTROL_PLANE_API_KEY:-}" ]]; then
  api_key_ref='env:CONTROL_PLANE_API_KEY'
else
  [[ -s "$api_key_file" ]] || { echo "Runtime API key is missing: $api_key_file (run: npm run tunnel:linux once)" >&2; exit 1; }
  chmod 600 "$api_key_file"
  api_key_ref="file:$api_key_file"
fi

SHIRO_AUTH_HEADER="Bearer $(tr -d '\r\n' <"$token_file")"
export SHIRO_AUTH_HEADER

exec "$tunnel_client" run \
  --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --control-plane.api-key "$api_key_ref" \
  --mcp.server-url "url=http://127.0.0.1:$mcp_port/mcp,channel=main" \
  --mcp.extra-headers 'Authorization: env:SHIRO_AUTH_HEADER' \
  --mcp.discovery-extra-headers 'Authorization: env:SHIRO_AUTH_HEADER' \
  --mcp.startup-wait-timeout 30s \
  --health.listen-addr '127.0.0.1:0' \
  --health.url-file "$health_url_file"
