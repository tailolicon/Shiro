import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeBroker, ChatGptSolAdapter } from '../src/index.js'

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
