import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { ChatGptBrowserRelay, RelayError, RELAY_RETRYABLE_CODES } from './chatgpt-relay.js'
import { GrokCliRunner, resolveGrokCliPath } from './grok-cli.js'
import { redactSecrets } from './redact.js'

const DEFAULT_PROVIDER = 'shiro-sol'
const DEFAULT_MODEL = 'gpt-5.6-sol'
const DEFAULT_PORT = 23157
const MAX_WAIT_MS = 45_000
const AUTO_CONTINUE_GRACE_MS = 5_000

export const REASONING_EFFORTS = Object.freeze([
  { id: 'light', name: 'Light', description: 'Ưu tiên phản hồi nhanh cho việc đơn giản.' },
  { id: 'standard', name: 'Standard', description: 'Cân bằng tốc độ và độ kỹ lưỡng.' },
  { id: 'high', name: 'High', description: 'Phân tích kỹ hơn cho thay đổi phức tạp.' },
  { id: 'max', name: 'Max', description: 'Mức kiểm tra sâu nhất cho việc rủi ro cao.' },
])

export const SPEED_PROFILES = Object.freeze([
  { id: 'fast', suffix: '-fast', name: 'Fast', description: 'Vòng lặp ngắn, ưu tiên phản hồi nhanh.', defaultEffort: 'light' },
  { id: 'balanced', suffix: '', name: 'Balanced', description: 'Cân bằng tốc độ, chất lượng và chi phí ngữ cảnh.', defaultEffort: 'standard' },
  { id: 'deep', suffix: '-deep', name: 'Deep', description: 'Ưu tiên độ kỹ lưỡng, xác minh và audit.', defaultEffort: 'high' },
])

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

function asError(error) {
  return error instanceof Error ? error : new Error(String(error))
}

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim()
}

function normalizeConfig(config = {}) {
  const port = Number(config.port ?? DEFAULT_PORT)
  const waitMs = Number(config.waitMs ?? 25_000)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port must be an integer from 1024 to 65535')
  if (!Number.isInteger(waitMs) || waitMs < 100 || waitMs > MAX_WAIT_MS) throw new Error(`waitMs must be an integer from 100 to ${MAX_WAIT_MS}`)
  const relayUrl = typeof config.relayUrl === 'string' ? config.relayUrl.trim() : ''
  const relayToken = typeof config.relayToken === 'string' ? config.relayToken.trim() : ''
  if ((relayUrl === '') !== (relayToken === '')) throw new Error('relayUrl and relayToken must be configured together')
  return {
    provider: requiredString(config.provider ?? DEFAULT_PROVIDER, 'provider'),
    model: requiredString(config.model ?? DEFAULT_MODEL, 'model'),
    workspaceRoot: resolve(requiredString(config.workspaceRoot, 'workspaceRoot')),
    token: requiredString(config.token, 'token'),
    relayUrl,
    relayToken,
    relayModel: requiredString(config.relayModel ?? 'GPT-5.6 Sol', 'relayModel'),
    grokProvider: requiredString(config.grokProvider ?? 'shiro-grok', 'grokProvider'),
    grokCliPath: typeof config.grokCliPath === 'string' ? config.grokCliPath.trim() : '',
    grokModels: Array.isArray(config.grokModels) && config.grokModels.length > 0
      ? config.grokModels.map(model => requiredString(model, 'grokModels[]'))
      : ['grok-4.6', 'grok-4.5'],
    port,
    waitMs,
  }
}

function baseModelId(model) {
  for (const profile of SPEED_PROFILES) {
    if (profile.suffix !== '' && model.endsWith(profile.suffix)) return model.slice(0, -profile.suffix.length)
  }
  return model
}

function modelIdForSpeed(model, speedProfile) {
  const profile = SPEED_PROFILES.find(candidate => candidate.id === speedProfile)
  if (profile === undefined) throw new Error(`unsupported speed profile: ${speedProfile}`)
  return `${baseModelId(model)}${profile.suffix}`
}

function profileForModel(model, configuredModel = DEFAULT_MODEL) {
  const base = baseModelId(configuredModel)
  const profile = SPEED_PROFILES.find(candidate => `${base}${candidate.suffix}` === model)
  if (profile === undefined) throw new Error(`unsupported Shiro model: ${model}`)
  return profile
}

