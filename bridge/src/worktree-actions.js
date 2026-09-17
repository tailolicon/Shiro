import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fail } from './action-errors.js'
import { git, repoRoot } from './git-actions.js'
import { guardWorktreeCreation, withWorktreeLock, registerLease } from './worktree-policy.js'

// Git worktrees: opt-in isolation for concurrent source writers, NOT one per task.
//
// WHY THIS IS SMALL
// A worktree is a second checkout of the same repository at another path,
// sharing one object store. Shiro already has a layer whose whole job is
// "another path an action may operate in" -- the workspace. So a worktree is
// created, then registered as a workspace, and every existing action works on
// it unchanged: fs_*, exec_run, git_*, terminal_*, and harness_start({workspace})
// running a whole agent turn isolated in that checkout. The isolation the
// parallel-task story needs comes from the two features composing, not from a
// parallel implementation.
//
// SNAPSHOT AND HANDOFF
// A snapshot is a commit object built from a scratch index (tracked AND
// untracked files), parented on HEAD and pinned under refs/shiro/snapshots/ so
// it survives gc. Nothing about the working tree changes when one is taken --
// that is the point: it is a save point, not a stash.
//
// Restoring and handing off are the SAME operation with different targets:
// compute the snapshot's diff against its parent and apply it. Applying a patch
// (rather than resetting the index to a tree) is what keeps the result
// explainable: files arrive as ordinary working-tree changes, conflicts are
// reported as conflicts, and nothing silently stages a hundred files. Because
// worktrees of one repository share the object store, a snapshot taken in one
// is directly applicable in another with no transport in between.

export const WORKTREE_LIMITS = Object.freeze({
  max_list: 100,
  max_label_length: 120,
  snapshot_ref_prefix: 'refs/shiro/snapshots',
})

const BRANCH_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/
const SNAPSHOT_ID = /^[0-9a-f]{8,64}$/i

function assertBranchName(value, label = 'branch') {
  const name = String(value ?? '').trim()
  if (name === '') fail('INVALID_ARGUMENT', `${label} is required`)
  if (name.length > 200) fail('INVALID_ARGUMENT', `${label} is too long`)
  if (!BRANCH_NAME.test(name) || name.includes('..') || name.endsWith('.lock')) {
    fail('INVALID_ARGUMENT', `${label} is not a valid git branch name: ${name}`)
  }
  return name
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'worktree'
}

/** Parse `git worktree list --porcelain` into records. */
export function parseWorktreeList(stdout) {
  const worktrees = []
  let current = null
  for (const line of String(stdout).split('\n')) {
    if (line === '') {
      if (current !== null) worktrees.push(current)
      current = null
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') current = { path: value, bare: false, detached: false, locked: false, prunable: false }
    else if (current === null) continue
    else if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'bare') current.bare = true
    else if (key === 'detached') current.detached = true
    else if (key === 'locked') { current.locked = true; if (value !== '') current.lock_reason = value }
    else if (key === 'prunable') { current.prunable = true; if (value !== '') current.prunable_reason = value }
  }
  if (current !== null) worktrees.push(current)
  return worktrees
}

export async function listWorktrees(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const result = await git(root, ['worktree', 'list', '--porcelain'], options)
  const worktrees = parseWorktreeList(result.stdout)
  return { repository: root, worktrees, total: worktrees.length }
}

/**
 * Where a new worktree goes when the caller does not say. A sibling of the
 * repository, so it lands under the same allowlisted root the repository is in.
 */
export function defaultWorktreePath(repositoryRoot, branch) {
  return join(dirname(repositoryRoot), `${basename(repositoryRoot)}.worktrees`, slug(branch))
}

/**
 * `git worktree add`. The destination is validated by the caller against the
 * workspace allowlist before this runs -- creating a checkout somewhere the
 * operator never allowed would be a hole through the workspace boundary.
 */
export async function addWorktree(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  assertBranchName(args.branch)
  if (!String(args.destination ?? '')) fail('INVALID_ARGUMENT', 'destination is required')
  return withWorktreeLock(root, async common => {
    const existing = parseWorktreeList((await git(root, ['worktree', 'list', '--porcelain'], options)).stdout)
    const budget = await guardWorktreeCreation(root, args, existing, options)
    const created = await materializeWorktree(sandbox, args, options)
    await registerLease(common, created.path, { branch: created.branch, head: created.head,
      purpose: args.purpose || 'parallel_write', reason: args.isolation_reason || 'explicit isolated checkout request',
      estimated_bytes: budget.estimatedBytes, sparse_paths: budget.sparsePaths })
    return created
  }, options)
}

