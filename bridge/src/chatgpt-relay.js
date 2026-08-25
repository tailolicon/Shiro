import { createHash, randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_MAX_THREAD_TURNS = 40
const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

// Mirrors `DEFAULT_RETRYABLE_CODES` in engine/packages/llm/llm/src/retry-policy.ts.
// Bridge cannot import that constant (see the RelayError doc comment below),
// so the exact five codes are duplicated here; keep them in sync.
export const RELAY_RETRYABLE_CODES = Object.freeze([EMPTY_RESPONSE_CODE, 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

/**
 * Typed relay failure. Carries an own `code` and an own `failure` snapshot
 * shaped exactly like `@deepseek-ai/dsh-llm`'s `LlmFailure`/`LlmError`
 * contract (message/code/status?/providerRetryAfterMs?/requestId?).
 *
 * bridge/package.json has no dependency on `@deepseek-ai/dsh-llm` (it only
 * depends on `@modelcontextprotocol/sdk` and `zod`; the engine `llm` package
 * is a peer of the whole DSH bundle, not importable from here), so this
 * class cannot extend the engine's `LlmError`/`HarnessError`. Instead it
 * duck-types the contract engine/packages/llm/llm/src/adapter-failure.ts
 * actually checks: `normalizeLlmFailure()` reads a thrown error's own
 * `failure` data property, and trusts it only when `failure.code` agrees
 * with the error's own `code` data property. Both are set as own properties
 * here, so a `RelayError` thrown out of the adapter survives normalization
 * with its exact code intact even though it is not an `instanceof HarnessError`.
 */
export class RelayError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RelayError'
    this.code = code
    const { status, providerRetryAfterMs, requestId } = options
    this.failure = Object.freeze({
      message,
      code,
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
      ...(Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0 ? { providerRetryAfterMs } : {}),
      ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
    })
  }
}

function asRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim()
}

function normalizeLoopbackUrl(value) {
  const url = new URL(asRequiredString(value, 'relayUrl'))
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('relayUrl must be a loopback HTTP URL')
  }
  return url.href.replace(/\/$/, '')
}

function effortForRelay(value) {
  if (value === 'light') return 'instant'
  if (value === 'standard') return 'medium'
  if (value === 'high' || value === 'max') return 'high'
  return 'auto'
}

function resolveMaxThreadTurns(explicit) {
  if (Number.isInteger(explicit) && explicit > 0) return explicit
  const fromEnv = Number(process.env.SHIRO_RELAY_MAX_THREAD_TURNS)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  return DEFAULT_MAX_THREAD_TURNS
}

/** Parse an HTTP `Retry-After` header (seconds or an HTTP-date) into a positive ms delay, or undefined. */
function parseRetryAfterMs(value) {
  if (value === null || value === undefined || value === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.round(seconds * 1000) : undefined
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return undefined
  const deltaMs = dateMs - Date.now()
  return deltaMs > 0 ? Math.round(deltaMs) : undefined
}

function httpFailureCode(status) {
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'CLIENT_ERROR'
}

/** Classify a non-OK relay HTTP response into a typed, retry-taxonomy-aware error. */
async function relayHttpError(response) {
  const body = await response.json().catch(() => ({}))
  const detail = body.detail ?? body.error ?? 'request failed'
  const code = httpFailureCode(response.status)
  const retryAfterMs = code === 'RATE_LIMIT' ? parseRetryAfterMs(response.headers?.get?.('retry-after')) : undefined
  return new RelayError(`ChatGPT browser relay HTTP ${response.status}: ${detail}`, code, {
    status: response.status,
    ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }),
  })
}