function modelInfo(provider, model, configuredModel = DEFAULT_MODEL) {
  const profile = profileForModel(model, configuredModel)
  return {
    provider,
    id: model,
    name: `Shiro · GPT-5.6 Sol · ${profile.name}`,
    description: profile.description,
    inputModalities: ['text', 'image'],
    reasoning: {
      efforts: REASONING_EFFORTS,
      defaultEffort: profile.defaultEffort,
    },
  }
}

function publicRequest(id, options) {
  const speedProfile = SPEED_PROFILES.find(profile => options.model.endsWith(profile.suffix) && profile.suffix !== '')
    ?? SPEED_PROFILES.find(profile => profile.id === 'balanced')
  return {
    request_id: id,
    session_id: options.sessionId ?? null,
    purpose: options.purpose ?? 'conversation',
    provider: options.provider,
    model: options.model,
    system: redactSecrets(options.system ?? ''),
    messages: redactSecrets(options.messages),
    tools: redactSecrets(options.tools ?? []),
    generation: {
      temperature: options.temperature ?? null,
      max_tokens: options.maxTokens ?? null,
      stop: options.stop ?? [],
      reasoning_effort: options.reasoningEffort ?? null,
      speed_profile: speedProfile.id,
    },
  }
}

export class BridgeBroker {
  #pending = new Map()
  #listeners = new Set()

  enqueue(options) {
    const id = randomUUID()
    let settle
    const response = new Promise((resolveResponse) => { settle = resolveResponse })
    const row = {
      id,
      sessionId: options.sessionId ?? null,
      createdAt: Date.now(),
      request: publicRequest(id, options),
      settle,
    }
    this.#pending.set(id, row)
    this.#notify()
    return { id, response }
  }

  cancel(id, failure = { message: 'Harness cancelled the model request', code: 'ABORTED' }) {
    const row = this.#pending.get(id)
    if (row === undefined) return false
    this.#pending.delete(id)
    row.settle({ kind: 'aborted', failure })
    this.#notify()
    return true
  }

  submit(id, response) {
    const row = this.#pending.get(id)
    if (row === undefined) throw new Error(`model request ${id} is not pending`)
    this.#pending.delete(id)
    row.settle(response)
    this.#notify()
    return row
  }

