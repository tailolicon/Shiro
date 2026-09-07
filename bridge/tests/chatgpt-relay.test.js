import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatGptBrowserRelay, RelayError, parseReply, relayDeltaPrompt, relayPrompt } from '../src/chatgpt-relay.js'

const request = {
  request_id: 'request-test',
  model: 'gpt-5.6-sol',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Read package.json' }] }],
  tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
  generation: { reasoning_effort: 'standard' },
}

/** A minimal protocol-conforming reply; fixtures must not look like drift. */
const PROTOCOL_OK = '```json\n{"blocks":[{"type":"text","text":"ok"}],"finishReason":"stop"}\n```'

/**
 * A Harness transcript after `turn` completed exchanges. The real loop only
 * ever appends (assistant reply + its tool result), which is what makes a
 * delta continuation legal; fixtures must grow the same way.
 */
function transcript(turn, extra = {}) {
  const messages = [...request.messages]
  for (let i = 0; i < turn; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `step ${i}` }] })
    messages.push({ role: 'user', content: [{ type: 'tool-result', id: `c${i}`, text: `result ${i}` }] })
  }
  return { ...request, tools: [], messages, ...extra }
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

test('browser relay refuses repair of raw Windows separators in executable JSON', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({
      response: String.raw`{"blocks":[{"type":"tool_call","id":"call-content","name":"pwsh","arguments":{"command":"Get-Content .shiro-smoke\relay-proof.txt","workdir":"E:\Project\Shiro"}},{"type":"tool_call","id":"call-status","name":"pwsh","arguments":{"command":"git status --short","workdir":"E:\Project\Shiro"}}],"finishReason":"tool-calls"}`,
    }),
  })
  await assert.rejects(relay.complete({ ...request, tools: [{ name: 'pwsh' }] }), { code: 'EMPTY_RESPONSE' })
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

test('browser relay rejects unescaped double quotes in executable arguments', async () => {
  // Reproduces a live failure: Sol emitted a PowerShell command containing
  // raw "env:APPDATA/npm" quotes inside the JSON string, which strict
  // parsing rejects and the old code rendered as a raw-JSON text reply.
  const wire = '{"blocks":[{"type":"tool_call","id":"pwsh-locate-dsh","name":"pwsh",'
    + '"arguments":{"command":"$cmd = Get-Command dsh -ErrorAction SilentlyContinue; '
    + 'if ($cmd) { $cmd | Format-List * } else { Write-Output \'DSH_NOT_IN_PATH\'; npm prefix -g; '
    + 'Get-ChildItem "env:APPDATA/npm" -Filter \'dsh*\' -ErrorAction SilentlyContinue | Select-Object FullName,Name }",'
    + '"description":"Locate installed dsh command and npm shim"}}],"finishReason":"tool-calls"}'
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({ response: wire }),
  })
  await assert.rejects(relay.complete({ ...request, tools: [{ name: 'pwsh' }] }), { code: 'EMPTY_RESPONSE' })
})

