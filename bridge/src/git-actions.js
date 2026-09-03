import { ActionError, asActionError, fail, requireConfirmation } from './action-errors.js'
import { assertSafeRef, confinePath, runGit } from './git-commands.js'
import { redactSecrets } from './redact.js'

// Typed local git actions for the Shiro connector.
//
// These are the deterministic replacement for "ask Harness to check git": the
// engine's own git tools (git-tool.js) stay in place for agent turns, but a
// client that just wants the branch, the diff or a commit no longer pays for a
// model round-trip. Every invocation reuses runGit() from git-commands.js, so
// the argv-array-never-a-shell-string rule and the path confinement are shared
// with the engine-side tools rather than reimplemented.
//
// Outward-facing or history-rewriting operations (push, reset --hard, restore,
// rebase) additionally require an explicit confirm=true, mirroring the approval
// gate that git-tool.js routes through ctx.get('approval').

export const GIT_LIMITS = Object.freeze({
  diff_max_bytes: 200_000,
  log_max_count: 200,
  log_default_count: 20,
  status_max_changes: 500,
  branch_max: 500,
  tag_max: 500,
  commit_message_max: 20_000,
})

// Unit/record separators keep the parser independent of anything that can
// appear inside a commit subject, an author name or a path.
const UNIT = '\x1f'
const RECORD = '\x1e'
const LOG_FORMAT = '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1e'

function gitError(argv, result) {
  const stderr = (result.stderr || result.stdout || '').trim()
  const lowered = stderr.toLowerCase()
  const summary = stderr === '' ? `git ${argv[0]} failed with exit code ${result.exitCode}` : stderr
  if (lowered.includes('not a git repository')) {
    return new ActionError('UNSUPPORTED', `${summary}. The fixed project root is not a git repository.`)
  }
  if (lowered.includes('conflict') || lowered.includes('needs merge') || lowered.includes('unmerged')) {
    return new ActionError('GIT_CONFLICT', summary)
  }
  if (lowered.includes('authentication failed') || lowered.includes('permission denied') || lowered.includes('could not read username')) {
    return new ActionError('PERMISSION_REQUIRED', `${summary}. Remote credentials come from the host git configuration; the connector never prompts for or stores them.`)
  }
  if (lowered.includes('could not resolve host') || lowered.includes('failed to connect') || lowered.includes('connection timed out')) {
    return new ActionError('TIMEOUT', summary, { retryable: true })
  }
  if (lowered.includes('would be overwritten') || lowered.includes('local changes') || lowered.includes('non-fast-forward') || lowered.includes('behind its remote') || lowered.includes('not possible to fast-forward')) {
    return new ActionError('CONFLICT', summary)
  }
  if (lowered.includes('already exists')) {
    return new ActionError('ALREADY_EXISTS', summary)
  }
  if (lowered.includes('did not match any file') || lowered.includes('unknown revision') || lowered.includes('not a valid object name') || lowered.includes('does not exist') || lowered.includes('invalid reference') || lowered.includes('pathspec')) {
    return new ActionError('NOT_FOUND', summary)
  }
  return new ActionError('PROCESS_FAILED', summary)
}

export async function git(root, argv, { stdin, signal, allowFailure = false, env, confinement, confinementRoot } = {}) {
  let result
  try {
    result = await runGit(root, argv, { stdin, signal, env, confinement, confinementRoot })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ActionError('UNSUPPORTED', 'git is not installed on this host')
    throw asActionError(error, 'PROCESS_FAILED', 'git')
  }
  if (!allowFailure && result.exitCode !== 0) throw gitError(argv, result)
  return result
}

/** Resolve the repo working directory: the fixed root by default, else a directory inside it. */
export async function repoRoot(sandbox, requested) {
  if (requested === undefined || requested === null || requested === '' || requested === '.') return sandbox.root
  const target = await sandbox.resolveDirectory(requested)
  return target.absolute
}

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

function confineAll(root, paths, label) {
  if (paths === undefined || paths === null) return []
  const list = Array.isArray(paths) ? paths : [paths]
  if (list.length > 100) fail('INVALID_ARGUMENT', `${label} accepts at most 100 paths`)
  return list.map(value => {
    try {
      return confinePath(root, value)
    } catch (error) {
      throw new ActionError('OUTSIDE_SANDBOX', error.message)
    }
  })
}

