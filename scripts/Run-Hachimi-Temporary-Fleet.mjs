#!/usr/bin/env node

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_FLEET_SIZE = 5
export const DEFAULT_INTERVAL_MINUTES = 27
export const DEFAULT_STAGGER_SECONDS = 8
// Zero means keep running until the process is explicitly stopped.
export const DEFAULT_MAX_ROUNDS = 0
export const DEFAULT_MAX_SESSION_RUNS = 4
export const DEFAULT_MAX_LAUNCH_ATTEMPTS = 20
const MIN_FREE_MEMORY_BYTES = 2 * 1024 ** 3
const MIN_FREE_MEMORY_RATIO = 0.15
const REQUEST_TIMEOUT_MS = 75_000
const BUSY_RETRY_MS = 5 * 60_000
const NEW_TAB_SETTLE_MS = 12_000
const SAME_TAB_RETRY_MS = 5_000
const ROUND_CLEANUP_POLL_MS = 5_000
const ROUND_CLEANUP_TIMEOUT_MS = 27 * 60_000

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDirectory, '..')
const runtimeRoot = path.resolve(repoRoot, '..', '.ShiroRuntime')
const runtimeEnvPath = path.join(runtimeRoot, 'state', 'chatgpt-relay.env')
const statusPath = path.join(runtimeRoot, 'state', 'hachimi-temporary-fleet-status.json')
const consoleScriptPath = path.join(scriptDirectory, 'ChatGPT-Temporary-Curation-30m.console.js')

function parseEnvFile(text = '') {
  const result = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return result
}

export function extractEmbeddedPrompt(script) {
  const marker = 'const PROMPT = String.raw`'
  const start = script.indexOf(marker)
  if (start < 0) throw new Error('Embedded Hachimi prompt marker is missing')
  const contentStart = start + marker.length
  const contentEnd = script.indexOf('`;\n\n  const INTERVAL_MS', contentStart)
  if (contentEnd < 0) throw new Error('Embedded Hachimi prompt terminator is missing')
  return script.slice(contentStart, contentEnd)
}

export function promptFileArgument(args = []) {
  const prefix = '--prompt-file='
  const value = args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || ''
  return value.trim()
}

export function fleetSizeArgument(args = [], fallback = DEFAULT_FLEET_SIZE) {
  const prefix = '--fleet-size='
  const raw = args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || ''
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error('--fleet-size must be an integer from 1 to 20')
  }
  return value
}

export function intervalMinutesArgument(args = [], fallback = DEFAULT_INTERVAL_MINUTES) {
  const prefix = '--interval-minutes='
  const raw = args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || ''
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value > 10_080) {
    throw new Error('--interval-minutes must be a positive number up to 10080')
  }
  return value
}

export function maxSessionRunsArgument(args = [], fallback = DEFAULT_MAX_SESSION_RUNS) {
  const prefix = '--max-session-runs='
  const raw = args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || ''
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error('--max-session-runs must be an integer from 1 to 1000')
  }
  return value
}

export function statusNameArgument(args = [], fallback = path.basename(statusPath)) {
  const prefix = '--status-name='
  const value = args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length).trim() || ''
  if (!value) return fallback
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(value)) {
    throw new Error('--status-name must be a simple .json filename')
  }
  return value
}