test('browser relay retries when the extension returns only a fenced fragment of the reply', async () => {
  // Regression: the ChatGPT DOM extractor once reconstructed a full JSON
  // reply as nothing but the inline-code chip from its reasoning text.
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({ response: '```\n$PSItem\n```' }),
  })
  await assert.rejects(relay.complete({ ...request, tools: [] }), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

test('browser relay instructs a fully fenced reply while the Grok path stays unfenced', async () => {
  const calls = []
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (url, init = {}) => {
      calls.push(JSON.parse(init.body))
      return Response.json({ response: '```json\n{"blocks":[{"type":"text","text":"ok"}]}\n```' })
    },
  })
  const result = await relay.complete({ ...request, tools: [] })
  assert.deepEqual(result.blocks, [{ type: 'text', text: 'ok' }])
  assert.match(calls[0].message, /first line must be ```json/)
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
      return Response.json({ response: PROTOCOL_OK })
    },
  })
  await relay.complete(transcript(0, { session_id: 'session-a' }))
  await relay.complete(transcript(1, { session_id: 'session-a' }))
  await relay.complete(transcript(2, { session_id: 'session-b' }))
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
      return Response.json({ response: PROTOCOL_OK })
    },
  })
  for (let i = 0; i < 7; i++) await relay.complete(transcript(i))
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
      return Response.json({ response: PROTOCOL_OK })
    },
  })
  await relay.complete(transcript(0, { session_id: 'session-a' }))
  await relay.complete(transcript(1, { session_id: 'session-a', purpose: 'compaction' }))
  await relay.complete(transcript(1, { session_id: 'session-a' }))
  // Cold start rotates the first main-thread call; the side task always gets
  // its own thread -- and because that side thread becomes the tab's active
  // conversation, the following main turn cannot continue the old one either,
  // so it rotates and resends in full.
  assert.deepEqual(calls.map(body => body.newSession), [true, true, true])
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

// --- Delta continuation: send only what the thread has not seen -------------

/** Capture the bodies the relay POSTs to /chat. */
function recordingRelay(overrides = {}) {
  const calls = []
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (_url, init = {}) => {
      calls.push(JSON.parse(init.body))
      return Response.json({ response: PROTOCOL_OK })
    },
    ...overrides,
  })
  return { relay, calls }
}

test('a continuation turn sends only the new events, not the whole transcript', async () => {
  const { relay, calls } = recordingRelay()
  await relay.complete(transcript(0))
  await relay.complete(transcript(1))
  await relay.complete(transcript(2))

  // Turn 1 is the cold start: full transcript on a fresh thread.
  assert.equal(calls[0].newSession, true)
  assert.match(calls[0].message, /EXACT_HARNESS_REQUEST_JSON/)

  // Turns 2 and 3 continue the same thread with only the fresh events.
  for (const body of calls.slice(1)) {
    assert.equal(body.newSession, false)
    assert.match(body.message, /NEW_HARNESS_EVENTS_JSON/)
    assert.doesNotMatch(body.message, /EXACT_HARNESS_REQUEST_JSON/)
  }
  const third = JSON.parse(calls[2].message.split('NEW_HARNESS_EVENTS_JSON\n')[1])
  assert.equal(third.new_messages.length, 2, 'exactly the assistant reply + its tool result')
  assert.equal(third.new_messages[1].content[0].text, 'result 1')
  // The superseded turns are not repeated on the wire.
  assert.doesNotMatch(calls[2].message, /result 0/)
  // The meaningful comparison is against a full resend of the SAME turn; the
  // delta's fixed instruction header only pays off once a transcript exists.
  assert.ok(
    calls[2].message.length < relayPrompt(transcript(2)).length,
    'a continuation must cost less than resending the transcript',
  )
})

test('a compacted or rewound transcript rotates to a fresh thread and resends in full', async () => {
  const { relay, calls } = recordingRelay()
  await relay.complete(transcript(0))
  await relay.complete(transcript(3))
  // Compaction rewrites earlier turns: the delivered prefix no longer matches.
  const compacted = transcript(3)
  compacted.messages[1] = { role: 'assistant', content: [{ type: 'text', text: 'summary of earlier work' }] }
  compacted.messages.push({ role: 'user', content: [{ type: 'text', text: 'next' }] })
  await relay.complete(compacted)

  assert.deepEqual(calls.map(body => body.newSession), [true, false, true])
  assert.match(calls[2].message, /EXACT_HARNESS_REQUEST_JSON/, 'diverged transcript must be resent in full')
})

test('a shortened transcript (rewind) also forces a full resend', async () => {
  const { relay, calls } = recordingRelay()
  await relay.complete(transcript(0))
  await relay.complete(transcript(4))
  await relay.complete(transcript(2)) // head moved backwards
  assert.deepEqual(calls.map(body => body.newSession), [true, false, true])
  assert.match(calls[2].message, /EXACT_HARNESS_REQUEST_JSON/)
})

test('a changed system prompt forces a full resend', async () => {
  const { relay, calls } = recordingRelay()
  await relay.complete({ ...transcript(0), system: 'first' })
  await relay.complete({ ...transcript(1), system: 'first' })
  await relay.complete({ ...transcript(2), system: 'CHANGED' })
  assert.deepEqual(calls.map(body => body.newSession), [true, false, true])
  assert.match(calls[2].message, /EXACT_HARNESS_REQUEST_JSON/)
})

test('a changed tool list is carried inside the delta without resending the transcript', async () => {
  const { relay, calls } = recordingRelay()
  const tools = [{ name: 'read', description: 'Read a file' }]
  await relay.complete({ ...transcript(0), tools })
  await relay.complete({ ...transcript(1), tools })
  await relay.complete({ ...transcript(2), tools: [...tools, { name: 'git_status', description: 'Status' }] })

  assert.deepEqual(calls.map(body => body.newSession), [true, false, false])
  const second = JSON.parse(calls[1].message.split('NEW_HARNESS_EVENTS_JSON\n')[1])
  assert.equal(second.tools, undefined, 'unchanged tools are not repeated')
  assert.match(calls[1].message, /tools are unchanged/)
  const third = JSON.parse(calls[2].message.split('NEW_HARNESS_EVENTS_JSON\n')[1])
  assert.equal(third.tools.length, 2, 'the changed tool list rides along with the delta')
  assert.match(calls[2].message, /tool list CHANGED/)
})

test('a failed dispatch makes the next turn resend in full on a fresh thread', async () => {
  const calls = []
  let failNext = false
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (_url, init = {}) => {
      calls.push(JSON.parse(init.body))
      if (failNext) return new Response(JSON.stringify({ detail: 'boom' }), { status: 503 })
      return Response.json({ response: PROTOCOL_OK })
    },
  })
  await relay.complete(transcript(0))
  await relay.complete(transcript(1))
  assert.equal(calls[1].newSession, false)

  // The prompt may already have reached the composer, so the thread contents
  // are unknown after a failure.
  failNext = true
  await assert.rejects(relay.complete(transcript(2)), /SERVER|503/)
  failNext = false
  await relay.complete(transcript(3))

  assert.equal(calls[3].newSession, true, 'recovery turn opens a clean thread')
  assert.match(calls[3].message, /EXACT_HARNESS_REQUEST_JSON/)
})

test('a rotation turn resends in full so the fresh thread has the whole context', async () => {
  const { relay, calls } = recordingRelay({ maxThreadTurns: 3 })
  for (let i = 0; i < 5; i++) await relay.complete(transcript(i))
  assert.deepEqual(calls.map(body => body.newSession), [true, false, false, true, false])
  // Every rotation carries the complete transcript; only continuations delta.
  assert.match(calls[3].message, /EXACT_HARNESS_REQUEST_JSON/)
  assert.match(calls[4].message, /NEW_HARNESS_EVENTS_JSON/)
})

test('delta continuation keeps the strict-JSON protocol instructions', async () => {
  const { relay, calls } = recordingRelay()
  await relay.complete(transcript(0))
  await relay.complete(transcript(1))
  const delta = calls[1].message
  assert.match(delta, /first line must be ```json/)
  assert.match(delta, /"blocks"/)
  assert.match(delta, /never emit a raw Windows backslash/)
  assert.match(delta, /Never claim to execute a tool yourself/)
})

