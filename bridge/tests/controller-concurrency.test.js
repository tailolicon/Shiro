import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeBroker, BridgeController } from '../src/index.js'

function ok(value) {
  return Promise.resolve({ result: { ok: true, value } })
}

function fixture(maxConcurrentTurns = 3) {
  const sessionIds = ['session-a', 'session-b', 'session-c', 'session-d']
  const prompts = []
  const cancellations = []
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
        create: () => ok({ sessionId: `session-new-${sessionIds.length}` }),
        selectModel: () => ok({}),
        history: () => ok({ events: [] }),
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
    workspaceRoot: '/tmp/shiro-test',
  })
  return { broker, controller, prompts, cancellations }
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