/** Classify a thrown `fetch()` failure (network, DNS, or our own timeout abort). A genuine user abort passes through unchanged. */
function classifyFetchFailure(error, userSignal) {
  if (userSignal?.aborted) return error
  const name = error && typeof error === 'object' ? error.name : undefined
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new RelayError('ChatGPT browser relay request timed out', 'TIMEOUT', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RelayError(`ChatGPT browser relay request failed: ${message}`, 'TRANSPORT', { cause: error })
}

/**
 * Escape double quotes the model embedded raw inside JSON string values
 * (for example a PowerShell command containing "env:APPDATA/npm"). A quote
 * inside a string only really closes it when the next non-whitespace
 * character is structural JSON (, } ] : or end of input); any other
 * follower means the model forgot to escape, so the quote is content.
 * Heuristic by nature -- an embedded quote directly followed by a comma is
 * still misread as a close -- but it is only ever tried after strict
 * parsing has already failed, so it can only rescue, never corrupt.
 */
function repairUnescapedInnerQuotes(candidate) {
  let out = ''
  let inString = false
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (ch === '\\') {
      out += ch + (candidate[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < candidate.length && /\s/.test(candidate[j])) j++
      const next = candidate[j]
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        inString = false
        out += ch
      } else {
        out += '\\"'
      }
      continue
    }
    out += ch
  }
  return out
}

function repairPathBackslashes(candidate) {
  // ChatGPT occasionally emits otherwise-valid JSON with raw Windows path
  // separators (for example E:\Project\Shiro). Repair path-like backslashes
  // only after strict parsing fails so valid JSON escapes keep their meaning.
  return candidate.replace(
    /(?<=[A-Za-z0-9:._-])\\(?=[A-Za-z0-9._-])/g,
    '\\\\',
  )
}

function extractJson(text) {
  const trimmed = String(text ?? '').trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidates = [trimmed, fenced].filter(Boolean)
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) } catch {}
  }
  // Repair passes run strictly after clean parsing fails, cheapest first,
  // then combined: backslashes, embedded quotes, both together.
  const repairs = [
    repairPathBackslashes,
    repairUnescapedInnerQuotes,
    candidate => repairUnescapedInnerQuotes(repairPathBackslashes(candidate)),
  ]
  for (const repair of repairs) {
    for (const candidate of candidates) {
      const repaired = repair(candidate)
      if (repaired === candidate) continue
      try { return JSON.parse(repaired) } catch {}
    }
  }
  return null
}

/** True when the raw reply attempted the `{"blocks":[...]}` protocol, whether or not it parses. */
function looksLikeAttemptedJson(rawText) {
  const trimmed = String(rawText ?? '').trim()
  // Any fenced reply counts as an attempt: the protocol instructs one fenced
  // JSON block, and a fence holding something else is the signature of the
  // browser extension reconstructing only a fragment of the real reply
  // (e.g. a lone inline-code chip) -- retry, never deliver the fragment.
  if (trimmed.startsWith('```')) return true
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i)?.[1]?.trim()
  return (fenced ?? trimmed).startsWith('{')
}

function normalizeBlocks(payload, rawText, allowedTools) {
  let blocks = Array.isArray(payload?.blocks) ? payload.blocks : null
  if (blocks === null && Array.isArray(payload?.tool_calls)) {
    blocks = payload.tool_calls.map(call => ({
      type: 'tool_call',
      id: call.id,
      name: call.name ?? call.function?.name,
      arguments: call.arguments ?? call.function?.arguments,
    }))
  }
  if (blocks === null) {
    const text = typeof payload?.text === 'string' ? payload.text : rawText
    return [{ type: 'text', text }]
  }
  return blocks.map((block, index) => {
    if (block?.type === 'tool_call' || block?.type === 'tool-call') {
      const name = asRequiredString(block.name, `blocks[${index}].name`)
      if (!allowedTools.has(name)) throw new Error(`relay returned unavailable Harness tool: ${name}`)
      return {
        type: 'tool_call',
        id: typeof block.id === 'string' && block.id ? block.id : `shiro-tool-${randomUUID()}`,
        name,
        arguments: block.arguments ?? {},
      }
    }
    if (block?.type === 'reasoning') {
      return { type: 'reasoning', text: String(block.text ?? '') }
    }
    return { type: 'text', text: String(block?.text ?? '') }
  }).filter(block => block.type === 'tool_call' || block.text !== '')
}