/** Strict ref-NAME rules (git-commands.js), used where a ref is being created. */
function safeRef(value, label) {
  try {
    return assertSafeRef(value, label)
  } catch (error) {
    throw new ActionError('INVALID_ARGUMENT', error.message)
  }
}

// A revision the caller only reads from may use git's ancestry syntax
// (HEAD~1, main^2, @{upstream}), which the branch-name rules deliberately
// reject. Every git call is still an argv array with shell:false, so the only
// real hazard is a value git would read as an option, or a range that would
// silently change what the command means -- both are refused here.
const REVISION = /^[A-Za-z0-9._/~^@{}+-]+$/

function safeRevision(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new ActionError('INVALID_ARGUMENT', `${label} is required`)
  const name = value.trim()
  if (name.startsWith('-')) throw new ActionError('INVALID_ARGUMENT', `${label} must not start with "-"`)
  if (name.includes('..')) throw new ActionError('INVALID_ARGUMENT', `${label} must name one revision, not a range`)
  if (name.length > 255) throw new ActionError('INVALID_ARGUMENT', `${label} is too long`)
  if (!REVISION.test(name)) throw new ActionError('INVALID_ARGUMENT', `${label} contains characters that are not allowed in a git revision: ${value}`)
  return name
}

function optionalRevision(value, label) {
  return value === undefined || value === null || value === '' ? undefined : safeRevision(value, label)
}

function boundText(text, limit) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

function parseNumstat(raw) {
  return raw.split('\n').filter(line => line !== '').map(line => {
    const [added, deleted, path] = line.split('\t')
    return {
      path,
      additions: added === '-' ? undefined : Number.parseInt(added, 10),
      deletions: deleted === '-' ? undefined : Number.parseInt(deleted, 10),
      binary: added === '-',
    }
  })
}

function totals(files) {
  return {
    files_changed: files.length,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  }
}

function parseCommits(raw) {
  return raw.split(RECORD).map(record => record.replace(/^\n+/, '')).filter(record => record.trim() !== '').map(record => {
    const [sha, shortSha, author, email, authoredAt, committedAt, subject] = record.split(UNIT)
    return { sha, short_sha: shortSha, author, author_email: email, authored_at: authoredAt, committed_at: committedAt, subject }
  })
}

const STATUS_LETTER = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed', U: 'unmerged',
}

function describeChange(index, worktree) {
  if (index !== '.' && index !== ' ') return STATUS_LETTER[index] ?? 'modified'
  return STATUS_LETTER[worktree] ?? 'modified'
}