export function renderFleetPrompt(template, slot, fleetSize = DEFAULT_FLEET_SIZE) {
  return String(template)
    .replaceAll('{{FLEET_SLOT}}', String(slot))
    .replaceAll('{{FLEET_SIZE}}', String(fleetSize))
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

/** Current ChatGPT Web renders two icons; Temporary is active when the first is hidden and the second is visible. */
export function hasActiveTemporaryChatControl(html) {
  const markup = temporaryButtonMarkup(html)
  if (!markup) return false
  const iconClasses = [...markup.matchAll(/<svg[^>]*class="([^"]*)"/gi)].map((match) => match[1].split(/\s+/))
  if (iconClasses.length < 2) return false
  return iconClasses[0].includes('opacity-0') && !iconClasses[1].includes('opacity-0')
}

export function hasInactiveTemporaryChatControl(html) {
  const markup = temporaryButtonMarkup(html)
  if (!markup) return false
  const iconClasses = [...markup.matchAll(/<svg[^>]*class="([^"]*)"/gi)].map((match) => match[1].split(/\s+/))
  if (iconClasses.length < 2) return false
  return !iconClasses[0].includes('opacity-0') && iconClasses[1].includes('opacity-0')
}

export function isTemporaryChatUrl(url) {
  try {
    return new URL(String(url || '')).searchParams.get('temporary-chat') === 'true'
  } catch {
    return false
  }
}

export function hasPersonalizedTemporaryChatControl(html) {
  return /<button[^>]*aria-label="Personalized"[^>]*>/i.test(String(html || ''))
}

export function hasAuthenticatedChatLayout(html) {
  const text = String(html || '')
  return /data-testid="accounts-profile-button"/i.test(text)
    && !/aria-label="Log in or sign up"/i.test(text)
}

export function hasExpectedChatMode(html, temporaryOnly = true, url = '', personalizedTemporary = false) {
  if (temporaryOnly) {
    const tempUrl = isTemporaryChatUrl(url)
    const explicitControl = hasActiveTemporaryChatControl(html)
    // Relay layout sanitization can redact Temporary's aria-label while preserving
    // the authenticated account marker and the authoritative temporary-chat URL.
    const sanitizedControlFallback = tempUrl && !temporaryButtonMarkup(html) && hasAuthenticatedChatLayout(html)
    const temporary = tempUrl && (explicitControl || sanitizedControlFallback)
    return temporary && (!personalizedTemporary || hasPersonalizedTemporaryChatControl(html))
  }
  // Existing normal conversations may omit the Temporary toggle entirely.
  // Their persistent /c/... URL plus the absence of an active Temporary
  // control is the stable fail-closed evidence for normal mode.
  return !isTemporaryChatUrl(url) && !hasActiveTemporaryChatControl(html)
}

export function hasActiveGenerationControl(html) {
  return /<(?:button|div)[^>]*(?:data-testid="(?:stop-button|stop-generating)[^"]*"|aria-label="(?:Stop generating|Stop response|Dừng tạo|Dừng phản hồi)")[^>]*>/i.test(String(html || ''))
}

export function hasSendControl(html) {
  return /<button[^>]*(?:data-testid="(?:send-button|composer-submit-button)"|class="[^"]*composer-submit-button[^"]*"|aria-label="(?:Send prompt|Send message|Send|Gửi prompt|Gửi tin nhắn|Gửi câu lệnh|Gửi|Start Voice)")[^>]*>/i.test(String(html || ''))
}

export function hasSettledObservedProgress(client) {
  if (!isGenerating(client)) return false
  if (client?.activeRequest?.requestId) return false
  const generation = client?.tabObservation?.generation || {}
  if (generation.activeTool || generation.stopVisible === true) return false
  const output = client?.tabObservation?.output || {}
  const items = Array.isArray(output.progressItems) ? output.progressItems : []
  if (output.finalMessage !== true || !String(output.answer || '').trim() || !items.length) return false
  return items.every((item) => {
    if (item?.active === true) return false
    const state = String(item?.state || '').toLowerCase()
    return ['completed', 'done', 'stopped'].includes(state)
  })
}

export function cleanupBusyEvidence(client, html) {
  if (client?.activeRequest?.requestId) return 'active_request'
  if (client?.tabObservation?.generation?.activeTool) return 'active_tool'
  if (hasActiveGenerationControl(html)) return 'stop_control'
  // ChatGPT Web can leave its streaming marker stuck on after the turn has
  // actually ended. The relay then reports generation=active forever even
  // though there is no request/tool/stop button and every observed progress
  // item is complete. Treat that exact evidence as settled instead of
  // deadlocking cohort cleanup.
  if (hasSettledObservedProgress(client)) return ''
  if (isGenerating(client)
    && !(client?.tabObservation?.output?.finalMessage === true && hasSendControl(html))) {
    return 'unsettled_generation'
  }
  return ''
}

export function selectFleetClients(clients, fleetSize = DEFAULT_FLEET_SIZE) {
  const candidates = [...clients]
    .filter((client) => client?.ready && client?.compatible !== false && !client?.quarantined)
    .sort((left, right) => {
      const leftActive = left?.tabObservation?.generation?.state === 'active' ? 1 : 0
      const rightActive = right?.tabObservation?.generation?.state === 'active' ? 1 : 0
      return leftActive - rightActive || Number(left.browserTabId || 0) - Number(right.browserTabId || 0)
    })
  return candidates.slice(0, fleetSize)
}

export function selectStatusFleet(status) {
  const candidates = Array.isArray(status?.sessions)
    ? status.sessions
    : (Array.isArray(status?.cleanup) ? status.cleanup : [])
  return candidates.filter((item) => Number.isInteger(item?.tabId)
    && item?.id
    && !['closed', 'already_closed'].includes(item?.state))
}

export function sessionRunCount(session) {
  const value = Number(session?.runCount)
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_SESSION_RUNS
}

export function fleetNeedsRotation(fleet, maxSessionRuns = DEFAULT_MAX_SESSION_RUNS) {
  return fleet.some((session) => sessionRunCount(session) >= maxSessionRuns)
}

export function hasRemainingRounds(round, maxRounds = DEFAULT_MAX_ROUNDS) {
  return maxRounds <= 0 || round < maxRounds
}

/** Never open more browser tabs in a round than the requested worker slots. */
export function launchOpenAttemptBudget(fleetSize, retained = 0) {
  return Math.min(DEFAULT_MAX_LAUNCH_ATTEMPTS, Math.max(0, fleetSize - retained))
}

/** Relay contention/readiness failures are retried in the same tab, never by opening another tab. */
export function isRetryableLaunchError(error) {
  return /Relay HTTP (?:423|5\d\d):/i.test(String(error?.message || error || ''))
}

/** Milliseconds a recurring fleet must wait before its next round. */
export function nextRoundDelayMs(nextRunAtMs, now = Date.now()) {
  const target = Number(nextRunAtMs)
  return Number.isFinite(target) ? Math.max(0, target - now) : 0
}

function memoryRisk() {
  const total = os.totalmem()
  const free = os.freemem()
  const ratio = total > 0 ? free / total : 0
  if (free < MIN_FREE_MEMORY_BYTES || ratio < MIN_FREE_MEMORY_RATIO) {
    return `free system memory is ${Math.round(free / 1024 / 1024)} MiB (${Math.round(ratio * 100)}%)`
  }
  return ''
}

function delay(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

class RelayClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '')
    this.token = token
    this.fetchImpl = fetchImpl
  }

  async request(method, route, body, signal) {
    const response = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    const text = await response.text()
    let payload = {}
    try { payload = text ? JSON.parse(text) : {} } catch { payload = { detail: text } }
    if (!response.ok) throw new Error(`Relay HTTP ${response.status}: ${payload.detail || payload.error || response.statusText}`)
    return payload
  }

  async clients(signal) {
    const payload = await this.request('GET', '/browser/clients', null, signal)
    return Array.isArray(payload.clients) ? payload.clients : []
  }

  async captureLayout(sourceClientId, signal) {
    const payload = await this.request('POST', '/browser/layout/capture', {
      sourceClientId,
      maxNodes: 15_000,
      maxBytes: 2_000_000,
    }, signal)
    return { html: String(payload.html || ''), metadata: payload.metadata || {} }
  }

  async queryDom(sourceClientId, selector, signal) {
    return await this.request('POST', '/browser/dom/query', {
      sourceClientId,
      selector,
      maxResults: 200,
      maxTextBytes: 2_000,
      visibleOnly: true,
      includeHidden: false,
      timeoutMs: 15_000,
    }, signal)
  }

  async clickElement(sourceClientId, elementId, signal) {
    return await this.request('POST', '/browser/dom/click', {
      sourceClientId,
      elementId,
      button: 'left',
      clickCount: 1,
      timeoutMs: 15_000,
    }, signal)
  }

  async submit(sourceClientId, prompt, signal, { temporaryOnly = true, allowWindowBlur = false } = {}) {
    return await this.request('POST', '/browser/passive-prompt', {
      sourceClientId,
      message: prompt,
      temporaryOnly,
      allowWindowBlur,
      timeoutMs: 60_000,
    }, signal)
  }

  async open(sourceClientId, signal, { temporaryOnly = true } = {}) {
    const payload = await this.request('POST', '/browser/tabs/open', {
      sourceClientId,
      url: temporaryOnly ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/',
      active: true,
      select: false,
      timeoutMs: 30_000,
    }, signal)
    if (!payload.client?.id || !Number.isInteger(payload.client?.browserTabId)) {
      throw new Error('Relay opened a tab without a stable client identity')
    }
    return payload.client
  }

  async close(sourceClientId, expectedUrl, signal) {
    return await this.request('POST', '/browser/tabs/close', {
      sourceClientId,
      expectedUrl,
      timeoutMs: 10_000,
    }, signal)
  }
}

