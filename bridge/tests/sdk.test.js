import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient, ShiroActionError } from '../src/sdk.js'

function fake({ results = {}, tools = [] } = {}) {
  const calls = []
  const client = {
    calls,
    async listTools() { return { tools } },
    async callTool(request) {
      calls.push(request)
      const answer = results[request.name]
      return answer === undefined ? { structuredContent: {} } : answer
    },
  }
  return { client, calls, shiro: createClient(client) }
}

test('an action is reachable by name or as a method, and returns its payload directly', async () => {
  const { shiro, calls } = fake({ results: { git_status: { structuredContent: { branch: 'main', dirty: false } } } })
  assert.deepEqual(await shiro.call('git_status', {}), { branch: 'main', dirty: false })
  assert.deepEqual(await shiro.git_status(), { branch: 'main', dirty: false })
  assert.deepEqual(calls.map(call => call.name), ['git_status', 'git_status'])
  // The caller gets the payload, not the MCP envelope.
  assert.equal(Object.hasOwn(await shiro.git_status(), 'structuredContent'), false)
})

test('a failed action throws, and the throw carries the bridge error code', async () => {
  const { shiro } = fake({
    results: { fs_read: { isError: true, structuredContent: { error: { code: 'OUTSIDE_SANDBOX', message: 'path escapes the workspace', details: { path: '/etc/passwd' } } } } },
  })
  // Returning an error object would make `await shiro.fs_read(...)` look like it
  // worked; throwing is what makes try/catch and `.code` branching possible.
  await assert.rejects(shiro.fs_read({ path: '/etc/passwd' }), error => {
    assert.ok(error instanceof ShiroActionError)
    assert.equal(error.code, 'OUTSIDE_SANDBOX')
    assert.equal(error.action, 'fs_read')
    assert.deepEqual(error.details, { path: '/etc/passwd' })
    return true
  })
})

test('an error with no body still throws something identifiable', async () => {
  const { shiro } = fake({ results: { fs_read: { isError: true } } })
  await assert.rejects(shiro.fs_read({}), error => {
    assert.equal(error.code, 'INTERNAL')
    assert.match(error.message, /fs_read failed/)
    return true
  })
})

test('the proxy does not invent methods out of ordinary property access', async () => {
  const { shiro } = fake()
  assert.equal(typeof shiro.call, 'function')
  assert.equal(typeof shiro.thread, 'function')
  // Things a runtime probes for must not turn into action calls.
  assert.equal(shiro.then, undefined, 'a thenable client would deadlock every await')
  assert.equal(shiro._private, undefined)
  assert.equal(shiro['not a name'], undefined)
  assert.equal(await Promise.resolve(shiro) === shiro, true)
  assert.rejects(shiro.call(''), TypeError)
})

test('capabilities can be listed and narrowed without knowing them in advance', async () => {
  const { shiro } = fake({
    results: {
      bridge_capabilities: {
        structuredContent: { actions: [{ name: 'fs_read', family: 'filesystem' }, { name: 'git_log', family: 'git' }] },
      },
    },
  })
  assert.equal((await shiro.actions()).length, 2)
  assert.deepEqual((await shiro.actions({ family: 'git' })).map(action => action.name), ['git_log'])
})

test('a schema can be fetched, and an unknown action says so instead of returning nothing', async () => {
  const { shiro } = fake({ tools: [{ name: 'fs_read', description: 'read', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }] })
  assert.equal((await shiro.schema('fs_read')).output.type, 'object')
  await assert.rejects(shiro.schema('nope'), error => error.code === 'NOT_FOUND')
})

test('a thread is resumed by id, and every call carries that id', async () => {
  const { shiro, calls } = fake()
  const thread = shiro.thread('  session-42  ')
  assert.equal(thread.id, 'session-42', 'the id is normalized once, not at every call site')

  await thread.events({ from_seq: 7, limit: 50 })
  await thread.steer({ message: 'stop and summarize' })
  await thread.fork({ at_seq: 3, label: 'alternative' })
  await thread.cancel({ reason: 'superseded' })

  assert.deepEqual(calls.map(call => call.name), ['thread_events', 'turn_steer', 'thread_fork', 'harness_cancel'])
  for (const call of calls) assert.equal(call.arguments.session_id, 'session-42')
  assert.equal(calls[0].arguments.from_seq, 7)
  assert.equal(calls[2].arguments.at_seq, 3)

  assert.throws(() => shiro.thread(''), TypeError)
})

test('a thread call cannot be tricked into addressing a different session', async () => {
  const { shiro, calls } = fake()
  // `session_id` is applied last, so a stray one in the arguments cannot
  // redirect the call to somebody else's thread.
  await shiro.thread('session-a').continue({ session_id: 'session-b', model_response: { content: 'x' } })
  assert.equal(calls[0].arguments.session_id, 'session-a')
})
