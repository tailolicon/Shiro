import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeBroker, ChatGptSolAdapter, REASONING_EFFORTS, turnCompletion } from '../src/index.js'

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