async function writeStatus(status, targetPath = statusPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
}

function isGenerating(client) {
  return client?.tabObservation?.generation?.state === 'active'
}

async function ensurePersonalizedTemporary(relay, client, signal) {
  const initial = await relay.queryDom(client.id, 'button', signal)
  const buttons = Array.isArray(initial?.elements) ? initial.elements : []
  if (buttons.some((element) => /^Personalized$/i.test(String(element.name || element.text || '').trim()))) return true
  const trigger = buttons.find((element) => /^Unpersonalized$/i.test(String(element.name || element.text || '').trim()))
  if (!trigger?.element_id) throw new Error('Temporary Chat personalization control was not found')
  await relay.clickElement(client.id, trigger.element_id, signal)
  await delay(500, signal)
  const menu = await relay.queryDom(client.id, '[role="menuitemradio"]', signal)
  const items = Array.isArray(menu?.elements) ? menu.elements : []
  const personalized = items.find((element) => /^Personalized(?:\s|$)/i.test(String(element.text || element.name || '').trim())
    && !/^Unpersonalized(?:\s|$)/i.test(String(element.text || element.name || '').trim()))
  if (!personalized?.element_id) throw new Error('Personalized Temporary Chat option was not found')
  await relay.clickElement(client.id, personalized.element_id, signal)
  await delay(750, signal)
  const verified = await relay.queryDom(client.id, 'button', signal)
  return (verified?.elements || []).some((element) => /^Personalized$/i.test(String(element.name || element.text || '').trim()))
}