/** git_status: normalized porcelain-v2 working-tree state. */
export async function status(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const limit = clampInteger(args.limit, { min: 1, max: GIT_LIMITS.status_max_changes, fallback: GIT_LIMITS.status_max_changes, label: 'limit' })
  const argv = ['status', '--porcelain=v2', '--branch', '-z']
  argv.push(args.untracked === false ? '--untracked-files=no' : '--untracked-files=all')
  if (args.include_ignored === true) argv.push('--ignored=matching')
  const result = await git(root, argv, options)
  const tokens = result.stdout.split('\0')
  const state = { branch: undefined, head: undefined, upstream: undefined, ahead: 0, behind: 0, detached: false }
  const changes = []
  const counts = { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, ignored: 0 }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '') continue
    if (token.startsWith('# branch.oid ')) { state.head = token.slice(13); continue }
    if (token.startsWith('# branch.head ')) {
      const head = token.slice(14)
      state.detached = head === '(detached)'
      state.branch = state.detached ? undefined : head
      continue
    }
    if (token.startsWith('# branch.upstream ')) { state.upstream = token.slice(18); continue }
    if (token.startsWith('# branch.ab ')) {
      const [ahead, behind] = token.slice(12).split(' ')
      state.ahead = Number.parseInt(ahead, 10) || 0
      state.behind = Math.abs(Number.parseInt(behind, 10) || 0)
      continue
    }
    if (token.startsWith('# ')) continue
    const kind = token[0]
    if (kind === '?') {
      counts.untracked += 1
      changes.push({ path: token.slice(2), status: 'untracked', staged: false, unstaged: true, index_status: '?', worktree_status: '?' })
      continue
    }
    if (kind === '!') {
      counts.ignored += 1
      changes.push({ path: token.slice(2), status: 'ignored', staged: false, unstaged: false, index_status: '!', worktree_status: '!' })
      continue
    }
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue
    const fields = token.split(' ')
    const xy = fields[1] ?? '..'
    const indexStatus = xy[0]
    const worktreeStatus = xy[1]
    // Porcelain v2 keeps the path as the final field of the record; a rename or
    // copy record is followed by its original path as a separate NUL token.
    const pathFieldStart = kind === 'u' ? 10 : (kind === '2' ? 9 : 8)
    const path = fields.slice(pathFieldStart).join(' ')
    let origPath
    if (kind === '2') {
      index += 1
      origPath = tokens[index]
    }
    const staged = kind !== 'u' && indexStatus !== '.'
    const unstaged = kind === 'u' || worktreeStatus !== '.'
    if (kind === 'u') counts.unmerged += 1
    else {
      if (staged) counts.staged += 1
      if (unstaged) counts.unstaged += 1
    }
    changes.push({
      path,
      orig_path: origPath,
      status: kind === 'u' ? 'unmerged' : describeChange(indexStatus, worktreeStatus),
      staged,
      unstaged,
      index_status: indexStatus,
      worktree_status: worktreeStatus,
    })
  }
  const page = changes.slice(0, limit)
  return {
    branch: state.branch,
    head: state.head,
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    detached: state.detached,
    clean: changes.filter(change => change.status !== 'ignored').length === 0,
    counts,
    changes: page,
    total_changes: changes.length,
    truncated: page.length < changes.length,
  }
}

/** git_remote_list: remotes with credentials stripped from their URLs. */
export async function remoteList(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const result = await git(root, ['remote', '--verbose'], { ...options, allowFailure: true })
  if (result.exitCode !== 0) throw gitError(['remote'], result)
  const remotes = new Map()
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue
    const [name, rest] = line.split('\t')
    if (rest === undefined) continue
    const [url, kind] = rest.split(' ')
    const entry = remotes.get(name) ?? { name }
    // Redaction is mandatory here: a remote URL is one of the few places a real
    // credential is routinely embedded (https://user:token@host/repo.git).
    if (kind === '(push)') entry.push_url = redactSecrets(url)
    else entry.fetch_url = redactSecrets(url)
    remotes.set(name, entry)
  }
  return { remotes: [...remotes.values()] }
}

/** git_repo_info: root, HEAD, dirty flag and credential-redacted remotes. */
export async function repoInfo(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], { ...options, allowFailure: true })
  if (inside.exitCode !== 0) throw gitError(['rev-parse'], inside)
  const top = await git(root, ['rev-parse', '--show-toplevel'], options)
  const head = await git(root, ['rev-parse', 'HEAD'], { ...options, allowFailure: true })
  const state = await status(sandbox, { path: args.path, limit: 1 }, options)
  const remotes = await remoteList(sandbox, { path: args.path }, options)
  return {
    is_repository: true,
    root: sandbox.relative(top.stdout.trim()),
    branch: state.branch,
    detached: state.detached,
    head: head.exitCode === 0 ? head.stdout.trim() : undefined,
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    dirty: !state.clean,
    changed_files: state.total_changes,
    remotes: remotes.remotes,
  }
}

/** git_diff: bounded unified diff plus per-file line stats. */
export async function diff(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const maxBytes = clampInteger(args.max_bytes, { min: 1000, max: GIT_LIMITS.diff_max_bytes, fallback: GIT_LIMITS.diff_max_bytes, label: 'max_bytes' })
  const contextLines = clampInteger(args.context_lines, { min: 0, max: 20, fallback: 3, label: 'context_lines' })
  const base = optionalRevision(args.base, 'base')
  const head = optionalRevision(args.head, 'head')
  if (head !== undefined && base === undefined) fail('INVALID_ARGUMENT', 'head requires base')
  const paths = confineAll(root, args.paths, 'paths')
  const range = []
  if (base !== undefined) range.push(base)
  if (head !== undefined) range.push(head)

  const common = ['--no-ext-diff', '--no-color']
  const staged = args.staged === true && base === undefined
  if (staged) common.push('--cached')
  const pathArgs = paths.length === 0 ? [] : ['--', ...paths]
  const numstat = await git(root, ['diff', ...common, '--numstat', ...range, ...pathArgs], options)
  const files = parseNumstat(numstat.stdout)
  const payload = { base, head, staged, files, ...totals(files) }
  if (args.stat_only === true) return { ...payload, truncated: false }
  const patch = await git(root, ['diff', ...common, `--unified=${contextLines}`, ...range, ...pathArgs], options)
  const bounded = boundText(patch.stdout, maxBytes)
  return {
    ...payload,
    patch: bounded.text,
    patch_bytes: patch.stdout.length,
    truncated: bounded.truncated || patch.truncated,
    max_bytes: maxBytes,
  }
}

