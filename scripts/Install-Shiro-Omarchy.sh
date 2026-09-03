#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
current_user="${USER:-$(id -un)}"

if ! command -v docker >/dev/null 2>&1; then
  omarchy pkg add docker docker-buildx
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo 'Installing pnpm 11 into the active Node.js prefix...'
  npm install -g pnpm@11
fi

if ! getent group docker >/dev/null; then
  sudo groupadd docker
fi
if ! getent group docker | awk -F: -v user="$current_user" '$4 ~ "(^|,)" user "(,|$)" { found=1 } END { exit !found }'; then
  sudo usermod -aG docker "$current_user"
  echo "Added $current_user to the docker group. Shiro will use that group immediately via sg; the next login picks it up normally."
fi
sudo systemctl enable --now docker.service

mkdir -p -- "$applications_dir"
desktop-file-install --dir="$applications_dir" \
  --set-key=Exec --set-value="$repo_root/scripts/Start-Shiro.sh" \
  --set-icon="$repo_root/desktop/shiro.svg" \
  "$repo_root/desktop/shiro.desktop"
update-desktop-database "$applications_dir"

echo "Installed Shiro launcher: $applications_dir/shiro.desktop"