async function verifiedChatMode(relay, client, signal, temporaryOnly = true, personalizedTemporary = false) {
  if (!client?.ready || client?.quarantined) return false
  const capture = await relay.captureLayout(client.id, signal)
  return hasExpectedChatMode(capture.html, temporaryOnly, client.url, personalizedTemporary)
}

async function cleanupOwnedFleet(relay, fleet, signal, log, temporaryOnly = true, personalizedTemporary = false) {
  const clients = await relay.clients(signal)
  const results = []
  for (const owned of fleet) {
    const current = clients.find((client) => client.browserTabId === owned.tabId)
    if (!current) {
      results.push({ ...owned, state: 'already_closed' })
      continue
    }
    try {
      const capture = await relay.captureLayout(current.id, signal)
      // The Personalized selector is only a launch-time assertion. ChatGPT can
      // hide that control after submission, so requiring it again during
      // cleanup strands otherwise verified runner-owned tabs forever. The tab
      // id is from this runner's own fleet and the URL still proves Temporary
      // vs normal mode; use live generation evidence only for the close gate.
      const cleanupModeMatches = temporaryOnly ? isTemporaryChatUrl(current.url) : !isTemporaryChatUrl(current.url)
      if (!cleanupModeMatches) {
        results.push({ ...owned, state: 'close_refused_wrong_chat_mode' })
        continue
      }
      const busyEvidence = cleanupBusyEvidence(current, capture.html)
      if (busyEvidence) {
        results.push({ ...owned, state: 'busy', detail: busyEvidence })
        continue
      }
      await relay.close(current.id, current.url, signal)
      log(`Closed completed runner-owned Temporary tab ${current.browserTabId}.`)
      results.push({ ...owned, state: 'closed' })
    } catch (error) {
      results.push({ ...owned, state: 'close_failed', detail: error.message })
    }
  }
  return results
}

async function forceCloseStaleOwnedFleet(relay, fleet, signal, log, temporaryOnly = true) {
  const clients = await relay.clients(signal)
  const results = []
  for (const owned of fleet) {
    const current = clients.find((client) => client.browserTabId === owned.tabId)
    if (!current) {
      results.push({ ...owned, state: 'already_closed' })
      continue
    }
    const wrongUrl = temporaryOnly ? !isTemporaryChatUrl(current.url) : isTemporaryChatUrl(current.url)
    if (wrongUrl) {
      results.push({ ...owned, state: 'force_close_refused_wrong_url' })
      continue
    }
    if (current?.activeRequest?.requestId || current?.tabObservation?.generation?.activeTool) {
      results.push({ ...owned, state: 'force_close_refused_active_work' })
      continue
    }
    try {
      // This tab id comes only from this runner's in-memory fleet. At the
      // deadline, an orphaned streaming bit must not keep it alive forever.
      await relay.close(current.id, current.url, signal)
      log(`Force-closed stale runner-owned tab ${current.browserTabId} after cleanup deadline.`)
      results.push({ ...owned, state: 'closed', detail: 'forced_after_cleanup_deadline' })
    } catch (error) {
      results.push({ ...owned, state: 'force_close_failed', detail: error.message })
    }
  }
  return results
}

async function cleanupOwnedFleetWhenIdle(
  relay,
  fleet,
  signal,
  log,
  temporaryOnly = true,
  personalizedTemporary = false,
  deadlineMs = Date.now() + ROUND_CLEANUP_TIMEOUT_MS,
) {
  let pending = [...fleet]
  const completed = []
  let lastSummary = ''
  while (pending.length && !signal.aborted && Date.now() < deadlineMs) {
    const pass = await cleanupOwnedFleet(relay, pending, signal, log, temporaryOnly, personalizedTemporary)
    const retry = []
    for (const item of pass) {
      if (['closed', 'already_closed'].includes(item.state)) completed.push(item)
      else retry.push(item)
    }
    pending = retry
    const currentSummary = JSON.stringify(summary(pending))
    if (pending.length && currentSummary !== lastSummary) {
      log(`Cleanup waiting on ${pending.length} tab(s): ${currentSummary}.`)
      lastSummary = currentSummary
    }
    if (pending.length && !signal.aborted && Date.now() < deadlineMs) {
      await delay(Math.min(ROUND_CLEANUP_POLL_MS, Math.max(0, deadlineMs - Date.now())), signal)
    }
  }
  if (pending.length && !signal.aborted) {
    log(`Cleanup deadline reached with ${pending.length} tab(s); attempting safe stale close.`)
    const forced = await forceCloseStaleOwnedFleet(relay, pending, signal, log, temporaryOnly)
    const retry = []
    for (const item of forced) {
      if (['closed', 'already_closed'].includes(item.state)) completed.push(item)
      else retry.push(item)
    }
    pending = retry
  }
  return [...completed, ...pending]
}

