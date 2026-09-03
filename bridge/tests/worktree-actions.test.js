import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import {
  addWorktree, applySnapshot, createSnapshot, dropSnapshot, defaultWorktreePath,
  listSnapshots, listWorktrees, parseWorktreeList, removeWorktree,
} from '../src/worktree-actions.js'

async function repository() {
  const base = await mkdtemp(join(tmpdir(), 'shiro-wt-'))
  const root = join(base, 'repo')
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString()
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' })
  git('config', 'user.email', 'test@shiro.local')
  git('config', 'user.name', 'Shiro Test')
  await writeFile(join(root, 'app.txt'), 'original\n')
  git('add', 'app.txt')
  git('commit', '-m', 'seed')
  return { base, root, git, sandbox: new Sandbox(root), cleanup: () => rm(base, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('the porcelain listing parses into records', () => {
  const parsed = parseWorktreeList([
    'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
    'worktree /repo.worktrees/task', 'HEAD def456', 'branch refs/heads/task', 'locked in use', '',
    'worktree /gone', 'HEAD 000', 'detached', 'prunable gitdir file points to non-existent location', '',
  ].join('\n'))
  assert.equal(parsed.length, 3)
  assert.equal(parsed[0].branch, 'main')
  assert.equal(parsed[1].locked, true)
  assert.equal(parsed[1].lock_reason, 'in use')
  assert.equal(parsed[2].detached, true)
  assert.equal(parsed[2].prunable, true)
  assert.equal(parsed[0].bare, false)
})

test('a worktree is created on its own branch and listed', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    const before = await listWorktrees(sandbox)
    assert.equal(before.total, 1, 'the main checkout is itself a worktree')

    const destination = defaultWorktreePath(root, 'feature/login')
    assert.match(destination, /repo\.worktrees\/feature-login$/)

    const created = await addWorktree(sandbox, { branch: 'feature/login', destination })
    assert.equal(created.branch, 'feature/login')
    assert.ok(existsSync(join(destination, 'app.txt')), 'the new checkout has the repository content')

    const after = await listWorktrees(sandbox)
    assert.equal(after.total, 2)
    assert.ok(after.worktrees.some(entry => entry.branch === 'feature/login'))
  } finally {
    await cleanup()
  }
})

test('two worktrees isolate their working trees from each other', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    const a = defaultWorktreePath(root, 'task-a')
    const b = defaultWorktreePath(root, 'task-b')
    await addWorktree(sandbox, { branch: 'task-a', destination: a })
    await addWorktree(sandbox, { branch: 'task-b', destination: b })

    // This is the whole point of the feature: parallel tasks cannot see each
    // other's edits, and the main checkout sees neither.
    await writeFile(join(a, 'app.txt'), 'from task a\n')
    await writeFile(join(b, 'app.txt'), 'from task b\n')
    assert.equal(await readFile(join(a, 'app.txt'), 'utf8'), 'from task a\n')
    assert.equal(await readFile(join(b, 'app.txt'), 'utf8'), 'from task b\n')
    assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'original\n')
  } finally {
    await cleanup()
  }
})

test('a branch already checked out elsewhere is refused', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    await addWorktree(sandbox, { branch: 'taken', destination: defaultWorktreePath(root, 'taken') })
    await rejects(
      addWorktree(sandbox, { branch: 'taken', create_branch: false, destination: join(root, '..', 'second') }),
      'ALREADY_EXISTS',
    )
    // ...and so is an occupied destination.
    await rejects(
      addWorktree(sandbox, { branch: 'other', destination: defaultWorktreePath(root, 'taken') }),
      'ALREADY_EXISTS',
    )
  } finally {
    await cleanup()
  }
})

