import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { BridgeBroker, configureMcp } from '../src/index.js'
import { CONTINUATION_DEFAULTS, ContinuationWatchdog } from '../src/continuation.js'

const MINUTE = 60_000

/** A submit() double that records calls and can be told to fail once. */
function fakeSubmit({ failNext = false } = {}) {
  const calls = []
  const state = { failNext }
  return {
    calls,
    state,
    fn: async (target, text) => {
      calls.push({ target, text })
      if (state.failNext) {
        state.failNext = false
        throw new Error('relay unreachable')
      }
      return { ok: true }
    },
  }
}

function clock(start = 0) {
  let now = start
  return { now: () => now, advance: ms => { now += ms } }
}

test('with nothing designated, a sweep is a no-op', async () => {
  const submit = fakeSubmit()
  const watchdog = new ContinuationWatchdog({ submit: submit.fn, pending: () => [] })
  const result = await watchdog.sweep()
  assert.deepEqual(result, { checked: 0, nudged: 0, reason: 'no continuation tab is designated' })
  assert.equal(submit.calls.length, 0)
})

test('designating requires a tab id and rejects nonsense ranges', () => {
  const watchdog = new ContinuationWatchdog({ submit: async () => {}, pending: () => [] })
  assert.throws(() => watchdog.designate({}), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => watchdog.designate({ browser_client_id: '  ' }), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => watchdog.designate({ browser_client_id: 'tab-1', after_minutes: 0 }), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => watchdog.designate({ browser_client_id: 'tab-1', after_minutes: 999 }), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => watchdog.designate({ browser_client_id: 'tab-1', text: '' }), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => watchdog.designate({ browser_client_id: 'tab-1', text: 'x'.repeat(2001) }), error => error.code === 'INVALID_ARGUMENT')
})

test('the defaults match the 27-minute nudge the platform cut-off calls for', () => {
  // 25 minutes is the platform's own cut-off; 27 is past it with margin, not a
  // round number picked for its own sake.
  assert.equal(CONTINUATION_DEFAULTS.after_minutes, 27)
  assert.equal(CONTINUATION_DEFAULTS.text, 'continue')
  const watchdog = new ContinuationWatchdog({ submit: async () => {}, pending: () => [] })
  const snapshot = watchdog.designate({ browser_client_id: 'tab-1' })
  assert.equal(snapshot.after_minutes, 27)
  assert.equal(snapshot.text, 'continue')
  assert.equal(snapshot.cooldown_minutes, CONTINUATION_DEFAULTS.cooldown_minutes)
  assert.equal(snapshot.max_nudges, CONTINUATION_DEFAULTS.max_nudges)
})

test('a turn stalled past after_minutes gets nudged exactly once per sweep', async () => {
  const time = clock()
  const submit = fakeSubmit()
  const watchdog = new ContinuationWatchdog({
    submit: submit.fn,
    now: time.now,
    pending: () => [
      { session_id: 'session-old', waiting_ms: 28 * MINUTE },
      { session_id: 'session-newer', waiting_ms: 26 * MINUTE },
    ],
  })
  watchdog.designate({ browser_client_id: 'tab-42', url: 'https://chatgpt.com/c/abc' })

  const result = await watchdog.sweep()
  assert.equal(result.nudged, 1)
  assert.equal(result.checked, 2)
  // The OLDEST stalled turn is the one worth nudging: it has been waiting longest.
  assert.equal(result.session_id, 'session-old')
  assert.equal(submit.calls.length, 1)
  assert.deepEqual(submit.calls[0].target, { browser_client_id: 'tab-42', url: 'https://chatgpt.com/c/abc' })
  assert.equal(submit.calls[0].text, 'continue')

  const snapshot = watchdog.snapshot()
  assert.equal(snapshot.nudges, 1)
  assert.equal(snapshot.nudges_remaining, CONTINUATION_DEFAULTS.max_nudges - 1)
  assert.equal(snapshot.recent.length, 1)
  assert.equal(snapshot.recent[0].ok, true)
})