/** git_log: normalized commit summaries with limit/skip paging. */
export async function log(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const limit = clampInteger(args.limit, { min: 1, max: GIT_LIMITS.log_max_count, fallback: GIT_LIMITS.log_default_count, label: 'limit' })
  const skip = clampInteger(args.skip, { min: 0, max: 100_000, fallback: 0, label: 'skip' })
  const ref = optionalRevision(args.ref, 'ref')
  const paths = confineAll(root, args.paths, 'paths')
  const argv = ['log', `--max-count=${limit + 1}`, `--skip=${skip}`, '--no-color', LOG_FORMAT]
  if (args.author !== undefined) {
    if (typeof args.author !== 'string' || args.author.startsWith('-')) fail('INVALID_ARGUMENT', 'author must be a plain string')
    argv.push(`--author=${args.author}`)
  }
  if (ref !== undefined) argv.push(ref)
  if (paths.length > 0) argv.push('--', ...paths)
  const result = await git(root, argv, { ...options, allowFailure: true })
  if (result.exitCode !== 0) {
    // A repository with no commits yet has no HEAD; that is a normal state.
    if ((result.stderr || '').includes('does not have any commits yet')) {
      return { ref, commits: [], returned: 0, skip, truncated: false }
    }
    throw gitError(argv, result)
  }
  const commits = parseCommits(result.stdout)
  const page = commits.slice(0, limit)
  return {
    ref,
    commits: page,
    returned: page.length,
    skip,
    truncated: commits.length > limit,
    next_skip: commits.length > limit ? skip + limit : undefined,
  }
}

/** git_show: one commit's metadata plus a bounded diff. */
export async function show(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const ref = args.ref === undefined || args.ref === '' ? 'HEAD' : safeRevision(args.ref, 'ref')
  const maxBytes = clampInteger(args.max_bytes, { min: 1000, max: GIT_LIMITS.diff_max_bytes, fallback: GIT_LIMITS.diff_max_bytes, label: 'max_bytes' })
  const meta = await git(root, ['show', '--no-patch', '--no-color', LOG_FORMAT, ref], options)
  const numstat = await git(root, ['show', '--no-ext-diff', '--no-color', '--numstat', '--format=', ref], options)
  const files = parseNumstat(numstat.stdout)
  const payload = { ref, commit: parseCommits(meta.stdout)[0], files, ...totals(files) }
  if (args.include_patch === false) return { ...payload, truncated: false }
  const patch = await git(root, ['show', '--no-ext-diff', '--no-color', '--format=', ref], options)
  const bounded = boundText(patch.stdout, maxBytes)
  return { ...payload, patch: bounded.text, patch_bytes: patch.stdout.length, truncated: bounded.truncated || patch.truncated }
}

/** git_branch_list: local and optionally remote branches with upstream info. */
export async function branchList(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const limit = clampInteger(args.limit, { min: 1, max: GIT_LIMITS.branch_max, fallback: 100, label: 'limit' })
  const refs = ['refs/heads']
  if (args.include_remote === true) refs.push('refs/remotes')
  const format = '--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(HEAD)%1f%(committerdate:iso-strict)%1f%(contents:subject)'
  const result = await git(root, ['for-each-ref', '--sort=-committerdate', format, ...refs], options)
  const branches = result.stdout.split('\n').filter(line => line !== '').map(line => {
    const [fullRef, name, sha, upstream, headMark, committedAt, subject] = line.split(UNIT)
    return {
      name,
      sha,
      upstream: upstream === '' ? undefined : upstream,
      current: headMark === '*',
      remote: fullRef.startsWith('refs/remotes/'),
      committed_at: committedAt,
      subject,
    }
  })
  const page = branches.slice(0, limit)
  return {
    branches: page,
    current: branches.find(branch => branch.current)?.name,
    total: branches.length,
    truncated: page.length < branches.length,
  }
}