  snapshot() {
    return [...this.#pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(row => row.request)
  }

  async waitForPending(timeoutMs) {
    const ready = this.snapshot()
    if (ready.length > 0) return ready
    let wake
    const changed = new Promise(resolveChange => { wake = resolveChange })
    this.#listeners.add(wake)
    try {
      await Promise.race([changed, delay(timeoutMs)])
      return this.snapshot()
    } finally {
      this.#listeners.delete(wake)
    }
  }

  #notify() {
    for (const listener of this.#listeners) listener()
    this.#listeners.clear()
  }
}

function finishReason(kind) {
  if (kind === 'tool-calls') return { kind: 'tool-calls' }
  if (kind === 'max-tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

function normalizeBlock(block) {
  if (block.type === 'tool_call') {
    return {
      type: 'tool-call',
      id: block.id,
      name: block.name,
      arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments),
    }
  }
  return { type: block.type, text: block.text }
}

/**
 * Emit the shared block-start/delta/block-end + usage + finish sequence for
 * one relay or MCP response. `streamedIndex` marks a block whose block-start
 * and deltas were already emitted live during SSE streaming: the engine's
 * llm-invariant validator throws on a repeated block-start for the same
 * index, so that block gets only its closing block-end here.
 */
function* emitBlocks(blocks, usage, finishReasonValue, streamedIndex) {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (index !== streamedIndex) {
      yield { type: 'block-start', index, blockType: block.type }
      if (block.type === 'text') {
        yield { type: 'text-delta', index, text: block.text }
      } else if (block.type === 'reasoning') {
        yield { type: 'reasoning-delta', index, text: block.text }
      } else if (block.type === 'tool-call') {
        yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
      }
    }
    yield { type: 'block-end', index, block }
  }
  yield { type: 'usage', usage: usage ?? { inputTokens: 0, outputTokens: 0 } }
  const inferred = blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop'
  yield { type: 'finish', reason: finishReason(finishReasonValue ?? inferred) }
}

function hasImageBlock(content) {
  return Array.isArray(content) && content.some(block => block?.type === 'image')
}

/**
 * Resolve durable image attachments into raw bytes for the relay's file
 * upload, and rewrite the outgoing messages so the JSON prompt embedded in
 * relayPrompt() never carries anything but a small text placeholder for each
 * image (durable `ImageAttachmentRef`s never carry raw bytes to begin with --
 * this also keeps the request-scoped image bytes out of the redacted/logged
 * request payload). Mirrors, at a much smaller scale, how
 * engine/packages/llm/llm-deepseek/src/adapter.ts resolves images through its
 * injected `attachments` service (`ctx.get('attachments')`) before serializing
 * a request; unlike that adapter this one degrades to a text placeholder
 * instead of throwing when a durable attachment cannot be resolved, since a
 * browser-relay completion has no other path to recover.
 */
async function resolveImageAttachments(options, attachmentStore, signal) {
  const messages = options.messages ?? []
  if (!messages.some(message => hasImageBlock(message.content))) {
    return { images: [], requestMessages: messages }
  }
  const images = []
  const requestMessages = []
  for (const message of messages) {
    if (!hasImageBlock(message.content)) {
      requestMessages.push(message)
      continue
    }
    const content = []
    for (const block of message.content) {
      if (block?.type !== 'image') {
        content.push(block)
        continue
      }
      const ref = block.attachment
      const name = ref && typeof ref.name === 'string' && ref.name !== '' ? ref.name : `image-${images.length + 1}`
      if (attachmentStore === undefined || attachmentStore === null || typeof attachmentStore.readImage !== 'function') {
        content.push({ type: 'text', text: `[image "${name}" could not be attached: no attachment store available]` })
        continue
      }
      try {
        const stored = await attachmentStore.readImage(ref, signal)
        images.push({ data: stored.data, mediaType: stored.ref.mediaType, name })
        content.push({ type: 'text', text: `[image attached: ${name}]` })
      } catch (error) {
        content.push({ type: 'text', text: `[image "${name}" could not be attached: ${asError(error).message}]` })
      }
    }
    requestMessages.push({ ...message, content })
  }
  return { images, requestMessages }
}

export class ChatGptSolAdapter {
  constructor(broker, provider, model, relay = null, resolveAttachments = () => undefined) {
    this.broker = broker
    this.provider = provider
    this.model = model
    this.relay = relay
    this.resolveAttachments = resolveAttachments
  }

  providerInfo(provider) {
    return { id: provider, name: 'Shiro · GPT-5.6 Sol' }
  }

  providerRetryPolicy() {
    // Duck-types engine/packages/llm/llm/src/retry-policy.ts's
    // `ResolvedNormalRetryPolicy` shape (bridge cannot import the resolver;
    // see the RelayError doc comment in chatgpt-relay.js). A small bounded
    // retry count is enough here: relay failures are either fast (HTTP/
    // network) or already bounded by the 30-minute per-call timeout, so a
    // long backoff ceiling would only stall the Harness turn.
    return {
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: [...RELAY_RETRYABLE_CODES],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
  }

  async listModels(provider) {
    return SPEED_PROFILES.map(profile => modelInfo(provider, modelIdForSpeed(this.model, profile.id), this.model))
  }

  async resolveModel(provider, model) {
    return modelInfo(provider, model, this.model)
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  async *stream(options) {
    let response
    let usedStreaming = false
    let streamedFirstBlock = false
    if (this.relay !== null) {
      const status = await this.relay.health(options.signal)
      if (status.ready) {
        try {
          const { images, requestMessages } = await resolveImageAttachments(
            options,
            this.resolveAttachments?.(),
            options.signal,
          )
          const request = publicRequest(randomUUID(), { ...options, messages: requestMessages })
          if (typeof this.relay.streamComplete === 'function') {
            usedStreaming = true
            for await (const item of this.relay.streamComplete(request, options.signal, images)) {
              if (item.type === 'delta') {
                if (!streamedFirstBlock) {
                  streamedFirstBlock = true
                  yield { type: 'block-start', index: 0, blockType: 'text' }
                }
                yield { type: 'text-delta', index: 0, text: item.text }
              } else if (item.type === 'final') {
                response = item.value
              }
            }
          } else {
            response = await this.relay.complete(request, options.signal, images)
          }
        } catch (error) {
          if (options.signal?.aborted) {
            response = { kind: 'aborted', failure: { message: 'Harness cancelled the browser relay request', code: 'ABORTED' } }
          } else if (error instanceof RelayError || usedStreaming) {
            // A typed relay failure carries a code the engine's retry policy
            // understands (see providerRetryPolicy() above) -- surface it
            // instead of silently degrading to the MCP handoff below, so the
            // harness can automatically re-ask. Once streaming has begun,
            // partial block-start/text-delta chunks may already be in
            // flight; falling back to a second, unrelated MCP-sourced
            // response would re-use block index 0 without ever closing it,
            // so any streaming-path failure must also propagate rather than
            // silently switch response sources.
            throw error
          } else {
            process.stderr.write(`shiro-relay: ${asError(error).message}; falling back to MCP handoff\n`)
          }
        }
      }
    }
    if (response === undefined) {
      const pending = this.broker.enqueue(options)
      const onAbort = () => { this.broker.cancel(pending.id) }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        response = await pending.response
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
      }
    }

    if (response.kind === 'aborted') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: response.failure } }
      return
    }