test('a turn that has not been waiting long enough is left alone', async () => {
  const submit = fakeSubmit()
  const watchdog = new ContinuationWatchdog({
    submit: submit.fn,
    pending: () => [{ session_id: 'session-fresh', waiting_ms: 5 * MINUTE }],
  })
  watchdog.designate({ browser_client_id: 'tab-1', after_minutes: 27 })
  const result = await watchdog.sweep()
  assert.equal(result.nudged, 0)
  assert.match(result.reason, /no turn has been waiting long enough/)
  assert.equal(submit.calls.length, 0)
})

test('the cooldown blocks a second nudge until it elapses', async () => {
  const time = clock()
  const submit = fakeSubmit()
  const watchdog = new ContinuationWatchdog({
    submit: submit.fn,
    now: time.now,
    pending: () => [{ session_id: 'session-1', waiting_ms: 30 * MINUTE }],
  })
  watchdog.designate({ browser_client_id: 'tab-1', after_minutes: 27, cooldown_minutes: 3 })

  const first = await watchdog.sweep()
  assert.equal(first.nudged, 1)

  time.advance(2 * MINUTE)
  const second = await watchdog.sweep()
  assert.equal(second.nudged, 0)
  assert.match(second.reason, /cooldown/)
  assert.equal(submit.calls.length, 1, 'still just the one nudge')

  time.advance(2 * MINUTE) // total 4 minutes since the first nudge, past the 3-minute cooldown
  const third = await watchdog.sweep()
  assert.equal(third.nudged, 1)
  assert.equal(submit.calls.length, 2)
})

test('a failed nudge does not spend the budget or start the cooldown', async () => {
  const time = clock()
  const submit = fakeSubmit({ failNext: true })
  const watchdog = new ContinuationWatchdog({
    submit: submit.fn,
    now: time.now,
    pending: () => [{ session_id: 'session-1', waiting_ms: 30 * MINUTE }],
  })
  watchdog.designate({ browser_client_id: 'tab-1', after_minutes: 27 })

  const failed = await watchdog.sweep()
  assert.equal(failed.nudged, 0)
  assert.match(failed.error, /relay unreachable/)
  assert.equal(watchdog.snapshot().nudges, 0, 'a failed attempt is not a spent nudge')

  // Immediately retried -- no cooldown was started by the failure.
  const retried = await watchdog.sweep()
  assert.equal(retried.nudged, 1)
  assert.equal(watchdog.snapshot().nudges, 1)
  assert.equal(watchdog.snapshot().last_error, undefined, 'a later success clears the last error')
})

test('the nudge budget stops the watchdog on its own', async () => {
  const time = clock()
  const submit = fakeSubmit()
  const watchdog = new ContinuationWatchdog({
    submit: submit.fn,
    now: time.now,
    pending: () => [{ session_id: 'session-1', waiting_ms: 30 * MINUTE }],
  })
  watchdog.designate({ browser_client_id: 'tab-1', after_minutes: 27, cooldown_minutes: 1, max_nudges: 2 })

  await watchdog.sweep()
  time.advance(2 * MINUTE)
  await watchdog.sweep()
  time.advance(2 * MINUTE)
  const third = await watchdog.sweep()

  assert.equal(third.nudged, 0)
  assert.match(third.reason, /budget \(2\) is spent/)
  assert.equal(submit.calls.length, 2)
})

test('re-designating replaces the target and resets history', async () => {
  const watchdog = new ContinuationWatchdog({ submit: async () => {}, pending: () => [] })
  watchdog.designate({ browser_client_id: 'tab-1', max_nudges: 1 })
  watchdog.history.push({ at: 'x', ok: true })
  watchdog.designate({ browser_client_id: 'tab-2' })
  assert.equal(watchdog.snapshot().browser_client_id, 'tab-2')
  assert.equal(watchdog.snapshot().recent.length, 0)
})

test('clearing forgets the target without touching stalled turns', () => {
  const watchdog = new ContinuationWatchdog({ submit: async () => {}, pending: () => [] })
  assert.deepEqual(watchdog.clear(), { cleared: false })
  watchdog.designate({ browser_client_id: 'tab-1' })
  assert.deepEqual(watchdog.clear(), { cleared: true })
  assert.equal(watchdog.snapshot().designated, false)
})

