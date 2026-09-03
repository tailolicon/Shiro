import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import {
  copyPath, createFile, deletePath, globToRegExp, listDirectory,
  makeDirectory, movePath, readEntry, searchText, statPath, updateFile,
} from '../src/fs-actions.js'

const sha256 = value => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fs-'))
  return { root, sandbox: new Sandbox(root), cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('fs_read pages by bytes and by lines with stable truncation metadata', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    const body = ['alpha', 'beta', 'gamma', 'delta'].join('\n')
    await writeFile(join(root, 'poem.txt'), body)

    const whole = await readEntry(sandbox, { path: 'poem.txt' })
    assert.equal(whole.content, body)
    assert.equal(whole.truncated, false)
    assert.equal(whole.eof, true)
    assert.equal(whole.sha256, sha256(body))

    const firstPage = await readEntry(sandbox, { path: 'poem.txt', max_bytes: 6 })
    assert.equal(firstPage.content, 'alpha\n')
    assert.equal(firstPage.truncated, true)
    assert.equal(firstPage.next_offset, 6)
    const secondPage = await readEntry(sandbox, { path: 'poem.txt', offset: firstPage.next_offset })
    assert.equal(secondPage.content, 'beta\ngamma\ndelta')
    assert.equal(secondPage.truncated, false)

    const lines = await readEntry(sandbox, { path: 'poem.txt', start_line: 2, end_line: 3 })
    assert.equal(lines.mode, 'lines')
    assert.equal(lines.content, 'beta\ngamma')
    assert.equal(lines.line_count, 4)

    const boundedLines = await readEntry(sandbox, { path: 'poem.txt', start_line: 1, end_line: 4, max_bytes: 7 })
    assert.equal(boundedLines.truncated, true)
    assert.equal(boundedLines.next_start_line, 2)

    // Binary-safe reads round-trip through base64.
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 253, 254, 255]))
    const blob = await readEntry(sandbox, { path: 'blob.bin', encoding: 'base64' })
    assert.deepEqual([...Buffer.from(blob.content, 'base64')], [0, 1, 2, 253, 254, 255])

    await rejects(readEntry(sandbox, { path: 'missing.txt' }), 'NOT_FOUND')
    await mkdir(join(root, 'dir'))
    await rejects(readEntry(sandbox, { path: 'dir' }), 'INVALID_ARGUMENT')
    await rejects(readEntry(sandbox, { path: 'poem.txt', offset: 9999 }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('fs_list paginates deterministically, filters by glob, and skips heavy directories', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await mkdir(join(root, 'src', 'inner'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'noise')
    for (const name of ['a.js', 'b.js', 'c.txt']) await writeFile(join(root, 'src', name), name)
    await writeFile(join(root, 'src', 'inner', 'd.js'), 'd')
    await writeFile(join(root, '.hidden'), 'x')

    const shallow = await listDirectory(sandbox, { path: 'src' })
    assert.deepEqual(shallow.entries.map(entry => entry.name), ['a.js', 'b.js', 'c.txt', 'inner'])

    const deep = await listDirectory(sandbox, { path: '.', recursive: true, depth: 4 })
    const paths = deep.entries.map(entry => entry.path)
    assert.ok(paths.includes('src/inner/d.js'))
    assert.ok(!paths.some(path => path.startsWith('node_modules')), 'node_modules must be skipped by default')
    assert.ok(!paths.includes('.hidden'), 'hidden entries are skipped by default')

    const withIgnored = await listDirectory(sandbox, { path: '.', recursive: true, depth: 4, include_ignored: true, include_hidden: true })
    assert.ok(withIgnored.entries.some(entry => entry.path === 'node_modules/pkg/index.js'))
    assert.ok(withIgnored.entries.some(entry => entry.path === '.hidden'))

    const globbed = await listDirectory(sandbox, { path: '.', recursive: true, depth: 4, glob: ['**/*.js'] })
    assert.deepEqual(globbed.entries.map(entry => entry.path).sort(), ['src/a.js', 'src/b.js', 'src/inner/d.js'])

    const page = await listDirectory(sandbox, { path: 'src', limit: 2 })
    assert.equal(page.truncated, true)
    assert.equal(page.next_cursor, '2')
    const rest = await listDirectory(sandbox, { path: 'src', limit: 2, cursor: page.next_cursor })
    assert.deepEqual(rest.entries.map(entry => entry.name), ['c.txt', 'inner'])
    assert.equal(rest.truncated, false)

    await rejects(listDirectory(sandbox, { path: 'src/a.js' }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('fs_stat reports type, mode, hash and symlink targets', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'file.txt'), 'body')
    await symlink(join(root, 'file.txt'), join(root, 'link.txt'))

    const file = await statPath(sandbox, { path: 'file.txt', include_hash: true })
    assert.equal(file.type, 'file')
    assert.equal(file.size, 4)
    assert.equal(file.sha256, sha256('body'))
    assert.equal(file.is_symlink, false)

    const withoutHash = await statPath(sandbox, { path: 'file.txt' })
    assert.equal(withoutHash.sha256, undefined)

    const followed = await statPath(sandbox, { path: 'link.txt' })
    assert.equal(followed.is_symlink, true)
    assert.equal(followed.type, 'file')
    assert.equal(followed.symlink_target, join(root, 'file.txt'))

    const unfollowed = await statPath(sandbox, { path: 'link.txt', follow: false })
    assert.equal(unfollowed.type, 'symlink')

    await rejects(statPath(sandbox, { path: 'nope' }), 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('fs_search bounds matches per file and overall, and skips binaries', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    await mkdir(join(root, 'pkg'))
    await writeFile(join(root, 'pkg', 'one.js'), 'const needle = 1\nconst needle = 2\nconst needle = 3\n')
    await writeFile(join(root, 'pkg', 'two.md'), 'no match here\nNEEDLE upper\n')
    await writeFile(join(root, 'pkg', 'bin.dat'), Buffer.from([110, 101, 101, 100, 108, 101, 0, 1]))

    const all = await searchText(sandbox, { query: 'needle' })
    assert.equal(all.match_count, 4)
    assert.equal(all.files_skipped, 1, 'the binary file must be skipped, not searched')

    const sensitive = await searchText(sandbox, { query: 'needle', case_sensitive: true })
    assert.equal(sensitive.match_count, 3)

    const perFile = await searchText(sandbox, { query: 'needle', max_matches_per_file: 1 })
    assert.equal(perFile.match_count, 2)

    const capped = await searchText(sandbox, { query: 'needle', max_results: 2 })
    assert.equal(capped.match_count, 2)
    assert.equal(capped.truncated, true)

    const globbed = await searchText(sandbox, { query: 'needle', glob: ['**/*.md'] })
    assert.deepEqual(globbed.matches.map(match => match.path), ['pkg/two.md'])

    const regex = await searchText(sandbox, { query: 'needle = [23]', regex: true })
    assert.deepEqual(regex.matches.map(match => match.line), [2, 3])

    const context = await searchText(sandbox, { query: 'needle = 2', regex: true, context_lines: 1 })
    assert.deepEqual(context.matches[0].before, ['const needle = 1'])
    assert.deepEqual(context.matches[0].after, ['const needle = 3'])

    await rejects(searchText(sandbox, { query: '(' , regex: true }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('fs write actions are idempotent, atomic and concurrency-checked', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    const created = await createFile(sandbox, { path: 'deep/new.txt', content: 'one', create_parents: true })
    assert.equal(created.created, true)
    assert.equal(created.sha256, sha256('one'))
    assert.equal(await readFile(join(root, 'deep', 'new.txt'), 'utf8'), 'one')

    // Re-creating with identical content is a safe no-op, not a conflict.
    const again = await createFile(sandbox, { path: 'deep/new.txt', content: 'one' })
    assert.equal(again.created, false)
    assert.equal(again.unchanged, true)

    // Different content is an explicit conflict unless overwrite is requested.
    await rejects(createFile(sandbox, { path: 'deep/new.txt', content: 'two' }), 'ALREADY_EXISTS')
    const overwritten = await createFile(sandbox, { path: 'deep/new.txt', content: 'two', fail_if_exists: false })
    assert.equal(overwritten.previous_sha256, sha256('one'))

    await rejects(createFile(sandbox, { path: 'absent/x.txt', content: 'x' }), 'NOT_FOUND')

    // Optimistic concurrency: a stale hash must not clobber.
    await rejects(updateFile(sandbox, { path: 'deep/new.txt', content: 'three', expected_sha256: sha256('one') }), 'CONFLICT')
    const updated = await updateFile(sandbox, { path: 'deep/new.txt', content: 'three', expected_sha256: sha256('two') })
    assert.equal(updated.sha256, sha256('three'))

    const appended = await updateFile(sandbox, { path: 'deep/new.txt', mode: 'append', content: '-more' })
    assert.equal(appended.bytes, 'three-more'.length)

    await writeFile(join(root, 'unique.txt'), 'aa BB aa\n')
    await rejects(updateFile(sandbox, { path: 'unique.txt', mode: 'replace_once', find: 'aa', replace: 'zz' }), 'CONFLICT')
    const patched = await updateFile(sandbox, { path: 'unique.txt', mode: 'replace_once', find: 'BB', replace: 'zz' })
    assert.equal(patched.replacements, 1)
    assert.equal(await readFile(join(root, 'unique.txt'), 'utf8'), 'aa zz aa\n')
    await rejects(updateFile(sandbox, { path: 'unique.txt', mode: 'replace_once', find: 'absent', replace: 'x' }), 'NOT_FOUND')

    await rejects(updateFile(sandbox, { path: 'never.txt', content: 'x' }), 'NOT_FOUND')
    const createdByUpdate = await updateFile(sandbox, { path: 'never.txt', content: 'x', create: true })
    assert.equal(createdByUpdate.created, true)

    // Writing the same bytes twice reports unchanged rather than touching disk.
    const noop = await updateFile(sandbox, { path: 'never.txt', content: 'x' })
    assert.equal(noop.unchanged, true)

    // Atomic write leaves no stray temporary file behind.
    assert.ok(!(await readdir(root)).some(name => name.includes('shiro-write')))
  } finally {
    await cleanup()
  }
})

test('fs mkdir, delete, move and copy enforce their explicit safety rules', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    assert.equal((await makeDirectory(sandbox, { path: 'a/b', parents: true })).created, true)
    assert.equal((await makeDirectory(sandbox, { path: 'a/b' })).created, false)
    await rejects(makeDirectory(sandbox, { path: 'a/b', exist_ok: false }), 'ALREADY_EXISTS')
    await writeFile(join(root, 'a', 'file.txt'), 'content')
    await rejects(makeDirectory(sandbox, { path: 'a/file.txt' }), 'CONFLICT')

    // A non-empty directory refuses to disappear without recursive.
    await rejects(deletePath(sandbox, { path: 'a' }), 'CONFLICT')
    await rejects(deletePath(sandbox, { path: 'a/file.txt', expected_type: 'directory' }), 'CONFLICT')
    await rejects(deletePath(sandbox, { path: 'a/file.txt', expected_sha256: sha256('stale') }), 'CONFLICT')
    assert.equal((await deletePath(sandbox, { path: 'a/file.txt', expected_sha256: sha256('content') })).deleted, true)
    assert.equal((await deletePath(sandbox, { path: 'a', recursive: true })).deleted, true)

    await writeFile(join(root, 'src.txt'), 'payload')
    await rejects(movePath(sandbox, { source: 'missing.txt', destination: 'x.txt' }), 'NOT_FOUND')
    assert.equal((await movePath(sandbox, { source: 'src.txt', destination: 'moved.txt' })).moved, true)
    await writeFile(join(root, 'other.txt'), 'other')
    await rejects(movePath(sandbox, { source: 'other.txt', destination: 'moved.txt' }), 'ALREADY_EXISTS')
    assert.equal((await movePath(sandbox, { source: 'other.txt', destination: 'moved.txt', overwrite: true })).overwrote, true)

    assert.equal((await copyPath(sandbox, { source: 'moved.txt', destination: 'copy.txt' })).copied, true)
    await rejects(copyPath(sandbox, { source: 'moved.txt', destination: 'copy.txt' }), 'ALREADY_EXISTS')
    await mkdir(join(root, 'tree', 'sub'), { recursive: true })
    await writeFile(join(root, 'tree', 'sub', 'leaf.txt'), 'leaf')
    await rejects(copyPath(sandbox, { source: 'tree', destination: 'tree-copy' }), 'INVALID_ARGUMENT')
    assert.equal((await copyPath(sandbox, { source: 'tree', destination: 'tree-copy', recursive: true })).type, 'directory')
    assert.equal(await readFile(join(root, 'tree-copy', 'sub', 'leaf.txt'), 'utf8'), 'leaf')

    // Both sides of a move stay confined to the fixed root.
    await rejects(movePath(sandbox, { source: 'moved.txt', destination: '../escaped.txt' }), 'OUTSIDE_SANDBOX')
    await rejects(copyPath(sandbox, { source: '../../etc/hosts', destination: 'stolen.txt' }), 'OUTSIDE_SANDBOX')
    assert.ok((await stat(join(root, 'moved.txt'))).isFile())
  } finally {
    await cleanup()
  }
})

test('glob translation matches path segments the way the actions document', () => {
  assert.ok(globToRegExp('*.js').test('a.js'))
  assert.ok(!globToRegExp('*.js').test('src/a.js'))
  assert.ok(globToRegExp('**/*.js').test('src/deep/a.js'))
  assert.ok(globToRegExp('**/*.js').test('a.js'))
  assert.ok(globToRegExp('src/?.ts').test('src/a.ts'))
  assert.ok(globToRegExp('src/[ab].ts').test('src/b.ts'))
  assert.ok(!globToRegExp('src/[ab].ts').test('src/c.ts'))
})

test('fs_search returns the same ordered result whatever order the parallel reads finish in', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    // Enough files to cross several read batches, in nested directories, so a
    // completion-order bug would show up as a reordered result.
    for (let index = 0; index < 40; index += 1) {
      const directory = join(root, `dir${String(index % 5)}`)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `file${String(index).padStart(2, '0')}.txt`), `padding\nneedle ${index}\n`)
    }
    const first = await searchText(sandbox, { query: 'needle', max_results: 500 })
    const second = await searchText(sandbox, { query: 'needle', max_results: 500 })
    assert.equal(first.match_count, 40)
    assert.deepEqual(first.matches, second.matches)
    const paths = first.matches.map(match => match.path)
    assert.deepEqual(paths, [...paths].sort(), 'results must be ordered by path')

    // Stopping at max_results keeps the same prefix as the full result.
    const capped = await searchText(sandbox, { query: 'needle', max_results: 7 })
    assert.equal(capped.truncated, true)
    assert.deepEqual(capped.matches, first.matches.slice(0, 7))
    assert.equal(capped.scan_capped, undefined, 'hitting max_results is not a scan cap')
  } finally {
    await cleanup()
  }
})
