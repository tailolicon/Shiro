import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessRegistry } from '../src/exec-actions.js'
import { Sandbox } from '../src/sandbox.js'
import { SubagentRegistry } from '../src/subagents.js'

/**
 * A real, spawnable stand-in for a CLI: a tiny Node script, not the real
 * claude/codex/grok/agy binaries. It lets these tests exercise the actual
 * pipeline -- ProcessRegistry.start -> a real child process -> the stdout ring
 * buffer -> logs() -> adapter.parseTranscript() -- without needing a signed-in
 * account. The wire-format parsing itself (real captured transcripts) is
 * covered separately in subagent-adapters.test.js.
 */
async function writeFixtureCli(dir) {
  const path = join(dir, 'fixture-cli.mjs')
  await writeFile(path, `
    const [, , prompt, resumeFrom, mode] = process.argv
    if (mode === 'slow') await new Promise(r => setTimeout(r, 400))
    if (mode === 'fail') { console.error('fixture: deliberate failure'); process.exit(1) }
    console.log(JSON.stringify({
      result: resumeFrom ? \`continued: \${prompt}\` : \`done: \${prompt}\`,
      session_id: resumeFrom || 'fixture-session-1',
    }))
  `, 'utf8')
  return path
}

function fixtureAdapter(scriptPath) {
  return {
    id: 'fixture',
    label: 'Fixture CLI',
    binary: process.execPath, // the node binary running these tests
    unverified: false,
    probeAuthArgv: ['--version'],
    classifyAuth: () => true,
    buildArgv({ prompt, resumeFrom, model }) {
      return [scriptPath, prompt, resumeFrom ?? '', model === 'slow' ? 'slow' : model === 'fail' ? 'fail' : '']
    },
    parseTranscript(stdout) {
      const trimmed = stdout.trim()
      if (trimmed === '') return { done: false }
      try {
        const value = JSON.parse(trimmed)
        return { done: true, success: true, threadId: value.session_id, message: value.result }
      } catch {
        return { done: false }
      }
    },
  }
}

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'shiro-subagents-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scriptPath = await writeFixtureCli(root)
  const adapter = fixtureAdapter(scriptPath)
  const sandbox = new Sandbox(root)
  const processes = new ProcessRegistry({ sandbox })
  const subagents = new SubagentRegistry({ processes, adapters: { fixture: adapter, other: { ...adapter, id: 'other' } } })
  return { root, sandbox, processes, subagents }
}

test('start tags the process as a subagent and returns immediately', async t => {
  const { subagents, sandbox } = await harness(t)
  const started = await subagents.start({ agent: 'fixture', prompt: 'read note.txt' }, { sandbox })
  assert.match(started.process_id, /^[0-9a-f-]{36}$/)
  assert.equal(started.agent, 'fixture')
  assert.equal(started.unverified, false)
  assert.equal(started.state, 'running')
})

test('an unknown agent name is refused before anything is spawned', async t => {
  const { subagents, sandbox, processes } = await harness(t)
  await assert.rejects(subagents.start({ agent: 'gpt5', prompt: 'x' }, { sandbox }), error => error.code === 'INVALID_ARGUMENT')
  assert.equal(processes.list({}).total, 0, 'nothing was spawned')
})

test('an empty or oversized prompt is rejected', async t => {
  const { subagents, sandbox } = await harness(t)
  await assert.rejects(subagents.start({ agent: 'fixture', prompt: '' }, { sandbox }), error => error.code === 'INVALID_ARGUMENT')
  await assert.rejects(subagents.start({ agent: 'fixture', prompt: 'x'.repeat(50_001) }, { sandbox }), error => error.code === 'INVALID_ARGUMENT')
})

