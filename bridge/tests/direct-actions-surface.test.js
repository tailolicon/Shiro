import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ActionMetrics } from '../src/direct-actions.js'
import { ProcessRegistry } from '../src/exec-actions.js'
import { Sandbox } from '../src/sandbox.js'
import { TerminalRegistry } from '../src/terminal-actions.js'
import { ThreadRegistry } from '../src/thread-registry.js'
import { WorkspaceRegistry } from '../src/workspaces.js'
import { BridgeBroker, configureMcp, LOG_STREAMS, readServiceLog } from '../src/index.js'
import { setConfirmationPolicy } from '../src/action-errors.js'

// This file exercises the confirmation brake, which ships OFF: a destructive
// action no longer costs a refusal-then-repeat round trip on an operator's own
// machine. The tests below are what an operator gets back with
// SHIRO_REQUIRE_CONFIRMATIONS=1, so they turn it on for this file.
setConfirmationPolicy({ required: true })

// The twelve actions the connector exposed before the direct-action work.
// Nothing here may disappear or change shape.
const ORIGINAL_ACTIONS = [
  'harness_profiles', 'fleet_start', 'fleet_status', 'fleet_stop', 'harness_start',
  'harness_sessions', 'harness_get_request', 'harness_continue', 'harness_status',
  'harness_respond', 'harness_get_artifact', 'harness_cancel',
]

const DIRECT_ACTIONS = [
  'bridge_status', 'bridge_capabilities', 'session_runtime_status',
  'workspace_list', 'workspace_open', 'workspace_create', 'workspace_close',
  'worktree_create', 'worktree_list', 'worktree_remove', 'worktree_snapshot',
  'worktree_snapshots', 'worktree_restore', 'worktree_handoff', 'worktree_snapshot_drop',
  'terminal_start', 'terminal_write', 'terminal_read', 'terminal_resize',
  'terminal_signal', 'terminal_stop', 'terminal_list',
  'image_open', 'image_metadata', 'pdf_info', 'pdf_render_page', 'download_file', 'artifact_import',
  'browser_tab_screenshot', 'browser_tab_navigate',
  'browser_dom_query', 'browser_tab_click', 'browser_tab_type', 'browser_tab_evaluate',
  'fs_read', 'fs_list', 'fs_stat', 'fs_search', 'fs_create_file', 'fs_update_file',
  'fs_mkdir', 'fs_delete', 'fs_move', 'fs_copy',
  'exec_run', 'process_start', 'process_status', 'process_logs', 'process_stop', 'process_list',
  'git_status', 'git_repo_info', 'git_diff', 'git_log', 'git_show', 'git_compare',
  'git_branch_list', 'git_branch_create', 'git_checkout', 'git_add', 'git_commit',
  'git_restore', 'git_reset', 'git_merge', 'git_rebase', 'git_tag_list', 'git_tag_create',
  'git_remote_list', 'git_fetch', 'git_pull', 'git_push',
  'task_list', 'task_run', 'test_run',
  'review_diff', 'review_stage_hunk', 'review_revert_hunk', 'review_findings',
  'harness_operation_list', 'harness_operation_get', 'harness_session_get',
  'thread_events', 'turn_steer', 'thread_fork', 'thread_archive', 'thread_unarchive',
  'thread_archived', 'thread_prune',
  'fleet_list', 'fleet_update', 'fleet_delete', 'fleet_run_now', 'fleet_runs',
  'fleet_worker_status', 'fleet_worker_recycle',
  'browser_owned_tabs', 'browser_tab_close', 'browser_tab_send_prompt',
  'artifact_list', 'artifact_metadata', 'artifact_delete',
  'config_get', 'config_validate', 'logs_tail', 'metrics_snapshot',
  'permission_get', 'permission_set',
  'continuation_set', 'continuation_status', 'continuation_clear', 'continuation_check',
  'subagent_providers', 'subagent_start', 'subagent_status', 'subagent_log', 'subagent_stop', 'subagent_list',
]

function testConfig(workspaceRoot, overrides = {}) {
  return {
    workspaceAllowlist: [],
    // configureMcp sets the confirmation policy from config on every build, so
    // a top-of-file setConfirmationPolicy would be overwritten the moment a
    // connector is constructed. This file's subject is the brake, so it is
    // configured here where the connector reads it.
    requireConfirmations: true,
    provider: 'shiro-sol',
    model: 'gpt-5.6-sol',
    workspaceRoot,
    port: 23157,
    waitMs: 25_000,
    maxConcurrentTurns: 4,
    relayUrl: '',
    relayModel: 'GPT-5.6 Sol',
    grokProvider: 'shiro-grok',
    grokModels: ['grok-4.6'],
    grokCliPath: '',
    fleetStateDir: join(workspaceRoot, '..', 'state'),
    logDir: join(workspaceRoot, '..', 'logs'),
    ...overrides,
  }
}

/**
 * Controller double that fails loudly if a direct action ever reaches an
 * engine/LLM entry point. Every direct action must be deterministic.
 */
function inertController() {
  const broker = new BridgeBroker()
  const forbidden = []
  const trap = name => (...args) => {
    forbidden.push(name)
    throw new Error(`${name} must never be reached by a direct action`)
  }
  return {
    broker,
    forbidden,
    start: trap('start'),
    submit: trap('submit'),
    respond: trap('respond'),
    cancel: trap('cancel'),
    readAttachment: trap('readAttachment'),
    async status() { forbidden.push('status'); return {} },
    async sessions() { return { workspace_id: 'workspace-test', sessions: [{ sessionId: 'session-test', title: 'demo' }] } },
    async sessionLog() { return { events: [] } },
    operationList: () => ({ operations: [], total: 0, active: 0, max_concurrent_turns: 4, truncated: false }),
    operationForSession: () => undefined,
    canFork: () => false,
    async threadEvents(sessionId, options) {
      return {
        session_id: sessionId,
        workspace: 'project',
        events: [{ event: { seq: 7, type: 'assistant/message' } }],
        returned: 1,
        from_seq: options.fromSeq,
        next_seq: 7,
        window_start: 0,
        cursor_behind_window: false,
        truncated: false,
        has_active_turn: false,
      }
    },
    async steer(sessionId) {
      const error = new Error(`thread ${sessionId} has no running turn to steer; use harness_start to begin one`)
      error.code = 'CONFLICT'
      throw error
    },
    async fork() {
      const error = new Error('this engine build exposes no sessions.fork')
      error.code = 'UNSUPPORTED'
      throw error
    },
    operationGet: () => { const error = new Error('operation not registered'); error.code = 'NOT_FOUND'; throw error },
    async sessionGet(sessionId) {
      if (sessionId !== 'session-test') { const error = new Error('missing'); error.code = 'NOT_FOUND'; throw error }
      return { workspace_id: 'workspace-test', session: { sessionId }, has_active_turn: false }
    },
  }
}