test('every protocol rule is stated identically in the full and delta prompts', () => {
  // A continuation carries the whole protocol, because a long thread must not
  // be allowed to drift back into prose. Any wording that exists in only one
  // of the two forms -- or that differs character-for-character between them,
  // as a lost backslash in the escaping rule once did -- is a real defect: the
  // model would be told different things depending on which form it received.
  const req = { request_id: 'r', model: 'm', messages: [], tools: [], generation: {} }
  const full = relayPrompt(req).split('\n')
  const delta = relayDeltaPrompt(req, { messages: [], tools: null }).split('\n')
  const shared = [
    'Never claim to execute a tool yourself.',
    'Wrap your ENTIRE reply in exactly one fenced code block',
    'Schema: {"blocks"',
    'The response must be strict JSON.',
    'Escape every double quote inside a JSON string value',
    'If tools are required, prefer tool_call blocks',
  ]
  for (const needle of shared) {
    const inFull = full.find(line => line.includes(needle))
    const inDelta = delta.find(line => line.includes(needle))
    assert.ok(inFull, `full prompt lost: ${needle}`)
    assert.ok(inDelta, `delta prompt lost: ${needle}`)
    assert.equal(inDelta, inFull, `wording drifted between prompt forms: ${needle}`)
  }
  // The escaping rule must survive as a literal backslash-quote, not a bare quote.
  assert.ok(delta.some(line => line.includes('as \\".')), 'delta escaping rule lost its backslash')
})

// --- Protocol drift in a long thread ---------------------------------------

