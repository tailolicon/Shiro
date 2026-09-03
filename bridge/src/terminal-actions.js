import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ActionError, fail } from './action-errors.js'
import { buildEnvironment, StreamRing } from './exec-actions.js'

// Interactive terminals: the piece process_start cannot cover.
//
// process_start gives a background process with captured output but no way to
// answer it. Anything that asks a question -- a REPL, `gh auth login`, an npm
// scaffolder, ssh, a debugger, a TUI -- needs a real pseudo-terminal plus a
// channel to keep typing into it. Node ships no pty, and the bridge ships no
// native dependency on purpose, so each terminal is hosted by a small stdlib
// Python helper (pty-bridge.py) speaking newline-delimited JSON.
//
// Everything else matches the process family: the working directory is
// resolved through a workspace Sandbox, the environment is the same allowlist
// (never the bridge's own env), output lands in a byte-addressed ring buffer
// so a client cursor survives buffer wrap, and only bridge-owned terminals are
// listable or controllable.

export const TERMINAL_LIMITS = Object.freeze({
  max_terminals: 8,
  output_bytes: 1_048_576,
  input_max_bytes: 8192,
  read_default_bytes: 65_536,
  read_max_bytes: 262_144,
  wait_max_ms: 20_000,
  start_timeout_ms: 5000,
  default_cols: 120,
  default_rows: 32,
  max_cols: 500,
  max_rows: 200,
  stop_grace_default_ms: 3000,
  stop_grace_max_ms: 30_000,
})

/**
 * Named keys the model can send without knowing terminal control codes. This
 * is the difference between "answer the prompt" and "guess that ctrl-C is
 * byte 0x03"; anything not listed can still be sent verbatim through `input`.
 */
export const CONTROL_KEYS = Object.freeze({
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  page_up: '\x1b[5~',
  page_down: '\x1b[6~',
  'ctrl-a': '\x01',
  'ctrl-b': '\x02',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-e': '\x05',
  'ctrl-l': '\x0c',
  'ctrl-r': '\x12',
  'ctrl-u': '\x15',
  'ctrl-w': '\x17',
  'ctrl-z': '\x1a',
})

export const TERMINAL_SIGNALS = Object.freeze(['INT', 'TERM', 'KILL', 'QUIT', 'HUP', 'USR1', 'USR2', 'TSTP', 'CONT'])

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'pty-bridge.py')

/**
 * Render pty output the way the terminal would, one line at a time.
 *
 * Stripping escapes is not enough: a REPL echoes each keystroke by moving the
 * cursor back and repainting the whole line, so a plain strip returns
 * ">>> 2>>> 2 >>> 2 +..." instead of ">>> 2 + 40". This is a one-dimensional
 * emulator -- a current line plus a cursor column, with the escapes that move
 * or erase within a line applied -- which is what makes REPL and prompt
 * transcripts readable. It deliberately does NOT model a 2-D screen, so a
 * full-screen TUI (vim, htop) still reads as successive repaints; pass
 * raw=true when the caller wants the exact bytes.
 */
export function renderTerminalText(text) {
  const lines = []
  let line = ''
  let column = 0
  const write = value => {
    if (column > line.length) line = line.padEnd(column, ' ')
    line = line.slice(0, column) + value + line.slice(column + value.length)
    column += value.length
  }
  const newline = () => { lines.push(line); line = ''; column = 0 }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\x1b') {
      const next = text[index + 1]
      if (next === '[') {
        // CSI: parameters, then intermediates, then one final byte.
        let cursor = index + 2
        while (cursor < text.length && /[0-?]/.test(text[cursor])) cursor += 1
        while (cursor < text.length && /[ -/]/.test(text[cursor])) cursor += 1
        const final = text[cursor]
        const parameters = text.slice(index + 2, cursor).split(';').map(part => (part === '' ? undefined : Number.parseInt(part, 10)))
        const first = Number.isInteger(parameters[0]) ? parameters[0] : undefined
        if (final === 'C') column += first ?? 1
        else if (final === 'D') column = Math.max(0, column - (first ?? 1))
        else if (final === 'G') column = Math.max(0, (first ?? 1) - 1)
        else if (final === 'H' || final === 'f') column = Math.max(0, (parameters[1] ?? 1) - 1)
        else if (final === 'K') {
          if ((first ?? 0) === 0) line = line.slice(0, column)
          else if (first === 1) line = ' '.repeat(Math.min(column, line.length)) + line.slice(column)
          else line = ''
        } else if (final === 'J') { if ((first ?? 0) >= 2) { lines.length = 0; line = ''; column = 0 } }
        else if (final === 'P') line = line.slice(0, column) + line.slice(column + (first ?? 1))
        else if (final === '@') line = line.slice(0, column) + ' '.repeat(first ?? 1) + line.slice(column)
        index = cursor === undefined ? text.length : cursor
        continue
      }
      if (next === ']') {
        // OSC: runs until BEL or ESC-backslash.
        const bell = text.indexOf('\x07', index)
        const terminator = text.indexOf('\x1b\\', index)
        const stop = [bell, terminator].filter(position => position !== -1).sort((left, right) => left - right)[0]
        index = stop === undefined ? text.length : stop + (stop === terminator ? 1 : 0)
        continue
      }
      index += 1
      continue
    }
    if (character === '\n') { newline(); continue }
    if (character === '\r') { column = 0; continue }
    if (character === '\b') { column = Math.max(0, column - 1); continue }
    if (character === '\t') { write(' '.repeat(8 - (column % 8))); continue }
    if (character === '\x07') continue
    if (character < ' ' || character === '\x7f') continue
    write(character)
  }
  lines.push(line)
  return lines.join('\n')
}