async function withConnector(run, { fleetManager = null, controller = inertController(), runtime, allowlist = [], allowlistFromBase = false, permissionProfile, permissionRules } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'shiro-surface-'))
  const root = join(base, 'project')
  await mkdir(root)
  // allowlistFromBase lets a worktree land beside the project the way it does
  // on a real deployment, where the allowlist is the project's parent.
  const roots = allowlistFromBase ? [...allowlist, base] : allowlist
  const config = testConfig(root, {
    ...(roots.length === 0 ? {} : { workspaceAllowlist: roots }),
    ...(permissionProfile === undefined ? {} : { permissionProfile }),
    ...(permissionRules === undefined ? {} : { permissionRules }),
  })
  const sharedRuntime = runtime ?? (() => {
    // Same wiring as startHttpServer: these registries are bridge-lifetime, not
    // per-request, so an opened workspace survives the next MCP connection.
    const workspaces = new WorkspaceRegistry({ projectRoot: root, allowedRoots: config.workspaceAllowlist ?? [] })
    const sandbox = workspaces.primary().sandbox
    return {
      workspaces,
      threads: new ThreadRegistry({ stateFile: join(base, 'threads.json') }),
      sandbox,
      processes: new ProcessRegistry({ sandbox }),
      terminals: new TerminalRegistry(),
      metrics: new ActionMetrics(),
    }
  })()
  const connect = async () => {
    const server = new McpServer({ name: 'shiro-surface-test', version: '0.0.0' })
    configureMcp(server, controller, config, fleetManager, sharedRuntime)
    const client = new Client({ name: 'shiro-surface-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return { server, client }
  }
  const first = await connect()
  const call = async (name, args = {}) => {
    const result = await first.client.callTool({ name, arguments: args })
    return { isError: result.isError === true, body: result.structuredContent, content: result.content }
  }
  try {
    await run({ client: first.client, call, root, base, config, controller, runtime: sharedRuntime, connect })
  } finally {
    await first.client.close()
    await first.server.close()
    await sharedRuntime.terminals?.disposeAll()
    await sharedRuntime.processes.disposeAll()
    await rm(base, { recursive: true, force: true })
  }
}

test('the connector exposes every original action plus the direct-action surface', async () => {
  await withConnector(async ({ client, call }) => {
    const catalog = await client.listTools()
    const names = catalog.tools.map(tool => tool.name)

    for (const name of ORIGINAL_ACTIONS) assert.ok(names.includes(name), `${name} disappeared from the connector`)
    for (const name of DIRECT_ACTIONS) assert.ok(names.includes(name), `${name} is missing`)
    assert.equal(names.length, ORIGINAL_ACTIONS.length + DIRECT_ACTIONS.length)
    assert.equal(new Set(names).size, names.length, 'action names must be unique')

    // Every action carries the metadata a mature connector advertises.
    for (const tool of catalog.tools) {
      assert.equal(typeof tool.title, 'string', `${tool.name} needs a title`)
      assert.ok(tool.description.length > 40, `${tool.name} needs a real description`)
      assert.ok(tool.inputSchema, `${tool.name} needs an inputSchema`)
      assert.ok(tool.outputSchema, `${tool.name} needs an outputSchema`)
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name} is missing ${hint}`)
      }
    }

    // Backward compatibility of the original twelve, field by field.
    const original = name => catalog.tools.find(tool => tool.name === name)
    assert.deepEqual(original('harness_start').inputSchema.required, ['prompt'])
    assert.ok(original('harness_start').inputSchema.properties.speed_profile)
    assert.ok(original('harness_start').inputSchema.properties.reasoning_effort)
    assert.equal(original('harness_start').annotations.destructiveHint, false)
    assert.equal(original('harness_cancel').annotations.destructiveHint, true)
    assert.equal(original('harness_status').annotations.readOnlyHint, true)
    assert.equal(original('fleet_status').annotations.readOnlyHint, true)
    assert.equal(original('fleet_stop').annotations.destructiveHint, true)
    assert.deepEqual(original('fleet_start').inputSchema.required.sort(), ['name', 'prompt', 'size'])

    // The capability report describes exactly what is registered.
    const capabilities = (await call('bridge_capabilities')).body
    assert.equal(capabilities.action_count, names.length)
    assert.deepEqual(capabilities.actions.map(action => action.name).sort(), [...names].sort())
    assert.ok(capabilities.families.includes('filesystem'))
    assert.ok(capabilities.families.includes('git'))
    assert.ok(capabilities.error_codes.includes('OUTSIDE_SANDBOX'))
    assert.ok(capabilities.error_codes.includes('PERMISSION_REQUIRED'))
    assert.equal(capabilities.features.fleet, false, 'this deployment has no browser relay')
    assert.ok(capabilities.limits.max_concurrent_turns >= 1)
    assert.ok(capabilities.unsupported.some(entry => entry.capability.includes('bridge_reload')))
    assert.ok(capabilities.unsupported.every(entry => typeof entry.reason === 'string' && entry.reason.length > 40))

    const status = (await call('bridge_status')).body
    assert.equal(status.ok, true)
    assert.equal(status.project_root, (await call('bridge_capabilities')).body.project_root)
    assert.equal(status.harness.active_turns, 0)
    assert.equal(status.processes.running, 0)
    assert.equal(status.health.browser_relay, false)
  })
})

test('direct actions never touch the engine, a session, or a model request', async () => {
  const controller = inertController()
  await withConnector(async ({ call, root, controller: used }) => {
    await writeFile(join(root, 'file.txt'), 'contents\n')
    await writeFile(join(root, 'package.json'), '{"name":"x","scripts":{"noop":"node -e 0"}}')

    for (const [name, args] of [
      ['bridge_status', {}],
      ['bridge_capabilities', {}],
      ['fs_read', { path: 'file.txt' }],
      ['fs_list', {}],
      ['fs_stat', { path: 'file.txt' }],
      ['fs_search', { query: 'contents' }],
      ['task_list', {}],
      ['process_list', {}],
      ['harness_operation_list', {}],
      ['metrics_snapshot', {}],
      ['config_get', {}],
    ]) {
      const result = await call(name, args)
      assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result.body)}`)
    }

    assert.deepEqual(used.forbidden, [], 'a direct action reached an engine entry point')
    assert.equal(used.broker.snapshot().length, 0, 'a direct action enqueued a model request')
  }, { controller })
})

test('errors normalize to the documented codes through MCP', async () => {
  await withConnector(async ({ call, root }) => {
    await writeFile(join(root, 'file.txt'), 'body')

    const escape = await call('fs_read', { path: '../../../etc/passwd' })
    assert.equal(escape.isError, true)
    assert.equal(escape.body.error.code, 'OUTSIDE_SANDBOX')
    assert.equal(escape.body.error.retryable, false)

    assert.equal((await call('fs_read', { path: 'missing.txt' })).body.error.code, 'NOT_FOUND')
    assert.equal((await call('fs_create_file', { path: 'file.txt', content: 'other' })).body.error.code, 'ALREADY_EXISTS')
    assert.equal((await call('fs_update_file', { path: 'file.txt', content: 'x', expected_sha256: 'deadbeef' })).body.error.code, 'CONFLICT')
    assert.equal((await call('exec_run', { argv: ['definitely-not-installed-xyz'] })).body.error.code, 'NOT_FOUND')
    assert.equal((await call('git_status', {})).body.error.code, 'UNSUPPORTED')
    assert.equal((await call('fleet_list', {})).body.error.code, 'UNSUPPORTED')
    assert.equal((await call('harness_operation_get', { operation_id: '11111111-1111-4111-8111-111111111111' })).body.error.code, 'NOT_FOUND')
    assert.equal((await call('logs_tail', { stream: 'backend.stdout' })).body.error.code, 'NOT_FOUND')
  })
})

test('destructive direct actions refuse to act until they are confirmed', async () => {
  await withConnector(async ({ call, root }) => {
    await mkdir(join(root, 'tree'))
    await writeFile(join(root, 'tree', 'leaf.txt'), 'leaf')
    await writeFile(join(root, 'target.txt'), 'target')
    await writeFile(join(root, 'source.txt'), 'source')

    const blocked = await call('fs_delete', { path: 'tree', recursive: true })
    assert.equal(blocked.isError, true)
    assert.equal(blocked.body.error.code, 'PERMISSION_REQUIRED')
    assert.match(blocked.body.error.message, /confirm=true/)
    assert.equal((await call('fs_stat', { path: 'tree/leaf.txt' })).isError, false, 'the tree must survive an unconfirmed delete')

    assert.equal((await call('fs_move', { source: 'source.txt', destination: 'target.txt', overwrite: true })).body.error.code, 'PERMISSION_REQUIRED')
    assert.equal((await call('fs_copy', { source: 'source.txt', destination: 'target.txt', overwrite: true })).body.error.code, 'PERMISSION_REQUIRED')
    assert.equal((await call('artifact_delete', { path: 'target.txt' })).body.error.code, 'PERMISSION_REQUIRED')
    // download_file leaves the machine as well as writing to disk: it must not
    // contact the server at all before the user has approved the exact call.
    const download = await call('download_file', { url: 'http://127.0.0.1:9/never.bin', path: 'never.bin' })
    assert.equal(download.body.error.code, 'PERMISSION_REQUIRED')
    assert.match(download.body.error.message, /confirm=true/)

    const confirmed = await call('fs_delete', { path: 'tree', recursive: true, confirm: true })
    assert.equal(confirmed.isError, false)
    assert.equal(confirmed.body.deleted, true)
    assert.equal((await call('fs_stat', { path: 'tree' })).body.error.code, 'NOT_FOUND')

    // artifact_delete deliberately refuses directories: trees go through fs_delete.
    await mkdir(join(root, 'dir2'))
    assert.equal((await call('artifact_delete', { path: 'dir2', confirm: true })).body.error.code, 'CONFLICT')
  })
})

