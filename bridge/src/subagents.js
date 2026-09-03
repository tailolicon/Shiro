import { spawn } from 'node:child_process'
import { fail } from './action-errors.js'
import { SUBAGENT_ADAPTERS } from './subagent-adapters.js'

// Dispatching a real coding-agent CLI as a sub-agent of the connector.
//
// This is built ON TOP of ProcessRegistry rather than beside it: a subagent IS
// a bridge-owned background process by every measure that already matters --
// it needs a PID, a stdout/stderr ring buffer, confinement, a stop signal, a
// process-count ceiling shared with everything else the bridge spawns. Layering
// on top means all of that is inherited for free, and a subagent shows up in
// process_list too, which is honest: it is one.
//
// What this layer adds is CLI-specific: choosing the right adapter, building
// its argv, and -- once the process has produced output -- parsing that output
// into a session id (for resuming) and a plain-text result, instead of leaving
// the caller to read raw JSON or NDJSON off a log tail.
//
// A background job model on purpose, not a blocking one: each of these CLIs
// can run for many minutes on a real task, and ChatGPT itself is cut off by
// its platform every ~25 minutes (see continuation.js). Blocking one MCP call
// on a subagent's full run would tie the two limits together for no reason.
// subagent_start returns immediately; subagent_status/subagent_log poll.

const PROBE_TIMEOUT_MS = 10_000
const DEFAULT_LOG_BYTES = 1_048_576

function isSubagentLabel(label) {
  return typeof label === 'string' && label.startsWith('subagent:')
}

export class SubagentRegistry {
  constructor({ processes, spawnImpl = spawn, adapters = SUBAGENT_ADAPTERS } = {}) {
    if (processes === null || processes === undefined) throw new Error('SubagentRegistry requires a ProcessRegistry')
    this.processes = processes
    this.spawn = spawnImpl
    // Overridable so tests can point "codex" at a trivial fixture script
    // instead of the real CLI, while exercising the exact same registry logic.
    this.adapters = adapters
    // process_id -> {agent, unverified}. ProcessRegistry owns the process
    // itself; this map is just enough to know a given process_id IS a
    // subagent (not some unrelated exec_run/process_start job) and which
    // adapter parses its output.
    this.subagents = new Map()
  }