/** Trim a trailing partial UTF-8 sequence so a page boundary never mojibakes. */
export function trimPartialUtf8(buffer) {
  let cut = buffer.length
  for (let index = 1; index <= 4 && index <= buffer.length; index += 1) {
    const byte = buffer[buffer.length - index]
    if ((byte & 0b1100_0000) === 0b1000_0000) continue
    const needed = (byte & 0b1000_0000) === 0 ? 1
      : (byte & 0b1110_0000) === 0b1100_0000 ? 2
        : (byte & 0b1111_0000) === 0b1110_0000 ? 3
          : (byte & 0b1111_1000) === 0b1111_0000 ? 4 : 1
    if (needed > index) cut = buffer.length - index
    break
  }
  return buffer.subarray(0, cut)
}

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

function defaultShell(source = process.env) {
  const shell = typeof source.SHELL === 'string' && source.SHELL.trim() !== '' ? source.SHELL.trim() : '/bin/bash'
  return [shell, '-i']
}

export class TerminalRegistry {
  constructor({ limits = TERMINAL_LIMITS, now = () => Date.now(), python = process.env.SHIRO_PYTHON ?? 'python3', helper = HELPER, confinement = null } = {}) {
    this.limits = limits
    this.confinement = confinement
    this.now = now
    this.python = python
    this.helper = helper
    this.terminals = new Map()
  }

