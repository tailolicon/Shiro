import { readdirSync, readFileSync } from 'node:fs'
import { cpus, freemem, hostname, loadavg, release, totalmem, type, uptime, userInfo } from 'node:os'
import { join } from 'node:path'
import { fail } from './action-errors.js'
import { redactSecrets } from './redact.js'

// Read-only host inspection. Distinct from process_* which only sees
// bridge-owned children: these two actions report the machine the bridge is
// running on, never send signals, and never open /proc/<pid>/environ.

export const HOST_LIMITS = Object.freeze({
  list_default: 50,
  list_max: 200,
  scan_cap: 4096,
  cmdline_max_chars: 240,
})

function clampInteger(value, { min, max, fallback, label }) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) fail('INVALID_ARGUMENT', `${label} must be an integer`)
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return value
}

function readText(path) {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

function parseStatus(text) {
  const fields = {}
  for (const line of String(text).split('\n')) {
    const split = line.indexOf(':')
    if (split === -1) continue
    fields[line.slice(0, split).trim()] = line.slice(split + 1).trim()
  }
  const uid = Number.parseInt(String(fields.Uid ?? '').split(/\s+/)[0] ?? '', 10)
  const rss = Number.parseInt(String(fields.VmRSS ?? '').split(/\s+/)[0] ?? '', 10)
  const threads = Number.parseInt(fields.Threads ?? '', 10)
  return {
    uid: Number.isInteger(uid) ? uid : undefined,
    rss_kb: Number.isInteger(rss) ? rss : undefined,
    threads: Number.isInteger(threads) ? threads : undefined,
  }
}

function parseStat(text) {
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  if (start < 1 || end <= start) return null
  const pid = Number.parseInt(text.slice(0, start).trim(), 10)
  const name = text.slice(start + 1, end)
  const rest = text.slice(end + 2).trim().split(/\s+/)
  const ppid = Number.parseInt(rest[1] ?? '', 10)
  if (!Number.isInteger(pid) || name === '') return null
  return {
    pid,
    name,
    state: rest[0] || undefined,
    ppid: Number.isInteger(ppid) ? ppid : undefined,
  }
}

function decodeCmdline(buffer, redact) {
  if (buffer === null || buffer.length === 0) return { text: '', kernel: true, truncated: false }
  const raw = buffer.toString('utf8').replace(/\0+$/, '').replaceAll('\0', ' ')
  const redacted = redact(raw)
  const truncated = redacted.length > HOST_LIMITS.cmdline_max_chars
  return {
    text: truncated ? redacted.slice(0, HOST_LIMITS.cmdline_max_chars) : redacted,
    kernel: false,
    truncated,
  }
}

/**
 * host_system_info: identity and resource snapshot of this host.
 * No environment, no mounts, no network addresses.
 */
export function hostSystemInfo() {
  const list = cpus()
  let username
  try { username = userInfo().username } catch { username = undefined }
  return {
    hostname: hostname(),
    platform: process.platform,
    type: type(),
    arch: process.arch,
    release: release(),
    node: process.versions.node,
    cpus: { count: list.length, model: list[0]?.model },
    memory: { total_bytes: totalmem(), free_bytes: freemem() },
    ...(process.platform === 'win32' ? {} : { loadavg: loadavg() }),
    uptime_seconds: Math.floor(uptime()),
    user: {
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      ...(username === undefined ? {} : { username }),
    },
    self: { pid: process.pid, ppid: process.ppid },
  }
}

/**
 * host_process_list: bounded /proc snapshot. Linux-only unless a test injects
 * a fake procRoot. Command lines are redacted and truncated; environ/cwd/exe
 * are never opened.
 */
export function listHostProcesses(args = {}, { procRoot = '/proc', redact = redactSecrets, scanCap = HOST_LIMITS.scan_cap } = {}) {
  if (procRoot === '/proc' && process.platform !== 'linux') {
    fail('UNSUPPORTED', `host_process_list reads /proc and is not available on ${process.platform}`)
  }
  const includeKernel = args.include_kernel === true
  const limit = clampInteger(args.limit, { min: 1, max: HOST_LIMITS.list_max, fallback: HOST_LIMITS.list_default, label: 'limit' })
  const nameFilter = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim().toLowerCase() : ''
  if (nameFilter.length > 80) fail('INVALID_ARGUMENT', 'name must be at most 80 characters')
  let afterPid = 0
  if (args.cursor !== undefined && args.cursor !== null && args.cursor !== '') {
    afterPid = Number(args.cursor)
    if (!Number.isInteger(afterPid) || afterPid < 0) fail('INVALID_ARGUMENT', 'cursor must be a process id returned as next_cursor')
  }
  let onlyPid
  if (args.pid !== undefined && args.pid !== null) {
    onlyPid = clampInteger(args.pid, { min: 1, max: 4_000_000_000, fallback: 1, label: 'pid' })
  }

  let names
  try {
    names = readdirSync(procRoot)
  } catch (error) {
    fail('UNSUPPORTED', `host process list is unavailable: ${error.message}`)
  }

  const matches = []
  let scanned = 0
  let kernelOmitted = 0
  let scanCapped = false
  let lastScannedPid = afterPid
  const pids = names
    .map(name => Number.parseInt(name, 10))
    .filter(pid => Number.isInteger(pid) && pid > 0)
    .sort((left, right) => left - right)

  for (const pid of pids) {
    if (scanned >= scanCap) { scanCapped = true; break }
    if (pid <= afterPid) continue
    if (onlyPid !== undefined && pid !== onlyPid) continue
    scanned += 1
    lastScannedPid = pid
    const dir = join(procRoot, String(pid))
    const statRaw = readText(join(dir, 'stat'))
    if (statRaw === null) continue
    const parsed = parseStat(statRaw.toString('utf8'))
    if (parsed === null) continue
    const cmdline = decodeCmdline(readText(join(dir, 'cmdline')), redact)
    if (cmdline.kernel && !includeKernel) {
      kernelOmitted += 1
      continue
    }
    if (nameFilter !== '' && !parsed.name.toLowerCase().includes(nameFilter) && !cmdline.text.toLowerCase().includes(nameFilter)) continue
    const status = parseStatus(readText(join(dir, 'status'))?.toString('utf8') ?? '')
    matches.push({
      pid: parsed.pid,
      ppid: parsed.ppid,
      name: parsed.name,
      state: parsed.state,
      uid: status.uid,
      rss_kb: status.rss_kb,
      threads: status.threads,
      cmdline: cmdline.text,
      ...(cmdline.truncated ? { cmdline_truncated: true } : {}),
      ...(cmdline.kernel ? { kernel: true } : {}),
    })
  }

  const page = matches.slice(0, limit)
  const truncated = matches.length > limit || scanCapped
  const cursorPid = matches.length > limit ? page[page.length - 1]?.pid : lastScannedPid
  return {
    processes: page,
    total: matches.length,
    scanned,
    kernel_threads_omitted: includeKernel ? 0 : kernelOmitted,
    truncated,
    ...(truncated && cursorPid ? { next_cursor: String(cursorPid) } : {}),
  }
}

const HOST_PROCESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pid: { type: 'integer', required: true },
    ppid: { type: 'integer' },
    name: { type: 'string', required: true },
    state: { type: 'string' },
    uid: { type: 'integer' },
    rss_kb: { type: 'integer' },
    threads: { type: 'integer' },
    cmdline: { type: 'string', required: true },
    cmdline_truncated: { type: 'boolean' },
    kernel: { type: 'boolean' },
  },
}

