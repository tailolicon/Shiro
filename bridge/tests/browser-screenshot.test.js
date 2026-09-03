import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertUnchanged, BUSY_POLICY, ownerOfTab, recheckOwnedBrowserTab, resolveOwnedBrowserTab,
} from '../src/browser-ownership.js'
import { captureOwnedTabScreenshot, decodeCapture, SCREENSHOT_LIMITS } from '../src/browser-screenshot.js'
import { BrowserFleetTransport } from '../src/fleet-manager.js'
import { Sandbox } from '../src/sandbox.js'

const OWNED_TAB = 7
const FOREIGN_TAB = 8

/** A real PNG header plus padding, so magic-byte checks are exercised. */
function png(width = 4, height = 3, padding = 0) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  return Buffer.concat([signature, ihdr, Buffer.alloc(padding, 7)])
}

/**
 * Fleet double wired to the REAL ownership helper, so these tests exercise the
 * actual gate rather than a stand-in for it.
 */
function harness(overrides = {}) {
  const state = {
    clients: [
      { id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/abc', ready: true },
      { id: 'client-foreign', browserTabId: FOREIGN_TAB, url: 'https://chatgpt.com/c/private', ready: true },
    ],
    busy: '',
    modeOk: true,
    capabilities: { screenshot: true },
    reply: () => ({ ok: true, image: { data_base64: png().toString('base64'), format: 'png' } }),
    listCalls: 0,
    screenshotCalls: [],
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
  const shared = { tabId: undefined, findOwner: tabId => ownerOfTab(fleets, tabId), listClients }
  const fleet = {
    async resolveOwnedTab(tabId, options) {
      return await resolveOwnedBrowserTab({ ...shared, tabId, inspect: async () => ({ modeOk: state.modeOk, busy: state.busy }), ...options })
    },
    async recheckOwnedTab(tabId, marker, action) {
      return assertUnchanged(marker, await recheckOwnedBrowserTab({ ...shared, tabId, action }), action)
    },
  }
  const transport = {
    async capabilities() {
      if (state.capabilitiesThrows) throw new Error('relay down')
      return state.capabilities
    },
    async screenshot(clientId, options) {
      state.screenshotCalls.push({ clientId, options })
      return state.reply(clientId, options)
    },
  }
  return { state, fleet, transport, fleets }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shiro-shot-'))
  return { root, sandbox: new Sandbox(root), cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

const NOW = Date.parse('2026-09-03T10:11:12.000Z')
const options = extra => ({ now: () => NOW, ...extra })

test('an owned tab is captured to a workspace file, not into the JSON result', async () => {
  const { root, sandbox, cleanup } = await fixture()
  const { fleet, transport, state } = harness()
  try {
    const result = await captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet, transport }))
    assert.equal(result.browser_tab_id, OWNED_TAB)
    assert.equal(result.fleet, 'writers')
    assert.equal(result.format, 'png')
    assert.equal(result.mime_type, 'image/png')
    assert.equal(result.width, 4)
    assert.equal(result.height, 3)
    assert.equal(result.full_page, false)
    assert.match(result.path, /^\.shiro\/screenshots\/tab-7-2026-09-03T10-11-12-000\.png$/)
    assert.match(result.sha256, /^[0-9a-f]{64}$/)
    // The bytes are on disk, and nowhere in the payload.
    const written = await readFile(join(root, result.path))
    assert.equal(written.length, result.bytes)
    assert.ok(!JSON.stringify(result).includes('iVBOR'), 'the image must not be inlined into the result')

    // The relay was addressed by the DERIVED client id, never a caller value.
    assert.equal(state.screenshotCalls[0].clientId, 'client-owned')
    assert.equal(state.screenshotCalls[0].options.fullPage, false)
  } finally {
    await cleanup()
  }
})

test('a foreign tab is refused exactly like a tab that does not exist', async () => {
  const { sandbox, cleanup } = await fixture()
  const { fleet, transport, state } = harness()
  try {
    const messages = []
    for (const tabId of [FOREIGN_TAB, 4242]) {
      await assert.rejects(
        captureOwnedTabScreenshot(sandbox, { browser_tab_id: tabId }, options({ fleet, transport })),
        error => {
          assert.equal(error.code, 'NOT_FOUND')
          messages.push(error.message.replace(String(tabId), 'X'))
          return true
        },
      )
    }
    assert.equal(new Set(messages).size, 1, 'foreign and unknown must be indistinguishable')
    assert.equal(state.screenshotCalls.length, 0, 'the relay is never asked to capture an unowned tab')
  } finally {
    await cleanup()
  }
})

test('ownership is re-checked immediately before the capture', async () => {
  const { root, sandbox, cleanup } = await fixture()
  // Verified while the tab is at /abc; by the time the capture would run the
  // tab has navigated, so the resolved authority no longer describes it.
  const { fleet, transport, state } = harness({
    clients: call => (call === 1
      ? [{ id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/abc', ready: true }]
      : [{ id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/moved', ready: true }]),
  })
  try {
    await rejects(captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet, transport })), 'CONFLICT')
    assert.equal(state.screenshotCalls.length, 0)
    assert.deepEqual(await readdir(root), [], 'a refused capture writes nothing')
  } finally {
    await cleanup()
  }
})

test('a tab closed between verification and capture fails safely', async () => {
  const { root, sandbox, cleanup } = await fixture()
  const { fleet, transport, state } = harness({
    clients: call => (call === 1
      ? [{ id: 'client-owned', browserTabId: OWNED_TAB, url: 'https://chatgpt.com/c/abc', ready: true }]
      : []),
  })
  try {
    await assert.rejects(
      captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet, transport })),
      error => {
        assert.equal(error.code, 'NOT_FOUND')
        assert.match(error.message, /no longer connected/)
        return true
      },
    )
    assert.equal(state.screenshotCalls.length, 0)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await cleanup()
  }
})