/**
 * Parse one raw structured model reply into Harness blocks. Shared by the
 * buffered `complete()`, the final settlement of `streamComplete()`, and the
 * Grok CLI runner, so every backend classifies failures identically and
 * produces byte-identical results for the same raw text.
 */
export function parseReply(rawText, tools) {
  if (rawText.trim() === '') throw new RelayError('ChatGPT browser relay returned an empty response', EMPTY_RESPONSE_CODE)
  const payload = extractJson(rawText)
  if (payload === null && looksLikeAttemptedJson(rawText)) {
    throw new RelayError(
      'ChatGPT browser relay reply began the structured JSON protocol but was truncated or malformed',
      EMPTY_RESPONSE_CODE,
    )
  }
  const allowedTools = new Set((tools ?? []).map(tool => tool?.name).filter(name => typeof name === 'string'))
  const blocks = normalizeBlocks(payload, rawText, allowedTools)
  if (blocks.length === 0) throw new RelayError('ChatGPT browser relay returned no usable blocks', EMPTY_RESPONSE_CODE)
  const inferred = blocks.some(block => block.type === 'tool_call') ? 'tool-calls' : 'stop'
  return {
    blocks,
    finishReason: ['stop', 'tool-calls', 'max-tokens'].includes(payload?.finishReason) ? payload.finishReason : inferred,
    usage: { inputTokens: 0, outputTokens: 0 },
    // A reply that never attempted the structured protocol is still delivered
    // as text (a genuine prose answer must not become a hard failure), but the
    // caller is told, because on a continuation turn it is the signature of
    // the model drifting off-protocol in a long thread.
    protocolDrift: payload === null,
  }
}

export function relayPrompt(request, { fenced = true } = {}) {
  // fenced=true is essential on the browser path: a naked JSON reply gets
  // markdown-rendered by the ChatGPT UI (math from $...$, autolinks, inline
  // code chips), and the extension's DOM-to-markdown reconstruction can drop
  // everything but a stray code chip. Inside one fenced block the reply stays
  // verbatim and code blocks are the one shape the extractor always returns
  // intact. The Grok CLI path passes fenced=false because --json-schema
  // already constrains its output.
  const formatLine = fenced
    ? 'Wrap your ENTIRE reply in exactly one fenced code block: the first line must be ```json and the last line must be ```. Output nothing outside that fence, and exactly one JSON object inside it.'
    : 'Return exactly one JSON object with no Markdown fence or surrounding prose.'
  return [
    'You are the language-model component inside Shiro, a DeepSeek Harness agent.',
    'The Harness owns every tool, plugin, permission, subagent, workflow, terminal, filesystem and Git operation.',
    'Never claim to execute a tool yourself. When a tool is needed, request it and let Harness execute it.',
    formatLine,
    'Schema: {"blocks":[{"type":"text","text":"..."}|{"type":"reasoning","text":"visible concise reasoning summary"}|{"type":"tool_call","id":"unique-id","name":"exact available tool name","arguments":{}}],"finishReason":"stop"|"tool-calls"|"max-tokens"}.',
    'The response must be strict JSON. Inside argument strings, use forward slashes for paths and never emit a raw Windows backslash.',
    'Escape every double quote inside a JSON string value as \\". In shell commands prefer single quotes so no escaping is needed.',
    'Use only tool names and argument shapes present in the exact Harness request below.',
    'If tools are required, prefer tool_call blocks and set finishReason to tool-calls. Do not fabricate tool results.',
    'The request contains the complete current context, including prior Harness tool results.',
    '',
    'EXACT_HARNESS_REQUEST_JSON',
    JSON.stringify(request),
  ].join('\n')
}

/**
 * Continuation form: the browser conversation already holds every earlier turn
 * of this Harness session, so only the events recorded since the last accepted
 * reply travel over the wire. Resending the whole transcript every turn makes
 * the thread grow quadratically (the tab keeps each prior full-history prompt
 * on top of the new one), which burns the ChatGPT-side context window, slows
 * time-to-first-token, and pushes the composer toward the large-paste path
 * that ChatGPT converts into a file attachment.
 *
 * Only used once the relay has proven the thread is still in sync with the
 * Harness transcript. Every uncertainty (compaction, rewind, changed system
 * prompt or tools, a failed dispatch, session change, rotation) falls back to
 * relayPrompt() on a fresh thread, so correctness never depends on this
 * optimization holding.
 */
