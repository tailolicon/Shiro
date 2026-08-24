import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeBroker, ChatGptSolAdapter, REASONING_EFFORTS, turnCompletion } from '../src/index.js'
import { RelayError } from '../src/chatgpt-relay.js'

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const options = {
  provider: 'shiro-sol',
  model: 'gpt-5.6-sol',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }], source: { kind: 'user' } }],
  tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
  sessionId: 'session-test',
}

test('broker exposes and settles multiple independent pending model requests', async () => {
  const broker = new BridgeBroker()
  const first = broker.enqueue(options)
  const second = broker.enqueue({ ...options, sessionId: 'session-child' })
  assert.equal(broker.snapshot().length, 2)
  broker.submit(first.id, { blocks: [{ type: 'text', text: 'one' }] })
  broker.submit(second.id, { blocks: [{ type: 'text', text: 'two' }] })
  assert.equal((await first.response).blocks[0].text, 'one')
  assert.equal((await second.response).blocks[0].text, 'two')
  assert.equal(broker.snapshot().length, 0)
})

test('adapter emits raw Harness tool-call chunks and terminal usage before finish', async () => {
  const broker = new BridgeBroker()
  const adapter = new ChatGptSolAdapter(broker, 'shiro-sol', 'gpt-5.6-sol')
  const chunksPromise = (async () => {
    const chunks = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    return chunks
  })()
  const [pending] = await broker.waitForPending(1000)
  broker.submit(pending.request_id, {
    blocks: [{ type: 'tool_call', id: 'call-1', name: 'read', arguments: { path: 'package.json' } }],
  })
  const chunks = await chunksPromise
  assert.equal(chunks.at(-2).type, 'usage')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.arguments, '{"path":"package.json"}')
})

test('adapter uses the connected browser relay without publishing an MCP handoff', async () => {
  const broker = new BridgeBroker()
  const relay = {
    health: async () => ({ ready: true, clients: 1 }),
    complete: async request => ({
      blocks: [{ type: 'text', text: `relay:${request.messages[0].content[0].text}` }],
      finishReason: 'stop',
    }),
  }
  const adapter = new ChatGptSolAdapter(broker, 'shiro-sol', 'gpt-5.6-sol', relay)
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  assert.equal(broker.snapshot().length, 0)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'relay:test')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('adapter exposes native speed profiles and reasoning effort metadata', async () => {
  const adapter = new ChatGptSolAdapter(new BridgeBroker(), 'shiro-sol', 'gpt-5.6-sol')
  const models = await adapter.listModels('shiro-sol')
  assert.deepEqual(models.map(model => model.id), [
    'gpt-5.6-sol-fast',
    'gpt-5.6-sol',
    'gpt-5.6-sol-deep',
  ])
  assert.deepEqual(models.map(model => model.reasoning.defaultEffort), ['light', 'standard', 'high'])
  assert.deepEqual(models[1].reasoning.efforts, REASONING_EFFORTS)
  assert.equal(adapter.providerInfo('shiro-sol').name, 'Shiro · GPT-5.6 Sol')
  assert.equal(models[1].name, 'Shiro · GPT-5.6 Sol · Balanced')
  await assert.rejects(adapter.resolveModel('shiro-sol', 'unknown-model'), /unsupported Shiro model/)
})

test('broker publishes selected speed and effort for ChatGPT Web', () => {
  const broker = new BridgeBroker()
  const pending = broker.enqueue({
    ...options,
    model: 'gpt-5.6-sol-deep',
    reasoningEffort: 'max',
  })
  const [request] = broker.snapshot()
  assert.equal(request.generation.speed_profile, 'deep')
  assert.equal(request.generation.reasoning_effort, 'max')
  broker.cancel(pending.id)
})

test('broker redacts secrets before a model request is exposed to ChatGPT Web', () => {
  const broker = new BridgeBroker()
  const pending = broker.enqueue({
    ...options,
    messages: [{ role: 'tool', content: [{ type: 'text', text: 'token sk-abcdefghijklmnop' }] }],
  })
  const serialized = JSON.stringify(broker.snapshot()[0])
  assert.equal(serialized.includes('sk-abcdefghijklmnop'), false)
  assert.equal(serialized.includes('sk-***'), true)
  broker.cancel(pending.id)
})

test('turn completion ignores an older end when auto-continue opened a later turn', () => {
  const page = {
    events: [
      { event: { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } } },
      { event: { seq: 2, type: 'turn/end', data: { reason: { kind: 'max-tokens' } } } },
      { event: { seq: 3, type: 'user/message', data: {} } },
      { event: { seq: 4, type: 'turn/start', data: { turn: 2 } } },
    ],
  }
  assert.equal(turnCompletion(page, 0), null)
})

test('turn completion exposes the terminal reason and latest text', () => {
  const page = {
    events: [
      { event: { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } } },
      { event: { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
    ],
  }
  assert.deepEqual(turnCompletion(page, 0), {
    event: page.events[1].event,
    assistant_text: 'done',
    reason: { kind: 'completed' },
  })
})

// --- Task 1: real error taxonomy + retry policy -----------------------------

test('adapter exposes a resolved retry policy covering the relay retryable codes', () => {
  const adapter = new ChatGptSolAdapter(new BridgeBroker(), 'shiro-sol', 'gpt-5.6-sol')
  const policy = adapter.providerRetryPolicy('shiro-sol')
  assert.equal(policy.mode, 'normal')
  assert.ok(policy.maxRetries > 0)
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.ok(policy.retryableCodes.includes(code), `expected retryableCodes to include ${code}`)
  }
})

