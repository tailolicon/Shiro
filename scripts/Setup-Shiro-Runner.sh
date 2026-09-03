#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="${1:?usage: Setup-Shiro-Runner.sh REPO_ROOT}"
image='shiro-runner:0.1.0'

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for Shiro sandbox_exec.' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo 'Docker is installed but unavailable. Start docker.service and add the current user to the docker group.' >&2
  exit 1
fi

# Reusing the local image keeps graphical-session startup independent of
# Docker Hub and DNS. Rebuild explicitly after changing container/Dockerfile.
if [[ "${SHIRO_REBUILD_RUNNER:-0}" == '1' ]] || ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build --quiet --tag "$image" --file "$repo_root/container/Dockerfile" "$repo_root/container" >/dev/null
fi
for volume in shiro-root-node-modules shiro-bridge-node-modules shiro-pnpm-store; do
  docker volume create "$volume" >/dev/null
done

mounts=(
  --mount "type=bind,source=$repo_root,target=/workspace"
  --mount 'type=volume,source=shiro-root-node-modules,target=/workspace/node_modules'
  --mount 'type=volume,source=shiro-bridge-node-modules,target=/workspace/bridge/node_modules'
  --mount 'type=volume,source=shiro-pnpm-store,target=/pnpm/store'
)

if ! docker run --rm --network none "${mounts[@]}" --workdir /workspace "$image" \
  'test -f bridge/node_modules/@modelcontextprotocol/sdk/package.json'; then
  docker run --rm --network bridge --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 512 --memory 4g --cpus 4 "${mounts[@]}" --workdir /workspace \
    --env CI=true "$image" \
    'pnpm --dir bridge install --frozen-lockfile=false --config.auto-install-peers=false --store-dir /pnpm/store'
fi

echo 'Shiro isolated runner is ready.'
