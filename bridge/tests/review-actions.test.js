import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import { createSnapshot } from '../src/worktree-actions.js'
import {
  buildHunkPatch, checkFindings, parseUnifiedDiff, PRIORITIES, reviewDiff, revertHunk, stageHunk,
} from '../src/review-actions.js'

const LINES = count => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

async function repository() {
  const base = await mkdtemp(join(tmpdir(), 'shiro-review-'))
  const root = join(base, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' })
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString()
  git('config', 'user.email', 'test@shiro.local')
  git('config', 'user.name', 'Shiro Test')
  await writeFile(join(root, 'app.txt'), `${LINES(30)}\n`)
  await writeFile(join(root, 'other.txt'), 'untouched\n')
  git('add', '.')
  git('commit', '-m', 'seed')
  return { base, root, git, sandbox: new Sandbox(root), cleanup: () => rm(base, { recursive: true, force: true }) }
}

/** Edit two far-apart regions so the diff has two independent hunks. */
async function twoHunks(root) {
  const lines = LINES(30).split('\n')
  lines[2] = 'line 3 CHANGED AT TOP'
  lines[25] = 'line 26 CHANGED AT BOTTOM'
  await writeFile(join(root, 'app.txt'), `${lines.join('\n')}\n`)
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('a unified diff parses into files and addressable hunks', () => {
  const files = parseUnifiedDiff([
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' context',
    '-old',
    '+new',
    '@@ -20,2 +20,3 @@',
    ' more',
    '+added',
    'diff --git a/b.bin b/b.bin',
    'Binary files a/b.bin and b/b.bin differ',
  ].join('\n'))
  assert.equal(files.length, 2)
  assert.equal(files[0].path, 'a.txt')
  assert.equal(files[0].hunks.length, 2)
  assert.equal(files[0].hunks[0].additions, 1)
  assert.equal(files[0].hunks[0].deletions, 1)
  assert.equal(files[0].hunks[1].new_start, 20)
  assert.equal(files[1].binary, true)
  // Ids are distinct and content-addressed.
  assert.notEqual(files[0].hunks[0].hunk_id, files[0].hunks[1].hunk_id)
  assert.match(files[0].hunks[0].hunk_id, /^h\d+\.[0-9a-f]{10}$/)
  // A rebuilt one-hunk patch keeps the file header.
  assert.match(buildHunkPatch(files[0], files[0].hunks[0]), /^diff --git a\/a\.txt b\/a\.txt\n[\s\S]*@@ -1,3 \+1,3 @@/)
})

test('review_diff splits a change into hunks that can be addressed', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    await twoHunks(root)
    const diff = await reviewDiff(sandbox, {})
    assert.equal(diff.against, 'HEAD')
    assert.equal(diff.file_count, 1)
    assert.equal(diff.hunk_count, 2, 'two far-apart edits are two hunks')
    const [top, bottom] = diff.files[0].hunks
    assert.match(top.body, /CHANGED AT TOP/)
    assert.match(bottom.body, /CHANGED AT BOTTOM/)
    assert.notEqual(top.hunk_id, bottom.hunk_id)
  } finally {
    await cleanup()
  }
})

test('one hunk can be staged while the other stays unstaged', async () => {
  const { root, sandbox, git, cleanup } = await repository()
  try {
    await twoHunks(root)
    const diff = await reviewDiff(sandbox, {})
    const [top, bottom] = diff.files[0].hunks

    const staged = await stageHunk(sandbox, { hunk_id: top.hunk_id })
    assert.equal(staged.staged, true)
    assert.equal(staged.path, 'app.txt')

    // Exactly the top edit is staged; the bottom one is still only in the tree.
    assert.match(git('diff', '--cached'), /CHANGED AT TOP/)
    assert.doesNotMatch(git('diff', '--cached'), /CHANGED AT BOTTOM/)
    assert.match(git('diff'), /CHANGED AT BOTTOM/)
    assert.ok(bottom.hunk_id.length > 0)
  } finally {
    await cleanup()
  }
})

