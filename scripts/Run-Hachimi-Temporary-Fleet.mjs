#!/usr/bin/env node

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_FLEET_SIZE = 5
export const DEFAULT_INTERVAL_MINUTES = 30
export const DEFAULT_STAGGER_SECONDS = 8
export const DEFAULT_MAX_ROUNDS = 12
export const DEFAULT_MAX_LAUNCH_ATTEMPTS = 20
const MIN_FREE_MEMORY_BYTES = 2 * 1024 ** 3
const MIN_FREE_MEMORY_RATIO = 0.15
const REQUEST_TIMEOUT_MS = 75_000
const BUSY_RETRY_MS = 5 * 60_000
const NEW_TAB_SETTLE_MS = 12_000

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

export function hasActiveGenerationControl(html) {
  return /<(?:button|div)[^>]*(?:data-testid="(?:stop-button|stop-generating)[^"]*"|aria-label="(?:Stop generating|Stop response|Dừng tạo|Dừng phản hồi)")[^>]*>/i.test(String(html || ''))
}

export function hasSendControl(html) {
  return /<button[^>]*(?:data-testid="send-button"|aria-label="(?:Send prompt|Send message|Send|Gửi prompt|Gửi tin nhắn|Gửi câu lệnh|Gửi)")[^>]*>/i.test(String(html || ''))
}