/** git_branch_create: create a branch, optionally switching to it. */
export async function branchCreate(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const name = safeRef(args.name, 'name')
  const startPoint = optionalRevision(args.start_point, 'start_point')
  const existing = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { ...options, allowFailure: true })
  if (existing.exitCode === 0) {
    // Creating a branch that already points somewhere is a conflict, but
    // "create and switch to it" is idempotent when the branch already exists.
    if (args.checkout === true) {
      await git(root, ['switch', name], options)
      return { name, created: false, checked_out: true, sha: existing.stdout.trim() }
    }
    fail('ALREADY_EXISTS', `branch already exists: ${name}`)
  }
  const argv = args.checkout === true ? ['switch', '--create', name] : ['branch', name]
  if (startPoint !== undefined) argv.push(startPoint)
  await git(root, argv, options)
  const sha = await git(root, ['rev-parse', `refs/heads/${name}`], options)
  return { name, created: true, checked_out: args.checkout === true, start_point: startPoint, sha: sha.stdout.trim() }
}

/** git_checkout: switch to an existing branch or detach onto a commit. */
export async function checkout(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const ref = safeRevision(args.ref, 'ref')
  const argv = args.detach === true ? ['switch', '--detach', ref] : ['switch', ref]
  const result = await git(root, argv, { ...options, allowFailure: true })
  if (result.exitCode !== 0) throw gitError(argv, result)
  const state = await status(sandbox, { path: args.path, limit: 1 }, options)
  return { ref, branch: state.branch, detached: state.detached, head: state.head, dirty: !state.clean }
}

/** git_add: stage explicit paths; staging everything must be asked for by name. */
export async function add(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const paths = confineAll(root, args.paths, 'paths')
  if (paths.length === 0 && args.all !== true) {
    fail('INVALID_ARGUMENT', 'paths is required; pass all=true only when the user asked to stage every change')
  }
  const argv = paths.length === 0 ? ['add', '--all'] : ['add', '--', ...paths]
  await git(root, argv, options)
  const state = await status(sandbox, { path: args.path }, options)
  return { staged_paths: paths, all: paths.length === 0, staged: state.counts.staged, unstaged: state.counts.unstaged, untracked: state.counts.untracked }
}

/** git_commit: commit staged work; expected_head gives optimistic concurrency. */
export async function commit(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (message === '') fail('INVALID_ARGUMENT', 'message is required')
  if (message.length > GIT_LIMITS.commit_message_max) fail('INVALID_ARGUMENT', `message is longer than ${GIT_LIMITS.commit_message_max} characters`)
  if (args.expected_head !== undefined) {
    const head = await git(root, ['rev-parse', 'HEAD'], { ...options, allowFailure: true })
    const current = head.exitCode === 0 ? head.stdout.trim() : ''
    if (current === '' || !current.startsWith(String(args.expected_head).trim())) {
      fail('CONFLICT', `HEAD moved: expected_head ${args.expected_head} but HEAD is ${current || '(no commits)'}`)
    }
  }
  const argv = ['commit']
  if (args.all === true) argv.push('--all')
  if (args.allow_empty === true) argv.push('--allow-empty')
  argv.push('--file=-')
  const result = await git(root, argv, { ...options, stdin: message.endsWith('\n') ? message : `${message}\n`, allowFailure: true })
  if (result.exitCode !== 0) {
    if (`${result.stdout}${result.stderr}`.includes('nothing to commit')) {
      fail('CONFLICT', 'nothing to commit: stage changes with git_add first, or pass allow_empty=true')
    }
    throw gitError(argv, result)
  }
  const sha = await git(root, ['rev-parse', 'HEAD'], options)
  const summary = await git(root, ['show', '--no-patch', '--no-color', LOG_FORMAT, 'HEAD'], options)
  return { committed: true, sha: sha.stdout.trim(), commit: parseCommits(summary.stdout)[0], all: args.all === true }
}