test('one hunk can be reverted without touching the other', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    await twoHunks(root)
    const diff = await reviewDiff(sandbox, {})
    const [top, bottom] = diff.files[0].hunks

    const reverted = await revertHunk(sandbox, { hunk_id: bottom.hunk_id })
    assert.equal(reverted.reverted, true)

    const content = await readFile(join(root, 'app.txt'), 'utf8')
    assert.match(content, /CHANGED AT TOP/, 'the other hunk survives')
    assert.doesNotMatch(content, /CHANGED AT BOTTOM/, 'this one is undone')
    assert.ok(top.hunk_id.length > 0)
  } finally {
    await cleanup()
  }
})

test('a stale hunk id is refused instead of applied to whatever moved there', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    await twoHunks(root)
    const stale = (await reviewDiff(sandbox, {})).files[0].hunks[0].hunk_id

    // The change is rewritten, so the old id no longer describes it.
    await writeFile(join(root, 'app.txt'), `${LINES(30)}\nsomething else entirely\n`)
    await assert.rejects(stageHunk(sandbox, { hunk_id: stale }), error => {
      assert.equal(error.code, 'CONFLICT')
      assert.match(error.message, /run review_diff again/)
      return true
    })
    await rejects(revertHunk(sandbox, { hunk_id: stale }), 'CONFLICT')
    await rejects(stageHunk(sandbox, { hunk_id: '' }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('a review can be scoped to exactly what a turn changed', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    // Work that happened before the turn.
    await writeFile(join(root, 'other.txt'), 'edited before the turn\n')
    const snapshot = await createSnapshot(sandbox, { label: 'before the turn' })

    // The turn's own work.
    await twoHunks(root)

    const sinceSnapshot = await reviewDiff(sandbox, { since_snapshot: snapshot.snapshot_id })
    assert.match(sinceSnapshot.against, /^snapshot /)
    assert.deepEqual(sinceSnapshot.files.map(file => file.path), ['app.txt'], 'only what changed after the snapshot')

    const sinceHead = await reviewDiff(sandbox, {})
    assert.deepEqual(sinceHead.files.map(file => file.path).sort(), ['app.txt', 'other.txt'])

    await rejects(reviewDiff(sandbox, { since_snapshot: 'not-an-id' }), 'INVALID_ARGUMENT')
    await rejects(reviewDiff(sandbox, { since_snapshot: 'abcdef123456' }), 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('the review scope can be the index or a revision, and paths narrow it', async () => {
  const { root, sandbox, git, cleanup } = await repository()
  try {
    await twoHunks(root)
    await writeFile(join(root, 'other.txt'), 'also changed\n')
    git('add', 'other.txt')

    const staged = await reviewDiff(sandbox, { staged: true })
    assert.equal(staged.against, 'the index')
    assert.deepEqual(staged.files.map(file => file.path), ['other.txt'])

    const narrowed = await reviewDiff(sandbox, { paths: ['app.txt'] })
    assert.deepEqual(narrowed.files.map(file => file.path), ['app.txt'])

    await rejects(reviewDiff(sandbox, { base: '--output=/tmp/x' }), 'INVALID_ARGUMENT')
    await rejects(reviewDiff(sandbox, { paths: ['--output=/tmp/x'] }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('findings are sorted by priority and checked against the change', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    await twoHunks(root)
    const checked = await checkFindings(sandbox, {
      findings: [
        { file: 'app.txt', line: 3, priority: 'nit', summary: 'naming' },
        { file: 'app.txt', line: 26, priority: 'blocker', summary: 'off by one' },
        { file: 'never-touched.txt', line: 1, priority: 'high', summary: 'this file is not in the change' },
        { file: 'app.txt', summary: 'no line given' },
      ],
    })
    assert.deepEqual(checked.findings.map(finding => finding.priority), ['blocker', 'high', 'medium', 'nit'])
    assert.equal(checked.findings[0].in_changed_hunk, true, 'line 26 is inside the bottom hunk')

    // The point of checking: a finding about untouched code is called out.
    const stray = checked.findings.find(finding => finding.file === 'never-touched.txt')
    assert.equal(stray.in_changed_file, false)
    assert.match(stray.note, /not part of the change/)
    assert.equal(checked.outside_change, 1)
    assert.equal(checked.by_priority.blocker, 1)
    assert.equal(checked.total, 4)
  } finally {
    await cleanup()
  }
})

test('finding input is validated rather than trusted', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    await twoHunks(root)
    await rejects(checkFindings(sandbox, { findings: [] }), 'INVALID_ARGUMENT')
    await rejects(checkFindings(sandbox, { findings: [{ file: '', summary: 'x' }] }), 'INVALID_ARGUMENT')
    await rejects(checkFindings(sandbox, { findings: [{ file: 'app.txt', summary: '  ' }] }), 'INVALID_ARGUMENT')
    // An unknown priority falls back to medium instead of being passed through.
    const checked = await checkFindings(sandbox, { findings: [{ file: 'app.txt', priority: 'catastrophic', summary: 'x' }] })
    assert.equal(checked.findings[0].priority, 'medium')
    assert.deepEqual(PRIORITIES, ['blocker', 'high', 'medium', 'low', 'nit'])
  } finally {
    await cleanup()
  }
})

test('a clean tree reviews as an empty change', async () => {
  const { sandbox, cleanup } = await repository()
  try {
    const diff = await reviewDiff(sandbox, {})
    assert.equal(diff.file_count, 0)
    assert.equal(diff.hunk_count, 0)
    assert.equal(diff.truncated, false)
  } finally {
    await cleanup()
  }
})

test('a file the agent just created is in the review, not missing from it', async () => {
  const { root, sandbox, git, cleanup } = await repository()
  try {
    await twoHunks(root)
    // The most review-worthy file in a turn is usually the one that did not
    // exist before it. `git diff HEAD` cannot see it, so review used to be
    // blind to exactly that file.
    await writeFile(join(root, 'created-by-the-turn.js'), 'export const value = 1\nexport const other = 2\n')

    const diff = await reviewDiff(sandbox, {})
    const created = diff.files.find(file => file.path === 'created-by-the-turn.js')
    assert.notEqual(created, undefined, 'the new file is part of the change')
    assert.equal(created.hunks.length, 1)
    assert.match(created.hunks[0].body, /export const value = 1/)
    assert.equal(created.hunks[0].additions, 2)

    // And it must be addressable like any other hunk, or the id this bridge
    // just handed out would read as stale.
    const staged = await stageHunk(sandbox, { hunk_id: created.hunks[0].hunk_id })
    assert.equal(staged.staged, true)
    assert.match(git('diff', '--cached', '--name-only'), /created-by-the-turn\.js/)

    // Ignored files stay out: .gitignore is the repository's own answer to
    // "is this part of the work".
    await writeFile(join(root, '.gitignore'), 'ignored.log\n')
    await writeFile(join(root, 'ignored.log'), 'noise\n')
    const second = await reviewDiff(sandbox, {})
    assert.equal(second.files.some(file => file.path === 'ignored.log'), false)
    assert.equal(second.files.some(file => file.path === '.gitignore'), true, 'but the gitignore itself is a new file')
  } finally {
    await cleanup()
  }
})

test('an untracked hunk can be reverted, which deletes what the turn added', async () => {
  const { root, sandbox, cleanup } = await repository()
  try {
    await writeFile(join(root, 'scratch.txt'), 'one\ntwo\n')
    const diff = await reviewDiff(sandbox, {})
    const created = diff.files.find(file => file.path === 'scratch.txt')
    const reverted = await revertHunk(sandbox, { hunk_id: created.hunks[0].hunk_id })
    assert.equal(reverted.reverted, true)
    await assert.rejects(readFile(join(root, 'scratch.txt'), 'utf8'), /ENOENT/, 'reverting a whole new file removes it')
  } finally {
    await cleanup()
  }
})

test('untracked files are excluded where they would be wrong, and on request', async () => {
  const { root, sandbox, git, cleanup } = await repository()
  try {
    await twoHunks(root)
    await writeFile(join(root, 'new.txt'), 'fresh\n')

    // --staged asks what is in the index; an untracked file is by definition not.
    git('add', 'app.txt')
    const staged = await reviewDiff(sandbox, { staged: true })
    assert.equal(staged.files.some(file => file.path === 'new.txt'), false)

    // A revision comparison is between commits, where "untracked" has no meaning.
    const againstBase = await reviewDiff(sandbox, { base: 'HEAD' })
    assert.equal(againstBase.files.some(file => file.path === 'new.txt'), false)

    // And a caller can opt out.
    const without = await reviewDiff(sandbox, { include_untracked: false })
    assert.equal(without.files.some(file => file.path === 'new.txt'), false)
    const withThem = await reviewDiff(sandbox, {})
    assert.equal(withThem.files.some(file => file.path === 'new.txt'), true)
  } finally {
    await cleanup()
  }
})
