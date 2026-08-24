import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { ChatGptBrowserRelay } from '../src/chatgpt-relay.js'
import { BridgeBroker, ChatGptSolAdapter } from '../src/index.js'

// Task 6 integration tests: drive ChatGptSolAdapter / ChatGptBrowserRelay
// against a real local node:http server standing in for
// relay/chatgpt-bridge, on a random loopback port -- no mocked fetch.

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function healthOk(res) {
  sendJson(res, 200, { ok: true, clients: 1, needsSelection: false })
}

function sseFrame(payload) {
  return `event: event\ndata: ${JSON.stringify(payload)}\n\n`
}

async function startServer(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) })
      else try { res.end() } catch {}
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

const baseOptions = {
  provider: 'shiro-sol',
  model: 'gpt-5.6-sol',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
  tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

// Mirrors the grammar enforced by engine/packages/llm/llm/src/invariant.ts,
// which throws mid-stream on violations (e.g. a repeated block-start for an
// index) whenever the llm-invariant companion is installed.
function assertStreamGrammar(chunks) {
  const open = new Map()
  let finished = false
  for (const chunk of chunks) {
    assert.equal(finished, false, `chunk ${chunk.type} after terminal finish`)
    if (chunk.type === 'block-start') {
      assert.equal(open.has(chunk.index), false, `repeated block-start index ${chunk.index}`)
      open.set(chunk.index, chunk.blockType)
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
      const expected = chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : 'tool-call'
      assert.equal(open.get(chunk.index), expected, `${chunk.type} at index ${chunk.index} without matching open block`)
    } else if (chunk.type === 'block-end') {
      assert.equal(open.get(chunk.index), chunk.block.type === 'tool-call' ? 'tool-call' : chunk.block.type,
        `block-end index ${chunk.index} does not close its open block`)
      open.delete(chunk.index)
    } else if (chunk.type === 'finish') {
      if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') {
        assert.equal(open.size, 0, `finish with ${open.size} open block(s)`)
      }
      finished = true
    }
  }
  assert.equal(finished, true, 'stream ended without a terminal finish chunk')
}

function makeAdapter(url, relayOverrides = {}, resolveAttachments = () => undefined) {
  const relay = new ChatGptBrowserRelay({ url, token: 'test-token', ...relayOverrides })
  return new ChatGptSolAdapter(new BridgeBroker(), 'shiro-sol', 'gpt-5.6-sol', relay, resolveAttachments)
}

test('relay-integration: happy path completion with tool calls', async () => {
  const server = await startServer(async (req, res) => {
    if (req.url === '/health') return healthOk(res)
    if (req.url === '/chat') {
      const body = await readJsonBody(req)
      assert.match(body.message, /DeepSeek Harness/)
      return sendJson(res, 200, {
        response: JSON.stringify({
          blocks: [{ type: 'tool_call', id: 'call-1', name: 'read', arguments: { file_path: 'package.json' } }],
          finishReason: 'tool-calls',
        }),
      })
    }
    res.writeHead(404).end()
  })
  try {
    const chunks = await collect(makeAdapter(server.url).stream(baseOptions))
    const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
    assert.equal(blockEnd.block.type, 'tool-call')
    assert.equal(blockEnd.block.name, 'read')
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
    assertStreamGrammar(chunks)
  } finally {
    await server.close()
  }
})

test('relay-integration: HTTP 429 with Retry-After surfaces a RATE_LIMIT finish', async () => {
  const server = await startServer(async (req, res) => {
    if (req.url === '/health') return healthOk(res)
    if (req.url === '/chat') {
      await readJsonBody(req)
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
      return res.end(JSON.stringify({ detail: 'slow down' }))
    }
    res.writeHead(404).end()
  })
  try {
    await assert.rejects(collect(makeAdapter(server.url).stream(baseOptions)), (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.failure.providerRetryAfterMs, 1000)
      return true
    })
  } finally {
    await server.close()
  }
})

test('relay-integration: HTTP 500 surfaces a SERVER finish', async () => {
  const server = await startServer(async (req, res) => {
    if (req.url === '/health') return healthOk(res)
    if (req.url === '/chat') {
      await readJsonBody(req)
      return sendJson(res, 500, { detail: 'internal error' })
    }
    res.writeHead(404).end()
  })
  try {
    await assert.rejects(collect(makeAdapter(server.url).stream(baseOptions)), (error) => {
      assert.equal(error.code, 'SERVER')
      return true
    })
  } finally {
    await server.close()
  }
})

test('relay-integration: connection refused surfaces TRANSPORT', async () => {
  // The adapter's health-gate would itself report not-ready on a refused
  // connection and silently fall back to the MCP handoff (a broker.enqueue()
  // that would never resolve in this test), so this exercises the relay
  // directly -- still a real socket-level failure against loopback.
  const server = await startServer(async (_req, res) => res.writeHead(404).end())
  const { url } = server
  await server.close()
  const relay = new ChatGptBrowserRelay({ url, token: 'test-token' })
  await assert.rejects(relay.complete({ ...baseOptions, tools: [], generation: {} }), (error) => {
    assert.equal(error.code, 'TRANSPORT')
    return true
  })
})

