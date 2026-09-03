import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeBroker, configureMcp, HARNESS_ACTION_DESCRIPTORS } from '../src/index.js'
import { PermissionPolicy } from '../src/permission-profile.js'

/**
 * Captures every tool the bridge registers, along with the handler that was
 * actually installed -- which is the only way to tell a gated registration from
 * an ungated one.
 */
function spyServer() {
  const tools = new Map()
  return {
    tools,
    registerTool(name, spec, handler) {
      assert.equal(tools.has(name), false, `${name} was registered twice`)
      tools.set(name, { spec, handler })
      return { enable() {}, disable() {} }
    },
    registerResource() { return { enable() {}, disable() {} } },
    registerPrompt() { return { enable() {}, disable() {} } },
  }
}

const controller = {
  broker: new BridgeBroker(),
  async sessions() { return { workspace_id: 'project', sessions: [] } },
  async status() { return { status: 'idle' } },
}

async function surface(profile) {
  const root = await mkdtemp(join(tmpdir(), 'shiro-permission-'))
  const server = spyServer()
  const policy = new PermissionPolicy({ profile })
  configureMcp(server, controller, { workspaceRoot: root, waitMs: 25_000, token: 'x' }, null, { policy })
  return { server, policy, root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** The refusal the policy produces, or null when the action was allowed through. */
async function refusalOf(entry) {
  let result
  try {
    result = await entry.handler({}, {})
  } catch {
    // The handler ran and failed on its own (missing arguments, no repository,
    // …) -- which means the gate let it through.
    return null
  }
  const error = result?.structuredContent?.error
  if (result?.isError !== true || error?.code !== 'PERMISSION_REQUIRED') return null
  return error
}

test('every registered tool carries an action descriptor', async t => {
  const { server, cleanup } = await surface('full')
  t.after(cleanup)

  const catalog = await server.tools.get('bridge_capabilities').handler({}, {})
  const described = new Set([
    ...catalog.structuredContent.actions.map(action => action.name),
    ...HARNESS_ACTION_DESCRIPTORS.map(descriptor => descriptor.name),
  ])
  // A tool with no descriptor is a tool the policy cannot judge.
  const undescribed = [...server.tools.keys()].filter(name => !described.has(name))
  assert.deepEqual(undescribed, [], 'these tools are registered but have no registry row')
  assert.ok(server.tools.size >= 118, `expected the full surface, saw ${server.tools.size}`)
})

test('read-only refuses every write action, including the hand-written ones', async t => {
  const { server, cleanup } = await surface('read-only')
  t.after(cleanup)

  const full = await surface('full')
  const catalog = await full.server.tools.get('bridge_capabilities').handler({}, {})
  await full.cleanup()
  const rows = new Map([
    ...catalog.structuredContent.actions.map(action => [action.name, action]),
    ...HARNESS_ACTION_DESCRIPTORS.map(descriptor => [descriptor.name, descriptor]),
  ])

  // Discovery stays open at every profile by design; everything else that is
  // not read-only must be refused.
  const ALWAYS_OPEN = new Set([
    'bridge_status', 'bridge_capabilities', 'config_get', 'config_validate',
    'metrics_snapshot', 'logs_tail', 'permission_get', 'permission_set',
  ])
  const leaked = []
  for (const [name, entry] of server.tools) {
    const row = rows.get(name)
    if (row === undefined || ALWAYS_OPEN.has(name)) continue
    const outward = row.family === 'network' || row.family === 'browser' || ['git_fetch', 'git_pull', 'git_push'].includes(name)
    if (row.read_only === true && !outward) continue
    if (await refusalOf(entry) === null) leaked.push(name)
  }
  assert.deepEqual(leaked, [], 'these write actions ran under a read-only profile')
})

test('the harness and fleet tools are gated, not just the direct actions', async t => {
  // The specific regression: these twelve are registered by hand in index.js
  // instead of through the direct-action table, and for a while that was enough
  // to skip the policy entirely. `harness_start` starts an agent that can write
  // anything; `fleet_start` drives a live browser.
  const { server, cleanup } = await surface('read-only')
  t.after(cleanup)

  for (const name of ['harness_start', 'harness_continue', 'harness_respond', 'harness_cancel', 'fleet_start', 'fleet_stop']) {
    const refusal = await refusalOf(server.tools.get(name))
    assert.notEqual(refusal, null, `${name} ran under a read-only profile`)
    assert.match(refusal.message, /read-only/)
  }
  // Reading a thread or listing sessions is still allowed, or a locked-down
  // client could not see what it already started.
  for (const name of ['harness_status', 'harness_sessions', 'harness_profiles', 'fleet_status']) {
    assert.equal(await refusalOf(server.tools.get(name)), null, `${name} should stay readable`)
  }
})

test('workspace-write refuses the actions that leave the machine', async t => {
  const { server, cleanup } = await surface('workspace-write')
  t.after(cleanup)

  for (const name of ['fleet_start', 'download_file', 'git_push', 'browser_tab_screenshot']) {
    const refusal = await refusalOf(server.tools.get(name))
    assert.notEqual(refusal, null, `${name} ran under workspace-write`)
    assert.match(refusal.message, /outside this machine/)
  }
  // Writing inside the workspace is exactly what this profile is for.
  assert.equal(await refusalOf(server.tools.get('fs_update_file')), null)
})

test('a tool registered without a descriptor is refused at startup, not at call time', async () => {
  const { createActionGate } = await import('../src/action-gate.js')
  const gate = createActionGate({ policy: new PermissionPolicy({ profile: 'full' }), descriptors: HARNESS_ACTION_DESCRIPTORS })
  assert.throws(() => gate('harness_invented', async () => ({})), /no action descriptor/)
  assert.equal(typeof gate('harness_start', async () => ({})), 'function')
})