export const HOST_TOOLS = [
  {
    name: 'host_system_info',
    mutating: false,
    description: 'Read-only snapshot of this host: hostname, OS, architecture, CPU count/model, memory, load, uptime, and the bridge process ids. Never dumps environment variables, mounts, or network addresses.',
    parameters: {},
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hostname: { type: 'string', required: true },
        platform: { type: 'string', required: true },
        type: { type: 'string', required: true },
        arch: { type: 'string', required: true },
        release: { type: 'string' },
        node: { type: 'string', required: true },
        cpus: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: { count: { type: 'integer', required: true }, model: { type: 'string' } },
        },
        memory: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: { total_bytes: { type: 'integer', required: true }, free_bytes: { type: 'integer', required: true } },
        },
        loadavg: { type: 'array', items: { type: 'number' } },
        uptime_seconds: { type: 'integer', required: true },
        user: {
          type: 'object',
          additionalProperties: false,
          properties: { uid: { type: 'integer' }, gid: { type: 'integer' }, username: { type: 'string' } },
        },
        self: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: { pid: { type: 'integer', required: true }, ppid: { type: 'integer' } },
        },
      },
    },
    execute: () => hostSystemInfo(),
    presentTitle: () => 'host system info',
  },
  {
    name: 'host_process_list',
    mutating: false,
    description: `Read-only list of host processes from /proc. Distinct from process_list, which only shows processes this bridge started. Command lines are secret-redacted and truncated to ${HOST_LIMITS.cmdline_max_chars} characters. Never opens environ, cwd, or exe. Does not send signals.`,
    parameters: {
      name: { type: 'string', description: 'Case-insensitive substring match against the process name or command line.' },
      pid: { type: 'number', description: 'Return only this process id.' },
      limit: { type: 'number', description: `Maximum rows to return (1-${HOST_LIMITS.list_max}, default ${HOST_LIMITS.list_default}).` },
      cursor: { type: 'string', description: 'Resume after this process id from a previous next_cursor.' },
      include_kernel: { type: 'boolean', description: 'Include kernel threads (empty cmdline). Default false.' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        processes: { type: 'array', required: true, items: HOST_PROCESS_SCHEMA },
        total: { type: 'integer', required: true },
        scanned: { type: 'integer' },
        kernel_threads_omitted: { type: 'integer' },
        truncated: { type: 'boolean', required: true },
        next_cursor: { type: 'string' },
      },
    },
    execute: args => listHostProcesses(args),
    presentTitle: args => args?.name ? `host processes matching ${args.name}` : 'host process list',
  },
]
