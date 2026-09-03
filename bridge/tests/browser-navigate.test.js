import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertUnchanged, BUSY_POLICY, ownerOfTab, recheckOwnedBrowserTab, resolveOwnedBrowserTab,
} from '../src/browser-ownership.js'
import { isChatGptUrl, navigateOwnedTab, parseTargetUrl } from '../src/browser-navigate.js'
import { setConfirmationPolicy } from '../src/action-errors.js'

// This file exercises the confirmation brake, which ships OFF: a destructive
// action no longer costs a refusal-then-repeat round trip on an operator's own
// machine. The tests below are what an operator gets back with
// SHIRO_REQUIRE_CONFIRMATIONS=1, so they turn it on for this file.
setConfirmationPolicy({ required: true })

const OWNED_TAB = 7
const FOREIGN_TAB = 8

function harness(overrides = {}) {
  const state = {
    clients: [
      { id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/abc', ready: true },
      { id: 'client-foreign', browserTabId: FOREIGN_TAB, url: 'https://chatgpt.com/c/private', ready: true },
    ],
    busy: '',
    modeOk: true,
    running: false,
    capabilities: { navigate: true, screenshot: true },
    reply: options => ({ ok: true, url: options.url, loaded: true, frameId: 'frame-1' }),
    listCalls: 0,
    navigateCalls: [],
    ...overrides,
  }
  const fleets = [{
    name: 'writers',
    config: { chatMode: 'normal' },
    workers: [{ slot: 1, workerId: 'worker-1', browserTabId: OWNED_TAB, state: 'idle' }],
  }]
  const listClients = async () => {
    state.listCalls += 1
    if (state.listThrows) throw new Error('ECONNREFUSED')
    return typeof state.clients === 'function' ? state.clients(state.listCalls) : state.clients
  }
  const shared = { findOwner: tabId => ownerOfTab(fleets, tabId), listClients }
  const fleet = {
    async resolveOwnedTab(tabId, options) {
      return await resolveOwnedBrowserTab({ ...shared, tabId, inspect: async () => ({ modeOk: state.modeOk, busy: state.busy }), ...options })
    },
    async recheckOwnedTab(tabId, marker, action) {
      return assertUnchanged(marker, await recheckOwnedBrowserTab({ ...shared, tabId, action }), action)
    },
    async status(name) {
      return { name, running: state.running }
    },
  }
  const transport = {
    async capabilities() {
      if (state.capabilitiesThrows) throw new Error('relay down')
      return state.capabilities
    },
    async navigate(clientId, options) {
      state.navigateCalls.push({ clientId, options })
      return state.reply(options)
    },
  }
  return { state, fleet, transport, fleets }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('http and https are accepted, including localhost and private addresses', () => {
  assert.equal(parseTargetUrl('https://example.com/a').protocol, 'https:')
  // Explicitly allowed: this machine's own services are legitimate targets.
  assert.equal(parseTargetUrl('http://localhost:3000/app').hostname, 'localhost')
  assert.equal(parseTargetUrl('http://127.0.0.1:8080/').hostname, '127.0.0.1')
  assert.equal(parseTargetUrl('http://192.168.1.10:9000/dash').hostname, '192.168.1.10')
  assert.equal(parseTargetUrl('http://10.0.0.5/').hostname, '10.0.0.5')
  assert.equal(parseTargetUrl('http://[::1]:5173/').hostname, '[::1]')
})

test('schemes that are escape hatches rather than pages are refused', () => {
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'blob:https://example.com/uuid',
    'file:///etc/passwd',
    'chrome://settings',
    'chrome-extension://abcdef/page.html',
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
    'ftp://example.com/f',
    'ws://example.com/socket',
  ]) {
    assert.throws(() => parseTargetUrl(bad), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT', bad)
      return true
    }, bad)
  }
  assert.throws(() => parseTargetUrl('https://user:pw@example.com/'), error => /credentials/.test(error.message))
  assert.throws(() => parseTargetUrl('/relative/path'), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => parseTargetUrl(''), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => parseTargetUrl(`https://example.com/${'a'.repeat(9000)}`), error => error.code === 'INVALID_ARGUMENT')
})

test('isChatGptUrl recognizes exactly the worker origins', () => {
  assert.equal(isChatGptUrl('https://chatgpt.com/c/abc'), true)
  assert.equal(isChatGptUrl('https://chat.openai.com/'), true)
  assert.equal(isChatGptUrl('https://chatgpt.com.evil.test/'), false)
  assert.equal(isChatGptUrl('http://chatgpt.com/'), false, 'http is a different origin')
  assert.equal(isChatGptUrl('not a url'), false)
})

test('navigating an owned tab within ChatGPT needs no confirmation', async () => {
  const { fleet, transport, state } = harness()
  const result = await navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/c/next' }, { fleet, transport })
  assert.equal(result.url, 'https://chatgpt.com/c/next')
  assert.equal(result.left_chatgpt, false)
  assert.equal(result.loaded, true)
  assert.equal(result.fleet, 'writers')
  // Addressed by the derived client id, never a caller-supplied one.
  assert.equal(state.navigateCalls[0].clientId, 'client-owned')
  assert.equal(state.navigateCalls[0].options.waitUntil, 'load')
})

test('a foreign tab is refused exactly like a tab that does not exist', async () => {
  const { fleet, transport, state } = harness()
  const messages = []
  for (const tabId of [FOREIGN_TAB, 4242]) {
    await assert.rejects(
      navigateOwnedTab({ browser_tab_id: tabId, url: 'https://chatgpt.com/' }, { fleet, transport }),
      error => {
        assert.equal(error.code, 'NOT_FOUND')
        messages.push(error.message.replace(String(tabId), 'X'))
        return true
      },
    )
  }
  assert.equal(new Set(messages).size, 1)
  assert.equal(state.navigateCalls.length, 0, 'the relay is never asked to navigate an unowned tab')
})

