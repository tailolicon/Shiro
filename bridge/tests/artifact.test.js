import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeBroker, readWorkspaceArtifact, MAX_ARTIFACT_BYTES } from '../src/index.js'

test('broker exposes full pending requests by id for harness_get_request', () => {
  const broker = new BridgeBroker()
  const { id } = broker.enqueue({
    provider: 'shiro-sol',
    model: 'gpt-5.6-sol',
    sessionId: 'session-page',
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(500) }] }],
    tools: [{ name: 'read' }],
  })
  const request = broker.request(id)
  assert.equal(request.request_id, id)
  assert.equal(request.messages.length, 1)
  assert.equal(broker.request('missing'), undefined)
})

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'shiro-artifact-'))
  await writeFile(join(root, 'shot.png'), PNG_HEADER)
  await writeFile(join(root, 'notes.md'), '# notes\n')
  await mkdir(join(root, 'out'))
  await writeFile(join(root, 'out', 'raw.bin'), Buffer.from([0x00, 0x01, 0x02]))
  return root
}

test('artifact reader returns images, texts, and blobs with workspace-relative paths', async () => {
  const root = await workspace()
  const image = await readWorkspaceArtifact(root, 'shot.png')
  assert.equal(image.kind, 'image')
  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.path, 'shot.png')
  assert.deepEqual([...image.data], [...PNG_HEADER])

  const text = await readWorkspaceArtifact(root, join(root, 'notes.md'))
  assert.equal(text.kind, 'text')
  assert.equal(text.data.toString('utf8'), '# notes\n')

  const blob = await readWorkspaceArtifact(root, 'out/raw.bin')
  assert.equal(blob.kind, 'blob')
  assert.equal(blob.path, join('out', 'raw.bin'))
})

test('artifact reader refuses escapes, symlink escapes, directories, and oversize files', async () => {
  const root = await workspace()
  await assert.rejects(readWorkspaceArtifact(root, '../../etc/passwd'), /escapes the fixed project root|artifact not found/)
  await symlink('/etc/hostname', join(root, 'leak'))
  await assert.rejects(readWorkspaceArtifact(root, 'leak'), /escapes the fixed project root/)
  await assert.rejects(readWorkspaceArtifact(root, 'out'), /not a regular file/)
  await assert.rejects(readWorkspaceArtifact(root, 'missing.txt'), /artifact not found/)
  await assert.rejects(readWorkspaceArtifact(root, 'shot.png', 4), /the limit is 4/)
  assert.ok(MAX_ARTIFACT_BYTES > 1_000_000)
})

test('model requests replace raw image blocks with fetchable image_attachment markers', async () => {
  const broker = new BridgeBroker()
  broker.enqueue({
    provider: 'shiro-sol',
    model: 'gpt-5.6-sol',
    sessionId: 'session-img',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image', attachment: { id: 'att-1', name: 'current-screen.png', mediaType: 'image/png' } },
      ],
    }],
    tools: [],
  })
  const [request] = broker.snapshot()
  const blocks = request.messages[0].content
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image_attachment')
  assert.equal(blocks[1].name, 'current-screen.png')
  assert.equal(blocks[1].attachment.id, 'att-1')
  assert.match(blocks[1].note, /harness_get_artifact/)
})
