import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Confinement, sandboxModeForProfile } from '../src/confinement.js'
import { PermissionPolicy } from '../src/permission-profile.js'
import { runCommand } from '../src/exec-actions.js'
import { Sandbox } from '../src/sandbox.js'

/** Stands in for ctx.sandbox: records what it was asked to confine. */
function fakeProvider({ enforcement = 'complete', runner = 'bwrap', throws = null } = {}) {
  const calls = []
  return {
    calls,
    confine(argv, policy) {
      calls.push({ argv: [...argv], policy })
      if (throws !== null) throw throws
      return {
        argv: [runner, '--mode', policy.mode, '--', ...argv],
        enforcement,
        denialSignatures: ['erofs'],
        runnerFailureRules: [],
      }
    },
  }
}

test('a bridge profile maps onto the engine sandbox vocabulary', () => {
  assert.equal(sandboxModeForProfile('read-only'), 'read-only')
  assert.equal(sandboxModeForProfile('workspace-write'), 'workspace-write')
  assert.equal(sandboxModeForProfile('full'), 'danger-full-access')
  assert.equal(sandboxModeForProfile(undefined), 'danger-full-access')
})

test('a command is wrapped in the provider argv, not spawned as given', () => {
  const provider = fakeProvider()
  const confinement = new Confinement({ provider, policy: new PermissionPolicy({ profile: 'workspace-write' }) })
  const result = confinement.confine(['node', '--test'], { workspaceRoot: '/w' })

  assert.deepEqual(result.argv, ['bwrap', '--mode', 'workspace-write', '--', 'node', '--test'])
  assert.equal(result.mode, 'workspace-write')
  assert.equal(result.enforcement, 'complete')
  assert.deepEqual(provider.calls[0].policy, { mode: 'workspace-write', workspaceRoot: '/w' })
})

test('full access is unconfined, and says so rather than implying a boundary', () => {
  const provider = fakeProvider()
  const confinement = new Confinement({ provider, policy: new PermissionPolicy({ profile: 'full' }) })
  const result = confinement.confine(['ls'], { workspaceRoot: '/w' })
  assert.deepEqual(result.argv, ['ls'], 'nothing to wrap')
  assert.equal(result.enforcement, 'none')
  assert.equal(provider.calls.length, 0, 'the provider is not consulted for a mode it does not confine')
})

test('a narrowed profile with no provider REFUSES instead of running unconfined', async () => {
  // The whole point. Running the command anyway is how a "read-only" run
  // quietly becomes a full-access one.
  const confinement = new Confinement({ provider: null, policy: new PermissionPolicy({ profile: 'workspace-write' }) })
  assert.throws(() => confinement.confine(['rm', '-rf', '/'], { workspaceRoot: '/w' }), error => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /cannot confine processes/)
    assert.match(error.message, /dsh-sandbox-local/, 'the message names the fix')
    return true
  })
  // With no provider, full access still runs: that profile asked for no boundary.
  const open = new Confinement({ provider: null, policy: new PermissionPolicy({ profile: 'full' }) })
  assert.equal(open.confine(['ls'], { workspaceRoot: '/w' }).enforcement, 'none')
})

test('a provider that cannot back the mode is a capability error, not a command failure', () => {
  const provider = fakeProvider({ throws: Object.assign(new Error('no usable backend'), { code: 'SANDBOX_UNAVAILABLE' }) })
  const confinement = new Confinement({ provider, policy: new PermissionPolicy({ profile: 'read-only' }) })
  assert.throws(() => confinement.confine(['ls'], { workspaceRoot: '/w' }), error => {
    assert.equal(error.code, 'UNSUPPORTED')
    assert.match(error.message, /confinement is unavailable for read-only/)
    return true
  })
})