test('branch names are validated before git sees them', async () => {
  const { sandbox, cleanup } = await repository()
  try {
    for (const branch of ['', '  ', '-dash-start', 'has space', 'has..dots', 'ends.lock', 'semi;colon', '--upload-pack=x']) {
      await rejects(addWorktree(sandbox, { branch, destination: '/tmp/x' }), 'INVALID_ARGUMENT')
    }
    await rejects(addWorktree(sandbox, { branch: 'ok', destination: '' }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('a worktree with uncommitted work is not removed by accident', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    const path = defaultWorktreePath(root, 'dirty')
    await addWorktree(sandbox, { branch: 'dirty', destination: path })
    await writeFile(join(path, 'app.txt'), 'unsaved work\n')

    await assert.rejects(removeWorktree(sandbox, { worktree_path: path }), error => {
      assert.equal(error.code, 'CONFLICT')
      assert.match(error.message, /worktree_snapshot first/)
      return true
    })
    assert.ok(existsSync(path), 'the checkout survives a refused removal')

    const removed = await removeWorktree(sandbox, { worktree_path: path, force: true })
    assert.equal(removed.removed, true)
    assert.ok(!existsSync(path))
    assert.equal((await listWorktrees(sandbox)).total, 1)
  } finally {
    await cleanup()
  }
})

test('a snapshot captures tracked and untracked work without touching the tree', async () => {
  const { root, sandbox, git, cleanup } = await repository()
  try {
    await writeFile(join(root, 'app.txt'), 'edited\n')
    await writeFile(join(root, 'new-file.txt'), 'untracked but important\n')
    git('add', 'app.txt')
    const stagedBefore = git('diff', '--cached', '--name-only')

    const snapshot = await createSnapshot(sandbox, { label: 'before refactor' })
    assert.match(snapshot.snapshot_id, /^[0-9a-f]{12}$/)
    assert.equal(snapshot.files_changed, 2, 'the untracked file is in the snapshot too')

    // Nothing about the working tree or the index moved: a save point is not a stash.
    assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'edited\n')
    assert.equal(await readFile(join(root, 'new-file.txt'), 'utf8'), 'untracked but important\n')
    assert.equal(git('diff', '--cached', '--name-only'), stagedBefore)

    const listed = await listSnapshots(sandbox)
    assert.equal(listed.total, 1)
    assert.equal(listed.snapshots[0].snapshot_id, snapshot.snapshot_id)
    assert.equal(listed.snapshots[0].label, 'before refactor')
  } finally {
    await cleanup()
  }
})

test('a snapshot survives aggressive garbage collection', async () => {
  const { sandbox, git, root, cleanup } = await repository()
  try {
    await writeFile(join(root, 'app.txt'), 'work in progress\n')
    const snapshot = await createSnapshot(sandbox, {})
    // The ref is what stops the save point being collected.
    git('gc', '--prune=now', '--aggressive')
    assert.equal((await listSnapshots(sandbox)).total, 1)
    assert.ok(git('cat-file', '-t', snapshot.commit).startsWith('commit'))
  } finally {
    await cleanup()
  }
})

test('restoring a snapshot brings the work back after it was thrown away', async () => {
  const { root, sandbox, git, cleanup } = await repository()
  try {
    await writeFile(join(root, 'app.txt'), 'valuable edit\n')
    await writeFile(join(root, 'extra.txt'), 'new file\n')
    const snapshot = await createSnapshot(sandbox, { label: 'wip' })

    // Throw the work away, the way a bad command would.
    git('checkout', '--', 'app.txt')
    await rm(join(root, 'extra.txt'))
    assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'original\n')

    const restored = await applySnapshot(sandbox, sandbox, { snapshot_id: snapshot.snapshot_id })
    assert.equal(restored.applied, true)
    assert.equal(restored.files_changed, 2)
    assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'valuable edit\n')
    assert.equal(await readFile(join(root, 'extra.txt'), 'utf8'), 'new file\n')
  } finally {
    await cleanup()
  }
})

test('work hands off from the main checkout into a worktree', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    const path = defaultWorktreePath(root, 'handoff')
    await addWorktree(sandbox, { branch: 'handoff', destination: path })
    const target = new Sandbox(path)

    // Start the work locally...
    await writeFile(join(root, 'app.txt'), 'started here\n')
    await writeFile(join(root, 'notes.md'), 'plan\n')
    const snapshot = await createSnapshot(sandbox, { label: 'hand to worktree' })

    // ...and continue it in the isolated checkout. The two share an object
    // store, so the snapshot needs no transport between them.
    const handed = await applySnapshot(sandbox, target, { snapshot_id: snapshot.snapshot_id })
    assert.equal(handed.applied, true)
    assert.equal(await readFile(join(path, 'app.txt'), 'utf8'), 'started here\n')
    assert.equal(await readFile(join(path, 'notes.md'), 'utf8'), 'plan\n')

    // The source checkout is untouched by the handoff.
    assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'started here\n')
  } finally {
    await cleanup()
  }
})

