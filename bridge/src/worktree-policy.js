// Bounded isolated checkouts; normal agents should use the existing workspace.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, statfs, readdir, readlink } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join, dirname } from 'node:path'
import { git } from './git-actions.js'
import { fail } from './action-errors.js'

export const WORKTREE_POLICY = Object.freeze({ maxLinked: 4, maxCheckoutBytes: 1024 ** 3, reserveBytes: 2 * 1024 ** 3, leaseHours: 24 })

export async function policyConfig(root, options = {}) {
  const read = async (key, fallback) => {
    const r = await git(root, ['config', '--get', key], { ...options, allowFailure: true })
    if (r.exitCode !== 0) return fallback
    const value = Number(r.stdout.trim())
    if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_ARGUMENT', `Invalid ${key}`)
    return value
  }
  return { maxLinked: await read('shiro.worktreeMaxLinked', WORKTREE_POLICY.maxLinked),
    maxCheckoutBytes: await read('shiro.worktreeMaxCheckoutBytes', WORKTREE_POLICY.maxCheckoutBytes) }
}

export function validateSparsePaths(paths) {
  if (paths === undefined) return []
  if (!Array.isArray(paths) || paths.length > 40) fail('INVALID_ARGUMENT', 'sparse_paths must contain at most 40 directories')
  for (const p of paths) {
    if (typeof p !== 'string' || !p || isAbsolute(p) || p.startsWith('-') || p.split(/[\\/]/).some(x => x === '..' || x === '.git') || /[\n\r\0]/.test(p)) {
      fail('INVALID_ARGUMENT', 'sparse_paths must be safe project-relative directories')
    }
  }
  return paths
}

