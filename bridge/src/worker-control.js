import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fail } from './action-errors.js'

const TEMPORARY_RUNNER = 'Run-Hachimi-Temporary-Fleet.mjs'
const CONTINUATION_RUNNER = 'Continue-Hachimi-After-Tab.mjs'
const STATUS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/

function argument(argv, prefix) {
  const value = Array.isArray(argv) ? argv.find(item => String(item).startsWith(prefix)) : undefined
  return typeof value === 'string' ? value.slice(prefix.length) : ''
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function time(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function hasProgram(process, program) {
  return Array.isArray(process.argv) && process.argv.some(item => basename(String(item)) === program)
}

function runnerProcess(process) {
  return hasProgram(process, TEMPORARY_RUNNER)
}

function continuationProcess(process) {
  return hasProgram(process, CONTINUATION_RUNNER)
}

function cliSubagentProcess(process) {
  return typeof process.label === 'string' && process.label.startsWith('subagent:')
}

function workerProcess(process) {
  return runnerProcess(process) || continuationProcess(process) || cliSubagentProcess(process) || workerLabel(process)
}

function workerLabel(process) {
  const label = String(process?.label || '')
  return /(?:^|[-_ ])w\d+(?:[-_ ]|$)|worker|continuous[-_ ]guard|fastpath/i.test(label)
}

function workerTerminal(terminal) {
  return runnerProcess(terminal) || continuationProcess(terminal) || workerLabel(terminal)
}

function temporaryMode(process) {
  if (process.argv.includes('--normal-chat')) return 'browser-normal'
  if (process.argv.includes('--personalized-temporary')) return 'browser-personalized'
  return 'browser-temporary'
}

function runnerLabel(process) {
  if (typeof process.label === 'string' && process.label.trim() !== '') return process.label.trim()
  const prompt = argument(process.argv, '--prompt-file=')
  return prompt === '' ? 'Temporary fleet' : basename(prompt).replace(/\.[^.]+$/, '').replaceAll(/[-_]+/g, ' ')
}

function statusNameOf(process) {
  const explicit = argument(process.argv, '--status-name=')
  if (explicit !== '') return explicit
  if (!continuationProcess(process)) return ''
  const script = process.argv.findIndex(item => basename(String(item)) === CONTINUATION_RUNNER)
  return script < 0 ? '' : String(process.argv[script + 3] || '')
}

function processRows(processes) {
  return processes.flatMap((process) => {
    if (runnerProcess(process) || continuationProcess(process)) {
      const count = positiveInteger(argument(process.argv, '--fleet-size='))
      return [{
        id: `bridge-process:${process.process_id}`,
        label: runnerLabel(process),
        source: 'browser',
        mode: continuationProcess(process) ? 'browser-supervisor' : temporaryMode(process),
        provider: 'ChatGPT Web',
        status: 'running',
        workerCount: count,
        totalWorkers: count,
        startedAt: time(process.started_at),
        detail: continuationProcess(process)
          ? 'Supervisor chờ tab cũ kết thúc rồi khởi động runner thay thế'
          : count === 1 ? '1 browser worker' : `${count} browser workers`,
        controlKind: 'process',
        controlId: process.process_id,
      }]
    }
    if (cliSubagentProcess(process)) {
      const provider = process.label.slice('subagent:'.length) || 'CLI'
      return [{
        id: `bridge-subagent:${process.process_id}`,
        label: process.label,
        source: 'cli',
        mode: 'cli',
        provider,
        status: 'running',
        workerCount: 1,
        totalWorkers: 1,
        startedAt: time(process.started_at),
        detail: process.cwd,
        controlKind: 'process',
        controlId: process.process_id,
      }]
    }
    if (workerLabel(process)) {
      return [{
        id: `bridge-process:${process.process_id}`,
        label: process.label,
        source: 'local',
        mode: 'process',
        provider: 'Local process',
        status: 'running',
        workerCount: 1,
        totalWorkers: 1,
        startedAt: time(process.started_at),
        detail: process.workspace || process.cwd,
        controlKind: 'process',
        controlId: process.process_id,
      }]
    }
    return []
  })
}

function terminalRows(terminals) {
  return terminals.filter(workerTerminal).map(terminal => {
    const browser = runnerProcess(terminal) || continuationProcess(terminal)
    const count = browser ? positiveInteger(argument(terminal.argv, '--fleet-size=')) : 1
    return {
      id: `bridge-terminal:${terminal.terminal_id}`,
      label: runnerLabel(terminal),
      source: browser ? 'browser' : 'local',
      mode: continuationProcess(terminal) ? 'browser-supervisor' : browser ? temporaryMode(terminal) : 'terminal',
      provider: browser ? 'ChatGPT Web' : 'Local terminal',
      status: 'running',
      workerCount: count,
      totalWorkers: count,
      startedAt: time(terminal.started_at),
      detail: browser
        ? count === 1 ? '1 browser worker' : `${count} browser workers`
        : terminal.workspace || terminal.cwd,
      controlKind: 'terminal',
      controlId: terminal.terminal_id,
    }
  })
}

function fleetRows(fleets) {
  return fleets.filter(fleet => fleet.running).map((fleet) => {
    const active = Math.max(0, Number(fleet.active_workers) || 0)
    const total = positiveInteger(fleet.size)
    return {
      id: `browser-fleet:${fleet.name}`,
      label: fleet.name,
      source: 'fleet',
      mode: fleet.chat_mode === 'temporary' ? 'browser-temporary' : 'browser-normal',
      provider: 'ChatGPT Web',
      status: fleet.last_error && active === 0 ? 'error' : 'running',
      workerCount: active,
      totalWorkers: total,
      startedAt: time(fleet.started_at),
      detail: `${active}/${total} worker hoạt động · vòng ${Number(fleet.round) || 0}`,
      controlKind: 'fleet',
      controlId: fleet.name,
    }
  })
}

/** Read and stop the bridge-owned worker sources shown by the Shiro dashboard. */
export class ShiroWorkerControl {
  constructor({
    fleetManager = null,
    processes,
    terminals = null,
    readFileImpl = readFile,
    readProcessFileImpl = readFile,
    killImpl = process.kill.bind(process),
    sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    if (processes === null || processes === undefined) throw new Error('ShiroWorkerControl requires a ProcessRegistry')
    this.fleetManager = fleetManager
    this.processes = processes
    this.terminals = terminals
    this.readFile = readFileImpl
    this.readProcessFile = readProcessFileImpl
    this.kill = killImpl
    this.sleep = sleepImpl
  }

  // Worker creation is permanently admitted. The old dashboard admission lock
  // was process-local and reset to locked on every backend restart, forcing the
  // operator to open the dashboard before any fleet/subagent could start.
  // Keep these compatibility methods so older dashboard clients do not break,
  // but they no longer have authority to block worker creation.
  spawnLocked() {
    return false
  }

  setSpawnLocked(_locked) {
    return { spawn_locked: false }
  }

  assertSpawnAllowed(_kind, _args = {}) {
    // Intentionally unrestricted. Worker creation is governed by the existing
    // action permissions, concurrency limits and ownership checks instead.
  }

  async snapshot() {
    const processes = this.processes.list({ state: 'running', limit: 100 }).processes
    const terminals = this.terminals === null
      ? []
      : this.terminals.list({ state: 'running', limit: 100 }).terminals
    let fleets = []
    if (this.fleetManager !== null) {
      try { fleets = (await this.fleetManager.list()).fleets }
      catch { fleets = [] }
    }
    return [...processRows(processes), ...terminalRows(terminals), ...fleetRows(fleets)]
      .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
  }

  async stop({ kind, id } = {}) {
    if (kind === 'admission') {
      if (id !== 'lock' && id !== 'unlock') throw new Error('Worker admission control must be lock or unlock')
      const state = this.setSpawnLocked(id === 'lock')
      return {
        stopped: false,
        kind,
        id,
        ...state,
        detail: 'Tạo worker luôn được bật; dashboard lock đã bị vô hiệu hóa.',
      }
    }
    if (kind === 'fleet') {
      if (this.fleetManager === null) throw new Error('Browser fleet manager is unavailable')
      const result = await this.fleetManager.stop(String(id || ''))
      return { stopped: true, kind, id: result.name, detail: 'Đã dừng lịch fleet; tác vụ đang gửi sẽ kết thúc an toàn.' }
    }
    if (kind === 'process') {
      const processId = String(id || '')
      const process = this.processes.status({ process_id: processId, tail_bytes: 0 })
      if (!workerProcess(process)) throw new Error('Process is not a Shiro worker')
      return await this.#stopRecord(process, kind, processId, () => this.processes.stop({ process_id: processId }))
    }
    if (kind === 'terminal') {
      if (this.terminals === null) throw new Error('Terminal worker control is unavailable')
      const terminalId = String(id || '')
      const terminal = this.terminals.list({ state: 'running', limit: 100 }).terminals
        .find(item => item.terminal_id === terminalId)
      if (!terminal || !workerTerminal(terminal)) throw new Error('Terminal is not a Shiro worker')
      return await this.#stopRecord(terminal, kind, terminalId, () => this.terminals.stop({ terminal_id: terminalId }))
    }
    throw new Error('Unknown worker control kind')
  }

  async #stopRecord(record, kind, id, stop) {
    const runner = runnerProcess(record) || continuationProcess(record)
      ? await this.#runnerState(record)
      : { tabs: [], runnerPid: null }
    const stopped = await stop()
    if (runner.runnerPid !== null) await this.#stopRunnerPid(runner.runnerPid)
    const closed = await this.#closeRunnerTabs(runner.tabs)
    return {
      stopped: true,
      kind,
      id,
      tabs_closed: closed,
      detail: runner.tabs.length === 0
        ? 'Đã dừng tiến trình worker.'
        : `Đã dừng tiến trình và đóng ${closed}/${runner.tabs.length} tab worker.`,
      record: stopped,
    }
  }

  async #runnerState(process) {
    if (this.fleetManager === null) return { tabs: [], runnerPid: null }
    const statusName = statusNameOf(process)
    if (!STATUS_NAME.test(statusName)) return { tabs: [], runnerPid: null }
    const statusPath = join(dirname(this.fleetManager.stateDir), statusName)
    try {
      const status = JSON.parse(await this.readFile(statusPath, 'utf8'))
      if (runnerProcess(process) && Number(status.pid) !== Number(process.pid)) return { tabs: [], runnerPid: null }
      const runnerPid = continuationProcess(process)
        ? await this.#verifiedRunnerPid(status.pid, statusName)
        : null
      const tabs = (Array.isArray(status.sessions) ? status.sessions : [])
        .filter(item => Number.isInteger(item?.tabId) && typeof item?.id === 'string' && item.id !== '')
        .map(item => ({ clientId: item.id, tabId: item.tabId }))
      return { tabs, runnerPid }
    } catch {
      return { tabs: [], runnerPid: null }
    }
  }

  async #verifiedRunnerPid(value, statusName) {
    const pid = Number(value)
    if (!Number.isInteger(pid) || pid < 1) return null
    try {
      const raw = await this.readProcessFile(`/proc/${pid}/cmdline`)
      const argv = raw.toString('utf8').split('\0').filter(Boolean)
      return argv.some(item => basename(item) === TEMPORARY_RUNNER)
        && argv.includes(`--status-name=${statusName}`)
        ? pid
        : null
    } catch {
      return null
    }
  }

  async #stopRunnerPid(pid) {
    try { this.kill(pid, 'SIGTERM') } catch (error) {
      if (error?.code !== 'ESRCH') throw error
      return
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.sleep(50)
      try { this.kill(pid, 0) } catch (error) {
        if (error?.code === 'ESRCH') return
        throw error
      }
    }
    try { this.kill(pid, 'SIGKILL') } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }

  async #closeRunnerTabs(targets) {
    if (this.fleetManager === null || targets.length === 0) return 0
    let clients
    try { clients = await this.fleetManager.transport.clients() }
    catch { return 0 }
    let closed = 0
    for (const target of targets) {
      const client = clients.find(item => item.id === target.clientId && item.browserTabId === target.tabId)
      if (!client) continue
      try {
        const url = new URL(String(client.url || ''))
        if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') continue
        await this.fleetManager.transport.close(client.id, client.url)
        closed += 1
      } catch {}
    }
    return closed
  }
}

export const workerControlInternals = {
  argument,
  continuationProcess,
  fleetRows,
  processRows,
  runnerProcess,
  statusNameOf,
  terminalRows,
  workerProcess,
  workerTerminal,
}
