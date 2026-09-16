import { spawn } from 'node:child_process'
import { desktopEnvironment } from './desktop-environment.js'
import { randomUUID } from 'node:crypto'
import { ActionError, asActionError, fail } from './action-errors.js'

// Foreground command execution and bridge-owned background processes.
//
// exec_run is the deterministic replacement for "ask Harness to run one
// command": no model turn, no durable session, one MCP round-trip. Commands
// are argv arrays passed to spawn() with shell:false, so a model-supplied
// argument can never become a shell metacharacter -- the same rule the git
// tool already enforces (see git-commands.js). `shell: true` exists for the
// cases that genuinely need a pipeline; it is opt-in per call, reported back
// in the result, and flagged in the tool description.
//
// The working directory is always resolved through Sandbox, so a process can
// only be started inside the fixed project root.

export const EXEC_LIMITS = Object.freeze({
  timeout_default_ms: 120_000,
  timeout_max_ms: 600_000,
  output_default_bytes: 262_144,
  output_max_bytes: 1_048_576,
  process_log_bytes: 1_048_576,
  max_processes: 16,
  max_env_overrides: 64,
  stop_grace_default_ms: 5000,
  stop_grace_max_ms: 60_000,
})

// The base environment is an allowlist, never a copy of process.env: the bridge
// process holds the bridge token, the relay token and whatever the launcher
// exported, and none of that belongs in a child started by a model.
const INHERITED_ENV = Object.freeze([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'USER', 'LOGNAME', 'SHELL', 'TERM',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'USERPROFILE',
])

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function buildEnvironment(overlay = {}, source = process.env) {
  const environment = desktopEnvironment(source)
  for (const name of INHERITED_ENV) {
    const value = source[name]
    if (typeof value === 'string') environment[name] = value
  }
  const entries = Object.entries(overlay ?? {})
  if (entries.length > EXEC_LIMITS.max_env_overrides) {
    fail('INVALID_ARGUMENT', `env accepts at most ${EXEC_LIMITS.max_env_overrides} entries`)
  }
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) fail('INVALID_ARGUMENT', `env name is not a valid variable name: ${name}`)
    if (typeof value !== 'string') fail('INVALID_ARGUMENT', `env.${name} must be a string`)
    if (value.includes('\0')) fail('INVALID_ARGUMENT', `env.${name} must not contain NUL bytes`)
    environment[name] = value
  }
  return environment
}

function normalizeCommand(args) {
  const useShell = args.shell === true
  if (useShell) {
    if (typeof args.command !== 'string' || args.command.trim() === '') {
      fail('INVALID_ARGUMENT', 'shell=true requires a non-empty command string')
    }
    if (args.argv !== undefined) fail('INVALID_ARGUMENT', 'pass either argv (preferred) or command with shell=true, not both')
    return { shell: true, command: args.command, argv: undefined, display: args.command }
  }
  if (!Array.isArray(args.argv) || args.argv.length === 0) {
    fail('INVALID_ARGUMENT', 'argv must be a non-empty array of strings, for example ["node","--test","tests/x.test.js"]')
  }
  if (args.argv.length > 256) fail('INVALID_ARGUMENT', 'argv accepts at most 256 entries')
  for (const item of args.argv) {
    if (typeof item !== 'string') fail('INVALID_ARGUMENT', 'every argv entry must be a string')
    if (item.includes('\0')) fail('INVALID_ARGUMENT', 'argv entries must not contain NUL bytes')
  }
  return { shell: false, command: args.argv[0], argv: args.argv.slice(1), display: args.argv.join(' ') }
}

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

class BoundedOutput {
  constructor(limit) {
    this.limit = limit
    this.parts = []
    this.length = 0
    this.total = 0
    this.truncated = false
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    this.total += buffer.length
    const remaining = this.limit - this.length
    if (remaining <= 0) { this.truncated = true; return }
    this.parts.push(buffer.subarray(0, remaining))
    this.length += Math.min(buffer.length, remaining)
    if (buffer.length > remaining) this.truncated = true
  }

  text() {
    return Buffer.concat(this.parts).toString('utf8')
  }
}


/**
 * The argv actually spawned, once confinement has had its say.
 *
 * A shell line becomes `['bash','-c', line]` because the sandbox seam confines
 * an exact argv, not a shell string -- and because confining the shell is the
 * only way a pipeline's every stage inherits the boundary.
 */
function spawnPlan(command, { confinement, workspaceRoot, mode }) {
  const argv = command.shell ? ['bash', '-c', command.command] : [command.command, ...command.argv]
  if (confinement === null || confinement === undefined) {
    return { argv, shell: false, sandbox: { mode: 'danger-full-access', enforcement: 'none' } }
  }
  const confined = confinement.confine(argv, { workspaceRoot, mode })
  return { argv: confined.argv, shell: false, sandbox: confinement.describe(confined) }
}

