import assert from 'node:assert/strict'
import test from 'node:test'
import { ShiroWorkerControl, workerControlInternals } from '../src/worker-control.js'

function processRegistry(rows) {
  const stopped = []
  return {
    stopped,
    list: () => ({ processes: rows }),
    status: ({ process_id }) => {
      const row = rows.find(item => item.process_id === process_id)
      if (!row) throw new Error('missing process')
      return row
    },
    stop: async ({ process_id }) => {
      stopped.push(process_id)
      return { process_id, state: 'stopped' }
    },
  }
}

function terminalRegistry(rows) {
  const stopped = []
  return {
    stopped,
    list: () => ({ terminals: rows }),
    stop: async ({ terminal_id }) => {
      stopped.push(terminal_id)
      return { terminal_id, state: 'stopped' }
    },
  }
}

test('worker control merges temporary runners, CLI subagents and running browser fleets', async () => {
  const processes = processRegistry([
    {
      process_id: 'runner-1', pid: 10, state: 'running', started_at: '2026-09-13T10:00:00.000Z',
      argv: ['node', 'scripts/Run-Hachimi-Temporary-Fleet.mjs', '--fleet-size=3', '--personalized-temporary'],
      label: 'Art workers', cwd: '.',
    },
    {
      process_id: 'cli-1', pid: 11, state: 'running', started_at: '2026-09-13T09:00:00.000Z',
      argv: ['codex', 'exec'], label: 'subagent:codex', cwd: 'game',
    },
    {
      process_id: 'server-1', pid: 12, state: 'running', started_at: '2026-09-13T08:00:00.000Z',
      argv: ['npm', 'run', 'dev'], label: 'dev server', cwd: '.',
    },
  ])
  const fleetManager = {
    list: async () => ({ fleets: [
      { name: 'audit', running: true, active_workers: 2, size: 4, chat_mode: 'normal', round: 3, started_at: '2026-09-13T11:00:00.000Z' },
      { name: 'old', running: false, active_workers: 0, size: 5, chat_mode: 'normal', round: 1 },
    ] }),
  }
  const rows = await new ShiroWorkerControl({ processes, fleetManager }).snapshot()
  assert.deepEqual(rows.map(row => row.id), ['browser-fleet:audit', 'bridge-process:runner-1', 'bridge-subagent:cli-1'])
  assert.deepEqual(rows.map(row => row.workerCount), [2, 3, 1])
  assert.equal(rows[1].mode, 'browser-personalized')
  assert.equal(rows[2].provider, 'codex')
})

test('worker control stops only a verified runner process and closes its status-owned ChatGPT tabs', async () => {
  const runner = {
    process_id: 'runner-1', pid: 42, state: 'running', started_at: '2026-09-13T10:00:00.000Z',
    argv: ['node', 'scripts/Run-Hachimi-Temporary-Fleet.mjs', '--fleet-size=2', '--status-name=workers.json'],
    label: 'Workers', cwd: '.',
  }
  const processes = processRegistry([runner])
  const closed = []
  const fleetManager = {
    stateDir: '/runtime/state/fleets',
    transport: {
      clients: async () => [
        { id: 'client-a', browserTabId: 101, url: 'https://chatgpt.com/?temporary-chat=true' },
        { id: 'client-b', browserTabId: 102, url: 'https://example.com/' },
      ],
      close: async (id, url) => { closed.push({ id, url }) },
    },
  }
  const control = new ShiroWorkerControl({
    processes,
    fleetManager,
    readFileImpl: async path => {
      assert.equal(path, '/runtime/state/workers.json')
      return JSON.stringify({ pid: 42, sessions: [
        { id: 'client-a', tabId: 101 },
        { id: 'client-b', tabId: 102 },
      ] })
    },
  })
  const result = await control.stop({ kind: 'process', id: 'runner-1' })
  assert.deepEqual(processes.stopped, ['runner-1'])
  assert.deepEqual(closed, [{ id: 'client-a', url: 'https://chatgpt.com/?temporary-chat=true' }])
  assert.equal(result.tabs_closed, 1)
})

test('worker control refuses unrelated bridge-owned processes', async () => {
  const processes = processRegistry([{
    process_id: 'server-1', pid: 12, state: 'running', started_at: '2026-09-13T08:00:00.000Z',
    argv: ['npm', 'run', 'dev'], label: 'dev server', cwd: '.',
  }])
  const control = new ShiroWorkerControl({ processes })
  await assert.rejects(control.stop({ kind: 'process', id: 'server-1' }), /not a Shiro worker/)
  assert.deepEqual(processes.stopped, [])
})

