import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeBroker, BridgeController } from '../src/index.js'

function ok(value) {
  return Promise.resolve({ result: { ok: true, value } })
}

function fixture(maxConcurrentTurns = 3, configOverrides = {}) {
  const sessionIds = ['session-a', 'session-b', 'session-c', 'session-d']
  const prompts = []
  const cancellations = []
  const creations = []
  const selections = []
  const histories = new Map(sessionIds.map(sessionId => [sessionId, []]))
  const ctx = {
    apiProxy: {
      events: {
        mux() {
          return { async *[Symbol.asyncIterator]() {} }
        },
      },
      workspace: {
        create: () => ok({ workspace: { workspaceId: 'workspace-test', title: 'Test', sessionIds } }),
      },
      sessions: {
        list: () => ok({ items: sessionIds.map(sessionId => ({ sessionId })) }),
        create(request) {
          creations.push(request.payload)
          return ok({ sessionId: `session-new-${sessionIds.length}` })
        },
        selectModel(request) {
          selections.push(request.payload)
          return ok({})
        },
        history(request) {
          const source = histories.get(request.payload.sessionId) ?? []
          const eligible = request.payload.beforeSeq === undefined
            ? source
            : source.filter(event => event.seq < request.payload.beforeSeq)
          const maxMessages = request.payload.maxMessages ?? 100
          const events = eligible.slice(-maxMessages)
          return ok({ events: events.map(event => ({ event })), hasMore: eligible.length > events.length })
        },
        prompt(request) {
          prompts.push(request.payload.sessionId)
          return ok({})
        },
        cancel(request) {
          cancellations.push(request.payload.sessionId)
          return ok({})
        },
      },
      respond: () => ok({}),
    },
    get: () => undefined,
  }
  const broker = new BridgeBroker()
  const controller = new BridgeController(ctx, broker, {
    provider: 'shiro-sol',
    model: 'gpt-5.6-sol',
    waitMs: 0,
    maxConcurrentTurns,
    sessionStatePath: ':memory:',
    workspaceRoot: '/tmp/shiro-test',
    ...configOverrides,
  })
  return { broker, controller, prompts, cancellations, creations, selections, histories }
}

test('controller runs independent root sessions concurrently and enforces the bound atomically', async () => {
  const { controller, prompts, cancellations } = fixture(3)
  try {
    const outcomes = await Promise.all([
      controller.start('one', undefined, 'session-a'),
      controller.start('two', undefined, 'session-b'),
      controller.start('three', undefined, 'session-c'),
    ])
    assert.deepEqual(prompts.sort(), ['session-a', 'session-b', 'session-c'])
    assert.equal(new Set(outcomes.map(outcome => outcome.operation_id)).size, 3)
    assert.deepEqual(outcomes.map(outcome => outcome.state), ['running', 'running', 'running'])

    const aggregate = await controller.status(0)
    assert.equal(aggregate.state, 'running')
    assert.equal(aggregate.operations.length, 3)
    await assert.rejects(controller.start('four', undefined, 'session-d'), /3 concurrent root turns/)
    await assert.rejects(controller.start('duplicate', undefined, 'session-a'), /3 concurrent root turns|already has a running root turn/)

    const first = outcomes[0]
    const scoped = await controller.status(0, first.operation_id)
    assert.equal(scoped.session_id, 'session-a')
    assert.deepEqual(await controller.cancel(first.operation_id), {
      cancelled: true,
      operation_id: first.operation_id,
      session_id: 'session-a',
      root_session_id: 'session-a',
      // Every turn payload now names the workspace it was anchored in; a turn
      // started without one is the primary workspace, as before.
      workspace: 'project',
    })
    assert.deepEqual(cancellations, ['session-a'])
    const replacement = await controller.start('replacement', undefined, 'session-d')
    assert.equal(replacement.session_id, 'session-d')
  } finally {
    await controller.dispose()
  }
})

test('autonomous mode selects the native ctx.llm route and never enters the Web model broker', async () => {
  const { broker, controller, selections } = fixture(3, {
    executionMode: 'autonomous',
    autonomousProvider: 'native-openai',
    autonomousModel: 'gpt-native-test',
  })
  try {
    const outcome = await controller.start('one large task', undefined, 'session-a', 'fast')
    assert.equal(outcome.state, 'running')
    assert.equal(outcome.execution_mode, 'autonomous')
    assert.deepEqual(outcome.model_route, { provider: 'native-openai', model: 'gpt-native-test' })
    assert.equal(broker.snapshot().length, 0, 'native loop ownership must not create a Web relay request')
    assert.deepEqual(selections, [{
      sessionId: 'session-a',
      provider: 'native-openai',
      model: 'gpt-native-test',
      reasoningEffort: 'light',
    }])
    const operation = controller.operationGet(outcome.operation_id)
    assert.equal(operation.execution_mode, 'autonomous')
    assert.deepEqual(operation.model_route, { provider: 'native-openai', model: 'gpt-native-test' })
  } finally {
    await controller.dispose()
  }
})

test('an unconfigured autonomous override fails before creating or claiming a session', async () => {
  const { controller, creations, selections, prompts } = fixture()
  try {
    await assert.rejects(
      controller.start('do not dispatch', undefined, undefined, 'balanced', undefined, {}, {}, 'autonomous'),
      /autonomous execution is not configured/,
    )
    assert.deepEqual(creations, [])
    assert.deepEqual(selections, [])
    assert.deepEqual(prompts, [])
    assert.equal(controller.operationList().total, 0)
  } finally {
    await controller.dispose()
  }
})

