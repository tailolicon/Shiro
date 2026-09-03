import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import { downloadFile, importArtifact, NET_LIMITS, normalizeFileReference, parseDownloadUrl, safeBasename } from '../src/net-actions.js'

const PAYLOAD = 'the quick brown fox jumps over the lazy dog\n'.repeat(8)
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')

/** Local origin server: redirects, errors, a slow body and a large body. */
async function origin() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/file.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(PAYLOAD)
      return
    }
    if (url.pathname === '/hop') {
      response.writeHead(302, { location: '/file.txt' })
      response.end()
      return
    }
    if (url.pathname === '/loop') {
      response.writeHead(302, { location: '/loop' })
      response.end()
      return
    }
    if (url.pathname === '/big') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.alloc(200_000, 7))
      return
    }
    if (url.pathname === '/declared-big') {
      response.writeHead(200, { 'content-length': '999999999' })
      response.end(Buffer.alloc(16))
      return
    }
    if (url.pathname === '/slow') {
      response.writeHead(200)
      response.write('start')
      return // never ends: exercises the timeout
    }
    if (url.pathname === '/denied') {
      response.writeHead(403)
      response.end('nope')
      return
    }
    response.writeHead(404)
    response.end('missing')
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolveClose => server.close(resolveClose)),
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shiro-net-'))
  return { root, sandbox: new Sandbox(root), cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('only credential-free http(s) URLs are accepted', () => {
  assert.equal(parseDownloadUrl('https://example.com/a.zip').protocol, 'https:')
  assert.throws(() => parseDownloadUrl('file:///etc/passwd'), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => parseDownloadUrl('ftp://example.com/a'), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => parseDownloadUrl('https://user:pass@example.com/a'), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => parseDownloadUrl('not a url'), error => error.code === 'INVALID_ARGUMENT')
})

test('download_file writes the body atomically and reports its hash', async () => {
  const server = await origin()
  const { root, sandbox, cleanup } = await fixture()
  try {
    await rejects(downloadFile(sandbox, { url: `${server.base}/file.txt`, path: 'downloads/file.txt' }), 'NOT_FOUND')
    const result = await downloadFile(sandbox, { url: `${server.base}/file.txt`, path: 'downloads/file.txt', create_parents: true })
    assert.equal(result.status, 200)
    assert.equal(result.bytes, Buffer.byteLength(PAYLOAD))
    assert.equal(result.sha256, PAYLOAD_SHA)
    assert.equal(result.path, 'downloads/file.txt')
    assert.equal(result.overwrote, false)
    assert.deepEqual(result.redirects, [])
    assert.equal(await readFile(join(root, 'downloads', 'file.txt'), 'utf8'), PAYLOAD)
    // No half-written temp file survives a successful download.
    assert.deepEqual(await readdir(join(root, 'downloads')), ['file.txt'])
  } finally {
    await cleanup()
    await server.close()
  }
})

test('an existing destination is protected until overwrite is asked for', async () => {
  const server = await origin()
  const { root, sandbox, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'file.txt'), 'previous contents')
    await rejects(downloadFile(sandbox, { url: `${server.base}/file.txt`, path: 'file.txt' }), 'ALREADY_EXISTS')
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'previous contents')

    const replaced = await downloadFile(sandbox, { url: `${server.base}/file.txt`, path: 'file.txt', overwrite: true })
    assert.equal(replaced.overwrote, true)
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), PAYLOAD)
  } finally {
    await cleanup()
    await server.close()
  }
})

test('redirects are followed, reported and bounded', async () => {
  const server = await origin()
  const { sandbox, cleanup } = await fixture()
  try {
    const hopped = await downloadFile(sandbox, { url: `${server.base}/hop`, path: 'hopped.txt' })
    assert.equal(hopped.redirects.length, 1)
    assert.equal(hopped.final_url, `${server.base}/file.txt`)
    assert.equal(hopped.sha256, PAYLOAD_SHA)

    await rejects(downloadFile(sandbox, { url: `${server.base}/loop`, path: 'loop.txt' }), 'PROCESS_FAILED')
  } finally {
    await cleanup()
    await server.close()
  }
})

