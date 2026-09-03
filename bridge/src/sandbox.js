import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ActionError, fail } from './action-errors.js'

// Path confinement for every direct connector action.
//
// The bridge has exactly one fixed project root. Direct actions accept only
// project-relative paths and must land inside that root *after* symlinks are
// resolved -- a lexical check alone is defeated by a symlink whose target
// escapes (`ln -s /etc inside-root/etc`). Existing paths are therefore checked
// through realpath(); paths that do not exist yet are checked through the
// realpath of their deepest existing ancestor, because the components being
// created cannot themselves be symlinks.
//
// This mirrors the confinement already used by readWorkspaceArtifact (index.js),
// confinePath (git-commands.js) and workspaceRelative (container-path.js); it
// is the write-capable, symlink-aware generalization of all three.

/** Project-relative form used in every public payload ('.' for the root). */
export function toRelative(root, absolute) {
  const rel = relative(root, absolute)
  if (rel === '') return '.'
  return rel.split(sep).join('/')
}

function lexical(root, requested) {
  if (typeof requested !== 'string' || requested === '') {
    fail('INVALID_ARGUMENT', 'path is required and must be a project-relative string')
  }
  if (requested.includes('\0')) fail('INVALID_ARGUMENT', 'path must not contain NUL bytes')
  if (isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested)) {
    fail('OUTSIDE_SANDBOX', `path must be relative to the fixed project root, not absolute: ${requested}`)
  }
  const absolute = resolve(root, requested)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail('OUTSIDE_SANDBOX', `path escapes the fixed project root: ${requested}`)
  }
  return absolute
}

function assertInside(rootReal, candidate, requested) {
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) {
    fail('OUTSIDE_SANDBOX', `path resolves outside the fixed project root through a link: ${requested}`)
  }
}

export class Sandbox {
  constructor(root) {
    if (typeof root !== 'string' || root.trim() === '') throw new Error('sandbox root is required')
    this.root = resolve(root)
    this.rootRealCache = null
  }

  /** realpath of the fixed root, resolved once: the root itself never moves. */
  async rootReal() {
    if (this.rootRealCache === null) {
      try {
        this.rootRealCache = await realpath(this.root)
      } catch (error) {
        throw new ActionError('INTERNAL', `fixed project root is unreadable: ${error.message}`)
      }
    }
    return this.rootRealCache
  }

  relative(absolute) {
    return toRelative(this.root, absolute)
  }

  /**
   * Resolve a path that must already exist. `follow:false` keeps a symlink
   * itself as the target (needed by stat/delete so a link can be inspected or
   * removed without touching what it points at) while still proving that the
   * link's own location is inside the root.
   */
  async resolveExisting(requested, { follow = true } = {}) {
    const rootReal = await this.rootReal()
    const absolute = lexical(this.root, requested)
    const parent = await this.#realParent(absolute, requested, rootReal)
    const leaf = absolute === this.root ? rootReal : join(parent, basenameOf(absolute))
    assertInside(rootReal, leaf, requested)
    let info
    try {
      info = await lstat(leaf)
    } catch {
      fail('NOT_FOUND', `path does not exist: ${this.relative(absolute)}`)
    }
    if (follow && info.isSymbolicLink()) {
      let target
      try {
        target = await realpath(leaf)
      } catch {
        fail('NOT_FOUND', `symlink target does not exist: ${this.relative(absolute)}`)
      }
      assertInside(rootReal, target, requested)
      return { absolute: target, relative: this.relative(absolute), requested, linked: true }
    }
    return { absolute: leaf, relative: this.relative(absolute), requested, linked: false }
  }

  /**
   * Resolve a path that may not exist yet (create/move/copy destinations). The
   * deepest existing ancestor is realpath()d and must be inside the root, so a
   * symlinked parent directory cannot be used to write outside.
   */
  async resolveForWrite(requested) {
    const rootReal = await this.rootReal()
    const absolute = lexical(this.root, requested)
    if (absolute === this.root) fail('INVALID_ARGUMENT', 'the fixed project root itself cannot be the target of a write')
    const parent = await this.#realParent(absolute, requested, rootReal)
    const target = join(parent, basenameOf(absolute))
    assertInside(rootReal, target, requested)
    return { absolute: target, relative: this.relative(absolute), requested }
  }

  /** Resolve a directory that must exist, used for process/exec cwd. */
  async resolveDirectory(requested = '.') {
    const resolved = await this.resolveExisting(requested)
    const info = await lstat(resolved.absolute)
    if (!info.isDirectory()) fail('INVALID_ARGUMENT', `cwd is not a directory: ${resolved.relative}`)
    return resolved
  }

  async #realParent(absolute, requested, rootReal) {
    if (absolute === this.root) return dirname(rootReal)
    const chain = []
    let cursor = dirname(absolute)
    // Walk up until an existing ancestor is found; every skipped component is
    // being created, so it cannot itself be a link.
    for (;;) {
      try {
        const real = await realpath(cursor)
        assertInside(rootReal, real, requested)
        return chain.length === 0 ? real : join(real, ...chain.reverse())
      } catch (error) {
        if (error instanceof ActionError) throw error
        if (cursor === this.root || cursor === dirname(cursor)) {
          fail('OUTSIDE_SANDBOX', `path escapes the fixed project root: ${requested}`)
        }
        chain.push(basenameOf(cursor))
        cursor = dirname(cursor)
      }
    }
  }
}

function basenameOf(value) {
  const parts = value.split(sep)
  return parts[parts.length - 1]
}
