import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEntry } from '../src/fs-actions.js'
import { normalizeAllowedRoots, PRIMARY_WORKSPACE_ID, WorkspaceRegistry } from '../src/workspaces.js'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'shiro-ws-'))
  const projects = join(base, 'Projects')
  const root = join(projects, 'Shiro')
  const sibling = join(projects, 'other-app')
  const outside = join(base, 'elsewhere')
  await mkdir(root, { recursive: true })
  await mkdir(sibling, { recursive: true })
  await mkdir(outside, { recursive: true })
  const registry = new WorkspaceRegistry({ projectRoot: root, allowedRoots: [projects] })
  return { base, projects, root, sibling, outside, registry, cleanup: () => rm(base, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('the allowlist refuses the filesystem root and normalizes entries', () => {
  assert.deepEqual(normalizeAllowedRoots(''), [])
  assert.deepEqual(normalizeAllowedRoots(undefined), [])
  assert.deepEqual(normalizeAllowedRoots('/srv/a:/srv/b'), ['/srv/a', '/srv/b'])
  assert.deepEqual(normalizeAllowedRoots(['/srv/a', '/srv/a/']), ['/srv/a'])
  assert.deepEqual(normalizeAllowedRoots('~/Projects', { home: '/home/x' }), ['/home/x/Projects'])
  assert.throws(() => normalizeAllowedRoots('/'), /filesystem root/)
  assert.throws(() => normalizeAllowedRoots(['/srv', '/']), /filesystem root/)
})

test('a bridge with no allowlist stays single-rooted', async () => {
  const base = await mkdtemp(join(tmpdir(), 'shiro-ws-solo-'))
  try {
    const registry = new WorkspaceRegistry({ projectRoot: base })
    assert.equal(registry.multiRoot, false)
    assert.equal(registry.primary().id, PRIMARY_WORKSPACE_ID)
    // Omitting the selector is what every pre-existing call does; it must keep
    // resolving to the fixed project root.
    assert.equal(registry.sandboxFor(undefined).root, registry.primary().sandbox.root)
    await rejects(registry.open({ path: join(base, '..') }), 'OUTSIDE_SANDBOX')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('workspace_open only accepts absolute paths inside an allowed root', async () => {
  const { sibling, outside, registry, cleanup } = await fixture()
  try {
    await rejects(registry.open({ path: 'relative/path' }), 'INVALID_ARGUMENT')
    await rejects(registry.open({ path: outside }), 'OUTSIDE_SANDBOX')
    await rejects(registry.open({ path: join(sibling, 'missing') }), 'NOT_FOUND')

    const opened = await registry.open({ path: sibling })
    assert.equal(opened.workspace_id, 'other-app')
    assert.equal(opened.path, sibling)
    assert.equal(opened.primary, false)
    assert.equal(opened.already_open, false)

    // Idempotent: the same directory never registers twice.
    const again = await registry.open({ path: sibling })
    assert.equal(again.workspace_id, 'other-app')
    assert.equal(again.already_open, true)
    assert.equal(registry.workspaces.size, 2)
  } finally {
    await cleanup()
  }
})

test('a symlink cannot smuggle a workspace outside the allowlist', async () => {
  const { projects, outside, registry, cleanup } = await fixture()
  try {
    const trapdoor = join(projects, 'looks-local')
    await symlink(outside, trapdoor)
    await rejects(registry.open({ path: trapdoor }), 'OUTSIDE_SANDBOX')
    // ...and neither can a symlinked parent for a directory being created.
    await rejects(registry.create({ path: join(trapdoor, 'new-project') }), 'OUTSIDE_SANDBOX')
  } finally {
    await cleanup()
  }
})

test('a file is not a workspace and the id stays unique per directory', async () => {
  const { projects, registry, cleanup } = await fixture()
  try {
    const file = join(projects, 'notes.md')
    await writeFile(file, 'x')
    await rejects(registry.open({ path: file }), 'INVALID_ARGUMENT')

    await mkdir(join(projects, 'a', 'app'), { recursive: true })
    await mkdir(join(projects, 'b', 'app'), { recursive: true })
    const first = await registry.open({ path: join(projects, 'a', 'app') })
    const second = await registry.open({ path: join(projects, 'b', 'app') })
    assert.equal(first.workspace_id, 'app')
    assert.equal(second.workspace_id, 'app-2')
  } finally {
    await cleanup()
  }
})

test('workspace_create makes the directory then opens it', async () => {
  const { projects, outside, registry, cleanup } = await fixture()
  try {
    const created = await registry.create({ path: join(projects, 'fresh', 'nested') })
    assert.equal(created.created, true)
    assert.equal(created.path, join(projects, 'fresh', 'nested'))
    const repeat = await registry.create({ path: join(projects, 'fresh', 'nested') })
    assert.equal(repeat.created, false)
    assert.equal(repeat.already_open, true)
    await rejects(registry.create({ path: join(outside, 'nope') }), 'OUTSIDE_SANDBOX')
  } finally {
    await cleanup()
  }
})

test('each workspace confines paths to its own root', async () => {
  const { root, sibling, registry, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'primary.txt'), 'in the project root\n')
    await writeFile(join(sibling, 'other.txt'), 'in the sibling\n')
    const opened = await registry.open({ path: sibling })

    const here = await readEntry(registry.sandboxFor(undefined), { path: 'primary.txt' })
    assert.equal(here.content, 'in the project root\n')
    const there = await readEntry(registry.sandboxFor(opened.workspace_id), { path: 'other.txt' })
    assert.equal(there.content, 'in the sibling\n')

    // Opening a second root does not merge the two: each stays confined.
    await rejects(readEntry(registry.sandboxFor(opened.workspace_id), { path: 'primary.txt' }), 'NOT_FOUND')
    await rejects(readEntry(registry.sandboxFor(opened.workspace_id), { path: '../Shiro/primary.txt' }), 'OUTSIDE_SANDBOX')
    assert.throws(() => registry.sandboxFor('no-such-workspace'), error => error.code === 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('workspace_close refuses the primary and busy workspaces', async () => {
  const { sibling, registry, cleanup } = await fixture()
  try {
    const opened = await registry.open({ path: sibling })
    assert.throws(() => registry.close({ workspace: PRIMARY_WORKSPACE_ID }), error => error.code === 'INVALID_ARGUMENT')
    assert.throws(
      () => registry.close({ workspace: opened.workspace_id }, { processes: 1, terminals: 0 }),
      error => error.code === 'BUSY',
    )
    // Once nothing is running there, closing is allowed without force.
    const closed = registry.close({ workspace: opened.workspace_id }, { processes: 0, terminals: 0 })
    assert.equal(closed.closed, true)
    assert.equal(registry.workspaces.size, 1)
  } finally {
    await cleanup()
  }
})

test('workspace_close with force closes despite running work', async () => {
  const { sibling, registry, cleanup } = await fixture()
  try {
    const opened = await registry.open({ path: sibling })
    const closed = registry.close({ workspace: opened.workspace_id, force: true }, { processes: 2, terminals: 1 })
    assert.equal(closed.closed, true)
    assert.equal(closed.running_processes, 2)
    assert.equal(closed.running_terminals, 1)
    assert.throws(() => registry.get(opened.workspace_id), error => error.code === 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('workspace_list reports the allowlist and can discover candidates', async () => {
  const { projects, sibling, registry, cleanup } = await fixture()
  try {
    await mkdir(join(sibling, '.git'), { recursive: true })
    await mkdir(join(projects, '.hidden-project'), { recursive: true })
    const plain = await registry.list({})
    assert.equal(plain.total, 1)
    assert.equal(plain.workspaces[0].primary, true)
    assert.deepEqual(plain.allowed_roots, [projects])
    assert.equal(plain.multi_root, true)
    assert.equal(plain.candidates, undefined)

    const discovered = await registry.list({ include_candidates: true })
    const names = discovered.candidates.map(entry => entry.name)
    assert.ok(names.includes('other-app'))
    assert.ok(names.includes('Shiro'))
    assert.ok(!names.includes('.hidden-project'), 'dot directories are not offered as projects')
    assert.equal(discovered.candidates.find(entry => entry.name === 'other-app').git_repository, true)

    const capped = await registry.list({ include_candidates: true, limit: 1 })
    assert.equal(capped.candidates.length, 1)
    assert.equal(capped.truncated, true)
  } finally {
    await cleanup()
  }
})

test('a workspace is pinned to the realpath it resolved at open time', async () => {
  const { base, projects, outside, registry, cleanup } = await fixture()
  try {
    // A legitimate symlink inside the allowlist, pointing at a real project.
    const target = join(projects, 'real-project')
    const link = join(projects, 'current')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'inside.txt'), 'the real project\n')
    await writeFile(join(outside, 'secret.txt'), 'must never be reachable\n')
    await symlink(target, link)

    const opened = await registry.open({ path: link })
    // Opening resolves the link once and stores the canonical directory, so the
    // workspace identity is a real path rather than a name someone else can
    // repoint later.
    assert.equal(opened.path, target)

    // Now move the link somewhere the allowlist would have rejected.
    await unlink(link)
    await symlink(outside, link)

    // The already-open workspace does not follow: it still resolves inside the
    // directory it was opened on.
    const sandbox = registry.sandboxFor(opened.workspace_id)
    assert.equal(sandbox.root, target)
    const read = await readEntry(sandbox, { path: 'inside.txt' })
    assert.equal(read.content, 'the real project\n')
    await rejects(readEntry(sandbox, { path: 'secret.txt' }), 'NOT_FOUND')
    assert.equal((await registry.list({})).workspaces.find(entry => entry.workspace_id === opened.workspace_id).path, target)

    // And re-opening through the repointed link is refused outright, because
    // the allowlist check happens against the resolved destination.
    await rejects(registry.open({ path: link }), 'OUTSIDE_SANDBOX')
    assert.ok(base.length > 0)
  } finally {
    await cleanup()
  }
})