async function launchChatTarget({ relay, prompt, signal, log, temporaryOnly = true, personalizedTemporary = false }) {
  const risk = memoryRisk()
  if (risk) return { state: 'memory_guard', detail: risk }
  const clients = await relay.clients(signal)
  const candidates = clients.filter((client) => client.ready && !client.quarantined
    && !client.activeRequest?.requestId && !isGenerating(client))
  let control = candidates[0] || null
  // Multiple ChatGPT windows can share the relay. Prefer an authenticated tab as
  // the opener so a fresh worker inherits the paid account/session instead of
  // silently falling back to a logged-out ChatGPT surface.
  for (const candidate of candidates) {
    try {
      const capture = await relay.captureLayout(candidate.id, signal)
      if (hasAuthenticatedChatLayout(capture.html)) {
        control = candidate
        break
      }
    } catch {
      // A stale/transitioning candidate is not a reason to discard the rest.
    }
  }
  if (!control) return { state: 'no_control_tab' }
  let opened = null
  try {
    opened = await relay.open(control.id, signal, { temporaryOnly })
    // Independently verify the rendered chat mode before allowing a browser
    // write. Normal sessions require the inactive Temporary toggle; Temporary
    // sessions require the active toggle.
    await delay(NEW_TAB_SETTLE_MS, signal)
    for (let attempt = 1; attempt <= DEFAULT_MAX_LAUNCH_ATTEMPTS; attempt += 1) {
      try {
        if (temporaryOnly && personalizedTemporary) {
          const personalized = await ensurePersonalizedTemporary(relay, opened, signal)
          if (!personalized) throw new Error('Fresh Temporary Chat could not be switched to Personalized')
        }
        if (!await verifiedChatMode(relay, opened, signal, temporaryOnly, personalizedTemporary)) {
          throw new Error(`Fresh ChatGPT tab did not render verified ${personalizedTemporary ? 'Personalized Temporary' : (temporaryOnly ? 'Temporary' : 'normal')} chat mode`)
        }
        const response = await relay.submit(opened.id, prompt, signal, { temporaryOnly, allowWindowBlur: true })
        log(`Submitted prompt to fresh ${personalizedTemporary ? 'Personalized Temporary' : (temporaryOnly ? 'Temporary' : 'normal')} tab ${opened.browserTabId}.`)
        return {
          id: opened.id,
          tabId: opened.browserTabId,
          state: 'submitted',
          submittedUserTurnKey: String(response.result?.submittedUserTurnKey || response.submittedUserTurnKey || ''),
        }
      } catch (error) {
        // A timed-out submit may already have crossed into ChatGPT. Live
        // generation is acceptance evidence: keep this tab as the worker
        // instead of retrying the prompt or opening a replacement.
        const current = (await relay.clients(signal).catch(() => []))
          .find((client) => client.browserTabId === opened.browserTabId)
        if (current && (isGenerating(current) || current.activeRequest?.requestId)) {
          log(`Prompt submission became uncertain in tab ${opened.browserTabId}; retaining the active tab as its worker slot.`)
          return {
            id: current.id,
            tabId: current.browserTabId,
            state: 'submitted_uncertain',
            detail: error.message,
          }
        }
        if (!isRetryableLaunchError(error) || attempt >= DEFAULT_MAX_LAUNCH_ATTEMPTS) throw error
        log(`Tab ${opened.browserTabId} is not ready for submission yet; retrying the same tab (${attempt}/${DEFAULT_MAX_LAUNCH_ATTEMPTS}).`)
        await delay(SAME_TAB_RETRY_MS, signal)
      }
    }
  } catch (error) {
    let retained = null
    if (opened) {
      try {
        const current = (await relay.clients(signal)).find((client) => client.browserTabId === opened.browserTabId)
        if (current) {
          retained = current
          if (!isGenerating(current) && !current.activeRequest?.requestId) {
            await relay.close(current.id, current.url, signal)
            retained = null
          }
        }
      } catch {
        // A failed client-list or close call cannot prove the tab disappeared.
        // Retain its original identity so it consumes a fleet slot and later
        // cleanup can retry instead of opening a replacement beside it.
        retained = opened
      }
    }
    if (retained) {
      return {
        id: retained.id,
        tabId: retained.browserTabId,
        state: 'launch_retained',
        detail: error.message,
      }
    }
    return { id: opened?.id || '', tabId: opened?.browserTabId || null, state: 'failed', detail: error.message }
  }
}

