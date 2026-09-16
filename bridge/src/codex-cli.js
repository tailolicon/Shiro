/**
 * Codex CLI model runner.
 *
 * Runs the locally installed, subscription-authenticated `codex exec` as a
 * schema-constrained language-model backend. Codex's own agent tools and user
 * configuration are disabled: DeepSeek Harness remains the only loop owner
 * and the only process allowed to execute the model's requested tools.
 */

import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { RelayError, parseReply, relayPrompt } from './chatgpt-relay.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

const BACKEND_INSTRUCTIONS = [
  'You are a stateless language-model backend for a DeepSeek Harness request.',
  'The user message contains the authoritative system prompt, messages, tool schemas, and generation settings.',
  'Do not inspect files or invoke Codex tools. Return only the schema-constrained model decision for that request.',
].join(' ')

// OpenAI strict structured outputs cannot leave arbitrary object properties
// open. Tool arguments therefore travel as a JSON string; parseReply() already
// validates and decodes that representation against the Harness tool surface.
const BLOCKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['text', 'reasoning', 'tool_call'] },
          text: { type: ['string', 'null'] },
          id: { type: ['string', 'null'] },
          name: { type: ['string', 'null'] },
          arguments: { type: ['string', 'null'] },
        },
        required: ['type', 'text', 'id', 'name', 'arguments'],
      },
    },
    finishReason: { type: 'string', enum: ['stop', 'tool-calls', 'max-tokens'] },
  },
  required: ['blocks', 'finishReason'],
}

const DISABLED_FEATURES = Object.freeze([
  'apps',
  'browser_use',
  'computer_use',
  'goals',
  'image_generation',
  'multi_agent',
  'shell_tool',
  'skill_search',
  'unified_exec',
  'view_image',
  'workspace_dependencies',
])

function codexEffort(effort) {
  if (effort === 'light') return 'low'
  if (effort === 'high') return 'high'
  if (effort === 'max') return 'xhigh'
  return 'medium'
}

/** Locate Codex from explicit config, the normal user install, or PATH. */
export function resolveCodexCliPath(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const path = explicit.trim()
    return existsSync(path) ? path : null
  }
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']
  const candidates = names.map(name => join(homedir(), '.local', 'bin', name))
  for (const dir of String(process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(join(dir, name))
  }
  return candidates.find(path => existsSync(path)) ?? null
}

function classifyExit(code, stderr) {
  const detail = String(stderr ?? '').trim()
  if (/rate.?limit|too many requests|usage limit|\b429\b/i.test(detail)) {
    return new RelayError(`Codex CLI rate limited: ${detail.slice(-500)}`, 'RATE_LIMIT')
  }
  if (/not logged in|login|credential|unauthorized|\b401\b/i.test(detail)) {
    return new RelayError(`Codex CLI is not authenticated (run "codex login"): ${detail.slice(-500)}`, 'SERVER')
  }
  return new RelayError(`Codex CLI exited with code ${code}: ${detail.slice(-500)}`, 'SERVER')
}

function latestUsage(stdout) {
  let usage
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const event = JSON.parse(line)
      if (event?.type === 'turn.completed' && event.usage) usage = event.usage
    } catch { /* stderr carries diagnostics; non-JSON stdout is ignored */ }
  }
  const count = value => (Number.isFinite(value) && value >= 0 ? value : 0)
  const mapped = {
    inputTokens: count(usage?.input_tokens),
    outputTokens: count(usage?.output_tokens),
  }
  if (count(usage?.cached_input_tokens) > 0) mapped.cacheReadTokens = count(usage.cached_input_tokens)
  if (count(usage?.cache_write_input_tokens) > 0) mapped.cacheWriteTokens = count(usage.cache_write_input_tokens)
  if (count(usage?.reasoning_output_tokens) > 0) mapped.reasoningTokens = count(usage.reasoning_output_tokens)
  return mapped
}

export class CodexCliRunner {
  constructor({ cliPath, timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn }) {
    if (typeof cliPath !== 'string' || cliPath.trim() === '') throw new Error('codex cliPath is required')
    this.cliPath = cliPath
    this.timeoutMs = timeoutMs
    this.spawn = spawnImpl
  }

  async complete(request, signal, { model, effort } = {}) {
    const workDir = mkdtempSync(join(tmpdir(), 'shiro-codex-'))
    const schemaFile = join(workDir, 'response-schema.json')
    const responseFile = join(workDir, 'response.json')
    try {
      writeFileSync(schemaFile, JSON.stringify(BLOCKS_SCHEMA), 'utf8')
      const args = [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--sandbox', 'read-only',
        '--cd', workDir,
        '--json',
        '--output-schema', schemaFile,
        '--output-last-message', responseFile,
        '-c', 'approval_policy="never"',
        '-c', `developer_instructions=${JSON.stringify(BACKEND_INSTRUCTIONS)}`,
        '-c', `model_reasoning_effort=${JSON.stringify(codexEffort(effort))}`,
      ]
      for (const feature of DISABLED_FEATURES) args.push('--disable', feature)
      if (typeof model === 'string' && model !== '') args.push('--model', model)
      // Explicit '-' prevents prompt bytes from entering argv (Windows has a
      // small command-line limit); the request is sent through stdin instead.
      args.push('-')
      const { stdout } = await this.#run(args, relayPrompt(request, { fenced: false }), signal, workDir)
      if (!existsSync(responseFile)) throw new RelayError('Codex CLI returned no final response', 'EMPTY_RESPONSE')
      const result = parseReply(readFileSync(responseFile, 'utf8'), request.tools)
      result.usage = latestUsage(stdout)
      return result
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  #run(args, input, signal, cwd) {
    return new Promise((resolvePromise, rejectPromise) => {
      let child
      try {
        child = this.spawn(this.cliPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd })
      } catch (error) {
        rejectPromise(new RelayError(`Codex CLI could not be started: ${error.message}`, 'TRANSPORT', { cause: error }))
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, this.timeoutMs)
      const onAbort = () => child.kill()
      if (signal !== undefined && signal !== null) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      const finish = action => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        action()
      }
      child.stdout?.on('data', chunk => { stdout += chunk })
      child.stderr?.on('data', chunk => { stderr += chunk })
      child.stdin?.on('error', () => {})
      child.on('error', error => finish(() =>
        rejectPromise(new RelayError(`Codex CLI could not be started: ${error.message}`, 'TRANSPORT', { cause: error }))))
      child.on('close', code => finish(() => {
        if (signal?.aborted) {
          const abortError = new Error('Codex CLI request aborted')
          abortError.name = 'AbortError'
          rejectPromise(abortError)
        } else if (timedOut) {
          rejectPromise(new RelayError('Codex CLI request timed out', 'TIMEOUT'))
        } else if (code !== 0) {
          rejectPromise(classifyExit(code, stderr))
        } else {
          resolvePromise({ stdout, stderr })
        }
      }))
      child.stdin?.end(input)
    })
  }
}
