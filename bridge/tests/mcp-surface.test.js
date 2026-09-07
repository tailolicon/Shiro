import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { BridgeBroker, configureMcp } from '../src/index.js'
import { publicSessionStatus } from '../src/session-status.js'

async function withMcp(controller, workspaceRoot, run, fleetManager = null) {
  const server = new McpServer({ name: 'shiro-mcp-test', version: '0.0.0' })
  configureMcp(server, controller, { workspaceRoot, waitMs: 25_000 }, fleetManager)
  const client = new Client({ name: 'shiro-mcp-test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

function fakeController() {
  const broker = new BridgeBroker()
  const calls = []
  return {
    broker,
    calls,
    // The real controller gates this on the request's recorded workspace; the
    // double only needs to hand the row back (harness-workspace.test.js covers
    // the gate itself against the real controller).
    pendingRequest(requestId) {
      calls.push(['pendingRequest', requestId])
      return broker.request(requestId)
    },
    async sessions() {
      return { workspace_id: 'workspace-test', workspace_title: 'Shiro test', sessions: [{ sessionId: 'session-test' }] }
    },
    async sessionLog(sessionId, limit) {
      calls.push(['sessionLog', sessionId, limit])
      return { session_id: sessionId, limit, events: [{ event: { seq: 1, type: 'assistant/message' } }] }
    },
    async status(waitMs, operationId, sessionId, waitOptions) {
      calls.push(['status', waitMs, operationId, sessionId, Boolean(waitOptions?.signal)])
      return {
        status: 'model_input_required',
        state: 'model_input_required',
        pending_action: 'model_response',
        request_id: '11111111-1111-4111-8111-111111111111',
        operation_id: 'operation-test',
        session_id: 'session-test',
        root_session_id: 'session-test',
        model_requests: [],
      }
    },
    async start(prompt, agentPreset, sessionId, speedProfile, reasoningEffort) {
      calls.push(['start', prompt, agentPreset, sessionId, speedProfile, reasoningEffort])
      return { status: 'running', state: 'running', pending_action: 'poll', operation_id: 'operation-test', session_id: 'session-test', root_session_id: 'session-test', model_requests: [] }
    },
    async submit() {
      return { status: 'running', state: 'running', pending_action: 'poll', operation_id: 'operation-test', session_id: 'session-test', root_session_id: 'session-test', model_requests: [] }
    },
    async respond() {
      return { status: 'running', state: 'running', pending_action: 'poll', operation_id: 'operation-test', session_id: 'session-test', root_session_id: 'session-test', model_requests: [] }
    },
    async readAttachment() {
      throw new Error('attachment test not configured')
    },
    async cancel(operationId, sessionId) {
      calls.push(['cancel', operationId, sessionId])
      return { cancelled: false, status: 'idle' }
    },
  }
}

function fakeFleetManager() {
  const calls = []
  const base = {
    name: 'hachimi',
    status: 'running',
    running: true,
    size: 3,
    active_workers: 3,
    chat_mode: 'normal',
    interval_minutes: 27,
    stagger_seconds: 0,
    max_session_runs: 4,
    round: 1,
    prompt_hash: 'prompt-hash',
    config_hash: 'config-hash',
    started_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:01.000Z',
    next_run_at: '2026-09-01T00:27:00.000Z',
    summary: { submitted: 3 },
    workers: [1, 2, 3].map(slot => ({
      worker_id: `hachimi:${slot}`,
      slot,
      state: 'submitted',
      browser_client_id: `client-${slot}`,
      browser_tab_id: 100 + slot,
      run_count: 1,
    })),
  }
  return {
    calls,
    async start(args) {
      calls.push(['fleetStart', args])
      return { ...base }
    },
    async status(name) {
      calls.push(['fleetStatus', name])
      return { ...base }
    },
    async stop(name) {
      calls.push(['fleetStop', name])
      return { ...base, status: 'stopped', running: false, next_run_at: null, summary: { closed: 3 } }
    },
  }
}

function toolByName(catalog, name) {
  const tool = catalog.tools.find(candidate => candidate.name === name)
  assert.ok(tool, `${name} missing from tool catalog`)
  return tool
}

test('configureMcp exposes a mature keyless protocol surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-mcp-'))
  const artifactPath = join(root, 'artifact.txt')
  await writeFile(artifactPath, 'hello from shiro\n')
  const controller = fakeController()
  const fleetManager = fakeFleetManager()

  try {
    await withMcp(controller, root, async client => {
      const catalog = await client.listTools()
      for (const name of [
        'fleet_start', 'fleet_status', 'fleet_stop',
        'harness_profiles', 'harness_start', 'harness_sessions', 'harness_get_request',
        'harness_continue', 'harness_status', 'harness_respond', 'harness_get_artifact', 'harness_cancel',
      ]) {
        const tool = toolByName(catalog, name)
        assert.equal(typeof tool.title, 'string')
        assert.ok(tool.outputSchema, `${name} must advertise outputSchema`)
        assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean')
        assert.equal(typeof tool.annotations?.destructiveHint, 'boolean')
        assert.equal(typeof tool.annotations?.idempotentHint, 'boolean')
        assert.equal(typeof tool.annotations?.openWorldHint, 'boolean')
      }

      const start = toolByName(catalog, 'harness_start')
      assert.deepEqual(start.inputSchema.required, ['prompt'])
      assert.ok(start.inputSchema.properties.speed_profile)
      assert.ok(start.inputSchema.properties.reasoning_effort)
      assert.equal(start.annotations.destructiveHint, false)
      const status = toolByName(catalog, 'harness_status')
      assert.ok(status.inputSchema.properties.operation_id)
      assert.ok(status.inputSchema.properties.session_id)
      const cancel = toolByName(catalog, 'harness_cancel')
      assert.ok(cancel.inputSchema.properties.operation_id)
      assert.ok(cancel.inputSchema.properties.session_id)
      assert.equal(cancel.annotations.destructiveHint, true)
      const fleetStart = toolByName(catalog, 'fleet_start')
      assert.deepEqual(fleetStart.inputSchema.required.sort(), ['name', 'prompt', 'size'])
      assert.equal(fleetStart.annotations.idempotentHint, true)
      assert.equal(toolByName(catalog, 'fleet_status').annotations.readOnlyHint, true)
      assert.equal(toolByName(catalog, 'fleet_stop').annotations.destructiveHint, true)

      const fleetStartResult = await client.callTool({
        name: 'fleet_start',
        arguments: {
          name: 'hachimi',
          size: 3,
          prompt: 'slot {{FLEET_SLOT}}/{{FLEET_SIZE}} {{FLEET_NAME}}',
          interval_minutes: 27,
          chat_mode: 'normal',
          stagger_seconds: 0,
          max_session_runs: 4,
        },
      })
      assert.equal(fleetStartResult.isError, undefined)
      assert.equal(fleetStartResult.structuredContent.active_workers, 3)
      assert.equal(fleetStartResult.structuredContent.workers[1].worker_id, 'hachimi:2')
      assert.deepEqual(fleetManager.calls.find(call => call[0] === 'fleetStart'), [
        'fleetStart',
        {
          name: 'hachimi',
          size: 3,
          prompt: 'slot {{FLEET_SLOT}}/{{FLEET_SIZE}} {{FLEET_NAME}}',
          intervalMinutes: 27,
          chatMode: 'normal',
          staggerSeconds: 0,
          maxSessionRuns: 4,
        },
      ])
      const fleetStatusResult = await client.callTool({ name: 'fleet_status', arguments: { name: 'hachimi' } })
      assert.equal(fleetStatusResult.structuredContent.config_hash, 'config-hash')
      const fleetStopResult = await client.callTool({ name: 'fleet_stop', arguments: { name: 'hachimi' } })
      assert.equal(fleetStopResult.structuredContent.running, false)
      assert.deepEqual(fleetManager.calls.find(call => call[0] === 'fleetStatus'), ['fleetStatus', 'hachimi'])
      assert.deepEqual(fleetManager.calls.find(call => call[0] === 'fleetStop'), ['fleetStop', 'hachimi'])

      const startResult = await client.callTool({ name: 'harness_start', arguments: { prompt: 'cached client compatibility' } })
      assert.equal(startResult.isError, undefined)
      assert.equal(startResult.structuredContent.state, 'running')
      assert.deepEqual(controller.calls.find(call => call[0] === 'start'), ['start', 'cached client compatibility', undefined, undefined, undefined, undefined])

      const statusResult = await client.callTool({
        name: 'harness_status',
        arguments: { operation_id: '22222222-2222-4222-8222-222222222222', session_id: 'session-test', wait_ms: 0 },
      })
      assert.equal(statusResult.isError, undefined)
      assert.deepEqual(
        {
          state: statusResult.structuredContent.state,
          pending_action: statusResult.structuredContent.pending_action,
          request_id: statusResult.structuredContent.request_id,
          operation_id: statusResult.structuredContent.operation_id,
          session_id: statusResult.structuredContent.session_id,
        },
        {
          state: 'model_input_required',
          pending_action: 'model_response',
          request_id: '11111111-1111-4111-8111-111111111111',
          operation_id: 'operation-test',
          session_id: 'session-test',
        },
      )
      assert.deepEqual(controller.calls.find(call => call[0] === 'status'), [
        'status', 0, '22222222-2222-4222-8222-222222222222', 'session-test', true,
      ])

      const cancelResult = await client.callTool({
        name: 'harness_cancel',
        arguments: { operation_id: '22222222-2222-4222-8222-222222222222' },
      })
      assert.equal(cancelResult.isError, undefined)
      assert.deepEqual(controller.calls.find(call => call[0] === 'cancel'), [
        'cancel', '22222222-2222-4222-8222-222222222222', undefined,
      ])

      const resources = await client.listResources()
      assert.deepEqual(resources.resources.map(resource => resource.uri).sort(), ['shiro://sessions', 'shiro://status'])
      const templates = await client.listResourceTemplates()
      const templateUris = templates.resourceTemplates.map(template => template.uriTemplate)
      assert.ok(templateUris.includes('shiro://artifact{?path}'), 'the original artifact template must keep resolving')
    assert.ok(templateUris.includes('shiro://artifact{?path,workspace}'), 'a second template addresses files in an opened workspace')
      assert.ok(templateUris.includes('shiro://session-log{?session_id,limit}'))

      const sessionsResource = await client.readResource({ uri: 'shiro://sessions' })
      assert.equal(JSON.parse(sessionsResource.contents[0].text).workspace_id, 'workspace-test')
      const logResource = await client.readResource({ uri: 'shiro://session-log?session_id=session-test&limit=7' })
      assert.equal(JSON.parse(logResource.contents[0].text).limit, 7)
      assert.deepEqual(controller.calls.find(call => call[0] === 'sessionLog'), ['sessionLog', 'session-test', 7])

      const prompts = await client.listPrompts()
      assert.deepEqual(prompts.prompts.map(prompt => prompt.name).sort(), ['fix-tests', 'resume-session', 'review-code'])
      const resumePrompt = await client.getPrompt({ name: 'resume-session', arguments: { session_id: 'session-test' } })
      assert.match(resumePrompt.messages[0].content.text, /session-test/)

      const artifact = await client.callTool({ name: 'harness_get_artifact', arguments: { path: 'artifact.txt' } })
      assert.equal(artifact.isError, undefined)
      assert.equal(artifact.structuredContent.path, 'artifact.txt')
      assert.match(artifact.structuredContent.resource_uri, /^shiro:\/\/artifact/)
      assert.equal(artifact.content[0].type, 'resource_link')
      const artifactResource = await client.readResource({ uri: artifact.structuredContent.resource_uri })
      assert.equal(artifactResource.contents[0].text, 'hello from shiro\n')

      const pending = controller.broker.enqueue({
        sessionId: 'session-test',
        provider: 'shiro-sol',
        model: 'gpt-5.6-sol',
        purpose: 'conversation',
        system: 'system',
        tools: [{ name: 'sandbox_exec', description: 'run tests', parameters: { type: 'object' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a'.repeat(6000) }] },
          { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(6000) }] },
        ],
      })
      const firstPage = await client.callTool({
        name: 'harness_get_request',
        arguments: { request_id: pending.id, max_bytes: 10_000 },
      })
      assert.equal(firstPage.isError, undefined)
      assert.equal(firstPage.structuredContent.tools[0].name, 'sandbox_exec')
      assert.equal(firstPage.structuredContent.messages_from, 0)
      assert.equal(firstPage.structuredContent.truncated, true)
      assert.equal(firstPage.structuredContent.next_messages_from, 1)
      const secondPage = await client.callTool({
        name: 'harness_get_request',
        arguments: { request_id: pending.id, messages_from: 1, max_bytes: 10_000 },
      })
      assert.equal(secondPage.structuredContent.system, undefined)
      assert.equal(secondPage.structuredContent.tools, undefined)
      assert.equal(secondPage.structuredContent.messages_from, 1)
      assert.equal(secondPage.structuredContent.truncated, false)
      controller.broker.cancel(pending.id)

      const missingArtifact = await client.callTool({ name: 'harness_get_artifact', arguments: { path: 'missing.txt' } })
      assert.equal(missingArtifact.isError, true)
      assert.equal(missingArtifact.structuredContent.error.code, 'harness_error')
      assert.match(missingArtifact.structuredContent.error.message, /artifact not found/)
    }, fleetManager)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('session runtime status is read-only and preserves its structured response through MCP validation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-runtime-mcp-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const controller = fakeController()
  controller.runtimeStatus = async (id, workspace) => {
    assert.equal(id, 'session-test')
    assert.equal(workspace.id, 'project')
    return { session_id: id, runtime_mode: 'web-harness', loop_owner: 'harness', requested_model: 'Astra', verified_model: null, recovery_state: 'interrupted-unverified', effects: [] }
  }
  await withMcp(controller, root, async client => {
    const tool = toolByName(await client.listTools(), 'session_runtime_status')
    assert.equal(tool.annotations.readOnlyHint, true)
    const result = await client.callTool({ name: 'session_runtime_status', arguments: { session_id: 'session-test' } })
    assert.notEqual(result.isError, true)
    assert.equal(result.structuredContent.runtime.requested_model, 'Astra')
    assert.equal(result.structuredContent.runtime.verified_model, null)
    assert.equal(result.structuredContent.runtime.recovery_state, 'interrupted-unverified')
  })
})


test('session runtime status exposes only an allowlisted redacted public projection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-runtime-secrets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const controller = fakeController()
  const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz123456'
  const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz123456'
  const privateKey = '-----BEGIN PRIVATE KEY-----\nVERYSECRETKEYMATERIAL\n-----END PRIVATE KEY-----'
  const credentialUrl = 'https://alice:supersecret@example.com/c/thread?access_token=token-secret#frag'
  controller.runtimeStatus = async () => publicSessionStatus({
    session_id: 'session-test', runtime_mode: 'web-harness', loop_owner: 'harness',
    workspace_id: 'root:stable', workspace_root: root,
    requested_model: `model ${bearer}`, verified_model: apiKey,
    requested_effort: 'high', verified_effort: privateKey,
    codex_thread_id: `thread api_key=${apiKey}`, recovery_state: 'interrupted-unverified',
    last_event_seq: 9, created_at: 1, updated_at: 2,
    executor_id: 'must-not-leak-executor-id', lease_until: 99, fence: 4,
    checkpoint: { operation_id: 'operation-test', after_seq: 3 },
    browser_binding: { client_id: 'client-test', tab_id: 7, conversation_id: 'conversation-test', url: credentialUrl, observed_at: 3,
      verification_evidence: `secret=${apiKey}` },
    operations: [{ operation_id: 'operation-test', state: 'interrupted', after_seq: 3, created_at: 1, updated_at: 2,
      data: { completion: { assistant_text: `${bearer} ${privateKey}` }, raw_secret: apiKey } }],
    effects: [{ effect_id: 'effect-test', operation_id: 'operation-test', name: 'harness.prompt', state: 'uncertain', created_at: 1, updated_at: 2,
      arguments: { token: apiKey }, receipt: { error: bearer, url: credentialUrl } }],
  }, { durable: true, workspace: 'project', now: 10 })

  await withMcp(controller, root, async client => {
    const result = await client.callTool({ name: 'session_runtime_status', arguments: { session_id: 'session-test' } })
    assert.notEqual(result.isError, true)
    const runtime = result.structuredContent.runtime
    const wire = JSON.stringify({ structured: result.structuredContent, content: result.content })
    for (const secret of ['abcdefghijklmnopqrstuvwxyz123456', 'supersecret', 'VERYSECRETKEYMATERIAL', 'token-secret', 'alice:supersecret']) {
      assert.equal(wire.includes(secret), false, `secret survived runtime projection: ${secret}`)
    }
    assert.equal(wire.includes('must-not-leak-executor-id'), false)
    assert.equal(runtime.operations[0].data, undefined)
    assert.equal(runtime.operations[0].completion, undefined)
    assert.equal(runtime.effects[0].arguments, undefined)
    assert.equal(runtime.effects[0].receipt, undefined)
    assert.equal(runtime.browser_binding.verification_evidence, undefined)
    assert.equal(runtime.browser_binding.url.includes('alice'), false)
    assert.equal(runtime.browser_binding.url.includes('access_token'), false)
    assert.equal(runtime.executor.fence, 4)
    assert.equal(runtime.operations[0].state, 'interrupted')
  })
})