async function materializeWorktree(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const branch = assertBranchName(args.branch)
  const destination = String(args.destination ?? '')
  if (destination === '') fail('INVALID_ARGUMENT', 'destination is required')

  const argv = ['worktree', 'add']
  if (args.sparse_paths?.length) argv.push('--no-checkout')
  if (args.create_branch === false) {
    argv.push(destination, branch)
  } else {
    argv.push('-b', branch, destination)
    if (args.base_ref !== undefined && args.base_ref !== null && String(args.base_ref) !== '') {
      argv.push(String(args.base_ref))
    }
  }
  const result = await git(root, argv, { ...options, allowFailure: true })
  if (result.exitCode !== 0) {
    const stderr = (result.stderr || result.stdout || '').trim()
    const lowered = stderr.toLowerCase()
    if (lowered.includes('already exists') || lowered.includes('already used by worktree') || lowered.includes('is already checked out')) {
      fail('ALREADY_EXISTS', stderr)
    }
    if (lowered.includes('not a valid object name') || lowered.includes('invalid reference')) {
      fail('NOT_FOUND', stderr)
    }
    fail('GIT_CONFLICT', stderr === '' ? `git worktree add failed with exit code ${result.exitCode}` : stderr)
  }
  if (args.sparse_paths?.length) {
    await git(destination, ['sparse-checkout', 'set', '--cone', '--', ...args.sparse_paths], options)
    await git(destination, ['checkout', branch], options)
  }
  const listed = parseWorktreeList((await git(root, ['worktree', 'list', '--porcelain'], options)).stdout)
  const created = listed.find(entry => entry.branch === branch) ?? listed.at(-1)
  return { repository: root, path: created?.path ?? destination, branch, head: created?.head }
}

export async function removeWorktree(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const target = String(args.worktree_path ?? '')
  if (target === '') fail('INVALID_ARGUMENT', 'worktree_path is required')
  const argv = ['worktree', 'remove']
  if (args.force === true) argv.push('--force')
  argv.push(target)
  const result = await git(root, argv, { ...options, allowFailure: true })
  if (result.exitCode !== 0) {
    const stderr = (result.stderr || result.stdout || '').trim()
    const lowered = stderr.toLowerCase()
    // Uncommitted work is the interesting failure: report it as a conflict the
    // caller resolves by snapshotting or by asking for force, never silently.
    if (lowered.includes('contains modified or untracked files')) {
      fail('CONFLICT', `${stderr}. Take a worktree_snapshot first, or pass force=true to discard them.`)
    }
    if (lowered.includes('is not a working tree') || lowered.includes('not a valid path')) fail('NOT_FOUND', stderr)
    fail('GIT_CONFLICT', stderr === '' ? `git worktree remove failed with exit code ${result.exitCode}` : stderr)
  }
  await git(root, ['worktree', 'prune'], { ...options, allowFailure: true })
  return { repository: root, path: target, removed: true, forced: args.force === true }
}

function snapshotRef(id) {
  return `${WORKTREE_LIMITS.snapshot_ref_prefix}/${id}`
}

/**
 * Build a commit from the current working tree without touching it.
 *
 * A scratch index is used so the caller's real index is untouched: the caller
 * may have work staged, and a save point must not disturb it.
 */
export async function createSnapshot(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const label = String(args.label ?? '').slice(0, WORKTREE_LIMITS.max_label_length)
  const head = (await git(root, ['rev-parse', 'HEAD'], options)).stdout.trim()
  const indexFile = join(tmpdir(), `shiro-snapshot-${randomUUID()}.index`)
  const env = { GIT_INDEX_FILE: indexFile }
  try {
    // Seed from HEAD so the scratch index starts where the branch is, then add
    // everything the working tree has -- including files git does not track yet,
    // which are exactly what a save point must not lose.
    await git(root, ['read-tree', 'HEAD'], { ...options, env })
    await git(root, ['add', '-A', '.'], { ...options, env })
    const tree = (await git(root, ['write-tree'], { ...options, env })).stdout.trim()
    const message = label === '' ? 'shiro snapshot' : `shiro snapshot: ${label}`
    const commit = (await git(root, ['commit-tree', tree, '-p', head, '-m', message], options)).stdout.trim()
    const id = commit.slice(0, 12)
    // Pinned under a ref so gc cannot collect the save point.
    await git(root, ['update-ref', snapshotRef(id), commit], options)
    const stat = await git(root, ['diff', '--numstat', `${head}..${commit}`], options)
    const files = stat.stdout.split('\n').filter(line => line.trim() !== '').length
    return { repository: root, snapshot_id: id, commit, base: head, label: label === '' ? undefined : label, files_changed: files }
  } finally {
    await rm(indexFile, { force: true }).catch(() => {})
  }
}

