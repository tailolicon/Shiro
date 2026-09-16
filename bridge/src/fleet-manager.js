import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from './action-errors.js'
import {
  assertUnchanged, BUSY_POLICY, recheckOwnedBrowserTab, resolveOwnedBrowserTab,
} from './browser-ownership.js'

const DEFAULT_INTERVAL_MINUTES = 27
const DEFAULT_MAX_SESSION_RUNS = 4
const DEFAULT_LAUNCH_CONCURRENCY = 3
const DEFAULT_VERIFY_ATTEMPTS = 20
const DEFAULT_VERIFY_DELAY_MS = 250
const REQUEST_TIMEOUT_MS = 60_000
// Fleet/browser workers are quota-capped independently of whichever model a
// ChatGPT tab happened to use previously. This is intentionally non-configurable
// at runtime: background work must never consume GPT-6 Pro quota.
const FLEET_CHATGPT_MODEL = 'GPT-5.6 Sol'
const FLEET_CHATGPT_EFFORT = 'xhigh'
const STATE_VERSION = 1
// Bounded per-fleet run history so fleet_runs can answer "what happened on the
// last rounds" without the state file growing without limit.
const MAX_RUN_HISTORY = 50
const FLEET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

function asPositiveNumber(value, fallback, label) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number`)
  return number
}

function asNonNegativeNumber(value, fallback, label) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`)
  return number
}

function asPositiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`)
  }
  return number
}

function normalizeLoopbackUrl(value) {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('relayUrl must be a loopback HTTP URL')
  }
  return url.href.replace(/\/$/, '')
}

export function renderFleetPrompt(template, slot, fleetSize, fleetName = '') {
  return String(template)
    .replaceAll('{{FLEET_SLOT}}', String(slot))
    .replaceAll('{{FLEET_SIZE}}', String(fleetSize))
    .replaceAll('{{FLEET_NAME}}', String(fleetName))
}

function temporaryButtonMarkup(html) {
  const patterns = [
    /<button[^>]*aria-label="(?:Tắt trò chuyện tạm thời|Trò chuyện tạm thời|Chat tạm thời)"[\s\S]{0,3000}?<\/button>/i,
    /<button[^>]*aria-label="(?:(?:Turn off|Disable) )?Temporary(?: Chat)?"[\s\S]{0,3000}?<\/button>/i,
  ]
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern)
    if (match) return match[0]
  }
  return ''
}

function hasActiveTemporaryChatControl(html) {
  const markup = temporaryButtonMarkup(html)
  if (!markup) return false
  const iconClasses = [...markup.matchAll(/<svg[^>]*class="([^"]*)"/gi)].map(match => match[1].split(/\s+/))
  return iconClasses.length >= 2 && iconClasses[0].includes('opacity-0') && !iconClasses[1].includes('opacity-0')
}

function isTemporaryChatUrl(url) {
  try { return new URL(String(url || '')).searchParams.get('temporary-chat') === 'true' } catch { return false }
}

function conversationIdFromUrl(url) {
  try {
    const match = new URL(String(url || '')).pathname.match(/^\/c\/([^/?#]+)/)
    return match ? decodeURIComponent(match[1]) : ''
  } catch {
    return ''
  }
}

function hasExpectedChatMode(html, chatMode, url) {
  if (chatMode === 'temporary') return isTemporaryChatUrl(url) && hasActiveTemporaryChatControl(html)
  return !isTemporaryChatUrl(url) && !hasActiveTemporaryChatControl(html)
}

function hasActiveGenerationControl(html) {
  return /<(?:button|div)[^>]*(?:data-testid="(?:stop-button|stop-generating)[^"]*"|aria-label="(?:Stop generating|Stop response|Dừng tạo|Dừng phản hồi)")[^>]*>/i.test(String(html || ''))
}

function busyEvidence(client, html = '') {
  if (client?.activeRequest?.requestId) return 'active_request'
  if (client?.tabObservation?.generation?.activeTool) return 'active_tool'
  if (client?.tabObservation?.generation?.state === 'active') return 'active_generation'
  if (hasActiveGenerationControl(html)) return 'stop_control'
  return ''
}

function responseDetail(text) {
  try {
    const payload = text ? JSON.parse(text) : {}
    return String(payload.detail || payload.error || payload.message || text || '')
  } catch {
    return String(text || '')
  }
}

export class BrowserFleetTransport {
  constructor({ url, token, fetchImpl = globalThis.fetch, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
    this.url = normalizeLoopbackUrl(url)
    this.token = String(token || '').trim()
    if (!this.token) throw new Error('relayToken is required')
    this.fetch = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
  }

  async request(method, route, body, signal) {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await this.fetch(`${this.url}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: combined,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`ChatGPT browser relay HTTP ${response.status}: ${responseDetail(text) || response.statusText}`)
    try { return text ? JSON.parse(text) : {} } catch { return {} }
  }

  async clients(signal) {
    const payload = await this.request('GET', '/browser/clients', undefined, signal)
    return Array.isArray(payload) ? payload : (Array.isArray(payload.clients) ? payload.clients : [])
  }

  async captureLayout(sourceClientId, signal) {
    return await this.request('POST', '/browser/layout/capture', {
      sourceClientId,
      maxNodes: 15_000,
      maxBytes: 2_000_000,
      timeoutMs: 15_000,
    }, signal)
  }

  /** What this relay build supports; screenshot is optional and probed, never assumed. */
  async capabilities(signal) {
    const payload = await this.request('GET', '/capabilities', undefined, signal)
    return {
      browser: payload?.browser ?? {},
      screenshot: payload?.browser?.screenshot === true,
      navigate: payload?.browser?.navigate === true,
      dom: payload?.browser?.dom === true,
      evaluate: payload?.browser?.evaluate === true,
    }
  }

  /**
   * Capture one tab. The route is intentionally narrow -- a tab the bridge
   * already verified, a format, a bound -- rather than a generic relay call.
   */
  async screenshot(sourceClientId, { format = 'png', fullPage = false, maxWidth, timeoutMs = 20_000 } = {}, signal) {
    return await this.request('POST', '/browser/tabs/screenshot', {
      sourceClientId,
      format,
      fullPage,
      ...(Number.isInteger(maxWidth) ? { maxWidth } : {}),
      timeoutMs,
    }, signal)
  }

  /** Navigate one verified tab. Scheme validation happens on both sides. */
  async navigate(sourceClientId, { url, waitUntil = 'load', timeoutMs = 30_000 } = {}, signal) {
    return await this.request('POST', '/browser/tabs/navigate', {
      sourceClientId,
      url: String(url || ''),
      waitUntil,
      timeoutMs,
    }, signal)
  }

  async evaluate(sourceClientId, options = {}, signal) {
    return await this.request('POST', '/browser/page/evaluate', { sourceClientId, ...options }, signal)
  }

  async queryDom(sourceClientId, options = {}, signal) {
    return await this.request('POST', '/browser/dom/query', { sourceClientId, ...options }, signal)
  }

  async clickElement(sourceClientId, options = {}, signal) {
    return await this.request('POST', '/browser/dom/click', { sourceClientId, ...options }, signal)
  }

  async typeIntoElement(sourceClientId, options = {}, signal) {
    return await this.request('POST', '/browser/dom/type', { sourceClientId, ...options }, signal)
  }

  async open(sourceClientId, chatMode, signal) {
    const payload = await this.request('POST', '/browser/tabs/open', {
      sourceClientId,
      url: chatMode === 'temporary' ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/',
      active: true,
      select: false,
      timeoutMs: 30_000,
    }, signal)
    if (!payload.client?.id || !Number.isInteger(payload.client?.browserTabId)) {
      throw new Error('Relay opened a tab without a stable client identity')
    }
    return payload.client
  }

  async submit(sourceClientId, prompt, signal) {
    return await this.request('POST', '/browser/passive-prompt', {
      sourceClientId,
      message: prompt,
      model: FLEET_CHATGPT_MODEL,
      effort: FLEET_CHATGPT_EFFORT,
      timeoutMs: 60_000,
    }, signal)
  }

  async deleteSession(sourceClientId, sessionId, expectedUrl, signal) {
    return await this.request('POST', '/sessions/delete', {
      sourceClientId,
      sessionId,
      expectedUrl,
      timeoutMs: 30_000,
    }, signal)
  }

  async close(sourceClientId, expectedUrl, signal) {
    return await this.request('POST', '/browser/tabs/close', {
      sourceClientId,
      expectedUrl,
      timeoutMs: 10_000,
    }, signal)
  }
}