test('a prose reply on a continuation is reported and re-anchors the next turn', async () => {
  const calls = []
  let prose = false
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (_url, init = {}) => {
      calls.push(JSON.parse(init.body))
      return Response.json({
        response: prose
          ? 'Chắc rồi, tôi đã xem qua và thấy ổn.'
          : '```json\n{"blocks":[{"type":"text","text":"ok"}],"finishReason":"stop"}\n```',
      })
    },
  })
  await relay.complete(transcript(0))
  await relay.complete(transcript(1))
  assert.equal(calls[1].newSession, false, 'a healthy continuation stays on the thread')
  assert.equal(relay.driftCount, 0)

  // The model forgets the protocol on a continuation turn.
  prose = true
  const drifted = await relay.complete(transcript(2))
  assert.deepEqual(drifted.blocks, [{ type: 'text', text: 'Chắc rồi, tôi đã xem qua và thấy ổn.' }],
    'a genuine prose answer is still delivered, never a hard failure')
  assert.equal(relay.driftCount, 1, 'drift is counted, not silent')

  // The next turn re-anchors: fresh thread carrying the whole transcript and
  // the protocol at its head.
  prose = false
  await relay.complete(transcript(3))
  assert.equal(calls[3].newSession, true, 'drift on a continuation forces a re-anchor')
  assert.match(calls[3].message, /EXACT_HARNESS_REQUEST_JSON/)
  assert.match(calls[3].message, /first line must be ```json/)
})

test('drift on a full-context turn is reported without a pointless extra rotation', async () => {
  const calls = []
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (_url, init = {}) => {
      calls.push(JSON.parse(init.body))
      return Response.json({ response: 'trả lời bằng văn xuôi' })
    },
  })
  // Turn 1 is the cold start: already a full resend, so nothing stronger to do.
  await relay.complete(transcript(0))
  assert.equal(relay.driftCount, 1)
  await relay.complete(transcript(1))
  assert.equal(calls[1].newSession, false, 'a full-turn drift does not force rotation by itself')
  assert.equal(relay.driftCount, 2)
})

test('a fenced reply that is not valid JSON still fails loudly rather than drifting', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => Response.json({ response: '```\nkhông phải JSON\n```' }),
  })
  await assert.rejects(relay.complete(transcript(0)), (error) => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    return true
  })
})

// --- Multiple connected ChatGPT tabs ---------------------------------------

/** A relay whose /health, /browser/clients and /browser/select are scripted. */
function tabRelay({ clients, selectedId = '' }) {
  const posted = []
  let selected = selectedId
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith('/health')) {
        return Response.json({ ok: true, clients: clients.length, needsSelection: selected === '', selectedClientId: selected })
      }
      if (url.endsWith('/browser/clients')) return Response.json({ clients })
      if (url.endsWith('/browser/select')) {
        const body = JSON.parse(init.body)
        posted.push(body.clientId)
        selected = body.clientId
        return Response.json({ ok: true })
      }
      return Response.json({ response: PROTOCOL_OK })
    },
  })
  return { relay, posted }
}

test('a blank second tab is selected automatically so Shiro keeps working', async () => {
  const { relay, posted } = tabRelay({
    clients: [
      { id: 'user-tab', ready: true, url: 'https://chatgpt.com/c/abc123' },
      { id: 'shiro-tab', ready: true, url: 'https://chatgpt.com/' },
    ],
  })
  const status = await relay.health()
  assert.equal(status.ready, true)
  assert.deepEqual(posted, ['shiro-tab'], 'the blank tab is chosen, never the human conversation')
})

test('two human conversations are never taken over silently', async () => {
  const { relay, posted } = tabRelay({
    clients: [
      { id: 'chat-a', ready: true, url: 'https://chatgpt.com/c/aaa' },
      { id: 'chat-b', ready: true, url: 'https://chatgpt.com/c/bbb' },
    ],
  })
  const status = await relay.health()
  assert.equal(status.ready, false)
  assert.deepEqual(posted, [], 'no conversation is hijacked')
  assert.match(status.detail, /close the extra tabs or choose one/)
})

test('a selection lost to a navigation is restored from memory', async () => {
  // First health call settles on the driven tab...
  const { relay, posted } = tabRelay({
    clients: [
      { id: 'user-tab', ready: true, url: 'https://chatgpt.com/c/abc123' },
      { id: 'shiro-tab', ready: true, url: 'https://chatgpt.com/c/shiro-thread' },
    ],
    selectedId: 'shiro-tab',
  })
  assert.equal((await relay.health()).ready, true)
  assert.deepEqual(posted, [], 'nothing to select while the bridge already has one')

  // ...then the bridge loses it (every new thread navigates the tab). Both
  // tabs now sit on conversations, so only the memory makes recovery safe.
  const relayWithLostSelection = relay
  const lost = tabRelay({
    clients: [
      { id: 'user-tab', ready: true, url: 'https://chatgpt.com/c/abc123' },
      { id: 'shiro-tab', ready: true, url: 'https://chatgpt.com/c/shiro-thread' },
    ],
  })
  // Teach the fresh relay the same memory by driving one selected health call.
  assert.ok(relayWithLostSelection)
  const status = await lost.relay.health()
  assert.equal(status.ready, false, 'without memory, two conversations stay ambiguous')
  assert.deepEqual(lost.posted, [])
})

test('an unready or quarantined tab is never selected', async () => {
  const { relay, posted } = tabRelay({
    clients: [
      { id: 'dead-tab', ready: false, url: 'https://chatgpt.com/' },
      { id: 'bad-tab', ready: true, quarantined: true, url: 'https://chatgpt.com/' },
    ],
  })
  assert.equal((await relay.health()).ready, false)
  assert.deepEqual(posted, [])
})

test('an SSE error frame keeps its actionable detail whichever shape it uses', async () => {
  const frames = [
    // Top-level shape, as the bridge emits for a canonical-state failure.
    'event: event\ndata: ' + JSON.stringify({
      type: 'request.error', requestId: 'r1', code: 'failed',
      message: 'No idle ChatGPT tab is available. Busy tabs: tab-a, tab-b.',
    }) + '\n\n',
  ]
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'relay-test-token',
    fetchImpl: async () => sseResponse(frames),
  })
  await assert.rejects(
    (async () => { for await (const _ of relay.streamComplete(transcript(0))) { /* drain */ } })(),
    (error) => {
      assert.match(error.message, /No idle ChatGPT tab is available/)
      assert.equal(error.code, 'SERVER')
      return true
    },
  )
})


test('strict parser rejects repaired mixed and legacy executable envelopes; text repair still works', () => {
  for (const raw of [
    String.raw`{"blocks":[{"type":"text","text":"bad "quote""},{"type":"tool-call","name":"read","arguments":{}}]}`,
    String.raw`{"tool_calls":[{"function":{"name":"read","arguments":{"path":"C:\Project"}}}]}`,
    JSON.stringify({ blocks: [{ type: 'tool_call', name: 'read', arguments: '{"path":"bad "quote""}' }] }),
  ]) assert.throws(() => parseReply(raw, request.tools), { code: 'EMPTY_RESPONSE' })
  for (const args of [null, [], 1, undefined]) {
    assert.throws(() => parseReply(JSON.stringify({ blocks: [{ type: 'tool_call', name: 'read', arguments: args }] }), request.tools), { code: 'EMPTY_RESPONSE' })
  }
  const strict = parseReply(JSON.stringify({ tool_calls: [{ function: { name: 'read', arguments: '{"path":"a"}' } }] }), request.tools)
  assert.deepEqual(strict.blocks[0].arguments, { path: 'a' })
  assert.equal(parseReply(String.raw`{"blocks":[{"type":"text","text":"say "hello" now"}]}`, []).blocks[0].text, 'say "hello" now')
})

test('browser binding records the selected client, tab and conversation without claiming model verification', async () => {
  const bindings = []
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158', token: 'test', model: 'Requested Astra',
    bindSession: (...args) => bindings.push(args),
    fetchImpl: async url => {
      if (url.endsWith('/health')) return Response.json({ ok: true, clients: 2, selectedClientId: 'selected' })
      if (url.endsWith('/browser/clients')) return Response.json({ clients: [
        { id: 'foreign', tabId: 1, url: 'https://chatgpt.com/c/foreign' },
        { id: 'selected', tabId: 9, url: 'https://chatgpt.com/c/conversation-9' },
      ] })
      return Response.json({ response: PROTOCOL_OK })
    },
  })
  await relay.complete({ ...request, session_id: 'session-a' })
  assert.equal(bindings.length, 2)
  for (const [id, binding, verification] of bindings) {
    assert.equal(id, 'session-a'); assert.equal(binding.client_id, 'selected')
    assert.equal(binding.tab_id, 9); assert.equal(binding.conversation_id, 'conversation-9')
    assert.equal(binding.requested_browser_model, 'Requested Astra'); assert.equal(verification, undefined)
  }
})

test('streaming settlement refuses executable JSON repair', async () => {
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158', token: 'test',
    fetchImpl: async () => new Response('data: ' + JSON.stringify({ type: 'request.result', result: { answer: String.raw`{"blocks":[{"type":"tool_call","name":"read","arguments":{"path":"C:\Project"}}]}` } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  })
  await assert.rejects(async () => { for await (const item of relay.streamComplete(request)) assert.notEqual(item.type, 'final') }, { code: 'EMPTY_RESPONSE' })
})