test('operation metrics derive model/tool latency and observed parallelism from durable events', async () => {
  const { controller, histories } = fixture(3, {
    executionMode: 'autonomous',
    autonomousProvider: 'native-openai',
    autonomousModel: 'gpt-native-test',
  })
  try {
    const started = await controller.start('benchmark me', undefined, 'session-a')
    const acceptedAt = controller.operationGet(started.operation_id).accepted_at
    histories.set('session-a', [
      { seq: 0, time: acceptedAt + 10, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: acceptedAt + 20, type: 'step/start', data: { turn: 1, step: 1 } },
      { seq: 2, time: acceptedAt + 60, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'x' } } },
      { seq: 3, time: acceptedAt + 70, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } },
      { seq: 4, time: acceptedAt + 75, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-2', name: 'grep', arguments: '{}' } },
      { seq: 5, time: acceptedAt + 100, type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' }, content: [] } } },
      { seq: 6, time: acceptedAt + 110, type: 'tool/result', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-2' }, content: [] } } },
      { seq: 7, time: acceptedAt + 120, type: 'step/end', data: { turn: 1, step: 1 } },
      { seq: 8, time: acceptedAt + 125, type: 'step/start', data: { turn: 1, step: 2 } },
      { seq: 9, time: acceptedAt + 150, type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'done' } } },
      { seq: 10, time: acceptedAt + 160, type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [] } } },
      { seq: 11, time: acceptedAt + 170, type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } },
    ])
    const done = await controller.status(50, started.operation_id)
    assert.equal(done.state, 'completed')
    assert.equal(done.metrics.model_rounds, 2)
    assert.equal(done.metrics.model_wait_ms, 65)
    assert.equal(done.metrics.tool_calls, 2)
    assert.equal(done.metrics.tool_results, 2)
    assert.equal(done.metrics.tool_result_latency_ms, 65)
    assert.equal(done.metrics.max_tool_calls_in_flight_observed, 2)
    assert.equal(done.metrics.time_to_first_model_ms, 20)
    assert.equal(done.metrics.time_to_first_tool_ms, 70)
    assert.equal(done.metrics.total_wall_ms, 170)
    assert.equal(done.metrics.last_event_seq, 11)
    assert.equal(done.metrics.complete, true)
    assert.equal(done.metrics.gap_after_seq, null)
  } finally {
    await controller.dispose()
  }
})

test('operation metrics recover a cursor that falls behind the latest 100-event history window', async () => {
  const { controller, histories } = fixture(3, {
    executionMode: 'autonomous',
    autonomousProvider: 'native-openai',
    autonomousModel: 'gpt-native-test',
  })
  try {
    const started = await controller.start('long benchmark', undefined, 'session-a')
    const acceptedAt = controller.operationGet(started.operation_id).accepted_at
    const events = [{ seq: 0, time: acceptedAt + 1, type: 'turn/start', data: { turn: 1 } }]
    let seq = 1
    for (let step = 1; step <= 55; step++) {
      events.push({ seq: seq++, time: acceptedAt + seq, type: 'step/start', data: { turn: 1, step } })
      events.push({ seq: seq++, time: acceptedAt + seq, type: 'assistant/chunk', data: { turn: 1, step, chunk: { type: 'text-delta', text: 'x' } } })
      const callId = `call-${step}`
      events.push({ seq: seq++, time: acceptedAt + seq, type: 'tool/call', data: { turn: 1, step, callId, name: 'read', arguments: '{}' } })
      events.push({ seq: seq++, time: acceptedAt + seq, type: 'tool/result', data: { turn: 1, step, message: { source: { kind: 'tool', callId }, content: [] } } })
      events.push({ seq: seq++, time: acceptedAt + seq, type: 'step/end', data: { turn: 1, step } })
    }
    events.push({ seq: seq++, time: acceptedAt + seq, type: 'assistant/message', data: { turn: 1, step: 55, message: { role: 'assistant', content: [] } } })
    events.push({ seq: seq++, time: acceptedAt + seq, type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
    histories.set('session-a', events)

    const done = await controller.status(100, started.operation_id)
    assert.equal(done.state, 'completed')
    assert.equal(done.metrics.complete, true)
    assert.equal(done.metrics.gap_after_seq, null)
    assert.equal(done.metrics.model_rounds, 55)
    assert.equal(done.metrics.tool_calls, 55)
    assert.equal(done.metrics.tool_results, 55)
    assert.equal(done.metrics.last_event_seq, events.at(-1).seq)
  } finally {
    await controller.dispose()
  }
})

test('broker tags pending model requests with the owning concurrent operation', async () => {
  const { broker, controller } = fixture(3)
  try {
    const [first, second] = await Promise.all([
      controller.start('one', undefined, 'session-a'),
      controller.start('two', undefined, 'session-b'),
    ])
    const requestA = broker.enqueue({
      sessionId: 'session-a',
      provider: 'shiro-sol',
      model: 'gpt-5.6-sol',
      messages: [],
      tools: [],
    })
    const requestB = broker.enqueue({
      sessionId: 'session-b',
      provider: 'shiro-sol',
      model: 'gpt-5.6-sol',
      messages: [],
      tools: [],
    })
    const pending = broker.snapshot()
    assert.equal(pending.find(request => request.request_id === requestA.id).operation_id, first.operation_id)
    assert.equal(pending.find(request => request.request_id === requestB.id).operation_id, second.operation_id)
    assert.deepEqual((await controller.status(0, first.operation_id)).model_requests.map(item => item.request_id), [requestA.id])
    assert.deepEqual((await controller.status(0, second.operation_id)).model_requests.map(item => item.request_id), [requestB.id])
    broker.cancel(requestA.id)
    broker.cancel(requestB.id)
  } finally {
    await controller.dispose()
  }
})
