import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadRegistry } from '../src/thread-registry.js'

async function fixture(now = () => Date.parse('2026-09-03T12:00:00.000Z')) {
  const base = await mkdtemp(join(tmpdir(), 'shiro-threads-'))
  const stateFile = join(base, 'state', 'threads.json')
  return { base, stateFile, registry: new ThreadRegistry({ stateFile, now }), cleanup: () => rm(base, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('archiving hides a thread without claiming anything was deleted', async () => {
  const { registry, cleanup } = await fixture()
  try {
    assert.equal(registry.isArchived('session-1'), false)
    const archived = await registry.archive('session-1', { label: 'old experiment', reason: 'superseded', workspace: 'project' })
    assert.equal(archived.archived, true)
    assert.equal(archived.label, 'old experiment')
    assert.equal(archived.workspace, 'project')
    // The whole contract of this feature: the engine keeps its transcript.
    assert.equal(archived.engine_transcript_retained, true)
    assert.equal(registry.isArchived('session-1'), true)
  } finally {
    await cleanup()
  }
})

test('a thread with a running turn is not archived by accident', async () => {
  const { registry, cleanup } = await fixture()
  try {
    await assert.rejects(registry.archive('busy', { hasActiveTurn: true }), error => {
      assert.equal(error.code, 'BUSY')
      assert.match(error.message, /harness_cancel/)
      return true
    })
    assert.equal(registry.isArchived('busy'), false)

    // force is allowed, and says plainly that the turn keeps running.
    const forced = await registry.archive('busy', { hasActiveTurn: true, force: true })
    assert.equal(forced.forced, true)
    assert.equal(registry.isArchived('busy'), true)
  } finally {
    await cleanup()
  }
})

test('the archive survives a bridge restart and can be reversed', async () => {
  const { stateFile, registry, cleanup } = await fixture()
  try {
    await registry.archive('session-1', { reason: 'done' })
    // A second registry over the same file is what the next bridge process sees.
    const reloaded = new ThreadRegistry({ stateFile })
    await reloaded.ready
    assert.equal(reloaded.isArchived('session-1'), true)

    const restored = await reloaded.unarchive('session-1')
    assert.equal(restored.archived, false)
    assert.equal(reloaded.isArchived('session-1'), false)
    await rejects(reloaded.unarchive('session-1'), 'NOT_FOUND')
    await rejects(reloaded.unarchive('never-seen'), 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('a corrupt state file degrades to "nothing archived" instead of breaking the bridge', async () => {
  const { base, cleanup } = await fixture()
  try {
    const stateFile = join(base, 'threads.json')
    await writeFile(stateFile, '{ this is not json')
    const registry = new ThreadRegistry({ stateFile })
    await registry.ready
    assert.equal(registry.isArchived('anything'), false)
    // ...and it repairs itself on the next write.
    await registry.archive('session-1', {})
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).threads.map(entry => entry.session_id), ['session-1'])
  } finally {
    await cleanup()
  }
})

function candidates(now) {
  const day = 86_400_000
  return [
    { session_id: 'fresh', updated_at: new Date(now - day).toISOString() },
    { session_id: 'week-old', updated_at: new Date(now - (7 * day)).toISOString() },
    { session_id: 'ancient', updated_at: new Date(now - (90 * day)).toISOString() },
    { session_id: 'running', updated_at: new Date(now - (90 * day)).toISOString(), has_active_turn: true },
    { session_id: 'undated' },
  ]
}

test('prune is a dry run until it is told otherwise', async () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z')
  const { registry, cleanup } = await fixture(() => now)
  try {
    const preview = await registry.prune(candidates(now), { olderThanDays: 30 })
    assert.equal(preview.dry_run, true)
    assert.deepEqual(preview.would_archive, ['ancient'])
    assert.equal(preview.skipped_active, 1, 'a thread with a running turn is never swept')
    assert.equal(registry.isArchived('ancient'), false, 'a dry run changes nothing')

    const done = await registry.prune(candidates(now), { olderThanDays: 30, dryRun: false, reason: 'quarterly cleanup' })
    assert.deepEqual(done.archived, ['ancient'])
    assert.equal(done.engine_transcripts_retained, true)
    assert.equal(registry.isArchived('ancient'), true)
    assert.equal(registry.record('ancient').reason, 'quarterly cleanup')
  } finally {
    await cleanup()
  }
})

test('a thread with no timestamp is never treated as old', async () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z')
  const { registry, cleanup } = await fixture(() => now)
  try {
    // Unknown age is not old age: sweeping it would delete-by-guess.
    const preview = await registry.prune(candidates(now), { olderThanDays: 1 })
    assert.ok(!preview.would_archive.includes('undated'))
  } finally {
    await cleanup()
  }
})

test('keep_last protects the newest threads regardless of age', async () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z')
  const { registry, cleanup } = await fixture(() => now)
  try {
    const preview = await registry.prune(candidates(now), { keepLast: 2 })
    assert.ok(!preview.would_archive.includes('fresh'))
    assert.ok(!preview.would_archive.includes('week-old'))
    assert.ok(preview.would_archive.includes('ancient'))

    // Both bounds together are an intersection, not a union.
    const both = await registry.prune(candidates(now), { keepLast: 4, olderThanDays: 30 })
    assert.deepEqual(both.would_archive, [], 'keep_last still covers the ancient one here')
  } finally {
    await cleanup()
  }
})

test('an unbounded prune is refused', async () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z')
  const { registry, cleanup } = await fixture(() => now)
  try {
    await rejects(registry.prune(candidates(now), {}), 'INVALID_ARGUMENT')
    await rejects(registry.prune(candidates(now), { dryRun: false }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('already-archived threads are not swept twice', async () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z')
  const { registry, cleanup } = await fixture(() => now)
  try {
    await registry.archive('ancient', { reason: 'by hand' })
    const preview = await registry.prune(candidates(now), { olderThanDays: 30 })
    assert.deepEqual(preview.would_archive, [])
    assert.equal(registry.record('ancient').reason, 'by hand', 'the original reason is not overwritten')
  } finally {
    await cleanup()
  }
})

test('listing shows archived threads newest first', async () => {
  let clock = Date.parse('2026-09-01T00:00:00.000Z')
  const { registry, cleanup } = await fixture(() => clock)
  try {
    await registry.archive('first', {})
    clock += 60_000
    await registry.archive('second', {})
    const listed = await registry.list({})
    assert.deepEqual(listed.threads.map(entry => entry.session_id), ['second', 'first'])
    assert.equal(listed.total, 2)
    assert.equal((await registry.list({ limit: 1 })).truncated, true)
  } finally {
    await cleanup()
  }
})

test('an empty session id is refused', async () => {
  const { registry, cleanup } = await fixture()
  try {
    await rejects(registry.archive('', {}), 'INVALID_ARGUMENT')
    await rejects(registry.archive('   ', {}), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})