test('a caller may narrow confinement but never widen it', () => {
  const confinement = new Confinement({ provider: fakeProvider(), policy: new PermissionPolicy({ profile: 'workspace-write' }) })
  assert.equal(confinement.modeFor('read-only'), 'read-only')
  assert.equal(confinement.modeFor(undefined), 'workspace-write')
  assert.throws(() => confinement.modeFor('danger-full-access'), error => {
    assert.equal(error.code, 'PERMISSION_REQUIRED')
    assert.match(error.message, /can only be narrowed/)
    return true
  })
  assert.throws(() => confinement.modeFor('yolo'), error => error.code === 'INVALID_ARGUMENT')
})

test('exec_run spawns the confined argv and reports the boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-confine-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sandbox = new Sandbox(root)

  // A "runner" that proves the wrapper is what actually ran: it prints its own
  // marker before executing the wrapped command.
  const provider = {
    confine(argv, policy) {
      return {
        argv: ['node', '-e', `console.log("CONFINED:${policy.mode}"); process.exit(0)`],
        enforcement: 'complete',
        denialSignatures: [],
        runnerFailureRules: [],
      }
    },
  }
  const confinement = new Confinement({ provider, policy: new PermissionPolicy({ profile: 'workspace-write' }) })

  const result = await runCommand(sandbox, { argv: ['node', '-e', 'console.log("UNCONFINED")'] }, { confinement })
  assert.match(result.stdout, /CONFINED:workspace-write/)
  assert.doesNotMatch(result.stdout, /UNCONFINED/, 'the original argv must not be what ran')
  assert.deepEqual(result.sandbox, { mode: 'workspace-write', enforcement: 'complete', backend: 'node' })
})

test('a shell line is confined as bash -c, so every stage of a pipeline inherits it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-confine-shell-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let seen = null
  const provider = {
    confine(argv, policy) {
      seen = argv
      return { argv: ['node', '-e', 'console.log("ok")'], enforcement: 'complete', denialSignatures: [], runnerFailureRules: [] }
    },
  }
  const confinement = new Confinement({ provider, policy: new PermissionPolicy({ profile: 'read-only' }) })
  await runCommand(new Sandbox(root), { command: 'echo hi | wc -l', shell: true }, { confinement })
  assert.deepEqual(seen, ['bash', '-c', 'echo hi | wc -l'])
})