function normalizeStartOptions(options = {}) {
  const name = String(options.name || '').trim()
  if (!FLEET_NAME_RE.test(name)) throw new Error('fleet name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/')
  const prompt = String(options.prompt || '')
  if (!prompt.trim()) throw new Error('fleet prompt is required')
  const size = asPositiveInteger(options.size, undefined, 'size', 20)
  const intervalMinutes = asPositiveNumber(options.intervalMinutes, DEFAULT_INTERVAL_MINUTES, 'intervalMinutes')
  const staggerSeconds = asNonNegativeNumber(options.staggerSeconds, 0, 'staggerSeconds')
  const maxSessionRuns = asPositiveInteger(options.maxSessionRuns, DEFAULT_MAX_SESSION_RUNS, 'maxSessionRuns', 100)
  const chatMode = options.chatMode ?? 'normal'
  if (!['normal', 'temporary'].includes(chatMode)) throw new Error('chatMode must be normal or temporary')
  const publicConfig = { name, size, intervalMinutes, chatMode, staggerSeconds, maxSessionRuns, promptHash: hash(prompt) }
  return {
    ...publicConfig,
    prompt,
    configHash: hash(publicConfig),
  }
}

function makeWorkers(name, size) {
  return Array.from({ length: size }, (_, index) => ({
    workerId: `${name}:${index + 1}`,
    slot: index + 1,
    state: 'planned',
    browserClientId: '',
    browserTabId: null,
    runCount: 0,
    lastSubmittedAt: null,
    lastUserTurnKey: '',
    lastError: '',
  }))
}