async function adoptChatTarget(relay, tabId, signal, temporaryOnly = true, personalizedTemporary = false) {
  if (!Number.isInteger(tabId)) return null
  const client = (await relay.clients(signal)).find((candidate) => candidate.browserTabId === tabId)
  if (!client || !await verifiedChatMode(relay, client, signal, temporaryOnly, personalizedTemporary)) {
    throw new Error(`Cannot adopt tab ${tabId}: it is not a verified ${personalizedTemporary ? 'Personalized Temporary' : (temporaryOnly ? 'Temporary' : 'normal')} chat`)
  }
  return {
    id: client.id,
    tabId,
    state: isGenerating(client) ? 'already_generating' : 'adopted_submitted',
    runCount: DEFAULT_MAX_SESSION_RUNS,
  }
}

async function launchRound({ relay, promptTemplate, adopted = [], staggerMs, signal, log, temporaryOnly = true,
  personalizedTemporary = false, fleetSize = DEFAULT_FLEET_SIZE }) {
  const results = [...adopted]
  let occupied = results.filter(isRetainedSession).length
  let launchAttempts = 0
  const openAttemptBudget = launchOpenAttemptBudget(fleetSize, occupied)
  while (!signal.aborted && occupied < fleetSize && launchAttempts < openAttemptBudget) {
    if (launchAttempts > 0) await delay(staggerMs, signal)
    const slot = occupied + 1
    const prompt = renderFleetPrompt(promptTemplate, slot, fleetSize)
    const launched = await launchChatTarget({ relay, prompt, signal, log, temporaryOnly, personalizedTemporary })
    const result = isRetainedSession(launched)
      ? { ...launched, slot, runCount: isSuccessfulSession(launched) ? 1 : 0 }
      : launched
    results.push(result)
    launchAttempts += 1
    if (isRetainedSession(result)) occupied += 1
    if (result.state === 'memory_guard' || result.state === 'no_control_tab') break
  }
  return results
}

export function isSuccessfulSession(result) {
  return ['submitted', 'submitted_uncertain', 'reused_submitted', 'already_generating', 'adopted_submitted'].includes(result?.state)
}

/** A still-open tab occupies a slot even when submission could not be confirmed. */
export function isRetainedSession(result) {
  return isSuccessfulSession(result) || result?.state === 'launch_retained'
}

async function inspectReusableFleet(relay, fleet, signal, temporaryOnly = true, personalizedTemporary = false) {
  const clients = await relay.clients(signal)
  const inspected = []
  for (const owned of fleet) {
    const current = clients.find((client) => client.browserTabId === owned.tabId)
    if (!current) {
      inspected.push({ owned, current: null, state: 'missing' })
      continue
    }
    try {
      const capture = await relay.captureLayout(current.id, signal)
      if (!hasExpectedChatMode(capture.html, temporaryOnly, current.url, personalizedTemporary)) {
        inspected.push({ owned, current, state: 'wrong_chat_mode' })
        continue
      }
      const busyEvidence = cleanupBusyEvidence(current, capture.html)
      inspected.push({ owned, current, state: busyEvidence ? 'busy' : 'ready', detail: busyEvidence })
    } catch (error) {
      inspected.push({ owned, current, state: 'inspect_failed', detail: error.message })
    }
  }
  return inspected
}

async function reuseFleetRound({ relay, fleet, promptTemplate, signal, log, temporaryOnly = true,
  personalizedTemporary = false, staggerMs = DEFAULT_STAGGER_SECONDS * 1000, fleetSize = DEFAULT_FLEET_SIZE, maxSessionRuns = DEFAULT_MAX_SESSION_RUNS }) {
  const attempts = fleet.map(async (owned, index) => {
    if (index > 0) await delay(index * staggerMs, signal)
    const slot = Number.isInteger(owned.slot) ? owned.slot : index + 1
    const prompt = renderFleetPrompt(promptTemplate, slot, fleetSize)
    try {
      const response = await relay.submit(owned.id, prompt, signal, { temporaryOnly, allowWindowBlur: true })
      const session = {
        ...owned,
        state: 'reused_submitted',
        slot,
        runCount: sessionRunCount(owned) + 1,
        submittedUserTurnKey: String(response.result?.submittedUserTurnKey || response.submittedUserTurnKey || ''),
      }
      log(`Submitted run ${session.runCount}/${maxSessionRuns} to runner-owned ${personalizedTemporary ? 'Personalized Temporary' : (temporaryOnly ? 'Temporary' : 'normal')} tab ${owned.tabId}.`)
      return session
    } catch (error) {
      return { ...owned, slot, state: 'reuse_failed', detail: error.message }
    }
  })
  const sessions = await Promise.all(attempts)
  const results = [...sessions]
  return { results, sessions }
}

function summary(results) {
  return results.reduce((counts, result) => {
    counts[result.state] = (counts[result.state] || 0) + 1
    return counts
  }, {})
}