  #meta(processId) {
    const meta = this.subagents.get(String(processId ?? ''))
    if (meta === undefined) fail('NOT_FOUND', `${processId} is not a subagent this bridge started (or it has been forgotten since restart)`)
    return meta
  }

  #adapterFor(name) {
    const adapter = this.adapters[String(name ?? '')]
    if (adapter === undefined) fail('INVALID_ARGUMENT', `agent must be one of ${Object.keys(this.adapters).join(', ')}, got "${name}"`)
    return adapter
  }

  async start(args = {}, runtime = {}) {
    const adapter = this.#adapterFor(args.agent)
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (prompt === '') fail('INVALID_ARGUMENT', 'prompt is required')
    if (prompt.length > 50_000) fail('INVALID_ARGUMENT', 'prompt is at most 50000 characters')

    let resumeFrom = typeof args.resume_from === 'string' && args.resume_from.trim() !== '' ? args.resume_from.trim() : undefined
    // A caller may pass either a raw session/thread id, or the process_id of
    // an earlier subagent_start -- resolved to that run's own session id, so
    // "continue what you just did" does not require the caller to have parsed
    // the transcript itself first.
    if (resumeFrom !== undefined && this.subagents.has(resumeFrom)) {
      const prior = await this.#transcript(resumeFrom)
      if (prior.threadId === undefined) {
        fail('CONFLICT', `${resumeFrom} has no session id yet (still running, or the CLI never reported one); check subagent_status first`)
      }
      resumeFrom = prior.threadId
    }

    const argv = adapter.buildArgv({
      prompt,
      resumeFrom,
      model: typeof args.model === 'string' ? args.model : undefined,
      permissionMode: typeof args.permission_mode === 'string' ? args.permission_mode : undefined,
      sandbox: typeof args.sandbox === 'string' ? args.sandbox : undefined,
      dangerouslySkipPermissions: args.dangerously_skip_permissions === true,
    })

    const record = await this.processes.start(
      // buildArgv returns the CLI's own arguments only; the binary itself is
      // prepended here, once, so every adapter's buildArgv stays free of
      // repeating its own binary name.
      { argv: [adapter.binary, ...argv], cwd: args.path ?? '.', label: `subagent:${adapter.id}` },
      runtime,
    )
    this.subagents.set(record.process_id, { agent: adapter.id, unverified: adapter.unverified })
    return { ...record, agent: adapter.id, unverified: adapter.unverified, resumed_from: resumeFrom }
  }

  async #transcript(processId) {
    const adapter = this.adapters[this.#meta(processId).agent]
    const log = this.processes.logs({ process_id: processId, stream: 'stdout', max_bytes: DEFAULT_LOG_BYTES, from_offset: 0 })
    return { ...adapter.parseTranscript(log.content), state: log.state }
  }

  async status(args = {}) {
    const meta = this.#meta(args.process_id)
    const snapshot = this.processes.status({ process_id: args.process_id, tail_bytes: 0 })
    const transcript = await this.#transcript(args.process_id)
    return {
      process_id: snapshot.process_id,
      agent: meta.agent,
      unverified: meta.unverified,
      state: snapshot.state,
      pid: snapshot.pid,
      cwd: snapshot.cwd,
      workspace: snapshot.workspace,
      started_at: snapshot.started_at,
      ended_at: snapshot.ended_at,
      duration_ms: snapshot.duration_ms,
      exit_code: snapshot.exit_code,
      sandbox: snapshot.sandbox,
      turn_done: transcript.done === true,
      turn_success: transcript.success,
      thread_id: transcript.threadId,
      message: transcript.message,
      usage: transcript.usage,
      warnings: transcript.warnings,
      unverified_shape: transcript.unverifiedShape,
    }
  }

  async log(args = {}) {
    this.#meta(args.process_id) // NOT_FOUND before touching the process log at all
    const page = this.processes.logs({
      process_id: args.process_id,
      stream: args.stream ?? 'stdout',
      max_bytes: args.max_bytes,
      from_offset: args.from_offset,
    })
    return page
  }

  async stop(args = {}) {
    const meta = this.#meta(args.process_id)
    const stopped = await this.processes.stop({ process_id: args.process_id, grace_ms: args.grace_ms, force: args.force })
    return { ...stopped, agent: meta.agent }
  }

  list(args = {}) {
    const all = this.processes.list({ state: args.state, limit: 100 })
    const subagents = all.processes
      .filter(entry => isSubagentLabel(entry.label))
      .map(entry => ({ ...entry, agent: this.subagents.get(entry.process_id)?.agent }))
    const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 50
    return {
      subagents: subagents.slice(0, limit),
      total: subagents.length,
      truncated: subagents.length > limit,
    }
  }

  /**
   * Read-only discovery: is each CLI installed, and does it look signed in?
   * Never spawns through ProcessRegistry -- this is a fast, short-lived probe,
   * not a bridge-owned job, and must not count against the process ceiling or
   * show up in process_list.
   */
  async providers() {
    const rows = await Promise.all(Object.values(this.adapters).map(adapter => this.#probe(adapter)))
    return { providers: rows }
  }

  async #probe(adapter) {
    const version = await this.#run(adapter.binary, ['--version'])
    if (!version.ok) {
      return { agent: adapter.id, label: adapter.label, installed: false, authenticated: null, unverified: adapter.unverified }
    }
    const auth = await this.#run(adapter.binary, adapter.probeAuthArgv)
    // classifyAuth is asked regardless of exit code: a CLI that is not signed
    // in is exactly the case most likely to exit non-zero (antigravity does;
    // grok does not), so gating the classifier on success would read "signed
    // out" as "unknown" for some CLIs and correctly for others. Each
    // classifier already returns null itself when nothing recognizable is in
    // the text, so there is nothing this layer needs the exit code to decide.
    const authenticated = adapter.classifyAuth(auth.stdout, auth.stderr)
    return {
      agent: adapter.id,
      label: adapter.label,
      installed: true,
      version: version.stdout.trim().slice(0, 80) || undefined,
      // null, not false: an auth probe that could not be classified is
      // "unknown", and reporting it as a confident no would be a guess.
      authenticated,
      unverified: adapter.unverified,
    }
  }

  #run(binary, argv) {
    return new Promise(resolveRun => {
      let child
      try {
        child = this.spawn(binary, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        resolveRun({ ok: false, stdout: '', stderr: '' })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => { if (!settled) child.kill() }, PROBE_TIMEOUT_MS)
      timer.unref?.()
      child.stdout?.on('data', chunk => { stdout += chunk })
      child.stderr?.on('data', chunk => { stderr += chunk })
      child.once('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolveRun({ ok: false, stdout, stderr }) } })
      child.once('close', code => { if (!settled) { settled = true; clearTimeout(timer); resolveRun({ ok: code === 0, stdout, stderr }) } })
    })
  }
}