    const blocks = response.blocks.map(normalizeBlock)
    const streamedIndex = streamedFirstBlock && blocks[0]?.type === 'text' ? 0 : -1
    yield* emitBlocks(blocks, response.usage, response.finishReason, streamedIndex)
  }
}

function grokModelInfo(provider, model) {
  return {
    provider,
    id: model,
    name: `Shiro · Grok Build · ${model}`,
    description: 'Grok Build CLI (đăng nhập grok.com) chạy headless làm model cho Harness.',
    inputModalities: ['text'],
    reasoning: {
      efforts: REASONING_EFFORTS,
      defaultEffort: 'standard',
    },
  }
}

/**
 * Second model route: the local Grok Build CLI in headless single-turn mode.
 * Every request is its own process, so unlike the single ChatGPT tab this
 * route serves concurrent subagents in parallel and reports real token usage.
 */
export class GrokBuildAdapter {
  constructor(runner, provider, models) {
    this.runner = runner
    this.provider = provider
    this.models = models
  }

  providerInfo(provider) {
    return { id: provider, name: 'Shiro · Grok Build' }
  }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: [...RELAY_RETRYABLE_CODES],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
  }

  async listModels(provider) {
    return this.models.map(model => grokModelInfo(provider, model))
  }

  async resolveModel(provider, model) {
    if (!this.models.includes(model)) throw new Error(`unknown Grok model: ${model}`)
    return grokModelInfo(provider, model)
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  async *stream(options) {
    let response
    try {
      response = await this.runner.complete(publicRequest(randomUUID(), options), options.signal, {
        model: options.model,
        effort: options.reasoningEffort,
      })
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Harness cancelled the Grok CLI request', code: 'ABORTED' } } }
        return
      }
      throw error
    }
    yield* emitBlocks(response.blocks.map(normalizeBlock), response.usage, response.finishReason, -1)
  }
}

function rpcId(prefix) {
  return `${prefix}-${randomUUID()}`
}

async function unwrap(promise, label) {
  const response = await promise
  if (!response.result.ok) throw new Error(`${label}: ${response.result.error.code}: ${response.result.error.message}`)
  return response.result.value
}

async function history(ctx, sessionId) {
  return unwrap(ctx.apiProxy.sessions.history({
    rpcId: rpcId('bridge-history'),
    payload: { sessionId, maxMessages: 100 },
  }), 'session.history')
}

function latestSeq(page) {
  return page.events.reduce((max, entry) => Math.max(max, entry.event.seq), -1)
}

export function turnCompletion(page, afterSeq) {
  const completed = page.events
    .map(entry => entry.event)
    .filter(event => event.seq > afterSeq && event.type === 'turn/end')
    .at(-1)
  if (completed === undefined) return null
  const laterTurnStarted = page.events.some(({ event }) => (
    event.seq > completed.seq && event.type === 'turn/start'
  ))
  if (laterTurnStarted) return null
  const texts = page.events.flatMap(({ event }) => {
    if (event.seq <= afterSeq || event.type !== 'assistant/message') return []
    const content = event.data?.message?.content
    if (!Array.isArray(content)) return []
    return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text)
  })
  return {
    event: completed,
    assistant_text: texts.at(-1) ?? '',
    reason: completed.data?.reason ?? { kind: 'completed' },
  }
}

