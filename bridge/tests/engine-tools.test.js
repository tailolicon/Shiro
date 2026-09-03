import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { BridgeBroker, configureMcp } from '../src/index.js'
import { engineToolCatalog, engineToolsOf, MIRROR_PREFIX, registerEngineTools } from '../src/engine-tools.js'
import { PermissionPolicy } from '../src/permission-profile.js'

/** Stands in for the engine's ctx.tools registry. */
function fakeEngineTools(schemas, run = null) {
  const calls = []
  return {
    calls,
    schemas: () => schemas,
    async execute(exec) {
      calls.push(exec)
      if (run !== null) return await run(exec)
      return { isError: false, value: { echoed: exec.arguments }, content: [{ type: 'text', text: 'done' }] }
    },
  }
}

const TODO_SCHEMA = {
  name: 'todo_write',
  description: 'Replace the task list.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list.',
        items: { type: 'object', properties: { content: { type: 'string', required: true }, status: { type: 'string', enum: ['pending', 'completed'] } } },
      },
    },
  },
}

test('the engine registry is read defensively, never trusted to exist', () => {
  assert.equal(engineToolsOf(undefined), null)
  assert.equal(engineToolsOf({}), null)
  assert.equal(engineToolsOf({ tools: { schemas: () => [] } }), null, 'a registry that cannot execute is not usable')
  assert.equal(engineToolsOf({ get tools() { throw new Error('service unavailable') } }), null)
  assert.notEqual(engineToolsOf({ tools: fakeEngineTools([]) }), null)
  // A registry that throws on listing yields an empty catalog, not a crash.
  assert.deepEqual(engineToolCatalog({ schemas() { throw new Error('boom') }, execute() {} }), [])
})

test('a plugin tool keeps its own name unless a bridge action already owns it', () => {
  const catalog = engineToolCatalog(fakeEngineTools([
    TODO_SCHEMA,
    { name: 'fs_read', description: 'the engine has one too', parameters: {} },
    { name: 'run_code', description: 'code-mode transport', parameters: {} },
    { name: '   ', description: 'nameless', parameters: {} },
  ]), { taken: new Set(['fs_read']) })

  assert.deepEqual(catalog.map(row => row.name), ['todo_write', `${MIRROR_PREFIX}fs_read`])
  assert.equal(catalog[0].renamed, false, 'no collision, so the plugin keeps the name its own docs use')
  assert.equal(catalog[1].renamed, true)
  assert.equal(catalog[1].engine_name, 'fs_read', 'the engine still gets called by its own name')
})