export async function listSnapshots(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const result = await git(root, [
    'for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(creatordate:iso-strict)%09%(subject)',
    WORKTREE_LIMITS.snapshot_ref_prefix,
  ], options)
  const snapshots = result.stdout.split('\n').filter(line => line.trim() !== '').map(line => {
    const [refname, commit, created, subject] = line.split('\t')
    return {
      snapshot_id: String(refname).split('/').pop(),
      commit,
      created_at: created,
      label: String(subject ?? '').replace(/^shiro snapshot:?\s*/, '') || undefined,
    }
  })
  return { repository: root, snapshots, total: snapshots.length }
}

async function resolveSnapshot(root, snapshotId, options) {
  const id = String(snapshotId ?? '').trim()
  if (!SNAPSHOT_ID.test(id)) fail('INVALID_ARGUMENT', 'snapshot_id is not a snapshot identifier from worktree_snapshot')
  const result = await git(root, ['rev-parse', '--verify', `${snapshotRef(id)}^{commit}`], { ...options, allowFailure: true })
  if (result.exitCode !== 0) fail('NOT_FOUND', `snapshot ${id} does not exist in this repository`)
  return result.stdout.trim()
}

/**
 * Apply a snapshot's changes into a working tree.
 *
 * This is the one operation behind both restore and handoff: the difference is
 * only which tree it targets. A patch is used rather than a tree reset because
 * the target may sit on a different commit -- which is the normal case when
 * handing work from the main checkout to a task worktree -- and because a
 * conflict must surface as a conflict instead of a silent overwrite.
 */
export async function applySnapshot(sourceSandbox, targetSandbox, args = {}, options = {}) {
  const sourceRoot = await repoRoot(sourceSandbox, args.path)
  const targetRoot = await repoRoot(targetSandbox, args.target_path)
  const commit = await resolveSnapshot(sourceRoot, args.snapshot_id, options)
  const base = (await git(sourceRoot, ['rev-parse', `${commit}^`], options)).stdout.trim()

  const diff = await git(sourceRoot, ['diff', '--binary', `${base}..${commit}`], options)
  if (diff.stdout.trim() === '') {
    return { repository: targetRoot, snapshot_id: args.snapshot_id, applied: true, empty: true, files_changed: 0 }
  }

  // Strict check, then a plain apply. `--3way` is deliberately not used: it
  // reports "does not match index" for patches that would in fact apply, and on
  // a real conflict it writes conflict markers into the tree -- which would
  // break the guarantee that a refused handoff leaves the target untouched.
  // The cost is that a snapshot only applies where its context still matches;
  // when it does not, the caller is told instead of being handed a mess.
  const check = await git(targetRoot, ['apply', '--check', '-'], { ...options, stdin: diff.stdout, allowFailure: true })
  if (check.exitCode !== 0) {
    const stderr = (check.stderr || check.stdout || '').trim()
    fail('GIT_CONFLICT', `the snapshot does not apply cleanly here: ${stderr}. Commit or stash the conflicting changes first.`)
  }
  const applied = await git(targetRoot, ['apply', '-'], { ...options, stdin: diff.stdout, allowFailure: true })
  if (applied.exitCode !== 0) {
    const stderr = (applied.stderr || applied.stdout || '').trim()
    fail('GIT_CONFLICT', stderr === '' ? 'the snapshot could not be applied' : stderr)
  }
  const stat = await git(sourceRoot, ['diff', '--numstat', `${base}..${commit}`], options)
  const files = stat.stdout.split('\n').filter(line => line.trim() !== '').length
  return { repository: targetRoot, snapshot_id: args.snapshot_id, commit, applied: true, empty: false, files_changed: files }
}

export async function dropSnapshot(sandbox, args = {}, options = {}) {
  const root = await repoRoot(sandbox, args.path)
  const commit = await resolveSnapshot(root, args.snapshot_id, options)
  await git(root, ['update-ref', '-d', snapshotRef(String(args.snapshot_id).trim())], options)
  return { repository: root, snapshot_id: String(args.snapshot_id).trim(), commit, deleted: true }
}
