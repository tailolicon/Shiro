import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionKernel } from '../src/session-kernel.js'
import { recoveryHistory } from '../src/session-recovery.js'
import { BridgeBroker, BridgeController } from '../src/index.js'

const claim = { session_id: 'session-a', runtime_mode: 'web-harness', loop_owner: 'harness', workspace_id: 'project', workspace_root: '/tmp/project-a' }
const operation = { id: 'operation-a', rootSessionId: 'session-a', workspace: 'project', workspaceRoot: '/tmp/project-a', workspaceId: 'engine-workspace', status: 'running', afterSeq: -1, startedAt: 1, reasoningEffort: 'high' }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shiro-kernel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'runtime', 'sessions.sqlite')
}
function seed(path) {
  const kernel = new SessionKernel({ path })
  kernel.claim(claim)
  kernel.saveOperation(operation)
  return kernel
}
function controller(path, events = [], ids = ['session-a'], config = {}) {
  const ok = value => Promise.resolve({ result: { ok: true, value } })
  const prompts = []
  const cancellations = []
  const ctx = { get() {}, apiProxy: {
    events: { mux: () => ({ async *[Symbol.asyncIterator]() {} }) },
    workspace: { create: () => ok({ workspace: { workspaceId: 'engine-workspace', sessionIds: ids } }) },
    sessions: { history: () => ok({ events: events.map(event => ({ event })), hasMore: false }), selectModel: () => ok({}),
      prompt: request => { prompts.push(request); return ok({}) }, cancel: request => { cancellations.push(request.payload.sessionId); return ok({}) }, create: () => ok({ sessionId: 'session-a' }) },
  } }
  return { controller: new BridgeController(ctx, new BridgeBroker(), { workspaceRoot: claim.workspace_root, sessionStatePath: path, waitMs: 0, model: 'gpt-5.6-sol', provider: 'shiro-sol', ...config }), prompts, cancellations, ctx }
}

test('SQLite round trip preserves schema, ownership, model distinction, binding and checkpoints', t => {
  const path = fixture(t)
  let kernel = seed(path)
  kernel.updateSession('session-a', { requested_model: 'Astra', requested_effort: 'high', codex_thread_id: 'metadata-only' })
  kernel.bindBrowser('session-a', 'project', claim.workspace_root, { client_id: 'client-2', tab_id: 42 })
  assert.equal(kernel.session('session-a', 'project', claim.workspace_root).verified_model, null)
  assert.throws(() => kernel.bindBrowser('session-a', 'project', claim.workspace_root, {}, { model: 'Astra' }), /evidence/)
  kernel.bindBrowser('session-a', 'project', claim.workspace_root, { client_id: 'client-2', tab_id: 42 }, { model: 'Observed model', effort: 'standard', evidence: 'observed picker label' })
  kernel.close()
  kernel = new SessionKernel({ path })
  t.after(() => kernel.close())
  const row = kernel.session('session-a', 'project', claim.workspace_root)
  assert.equal(row.requested_model, 'Astra')
  assert.equal(row.verified_model, 'Observed model')
  assert.equal(row.requested_effort, 'high')
  assert.equal(row.verified_effort, 'standard')
  assert.equal(row.browser_binding.tab_id, 42)
  assert.equal(row.operations[0].state, 'running')
  assert.deepEqual(row.checkpoint, { operation_id: 'operation-a', after_seq: -1 })
  assert.equal(kernel.db.prepare('PRAGMA user_version').get().user_version, 2)
})

test('ownership and active-operation conflicts fail across SQLite connections; workspace ids and roots are isolated', t => {
  const path = fixture(t)
  const a = seed(path), b = new SessionKernel({ path })
  t.after(() => { a.close(); b.close() })
  assert.throws(() => b.claim({ ...claim, runtime_mode: 'codex-native', loop_owner: 'codex' }), { code: 'CONFLICT' })
  assert.throws(() => b.claim({ ...claim, workspace_root: '/tmp/project-b' }), { code: 'NOT_FOUND' })
  assert.equal(b.session('session-a', 'another', claim.workspace_root).workspace_root, claim.workspace_root)
  assert.throws(() => b.session('session-a', 'project', '/tmp/project-b'), { code: 'NOT_FOUND' })
  assert.throws(() => b.claim({ ...claim, session_id: 'bad', runtime_mode: 'web-harness', loop_owner: 'codex' }), /CHECK/)
  assert.throws(() => b.saveOperation({ ...operation, id: 'second' }), { code: 'FENCED' })
  assert.equal(a.session('session-a', 'project', claim.workspace_root).operations.length, 1)
})