test('paginated actions expose stable cursors through MCP', async () => {
  await withConnector(async ({ call, root }) => {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(join(root, name), name)

    const first = await call('fs_list', { limit: 2 })
    assert.equal(first.body.returned, 2)
    assert.equal(first.body.truncated, true)
    const second = await call('fs_list', { limit: 2, cursor: first.body.next_cursor })
    assert.equal(second.body.truncated, false)
    assert.deepEqual(
      [...first.body.entries, ...second.body.entries].map(entry => entry.name),
      ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
    )

    await writeFile(join(root, 'long.txt'), 'x'.repeat(5000))
    const page = await call('fs_read', { path: 'long.txt', max_bytes: 1000 })
    assert.equal(page.body.truncated, true)
    assert.equal(page.body.next_offset, 1000)
    const tail = await call('fs_read', { path: 'long.txt', offset: 4000 })
    assert.equal(tail.body.eof, true)
    assert.equal(tail.body.bytes_returned, 1000)
  })
})

test('process state and metrics are bridge-lifetime, not per-request', async () => {
  await withConnector(async ({ call, connect, runtime }) => {
    const started = await call('process_start', { argv: ['node', '-e', 'setInterval(() => console.log("alive"), 20)'], label: 'server' })
    assert.equal(started.isError, false)
    assert.equal(started.body.state, 'running')

    // A second MCP server -- what a second HTTP request builds -- must see the
    // same process registry and the same counters.
    const secondary = await connect()
    try {
      const listed = await secondary.client.callTool({ name: 'process_list', arguments: {} })
      assert.equal(listed.structuredContent.running, 1)
      assert.equal(listed.structuredContent.processes[0].process_id, started.body.process_id)

      const status = await secondary.client.callTool({ name: 'bridge_status', arguments: {} })
      assert.equal(status.structuredContent.processes.running, 1)

      const metrics = await secondary.client.callTool({ name: 'metrics_snapshot', arguments: {} })
      assert.ok(metrics.structuredContent.total_calls >= 2)
      assert.ok(metrics.structuredContent.actions.some(action => action.name === 'process_start'))
    } finally {
      await secondary.client.close()
      await secondary.server.close()
    }

    const stopped = await call('process_stop', { process_id: started.body.process_id, grace_ms: 500 })
    assert.equal(stopped.body.state, 'stopped')
    assert.equal((await call('process_list', { state: 'running' })).body.running, 0)
    assert.equal(runtime.processes.list({}).total, 1, 'the stopped process stays listable in the same bridge-lifetime registry')
  })
})

test('config and log introspection stay secret-free and allowlisted', async () => {
  await withConnector(async ({ call, base, config }) => {
    const effective = (await call('config_get')).body
    assert.equal(effective.provider, 'shiro-sol')
    assert.equal(effective.redacted, true)
    assert.equal(effective.relay.configured, false)
    const serialized = JSON.stringify(effective)
    assert.ok(!serialized.includes('token'), 'config_get must not carry any token field')

    const valid = await call('config_validate', {
      config: { workspaceRoot: config.workspaceRoot, token: 'a-real-bridge-token-value', port: 23157 },
    })
    assert.equal(valid.body.valid, true)
    assert.ok(!JSON.stringify(valid.body.normalized).includes('a-real-bridge-token-value'), 'validation must not echo the token back')

    const invalid = await call('config_validate', { config: { workspaceRoot: config.workspaceRoot, token: 'x', port: 80 } })
    assert.equal(invalid.body.valid, false)
    assert.match(invalid.body.message, /port/)

    // logs_tail takes a stream name from a fixed list, never a path.
    const streams = LOG_STREAMS
    assert.ok(streams.includes('backend.stderr'))
    await assert.rejects(readServiceLog(join(base, 'logs'), { stream: '../../../etc/passwd' }), error => error.code === 'INVALID_ARGUMENT')

    await mkdir(join(base, 'logs'), { recursive: true })
    await writeFile(join(base, 'logs', 'backend.stderr.log'), 'starting\nBearer abcdefghijklmnopqrstuvwxyz012345\ndone\n')
    const tail = await call('logs_tail', { stream: 'backend.stderr' })
    assert.equal(tail.isError, false)
    assert.match(tail.body.content, /starting/)
    assert.ok(!tail.body.content.includes('abcdefghijklmnopqrstuvwxyz012345'), 'log secrets must be redacted')
    assert.equal(tail.body.redacted, true)
    assert.equal(tail.body.truncated, false)
  })
})

test('artifact actions classify and address produced files', async () => {
  await withConnector(async ({ call, root }) => {
    await writeFile(join(root, 'report.md'), '# report\n')
    await writeFile(join(root, 'shot.png'), Buffer.from([137, 80, 78, 71]))

    const listed = (await call('artifact_list', {})).body
    assert.equal(listed.total, 2)
    assert.ok(listed.artifacts.every(artifact => artifact.resource_uri.startsWith('shiro://artifact')))
    assert.equal(listed.artifacts.find(artifact => artifact.path === 'shot.png').kind, 'image')
    assert.equal(listed.artifacts.find(artifact => artifact.path === 'report.md').mime_type, 'text/plain')

    const onlyImages = (await call('artifact_list', { kind: 'image' })).body
    assert.deepEqual(onlyImages.artifacts.map(artifact => artifact.path), ['shot.png'])

    const meta = (await call('artifact_metadata', { path: 'report.md', include_hash: true })).body
    assert.equal(meta.kind, 'text')
    assert.equal(meta.fetchable, true)
    assert.match(meta.sha256, /^[0-9a-f]{64}$/)

    // The uri artifact_metadata reports is the one harness_get_artifact returns.
    const fetched = await call('harness_get_artifact', { path: 'report.md' })
    assert.equal(fetched.body.resource_uri, meta.resource_uri)
  })
})

/**
 * Fleet manager double: the fleet and browser actions are thin, typed wrappers,
 * so this asserts the wiring (argument mapping, ownership refusals, capability
 * reporting) rather than re-testing FleetManager itself.
 */