test('size caps are enforced by declared length and while streaming', async () => {
  const server = await origin()
  const { root, sandbox, cleanup } = await fixture()
  try {
    await rejects(downloadFile(sandbox, { url: `${server.base}/declared-big`, path: 'a.bin' }), 'INVALID_ARGUMENT')
    await rejects(downloadFile(sandbox, { url: `${server.base}/big`, path: 'b.bin', max_bytes: 1024 }), 'INVALID_ARGUMENT')
    // Neither attempt may leave a partial file or a temp file behind.
    assert.deepEqual(await readdir(root), [])
    assert.ok(NET_LIMITS.max_bytes_cap > NET_LIMITS.max_bytes_default)
  } finally {
    await cleanup()
    await server.close()
  }
})

test('a hash mismatch discards the download', async () => {
  const server = await origin()
  const { root, sandbox, cleanup } = await fixture()
  try {
    await rejects(
      downloadFile(sandbox, { url: `${server.base}/file.txt`, path: 'c.txt', expected_sha256: 'f'.repeat(64) }),
      'CONFLICT',
    )
    assert.deepEqual(await readdir(root), [])

    const verified = await downloadFile(sandbox, { url: `${server.base}/file.txt`, path: 'c.txt', expected_sha256: PAYLOAD_SHA })
    assert.equal(verified.sha256, PAYLOAD_SHA)
  } finally {
    await cleanup()
    await server.close()
  }
})

test('HTTP failures map onto the documented error codes', async () => {
  const server = await origin()
  const { sandbox, cleanup } = await fixture()
  try {
    await rejects(downloadFile(sandbox, { url: `${server.base}/nothing-here`, path: 'd.txt' }), 'NOT_FOUND')
    await rejects(downloadFile(sandbox, { url: `${server.base}/denied`, path: 'e.txt' }), 'PERMISSION_REQUIRED')
  } finally {
    await cleanup()
    await server.close()
  }
})

test('a stalled response times out instead of hanging the connector', async () => {
  const server = await origin()
  const { root, sandbox, cleanup } = await fixture()
  try {
    await rejects(downloadFile(sandbox, { url: `${server.base}/slow`, path: 'f.txt', timeout_ms: 1000 }), 'TIMEOUT')
    assert.deepEqual(await readdir(root), [])
  } finally {
    await cleanup()
    await server.close()
  }
})

test('the destination is confined to the workspace', async () => {
  const server = await origin()
  const { sandbox, cleanup } = await fixture()
  try {
    await rejects(downloadFile(sandbox, { url: `${server.base}/file.txt`, path: '../escape.txt' }), 'OUTSIDE_SANDBOX')
    await rejects(downloadFile(sandbox, { url: `${server.base}/file.txt`, path: '/etc/shiro.txt' }), 'OUTSIDE_SANDBOX')
  } finally {
    await cleanup()
    await server.close()
  }
})

test('header arguments are validated so nothing can be smuggled into the request', async () => {
  const server = await origin()
  const { sandbox, cleanup } = await fixture()
  try {
    await rejects(
      downloadFile(sandbox, { url: `${server.base}/file.txt`, path: 'g.txt', headers: { 'bad header': 'x' } }),
      'INVALID_ARGUMENT',
    )
    await rejects(
      downloadFile(sandbox, { url: `${server.base}/file.txt`, path: 'g.txt', headers: { authorization: 'a\r\nX-Injected: 1' } }),
      'INVALID_ARGUMENT',
    )
  } finally {
    await cleanup()
    await server.close()
  }
})

