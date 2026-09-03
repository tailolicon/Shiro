import { randomBytes } from 'node:crypto'
import { access, chmod, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'))
const runtimeRoot = path.resolve(repoRoot, '..', '.ShiroRuntime')
const engineRoot = path.join(repoRoot, 'engine')
const profileRoot = path.join(runtimeRoot, 'dsh-home', 'profiles', 'web')
const stateRoot = path.join(runtimeRoot, 'state')
const relayDataRoot = path.join(runtimeRoot, 'chatgpt-relay')
const relayExtensionRoot = path.join(runtimeRoot, 'chatgpt-extension')
const relayPort = Number(process.argv[3] || 23158)

if (!Number.isInteger(relayPort) || relayPort < 1024 || relayPort > 65535) {
  throw new Error('relay port must be an integer from 1024 to 65535')
}

const paths = {
  runtimeRoot,
  profileRoot,
  stateRoot,
  relayDataRoot,
  relayExtensionRoot,
  tokenFile: path.join(stateRoot, 'bridge-token.txt'),
  relayEnvFile: path.join(stateRoot, 'chatgpt-relay.env'),
}

for (const directory of [
  runtimeRoot,
  path.join(runtimeRoot, 'dsh-home'),
  profileRoot,
  stateRoot,
  path.join(runtimeRoot, 'logs'),
  relayDataRoot,
  relayExtensionRoot,
  path.join(runtimeRoot, 'agents'),
  path.join(runtimeRoot, 'memory'),
  path.join(runtimeRoot, 'chrome-profile'),
]) {
  await mkdir(directory, { recursive: true })
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function token(bytes) {
  return randomBytes(bytes).toString('base64url')
}

if (!await exists(paths.tokenFile)) await writeFile(paths.tokenFile, token(32), { mode: 0o600 })
await chmod(paths.tokenFile, 0o600)

if (!await exists(paths.relayEnvFile)) {
  const lines = [
    'HOST=127.0.0.1',
    `PORT=${relayPort}`,
    `PUBLIC_BASE_URL=http://127.0.0.1:${relayPort}`,
    `API_TOKEN=${token(48)}`,
    `BRIDGE_TOKEN=${token(48)}`,
    `DATA_DIR=${relayDataRoot}`,
    'AUTO_OPEN_TAB=1',
    'ANSWER_TIMEOUT_MS=1800000',
    'REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS=300000',
  ]
  await writeFile(paths.relayEnvFile, `${lines.join('\n')}\n`, { mode: 0o600 })
}
await chmod(paths.relayEnvFile, 0o600)

// The bridge's engine-facing peer, linked into the bridge's OWN node_modules.
//
// The profile links @shiro-ai/harness-bridge as a symlink to bridge/, and Node
// resolves a symlinked package's imports from its REAL path -- so
// `import '@deepseek-ai/dsh-tools'` inside bridge/src/container-tool.js is
// looked up under bridge/, never under the profile that linked it. The peer is
// declared optional and autoInstallPeers is off, so nothing installed it and
// BOTH `@shiro-ai/harness-bridge/container-tool` and `/git-tool` failed to load
// with ERR_MODULE_NOT_FOUND -- silently, because a preset row that cannot be
// imported takes the agent's container and git tools with it and says nothing.
async function linkBridgePeer() {
  const target = path.join(engineRoot, 'packages', 'core', 'tools')
  const scope = path.join(repoRoot, 'bridge', 'node_modules', '@deepseek-ai')
  const linkPath = path.join(scope, 'dsh-tools')
  await mkdir(scope, { recursive: true })
  // Relative, so the checkout stays movable.
  const relative = path.relative(scope, target)
  const current = await readlink(linkPath).catch(() => null)
  if (current === relative) return
  await rm(linkPath, { recursive: true, force: true })
  await symlink(relative, linkPath, 'dir')
}
await linkBridgePeer()

const link = value => `link:${value}`
const file = value => `file:${value}`
const profile = {
  name: 'shiro-profile-web',
  private: true,
  dependencies: {
    '@deepseek-ai/cordis': link(path.join(engineRoot, 'vendor', 'cordis')),
    '@deepseek-ai/schemastery': link(path.join(engineRoot, 'vendor', 'schemastery')),
    '@deepseek-ai/dsh-client-connection': link(path.join(engineRoot, 'packages', 'client', 'connection')),
    '@deepseek-ai/dsh-client-locale': link(path.join(engineRoot, 'packages', 'client', 'locale')),
    '@deepseek-ai/dsh-client-runtime': link(path.join(engineRoot, 'packages', 'client', 'runtime')),
    '@deepseek-ai/dsh-client-ui-layout': link(path.join(engineRoot, 'packages', 'client', 'ui-layout')),
    '@deepseek-ai/dsh-client-ui-settings': link(path.join(engineRoot, 'packages', 'client', 'ui-settings')),
    '@deepseek-ai/dsh-client-ui-settings-plugins': link(path.join(engineRoot, 'packages', 'client', 'ui-settings-plugins')),
    '@deepseek-ai/dsh-client-ui-sidebar': link(path.join(engineRoot, 'packages', 'client', 'ui-sidebar')),
    '@deepseek-ai/dsh-client-ui-slots': link(path.join(engineRoot, 'packages', 'client', 'ui-slots')),
    '@deepseek-ai/dsh-host-webserver': link(path.join(engineRoot, 'packages', 'host', 'webserver')),
    '@deepseek-ai/dsh-session': link(path.join(engineRoot, 'packages', 'core', 'session')),
    '@deepseek-ai/dsh-settings': link(path.join(engineRoot, 'packages', 'settings', 'settings')),
    '@deepseek-ai/dsh-subagent': link(path.join(engineRoot, 'packages', 'subagent', 'subagent')),
    '@deepseek-ai/dsh-tools': link(path.join(engineRoot, 'packages', 'core', 'tools')),
    '@shiro-ai/harness-bridge': link(path.join(repoRoot, 'bridge')),
    '@deepseek-ai/dsh-web-search-exa': link(path.join(engineRoot, 'packages', 'web', 'web-search-exa')),
    'dsh-client-auto-continue': file(path.join(repoRoot, 'plugins', 'auto-continue')),
    '@leetoners/dsh-ui-subagent-monitor': file(path.join(repoRoot, 'plugins', 'subagent-monitor')),
    '@shiro-ai/dsh-memory': link(path.join(repoRoot, 'plugins', 'memory')),
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@shiro-ai/harness-bridge',
        'dsh-client-auto-continue',
        '@leetoners/dsh-ui-subagent-monitor',
        '@shiro-ai/dsh-memory',
      ],
    },
  },
}

