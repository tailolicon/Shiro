import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeBroker, BridgeController } from '../src/index.js'

// Harness turns anchored in a workspace other than the fixed project root.
//
// Engine workspaces are keyed by path and sessions inherit that path as their
// cwd, which is what every engine tool (and now shiro-git-tool /
// shiro-container-tool) resolves against. These tests pin the two things that
// makes correct: the engine is asked for the workspace the caller named, and
// sessions never leak across workspaces.

const PROJECT_ROOT = '/tmp/shiro-project'
const OTHER_ROOT = '/tmp/other-app'

function ok(value) {
  return Promise.resolve({ result: { ok: true, value } })
}

function fixture() {
  // One session per workspace, so a cross-workspace resume is observable.
  const byPath = {
    [PROJECT_ROOT]: { workspaceId: 'ws-project', title: 'Shiro', sessionIds: ['session-project'] },
    [OTHER_ROOT]: { workspaceId: 'ws-other', title: 'other-app', sessionIds: ['session-other'] },
  }
  const createdWorkspaces = []
  const createdSessions = []
  const cancellations = []
  // A pushable event channel, so an approval frame can be delivered AFTER a
  // turn exists -- which is the only way to exercise the real stamping path in
  // pumpEvents rather than writing into the interactions map by hand.
  const queue = []
  let wake = null
  let closed = false
  const emit = envelope => { queue.push(envelope); wake?.(); wake = null }
  const ctx = {
    apiProxy: {
      events: {
        mux(_request, signal) {
          signal?.addEventListener('abort', () => { closed = true; wake?.(); wake = null }, { once: true })
          return {
            async *[Symbol.asyncIterator]() {
              for (;;) {
                while (queue.length > 0) yield queue.shift()
                if (closed) return
                await new Promise(resolveWake => { wake = resolveWake })
              }
            },
          }
        },
      },
      workspace: {
        create(request) {
          const path = request.payload.path
          createdWorkspaces.push(path)
          const workspace = byPath[path]
          if (workspace === undefined) return Promise.resolve({ result: { ok: false, error: { message: `unknown workspace ${path}` } } })
          return ok({ workspace: { ...workspace, path } })
        },
      },
      sessions: {
        list: () => ok({ items: Object.values(byPath).flatMap(entry => entry.sessionIds.map(sessionId => ({ sessionId }))) }),
        create(request) {
          createdSessions.push(request.payload.workspaceId)
          return ok({ sessionId: `session-new-${createdSessions.length}` })
        },
        selectModel: () => ok({}),
        history: () => ok({ events: [] }),
        prompt: () => ok({}),
        cancel(request) {
          cancellations.push(request.payload.sessionId)
          return ok({})
        },
      },
      respond: () => ok({}),
    },
    get: () => undefined,
  }
  const controller = new BridgeController(ctx, new BridgeBroker(), {
    provider: 'shiro-sol',
    model: 'gpt-5.6-sol',
    waitMs: 0,
    maxConcurrentTurns: 4,
    sessionStatePath: ':memory:',
    workspaceRoot: PROJECT_ROOT,
  })
  return { controller, createdWorkspaces, createdSessions, cancellations, emit }
}

const PRIMARY = { id: 'project', root: PROJECT_ROOT }

/** Wait for the background event pump to record the interaction. */
async function settle(predicate, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolveTick => setTimeout(resolveTick, 5))
  }
  throw new Error('condition never became true')
}

async function rejectsNotFound(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'NOT_FOUND', `expected NOT_FOUND, got ${error.code}: ${error.message}`)
    // The message must not confirm the id exists somewhere else.
    assert.doesNotMatch(error.message, /other-app|belongs to|exists in/)
    return true
  })
}

const OTHER = { id: 'other-app', root: OTHER_ROOT }

test('omitting the workspace keeps every turn in the fixed project root', async () => {
  const { controller, createdWorkspaces, createdSessions } = fixture()
  try {
    const outcome = await controller.start('do a thing')
    assert.deepEqual(createdWorkspaces, [PROJECT_ROOT])
    assert.deepEqual(createdSessions, ['ws-project'])
    assert.equal(outcome.workspace, 'project')
  } finally {
    await controller.dispose()
  }
})

test('a named workspace anchors the engine session in that root', async () => {
  const { controller, createdWorkspaces, createdSessions } = fixture()
  try {
    const outcome = await controller.start('build the other app', undefined, undefined, 'balanced', undefined, {}, OTHER)
    // The engine is asked for the workspace of the directory the caller named,
    // and the session is created inside it -- that is what gives the session
    // the cwd every tool then resolves against.
    assert.deepEqual(createdWorkspaces, [OTHER_ROOT])
    assert.deepEqual(createdSessions, ['ws-other'])
    assert.equal(outcome.workspace, 'other-app')

    // Scoped by default: the default listing is the project root, so a turn in
    // another workspace must not appear in it.
    assert.deepEqual(controller.operationList({}).operations, [])
    const listed = controller.operationList({ workspace: OTHER })
    assert.equal(listed.workspace, 'other-app')
    assert.equal(listed.operations[0].workspace, 'other-app')
  } finally {
    await controller.dispose()
  }
})

