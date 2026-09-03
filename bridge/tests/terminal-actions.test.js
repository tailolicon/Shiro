import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import {
  CONTROL_KEYS, renderTerminalText, TERMINAL_LIMITS, TerminalRegistry, trimPartialUtf8,
} from '../src/terminal-actions.js'

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shiro-pty-'))
  const terminals = new TerminalRegistry(options)
  return {
    root,
    sandbox: new Sandbox(root),
    terminals,
    cleanup: async () => {
      await terminals.disposeAll()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

/** Read until `predicate` matches or the budget runs out, following the cursor. */
async function readUntil(terminals, terminalId, predicate, { budgetMs = 8000, from = 0 } = {}) {
  const deadline = Date.now() + budgetMs
  let cursor = from
  let seen = ''
  while (Date.now() < deadline) {
    const page = await terminals.read({ terminal_id: terminalId, from_offset: cursor, wait_ms: 1000 })
    cursor = page.next_offset
    seen += page.content
    if (predicate(seen, page)) return { seen, page, cursor }
  }
  throw new Error(`terminal never matched; transcript so far: ${JSON.stringify(seen)}`)
}

test('the terminal renderer replays cursor motion the way a terminal paints it', () => {
  // A REPL echoes each keystroke by repainting the line: strip alone is not enough.
  const repaint = '\x1b[1;35m>>> \x1b[0m2\r\x1b[4C2 \r\x1b[4C2 + 40\r\n42\r\n'
  assert.equal(renderTerminalText(repaint), '>>> 2 + 40\n42\n')
  assert.equal(renderTerminalText('abc\r\x1b[Kz'), 'z')
  // Backspace moves the cursor without erasing, exactly like a real terminal.
  assert.equal(renderTerminalText('hello\b\b\bp'), 'heplo')
  assert.equal(renderTerminalText('oops\b \b'), 'oop ')
  assert.equal(renderTerminalText('one\x1b]0;title\x07two'), 'onetwo')
  assert.equal(renderTerminalText('a\tb'), 'a       b')
  assert.equal(renderTerminalText('keep\x1b[2Jgone'), 'gone')
  assert.equal(renderTerminalText('\x1b[31mred\x1b[0m'), 'red')
})

test('a page boundary never splits a UTF-8 codepoint', () => {
  const bytes = Buffer.from('héllo', 'utf8')
  // 'é' spans bytes 1-2: cutting after byte 1 must drop the incomplete lead byte.
  assert.equal(trimPartialUtf8(bytes.subarray(0, 2)).length, 1)
  assert.equal(trimPartialUtf8(bytes.subarray(0, 3)).length, 3)
  assert.equal(trimPartialUtf8(bytes).toString('utf8'), 'héllo')
})

test('a terminal runs a program, streams its output and reports its exit', async () => {
  const { sandbox, terminals, cleanup } = await fixture()
  try {
    const started = await terminals.start(
      { argv: ['/bin/sh', '-c', 'echo hello from the pty; exit 7'], label: 'greeting' },
      { sandbox, workspaceId: 'project' },
    )
    assert.equal(started.state, 'running')
    assert.equal(started.workspace, 'project')
    assert.equal(started.label, 'greeting')
    assert.ok(started.pid > 0)

    const { seen } = await readUntil(terminals, started.terminal_id, text => text.includes('hello from the pty'))
    assert.match(seen, /hello from the pty/)

    await readUntil(terminals, started.terminal_id, (_text, page) => page.state !== 'running')
    const final = await terminals.read({ terminal_id: started.terminal_id, from_offset: 0 })
    assert.equal(final.state, 'exited')
    assert.equal(final.exit_code, 7)
    // A finished terminal keeps its transcript readable.
    assert.match(final.content, /hello from the pty/)
  } finally {
    await cleanup()
  }
})

test('an interactive program can be answered and interrupted', async () => {
  const { sandbox, terminals, cleanup } = await fixture()
  try {
    const started = await terminals.start({ argv: ['python3', '-i', '-q'] }, { sandbox, workspaceId: 'project' })
    const { cursor } = await readUntil(terminals, started.terminal_id, text => text.includes('>>>'))

    // The whole point: keep typing into a program that is already running.
    terminals.write({ terminal_id: started.terminal_id, input: '6 * 7', submit: true })
    const answered = await terminals.read({ terminal_id: started.terminal_id, from_offset: cursor, wait_ms: 5000 })
    assert.match(answered.content, /42/)
    assert.equal(answered.idle, false)

    // ctrl-C is a named key, not a byte the caller has to know.
    const interrupted = terminals.write({ terminal_id: started.terminal_id, keys: ['ctrl-c'] })
    assert.equal(interrupted.bytes_written, CONTROL_KEYS['ctrl-c'].length)

    const resized = terminals.resize({ terminal_id: started.terminal_id, cols: 200, rows: 60 })
    assert.equal(resized.cols, 200)
    assert.equal(resized.rows, 60)

    const stopped = await terminals.stop({ terminal_id: started.terminal_id, force: true })
    assert.ok(['stopped', 'exited'].includes(stopped.state))
    const again = await terminals.stop({ terminal_id: started.terminal_id })
    assert.equal(again.already_stopped, true)
  } finally {
    await cleanup()
  }
})

test('reads follow a cursor and wait for a quiet period rather than the first byte', async () => {
  const { sandbox, terminals, cleanup } = await fixture()
  try {
    const started = await terminals.start(
      { argv: ['/bin/sh', '-c', 'printf one; sleep 0.2; printf two; sleep 5'] },
      { sandbox, workspaceId: 'project' },
    )
    // settle_ms spans the gap between the two writes, so one call sees both.
    const page = await terminals.read({ terminal_id: started.terminal_id, from_offset: 0, wait_ms: 4000, settle_ms: 600 })
    assert.match(page.content, /onetwo/)
    assert.equal(page.offset, 0)
    assert.ok(page.next_offset >= 6)

    // A cursor past the end with no new output comes back idle, not hanging.
    const idle = await terminals.read({ terminal_id: started.terminal_id, from_offset: page.next_offset, wait_ms: 300, settle_ms: 0 })
    assert.equal(idle.idle, true)
    assert.equal(idle.content, '')
    await terminals.stop({ terminal_id: started.terminal_id, force: true })
  } finally {
    await cleanup()
  }
})

test('terminal cwd is confined to the workspace and unknown ids fail cleanly', async () => {
  const { sandbox, terminals, cleanup } = await fixture()
  try {
    await rejects(terminals.start({ argv: ['/bin/sh'], cwd: '../..' }, { sandbox, workspaceId: 'project' }), 'OUTSIDE_SANDBOX')
    await rejects(terminals.start({ argv: ['/bin/sh'], cwd: '/etc' }, { sandbox, workspaceId: 'project' }), 'OUTSIDE_SANDBOX')
    await rejects(terminals.start({ argv: [] }, { sandbox, workspaceId: 'project' }), 'INVALID_ARGUMENT')
    await rejects(terminals.read({ terminal_id: 'nope' }), 'NOT_FOUND')
    assert.throws(() => terminals.write({ terminal_id: 'nope', input: 'x' }), error => error.code === 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('writing to a finished terminal is a conflict, not a silent no-op', async () => {
  const { sandbox, terminals, cleanup } = await fixture()
  try {
    const started = await terminals.start({ argv: ['/bin/sh', '-c', 'exit 0'] }, { sandbox, workspaceId: 'project' })
    await readUntil(terminals, started.terminal_id, (_text, page) => page.state !== 'running')
    assert.throws(() => terminals.write({ terminal_id: started.terminal_id, input: 'ls', submit: true }), error => error.code === 'CONFLICT')
    assert.throws(() => terminals.signal({ terminal_id: started.terminal_id }), error => error.code === 'CONFLICT')
  } finally {
    await cleanup()
  }
})

test('input validation covers empty writes, unknown keys and oversized payloads', async () => {
  const { sandbox, terminals, cleanup } = await fixture()
  try {
    const started = await terminals.start({ argv: ['/bin/sh'] }, { sandbox, workspaceId: 'project' })
    const id = started.terminal_id
    assert.throws(() => terminals.write({ terminal_id: id }), error => error.code === 'INVALID_ARGUMENT')
    assert.throws(() => terminals.write({ terminal_id: id, keys: ['ctrl-nope'] }), error => error.code === 'INVALID_ARGUMENT')
    assert.throws(
      () => terminals.write({ terminal_id: id, input: 'x'.repeat(TERMINAL_LIMITS.input_max_bytes + 1) }),
      error => error.code === 'INVALID_ARGUMENT',
    )
    assert.throws(() => terminals.signal({ terminal_id: id, signal: 'BOGUS' }), error => error.code === 'INVALID_ARGUMENT')
    await terminals.stop({ terminal_id: id, force: true })
  } finally {
    await cleanup()
  }
})

test('the terminal count is capped and only bridge-owned terminals are listed', async () => {
  const { sandbox, terminals, cleanup } = await fixture({ limits: { ...TERMINAL_LIMITS, max_terminals: 2 } })
  try {
    const first = await terminals.start({ argv: ['/bin/sh'] }, { sandbox, workspaceId: 'project' })
    await terminals.start({ argv: ['/bin/sh'] }, { sandbox, workspaceId: 'other' })
    await rejects(terminals.start({ argv: ['/bin/sh'] }, { sandbox, workspaceId: 'project' }), 'BUSY')

    const listed = terminals.list({})
    assert.equal(listed.total, 2)
    assert.equal(listed.running, 2)
    assert.equal(listed.max_terminals, 2)
    assert.equal(terminals.list({ workspace: 'other' }).total, 1)
    assert.equal(terminals.runningIn('project'), 1)

    await terminals.stop({ terminal_id: first.terminal_id, force: true })
    assert.equal(terminals.runningIn('project'), 0)
  } finally {
    await cleanup()
  }
})

test('a missing pty host is reported as UNSUPPORTED, never as a dead terminal id', async () => {
  const { sandbox, terminals, cleanup } = await fixture({ python: 'python3-that-does-not-exist' })
  try {
    await rejects(terminals.start({ argv: ['/bin/sh'] }, { sandbox, workspaceId: 'project' }), 'UNSUPPORTED')
    assert.equal(terminals.list({}).total, 0, 'a failed start leaves no phantom terminal behind')
  } finally {
    await cleanup()
  }
})

test('a program that cannot be executed surfaces in the transcript and exits', async () => {
  const { sandbox, terminals, cleanup } = await fixture()
  try {
    const started = await terminals.start({ argv: ['definitely-not-a-real-binary'] }, { sandbox, workspaceId: 'project' })
    const { page } = await readUntil(terminals, started.terminal_id, (text, current) => current.state !== 'running' || text.includes('cannot start'))
    assert.match(page.content + '', /cannot start|not found/i)
  } finally {
    await cleanup()
  }
})

test('disposeAll kills every live terminal', async () => {
  const { sandbox, terminals, root } = await fixture()
  await terminals.start({ argv: ['/bin/sh'] }, { sandbox, workspaceId: 'project' })
  await terminals.start({ argv: ['/bin/sh'] }, { sandbox, workspaceId: 'project' })
  assert.equal(await terminals.disposeAll(), 2)
  assert.equal(terminals.list({}).total, 0)
  await rm(root, { recursive: true, force: true })
})

test('a workspace file is reachable from a terminal started in it', async () => {
  const { root, sandbox, terminals, cleanup } = await fixture()
  try {
    await writeFile(join(root, 'marker.txt'), 'workspace-local\n')
    const started = await terminals.start({ argv: ['/bin/sh', '-c', 'cat marker.txt'] }, { sandbox, workspaceId: 'project' })
    const { seen } = await readUntil(terminals, started.terminal_id, text => text.includes('workspace-local'))
    assert.match(seen, /workspace-local/)
  } finally {
    await cleanup()
  }
})
