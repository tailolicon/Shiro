import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatGptBrowserRelay, RelayError } from '../src/chatgpt-relay.js'

const request = {
  request_id: 'request-test',
  model: 'gpt-5.6-sol',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Read package.json' }] }],
  tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
  generation: { reasoning_effort: 'standard' },
}

test('browser relay stays loopback-only and maps a Harness tool call', async () => {
  const calls = []
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init })
      if (url.endsWith('/health')) {
        return Response.json({ ok: true, clients: 1, needsSelection: false })
      }
      return Response.json({
        response: JSON.stringify({
          blocks: [{ type: 'tool_call', id: 'call-1', name: 'read', arguments: { file_path: 'package.json' } }],
          finishReason: 'tool-calls',
        }),
      })
    },
  })

  assert.deepEqual(await relay.health(), { ready: true, clients: 1, detail: '' })
  const result = await relay.complete(request)
  assert.equal(result.finishReason, 'tool-calls')
  assert.deepEqual(result.blocks[0], {
    type: 'tool_call', id: 'call-1', name: 'read', arguments: { file_path: 'package.json' },
  })
  const sent = JSON.parse(calls[1].init.body)
  // First main-thread call of a fresh relay instance rotates (cold start).
  assert.equal(sent.newSession, true)
  assert.equal(sent.autoOpenTab, false)
  assert.equal(sent.effort, 'medium')
  assert.match(sent.message, /DeepSeek Harness/)
  assert.match(sent.message, /Read package\.json/)
})

test('browser relay rejects non-loopback endpoints and unknown tool names', async () => {
  assert.throws(() => new ChatGptBrowserRelay({
    url: 'https://example.com', token: 'relay-test-token',
  }), /loopback/)

  const relay = new ChatGptBrowserRelay({
    url: 'http://localhost:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({
      response: '{"blocks":[{"type":"tool_call","name":"delete_everything","arguments":{}}]}',
    }),
  })
  await assert.rejects(relay.complete(request), /unavailable Harness tool/)
})

test('browser relay preserves ordinary text when ChatGPT does not emit JSON', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({ response: 'Tôi đang hoạt động trong Shiro.' }),
  })
  const result = await relay.complete({ ...request, tools: [] })
  assert.deepEqual(result.blocks, [{ type: 'text', text: 'Tôi đang hoạt động trong Shiro.' }])
  assert.equal(result.finishReason, 'stop')
})

test('browser relay repairs raw Windows separators in multi-tool JSON', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({
      response: String.raw`{"blocks":[{"type":"tool_call","id":"call-content","name":"pwsh","arguments":{"command":"Get-Content .shiro-smoke\relay-proof.txt","workdir":"E:\Project\Shiro"}},{"type":"tool_call","id":"call-status","name":"pwsh","arguments":{"command":"git status --short","workdir":"E:\Project\Shiro"}}],"finishReason":"tool-calls"}`,
    }),
  })
  const result = await relay.complete({
    ...request,
    tools: [{ name: 'pwsh', description: 'Run PowerShell', inputSchema: { type: 'object' } }],
  })
  assert.equal(result.finishReason, 'tool-calls')
  assert.deepEqual(result.blocks, [
    {
      type: 'tool_call',
      id: 'call-content',
      name: 'pwsh',
      arguments: { command: String.raw`Get-Content .shiro-smoke\relay-proof.txt`, workdir: String.raw`E:\Project\Shiro` },
    },
    {
      type: 'tool_call',
      id: 'call-status',
      name: 'pwsh',
      arguments: { command: 'git status --short', workdir: String.raw`E:\Project\Shiro` },
    },
  ])
})

// --- Task 1: real error taxonomy + retry policy -----------------------------

test('browser relay classifies HTTP 429 as RATE_LIMIT and honors Retry-After', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'slow down' }), {
      status: 429,
      headers: { 'retry-after': '2' },
    }),
  })
  await assert.rejects(relay.complete(request), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.failure.code, 'RATE_LIMIT')
    assert.equal(error.failure.status, 429)
    assert.equal(error.failure.providerRetryAfterMs, 2000)
    return true
  })
})

