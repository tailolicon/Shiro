#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo 'usage: Run-Shiro-Backend.sh PROJECT_ROOT WEB_PORT MCP_PORT' >&2
  exit 2
fi

project_root="$(realpath -- "$1")"
web_port="$2"
mcp_port="$3"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
runtime_root="$(cd -- "$repo_root/.." && pwd)/.ShiroRuntime"
relay_env="$runtime_root/state/chatgpt-relay.env"

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$relay_env" | tail -n 1
}

[[ -s "$runtime_root/state/bridge-token.txt" ]] || { echo 'Private bridge token is missing.' >&2; exit 1; }
[[ -s "$relay_env" ]] || { echo 'ChatGPT relay configuration is missing.' >&2; exit 1; }

relay_port="$(env_value PORT)"
relay_api_token="$(env_value API_TOKEN)"
[[ -n "$relay_api_token" ]] || { echo 'ChatGPT relay API token is missing.' >&2; exit 1; }

export DSH_HOME="$runtime_root/dsh-home"
export DSH_AGENTS_HOME="$runtime_root/agents"
export SHIRO_MEMORY_ROOT="$runtime_root/memory"
export SHIRO_WORKSPACE_ROOT="$project_root"
# Directory trees the direct actions may open as extra workspaces
# (workspace_open). The fixed project root is always reachable; everything else
# has to be listed here. Colon-separated, absolute; "/" is refused. Override by
# exporting SHIRO_WORKSPACE_ALLOWLIST before launching, or set it to the empty
# string to keep the bridge single-rooted.
export SHIRO_WORKSPACE_ALLOWLIST="${SHIRO_WORKSPACE_ALLOWLIST-$(dirname -- "$project_root"):/tmp/shiro}"
export SHIRO_LOG_DIR="$runtime_root/logs"
export SHIRO_BRIDGE_TOKEN="$(<"$runtime_root/state/bridge-token.txt")"
export SHIRO_BRIDGE_PORT="$mcp_port"
export SHIRO_RELAY_URL="http://127.0.0.1:${relay_port:-23158}"
export SHIRO_RELAY_API_TOKEN="$relay_api_token"
export SHIRO_RELAY_MODEL='GPT-5.6 Sol'
export DSH_CLIENT_TITLE='Shiro'

# Prefer the native Harness-owned loop when the subscription-authenticated
# Grok Build CLI is installed. It is already registered as a pure model
# adapter by the bridge (its own tools/subagents/web search are disabled), so
# this removes the browser/MCP round trip from every model→tool→model step.
# An operator can keep the compatibility path with
# SHIRO_EXECUTION_MODE=relay, or select another ctx.llm adapter by exporting
# the autonomous provider/model pair before launch.
grok_cli="${SHIRO_GROK_CLI:-$HOME/.grok/bin/grok}"
if [[ -x "$grok_cli" ]]; then
  export SHIRO_GROK_CLI="$grok_cli"
  export SHIRO_AUTONOMOUS_PROVIDER="${SHIRO_AUTONOMOUS_PROVIDER:-shiro-grok}"
  export SHIRO_AUTONOMOUS_MODEL="${SHIRO_AUTONOMOUS_MODEL:-grok-4.6}"
fi
if [[ -n "${SHIRO_AUTONOMOUS_PROVIDER:-}" && -n "${SHIRO_AUTONOMOUS_MODEL:-}" ]]; then
  export SHIRO_EXECUTION_MODE="${SHIRO_EXECUTION_MODE:-autonomous}"
fi

cd -- "$repo_root/engine"
exec pnpm dsh --profile web --no-open --host 127.0.0.1 --port "$web_port"