  #require(terminalId) {
    const entry = this.terminals.get(terminalId)
    if (entry === undefined) fail('NOT_FOUND', `terminal ${terminalId} is not a bridge-owned terminal`)
    return entry
  }

  #requireLive(terminalId) {
    const entry = this.#require(terminalId)
    if (entry.state !== 'running') {
      fail('CONFLICT', `terminal ${terminalId} already ${entry.state} (exit code ${entry.exitCode ?? 'n/a'}); start a new one with terminal_start`)
    }
    return entry
  }

  #record(entry, extra = {}) {
    return {
      terminal_id: entry.id,
      state: entry.state,
      command: entry.display,
      argv: entry.argv,
      cwd: entry.cwd,
      workspace: entry.workspaceId,
      sandbox: entry.sandbox,
      label: entry.label,
      pid: entry.pid,
      cols: entry.cols,
      rows: entry.rows,
      started_at: new Date(entry.startedAt).toISOString(),
      ended_at: entry.endedAt === null ? undefined : new Date(entry.endedAt).toISOString(),
      duration_ms: (entry.endedAt ?? this.now()) - entry.startedAt,
      exit_code: entry.exitCode,
      signal: entry.signal,
      output_bytes: entry.output.end,
      last_output_at: entry.lastOutputAt === null ? undefined : new Date(entry.lastOutputAt).toISOString(),
      last_error: entry.lastError,
      ...extra,
    }
  }

  #settle(entry) {
    for (const waiter of entry.waiters.splice(0)) waiter()
  }

  /** Resolve on the next byte of output (or state change), or after `ms`. */
  #awaitChange(entry, ms) {
    return new Promise(resolveChange => {
      const timer = setTimeout(() => {
        entry.waiters = entry.waiters.filter(waiter => waiter !== wake)
        resolveChange()
      }, Math.max(0, ms))
      timer.unref?.()
      const wake = () => { clearTimeout(timer); resolveChange() }
      entry.waiters.push(wake)
    })
  }

  #send(entry, message) {
    if (entry.host.stdin.destroyed) fail('CONFLICT', `terminal ${entry.id} is no longer accepting input`)
    entry.host.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * terminal_start: open a pty running argv (an interactive shell by default)
   * inside one workspace. Resolves only after the helper reports the child is
   * alive, so a missing interpreter or a bad cwd is an error here rather than
   * a terminal id the caller would have to poll to discover is dead.
   */
  async start(args = {}, { sandbox, workspaceId, confinement = this.confinement } = {}) {
    if (sandbox === undefined) fail('INTERNAL', 'terminal_start requires a workspace sandbox')
    const live = [...this.terminals.values()].filter(entry => entry.state === 'running')
    if (live.length >= this.limits.max_terminals) {
      fail('BUSY', `${live.length} terminals are already open (limit ${this.limits.max_terminals}); close one with terminal_stop first`)
    }
    if (args.argv !== undefined) {
      if (!Array.isArray(args.argv) || args.argv.length === 0) fail('INVALID_ARGUMENT', 'argv must be a non-empty array of strings')
      if (args.argv.length > 256) fail('INVALID_ARGUMENT', 'argv accepts at most 256 entries')
      for (const item of args.argv) {
        if (typeof item !== 'string') fail('INVALID_ARGUMENT', 'every argv entry must be a string')
        if (item.includes('\0')) fail('INVALID_ARGUMENT', 'argv entries must not contain NUL bytes')
      }
    }
    const argv = args.argv ?? defaultShell()
    const cwd = await sandbox.resolveDirectory(args.cwd ?? '.')
    const cols = clampInteger(args.cols, { min: 20, max: this.limits.max_cols, fallback: this.limits.default_cols, label: 'cols' })
    const rows = clampInteger(args.rows, { min: 4, max: this.limits.max_rows, fallback: this.limits.default_rows, label: 'rows' })
    // TERM must exist or curses programs refuse to draw; the rest of the
    // environment is the same allowlist exec_run uses.
    const environment = {
      TERM: 'xterm-256color',
      ...buildEnvironment(args.env),
      PWD: cwd.absolute,
    }

    const id = randomUUID()
    // The PTY HOST is what gets confined, not the shell inside it: everything
    // the terminal ever runs is a descendant of this process, so one boundary
    // here covers the whole session -- including commands typed later, which
    // is the only place a per-spawn wrapper could not reach.
    const plan = confinement === null
      ? { argv: [this.python, this.helper], sandbox: { mode: 'danger-full-access', enforcement: 'none' } }
      : (() => {
        const confined = confinement.confine([this.python, this.helper], { workspaceRoot: sandbox.root, mode: args.sandbox_mode })
        return { argv: confined.argv, sandbox: confinement.describe(confined) }
      })()
    let host
    try {
      host = spawn(plan.argv[0], plan.argv.slice(1), {
        cwd: cwd.absolute,
        env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw new ActionError('UNSUPPORTED', `interactive terminals need ${this.python} on PATH: ${error.message}`)
    }

    const entry = {
      id,
      host,
      pid: null,
      state: 'starting',
      display: argv.join(' '),
      argv,
      cwd: cwd.relative,
      workspaceId,
      sandbox: plan.sandbox,
      label: typeof args.label === 'string' && args.label !== '' ? args.label.slice(0, 120) : undefined,
      cols,
      rows,
      startedAt: this.now(),
      endedAt: null,
      exitCode: undefined,
      signal: undefined,
      lastError: undefined,
      lastOutputAt: null,
      output: new StreamRing(this.limits.output_bytes),
      waiters: [],
      stopRequested: false,
    }
    this.terminals.set(id, entry)

    const ready = new Promise((resolveReady, rejectReady) => {
      let pendingStderr = ''
      // Settlement is tracked separately from entry.state: the error and close
      // handlers mark the terminal failed before reporting, and keying off the
      // state would leave this promise pending forever.
      let settled = false
      const finishStart = outcome => {
        if (settled) return
        settled = true
        if (outcome instanceof Error) { rejectReady(outcome); return }
        if (entry.state === 'starting') entry.state = 'running'
        resolveReady()
      }
      host.stdout.on('data', chunk => {
        entry.output.append(chunk)
        entry.lastOutputAt = this.now()
        this.#settle(entry)
      })
      host.stderr.on('data', chunk => {
        pendingStderr += chunk.toString('utf8')
        const lines = pendingStderr.split('\n')
        pendingStderr = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') continue
          let record
          try { record = JSON.parse(line) } catch { entry.lastError = line.slice(0, 400); continue }
          if (record.event === 'started') {
            entry.pid = typeof record.pid === 'number' ? record.pid : null
            finishStart()
          } else if (record.event === 'exit') {
            entry.exitCode = record.code ?? null
            entry.signal = typeof record.signal === 'number' ? record.signal : undefined
          } else if (record.event === 'error') {
            entry.lastError = String(record.message ?? '').slice(0, 400)
          }
        }
      })
      host.once('error', error => {
        entry.state = 'failed'
        entry.endedAt = this.now()
        entry.lastError = error.message
        this.#settle(entry)
        finishStart(error.code === 'ENOENT'
          ? new ActionError('UNSUPPORTED', `interactive terminals need ${this.python} on PATH (terminal_start is unavailable on this host until it is installed)`)
          : new ActionError('PROCESS_FAILED', `pty host failed: ${error.message}`))
      })
      host.once('close', () => {
        if (entry.state !== 'failed') entry.state = entry.stopRequested ? 'stopped' : 'exited'
        entry.endedAt = this.now()
        this.#settle(entry)
        finishStart(new ActionError('PROCESS_FAILED', entry.lastError ?? 'the pty host exited before the terminal was ready'))
      })
      const timer = setTimeout(() => {
        finishStart(new ActionError('TIMEOUT', `the pty host did not report a live terminal within ${this.limits.start_timeout_ms} ms`))
      }, this.limits.start_timeout_ms)
      timer.unref?.()
    })

    host.stdin.write(`${JSON.stringify({ argv, cwd: cwd.absolute, env: environment, cols, rows })}\n`)
    try {
      await ready
    } catch (error) {
      this.terminals.delete(id)
      try { host.kill('SIGKILL') } catch {}
      throw error
    }
    return this.#record(entry)
  }

  /**
   * terminal_write: type into a live terminal. `input` is sent verbatim,
   * `keys` sends named control keys, and submit=true appends Enter -- the
   * common case of answering a prompt is therefore one call.
   */
  write(args = {}) {
    const entry = this.#requireLive(args.terminal_id)
    let payload = ''
    if (args.input !== undefined) {
      if (typeof args.input !== 'string') fail('INVALID_ARGUMENT', 'input must be a string')
      payload += args.input
    }
    for (const key of args.keys ?? []) {
      const sequence = CONTROL_KEYS[key]
      if (sequence === undefined) fail('INVALID_ARGUMENT', `unknown key ${key}; known keys: ${Object.keys(CONTROL_KEYS).join(', ')}`)
      payload += sequence
    }
    if (args.submit === true) payload += '\r'
    if (payload === '') fail('INVALID_ARGUMENT', 'pass input, keys, or submit=true: there is nothing to send')
    const bytes = Buffer.from(payload, 'utf8')
    if (bytes.length > this.limits.input_max_bytes) {
      fail('INVALID_ARGUMENT', `input is ${bytes.length} bytes; the limit is ${this.limits.input_max_bytes} per call`)
    }
    this.#send(entry, { t: 'i', d: bytes.toString('base64') })
    return { ...this.#record(entry), bytes_written: bytes.length }
  }

  /**
   * terminal_read: cursor-based read of the pty transcript. wait_ms blocks
   * server-side until new bytes arrive (or the program exits), which is what
   * turns "run a command and see the answer" into a single round-trip instead
   * of a poll loop.
   */
  async read(args = {}) {
    const entry = this.#require(args.terminal_id)
    const maxBytes = clampInteger(args.max_bytes, { min: 256, max: this.limits.read_max_bytes, fallback: this.limits.read_default_bytes, label: 'max_bytes' })
    const waitMs = clampInteger(args.wait_ms, { min: 0, max: this.limits.wait_max_ms, fallback: 0, label: 'wait_ms' })
    const from = args.from_offset === undefined
      ? Math.max(entry.output.start, entry.output.end - maxBytes)
      : clampInteger(args.from_offset, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0, label: 'from_offset' })

    // Waiting stops when the program has been quiet for settle_ms, not at the
    // first byte: a command's answer arrives in several writes, and returning
    // after the first one would hand back half a line and force a poll loop.
    const settleMs = clampInteger(args.settle_ms, { min: 0, max: 5000, fallback: 250, label: 'settle_ms' })
    if (waitMs > 0) {
      const deadline = this.now() + waitMs
      for (;;) {
        const hasData = entry.output.end > from
        const quiet = entry.lastOutputAt === null || this.now() - entry.lastOutputAt >= settleMs
        if (hasData && quiet) break
        if (entry.state !== 'running' && hasData) break
        const remaining = deadline - this.now()
        if (remaining <= 0) break
        await this.#awaitChange(entry, hasData ? Math.min(remaining, settleMs) : remaining)
      }
    }

    const page = entry.output.readBuffer(from, maxBytes)
    // Hold back a split codepoint only while more bytes are still coming.
    const usable = page.truncated ? trimPartialUtf8(page.buffer) : page.buffer
    let text = usable.toString('utf8')
    const raw = args.raw === true
    if (!raw) text = renderTerminalText(text)
    return {
      ...this.#record(entry),
      content: text,
      raw,
      offset: page.offset,
      next_offset: page.offset + usable.length,
      dropped_bytes: page.dropped_bytes,
      truncated: page.offset + usable.length < entry.output.end,
      total_bytes: entry.output.end,
      idle: entry.output.end <= from,
    }
  }

  /** terminal_resize: tell the program the window changed (TIOCSWINSZ). */
  resize(args = {}) {
    const entry = this.#requireLive(args.terminal_id)
    entry.cols = clampInteger(args.cols, { min: 20, max: this.limits.max_cols, fallback: entry.cols, label: 'cols' })
    entry.rows = clampInteger(args.rows, { min: 4, max: this.limits.max_rows, fallback: entry.rows, label: 'rows' })
    this.#send(entry, { t: 'r', cols: entry.cols, rows: entry.rows })
    return this.#record(entry)
  }

  /** terminal_signal: signal the foreground process group, like ctrl-C would. */
  signal(args = {}) {
    const entry = this.#requireLive(args.terminal_id)
    const name = String(args.signal ?? 'INT').toUpperCase().replace(/^SIG/, '')
    if (!TERMINAL_SIGNALS.includes(name)) {
      fail('INVALID_ARGUMENT', `signal must be one of ${TERMINAL_SIGNALS.join(', ')}`)
    }
    this.#send(entry, { t: 's', sig: name })
    return { ...this.#record(entry), sent_signal: name }
  }

  /** terminal_stop: kill the pty and its process group, then reap the host. */
  async stop(args = {}) {
    const entry = this.#require(args.terminal_id)
    if (entry.state !== 'running') return { ...this.#record(entry), already_stopped: true }
    const graceMs = clampInteger(args.grace_ms, { min: 0, max: this.limits.stop_grace_max_ms, fallback: this.limits.stop_grace_default_ms, label: 'grace_ms' })
    entry.stopRequested = true
    const closed = new Promise(resolveClosed => entry.host.once('close', () => resolveClosed(true)))
    if (args.force === true) {
      this.#send(entry, { t: 'q' })
    } else {
      this.#send(entry, { t: 's', sig: 'HUP' })
    }
    const finished = await Promise.race([
      closed,
      new Promise(resolveTimeout => { const timer = setTimeout(() => resolveTimeout(false), graceMs); timer.unref?.() }),
    ])
    let escalated = false
    if (!finished) {
      escalated = true
      try { this.#send(entry, { t: 'q' }) } catch {}
      try { entry.host.kill('SIGKILL') } catch {}
      await Promise.race([closed, new Promise(resolveTimeout => { const timer = setTimeout(resolveTimeout, 2000); timer.unref?.() })])
    }
    return { ...this.#record(entry), escalated_to_kill: escalated }
  }

  /** terminal_list: only terminals this bridge opened. */
  list(args = {}) {
    const state = args.state
    if (state !== undefined && !['running', 'exited', 'stopped', 'failed'].includes(state)) {
      fail('INVALID_ARGUMENT', 'state must be running, exited, stopped, or failed')
    }
    const all = [...this.terminals.values()]
      .filter(entry => state === undefined || entry.state === state)
      .filter(entry => args.workspace === undefined || entry.workspaceId === args.workspace)
      .sort((left, right) => right.startedAt - left.startedAt)
    const limit = clampInteger(args.limit, { min: 1, max: 100, fallback: 50, label: 'limit' })
    return {
      terminals: all.slice(0, limit).map(entry => this.#record(entry)),
      total: all.length,
      running: [...this.terminals.values()].filter(entry => entry.state === 'running').length,
      max_terminals: this.limits.max_terminals,
      truncated: all.length > limit,
    }
  }

  /** Live terminals attributed to one workspace; workspace_close checks this. */
  runningIn(workspaceId) {
    return [...this.terminals.values()].filter(entry => entry.state === 'running' && entry.workspaceId === workspaceId).length
  }

  async disposeAll() {
    const live = [...this.terminals.values()].filter(entry => entry.state === 'running')
    for (const entry of live) {
      entry.stopRequested = true
      try { entry.host.kill('SIGKILL') } catch {}
    }
    this.terminals.clear()
    return live.length
  }
}