test('worker control projects and stops browser-runner and labelled local-worker terminals', async () => {
  const processes = processRegistry([])
  const terminals = terminalRegistry([
    {
      terminal_id: 'browser-1', pid: 51, state: 'running', started_at: '2026-09-13T12:00:00.000Z',
      argv: ['node', 'scripts/Run-Hachimi-Temporary-Fleet.mjs', '--fleet-size=2', '--status-name=browser.json'],
      label: 'hachimi-browser-worker', workspace: 'project', cwd: '.',
    },
    {
      terminal_id: 'local-1', pid: 3, state: 'running', started_at: '2026-09-13T11:00:00.000Z',
      argv: ['python3'], label: 'w3-fastpath-write', workspace: 'translation', cwd: '.',
    },
    {
      terminal_id: 'shell-1', pid: 4, state: 'running', started_at: '2026-09-13T10:00:00.000Z',
      argv: ['bash'], label: 'dev shell', workspace: 'project', cwd: '.',
    },
  ])
  const closed = []
  const fleetManager = {
    stateDir: '/runtime/state/fleets',
    list: async () => ({ fleets: [] }),
    transport: {
      clients: async () => [{ id: 'client-a', browserTabId: 201, url: 'https://chatgpt.com/?temporary-chat=true' }],
      close: async (id, url) => { closed.push({ id, url }) },
    },
  }
  const control = new ShiroWorkerControl({
    processes,
    terminals,
    fleetManager,
    readFileImpl: async () => JSON.stringify({ pid: 51, sessions: [{ id: 'client-a', tabId: 201 }] }),
  })
  const rows = await control.snapshot()
  assert.deepEqual(rows.map(row => row.id), ['bridge-terminal:browser-1', 'bridge-terminal:local-1'])
  assert.deepEqual(rows.map(row => row.workerCount), [2, 1])

  const result = await control.stop({ kind: 'terminal', id: 'browser-1' })
  assert.deepEqual(terminals.stopped, ['browser-1'])
  assert.deepEqual(closed, [{ id: 'client-a', url: 'https://chatgpt.com/?temporary-chat=true' }])
  assert.equal(result.tabs_closed, 1)
})

test('continuation supervisors are visible and resolve their positional status file', () => {
  const process = {
    argv: ['node', 'scripts/Continue-Hachimi-After-Tab.mjs', '101', 'worker.prompt.txt', 'worker-status.json'],
    label: 'w1-safe-continuation',
  }
  assert.equal(workerControlInternals.continuationProcess(process), true)
  assert.equal(workerControlInternals.workerProcess(process), true)
  assert.equal(workerControlInternals.statusNameOf(process), 'worker-status.json')
  assert.equal(workerControlInternals.processRows([{ ...process, process_id: 'p1' }])[0].mode, 'browser-supervisor')
})

test('stopping a continuation supervisor also terminates its verified orphan runner', async () => {
  const supervisor = {
    process_id: 'supervisor-1', pid: 42, state: 'running', started_at: '2026-09-13T10:00:00.000Z',
    argv: ['node', 'scripts/Continue-Hachimi-After-Tab.mjs', '101', 'worker.prompt.txt', 'worker-status.json'],
    label: 'w1-safe-continuation', cwd: '.',
  }
  const processes = processRegistry([supervisor])
  const signals = []
  let alive = true
  const control = new ShiroWorkerControl({
    processes,
    fleetManager: {
      stateDir: '/runtime/state/fleets',
      transport: { clients: async () => [] },
    },
    readFileImpl: async () => JSON.stringify({ pid: 99, sessions: [] }),
    readProcessFileImpl: async path => {
      assert.equal(path, '/proc/99/cmdline')
      return Buffer.from('node\0scripts/Run-Hachimi-Temporary-Fleet.mjs\0--status-name=worker-status.json\0')
    },
    killImpl: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGTERM') alive = false
      if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    },
    sleepImpl: async () => {},
  })
  await control.stop({ kind: 'process', id: 'supervisor-1' })
  assert.deepEqual(processes.stopped, ['supervisor-1'])
  assert.deepEqual(signals, [[99, 'SIGTERM'], [99, 0]])
})

test('worker process classifier does not trust labels alone for temporary fleets', () => {
  assert.equal(workerControlInternals.runnerProcess({ argv: ['node', 'scripts/Run-Hachimi-Temporary-Fleet.mjs'] }), true)
  assert.equal(workerControlInternals.runnerProcess({ argv: ['node', 'other.js'], label: 'Temporary fleet' }), false)
  assert.equal(workerControlInternals.workerProcess({ argv: ['codex'], label: 'subagent:codex' }), true)
  assert.equal(workerControlInternals.workerProcess({ argv: ['python3'], label: 'w2-local-worker' }), true)
  assert.equal(workerControlInternals.processRows([{
    process_id: 'local-p', argv: ['python3'], label: 'w2-local-worker', cwd: '.',
  }])[0].mode, 'process')
  assert.equal(workerControlInternals.workerTerminal({ argv: ['python3'], label: 'w2-fastpath-write' }), true)
  assert.equal(workerControlInternals.workerTerminal({ argv: ['bash'], label: 'dev shell' }), false)
})

test('worker creation is always admitted and dashboard lock commands are compatibility no-ops', async () => {
  const control = new ShiroWorkerControl({ processes: processRegistry([]) })
  assert.equal(control.spawnLocked(), false)
  assert.doesNotThrow(() => control.assertSpawnAllowed('terminal', { argv: ['python3'], label: 'w1-fastpath' }))
  assert.doesNotThrow(() => control.assertSpawnAllowed('fleet', { name: 'allowed-by-user' }))
  assert.doesNotThrow(() => control.assertSpawnAllowed('subagent', { agent: 'codex' }))

  const unlocked = await control.stop({ kind: 'admission', id: 'unlock' })
  assert.equal(unlocked.spawn_locked, false)

  const lockAttempt = await control.stop({ kind: 'admission', id: 'lock' })
  assert.equal(lockAttempt.spawn_locked, false)
  assert.match(lockAttempt.detail, /luôn được bật/)
  assert.doesNotThrow(() => control.assertSpawnAllowed('subagent', { agent: 'codex' }))
})