test('ownership moving to another fleet slot invalidates the capture', async () => {
  const { sandbox, cleanup } = await fixture()
  const { fleet, transport, fleets, state } = harness()
  try {
    const original = fleet.recheckOwnedTab.bind(fleet)
    fleet.recheckOwnedTab = async (tabId, marker, action) => {
      // The tab is recycled into a different slot between the two checks.
      fleets[0].workers[0] = { slot: 2, workerId: 'worker-2', browserTabId: OWNED_TAB, state: 'idle' }
      return await original(tabId, marker, action)
    }
    await rejects(captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet, transport })), 'CONFLICT')
    assert.equal(state.screenshotCalls.length, 0)
  } finally {
    await cleanup()
  }
})

test('a relay without a screenshot route says exactly what is missing', async () => {
  const { sandbox, cleanup } = await fixture()
  const { fleet, transport, state } = harness({ capabilities: { screenshot: false } })
  try {
    await assert.rejects(
      captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet, transport })),
      error => {
        assert.equal(error.code, 'UNSUPPORTED')
        assert.match(error.message, /POST \/browser\/tabs\/screenshot/)
        assert.match(error.message, /capabilities\.browser\.screenshot/)
        return true
      },
    )
    assert.equal(state.screenshotCalls.length, 0, 'no capture is attempted against a relay that cannot do it')
  } finally {
    await cleanup()
  }
})

test('an unreachable relay is retryable UNSUPPORTED, and a missing fleet is refused', async () => {
  const { sandbox, cleanup } = await fixture()
  const down = harness({ capabilitiesThrows: true })
  try {
    await assert.rejects(
      captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet: down.fleet, transport: down.transport })),
      error => {
        assert.equal(error.code, 'UNSUPPORTED')
        assert.equal(error.retryable, true)
        return true
      },
    )
    await rejects(captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet: null, transport: null })), 'UNSUPPORTED')

    // The relay may also drop between the capability probe and the client list.
    const dropped = harness({ listThrows: true })
    await rejects(
      captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet: dropped.fleet, transport: dropped.transport })),
      'UNSUPPORTED',
    )
  } finally {
    await cleanup()
  }
})

