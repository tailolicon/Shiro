#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
runtime_root="$(cd -- "$repo_root/.." && pwd)/.ShiroRuntime"

export ENV_FILE="$runtime_root/state/chatgpt-relay.env"
export BRIDGE_EXTENSION_TARGET_DIR="$runtime_root/chatgpt-extension"
export SHIRO_OMNICAST_RETURN_STATE_FILE="$runtime_root/state/omnicast-return.json"

cd -- "$repo_root/relay/chatgpt-bridge"
exec node src/index.js --server
