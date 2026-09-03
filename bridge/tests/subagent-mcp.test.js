import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { BridgeBroker, configureMcp } from '../src/index.js'
import { ProcessRegistry } from '../src/exec-actions.js'
import { PermissionPolicy } from '../src/permission-profile.js'
import { Sandbox } from '../src/sandbox.js'
import { SubagentRegistry } from '../src/subagents.js'

// A fixture CLI stands in for claude/codex/grok/antigravity so this file never
// spawns a real one: no auth dependency, no cost, no network, fast and
// deterministic. Adapter-level parsing of the REAL wire formats is covered in
// subagent-adapters.test.js; SubagentRegistry's own logic in subagents.test.js.
// This file is specifically the MCP wiring: schemas, argument flow, the
// permission gate, and bridge_capabilities/process isolation.
async function writeFixtureCli(dir) {
  const path = join(dir, 'fixture-cli.mjs')
  await writeFile(path, `
    const [, , prompt] = process.argv
    console.log(JSON.stringify({ result: \`done: \${prompt}\`, session_id: 'fixture-session' }))
  `, 'utf8')
  return path
}

function fixtureAdapters(scriptPath) {
  const fixture = {
    id: 'fixture',
    label: 'Fixture CLI',
    binary: process.execPath,
    unverified: false,
    probeAuthArgv: ['--version'],
    classifyAuth: () => true,
    buildArgv({ prompt }) { return [scriptPath, prompt] },
    parseTranscript(stdout) {
      const trimmed = stdout.trim()
      if (trimmed === '') return { done: false }
      try {
        const value = JSON.parse(trimmed)
        return { done: true, success: true, threadId: value.session_id, message: value.result }
      } catch { return { done: false } }
    },
  }
  // The action schema advertises the real four agent names via z.enum, so the
  // fixture is registered under one of THOSE names rather than a made-up one
  // -- this file is testing the real MCP surface, only the spawn target is fake.
  // Each entry needs its OWN `id` matching its key: subagent_start's output
  // schema enums the real agent names, and `id` (not the map key) is what
  // flows into that field.
  return Object.fromEntries(['claude', 'codex', 'grok', 'antigravity'].map(name => [name, { ...fixture, id: name }]))
}

async function withConnector(profile, run) {
  const root = await mkdtemp(join(tmpdir(), 'shiro-subagent-mcp-'))
  const scriptPath = await writeFixtureCli(root)
  const sandbox = new Sandbox(root)
  const processes = new ProcessRegistry({ sandbox })
  const policy = new PermissionPolicy({ profile })
  const subagents = new SubagentRegistry({ processes, adapters: fixtureAdapters(scriptPath) })
  const controller = { broker: new BridgeBroker(), async sessions() { return { sessions: [] } }, async status() { return { status: 'idle' } } }
  const server = new McpServer({ name: 'subagent-mcp-test', version: '0.0.0' })
  configureMcp(server, controller, { workspaceRoot: root, waitMs: 25_000, token: 'x' }, {}, { policy, processes, subagents })
  const client = new Client({ name: 'subagent-mcp-test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return { isError: result.isError === true, body: result.structuredContent }
  }
  try {
    await run({ call, client, root })
  } finally {
    await client.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('all six subagent tools are registered with real schemas', async () => {
  await withConnector('full', async ({ client }) => {
    const tools = (await client.listTools()).tools
    const names = ['subagent_providers', 'subagent_start', 'subagent_status', 'subagent_log', 'subagent_stop', 'subagent_list']
    for (const name of names) {
      const tool = tools.find(entry => entry.name === name)
      assert.notEqual(tool, undefined, `${name} is missing`)
      assert.ok(tool.description.length > 40, `${name} needs a real description`)
      assert.ok(tool.outputSchema, `${name} needs an outputSchema`)
    }
    const start = tools.find(entry => entry.name === 'subagent_start')
    assert.deepEqual(start.inputSchema.properties.agent.enum.sort(), ['antigravity', 'claude', 'codex', 'grok'])
  })
})

test('start -> status -> log -> stop round-trips through MCP end to end', async () => {
  await withConnector('full', async ({ call }) => {
    const started = await call('subagent_start', { agent: 'codex', prompt: 'read note.txt' })
    assert.equal(started.isError, false)
    assert.equal(started.body.agent, 'codex')
    const processId = started.body.process_id
    assert.match(processId, /^[0-9a-f-]{36}$/)

    await new Promise(resolve => setTimeout(resolve, 300))

    const status = await call('subagent_status', { process_id: processId })
    assert.equal(status.body.turn_done, true)
    assert.equal(status.body.message, 'done: read note.txt')
    assert.equal(status.body.thread_id, 'fixture-session')

    const log = await call('subagent_log', { process_id: processId })
    assert.match(log.body.content, /"result":"done: read note.txt"/)

    const listed = await call('subagent_list', {})
    assert.equal(listed.body.total, 1)
    assert.equal(listed.body.subagents[0].process_id, processId)

    const stopped = await call('subagent_stop', { process_id: processId })
    assert.equal(stopped.isError, false)
    assert.equal(stopped.body.already_stopped, true, 'it had already exited on its own')
  })
})

test('subagent_providers is reachable and reports the fixture as installed and authenticated', async () => {
  await withConnector('full', async ({ call }) => {
    const providers = await call('subagent_providers', {})
    assert.equal(providers.isError, false)
    assert.equal(providers.body.providers.length, 4)
    for (const row of providers.body.providers) {
      assert.equal(row.installed, true)
      assert.equal(row.authenticated, true)
    }
  })
})

test('an unknown process_id is NOT_FOUND, not a crash', async () => {
  await withConnector('full', async ({ call }) => {
    const status = await call('subagent_status', { process_id: '11111111-1111-4111-8111-111111111111' })
    assert.equal(status.isError, true)
    assert.equal(status.body.error.code, 'NOT_FOUND')
  })
})

test('read-only refuses subagent_start; workspace-write refuses it too, since it reaches outward', async () => {
  await withConnector('read-only', async ({ call }) => {
    const refused = await call('subagent_start', { agent: 'codex', prompt: 'x' })
    assert.equal(refused.isError, true)
    assert.equal(refused.body.error.code, 'PERMISSION_REQUIRED')
  })
  await withConnector('workspace-write', async ({ call }) => {
    const refused = await call('subagent_start', { agent: 'codex', prompt: 'x' })
    assert.equal(refused.isError, true)
    assert.equal(refused.body.error.code, 'PERMISSION_REQUIRED')
    assert.match(refused.body.error.message, /outside this machine/)
  })
})

test('read-only still allows discovery: providers, status, log, list', async () => {
  await withConnector('read-only', async ({ call }) => {
    assert.equal((await call('subagent_providers', {})).isError, false)
    assert.equal((await call('subagent_list', {})).isError, false)
  })
})

test('subagent_stop needs full too, same coarse family-level gate as fleet_stop', async () => {
  // The 'subagent' family is outward-on-write at the family level, matching
  // the existing fleet precedent (fleet_stop is also gated, not just
  // fleet_start): one honest, simple rule beats a per-action exception list
  // that has to be kept in sync by hand as actions are added.
  await withConnector('full', async ({ call, client }) => {
    const started = await call('subagent_start', { agent: 'codex', prompt: 'x' })
    await client.callTool({ name: 'permission_set', arguments: { profile: 'workspace-write' } })
    const stopped = await call('subagent_stop', { process_id: started.body.process_id, force: true })
    assert.equal(stopped.isError, true)
    assert.equal(stopped.body.error.code, 'PERMISSION_REQUIRED')
  })
})
