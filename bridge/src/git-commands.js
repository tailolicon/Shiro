import { spawn } from 'node:child_process'
import { posix, win32 } from 'node:path'

// Pure, dependency-free core of the Git tool: git argv construction, path
// confinement, ref validation, approval-reason derivation, and the spawn
// runner. Kept separate from git-tool.js (which imports @deepseek-ai/dsh-tools)
// so this logic is unit-testable standalone, mirroring the
// container-path.js / container-tool.js split.
//
// Every git invocation is an ARGV ARRAY passed to spawn() with no shell, so a
// model argument can never become a shell metacharacter or a second command --
// the injection class that failed the audited third-party dsh-gitflow plugin.

export const MAX_OUTPUT = 256 * 1024
export const MAX_LOG_COUNT = 200
export const DEFAULT_LOG_COUNT = 20

/** Reject a branch/ref token git could read as an option or that breaks ref rules. */
export function assertSafeRef(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  const name = value.trim()
  if (name.startsWith('-')) throw new Error(`${label} must not start with "-"`)
  if (/[\s~^:?*\[\\]/.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) {
    throw new Error(`${label} contains characters that are not allowed in a git ref: ${value}`)
  }
  if (name.length > 255) throw new Error(`${label} is too long`)
  return name
}

/** Resolve a model-supplied path and confine it inside the workspace, returned git-relative with forward slashes. */
export function confinePath(workspaceRoot, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('path must be a non-empty string')
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) throw new Error(`path escapes the workspace root: ${value}`)
  const pathApi = win32.isAbsolute(workspaceRoot) ? win32 : posix
  const resolved = pathApi.resolve(workspaceRoot, value)
  const rel = pathApi.relative(workspaceRoot, resolved)
  if (rel === '') return '.'
  if (rel === '..' || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) {
    throw new Error(`path escapes the workspace root: ${value}`)
  }
  return rel.split(pathApi.sep).join('/')
}

/** Every git tool spec: schema, argv builder (args, workspaceRoot) -> {argv, stdin?}, presentation, and mutation flag. */
export const GIT_TOOLS = [
  {
    name: 'git_status',
    mutating: false,
    description: 'Show the working tree status (porcelain short format with branch and all untracked files). Read-only.',
    parameters: {},
    build: () => ({ argv: ['status', '--short', '--branch', '--untracked-files=all'] }),
    presentTitle: () => 'git status',
  },
  {
    name: 'git_diff',
    mutating: false,
    description: 'Show changes as a unified diff. Read-only. By default shows unstaged working-tree changes; set staged=true for the index. Optionally limit to one path inside the project.',
    parameters: {
      staged: { type: 'boolean', description: 'Diff the staged index against HEAD instead of the working tree.' },
      path: { type: 'string', description: 'Optional path inside the project to limit the diff to.' },
    },
    build: (args, workspaceRoot) => {
      const argv = ['diff', '--no-ext-diff', '--no-color']
      if (args.staged === true) argv.push('--cached')
      if (args.path !== undefined && args.path !== null && args.path !== '') argv.push('--', confinePath(workspaceRoot, args.path))
      return { argv }
    },
    presentTitle: args => `git diff${args.staged ? ' --cached' : ''}${args.path ? ` -- ${args.path}` : ''}`,
  },
  {
    name: 'git_log',
    mutating: false,
    description: `Show recent commit history (hash, author, date, subject). Read-only. count defaults to ${DEFAULT_LOG_COUNT}, max ${MAX_LOG_COUNT}. Optionally limit to one path inside the project.`,
    parameters: {
      count: { type: 'number', description: `Number of commits to show (1-${MAX_LOG_COUNT}, default ${DEFAULT_LOG_COUNT}).` },
      path: { type: 'string', description: 'Optional path inside the project to limit history to.' },
    },
    build: (args, workspaceRoot) => {
      let count = args.count ?? DEFAULT_LOG_COUNT
      if (!Number.isInteger(count) || count < 1) count = DEFAULT_LOG_COUNT
      if (count > MAX_LOG_COUNT) count = MAX_LOG_COUNT
      const argv = ['log', `--max-count=${count}`, '--no-color', '--format=%h  %an  %ad  %s', '--date=short']
      if (args.path !== undefined && args.path !== null && args.path !== '') argv.push('--', confinePath(workspaceRoot, args.path))
      return { argv }
    },
    presentTitle: args => `git log -n ${args.count ?? DEFAULT_LOG_COUNT}${args.path ? ` -- ${args.path}` : ''}`,
  },
  {
    name: 'git_show',
    mutating: false,
    description: 'Show a commit or object (metadata + diff, no external diff tool). Read-only. ref defaults to HEAD.',
    parameters: {
      ref: { type: 'string', description: 'Commit-ish / object to show (e.g. HEAD, a branch, or a hash). Defaults to HEAD.' },
    },
    build: (args) => {
      const ref = args.ref === undefined || args.ref === null || args.ref === '' ? 'HEAD' : assertSafeRef(args.ref, 'ref')
      return { argv: ['show', '--no-ext-diff', '--no-color', ref] }
    },
    presentTitle: args => `git show ${args.ref ?? 'HEAD'}`,
  },
  {
    name: 'git_branch',
    mutating: false, // list is read-only; create/switch mutate and are gated via gateReason
    description: 'List branches (action="list", read-only, default), or create+switch (action="create") or switch (action="switch"). Create/switch require approval. Never deletes branches.',
    parameters: {
      action: { type: 'string', description: 'One of "list" (default), "create", "switch".' },
      name: { type: 'string', description: 'Branch name for create/switch.' },
    },
    build: (args) => {
      const action = args.action ?? 'list'
      if (action === 'list') return { argv: ['branch', '--list', '--no-color', '-vv'] }
      const name = assertSafeRef(args.name, 'name')
      if (action === 'create') return { argv: ['switch', '--create', name] }
      if (action === 'switch') return { argv: ['switch', name] }
      throw new Error('action must be "list", "create", or "switch"')
    },
    presentTitle: (args) => {
      const action = args.action ?? 'list'
      if (action === 'list') return 'git branch --list'
      return `git switch${action === 'create' ? ' --create' : ''} ${args.name ?? ''}`.trim()
    },
  },
  {
    name: 'git_add',
    mutating: true,
    description: 'Stage one or more paths for the next commit. Requires approval. Paths are confined to the session workspace root. Does not reset or discard anything.',
    parameters: {
      paths: { type: 'array', items: { type: 'string' }, required: true, description: 'Project-relative paths to stage.' },
    },
    build: (args, workspaceRoot) => {
      if (!Array.isArray(args.paths) || args.paths.length === 0) throw new Error('paths must be a non-empty array')
      return { argv: ['add', '--', ...args.paths.map(p => confinePath(workspaceRoot, p))] }
    },
    presentTitle: args => `git add ${Array.isArray(args.paths) ? args.paths.join(' ') : ''}`.trim(),
  },
  {
    name: 'git_commit',
    mutating: true,
    description: 'Create a commit from the staged changes. Requires approval. The message is passed via stdin (never the shell). Set all=true to also stage tracked modifications (like git commit -a); untracked files are never added. Never pushes.',
    parameters: {
      message: { type: 'string', required: true, description: 'Commit message.' },
      all: { type: 'boolean', description: 'Stage tracked (already-known) modified files before committing, like git commit -a.' },
    },
    build: (args) => {
      if (typeof args.message !== 'string' || args.message.trim() === '') throw new Error('message is required')
      const argv = ['commit']
      if (args.all === true) argv.push('-a')
      argv.push('--file=-')
      return { argv, stdin: args.message.endsWith('\n') ? args.message : `${args.message}\n` }
    },
    presentTitle: args => `git commit${args.all ? ' -a' : ''} -m ${JSON.stringify(String(args.message ?? '').split('\n')[0])}`,
  },
]

