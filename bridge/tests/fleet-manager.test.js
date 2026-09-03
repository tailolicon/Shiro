import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptBrowserRelay } from '../src/chatgpt-relay.js'
import { FleetManager, renderFleetPrompt } from '../src/fleet-manager.js'

const TEMP_ACTIVE = '<button aria-label="Tắt trò chuyện tạm thời"><span><svg class="icon opacity-0"></svg><svg class="icon"></svg></span></button>'

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class FakeTransport {
  constructor({ openDelayMs = 0 } = {}) {
    this.openDelayMs = openDelayMs
    this.nextTab = 100
    this.openActive = 0
    this.maxOpenActive = 0
    this.openCalls = []
    this.submitCalls = []
    this.deleteCalls = []
    this.closeCalls = []
    this.busyTabs = new Set()
    this.clientsList = [{
      id: 'control',
      browserTabId: 1,
      ready: true,
      quarantined: false,
      url: 'https://chatgpt.com/c/control',
      tabObservation: { generation: { state: 'stopped', activeTool: false } },
    }]
  }

  async clients() {
    return this.clientsList.map(client => ({
      ...client,
      activeRequest: this.busyTabs.has(client.browserTabId) ? { requestId: `busy-${client.browserTabId}` } : null,
      tabObservation: {
        generation: {
          state: this.busyTabs.has(client.browserTabId) ? 'active' : 'stopped',
          activeTool: false,
        },
      },
    }))
  }

  async captureLayout(clientId) {
    const client = this.clientsList.find(candidate => candidate.id === clientId)
    if (!client) throw new Error(`unknown client ${clientId}`)
    const temporary = new URL(client.url).searchParams.get('temporary-chat') === 'true'
    return {
      html: `${temporary ? TEMP_ACTIVE : ''}${this.busyTabs.has(client.browserTabId) ? '<button data-testid="stop-button" aria-label="Stop generating"></button>' : ''}`,
    }
  }

  async open(sourceClientId, chatMode) {
    this.openActive += 1
    this.maxOpenActive = Math.max(this.maxOpenActive, this.openActive)
    this.openCalls.push({ sourceClientId, chatMode })
    if (this.openDelayMs > 0) await delay(this.openDelayMs)
    const tabId = this.nextTab++
    const client = {
      id: `worker-client-${tabId}`,
      browserTabId: tabId,
      ready: true,
      quarantined: false,
      url: chatMode === 'temporary' ? 'https://chatgpt.com/?temporary-chat=true' : `https://chatgpt.com/c/worker-${tabId}`,
      tabObservation: { generation: { state: 'stopped', activeTool: false } },
    }
    this.clientsList.push(client)
    this.openActive -= 1
    return client
  }

  async submit(sourceClientId, prompt) {
    this.submitCalls.push({ sourceClientId, prompt })
    return { result: { submittedUserTurnKey: `turn-${this.submitCalls.length}` } }
  }

  async deleteSession(sourceClientId, sessionId, expectedUrl) {
    const client = this.clientsList.find(candidate => candidate.id === sourceClientId)
    if (!client) throw new Error(`unknown client ${sourceClientId}`)
    assert.equal(client.url, expectedUrl)
    const expectedSessionId = new URL(expectedUrl).pathname.match(/^\/c\/([^/?#]+)/)?.[1] || ''
    assert.equal(sessionId, expectedSessionId)
    this.deleteCalls.push({ sourceClientId, sessionId, expectedUrl, browserTabId: client.browserTabId })
    client.url = 'https://chatgpt.com/'
    return { deleted: true, deletedSessionId: sessionId, beforeUrl: expectedUrl, afterUrl: client.url }
  }

  async close(sourceClientId) {
    const client = this.clientsList.find(candidate => candidate.id === sourceClientId)
    if (client) {
      this.closeCalls.push({ sourceClientId, browserTabId: client.browserTabId })
      this.clientsList = this.clientsList.filter(candidate => candidate.id !== sourceClientId)
    }
    return { closed: true }
  }
}

function fakeTimers() {
  const scheduled = []
  return {
    scheduled,
    setTimer(callback, ms) {
      const timer = { callback, ms, unref() {} }
      scheduled.push(timer)
      return timer
    },
    clearTimer(timer) {
      const index = scheduled.indexOf(timer)
      if (index >= 0) scheduled.splice(index, 1)
    },
  }
}

function managerOptions(transport, stateDir, extras = {}) {
  const timers = extras.timers || fakeTimers()
  return {
    manager: new FleetManager({
      transport,
      stateDir,
      autoRestore: extras.autoRestore ?? false,
      now: extras.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      sleep: extras.sleep || (async () => {}),
      launchConcurrency: extras.launchConcurrency ?? 3,
      verifyAttempts: 1,
      verifyDelayMs: 0,
    }),
    timers,
  }
}

test('renderFleetPrompt expands stable slot, size and fleet name placeholders', () => {
  assert.equal(
    renderFleetPrompt('fleet={{FLEET_NAME}} slot={{FLEET_SLOT}}/{{FLEET_SIZE}}', 2, 3, 'hachimi'),
    'fleet=hachimi slot=2/3',
  )
})

test('cold fleet startup opens workers concurrently and preserves slots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-parallel-'))
  const transport = new FakeTransport({ openDelayMs: 35 })
  const { manager } = managerOptions(transport, root)
  try {
    const snapshot = await manager.start({
      name: 'hachimi',
      size: 3,
      prompt: 'Run slot {{FLEET_SLOT}}/{{FLEET_SIZE}} in {{FLEET_NAME}}',
      intervalMinutes: 27,
      chatMode: 'normal',
    })
    assert.equal(transport.openCalls.length, 3)
    assert.ok(transport.maxOpenActive >= 2, `expected parallel opens, max concurrency was ${transport.maxOpenActive}`)
    assert.equal(transport.submitCalls.length, 3)
    assert.deepEqual(snapshot.workers.map(worker => worker.slot), [1, 2, 3])
    assert.deepEqual(snapshot.workers.map(worker => worker.worker_id), ['hachimi:1', 'hachimi:2', 'hachimi:3'])
    assert.ok(transport.submitCalls.some(call => call.prompt.includes('slot 2/3 in hachimi')))
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('identical fleet_start is idempotent while conflicting config fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-idempotent-'))
  const transport = new FakeTransport()
  const { manager } = managerOptions(transport, root)
  const config = { name: 'same', size: 2, prompt: 'hello {{FLEET_SLOT}}', intervalMinutes: 27, chatMode: 'normal' }
  try {
    const first = await manager.start(config)
    const opens = transport.openCalls.length
    const submits = transport.submitCalls.length
    const second = await manager.start(config)
    assert.equal(second.config_hash, first.config_hash)
    assert.equal(transport.openCalls.length, opens)
    assert.equal(transport.submitCalls.length, submits)
    await assert.rejects(
      manager.start({ ...config, prompt: 'different prompt' }),
      /different configuration/,
    )
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('busy workers are skipped and never double-submitted on a tick', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-busy-'))
  const transport = new FakeTransport()
  const { manager } = managerOptions(transport, root)
  try {
    const first = await manager.start({ name: 'busy', size: 2, prompt: 'go', intervalMinutes: 27, chatMode: 'normal' })
    const busyWorker = first.workers[0]
    transport.busyTabs.add(busyWorker.browser_tab_id)
    const before = transport.submitCalls.filter(call => call.sourceClientId === busyWorker.browser_client_id).length
    const second = await manager.runNow('busy')
    const after = transport.submitCalls.filter(call => call.sourceClientId === busyWorker.browser_client_id).length
    assert.equal(after, before)
    assert.equal(second.summary.busy, 1)
    assert.equal(second.workers[0].worker_id, busyWorker.worker_id)
    assert.equal(second.workers[0].slot, 1)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('rotation replaces only the expired worker and keeps worker identity and slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-rotate-'))
  const transport = new FakeTransport()
  const { manager } = managerOptions(transport, root)
  try {
    const first = await manager.start({ name: 'rotate', size: 1, prompt: 'go', intervalMinutes: 27, chatMode: 'normal', maxSessionRuns: 1 })
    const oldTab = first.workers[0].browser_tab_id
    const second = await manager.runNow('rotate')
    assert.equal(second.workers[0].worker_id, 'rotate:1')
    assert.equal(second.workers[0].slot, 1)
    assert.notEqual(second.workers[0].browser_tab_id, oldTab)
    assert.deepEqual(transport.deleteCalls.map(call => ({ browserTabId: call.browserTabId, sessionId: call.sessionId })), [
      { browserTabId: oldTab, sessionId: `worker-${oldTab}` },
    ])
    assert.ok(transport.closeCalls.some(call => call.browserTabId === oldTab))
    assert.equal(second.workers[0].run_count, 1)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('normal rotation refuses deletion when the owned conversation identity cannot be proven', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-safe-delete-'))
  const transport = new FakeTransport()
  const { manager } = managerOptions(transport, root)
  try {
    const first = await manager.start({ name: 'safe-delete', size: 1, prompt: 'go', intervalMinutes: 27, chatMode: 'normal', maxSessionRuns: 1 })
    const oldWorker = first.workers[0]
    const client = transport.clientsList.find(candidate => candidate.browserTabId === oldWorker.browser_tab_id)
    client.url = 'https://chatgpt.com/'
    const submitCount = transport.submitCalls.length
    const closeCount = transport.closeCalls.length
    const second = await manager.runNow('safe-delete')
    assert.equal(second.summary.failed, 1)
    assert.equal(second.workers[0].browser_tab_id, oldWorker.browser_tab_id)
    assert.equal(second.workers[0].run_count, 1)
    assert.equal(transport.deleteCalls.length, 0)
    assert.equal(transport.closeCalls.length, closeCount)
    assert.equal(transport.submitCalls.length, submitCount)
    assert.match(second.workers[0].last_error, /refusing fleet rotation cleanup/)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('temporary chat rotation closes without attempting history deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-temp-rotate-'))
  const transport = new FakeTransport()
  const { manager } = managerOptions(transport, root)
  try {
    const first = await manager.start({ name: 'temp-rotate', size: 1, prompt: 'go', intervalMinutes: 27, chatMode: 'temporary', maxSessionRuns: 1 })
    const oldTab = first.workers[0].browser_tab_id
    const second = await manager.runNow('temp-rotate')
    assert.equal(transport.deleteCalls.length, 0)
    assert.ok(transport.closeCalls.some(call => call.browserTabId === oldTab))
    assert.notEqual(second.workers[0].browser_tab_id, oldTab)
    assert.equal(second.workers[0].run_count, 1)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('fleet_stop disables scheduling, closes idle workers, and leaves busy worker reserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-stop-'))
  const transport = new FakeTransport()
  const timers = fakeTimers()
  const { manager } = managerOptions(transport, root, { timers })
  try {
    const running = await manager.start({ name: 'stopme', size: 2, prompt: 'go', intervalMinutes: 27, chatMode: 'normal' })
    transport.busyTabs.add(running.workers[0].browser_tab_id)
    assert.equal(timers.scheduled.length, 1)
    const stopped = await manager.stop('stopme')
    assert.equal(stopped.running, false)
    assert.equal(timers.scheduled.length, 0)
    assert.equal(stopped.workers[0].state, 'busy_stopped')
    assert.ok(stopped.workers[0].browser_tab_id)
    assert.equal(stopped.workers[1].state, 'closed')
    assert.equal(stopped.workers[1].browser_tab_id, undefined)
    assert.equal(manager.isReservedClient({
      id: stopped.workers[0].browser_client_id,
      browserTabId: stopped.workers[0].browser_tab_id,
    }), true)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('running fleet state restores with stable identity and a re-armed future schedule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-restore-'))
  const transport = new FakeTransport()
  const clock = { now: 1_700_000_000_000 }
  const timers1 = fakeTimers()
  const firstManager = managerOptions(transport, root, { timers: timers1, now: () => clock.now }).manager
  try {
    const first = await firstManager.start({ name: 'restore', size: 1, prompt: 'go', intervalMinutes: 60, chatMode: 'normal' })
    await firstManager.dispose()
    const timers2 = fakeTimers()
    const secondManager = new FleetManager({
      transport,
      stateDir: root,
      now: () => clock.now,
      setTimer: timers2.setTimer,
      clearTimer: timers2.clearTimer,
      sleep: async () => {},
      verifyAttempts: 1,
      verifyDelayMs: 0,
      autoRestore: true,
    })
    try {
      await secondManager.ready
      const restored = await secondManager.status('restore')
      assert.equal(restored.running, true)
      assert.equal(restored.workers[0].worker_id, first.workers[0].worker_id)
      assert.equal(restored.workers[0].slot, first.workers[0].slot)
      assert.equal(timers2.scheduled.length, 1)
      assert.ok(timers2.scheduled[0].ms > 0)
      assert.equal(secondManager.isReservedClient({
        id: restored.workers[0].browser_client_id,
        browserTabId: restored.workers[0].browser_tab_id,
      }), true)
    } finally {
      await secondManager.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ChatGptBrowserRelay auto-selection excludes reserved fleet blank tabs', async () => {
  let healthCalls = 0
  let selectedClientId = ''
  const clients = [
    { id: 'fleet-1', browserTabId: 101, ready: true, quarantined: false, url: 'https://chatgpt.com/?temporary-chat=true' },
    { id: 'fleet-2', browserTabId: 102, ready: true, quarantined: false, url: 'https://chatgpt.com/?temporary-chat=true' },
    { id: 'control', browserTabId: 10, ready: true, quarantined: false, url: 'https://chatgpt.com/' },
  ]
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname
    if (path === '/health') {
      healthCalls += 1
      return json(healthCalls === 1
        ? { ok: false, clients: 3, needsSelection: true, selectedClientId: '' }
        : { ok: true, clients: 3, needsSelection: false, selectedClientId })
    }
    if (path === '/browser/clients') return json({ clients })
    if (path === '/browser/select') {
      selectedClientId = JSON.parse(options.body).clientId
      return json({ ok: true })
    }
    throw new Error(`unexpected path ${path}`)
  }
  const relay = new ChatGptBrowserRelay({
    url: 'http://127.0.0.1:23158',
    token: 'test-token',
    fetchImpl,
    isReservedClient: client => client.id.startsWith('fleet-'),
  })
  const result = await relay.health()
  assert.equal(result.ready, true)
  assert.equal(selectedClientId, 'control')
})

test('fleet lifecycle: list, update, run history, worker status, recycle and delete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-lifecycle-'))
  const transport = new FakeTransport()
  const { manager, timers } = managerOptions(transport, root)
  try {
    await manager.start({ name: 'alpha', size: 2, prompt: 'p {{FLEET_SLOT}}', intervalMinutes: 27, chatMode: 'normal', maxSessionRuns: 4 })
    await manager.start({ name: 'beta', size: 1, prompt: 'q', intervalMinutes: 5, chatMode: 'temporary' })

    const listed = await manager.list()
    assert.equal(listed.total, 2)
    assert.equal(listed.running, 2)
    assert.deepEqual(listed.fleets.map(fleet => fleet.name).sort(), ['alpha', 'beta'])

    // fleet_update changes policy in place and reports exactly what it applied.
    const updated = await manager.update('alpha', { intervalMinutes: 60, maxSessionRuns: 2, prompt: 'p2 {{FLEET_SLOT}}' })
    assert.deepEqual(Object.keys(updated.applied).sort(), ['interval_minutes', 'max_session_runs', 'prompt'])
    assert.equal(updated.interval_minutes, 60)
    assert.equal(updated.max_session_runs, 2)
    assert.notEqual(updated.prompt_hash, listed.fleets.find(fleet => fleet.name === 'alpha').prompt_hash)
    assert.equal(updated.size, 2, 'fleet size stays immutable')
    await assert.rejects(manager.update('alpha', {}), /at least one of/)
    await assert.rejects(manager.update('ghost', { intervalMinutes: 5 }), /unknown fleet/)

    // The updated prompt is what the next round actually submits.
    transport.submitCalls.length = 0
    await manager.runNow('alpha')
    assert.ok(transport.submitCalls.every(call => call.prompt.startsWith('p2 ')))

    const runs = await manager.runs('alpha', { limit: 1 })
    assert.equal(runs.total, 2, 'the initial round and the manual round are both recorded')
    assert.equal(runs.runs[0].source, 'manual')
    assert.equal(runs.truncated, true)
    assert.equal(runs.next_cursor, '1')
    const older = await manager.runs('alpha', { limit: 5, cursor: 1 })
    assert.equal(older.runs[0].source, 'initial')
    assert.equal(older.truncated, false)

    const worker = await manager.workerStatus('alpha', 2)
    assert.equal(worker.worker.slot, 2)
    assert.equal(worker.worker.state, 'submitted')
    assert.equal(worker.recent_runs.length, 2)
    await assert.rejects(manager.workerStatus('alpha', 9), /no slot 9/)

    // Recycling deletes the owned conversation, closes that one tab, resets the
    // run budget, and leaves the other slot untouched.
    const before = await manager.status('alpha')
    const recycledTab = before.workers.find(entry => entry.slot === 1).browser_tab_id
    const keptTab = before.workers.find(entry => entry.slot === 2).browser_tab_id
    const recycled = await manager.recycleWorker('alpha', 1)
    assert.equal(recycled.outcome, 'closed')
    assert.equal(recycled.conversation_deleted, true)
    assert.equal(recycled.worker.run_count, 0)
    assert.equal(recycled.worker.browser_tab_id, undefined)
    assert.ok(transport.deleteCalls.some(call => call.browserTabId === recycledTab))
    assert.ok(transport.closeCalls.some(call => call.browserTabId === recycledTab))
    assert.ok(!transport.closeCalls.some(call => call.browserTabId === keptTab))
    assert.equal((await manager.status('alpha')).workers.find(entry => entry.slot === 2).browser_tab_id, keptTab)

    // A busy tab is never recycled from under a running generation.
    transport.busyTabs.add(keptTab)
    await assert.rejects(manager.recycleWorker('alpha', 2), /generating a response/)
    transport.busyTabs.delete(keptTab)

    // Deleting is not stopping: a running fleet is refused.
    await assert.rejects(manager.remove('alpha'), /still running/)
    await manager.stop('alpha')
    const removed = await manager.remove('alpha')
    assert.equal(removed.deleted, true)
    assert.equal((await manager.list()).total, 1)
    assert.deepEqual(await manager.remove('alpha'), { name: 'alpha', deleted: false, not_found: true })
    assert.equal(timers.scheduled.some(timer => timer.name === 'alpha'), false)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('owned-tab actions operate only on verified Shiro-owned tabs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-fleet-tabs-'))
  const transport = new FakeTransport()
  const { manager } = managerOptions(transport, root)
  try {
    await manager.start({ name: 'gamma', size: 2, prompt: 'hello {{FLEET_SLOT}}', intervalMinutes: 27, chatMode: 'normal' })
    const snapshot = await manager.status('gamma')
    const ownedTab = snapshot.workers[0].browser_tab_id

    const owned = await manager.ownedTabs()
    assert.equal(owned.total, 2)
    assert.equal(owned.owned, 2)
    assert.ok(owned.tabs.every(tab => tab.owned && tab.fleet === 'gamma'))
    assert.ok(!owned.tabs.some(tab => tab.browser_tab_id === 1), 'the user control tab is not fleet-owned')

    const everything = await manager.ownedTabs({ includeForeign: true })
    assert.equal(everything.total, 3)
    assert.equal(everything.owned, 2)
    assert.equal(everything.tabs.find(tab => tab.browser_tab_id === 1).owned, false)

    // The foreign control tab is refused by every write action -- and refused
    // with the SAME answer as a tab id that does not exist at all, so the
    // connector cannot be used to probe which tabs the user has open.
    const messages = []
    for (const call of [
      () => manager.closeOwnedTab(1),
      () => manager.sendPromptToOwnedTab(1, 'hi'),
      () => manager.closeOwnedTab(9999),
      () => manager.sendPromptToOwnedTab(9999, 'hi'),
    ]) {
      await assert.rejects(call(), error => {
        assert.equal(error.code, 'NOT_FOUND')
        messages.push(error.message.replace(/\b(1|9999)\b/, 'X'))
        return true
      })
    }
    assert.equal(new Set(messages).size, 1, `foreign and unknown tabs must be indistinguishable: ${JSON.stringify(messages)}`)
    assert.doesNotMatch(messages[0], /foreign|not owned|exists/)
    // Listing foreign tabs is observation only: it granted no authority above.
    assert.equal(everything.tabs.find(tab => tab.browser_tab_id === 1).owned, false)

    // A prompt into an owned tab counts against that slot's rotation budget.
    const submitted = await manager.sendPromptToOwnedTab(ownedTab, 'manual prompt')
    assert.equal(submitted.submitted, true)
    assert.equal(submitted.run_count, 2)
    assert.equal(transport.submitCalls.at(-1).prompt, 'manual prompt')
    await assert.rejects(manager.sendPromptToOwnedTab(ownedTab, '   '), /prompt is required/)

    transport.busyTabs.add(ownedTab)
    await assert.rejects(manager.sendPromptToOwnedTab(ownedTab, 'x'), /generating a response/)
    await assert.rejects(manager.closeOwnedTab(ownedTab), /generating a response/)
    transport.busyTabs.delete(ownedTab)

    const closed = await manager.closeOwnedTab(ownedTab)
    assert.equal(closed.closed, true)
    assert.equal(closed.fleet, 'gamma')
    assert.equal((await manager.ownedTabs()).owned, 1)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
