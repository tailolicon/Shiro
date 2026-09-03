import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fail } from './action-errors.js'
import { Sandbox } from './sandbox.js'

// Multi-root workspaces for the direct actions.
//
// Until now every fs_/exec_/git_ action was locked to one fixed project root,
// which meant a sibling project could only be touched by copying it into the
// Shiro repository. A workspace is a second confinement layer on top of the
// existing Sandbox: the operator declares which directory trees may ever be
// opened (the allowlist), the model opens one of them by path, and every later
// call addresses it by an opaque workspace id. Inside a workspace the original
// Sandbox rules are unchanged -- relative paths only, no `..`, no symlink
// escape -- so widening the reachable set never widens what a single call can
// reach beyond the workspace it names.
//
// The primary workspace is the configured project root. It is always open,
// cannot be closed, and is what every action uses when `workspace` is omitted,
// so the whole 74-action surface keeps its previous behaviour byte for byte.

export const WORKSPACE_LIMITS = Object.freeze({
  max_open: 16,
  max_candidates: 200,
  max_candidate_depth: 2,
})

export const PRIMARY_WORKSPACE_ID = 'project'

/** Expand a leading `~` so operators and models can type the natural form. */
export function expandHome(value, home = homedir()) {
  if (value === '~') return home
  if (value.startsWith(`~${sep}`) || value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

function isInside(parent, child) {
  return child === parent || child.startsWith(parent + sep)
}

function slug(value) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'workspace' : cleaned.slice(0, 48)
}

/**
 * Normalize the operator-supplied allowlist. Entries are absolute directory
 * prefixes; `/` is refused because an allowlist of everything is never an
 * intentional configuration, only a typo that would hand the model the host.
 */
export function normalizeAllowedRoots(value, { home = homedir() } = {}) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? value.split(/[:;\n]/)
      : []
  const roots = []
  for (const entry of raw) {
    if (typeof entry !== 'string') throw new Error('workspaceAllowlist entries must be strings')
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const expanded = resolve(expandHome(trimmed, home))
    if (expanded === sep || expanded === '/') {
      throw new Error('workspaceAllowlist must not contain the filesystem root: list the project directories that may be opened')
    }
    if (!roots.includes(expanded)) roots.push(expanded)
  }
  return roots
}

export class WorkspaceRegistry {
  constructor({ projectRoot, allowedRoots = [], now = () => Date.now(), limits = WORKSPACE_LIMITS } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new Error('projectRoot is required')
    this.projectRoot = resolve(projectRoot)
    this.allowedRoots = normalizeAllowedRoots(allowedRoots)
    this.limits = limits
    this.now = now
    this.workspaces = new Map()
    this.workspaces.set(PRIMARY_WORKSPACE_ID, {
      id: PRIMARY_WORKSPACE_ID,
      name: 'project',
      path: this.projectRoot,
      real: null,
      primary: true,
      openedAt: now(),
      sandbox: new Sandbox(this.projectRoot),
    })
  }

  /** The configured project root: open forever, used whenever `workspace` is omitted. */
  primary() {
    return this.workspaces.get(PRIMARY_WORKSPACE_ID)
  }

  /** True when additional roots may be opened at all on this deployment. */
  get multiRoot() {
    return this.allowedRoots.length > 0
  }

  get(workspaceId) {
    if (workspaceId === undefined || workspaceId === null || workspaceId === '') return this.primary()
    if (typeof workspaceId !== 'string') fail('INVALID_ARGUMENT', 'workspace must be a workspace id string')
    const entry = this.workspaces.get(workspaceId)
    if (entry === undefined) {
      const known = [...this.workspaces.keys()].join(', ')
      fail('NOT_FOUND', `workspace ${workspaceId} is not open; open it with workspace_open. Currently open: ${known}`)
    }
    return entry
  }

  /** The Sandbox every direct action resolves its paths through. */
  sandboxFor(workspaceId) {
    return this.get(workspaceId).sandbox
  }