export function relayDeltaPrompt(request, delta, { fenced = true } = {}) {
  const formatLine = fenced
    ? 'Wrap your ENTIRE reply in exactly one fenced code block: the first line must be ```json and the last line must be ```. Output nothing outside that fence, and exactly one JSON object inside it.'
    : 'Return exactly one JSON object with no Markdown fence or surrounding prose.'
  const toolsChanged = delta.tools !== null && delta.tools !== undefined
  const continuation = {
    request_id: request.request_id,
    session_id: request.session_id ?? null,
    purpose: request.purpose ?? 'conversation',
    provider: request.provider,
    model: request.model,
    generation: request.generation,
    new_messages: delta.messages,
    ...(toolsChanged ? { tools: delta.tools } : {}),
  }
  return [
    'Continue the same Shiro / DeepSeek Harness session from earlier in this conversation.',
    'The complete prior context is already above. Reuse it; never ask for it to be repeated.',
    'Below are ONLY the Harness events recorded since your last reply, in order.',
    'The Harness owns every tool, plugin, permission, subagent, workflow, terminal, filesystem and Git operation.',
    'Never claim to execute a tool yourself. When a tool is needed, request it and let Harness execute it.',
    formatLine,
    'Schema: {"blocks":[{"type":"text","text":"..."}|{"type":"reasoning","text":"visible concise reasoning summary"}|{"type":"tool_call","id":"unique-id","name":"exact available tool name","arguments":{}}],"finishReason":"stop"|"tool-calls"|"max-tokens"}.',
    'The response must be strict JSON. Inside argument strings, use forward slashes for paths and never emit a raw Windows backslash.',
    'Escape every double quote inside a JSON string value as \\". In shell commands prefer single quotes so no escaping is needed.',
    toolsChanged
      ? 'The available tool list CHANGED. Use only the tool names listed below.'
      : 'The available tools are unchanged from earlier in this conversation. Use only those tool names.',
    'If tools are required, prefer tool_call blocks and set finishReason to tool-calls. Do not fabricate tool results.',
    '',
    'NEW_HARNESS_EVENTS_JSON',
    JSON.stringify(continuation),
  ].join('\n')
}

function toBase64(data) {
  if (typeof data === 'string') return data
  return Buffer.from(data).toString('base64')
}

function byteLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'base64')
  return data?.byteLength ?? data?.length ?? 0
}

/** Parse one `\n\n`-delimited SSE frame into its JSON `data:` payload, or null when it carries none. */
function parseSseFrame(frame) {
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) data += (data.length > 0 ? '\n' : '') + line.slice(5).trimStart()
  }
  if (data.length === 0) return null
  try { return JSON.parse(data) } catch { return null }
}

function sseErrorToRelayError(frame) {
  const err = frame.error ?? {}
  const message = typeof err.message === 'string' && err.message ? err.message : 'ChatGPT browser relay request failed'
  const code = typeof err.code === 'string' && RELAY_RETRYABLE_CODES.includes(err.code) ? err.code : 'SERVER'
  return new RelayError(`ChatGPT browser relay stream error: ${message}`, code)
}

const UNICODE_ESCAPE_CHARS = 4
const SIMPLE_ESCAPES = Object.freeze({ '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' })

/**
 * Bounded incremental extractor for the first text block's string value out
 * of a streaming `{"blocks":[{"type":"text","text":"..."}...]}` reply.
 *
 * Deliberately narrow: it only starts extracting once the buffered reply is
 * anchored exactly on `{"blocks":[{"type":"text","text":"` (optionally past
 * a stripped code fence) -- the literal schema relayPrompt() instructs the
 * model to use. That anchor guarantees, by construction, that anything this
 * extractor streams corresponds to the eventual `blocks[0]` of the fully
 * parsed reply, so the caller can always safely index streamed deltas at 0.
 * Any other shape (a reasoning or tool_call block first, prose or a
 * prose-prefixed reply, key order the model didn't follow, or an escape
 * sequence the scanner cannot decode)
 * simply yields no deltas at all rather than something incorrect -- the
 * authoritative final blocks always come from re-parsing the complete raw
 * text (see `parseReply`), never from reassembling emitted deltas, so a
 * confused scanner can never corrupt the final result, only skip the
 * streaming preview for that one reply.
 */
