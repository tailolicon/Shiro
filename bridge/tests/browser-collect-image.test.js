import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectGeneratedImage } from '../src/browser-collect-image.js'

function pngFixture() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(1254, 8)
  ihdr.writeUInt32BE(1254, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  return Buffer.concat([signature, ihdr, Buffer.alloc(310_000, 7)])
}

test('collectGeneratedImage streams native browser bytes atomically into the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-collect-'))
  const bytes = pngFixture()
  const calls = []
  const fleet = {
    async resolveOwnedTab(tabId, options) {
      calls.push(['resolve', tabId, options])
      assert.equal(tabId, 101)
      return {
        record: {
          browser_tab_id: 101,
          browser_client_id: 'client-101',
          url: 'https://chatgpt.com/c/test',
          fleet: 'gam', slot: 1, busy: false,
        },
        marker: 'm1',
      }
    },
    async recheckOwnedTab(tabId, marker, action) {
      calls.push(['recheck', tabId, marker, action])
    },
  }
  const transport = {
    async capabilities() { return { evaluate: true } },
    async evaluate(clientId, options) {
      assert.equal(clientId, 'client-101')
      const expression = options.expression
      if (expression.includes('fetch(src')) {
        return { json: JSON.stringify({
          bytes: bytes.length,
          content_type: 'image/png',
          alt: 'Generated image: Test Asset',
          src: 'https://chatgpt.com/backend-api/estuary/content?id=file_test',
          file_id: 'file_test', natural_width: 1254, natural_height: 1254,
        }) }
      }
      if (expression.includes('btoa(bin)')) {
        const match = /subarray\((\d+),(\d+)\)/.exec(expression)
        assert.ok(match)
        const start = Number(match[1]); const end = Number(match[2])
        return { json: JSON.stringify(bytes.subarray(start, end).toString('base64')) }
      }
      return { json: 'true' }
    },
  }
  const sandbox = {
    async resolveForWrite(relative) {
      assert.equal(relative, 'inputs/worker-inbox/imgw/asset/v003/front.png')
      return { relative, absolute: join(root, relative) }
    },
  }
  try {
    const result = await collectGeneratedImage(sandbox, {
      browser_tab_id: 101,
      save_to: 'inputs/worker-inbox/imgw/asset/v003/front.png',
      image_alt: 'Generated image: Test Asset',
    }, { fleet, transport, now: () => Date.parse('2026-09-11T16:00:00Z') })
    assert.equal(result.bytes, bytes.length)
    assert.equal(result.generated_file_id, 'file_test')
    assert.equal(result.width, 1254)
    assert.equal(result.height, 1254)
    assert.equal(result.mime_type, 'image/png')
    assert.deepEqual(await readFile(join(root, result.path)), bytes)
    assert.ok(calls.filter(row => row[0] === 'recheck').length >= 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