test('status reports not-done while running and the parsed result once exited', async t => {
  const { subagents, sandbox } = await harness(t)
  const started = await subagents.start({ agent: 'fixture', prompt: 'slow one', model: 'slow' }, { sandbox })

  const early = await subagents.status({ process_id: started.process_id })
  assert.equal(early.state, 'running')
  assert.equal(early.turn_done, false)
  assert.equal(early.message, undefined)

  await new Promise(resolve => setTimeout(resolve, 700))
  const done = await subagents.status({ process_id: started.process_id })
  assert.equal(done.state, 'exited')
  assert.equal(done.turn_done, true)
  assert.equal(done.turn_success, true)
  assert.equal(done.message, 'done: slow one')
  assert.equal(done.thread_id, 'fixture-session-1')
  assert.equal(done.agent, 'fixture')
})

test('a failed CLI still reports a clean status, not a thrown error', async t => {
  const { subagents, sandbox } = await harness(t)
  const started = await subagents.start({ agent: 'fixture', prompt: 'x', model: 'fail' }, { sandbox })
  await new Promise(resolve => setTimeout(resolve, 300))
  const status = await subagents.status({ process_id: started.process_id })
  assert.equal(status.state, 'exited')
  assert.equal(status.exit_code, 1)
  assert.equal(status.turn_done, false, 'the fixture printed nothing before failing, so there is no result to parse')
})

test('resume_from a process_id resolves through that run\'s own parsed session id', async t => {
  const { subagents, sandbox } = await harness(t)
  const first = await subagents.start({ agent: 'fixture', prompt: 'first turn' }, { sandbox })
  await new Promise(resolve => setTimeout(resolve, 200))

  const second = await subagents.start({ agent: 'fixture', prompt: 'second turn', resume_from: first.process_id }, { sandbox })
  assert.equal(second.resumed_from, 'fixture-session-1', 'resolved from the FIRST run\'s transcript, not passed through raw')
  await new Promise(resolve => setTimeout(resolve, 200))
  const status = await subagents.status({ process_id: second.process_id })
  assert.equal(status.message, 'continued: second turn')
})

test('resume_from a raw session id (not a known process_id) passes straight through', async t => {
  const { subagents, sandbox } = await harness(t)
  const started = await subagents.start({ agent: 'fixture', prompt: 'x', resume_from: 'some-external-session-id' }, { sandbox })
  assert.equal(started.resumed_from, 'some-external-session-id')
})

test('resuming a process that has not produced a session id yet is refused, not guessed', async t => {
  const { subagents, sandbox } = await harness(t)
  const first = await subagents.start({ agent: 'fixture', prompt: 'slow', model: 'slow' }, { sandbox })
  // Still running -- no transcript yet.
  await assert.rejects(subagents.start({ agent: 'fixture', prompt: 'y', resume_from: first.process_id }, { sandbox }), error => {
    assert.equal(error.code, 'CONFLICT')
    assert.match(error.message, /subagent_status/)
    return true
  })
})

test('log and stop refuse a process_id that is a real bridge process but not a subagent', async t => {
  const { subagents, sandbox, processes } = await harness(t)
  const plain = await processes.start({ argv: [process.execPath, '-e', 'setTimeout(()=>{},2000)'] }, { sandbox })
  await assert.rejects(subagents.status({ process_id: plain.process_id }), error => error.code === 'NOT_FOUND')
  await assert.rejects(subagents.log({ process_id: plain.process_id }), error => error.code === 'NOT_FOUND')
  await assert.rejects(subagents.stop({ process_id: plain.process_id }), error => error.code === 'NOT_FOUND')
  await processes.stop({ process_id: plain.process_id, force: true })
})

test('log reads raw output, cursor-paginated exactly like process_logs', async t => {
  const { subagents, sandbox } = await harness(t)
  const started = await subagents.start({ agent: 'fixture', prompt: 'hello' }, { sandbox })
  await new Promise(resolve => setTimeout(resolve, 300))
  const page = await subagents.log({ process_id: started.process_id })
  assert.match(page.content, /"result":"done: hello"/)
  assert.equal(page.eof, true)
})