function fakeFleetManager() {
  const calls = []
  const snapshot = {
    name: 'hachimi', status: 'running', running: true, size: 2, active_workers: 2,
    chat_mode: 'normal', interval_minutes: 27, stagger_seconds: 0, max_session_runs: 4,
    round: 3, prompt_hash: 'p', config_hash: 'c', recorded_runs: 3,
    started_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:05:00.000Z',
    next_run_at: '2026-09-01T00:27:00.000Z', summary: { submitted: 2 },
    workers: [1, 2].map(slot => ({ worker_id: `hachimi:${slot}`, slot, state: 'submitted', browser_tab_id: 100 + slot, run_count: 1 })),
  }
  const record = (name, ...args) => { calls.push([name, ...args]) }
  return {
    calls,
    async start(args) { record('start', args); return snapshot },
    async status(name) { record('status', name); return snapshot },
    async resolveOwnedTabStatus(name) { return snapshot },
    async stop(name) { record('stop', name); return { ...snapshot, running: false, status: 'stopped' } },
    async list() { record('list'); return { fleets: [snapshot], total: 1, running: 1 } },
    async update(name, changes) { record('update', name, changes); return { ...snapshot, applied: { interval_minutes: changes.intervalMinutes } } },
    async remove(name) { record('remove', name); return { name, deleted: true, rounds_recorded: 3 } },
    async runNow(name) { record('runNow', name); return snapshot },
    async runs(name, options) { record('runs', name, options); return { name, runs: [], returned: 0, total: 0, cursor: 0, truncated: false, retained_rounds: 50 } },
    async workerStatus(name, slot) { record('workerStatus', name, slot); return { name, running: true, chat_mode: 'normal', max_session_runs: 4, worker: snapshot.workers[slot - 1], recent_runs: [] } },
    async recycleWorker(name, slot, options) { record('recycleWorker', name, slot, options); return { name, slot, outcome: 'closed', conversation_deleted: true, running: true, worker: snapshot.workers[slot - 1] } },
    async ownedTabs(options) { record('ownedTabs', options); return { tabs: [{ browser_tab_id: 101, owned: true, fleet: 'hachimi', slot: 1 }], total: 1, owned: 1, includes_foreign: options?.includeForeign === true } },
    // Ownership behaves like the real helper: a tab that is not ours is
    // NOT_FOUND with the same wording as one that does not exist.
    async resolveOwnedTab(tabId, options) {
      record('resolveOwnedTab', tabId, options)
      if (tabId !== 101) {
        const error = new Error(`browser tab ${tabId} is not an open Shiro-owned tab`)
        error.code = 'NOT_FOUND'
        throw error
      }
      const rec = {
        browser_tab_id: 101, browser_client_id: 'client-101', url: 'https://chatgpt.com/c/x',
        fleet: 'hachimi', slot: 1, worker_id: 'hachimi:1', chat_mode: 'normal', busy: false,
      }
      return { record: rec, marker: 'marker-101' }
    },
    async recheckOwnedTab(tabId, marker, action) {
      record('recheckOwnedTab', tabId, marker, action)
      return { record: { browser_tab_id: tabId }, marker }
    },
    transport: {
      async capabilities() { record('capabilities'); return { screenshot: true, navigate: true, dom: true, evaluate: true } },
      async queryDom(clientId, opts) {
        record('queryDom', clientId, opts)
        return {
          generation: 'g1',
          elements: [{ element_id: 'g1:1', tag: 'button', name: 'Send', visible: true, enabled: true, editable: false, box: { x: 1, y: 2, width: 8, height: 4 } }],
          total: 1,
          truncated: false,
          url: 'https://chatgpt.com/c/x',
        }
      },
      async clickElement(clientId, opts) { record('clickElement', clientId, opts); return { clicked: true, tag: 'button', at: { x: 5, y: 4 } } },
      async typeIntoElement(clientId, opts) { record('typeIntoElement', clientId, opts); return { typed: true, mode: opts.mode, submitted: opts.submit === true, tag: 'textarea' } },
      async evaluate(clientId, opts) { record('evaluate', clientId, opts); return { json: '"ok"', valueType: 'string', bytes: 4 } },
      async navigate(clientId, opts) {
        record('navigate', clientId, opts)
        return { url: opts.url, loaded: true, frameId: 'frame-1' }
      },
      async screenshot(clientId, opts) {
        record('screenshot', clientId, opts)
        const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const ihdr = Buffer.alloc(25)
        ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4)
        ihdr.writeUInt32BE(2, 8); ihdr.writeUInt32BE(2, 12); ihdr[16] = 8; ihdr[17] = 6
        return { image: { data_base64: Buffer.concat([signature, ihdr]).toString('base64') } }
      },
    },
    async closeOwnedTab(tabId) {
      record('closeOwnedTab', tabId)
      if (tabId !== 101) {
        const error = new Error(`browser tab ${tabId} is not an open Shiro-owned tab`)
        error.code = 'NOT_FOUND'
        throw error
      }
      return { browser_tab_id: tabId, closed: true, fleet: 'hachimi', slot: 1, fleet_running: true }
    },
    async sendPromptToOwnedTab(tabId, prompt) {
      record('sendPromptToOwnedTab', tabId, prompt)
      if (tabId !== 101) {
        const error = new Error(`browser tab ${tabId} is not an open Shiro-owned tab`)
        error.code = 'NOT_FOUND'
        throw error
      }
      return { browser_tab_id: tabId, submitted: true, fleet: 'hachimi', slot: 1, run_count: 2, max_session_runs: 4 }
    },
  }
}

test('fleet and browser actions map arguments through to the fleet manager', async () => {
  const fleetManager = fakeFleetManager()
  await withConnector(async ({ call }) => {
    const capabilities = (await call('bridge_capabilities')).body
    assert.equal(capabilities.features.fleet, true)
    assert.equal(capabilities.features.browser_tabs, true)

    assert.equal((await call('fleet_list')).body.total, 1)

    const updated = await call('fleet_update', { name: 'hachimi', interval_minutes: 60, max_session_runs: 2 })
    assert.equal(updated.isError, false)
    assert.deepEqual(fleetManager.calls.find(entry => entry[0] === 'update'), [
      'update', 'hachimi', { prompt: undefined, intervalMinutes: 60, staggerSeconds: undefined, maxSessionRuns: 2 },
    ])

    assert.equal((await call('fleet_run_now', { name: 'hachimi' })).body.round, 3)
    assert.equal((await call('fleet_runs', { name: 'hachimi', limit: 5 })).body.retained_rounds, 50)
    assert.deepEqual(fleetManager.calls.find(entry => entry[0] === 'runs'), ['runs', 'hachimi', { limit: 5, cursor: 0 }])
    assert.equal((await call('fleet_worker_status', { name: 'hachimi', slot: 2 })).body.worker.slot, 2)

    const recycled = await call('fleet_worker_recycle', { name: 'hachimi', slot: 1 })
    assert.equal(recycled.body.conversation_deleted, true)
    assert.deepEqual(fleetManager.calls.find(entry => entry[0] === 'recycleWorker'), ['recycleWorker', 'hachimi', 1, { deleteConversation: true }])
    await call('fleet_worker_recycle', { name: 'hachimi', slot: 1, delete_conversation: false })
    assert.deepEqual(fleetManager.calls.filter(entry => entry[0] === 'recycleWorker').at(-1)[3], { deleteConversation: false })

    assert.equal((await call('fleet_delete', { name: 'hachimi' })).body.deleted, true)

    const tabs = await call('browser_owned_tabs', { include_foreign: true })
    assert.equal(tabs.body.includes_foreign, true)
    assert.equal(tabs.body.owned, 1)

    assert.equal((await call('browser_tab_send_prompt', { browser_tab_id: 101, prompt: 'hello' })).body.run_count, 2)
    assert.equal((await call('browser_tab_close', { browser_tab_id: 101 })).body.closed, true)

    // A tab the fleet does not own is refused, and the refusal is an isError
    // result rather than a protocol failure.
    const foreign = await call('browser_tab_close', { browser_tab_id: 4242 })
    assert.equal(foreign.isError, true)
    assert.equal(foreign.body.error.code, 'NOT_FOUND')
    assert.doesNotMatch(foreign.body.error.message, /not owned|foreign/)
  }, { fleetManager })
})

test('browser_tab_screenshot captures an owned tab into the workspace', async () => {
  const fleetManager = fakeFleetManager()
  await withConnector(async ({ call, root }) => {
    const capabilities = (await call('bridge_capabilities')).body
    assert.equal(capabilities.features.browser_screenshot, true)
    // A relay that CAN capture must not still be advertising the action as
    // unsupported: the entry is probed, not a constant.
    assert.ok(
      capabilities.unsupported.every(entry => !/browser_tab_screenshot/.test(entry.capability)),
      'a capable relay removes the screenshot caveat',
    )

    const shot = await call('browser_tab_screenshot', { browser_tab_id: 101 })
    assert.equal(shot.isError, false, JSON.stringify(shot.body))
    assert.equal(shot.body.browser_tab_id, 101)
    assert.equal(shot.body.mime_type, 'image/png')
    assert.equal(shot.body.width, 2)
    assert.ok(shot.body.resource_uri.startsWith('shiro://artifact'))
    assert.ok(!JSON.stringify(shot.body).includes('iVBOR'), 'the image is a file, not a base64 blob in the result')

    // The file is really there, and the relay was addressed by the derived id.
    const stat = await call('fs_stat', { path: shot.body.path })
    assert.equal(stat.body.size, shot.body.bytes)
    assert.equal(fleetManager.calls.find(entry => entry[0] === 'screenshot')[1], 'client-101')

    // Ownership was verified and then RE-verified before the relay call.
    assert.ok(fleetManager.calls.some(entry => entry[0] === 'resolveOwnedTab'))
    assert.ok(fleetManager.calls.some(entry => entry[0] === 'recheckOwnedTab'))
    assert.ok(root.length > 0)
  }, { fleetManager })
})