/** git_restore: discard changes for explicit paths. Destructive; needs confirm. */
export async function restore(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const paths = confineAll(root, args.paths, 'paths')
  if (paths.length === 0) fail('INVALID_ARGUMENT', 'paths is required; git_restore never restores the whole tree implicitly')
  const mode = args.mode ?? 'worktree'
  if (!['worktree', 'staged', 'both'].includes(mode)) fail('INVALID_ARGUMENT', 'mode must be worktree, staged, or both')
  const source = optionalRevision(args.source, 'source')
  requireConfirmation(args.confirm, `Discard ${mode === 'staged' ? 'staged' : 'local'} changes in ${paths.length} path(s): ${paths.join(', ')}`)
  const argv = ['restore']
  if (mode === 'staged' || mode === 'both') argv.push('--staged')
  if (mode === 'worktree' || mode === 'both') argv.push('--worktree')
  if (source !== undefined) argv.push(`--source=${source}`)
  argv.push('--', ...paths)
  await git(root, argv, options)
  const state = await status(sandbox, { path: args.path }, options)
  return { restored_paths: paths, mode, source, clean: state.clean, counts: state.counts }
}

/** git_reset: move HEAD/index; --hard discards work and needs confirm. */
export async function reset(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const mode = args.mode ?? 'mixed'
  if (!['soft', 'mixed', 'hard'].includes(mode)) fail('INVALID_ARGUMENT', 'mode must be soft, mixed, or hard')
  const ref = optionalRevision(args.ref, 'ref') ?? 'HEAD'
  if (mode === 'hard') {
    requireConfirmation(args.confirm, `Run git reset --hard ${ref}, permanently discarding every uncommitted change in the working tree`)
  }
  const before = await git(root, ['rev-parse', 'HEAD'], { ...options, allowFailure: true })
  await git(root, ['reset', `--${mode}`, ref], options)
  const after = await git(root, ['rev-parse', 'HEAD'], { ...options, allowFailure: true })
  const state = await status(sandbox, { path: args.path }, options)
  return {
    mode,
    ref,
    previous_head: before.exitCode === 0 ? before.stdout.trim() : undefined,
    head: after.exitCode === 0 ? after.stdout.trim() : undefined,
    clean: state.clean,
    counts: state.counts,
  }
}

async function conflictedPaths(root, options) {
  const result = await git(root, ['diff', '--name-only', '--diff-filter=U'], { ...options, allowFailure: true })
  return result.stdout.split('\n').filter(line => line !== '')
}

/** git_merge: merge one ref, reporting conflicts as GIT_CONFLICT. */
export async function merge(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  if (args.action === 'abort') {
    const aborted = await git(root, ['merge', '--abort'], { ...options, allowFailure: true })
    if (aborted.exitCode !== 0) fail('CONFLICT', (aborted.stderr || 'there is no merge in progress to abort').trim())
    return { action: 'abort', aborted: true }
  }
  const ref = safeRevision(args.ref, 'ref')
  const fastForward = args.fast_forward ?? 'auto'
  if (!['auto', 'only', 'never'].includes(fastForward)) fail('INVALID_ARGUMENT', 'fast_forward must be auto, only, or never')
  const argv = ['merge', '--no-edit']
  if (fastForward === 'only') argv.push('--ff-only')
  if (fastForward === 'never') argv.push('--no-ff')
  argv.push(ref)
  const result = await git(root, argv, { ...options, allowFailure: true })
  if (result.exitCode !== 0) {
    const conflicts = await conflictedPaths(root, options)
    if (conflicts.length > 0) {
      throw new ActionError('GIT_CONFLICT', `merge of ${ref} left ${conflicts.length} conflicted path(s): ${conflicts.join(', ')}. Resolve them with fs_update_file plus git_add and then git_commit, or call git_merge with action=abort.`, { details: { conflicts } })
    }
    throw gitError(argv, result)
  }
  const head = await git(root, ['rev-parse', 'HEAD'], options)
  return { action: 'merge', merged: true, ref, fast_forward: fastForward, head: head.stdout.trim(), output: result.stdout.trim() }
}