export function cleanupBusyEvidence(client, html) {
  if (client?.activeRequest?.requestId) return 'active_request'
  if (client?.tabObservation?.generation?.activeTool) return 'active_tool'
  if (hasActiveGenerationControl(html)) return 'stop_control'
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

  async submit(sourceClientId, prompt, signal) {
    return await this.request('POST', '/browser/passive-prompt', {
      sourceClientId,
      message: prompt,
      temporaryOnly: true,
      timeoutMs: 60_000,
    }, signal)
  }

  async open(sourceClientId, signal) {
    const payload = await this.request('POST', '/browser/tabs/open', {
      sourceClientId,
      url: 'https://chatgpt.com/',
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

async function writeStatus(status) {
  await fs.mkdir(path.dirname(statusPath), { recursive: true })
  await fs.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
}

function isGenerating(client) {
  return client?.tabObservation?.generation?.state === 'active'
}

async function verifiedTemporary(relay, client, signal) {
  if (!client?.ready || client?.quarantined) return false
  const capture = await relay.captureLayout(client.id, signal)
  return hasActiveTemporaryChatControl(capture.html)
}

async function cleanupOwnedFleet(relay, fleet, signal, log) {
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
      if (!hasActiveTemporaryChatControl(capture.html)) {
        results.push({ ...owned, state: 'close_refused_not_temporary' })
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

async function launchTemporaryTarget({ relay, prompt, signal, log }) {
  const risk = memoryRisk()
  if (risk) return { state: 'memory_guard', detail: risk }
  const clients = await relay.clients(signal)
  const control = clients.find((client) => client.ready && !client.quarantined
    && !client.activeRequest?.requestId && !isGenerating(client))
  if (!control) return { state: 'no_control_tab' }
  let opened = null
  try {
    opened = await relay.open(control.id, signal)
    // A newly rendered ChatGPT button can exist before React has attached its
    // click handler. Wait once, then rely on temporaryOnly's single fail-closed
    // activation attempt; never retry an unconfirmed browser write.
    await delay(NEW_TAB_SETTLE_MS, signal)
    const response = await relay.submit(opened.id, prompt, signal)
    log(`Submitted prompt to fresh Temporary tab ${opened.browserTabId}.`)
    return {
      id: opened.id,
      tabId: opened.browserTabId,
      state: 'submitted',
      submittedUserTurnKey: String(response.result?.submittedUserTurnKey || response.submittedUserTurnKey || ''),
    }
  } catch (error) {
    if (opened) {
      try {
        const current = (await relay.clients(signal)).find((client) => client.browserTabId === opened.browserTabId)
        if (current && !isGenerating(current) && !current.activeRequest?.requestId) {
          await relay.close(current.id, current.url, signal)
        }
      } catch {}
    }
    return { id: opened?.id || '', tabId: opened?.browserTabId || null, state: 'failed', detail: error.message }
  }
}

async function adoptTemporaryTarget(relay, tabId, signal) {
  if (!Number.isInteger(tabId)) return null
  const client = (await relay.clients(signal)).find((candidate) => candidate.browserTabId === tabId)
  if (!client || !await verifiedTemporary(relay, client, signal)) {
    throw new Error(`Cannot adopt tab ${tabId}: it is not a verified Temporary Chat`)
  }
  return { id: client.id, tabId, state: isGenerating(client) ? 'already_generating' : 'adopted_submitted' }
}

async function launchRound({ relay, promptTemplate, adopted = [], staggerMs, signal, log }) {
  const results = [...adopted]
  let successful = results.filter(isSuccessfulSession).length
  let launchAttempts = 0
  while (!signal.aborted && successful < DEFAULT_FLEET_SIZE && launchAttempts < DEFAULT_MAX_LAUNCH_ATTEMPTS) {
    if (launchAttempts > 0) await delay(staggerMs, signal)
    const prompt = renderFleetPrompt(promptTemplate, successful + 1)
    const result = await launchTemporaryTarget({ relay, prompt, signal, log })
    results.push(result)
    launchAttempts += 1
    if (isSuccessfulSession(result)) successful += 1
    if (result.state === 'memory_guard' || result.state === 'no_control_tab') break
  }
  return results
}

export function isSuccessfulSession(result) {
  return ['submitted', 'already_generating', 'adopted_submitted'].includes(result?.state)
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
  const once = args.has('--once')
  const resumeStatus = args.has('--resume-status')
  const adoptValue = rawArgs.find((argument) => argument.startsWith('--adopt-tabs='))?.split('=', 2)[1]
    || rawArgs.find((argument) => argument.startsWith('--adopt-tab='))?.split('=', 2)[1]
  const adoptTabIds = String(adoptValue || '').split(',').map((value) => value.trim()).filter(Boolean).map(Number).filter(Number.isInteger)
  const env = parseEnvFile(await fs.readFile(runtimeEnvPath, 'utf8'))
  if (!env.API_TOKEN) throw new Error(`Relay token is missing from ${runtimeEnvPath}`)
  const promptFile = promptFileArgument(rawArgs)
  const promptTemplate = promptFile
    ? await fs.readFile(path.resolve(process.cwd(), promptFile), 'utf8')
    : extractEmbeddedPrompt(await fs.readFile(consoleScriptPath, 'utf8'))
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
    if (resumeStatus) {
      try {
        fleet = selectStatusFleet(JSON.parse(await fs.readFile(statusPath, 'utf8')))
        if (fleet.length) log(`Resuming cleanup for ${fleet.length} runner-owned Temporary tabs before launching the five-tab fleet.`)
      } catch (error) {
        log(`Could not resume the previous status file: ${error.message}`)
      }
    }
    let adopted = []
    for (const tabId of adoptTabIds) adopted.push(await adoptTemporaryTarget(relay, tabId, controller.signal))
    let round = 0
    while (!controller.signal.aborted && round < DEFAULT_MAX_ROUNDS) {
      if (fleet.length) {
        const cleanup = await cleanupOwnedFleet(relay, fleet, controller.signal, log)
        const blocked = cleanup.filter((item) => !['closed', 'already_closed'].includes(item.state))
        if (blocked.length) {
          await writeStatus({
            running: true,
            fleetSize: fleet.length,
            intervalMinutes: DEFAULT_INTERVAL_MINUTES,
            round,
            updatedAt: new Date().toISOString(),
            summary: summary(cleanup),
            cleanup,
            nextRetryAt: new Date(Date.now() + BUSY_RETRY_MS).toISOString(),
          })
          log(`Previous fleet is not safely closable; retrying in ${BUSY_RETRY_MS / 60_000} minutes.`)
          await delay(BUSY_RETRY_MS, controller.signal)
          continue
        }
        fleet = []
      }
      round += 1
      const startedAt = new Date().toISOString()
      log(`Starting round ${round}/${DEFAULT_MAX_ROUNDS}.`)
      const results = await launchRound({
        relay,
        promptTemplate,
        adopted,
        staggerMs: DEFAULT_STAGGER_SECONDS * 1000,
        signal: controller.signal,
        log,
      })
      adopted = []
      fleet = results.filter((result) => isSuccessfulSession(result) && Number.isInteger(result.tabId))
      const status = {
        running: !once && round < DEFAULT_MAX_ROUNDS && !controller.signal.aborted,
        fleetSize: fleet.length,
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        staggerSeconds: DEFAULT_STAGGER_SECONDS,
        round,
        maxRounds: DEFAULT_MAX_ROUNDS,
        startedAt,
        updatedAt: new Date().toISOString(),
        summary: summary(results),
        sessions: results,
        nextRunAt: once || round >= DEFAULT_MAX_ROUNDS ? null : new Date(Date.now() + DEFAULT_INTERVAL_MINUTES * 60_000).toISOString(),
      }
      await writeStatus(status)
      log(`Round ${round} result: ${JSON.stringify(status.summary)}.`)
      if (once || round >= DEFAULT_MAX_ROUNDS || controller.signal.aborted) break
      await delay(DEFAULT_INTERVAL_MINUTES * 60_000, controller.signal)
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