test('relay-integration: abort mid-request yields an aborted finish', async () => {
  const server = await startServer(async (req, res) => {
    if (req.url === '/health') return healthOk(res)
    if (req.url === '/chat') {
      await readJsonBody(req)
      let clientClosed = false
      req.once('close', () => { clientClosed = true })
      await new Promise(resolve => setTimeout(resolve, 80))
      if (clientClosed || res.writableEnded) { try { res.socket?.destroy() } catch {} return }
      try { sendJson(res, 200, { response: 'too late to matter' }) } catch {}
      return
    }
    res.writeHead(404).end()
  })
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const chunks = await collect(makeAdapter(server.url).stream({ ...baseOptions, signal: controller.signal }))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'finish')
    assert.equal(chunks[0].reason.kind, 'aborted')
    // Let the server's pending handler settle before tearing the server down.
    await new Promise(resolve => setTimeout(resolve, 120))
  } finally {
    await server.close()
  }
})

test('relay-integration: two concurrent stream() calls both complete', async () => {
  let received = 0
  const server = await startServer(async (req, res) => {
    if (req.url === '/health') return healthOk(res)
    if (req.url === '/chat') {
      const body = await readJsonBody(req)
      received += 1
      return sendJson(res, 200, { response: JSON.stringify({ blocks: [{ type: 'text', text: `reply to: ${body.message.slice(-1)}` }], finishReason: 'stop' }) })
    }
    res.writeHead(404).end()
  })
  try {
    const adapter = makeAdapter(server.url)
    const [chunksA, chunksB] = await Promise.all([
      collect(adapter.stream(baseOptions)),
      collect(adapter.stream(baseOptions)),
    ])
    assert.equal(received, 2)
    assert.equal(chunksA.at(-1).type, 'finish')
    assert.equal(chunksB.at(-1).type, 'finish')
  } finally {
    await server.close()
  }
})

test('relay-integration: newSession rotates across calls as the tracked Harness session id changes', async () => {
  const seen = []
  const server = await startServer(async (req, res) => {
    if (req.url === '/health') return healthOk(res)
    if (req.url === '/chat') {
      const body = await readJsonBody(req)
      seen.push(body.newSession)
      return sendJson(res, 200, { response: JSON.stringify({ blocks: [{ type: 'text', text: 'ok' }], finishReason: 'stop' }) })
    }
    res.writeHead(404).end()
  })
  try {
    const adapter = makeAdapter(server.url)
    await collect(adapter.stream({ ...baseOptions, sessionId: 'session-a' }))
    await collect(adapter.stream({ ...baseOptions, sessionId: 'session-a' }))
    await collect(adapter.stream({ ...baseOptions, sessionId: 'session-b' }))
    // Cold start rotates the first call; a changed session id rotates again.
    assert.deepEqual(seen, [true, false, true])
  } finally {
    await server.close()
  }
})

test('relay-integration: image attachments are uploaded and referenced in the /chat body', async () => {
  const uploaded = []
  let chatAttachments
  const server = await startServer(async (req, res) => {
    if (req.url === '/health') return healthOk(res)
    if (req.url === '/files') {
      const body = await readJsonBody(req)
      const file = { id: `file-${uploaded.length + 1}`, name: body.name, mime: body.mime, size: Buffer.from(body.contentBase64, 'base64').length }
      uploaded.push({ ...body, file })
      return sendJson(res, 201, { ok: true, file })
    }
    if (req.url === '/chat') {
      const body = await readJsonBody(req)
      chatAttachments = body.attachments
      return sendJson(res, 200, { response: JSON.stringify({ blocks: [{ type: 'text', text: 'I see a red square' }], finishReason: 'stop' }) })
    }
    res.writeHead(404).end()
  })
  try {
    const attachmentStore = {
      readImage: async ref => ({ ref: { ...ref, mediaType: 'image/png' }, data: new Uint8Array([137, 80, 78, 71]) }),
    }
    const adapter = makeAdapter(server.url, {}, () => attachmentStore)
    const options = {
      ...baseOptions,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', attachment: { attachmentId: 'sha256:img1', mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'square.png' } },
        ],
        source: { kind: 'user' },
      }],
    }
    await collect(adapter.stream(options))
    assert.equal(uploaded.length, 1)
    assert.equal(uploaded[0].name, 'square.png')
    assert.equal(chatAttachments.length, 1)
    assert.equal(chatAttachments[0].id, 'file-1')
  } finally {
    await server.close()
  }
})

test('relay-integration: streaming delta order matches the buffered result', async () => {
  const server = await startServer(async (req, res) => {
    if (req.url === '/health') return healthOk(res)
    if (req.url === '/chat') {
      const body = await readJsonBody(req)
      const wireText = JSON.stringify({ blocks: [{ type: 'text', text: 'Streamed answer.' }], finishReason: 'stop' })
      if (body.stream !== true) {
        return sendJson(res, 200, { response: wireText })
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      const half = Math.ceil(wireText.length / 2)
      res.write(sseFrame({ type: 'answer.delta', requestId: 'r1', text: wireText.slice(0, half), delta: wireText.slice(0, half) }))
      res.write(sseFrame({ type: 'answer.delta', requestId: 'r1', text: wireText, delta: wireText.slice(half) }))
      res.write(sseFrame({ type: 'request.result', requestId: 'r1', result: { answer: wireText } }))
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  try {
    const chunks = await collect(makeAdapter(server.url).stream(baseOptions))
    const deltas = chunks.filter(chunk => chunk.type === 'text-delta')
    assert.ok(deltas.length > 0, 'expected at least one streamed text-delta chunk')
    assert.equal(deltas.map(chunk => chunk.text).join(''), 'Streamed answer.')
    const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
    assert.equal(blockEnd.block.text, 'Streamed answer.')
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
    assertStreamGrammar(chunks)
  } finally {
    await server.close()
  }
})