export async function guardWorktreeCreation(root, args, listing, options = {}) {
  if (args.purpose === 'read_only') fail('INVALID_ARGUMENT', 'Read/research/review workers reuse the current workspace; no checkout needed')
  const main = listing[0]?.path || root
  const rel = relative(resolve(main), resolve(args.destination))
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) fail('INVALID_ARGUMENT', 'Do not nest worktrees inside the source checkout')
  const config = await policyConfig(root, options)
  if (listing.filter(w => !w.prunable).length - 1 >= config.maxLinked) {
    fail('BUSY', `Worktree budget reached (${config.maxLinked} linked checkouts). Reuse an existing workspace or preserve and retire completed work first.`)
  }
  const sparse = validateSparsePaths(args.sparse_paths)
  const ref = args.base_ref || (args.create_branch === false ? args.branch : 'HEAD')
  if (String(ref).startsWith('-')) fail('INVALID_ARGUMENT', 'base_ref must not be an option')
  const resolved = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`], options)).stdout.trim()
  const size = await git(root, ['ls-tree', '-r', '--format=%(objectsize)', resolved, ...(sparse.length ? ['--', ...sparse] : [])], options)
  if (size.truncated) fail('CONFLICT', 'Checkout inventory exceeds safety bound. Use sparse_paths instead of duplicating this large data repository.')
  const estimatedBytes = size.stdout.split('\n').reduce((n, line) => n + (Number(line) || 0), 0)
  if (estimatedBytes > config.maxCheckoutBytes) fail('CONFLICT', `Checkout would materialize ${estimatedBytes} bytes (budget ${config.maxCheckoutBytes}). Use sparse_paths or the shared workspace.`)
  // Cone mode includes files in each ancestor directory, not just the root.
  // Count each ancestor once, excluding descendants already included recursively.
  let total = estimatedBytes
  if (sparse.length) {
    const ancestors = new Set([''])
    for (const path of sparse) {
      const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
      for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join('/'))
    }
    for (const ancestor of ancestors) {
      if (sparse.some(p => ancestor === p || ancestor.startsWith(p + '/'))) continue
      const tree = ancestor ? `${resolved}:${ancestor}` : resolved
      const top = await git(root, ['ls-tree', '--format=%(objecttype) %(objectsize)', tree], options)
      if (top.truncated) fail('CONFLICT', 'Sparse ancestor inventory exceeds safety bound')
      total += top.stdout.split('\n').filter(s => s.startsWith('blob ')).reduce((n, s) => n + Number(s.slice(5)), 0)
    }
    if (total > config.maxCheckoutBytes) fail('CONFLICT', 'Sparse checkout plus ancestor files exceeds byte budget')
  }
  let parent = dirname(resolve(args.destination))
  let space
  while (!space) {
    try { space = await statfs(parent) } catch (error) {
      if (error.code !== 'ENOENT' || dirname(parent) === parent) throw error
      parent = dirname(parent)
    }
  }
  if (Number(space.bavail) * Number(space.bsize) < total + WORKTREE_POLICY.reserveBytes) fail('CONFLICT', 'Insufficient free disk for this isolated checkout and safety reserve')
  return { estimatedBytes: total, sparsePaths: sparse, main, ...config }
}

export async function withWorktreeLock(root, fn, options = {}) {
  const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options)).stdout.trim()
  const lock = join(common, 'shiro-worktree-create.lock')
  try { await mkdir(lock) } catch (error) {
    if (error.code === 'EEXIST') fail('BUSY', 'Another checkout mutation owns the Git worktree lock; do not create a duplicate')
    throw error
  }
  try { await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })); return await fn(common) }
  finally { await rm(lock, { recursive: true, force: true }) }
}

export async function registerLease(common, path, details = {}) {
  const dir = join(common, 'shiro-worktree-leases')
  await mkdir(dir, { recursive: true })
  const name = createHash('sha256').update(resolve(path)).digest('hex') + '.json'
  const now = Date.now()
  await writeFile(join(dir, name), JSON.stringify({ path: resolve(path), created_at: new Date(now).toISOString(), expires_at: new Date(now + WORKTREE_POLICY.leaseHours * 3600000).toISOString(), ...details }, null, 2))
}

async function activePaths(target) {
  if (process.platform !== 'linux') return true // Unknown host process state is not permission to delete.
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
    const points = []
    try {
      points.push(await readlink(`/proc/${pid}/cwd`))
      const args = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0')
      points.push(...args.filter(s => s.startsWith('/')))
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        try { points.push(await readlink(`/proc/${pid}/fd/${fd}`)) } catch {}
      }
    } catch { continue }
    if (points.some(p => p === target || p.startsWith(target + '/'))) return true
  }
  return false
}

export async function managedMaintenance(root, parseList, { apply = false, now = Date.now(), ...options } = {}) {
  return withWorktreeLock(root, async common => {
    let files
    try { files = await readdir(join(common, 'shiro-worktree-leases')) } catch { files = [] }
    const list = parseList((await git(root, ['worktree', 'list', '--porcelain'], options)).stdout)
    const main = list[0]
    const report = []
    for (const file of files.filter(f => /^[0-9a-f]{64}\.json$/.test(f))) {
      const leasePath = join(common, 'shiro-worktree-leases', file)
      const lease = JSON.parse(await readFile(leasePath, 'utf8'))
      const wt = list.find(w => w.path === lease.path)
      let reason = ''
      if (!wt) reason = 'already_removed'
      else if (wt.path === main.path || wt.locked || wt.prunable) reason = 'protected_or_unavailable'
      else if (!(Date.parse(lease.expires_at) <= now)) reason = 'lease_not_expired'
      else if (await activePaths(wt.path)) reason = 'in_use'
      else {
        const status = await git(wt.path, ['status', '--porcelain', '--untracked-files=all'], options)
        const ignored = await git(wt.path, ['ls-files', '--others', '--ignored', '--exclude-standard'], options)
        const ancestor = await git(root, ['merge-base', '--is-ancestor', wt.head, main.head], { ...options, allowFailure: true })
        if (status.truncated || status.stdout.trim()) reason = 'dirty_preserve_first'
        else if (ignored.truncated || ignored.stdout.trim()) reason = 'ignored_data_preserve_first'
        else if (ancestor.exitCode !== 0) reason = 'unmerged_preserve_first'
      }
      if (!reason && apply) {
        await git(root, ['update-ref', `refs/shiro/retired/${file.slice(0, -5)}`, wt.head], options)
        await git(root, ['worktree', 'remove', wt.path], options) // Never --force in automatic retirement.
        await rm(leasePath)
      }
      report.push({ path: lease.path, eligible: !reason, removed: !reason && apply, reason })
    }
    return { repository: root, dry_run: !apply, worktrees: report }
  }, options)
}