test('a generating tab is never navigated out from under its response', async () => {
  const { fleet, transport, state } = harness({ busy: 'active_request' })
  await rejects(navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/' }, { fleet, transport }), 'BUSY')
  assert.equal(state.navigateCalls.length, 0)
})

test('a running fleet slot cannot be taken off ChatGPT at all', async () => {
  const { fleet, transport, state } = harness({ running: true })
  await assert.rejects(
    navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'http://localhost:3000/', confirm: true }, { fleet, transport }),
    error => {
      assert.equal(error.code, 'BUSY')
      assert.match(error.message, /fleet_stop/)
      return true
    },
  )
  assert.equal(state.navigateCalls.length, 0, 'confirm does not override a live fleet')
  // ...but navigating within ChatGPT is still fine while the fleet runs.
  const inside = await navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/c/other' }, { fleet, transport })
  assert.equal(inside.left_chatgpt, false)
})

test('leaving ChatGPT on a stopped fleet needs an explicit confirmation', async () => {
  const { fleet, transport, state } = harness({ running: false, reply: options => ({ url: options.url, loaded: true }) })
  await assert.rejects(
    navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'http://localhost:3000/app' }, { fleet, transport }),
    error => {
      assert.equal(error.code, 'PERMISSION_REQUIRED')
      assert.match(error.message, /confirm=true/)
      return true
    },
  )
  assert.equal(state.navigateCalls.length, 0)

  const confirmed = await navigateOwnedTab(
    { browser_tab_id: OWNED_TAB, url: 'http://localhost:3000/app', confirm: true },
    { fleet, transport },
  )
  assert.equal(confirmed.url, 'http://localhost:3000/app')
  assert.equal(confirmed.left_chatgpt, true)
})

test('ownership is re-checked immediately before the navigation', async () => {
  const { fleet, transport, state } = harness({
    clients: call => (call === 1
      ? [{ id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/abc', ready: true }]
      : [{ id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/moved', ready: true }]),
  })
  await rejects(navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/c/next' }, { fleet, transport }), 'CONFLICT')
  assert.equal(state.navigateCalls.length, 0)
})

test('a relay without the navigate route says exactly what is missing', async () => {
  const { fleet, transport, state } = harness({ capabilities: { screenshot: true, navigate: false } })
  await assert.rejects(
    navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/' }, { fleet, transport }),
    error => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.message, /POST \/browser\/tabs\/navigate/)
      return true
    },
  )
  assert.equal(state.navigateCalls.length, 0)
})

test('an unreachable relay and a missing fleet are both refused cleanly', async () => {
  const down = harness({ capabilitiesThrows: true })
  await assert.rejects(
    navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/' }, { fleet: down.fleet, transport: down.transport }),
    error => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.equal(error.retryable, true)
      return true
    },
  )
  await rejects(navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/' }, { fleet: null, transport: null }), 'UNSUPPORTED')
})

test('a relay navigation failure is reported, not swallowed', async () => {
  const { fleet, transport } = harness({ reply: () => { throw new Error('net::ERR_CONNECTION_REFUSED') } })
  await assert.rejects(
    navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/' }, { fleet, transport }),
    error => {
      assert.equal(error.code, 'PROCESS_FAILED')
      assert.match(error.message, /ERR_CONNECTION_REFUSED/)
      return true
    },
  )
})

test('a page that never finishes loading is reported as navigated but not loaded', async () => {
  const { fleet, transport } = harness({
    reply: options => ({ url: options.url, loaded: false, loadError: 'waiting for Page.loadEventFired timed out after 30000 ms' }),
  })
  const result = await navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/c/slow' }, { fleet, transport })
  assert.equal(result.loaded, false)
  assert.match(result.load_error, /timed out/)
})

test('the reported URL is where the browser ended up, redirects included', async () => {
  const { fleet, transport } = harness({
    running: false,
    reply: () => ({ url: 'https://elsewhere.example/landing', loaded: true }),
  })
  const result = await navigateOwnedTab(
    { browser_tab_id: OWNED_TAB, url: 'https://redirector.example/go', confirm: true },
    { fleet, transport },
  )
  assert.equal(result.requested_url, 'https://redirector.example/go')
  assert.equal(result.url, 'https://elsewhere.example/landing')
  assert.equal(result.left_chatgpt, true)
})

test('wait_until and timeout are validated and passed through', async () => {
  const { fleet, transport, state } = harness()
  await rejects(navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/', wait_until: 'idle' }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/', timeout_ms: 10 }, { fleet, transport }), 'INVALID_ARGUMENT')
  await rejects(navigateOwnedTab({ browser_tab_id: '7', url: 'https://chatgpt.com/' }, { fleet, transport }), 'INVALID_ARGUMENT')

  await navigateOwnedTab({ browser_tab_id: OWNED_TAB, url: 'https://chatgpt.com/', wait_until: 'commit', timeout_ms: 5000 }, { fleet, transport })
  assert.equal(state.navigateCalls.at(-1).options.waitUntil, 'commit')
  assert.equal(state.navigateCalls.at(-1).options.timeoutMs, 5000)

  // A read-only capture may run on a busy tab; navigation may not. Same helper,
  // different per-action policy.
  assert.equal(BUSY_POLICY.refuse, 'refuse')
})
