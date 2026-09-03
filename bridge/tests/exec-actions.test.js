import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import { buildEnvironment, EXEC_LIMITS, ProcessRegistry, runCommand } from '../src/exec-actions.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shiro-exec-'))
  return { root, sandbox: new Sandbox(root), cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

const until = async predicate => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

test('exec_run reports exit codes, timeouts, truncation and stdin', async () => {
  const { root, sandbox, cleanup } = await fixture()
  try {
    const ok = await runCommand(sandbox, { argv: ['node', '-e', 'console.log("out"); console.error("err")'] })
    assert.equal(ok.exit_code, 0)
    assert.equal(ok.stdout, 'out\n')
    assert.equal(ok.stderr, 'err\n')
    assert.equal(ok.shell, false)
    assert.equal(ok.timed_out, false)

    const failing = await runCommand(sandbox, { argv: ['node', '-e', 'process.exit(7)'] })
    assert.equal(failing.exit_code, 7)

    const timedOut = await runCommand(sandbox, { argv: ['node', '-e', 'setTimeout(() => {}, 60000)'], timeout_ms: 300 })
    assert.equal(timedOut.timed_out, true)
    assert.notEqual(timedOut.exit_code, 0)

    const truncated = await runCommand(sandbox, { argv: ['node', '-e', 'process.stdout.write("x".repeat(20000))'], max_output_bytes: 1024 })
    assert.equal(truncated.stdout.length, 1024)
    assert.equal(truncated.stdout_truncated, true)
    assert.equal(truncated.stdout_bytes, 20000)

    const piped = await runCommand(sandbox, { argv: ['node', '-e', 'process.stdin.pipe(process.stdout)'], stdin: 'echoed' })
    assert.equal(piped.stdout, 'echoed')

    // argv is never interpreted by a shell: the metacharacters stay data.
    const literal = await runCommand(sandbox, { argv: ['node', '-e', 'console.log(process.argv[1])', 'a; rm -rf /'] })
    assert.equal(literal.stdout.trim(), 'a; rm -rf /')

    // shell mode is opt-in and is reported back in the result.
    const shelled = await runCommand(sandbox, { command: 'echo one && echo two', shell: true })
    assert.equal(shelled.shell, true)
    assert.equal(shelled.stdout, 'one\ntwo\n')

    await mkdir(join(root, 'work'))
    await writeFile(join(root, 'work', 'marker.txt'), 'here')
    const scoped = await runCommand(sandbox, { argv: ['node', '-e', 'console.log(require("fs").readFileSync("marker.txt","utf8"))'], cwd: 'work' })
    assert.equal(scoped.cwd, 'work')
    assert.equal(scoped.stdout.trim(), 'here')

    await rejects(runCommand(sandbox, { argv: ['node'], cwd: '../..' }), 'OUTSIDE_SANDBOX')
    await rejects(runCommand(sandbox, { argv: ['node'], cwd: 'missing' }), 'NOT_FOUND')
    await rejects(runCommand(sandbox, { argv: ['definitely-not-installed-xyz'] }), 'NOT_FOUND')
    await rejects(runCommand(sandbox, { argv: [] }), 'INVALID_ARGUMENT')
    await rejects(runCommand(sandbox, { command: 'echo hi' }), 'INVALID_ARGUMENT')
    await rejects(runCommand(sandbox, { argv: ['node'], timeout_ms: EXEC_LIMITS.timeout_max_ms + 1 }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('child environments are an allowlist plus an explicit overlay', async () => {
  const source = { PATH: '/usr/bin', HOME: '/home/x', SHIRO_BRIDGE_TOKEN: 'super-secret', AWS_SECRET_ACCESS_KEY: 'nope' }
  const environment = buildEnvironment({ EXTRA: 'value' }, source)
  assert.equal(environment.PATH, '/usr/bin')
  assert.equal(environment.EXTRA, 'value')
  assert.equal(environment.SHIRO_BRIDGE_TOKEN, undefined, 'bridge credentials must never reach a child process')
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined)
  assert.throws(() => buildEnvironment({ 'bad name': 'x' }), error => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => buildEnvironment({ OK: 1 }), error => error.code === 'INVALID_ARGUMENT')
})

test('process lifecycle: start, status, cursor logs, stop and bridge-only listing', async () => {
  const { sandbox, cleanup } = await fixture()
  const registry = new ProcessRegistry({ sandbox })
  try {
    const started = await registry.start({
      argv: ['node', '-e', 'let i = 0; setInterval(() => { console.log("tick " + i); console.error("e" + i); i += 1 }, 20)'],
      label: 'ticker',
    })
    assert.equal(started.state, 'running')
    assert.equal(started.label, 'ticker')
    assert.ok(Number.isInteger(started.pid))

    assert.ok(await until(() => registry.logs({ process_id: started.process_id }).total_bytes > 600))

    const first = registry.logs({ process_id: started.process_id, max_bytes: 256 })
    assert.equal(first.offset, 0)
    assert.equal(first.content.length, 256)
    assert.equal(first.truncated, true)
    const next = registry.logs({ process_id: started.process_id, from_offset: first.next_offset })
    assert.equal(next.offset, first.next_offset)
    assert.equal(next.dropped_bytes, 0)

    const stderrPage = registry.logs({ process_id: started.process_id, stream: 'stderr' })
    assert.match(stderrPage.content, /^e0/)

    const status = registry.status({ process_id: started.process_id })
    assert.equal(status.state, 'running')
    assert.match(status.stdout_tail, /tick/)

    const listed = registry.list({ state: 'running' })
    assert.equal(listed.running, 1)
    assert.equal(listed.processes[0].process_id, started.process_id)

    const stopped = await registry.stop({ process_id: started.process_id, grace_ms: 500 })
    assert.equal(stopped.state, 'stopped')
    const again = await registry.stop({ process_id: started.process_id })
    assert.equal(again.already_stopped, true)

    // A process that exits on its own is recorded with its exit code.
    const shortLived = await registry.start({ argv: ['node', '-e', 'process.exit(4)'] })
    assert.ok(await until(() => registry.status({ process_id: shortLived.process_id }).state === 'exited'))
    assert.equal(registry.status({ process_id: shortLived.process_id }).exit_code, 4)

    // status/logs/list are synchronous reads over bridge-local state.
    assert.throws(() => registry.status({ process_id: '00000000-0000-4000-8000-000000000000' }), error => error.code === 'NOT_FOUND')
    assert.throws(() => registry.logs({ process_id: '00000000-0000-4000-8000-000000000000' }), error => error.code === 'NOT_FOUND')
    await rejects(registry.start({ argv: ['definitely-not-installed-xyz'] }), 'NOT_FOUND')
    await rejects(registry.start({ argv: ['node'], cwd: '../..' }), 'OUTSIDE_SANDBOX')
  } finally {
    await registry.disposeAll()
    await cleanup()
  }
})

test('the process registry refuses to exceed its concurrency limit and kills everything on dispose', async () => {
  const { sandbox, cleanup } = await fixture()
  const registry = new ProcessRegistry({ sandbox, limits: { ...EXEC_LIMITS, max_processes: 2 } })
  try {
    const sleeper = ['node', '-e', 'setInterval(() => {}, 1000)']
    await registry.start({ argv: sleeper })
    await registry.start({ argv: sleeper })
    await rejects(registry.start({ argv: sleeper }), 'BUSY')
    assert.equal(await registry.disposeAll(), 2)
    assert.equal(registry.list({}).total, 0)
  } finally {
    await registry.disposeAll()
    await cleanup()
  }
})

test('process log ring buffer reports dropped bytes instead of silently skipping', async () => {
  const { sandbox, cleanup } = await fixture()
  const registry = new ProcessRegistry({ sandbox, limits: { ...EXEC_LIMITS, process_log_bytes: 64 } })
  try {
    const started = await registry.start({ argv: ['node', '-e', 'process.stdout.write("y".repeat(500))'] })
    assert.ok(await until(() => registry.logs({ process_id: started.process_id }).total_bytes >= 500))
    const page = registry.logs({ process_id: started.process_id, from_offset: 0 })
    assert.equal(page.total_bytes, 500)
    assert.equal(page.dropped_bytes, 500 - 64)
    assert.equal(page.offset, 500 - 64)
    assert.equal(page.content.length, 64)
  } finally {
    await registry.disposeAll()
    await cleanup()
  }
})
