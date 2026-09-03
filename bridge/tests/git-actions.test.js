import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import { runGit } from '../src/git-commands.js'
import * as git from '../src/git-actions.js'

// Every git action runs against a throwaway repository fixture: no network, no
// user configuration, and nothing that could touch the real Shiro checkout.
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'shiro-git-'))
  const run = async (...argv) => {
    const result = await runGit(root, argv)
    assert.equal(result.exitCode, 0, `git ${argv.join(' ')} failed: ${result.stderr}`)
    return result
  }
  await run('init', '--initial-branch=main')
  await run('config', 'user.email', 'fixture@example.invalid')
  await run('config', 'user.name', 'Shiro Fixture')
  await run('config', 'commit.gpgsign', 'false')
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await run('add', 'README.md')
  await run('commit', '--message', 'initial commit')
  return { root, run, sandbox: new Sandbox(root), cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('git_status and git_repo_info normalize the working tree', async () => {
  const { root, run, sandbox, cleanup } = await repository()
  try {
    const clean = await git.status(sandbox, {})
    assert.equal(clean.branch, 'main')
    assert.equal(clean.clean, true)
    assert.equal(clean.total_changes, 0)
    assert.match(clean.head, /^[0-9a-f]{40}$/)

    await writeFile(join(root, 'README.md'), '# fixture\nchanged\n')
    await writeFile(join(root, 'new.txt'), 'new\n')
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'staged.txt'), 'staged\n')
    await run('add', 'sub/staged.txt')

    const dirty = await git.status(sandbox, {})
    assert.equal(dirty.clean, false)
    assert.equal(dirty.counts.staged, 1)
    assert.equal(dirty.counts.unstaged, 1)
    assert.equal(dirty.counts.untracked, 1)
    const readme = dirty.changes.find(change => change.path === 'README.md')
    assert.equal(readme.status, 'modified')
    assert.equal(readme.staged, false)
    assert.equal(readme.unstaged, true)
    assert.equal(dirty.changes.find(change => change.path === 'new.txt').status, 'untracked')
    assert.equal(dirty.changes.find(change => change.path === 'sub/staged.txt').status, 'added')

    const limited = await git.status(sandbox, { limit: 1 })
    assert.equal(limited.changes.length, 1)
    assert.equal(limited.truncated, true)
    assert.equal(limited.total_changes, 3)

    const withoutUntracked = await git.status(sandbox, { untracked: false })
    assert.equal(withoutUntracked.counts.untracked, 0)

    const info = await git.repoInfo(sandbox, {})
    assert.equal(info.is_repository, true)
    assert.equal(info.root, '.')
    assert.equal(info.branch, 'main')
    assert.equal(info.dirty, true)
    assert.deepEqual(info.remotes, [])
  } finally {
    await cleanup()
  }
})

test('git_remote_list redacts credentials embedded in remote URLs', async () => {
  const { run, sandbox, cleanup } = await repository()
  try {
    await run('remote', 'add', 'origin', 'https://someuser:ghp_012345678901234567890123456789012345@example.invalid/repo.git')
    const listed = await git.remoteList(sandbox, {})
    assert.equal(listed.remotes.length, 1)
    assert.ok(!listed.remotes[0].fetch_url.includes('ghp_012345678901234567890123456789012345'), 'the token must not leave the bridge')
    assert.ok(!listed.remotes[0].push_url.includes('ghp_012345678901234567890123456789012345'))
    assert.match(listed.remotes[0].fetch_url, /\*\*\*@example\.invalid/)

    const info = await git.repoInfo(sandbox, {})
    assert.ok(!JSON.stringify(info).includes('ghp_012345678901234567890123456789012345'))
  } finally {
    await cleanup()
  }
})