test('database cannot be inside a workspace, including through a symlink; future schemas are left untouched', t => {
  const path = fixture(t), root = join(path, '..', 'workspace')
  mkdirSync(root, { recursive: true })
  const alias = join(root, '..', 'alias')
  symlinkSync(root, alias)
  assert.throws(() => new SessionKernel({ path: join(alias, 'state.sqlite'), workspaceRoot: root }), /outside/)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version=99'); db.close()
  assert.throws(() => new SessionKernel({ path }), /unsupported/)
  const check = new DatabaseSync(path)
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99); check.close()
})

test('started effects become uncertain on recovery and can never be automatically retried', async t => {
  const path = fixture(t)
  let kernel = seed(path)
  const effect = { effect_id: 'effect-a', session_id: 'session-a', operation_id: 'operation-a', name: 'write', arguments: { path: 'a' } }
  kernel.planEffect(effect); kernel.transitionEffect(effect.effect_id, 'started'); kernel.close()
  kernel = new SessionKernel({ path }); t.after(() => kernel.close())
  kernel.acquireSession('session-a')
  kernel.recoverEffects(operation.id)
  assert.equal(kernel.session('session-a', 'project', claim.workspace_root).effects[0].state, 'uncertain')
  assert.throws(() => kernel.transitionEffect(effect.effect_id, 'started'), /cannot be retried/)
  let calls = 0
  await assert.rejects(kernel.runEffect(effect, () => { calls++; return {} }))
  assert.equal(calls, 0)
})

test('restart hydrates ambiguous running operations as interrupted, without resurrecting model requests or dispatching prompts', async t => {
  const path = fixture(t); seed(path).close()
  const { controller: bridge, prompts } = controller(path)
  t.after(() => bridge.dispose())
  await bridge.ready
  const status = await bridge.runtimeStatus('session-a')
  assert.equal(status.recovery_state, 'interrupted-unverified')
  assert.equal((await bridge.status(0)).status, 'interrupted')
  assert.equal(bridge.broker.snapshot().length, 0)
  await assert.rejects(bridge.start('resume', undefined, 'session-a'), /ambiguous/)
  assert.equal(prompts.length, 0)
})

test('restart reconciles a proven terminal turn, but not history from another workspace', async t => {
  const path = fixture(t); const kernel = seed(path)
  await kernel.runEffect({ effect_id: 'dispatch', session_id: 'session-a', operation_id: 'operation-a', name: 'harness.prompt', arguments: {} }, async () => ({ accepted: true }))
  kernel.close()
  const { controller: bridge } = controller(path, [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }])
  t.after(() => bridge.dispose()); await bridge.ready
  assert.equal((await bridge.runtimeStatus('session-a')).recovery_state, 'reconciled-terminal')
  await assert.rejects(bridge.runtimeStatus('session-a', { id: 'project', root: '/tmp/project-b' }), { code: 'NOT_FOUND' })
})

test('start and cancel persist ownership, requested model and dispatch receipt', async t => {
  const { controller: bridge } = controller(fixture(t))
  t.after(() => bridge.dispose())
  const started = await bridge.start('task', undefined, 'session-a', 'deep', 'high')
  let row = await bridge.runtimeStatus('session-a')
  assert.equal(row.loop_owner, 'harness'); assert.equal(row.runtime_mode, 'web-harness')
  assert.equal(row.requested_model, 'gpt-5.6-sol-deep'); assert.equal(row.verified_model, null)
  assert.equal(row.effects[0].state, 'succeeded')
  await bridge.cancel(started.operation_id)
  row = await bridge.runtimeStatus('session-a')
  assert.equal(row.operations[0].state, 'cancelled')
})