test('stop kills a running subagent and is tagged with its agent', async t => {
  const { subagents, sandbox } = await harness(t)
  const started = await subagents.start({ agent: 'fixture', prompt: 'slow', model: 'slow' }, { sandbox })
  const stopped = await subagents.stop({ process_id: started.process_id, force: true })
  assert.equal(stopped.agent, 'fixture')
  assert.ok(['stopped', 'exited'].includes(stopped.state))
})

test('list shows only subagent-tagged processes, not other bridge-owned ones', async t => {
  const { subagents, sandbox, processes } = await harness(t)
  const subagentRun = await subagents.start({ agent: 'fixture', prompt: 'x' }, { sandbox })
  const plain = await processes.start({ argv: [process.execPath, '-e', 'setTimeout(()=>{},50)'] }, { sandbox })
  await new Promise(resolve => setTimeout(resolve, 300))

  const listed = await subagents.list({})
  assert.equal(listed.total, 1)
  assert.equal(listed.subagents[0].process_id, subagentRun.process_id)
  assert.equal(listed.subagents[0].agent, 'fixture')
  assert.ok(listed.subagents.every(entry => entry.process_id !== plain.process_id))
})

test('providers reports install and auth state without spawning a bridge-owned process', async t => {
  const { subagents, processes } = await harness(t)
  const result = await subagents.providers()
  assert.equal(result.providers.length, 2) // fixture + other, from the injected adapters map
  const fixtureRow = result.providers.find(row => row.agent === 'fixture')
  assert.equal(fixtureRow.installed, true)
  assert.equal(fixtureRow.authenticated, true)
  assert.equal(processes.list({}).total, 0, 'a discovery probe must not show up as a bridge-owned process')
})

test('providers classifies auth from stderr and from a non-zero exit, not just stdout on success', async () => {
  // Regression: codex's real `login status` prints to STDERR on exit 0
  // ("Logged in using ChatGPT"), and antigravity's real `models` prints
  // "Please sign in..." to stderr on exit 1. A classifier that only looked at
  // stdout-on-success read both as unknown (null) instead of their real
  // answer -- caught by comparing this probe's output to the real CLIs live,
  // not by a fixture whose classifyAuth ignored its own arguments.
  const stderrOnSuccess = new SubagentRegistry({
    processes: new ProcessRegistry({ sandbox: new Sandbox(tmpdir()) }),
    adapters: {
      quiet: {
        id: 'quiet', label: 'Quiet CLI', binary: process.execPath, unverified: false,
        probeAuthArgv: ['-e', 'process.stderr.write("Logged in using Example")'],
        classifyAuth: (stdout, stderr) => `${stdout}${stderr}`.toLowerCase().includes('logged in'),
      },
      failsWhenSignedOut: {
        id: 'failsWhenSignedOut', label: 'Exit1 CLI', binary: process.execPath, unverified: false,
        probeAuthArgv: ['-e', 'process.stderr.write("Please sign in"); process.exit(1)'],
        classifyAuth: (stdout, stderr) => (/sign in/i.test(stderr) ? false : null),
      },
    },
  })
  const result = await stderrOnSuccess.providers()
  assert.equal(result.providers.find(row => row.agent === 'quiet').authenticated, true)
  assert.equal(result.providers.find(row => row.agent === 'failsWhenSignedOut').authenticated, false)
})

test('providers reports a missing binary as not-installed, not an error', async () => {
  const missing = new SubagentRegistry({ processes: new ProcessRegistry({ sandbox: new Sandbox(tmpdir()) }), adapters: {
    ghost: { id: 'ghost', label: 'Ghost CLI', binary: 'this-binary-does-not-exist-anywhere', unverified: true, probeAuthArgv: [], classifyAuth: () => null },
  } })
  const result = await missing.providers()
  assert.deepEqual(result.providers, [{ agent: 'ghost', label: 'Ghost CLI', installed: false, authenticated: null, unverified: true }])
})