function awaitsAutoContinue(reason) {
  return reason?.kind === 'max-tokens' || reason?.kind === 'error' || reason?.kind === 'interrupted'
}

class BridgeController {
  constructor(ctx, broker, config) {
    this.ctx = ctx
    this.broker = broker
    this.config = config
    this.operation = null
    this.interactions = new Map()
    this.eventsAbort = new AbortController()
    this.eventsTask = this.pumpEvents()
  }

  async pumpEvents() {
    try {
      const stream = this.ctx.apiProxy.events.mux({
        rpcId: rpcId('bridge-events'),
        payload: {},
      }, this.eventsAbort.signal)
      for await (const envelope of stream) {
        const frame = envelope.payload
        if (frame.type === 'approval/requested' || frame.type === 'question/requested') {
          this.interactions.set(envelope.rpcId, {
            interaction_id: envelope.rpcId,
            ...frame,
          })
        } else if (frame.type === 'approval/resolved') {
          for (const [id, item] of this.interactions) {
            if (item.type === 'approval/requested' && item.approvalId === frame.approvalId) this.interactions.delete(id)
          }
        } else if (frame.type === 'question/resolved') {
          this.interactions.delete(frame.questionRpcId)
        }
      }
    } catch (error) {
      if (!this.eventsAbort.signal.aborted) process.stderr.write(`dsh-sol-bridge: event stream failed: ${asError(error).message}\n`)
    }
  }

  interactionSnapshot() {
    return [...this.interactions.values()]
  }

  async workspace() {
    return unwrap(this.ctx.apiProxy.workspace.create({
      rpcId: rpcId('bridge-workspace'),
      payload: { path: this.config.workspaceRoot },
    }), 'workspace.create')
  }

  async sessions() {
    const workspaceValue = await this.workspace()
    const listed = await unwrap(this.ctx.apiProxy.sessions.list({
      rpcId: rpcId('bridge-sessions'),
      payload: {},
    }), 'session.list')
    const allowed = new Set(workspaceValue.workspace.sessionIds)
    return {
      workspace_id: workspaceValue.workspace.workspaceId,
      workspace_title: workspaceValue.workspace.title,
      sessions: listed.items.filter(item => allowed.has(item.sessionId)),
    }
  }

  async start(prompt, agentPreset, requestedSessionId, speedProfile = 'balanced', reasoningEffort) {
    if (this.operation?.status === 'running') throw new Error('another root Harness turn is already running')
    const workspaceValue = await this.workspace()
    let created
    if (requestedSessionId === undefined) {
      created = await unwrap(this.ctx.apiProxy.sessions.create({
        rpcId: rpcId('bridge-session'),
        payload: {
          workspaceId: workspaceValue.workspace.workspaceId,
          ...(agentPreset === undefined ? {} : { agentPreset }),
        },
      }), 'session.create')
    } else {
      if (agentPreset !== undefined) throw new Error('agent_preset is valid only when creating a new session')
      if (!workspaceValue.workspace.sessionIds.includes(requestedSessionId)) {
        throw new Error('session_id is not registered under the fixed bridge workspace')
      }
      created = { sessionId: requestedSessionId }
    }
    const selectedModel = modelIdForSpeed(this.config.model, speedProfile)
    const selectedProfile = profileForModel(selectedModel, this.config.model)
    const selectedEffort = reasoningEffort ?? selectedProfile.defaultEffort
    await unwrap(this.ctx.apiProxy.sessions.selectModel({
      rpcId: rpcId('bridge-model'),
      payload: {
        sessionId: created.sessionId,
        provider: this.config.provider,
        model: selectedModel,
        reasoningEffort: selectedEffort,
      },
    }), 'session.selectModel')
    const before = await history(this.ctx, created.sessionId)
    this.operation = {
      id: randomUUID(),
      rootSessionId: created.sessionId,
      workspaceId: workspaceValue.workspace.workspaceId,
      afterSeq: latestSeq(before),
      status: 'running',
      startedAt: Date.now(),
      speedProfile: selectedProfile.id,
      reasoningEffort: selectedEffort,
      recoverableEnd: null,
    }
    await unwrap(this.ctx.apiProxy.sessions.prompt({
      rpcId: rpcId('bridge-prompt'),
      payload: {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: 'Asia/Saigon',
      },
    }), 'session.prompt')
    return this.waitForOutcome(this.config.waitMs)
  }