function activeWorkerCount(workers) {
  return workers.filter(worker => Number.isInteger(worker.browserTabId) && !['closed', 'orphaned'].includes(worker.state)).length
}

async function runBounded(items, limit, task) {
  if (items.length === 0) return []
  let next = 0
  const results = new Array(items.length)
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export class FleetManager {
  constructor({
    transport,
    stateDir,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    launchConcurrency = DEFAULT_LAUNCH_CONCURRENCY,
    verifyAttempts = DEFAULT_VERIFY_ATTEMPTS,
    verifyDelayMs = DEFAULT_VERIFY_DELAY_MS,
    autoRestore = true,
  }) {
    if (!transport) throw new Error('FleetManager transport is required')
    if (!stateDir) throw new Error('FleetManager stateDir is required')
    this.transport = transport
    this.stateDir = stateDir
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.sleep = sleep
    this.launchConcurrency = asPositiveInteger(launchConcurrency, DEFAULT_LAUNCH_CONCURRENCY, 'launchConcurrency', 20)
    this.verifyAttempts = asPositiveInteger(verifyAttempts, DEFAULT_VERIFY_ATTEMPTS, 'verifyAttempts', 100)
    this.verifyDelayMs = asNonNegativeNumber(verifyDelayMs, DEFAULT_VERIFY_DELAY_MS, 'verifyDelayMs')
    this.fleets = new Map()
    this.timers = new Map()
    this.inFlight = new Map()
    this.reservedClientIds = new Set()
    this.reservedTabIds = new Set()
    this.ready = autoRestore ? this.restore() : Promise.resolve()
  }

  isReservedClient(client) {
    return Boolean(client) && (this.reservedClientIds.has(client.id) || this.reservedTabIds.has(Number(client.browserTabId)))
  }

  #reserve(worker) {
    if (worker.browserClientId) this.reservedClientIds.add(worker.browserClientId)
    if (Number.isInteger(worker.browserTabId)) this.reservedTabIds.add(worker.browserTabId)
  }

  #unreserve(worker) {
    if (worker.browserClientId) this.reservedClientIds.delete(worker.browserClientId)
    if (Number.isInteger(worker.browserTabId)) this.reservedTabIds.delete(worker.browserTabId)
  }

  #rebind(worker, client) {
    if (worker.browserClientId && worker.browserClientId !== client.id) this.reservedClientIds.delete(worker.browserClientId)
    worker.browserClientId = String(client.id || '')
    worker.browserTabId = Number.isInteger(client.browserTabId) ? client.browserTabId : worker.browserTabId
    this.#reserve(worker)
  }

  #statePath(name) {
    return join(this.stateDir, `${name}.json`)
  }

  async #persist(fleet) {
    await mkdir(this.stateDir, { recursive: true })
    const target = this.#statePath(fleet.name)
    const temporary = join(this.stateDir, `.${fleet.name}.${process.pid}.${this.now()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(fleet, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  #snapshot(fleet) {
    return {
      name: fleet.name,
      status: fleet.running ? 'running' : 'stopped',
      running: Boolean(fleet.running),
      size: fleet.config.size,
      active_workers: activeWorkerCount(fleet.workers),
      chat_mode: fleet.config.chatMode,
      interval_minutes: fleet.config.intervalMinutes,
      stagger_seconds: fleet.config.staggerSeconds,
      max_session_runs: fleet.config.maxSessionRuns,
      round: fleet.round,
      prompt_hash: fleet.config.promptHash,
      config_hash: fleet.config.configHash,
      started_at: fleet.startedAt,
      updated_at: fleet.updatedAt,
      next_run_at: fleet.nextRunAt,
      last_error: fleet.lastError || undefined,
      recorded_runs: Array.isArray(fleet.history) ? fleet.history.length : 0,
      summary: { ...(fleet.summary || {}) },
      workers: fleet.workers.map(worker => ({
        worker_id: worker.workerId,
        slot: worker.slot,
        state: worker.state,
        browser_client_id: worker.browserClientId || undefined,
        browser_tab_id: Number.isInteger(worker.browserTabId) ? worker.browserTabId : undefined,
        run_count: worker.runCount,
        last_submitted_at: worker.lastSubmittedAt || undefined,
        last_user_turn_key: worker.lastUserTurnKey || undefined,
        last_error: worker.lastError || undefined,
      })),
    }
  }

  async restore() {
    await mkdir(this.stateDir, { recursive: true })
    let names = []
    try { names = await readdir(this.stateDir) } catch { return }
    for (const file of names.filter(name => name.endsWith('.json'))) {
      try {
        const fleet = JSON.parse(await readFile(join(this.stateDir, file), 'utf8'))
        if (fleet?.version !== STATE_VERSION || !FLEET_NAME_RE.test(String(fleet.name || '')) || !fleet.config || !Array.isArray(fleet.workers)) continue
        this.fleets.set(fleet.name, fleet)
        for (const worker of fleet.workers) this.#reserve(worker)
        if (fleet.running) await this.#schedule(fleet, fleet.nextRunAt)
      } catch {}
    }
  }

  async start(options) {
    await this.ready
    const config = normalizeStartOptions(options)
    const existing = this.fleets.get(config.name)
    if (existing) {
      if (existing.config.configHash !== config.configHash) {
        throw new Error(`fleet ${config.name} already exists with different configuration`)
      }
      if (existing.running) return this.#snapshot(existing)
      existing.running = true
      existing.updatedAt = new Date(this.now()).toISOString()
      existing.lastError = ''
      await this.#persist(existing)
      await this.#tick(existing.name, 'restart')
      await this.#schedule(existing)
      return this.#snapshot(existing)
    }

    const timestamp = new Date(this.now()).toISOString()
    const fleet = {
      version: STATE_VERSION,
      name: config.name,
      config,
      running: true,
      round: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
      nextRunAt: null,
      lastError: '',
      summary: {},
      workers: makeWorkers(config.name, config.size),
    }
    this.fleets.set(fleet.name, fleet)
    await this.#persist(fleet)
    await this.#tick(fleet.name, 'initial')
    await this.#schedule(fleet)
    return this.#snapshot(fleet)
  }

  async status(name) {
    await this.ready
    const fleet = this.fleets.get(String(name || ''))
    if (!fleet) throw new Error(`unknown fleet: ${name}`)
    return this.#snapshot(fleet)
  }

  async runNow(name) {
    await this.ready
    const fleet = this.fleets.get(String(name || ''))
    if (!fleet) throw new Error(`unknown fleet: ${name}`)
    return await this.#tick(fleet.name, 'manual')
  }

  async stop(name) {
    await this.ready
    const fleet = this.fleets.get(String(name || ''))
    if (!fleet) return { name: String(name || ''), status: 'stopped', running: false, not_found: true, workers: [], summary: {} }

    fleet.running = false
    fleet.nextRunAt = null
    fleet.updatedAt = new Date(this.now()).toISOString()
    const timer = this.timers.get(fleet.name)
    if (timer !== undefined) this.clearTimer(timer)
    this.timers.delete(fleet.name)
    await this.#persist(fleet)

    const active = this.inFlight.get(fleet.name)
    if (active) await active.catch(() => {})

    let clients = []
    try { clients = await this.transport.clients() } catch (error) { fleet.lastError = error.message }
    const byTab = new Map(clients.filter(client => Number.isInteger(client.browserTabId)).map(client => [client.browserTabId, client]))
    const results = await runBounded(fleet.workers, this.launchConcurrency, async worker => {
      const client = Number.isInteger(worker.browserTabId) ? byTab.get(worker.browserTabId) : null
      if (!client) {
        this.#unreserve(worker)
        worker.state = 'closed'
        worker.browserClientId = ''
        worker.browserTabId = null
        return 'already_closed'
      }
      this.#rebind(worker, client)
      try {
        const inspection = await this.#inspect(client, fleet.config.chatMode)
        if (!inspection.modeOk) {
          worker.state = 'orphaned'
          worker.lastError = 'chat mode could not be verified during stop'
          return 'orphaned'
        }
        if (inspection.busy) {
          worker.state = 'busy_stopped'
          return 'busy'
        }
        await this.transport.close(client.id, client.url)
        this.#unreserve(worker)
        worker.state = 'closed'
        worker.browserClientId = ''
        worker.browserTabId = null
        return 'closed'
      } catch (error) {
        worker.state = 'close_failed'
        worker.lastError = error.message
        return 'close_failed'
      }
    })
    fleet.summary = results.reduce((summary, state) => ({ ...summary, [state]: (summary[state] || 0) + 1 }), {})
    fleet.updatedAt = new Date(this.now()).toISOString()
    await this.#persist(fleet)
    return this.#snapshot(fleet)
  }

  /** fleet_list: every server-owned fleet, newest activity first. */
  async list() {
    await this.ready
    const fleets = [...this.fleets.values()]
      .map(fleet => this.#snapshot(fleet))
      .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')))
    return {
      fleets,
      total: fleets.length,
      running: fleets.filter(fleet => fleet.running).length,
    }
  }

  /**
   * fleet_update: change scheduling policy in place. The prompt, interval,
   * stagger and per-session run budget are the fields a caller actually tunes
   * between rounds; size stays immutable because changing it would silently
   * orphan or duplicate owned browser tabs -- stop and start for that.
   */
  async update(name, changes = {}) {
    await this.ready
    const fleet = this.fleets.get(String(name || ''))
    if (!fleet) throw new Error(`unknown fleet: ${name}`)
    const applied = {}
    const config = { ...fleet.config }
    if (changes.prompt !== undefined) {
      const prompt = String(changes.prompt)
      if (!prompt.trim()) throw new Error('fleet prompt is required')
      config.prompt = prompt
      config.promptHash = hash(prompt)
      applied.prompt = true
    }
    if (changes.intervalMinutes !== undefined) {
      config.intervalMinutes = asPositiveNumber(changes.intervalMinutes, DEFAULT_INTERVAL_MINUTES, 'intervalMinutes')
      applied.interval_minutes = config.intervalMinutes
    }
    if (changes.staggerSeconds !== undefined) {
      config.staggerSeconds = asNonNegativeNumber(changes.staggerSeconds, 0, 'staggerSeconds')
      applied.stagger_seconds = config.staggerSeconds
    }
    if (changes.maxSessionRuns !== undefined) {
      config.maxSessionRuns = asPositiveInteger(changes.maxSessionRuns, DEFAULT_MAX_SESSION_RUNS, 'maxSessionRuns', 100)
      applied.max_session_runs = config.maxSessionRuns
    }
    if (Object.keys(applied).length === 0) throw new Error('fleet_update needs at least one of prompt, intervalMinutes, staggerSeconds, maxSessionRuns')
    const { prompt, configHash, ...publicConfig } = config
    config.configHash = hash(publicConfig)
    fleet.config = config
    fleet.updatedAt = new Date(this.now()).toISOString()
    await this.#persist(fleet)
    // A new interval only takes effect from the next scheduled run: rescheduling
    // from now would silently skip or duplicate the round already in flight.
    if (fleet.running && applied.interval_minutes !== undefined) await this.#schedule(fleet)
    return { ...this.#snapshot(fleet), applied }
  }

  /** fleet_delete: forget a stopped fleet's state and history. */
  async remove(name) {
    await this.ready
    const key = String(name || '')
    const fleet = this.fleets.get(key)
    if (!fleet) return { name: key, deleted: false, not_found: true }
    if (fleet.running) throw new Error(`fleet ${key} is still running; call fleet_stop first so its browser tabs are closed`)
    const timer = this.timers.get(key)
    if (timer !== undefined) this.clearTimer(timer)
    this.timers.delete(key)
    for (const worker of fleet.workers) this.#unreserve(worker)
    this.fleets.delete(key)
    try { await unlink(this.#statePath(key)) } catch {}
    return { name: key, deleted: true, rounds_recorded: Array.isArray(fleet.history) ? fleet.history.length : 0 }
  }

  /** fleet_runs: newest-first page of recorded round outcomes. */
  async runs(name, { limit = 10, cursor = 0 } = {}) {
    await this.ready
    const fleet = this.fleets.get(String(name || ''))
    if (!fleet) throw new Error(`unknown fleet: ${name}`)
    const history = Array.isArray(fleet.history) ? [...fleet.history].reverse() : []
    const start = Number.isInteger(cursor) && cursor > 0 ? cursor : 0
    const page = history.slice(start, start + limit)
    return {
      name: fleet.name,
      runs: page,
      returned: page.length,
      total: history.length,
      cursor: start,
      truncated: start + page.length < history.length,
      next_cursor: start + page.length < history.length ? String(start + page.length) : undefined,
      retained_rounds: MAX_RUN_HISTORY,
    }
  }

  /** fleet_worker_status: one slot in detail, plus its recent outcomes. */
  async workerStatus(name, slot) {
    await this.ready
    const fleet = this.fleets.get(String(name || ''))
    if (!fleet) throw new Error(`unknown fleet: ${name}`)
    const worker = fleet.workers.find(candidate => candidate.slot === slot)
    if (!worker) throw new Error(`fleet ${fleet.name} has no slot ${slot}`)
    const snapshot = this.#snapshot(fleet)
    const history = Array.isArray(fleet.history) ? [...fleet.history].reverse().slice(0, 10) : []
    return {
      name: fleet.name,
      running: fleet.running,
      chat_mode: fleet.config.chatMode,
      max_session_runs: fleet.config.maxSessionRuns,
      next_run_at: fleet.nextRunAt,
      worker: snapshot.workers.find(candidate => candidate.slot === slot),
      recent_runs: history.map(entry => ({
        round: entry.round,
        at: entry.at,
        ...(entry.workers.find(candidate => candidate.slot === slot) ?? {}),
      })),
    }
  }

  /**
   * fleet_worker_recycle: close one owned tab now and reset its run budget, so
   * the next round opens a fresh conversation in the same slot. In normal chat
   * mode the owned ChatGPT conversation is deleted first -- the same verified
   * path the automatic max_session_runs rotation uses, never a blind close.
   */
  async recycleWorker(name, slot, { deleteConversation = true } = {}) {
    await this.ready
    const fleet = this.fleets.get(String(name || ''))
    if (!fleet) throw new Error(`unknown fleet: ${name}`)
    const worker = fleet.workers.find(candidate => candidate.slot === slot)
    if (!worker) throw new Error(`fleet ${fleet.name} has no slot ${slot}`)
    if (this.inFlight.has(fleet.name)) throw new Error(`fleet ${fleet.name} is mid-round; retry once the current round finishes`)

    let outcome = 'already_closed'
    let deletedConversation = false
    if (Number.isInteger(worker.browserTabId)) {
      const clients = await this.transport.clients()
      const client = clients.find(candidate => Number(candidate.browserTabId) === worker.browserTabId)
      if (client) {
        this.#rebind(worker, client)
        const inspection = await this.#inspect(client, fleet.config.chatMode)
        if (!inspection.modeOk) throw new Error('refusing to recycle a tab whose ChatGPT chat mode could not be verified as fleet-owned')
        if (inspection.busy) throw new Error('worker tab is generating a response; retry when it is idle')
        let closeUrl = client.url
        if (deleteConversation && fleet.config.chatMode === 'normal') {
          const sessionId = conversationIdFromUrl(client.url)
          if (!sessionId) throw new Error('refusing recycle cleanup without a concrete owned ChatGPT conversation URL')
          const deletion = await this.transport.deleteSession(client.id, sessionId, client.url)
          if (deletion?.deleted !== true) throw new Error(`recycle could not confirm deletion of owned ChatGPT conversation ${sessionId}`)
          deletedConversation = true
          closeUrl = String(deletion.afterUrl || deletion.url || client.url)
        }
        await this.transport.close(client.id, closeUrl)
        outcome = 'closed'
      }
    }
    this.#unreserve(worker)
    worker.browserClientId = ''
    worker.browserTabId = null
    worker.runCount = 0
    worker.lastUserTurnKey = ''
    worker.state = 'recycled'
    fleet.updatedAt = new Date(this.now()).toISOString()
    await this.#persist(fleet)
    return {
      name: fleet.name,
      slot,
      outcome,
      conversation_deleted: deletedConversation,
      running: fleet.running,
      next_run_at: fleet.nextRunAt,
      worker: this.#snapshot(fleet).workers.find(candidate => candidate.slot === slot),
    }
  }

  /** Slot that owns one browser tab id, or undefined when the tab is foreign. */
  #ownerOf(tabId) {
    for (const fleet of this.fleets.values()) {
      const worker = fleet.workers.find(candidate => candidate.browserTabId === tabId)
      if (worker) return { fleet, worker }
    }
    return undefined
  }

  /**
   * browser_owned_tabs: every live relay client, labelled with the fleet slot
   * that owns it. Foreign tabs are reported so the caller can see them, but
   * they carry owned:false and no fleet association -- the write actions below
   * refuse to touch them.
   */
  async ownedTabs({ includeForeign = false } = {}) {
    await this.ready
    let clients = []
    try { clients = await this.transport.clients() } catch (error) { throw new Error(`browser relay is unreachable: ${error.message}`) }
    const tabs = []
    for (const client of clients) {
      const tabId = Number.isInteger(client.browserTabId) ? client.browserTabId : null
      const owner = tabId === null ? undefined : this.#ownerOf(tabId)
      const owned = owner !== undefined
      if (!owned && !includeForeign) continue
      tabs.push({
        browser_client_id: String(client.id || ''),
        browser_tab_id: tabId,
        url: String(client.url || ''),
        title: typeof client.title === 'string' ? client.title : undefined,
        ready: client.ready === true,
        quarantined: client.quarantined === true,
        owned,
        fleet: owner?.fleet.name,
        slot: owner?.worker.slot,
        worker_id: owner?.worker.workerId,
        worker_state: owner?.worker.state,
        run_count: owner?.worker.runCount,
        chat_mode: owner?.fleet.config.chatMode,
      })
    }
    return {
      tabs,
      total: tabs.length,
      owned: tabs.filter(tab => tab.owned).length,
      includes_foreign: includeForeign,
    }
  }

  /**
   * The one ownership entry point every browser action uses. It delegates to
   * browser-ownership.js so the rules (registry is the authority, foreign is
   * indistinguishable from unknown, per-action busy policy) live in one
   * unit-tested place instead of being restated per action.
   */
  async resolveOwnedTab(tabId, { busyPolicy = BUSY_POLICY.refuse, action = 'this action' } = {}) {
    await this.ready
    return await resolveOwnedBrowserTab({
      tabId,
      findOwner: id => this.#ownerOf(id),
      listClients: () => this.transport.clients(),
      inspect: (client, chatMode) => this.#inspect(client, chatMode),
      busyPolicy,
      action,
    })
  }

  /** Cheap identity re-check, run immediately before a relay call. */
  async recheckOwnedTab(tabId, marker, action = 'this action') {
    const fresh = await recheckOwnedBrowserTab({
      tabId,
      findOwner: id => this.#ownerOf(id),
      listClients: () => this.transport.clients(),
      action,
    })
    return assertUnchanged(marker, fresh, action)
  }

  /** Mutable fleet/worker objects behind a resolved record. */
  #slotOf(record) {
    const owner = this.#ownerOf(record.browser_tab_id)
    if (owner === undefined) fail('CONFLICT', `browser tab ${record.browser_tab_id} lost its Shiro slot mid-action`)
    return owner
  }

  /** browser_tab_close: close one verified idle Shiro-owned tab. */
  async closeOwnedTab(tabId) {
    const { record, marker } = await this.resolveOwnedTab(tabId, { action: 'closing the tab' })
    // Re-check right before the relay call: closing the wrong tab because the
    // id was recycled in between is exactly the failure this prevents.
    await this.recheckOwnedTab(tabId, marker, 'closing the tab')
    const { fleet, worker } = this.#slotOf(record)
    await this.transport.close(record.browser_client_id, record.url)
    this.#unreserve(worker)
    worker.browserClientId = ''
    worker.browserTabId = null
    worker.state = 'closed'
    fleet.updatedAt = new Date(this.now()).toISOString()
    await this.#persist(fleet)
    return { browser_tab_id: tabId, closed: true, fleet: fleet.name, slot: worker.slot, fleet_running: fleet.running }
  }

  /**
   * browser_tab_send_prompt: low-level submit into one verified owned tab. It
   * counts as a run for that slot, so the max_session_runs rotation budget
   * stays honest; fleet_start remains the scheduled, higher-level API.
   */
  async sendPromptToOwnedTab(tabId, prompt) {
    const text = String(prompt || '')
    if (!text.trim()) throw new Error('prompt is required')
    const { record, marker } = await this.resolveOwnedTab(tabId, { action: 'sending a prompt' })
    await this.recheckOwnedTab(tabId, marker, 'sending a prompt')
    const { fleet, worker } = this.#slotOf(record)
    const response = await this.transport.submit(record.browser_client_id, text)
    worker.state = 'submitted'
    worker.runCount += 1
    worker.lastSubmittedAt = new Date(this.now()).toISOString()
    worker.lastUserTurnKey = String(response?.result?.submittedUserTurnKey || response?.submittedUserTurnKey || '')
    worker.lastError = ''
    fleet.updatedAt = new Date(this.now()).toISOString()
    await this.#persist(fleet)
    return {
      browser_tab_id: tabId,
      submitted: true,
      fleet: fleet.name,
      slot: worker.slot,
      run_count: worker.runCount,
      max_session_runs: fleet.config.maxSessionRuns,
      last_user_turn_key: worker.lastUserTurnKey || undefined,
    }
  }

  async dispose() {
    for (const timer of this.timers.values()) this.clearTimer(timer)
    this.timers.clear()
  }

  async #schedule(fleet, requestedAt = null) {
    const existing = this.timers.get(fleet.name)
    if (existing !== undefined) this.clearTimer(existing)
    this.timers.delete(fleet.name)
    if (!fleet.running) return

    const intervalMs = Math.round(fleet.config.intervalMinutes * 60_000)
    const parsed = requestedAt ? Date.parse(requestedAt) : NaN
    const now = this.now()
    const target = Number.isFinite(parsed) && parsed > now ? parsed : now + intervalMs
    fleet.nextRunAt = new Date(target).toISOString()
    fleet.updatedAt = new Date(now).toISOString()
    await this.#persist(fleet)
    const timer = this.setTimer(() => { void this.#scheduledTick(fleet.name) }, Math.max(0, target - now))
    timer?.unref?.()
    this.timers.set(fleet.name, timer)
  }

  async #scheduledTick(name) {
    this.timers.delete(name)
    const fleet = this.fleets.get(name)
    if (!fleet?.running) return
    await this.#tick(name, 'scheduled').catch(error => {
      fleet.lastError = error.message
    })
    if (fleet.running) await this.#schedule(fleet)
  }

  async #tick(name, source) {
    const fleet = this.fleets.get(name)
    if (!fleet) throw new Error(`unknown fleet: ${name}`)
    if (!fleet.running) return this.#snapshot(fleet)
    if (this.inFlight.has(name)) {
      const snapshot = this.#snapshot(fleet)
      snapshot.summary = { ...snapshot.summary, skipped_overlap: (snapshot.summary.skipped_overlap || 0) + 1 }
      return snapshot
    }

    const promise = this.#tickInternal(fleet, source)
    this.inFlight.set(name, promise)
    try {
      await promise
      return this.#snapshot(fleet)
    } finally {
      if (this.inFlight.get(name) === promise) this.inFlight.delete(name)
    }
  }

  async #tickInternal(fleet, source) {
    fleet.round += 1
    fleet.updatedAt = new Date(this.now()).toISOString()
    let clients = await this.transport.clients()
    const control = clients.find(client => client?.ready && client?.quarantined !== true && typeof client.id === 'string' && !this.isReservedClient(client))
      || clients.find(client => client?.ready && client?.quarantined !== true && typeof client.id === 'string')
    const byTab = new Map(clients.filter(client => Number.isInteger(client.browserTabId)).map(client => [client.browserTabId, client]))

    const results = await runBounded(fleet.workers, this.launchConcurrency, async (worker, index) => {
      if (!fleet.running) return 'stopped'
      try {
        if (fleet.config.staggerSeconds > 0 && index > 0) await this.sleep(index * fleet.config.staggerSeconds * 1000)
        let client = Number.isInteger(worker.browserTabId) ? byTab.get(worker.browserTabId) : null
        if (worker.browserTabId && !client) {
          this.#unreserve(worker)
          worker.browserClientId = ''
          worker.browserTabId = null
          worker.state = 'missing'
        }
        if (client) {
          this.#rebind(worker, client)
          const inspection = await this.#inspect(client, fleet.config.chatMode)
          if (!inspection.modeOk) {
            worker.state = 'orphaned'
            worker.lastError = 'worker chat mode could not be verified'
            return 'orphaned'
          }
          if (inspection.busy) {
            worker.state = 'busy'
            return 'busy'
          }
          if (worker.runCount >= fleet.config.maxSessionRuns) {
            let closeUrl = client.url
            if (fleet.config.chatMode === 'normal') {
              const sessionId = conversationIdFromUrl(client.url)
              if (!sessionId) {
                throw new Error('refusing fleet rotation cleanup without a concrete owned ChatGPT conversation URL')
              }
              const deletion = await this.transport.deleteSession(client.id, sessionId, client.url)
              if (deletion?.deleted !== true) {
                throw new Error(`fleet rotation could not confirm deletion of owned ChatGPT conversation ${sessionId}`)
              }
              worker.runCount = 0
              worker.state = 'conversation_deleted'
              closeUrl = String(deletion.afterUrl || deletion.url || client.url)
            } else {
              worker.runCount = 0
            }
            await this.transport.close(client.id, closeUrl)
            this.#unreserve(worker)
            worker.browserClientId = ''
            worker.browserTabId = null
            worker.state = 'rotating'
            client = null
          }
        }

        if (!client) {
          if (!control?.id) {
            worker.state = 'no_control_tab'
            worker.lastError = 'no healthy browser control tab is available'
            return 'no_control_tab'
          }
          client = await this.#launch(worker, fleet, control.id)
          if (!client) return worker.state || 'launch_failed'
        }

        if (!fleet.running) return 'stopped'
        const inspection = await this.#inspect(client, fleet.config.chatMode)
        if (!inspection.modeOk) {
          worker.state = 'orphaned'
          worker.lastError = 'worker chat mode changed before submit'
          return 'orphaned'
        }
        if (inspection.busy) {
          worker.state = 'busy'
          return 'busy'
        }
        const prompt = renderFleetPrompt(fleet.config.prompt, worker.slot, fleet.config.size, fleet.name)
        const response = await this.transport.submit(client.id, prompt)
        worker.state = 'submitted'
        worker.runCount += 1
        worker.lastSubmittedAt = new Date(this.now()).toISOString()
        worker.lastUserTurnKey = String(response?.result?.submittedUserTurnKey || response?.submittedUserTurnKey || '')
        worker.lastError = ''
        return 'submitted'
      } catch (error) {
        worker.state = 'failed'
        worker.lastError = error.message
        return 'failed'
      }
    })

    fleet.summary = results.reduce((summary, state) => ({ ...summary, [state]: (summary[state] || 0) + 1 }), { source })
    fleet.updatedAt = new Date(this.now()).toISOString()
    this.#recordRun(fleet, source, results)
    await this.#persist(fleet)
  }

  #recordRun(fleet, source, results) {
    if (!Array.isArray(fleet.history)) fleet.history = []
    fleet.history.push({
      round: fleet.round,
      source,
      at: new Date(this.now()).toISOString(),
      outcomes: results.reduce((summary, state) => ({ ...summary, [state]: (summary[state] || 0) + 1 }), {}),
      workers: fleet.workers.map((worker, index) => ({
        slot: worker.slot,
        outcome: results[index],
        state: worker.state,
        run_count: worker.runCount,
        browser_tab_id: Number.isInteger(worker.browserTabId) ? worker.browserTabId : undefined,
        last_submitted_at: worker.lastSubmittedAt || undefined,
        last_error: worker.lastError || undefined,
      })),
    })
    if (fleet.history.length > MAX_RUN_HISTORY) fleet.history.splice(0, fleet.history.length - MAX_RUN_HISTORY)
  }

  async #launch(worker, fleet, controlClientId) {
    worker.state = 'launching'
    const client = await this.transport.open(controlClientId, fleet.config.chatMode)
    this.#rebind(worker, client)
    const verified = await this.#verify(client, fleet.config.chatMode)
    if (!verified) {
      worker.state = 'launch_failed'
      worker.lastError = `fresh ${fleet.config.chatMode} chat mode could not be verified`
      try { await this.transport.close(client.id, client.url) } catch {}
      this.#unreserve(worker)
      worker.browserClientId = ''
      worker.browserTabId = null
      return null
    }
    worker.state = 'ready'
    return client
  }

  async #verify(client, chatMode) {
    for (let attempt = 0; attempt < this.verifyAttempts; attempt += 1) {
      const inspection = await this.#inspect(client, chatMode).catch(() => null)
      if (inspection?.modeOk) return true
      if (attempt + 1 < this.verifyAttempts && this.verifyDelayMs > 0) await this.sleep(this.verifyDelayMs)
    }
    return false
  }

  async #inspect(client, chatMode) {
    const capture = await this.transport.captureLayout(client.id)
    const html = String(capture?.html || '')
    return {
      modeOk: hasExpectedChatMode(html, chatMode, client.url),
      busy: busyEvidence(client, html),
    }
  }
}