test('browser relay classifies HTTP 5xx as SERVER', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'boom' }), { status: 503 }),
  })
  await assert.rejects(relay.complete(request), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'SERVER')
    assert.equal(error.failure.status, 503)
    return true
  })
})

test('browser relay classifies a network failure as TRANSPORT', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => { throw new TypeError('fetch failed: ECONNREFUSED') },
  })
  await assert.rejects(relay.complete(request), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'TRANSPORT')
    return true
  })
})

test('browser relay lets a genuine user abort pass through unchanged (not TRANSPORT/TIMEOUT)', async () => {
  const controller = new AbortController()
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (_url, init = {}) => {
      controller.abort()
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    },
  })
  await assert.rejects(relay.complete(request, controller.signal), (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error instanceof RelayError, false)
    return true
  })
})

// --- Task 2: malformed/truncated tool-call JSON must not silently degrade --

test('browser relay throws a typed retryable error for truncated JSON that started the protocol', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({
      response: '{"blocks":[{"type":"text","text":"partial reply that never clo',
    }),
  })
  await assert.rejects(relay.complete(request), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

test('browser relay throws a typed retryable error for a genuinely empty reply', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({ response: '   ' }),
  })
  await assert.rejects(relay.complete(request), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

test('browser relay still falls back to a plain text block for genuine prose', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({ response: 'Just chatting, no JSON here.' }),
  })
  const result = await relay.complete({ ...request, tools: [] })
  assert.deepEqual(result.blocks, [{ type: 'text', text: 'Just chatting, no JSON here.' }])
})

// --- Task 3: session isolation + bounded thread rotation --------------------

test('browser relay rotates the browser thread when the tracked Harness session id changes', async () => {
  const calls = []
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (url, init = {}) => {
      calls.push(JSON.parse(init.body))
      return Response.json({ response: 'ok' })
    },
  })
  await relay.complete({ ...request, tools: [], session_id: 'session-a' })
  await relay.complete({ ...request, tools: [], session_id: 'session-a' })
  await relay.complete({ ...request, tools: [], session_id: 'session-b' })
  // Cold start rotates too: the first call of a fresh process must not
  // continue a conversation left over from a previous run.
  assert.deepEqual(calls.map(body => body.newSession), [true, false, true])
})

test('browser relay rotates after a bounded number of turns on the same thread and resets the counter', async () => {
  const calls = []
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    maxThreadTurns: 3,
    fetchImpl: async (url, init = {}) => {
      calls.push(JSON.parse(init.body))
      return Response.json({ response: 'ok' })
    },
  })
  for (let i = 0; i < 7; i++) await relay.complete({ ...request, tools: [] })
  // The cold-start turn opens thread 1 and counts as its turn 1; turns 2-3
  // share it; the 4th turn (turnsOnThread at the maxThreadTurns=3 bound)
  // rotates and counts as turn 1 of the next thread, and so on.
  assert.deepEqual(calls.map(body => body.newSession), [true, false, false, true, false, false, true])
})

test('browser relay always starts a fresh thread for compaction and session-title side tasks', async () => {
  const calls = []
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (url, init = {}) => {
      calls.push(JSON.parse(init.body))
      return Response.json({ response: 'ok' })
    },
  })
  await relay.complete({ ...request, tools: [], session_id: 'session-a' })
  await relay.complete({ ...request, tools: [], session_id: 'session-a', purpose: 'compaction' })
  await relay.complete({ ...request, tools: [], session_id: 'session-a' })
  // Cold start rotates the first main-thread call; the side task always
  // rotates; the main thread then continues where it left off.
  assert.deepEqual(calls.map(body => body.newSession), [true, true, false])
})

// --- Task 5: bounded incremental streaming ----------------------------------

function sseFrame(payload) {
  return `event: event\ndata: ${JSON.stringify(payload)}\n\n`
}

function sseResponse(frames) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collectStream(iterable) {
  const deltas = []
  let final
  for await (const item of iterable) {
    if (item.type === 'delta') deltas.push(item.text)
    else if (item.type === 'final') final = item.value
  }
  return { deltas, final }
}