  async submit(requestId, response, waitMs) {
    this.broker.submit(requestId, response)
    return this.waitForOutcome(waitMs)
  }

  async waitForOutcome(waitMs) {
    const operation = this.operation
    if (operation === null) return { status: 'idle', model_requests: this.broker.snapshot() }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const pending = this.broker.snapshot()
      if (pending.length > 0) {
        return {
          status: 'model_input_required',
          operation_id: operation.id,
          root_session_id: operation.rootSessionId,
          model_requests: pending,
          requested_profile: {
            speed: operation.speedProfile,
            effort: operation.reasoningEffort,
          },
          instruction: `Act as GPT-5.6 Sol with requested speed=${operation.speedProfile} and effort=${operation.reasoningEffort} for each exact model request. Return Harness tool calls as tool_call blocks; do not execute those tools outside Harness. Submit every pending request, then continue until status is completed.`,
        }
      }
      const interactions = this.interactionSnapshot()
      if (interactions.length > 0) {
        return {
          status: 'user_input_required',
          operation_id: operation.id,
          root_session_id: operation.rootSessionId,
          interactions,
          instruction: 'Relay questions to the user. Allow an approval only after the user explicitly consents to that exact operation; otherwise reject it. Call harness_respond, then continue.',
        }
      }
      const page = await history(this.ctx, operation.rootSessionId)
      const done = turnCompletion(page, operation.afterSeq)
      if (done !== null) {
        if (awaitsAutoContinue(done.reason)) {
          if (operation.recoverableEnd?.seq !== done.event.seq) {
            operation.recoverableEnd = { seq: done.event.seq, observedAt: Date.now() }
          }
          if (Date.now() - operation.recoverableEnd.observedAt < AUTO_CONTINUE_GRACE_MS) {
            await delay(150)
            continue
          }
        }
        operation.status = 'completed'
        return {
          status: 'completed',
          operation_id: operation.id,
          root_session_id: operation.rootSessionId,
          completion: done,
        }
      }
      await delay(150)
    }
    return {
      status: 'running',
      operation_id: operation.id,
      root_session_id: operation.rootSessionId,
      model_requests: this.broker.snapshot(),
      instruction: 'Call harness_status or harness_continue again. Harness is still executing its own tools.',
    }
  }

  async status(waitMs) {
    return this.waitForOutcome(waitMs)
  }

  async respond(interactionId, approvalOutcome, answers, waitMs) {
    const interaction = this.interactions.get(interactionId)
    if (interaction === undefined) throw new Error(`interaction ${interactionId} is not pending`)
    let value
    if (interaction.type === 'approval/requested') {
      if (approvalOutcome === undefined) throw new Error('approval_outcome is required for an approval')
      if (answers !== undefined) throw new Error('answers are valid only for a question')
      value = {
        sessionId: interaction.sessionId,
        approvalId: interaction.approvalId,
        outcome: approvalOutcome,
      }
    } else {
      if (answers === undefined) throw new Error('answers are required for a question')
      if (approvalOutcome !== undefined) throw new Error('approval_outcome is valid only for an approval')
      value = { sessionId: interaction.sessionId, answer: { answers } }
    }
    const receipt = await this.ctx.apiProxy.respond({
      type: 'client-response',
      rpcId: interactionId,
      result: { ok: true, value },
    })
    if (!receipt.accepted) throw new Error(`Harness rejected the response: ${receipt.reason}`)
    this.interactions.delete(interactionId)
    return this.waitForOutcome(waitMs)
  }

  async cancel() {
    const operation = this.operation
    if (operation === null || operation.status !== 'running') return { cancelled: false, status: operation?.status ?? 'idle' }
    await unwrap(this.ctx.apiProxy.sessions.cancel({
      rpcId: rpcId('bridge-cancel'),
      payload: { sessionId: operation.rootSessionId },
    }), 'session.cancel')
    operation.status = 'cancelled'
    return { cancelled: true, root_session_id: operation.rootSessionId }
  }

  async dispose() {
    this.eventsAbort.abort()
    await this.eventsTask
  }
}

const modelBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
])

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function errorResult(error) {
  return { content: [{ type: 'text', text: asError(error).message }], isError: true }
}