test('include_foreign grants no authority to any content or write action', async () => {
  const fleetManager = fakeFleetManager()
  await withConnector(async ({ call }) => {
    // Listing with include_foreign is observation. It must not make a foreign
    // tab actionable by anything -- this is the regression guard for every
    // browser action added from here on.
    const listed = await call('browser_owned_tabs', { include_foreign: true })
    assert.equal(listed.body.includes_foreign, true)

    for (const [name, args] of [
      ['browser_tab_screenshot', { browser_tab_id: 4242 }],
      ['browser_tab_navigate', { browser_tab_id: 4242, url: 'https://chatgpt.com/' }],
      ['browser_dom_query', { browser_tab_id: 4242, selector: 'button' }],
      ['browser_tab_click', { browser_tab_id: 4242, element_id: 't4242.g1:1' }],
      ['browser_tab_type', { browser_tab_id: 4242, element_id: 't4242.g1:1', text: 'x' }],
      ['browser_tab_evaluate', { browser_tab_id: 4242, expression: '1', confirm: true }],
      ['browser_tab_close', { browser_tab_id: 4242 }],
      ['browser_tab_send_prompt', { browser_tab_id: 4242, prompt: 'hi' }],
    ]) {
      const refused = await call(name, args)
      assert.equal(refused.isError, true, `${name} must refuse a foreign tab`)
      assert.equal(refused.body.error.code, 'NOT_FOUND', `${name} must not confirm the tab exists`)
    }
    assert.equal(fleetManager.calls.filter(entry => entry[0] === 'screenshot').length, 0)
  }, { fleetManager })
})

/**
 * Schema conformance for the git mutations. The SDK validates structuredContent
 * against each tool's declared outputSchema and rejects undeclared keys, so
 * driving a whole local git flow through MCP is what proves the declared shapes
 * match what the handlers actually return.
 */