test('two workspaces run concurrently without sharing sessions', async () => {
  const { controller, createdWorkspaces } = fixture()
  try {
    const [here, there] = await Promise.all([
      controller.start('task in Shiro'),
      controller.start('task in other-app', undefined, undefined, 'balanced', undefined, {}, OTHER),
    ])
    assert.equal(here.workspace, 'project')
    assert.equal(there.workspace, 'other-app')
    assert.notEqual(here.session_id, there.session_id)
    assert.deepEqual([...createdWorkspaces].sort(), [OTHER_ROOT, PROJECT_ROOT])
  } finally {
    await controller.dispose()
  }
})

test('sessions are namespaced per workspace', async () => {
  const { controller } = fixture()
  try {
    const here = await controller.sessions()
    assert.equal(here.workspace, 'project')
    assert.equal(here.workspace_root, PROJECT_ROOT)
    assert.equal(here.workspace_id, 'ws-project')
    assert.deepEqual(here.sessions.map(entry => entry.sessionId), ['session-project'])

    const there = await controller.sessions(OTHER)
    assert.equal(there.workspace, 'other-app')
    assert.equal(there.workspace_id, 'ws-other')
    assert.deepEqual(there.sessions.map(entry => entry.sessionId), ['session-other'])
  } finally {
    await controller.dispose()
  }
})

test('a session cannot be resumed from the wrong workspace', async () => {
  const { controller } = fixture()
  try {
    // A session id from another workspace must not run against this tree, and
    // the error has to name the workspace it was looked up in.
    await assert.rejects(
      controller.start('continue elsewhere', undefined, 'session-other'),
      error => {
        assert.match(error.message, /not registered under bridge workspace project/)
        return true
      },
    )

    // Resuming it in its own workspace is the same call and works.
    const resumed = await controller.start('continue', undefined, 'session-other', 'balanced', undefined, {}, OTHER)
    assert.equal(resumed.session_id, 'session-other')
    assert.equal(resumed.workspace, 'other-app')
  } finally {
    await controller.dispose()
  }
})

test('session reads are scoped to the workspace that owns them', async () => {
  const { controller } = fixture()
  try {
    const got = await controller.sessionGet('session-other', OTHER)
    assert.equal(got.workspace, 'other-app')
    assert.equal(got.session.sessionId, 'session-other')

    await assert.rejects(controller.sessionGet('session-other'), error => {
      assert.equal(error.code, 'NOT_FOUND')
      return true
    })
    await assert.rejects(controller.sessionLog('session-project', 10, OTHER), /not registered under bridge workspace other-app/)
  } finally {
    await controller.dispose()
  }
})

// ---------------------------------------------------------------------------
// Control-plane isolation. Every id the client holds is opaque, so each one
// records the workspace it was created in and the gate compares that recorded
// value before the engine is touched. These tests drive each crossing.
// ---------------------------------------------------------------------------

test('a pending model request records its workspace when it is created', async () => {
  const { controller } = fixture()
  try {
    const started = await controller.start('work', undefined, undefined, 'balanced', undefined, {}, OTHER)
    const pending = controller.broker.enqueue({
      sessionId: started.session_id,
      provider: 'shiro-sol',
      model: 'gpt-5.6-sol',
      messages: [],
    })
    // Stamped at enqueue, not derived later from the session.
    const request = controller.broker.request(pending.id)
    assert.equal(request.workspace, 'other-app')
    assert.equal(request.operation_id, started.operation_id)
  } finally {
    await controller.dispose()
  }
})

test('harness_continue cannot answer a request from another workspace', async () => {
  const { controller } = fixture()
  try {
    const started = await controller.start('work', undefined, undefined, 'balanced', undefined, {}, OTHER)
    const pending = controller.broker.enqueue({ sessionId: started.session_id, provider: 'shiro-sol', model: 'gpt-5.6-sol', messages: [] })

    await rejectsNotFound(controller.submit(pending.id, { blocks: [] }, 0, {}, PRIMARY))
    // The request must still be pending: a refused submit may not consume it.
    assert.notEqual(controller.broker.request(pending.id), undefined)

    // The same call from its own workspace is accepted.
    await controller.submit(pending.id, { blocks: [] }, 0, {}, OTHER)
    assert.equal(controller.broker.request(pending.id), undefined)
  } finally {
    await controller.dispose()
  }
})

test('harness_get_request will not hand over another workspace request body', async () => {
  const { controller } = fixture()
  try {
    const started = await controller.start('work', undefined, undefined, 'balanced', undefined, {}, OTHER)
    const pending = controller.broker.enqueue({
      sessionId: started.session_id,
      provider: 'shiro-sol',
      model: 'gpt-5.6-sol',
      system: 'secret system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'private' }] }],
    })
    assert.throws(() => controller.pendingRequest(pending.id, PRIMARY), error => error.code === 'NOT_FOUND')
    assert.equal(controller.pendingRequest(pending.id, OTHER).system, 'secret system prompt')
  } finally {
    await controller.dispose()
  }
})