test('a connector file reference normalizes to something fetchable, or says why not', () => {
  // The documented shape the ChatGPT runtime substitutes for an attachment.
  assert.deepEqual(
    normalizeFileReference({ download_url: 'https://files/x', file_id: 'file_9', mime_type: 'application/zip', file_name: 'src.zip' }),
    { download_url: 'https://files/x', file_id: 'file_9', mime_type: 'application/zip', file_name: 'src.zip' },
  )
  assert.equal(normalizeFileReference('https://files/x').download_url, 'https://files/x')

  // The two degraded forms field reports describe. Neither carries bytes we can
  // reach, so both must explain that instead of failing opaquely.
  assert.throws(() => normalizeFileReference('file_abc123'), error => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /only the file id/)
    return true
  })
  assert.throws(() => normalizeFileReference('/mnt/data/movie.mp4'), error => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /ChatGPT's own sandbox/)
    return true
  })
  assert.throws(() => normalizeFileReference({ file_id: 'file_1' }), error => error.code === 'UNSUPPORTED')
  assert.throws(() => normalizeFileReference(42), error => error.code === 'INVALID_ARGUMENT')
})

test('an attachment file name never becomes a path', () => {
  assert.equal(safeBasename('report.pdf'), 'report.pdf')
  assert.equal(safeBasename('/mnt/data/../../etc/passwd'), 'passwd')
  assert.equal(safeBasename('..'), 'imported-file')
  assert.equal(safeBasename('C:\\Users\\me\\a.zip'), 'a.zip')
  assert.equal(safeBasename('', 'fallback'), 'fallback')
})

test('artifact_import lands the attachment in the workspace', async () => {
  const server = await origin()
  const { root, sandbox, cleanup } = await fixture()
  try {
    const imported = await importArtifact(sandbox, {
      file: { download_url: `${server.base}/file.txt`, file_id: 'file_42', file_name: 'notes.txt', mime_type: 'text/plain' },
    })
    assert.equal(imported.imported, true)
    assert.equal(imported.path, 'notes.txt')
    assert.equal(imported.file_id, 'file_42')
    assert.equal(imported.declared_mime_type, 'text/plain')
    assert.equal(imported.sha256, PAYLOAD_SHA)
    assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), PAYLOAD)

    // An explicit destination wins, and nested parents are created.
    const nested = await importArtifact(sandbox, {
      file: { download_url: `${server.base}/file.txt`, file_id: 'file_43' },
      destination: 'inbox/2026/payload.txt',
    })
    assert.equal(nested.path, 'inbox/2026/payload.txt')

    // A hostile file name cannot climb out of the workspace.
    const hostile = await importArtifact(sandbox, {
      file: { download_url: `${server.base}/file.txt`, file_id: 'file_44', file_name: '../../escape.txt' },
    })
    assert.equal(hostile.path, 'escape.txt')

    // Every downloadFile guarantee still applies on the import path.
    await rejects(importArtifact(sandbox, {
      file: { download_url: `${server.base}/file.txt`, file_id: 'f' }, destination: 'notes.txt',
    }), 'ALREADY_EXISTS')
    await rejects(importArtifact(sandbox, {
      file: { download_url: `${server.base}/big`, file_id: 'f' }, destination: 'big.bin', max_bytes: 1024,
    }), 'INVALID_ARGUMENT')
    await rejects(importArtifact(sandbox, {
      file: { download_url: 'file:///etc/passwd', file_id: 'f' }, destination: 'p.txt',
    }), 'INVALID_ARGUMENT')
    await rejects(importArtifact(sandbox, {
      file: { download_url: `${server.base}/file.txt`, file_id: 'f' }, destination: '../outside.txt',
    }), 'OUTSIDE_SANDBOX')
  } finally {
    await cleanup()
    await server.close()
  }
})

test('artifact_import takes exactly one source', async () => {
  const server = await origin()
  const { sandbox, cleanup } = await fixture()
  try {
    await rejects(importArtifact(sandbox, {}), 'INVALID_ARGUMENT')
    await rejects(importArtifact(sandbox, { file: { download_url: `${server.base}/file.txt`, file_id: 'f' }, source_url: `${server.base}/file.txt` }), 'INVALID_ARGUMENT')
    const viaUrl = await importArtifact(sandbox, { source_url: `${server.base}/file.txt`, destination: 'direct.txt' })
    assert.equal(viaUrl.path, 'direct.txt')
  } finally {
    await cleanup()
    await server.close()
  }
})
