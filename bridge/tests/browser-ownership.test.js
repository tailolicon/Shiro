import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertUnchanged, BUSY_POLICY, ownerOfTab, ownershipMarker, resolveOwnedBrowserTab,
} from '../src/browser-ownership.js'

const OWNED_TAB = 11
const FOREIGN_TAB = 22
const UNKNOWN_TAB = 33

function fleets() {
  return [{
    name: 'writers',
    config: { chatMode: 'normal' },
    workers: [
      { slot: 1, workerId: 'worker-1', browserTabId: OWNED_TAB, state: 'idle' },
      { slot: 2, workerId: 'worker-2', browserTabId: null, state: 'closed' },
    ],
  }]
}

function harness(overrides = {}) {
  const calls = { listClients: 0, inspect: 0 }
  const state = fleets()
  return {
    calls,
    state,
    args: {
      tabId: OWNED_TAB,
      findOwner: tabId => ownerOfTab(state, tabId),
      async listClients() {
        calls.listClients += 1
        return [
          { id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/abc', title: 'Shiro worker', ready: true },
          { id: 'client-foreign', browserTabId: FOREIGN_TAB, url: 'https://chatgpt.com/c/private', title: 'my own chat', ready: true },
        ]
      },
      async inspect() {
        calls.inspect += 1
        return { modeOk: true, busy: false }
      },
      action: 'the test action',
      ...overrides,
    },
  }
}

async function rejects(promise, code) {
  return await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('ownerOfTab reads Shiro state and nothing else', () => {
  const state = fleets()
  assert.equal(ownerOfTab(state, OWNED_TAB).worker.slot, 1)
  assert.equal(ownerOfTab(state, FOREIGN_TAB), undefined)
  assert.equal(ownerOfTab(state, null), undefined)
  assert.equal(ownerOfTab(state, '11'), undefined, 'a string tab id is not an integer tab id')
  assert.equal(ownerOfTab([], OWNED_TAB), undefined)
})

test('an owned tab resolves to a canonical record derived from the registry', async () => {
  const { args, calls } = harness()
  const { record, marker } = await resolveOwnedBrowserTab(args)
  assert.equal(record.browser_tab_id, OWNED_TAB)
  assert.equal(record.browser_client_id, 'client-owned')
  assert.equal(record.fleet, 'writers')
  assert.equal(record.slot, 1)
  assert.equal(record.worker_id, 'worker-1')
  assert.equal(record.chat_mode, 'normal')
  assert.equal(record.busy, false)
  assert.equal(marker, ownershipMarker(record))
  assert.equal(calls.inspect, 1, 'the tab is verified, not assumed')
})

test('a foreign tab and an unknown tab are the same answer', async () => {
  // Distinguishing them would confirm which tab ids exist in the user's browser.
  const foreign = harness({ tabId: FOREIGN_TAB })
  const unknown = harness({ tabId: UNKNOWN_TAB })
  let foreignMessage
  let unknownMessage
  await assert.rejects(resolveOwnedBrowserTab(foreign.args), error => { foreignMessage = error.message; return error.code === 'NOT_FOUND' })
  await assert.rejects(resolveOwnedBrowserTab(unknown.args), error => { unknownMessage = error.message; return error.code === 'NOT_FOUND' })
  assert.equal(foreignMessage.replace(String(FOREIGN_TAB), 'X'), unknownMessage.replace(String(UNKNOWN_TAB), 'X'))
  assert.doesNotMatch(foreignMessage, /foreign|not owned|belongs to/)
  // ...and the relay was never asked about a tab we do not own.
  assert.equal(foreign.calls.listClients, 0)
  assert.equal(unknown.calls.listClients, 0)
})

test('a caller cannot smuggle in its own client identity', async () => {
  const { args } = harness()
  // browser_client_id is an OUTPUT: passing one changes nothing about which
  // relay client is used.
  const { record } = await resolveOwnedBrowserTab({ ...args, browser_client_id: 'client-foreign', browserClientId: 'client-foreign' })
  assert.equal(record.browser_client_id, 'client-owned')
})

test('a tab id must be an integer', async () => {
  const { args } = harness()
  await rejects(resolveOwnedBrowserTab({ ...args, tabId: '11' }), 'INVALID_ARGUMENT')
  await rejects(resolveOwnedBrowserTab({ ...args, tabId: undefined }), 'INVALID_ARGUMENT')
  await rejects(resolveOwnedBrowserTab({ ...args, busyPolicy: 'sometimes' }), 'INVALID_ARGUMENT')
})

test('an owned tab that left the relay is reported as gone, not as foreign', async () => {
  const { args } = harness({ listClients: async () => [] })
  await assert.rejects(resolveOwnedBrowserTab(args), error => {
    assert.equal(error.code, 'NOT_FOUND')
    // Safe to be specific: this is Shiro's own slot, not the user's other tabs.
    assert.match(error.message, /no longer connected/)
    return true
  })
})

test('an unreachable relay is UNSUPPORTED and retryable, not a silent success', async () => {
  const { args } = harness({ listClients: async () => { throw new Error('ECONNREFUSED') } })
  await assert.rejects(resolveOwnedBrowserTab(args), error => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.equal(error.retryable, true)
    assert.match(error.message, /unreachable/)
    return true
  })
})

test('an unverifiable chat mode refuses the action', async () => {
  const { args } = harness({ inspect: async () => ({ modeOk: false, busy: false }) })
  await rejects(resolveOwnedBrowserTab(args), 'CONFLICT')

  const throwing = harness({ inspect: async () => { throw new Error('layout capture failed') } })
  await rejects(resolveOwnedBrowserTab(throwing.args), 'CONFLICT')
})

test('a truthy non-boolean busy signal still counts as busy', async () => {
  // The relay reports evidence strings, not booleans: an === true comparison
  // here would disable the busy policy everywhere at once.
  const { args } = harness({ inspect: async () => ({ modeOk: true, busy: 'active_request' }) })
  await assert.rejects(resolveOwnedBrowserTab(args), error => {
    assert.equal(error.code, 'BUSY')
    assert.match(error.message, /active_request/)
    return true
  })
  const allowed = harness({ inspect: async () => ({ modeOk: true, busy: 'stop_control' }), busyPolicy: BUSY_POLICY.allow })
  const { record } = await resolveOwnedBrowserTab(allowed.args)
  assert.equal(record.busy, true)
  assert.equal(record.busy_evidence, 'stop_control')

  const idle = harness({ inspect: async () => ({ modeOk: true, busy: '' }) })
  assert.equal((await resolveOwnedBrowserTab(idle.args)).record.busy, false)
})

test('busy policy is per action, not global', async () => {
  const busy = { inspect: async () => ({ modeOk: true, busy: true }) }
  const refusing = harness(busy)
  await assert.rejects(resolveOwnedBrowserTab(refusing.args), error => {
    assert.equal(error.code, 'BUSY')
    assert.equal(error.retryable, true)
    return true
  })

  const allowing = harness({ ...busy, busyPolicy: BUSY_POLICY.allow })
  const { record } = await resolveOwnedBrowserTab(allowing.args)
  assert.equal(record.busy, true, 'a read-only action may proceed but must still see the state')
})

test('the marker changes whenever acting would hit something else', () => {
  const base = {
    browser_tab_id: OWNED_TAB, browser_client_id: 'client-owned',
    url: 'https://chatgpt.com/c/abc', worker_id: 'worker-1', fleet: 'writers', slot: 1,
  }
  const marker = ownershipMarker(base)
  assert.notEqual(ownershipMarker({ ...base, url: 'https://chatgpt.com/c/other' }), marker, 'navigation')
  assert.notEqual(ownershipMarker({ ...base, browser_client_id: 'client-new' }), marker, 'tab reopened')
  assert.notEqual(ownershipMarker({ ...base, worker_id: 'worker-9' }), marker, 'slot recycled')
  assert.notEqual(ownershipMarker({ ...base, slot: 2 }), marker, 'moved slot')
  assert.equal(ownershipMarker({ ...base }), marker)
})

test('assertUnchanged stops an action whose subject moved under it', async () => {
  const { args } = harness()
  const first = await resolveOwnedBrowserTab(args)

  // Same world: the re-check passes and returns the fresh resolution.
  const again = await resolveOwnedBrowserTab(args)
  assert.equal(assertUnchanged(first.marker, again), again)

  // The tab navigated between verification and the relay call.
  const navigated = harness({
    listClients: async () => [{ id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/moved', ready: true }],
  })
  const after = await resolveOwnedBrowserTab(navigated.args)
  assert.throws(() => assertUnchanged(first.marker, after, 'the capture'), error => {
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /changed between verification and the capture/)
    return true
  })
})

test('ownership moving to another slot invalidates a resolution', async () => {
  const { args, state } = harness()
  const first = await resolveOwnedBrowserTab(args)
  // The tab is recycled into a different slot while the action is in flight.
  state[0].workers[0].browserTabId = null
  state[0].workers[1].browserTabId = OWNED_TAB
  const after = await resolveOwnedBrowserTab(args)
  assert.equal(after.record.slot, 2)
  assert.throws(() => assertUnchanged(first.marker, after), error => error.code === 'CONFLICT')
})