test('a mirrored tool advertises the plugin schema and forwards the call', async t => {
  const engine = fakeEngineTools([TODO_SCHEMA])
  const server = new McpServer({ name: 'mirror-test', version: '0.0.0' })
  const descriptors = []
  registerEngineTools(server, { tools: engine, descriptors, policy: new PermissionPolicy({ profile: 'full' }) })

  const client = new Client({ name: 'mirror-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })

  const listed = (await client.listTools()).tools.find(tool => tool.name === 'todo_write')
  assert.notEqual(listed, undefined)
  assert.match(listed.description, /Replace the task list/)
  assert.match(listed.description, /DSH plugin tool/, 'the client is told where this comes from')
  // The plugin's own JSON Schema survives the trip: the model sees the real
  // parameters, which is the whole point of mirroring natively.
  assert.deepEqual(listed.inputSchema.required, ['todos'])
  assert.equal(listed.inputSchema.properties.todos.type, 'array')

  const result = await client.callTool({ name: 'todo_write', arguments: { todos: [{ content: 'ship it', status: 'pending' }] } })
  assert.notEqual(result.isError, true)
  assert.deepEqual(engine.calls[0].name, 'todo_write')
  assert.deepEqual(engine.calls[0].arguments, { todos: [{ content: 'ship it', status: 'pending' }] })
  assert.deepEqual(result.structuredContent.value, { echoed: { todos: [{ content: 'ship it', status: 'pending' }] } })
  assert.deepEqual(result.content[0], { type: 'text', text: 'done' })
})

test('a plugin failure comes back in the bridge error vocabulary', async t => {
  const engine = fakeEngineTools([TODO_SCHEMA], async () => ({
    isError: true,
    error: { code: 'INVALID_TODO', message: 'the list is empty' },
    content: [{ type: 'text', text: 'the list is empty' }],
  }))
  const server = new McpServer({ name: 'mirror-fail', version: '0.0.0' })
  registerEngineTools(server, { tools: engine, policy: new PermissionPolicy({ profile: 'full' }) })
  const client = new Client({ name: 'mirror-fail-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })

  const result = await client.callTool({ name: 'todo_write', arguments: { todos: [] } })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error.code, 'INVALID_TODO')
  assert.match(result.structuredContent.error.message, /list is empty/)

  // A thrown error is not allowed to escape as an MCP protocol failure.
  const thrower = fakeEngineTools([TODO_SCHEMA], async () => { throw new Error('the plugin exploded') })
  const server2 = new McpServer({ name: 'mirror-throw', version: '0.0.0' })
  registerEngineTools(server2, { tools: thrower })
  const client2 = new Client({ name: 'mirror-throw-client', version: '0.0.0' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server2.connect(st)
  await client2.connect(ct)
  t.after(async () => { await client2.close(); await server2.close() })
  const thrown = await client2.callTool({ name: 'todo_write', arguments: { todos: [] } })
  assert.equal(thrown.isError, true)
  assert.match(thrown.structuredContent.error.message, /todo_write failed: the plugin exploded/)
})

test('a mirrored tool is gated by the permission profile like any other action', async t => {
  const engine = fakeEngineTools([TODO_SCHEMA])
  const server = new McpServer({ name: 'mirror-policy', version: '0.0.0' })
  registerEngineTools(server, { tools: engine, policy: new PermissionPolicy({ profile: 'read-only' }) })
  const client = new Client({ name: 'mirror-policy-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })

  const refused = await client.callTool({ name: 'todo_write', arguments: { todos: [] } })
  assert.equal(refused.isError, true)
  assert.equal(refused.structuredContent.error.code, 'PERMISSION_REQUIRED')
  assert.equal(engine.calls.length, 0, 'the engine must not be reached at all')
})

test('mirrored tools appear in bridge_capabilities as their own family', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-mirror-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const engine = fakeEngineTools([TODO_SCHEMA, { name: 'lsp_definition', description: 'Jump to definition.', parameters: { type: 'object', properties: { path: { type: 'string', required: true } } } }])
  const server = new McpServer({ name: 'mirror-caps', version: '0.0.0' })
  const controller = { broker: new BridgeBroker(), async sessions() { return { sessions: [] } }, async status() { return { status: 'idle' } } }
  configureMcp(server, controller, { workspaceRoot: root, waitMs: 25_000, token: 'x' }, null, { engineTools: engine })

  const client = new Client({ name: 'mirror-caps-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })

  const catalog = (await client.callTool({ name: 'bridge_capabilities', arguments: {} })).structuredContent
  const plugins = catalog.actions.filter(action => action.family === 'plugin')
  assert.deepEqual(plugins.map(action => action.name).sort(), ['lsp_definition', 'todo_write'])
  assert.ok(catalog.families.includes('plugin'))
  // Discovery counts them, so a client can tell one deployment's plugin set
  // from another's without calling anything.
  assert.equal(catalog.action_count, catalog.actions.length)
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'lsp_definition'))
})

test('a deployment with no engine registry simply has no plugin tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-mirror-none-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const server = new McpServer({ name: 'mirror-absent', version: '0.0.0' })
  const controller = { broker: new BridgeBroker(), async sessions() { return { sessions: [] } }, async status() { return { status: 'idle' } } }
  configureMcp(server, controller, { workspaceRoot: root, waitMs: 25_000, token: 'x' }, null, {})
  const client = new Client({ name: 'mirror-absent-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })

  const catalog = (await client.callTool({ name: 'bridge_capabilities', arguments: {} })).structuredContent
  assert.equal(catalog.actions.some(action => action.family === 'plugin'), false)
  assert.ok(catalog.action_count >= 118, 'the native surface is unaffected')
})

test('the registry is read through cordis reflect, not through a bare ctx.tools', () => {
  // Regression, found only by restarting into a real engine: cordis ENFORCES
  // declared injection, so `ctx.tools` on a plugin that did not inject `tools`
  // throws `cannot get property "tools" without inject`. The old code caught
  // that throw and reported null -- "no engine here" while the engine was
  // right there, and the mirror silently registered zero tools.
  const registry = fakeEngineTools([TODO_SCHEMA])
  const cordisLike = {
    get tools() { throw new Error('cannot get property "tools" without inject') },
    reflect: { get: (name, strict) => (name === 'tools' && strict === false ? registry : undefined) },
  }
  assert.equal(engineToolsOf(cordisLike), registry)

  // A host with no tool registry at all still resolves to null, not a throw.
  assert.equal(engineToolsOf({ reflect: { get: () => undefined } }), null)
  // A reflect that itself throws falls through to the direct read.
  assert.equal(engineToolsOf({ reflect: { get() { throw new Error('boom') } }, tools: registry }), registry)
  // Something shaped like a service but missing execute() is not usable.
  assert.equal(engineToolsOf({ reflect: { get: () => ({ schemas: () => [] }) } }), null)
})

test('the registry resolves per request, so plugins mounted later still mirror', async t => {
  // Reading it once at boot froze the mirror at whatever existed in that
  // instant; tool plugins that mount after the bridge would never appear.
  const root = await mkdtemp(join(tmpdir(), 'shiro-mirror-lazy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let mounted = []
  const registry = {
    schemas: () => mounted,
    async execute() { return { isError: false, value: null, content: [] } },
  }

  const controller = { broker: new BridgeBroker(), async sessions() { return { sessions: [] } }, async status() { return { status: 'idle' } } }
  const build = async () => {
    const server = new McpServer({ name: 'mirror-lazy', version: '0.0.0' })
    // A RESOLVER, the shape startHttpServer passes.
    configureMcp(server, controller, { workspaceRoot: root, waitMs: 25_000, token: 'x' }, null, { engineTools: () => registry })
    const client = new Client({ name: 'mirror-lazy-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return { server, client }
  }

  const first = await build()
  assert.equal((await first.client.listTools()).tools.some(tool => tool.name === 'todo_write'), false, 'nothing mounted yet')
  await first.client.close()
  await first.server.close()

  // A tool plugin mounts after the bridge did.
  mounted = [TODO_SCHEMA]

  const second = await build()
  assert.equal((await second.client.listTools()).tools.some(tool => tool.name === 'todo_write'), true, 'the later plugin is mirrored')
  await second.client.close()
  await second.server.close()
})