test('without a confinement the command still runs, reported as unconfined', async t => {
  // Backward compatibility for callers that pass no confinement (tests, and any
  // host with no sandbox seam at all). It must be visible in the result.
  const root = await mkdtemp(join(tmpdir(), 'shiro-confine-none-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await runCommand(new Sandbox(root), { argv: ['node', '-e', 'console.log("plain")'] }, {})
  assert.match(result.stdout, /plain/)
  assert.equal(result.sandbox.enforcement, 'none')
})

// -- the other spawn paths ---------------------------------------------------

test('a terminal confines the PTY HOST, so everything typed later inherits it', async t => {
  // The shell inside a terminal is not spawned by the bridge -- the PTY host
  // spawns it, and the user types more commands into it afterwards. Wrapping
  // individual commands could never cover those; wrapping the host covers the
  // whole session because every one of them is its descendant.
  const { TerminalRegistry } = await import('../src/terminal-actions.js')
  const root = await mkdtemp(join(tmpdir(), 'shiro-confine-tty-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  // A pass-through provider: it records WHAT it was asked to confine, then
  // hands the argv back unchanged so the real PTY host still starts and speaks
  // its own protocol. Substituting a stand-in binary here would only prove the
  // stand-in cannot talk to the registry.
  let confinedArgv = null
  const provider = {
    confine(argv) {
      confinedArgv = [...argv]
      return { argv: [...argv], enforcement: 'complete', denialSignatures: [], runnerFailureRules: [] }
    },
  }
  const terminals = new TerminalRegistry({
    confinement: new Confinement({ provider, policy: new PermissionPolicy({ profile: 'workspace-write' }) }),
  })
  const started = await terminals.start({ argv: ['bash'] }, { sandbox: new Sandbox(root) })
  t.after(async () => { await terminals.stop({ terminal_id: started.terminal_id, force: true }).catch(() => {}) })

  assert.notEqual(confinedArgv, null, 'the PTY host was confined')
  assert.match(confinedArgv[0], /python/, 'it is the python PTY helper that gets wrapped, not bash')
  assert.equal(started.sandbox.mode, 'workspace-write')
  assert.equal(started.sandbox.enforcement, 'complete')
})

test('git takes the boundary as an argument, and worktree work deliberately does not', async () => {
  // Measured against the real engine provider: under workspace-write, `git
  // worktree add` into an allowlisted SIBLING directory fails with
  // "Read-only file system" -- correct enforcement, wrong outcome, because
  // creating a checkout in another allowed root is exactly what
  // worktree_create is for. So the boundary is opt-in per caller: actions that
  // stay inside one workspace pass it, worktree actions do not.
  const { runGit } = await import('../src/git-commands.js')
  assert.equal(typeof runGit, 'function')

  const wired = await readFile(new URL('../src/direct-actions.js', import.meta.url), 'utf8')
  const gitCalls = [...wired.matchAll(/git\.\w+\(sandboxOf\(args\), args.*$/gm)].map(match => match[0])
  assert.ok(gitCalls.length > 15, `expected the git family, saw ${gitCalls.length}`)
  for (const call of gitCalls) {
    assert.match(call, /confinement/, `git call site not confined: ${call}`)
  }
  // The deliberate exception, asserted so it cannot be "fixed" by accident.
  const worktreeCalls = [...wired.matchAll(/worktrees\.\w+\(sandboxOf\(args\).*$/gm)].map(match => match[0])
  assert.ok(worktreeCalls.length > 0)
  for (const call of worktreeCalls) {
    assert.doesNotMatch(call, /confinement/, `worktree must stay unconfined to reach other allowed roots: ${call}`)
  }
})

test('task and test runs inherit the exec boundary', async () => {
  const wired = await readFile(new URL('../src/direct-actions.js', import.meta.url), 'utf8')
  for (const name of ['runTask', 'runTests']) {
    const call = wired.match(new RegExp(`tasks\\.${name}\\(.*$`, 'm'))?.[0]
    assert.ok(call, `${name} call site not found`)
    assert.match(call, /confinement/, `${name} runs package scripts and must be confined`)
  }
})

test('every action that spawns declares sandbox_mode, so a caller can narrow one call', async () => {
  const wired = await readFile(new URL('../src/direct-actions.js', import.meta.url), 'utf8')
  // Reading the parameter without declaring it is how it silently did nothing.
  const declared = (wired.match(/sandbox_mode: z\.enum/g) ?? []).length
  assert.equal(declared, 5, 'exec_run, process_start, task_run, test_run, terminal_start')
})

test('a task run forwards sandbox_mode to the command it actually spawns', async t => {
  // task-actions rebuilds the runCommand arguments field by field instead of
  // spreading, so an unnamed field is dropped in silence: sandbox_mode was
  // declared on test_run, accepted, threaded down, and still had no effect on
  // the spawn. Caught by running it live, not by any unit test.
  const { runTests } = await import('../src/task-actions.js')
  const root = await mkdtemp(join(tmpdir(), 'shiro-confine-task-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'probe', scripts: { test: 'node -e "process.exit(0)"' } }))

  let seenMode = null
  const provider = {
    confine(argv, policy) {
      seenMode = policy.mode
      return { argv: ['node', '-e', 'process.exit(0)'], enforcement: 'complete', denialSignatures: [], runnerFailureRules: [] }
    },
  }
  const confinement = new Confinement({ provider, policy: new PermissionPolicy({ profile: 'full' }) })
  const result = await runTests(new Sandbox(root), { sandbox_mode: 'read-only' }, { confinement })
  assert.equal(seenMode, 'read-only', 'the per-call mode reached the provider')
  assert.equal(result.sandbox.mode, 'read-only')
})