const manifestPath = path.join(profileRoot, 'package.json')
let existing = {}
try {
  existing = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch {
  // A missing or invalid generated manifest is safely rebuilt below.
}

const existingBundles = Array.isArray(existing?.dsh?.profile?.bundles)
  ? existing.dsh.profile.bundles
  : []
const merged = {
  ...existing,
  ...profile,
  dependencies: { ...(existing.dependencies || {}), ...profile.dependencies },
  dsh: {
    ...(existing.dsh || {}),
    ...profile.dsh,
    profile: {
      ...(existing?.dsh?.profile || {}),
      ...profile.dsh.profile,
      bundles: [...new Set([...profile.dsh.profile.bundles, ...existingBundles])],
    },
  },
}
await writeFile(manifestPath, `${JSON.stringify(merged, null, 2)}\n`)

for (const name of ['cordis.yml', 'cordis.patch.yml']) {
  const configPath = path.join(profileRoot, name)
  if (!await exists(configPath)) await writeFile(configPath, '[]\n')
}

// Optional engine plugins, mounted per machine. LSP needs language servers that
// are actually installed and Codex hooks need a config path the operator named
// and that resolves inside a trusted root, so the rows are GENERATED rather
// than statically declared-and-disabled: a row that cannot work is not written
// at all. The block is spliced into the profile patch layer, leaving anything
// hand-written in that file (for example a bridge pin) untouched.
const {
  discoverLanguageServers,
  mergeProfilePatch,
  renderOptionalPluginBlock,
  resolveHooksConfigPath,
} = await import(path.join(repoRoot, 'bridge', 'src', 'engine-plugins.js'))

const profilePatchPath = path.join(profileRoot, 'cordis.patch.yml')
let hooksConfigPath = ''
try {
  hooksConfigPath = resolveHooksConfigPath(process.env.SHIRO_HOOKS_CONFIG, {
    projectRoot: repoRoot,
    runtimeRoot,
  })
} catch (error) {
  // A bad hooks path disables hooks loudly; it never falls back to another
  // file and never stops the runtime from being prepared.
  process.stderr.write(`shiro: Codex hooks disabled: ${error.message}\n`)
}
const optionalBlock = renderOptionalPluginBlock({
  lspServers: discoverLanguageServers(),
  hooksConfigPath,
  model: process.env.SHIRO_RELAY_MODEL || 'GPT-5.6 Sol',
})
const existingPatch = await readFile(profilePatchPath, 'utf8').catch(() => '')
const mergedPatch = mergeProfilePatch(existingPatch, optionalBlock)
if (mergedPatch !== existingPatch) await writeFile(profilePatchPath, mergedPatch)

process.stdout.write(`${JSON.stringify(paths)}\n`)
