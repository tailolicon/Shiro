#!/usr/bin/env bash
set -Eeuo pipefail

# Installs real per-process systemd supervision for Shiro.
#
# WHY THIS REPLACES THE OLD shiro.service
# The previous unit was a oneshot that ran Start-Shiro.sh -- which spawns
# everything DETACHED and exits. systemd marked the unit "active" forever while
# tracking no process at all: the backend could die (or serve a dead port, as
# actually happened when the working tree was switched underneath it) and
# nothing would notice, let alone restart it. Type=oneshot supervision of
# detached children is not supervision.
#
# THE SHAPE INSTALLED HERE
#   shiro-prepare.service   oneshot: deps, tokens, extension, engine build
#   shiro-relay.service     foreground node relay,  Restart=always
#   shiro-backend.service   foreground dsh engine,  Restart=always
#   shiro-tunnel.service    foreground tunnel client, Restart=always,
#                           skipped cleanly (Condition) until it is configured
#   shiro-chromium.service  the dedicated fleet browser, Restart=on-failure
#   shiro-watchdog.timer    HTTP health checks -- catches alive-but-dead-port
#   shiro.target            groups the lot; WantedBy=graphical-session.target,
#                           so on Omarchy (autologin straight into Hyprland)
#                           "machine on" means "Shiro up"
#
# Long-running daemon pieces use Restart=always + StartLimitIntervalSec=0 so
# systemd never gives up on a crashed backend/relay/tunnel. Chromium is the one
# deliberate exception: a second Chromium invocation for an already-owned
# --user-data-dir forwards its URL into the existing browser and exits 0. With
# Restart=always that becomes a 5-second new-tab loop, so the browser uses
# Restart=on-failure instead. Deliberate stops go through Stop-Shiro.sh and code
# updates go through Reload-Shiro.sh.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
runtime_root="$(cd -- "$repo_root/.." && pwd)/.ShiroRuntime"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
web_port="${SHIRO_WEB_PORT:-3080}"
mcp_port="${SHIRO_BRIDGE_PORT:-23157}"

command -v systemctl >/dev/null || { echo 'systemctl is required' >&2; exit 1; }
systemctl --user is-system-running >/dev/null 2>&1 || { echo 'the systemd user manager is not running' >&2; exit 1; }

mkdir -p -- "$unit_dir"

# The PATH every unit gets: mise shims resolve node/pnpm/npm at whatever
# version mise currently pins, instead of hardcoding one install dir the way
# the old unit did (it pinned node 26.7.0 and would have broken on update).
unit_path="$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

write_unit() {
  local name="$1"
  cat >"$unit_dir/$name"
  echo "  wrote $unit_dir/$name"
}

write_unit shiro.target <<EOF
[Unit]
Description=Shiro coding-agent stack
# Stops with logout, starts with login; Omarchy autologs into Hyprland, so in
# practice this is boot-to-up.
PartOf=graphical-session.target
After=graphical-session.target

[Install]
WantedBy=graphical-session.target
EOF

write_unit shiro-prepare.service <<EOF
[Unit]
Description=Shiro runtime prepare (deps, tokens, extension, engine build)
PartOf=shiro.target
Before=shiro-relay.service shiro-backend.service shiro-tunnel.service shiro-chromium.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=PATH=$unit_path
Environment=SHIRO_SYSTEMD_UNIT=1
Environment=CI=true
ExecStart=/usr/bin/bash $repo_root/scripts/Start-Shiro.sh --prepare-only --no-open --no-browser
# First run may build the whole engine.
TimeoutStartSec=1800

[Install]
WantedBy=shiro.target
EOF

write_unit shiro-relay.service <<EOF
[Unit]
Description=Shiro ChatGPT browser relay
PartOf=shiro.target
Requires=shiro-prepare.service
After=shiro-prepare.service

[Service]
Environment=PATH=$unit_path
ExecStart=/usr/bin/bash $repo_root/scripts/Run-Shiro-Relay.sh
Restart=always
RestartSec=3
StartLimitIntervalSec=0
SyslogIdentifier=shiro-relay

[Install]
WantedBy=shiro.target
EOF

write_unit shiro-backend.service <<EOF
[Unit]
Description=Shiro backend (DSH engine + MCP bridge)
PartOf=shiro.target
Requires=shiro-prepare.service
After=shiro-prepare.service shiro-relay.service
Wants=shiro-relay.service

