import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatGptBrowserRelay } from '../src/chatgpt-relay.js'

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
  assert.equal(sent.newSession, true)
  assert.equal(sent.autoOpenTab, true)
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
