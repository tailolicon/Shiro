import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Only session connection metadata is inherited. Credentials and arbitrary
// systemd environment variables never enter the child environment.
export const DESKTOP_ENV_NAMES = Object.freeze([
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'HYPRLAND_INSTANCE_SIGNATURE',
  'XAUTHORITY', 'PULSE_SERVER', 'PIPEWIRE_REMOTE', 'XDG_DATA_DIRS',
])
const allowed = new Set(DESKTOP_ENV_NAMES)
let cached = null
let expires = 0

export function selectDesktopEnvironment(source = {}) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    allowed.has(key) && typeof value === 'string' && value.length > 0 &&
    value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)))
}

export function parseDesktopEnvironment(text) {
  const values = {}
  for (const line of String(text).split('\n')) {
    const split = line.indexOf('=')
    if (split > 0 && allowed.has(line.slice(0, split))) values[line.slice(0, split)] = line.slice(split + 1)
  }
  return selectDesktopEnvironment(values)
}

export function clearDesktopEnvironmentCache() { cached = null; expires = 0 }

export function desktopEnvironment(source = process.env, { discover = source === process.env } = {}) {
  const explicit = selectDesktopEnvironment(source)
  if (!discover || process.platform !== 'linux') return explicit
  if (cached !== null && Date.now() < expires) return { ...cached, ...explicit }
  const uid = process.getuid?.()
  const runtime = `/run/user/${uid}`
  let found = {}
  try {
    const info = lstatSync(runtime)
    if (info.isDirectory() && !info.isSymbolicLink() && info.uid === uid) {
      found.XDG_RUNTIME_DIR = runtime
      if (existsSync(join(runtime, 'bus'))) {
        found.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`
        const result = spawnSync('/usr/bin/systemctl', ['--user', 'show-environment'], {
          env: { PATH: '/usr/bin:/bin', HOME: source.HOME ?? '', ...found },
          encoding: 'utf8', timeout: 1500, maxBuffer: 262144,
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        })
        if (result.status === 0) found = { ...found, ...parseDesktopEnvironment(result.stdout) }
      }
      // An unambiguous live compositor is useful when the user manager has not
      // imported its session environment. Never pick a random one of several.
      if (!found.HYPRLAND_INSTANCE_SIGNATURE) {
        const base = join(runtime, 'hypr')
        if (existsSync(base)) {
          const active = readdirSync(base).filter(name =>
            /^[A-Za-z0-9_.-]+$/.test(name) && existsSync(join(base, name, '.socket.sock')))
          if (active.length === 1) found.HYPRLAND_INSTANCE_SIGNATURE = active[0]
        }
      }
      if (!found.WAYLAND_DISPLAY) {
        const sockets = readdirSync(runtime).filter(name => /^wayland-\d+$/.test(name) && lstatSync(join(runtime, name)).isSocket())
        if (sockets.length === 1) found.WAYLAND_DISPLAY = sockets[0]
      }
    }
  } catch { /* A headless runner legitimately has no desktop. */ }
  cached = selectDesktopEnvironment(found)
  expires = Date.now() + 5000
  return { ...cached, ...explicit }
}
