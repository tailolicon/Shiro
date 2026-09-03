#!/usr/bin/env bash
set -Eeuo pipefail

# Downloads OpenAI's official Secure MCP Tunnel client (github.com/openai/tunnel-client)
# into ../.ShiroRuntime/tunnel/tunnel-client. Version and checksum are pinned, in the
# same spirit as Shiro's pinned submodules: bump both together after auditing a release.

version='v0.0.13'
declare -A sha256=(
  ['linux-amd64']='e71f37b424126513173d5e3590687c0b5ccf6e8ef3fba900104d1f8c60dad906'
  ['linux-arm64']='9d214a805bec213a3a156dc2a4460a6dfe2f35b0c00ba20609d002bf5e6469f8'
)

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
runtime_root="$(cd -- "$repo_root/.." && pwd)/.ShiroRuntime"
tunnel_root="$runtime_root/tunnel"
target="$tunnel_root/tunnel-client"

case "$(uname -m)" in
  x86_64) arch='amd64' ;;
  aarch64) arch='arm64' ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
platform="linux-$arch"
asset="tunnel-client-${version}-${platform}.zip"
url="https://github.com/openai/tunnel-client/releases/download/${version}/${asset}"

for command in curl unzip sha256sum; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command is missing: $command" >&2; exit 1; }
done

if [[ -x "$target" ]]; then
  installed="$("$target" --version 2>/dev/null | head -n 1 || true)"
  if [[ "$installed" == "${version#v}"* ]]; then
    echo "Tunnel client $version is already installed: $target"
    exit 0
  fi
  echo "Replacing installed tunnel client (${installed:-unknown version}) with $version..."
fi

mkdir -p -- "$tunnel_root"
workdir="$(mktemp -d)"
trap 'rm -rf -- "$workdir"' EXIT

echo "Downloading $asset..."
curl --fail --location --proto '=https' --tlsv1.2 --output "$workdir/$asset" "$url"

echo "${sha256[$platform]}  $workdir/$asset" | sha256sum --check --quiet \
  || { echo "Checksum mismatch for $asset. Refusing to install." >&2; exit 1; }

unzip -o -q "$workdir/$asset" -d "$workdir/extracted"
binary="$(find "$workdir/extracted" -type f -name 'tunnel-client*' ! -name '*.txt' ! -name '*.json' | head -n 1)"
[[ -n "$binary" ]] || { echo "The archive did not contain a tunnel-client binary." >&2; exit 1; }

install -m 755 -- "$binary" "$target"
echo "Installed tunnel-client $("$target" --version 2>/dev/null | head -n 1 || echo "$version"): $target"