function configureMcp(server, controller, config) {
  server.registerTool('harness_profiles', {
    title: 'List exact Shiro speed and effort profiles',
    description: 'Returns the exact supported speed profiles, effort levels, defaults, and the limitation that ChatGPT Web compute settings remain controlled by the ChatGPT model selector. Use this when the user asks which parameters are active.',
    inputSchema: {},
  }, async () => toolResult({
    speed_profiles: SPEED_PROFILES.map(({ id, name, description, defaultEffort }) => ({ id, name, description, default_effort: defaultEffort })),
    reasoning_efforts: REASONING_EFFORTS,
    default: { speed_profile: 'balanced', reasoning_effort: 'standard' },
    scope: 'These values select and expose Shiro operating policy. The ChatGPT Web model and compute entitlement are still selected by ChatGPT itself.',
  }))

  server.registerTool('harness_start', {
    title: 'Start a full Shiro coding task',
    description: `Starts one Shiro task in the fixed sandbox ${config.workspaceRoot}. This is the entry point. The returned model_requests are exact engine LLM calls: act as GPT-5.6 Sol and answer them with harness_continue. All filesystem, PowerShell, tests, Git, skills, plans, goals, subagents, workflows, approvals, persistence, and sandboxing stay inside Shiro's DeepSeek Harness engine.`,
    inputSchema: {
      prompt: z.string().min(1).describe('The user task for Shiro.'),
      agent_preset: z.string().min(1).optional().describe('Optional Harness preset; omit to use the full standard coding-agent preset.'),
      session_id: z.string().min(1).optional().describe('Optional durable Harness session id returned by harness_sessions. Omit to create a new session.'),
      speed_profile: z.enum(['fast', 'balanced', 'deep']).describe('Required Shiro operating profile. Use balanced unless the user asks otherwise, and state the selected value to the user.'),
      reasoning_effort: z.enum(['light', 'standard', 'high', 'max']).describe('Required reasoning effort. Use standard unless the user asks otherwise, and state the selected value to the user.'),
    },
  }, async ({ prompt, agent_preset: agentPreset, session_id: sessionId, speed_profile: speedProfile, reasoning_effort: reasoningEffort }) => {
    try { return toolResult(await controller.start(prompt, agentPreset, sessionId, speedProfile, reasoningEffort)) } catch (error) { return errorResult(error) }
  })

  server.registerTool('harness_sessions', {
    title: 'List resumable Shiro sessions',
    description: 'Lists only durable sessions registered under the bridge\'s fixed project root. Pass one returned session id to harness_start to continue that exact Harness conversation.',
    inputSchema: {},
  }, async () => {
    try { return toolResult(await controller.sessions()) } catch (error) { return errorResult(error) }
  })

  server.registerTool('harness_continue', {
    title: 'Return one Sol model decision to Shiro',
    description: 'Answers exactly one pending Harness model request. Use only tool names and JSON arguments from that request. If tools are needed, return tool_call blocks so Harness executes them under its own sandbox; never simulate tool results. Keep calling this tool for every returned model request until status is completed.',
    inputSchema: {
      request_id: z.string().uuid(),
      blocks: z.array(modelBlockSchema).min(1),
      finish_reason: z.enum(['stop', 'tool-calls', 'max-tokens']).optional(),
      usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(),
      wait_ms: z.number().int().min(100).max(MAX_WAIT_MS).optional(),
    },
  }, async ({ request_id: requestId, blocks, finish_reason: finishReasonValue, usage, wait_ms: waitMs }) => {
    try {
      return toolResult(await controller.submit(requestId, {
        blocks,
        ...(finishReasonValue === undefined ? {} : { finishReason: finishReasonValue }),
        ...(usage === undefined ? {} : { usage }),
      }, waitMs ?? config.waitMs))
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('harness_status', {
    title: 'Inspect the active Shiro task',
    description: 'Returns pending model requests, running tool state, or final completion for the active Harness turn.',
    inputSchema: { wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional() },
  }, async ({ wait_ms: waitMs }) => {
    try { return toolResult(await controller.status(waitMs ?? 0)) } catch (error) { return errorResult(error) }
  })

  server.registerTool('harness_respond', {
    title: 'Answer a Harness question or approval request',
    description: 'Answers one pending Harness interaction returned with status user_input_required. Relay questions to the user. For approvals, allowed-once transmits consent to run the exact wider operation and must be used only after explicit user confirmation; use rejected otherwise.',
    inputSchema: {
      interaction_id: z.string().min(1),
      approval_outcome: z.enum(['allowed-once', 'rejected']).optional(),
      answers: z.array(z.object({
        id: z.string().min(1),
        selected: z.array(z.string()),
        custom: z.string().optional(),
      })).optional(),
      wait_ms: z.number().int().min(100).max(MAX_WAIT_MS).optional(),
    },
  }, async ({ interaction_id: interactionId, approval_outcome: approvalOutcome, answers, wait_ms: waitMs }) => {
    try { return toolResult(await controller.respond(interactionId, approvalOutcome, answers, waitMs ?? config.waitMs)) } catch (error) { return errorResult(error) }
  })

  server.registerTool('harness_cancel', {
    title: 'Cancel the active Shiro turn',
    description: 'Cancels only the active Harness turn. It does not delete files, sessions, or workspaces.',
    inputSchema: {},
  }, async () => {
    try { return toolResult(await controller.cancel()) } catch (error) { return errorResult(error) }
  })
}

async function handleMcpRequest(req, res, controller, config) {
  const authorization = req.headers.authorization ?? ''
  if (!safeEqual(authorization, `Bearer ${config.token}`)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  const server = new McpServer(
    { name: 'shiro-harness-bridge', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Use harness_profiles when parameters are requested. Before harness_start, choose and state exact speed_profile and reasoning_effort; default to balanced/standard. Then act as the model for every returned model_requests item with harness_continue. Shiro executes all coding tools inside its fixed project root. Continue until completed.',
    },
  )
  configureMcp(server, controller, config)
  const transport = new StreamableHTTPServerTransport({})
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}

function startHttpServer(ctx, broker, config) {
  const controller = new BridgeController(ctx, broker, config)
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        provider: config.provider,
        model: config.model,
        workspaceRoot: config.workspaceRoot,
        browserRelay: {
          configured: config.relayUrl !== '',
          url: config.relayUrl,
        },
        speedProfiles: SPEED_PROFILES.map(({ id, name, description, defaultEffort }) => ({ id, name, description, defaultEffort })),
        reasoningEfforts: REASONING_EFFORTS,
      }))
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    void handleMcpRequest(req, res, controller, config).catch(error => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(asError(error).message)
    })
  })
  http.listen(config.port, '127.0.0.1')
  http.on('listening', () => {
    process.stderr.write(`shiro-bridge: http://127.0.0.1:${config.port}/mcp (workspace ${config.workspaceRoot})\n`)
  })
  return { http, controller }
}

