#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_INTERVAL_MINUTES = 27
const DEFAULT_RELAY_PORT = 23158
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

function optionValue(args, index, name) {
  const value = args[index + 1]
  if (value == null || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

export function parseRepeatPromptArgs(args = []) {
  const options = {
    prompt: '',
    promptFile: '',
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    sessionId: '',
    sourceClientId: '',
    model: '',
    effort: '',
    relayUrl: '',
    apiToken: '',
    waitFirst: false,
    once: false,
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--wait-first') options.waitFirst = true
    else if (arg === '--once') options.once = true
    else if (arg === '--prompt') options.prompt = optionValue(args, index++, arg)
    else if (arg === '--prompt-file') options.promptFile = optionValue(args, index++, arg)
    else if (arg === '--interval-minutes') options.intervalMinutes = Number(optionValue(args, index++, arg))
    else if (arg === '--session') options.sessionId = optionValue(args, index++, arg)
    else if (arg === '--client') options.sourceClientId = optionValue(args, index++, arg)
    else if (arg === '--model') options.model = optionValue(args, index++, arg)
    else if (arg === '--effort') options.effort = optionValue(args, index++, arg)
    else if (arg === '--relay-url') options.relayUrl = optionValue(args, index++, arg)
    else if (arg === '--api-token') options.apiToken = optionValue(args, index++, arg)
    else throw new Error(`Unknown option: ${arg}`)
  }

  if (!Number.isFinite(options.intervalMinutes) || options.intervalMinutes <= 0) {
    throw new Error('--interval-minutes must be a positive number')
  }
  if (options.prompt && options.promptFile) throw new Error('Use either --prompt or --prompt-file, not both')
  return options
}

export function parseEnvFile(text = '') {
  const result = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

export function normalizeLoopbackRelayUrl(value) {
  const url = new URL(String(value || `http://127.0.0.1:${DEFAULT_RELAY_PORT}`))
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('The Shiro relay URL must be a loopback HTTP URL')
  }
  return url.href.replace(/\/$/, '')
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

export async function resolveRepeatPromptConfig(options, dependencies = {}) {
  const environment = dependencies.environment || process.env
  const currentDirectory = dependencies.currentDirectory || process.cwd()
  const repoRoot = dependencies.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const runtimeEnvPath = dependencies.runtimeEnvPath
    || path.join(path.dirname(repoRoot), '.ShiroRuntime', 'state', 'chatgpt-relay.env')
  const relaySettings = parseEnvFile(await readOptionalFile(runtimeEnvPath))

  let prompt = options.prompt || environment.SHIRO_REPEAT_PROMPT || ''
  if (options.promptFile) prompt = await fs.readFile(path.resolve(currentDirectory, options.promptFile), 'utf8')
  if (!String(prompt).trim()) {
    throw new Error('A prompt is required. Use --prompt, --prompt-file, or SHIRO_REPEAT_PROMPT')
  }

  const relayUrl = normalizeLoopbackRelayUrl(
    options.relayUrl
      || environment.SHIRO_RELAY_URL
      || `http://127.0.0.1:${relaySettings.PORT || DEFAULT_RELAY_PORT}`,
  )
  const apiToken = options.apiToken
    || environment.SHIRO_RELAY_API_TOKEN
    || relaySettings.API_TOKEN
    || ''
  if (!apiToken) {
    throw new Error(`Shiro relay API token was not found. Start Shiro once or check ${runtimeEnvPath}`)
  }

  return {
    ...options,
    prompt: String(prompt),
    relayUrl,
    apiToken,
    intervalMs: Math.round(options.intervalMinutes * 60_000),
  }
}

async function responseDetail(response) {
  const text = await response.text()
  if (!text) return ''
  try {
    const body = JSON.parse(text)
    return String(body.detail || body.error || body.message || text)
  } catch {
    return text
  }
}

export async function submitPromptThroughShiro(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch
  const body = {
    message: config.prompt,
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
    ...(config.sourceClientId ? { sourceClientId: config.sourceClientId } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  }
  const response = await fetchImpl(`${config.relayUrl}/browser/passive-prompt`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: dependencies.signal,
  })
  if (!response.ok) {
    throw new Error(`Shiro relay HTTP ${response.status}: ${await responseDetail(response) || response.statusText}`)
  }
  return await response.json()
}

export function nextScheduledTime(previousScheduledTime, now, intervalMs) {
  let next = previousScheduledTime + intervalMs
  if (next <= now) next += (Math.floor((now - next) / intervalMs) + 1) * intervalMs
  return next
}

function waitUntil(timestamp, signal) {
  const delay = Math.max(0, timestamp - Date.now())
  if (delay === 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, delay)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function timestamp(value = Date.now()) {
  return new Date(value).toLocaleString('vi-VN')
}

export async function runRepeatPrompt(config, dependencies = {}) {
  const signal = dependencies.signal
  const log = dependencies.log || console.log
  const logError = dependencies.logError || console.error
  let scheduledTime = Date.now() + (config.waitFirst ? config.intervalMs : 0)
  let attempts = 0

  while (!signal?.aborted) {
    await waitUntil(scheduledTime, signal)
    if (signal?.aborted) break
    attempts += 1
    log(`[${timestamp()}] Đang gửi prompt #${attempts} qua Shiro bridge...`)
    try {
      await submitPromptThroughShiro(config, { fetchImpl: dependencies.fetchImpl, signal })
      log(`[${timestamp()}] Đã điền và gửi prompt #${attempts} thành công.`)
    } catch (error) {
      if (signal?.aborted) break
      logError(`[${timestamp()}] Prompt #${attempts} thất bại: ${error.message}`)
    }
    if (config.once) break
    scheduledTime = nextScheduledTime(scheduledTime, Date.now(), config.intervalMs)
    log(`Lần tiếp theo: ${timestamp(scheduledTime)}`)
  }

  return { attempts, stopped: Boolean(signal?.aborted) }
}

function printHelp() {
  console.log(`Tự động gửi prompt vào ChatGPT Web qua Shiro bridge mỗi 27 phút.

Usage:
  node scripts/Repeat-ChatGPT-Prompt.mjs --prompt "Nội dung prompt"
  node scripts/Repeat-ChatGPT-Prompt.mjs --prompt-file .\\prompt.txt

Options:
  --prompt <text>             Nội dung gửi
  --prompt-file <path>        Đọc nội dung từ file (hỗ trợ nhiều dòng)
  --interval-minutes <n>      Chu kỳ gửi; mặc định ${DEFAULT_INTERVAL_MINUTES}
  --session <id>              Cố định vào một ChatGPT conversation
  --client <id>               Cố định vào một tab bridge
  --model <name>              Model hiển thị mà bridge sẽ chọn
  --effort <name>             Effort hiển thị mà bridge sẽ chọn
  --wait-first                Chờ đủ một chu kỳ trước lần gửi đầu
  --once                      Chỉ gửi một lần (hữu ích để kiểm tra)
  --relay-url <url>           Mặc định đọc cấu hình runtime của Shiro
  --api-token <token>         Mặc định đọc cấu hình runtime của Shiro
  --help                      Hiện trợ giúp

Ctrl+C dừng scheduler.`)
}

async function main() {
  const options = parseRepeatPromptArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  const config = await resolveRepeatPromptConfig(options)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  console.log(`Chu kỳ: ${config.intervalMinutes} phút · Relay: ${config.relayUrl}`)
  if (config.sessionId) console.log(`ChatGPT session: ${config.sessionId}`)
  try {
    await runRepeatPrompt(config, { signal: controller.signal })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
  console.log('Đã dừng scheduler.')
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()
if (isMain) {
  main().catch((error) => {
    console.error(`Không thể chạy scheduler: ${error.message}`)
    process.exitCode = 1
  })
}