async function main() {
  const rawArgs = process.argv.slice(2)
  const args = new Set(rawArgs)
  if (args.has('--help') || args.has('-h')) {
    console.log([
      'Usage: node scripts/Run-Hachimi-Temporary-Fleet.mjs --prompt-file=<path> [options]',
      '',
      'The legacy embedded hachimi-tl-vi prompt is disabled. An explicit --prompt-file is required.',
      'Common options: --fleet-size=N --interval-minutes=N --max-session-runs=N --once',
      '              --personalized-temporary --normal-chat --close-after-round',
    ].join('\n'))
    return
  }
  const promptFile = promptFileArgument(rawArgs)
  if (!promptFile) {
    console.error('Refusing to launch: the legacy embedded hachimi-tl-vi prompt is disabled; pass --prompt-file=<path> explicitly.')
    process.exitCode = 2
    return
  }
  const once = args.has('--once')
  const resumeStatus = args.has('--resume-status')
  const temporaryOnly = !args.has('--normal-chat')
  const personalizedTemporary = temporaryOnly && args.has('--personalized-temporary')
  const closeAfterRound = args.has('--close-after-round')
  const chatMode = personalizedTemporary ? 'temporary_personalized' : (temporaryOnly ? 'temporary' : 'normal')
  const fleetSize = fleetSizeArgument(rawArgs)
  const intervalMinutes = intervalMinutesArgument(rawArgs)
  const maxSessionRuns = maxSessionRunsArgument(rawArgs)
  const runStatusPath = path.join(path.dirname(statusPath), statusNameArgument(rawArgs))
  const adoptValue = rawArgs.find((argument) => argument.startsWith('--adopt-tabs='))?.split('=', 2)[1]
    || rawArgs.find((argument) => argument.startsWith('--adopt-tab='))?.split('=', 2)[1]
  const adoptTabIds = String(adoptValue || '').split(',').map((value) => value.trim()).filter(Boolean).map(Number).filter(Number.isInteger)
  if (adoptTabIds.length > fleetSize) throw new Error('adopted tab count exceeds --fleet-size')
  const env = parseEnvFile(await fs.readFile(runtimeEnvPath, 'utf8'))
  if (!env.API_TOKEN) throw new Error(`Relay token is missing from ${runtimeEnvPath}`)
  const promptTemplate = await fs.readFile(path.resolve(process.cwd(), promptFile), 'utf8')
  if (!promptTemplate.trim()) throw new Error('Fleet prompt is empty')
  const relay = new RelayClient({
    baseUrl: `http://127.0.0.1:${env.PORT || 23158}`,
    token: env.API_TOKEN,
  })
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`)

  try {
    let fleet = []
    let round = 0
    if (resumeStatus) {
      try {
        const previousStatus = JSON.parse(await fs.readFile(runStatusPath, 'utf8'))
        fleet = selectStatusFleet(previousStatus)
        round = Number.isInteger(Number(previousStatus.round)) ? Number(previousStatus.round) : 0
        if (fleet.length) log(`Resuming ${fleet.length} runner-owned ${chatMode} tabs at completed round ${round}.`)
      } catch (error) {
        log(`Could not resume the previous status file: ${error.message}`)
      }
    }
    let adopted = []
    for (const tabId of adoptTabIds) adopted.push(await adoptChatTarget(relay, tabId, controller.signal, temporaryOnly, personalizedTemporary))
    while (!controller.signal.aborted && hasRemainingRounds(round)) {
      let reusableTargets = null
      let deferredResults = []
      if (fleet.length) {
        const inspected = await inspectReusableFleet(relay, fleet, controller.signal, temporaryOnly, personalizedTemporary)
        const busy = inspected.filter((item) => ['busy', 'inspect_failed'].includes(item.state))
        const missingOrInvalid = inspected.some((item) => ['missing', 'wrong_chat_mode'].includes(item.state))
        const rotationRequired = fleetNeedsRotation(fleet, maxSessionRuns)
        const ready = inspected.filter((item) => item.state === 'ready')
        if (busy.length && (rotationRequired || missingOrInvalid || !ready.length)) {
          const retry = busy.map(({ owned, state, detail }) => ({ ...owned, state, detail }))
          await writeStatus({
            running: true,
            pid: process.pid,
            fleetSize,
            intervalMinutes,
            maxSessionRuns,
            chatMode,
            round,
            updatedAt: new Date().toISOString(),
            summary: summary(retry),
            sessions: fleet,
            retry,
            nextRetryAt: new Date(Date.now() + BUSY_RETRY_MS).toISOString(),
          }, runStatusPath)
          log(`No safely reusable ${chatMode} session is available; retrying in ${BUSY_RETRY_MS / 60_000} minutes.`)
          await delay(BUSY_RETRY_MS, controller.signal)
          continue
        }

        if (rotationRequired || missingOrInvalid) {
          const cleanup = await cleanupOwnedFleet(relay, fleet, controller.signal, log, temporaryOnly, personalizedTemporary)
          const blocked = cleanup.filter((item) => !['closed', 'already_closed'].includes(item.state))
          if (blocked.length) {
            await writeStatus({
              running: true,
              pid: process.pid,
              fleetSize,
              intervalMinutes,
              maxSessionRuns,
              chatMode,
              round,
              updatedAt: new Date().toISOString(),
              summary: summary(cleanup),
              sessions: fleet,
              cleanup,
              nextRetryAt: new Date(Date.now() + BUSY_RETRY_MS).toISOString(),
            }, runStatusPath)
            log(`The expiring cohort is not safely closable; retrying in ${BUSY_RETRY_MS / 60_000} minutes.`)
            await delay(BUSY_RETRY_MS, controller.signal)
            continue
          }
          fleet = []
        } else {
          fleet = inspected.map(({ owned, current }) => ({ ...owned, id: current.id }))
          if (busy.length) {
            reusableTargets = ready.map(({ owned, current }) => ({ ...owned, id: current.id }))
            deferredResults = busy.map(({ owned, state, detail }) => ({ ...owned, state, detail }))
            log(`Deferring ${busy.length} busy ${chatMode} session(s); submitting to ${reusableTargets.length} ready session(s).`)
          }
        }
      }
      round += 1
      const startedAt = new Date().toISOString()
      log(`Starting round ${round}${DEFAULT_MAX_ROUNDS > 0 ? `/${DEFAULT_MAX_ROUNDS}` : ''}.`)
      let results = []
      if (fleet.length) {
        const targets = reusableTargets || fleet
        const reused = await reuseFleetRound({
          relay,
          fleet: targets,
          promptTemplate,
          signal: controller.signal,
          log,
          temporaryOnly,
          personalizedTemporary,
          fleetSize,
          maxSessionRuns,
        })
        results = [...reused.results, ...deferredResults]
        if (reusableTargets) {
          const updatedByTab = new Map(reused.sessions.map((session) => [session.tabId, session]))
          fleet = fleet.map((session) => updatedByTab.get(session.tabId) || session)
        } else {
          fleet = reused.sessions
        }
      } else {
        results = await launchRound({
          relay,
          promptTemplate,
          adopted,
          staggerMs: DEFAULT_STAGGER_SECONDS * 1000,
          signal: controller.signal,
          log,
          temporaryOnly,
          personalizedTemporary,
          fleetSize,
        })
        fleet = results.filter((result) => isRetainedSession(result) && Number.isInteger(result.tabId))
      }
      adopted = []
      const nextRunAtMs = once || !hasRemainingRounds(round) ? null : Date.now() + intervalMinutes * 60_000
      const status = {
        running: !once && hasRemainingRounds(round) && !controller.signal.aborted,
        pid: process.pid,
        fleetSize,
        activeFleetSize: fleet.length,
        intervalMinutes,
        maxSessionRuns,
        chatMode,
        staggerSeconds: DEFAULT_STAGGER_SECONDS,
        round,
        maxRounds: DEFAULT_MAX_ROUNDS,
        startedAt,
        updatedAt: new Date().toISOString(),
        summary: summary(results),
        sessions: fleet,
        results,
        closeAfterRound,
        nextRunAt: nextRunAtMs == null ? null : new Date(nextRunAtMs).toISOString(),
      }
      await writeStatus(status, runStatusPath)
      log(`Round ${round} result: ${JSON.stringify(status.summary)}.`)

      if (closeAfterRound && fleet.length && !controller.signal.aborted) {
        log(`Waiting for ${fleet.length} runner-owned ${chatMode} tab(s) to finish, then closing them before the next round.`)
        const cleanupDeadlineMs = Math.min(
          nextRunAtMs ?? Number.POSITIVE_INFINITY,
          Date.now() + ROUND_CLEANUP_TIMEOUT_MS,
        )
        const cleanup = await cleanupOwnedFleetWhenIdle(
          relay,
          fleet,
          controller.signal,
          log,
          temporaryOnly,
          personalizedTemporary,
          cleanupDeadlineMs,
        )
        const blocked = cleanup.filter((item) => !['closed', 'already_closed'].includes(item.state))
        fleet = blocked
        await writeStatus({
          ...status,
          running: !once && hasRemainingRounds(round) && !controller.signal.aborted,
          activeFleetSize: fleet.length,
          sessions: fleet,
          cleanup,
          cleanupCompletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, runStatusPath)
        if (!fleet.length) log(`Round ${round} cleanup complete: all runner-owned worker tabs are closed.`)
      }

      if (once || !hasRemainingRounds(round) || controller.signal.aborted) break
      if (closeAfterRound && fleet.length) {
        log(`Round ${round} cleanup is incomplete; refusing to open another cohort while runner-owned tabs remain.`)
      }
      await delay(nextRoundDelayMs(nextRunAtMs), controller.signal)
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) {
  main().catch(async (error) => {
    await writeStatus({ running: false, failedAt: new Date().toISOString(), error: error.message }).catch(() => {})
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}