/** git_rebase: start/continue/skip/abort a rebase. Rewrites history; needs confirm. */
export async function rebase(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const action = args.action ?? 'start'
  if (!['start', 'continue', 'abort', 'skip'].includes(action)) fail('INVALID_ARGUMENT', 'action must be start, continue, abort, or skip')
  if (action === 'abort') {
    const aborted = await git(root, ['rebase', '--abort'], { ...options, allowFailure: true })
    if (aborted.exitCode !== 0) fail('CONFLICT', (aborted.stderr || 'there is no rebase in progress to abort').trim())
    return { action, aborted: true }
  }
  let argv
  if (action === 'start') {
    const onto = safeRevision(args.onto, 'onto')
    requireConfirmation(args.confirm, `Rebase the current branch onto ${onto}, rewriting local commit history`)
    argv = ['rebase', onto]
  } else {
    argv = ['rebase', `--${action}`]
  }
  const result = await git(root, argv, { ...options, allowFailure: true })
  if (result.exitCode !== 0) {
    const conflicts = await conflictedPaths(root, options)
    if (conflicts.length > 0) {
      throw new ActionError('GIT_CONFLICT', `rebase stopped on ${conflicts.length} conflicted path(s): ${conflicts.join(', ')}. Resolve them, stage them with git_add, then call git_rebase with action=continue, or action=abort to undo.`, { details: { conflicts } })
    }
    throw gitError(argv, result)
  }
  const head = await git(root, ['rev-parse', 'HEAD'], options)
  return { action, rebased: true, head: head.stdout.trim(), output: result.stdout.trim() }
}

/** git_tag_list: newest-first tags with their target commits. */
export async function tagList(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const limit = clampInteger(args.limit, { min: 1, max: GIT_LIMITS.tag_max, fallback: 100, label: 'limit' })
  const format = '--format=%(refname:short)%1f%(objectname)%1f%(creatordate:iso-strict)%1f%(contents:subject)'
  const result = await git(root, ['for-each-ref', '--sort=-creatordate', format, 'refs/tags'], options)
  const tags = result.stdout.split('\n').filter(line => line !== '').map(line => {
    const [name, sha, createdAt, subject] = line.split(UNIT)
    return { name, sha, created_at: createdAt, subject }
  })
  const page = tags.slice(0, limit)
  return { tags: page, total: tags.length, truncated: page.length < tags.length }
}

/** git_tag_create: lightweight or annotated tag on a ref. */
export async function tagCreate(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const name = safeRef(args.name, 'name')
  const ref = optionalRevision(args.ref, 'ref')
  const existing = await git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], { ...options, allowFailure: true })
  if (existing.exitCode === 0) fail('ALREADY_EXISTS', `tag already exists: ${name}`)
  const annotated = typeof args.message === 'string' && args.message.trim() !== ''
  const argv = ['tag']
  if (annotated) argv.push('--annotate', '--file=-')
  argv.push(name)
  if (ref !== undefined) argv.push(ref)
  await git(root, argv, { ...options, stdin: annotated ? `${args.message}\n` : undefined })
  const sha = await git(root, ['rev-parse', `refs/tags/${name}`], options)
  return { name, created: true, annotated, ref, sha: sha.stdout.trim() }
}

/** git_compare: ahead/behind plus per-file stats between two refs. */
export async function compare(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const base = safeRevision(args.base, 'base')
  const head = args.head === undefined || args.head === '' ? 'HEAD' : safeRevision(args.head, 'head')
  const counts = await git(root, ['rev-list', '--left-right', '--count', `${base}...${head}`], options)
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(value => Number.parseInt(value, 10) || 0)
  const numstat = await git(root, ['diff', '--no-ext-diff', '--no-color', '--numstat', `${base}...${head}`], options)
  const files = parseNumstat(numstat.stdout)
  const limit = clampInteger(args.limit, { min: 1, max: GIT_LIMITS.log_max_count, fallback: GIT_LIMITS.log_default_count, label: 'limit' })
  const commits = await git(root, ['log', `--max-count=${limit}`, '--no-color', LOG_FORMAT, `${base}..${head}`], { ...options, allowFailure: true })
  const mergeBase = await git(root, ['merge-base', base, head], { ...options, allowFailure: true })
  return {
    base,
    head,
    ahead,
    behind,
    merge_base: mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : undefined,
    files,
    ...totals(files),
    commits: commits.exitCode === 0 ? parseCommits(commits.stdout) : [],
    truncated: ahead > limit,
  }
}