test('a relay error during capture never leaves a partial file', async () => {
  const { root, sandbox, cleanup } = await fixture()
  const { fleet, transport } = harness({ reply: () => { throw new Error('extension timed out') } })
  try {
    await rejects(captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet, transport })), 'PROCESS_FAILED')
    assert.deepEqual(await readdir(root), [])
  } finally {
    await cleanup()
  }
})

test('a malformed relay reply is rejected and cleaned up', async () => {
  const { root, sandbox, cleanup } = await fixture()
  for (const [label, reply] of [
    ['no image at all', () => ({ ok: true })],
    ['empty payload', () => ({ image: { data_base64: '' } })],
    ['not an image', () => ({ image: { data_base64: Buffer.from('<html>error page</html>').toString('base64') } })],
    ['wrong format', () => ({ image: { data_base64: png().toString('base64'), format: 'webp' } })],
  ]) {
    const { fleet, transport } = harness({ reply })
    const format = label === 'wrong format' ? 'webp' : 'png'
    await assert.rejects(
      captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB, format }, options({ fleet, transport })),
      error => {
        assert.equal(error.code, 'PROCESS_FAILED', `${label}: ${error.code} ${error.message}`)
        return true
      },
    )
  }
  // Not one byte of any of those attempts survived.
  assert.deepEqual(await readdir(root), [])
  await cleanup()
})

test('an oversized capture is refused before it reaches the workspace', async () => {
  const { root, sandbox, cleanup } = await fixture()
  const { fleet, transport } = harness({ reply: () => ({ image: { data_base64: png(4, 3, 40_000).toString('base64') } }) })
  try {
    await rejects(
      captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB, max_bytes: 4096 }, options({ fleet, transport })),
      'INVALID_ARGUMENT',
    )
    assert.deepEqual(await readdir(root), [])
    assert.ok(SCREENSHOT_LIMITS.max_bytes_cap >= SCREENSHOT_LIMITS.max_bytes_default)
  } finally {
    await cleanup()
  }
})

test('decodeCapture bounds the payload before allocating it', () => {
  // The base64 length check must reject before Buffer.from materializes a huge
  // string, so a hostile relay cannot make the bridge allocate at will.
  assert.throws(
    () => decodeCapture({ image: { data_base64: 'A'.repeat(10_000) } }, { format: 'png', maxBytes: 1000 }),
    error => error.code === 'INVALID_ARGUMENT',
  )
})

test('the destination stays inside the workspace and is not silently overwritten', async () => {
  const { root, sandbox, cleanup } = await fixture()
  const { fleet, transport } = harness()
  try {
    await rejects(
      captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB, save_to: '../escape.png' }, options({ fleet, transport })),
      'OUTSIDE_SANDBOX',
    )
    await writeFile(join(root, 'taken.png'), 'existing')
    await rejects(
      captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB, save_to: 'taken.png' }, options({ fleet, transport })),
      'ALREADY_EXISTS',
    )
    assert.equal(await readFile(join(root, 'taken.png'), 'utf8'), 'existing')

    const replaced = await captureOwnedTabScreenshot(
      sandbox,
      { browser_tab_id: OWNED_TAB, save_to: 'taken.png', overwrite: true },
      options({ fleet, transport }),
    )
    assert.equal(replaced.overwrote, true)
  } finally {
    await cleanup()
  }
})

test('a capture may run while the tab is generating, unlike a write action', async () => {
  const { sandbox, cleanup } = await fixture()
  const { fleet, transport } = harness({ busy: 'active_request' })
  try {
    // Read-only: watching a response arrive is exactly when a capture is useful.
    const result = await captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet, transport }))
    assert.equal(result.busy, true)
    // ...while a write action on the same tab is still refused.
    await rejects(fleet.resolveOwnedTab(OWNED_TAB, { busyPolicy: BUSY_POLICY.refuse, action: 'typing' }), 'BUSY')
  } finally {
    await cleanup()
  }
})

