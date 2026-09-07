/**
 * Grok Build CLI model runner.
 *
 * Runs the locally installed, subscription-authenticated `grok` CLI
 * (Grok Build TUI >= 1.0) in headless single-turn mode as a pure language
 * model for the Harness: all of the CLI's own agentic surface is disabled
 * (`--tools=`, `--no-subagents`, `--no-plan`, `--disable-web-search`,
 * `--max-turns 1`) so the DeepSeek Harness keeps sole ownership of tools,
 * files and the agent loop. `--json-schema` constrains the reply to the same
 * `{"blocks":[...]}` protocol the ChatGPT relay uses, and the CLI's JSON
 * envelope supplies real token usage, which the browser relay cannot.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayError, parseReply, relayPrompt } from './chatgpt-relay.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

// Grok Build normally injects its full coding-agent system prompt even when
// every tool is disabled. That costs tens of thousands of input tokens on
// every Harness model round and gives the model a second, competing agent
// identity. The Harness request already carries the complete system prompt,
// messages, and scoped tool schemas, so the CLI only needs this small adapter
// contract around it.
const BACKEND_SYSTEM_PROMPT = [
  'You are a stateless language-model backend for the DeepSeek Harness request in the user message.',
  'Treat EXACT_HARNESS_REQUEST_JSON.system, messages, tools, and generation settings as the authoritative request.',
  'Do not inspect files, run tools, or act as a separate coding agent; return only the schema-constrained model decision.',
].join(' ')

// Prompts routinely exceed the Windows 32K command-line limit, so the request
// always travels via --prompt-file rather than a positional argument.
const BLOCKS_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text', 'reasoning', 'tool_call'] },
          text: { type: 'string' },
          id: { type: 'string' },
          name: { type: 'string' },
          arguments: { type: 'object' },
        },
        required: ['type'],
      },
    },
    finishReason: { type: 'string', enum: ['stop', 'tool-calls', 'max-tokens'] },
  },
  required: ['blocks'],
})

/** Map Harness reasoning efforts onto the CLI's effort levels (1:1). */
function grokEffort(effort) {
  if (effort === 'light') return 'low'
  if (effort === 'high') return 'high'
  if (effort === 'max') return 'xhigh'
  return 'medium'
}

/** Locate the Grok Build CLI: explicit config path first, then the default install. */
export function resolveGrokCliPath(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const path = explicit.trim()
    return existsSync(path) ? path : null
  }
  const binary = process.platform === 'win32' ? 'grok.exe' : 'grok'
  const home = join(homedir(), '.grok', 'bin', binary)
  return existsSync(home) ? home : null
}

function classifyExit(code, stderr) {
  const detail = String(stderr ?? '').trim()
  if (/rate.?limit|too many requests|\b429\b/i.test(detail)) {
    return new RelayError(`Grok CLI rate limited: ${detail.slice(0, 300)}`, 'RATE_LIMIT')
  }
  if (/not logged in|login|credential|unauthorized|\b401\b/i.test(detail)) {
    return new RelayError(`Grok CLI is not authenticated (run "grok login"): ${detail.slice(0, 300)}`, 'SERVER')
  }
  return new RelayError(`Grok CLI exited with code ${code}: ${detail.slice(0, 300)}`, 'SERVER')
}

function mapUsage(usage) {
  if (usage === undefined || usage === null) return { inputTokens: 0, outputTokens: 0 }
  const count = value => (Number.isFinite(value) && value >= 0 ? value : 0)
  const mapped = {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
  }
  if (count(usage.cache_read_input_tokens) > 0) mapped.cacheReadTokens = count(usage.cache_read_input_tokens)
  if (count(usage.cache_creation_input_tokens) > 0) mapped.cacheWriteTokens = count(usage.cache_creation_input_tokens)
  if (count(usage.reasoning_tokens) > 0) mapped.reasoningTokens = count(usage.reasoning_tokens)
  return mapped
}

function finishFromStopReason(stopReason) {
  if (stopReason === 'max_tokens' || stopReason === 'max-tokens') return 'max-tokens'
  return undefined
}

export class GrokCliRunner {
  constructor({ cliPath, timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn }) {
    if (typeof cliPath !== 'string' || cliPath.trim() === '') throw new Error('grok cliPath is required')
    this.cliPath = cliPath
    this.timeoutMs = timeoutMs
    this.spawn = spawnImpl
  }

  async complete(request, signal, { model, effort } = {}) {
    const workDir = mkdtempSync(join(tmpdir(), 'shiro-grok-'))
    const promptFile = join(workDir, 'prompt.txt')
    try {
      writeFileSync(promptFile, relayPrompt(request, { fenced: false }), 'utf8')
      const args = [
        '--prompt-file', promptFile,
        '--json-schema', BLOCKS_SCHEMA,
        '--system-prompt-override', BACKEND_SYSTEM_PROMPT,
        '--verbatim',
        // 2, not 1: the schema-constrained final answer sometimes lands on a
        // second internal turn. With every tool disabled the extra turn can
        // only ever be the model finishing its reply.
        '--max-turns', '2',
        '--no-subagents',
        '--no-plan',
        '--disable-web-search',
        '--tools=',
        '--reasoning-effort', grokEffort(effort),
      ]
      if (typeof model === 'string' && model !== '') args.push('-m', model)
      // Run from the empty temp directory: the CLI hydrates project context
      // (file tree, rule files) from its cwd, which is pure token overhead
      // here -- the Harness request already carries the full context.
      const { stdout } = await this.#run(args, signal, workDir)
      return this.#settle(stdout, request)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  #settle(stdout, request) {
    let envelope
    try {
      envelope = JSON.parse(stdout)
    } catch {
      throw new RelayError('Grok CLI returned an unparseable envelope', 'EMPTY_RESPONSE')
    }
    const structured = envelope?.structuredOutput
    const rawText = structured !== undefined && structured !== null
      ? JSON.stringify(structured)
      : String(envelope?.text ?? '')
    const result = parseReply(rawText, request.tools)
    const thought = typeof envelope?.thought === 'string' ? envelope.thought.trim() : ''
    if (thought !== '' && !result.blocks.some(block => block.type === 'reasoning')) {
      result.blocks = [{ type: 'reasoning', text: thought }, ...result.blocks]
    }
    result.usage = mapUsage(envelope?.usage)
    result.finishReason = finishFromStopReason(envelope?.stopReason) ?? result.finishReason
    return result
  }

  #run(args, signal, cwd) {
    return new Promise((resolvePromise, rejectPromise) => {
      let child
      try {
        child = this.spawn(this.cliPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd })
      } catch (error) {
        rejectPromise(new RelayError(`Grok CLI could not be started: ${error.message}`, 'TRANSPORT', { cause: error }))
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
      child.on('error', error => finish(() =>
        rejectPromise(new RelayError(`Grok CLI could not be started: ${error.message}`, 'TRANSPORT', { cause: error }))))
      child.on('close', code => finish(() => {
        if (signal?.aborted) {
          const abortError = new Error('Grok CLI request aborted')
          abortError.name = 'AbortError'
          rejectPromise(abortError)
        } else if (timedOut) {
          rejectPromise(new RelayError('Grok CLI request timed out', 'TIMEOUT'))
        } else if (code !== 0) {
          rejectPromise(classifyExit(code, stderr))
        } else {
          resolvePromise({ stdout, stderr })
        }
      }))
    })
  }
}
