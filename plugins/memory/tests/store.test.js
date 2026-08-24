import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../src/store.js'

test('persists, searches, archives, and restores memories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-memory-'))
  const first = new MemoryStore(root)
  const stored = await first.store({
    title: 'Sở thích',
    content: 'Người dùng thích giao diện màu trắng.',
    tags: ['profile', 'UI'],
    importance: 'high',
  })
  assert.match(stored.id, /^mem_\d{6}$/)

  const second = new MemoryStore(root)
  const search = await second.search({ query: 'giao dien trang', limit: 5 })
  assert.equal(search.matches[0].id, stored.id)
  assert.equal((await second.get(stored.id)).content, stored.content)

  await second.archive(stored.id)
  assert.equal((await second.list()).memories.length, 0)
  assert.equal((await second.list({ state: 'archived' })).memories[0].id, stored.id)
  await second.restore(stored.id)
  assert.equal((await second.list()).memories[0].id, stored.id)

  const onDisk = JSON.parse(await readFile(join(root, 'memories.json'), 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.memories.length, 1)
})

test('serializes concurrent writes and updates existing ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-memory-'))
  const store = new MemoryStore(root)
  const created = await Promise.all(Array.from({ length: 12 }, (_, index) => store.store({
    content: `memory ${index}`,
    tags: ['batch'],
  })))
  assert.equal(new Set(created.map(memory => memory.id)).size, 12)
  const updated = await store.store({ id: created[0].id, content: 'updated', tags: ['new'] })
  assert.equal(updated.content, 'updated')
  assert.deepEqual(updated.tags, ['new'])
  assert.equal((await store.list({ limit: 100 })).memories.length, 12)
})

test('rejects unsafe or unbounded inputs', async () => {
  assert.throws(() => new MemoryStore('relative/path'), /absolute path/)
  const root = await mkdtemp(join(tmpdir(), 'shiro-memory-'))
  const store = new MemoryStore(root)
  await assert.rejects(store.store({ content: '' }), /non-empty/)
  await assert.rejects(store.search({ query: '', limit: 3 }), /non-empty/)
  await assert.rejects(store.list({ limit: 101 }), /1 to 100/)
})