test('corrupt database keeps control-plane status available but fails new execution closed', async t => {
  const path = fixture(t); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'not sqlite')
  const { controller: bridge, prompts } = controller(path)
  t.after(() => bridge.dispose())
  assert.equal((await bridge.runtimeStatus('session-a')).recovery_state, 'storage-unavailable')
  await assert.rejects(bridge.start('task'), /unavailable/)
  assert.equal(prompts.length, 0)
})

test('unreceipted terminal history cannot fabricate recovered completion', async t => {
  const path = fixture(t); seed(path).close()
  const { controller: bridge } = controller(path, [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }])
  t.after(() => bridge.dispose())
  assert.equal((await bridge.runtimeStatus('session-a')).recovery_state, 'interrupted-unverified')
})

test('recovery marks a dispatched effect uncertain, leaving planned and terminal receipts unchanged', async t => {
  const path = fixture(t), kernel = seed(path)
  for (const [id, state] of [['started', 'started'], ['planned', 'planned'], ['succeeded', 'succeeded'], ['failed', 'failed']]) {
    kernel.planEffect({ effect_id: id, session_id: 'session-a', operation_id: operation.id, name: 'effect', arguments: {} })
    if (state !== 'planned') kernel.transitionEffect(id, 'started')
    if (['succeeded','failed'].includes(state)) kernel.transitionEffect(id, state, { known: state })
  }
  kernel.close()
  const { controller: bridge } = controller(path); t.after(() => bridge.dispose())
  const row = await bridge.runtimeStatus('session-a')
  assert.deepEqual(Object.fromEntries(row.effects.map(effect => [effect.effect_id, effect.state])), { started: 'uncertain', planned: 'planned', succeeded: 'succeeded', failed: 'failed' })
})

test('secondary workspace operations hydrate lazily without leaking into primary operation lists', async t => {
  const path = fixture(t), kernel = new SessionKernel({ path })
  kernel.claim({ ...claim, workspace_id: 'secondary', workspace_root: '/tmp/secondary' })
  kernel.saveOperation({ ...operation, workspace: 'secondary', workspaceRoot: '/tmp/secondary' }); kernel.close()
  const { controller: bridge } = controller(path); t.after(() => bridge.dispose()); await bridge.ready
  assert.equal(bridge.operationList().total, 0)
  const row = await bridge.runtimeStatus('session-a', { id: 'secondary', root: '/tmp/secondary' })
  assert.equal(row.operations[0].state, 'interrupted')
  assert.equal(bridge.operationList().total, 0)
  assert.equal(bridge.operationList({ workspace: { id: 'secondary' } }).total, 1)
})

