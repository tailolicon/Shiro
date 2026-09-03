import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

// Discovery for the engine plugins Shiro mounts conditionally.
//
// Two of the three optional engine plugins cannot be mounted unconditionally:
//
//   * dsh-lsp-stdio needs a NON-EMPTY table of language servers, each naming a
//     real executable. Mounting it with a server that is not installed would
//     fail at startup or spawn nothing; mounting it with an empty table is a
//     schema error. So the table is built from what this machine actually has.
//
//   * dsh-hooks-codex runs shell commands from a hooks.json on every tool call.
//     Loading one from an arbitrary path would be remote code execution by
//     configuration, so the path is opt-in AND has to resolve inside the
//     project root or the Shiro runtime directory.
//
// The logic lives here rather than inline in cordis.patch.yml so it can be
// unit-tested without booting an engine (the same split as session-root.js).

/**
 * Language servers Shiro knows how to configure, by executable. Each entry is
 * the dsh-lsp-stdio LspLocalServerConfig minus the defaults.
 */
export const KNOWN_LANGUAGE_SERVERS = Object.freeze({
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript',
      '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
    },
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
  },
  rust: {
    command: 'rust-analyzer',
    args: [],
    extensionToLanguage: { '.rs': 'rust' },
  },
  go: {
    command: 'gopls',
    args: ['serve'],
    extensionToLanguage: { '.go': 'go' },
  },
  clangd: {
    command: 'clangd',
    args: ['--background-index'],
    extensionToLanguage: { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp' },
  },
  bash: {
    command: 'bash-language-server',
    args: ['start'],
    extensionToLanguage: { '.sh': 'shellscript', '.bash': 'shellscript' },
  },
})

/** Default probe: is this executable on PATH? */
export function commandExists(command) {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Build the dsh-lsp-stdio servers table from the language servers present.
 * An empty result means the plugin must stay disabled: its config requires a
 * non-empty table, so mounting it anyway would fail at boot.
 */
export function discoverLanguageServers({ probe = commandExists, catalog = KNOWN_LANGUAGE_SERVERS } = {}) {
  const servers = {}
  for (const [id, entry] of Object.entries(catalog)) {
    if (!probe(entry.command)) continue
    servers[id] = { command: entry.command, args: [...entry.args], extensionToLanguage: { ...entry.extensionToLanguage } }
  }
  return servers
}

function isInside(parent, child) {
  return child === parent || child.startsWith(parent + sep)
}

/**
 * Decide whether a Codex hooks.json may be loaded.
 *
 * Hooks execute shell commands on tool-use seams, so this is the difference
 * between a config file and arbitrary code. The rule: the caller has to name a
 * path explicitly (no implicit discovery), it must be an existing regular file,
 * and it must live inside the project root or the Shiro runtime directory --
 * not, say, inside a repository that was just cloned by an agent.
 *
 * @returns the absolute trusted path, or '' when hooks must stay disabled.
 */
export function resolveHooksConfigPath(candidate, { projectRoot, runtimeRoot, isFile = defaultIsFile } = {}) {
  const raw = String(candidate ?? '').trim()
  if (raw === '') return ''
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error('resolveHooksConfigPath requires the project root')
  }
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw)
  const roots = [resolve(projectRoot), ...(typeof runtimeRoot === 'string' && runtimeRoot.trim() !== '' ? [resolve(runtimeRoot)] : [])]
  if (!roots.some(root => isInside(root, absolute))) {
    throw new Error(`hooks config ${absolute} is outside the project root and the Shiro runtime directory; hooks run shell commands, so an arbitrary path is not loaded`)
  }
  if (!isFile(absolute)) {
    throw new Error(`hooks config ${absolute} does not exist or is not a regular file`)
  }
  return absolute
}

function defaultIsFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Generated rows go into the PROFILE patch layer rather than the static bundle
// patch, for one reason: a row that cannot work must not exist at all.
// dsh-lsp-stdio requires a non-empty server table and dsh-hooks-codex requires
// a real configPath, so "mount it and disable it with an expression" would put
// an invalid row in front of a loader that fails the whole boot on an invalid
// field. Generating only the applicable rows removes the question.
export const GENERATED_BLOCK_START = '# >>> shiro-optional-plugins (generated by Prepare-Shiro-Runtime.mjs; edits are overwritten)'
export const GENERATED_BLOCK_END = '# <<< shiro-optional-plugins'

function yamlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * Render the profile-patch rows for whatever this machine can actually mount.
 * Returns '' when nothing applies, which means the block is removed entirely.
 */
export function renderOptionalPluginBlock({ lspServers = {}, hooksConfigPath = '', model = '' } = {}) {
  const rows = []
  if (Object.keys(lspServers).length > 0) {
    // JSON is valid YAML, so the server table is emitted as a JSON literal
    // rather than hand-serialized -- one less thing to get subtly wrong.
    rows.push('  - id: shiro-lsp')
    rows.push("    name: '@deepseek-ai/dsh-lsp'")
    rows.push('  - id: shiro-lsp-stdio')
    rows.push("    name: '@deepseek-ai/dsh-lsp-stdio'")
    rows.push('    config:')
    rows.push(`      servers: ${JSON.stringify(lspServers)}`)
    // The third row is the one that reaches the model. dsh-lsp provides the
    // capability and dsh-lsp-stdio speaks to the servers, but NEITHER
    // registers a tool -- without dsh-tool-lsp the provider is mounted and the
    // agent still has no `lsp` to call, which is exactly how this shipped.
    rows.push('  - id: shiro-tool-lsp')
    rows.push("    name: '@deepseek-ai/dsh-tool-lsp'")
  }
  if (hooksConfigPath !== '') {
    rows.push('  - id: shiro-hooks-codex')
    rows.push("    name: '@deepseek-ai/dsh-hooks-codex'")
    rows.push('    config:')
    rows.push(`      configPath: ${yamlString(hooksConfigPath)}`)
    if (model !== '') rows.push(`      model: ${yamlString(model)}`)
  }
  if (rows.length === 0) return ''
  return [GENERATED_BLOCK_START, '- insert:', ...rows, GENERATED_BLOCK_END].join('\n')
}

/**
 * Splice the generated block into an existing profile patch without touching
 * anything the operator wrote by hand -- the bridge pin lives in that file.
 */
export function mergeProfilePatch(existing, block) {
  const text = String(existing ?? '')
  const start = text.indexOf(GENERATED_BLOCK_START)
  const end = text.indexOf(GENERATED_BLOCK_END)
  let base = text
  if (start !== -1 && end !== -1 && end > start) {
    base = text.slice(0, start) + text.slice(end + GENERATED_BLOCK_END.length)
  }
  base = base.replace(/\n{3,}/g, '\n\n').trimEnd()
  if (block === '') return base === '' ? '' : `${base}\n`
  return base === '' ? `${block}\n` : `${base}\n${block}\n`
}