class IncrementalTextExtractor {
  #mode = 'sniff' // sniff -> in-string | done
  #buffer = ''
  #pendingEscape = ''
  #active = true

  push(text) {
    if (!this.#active || text.length === 0) return []
    if (this.#mode === 'in-string') return this.#consumeString(text)
    if (this.#mode === 'done') return []
    this.#buffer += text
    return this.#advance()
  }

  #advance() {
    const trimmed = this.#buffer.replace(/^\s+/, '')
    if (trimmed.length === 0) return []
    const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?/i)
    const content = fenceMatch ? trimmed.slice(fenceMatch[0].length) : trimmed
    if (fenceMatch && content.length === 0) return []
    if (!content.startsWith('{')) {
      // A reply that does not open with the JSON protocol is NOT safe to
      // stream: parseReply()'s extractJson() can still recover an embedded
      // `{...}` from mid-prose (e.g. "Here's the plan: {json}"), in which
      // case the final blocks[0] may be a tool_call while the streamed
      // deltas claimed a text block at index 0 -- a stream-grammar
      // violation the engine's llm-invariant validator throws on. Skip the
      // preview entirely; the buffered settlement emits everything.
      this.#active = false
      this.#mode = 'done'
      this.#buffer = ''
      return []
    }
    const anchor = /^\{\s*"blocks"\s*:\s*\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"/
    const match = content.match(anchor)
    if (match !== null) {
      this.#mode = 'in-string'
      const remainder = content.slice(match[0].length)
      this.#buffer = ''
      return this.#consumeString(remainder)
    }
    if (content.length > 128) {
      this.#active = false
      this.#mode = 'done'
      this.#buffer = ''
    }
    return []
  }

  #consumeString(text) {
    const out = []
    let literal = ''
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (this.#pendingEscape.startsWith('\\u')) {
        this.#pendingEscape += ch
        if (this.#pendingEscape.length === 2 + UNICODE_ESCAPE_CHARS) {
          const hex = this.#pendingEscape.slice(2)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            literal += String.fromCharCode(Number.parseInt(hex, 16))
            this.#pendingEscape = ''
          } else {
            this.#active = false
            this.#mode = 'done'
            if (literal.length > 0) out.push(literal)
            return out
          }
        }
        continue
      }
      if (this.#pendingEscape === '\\') {
        if (ch === 'u') { this.#pendingEscape = '\\u'; continue }
        const simple = SIMPLE_ESCAPES[ch]
        if (simple === undefined) {
          this.#active = false
          this.#mode = 'done'
          if (literal.length > 0) out.push(literal)
          return out
        }
        literal += simple
        this.#pendingEscape = ''
        continue
      }
      if (ch === '\\') { this.#pendingEscape = '\\'; continue }
      if (ch === '"') {
        this.#mode = 'done'
        this.#active = false
        if (literal.length > 0) out.push(literal)
        return out
      }
      literal += ch
    }
    if (literal.length > 0) out.push(literal)
    return out
  }
}

/** Stable fingerprint of any JSON-serializable value, for cheap prefix comparison. */
function fingerprint(value) {
  return createHash('sha1').update(JSON.stringify(value ?? null)).digest('hex')
}

export class ChatGptBrowserRelay {
  #lastSessionId = null
  #turnsOnThread = 0
  #started = false
  // Delta bookkeeping: how much of the Harness transcript the live browser
  // thread has already received, and fingerprints proving it is still the
  // same transcript (not compacted, rewound, or re-prompted underneath us).
  #deliveredCount = 0
  #prefixHash = ''
  #systemHash = ''
  #toolsHash = ''
  // Count of replies that arrived without the structured protocol.
  #driftCount = 0
  // Set immediately before a dispatch and cleared only on a committed reply.
  // A failed turn may or may not have reached the composer, so the thread's
  // contents become unknown and the next turn must resend everything fresh.
  #forceFull = false