  #allowed(realPath) {
    if (isInside(this.projectRoot, realPath)) return this.projectRoot
    for (const root of this.allowedRoots) {
      if (isInside(root, realPath)) return root
    }
    return null
  }

  #assertAllowed(realPath, requested) {
    const allowed = this.#allowed(realPath)
    if (allowed === null) {
      const list = this.allowedRoots.length === 0
        ? 'this deployment has no workspace allowlist configured, so only the fixed project root is reachable (set workspaceAllowlist / SHIRO_WORKSPACE_ALLOWLIST to open sibling projects)'
        : `allowed roots: ${[this.projectRoot, ...this.allowedRoots].join(', ')}`
      fail('OUTSIDE_SANDBOX', `${requested} is outside every allowed workspace root; ${list}`)
    }
    return allowed
  }

  #resolveRequested(requested) {
    if (typeof requested !== 'string' || requested.trim() === '') {
      fail('INVALID_ARGUMENT', 'path is required: an absolute directory inside one of the allowed workspace roots')
    }
    if (requested.includes('\0')) fail('INVALID_ARGUMENT', 'path must not contain NUL bytes')
    const expanded = expandHome(requested.trim())
    if (!isAbsolute(expanded)) {
      fail('INVALID_ARGUMENT', `workspace paths are absolute (or ~-relative), unlike the project-relative paths every other action takes: ${requested}`)
    }
    return resolve(expanded)
  }

  #idFor(name, absolute) {
    const base = slug(typeof name === 'string' && name.trim() !== '' ? name.trim() : absolute.split(sep).filter(Boolean).pop() ?? 'workspace')
    if (!this.workspaces.has(base)) return base
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${base}-${suffix}`
      if (!this.workspaces.has(candidate)) return candidate
    }
    fail('CONFLICT', `too many workspaces named like ${base}`)
  }

  #record(entry, extra = {}) {
    return {
      workspace_id: entry.id,
      name: entry.name,
      path: entry.path,
      primary: entry.primary === true,
      opened_at: new Date(entry.openedAt).toISOString(),
      ...extra,
    }
  }

  /**
   * Validate a path against the allowlist without creating or opening it.
   * worktree_create needs the check before git makes the checkout.
   */
  assertPathAllowed(requested) {
    const absolute = this.#resolveRequested(requested)
    this.#assertAllowed(absolute, requested)
    return absolute
  }

  /**
   * workspace_open: register an existing directory as an addressable root.
   * Idempotent -- opening a directory that is already open returns the same
   * workspace id with already_open=true instead of a second registration.
   */
  async open(args = {}) {
    const requested = this.#resolveRequested(args.path)
    // Allowlist first, existence second: answering NOT_FOUND for a path outside
    // the allowed roots would turn workspace_open into a probe for what exists
    // elsewhere on the host. The real path is re-checked after realpath so a
    // symlink inside an allowed root still cannot point out of it.
    this.#assertAllowed(requested, requested)
    let real
    try {
      real = await realpath(requested)
    } catch {
      fail('NOT_FOUND', `directory does not exist: ${requested}. Use workspace_create to make it first.`)
    }
    this.#assertAllowed(real, requested)
    const info = await stat(real)
    if (!info.isDirectory()) fail('INVALID_ARGUMENT', `workspace path is not a directory: ${requested}`)
    for (const entry of this.workspaces.values()) {
      const known = entry.real ?? await realpath(entry.path).catch(() => entry.path)
      if (known === real) return { ...this.#record(entry), already_open: true }
    }
    if (this.workspaces.size >= this.limits.max_open) {
      fail('BUSY', `${this.workspaces.size} workspaces are open (limit ${this.limits.max_open}); close one with workspace_close first`)
    }
    const id = this.#idFor(args.name, real)
    const entry = {
      id,
      name: typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim().slice(0, 80) : real.split(sep).filter(Boolean).pop() ?? id,
      path: real,
      real,
      primary: false,
      openedAt: this.now(),
      sandbox: new Sandbox(real),
    }
    this.workspaces.set(id, entry)
    return { ...this.#record(entry), already_open: false }
  }

  /** workspace_create: mkdir inside the allowlist, then open it. */
  async create(args = {}) {
    const requested = this.#resolveRequested(args.path)
    this.#assertAllowed(requested, requested)
    // The directory does not exist yet, so the allowlist is checked again
    // against the deepest existing ancestor: that ancestor is what a symlink
    // could redirect somewhere else.
    let cursor = requested
    const missing = []
    for (;;) {
      try {
        const real = await realpath(cursor)
        this.#assertAllowed(real, requested)
        break
      } catch (error) {
        if (error?.code !== undefined && error.code !== 'ENOENT') throw error
        const parent = resolve(cursor, '..')
        if (parent === cursor) fail('OUTSIDE_SANDBOX', `${requested} has no existing parent inside the allowed workspace roots`)
        missing.push(cursor)
        cursor = parent
      }
    }
    if (missing.length === 0) return { ...(await this.open({ path: requested, name: args.name })), created: false }
    if (missing.length > 1 && args.create_parents === false) {
      fail('NOT_FOUND', `the parent of ${requested} does not exist; pass create_parents=true (the default) to create the chain`)
    }
    await mkdir(requested, { recursive: true })
    return { ...(await this.open({ path: requested, name: args.name })), created: true }
  }

  /**
   * workspace_close: forget one opened root. The primary workspace is never
   * closable, and the caller supplies the live process/terminal counts so a
   * workspace with running work is refused unless the call is explicit.
   */
  close(args = {}, usage = { processes: 0, terminals: 0 }) {
    const entry = this.get(args.workspace ?? args.workspace_id)
    if (entry.primary) {
      fail('INVALID_ARGUMENT', 'the primary workspace is the fixed project root and is always open; it cannot be closed')
    }
    const busy = (usage.processes ?? 0) + (usage.terminals ?? 0)
    if (busy > 0 && args.force !== true) {
      fail('BUSY', `workspace ${entry.id} still has ${usage.processes ?? 0} running process(es) and ${usage.terminals ?? 0} terminal(s); stop them first or repeat with force=true (closing does not kill them)`)
    }
    this.workspaces.delete(entry.id)
    return { ...this.#record(entry), closed: true, running_processes: usage.processes ?? 0, running_terminals: usage.terminals ?? 0 }
  }

  /** Open workspaces, newest last, primary first. */
  records(extra = () => ({})) {
    return [...this.workspaces.values()]
      .sort((left, right) => (right.primary === true ? 1 : 0) - (left.primary === true ? 1 : 0) || left.openedAt - right.openedAt)
      .map(entry => this.#record(entry, extra(entry)))
  }

  /**
   * workspace_list: what is open plus, on request, what could be opened.
   * Discovery walks the allowlist a couple of levels deep so the model can find
   * sibling projects without guessing paths, and is bounded by max_candidates.
   */
  async list(args = {}, extra = () => ({})) {
    const workspaces = this.records(extra)
    const payload = {
      workspaces,
      total: workspaces.length,
      max_open: this.limits.max_open,
      project_root: this.projectRoot,
      allowed_roots: [...this.allowedRoots],
      multi_root: this.multiRoot,
    }
    if (args.include_candidates !== true) return payload
    const limit = Math.min(Number.isInteger(args.limit) ? args.limit : this.limits.max_candidates, this.limits.max_candidates)
    const depth = Math.min(Number.isInteger(args.depth) ? args.depth : 1, this.limits.max_candidate_depth)
    const open = new Set([...this.workspaces.values()].map(entry => entry.path))
    const candidates = []
    let truncated = false
    const walk = async (directory, level) => {
      if (candidates.length >= limit) { truncated = true; return }
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch { return }
      for (const child of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!child.isDirectory() || child.name.startsWith('.')) continue
        if (candidates.length >= limit) { truncated = true; return }
        const absolute = join(directory, child.name)
        const marker = await stat(join(absolute, '.git')).then(() => true).catch(() => false)
        candidates.push({ path: absolute, name: child.name, git_repository: marker, open: open.has(absolute) })
        if (level < depth && !marker) await walk(absolute, level + 1)
      }
    }
    for (const root of this.allowedRoots) await walk(root, 1)
    return { ...payload, candidates, candidate_count: candidates.length, truncated }
  }
}