/** Human-readable approval reason for a mutating call, or undefined when the call is read-only. */
export function gateReason(name, args = {}) {
  if (name === 'git_add') {
    const paths = Array.isArray(args.paths) ? args.paths : []
    return `Stage ${paths.length} path(s) for commit: ${paths.join(', ')}`
  }
  if (name === 'git_commit') return `Create a git commit${args.all ? ' (staging tracked modifications first)' : ''}`
  if (name === 'git_branch') {
    const action = args.action ?? 'list'
    if (action === 'create') return `Create and switch to branch "${args.name}"`
    if (action === 'switch') return `Switch to branch "${args.name}"`
  }
  return undefined
}

function boundedString(parts, length) {
  return { text: Buffer.concat(parts).toString('utf8'), truncated: length >= MAX_OUTPUT }
}

/** Run one git invocation with an argv array (never a shell string). Rejects only on spawn failure. */
export function runGit(workspaceRoot, args, { stdin, signal, env, confinement, confinementRoot } = {}) {
  // Confinement is OPTIONAL here and applied by the caller, not assumed: git's
  // argv is always built by Shiro (never free-form model text), and some git
  // work legitimately writes outside the calling workspace -- worktree_create
  // puts a checkout in a sibling directory the operator allowlisted. A caller
  // that wants the boundary passes it, and says which root it applies to.
  const plan = confinement === undefined || confinement === null
    ? { argv: ['git', ...args] }
    : { argv: confinement.confine(['git', ...args], { workspaceRoot: confinementRoot ?? workspaceRoot }).argv }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(plan.argv[0], plan.argv.slice(1), {
      cwd: workspaceRoot,
      windowsHide: true,
      shell: false,
      // Overlaid, never replaced: git needs the ambient HOME/PATH to find the
      // user's config and credential helpers. Snapshotting overlays only
      // GIT_INDEX_FILE so a scratch index can be built without touching the
      // real one.
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const out = { parts: [], length: 0 }
    const err = { parts: [], length: 0 }
    const collect = state => chunk => {
      const remaining = MAX_OUTPUT - state.length
      if (remaining <= 0) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      state.parts.push(buf.subarray(0, remaining))
      state.length += Math.min(buf.length, remaining)
    }
    child.stdout.on('data', collect(out))
    child.stderr.on('data', collect(err))

    let settled = false
    const onAbort = () => { if (!settled) child.kill() }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', error => {
      settled = true
      signal?.removeEventListener('abort', onAbort)
      rejectRun(error)
    })
    child.once('close', code => {
      settled = true
      signal?.removeEventListener('abort', onAbort)
      const stdout = boundedString(out.parts, out.length)
      const stderr = boundedString(err.parts, err.length)
      resolveRun({ exitCode: code, stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated })
    })
    if (stdin !== undefined) child.stdin.end(stdin)
  })
}