test('work hands back from a worktree into the main checkout', async () => {
  const { root, sandbox, git, cleanup } = await repository()
  try {
    const path = defaultWorktreePath(root, 'back')
    await addWorktree(sandbox, { branch: 'back', destination: path })
    const target = new Sandbox(path)

    await writeFile(join(path, 'app.txt'), 'done in the worktree\n')
    const snapshot = await createSnapshot(target, { label: 'result' })
    assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'original\n', 'still isolated before the handoff')

    const handed = await applySnapshot(target, sandbox, { snapshot_id: snapshot.snapshot_id })
    assert.equal(handed.applied, true)
    assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'done in the worktree\n')
    assert.match(git('status', '--porcelain'), /app\.txt/)
  } finally {
    await cleanup()
  }
})

test('a snapshot that conflicts is refused rather than half-applied', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    const path = defaultWorktreePath(root, 'conflict')
    await addWorktree(sandbox, { branch: 'conflict', destination: path })
    const target = new Sandbox(path)

    await writeFile(join(root, 'app.txt'), 'source version\n')
    const snapshot = await createSnapshot(sandbox, {})

    // The target already changed the same line a different way.
    await writeFile(join(path, 'app.txt'), 'target version\n')
    await assert.rejects(applySnapshot(sandbox, target, { snapshot_id: snapshot.snapshot_id }), error => {
      assert.equal(error.code, 'GIT_CONFLICT')
      assert.match(error.message, /does not apply cleanly/)
      return true
    })
    // The target keeps exactly what it had: nothing was written before the check.
    assert.equal(await readFile(join(path, 'app.txt'), 'utf8'), 'target version\n')
  } finally {
    await cleanup()
  }
})

test('an empty snapshot applies as a no-op', async () => {
  const { sandbox, cleanup } = await repository()
  try {
    const snapshot = await createSnapshot(sandbox, { label: 'clean tree' })
    assert.equal(snapshot.files_changed, 0)
    const applied = await applySnapshot(sandbox, sandbox, { snapshot_id: snapshot.snapshot_id })
    assert.equal(applied.empty, true)
    assert.equal(applied.files_changed, 0)
  } finally {
    await cleanup()
  }
})

test('unknown and malformed snapshot ids are rejected distinctly', async () => {
  const { sandbox, cleanup } = await repository()
  try {
    await rejects(applySnapshot(sandbox, sandbox, { snapshot_id: 'not a snapshot' }), 'INVALID_ARGUMENT')
    await rejects(applySnapshot(sandbox, sandbox, { snapshot_id: '' }), 'INVALID_ARGUMENT')
    // A well-formed id that does not exist is NOT_FOUND, not a git error dump.
    await rejects(applySnapshot(sandbox, sandbox, { snapshot_id: 'abcdef123456' }), 'NOT_FOUND')
    await rejects(dropSnapshot(sandbox, { snapshot_id: 'abcdef123456' }), 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('a snapshot can be dropped when it is no longer wanted', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    await writeFile(join(root, 'app.txt'), 'temp\n')
    const snapshot = await createSnapshot(sandbox, {})
    assert.equal((await listSnapshots(sandbox)).total, 1)

    const dropped = await dropSnapshot(sandbox, { snapshot_id: snapshot.snapshot_id })
    assert.equal(dropped.deleted, true)
    assert.equal((await listSnapshots(sandbox)).total, 0)
    await rejects(applySnapshot(sandbox, sandbox, { snapshot_id: snapshot.snapshot_id }), 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('worktree actions on a directory that is not a repository fail clearly', async () => {
  const base = await mkdtemp(join(tmpdir(), 'shiro-not-repo-'))
  try {
    const sandbox = new Sandbox(base)
    await rejects(listWorktrees(sandbox), 'UNSUPPORTED')
    await rejects(createSnapshot(sandbox, {}), 'UNSUPPORTED')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