test('streamComplete emits incremental text deltas that assemble into the buffered result', async () => {
  const wireText = JSON.stringify({
    blocks: [{ type: 'text', text: 'Line1\nTab:\t"quoted" back\\slash café' }],
    finishReason: 'stop',
  })
  // Split into small, escape-boundary-crossing pieces to prove the scanner
  // survives escapes split across chunks.
  const pieces = []
  for (let i = 0; i < wireText.length; i += 3) pieces.push(wireText.slice(i, i + 3))
  let sent = ''
  const frames = pieces.map((piece) => {
    sent += piece
    return sseFrame({ type: 'answer.delta', requestId: 'r1', text: sent, delta: piece, source: 'tab.observation' })
  })
  frames.push(sseFrame({ type: 'request.result', requestId: 'r1', result: { answer: wireText } }))

  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => sseResponse(frames),
  })
  const { deltas, final } = await collectStream(relay.streamComplete({ ...request, tools: [] }))
  assert.equal(deltas.join(''), 'Line1\nTab:\t"quoted" back\\slash café')
  assert.deepEqual(final.blocks, [{ type: 'text', text: 'Line1\nTab:\t"quoted" back\\slash café' }])
  assert.equal(final.finishReason, 'stop')
})

test('streamComplete never streams a prose-prefixed reply whose embedded JSON parses to tool calls', async () => {
  // "Here's the plan: {json}" replies stream nothing: extractJson() can still
  // recover the embedded object (blocks[0] = tool_call), so streamed text
  // deltas at index 0 would violate the engine's stream grammar.
  const wireText = 'Sure! Here is what I will do: '
    + JSON.stringify({ blocks: [{ type: 'tool_call', id: 'c1', name: 'read', arguments: { file_path: 'a.txt' } }], finishReason: 'tool-calls' })
  const frames = [
    sseFrame({ type: 'answer.delta', requestId: 'r1', text: wireText.slice(0, 12), delta: wireText.slice(0, 12) }),
    sseFrame({ type: 'answer.delta', requestId: 'r1', text: wireText, delta: wireText.slice(12) }),
    sseFrame({ type: 'request.result', requestId: 'r1', result: { answer: wireText } }),
  ]
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => sseResponse(frames),
  })
  const { deltas, final } = await collectStream(relay.streamComplete(request))
  assert.deepEqual(deltas, [])
  assert.equal(final.blocks[0].type, 'tool_call')
  assert.equal(final.finishReason, 'tool-calls')
})

test('streamComplete falls back to a buffered read when the response has no readable SSE body', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({ response: 'Just chatting, no JSON here.' }),
  })
  const { deltas, final } = await collectStream(relay.streamComplete({ ...request, tools: [] }))
  assert.deepEqual(deltas, [])
  assert.deepEqual(final.blocks, [{ type: 'text', text: 'Just chatting, no JSON here.' }])
})

test('streamComplete surfaces a request.error SSE frame as a typed error', async () => {
  const frames = [sseFrame({ type: 'request.error', requestId: 'r1', error: { code: 'RATE_LIMIT', message: 'slow down' } })]
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => sseResponse(frames),
  })
  await assert.rejects(collectStream(relay.streamComplete({ ...request, tools: [] })), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'RATE_LIMIT')
    return true
  })
})

test('streamComplete does not stream deltas when the reply is not the anchored text-first JSON shape', async () => {
  const wireText = JSON.stringify({
    blocks: [{ type: 'tool_call', id: 'call-1', name: 'read', arguments: { file_path: 'package.json' } }],
    finishReason: 'tool-calls',
  })
  const frames = [
    sseFrame({ type: 'answer.snapshot', requestId: 'r1', text: wireText, delta: wireText }),
    sseFrame({ type: 'request.result', requestId: 'r1', result: { answer: wireText } }),
  ]
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => sseResponse(frames),
  })
  const { deltas, final } = await collectStream(relay.streamComplete({
    ...request,
    tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
  }))
  assert.deepEqual(deltas, [])
  assert.deepEqual(final.blocks, [{ type: 'tool_call', id: 'call-1', name: 'read', arguments: { file_path: 'package.json' } }])
})