[Service]
Environment=PATH=$unit_path
ExecStart=/usr/bin/bash $repo_root/scripts/Run-Shiro-Backend.sh $repo_root $web_port $mcp_port
Restart=always
RestartSec=3
StartLimitIntervalSec=0
SyslogIdentifier=shiro-backend

[Install]
WantedBy=shiro.target
EOF

write_unit shiro-tunnel.service <<EOF
[Unit]
Description=Shiro Secure MCP Tunnel client
PartOf=shiro.target
Requires=shiro-prepare.service
After=shiro-prepare.service shiro-backend.service
# Not configured yet -> skipped cleanly instead of crash-looping. Run
# scripts/Start-Shiro-Tunnel.sh once to provision these files.
ConditionPathExists=$runtime_root/tunnel/tunnel-client
ConditionPathExists=$runtime_root/state/tunnel-id.txt
ConditionPathExists=$runtime_root/state/runtime-api-key.txt

[Service]
Environment=PATH=$unit_path
ExecStart=/usr/bin/bash $repo_root/scripts/Run-Shiro-Tunnel.sh $mcp_port
Restart=always
RestartSec=5
StartLimitIntervalSec=0
SyslogIdentifier=shiro-tunnel

[Install]
WantedBy=shiro.target
EOF

write_unit shiro-chromium.service <<EOF
[Unit]
Description=Shiro dedicated ChatGPT Chromium profile
PartOf=shiro.target
Requires=shiro-prepare.service
After=shiro-prepare.service shiro-relay.service graphical-session.target

[Service]
Environment=PATH=$unit_path
ExecStart=/usr/bin/chromium --user-data-dir=$runtime_root/chrome-profile --load-extension=$runtime_root/chatgpt-extension --no-first-run --no-default-browser-check --disable-background-timer-throttling --ozone-platform-hint=auto --start-minimized https://chatgpt.com/
# Chromium exits 0 when this profile is already owned and forwards the URL to
# that browser. Restart=always would therefore inject a new tab every cycle.
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=0
SyslogIdentifier=shiro-chromium

[Install]
WantedBy=shiro.target
EOF

write_unit shiro-watchdog.service <<EOF
[Unit]
Description=Shiro health watchdog (restarts units whose HTTP health died)

[Service]
Type=oneshot
Environment=PATH=$unit_path
ExecStart=/usr/bin/bash $repo_root/scripts/Shiro-Watchdog.sh
SyslogIdentifier=shiro-watchdog
EOF

write_unit shiro-watchdog.timer <<EOF
[Unit]
Description=Run the Shiro health watchdog once a minute
PartOf=shiro.target

[Timer]
OnStartupSec=2min
OnUnitActiveSec=1min
AccuracySec=15s

[Install]
WantedBy=shiro.target
EOF

# -- migrate off the old single oneshot and any hand-started processes --------
if systemctl --user is-enabled shiro.service >/dev/null 2>&1; then
  echo 'Disabling the old oneshot shiro.service...'
  systemctl --user disable --now shiro.service >/dev/null 2>&1 || true
fi
rm -f -- "$unit_dir/shiro.service"

echo 'Stopping any hand-started Shiro processes...'
SHIRO_SYSTEMD_UNIT=1 bash "$script_dir/Stop-Shiro.sh" || true

systemctl --user daemon-reload
systemctl --user enable shiro.target >/dev/null
# enable propagates WantedBy for member units too
systemctl --user enable shiro-prepare.service shiro-relay.service shiro-backend.service shiro-tunnel.service shiro-chromium.service shiro-watchdog.timer >/dev/null

echo 'Starting shiro.target...'
systemctl --user start shiro.target

for _ in {1..240}; do
  curl --fail --silent --max-time 2 "http://127.0.0.1:$mcp_port/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if curl --fail --silent --max-time 2 "http://127.0.0.1:$mcp_port/health" >/dev/null 2>&1; then
  echo "Shiro is up and supervised: http://127.0.0.1:$web_port/"
else
  echo 'Units started but the bridge is not healthy yet; check: systemctl --user status shiro-backend' >&2
  exit 1
fi

systemctl --user --no-pager --no-legend list-units 'shiro*' || true