test('adapter rethrows a typed relay failure instead of silently degrading to the MCP handoff', async () => {
  const broker = new BridgeBroker()
  const relay = {
    health: async () => ({ ready: true, clients: 1 }),
    complete: async () => { throw new RelayError('boom', 'SERVER', { status: 503 }) },
  }
  const adapter = new ChatGptSolAdapter(broker, 'shiro-sol', 'gpt-5.6-sol', relay)
  await assert.rejects(collect(adapter.stream(options)), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'SERVER')
    return true
  })
  // No MCP handoff was published for the harness to answer.
  assert.equal(broker.snapshot().length, 0)
})

test('adapter still yields an aborted finish (not a thrown error) when the harness cancelled the call', async () => {
  const broker = new BridgeBroker()
  const controller = new AbortController()
  const relay = {
    health: async () => ({ ready: true, clients: 1 }),
    complete: async (_request, signal) => {
      controller.abort()
      assert.equal(signal?.aborted, true)
      throw new RelayError('ChatGPT browser relay request timed out', 'TIMEOUT')
    },
  }
  const adapter = new ChatGptSolAdapter(broker, 'shiro-sol', 'gpt-5.6-sol', relay)
  const chunks = await collect(adapter.stream({ ...options, signal: controller.signal }))
  assert.deepEqual(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
})

// --- Task 4: image attachments -----------------------------------------------

const imageOptions = {
  ...options,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this screenshot?' },
      {
        type: 'image',
        attachment: { attachmentId: 'sha256:abc123', mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'screenshot.png' },
      },
    ],
    source: { kind: 'user' },
  }],
}

test('adapter resolves image blocks through the injected attachment store and forwards bytes to the relay', async () => {
  const broker = new BridgeBroker()
  const bytes = new Uint8Array([1, 2, 3, 4])
  const readCalls = []
  const attachmentStore = {
    readImage: async (ref) => {
      readCalls.push(ref)
      return { ref: { ...ref, mediaType: 'image/png' }, data: bytes }
    },
  }
  let completeArgs
  const relay = {
    health: async () => ({ ready: true, clients: 1 }),
    complete: async (request, _signal, images) => {
      completeArgs = { request, images }
      return { blocks: [{ type: 'text', text: 'a red square' }], finishReason: 'stop' }
    },
  }
  const adapter = new ChatGptSolAdapter(broker, 'shiro-sol', 'gpt-5.6-sol', relay, () => attachmentStore)
  const chunks = await collect(adapter.stream(imageOptions))

  assert.equal(readCalls.length, 1)
  assert.equal(readCalls[0].attachmentId, 'sha256:abc123')
  assert.equal(completeArgs.images.length, 1)
  assert.equal(completeArgs.images[0].data, bytes)
  assert.equal(completeArgs.images[0].mediaType, 'image/png')
  assert.equal(completeArgs.images[0].name, 'screenshot.png')
  // The raw ImageAttachmentRef metadata never reaches the serialized prompt --
  // only a small text placeholder does.
  const serializedMessages = JSON.stringify(completeArgs.request.messages)
  assert.equal(serializedMessages.includes('sha256:abc123'), false)
  assert.match(serializedMessages, /image attached: screenshot\.png/)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta').text, 'a red square')
})

test('adapter degrades to a text placeholder when no attachment store is available', async () => {
  const broker = new BridgeBroker()
  let completeArgs
  const relay = {
    health: async () => ({ ready: true, clients: 1 }),
    complete: async (request, _signal, images) => {
      completeArgs = { request, images }
      return { blocks: [{ type: 'text', text: 'cannot see it' }], finishReason: 'stop' }
    },
  }
  const adapter = new ChatGptSolAdapter(broker, 'shiro-sol', 'gpt-5.6-sol', relay, () => undefined)
  await collect(adapter.stream(imageOptions))
  assert.deepEqual(completeArgs.images, [])
  const serializedMessages = JSON.stringify(completeArgs.request.messages)
  assert.match(serializedMessages, /could not be attached/)
})

// --- Task 5: streaming --------------------------------------------------------

test('adapter streams text deltas from a relay that supports streamComplete without duplicating the final block', async () => {
  const broker = new BridgeBroker()
  const relay = {
    health: async () => ({ ready: true, clients: 1 }),
    async *streamComplete() {
      yield { type: 'delta', text: 'Hel' }
      yield { type: 'delta', text: 'lo' }
      yield { type: 'final', value: { blocks: [{ type: 'text', text: 'Hello' }], finishReason: 'stop' } }
    },
  }
  const adapter = new ChatGptSolAdapter(broker, 'shiro-sol', 'gpt-5.6-sol', relay)
  const chunks = await collect(adapter.stream(options))

  const deltas = chunks.filter(chunk => chunk.type === 'text-delta')
  assert.deepEqual(deltas.map(chunk => chunk.text), ['Hel', 'lo'])
  const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
  assert.equal(blockEnd.block.text, 'Hello')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})