test('pending-read failure is reported, not thrown', async () => {
  const watchdog = new ContinuationWatchdog({
    submit: async () => {},
    pending: () => { throw new Error('broker gone') },
  })
  watchdog.designate({ browser_client_id: 'tab-1' })
  const result = await watchdog.sweep()
  assert.equal(result.nudged, 0)
  assert.match(result.reason, /broker gone/)
})

// -- through MCP: the four connector actions -------------------------------

async function withConnector(run) {
  const root = await mkdtemp(join(tmpdir(), 'shiro-continuation-'))
  // Started at the real clock: the broker stamps createdAt with the real
  // Date.now(), so a fake clock starting at 0 would make every pending
  // request look astronomically old rather than freshly enqueued.
  const time = clock(Date.now())
  const submit = fakeSubmit()
  const continuation = new ContinuationWatchdog({ submit: submit.fn, now: time.now, pending: () => broker.waiting(time.now()) })
  const broker = new BridgeBroker()
  const controller = {
    broker,
    async sessions() { return { sessions: [] } },
    async status() { return { status: 'idle' } },
  }
  const server = new McpServer({ name: 'continuation-test', version: '0.0.0' })
  configureMcp(server, controller, { workspaceRoot: root, waitMs: 25_000, token: 'x' }, {}, { continuation })
  const client = new Client({ name: 'continuation-test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return { isError: result.isError === true, body: result.structuredContent }
  }
  try {
    await run({ call, root, time, submit, broker })
  } finally {
    await client.close()
    await server.close()
  }
}

test('continuation_set/status/clear/check round-trip through MCP', async () => {
  await withConnector(async ({ call, time, submit, broker }) => {
    const empty = await call('continuation_status')
    assert.equal(empty.body.designated, false)

    const set = await call('continuation_set', { browser_client_id: 'tab-99', after_minutes: 27 })
    assert.equal(set.isError, false)
    assert.equal(set.body.designated, true)
    assert.equal(set.body.browser_client_id, 'tab-99')

    // Stamp a pending request that is old enough to be nudged, through the real
    // broker rather than a double, so the wiring end to end is what is tested.
    broker.enqueue({ sessionId: 'session-live', model: 'x', reasoningEffort: 'standard', messages: [], tools: [] })
    time.advance(30 * MINUTE)

    const checked = await call('continuation_check')
    assert.equal(checked.isError, false)
    assert.equal(checked.body.nudged, 1)
    assert.equal(submit.calls.length, 1)
    assert.equal(submit.calls[0].text, 'continue')

    const status = await call('continuation_status')
    assert.equal(status.body.nudges, 1)

    const cleared = await call('continuation_clear')
    assert.equal(cleared.body.cleared, true)
    assert.equal((await call('continuation_status')).body.designated, false)
  })
})

test('continuation_set validates arguments through the MCP boundary too', async () => {
  await withConnector(async ({ call }) => {
    // A missing REQUIRED field (browser_client_id has no .optional()) is
    // rejected by the MCP SDK's own schema check, before our handler runs --
    // isError is true but there is no structuredContent, only a text block.
    const missing = await call('continuation_set', {})
    assert.equal(missing.isError, true)
    assert.equal(missing.body, undefined)

    // A value that satisfies the Zod schema (a non-empty string) but fails our
    // own check reaches the handler and comes back in the bridge's error
    // vocabulary: Zod only sees raw length, not that it trims to nothing.
    const blank = await call('continuation_set', { browser_client_id: '   ' })
    assert.equal(blank.isError, true)
    assert.equal(blank.body.error.code, 'INVALID_ARGUMENT')
  })
})

test('without a browser relay configured, continuation actions refuse cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-continuation-none-'))
  try {
    const controller = { broker: new BridgeBroker(), async sessions() { return { sessions: [] } }, async status() { return { status: 'idle' } } }
    const server = new McpServer({ name: 'continuation-none', version: '0.0.0' })
    // No `continuation` in runtime and no fleetManager -- the shape a deployment
    // without SHIRO_RELAY_URL actually has.
    configureMcp(server, controller, { workspaceRoot: root, waitMs: 25_000, token: 'x' }, null, {})
    const client = new Client({ name: 'continuation-none-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({ name: 'continuation_status', arguments: {} })
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.error.code, 'UNSUPPORTED')
    } finally {
      await client.close()
      await server.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