test('an interaction records its workspace and cannot be answered from another', async () => {
  const { controller, emit } = fixture()
  try {
    const started = await controller.start('work', undefined, undefined, 'balanced', undefined, {}, OTHER)
    emit({
      rpcId: 'interaction-1',
      payload: { type: 'approval/requested', sessionId: started.session_id, approvalId: 'approval-1' },
    })
    await settle(() => controller.interactions.size > 0)

    // Stamped when the engine asked, from the operation that owns the session.
    assert.equal(controller.interactions.get('interaction-1').workspace, 'other-app')

    // An approval is what authorizes a destructive step: it never crosses.
    await rejectsNotFound(controller.respond('interaction-1', 'allowed-once', undefined, 0, {}, PRIMARY))
    assert.ok(controller.interactions.has('interaction-1'), 'a refused approval must not consume the interaction')
  } finally {
    await controller.dispose()
  }
})

test('harness_status will not report the state of another workspace turn', async () => {
  const { controller } = fixture()
  try {
    const started = await controller.start('work', undefined, undefined, 'balanced', undefined, {}, OTHER)
    await rejectsNotFound(controller.status(0, started.operation_id, undefined, {}, PRIMARY))
    await rejectsNotFound(controller.status(0, undefined, started.session_id, {}, PRIMARY))

    const own = await controller.status(0, started.operation_id, undefined, {}, OTHER)
    assert.equal(own.operation_id, started.operation_id)
  } finally {
    await controller.dispose()
  }
})

test('an unscoped status in one workspace never shows another workspace work', async () => {
  const { controller } = fixture()
  try {
    const started = await controller.start('work', undefined, undefined, 'balanced', undefined, {}, OTHER)
    controller.broker.enqueue({ sessionId: started.session_id, provider: 'shiro-sol', model: 'gpt-5.6-sol', messages: [] })

    // The project root has no turns, so the honest answer is idle -- and it
    // must not leak the other workspace's pending request into model_requests.
    const idle = await controller.status(0, undefined, undefined, {}, PRIMARY)
    assert.equal(idle.status, 'idle')
    assert.equal(idle.workspace, 'project')
    assert.deepEqual(idle.model_requests, [])

    // ...while the workspace that owns the request does see it (a non-zero wait
    // lets the outcome loop run once).
    const there = await controller.status(50, undefined, undefined, {}, OTHER)
    assert.equal(there.status, 'model_input_required')
    assert.equal(there.model_requests.length, 1)
  } finally {
    await controller.dispose()
  }
})

test('harness_cancel cannot stop a turn in another workspace', async () => {
  const { controller, cancellations } = fixture()
  try {
    const started = await controller.start('long task', undefined, undefined, 'balanced', undefined, {}, OTHER)

    await rejectsNotFound(controller.cancel(started.operation_id, undefined, PRIMARY))
    await rejectsNotFound(controller.cancel(undefined, started.session_id, PRIMARY))
    // Nothing reached the engine and the turn is untouched.
    assert.deepEqual(cancellations, [])
    assert.equal(controller.operationGet(started.operation_id, OTHER).status, 'running')

    // Cancelling from its own workspace works.
    const cancelled = await controller.cancel(started.operation_id, undefined, OTHER)
    assert.equal(cancelled.cancelled, true)
    assert.deepEqual(cancellations, [started.session_id])
  } finally {
    await controller.dispose()
  }
})

test('an unscoped cancel in one workspace cannot reach a turn in another', async () => {
  const { controller, cancellations } = fixture()
  try {
    await controller.start('long task', undefined, undefined, 'balanced', undefined, {}, OTHER)
    // One turn is active, but not in this workspace: the implicit "cancel the
    // only running turn" fallback must not reach across.
    const outcome = await controller.cancel(undefined, undefined, PRIMARY)
    assert.equal(outcome.cancelled, false)
    assert.deepEqual(cancellations, [])
  } finally {
    await controller.dispose()
  }
})

test('operation reads are scoped, and scoped by default', async () => {
  const { controller } = fixture()
  try {
    const here = await controller.start('in Shiro')
    const there = await controller.start('in other-app', undefined, undefined, 'balanced', undefined, {}, OTHER)

    await assert.rejects(async () => controller.operationGet(there.operation_id, PRIMARY), error => error.code === 'NOT_FOUND')
    assert.equal(controller.operationGet(there.operation_id, OTHER).operation_id, there.operation_id)

    const listed = controller.operationList({})
    assert.deepEqual(listed.operations.map(entry => entry.operation_id), [here.operation_id])
    assert.equal(listed.workspace, 'project')
    assert.equal(listed.active, 1, 'the active count is the workspace count, not the bridge total')

    const scoped = controller.operationList({ workspace: OTHER })
    assert.deepEqual(scoped.operations.map(entry => entry.operation_id), [there.operation_id])

    // bridge_status asks for the bridge-wide count on purpose: a number, not state.
    assert.equal(controller.operationList({ all_workspaces: true }).total, 2)
  } finally {
    await controller.dispose()
  }
})