function spawnFailure(error, display) {
  if (error?.code === 'ENOENT') {
    return new ActionError('NOT_FOUND', `executable not found: ${display.split(' ')[0]}`)
  }
  if (error?.code === 'EACCES') {
    return new ActionError('PERMISSION_REQUIRED', `executable is not runnable: ${display.split(' ')[0]}`)
  }
  return asActionError(error, 'PROCESS_FAILED', 'spawn')
}

/** exec_run: one bounded foreground command inside the fixed project root. */
export async function runCommand(sandbox, args = {}, { signal, confinement = null } = {}) {
  const command = normalizeCommand(args)
  const cwd = await sandbox.resolveDirectory(args.cwd ?? '.')
  const timeoutMs = clampInteger(args.timeout_ms, { min: 100, max: EXEC_LIMITS.timeout_max_ms, fallback: EXEC_LIMITS.timeout_default_ms, label: 'timeout_ms' })
  const maxOutput = clampInteger(args.max_output_bytes, { min: 1024, max: EXEC_LIMITS.output_max_bytes, fallback: EXEC_LIMITS.output_default_bytes, label: 'max_output_bytes' })
  if (args.stdin !== undefined && typeof args.stdin !== 'string') fail('INVALID_ARGUMENT', 'stdin must be a string')
  const environment = { ...buildEnvironment(args.env), PWD: cwd.absolute }
  // Resolved before the promise so a refusal (no backend for a narrowed
  // profile) rejects as an action error rather than as a spawn failure.
  const plan = spawnPlan(command, { confinement, workspaceRoot: sandbox.root, mode: args.sandbox_mode })
  const startedAt = Date.now()

  return await new Promise((resolveRun, rejectRun) => {
    let child
    try {
      child = spawn(plan.argv[0], plan.argv.slice(1), {
        cwd: cwd.absolute,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: [args.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      rejectRun(spawnFailure(error, command.display))
      return
    }
    const stdout = new BoundedOutput(maxOutput)
    const stderr = new BoundedOutput(maxOutput)
    child.stdout.on('data', chunk => stdout.append(chunk))
    child.stderr.on('data', chunk => stderr.append(chunk))

    let timedOut = false
    let aborted = false
    let settled = false
    const kill = reason => {
      if (settled) return
      if (reason === 'timeout') timedOut = true
      if (reason === 'abort') aborted = true
      child.kill('SIGTERM')
      setTimeout(() => { if (!settled) child.kill('SIGKILL') }, 2000).unref?.()
    }
    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    timer.unref?.()
    const onAbort = () => kill('abort')
    signal?.addEventListener('abort', onAbort, { once: true })

    child.once('error', error => {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      rejectRun(spawnFailure(error, command.display))
    })
    child.once('close', (code, closeSignal) => {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolveRun({
        command: command.display,
        argv: command.shell ? undefined : args.argv,
        shell: command.shell,
        cwd: cwd.relative,
        exit_code: code,
        signal: closeSignal ?? undefined,
        timed_out: timedOut,
        aborted,
        duration_ms: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdout_bytes: stdout.total,
        stderr_bytes: stderr.total,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        max_output_bytes: maxOutput,
        // Reported, not assumed: the caller can see which backend enforced the
        // boundary and how completely, instead of trusting the word "sandbox".
        sandbox: plan.sandbox,
      })
    })
    if (args.stdin !== undefined) child.stdin.end(args.stdin)
  })
}

/**
 * Byte-addressed ring buffer for one process stream. Offsets are absolute
 * counts since the process started, so a client cursor stays meaningful even
 * after the oldest bytes have been dropped -- the reader is told exactly how
 * many bytes it missed instead of silently resuming somewhere else.
 */
export class StreamRing {
  constructor(limit) {
    this.limit = limit
    this.chunks = []
    this.size = 0
    this.start = 0
    this.end = 0
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    this.chunks.push(buffer)
    this.size += buffer.length
    this.end += buffer.length
    while (this.size > this.limit) {
      const head = this.chunks[0]
      const excess = this.size - this.limit
      if (head.length <= excess) {
        this.chunks.shift()
        this.size -= head.length
        this.start += head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.size -= excess
        this.start += excess
      }
    }
  }

  /** Raw bytes for readers that must decode the slice themselves (terminals). */
  readBuffer(from, maxBytes) {
    const begin = Math.max(from, this.start)
    const dropped = Math.max(0, this.start - from)
    if (begin >= this.end) {
      return { offset: begin, buffer: Buffer.alloc(0), next_offset: this.end, dropped_bytes: dropped, truncated: false }
    }
    const joined = Buffer.concat(this.chunks)
    const sliceStart = begin - this.start
    const sliceEnd = Math.min(sliceStart + maxBytes, joined.length)
    const slice = joined.subarray(sliceStart, sliceEnd)
    const next = begin + slice.length
    return { offset: begin, buffer: slice, next_offset: next, dropped_bytes: dropped, truncated: next < this.end }
  }

  read(from, maxBytes) {
    const page = this.readBuffer(from, maxBytes)
    return { ...page, text: page.buffer.toString('utf8'), buffer: undefined }
  }

  tail(maxBytes) {
    return this.read(Math.max(this.start, this.end - maxBytes), maxBytes)
  }
}

/**
 * Registry of long-running processes the bridge itself started. Only these are
 * listable and controllable: the connector never enumerates or signals
 * arbitrary host processes.
 */
export class ProcessRegistry {
  constructor({ sandbox, limits = EXEC_LIMITS, now = () => Date.now(), confinement = null } = {}) {
    this.sandbox = sandbox
    this.confinement = confinement
    this.limits = limits
    this.now = now
    this.processes = new Map()
  }

  #record(entry, { includeTail = false, tailBytes = 4096 } = {}) {
    const snapshot = {
      process_id: entry.id,
      pid: entry.pid,
      state: entry.state,
      command: entry.display,
      argv: entry.argv,
      shell: entry.shell,
      cwd: entry.cwd,
      workspace: entry.workspaceId,
      sandbox: entry.sandbox,
      label: entry.label,
      started_at: new Date(entry.startedAt).toISOString(),
      ended_at: entry.endedAt === null ? undefined : new Date(entry.endedAt).toISOString(),
      duration_ms: (entry.endedAt ?? this.now()) - entry.startedAt,
      exit_code: entry.exitCode,
      signal: entry.signal,
      stdout_bytes: entry.stdout.end,
      stderr_bytes: entry.stderr.end,
      last_error: entry.lastError,
    }
    if (includeTail) {
      snapshot.stdout_tail = entry.stdout.tail(tailBytes).text
      snapshot.stderr_tail = entry.stderr.tail(tailBytes).text
      snapshot.stdout_next_offset = entry.stdout.end
      snapshot.stderr_next_offset = entry.stderr.end
    }
    return snapshot
  }

  #require(processId) {
    const entry = this.processes.get(processId)
    if (entry === undefined) fail('NOT_FOUND', `process ${processId} is not a bridge-owned process`)
    return entry
  }

  /**
   * process_start: launch a background process under a workspace root. The
   * sandbox is passed per call because a bridge may have several workspaces
   * open; omitting it keeps the original fixed-root behaviour.
   */
  async start(args = {}, { sandbox = this.sandbox, workspaceId, confinement = this.confinement } = {}) {
    const running = [...this.processes.values()].filter(entry => entry.state === 'running')
    if (running.length >= this.limits.max_processes) {
      fail('BUSY', `the bridge already owns ${running.length} running processes (limit ${this.limits.max_processes}); stop one with process_stop first`)
    }
    const command = normalizeCommand(args)
    const cwd = await sandbox.resolveDirectory(args.cwd ?? '.')
    const environment = { ...buildEnvironment(args.env), PWD: cwd.absolute }
    const id = randomUUID()
    // A background process outlives the call that started it, so an unconfined
    // one is the longest-lived hole of the two exec paths.
    const plan = spawnPlan(command, { confinement, workspaceRoot: sandbox.root, mode: args.sandbox_mode })
    let child
    try {
      child = spawn(plan.argv[0], plan.argv.slice(1), {
        cwd: cwd.absolute,
        env: environment,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw spawnFailure(error, command.display)
    }
    const entry = {
      id,
      pid: child.pid ?? null,
      child,
      state: 'running',
      display: command.display,
      argv: command.shell ? undefined : args.argv,
      shell: command.shell,
      cwd: cwd.relative,
      workspaceId,
      sandbox: plan.sandbox,
      label: typeof args.label === 'string' && args.label !== '' ? args.label.slice(0, 120) : undefined,
      startedAt: this.now(),
      endedAt: null,
      exitCode: undefined,
      signal: undefined,
      lastError: undefined,
      stdout: new StreamRing(this.limits.process_log_bytes),
      stderr: new StreamRing(this.limits.process_log_bytes),
      stopRequested: false,
    }
    this.processes.set(id, entry)
    child.stdout.on('data', chunk => entry.stdout.append(chunk))
    child.stderr.on('data', chunk => entry.stderr.append(chunk))
    child.once('error', error => {
      entry.state = 'failed'
      entry.lastError = spawnFailure(error, command.display).message
      entry.endedAt = this.now()
    })
    child.once('close', (code, closeSignal) => {
      entry.exitCode = code
      entry.signal = closeSignal ?? undefined
      entry.endedAt = this.now()
      if (entry.state !== 'failed') entry.state = entry.stopRequested ? 'stopped' : 'exited'
    })
    // A spawn that fails (missing executable) emits 'error' on the next tick;
    // surfacing it here turns an immediately dead process into a real error
    // instead of a process_id the caller would have to poll to discover.
    await new Promise(resolveTick => setTimeout(resolveTick, 0))
    if (entry.state === 'failed') {
      this.processes.delete(id)
      throw new ActionError('NOT_FOUND', entry.lastError ?? `process failed to start: ${command.display}`)
    }
    return this.#record(entry)
  }

  /** process_status: state plus a bounded tail of recent output. */
  status(args = {}) {
    const entry = this.#require(args.process_id)
    const tailBytes = clampInteger(args.tail_bytes, { min: 0, max: 65_536, fallback: 4096, label: 'tail_bytes' })
    return this.#record(entry, { includeTail: tailBytes > 0, tailBytes })
  }

  /** process_list: only processes this bridge started. */
  list(args = {}) {
    const state = args.state
    if (state !== undefined && !['running', 'exited', 'stopped', 'failed'].includes(state)) {
      fail('INVALID_ARGUMENT', 'state must be running, exited, stopped, or failed')
    }
    const all = [...this.processes.values()]
      .filter(entry => state === undefined || entry.state === state)
      .sort((left, right) => right.startedAt - left.startedAt)
    const limit = clampInteger(args.limit, { min: 1, max: 100, fallback: 50, label: 'limit' })
    return {
      processes: all.slice(0, limit).map(entry => this.#record(entry)),
      total: all.length,
      running: [...this.processes.values()].filter(entry => entry.state === 'running').length,
      max_processes: this.limits.max_processes,
      truncated: all.length > limit,
    }
  }

  /** process_logs: cursor-based read of one stream. */
  logs(args = {}) {
    const entry = this.#require(args.process_id)
    const stream = args.stream ?? 'stdout'
    if (!['stdout', 'stderr'].includes(stream)) fail('INVALID_ARGUMENT', 'stream must be stdout or stderr')
    const maxBytes = clampInteger(args.max_bytes, { min: 256, max: this.limits.output_max_bytes, fallback: this.limits.output_default_bytes, label: 'max_bytes' })
    const from = clampInteger(args.from_offset, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0, label: 'from_offset' })
    const ring = stream === 'stdout' ? entry.stdout : entry.stderr
    const page = ring.read(from, maxBytes)
    return {
      process_id: entry.id,
      stream,
      state: entry.state,
      content: page.text,
      offset: page.offset,
      next_offset: page.next_offset,
      dropped_bytes: page.dropped_bytes,
      truncated: page.truncated,
      total_bytes: ring.end,
      eof: !page.truncated && entry.state !== 'running',
    }
  }

  /** process_stop: SIGTERM, then SIGKILL after the grace window. */
  async stop(args = {}) {
    const entry = this.#require(args.process_id)
    if (entry.state !== 'running') return { ...this.#record(entry), already_stopped: true }
    const graceMs = clampInteger(args.grace_ms, { min: 0, max: this.limits.stop_grace_max_ms, fallback: this.limits.stop_grace_default_ms, label: 'grace_ms' })
    entry.stopRequested = true
    const exited = new Promise(resolveExit => entry.child.once('close', () => resolveExit(true)))
    entry.child.kill(args.force === true ? 'SIGKILL' : 'SIGTERM')
    const finished = await Promise.race([
      exited,
      new Promise(resolveTimeout => { const timer = setTimeout(() => resolveTimeout(false), graceMs); timer.unref?.() }),
    ])
    let escalated = false
    if (!finished) {
      escalated = true
      entry.child.kill('SIGKILL')
      await Promise.race([exited, new Promise(resolveTimeout => { const timer = setTimeout(resolveTimeout, 2000); timer.unref?.() })])
    }
    return { ...this.#record(entry), escalated_to_sigkill: escalated }
  }

  /** Running processes attributed to one workspace; workspace_close checks this. */
  runningIn(workspaceId) {
    return [...this.processes.values()].filter(entry => entry.state === 'running' && entry.workspaceId === workspaceId).length
  }

  /** Kill everything this bridge owns; called from the plugin dispose hook. */
  async disposeAll() {
    const running = [...this.processes.values()].filter(entry => entry.state === 'running')
    for (const entry of running) {
      entry.stopRequested = true
      try { entry.child.kill('SIGKILL') } catch {}
    }
    this.processes.clear()
    return running.length
  }
}