function remoteName(value) {
  if (value === undefined || value === null || value === '') return 'origin'
  if (typeof value !== 'string' || value.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(value)) {
    fail('INVALID_ARGUMENT', `remote name contains characters that are not allowed: ${value}`)
  }
  return value
}

/** git_fetch: read-only network refresh of remote refs. */
export async function fetch(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const remote = remoteName(args.remote)
  const argv = ['fetch', '--no-color']
  if (args.prune === true) argv.push('--prune')
  if (args.tags === true) argv.push('--tags')
  argv.push(remote)
  if (args.ref !== undefined && args.ref !== '') argv.push(safeRef(args.ref, 'ref'))
  const result = await git(root, argv, { ...options, allowFailure: true })
  if (result.exitCode !== 0) throw gitError(argv, result)
  const state = await status(sandbox, { path: args.path, limit: 1 }, options)
  return { fetched: true, remote, pruned: args.prune === true, ahead: state.ahead, behind: state.behind, output: redactSecrets(`${result.stdout}${result.stderr}`.trim()) }
}

/** git_pull: fetch and integrate, fast-forward only unless told otherwise. */
export async function pull(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const remote = remoteName(args.remote)
  const strategy = args.strategy ?? 'ff-only'
  if (!['ff-only', 'merge', 'rebase'].includes(strategy)) fail('INVALID_ARGUMENT', 'strategy must be ff-only, merge, or rebase')
  if (strategy === 'rebase') requireConfirmation(args.confirm, `Pull with rebase from ${remote}, rewriting local commit history`)
  const argv = ['pull', '--no-color']
  if (strategy === 'ff-only') argv.push('--ff-only')
  if (strategy === 'merge') argv.push('--no-rebase', '--no-edit')
  if (strategy === 'rebase') argv.push('--rebase')
  argv.push(remote)
  if (args.ref !== undefined && args.ref !== '') argv.push(safeRef(args.ref, 'ref'))
  const result = await git(root, argv, { ...options, allowFailure: true })
  if (result.exitCode !== 0) {
    const conflicts = await conflictedPaths(root, options)
    if (conflicts.length > 0) {
      throw new ActionError('GIT_CONFLICT', `pull left ${conflicts.length} conflicted path(s): ${conflicts.join(', ')}`, { details: { conflicts } })
    }
    throw gitError(argv, result)
  }
  const head = await git(root, ['rev-parse', 'HEAD'], options)
  return { pulled: true, remote, strategy, head: head.stdout.trim(), output: redactSecrets(`${result.stdout}${result.stderr}`.trim()) }
}

/**
 * git_push: the only action that publishes local work outside this machine. It
 * always requires confirm=true and never force-pushes without a separate
 * explicit flag, so the exact remote write is surfaced before it happens.
 */
export async function push(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const remote = remoteName(args.remote)
  const state = await status(sandbox, { path: args.path, limit: 1 }, options)
  const branch = args.ref === undefined || args.ref === '' ? state.branch : safeRef(args.ref, 'ref')
  if (branch === undefined) fail('INVALID_ARGUMENT', 'HEAD is detached; pass ref explicitly to name the branch to push')
  const forced = args.force === true
  requireConfirmation(args.confirm, `Push ${forced ? '(FORCE, with lease) ' : ''}branch "${branch}" to remote "${remote}", publishing ${state.ahead} local commit(s) outside this machine`)
  const argv = ['push', '--no-color']
  if (forced) argv.push('--force-with-lease')
  if (args.set_upstream === true) argv.push('--set-upstream')
  if (args.dry_run === true) argv.push('--dry-run')
  argv.push(remote, branch)
  const result = await git(root, argv, { ...options, allowFailure: true })
  if (result.exitCode !== 0) throw gitError(argv, result)
  return {
    pushed: true,
    dry_run: args.dry_run === true,
    remote,
    ref: branch,
    force: forced,
    commits_pushed: state.ahead,
    output: redactSecrets(`${result.stdout}${result.stderr}`.trim()),
  }
}