test('the local git flow round-trips through MCP with schema-valid results', async () => {
  await withConnector(async ({ call, root }) => {
    const { runGit } = await import('../src/git-commands.js')
    const git = async (...argv) => {
      const result = await runGit(root, argv)
      assert.equal(result.exitCode, 0, `git ${argv.join(' ')}: ${result.stderr}`)
    }
    await git('init', '--initial-branch=main')
    await git('config', 'user.email', 'fixture@example.invalid')
    await git('config', 'user.name', 'Shiro Fixture')
    await writeFile(join(root, 'a.txt'), 'first\n')
    await git('add', 'a.txt')
    await git('commit', '--message', 'initial')

    const ok = async (name, args = {}) => {
      const result = await call(name, args)
      assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result.body)}`)
      return result.body
    }

    assert.equal((await ok('git_repo_info')).branch, 'main')
    assert.equal((await ok('git_status')).clean, true)
    assert.equal((await ok('git_branch_list')).current, 'main')
    assert.equal((await ok('git_log', { limit: 1 })).commits[0].subject, 'initial')
    assert.equal((await ok('git_show')).files_changed, 1)
    assert.deepEqual((await ok('git_tag_list')).tags, [])
    assert.deepEqual((await ok('git_remote_list')).remotes, [])

    const branch = await ok('git_branch_create', { name: 'feature', checkout: true })
    assert.equal(branch.checked_out, true)
    await writeFile(join(root, 'b.txt'), 'second\n')
    assert.equal((await ok('git_add', { paths: ['b.txt'] })).staged, 1)
    assert.equal((await ok('git_diff', { staged: true })).files_changed, 1)
    const commit = await ok('git_commit', { message: 'add b' })
    assert.match(commit.sha, /^[0-9a-f]{40}$/)

    const compared = await ok('git_compare', { base: 'main', head: 'feature' })
    assert.equal(compared.ahead, 1)

    assert.equal((await ok('git_checkout', { ref: 'main' })).branch, 'main')
    const merged = await ok('git_merge', { ref: 'feature' })
    assert.equal(merged.merged, true)

    const tag = await ok('git_tag_create', { name: 'v1', message: 'release one' })
    assert.equal(tag.annotated, true)
    assert.equal((await ok('git_tag_list')).total, 1)

    await writeFile(join(root, 'a.txt'), 'edited\n')
    assert.equal((await ok('git_restore', { paths: ['a.txt'], confirm: true })).clean, true)
    assert.equal((await ok('git_reset', { mode: 'mixed', ref: 'HEAD' })).mode, 'mixed')
    assert.equal((await ok('git_reset', { mode: 'hard', ref: 'HEAD', confirm: true })).clean, true)

    // A rebase with nothing to do still round-trips its success shape.
    assert.equal((await ok('git_rebase', { action: 'start', onto: 'main', confirm: true })).rebased, true)

    // Network writes stay refused and the refusal names the exact operation.
    const refused = await call('git_push', { remote: 'origin' })
    assert.equal(refused.isError, true)
    assert.equal(refused.body.error.code, 'PERMISSION_REQUIRED')
    assert.match(refused.body.error.message, /remote "origin"/)
  })
})

test('a second workspace is addressable end to end and stays confined', async () => {
  const base = await mkdtemp(join(tmpdir(), 'shiro-multi-'))
  const projects = join(base, 'Projects')
  const sibling = join(projects, 'other-app')
  await mkdir(sibling, { recursive: true })
  await writeFile(join(sibling, 'README.md'), '# other app\n')
  try {
    await withConnector(async ({ call, root, connect }) => {
      await writeFile(join(root, 'local.txt'), 'primary\n')

      const listed = await call('workspace_list', { include_candidates: true })
      assert.equal(listed.body.multi_root, true)
      assert.equal(listed.body.workspaces.length, 1)
      assert.equal(listed.body.workspaces[0].primary, true)
      assert.ok(listed.body.candidates.some(entry => entry.name === 'other-app'))

      // Outside the allowlist is refused before anything is touched.
      const refused = await call('workspace_open', { path: join(base, 'not-allowed') })
      assert.equal(refused.body.error.code, 'OUTSIDE_SANDBOX')

      const opened = await call('workspace_open', { path: sibling })
      assert.equal(opened.isError, false)
      const workspace = opened.body.workspace_id
      assert.equal((await call('workspace_open', { path: sibling })).body.already_open, true)

      // The same action reads a different root purely by the selector.
      assert.equal((await call('fs_read', { path: 'local.txt' })).body.content, 'primary\n')
      assert.equal((await call('fs_read', { path: 'README.md', workspace })).body.content, '# other app\n')
      assert.equal((await call('fs_read', { path: 'local.txt', workspace })).body.error.code, 'NOT_FOUND')
      assert.equal((await call('fs_read', { path: '../project/local.txt', workspace })).body.error.code, 'OUTSIDE_SANDBOX')
      assert.equal((await call('fs_read', { path: 'README.md', workspace: 'made-up' })).body.error.code, 'NOT_FOUND')

      // Writes, exec and artifact listing follow the same selector.
      assert.equal((await call('fs_create_file', { path: 'notes.txt', content: 'hi', workspace })).isError, false)
      const ran = await call('exec_run', { argv: ['sh', '-c', 'ls'], workspace })
      assert.match(ran.body.stdout, /notes\.txt/)
      const artifacts = await call('artifact_list', { workspace })
      assert.ok(artifacts.body.artifacts.some(entry => entry.path === 'notes.txt'))
      assert.ok(
        artifacts.body.artifacts.every(entry => entry.resource_uri.includes(`workspace=${workspace}`)),
        'an artifact URI outside the primary workspace must say which workspace it belongs to',
      )

      // Workspace registration is bridge-lifetime, like processes and metrics.
      const second = await connect()
      try {
        const reread = await second.client.callTool({ name: 'fs_read', arguments: { path: 'README.md', workspace } })
        assert.equal(reread.structuredContent.content, '# other app\n')
      } finally {
        await second.client.close()
        await second.server.close()
      }

      assert.equal((await call('workspace_close', { workspace: 'project' })).body.error.code, 'INVALID_ARGUMENT')
      assert.equal((await call('workspace_close', { workspace })).body.closed, true)
      assert.equal((await call('fs_read', { path: 'README.md', workspace })).body.error.code, 'NOT_FOUND')
      // Closing is bookkeeping only: the files are untouched.
      assert.equal((await call('workspace_open', { path: sibling })).body.already_open, false)
    }, { allowlist: [projects] })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a single-rooted deployment reports no multi-root capability', async () => {
  await withConnector(async ({ call, config }) => {
    assert.deepEqual(config.workspaceAllowlist, [])
    const listed = await call('workspace_list', {})
    assert.equal(listed.body.multi_root, false)
    assert.deepEqual(listed.body.allowed_roots, [])
    const capabilities = await call('bridge_capabilities')
    assert.equal(capabilities.body.features.multi_root_workspaces, false)
    const refused = await call('workspace_open', { path: '/etc' })
    assert.equal(refused.body.error.code, 'OUTSIDE_SANDBOX')
    assert.match(refused.body.error.message, /no workspace allowlist/)
  })
})

test('an interactive terminal round-trips through MCP', async () => {
  await withConnector(async ({ call }) => {
    const started = await call('terminal_start', { argv: ['python3', '-i', '-q'], label: 'repl' })
    assert.equal(started.isError, false, JSON.stringify(started.body))
    const terminal = started.body.terminal_id
    assert.equal(started.body.state, 'running')
    assert.equal(started.body.workspace, 'project')

    const prompt = await call('terminal_read', { terminal_id: terminal, from_offset: 0, wait_ms: 5000 })
    assert.match(prompt.body.content, />>>/)

    assert.equal((await call('terminal_write', { terminal_id: terminal, input: '21 * 2', submit: true })).isError, false)
    const answer = await call('terminal_read', { terminal_id: terminal, from_offset: prompt.body.next_offset, wait_ms: 5000 })
    assert.match(answer.body.content, /42/)

    assert.equal((await call('terminal_resize', { terminal_id: terminal, cols: 100, rows: 40 })).body.cols, 100)
    const listed = await call('terminal_list', {})
    assert.equal(listed.body.running, 1)
    assert.equal(listed.body.terminals[0].terminal_id, terminal)

    const stopped = await call('terminal_stop', { terminal_id: terminal, force: true })
    assert.equal(stopped.isError, false)
    // A well-formed but unknown id is a clean NOT_FOUND, not a protocol error.
    assert.equal(
      (await call('terminal_read', { terminal_id: '00000000-0000-4000-8000-000000000000' })).body.error.code,
      'NOT_FOUND',
    )
  })
})

test('image and pdf actions return real media blocks through MCP', async () => {
  await withConnector(async ({ call, root }) => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      (() => {
        const ihdr = Buffer.alloc(25)
        ihdr.writeUInt32BE(13, 0)
        ihdr.write('IHDR', 4)
        ihdr.writeUInt32BE(3, 8)
        ihdr.writeUInt32BE(5, 12)
        ihdr[16] = 8
        ihdr[17] = 6
        return ihdr
      })(),
    ])
    await writeFile(join(root, 'shot.png'), png)

    const meta = await call('image_metadata', { path: 'shot.png' })
    assert.equal(meta.body.width, 3)
    assert.equal(meta.body.height, 5)
    assert.equal(meta.body.fits_inline, true)

    const opened = await call('image_open', { path: 'shot.png' })
    assert.equal(opened.isError, false)
    const image = opened.content.find(block => block.type === 'image')
    assert.ok(image, 'image_open must return an MCP image block, not base64 text')
    assert.equal(image.mimeType, 'image/png')
    assert.equal(Buffer.from(image.data, 'base64').length, png.length)
    assert.equal(opened.body.sha256.length, 64)

    await writeFile(join(root, 'notes.txt'), 'not an image')
    assert.equal((await call('image_open', { path: 'notes.txt' })).body.error.code, 'INVALID_ARGUMENT')
    assert.equal((await call('pdf_info', { path: 'notes.txt' })).isError, true)
  })
})

test('artifact_import declares the connector file parameter and gates the fetch', async () => {
  await withConnector(async ({ client, call }) => {
    const catalog = await client.listTools()
    const tool = catalog.tools.find(entry => entry.name === 'artifact_import')

    // The declaration ChatGPT's runtime looks for when substituting an
    // attachment; without it the file never becomes a download_url.
    assert.deepEqual(tool._meta?.['openai/fileParams'], ['file'])
    const file = tool.inputSchema.properties.file
    const objectBranch = (file.anyOf ?? file.oneOf ?? [file]).find(branch => branch.type === 'object')
    assert.ok(objectBranch, 'the file parameter must declare the connector file object shape')
    for (const property of ['download_url', 'file_id', 'mime_type', 'file_name']) {
      assert.ok(objectBranch.properties[property], `the file object must declare ${property}`)
    }
    assert.deepEqual([...objectBranch.required].sort(), ['download_url', 'file_id'])

    // It fetches a URL and writes to disk, so it carries download_file's gate:
    // an unconfirmed call must not contact anything.
    const blocked = await call('artifact_import', {
      file: { download_url: 'http://127.0.0.1:9/never.bin', file_id: 'file_1', file_name: 'never.bin' },
    })
    assert.equal(blocked.body.error.code, 'PERMISSION_REQUIRED')
    assert.match(blocked.body.error.message, /confirm=true/)

    // The degraded reference forms report what arrived instead of failing blankly.
    const bareId = await call('artifact_import', { file: 'file_abc', confirm: true })
    assert.equal(bareId.body.error.code, 'UNSUPPORTED')
    assert.match(bareId.body.error.message, /file id/)
    const containerPath = await call('artifact_import', { file: '/mnt/data/big.zip', confirm: true })
    assert.equal(containerPath.body.error.code, 'UNSUPPORTED')

    const capabilities = await call('bridge_capabilities')
    assert.equal(capabilities.body.features.file_import, true)
    assert.ok(
      capabilities.body.unsupported.every(entry => !/artifact_import/.test(entry.capability)),
      'artifact_import must not still be advertised as unsupported',
    )
  })
})

test('a Harness turn can only be anchored in an opened workspace', async () => {
  const controller = inertController()
  await withConnector(async ({ call, controller: used }) => {
    // The workspace is resolved before anything reaches the engine: an unknown
    // id must fail without the controller's start() trap ever firing, which is
    // what keeps the operator allowlist governing agent turns too.
    const unknown = await call('harness_start', { prompt: 'do something', workspace: 'not-open' })
    assert.equal(unknown.isError, true)
    assert.equal(unknown.body.error.code, 'NOT_FOUND')
    assert.match(unknown.body.error.message, /workspace_open/)

    assert.equal((await call('harness_sessions', { workspace: 'not-open' })).body.error.code, 'NOT_FOUND')
    assert.equal(
      (await call('harness_session_get', { session_id: 'session-test', workspace: 'not-open' })).body.error.code,
      'NOT_FOUND',
    )
    assert.deepEqual(used.forbidden, [], 'no engine entry point may be reached for an unknown workspace')

    // Omitting it stays the old behaviour: the primary workspace resolves and
    // the call proceeds into the controller (which this double then traps).
    const primary = await call('harness_sessions', {})
    assert.equal(primary.isError, false)
  }, { controller })
})

test('every control-plane action that takes an opaque id also takes the workspace', async () => {
  await withConnector(async ({ client }) => {
    const catalog = await client.listTools()
    const properties = name => catalog.tools.find(tool => tool.name === name).inputSchema.properties
    // Without this parameter the gate has nothing to compare against, so a
    // refactor that drops it would silently reopen cross-workspace access.
    for (const name of [
      'harness_start', 'harness_sessions', 'harness_session_get', 'harness_get_request',
      'harness_continue', 'harness_status', 'harness_respond', 'harness_cancel',
      'harness_operation_list', 'harness_operation_get', 'harness_get_artifact',
    ]) {
      assert.ok(properties(name).workspace, `${name} must accept a workspace selector`)
    }
    // ...and none of them may require it: omitting it stays the project root.
    for (const name of ['harness_continue', 'harness_status', 'harness_cancel', 'harness_operation_list']) {
      const required = catalog.tools.find(tool => tool.name === name).inputSchema.required ?? []
      assert.ok(!required.includes('workspace'), `${name} must keep workspace optional`)
    }
  })
})

test('browser_tab_navigate drives an owned tab and refuses foreign ones', async () => {
  const fleetManager = fakeFleetManager()
  await withConnector(async ({ call }) => {
    assert.equal((await call('bridge_capabilities')).body.features.browser_navigate, true)

    // The fake fleet reports running:true, so leaving ChatGPT is refused
    // outright and staying on ChatGPT is allowed.
    const inside = await call('browser_tab_navigate', { browser_tab_id: 101, url: 'https://chatgpt.com/c/next' })
    assert.equal(inside.isError, false, JSON.stringify(inside.body))
    assert.equal(inside.body.left_chatgpt, false)
    assert.equal(inside.body.loaded, true)
    assert.equal(fleetManager.calls.find(entry => entry[0] === 'navigate')[1], 'client-101')

    const away = await call('browser_tab_navigate', { browser_tab_id: 101, url: 'http://localhost:3000/', confirm: true })
    assert.equal(away.body.error.code, 'BUSY')
    assert.match(away.body.error.message, /fleet_stop/)

    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'about:blank']) {
      const refused = await call('browser_tab_navigate', { browser_tab_id: 101, url })
      assert.equal(refused.body.error.code, 'INVALID_ARGUMENT', url)
    }

    const foreign = await call('browser_tab_navigate', { browser_tab_id: 4242, url: 'https://chatgpt.com/' })
    assert.equal(foreign.body.error.code, 'NOT_FOUND')
    assert.doesNotMatch(foreign.body.error.message, /not owned|foreign/)
  }, { fleetManager })
})

test('the DOM query -> click -> type flow round-trips through MCP', async () => {
  const fleetManager = fakeFleetManager()
  await withConnector(async ({ call }) => {
    const capabilities = (await call('bridge_capabilities')).body
    assert.equal(capabilities.features.browser_dom, true)

    const found = await call('browser_dom_query', { browser_tab_id: 101, selector: 'button' })
    assert.equal(found.isError, false, JSON.stringify(found.body))
    assert.equal(found.body.returned, 1)
    const handle = found.body.elements[0].element_id
    // Handles are tab-scoped opaque strings, not raw page ids.
    assert.match(handle, /^t101\./)

    const clicked = await call('browser_tab_click', { browser_tab_id: 101, element_id: handle })
    assert.equal(clicked.body.clicked, true)
    // The tab prefix never reaches the page.
    assert.equal(fleetManager.calls.find(entry => entry[0] === 'clickElement')[2].elementId, 'g1:1')

    const typed = await call('browser_tab_type', { browser_tab_id: 101, element_id: handle, text: 'a secret prompt', submit: true })
    assert.equal(typed.body.typed, true)
    assert.equal(typed.body.characters, 15)
    assert.ok(!JSON.stringify(typed.body).includes('secret prompt'), 'typed text is not echoed back')

    // A handle from another tab is refused before the relay is asked.
    const crossed = await call('browser_tab_click', { browser_tab_id: 101, element_id: 't102.g1:1' })
    assert.equal(crossed.body.error.code, 'CONFLICT')
  }, { fleetManager })
})

test('browser_tab_evaluate is gated behind an explicit confirmation', async () => {
  const fleetManager = fakeFleetManager()
  await withConnector(async ({ call }) => {
    assert.equal((await call('bridge_capabilities')).body.features.browser_evaluate, true)

    const blocked = await call('browser_tab_evaluate', { browser_tab_id: 101, expression: 'document.title' })
    assert.equal(blocked.body.error.code, 'PERMISSION_REQUIRED')
    assert.equal(fleetManager.calls.filter(entry => entry[0] === 'evaluate').length, 0)

    const ran = await call('browser_tab_evaluate', { browser_tab_id: 101, expression: 'document.title', confirm: true })
    assert.equal(ran.isError, false, JSON.stringify(ran.body))
    assert.equal(ran.body.json, '"ok"')
    assert.equal(ran.body.value_type, 'string')
  }, { fleetManager })
})

test('a worktree becomes a workspace, isolates a task, and hands the work back', async () => {
  const { execFileSync } = await import('node:child_process')
  await withConnector(async ({ call, root, base }) => {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString()
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' })
    git('config', 'user.email', 'test@shiro.local')
    git('config', 'user.name', 'Shiro Test')
    await writeFile(join(root, 'app.txt'), 'original\n')
    git('add', 'app.txt')
    git('commit', '-qm', 'seed')

    // One call: git worktree add + register it as an addressable workspace.
    const created = await call('worktree_create', { branch: 'task-1', name: 'task-1' })
    assert.equal(created.isError, false, JSON.stringify(created.body))
    const workspace = created.body.workspace_id
    assert.equal(created.body.branch, 'task-1')
    assert.ok(created.body.path.startsWith(base), 'the checkout lands inside the allowlist')

    // The payoff: every existing action works on the isolated checkout, and the
    // main checkout does not see the edits.
    assert.equal((await call('fs_read', { path: 'app.txt', workspace })).body.content, 'original\n')
    await call('fs_update_file', { path: 'app.txt', content: 'changed in the worktree\n', workspace })
    const ran = await call('exec_run', { argv: ['cat', 'app.txt'], workspace })
    assert.equal(ran.body.stdout, 'changed in the worktree\n')
    assert.equal((await call('fs_read', { path: 'app.txt' })).body.content, 'original\n', 'the main checkout is untouched')
    assert.equal((await call('git_status', { workspace })).body.branch, 'task-1')

    const listed = await call('worktree_list', {})
    assert.equal(listed.body.total, 2)
    assert.ok(listed.body.worktrees.some(entry => entry.workspace === workspace), 'the listing maps checkout to workspace')

    // Hand the result back to the main checkout.
    const handed = await call('worktree_handoff', { from: workspace, to: 'project', confirm: true })
    assert.equal(handed.isError, false, JSON.stringify(handed.body))
    assert.equal(handed.body.applied, true)
    assert.equal((await call('fs_read', { path: 'app.txt' })).body.content, 'changed in the worktree\n')

    // Removing it needs confirmation, and closes the workspace with it.
    const unconfirmed = await call('worktree_remove', { worktree: workspace })
    assert.equal(unconfirmed.body.error.code, 'PERMISSION_REQUIRED')
    const removed = await call('worktree_remove', { worktree: workspace, force: true, confirm: true })
    assert.equal(removed.body.removed, true)
    assert.equal(removed.body.workspace_closed, workspace)
    assert.equal((await call('fs_read', { path: 'app.txt', workspace })).body.error.code, 'NOT_FOUND')
  }, { allowlistFromBase: true })
})

test('a snapshot survives work being thrown away, and cannot escape the allowlist', async () => {
  const { execFileSync } = await import('node:child_process')
  await withConnector(async ({ call, root }) => {
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 'test@shiro.local'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.name', 'Shiro Test'], { cwd: root, stdio: 'pipe' })
    await writeFile(join(root, 'app.txt'), 'original\n')
    execFileSync('git', ['add', 'app.txt'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, stdio: 'pipe' })

    await call('fs_update_file', { path: 'app.txt', content: 'valuable\n' })
    await call('fs_create_file', { path: 'untracked.txt', content: 'also valuable\n' })
    const snapshot = await call('worktree_snapshot', { label: 'before the risky bit' })
    assert.equal(snapshot.body.files_changed, 2, 'the untracked file is captured too')

    // The save point does not disturb the tree it saved.
    assert.equal((await call('fs_read', { path: 'app.txt' })).body.content, 'valuable\n')
    assert.equal((await call('worktree_snapshots', {})).body.total, 1)

    // Throw the work away, then bring it back.
    await call('fs_update_file', { path: 'app.txt', content: 'original\n' })
    await call('fs_delete', { path: 'untracked.txt' })
    const restored = await call('worktree_restore', { snapshot_id: snapshot.body.snapshot_id, confirm: true })
    assert.equal(restored.isError, false, JSON.stringify(restored.body))
    assert.equal(restored.body.applied, true)
    assert.equal((await call('fs_read', { path: 'app.txt' })).body.content, 'valuable\n')
    assert.equal((await call('fs_read', { path: 'untracked.txt' })).body.content, 'also valuable\n')

    // A checkout outside the allowlist is refused before git runs.
    const escape = await call('worktree_create', { branch: 'escape', path: '/tmp/shiro-worktree-escape' })
    assert.equal(escape.body.error.code, 'OUTSIDE_SANDBOX')
  }, { allowlistFromBase: true })
})

test('archiving a thread hides it and blocks resuming it, without deleting anything', async () => {
  await withConnector(async ({ call }) => {
    assert.equal((await call('harness_sessions', {})).body.sessions.length, 1)

    const archived = await call('thread_archive', { session_id: 'session-test', reason: 'finished' })
    assert.equal(archived.isError, false, JSON.stringify(archived.body))
    assert.equal(archived.body.archived, true)
    // The action must not imply a deletion it did not perform.
    assert.equal(archived.body.engine_transcript_retained, true)

    const listed = await call('harness_sessions', {})
    assert.equal(listed.body.sessions.length, 0)
    assert.equal(listed.body.archived_hidden, 1)

    const resumed = await call('harness_start', { prompt: 'continue', session_id: 'session-test' })
    assert.equal(resumed.body.error.code, 'CONFLICT')
    assert.match(resumed.body.error.message, /thread_unarchive/)

    assert.equal((await call('thread_archived', {})).body.total, 1)
    assert.equal((await call('thread_unarchive', { session_id: 'session-test' })).body.archived, false)
    assert.equal((await call('harness_sessions', {})).body.sessions.length, 1)
  })
})

test('thread_prune previews before it sweeps', async () => {
  await withConnector(async ({ call }) => {
    // No bounds at all is refused: an unbounded sweep is never what was meant.
    assert.equal((await call('thread_prune', {})).body.error.code, 'INVALID_ARGUMENT')

    const preview = await call('thread_prune', { keep_last: 0 })
    assert.equal(preview.body.dry_run, true, 'the default is a dry run')
    assert.equal(preview.body.count, 1)
    assert.equal((await call('harness_sessions', {})).body.sessions.length, 1, 'a preview changes nothing')

    const swept = await call('thread_prune', { keep_last: 0, dry_run: false, reason: 'cleanup' })
    assert.equal(swept.body.dry_run, false)
    assert.deepEqual(swept.body.archived, ['session-test'])
    assert.equal((await call('harness_sessions', {})).body.sessions.length, 0)
  })
})

test('thread items stream by cursor, and steering needs a live turn', async () => {
  await withConnector(async ({ call }) => {
    const page = await call('thread_events', { session_id: 'session-test', from_seq: 0, limit: 10 })
    assert.equal(page.isError, false, JSON.stringify(page.body))
    assert.equal(page.body.next_seq, 7)
    assert.equal(page.body.cursor_behind_window, false)

    // Steering a thread with no running turn is a CONFLICT, not a new turn.
    const steered = await call('turn_steer', { session_id: 'session-test', message: 'focus on the tests' })
    assert.equal(steered.body.error.code, 'CONFLICT')

    // Fork reports the engine's actual capability rather than assuming it.
    assert.equal((await call('bridge_capabilities')).body.features.thread_fork, false)
    assert.equal((await call('thread_fork', { session_id: 'session-test' })).body.error.code, 'UNSUPPORTED')
  })
})

test('the permission profile gates the whole action surface', async () => {
  await withConnector(async ({ call, root }) => {
    await writeFile(join(root, 'file.txt'), 'contents\n')
    assert.equal((await call('permission_get')).body.profile, 'full')

    // Narrow to workspace-write: writes still work, leaving the machine does not.
    const narrowed = await call('permission_set', { profile: 'workspace-write', reason: 'unfamiliar repo' })
    assert.equal(narrowed.body.profile, 'workspace-write')
    assert.equal((await call('fs_update_file', { path: 'file.txt', content: 'edited\n' })).isError, false)
    const download = await call('download_file', { url: 'https://example.com/x', path: 'x', confirm: true })
    assert.equal(download.body.error.code, 'PERMISSION_REQUIRED')
    assert.match(download.body.error.message, /outside this machine/)

    // Narrow again: now even the write is refused, while reads still answer.
    await call('permission_set', { profile: 'read-only' })
    assert.equal((await call('fs_read', { path: 'file.txt' })).body.content, 'edited\n')
    const write = await call('fs_update_file', { path: 'file.txt', content: 'again\n' })
    assert.equal(write.body.error.code, 'PERMISSION_REQUIRED')
    assert.equal((await call('exec_run', { argv: ['echo', 'hi'] })).body.error.code, 'PERMISSION_REQUIRED')

    // Discovery keeps working, and widening back is refused.
    assert.equal((await call('bridge_capabilities')).body.permission.profile, 'read-only')
    const widened = await call('permission_set', { profile: 'full' })
    assert.equal(widened.body.error.code, 'PERMISSION_REQUIRED')
    assert.match(widened.body.error.message, /operator and a restart/)
  })
})

test('command and network rules apply to the actions that take them', async () => {
  await withConnector(async ({ call }) => {
    assert.deepEqual((await call('permission_get')).body.command_deny, ['rm', 'curl'])

    const denied = await call('exec_run', { argv: ['rm', '-rf', '.'] })
    assert.equal(denied.body.error.code, 'PERMISSION_REQUIRED')
    assert.match(denied.body.error.message, /command rules deny/)
    assert.equal((await call('exec_run', { argv: ['echo', 'allowed'] })).isError, false)

    // The same rules cover background processes, not just foreground commands.
    assert.equal((await call('process_start', { argv: ['curl', 'https://x'] })).body.error.code, 'PERMISSION_REQUIRED')

    const host = await call('download_file', { url: 'https://blocked.test/x', path: 'x', confirm: true })
    assert.equal(host.body.error.code, 'PERMISSION_REQUIRED')
    assert.match(host.body.error.message, /network rules/)
  }, { permissionRules: { commandDeny: ['rm', 'curl'], networkAllow: ['github.com'] } })
})

test('the engine-facing tool entrypoints actually import', async () => {
  // Regression: the profile links @shiro-ai/harness-bridge as a SYMLINK, and
  // Node resolves a symlinked package's own imports from its real path -- so
  // `@deepseek-ai/dsh-tools` inside container-tool.js was looked up under
  // bridge/, where the optional peer had never been installed. Both engine
  // entrypoints failed with ERR_MODULE_NOT_FOUND, silently taking the agent's
  // container and git tools with them: nothing logged, and the bridge's own
  // 128 direct actions were unaffected, so every suite stayed green.
  // Prepare-Shiro-Runtime.mjs now links that peer into bridge/node_modules.
  const container = await import('../src/container-tool.js')
  const git = await import('../src/git-tool.js')
  for (const [label, plugin] of [['container-tool', container], ['git-tool', git]]) {
    assert.equal(typeof plugin.apply, 'function', `${label} must be a mountable cordis plugin`)
    assert.equal(typeof plugin.name, 'string')
    assert.ok(Array.isArray(plugin.inject), `${label} declares what it injects`)
  }
})