test('live completion persists terminal transition and event checkpoint', async t => {
  const events = [], { controller: bridge } = controller(fixture(t), events)
  t.after(() => bridge.dispose())
  await bridge.start('task', undefined, 'session-a')
  events.push({ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal((await bridge.status(100)).status, 'completed')
  const row = await bridge.runtimeStatus('session-a')
  assert.equal(row.last_event_seq, 1)
  assert.equal(row.operations[0].state, 'completed')
  assert.equal((await bridge.status(0)).completion.event.seq, 1)
})

test('dispatch exceptions persist failed operation and uncertain receipt, block replay, and remain explicitly cancellable', async t => {
  const { controller: bridge, ctx, cancellations } = controller(fixture(t))
  t.after(() => bridge.dispose())
  let calls = 0
  ctx.apiProxy.sessions.prompt = async () => { calls++; throw new Error('connection lost after sending') }
  await assert.rejects(bridge.start('task', undefined, 'session-a'), /connection lost/)
  let row = await bridge.runtimeStatus('session-a')
  assert.equal(row.operations[0].state, 'failed')
  assert.equal(row.effects[0].state, 'uncertain')
  await assert.rejects(bridge.start('task again', undefined, 'session-a'), /ambiguous/)
  assert.equal(calls, 1)
  const cancelled = await bridge.cancel(row.operations[0].operation_id)
  assert.equal(cancelled.cancelled, true)
  assert.deepEqual(cancellations, ['session-a'])
  row = await bridge.runtimeStatus('session-a')
  assert.equal(row.recovery_state, 'cancellation-accepted-effects-unverified')
  assert.equal(row.operations[0].state, 'cancelled')
})

test('a different loop owner is refused before engine model selection or dispatch', async t => {
  const path = fixture(t), kernel = new SessionKernel({ path })
  kernel.claim({ ...claim, runtime_mode: 'codex-native', loop_owner: 'codex' }); kernel.close()
  const { controller: bridge, ctx, prompts } = controller(path); t.after(() => bridge.dispose())
  let selections = 0
  ctx.apiProxy.sessions.selectModel = async () => { selections++; throw new Error('must not select') }
  await assert.rejects(bridge.start('task', undefined, 'session-a'), { code: 'CONFLICT' })
  assert.equal(selections, 0); assert.equal(prompts.length, 0)
})


test('lease fencing protects a live executor and rejects stale writes after takeover', t => {
  const path = fixture(t)
  let now = 1_000
  const clock = () => now
  const a = new SessionKernel({ path, now: clock, leaseMs: 100, executorId: 'executor-a' })
  const b = new SessionKernel({ path, now: clock, leaseMs: 100, executorId: 'executor-b' })
  t.after(() => { try { a.close() } catch {}; try { b.close() } catch {} })
  a.claim(claim)
  a.saveOperation(operation)
  a.planEffect({ effect_id: 'in-flight', session_id: 'session-a', operation_id: operation.id, name: 'harness.prompt', arguments: {} })
  a.transitionEffect('in-flight', 'started')

  assert.throws(() => b.acquireSession('session-a'), /live executor lease/)
  let row = b.session('session-a', 'ignored-alias', claim.workspace_root)
  assert.equal(row.operations[0].state, 'running')
  assert.equal(row.effects[0].state, 'started')

  now = 1_101
  b.acquireSession('session-a')
  b.recoverEffects(operation.id)
  b.saveOperation({ ...operation, status: 'interrupted', recoveryState: 'interrupted-unverified' })
  assert.throws(() => a.saveOperation({ ...operation, status: 'completed' }), { code: 'FENCED' })
  assert.throws(() => a.transitionEffect('in-flight', 'succeeded', { accepted: true }), { code: 'FENCED' })
  row = b.session('session-a', 'another-alias', claim.workspace_root)
  assert.equal(row.operations[0].state, 'interrupted')
  assert.equal(row.effects[0].state, 'uncertain')
})

test('a second controller leaves a live owner intact, then recovers only after lease expiry', async t => {
  const path = fixture(t)
  let now = 10_000
  const clock = () => now
  const owner = new SessionKernel({ path, now: clock, leaseMs: 100, executorId: 'owner' })
  owner.claim(claim)
  owner.saveOperation(operation)
  owner.planEffect({ effect_id: 'live-dispatch', session_id: 'session-a', operation_id: operation.id, name: 'harness.prompt', arguments: {} })
  owner.transitionEffect('live-dispatch', 'started')
  const observer = new SessionKernel({ path, now: clock, leaseMs: 100, executorId: 'observer' })
  const { controller: first } = controller(path, [], ['session-a'], { sessionKernel: owner, sessionHeartbeat: false })
  const { controller: second } = controller(path, [], ['session-a'], { sessionKernel: observer, sessionHeartbeat: false })
  t.after(async () => {
    await first.dispose().catch(() => {})
    await second.dispose().catch(() => {})
    try { owner.close() } catch {}
    try { observer.close() } catch {}
  })
  await Promise.all([first.ready, second.ready])
  let row = observer.session('session-a', 'any-alias', claim.workspace_root)
  assert.equal(row.operations[0].state, 'running')
  assert.equal(row.effects[0].state, 'started')
  assert.equal(second.operationList().operations[0].status, 'running')

  now = 10_101
  await second.runtimeStatus('session-a')
  row = observer.session('session-a', 'any-alias', claim.workspace_root)
  assert.equal(row.operations[0].state, 'interrupted')
  assert.equal(row.effects[0].state, 'uncertain')
  assert.throws(() => owner.saveOperation({ ...operation, status: 'completed' }), { code: 'FENCED' })
})

test('recovery history proves the baseline across pages and refuses truncation or gaps', async () => {
  const pages = new Map([
    ['tail', { events: [{ event: { seq: 2 } }, { event: { seq: 3 } }], hasMore: true }],
    [2, { events: [{ event: { seq: 0 } }, { event: { seq: 1 } }], hasMore: false }],
  ])
  const complete = await recoveryHistory(before => pages.get(before ?? 'tail'), 0)
  assert.deepEqual(complete.events.map(entry => entry.event.seq), [0, 1, 2, 3])

  assert.equal(await recoveryHistory(async () => ({ events: [{ event: { seq: 200 } }, { event: { seq: 201 } }], hasMore: false }), -1), null)
  assert.equal(await recoveryHistory(async before => before === undefined
    ? { events: [{ event: { seq: 4 } }, { event: { seq: 5 } }], hasMore: true }
    : { events: [{ event: { seq: 0 } }, { event: { seq: 2 } }], hasMore: false }, 0), null)
  assert.equal(await recoveryHistory(async () => ({ events: [{ event: { seq: 0 } }], hasMore: false, truncated: true }), -1), null)
})

test('recovery never reconciles an auto-continued history with multiple starts', async t => {
  const path = fixture(t)
  const kernel = seed(path)
  await kernel.runEffect({ effect_id: 'dispatch-auto', session_id: 'session-a', operation_id: operation.id, name: 'harness.prompt', arguments: {} }, async () => ({ accepted: true }))
  kernel.close()
  const events = [
    { seq: 0, type: 'turn/start' },
    { seq: 1, type: 'turn/end', data: { reason: { kind: 'max-tokens' } } },
    { seq: 2, type: 'turn/start' },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const { controller: bridge } = controller(path, events)
  t.after(() => bridge.dispose())
  await bridge.ready
  assert.equal((await bridge.runtimeStatus('session-a')).recovery_state, 'interrupted-unverified')
  assert.equal((await bridge.status(0)).status, 'interrupted')
})

test('durable workspace identity remaps to the current alias without leaking into a new primary root', async t => {
  const path = fixture(t)
  seed(path).close()
  const { controller: bridge } = controller(path, [], ['session-a'], { workspaceRoot: '/tmp/project-b' })
  t.after(() => bridge.dispose())
  await bridge.ready
  assert.equal(bridge.operationList().total, 0)

  const first = await bridge.runtimeStatus('session-a', { id: 'renamed-a', root: claim.workspace_root })
  assert.equal(first.operations[0].state, 'interrupted')
  assert.equal(bridge.operationList().total, 0)
  assert.equal(bridge.operationList({ workspace: { id: 'renamed-a', root: claim.workspace_root } }).total, 1)
  assert.throws(() => bridge.operationGet(operation.id, { id: 'project', root: '/tmp/project-b' }), { code: 'NOT_FOUND' })

  await bridge.runtimeStatus('session-a', { id: 'a-after-reorder', root: claim.workspace_root })
  assert.equal(bridge.operationList({ workspace: { id: 'renamed-a', root: claim.workspace_root } }).total, 0)
  assert.equal(bridge.operationList({ workspace: { id: 'a-after-reorder', root: claim.workspace_root } }).total, 1)
})

test('recovered interrupted cancellation is durable, workspace-scoped and idempotent', async t => {
  const path = fixture(t)
  seed(path).close()
  const { controller: bridge, cancellations } = controller(path)
  t.after(() => bridge.dispose())
  await bridge.ready
  assert.equal((await bridge.status(0)).status, 'interrupted')

  await assert.rejects(bridge.cancel(operation.id, undefined, { id: 'wrong', root: '/tmp/project-b' }), { code: 'NOT_FOUND' })
  assert.deepEqual(cancellations, [])
  const first = await bridge.cancel(operation.id, undefined, { id: 'project', root: claim.workspace_root })
  assert.equal(first.cancelled, true)
  assert.deepEqual(cancellations, ['session-a'])
  const second = await bridge.cancel(operation.id, undefined, { id: 'project', root: claim.workspace_root })
  assert.equal(second.cancelled, true)
  assert.deepEqual(cancellations, ['session-a'])
  const row = await bridge.runtimeStatus('session-a')
  assert.equal(row.recovery_state, 'cancellation-accepted-effects-unverified')
  assert.equal(row.operations[0].state, 'cancelled')
  assert.equal(row.effects.find(effect => effect.effect_id === `cancel:${operation.id}`).state, 'succeeded')
})


test('schema v1 migrates transactionally to stable canonical workspace identity and fencing columns', t => {
  const path = fixture(t)
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('web-harness','codex-native','direct')),
      loop_owner TEXT NOT NULL CHECK(loop_owner IN ('harness','codex','direct')),
      workspace_id TEXT NOT NULL, workspace_root TEXT NOT NULL,
      requested_model TEXT, verified_model TEXT, requested_effort TEXT, verified_effort TEXT,
      browser_binding TEXT, codex_thread_id TEXT, last_event_seq INTEGER NOT NULL DEFAULT -1,
      checkpoint TEXT, recovery_state TEXT NOT NULL DEFAULT 'clean', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      CHECK ((runtime_mode='web-harness' AND loop_owner='harness') OR (runtime_mode='codex-native' AND loop_owner='codex') OR (runtime_mode='direct' AND loop_owner='direct'))
    );
    CREATE TRIGGER immutable_session_owner BEFORE UPDATE OF runtime_mode,loop_owner,workspace_id,workspace_root ON sessions
      WHEN NEW.runtime_mode != OLD.runtime_mode OR NEW.loop_owner != OLD.loop_owner OR NEW.workspace_id != OLD.workspace_id OR NEW.workspace_root != OLD.workspace_root
      BEGIN SELECT RAISE(ABORT, 'session ownership is immutable'); END;
    CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id),
      state TEXT NOT NULL CHECK(state IN ('running','completed','cancelled','failed','interrupted')),
      after_seq INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(operation_id, session_id)
    );
    CREATE UNIQUE INDEX one_running_operation ON operations(session_id) WHERE state='running';
    CREATE TABLE effects (
      effect_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id),
      operation_id TEXT NOT NULL REFERENCES operations(operation_id), name TEXT NOT NULL, arguments TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('planned','started','succeeded','failed','uncertain')),
      receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY(operation_id, session_id) REFERENCES operations(operation_id, session_id)
    );
    INSERT INTO sessions(session_id,runtime_mode,loop_owner,workspace_id,workspace_root,created_at,updated_at)
      VALUES('legacy-session','web-harness','harness','old-process-alias','/tmp/project-a',1,1);
    PRAGMA user_version=1;
  `)
  db.close()

  const kernel = new SessionKernel({ path, executorId: 'migration-test' })
  t.after(() => kernel.close())
  const migrated = kernel.db.prepare("SELECT workspace_id,workspace_root,executor_id,lease_until,fence FROM sessions WHERE session_id='legacy-session'").get()
  assert.match(migrated.workspace_id, /^root:[0-9a-f]{64}$/)
  assert.equal(migrated.workspace_root, '/tmp/project-a')
  assert.equal(migrated.executor_id, null)
  assert.equal(migrated.lease_until, 0)
  assert.equal(migrated.fence, 0)
  assert.equal(kernel.db.prepare('PRAGMA user_version').get().user_version, 2)

  kernel.claim({ ...claim, session_id: 'legacy-session', workspace_id: 'renamed-after-restart' })
  const claimed = kernel.session('legacy-session', 'renamed-after-restart', claim.workspace_root)
  assert.equal(claimed.workspace_id, migrated.workspace_id)
  assert.equal(claimed.fence, 1)
})