export const name = 'llm-shiro-harness-bridge'
export const inject = ['llm', 'apiProxy']

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const broker = new BridgeBroker()
  const relay = config.relayUrl === '' ? null : new ChatGptBrowserRelay({
    url: config.relayUrl,
    token: config.relayToken,
    model: config.relayModel,
  })
  // 'attachments' is deliberately not a hard `inject` dependency (unlike
  // 'llm'/'apiProxy' above): it is an optional durable-image service that
  // may not be mounted in every Shiro composition, and a hard inject would
  // block this plugin from loading at all until one is. `ctx.get()` reads it
  // only at call time, mirroring how engine/packages/llm/llm-deepseek/src
  // /adapter.ts resolves it (`resolveAttachments: () => ctx.get('attachments')`).
  const adapter = new ChatGptSolAdapter(broker, config.provider, config.model, relay, () => ctx.get('attachments'))
  ctx.llm.registerAdapter([config.provider], adapter)
  const grokCliPath = resolveGrokCliPath(config.grokCliPath)
  if (grokCliPath !== null) {
    const grokRunner = new GrokCliRunner({ cliPath: grokCliPath })
    ctx.llm.registerAdapter([config.grokProvider], new GrokBuildAdapter(grokRunner, config.grokProvider, config.grokModels))
  } else if (config.grokCliPath !== '') {
    process.stderr.write(`shiro-grok: configured Grok CLI not found at ${config.grokCliPath}; route disabled\n`)
  }
  ctx.effect(() => {
    const runtime = startHttpServer(ctx, broker, config)
    return async () => {
      await runtime.controller.dispose()
      await new Promise(resolveClose => { runtime.http.close(() => resolveClose()) })
    }
  }, 'shiro-harness-bridge.serve')
}