  constructor({ url, token, model = 'GPT-5.6 Sol', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, maxThreadTurns }) {
    this.url = normalizeLoopbackUrl(url)
    this.token = asRequiredString(token, 'relayToken')
    this.model = asRequiredString(model, 'relayModel')
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
    this.maxThreadTurns = resolveMaxThreadTurns(maxThreadTurns)
  }

  async health(signal) {
    try {
      const response = await this.fetch(`${this.url}/health`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal,
      })
      if (!response.ok) return { ready: false, detail: `HTTP ${response.status}` }
      const body = await response.json()
      return {
        ready: body.ok === true && Number(body.clients ?? 0) > 0 && body.needsSelection !== true,
        clients: Number(body.clients ?? 0),
        detail: body.needsSelection === true ? 'browser tab selection required' : '',
      }
    } catch (error) {
      return { ready: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Decide whether this call should start a fresh browser conversation.
   * - One-shot side tasks (compaction / session-title) always get a fresh
   *   thread and never touch the main thread's tracked session or turn count.
   * - A tracked harness session id that changes from the last one served
   *   rotates the thread (the conversation moved to a different Harness
   *   session; reusing the browser tab's conversation would mix histories).
   * - Otherwise, a bounded number of turns on the same browser conversation
   *   forces rotation, since the complete Harness context is re-sent on
   *   every relayPrompt() call and an unbounded single ChatGPT conversation
   *   only accumulates browser-side overhead.
   */
  #planThread(request) {
    const purpose = request.purpose
    const sessionId = typeof request.session_id === 'string' && request.session_id !== '' ? request.session_id : null
    const isSideTask = purpose === 'compaction' || purpose === 'session-title'
    let newSession = false
    if (isSideTask) newSession = true
    // The first main-thread call of a fresh process must not silently
    // continue whatever conversation the browser tab was left on by a
    // previous Shiro run -- that history belongs to another lifetime.
    else if (!this.#started) newSession = true
    // A previous dispatch failed after the prompt may already have reached the
    // composer, so the thread's contents are unknown: start over cleanly.
    else if (this.#forceFull) newSession = true
    else if (sessionId !== null && this.#lastSessionId !== null && sessionId !== this.#lastSessionId) newSession = true
    else if (this.#turnsOnThread >= this.maxThreadTurns) newSession = true

    // Only an in-sync continuation thread may receive a delta. When the
    // transcript diverged (compaction dropped or rewrote earlier turns, a
    // rewind moved the head, the system prompt changed), the live thread still
    // holds the superseded originals, so continuing it would show the model a
    // context the Harness no longer intends. Rotating to a fresh thread and
    // resending in full is the only correct repair -- and it reclaims the
    // ChatGPT-side context window at the same time.
    let delta = null
    if (!newSession) {
      delta = this.#planDelta(request)
      if (delta === null) newSession = true
    }
    return { newSession, sessionId, isSideTask, delta }
  }

  /** The messages recorded since the last committed turn, or null when a delta is unsafe. */
  #planDelta(request) {
    const messages = Array.isArray(request.messages) ? request.messages : []
    if (this.#deliveredCount === 0 || messages.length <= this.#deliveredCount) return null
    if (fingerprint(messages.slice(0, this.#deliveredCount)) !== this.#prefixHash) return null
    if (fingerprint(request.system ?? '') !== this.#systemHash) return null
    const toolsHash = fingerprint(request.tools ?? [])
    return {
      messages: messages.slice(this.#deliveredCount),
      tools: toolsHash === this.#toolsHash ? null : (request.tools ?? []),
    }
  }

  /**
   * Record an off-protocol reply. Repeating the protocol in every continuation
   * makes drift unlikely, but a long thread can still dilute it. Drift on a
   * continuation is self-healed by re-anchoring: the next turn opens a fresh
   * thread carrying the full transcript and the protocol at its head. Drift on
   * a turn that was already a full resend has no stronger remedy, so it is
   * only reported.
   */
  #noteDrift(plan) {
    this.#driftCount += 1
    const wasContinuation = plan.delta !== null && plan.delta !== undefined
    process.stderr.write(
      `shiro-relay: reply ${this.#driftCount} ignored the structured protocol `
      + `(${wasContinuation ? 'continuation turn; re-anchoring on a fresh thread' : 'full-context turn'})
`,
    )
    if (wasContinuation) this.#forceFull = true
  }

  /** Replies so far that arrived without the structured protocol. */
  get driftCount() {
    return this.#driftCount
  }

  #commitThread(plan, request) {
    if (plan.isSideTask) {
      // The side task ran in its own fresh browser conversation, which is now
      // the tab's active thread -- the main session's thread is no longer the
      // one a `newSession: false` call would continue. Under full resend that
      // was merely untidy; a delta continuation would append to the wrong
      // conversation, so the next main turn must open a fresh thread and
      // resend everything.
      this.#deliveredCount = 0
      this.#prefixHash = ''
      this.#forceFull = true
      return
    }
    this.#started = true
    this.#lastSessionId = plan.sessionId
    this.#turnsOnThread = plan.newSession ? 1 : this.#turnsOnThread + 1
    const messages = Array.isArray(request.messages) ? request.messages : []
    this.#deliveredCount = messages.length
    this.#prefixHash = fingerprint(messages)
    this.#systemHash = fingerprint(request.system ?? '')
    this.#toolsHash = fingerprint(request.tools ?? [])
    this.#forceFull = false
  }

  #buildBody(request, plan, attachments, stream) {
    return {
      message: plan.delta === null || plan.delta === undefined
        ? relayPrompt(request)
        : relayDeltaPrompt(request, plan.delta),
      model: this.model,
      effort: effortForRelay(request.generation?.reasoning_effort),
      newSession: plan.newSession,
      autoOpenTab: false,
      ...(attachments === undefined ? {} : { attachments }),
      ...(stream ? { stream: true } : {}),
    }
  }

  async #post(path, body, combinedSignal, userSignal) {
    let response
    try {
      response = await this.fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      })
    } catch (error) {
      throw classifyFetchFailure(error, userSignal)
    }
    if (!response.ok) throw await relayHttpError(response)
    return response
  }

  async #uploadImage(image, combinedSignal, userSignal) {
    const contentBase64 = toBase64(image.data)
    const response = await this.#post('/files', {
      name: image.name,
      mime: image.mediaType,
      contentBase64,
    }, combinedSignal, userSignal)
    const body = await response.json().catch(() => ({}))
    const file = body.file
    if (file === undefined || file === null || typeof file.id !== 'string' || file.id === '') {
      throw new RelayError('ChatGPT browser relay image upload returned no file id', 'SERVER')
    }
    return {
      id: file.id,
      name: String(file.name ?? image.name ?? 'image'),
      mime: String(file.mime ?? image.mediaType ?? 'application/octet-stream'),
      size: Number.isFinite(file.size) ? file.size : byteLength(image.data),
    }
  }

  async #uploadImages(images, combinedSignal, userSignal) {
    const uploaded = []
    for (const image of images) uploaded.push(await this.#uploadImage(image, combinedSignal, userSignal))
    return uploaded
  }

  /**
   * Buffered completion: one Harness model request -> one ChatGPT reply,
   * parsed into blocks. `images` (optional) are uploaded to the relay's file
   * store first and passed through as `attachments` in the shape its /chat
   * route accepts (`{id, name, mime, size}`, matching `attachmentProjection`
   * in relay/chatgpt-bridge/src/bridge/requestExecutionPlan.js).
   */
  async complete(request, signal, images = []) {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const plan = this.#planThread(request)
    const attachments = images.length > 0 ? await this.#uploadImages(images, combined, signal) : undefined
    // From here the prompt may reach the composer; only a committed reply
    // proves what the thread now holds.
    this.#forceFull = true
    const response = await this.#post('/chat', this.#buildBody(request, plan, attachments, false), combined, signal)
    const body = await response.json().catch(() => ({}))
    const rawText = String(body.response ?? body.answer ?? '')
    const result = parseReply(rawText, request.tools)
    this.#commitThread(plan, request)
    if (result.protocolDrift) this.#noteDrift(plan)
    return result
  }

  /**
   * Streaming completion. Yields `{type:'delta', text}` chunks as the model's
   * first text block is typed (best-effort; see `IncrementalTextExtractor`),
   * then exactly one `{type:'final', value}` carrying the same shape
   * `complete()` returns, computed by parsing the complete raw reply -- so
   * the assembled result is always identical to the buffered path regardless
   * of how much (or how little) incremental preview was possible.
   *
   * Falls back to a plain buffered read of the same HTTP response (no second
   * request) when the relay did not actually answer with an SSE stream (a
   * non `text/event-stream` content type, or no readable body). Never
   * issues a second HTTP request to "recover" from a mid-stream problem --
   * once one browser-side prompt has been submitted, resubmitting would
   * duplicate a real ChatGPT turn instead of safely retrying a local parse.
   */
  async *streamComplete(request, signal, images = []) {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const plan = this.#planThread(request)
    const attachments = images.length > 0 ? await this.#uploadImages(images, combined, signal) : undefined
    // Same rule as complete(): the thread's contents are unknown until commit.
    this.#forceFull = true
    const response = await this.#post('/chat', this.#buildBody(request, plan, attachments, true), combined, signal)

    const body = response.body
    const contentType = response.headers?.get?.('content-type') ?? ''
    if (!contentType.includes('text/event-stream') || body === null || body === undefined || typeof body.getReader !== 'function') {
      const parsed = await response.json().catch(() => null)
      const rawText = parsed === null ? '' : String(parsed.response ?? parsed.answer ?? '')
      const result = parseReply(rawText, request.tools)
      this.#commitThread(plan, request)
      if (result.protocolDrift) this.#noteDrift(plan)
      yield { type: 'final', value: result }
      return
    }

    const extractor = new IncrementalTextExtractor()
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let sseBuffer = ''
    let finalResult
    let streamError
    try {
      while (finalResult === undefined && streamError === undefined) {
        let value, done
        try {
          ({ value, done } = await reader.read())
        } catch (error) {
          // Same taxonomy as #post: a mid-stream timeout or dropped
          // connection must surface as a retryable TIMEOUT/TRANSPORT code,
          // while a genuine user abort passes through for the adapter's
          // aborted-finish handling.
          throw classifyFetchFailure(error, signal)
        }
        if (done) break
        sseBuffer += decoder.decode(value, { stream: true })
        let frameEnd = sseBuffer.indexOf('\n\n')
        while (frameEnd !== -1) {
          const frame = sseBuffer.slice(0, frameEnd)
          sseBuffer = sseBuffer.slice(frameEnd + 2)
          const parsed = parseSseFrame(frame)
          if (parsed !== null) {
            if (parsed.type === 'request.result') {
              finalResult = parsed.result
            } else if (parsed.type === 'request.error') {
              streamError = sseErrorToRelayError(parsed)
            } else if (parsed.type === 'answer.snapshot' || parsed.type === 'answer.delta') {
              const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
              if (delta.length > 0) for (const chunk of extractor.push(delta)) yield { type: 'delta', text: chunk }
            }
          }
          if (finalResult !== undefined || streamError !== undefined) break
          frameEnd = sseBuffer.indexOf('\n\n')
        }
      }
    } finally {
      try { await reader.cancel() } catch {}
    }

    if (streamError !== undefined) throw streamError
    if (finalResult === undefined) {
      throw new RelayError('ChatGPT browser relay stream ended before a result was received', 'TRANSPORT')
    }
    const rawText = String(finalResult.answer ?? '')
    const result = parseReply(rawText, request.tools)
    this.#commitThread(plan, request)
    if (result.protocolDrift) this.#noteDrift(plan)
    yield { type: 'final', value: result }
  }
}