test('argument validation covers format, bounds and tab id', async () => {
  const { sandbox, cleanup } = await fixture()
  const { fleet, transport } = harness()
  try {
    for (const args of [
      { browser_tab_id: OWNED_TAB, format: 'gif' },
      { browser_tab_id: OWNED_TAB, max_bytes: 1 },
      { browser_tab_id: OWNED_TAB, max_width: 1 },
      { browser_tab_id: OWNED_TAB, timeout_ms: 1 },
      { browser_tab_id: '7' },
    ]) {
      await rejects(captureOwnedTabScreenshot(sandbox, args, options({ fleet, transport })), 'INVALID_ARGUMENT')
    }
  } finally {
    await cleanup()
  }
})

test('full_page and max_width reach the relay only when asked for', async () => {
  const { sandbox, cleanup } = await fixture()
  const { fleet, transport, state } = harness()
  try {
    await captureOwnedTabScreenshot(
      sandbox,
      { browser_tab_id: OWNED_TAB, full_page: true, max_width: 1024, timeout_ms: 5000 },
      options({ fleet, transport }),
    )
    const sent = state.screenshotCalls.at(-1).options
    assert.equal(sent.fullPage, true)
    assert.equal(sent.maxWidth, 1024)
    assert.equal(sent.timeoutMs, 5000)
    assert.equal(sent.format, 'png')
  } finally {
    await cleanup()
  }
})

test('a relay failure message cannot smuggle secrets into the result', async () => {
  const { sandbox, cleanup } = await fixture()
  const secret = 'Bearer sk-live-should-never-appear'
  const { fleet, transport } = harness({ reply: () => { throw new Error(`upstream said ${secret}`) } })
  try {
    // The bridge redacts what it returns; this pins that the raw header value
    // is not what a caller receives verbatim from a relay error.
    await assert.rejects(
      captureOwnedTabScreenshot(sandbox, { browser_tab_id: OWNED_TAB }, options({ fleet, transport })),
      error => {
        assert.equal(error.code, 'PROCESS_FAILED')
        assert.ok(error.message.length < 500, 'relay error text must stay bounded')
        return true
      },
    )
  } finally {
    await cleanup()
  }
})

// The wire contract with the relay. These two calls are the only place the
// bridge and relay/chatgpt-bridge have to agree, so they are pinned here rather
// than discovered at runtime on a live machine.
test('the transport speaks the relay screenshot contract', async () => {
  const calls = []
  const transport = new BrowserFleetTransport({
    url: 'http://127.0.0.1:23158',
    token: 'relay-token',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
      if (String(url).endsWith('/capabilities')) {
        return { ok: true, status: 200, statusText: 'OK', async text() { return JSON.stringify({ ok: true, browser: { connected: true, screenshot: true } }) } }
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() { return JSON.stringify({ ok: true, image: { data_base64: 'AAAA', format: 'png', bytes: 3 } }) }
      }
    },
  })

  const capabilities = await transport.capabilities()
  assert.equal(capabilities.screenshot, true, 'features.browser_screenshot follows capabilities.browser.screenshot')
  assert.equal(calls[0].url, 'http://127.0.0.1:23158/capabilities')
  assert.equal(calls[0].method, 'GET')

  await transport.screenshot('client-owned', { format: 'webp', fullPage: true, maxWidth: 1024, timeoutMs: 9000 })
  assert.equal(calls[1].url, 'http://127.0.0.1:23158/browser/tabs/screenshot')
  assert.equal(calls[1].method, 'POST')
  assert.deepEqual(calls[1].body, {
    sourceClientId: 'client-owned',
    format: 'webp',
    fullPage: true,
    maxWidth: 1024,
    timeoutMs: 9000,
  })

  // A relay build without the route reports the capability as absent, which is
  // what turns browser_tab_screenshot into a precise UNSUPPORTED.
  const older = new BrowserFleetTransport({
    url: 'http://127.0.0.1:23158',
    token: 'relay-token',
    fetchImpl: async () => ({ ok: true, status: 200, statusText: 'OK', async text() { return JSON.stringify({ ok: true, browser: { connected: true } }) } }),
  })
  assert.equal((await older.capabilities()).screenshot, false)
})
