import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'shiro-sandbox-'))
  const root = join(base, 'root')
  await mkdir(join(root, 'nested', 'deep'), { recursive: true })
  await writeFile(join(root, 'inside.txt'), 'inside\n')
  await writeFile(join(base, 'outside.txt'), 'outside\n')
  await mkdir(join(base, 'outside-dir'))
  await symlink(join(base, 'outside.txt'), join(root, 'escape-file'))
  await symlink(join(base, 'outside-dir'), join(root, 'escape-dir'))
  await symlink(join(root, 'inside.txt'), join(root, 'inside-link'))
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('sandbox confines every path form to the fixed project root', async () => {
  const { root, cleanup } = await fixture()
  try {
    const sandbox = new Sandbox(root)

    // Plain relative paths resolve and report themselves relative to the root.
    assert.equal((await sandbox.resolveExisting('inside.txt')).relative, 'inside.txt')
    assert.equal((await sandbox.resolveExisting('.')).relative, '.')
    assert.equal((await sandbox.resolveExisting('nested/deep')).relative, 'nested/deep')

    // Traversal, absolute paths and Windows-style absolute paths are refused.
    await rejects(sandbox.resolveExisting('../outside.txt'), 'OUTSIDE_SANDBOX')
    await rejects(sandbox.resolveExisting('nested/../../outside.txt'), 'OUTSIDE_SANDBOX')
    await rejects(sandbox.resolveExisting('/etc/passwd'), 'OUTSIDE_SANDBOX')
    await rejects(sandbox.resolveExisting('C:\\Windows\\system32'), 'OUTSIDE_SANDBOX')
    await rejects(sandbox.resolveExisting('inside\u0000.txt'), 'INVALID_ARGUMENT')

    // Symlink chains that leave the root are refused on read and on write.
    await rejects(sandbox.resolveExisting('escape-file'), 'OUTSIDE_SANDBOX')
    await rejects(sandbox.resolveExisting('escape-dir/anything'), 'OUTSIDE_SANDBOX')
    await rejects(sandbox.resolveForWrite('escape-dir/created.txt'), 'OUTSIDE_SANDBOX')
    await rejects(sandbox.resolveForWrite('escape-dir/deeper/created.txt'), 'OUTSIDE_SANDBOX')

    // A symlink pointing inside the root stays usable, and follow:false keeps
    // the link itself addressable so it can be inspected or unlinked.
    assert.equal((await sandbox.resolveExisting('inside-link')).linked, true)
    assert.equal((await sandbox.resolveExisting('escape-file', { follow: false })).relative, 'escape-file')

    // Paths that do not exist yet are validated through their deepest existing
    // ancestor, so creation inside the root works and creation outside does not.
    assert.equal((await sandbox.resolveForWrite('nested/new/file.txt')).relative, 'nested/new/file.txt')
    await rejects(sandbox.resolveForWrite('../new.txt'), 'OUTSIDE_SANDBOX')
    await rejects(sandbox.resolveForWrite('.'), 'INVALID_ARGUMENT')

    // cwd resolution insists on a real directory.
    assert.equal((await sandbox.resolveDirectory('nested')).relative, 'nested')
    await rejects(sandbox.resolveDirectory('inside.txt'), 'INVALID_ARGUMENT')
    await rejects(sandbox.resolveDirectory('missing'), 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})