test('git_diff bounds the patch and reports per-file stats', async () => {
  const { root, run, sandbox, cleanup } = await repository()
  try {
    await writeFile(join(root, 'README.md'), `# fixture\n${'line\n'.repeat(400)}`)
    const unstaged = await git.diff(sandbox, {})
    assert.equal(unstaged.files_changed, 1)
    assert.equal(unstaged.files[0].path, 'README.md')
    assert.equal(unstaged.additions, 400)
    assert.match(unstaged.patch, /^diff --git/)

    const statOnly = await git.diff(sandbox, { stat_only: true })
    assert.equal(statOnly.patch, undefined)
    assert.equal(statOnly.files_changed, 1)

    const bounded = await git.diff(sandbox, { max_bytes: 1000 })
    assert.equal(bounded.truncated, true)
    assert.equal(bounded.patch.length, 1000)

    assert.equal((await git.diff(sandbox, { staged: true })).files_changed, 0)
    await run('add', 'README.md')
    assert.equal((await git.diff(sandbox, { staged: true })).files_changed, 1)
    assert.equal((await git.diff(sandbox, {})).files_changed, 0)

    await rejects(git.diff(sandbox, { paths: ['../outside'] }), 'OUTSIDE_SANDBOX')
    await rejects(git.diff(sandbox, { head: 'main' }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('git_log and git_show page and describe commits', async () => {
  const { root, run, sandbox, cleanup } = await repository()
  try {
    for (const index of [1, 2, 3]) {
      await writeFile(join(root, `file${index}.txt`), `body ${index}\n`)
      await run('add', `file${index}.txt`)
      await run('commit', '--message', `commit ${index}`)
    }
    const page = await git.log(sandbox, { limit: 2 })
    assert.equal(page.commits.length, 2)
    assert.equal(page.commits[0].subject, 'commit 3')
    assert.equal(page.truncated, true)
    assert.equal(page.next_skip, 2)
    const rest = await git.log(sandbox, { limit: 2, skip: page.next_skip })
    assert.equal(rest.commits[0].subject, 'commit 1')
    assert.equal(rest.truncated, false)

    const scoped = await git.log(sandbox, { paths: ['file2.txt'] })
    assert.deepEqual(scoped.commits.map(commit => commit.subject), ['commit 2'])

    const shown = await git.show(sandbox, {})
    assert.equal(shown.commit.subject, 'commit 3')
    assert.equal(shown.files_changed, 1)
    assert.match(shown.patch, /body 3/)
    assert.equal((await git.show(sandbox, { include_patch: false })).patch, undefined)

    await rejects(git.show(sandbox, { ref: 'no-such-ref' }), 'NOT_FOUND')
    await rejects(git.log(sandbox, { ref: '--output=/tmp/x' }), 'INVALID_ARGUMENT')
    await rejects(git.log(sandbox, { ref: 'main..HEAD' }), 'INVALID_ARGUMENT')
    // Ancestry syntax stays usable for read-only revisions.
    assert.equal((await git.log(sandbox, { ref: 'HEAD~1', limit: 1 })).commits[0].subject, 'commit 2')
  } finally {
    await cleanup()
  }
})

test('branch, checkout, add, commit and compare form a working local flow', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    const created = await git.branchCreate(sandbox, { name: 'feature', checkout: true })
    assert.equal(created.created, true)
    assert.equal(created.checked_out, true)

    // Creating the same branch again is a conflict, unless it is a checkout.
    await rejects(git.branchCreate(sandbox, { name: 'feature' }), 'ALREADY_EXISTS')
    assert.equal((await git.branchCreate(sandbox, { name: 'feature', checkout: true })).created, false)

    await writeFile(join(root, 'feature.txt'), 'feature work\n')
    await rejects(git.add(sandbox, {}), 'INVALID_ARGUMENT')
    await rejects(git.add(sandbox, { paths: ['../escape.txt'] }), 'OUTSIDE_SANDBOX')
    const staged = await git.add(sandbox, { paths: ['feature.txt'] })
    assert.equal(staged.staged, 1)

    await rejects(git.commit(sandbox, { message: 'x', expected_head: '0000000' }), 'CONFLICT')
    const committed = await git.commit(sandbox, { message: 'add feature' })
    assert.match(committed.sha, /^[0-9a-f]{40}$/)
    assert.equal(committed.commit.subject, 'add feature')

    // The expected_head guard passes once the caller knows the real HEAD.
    await writeFile(join(root, 'feature.txt'), 'more\n')
    const second = await git.commit(sandbox, { message: 'more feature', all: true, expected_head: committed.sha })
    assert.notEqual(second.sha, committed.sha)

    await rejects(git.commit(sandbox, { message: 'nothing staged' }), 'CONFLICT')

    const branches = await git.branchList(sandbox, {})
    assert.equal(branches.current, 'feature')
    assert.deepEqual(branches.branches.map(branch => branch.name).sort(), ['feature', 'main'])

    const comparison = await git.compare(sandbox, { base: 'main', head: 'feature' })
    assert.equal(comparison.ahead, 2)
    assert.equal(comparison.behind, 0)
    assert.equal(comparison.files_changed, 1)
    assert.deepEqual(comparison.commits.map(commit => commit.subject), ['more feature', 'add feature'])

    const switched = await git.checkout(sandbox, { ref: 'main' })
    assert.equal(switched.branch, 'main')
    assert.equal(switched.detached, false)
    const detached = await git.checkout(sandbox, { ref: committed.sha, detach: true })
    assert.equal(detached.detached, true)
    await rejects(git.checkout(sandbox, { ref: 'ghost-branch' }), 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('destructive git actions refuse to run without explicit confirmation', async () => {
  const { root, run, sandbox, cleanup } = await repository()
  try {
    await writeFile(join(root, 'README.md'), '# fixture\nlocal edit\n')

    // git_restore discards work: no confirm, no action, and the file survives.
    await rejects(git.restore(sandbox, { paths: ['README.md'] }), 'PERMISSION_REQUIRED')
    assert.match(await readFileText(root, 'README.md'), /local edit/)
    const restored = await git.restore(sandbox, { paths: ['README.md'], confirm: true })
    assert.equal(restored.clean, true)
    assert.ok(!(await readFileText(root, 'README.md')).includes('local edit'))
    await rejects(git.restore(sandbox, { paths: [], confirm: true }), 'INVALID_ARGUMENT')

    // reset --hard needs confirmation; soft and mixed do not.
    await writeFile(join(root, 'second.txt'), 'second\n')
    await run('add', 'second.txt')
    await run('commit', '--message', 'second commit')
    await writeFile(join(root, 'second.txt'), 'uncommitted\n')
    await rejects(git.reset(sandbox, { mode: 'hard', ref: 'HEAD' }), 'PERMISSION_REQUIRED')
    assert.match(await readFileText(root, 'second.txt'), /uncommitted/)

    const soft = await git.reset(sandbox, { mode: 'soft', ref: 'HEAD~1' })
    assert.notEqual(soft.head, soft.previous_head)
    const hard = await git.reset(sandbox, { mode: 'hard', ref: 'HEAD', confirm: true })
    assert.equal(hard.clean, true)

    // rebase rewrites history, so action=start is gated too.
    await rejects(git.rebase(sandbox, { action: 'start', onto: 'main' }), 'PERMISSION_REQUIRED')
    await rejects(git.rebase(sandbox, { action: 'abort' }), 'CONFLICT')

    // push leaves the machine: gated, and the refusal names the exact operation.
    await assert.rejects(git.push(sandbox, { remote: 'origin' }), error => {
      assert.equal(error.code, 'PERMISSION_REQUIRED')
      assert.match(error.message, /Push branch "main" to remote "origin"/)
      return true
    })
    await rejects(git.push(sandbox, { remote: 'origin; rm -rf /', confirm: true }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('git_merge surfaces conflicts as GIT_CONFLICT and can abort them', async () => {
  const { root, run, sandbox, cleanup } = await repository()
  try {
    await run('switch', '--create', 'left')
    await writeFile(join(root, 'shared.txt'), 'left side\n')
    await run('add', 'shared.txt')
    await run('commit', '--message', 'left change')

    await run('switch', 'main')
    await run('switch', '--create', 'right')
    await writeFile(join(root, 'shared.txt'), 'right side\n')
    await run('add', 'shared.txt')
    await run('commit', '--message', 'right change')

    await assert.rejects(git.merge(sandbox, { ref: 'left' }), error => {
      assert.equal(error.code, 'GIT_CONFLICT')
      assert.deepEqual(error.details.conflicts, ['shared.txt'])
      return true
    })
    assert.equal((await git.merge(sandbox, { action: 'abort' })).aborted, true)
    assert.equal((await git.status(sandbox, {})).counts.unmerged, 0)

    // A clean fast-forward merge still works.
    await run('switch', 'main')
    const merged = await git.merge(sandbox, { ref: 'left' })
    assert.equal(merged.merged, true)
    assert.equal((await git.compare(sandbox, { base: 'left', head: 'main' })).ahead, 0)
  } finally {
    await cleanup()
  }
})

test('tags are created once and listed newest first', async () => {
  const { sandbox, cleanup } = await repository()
  try {
    assert.deepEqual((await git.tagList(sandbox, {})).tags, [])
    const lightweight = await git.tagCreate(sandbox, { name: 'v0.1.0' })
    assert.equal(lightweight.annotated, false)
    const annotated = await git.tagCreate(sandbox, { name: 'v0.2.0', message: 'second release' })
    assert.equal(annotated.annotated, true)
    await rejects(git.tagCreate(sandbox, { name: 'v0.1.0' }), 'ALREADY_EXISTS')
    const listed = await git.tagList(sandbox, {})
    assert.equal(listed.total, 2)
    assert.ok(listed.tags.some(tag => tag.name === 'v0.2.0' && tag.subject === 'second release'))
  } finally {
    await cleanup()
  }
})

test('git actions report a non-repository directory as UNSUPPORTED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-nogit-'))
  try {
    const sandbox = new Sandbox(root)
    await rejects(git.status(sandbox, {}), 'UNSUPPORTED')
    await rejects(git.repoInfo(sandbox, {}), 'UNSUPPORTED')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function readFileText(root, relativePath) {
  const { readFile } = await import('node:fs/promises')
  return await readFile(join(root, relativePath), 'utf8')
}
