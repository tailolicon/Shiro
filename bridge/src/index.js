import { canonicalWorkspaceRoot, defaultSessionStatePath } from './session-kernel.js'
import { SessionRuntime } from './session-runtime.js'
import { recoveryHistory } from './session-recovery.js'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { ActionError, setConfirmationPolicy } from './action-errors.js'
import { createActionGate } from './action-gate.js'
import { ContinuationWatchdog } from './continuation.js'
import { SubagentRegistry } from './subagents.js'
import { engineToolsOf, registerEngineTools } from './engine-tools.js'
import { IMAGE_MIME_BY_EXTENSION, TEXT_EXTENSIONS } from './artifact-kind.js'
import { ActionMetrics, FLEET_SNAPSHOT_SHAPE, registerDirectActions } from './direct-actions.js'
import { ProcessRegistry } from './exec-actions.js'
import { Sandbox } from './sandbox.js'
import { TerminalRegistry } from './terminal-actions.js'
import { ThreadRegistry } from './thread-registry.js'
import { ShiroWorkerControl } from './worker-control.js'
import { normalizeProfile, normalizeRules, PermissionPolicy } from './permission-profile.js'
import { normalizeAllowedRoots, PRIMARY_WORKSPACE_ID, WorkspaceRegistry } from './workspaces.js'
import { ChatGptBrowserRelay, RelayError, RELAY_RETRYABLE_CODES } from './chatgpt-relay.js'
import { errorResult, looseObject, resultSchema, toolResult } from './mcp-result.js'
import { BrowserFleetTransport, FleetManager } from './fleet-manager.js'
import { CodexCliRunner, resolveCodexCliPath } from './codex-cli.js'
import { GrokCliRunner, resolveGrokCliPath } from './grok-cli.js'
import { redactSecrets } from './redact.js'
import {
  OmnicastReturnMailbox,
  omnicastLeaseIsIdle,
  registerOmnicastReturnOnly,
} from './omnicast-return.js'

const DEFAULT_PROVIDER = 'shiro-sol'
const DEFAULT_MODEL = 'gpt-5.6-sol'
// Hard quota safety policy: Shiro's ChatGPT Web/browser route is capped at
// GPT-5.6 Sol.  GPT-6 Pro/Astra is intentionally forbidden so background
// workers, fleets and autonomous turns cannot burn the user's Pro quota.
const DEFAULT_WEB_MODEL = 'gpt-5.6-sol'
const DEFAULT_WEB_RELAY_MODEL = 'GPT-5.6 Sol'
const PROHIBITED_CHATGPT_WEB_MODEL = /(?:gpt[\s._-]*6(?:\b|[\s._-])|\bastra\b|\bgpt[\s._-]*pro\b|\bgpt[\s._-]*6[\s._-]*pro\b)/i
const DEFAULT_PORT = 23157
const DEFAULT_MAX_CONCURRENT_TURNS = 4
// One MCP tool call must stay well under the client's per-call patience
// (ChatGPT developer mode tolerates ~25-30s long-polls); long work stays
// server-side and the client re-polls with harness_status.
const MAX_WAIT_MS = 30_000
const AUTO_CONTINUE_GRACE_MS = 5_000
const PROGRESS_INTERVAL_MS = 2_000
// One harness_get_request page must stay far below the size where the MCP
// client starts eliding tool results from its context.
const REQUEST_PAGE_MAX_BYTES = 80_000
export const SHIRO_CLIENT_HEADER = 'x-shiro-client'
export const SHIRO_CONTROL_HEADER = 'x-shiro-omnicast-control'

export function mcpRequestHasControlCredential(headers = {}, expectedToken = '') {
  const raw = headers[SHIRO_CONTROL_HEADER]
  const supplied = String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''))
  return expectedToken !== '' && safeEqual(supplied, expectedToken)
}

/**
 * Resolve the loop owner for one HTTP MCP caller.
 *
 * Every caller follows the deployment-wide execution default. In Shiro's normal
 * autonomous configuration this keeps the complete model→tool→model loop inside
 * Harness even when the operator entered through a ChatGPT connector, so the
 * connector is only a control/observation surface rather than a per-round relay.
 * An explicit harness_start execution_mode still wins for every caller.
 */
export function mcpRequestExecutionContext(headers = {}, configuredMode = 'relay') {
  const raw = headers[SHIRO_CLIENT_HEADER]
  const marker = String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).trim().toLowerCase()
  const internal = marker === 'shiro-cli' || marker === 'shiro-python'
  return {
    clientKind: internal ? marker : 'connector',
    defaultExecutionMode: configuredMode,
  }
}

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

function enforceChatGptWebQuotaCap(value, label) {
  const model = requiredString(value, label)
  if (PROHIBITED_CHATGPT_WEB_MODEL.test(model)) {
    throw new Error(`${label}=${model} is forbidden by Shiro quota policy; maximum allowed ChatGPT Web model is GPT-5.6 Sol with xhigh effort`)
  }
  return model
}

function normalizeConfig(config = {}) {
  const port = Number(config.port ?? DEFAULT_PORT)
  const waitMs = Number(config.waitMs ?? 25_000)
  const maxConcurrentTurns = Number(config.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port must be an integer from 1024 to 65535')
  if (!Number.isInteger(waitMs) || waitMs < 100 || waitMs > MAX_WAIT_MS) throw new Error(`waitMs must be an integer from 100 to ${MAX_WAIT_MS}`)
  if (!Number.isInteger(maxConcurrentTurns) || maxConcurrentTurns < 1 || maxConcurrentTurns > 16) {
    throw new Error('maxConcurrentTurns must be an integer from 1 to 16')
  }
  const relayUrl = typeof config.relayUrl === 'string' ? config.relayUrl.trim() : ''
  const relayToken = typeof config.relayToken === 'string' ? config.relayToken.trim() : ''
  if ((relayUrl === '') !== (relayToken === '')) throw new Error('relayUrl and relayToken must be configured together')
  const workspaceRoot = resolve(requiredString(config.workspaceRoot, 'workspaceRoot'))
  // Additional directory trees the direct actions may open as workspaces. An
  // empty allowlist (the default) keeps the bridge single-rooted exactly as
  // before: widening the reachable set is always an explicit operator choice.
  const workspaceAllowlist = normalizeAllowedRoots(config.workspaceAllowlist)
  // The coarse permission dial. The configured value is a CEILING: a runtime
  // caller may narrow it, never widen it.
  const permissionProfile = normalizeProfile(config.permissionProfile)
  // Off by default: see setConfirmationPolicy. An operator turns the brake back
  // on with SHIRO_REQUIRE_CONFIRMATIONS=1.
  const requireConfirmations = config.requireConfirmations === true || String(config.requireConfirmations ?? '') === '1'
  const permissionRules = normalizeRules(config.permissionRules ?? {})
  const configuredFleetStateDir = typeof config.fleetStateDir === 'string' ? config.fleetStateDir.trim() : ''
  const configuredLogDir = typeof config.logDir === 'string' ? config.logDir.trim() : ''
  const omnicastControlToken = typeof config.omnicastControlToken === 'string' ? config.omnicastControlToken.trim() : ''
  const omnicastReturnStateFile = typeof config.omnicastReturnStateFile === 'string' ? config.omnicastReturnStateFile.trim() : ''
  if ((omnicastControlToken === '') !== (omnicastReturnStateFile === '')) {
    throw new Error('omnicastControlToken and omnicastReturnStateFile must be configured together')
  }
  const provider = requiredString(config.provider ?? DEFAULT_PROVIDER, 'provider')
  const model = enforceChatGptWebQuotaCap(config.model ?? DEFAULT_MODEL, 'model')
  const relayModel = enforceChatGptWebQuotaCap(config.relayModel ?? 'GPT-5.6 Sol', 'relayModel')
  const webProvider = requiredString(config.webProvider ?? 'shiro-web', 'webProvider')
  if (webProvider === provider) throw new Error('webProvider must differ from provider because provider is reserved for the legacy MCP relay route')
  const webModel = enforceChatGptWebQuotaCap(config.webModel ?? DEFAULT_WEB_MODEL, 'webModel')
  const webRelayModel = enforceChatGptWebQuotaCap(config.webRelayModel ?? DEFAULT_WEB_RELAY_MODEL, 'webRelayModel')
  const autonomousProvider = typeof config.autonomousProvider === 'string' ? config.autonomousProvider.trim() : ''
  const autonomousModelRaw = typeof config.autonomousModel === 'string' ? config.autonomousModel.trim() : ''
  const autonomousModel = autonomousModelRaw === '' ? '' : enforceChatGptWebQuotaCap(autonomousModelRaw, 'autonomousModel')
  if ((autonomousProvider === '') !== (autonomousModel === '')) {
    throw new Error('autonomousProvider and autonomousModel must be configured together')
  }
  if (autonomousProvider !== '' && autonomousProvider === provider) {
    throw new Error('autonomousProvider must differ from provider because provider is reserved for the legacy relay adapter')
  }
  if (autonomousProvider === webProvider && autonomousModel !== webModel) {
    throw new Error('autonomousModel must match webModel when autonomousProvider selects webProvider')
  }
  if (autonomousProvider === webProvider && relayUrl === '') {
    throw new Error('autonomousProvider cannot select webProvider unless relayUrl and relayToken are configured')
  }
  const executionMode = config.executionMode === undefined || config.executionMode === null || config.executionMode === ''
    ? (autonomousProvider === '' ? 'relay' : 'autonomous')
    : String(config.executionMode).trim()
  if (!['autonomous', 'relay'].includes(executionMode)) throw new Error('executionMode must be autonomous or relay')
  if (executionMode === 'autonomous' && autonomousProvider === '') {
    throw new Error('executionMode autonomous requires autonomousProvider and autonomousModel')
  }
  return {
    // `provider` / `model` remain the legacy Web-relay adapter route. Native
    // autonomous turns select `autonomousProvider` / `autonomousModel`, which
    // are supplied by any adapter already registered on ctx.llm (pi-ai,
    // OpenAI Responses, a gateway, a local CLI adapter, ...).
    provider,
    model,
    executionMode,
    autonomousProvider,
    autonomousModel,
    workspaceRoot,
    workspaceAllowlist,
    permissionProfile,
    permissionRules,
    requireConfirmations,
    sessionStatePath: config.sessionStatePath ?? process.env.SHIRO_SESSION_STATE_PATH ?? defaultSessionStatePath(),
    sessionKernel: config.sessionKernel,
    sessionClock: config.sessionClock,
    sessionLeaseMs: config.sessionLeaseMs,
    sessionHeartbeat: config.sessionHeartbeat,
    fleetStateDir: resolve(configuredFleetStateDir || resolve(workspaceRoot, '..', '.ShiroRuntime', 'state', 'fleets')),
    // Service logs live in the runtime directory beside the project root, not
    // inside it; logs_tail reads them through a fixed stream allowlist rather
    // than through the sandboxed filesystem actions.
    logDir: resolve(configuredLogDir || resolve(workspaceRoot, '..', '.ShiroRuntime', 'logs')),
    omnicastControlToken,
    omnicastReturnStateFile: omnicastReturnStateFile === '' ? '' : resolve(omnicastReturnStateFile),
    token: requiredString(config.token, 'token'),
    relayUrl,
    relayToken,
    relayModel,
    webProvider,
    webModel,
    // Browser/ChatGPT Web route is deliberately capped at Sol.  The browser
    // effort may be xhigh, but the model must never switch to GPT-6 Pro/Astra.
    webRelayModel,
    codexProvider: requiredString(config.codexProvider ?? 'shiro-codex', 'codexProvider'),
    codexCliPath: typeof config.codexCliPath === 'string' ? config.codexCliPath.trim() : '',
    codexModels: Array.isArray(config.codexModels) && config.codexModels.length > 0
      ? config.codexModels.map(model => enforceChatGptWebQuotaCap(model, 'codexModels[]'))
      : ['gpt-5.6-sol'],
    grokProvider: requiredString(config.grokProvider ?? 'shiro-grok', 'grokProvider'),
    grokCliPath: typeof config.grokCliPath === 'string' ? config.grokCliPath.trim() : '',
    grokModels: Array.isArray(config.grokModels) && config.grokModels.length > 0
      ? config.grokModels.map(model => requiredString(model, 'grokModels[]'))
      : ['grok-4.6', 'grok-4.5'],
    port,
    waitMs,
    maxConcurrentTurns,
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

function modelDisplayName(model) {
  const base = baseModelId(model)
  if (base === 'gpt-6-astra') return 'GPT-6 Astra'
  if (base === 'gpt-5.6-sol') return 'GPT-5.6 Sol'
  return base
}

function profileForModel(model, configuredModel = DEFAULT_MODEL) {
  const base = baseModelId(configuredModel)
  const profile = SPEED_PROFILES.find(candidate => `${base}${candidate.suffix}` === model)
  if (profile === undefined) throw new Error(`unsupported Shiro model: ${model}`)
  return profile
}

function executionRoute(config, mode = config.executionMode, speedProfile = 'balanced', reasoningEffort) {
  if (!['autonomous', 'relay'].includes(mode)) throw new Error(`unsupported execution mode: ${mode}`)
  const profile = SPEED_PROFILES.find(candidate => candidate.id === speedProfile)
  if (profile === undefined) throw new Error(`unsupported speed profile: ${speedProfile}`)
  if (mode === 'autonomous') {
    if (!config.autonomousProvider || !config.autonomousModel) {
      throw new Error('autonomous execution is not configured; set autonomousProvider and autonomousModel')
    }
    return {
      mode,
      provider: config.autonomousProvider,
      model: config.autonomousModel,
      profile,
      effort: reasoningEffort ?? profile.defaultEffort,
    }
  }
  const model = modelIdForSpeed(config.model, speedProfile)
  const relayProfile = profileForModel(model, config.model)
  return {
    mode,
    provider: config.provider,
    model,
    profile: relayProfile,
    effort: reasoningEffort ?? relayProfile.defaultEffort,
  }
}

function modelInfo(provider, model, configuredModel = DEFAULT_MODEL) {
  const profile = profileForModel(model, configuredModel)
  return {
    provider,
    id: model,
    name: `Shiro · ${modelDisplayName(configuredModel)} · ${profile.name}`,
    description: profile.description,
    inputModalities: ['text', 'image'],
    reasoning: {
      efforts: REASONING_EFFORTS,
      defaultEffort: profile.defaultEffort,
    },
  }
}

/**
 * Model requests travel to the MCP client as JSON, so raw image blocks (which
 * only carry an internal attachment ref) become explicit markers that tell the
 * client how to fetch the actual bytes with harness_get_artifact. Base64 never
 * goes inline here -- large blobs inside JSON tool results degrade the client.
 */
function mcpVisibleMessages(messages) {
  return (messages ?? []).map(message => {
    if (!Array.isArray(message.content)) return message
    let index = 0
    const content = message.content.map(block => {
      if (block?.type !== 'image') return block
      index += 1
      const ref = block.attachment ?? null
      const name = ref !== null && typeof ref.name === 'string' && ref.name !== '' ? ref.name : `image-${index}`
      return {
        type: 'image_attachment',
        name,
        attachment: ref,
        note: 'Binary is not inlined. Call harness_get_artifact with this exact attachment object to view the image.',
      }
    })
    return { ...message, content }
  })
}

function publicRequest(id, options) {
  const speedProfile = SPEED_PROFILES.find(profile => options.model.endsWith(profile.suffix) && profile.suffix !== '')
    ?? SPEED_PROFILES.find(profile => profile.id === 'balanced')
  return {
    request_id: id,
    ...(options.operationId === undefined ? {} : { operation_id: options.operationId }),
    workspace: options.workspace ?? PRIMARY_WORKSPACE_ID,
    session_id: options.sessionId ?? null,
    purpose: options.purpose ?? 'conversation',
    provider: options.provider,
    model: options.model,
    system: redactSecrets(options.system ?? ''),
    messages: redactSecrets(mcpVisibleMessages(options.messages)),
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

/**
 * Outcome payloads must stay small enough that the MCP client never elides
 * them (ChatGPT collapses oversized tool results into "skipped messages",
 * losing even the flat coordination fields). Turn outcomes therefore carry
 * only these summaries; the full request body is fetched separately -- and
 * paginated -- with harness_get_request.
 */
function requestSummary(request) {
  return {
    request_id: request.request_id,
    ...(request.operation_id === undefined ? {} : { operation_id: request.operation_id }),
    session_id: request.session_id,
    purpose: request.purpose,
    provider: request.provider,
    model: request.model,
    message_count: Array.isArray(request.messages) ? request.messages.length : 0,
    tool_count: Array.isArray(request.tools) ? request.tools.length : 0,
    approx_bytes: JSON.stringify(request).length,
  }
}

export class BridgeBroker {
  #pending = new Map()
  #listeners = new Set()

  // Set by BridgeController. While an MCP-driven root turn is running, the
  // Sol adapter must hand every engine model call to this broker (the MCP
  // client acts as the model, subagents included) instead of the browser
  // relay -- otherwise MCP-driven turns starve behind the hidden ChatGPT tab.
  operationProbe = null
  operationResolver = null

  mcpTurnActive(sessionId) {
    try { return this.operationProbe?.(sessionId) === true } catch { return false }
  }

  enqueue(options) {
    const id = randomUUID()
    // The owning turn AND its workspace are stamped here, when the request is
    // created and the mapping is unambiguous. Deriving the workspace later from
    // the session would re-open the question at every read, and a control-plane
    // gate that recomputes its own subject is a gate you can race.
    let operationId
    let workspace
    try {
      const owner = this.operationResolver?.(options.sessionId ?? null)
      operationId = owner?.id
      workspace = owner?.workspace
    } catch { operationId = undefined }
    let settle
    const response = new Promise((resolveResponse) => { settle = resolveResponse })
    const row = {
      id,
      sessionId: options.sessionId ?? null,
      createdAt: Date.now(),
      request: publicRequest(id, { ...options, operationId, workspace }),
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

  request(id) {
    return this.#pending.get(id)?.request
  }

  /**
   * How long each pending model request has gone unanswered. This is what tells
   * a stalled turn from a slow one: ChatGPT stops answering when the platform
   * cuts it off, and the request simply sits here.
   */
  waiting(now = Date.now()) {
    return [...this.#pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(row => ({
        request_id: row.id,
        session_id: row.sessionId,
        created_at: new Date(row.createdAt).toISOString(),
        waiting_ms: Math.max(0, now - row.createdAt),
      }))
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
  constructor(broker, provider, model, relay = null, resolveAttachments = () => undefined, options = {}) {
    this.broker = broker
    this.provider = provider
    this.model = model
    this.relay = relay
    this.resolveAttachments = resolveAttachments
    this.browserRelayRequired = options.browserRelayRequired === true
  }

  providerInfo(provider) {
    return { id: provider, name: `Shiro · ${modelDisplayName(this.model)}` }
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
    if (this.browserRelayRequired && this.relay === null) {
      throw new RelayError('ChatGPT Web browser relay is not configured for the autonomous Web route', 'TRANSPORT')
    }
    const browserRelayAllowed = this.relay !== null
      && (this.browserRelayRequired || !this.broker.mcpTurnActive(options.sessionId))
    if (browserRelayAllowed) {
      const status = await this.relay.health(options.signal)
      if (!status.ready && this.browserRelayRequired) {
        throw new RelayError(
          `ChatGPT Web browser relay is not ready: ${status.detail || 'no safe ready ChatGPT tab'}`,
          'TRANSPORT',
        )
      }
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
          } else if (this.browserRelayRequired) {
            throw new RelayError(`ChatGPT Web browser relay failed: ${asError(error).message}`, 'TRANSPORT', { cause: error })
          } else {
            process.stderr.write(`shiro-relay: ${asError(error).message}; falling back to MCP handoff\n`)
          }
        }
      }
    }
    if (response === undefined && this.browserRelayRequired) {
      throw new RelayError('ChatGPT Web browser relay produced no response', 'EMPTY_RESPONSE')
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

function codexModelInfo(provider, model) {
  return {
    provider,
    id: model,
    name: `Shiro · Codex · ${model}`,
    description: 'Codex CLI (đăng nhập ChatGPT) chạy không tool làm model thuần cho Harness.',
    inputModalities: ['text'],
    reasoning: {
      efforts: REASONING_EFFORTS,
      defaultEffort: 'standard',
    },
  }
}

/**
 * Subscription-authenticated Codex route. Each request is an isolated,
 * ephemeral process with Codex's own tool surface disabled; Harness alone
 * owns tool execution and continuation rounds.
 */
export class CodexCliAdapter {
  constructor(runner, provider, models) {
    this.runner = runner
    this.provider = provider
    this.models = models
  }

  providerInfo(provider) {
    return { id: provider, name: 'Shiro · Codex' }
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
    return this.models.map(model => codexModelInfo(provider, model))
  }

  async resolveModel(provider, model) {
    if (!this.models.includes(model)) throw new Error(`unknown Codex model: ${model}`)
    return codexModelInfo(provider, model)
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
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Harness cancelled the Codex CLI request', code: 'ABORTED' } } }
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

async function history(ctx, sessionId, maxMessages = 100, beforeSeq) {
  return unwrap(ctx.apiProxy.sessions.history({
    rpcId: rpcId('bridge-history'),
    payload: { sessionId, maxMessages, ...(beforeSeq === undefined ? {} : { beforeSeq }) },
  }), 'session.history')
}

function latestSeq(page) {
  return page.events.reduce((max, entry) => Math.max(max, entry.event.seq), -1)
}

export function turnCompletion(page, afterSeq) {
  const events = page.events.map(entry => entry.event)
  const completed = events
    .filter(event => event.seq > afterSeq && event.type === 'turn/end')
    .at(-1)
  if (completed === undefined) return null
  const laterTurnStarted = events.some(event => (
    event.seq > completed.seq && event.type === 'turn/start'
  ))
  if (laterTurnStarted) return null

  // A `submit_final` result is deliberately allowed to be the terminal
  // user-facing answer. DSH commits that result and closes the turn through
  // `exec.concludeTurn()`, so there is no later assistant/message whose sole job
  // would be to echo the same text. Code Mode forwards that terminal marker from
  // a nested tool to `run_code`; its durable `tool/code-dispatch` event preserves
  // the exact nested tool identity and output, so use that authoritative event
  // instead of guessing from an ordinary run_code result or turn shape.
  const completedNormally = completed.data?.reason?.kind === 'completed'
  const runCodeCallIds = new Set(events.flatMap(event => (
    event.seq > afterSeq
      && event.seq <= completed.seq
      && event.type === 'tool/call'
      && event.data?.name === 'run_code'
      && typeof event.data?.callId === 'string'
      ? [event.data.callId]
      : []
  )))
  const finalCallIds = new Set(events.flatMap(event => (
    completedNormally
      && event.seq > afterSeq
      && event.seq <= completed.seq
      && event.type === 'tool/call'
      && event.data?.name === 'submit_final'
      && typeof event.data?.callId === 'string'
      ? [event.data.callId]
      : []
  )))
  const candidates = []
  for (const event of events) {
    if (event.seq <= afterSeq || event.seq > completed.seq) continue
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .at(-1)
      if (text !== undefined) candidates.push({ seq: event.seq, text })
      continue
    }
    if (event.type === 'tool/code-dispatch') {
      const data = event.data ?? {}
      if (completedNormally
        && data.name === 'submit_final'
        && data.isError === false
        && runCodeCallIds.has(data.rootCallId)) {
        const content = Array.isArray(data.content) ? data.content : []
        const text = content
          .filter(item => item?.type === 'text' && typeof item.text === 'string')
          .map(item => item.text)
          .at(-1)
        if (text !== undefined) candidates.push({ seq: event.seq, text })
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    const callId = message?.source?.callId ?? message?.callId ?? event.data?.callId
    if (!finalCallIds.has(callId)) continue
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (const block of blocks) {
      if (block?.type !== 'tool-result' || block.isError === true) continue
      const nested = Array.isArray(block.content) ? block.content : []
      const text = nested
        .filter(item => item?.type === 'text' && typeof item.text === 'string')
        .map(item => item.text)
        .at(-1)
      if (text !== undefined) candidates.push({ seq: event.seq, text })
    }
  }
  candidates.sort((left, right) => left.seq - right.seq)
  return {
    event: completed,
    assistant_text: candidates.at(-1)?.text ?? '',
    reason: completed.data?.reason ?? { kind: 'completed' },
  }
}

function awaitsAutoContinue(reason) {
  return reason?.kind === 'max-tokens' || reason?.kind === 'error' || reason?.kind === 'interrupted'
}

function metricState(operation) {
  if (operation.metrics === undefined) {
    operation.metrics = {
      last_seq: operation.afterSeq,
      model_rounds: 0,
      tool_calls: 0,
      tool_results: 0,
      model_wait_ms: 0,
      tool_result_latency_ms: 0,
      max_tool_calls_in_flight_observed: 0,
      complete: true,
      gap_after_seq: null,
      pending_model_steps: {},
      pending_tool_calls: {},
    }
  }
  return operation.metrics
}

function historyCoversAfterSeq(page, afterSeq) {
  const events = (page.events ?? []).map(entry => entry.event).sort((left, right) => left.seq - right.seq)
  if (events.length === 0) return true
  const newer = events.filter(event => event.seq > afterSeq)
  if (newer.length === 0) return true
  if (newer[0].seq !== afterSeq + 1) return false
  return newer.every((event, index) => index === 0 || event.seq === newer[index - 1].seq + 1)
}

function observeOperationMetrics(operation, page) {
  const metrics = metricState(operation)
  const events = (page.events ?? [])
    .map(entry => entry.event)
    .filter(event => event.seq > Math.max(operation.afterSeq, metrics.last_seq ?? operation.afterSeq))
    .sort((left, right) => left.seq - right.seq)
  metrics.complete = true
  metrics.gap_after_seq = null
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'step/start') {
      metrics.model_rounds += 1
      metrics.first_model_round_at ??= event.time
      metrics.pending_model_steps[`${data.turn}:${data.step}`] = event.time
    } else if (event.type === 'assistant/chunk' || event.type === 'assistant/message') {
      const key = `${data.turn}:${data.step}`
      const started = metrics.pending_model_steps[key]
      if (started !== undefined) {
        metrics.model_wait_ms += Math.max(0, event.time - started)
        delete metrics.pending_model_steps[key]
      }
      metrics.first_model_output_at ??= event.time
    } else if (event.type === 'tool/call') {
      metrics.tool_calls += 1
      metrics.first_tool_call_at ??= event.time
      metrics.pending_tool_calls[data.callId] = event.time
      metrics.max_tool_calls_in_flight_observed = Math.max(
        metrics.max_tool_calls_in_flight_observed,
        Object.keys(metrics.pending_tool_calls).length,
      )
    } else if (event.type === 'tool/result') {
      metrics.tool_results += 1
      const callId = data.message?.source?.callId ?? data.message?.callId ?? data.callId
      const started = callId === undefined ? undefined : metrics.pending_tool_calls[callId]
      if (started !== undefined) {
        // Results commit in model order, so this is deliberately named result
        // latency rather than exact tool CPU/wall time. It remains a stable
        // benchmark for scheduler + tool overhead and can reveal regressions.
        metrics.tool_result_latency_ms += Math.max(0, event.time - started)
        delete metrics.pending_tool_calls[callId]
      }
    } else if (event.type === 'turn/end') {
      metrics.completed_at = event.time
    }
    metrics.last_seq = Math.max(metrics.last_seq ?? operation.afterSeq, event.seq)
  }
  return metrics
}

function publicOperationMetrics(operation, now = Date.now()) {
  const metrics = metricState(operation)
  const acceptedAt = operation.acceptedAt ?? operation.startedAt
  const end = metrics.completed_at ?? now
  return {
    accepted_at: acceptedAt,
    first_model_round_at: metrics.first_model_round_at ?? null,
    first_model_output_at: metrics.first_model_output_at ?? null,
    first_tool_call_at: metrics.first_tool_call_at ?? null,
    completed_at: metrics.completed_at ?? null,
    time_to_first_model_ms: metrics.first_model_round_at === undefined ? null : Math.max(0, metrics.first_model_round_at - acceptedAt),
    time_to_first_tool_ms: metrics.first_tool_call_at === undefined ? null : Math.max(0, metrics.first_tool_call_at - acceptedAt),
    model_rounds: metrics.model_rounds,
    model_wait_ms: metrics.model_wait_ms,
    tool_calls: metrics.tool_calls,
    tool_results: metrics.tool_results,
    tool_result_latency_ms: metrics.tool_result_latency_ms,
    max_tool_calls_in_flight_observed: metrics.max_tool_calls_in_flight_observed,
    total_wall_ms: Math.max(0, end - acceptedAt),
    last_event_seq: metrics.last_seq,
    complete: metrics.complete !== false,
    gap_after_seq: metrics.gap_after_seq ?? null,
  }
}

export class BridgeController {
  constructor(ctx, broker, config) {
    this.ctx = ctx
    this.broker = broker
    this.config = config
    this.operations = new Map()
    this.operationsBySession = new Map()
    this.lastOperationId = null
    this.pendingStarts = 0
    this.startingSessions = new Set()
    this.interactions = new Map()
    this.eventsAbort = new AbortController()
    this.runtime = new SessionRuntime(config)
    this.workspaceAliases = new Map([[PRIMARY_WORKSPACE_ID, canonicalWorkspaceRoot(config.workspaceRoot)]])
    this.runtimeWorkspaces = new Map()
    this.ready = this.runtime.recover(this, (id, before) => history(this.ctx, id, 100, before), turnCompletion, { id: PRIMARY_WORKSPACE_ID, root: canonicalWorkspaceRoot(config.workspaceRoot) })
    this.eventsTask = this.pumpEvents()
    this.broker.operationProbe = () => this.activeOperations().length > 0
    this.broker.operationResolver = sessionId => {
      const direct = this.operationForSession(sessionId)
      if (direct?.status === 'running') return { id: direct.id, workspace: direct.workspace ?? PRIMARY_WORKSPACE_ID }
      const active = this.activeOperations()
      return active.length === 1 ? { id: active[0].id, workspace: active[0].workspace ?? PRIMARY_WORKSPACE_ID } : undefined
    }
  }

  workspaceScope(workspace = {}, register = false) {
    if (typeof workspace === 'string') workspace = { id: workspace }
    const id = workspace.id ?? PRIMARY_WORKSPACE_ID
    const entry = this.workspaceRegistry?.get(id)
    let root = entry?.path ?? this.workspaceAliases.get(id)
    if (!entry && id !== PRIMARY_WORKSPACE_ID && register && workspace.root) root = workspace.root
    if (!root || (workspace.root && canonicalWorkspaceRoot(root) !== canonicalWorkspaceRoot(workspace.root))) {
      throw Object.assign(new Error('workspace is not open under this root'), { code: 'NOT_FOUND' })
    }
    root = canonicalWorkspaceRoot(root)
    if (register) this.workspaceAliases.set(id, root)
    return { id, root }
  }

  operationMatches(operation, workspace) {
    try {
      const current = this.workspaceScope({ id: operation.workspace ?? PRIMARY_WORKSPACE_ID })
      const expected = workspace === undefined ? current : this.workspaceScope(workspace)
      return current.id === expected.id && current.root === expected.root && canonicalWorkspaceRoot(operation.workspaceRoot ?? this.config.workspaceRoot) === expected.root
    } catch { return false }
  }

  async ensureRuntimeWorkspace(workspace = {}) {
    const scope = this.workspaceScope(workspace, true)
    await this.ready
    // Serialize reconciliation per root, but recheck leases on subsequent reads:
    // a controller that saw a live foreign owner may later observe expiration.
    const previous = this.runtimeWorkspaces.get(scope.root) ?? Promise.resolve()
    const task = previous.then(() => this.runtime.recover(this, (id, before) => history(this.ctx, id, 100, before), turnCompletion, scope))
    this.runtimeWorkspaces.set(scope.root, task)
    await task
    return scope
  }

  async runtimeStatus(sessionId, workspace = {}) {
    const scope = await this.ensureRuntimeWorkspace(workspace)
    return this.runtime.status(sessionId, scope.id, scope.root)
  }

  bindBrowser(sessionId, binding, verification) {
    const operation = this.operationForSession(sessionId)
    if (!operation) return
    this.runtime.require().bindBrowser(operation.rootSessionId, operation.workspace, operation.workspaceRoot, { ...binding, request_session_id: sessionId }, verification)
  }

  activeOperations(workspace) {
    return [...this.operations.values()].filter(operation => operation.status === 'running' && this.operationMatches(operation, workspace))
  }

  /**
   * The control-plane workspace gate.
   *
   * Every id the client hands back -- operation, session, request, interaction
   * -- is opaque, so nothing about it says which tree it belongs to. Each one
   * therefore carries the workspace it was created in, and this compares that
   * recorded value against the workspace the caller claims BEFORE the engine is
   * touched. The answer for a mismatch is NOT_FOUND, never a "wrong workspace"
   * message: confirming that an id exists somewhere else is itself the leak.
   */
  #gate(owned, workspace, subject) {
    if (owned && this.operationMatches(owned, workspace)) return
    throw Object.assign(new Error(`${subject} is not registered under this workspace`), { code: 'NOT_FOUND' })
  }

  operationForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    return this.operationsBySession.get(sessionId)
  }

  attachSessionToParent(childSessionId, parentSessionId) {
    if (typeof childSessionId !== 'string' || typeof parentSessionId !== 'string') return
    const operation = this.operationForSession(parentSessionId)
    if (operation !== undefined) this.operationsBySession.set(childSessionId, operation)
  }

  operationSummary(operation) {
    const pendingRequests = this.pendingForOperation(operation)
    return {
      operation_id: operation.id,
      session_id: operation.rootSessionId,
      root_session_id: operation.rootSessionId,
      workspace: operation.workspace ?? PRIMARY_WORKSPACE_ID,
      status: operation.status,
      accepted_at: operation.acceptedAt ?? operation.startedAt,
      started_at: operation.startedAt,
      execution_mode: operation.executionMode ?? 'relay',
      model_route: {
        provider: operation.modelProvider ?? this.config.provider,
        model: operation.modelId ?? this.config.model,
      },
      metrics: publicOperationMetrics(operation),
      pending_model_requests: pendingRequests.length,
      pending_interactions: this.interactionSnapshot(operation).length,
    }
  }

  /**
   * harness_operation_list: every root turn this bridge has registered, newest
   * first. Deterministic control-plane read -- no engine call, no LLM.
   */
  operationList({ status, limit = 20, workspace = {}, all_workspaces: allWorkspaces = false } = {}) {
    // Scoped, and scoped by default: omitting the workspace means the fixed
    // project root, never "every workspace this bridge has ever opened".
    // all_workspaces exists for bridge_status, which reports how much work the
    // bridge is carrying in total -- a count, never another workspace's state.
    const scope = workspace.id ?? PRIMARY_WORKSPACE_ID
    const all = [...this.operations.values()]
      .filter(operation => this.operationMatches(operation, allWorkspaces ? undefined : workspace))
      .filter(operation => status === undefined || operation.status === status)
      .sort((left, right) => right.startedAt - left.startedAt)
    const page = all.slice(0, limit)
    return {
      operations: page.map(operation => ({
        ...this.operationSummary(operation),
        speed_profile: operation.speedProfile,
        reasoning_effort: operation.reasoningEffort,
      })),
      workspace: allWorkspaces ? undefined : scope,
      total: all.length,
      active: allWorkspaces ? this.activeOperations().length : this.activeOperations(workspace).length,
      max_concurrent_turns: this.config.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS,
      truncated: all.length > page.length,
    }
  }

  /** harness_operation_get: compact full state for one root turn. */
  operationGet(operationId, workspace = {}) {
    const operation = this.operations.get(operationId)
    if (operation === undefined) {
      const error = new Error(`operation ${operationId} is not registered`)
      error.code = 'NOT_FOUND'
      throw error
    }
    this.#gate(operation, workspace, `operation ${operationId}`)
    const pending = this.pendingForOperation(operation)
    return {
      ...this.operationSummary(operation),
      speed_profile: operation.speedProfile,
      reasoning_effort: operation.reasoningEffort,
      accepted_at_iso: new Date(operation.acceptedAt ?? operation.startedAt).toISOString(),
      started_at_iso: new Date(operation.startedAt).toISOString(),
      duration_ms: Date.now() - (operation.acceptedAt ?? operation.startedAt),
      model_requests: pending.map(request => requestSummary(request)),
      interactions: this.interactionSnapshot(operation),
      sessions: [...this.operationsBySession.entries()]
        .filter(([, candidate]) => candidate.id === operation.id)
        .map(([sessionId]) => sessionId),
    }
  }

  /**
   * harness_session_get: one durable session's metadata plus whichever root
   * turn currently owns it. Sessions outside the fixed workspace stay invisible.
   */
  async sessionGet(sessionId, workspace = {}) {
    const listed = await this.sessions(workspace)
    const session = listed.sessions.find(item => item.sessionId === sessionId)
    if (session === undefined) {
      const error = new Error(`session ${sessionId} is not registered under bridge workspace ${workspace.id ?? PRIMARY_WORKSPACE_ID}`)
      error.code = 'NOT_FOUND'
      throw error
    }
    const operation = this.operationForSession(sessionId)
    if (operation) this.#gate(operation, workspace, `session ${sessionId}`)
    return {
      workspace: listed.workspace,
      workspace_root: listed.workspace_root,
      workspace_id: listed.workspace_id,
      workspace_title: listed.workspace_title,
      session,
      active_operation: operation === undefined ? undefined : this.operationSummary(operation),
      has_active_turn: operation?.status === 'running',
    }
  }

  /**
   * Resolve which turn a control-plane call is about, inside one workspace.
   * Every exit gates on the recorded workspace, and the implicit fallbacks
   * (single active turn, last turn) only ever consider that workspace -- so
   * omitting operation_id in workspace A can never land on a turn in B.
   */
  resolveOperation(operationId, sessionId, workspace = {}) {
    const scope = workspace.id ?? PRIMARY_WORKSPACE_ID
    if (operationId !== undefined) {
      const operation = this.operations.get(operationId)
      if (operation === undefined) throw new Error(`operation ${operationId} is not registered`)
      this.#gate(operation, workspace, `operation ${operationId}`)
      if (sessionId !== undefined && this.operationForSession(sessionId)?.id !== operation.id) {
        throw new Error('operation_id and session_id refer to different Shiro turns')
      }
      return operation
    }
    if (sessionId !== undefined) {
      const operation = this.operationForSession(sessionId)
      if (operation === undefined) throw new Error(`session ${sessionId} has no registered Shiro operation`)
      this.#gate(operation, workspace, `session ${sessionId}`)
      return operation
    }
    const active = this.activeOperations(workspace)
    if (active.length === 1) return active[0]
    if (active.length > 1) return null
    if (this.lastOperationId === null) return null
    const last = this.operations.get(this.lastOperationId)
    if (last === undefined) return null
    return this.operationMatches(last, workspace) ? last : null
  }

  pendingForOperation(operation) {
    return this.broker.snapshot().filter(request => (
      request.operation_id === operation.id
      || (request.operation_id === undefined && this.operationForSession(request.session_id)?.id === operation.id)
    ))
  }

  operationForRequest(request) {
    if (request?.operation_id !== undefined) return this.operations.get(request.operation_id)
    const direct = this.operationForSession(request?.session_id)
    if (direct !== undefined) return direct
    const active = this.activeOperations()
    return active.length === 1 ? active[0] : undefined
  }

  multipleOutcome(scope = PRIMARY_WORKSPACE_ID) {
    const active = this.activeOperations(scope)
    const pending = this.broker.snapshot().filter(request => (request.workspace ?? PRIMARY_WORKSPACE_ID) === scope)
    const interactions = this.interactionSnapshot(undefined, scope)
    const common = {
      workspace: scope,
      operations: active.map(operation => this.operationSummary(operation)),
      model_requests: pending.map(requestSummary),
    }
    if (pending.length > 0) {
      return {
        status: 'model_input_required',
        state: 'model_input_required',
        pending_action: 'model_response',
        request_id: pending[0].request_id,
        ...common,
        instruction: 'Multiple Shiro turns are active. Fetch and answer each pending request_id with harness_get_request and harness_continue; requests may be handled in parallel.',
      }
    }
    if (interactions.length > 0) {
      return {
        status: 'user_input_required',
        state: 'user_input_required',
        pending_action: 'user_response',
        interaction_id: interactions[0].interaction_id,
        interactions,
        ...common,
        instruction: 'Multiple Shiro turns are active. Relay each interaction to the user and answer it with harness_respond.',
      }
    }
    return {
      status: 'running',
      state: 'running',
      pending_action: 'poll',
      ...common,
      instruction: 'Multiple Shiro turns are running. Call harness_status again, or pass operation_id/session_id to inspect one turn.',
    }
  }

  async pumpEvents() {
    try {
      const stream = this.ctx.apiProxy.events.mux({
        rpcId: rpcId('bridge-events'),
        payload: {},
      }, this.eventsAbort.signal)
      for await (const envelope of stream) {
        const frame = envelope.payload
        this.attachSessionToParent(frame.childSessionId ?? frame.sessionId, frame.parentSessionId)
        if (frame.type === 'approval/requested' || frame.type === 'question/requested') {
          const operation = this.operationForSession(frame.sessionId)
          this.interactions.set(envelope.rpcId, {
            interaction_id: envelope.rpcId,
            // Stamped once, at the moment the engine asked: harness_respond
            // then checks a recorded fact instead of re-deriving ownership.
            workspace: operation?.workspace ?? PRIMARY_WORKSPACE_ID,
            ...(operation === undefined ? {} : { operation_id: operation.id }),
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

  interactionSnapshot(operation, scope) {
    const items = [...this.interactions.values()]
      .filter(item => scope === undefined || (item.workspace ?? PRIMARY_WORKSPACE_ID) === scope)
    if (operation === undefined) return items
    return items.filter(item => (
      item.operation_id === operation.id
      || (item.operation_id === undefined && this.operationForSession(item.sessionId)?.id === operation.id)
    ))
  }

  /**
   * Resolve the engine workspace for one directory. Engine workspaces are keyed
   * by path and `workspace.create` is resolve-or-create, so this is also how a
   * Harness turn is anchored somewhere other than the fixed project root: the
   * caller passes an opened bridge workspace's root and the session it creates
   * inherits that cwd, which is what every engine tool resolves against.
   */
  async workspace(root = this.config.workspaceRoot) {
    return unwrap(this.ctx.apiProxy.workspace.create({
      rpcId: rpcId('bridge-workspace'),
      payload: { path: root },
    }), 'workspace.create')
  }

  async sessions(workspace = {}) {
    const workspaceValue = await this.workspace(workspace.root)
    const listed = await unwrap(this.ctx.apiProxy.sessions.list({
      rpcId: rpcId('bridge-sessions'),
      payload: {},
    }), 'session.list')
    const allowed = new Set(workspaceValue.workspace.sessionIds)
    return {
      workspace: workspace.id ?? PRIMARY_WORKSPACE_ID,
      workspace_root: workspaceValue.workspace.path ?? workspace.root ?? this.config.workspaceRoot,
      workspace_id: workspaceValue.workspace.workspaceId,
      workspace_title: workspaceValue.workspace.title,
      sessions: listed.items.filter(item => allowed.has(item.sessionId)),
    }
  }

  /**
   * thread_events: the item stream for one thread, paged by sequence number.
   *
   * The engine's history call returns the last N events, so this pages FORWARD
   * from a cursor within that window rather than pretending to reach arbitrarily
   * far back: `window_start` says what the oldest visible event was, so a caller
   * whose cursor fell out of the window is told instead of silently skipping.
   */
  async threadEvents(sessionId, { fromSeq = -1, limit = 50, types, window = 400 } = {}, workspace = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200')
    const workspaceValue = await this.workspace(workspace.root)
    if (!workspaceValue.workspace.sessionIds.includes(sessionId)) {
      const error = new Error(`session_id is not registered under bridge workspace ${workspace.id ?? PRIMARY_WORKSPACE_ID}`)
      error.code = 'NOT_FOUND'
      throw error
    }
    const page = await history(this.ctx, sessionId, Math.max(limit, Math.min(1000, window)))
    const all = Array.isArray(page.events) ? page.events : []
    const windowStart = all.reduce((min, entry) => Math.min(min, entry.event.seq), Number.POSITIVE_INFINITY)
    const wanted = Array.isArray(types) && types.length > 0 ? new Set(types) : null
    const matched = all
      .filter(entry => entry.event.seq > fromSeq)
      .filter(entry => wanted === null || wanted.has(entry.event.type))
      .sort((left, right) => left.event.seq - right.event.seq)
    const slice = matched.slice(0, limit)
    const operation = this.operationForSession(sessionId)
    return redactSecrets({
      session_id: sessionId,
      workspace: workspace.id ?? PRIMARY_WORKSPACE_ID,
      events: slice,
      returned: slice.length,
      from_seq: fromSeq,
      next_seq: slice.length === 0 ? fromSeq : slice[slice.length - 1].event.seq,
      window_start: Number.isFinite(windowStart) ? windowStart : null,
      cursor_behind_window: Number.isFinite(windowStart) && fromSeq >= 0 && fromSeq + 1 < windowStart,
      truncated: matched.length > slice.length,
      has_active_turn: operation?.status === 'running',
      operation_id: operation?.id,
    })
  }

  /**
   * turn_steer: add a message to a turn that is already running.
   *
   * The engine takes queued prompts on a live session, which is exactly what
   * steering is; the guard is that there must BE a running turn, otherwise this
   * would silently become "start a new turn" with none of harness_start's
   * concurrency accounting.
   */
  async steer(sessionId, text, workspace = {}) {
    const message = String(text ?? '').trim()
    if (message === '') throw new Error('message is required')
    const operation = this.operationForSession(sessionId)
    if (operation === undefined || operation.status !== 'running') {
      const error = new Error(`thread ${sessionId} has no running turn to steer; use harness_start to begin one`)
      error.code = 'CONFLICT'
      throw error
    }
    this.#gate(operation, workspace, `thread ${sessionId}`)
    this.runtime.require().assertLease(operation.rootSessionId)
    await unwrap(this.ctx.apiProxy.sessions.prompt({
      rpcId: rpcId('bridge-steer'),
      payload: {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
        clientTimeZone: 'Asia/Saigon',
      },
    }), 'session.prompt')
    return {
      session_id: sessionId,
      operation_id: operation.id,
      workspace: operation.workspace ?? PRIMARY_WORKSPACE_ID,
      steered: true,
      characters: message.length,
      instruction: 'The message is queued for the running turn. Poll harness_status to see the turn pick it up.',
    }
  }

  /**
   * thread_fork: branch a conversation, when the engine supports it.
   *
   * Detected at call time rather than assumed: the bridge speaks to whatever
   * engine build is loaded, and claiming a capability that build lacks would
   * fail deep inside an rpc instead of here with a reason.
   */
  async fork(sessionId, { title } = {}, workspace = {}) {
    const workspaceValue = await this.workspace(workspace.root)
    if (!workspaceValue.workspace.sessionIds.includes(sessionId)) {
      const error = new Error(`session_id is not registered under bridge workspace ${workspace.id ?? PRIMARY_WORKSPACE_ID}`)
      error.code = 'NOT_FOUND'
      throw error
    }
    if (typeof this.ctx.apiProxy.sessions.fork !== 'function') {
      const error = new Error('this engine build exposes no sessions.fork, so a thread cannot be branched. Start a new thread with harness_start instead; bridge_capabilities reports features.thread_fork=false.')
      error.code = 'UNSUPPORTED'
      throw error
    }
    const created = await unwrap(this.ctx.apiProxy.sessions.fork({
      rpcId: rpcId('bridge-fork'),
      payload: { sessionId, ...(typeof title === 'string' && title !== '' ? { title } : {}) },
    }), 'session.fork')
    return {
      source_session_id: sessionId,
      session_id: String(created?.sessionId ?? created?.session?.sessionId ?? ''),
      workspace: workspace.id ?? PRIMARY_WORKSPACE_ID,
      forked: true,
    }
  }

  /** Whether this engine build can branch a conversation. */
  canFork() {
    return typeof this.ctx.apiProxy?.sessions?.fork === 'function'
  }

  async sessionLog(sessionId, limit = 50, workspace = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200')
    const workspaceValue = await this.workspace(workspace.root)
    if (!workspaceValue.workspace.sessionIds.includes(sessionId)) {
      throw new Error(`session_id is not registered under bridge workspace ${workspace.id ?? PRIMARY_WORKSPACE_ID}`)
    }
    const page = await history(this.ctx, sessionId, limit)
    const events = Array.isArray(page.events) ? page.events.slice(-limit) : []
    return redactSecrets({ session_id: sessionId, limit, events })
  }

  async start(prompt, agentPreset, requestedSessionId, speedProfile = 'balanced', reasoningEffort, waitOptions = {}, workspace = {}, requestedExecutionMode) {
    const acceptedAt = Date.now()
    // Validate the per-turn route before creating or claiming a durable
    // session. In particular, an autonomous override on a relay-only bridge
    // must fail without leaving an otherwise unused session behind.
    const route = executionRoute(this.config, requestedExecutionMode ?? this.config.executionMode ?? 'relay', speedProfile, reasoningEffort)
    workspace = await this.ensureRuntimeWorkspace(workspace)
    const kernel = this.runtime.require()
    const limit = this.config.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS
    if (this.activeOperations().length + this.pendingStarts >= limit) {
      throw new Error(`Shiro already has ${limit} concurrent root turns; wait for or cancel one before starting another`)
    }
    if (requestedSessionId !== undefined) {
      if (this.startingSessions.has(requestedSessionId) || this.operationForSession(requestedSessionId)?.status === 'running') {
        throw new Error(`session ${requestedSessionId} already has a running root turn`)
      }
      this.startingSessions.add(requestedSessionId)
    }
    this.pendingStarts += 1
    let operation
    try {
      const workspaceValue = await this.workspace(workspace.root)
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
          // Sessions are namespaced by workspace: resuming one from another
          // workspace would run it against the wrong tree.
          throw new Error(`session_id is not registered under bridge workspace ${workspace.id ?? PRIMARY_WORKSPACE_ID}; list it with harness_sessions for that workspace`)
        }
        created = { sessionId: requestedSessionId }
      }
      kernel.claim({ session_id: created.sessionId, runtime_mode: 'web-harness', loop_owner: 'harness',
        workspace_id: workspace.id ?? PRIMARY_WORKSPACE_ID, workspace_root: workspace.root ?? this.config.workspaceRoot })
      const durable = kernel.session(created.sessionId, workspace.id ?? PRIMARY_WORKSPACE_ID, workspace.root ?? this.config.workspaceRoot)
      if (this.operationForSession(created.sessionId)?.status === 'interrupted' || durable.effects.some(effect => effect.state === 'uncertain' || effect.state === 'started')) {
        throw Object.assign(new Error('session has an ambiguous interrupted turn; reconcile engine execution before resuming'), { code: 'CONFLICT' })
      }
      kernel.updateSession(created.sessionId, { requested_model: route.model, requested_effort: route.effort, verified_model: null, verified_effort: null })
      await unwrap(this.ctx.apiProxy.sessions.selectModel({
        rpcId: rpcId('bridge-model'),
        payload: {
          sessionId: created.sessionId,
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.effort,
        },
      }), 'session.selectModel')
      const before = await history(this.ctx, created.sessionId)
      operation = {
        id: randomUUID(),
        rootSessionId: created.sessionId,
        workspaceId: workspaceValue.workspace.workspaceId,
        workspace: workspace.id ?? PRIMARY_WORKSPACE_ID,
        workspaceRoot: workspace.root ?? this.config.workspaceRoot,
        afterSeq: latestSeq(before),
        status: 'running',
        acceptedAt,
        startedAt: Date.now(),
        executionMode: route.mode,
        modelProvider: route.provider,
        modelId: route.model,
        speedProfile: route.profile.id,
        reasoningEffort: route.effort,
        recoverableEnd: null,
      }
      this.runtime.persist(operation)
      this.operations.set(operation.id, operation)
      this.operationsBySession.set(operation.rootSessionId, operation)
      this.lastOperationId = operation.id
      await kernel.runEffect({ effect_id: randomUUID(), session_id: created.sessionId, operation_id: operation.id, name: 'harness.prompt', arguments: { session_id: created.sessionId } }, () => unwrap(this.ctx.apiProxy.sessions.prompt({
        rpcId: rpcId('bridge-prompt'),
        payload: {
          sessionId: created.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
          clientTimeZone: 'Asia/Saigon',
        },
      }), 'session.prompt'))
      return this.waitForOutcome(this.config.waitMs, { ...waitOptions, operationId: operation.id, workspace })
    } catch (error) {
      if (operation?.status === 'running' && error.code !== 'FENCED') {
        operation.status = 'failed'
        operation.recoveryState = 'dispatch-failed-or-uncertain'
        this.runtime.persist(operation)
      }
      throw error
    } finally {
      this.pendingStarts -= 1
      if (requestedSessionId !== undefined) this.startingSessions.delete(requestedSessionId)
    }
  }

  async submit(requestId, response, waitMs, waitOptions = {}, workspace = {}) {
    const request = this.broker.request(requestId)
    if (request === undefined) throw new Error(`model request ${requestId} is not pending`)
    // Gate before the answer reaches the engine: a model response is an input
    // to a running turn, so accepting one across workspaces would let a caller
    // scoped to B drive a turn in A.
    this.#gate(this.operationForRequest(request) ?? { workspace: request.workspace, workspaceRoot: this.config.workspaceRoot }, workspace, `model request ${requestId}`)
    const operation = this.operationForRequest(request)
    if (operation === undefined) throw new Error(`model request ${requestId} cannot be matched to one active Shiro operation`)
    this.runtime.require().assertLease(operation.rootSessionId)
    this.broker.submit(requestId, response)
    return this.waitForOutcome(waitMs, { ...waitOptions, operationId: operation.id, workspace })
  }

  /** harness_get_request: the full body of one pending request, workspace-gated. */
  pendingRequest(requestId, workspace = {}) {
    const request = this.broker.request(requestId)
    if (request === undefined) return undefined
    this.#gate(this.operationForRequest(request) ?? { workspace: request.workspace, workspaceRoot: this.config.workspaceRoot }, workspace, `model request ${requestId}`)
    return request
  }

  async waitForOutcome(waitMs, { operationId, sessionId, signal, onProgress, workspace = {} } = {}) {
    workspace = await this.ensureRuntimeWorkspace(workspace)
    if (signal?.aborted) throw requestCancelledError()
    const scope = workspace.id ?? PRIMARY_WORKSPACE_ID
    if (operationId === undefined && sessionId === undefined && this.activeOperations(scope).length > 1) {
      return this.multipleOutcome(scope)
    }
    const operation = this.resolveOperation(operationId, sessionId, workspace)
    if (operation === null) {
      // Even the idle answer stays inside the workspace: the pending requests
      // of another tree are not this caller's business.
      return {
        status: 'idle',
        state: 'idle',
        pending_action: 'none',
        workspace: scope,
        model_requests: this.broker.snapshot().filter(request => (request.workspace ?? PRIMARY_WORKSPACE_ID) === scope).map(requestSummary),
      }
    }
    if (operation.status !== 'running') return {
      status: operation.status, state: operation.status, pending_action: 'none',
      operation_id: operation.id, session_id: operation.rootSessionId, root_session_id: operation.rootSessionId,
      workspace: scope,
      execution_mode: operation.executionMode ?? 'relay',
      model_route: { provider: operation.modelProvider ?? this.config.provider, model: operation.modelId ?? this.config.model },
      metrics: publicOperationMetrics(operation),
      recovery_state: operation.recoveryState,
      completion: operation.completion,
    }
    try { this.runtime.require().assertLease(operation.rootSessionId) } catch (error) {
      if (error.code !== 'FENCED') throw error
      return { status: operation.status, state: operation.status, pending_action: 'none', operation_id: operation.id, session_id: operation.rootSessionId, workspace: scope, recovery_state: 'owned-by-other-executor' }
    }
    const startedAt = Date.now()
    const deadline = startedAt + waitMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw requestCancelledError()
      if (onProgress !== undefined) await onProgress(Date.now() - startedAt, waitMs)
      const pending = this.pendingForOperation(operation)
      if (pending.length > 0) {
        return {
          status: 'model_input_required',
          state: 'model_input_required',
          pending_action: 'model_response',
          request_id: pending[0].request_id,
          operation_id: operation.id,
          session_id: operation.rootSessionId,
          root_session_id: operation.rootSessionId,
          workspace: operation.workspace ?? PRIMARY_WORKSPACE_ID,
          execution_mode: operation.executionMode ?? 'relay',
          model_route: { provider: operation.modelProvider ?? this.config.provider, model: operation.modelId ?? this.config.model },
          metrics: publicOperationMetrics(operation),
          model_requests: pending.map(requestSummary),
          requested_profile: {
            speed: operation.speedProfile,
            effort: operation.reasoningEffort,
          },
          instruction: `Fetch the full body of request_id with harness_get_request (paginate with messages_from if truncated), act as ${modelDisplayName(operation.modelId ?? this.config.model)} with requested speed=${operation.speedProfile} and effort=${operation.reasoningEffort}, then answer with harness_continue. Return Harness tool calls as tool_call blocks; do not execute those tools outside Harness. Submit every pending request, then continue until status is completed.`,
        }
      }
      const interactions = this.interactionSnapshot(operation)
      if (interactions.length > 0) {
        return {
          status: 'user_input_required',
          state: 'user_input_required',
          pending_action: 'user_response',
          interaction_id: interactions[0].interaction_id,
          operation_id: operation.id,
          session_id: operation.rootSessionId,
          root_session_id: operation.rootSessionId,
          workspace: operation.workspace ?? PRIMARY_WORKSPACE_ID,
          execution_mode: operation.executionMode ?? 'relay',
          model_route: { provider: operation.modelProvider ?? this.config.provider, model: operation.modelId ?? this.config.model },
          metrics: publicOperationMetrics(operation),
          interactions,
          instruction: 'Relay questions to the user. Allow an approval only after the user explicitly consents to that exact operation; otherwise reject it. Call harness_respond, then continue.',
        }
      }
      const page = await history(this.ctx, operation.rootSessionId)
      const metrics = metricState(operation)
      const metricSeqBefore = metrics.last_seq
      const metricCompleteBefore = metrics.complete !== false
      const observedSeq = Math.max(operation.lastEventSeq ?? operation.afterSeq, latestSeq(page))
      if (latestSeq(page) > metricSeqBefore) {
        if (historyCoversAfterSeq(page, metricSeqBefore)) {
          observeOperationMetrics(operation, page)
        } else {
          const recovered = await recoveryHistory(
            beforeSeq => history(this.ctx, operation.rootSessionId, 500, beforeSeq),
            metricSeqBefore,
          )
          if (recovered === null) {
            metrics.complete = false
            metrics.gap_after_seq = metricSeqBefore
          } else {
            observeOperationMetrics(operation, recovered)
          }
        }
      }
      if (
        observedSeq !== operation.lastEventSeq
        || metricState(operation).last_seq !== metricSeqBefore
        || (metricState(operation).complete !== false) !== metricCompleteBefore
      ) {
        operation.lastEventSeq = observedSeq
        this.runtime.persist(operation)
      }
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
        operation.completion = done
        operation.status = done.reason?.kind === 'error' ? 'failed' : done.reason?.kind === 'interrupted' ? 'cancelled' : 'completed'
        this.runtime.persist(operation)
        return {
          status: operation.status,
          state: operation.status,
          pending_action: 'none',
          operation_id: operation.id,
          session_id: operation.rootSessionId,
          root_session_id: operation.rootSessionId,
          workspace: operation.workspace ?? PRIMARY_WORKSPACE_ID,
          execution_mode: operation.executionMode ?? 'relay',
          model_route: { provider: operation.modelProvider ?? this.config.provider, model: operation.modelId ?? this.config.model },
          metrics: publicOperationMetrics(operation),
          completion: done,
        }
      }
      await delay(150)
    }
    if (signal?.aborted) throw requestCancelledError()
    return {
      status: 'running',
      state: 'running',
      pending_action: 'poll',
      operation_id: operation.id,
      session_id: operation.rootSessionId,
      root_session_id: operation.rootSessionId,
      workspace: operation.workspace ?? PRIMARY_WORKSPACE_ID,
      execution_mode: operation.executionMode ?? 'relay',
      model_route: { provider: operation.modelProvider ?? this.config.provider, model: operation.modelId ?? this.config.model },
      metrics: publicOperationMetrics(operation),
      model_requests: this.pendingForOperation(operation).map(requestSummary),
      instruction: operation.executionMode === 'autonomous'
        ? 'Harness owns the model/tool loop locally. Read thread_events for progress or call harness_status again; only respond when an approval/question is surfaced.'
        : 'Call harness_status or harness_continue again. Legacy relay mode is still executing the Harness turn.',
    }
  }

  async status(waitMs, operationId, sessionId, waitOptions = {}, workspace = {}) {
    return this.waitForOutcome(waitMs, { ...waitOptions, operationId, sessionId, workspace })
  }

  async respond(interactionId, approvalOutcome, answers, waitMs, waitOptions = {}, workspace = {}) {
    const interaction = this.interactions.get(interactionId)
    if (interaction === undefined) throw new Error(`interaction ${interactionId} is not pending`)
    // An approval is the highest-value input in the system: it is what lets a
    // turn do something destructive. It never crosses a workspace boundary.
    this.#gate(this.operations.get(interaction.operation_id) ?? this.operationForSession(interaction.sessionId), workspace, `interaction ${interactionId}`)
    const operation = interaction.operation_id === undefined
      ? this.operationForSession(interaction.sessionId)
      : this.operations.get(interaction.operation_id)
    if (operation === undefined) throw new Error(`interaction ${interactionId} cannot be matched to one active Shiro operation`)
    this.runtime.require().assertLease(operation.rootSessionId)
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
    return this.waitForOutcome(waitMs, { ...waitOptions, operationId: operation.id, workspace })
  }

  async readAttachment(ref, maxBytes) {
    const store = this.ctx.get('attachments')
    if (store === undefined || store === null || typeof store.readImage !== 'function') {
      throw new Error('no attachment store is mounted in this Shiro composition')
    }
    const stored = await store.readImage(ref)
    if (stored.data.byteLength > maxBytes) {
      throw new Error(`attachment is ${stored.data.byteLength} bytes; the limit is ${maxBytes}`)
    }
    const name = typeof stored.ref?.name === 'string' && stored.ref.name !== '' ? stored.ref.name : 'attachment'
    return { kind: 'image', mimeType: stored.ref.mediaType, data: stored.data, bytes: stored.data.byteLength, name }
  }

  async cancel(operationId, sessionId, workspace = {}) {
    workspace = await this.ensureRuntimeWorkspace(workspace)
    if (operationId === undefined && sessionId === undefined && this.activeOperations(workspace).length > 1) {
      throw new Error('multiple Shiro turns are active; pass operation_id or session_id to cancel exactly one')
    }
    const operation = this.resolveOperation(operationId, sessionId, workspace)
    if (!operation) return { cancelled: false, status: 'idle' }
    const kernel = this.runtime.require()
    const effectId = `cancel:${operation.id}`
    const prior = kernel.session(operation.rootSessionId, workspace.id, workspace.root).effects.find(effect => effect.effect_id === effectId)
    const accepted = () => ({ cancelled: true, operation_id: operation.id, session_id: operation.rootSessionId, root_session_id: operation.rootSessionId, workspace: workspace.id })
    if (prior?.state === 'succeeded') return accepted()
    if (prior) return { cancelled: false, status: 'cancellation-uncertain' }
    const potentiallyLive = operation.status === 'running' || operation.status === 'interrupted'
      || (operation.status === 'failed' && operation.recoveryState === 'dispatch-failed-or-uncertain')
    if (!potentiallyLive) return { cancelled: false, status: operation.status }
    // A locally running operation was created through this controller, so its
    // session membership is already proven. Recovered interrupted/failed work
    // may outlive the bridge process, therefore re-check engine membership
    // before sending a cancellation into that durable session.
    if (operation.status !== 'running') {
      const membership = await this.workspace(workspace.root)
      if (!membership.workspace.sessionIds.includes(operation.rootSessionId)) throw Object.assign(new Error('session is not registered under this workspace'), { code: 'NOT_FOUND' })
    }
    const current = this.operationForSession(operation.rootSessionId)
    if (current && current.id !== operation.id && current.status === 'running') {
      throw Object.assign(new Error('a newer turn is running on this session; refusing to cancel an older operation'), { code: 'CONFLICT' })
    }
    kernel.assertLease(operation.rootSessionId)
    await kernel.runEffect({ effect_id: effectId, session_id: operation.rootSessionId, operation_id: operation.id, name: 'harness.cancel', arguments: { session_id: operation.rootSessionId } }, () => unwrap(this.ctx.apiProxy.sessions.cancel({
      rpcId: rpcId('bridge-cancel'), payload: { sessionId: operation.rootSessionId },
    }), 'session.cancel'))
    operation.status = 'cancelled'
    operation.recoveryState = 'cancellation-accepted-effects-unverified'
    this.runtime.persist(operation)
    return accepted()
  }

  async dispose() {
    this.eventsAbort.abort()
    await this.eventsTask
    await this.ready
    await Promise.all(this.runtimeWorkspaces.values())
    this.runtime.close()
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

function requestCancelledError() {
  const error = new Error('MCP request wait was cancelled; the underlying Shiro turn is still running. Call harness_status to resume waiting or harness_cancel to cancel the turn.')
  error.code = 'request_cancelled'
  error.retryable = true
  return error
}

function requestWaitOptions(extra, label) {
  const progressToken = extra?._meta?.progressToken
  let lastProgressAt = 0
  return {
    signal: extra?.signal,
    onProgress: progressToken === undefined ? undefined : async (elapsedMs, totalMs) => {
      const now = Date.now()
      if (elapsedMs > 0 && now - lastProgressAt < PROGRESS_INTERVAL_MS) return
      lastProgressAt = now
      if (extra?.signal?.aborted) return
      try {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: Math.min(elapsedMs, totalMs),
            total: totalMs,
            message: `${label} (${Math.floor(elapsedMs / 1000)}s)`,
          },
        })
      } catch (error) {
        if (!extra?.signal?.aborted) process.stderr.write(`shiro-bridge: progress notification failed: ${asError(error).message}\n`)
      }
    },
  }
}

export const MAX_ARTIFACT_BYTES = 6_000_000

/**
 * Read one file for the MCP artifact bridge. The resolved real path must stay
 * inside the fixed workspace root (symlinks included), the file must be a
 * regular file, and it must fit under maxBytes -- the caller receives the raw
 * bytes plus enough metadata to build the right MCP content block.
 */
export async function readWorkspaceArtifact(workspaceRoot, requestedPath, maxBytes = MAX_ARTIFACT_BYTES) {
  const rootReal = await realpath(workspaceRoot)
  const target = resolve(rootReal, requestedPath)
  let real
  try {
    real = await realpath(target)
  } catch {
    throw new Error(`artifact not found: ${requestedPath}`)
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error('artifact path escapes the fixed project root')
  }
  const info = await stat(real)
  if (!info.isFile()) throw new Error('artifact path is not a regular file')
  if (info.size > maxBytes) {
    throw new Error(`artifact is ${info.size} bytes; the limit is ${maxBytes}. Produce a smaller file (crop, compress, or excerpt) and fetch that instead.`)
  }
  const data = await readFile(real)
  const extension = extname(real).toLowerCase()
  const relativePath = relative(rootReal, real)
  const imageMime = IMAGE_MIME_BY_EXTENSION[extension]
  if (imageMime !== undefined) {
    return { kind: 'image', mimeType: imageMime, data, path: relativePath, bytes: info.size }
  }
  const looksText = TEXT_EXTENSIONS.has(extension) || !data.subarray(0, 4096).includes(0)
  if (looksText) {
    return { kind: 'text', mimeType: 'text/plain', data, path: relativePath, bytes: info.size }
  }
  return { kind: 'blob', mimeType: 'application/octet-stream', data, path: relativePath, bytes: info.size }
}

// Shared shape for every turn-outcome tool (start/continue/status/respond).
// The flat coordination fields (state/pending_action/request_id/...) are what
// the MCP client steers by; the legacy status/root_session_id names stay for
// compatibility with earlier conversations.
const outcomeShape = {
  status: z.string(),
  state: z.string(),
  pending_action: z.enum(['model_response', 'user_response', 'poll', 'none']),
  request_id: z.string().optional().describe('Present when state is model_input_required: pass it to harness_continue.'),
  interaction_id: z.string().optional().describe('Present when state is user_input_required: pass it to harness_respond.'),
  session_id: z.string().optional(),
  operation_id: z.string().optional(),
  root_session_id: z.string().optional(),
  workspace: z.string().optional().describe('Bridge workspace the turn is anchored in.'),
  execution_mode: z.enum(['autonomous', 'relay']).optional().describe('autonomous keeps model↔tool rounds inside Harness; relay exposes model requests to the MCP client for compatibility.'),
  model_route: looseObject().optional().describe('{provider, model} selected for this operation.'),
  metrics: looseObject().optional().describe('Per-operation Codex-style timing/call counters derived from durable session events.'),
  model_requests: z.array(looseObject()).optional(),
  operations: z.array(looseObject()).optional(),
  interactions: z.array(looseObject()).optional(),
  completion: looseObject().optional(),
  recovery_state: z.string().optional(),
  requested_profile: looseObject().optional(),
  instruction: z.string().optional(),
}

const fleetSnapshotShape = FLEET_SNAPSHOT_SHAPE

/**
 * Service logs the launcher writes into the runtime directory beside the
 * project root. logs_tail takes a stream NAME from this fixed list, never a
 * caller-supplied path, so reading outside the sandbox stays a closed set of
 * four known services rather than an escape hatch.
 */
export const LOG_STREAMS = Object.freeze([
  'backend.stdout', 'backend.stderr',
  'chatgpt-relay.stdout', 'chatgpt-relay.stderr',
  'tunnel.stdout', 'tunnel.stderr',
  'chromium.stdout', 'chromium.stderr',
])

export async function readServiceLog(logDir, { stream, from_offset: fromOffset, max_bytes: maxBytes = 65_536 } = {}) {
  if (!LOG_STREAMS.includes(stream)) {
    throw new ActionError('INVALID_ARGUMENT', `stream must be one of ${LOG_STREAMS.join(', ')}`)
  }
  const file = resolve(logDir, `${stream}.log`)
  let info
  try {
    info = await stat(file)
  } catch {
    throw new ActionError('NOT_FOUND', `no ${stream} log has been written yet (${file})`)
  }
  const start = fromOffset === undefined ? Math.max(0, info.size - maxBytes) : Math.min(fromOffset, info.size)
  const length = Math.min(maxBytes, info.size - start)
  const handle = await open(file, 'r')
  let buffer
  try {
    buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, start)
  } finally {
    await handle.close()
  }
  const next = start + length
  return {
    stream,
    // Service logs routinely echo tokens from the launcher environment, so the
    // redactor runs before anything leaves the bridge.
    content: redactSecrets(buffer.toString('utf8')),
    offset: start,
    next_offset: next,
    size: info.size,
    redacted: true,
    truncated: next < info.size,
  }
}

/**
 * Descriptors for the twelve original Harness tools, so bridge_capabilities can
 * report one complete action inventory instead of only the direct actions.
 */
export const HARNESS_ACTION_DESCRIPTORS = Object.freeze([
  { name: 'harness_profiles', title: 'List exact Shiro speed and effort profiles', family: 'harness', read_only: true, destructive: false, requires_confirmation: false },
  { name: 'session_runtime_status', title: 'Read durable session runtime', family: 'harness', read_only: true, destructive: false, requires_confirmation: false },
  { name: 'harness_start', title: 'Start a full Shiro coding task', family: 'harness', read_only: false, destructive: false, requires_confirmation: false },
  { name: 'harness_sessions', title: 'List resumable Shiro sessions', family: 'harness', read_only: true, destructive: false, requires_confirmation: false },
  { name: 'harness_get_request', title: 'Fetch the full body of one pending model request', family: 'harness', read_only: true, destructive: false, requires_confirmation: false },
  { name: 'harness_continue', title: 'Return one relay model decision to Shiro', family: 'harness', read_only: false, destructive: false, requires_confirmation: false },
  { name: 'harness_status', title: 'Inspect active Shiro tasks', family: 'harness', read_only: true, destructive: false, requires_confirmation: false },
  { name: 'harness_respond', title: 'Answer a Harness question or approval request', family: 'harness', read_only: false, destructive: false, requires_confirmation: false },
  { name: 'harness_get_artifact', title: 'Fetch a produced file or image over MCP', family: 'artifact', read_only: true, destructive: false, requires_confirmation: false },
  { name: 'harness_cancel', title: 'Request cancellation of one Shiro turn', family: 'harness', read_only: false, destructive: true, requires_confirmation: false },
  { name: 'fleet_start', title: 'Start or resume a named ChatGPT worker fleet', family: 'fleet', read_only: false, destructive: false, requires_confirmation: false },
  { name: 'fleet_status', title: 'Read one named ChatGPT worker fleet', family: 'fleet', read_only: true, destructive: false, requires_confirmation: false },
  { name: 'fleet_stop', title: 'Stop one named ChatGPT worker fleet', family: 'fleet', read_only: false, destructive: true, requires_confirmation: false },
])

export const BRIDGE_VERSION = '0.2.0'

// Bumped whenever the direct-action surface changes shape, so a client can
// feature-detect with bridge_capabilities instead of assuming every deployment
// exposes the same actions.
export const DIRECT_ACTIONS_VERSION = 7

export function configureMcp(server, controller, config, fleetManager = null, runtime = {}) {
  const requestDefaultExecutionMode = runtime.requestDefaultExecutionMode ?? config.executionMode ?? 'relay'
  const requestClientKind = runtime.requestClientKind ?? 'embedded'
  // A local OmniCast client opens this short critical section before prompting
  // ChatGPT. While it is active an inbound connector request receives exactly
  // one tool, so prompt text cannot grant itself filesystem/shell/git access.
  if (runtime.requestControlAuthorized !== true
    && runtime.omnicastReturns?.restrictsConnector()) {
    registerOmnicastReturnOnly(server, {
      mailbox: runtime.omnicastReturns,
      // An unverified routing marker has no authority. Build the same one-tool
      // catalog as a real connector even when it claimed `shiro-python`.
      clientKind: 'connector',
      metrics: runtime.metrics,
    })
    return
  }
  // Workspaces are resolved first: the artifact resource and harness_get_artifact
  // both address files through them, not through the raw project root, so a file
  // produced in a secondary workspace is fetchable by the same URI scheme.
  const workspaces = runtime.workspaces ?? new WorkspaceRegistry({
    projectRoot: config.workspaceRoot,
    allowedRoots: config.workspaceAllowlist ?? [],
  })
  controller.workspaceRegistry = workspaces
  setConfirmationPolicy({ required: config.requireConfirmations === true })
  const policy = runtime.policy ?? new PermissionPolicy({ profile: config.permissionProfile, rules: config.permissionRules })
  // The harness and fleet tools are written out by hand below rather than built
  // from the direct-action table, so they need the gate applied explicitly.
  // Registering one of them through `server.registerTool` directly would slip
  // past the policy -- permission-coverage.test.js fails if that happens again.
  const gate = createActionGate({ policy, descriptors: HARNESS_ACTION_DESCRIPTORS })
  const registerGatedTool = (name, spec, handler) => server.registerTool(name, spec, gate(name, handler))
  const threads = runtime.threads ?? new ThreadRegistry({
    stateFile: resolve(config.fleetStateDir ?? resolve(config.workspaceRoot, '..', '.ShiroRuntime', 'state'), '..', 'threads.json'),
  })
  // Two templates on purpose: the SDK matches a URI template exactly, so
  // `{?path,workspace}` alone would stop resolving every `shiro://artifact?path=`
  // URI already handed out. The bare form keeps addressing the project root and
  // the two-variable form addresses an opened workspace.
  const artifactTemplate = new ResourceTemplate('shiro://artifact{?path}', { list: undefined })
  const workspaceArtifactTemplate = new ResourceTemplate('shiro://artifact{?path,workspace}', { list: undefined })
  const sessionLogTemplate = new ResourceTemplate('shiro://session-log{?session_id,limit}', { list: undefined })
  const artifactUri = (path, workspace) => (workspace === undefined || workspace === PRIMARY_WORKSPACE_ID
    ? artifactTemplate.uriTemplate.expand({ path })
    : workspaceArtifactTemplate.uriTemplate.expand({ path, workspace }))
  const artifactRoot = workspace => workspaces.get(workspace).path
  // An engine turn may only be anchored in a workspace the bridge already has
  // open: an unknown id fails before the engine sees a path, so the operator
  // allowlist governs agent turns exactly as it governs direct actions.
  const harnessWorkspace = workspace => {
    const entry = workspaces.get(workspace)
    return { id: entry.id, root: entry.path }
  }

  server.registerResource('shiro-sessions', 'shiro://sessions', {
    title: 'Shiro durable sessions',
    description: 'Durable Shiro sessions registered under the fixed workspace root.',
    mimeType: 'application/json',
  }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await controller.sessions()) }],
  }))

  server.registerResource('shiro-status', 'shiro://status', {
    title: 'Shiro active task status',
    description: 'Current status of the active Shiro turn without waiting.',
    mimeType: 'application/json',
  }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await controller.status(0)) }],
  }))

  server.registerResource('shiro-session-log', sessionLogTemplate, {
    title: 'Shiro bounded session log',
    description: 'Read a bounded, redacted event log for one durable session under the fixed workspace root.',
    mimeType: 'application/json',
  }, async (uri, variables) => {
    const rawSessionId = Array.isArray(variables.session_id) ? variables.session_id[0] : variables.session_id
    if (typeof rawSessionId !== 'string' || rawSessionId === '') throw new Error('session_id is required')
    let sessionId
    try {
      sessionId = decodeURIComponent(rawSessionId)
    } catch {
      throw new Error('session_id is not valid URI encoding')
    }
    const rawLimit = Array.isArray(variables.limit) ? variables.limit[0] : variables.limit
    const limit = rawLimit === undefined || rawLimit === '' ? 50 : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200')
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await controller.sessionLog(sessionId, limit)) }],
    }
  })

  const readArtifactResource = async (uri, variables) => {
    const rawPath = Array.isArray(variables.path) ? variables.path[0] : variables.path
    if (typeof rawPath !== 'string' || rawPath === '') throw new Error('artifact resource path is required')
    let requestedPath
    try {
      requestedPath = decodeURIComponent(rawPath)
    } catch {
      throw new Error('artifact resource path is not valid URI encoding')
    }
    const rawWorkspace = Array.isArray(variables.workspace) ? variables.workspace[0] : variables.workspace
    const artifact = await readWorkspaceArtifact(artifactRoot(rawWorkspace === '' ? undefined : rawWorkspace), requestedPath)
    const common = { uri: uri.href, mimeType: artifact.mimeType }
    return {
      contents: [artifact.kind === 'text'
        ? { ...common, text: Buffer.from(artifact.data).toString('utf8') }
        : { ...common, blob: Buffer.from(artifact.data).toString('base64') }],
    }
  }

  server.registerResource('shiro-artifact', artifactTemplate, {
    title: 'Shiro workspace artifact',
    description: `Read one file inside the fixed Shiro workspace ${config.workspaceRoot}.`,
    mimeType: 'application/octet-stream',
  }, readArtifactResource)

  server.registerResource('shiro-artifact-workspace', workspaceArtifactTemplate, {
    title: 'Shiro artifact in an opened workspace',
    description: 'Read one file inside a workspace opened with workspace_open, addressed by its workspace id.',
    mimeType: 'application/octet-stream',
  }, readArtifactResource)

  server.registerPrompt('review-code', {
    title: 'Review code with Shiro',
    description: 'Review code in the Shiro workspace without modifying it unless explicitly requested.',
    argsSchema: { scope: z.string().optional().describe('Optional file, directory, diff, or feature scope.') },
  }, async ({ scope }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Review ${scope ?? 'the relevant current changes'} in the Shiro workspace. Inspect the implementation and tests first, then report concrete correctness, security, compatibility, and maintainability issues with evidence. Do not modify files unless I explicitly ask you to.` } }],
  }))

  server.registerPrompt('fix-tests', {
    title: 'Fix failing tests with Shiro',
    description: 'Run relevant tests, fix the root cause, and rerun focused validation.',
    argsSchema: { command: z.string().optional().describe('Optional failing or focused test command.') },
  }, async ({ command }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Use Shiro to ${command === undefined ? 'run the relevant tests' : `run ${command}`}, diagnose any failure, fix the root cause with the smallest compatible change, and rerun focused validation. Preserve unrelated working-tree changes.` } }],
  }))

  server.registerPrompt('resume-session', {
    title: 'Resume a durable Shiro session',
    description: 'Resume one exact durable Harness session and continue its pending work.',
    argsSchema: { session_id: z.string().min(1).describe('Session id returned by harness_sessions.') },
  }, async ({ session_id: sessionId }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Resume the exact durable Shiro session ${sessionId} with harness_start using that session_id. In autonomous mode let Harness own the local model/tool loop and follow thread_events/status; use harness_continue only if this session is explicitly running in legacy relay mode. Do not create a replacement session.` } }],
  }))

  registerGatedTool('harness_profiles', {
    title: 'List exact Shiro speed and effort profiles',
    description: 'Returns the exact supported speed profiles, effort levels, defaults, and the limitation that ChatGPT Web compute settings remain controlled by the ChatGPT model selector. Use this when the user asks which parameters are active.',
    inputSchema: {},
    outputSchema: resultSchema({
      speed_profiles: z.array(looseObject()),
      reasoning_efforts: z.array(looseObject()),
      default: looseObject(),
      scope: z.string(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult({
    speed_profiles: SPEED_PROFILES.map(({ id, name, description, defaultEffort }) => ({ id, name, description, default_effort: defaultEffort })),
    reasoning_efforts: REASONING_EFFORTS,
    default: { speed_profile: 'balanced', reasoning_effort: 'standard' },
    scope: `These values select Shiro operating policy. In autonomous mode inference runs on the configured local ctx.llm route${config.autonomousProvider ? ` (${config.autonomousProvider}/${config.autonomousModel})` : ''}; in legacy relay mode ChatGPT Web model entitlement remains external.`,
  }))

  const requireFleetManager = () => {
    if (fleetManager === null) throw new Error('Shiro browser fleet manager is unavailable because the browser relay is not configured')
    return fleetManager
  }

  registerGatedTool('fleet_start', {
    title: 'Start or resume a named ChatGPT worker fleet',
    description: 'Creates or idempotently resumes a named fleet of ChatGPT Web worker tabs. Shiro owns stable fleet slots, recurring prompt scheduling, browser-tab lifecycle and persisted state server-side, so the client does not orchestrate individual tabs or repeated sends.',
    inputSchema: {
      name: z.string().min(1).max(64),
      size: z.number().int().min(1).max(20),
      prompt: z.string().min(1),
      interval_minutes: z.number().positive().max(10_080).optional(),
      chat_mode: z.enum(['normal', 'temporary']).optional(),
      stagger_seconds: z.number().nonnegative().max(300).optional(),
      max_session_runs: z.number().int().min(1).max(100).optional(),
    },
    outputSchema: resultSchema(fleetSnapshotShape),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ name, size, prompt, interval_minutes: intervalMinutes, chat_mode: chatMode, stagger_seconds: staggerSeconds, max_session_runs: maxSessionRuns }) => {
    try {
      runtime.workerControl?.assertSpawnAllowed('fleet', { name, size })
      return toolResult(await requireFleetManager().start({ name, size, prompt, intervalMinutes, chatMode, staggerSeconds, maxSessionRuns }))
    } catch (error) { return errorResult(error) }
  })

  registerGatedTool('fleet_status', {
    title: 'Read one named ChatGPT worker fleet',
    description: 'Returns compact server-owned fleet state. Worker ids, browser client ids and browser tab ids are distinct from Harness durable session ids and MCP root-turn operation ids.',
    inputSchema: { name: z.string().min(1).max(64) },
    outputSchema: resultSchema(fleetSnapshotShape),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name }) => {
    try { return toolResult(await requireFleetManager().status(name)) } catch (error) { return errorResult(error) }
  })

  registerGatedTool('fleet_stop', {
    title: 'Stop one named ChatGPT worker fleet',
    description: 'Stops future scheduling for one fleet and safely closes verified idle fleet-owned tabs when possible. Busy or unverifiable tabs may remain open but receive no future fleet prompts. This does not cancel Harness root turns; harness_cancel does not stop fleets.',
    inputSchema: { name: z.string().min(1).max(64) },
    outputSchema: resultSchema(fleetSnapshotShape),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ name }) => {
    try { return toolResult(await requireFleetManager().stop(name)) } catch (error) { return errorResult(error) }
  })

  registerGatedTool('session_runtime_status', {
    title: 'Read durable session runtime',
    description: 'Read a workspace-scoped, secret-redacted durable runtime projection: ownership, lease/fence state, requested and verified model/effort, browser binding metadata, recovery, operation checkpoints and effect states. Raw operation data, completion text, effect arguments and receipts are excluded. Does not resume execution.',
    inputSchema: { session_id: z.string().min(1), workspace: z.string().min(1).optional() },
    outputSchema: resultSchema({ runtime: looseObject() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ session_id, workspace }) => {
    try { return toolResult({ runtime: await controller.runtimeStatus(session_id, harnessWorkspace(workspace)) }) } catch (error) { return errorResult(error) }
  })

  registerGatedTool('harness_start', {
    title: 'Start a full Shiro coding task',
    description: `Starts one Shiro task. It runs in the fixed project root ${config.workspaceRoot} unless workspace names another root opened with workspace_open. Up to ${config.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS} root turns may run concurrently. This ${requestClientKind} request defaults to ${requestDefaultExecutionMode}. In autonomous mode the selected ctx.llm provider streams directly into DeepSeek Harness, which owns every model→tool→model round locally; the MCP client only reads thread_events/status and handles approvals or user steering. In relay mode the calling ChatGPT conversation supplies model rounds through model_requests + harness_continue, so no secondary ChatGPT Web model tab is opened. Agent presets are the scoped-tool mechanism: hidden tools are omitted from the model schema and execution surface.`,
    inputSchema: {
      prompt: z.string().min(1).describe('The user task for Shiro.'),
      workspace: z.string().min(1).optional().describe('Workspace id from workspace_list to run the task in. Omit for the fixed project root. Sessions are namespaced per workspace, so session_id must belong to the same one.'),
      agent_preset: z.string().min(1).optional().describe('Optional Harness preset; omit to use the full standard coding-agent preset.'),
      session_id: z.string().min(1).optional().describe('Optional durable Harness session id returned by harness_sessions for this workspace. Omit to create a new session.'),
      speed_profile: z.enum(['fast', 'balanced', 'deep']).optional().describe('Optional Shiro operating profile. Omit for balanced; explicit values remain supported for clients that expose this field.'),
      reasoning_effort: z.enum(['light', 'standard', 'high', 'max']).optional().describe('Optional reasoning effort. Omit to use the selected profile default (balanced defaults to standard).'),
      execution_mode: z.enum(['autonomous', 'relay']).optional().describe(`Override this turn only. autonomous requires autonomousProvider/autonomousModel to be configured; omit to use this caller's ${requestDefaultExecutionMode} default.`),
    },
    outputSchema: resultSchema(outcomeShape),
    // The engine's tools can edit workspace files and reach the web
    // (web_fetch/search), and destructive steps still require harness_respond
    // approval -- so: writes yes, destructive no, open world yes.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ prompt, workspace, agent_preset: agentPreset, session_id: sessionId, speed_profile: speedProfile, reasoning_effort: reasoningEffort, execution_mode: executionMode }, extra) => {
    try {
      if (sessionId !== undefined && threads.isArchived(sessionId)) {
        throw Object.assign(new Error(`thread ${sessionId} is archived; restore it with thread_unarchive before resuming it`), { code: 'CONFLICT' })
      }
      return toolResult(await controller.start(
        prompt,
        agentPreset,
        sessionId,
        speedProfile,
        reasoningEffort,
        requestWaitOptions(extra, 'Starting Shiro task'),
        harnessWorkspace(workspace),
        executionMode ?? requestDefaultExecutionMode,
      ))
    } catch (error) { return errorResult(error) }
  })

  registerGatedTool('harness_sessions', {
    title: 'List resumable Shiro sessions',
    description: 'Lists durable sessions registered under one workspace: the fixed project root by default, or the workspace you name. Sessions are namespaced per workspace, so a session started in another one is not listed here and cannot be resumed from here. Pass one returned session id to harness_start with the same workspace to continue that exact Harness conversation.',
    inputSchema: {
      workspace: z.string().min(1).optional().describe('Workspace id from workspace_list. Omit for the fixed project root.'),
    },
    outputSchema: resultSchema({
      workspace: z.string(),
      workspace_root: z.string(),
      workspace_id: z.string(),
      workspace_title: z.string().optional(),
      sessions: z.array(looseObject()),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace }) => {
    try {
      const listed = await controller.sessions(harnessWorkspace(workspace))
      // Archived threads are hidden here and refused by harness_start; the
      // engine's own copy of each transcript is untouched.
      const visible = listed.sessions.filter(item => !threads.isArchived(item.sessionId))
      return toolResult({ ...listed, sessions: visible, archived_hidden: listed.sessions.length - visible.length })
    } catch (error) { return errorResult(error) }
  })

  registerGatedTool('harness_get_request', {
    title: 'Fetch the full body of one pending model request',
    description: 'Legacy relay compatibility only. Autonomous operations never expose model requests. For a relay-mode request_id from model_requests, fetch the exact system prompt, tools, and messages; page with messages_from when truncated, then answer with harness_continue.',
    inputSchema: {
      request_id: z.string().uuid(),
      workspace: z.string().min(1).optional().describe('Workspace the turn belongs to. Omit for the fixed project root. An id from another workspace fails with NOT_FOUND before the engine is touched.'),
      messages_from: z.number().int().min(0).optional().describe('Message index to continue from; defaults to 0. The system prompt and tool list are included only on the first page.'),
      max_bytes: z.number().int().min(10_000).max(REQUEST_PAGE_MAX_BYTES).optional(),
    },
    outputSchema: resultSchema({
      request_id: z.string(),
      operation_id: z.string().optional(),
      session_id: z.string().nullable().optional(),
      purpose: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      system: z.string().optional(),
      generation: looseObject().optional(),
      tools: z.array(looseObject()).optional(),
      messages: z.array(looseObject()),
      messages_total: z.number(),
      messages_from: z.number(),
      messages_returned: z.number(),
      truncated: z.boolean(),
      next_messages_from: z.number().optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ request_id: requestId, workspace, messages_from: messagesFrom = 0, max_bytes: maxBytes }) => {
    try {
      const request = controller.pendingRequest(requestId, harnessWorkspace(workspace))
      if (request === undefined) throw new Error(`model request ${requestId} is not pending`)
      const limit = maxBytes ?? REQUEST_PAGE_MAX_BYTES
      const total = Array.isArray(request.messages) ? request.messages.length : 0
      if (messagesFrom > total) throw new Error(`messages_from ${messagesFrom} is beyond the ${total} messages of this request`)
      const firstPage = messagesFrom === 0
      let used = firstPage ? JSON.stringify({ system: request.system, tools: request.tools }).length : 0
      const slice = []
      let next = messagesFrom
      while (next < total) {
        const size = JSON.stringify(request.messages[next]).length
        if (slice.length > 0 && used + size > limit) break
        used += size
        slice.push(request.messages[next])
        next += 1
        if (used > limit) break
      }
      const truncated = next < total
      const payload = {
        request_id: request.request_id,
        session_id: request.session_id,
        purpose: request.purpose,
        provider: request.provider,
        model: request.model,
        generation: request.generation,
        ...(firstPage ? { system: request.system, tools: request.tools } : {}),
        messages: slice,
        messages_total: total,
        messages_from: messagesFrom,
        messages_returned: slice.length,
        truncated,
        ...(truncated ? { next_messages_from: next } : {}),
      }
      return toolResult(payload)
    } catch (error) { return errorResult(error) }
  })

  registerGatedTool('harness_continue', {
    title: 'Return one legacy relay model decision to Shiro',
    description: 'Legacy relay compatibility only. Answers exactly one pending relay-mode model request. Autonomous operations keep this round-trip entirely inside Harness and never call this action. For relay requests, use only the request tool schema and return tool_call blocks so Harness executes them.',
    inputSchema: {
      request_id: z.string().uuid(),
      workspace: z.string().min(1).optional().describe('Workspace the turn belongs to. Omit for the fixed project root. An id from another workspace fails with NOT_FOUND before the engine is touched.'),
      blocks: z.array(modelBlockSchema).min(1),
      finish_reason: z.enum(['stop', 'tool-calls', 'max-tokens']).optional(),
      usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(),
      wait_ms: z.number().int().min(100).max(MAX_WAIT_MS).optional(),
    },
    outputSchema: resultSchema(outcomeShape),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ request_id: requestId, workspace, blocks, finish_reason: finishReasonValue, usage, wait_ms: waitMs }, extra) => {
    try {
      return toolResult(await controller.submit(
        requestId,
        {
          blocks,
          ...(finishReasonValue === undefined ? {} : { finishReason: finishReasonValue }),
          ...(usage === undefined ? {} : { usage }),
        },
        waitMs ?? config.waitMs,
        requestWaitOptions(extra, 'Waiting for Shiro'),
        harnessWorkspace(workspace),
      ))
    } catch (error) { return errorResult(error) }
  })

  registerGatedTool('harness_status', {
    title: 'Inspect active Shiro tasks',
    description: 'Returns one operation’s execution mode/model route, benchmark metrics, pending interaction or final completion. Autonomous turns keep model requests local and expose progress through thread_events; relay turns may also return model_requests. Pass operation_id or session_id to inspect one turn, or omit both for workspace aggregate status.',
    inputSchema: {
      operation_id: z.string().uuid().optional(),
      session_id: z.string().min(1).optional(),
      workspace: z.string().min(1).optional().describe('Workspace the turn belongs to. Omit for the fixed project root. An id from another workspace fails with NOT_FOUND before the engine is touched.'),
      wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
    },
    outputSchema: resultSchema(outcomeShape),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ operation_id: operationId, session_id: sessionId, workspace, wait_ms: waitMs }, extra) => {
    try {
      return toolResult(await controller.status(
        waitMs ?? 0,
        operationId,
        sessionId,
        requestWaitOptions(extra, 'Waiting for Shiro status'),
        harnessWorkspace(workspace),
      ))
    } catch (error) { return errorResult(error) }
  })

  registerGatedTool('harness_respond', {
    title: 'Answer a Harness question or approval request',
    description: 'Answers one pending Harness interaction returned with status user_input_required. Relay questions to the user. For approvals, allowed-once transmits consent to run the exact wider operation and must be used only after explicit user confirmation; use rejected otherwise.',
    inputSchema: {
      interaction_id: z.string().min(1),
      workspace: z.string().min(1).optional().describe('Workspace the turn belongs to. Omit for the fixed project root. An id from another workspace fails with NOT_FOUND before the engine is touched.'),
      approval_outcome: z.enum(['allowed-once', 'rejected']).optional(),
      answers: z.array(z.object({
        id: z.string().min(1),
        selected: z.array(z.string()),
        custom: z.string().optional(),
      })).optional(),
      wait_ms: z.number().int().min(100).max(MAX_WAIT_MS).optional(),
    },
    outputSchema: resultSchema(outcomeShape),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ interaction_id: interactionId, workspace, approval_outcome: approvalOutcome, answers, wait_ms: waitMs }, extra) => {
    try {
      return toolResult(await controller.respond(
        interactionId,
        approvalOutcome,
        answers,
        waitMs ?? config.waitMs,
        requestWaitOptions(extra, 'Waiting after Shiro interaction'),
        harnessWorkspace(workspace),
      ))
    } catch (error) { return errorResult(error) }
  })

  registerGatedTool('harness_get_artifact', {
    title: 'Fetch a produced file or image over MCP',
    description: `Returns one produced artifact in a client-friendly form. Pass path for a file under the fixed project root ${config.workspaceRoot} to receive a compact MCP resource_link that can be read on demand, or pass the attachment object copied verbatim from an image_attachment block to receive that ephemeral image inline. Limit ${MAX_ARTIFACT_BYTES} bytes.`,
    inputSchema: {
      path: z.string().min(1).optional().describe(`File under ${config.workspaceRoot}. Exactly one of path or attachment is required.`),
      workspace: z.string().min(1).optional().describe('Workspace id from workspace_list when the file lives in an opened workspace rather than the fixed project root. Ignored with attachment.'),
      attachment: z.record(z.string(), z.unknown()).optional().describe('The attachment object from an image_attachment block, verbatim.'),
      max_bytes: z.number().int().min(1).max(MAX_ARTIFACT_BYTES).optional(),
    },
    outputSchema: resultSchema({
      kind: z.string(),
      mime_type: z.string(),
      bytes: z.number(),
      path: z.string().optional(),
      name: z.string().optional(),
      resource_uri: z.string().optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path: requestedPath, workspace, attachment, max_bytes: maxBytes }) => {
    try {
      if ((requestedPath === undefined) === (attachment === undefined)) {
        throw new Error('pass exactly one of path or attachment')
      }
      const limit = maxBytes ?? MAX_ARTIFACT_BYTES
      const artifact = requestedPath !== undefined
        ? await readWorkspaceArtifact(artifactRoot(workspace), requestedPath, limit)
        : await controller.readAttachment(attachment, limit)
      const resourceUri = requestedPath === undefined ? undefined : artifactUri(artifact.path, workspace)
      const meta = {
        kind: artifact.kind,
        mime_type: artifact.mimeType,
        bytes: artifact.bytes,
        ...(artifact.path === undefined ? {} : { path: artifact.path }),
        ...(artifact.name === undefined ? {} : { name: artifact.name }),
        ...(resourceUri === undefined ? {} : { resource_uri: resourceUri }),
      }
      if (resourceUri !== undefined) {
        return {
          content: [
            {
              type: 'resource_link',
              uri: resourceUri,
              name: artifact.path,
              mimeType: artifact.mimeType,
              description: `Shiro workspace artifact (${artifact.bytes} bytes)`,
            },
            { type: 'text', text: JSON.stringify(meta) },
          ],
          structuredContent: meta,
        }
      }
      let content
      if (artifact.kind === 'image') {
        content = [
          { type: 'image', data: Buffer.from(artifact.data).toString('base64'), mimeType: artifact.mimeType },
          { type: 'text', text: JSON.stringify(meta) },
        ]
      } else if (artifact.kind === 'text') {
        content = [{ type: 'text', text: Buffer.from(artifact.data).toString('utf8') }]
      } else {
        content = [{
          type: 'resource',
          resource: {
            uri: `shiro://artifact/${artifact.path ?? artifact.name ?? 'blob'}`,
            blob: Buffer.from(artifact.data).toString('base64'),
            mimeType: artifact.mimeType,
          },
        }]
      }
      return { content, structuredContent: meta }
    } catch (error) { return errorResult(error) }
  })

  registerGatedTool('harness_cancel', {
    title: 'Request cancellation of one Shiro turn',
    description: 'Requests cancellation of an active or interrupted Harness turn; acceptance does not prove all side effects stopped. Repeated accepted requests are durable and idempotent. Operates in one workspace (the fixed project root unless workspace names another). Pass operation_id or session_id when multiple turns are active there. An id belonging to another workspace fails with NOT_FOUND and cancels nothing. It does not delete files, sessions, or workspaces, and it does not stop ChatGPT worker fleets; use fleet_stop for those.',
    inputSchema: {
      operation_id: z.string().uuid().optional(),
      session_id: z.string().min(1).optional(),
      workspace: z.string().min(1).optional().describe('Workspace the turn belongs to. Omit for the fixed project root. An id from another workspace fails with NOT_FOUND before the engine is touched.'),
    },
    outputSchema: resultSchema({
      cancelled: z.boolean(),
      status: z.string().optional(),
      operation_id: z.string().optional(),
      session_id: z.string().optional(),
      root_session_id: z.string().optional(),
      workspace: z.string().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ operation_id: operationId, session_id: sessionId, workspace }) => {
    try { return toolResult(await controller.cancel(operationId, sessionId, harnessWorkspace(workspace))) } catch (error) { return errorResult(error) }
  })

  // Direct actions: deterministic filesystem, exec, process, git, task, fleet,
  // browser, artifact and config operations that never invoke an LLM. The
  // sandbox, the process registry and the metrics counters are per-bridge, not
  // per-request: a new McpServer is built for every HTTP request, so anything
  // holding state has to be handed in through `runtime`.
  const sandbox = runtime.sandbox ?? workspaces.primary().sandbox
  const directRegistry = registerDirectActions(server, {
    // The engine's sandbox seam, when the host provides one.
    sandboxProvider: typeof runtime.sandboxProvider === 'function' ? runtime.sandboxProvider() : (runtime.sandboxProvider ?? null),
    continuation: runtime.continuation ?? null,
    subagents: runtime.subagents ?? undefined,
    config: {
      ...config,
      executionMode: requestDefaultExecutionMode,
      configuredExecutionMode: config.executionMode ?? 'relay',
      requestClientKind,
    },
    controller,
    fleetManager,
    sandbox,
    workspaces,
    threads,
    policy,
    processes: runtime.processes ?? new ProcessRegistry({ sandbox }),
    terminals: runtime.terminals ?? new TerminalRegistry(),
    workerControl: runtime.workerControl,
    metrics: runtime.metrics ?? new ActionMetrics(),
    bridgeVersion: BRIDGE_VERSION,
    directActionsVersion: DIRECT_ACTIONS_VERSION,
    maxWaitMs: MAX_WAIT_MS,
    maxArtifactBytes: MAX_ARTIFACT_BYTES,
    harnessActions: HARNESS_ACTION_DESCRIPTORS,
    artifactUri,
    logStreams: LOG_STREAMS,
    readLog: args => readServiceLog(config.logDir ?? resolve(config.workspaceRoot, '..', '.ShiroRuntime', 'logs'), args),
    redact: value => redactSecrets(value),
    validateConfig: candidate => normalizeConfig(candidate),
    omnicastReturns: runtime.omnicastReturns,
  })

  // Mirror the engine's plugin tools LAST, so `taken` is the complete set of
  // bridge action names and a plugin can never shadow one. The rows are pushed
  // into the same registry bridge_capabilities reads, which is why a mirrored
  // tool is discoverable and gated exactly like a native action.
  // Resolved per MCP request, not once at boot: a fresh McpServer is built for
  // every request, so a lazily-read registry naturally picks up tool plugins
  // that mounted after the bridge did. Reading it once at startup silently
  // froze the mirror at whatever existed in that instant.
  const engineTools = typeof runtime.engineTools === 'function' ? runtime.engineTools() : (runtime.engineTools ?? null)
  if (engineTools !== null) {
    registerEngineTools(server, {
      tools: engineTools,
      descriptors: directRegistry,
      policy,
      metrics: runtime.metrics,
      taken: new Set([...directRegistry.map(row => row.name), ...HARNESS_ACTION_DESCRIPTORS.map(row => row.name)]),
    })
  }
}

async function handleMcpRequest(req, res, controller, config, fleetManager, runtime) {
  const authorization = req.headers.authorization ?? ''
  if (!safeEqual(authorization, `Bearer ${config.token}`)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  const requestContext = mcpRequestExecutionContext(req.headers, config.executionMode ?? 'relay')
  const requestControlAuthorized = mcpRequestHasControlCredential(
    req.headers,
    config.omnicastControlToken,
  )
  const server = new McpServer(
    { name: 'shiro-harness-bridge', title: 'Shiro', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: `This ${requestContext.clientKind} connection defaults to ${requestContext.defaultExecutionMode}. Send one large task with harness_start. In relay mode, fetch each model_request with harness_get_request and return the current ChatGPT conversation's decision with harness_continue; this keeps the loop in the connector and does not open a secondary ChatGPT Web model tab. When execution_mode is autonomous, DeepSeek Harness owns the complete streamed model↔tool loop locally: read thread_events with its cursor for progress/tool/diff events, use turn_steer for user steering, and answer only user_input_required interactions with harness_respond. Poll harness_status for terminal state and benchmark metrics. Agent presets scope the model tool surface, and hidden tools are omitted from schemas. Continue until terminal state or a real user interaction is required.`,
    },
  )
  configureMcp(server, controller, config, fleetManager, {
    ...runtime,
    requestDefaultExecutionMode: requestContext.defaultExecutionMode,
    requestClientKind: requestContext.clientKind,
    requestControlAuthorized,
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}

/**
 * The engine's sandbox seam, or null when the host mounts none.
 *
 * Read through `ctx.reflect.get`, not `ctx.sandbox`, for the same reason as the
 * tool registry: cordis enforces declared injection and THROWS for anything a
 * plugin did not list, so the direct read failed, the catch reported null, and
 * confinement silently became a no-op -- every command ran unconfined while
 * reporting `enforcement: "none"` as if that were the operator's choice.
 * Injecting it instead would make the service required and leave the whole
 * bridge unmounted on a host without one.
 */
function sandboxProviderOf(ctx) {
  const usable = provider => (provider !== null && provider !== undefined && typeof provider.confine === 'function' ? provider : null)
  try {
    const reflected = ctx?.reflect?.get?.('sandbox', false)
    if (usable(reflected) !== null) return reflected
  } catch { /* fall through to the direct read */ }
  try {
    return usable(ctx?.sandbox ?? null)
  } catch {
    return null
  }
}

function startHttpServer(ctx, broker, config, fleetManager) {
  const controller = new BridgeController(ctx, broker, config)
  // Bridge-lifetime state for the direct actions. A fresh McpServer is built
  // per HTTP request, so the process registry, the path sandbox and the metric
  // counters must outlive any single request.
  const workspaces = new WorkspaceRegistry({
    projectRoot: config.workspaceRoot,
    allowedRoots: config.workspaceAllowlist ?? [],
  })
  controller.workspaceRegistry = workspaces
  const sandbox = workspaces.primary().sandbox
  const processes = new ProcessRegistry({ sandbox })
  const omnicastReturns = config.omnicastControlToken === '' ? null : new OmnicastReturnMailbox({
    controlToken: config.omnicastControlToken,
    stateFile: config.omnicastReturnStateFile,
    openProof: async ({ clientId }) => {
      if (fleetManager === null) return false
      let clients
      try { clients = await fleetManager.transport.clients() } catch { return false }
      const client = clients.find(item => item?.id === clientId)
      const generation = client?.tabObservation?.generation?.state
      return client !== undefined
        && client.ready === true
        && client.quarantined !== true
        && !client.activeRequest
        && [undefined, null, 'idle', 'stopped'].includes(generation)
    },
    idleProof: async (lease, reservation) => {
      if (fleetManager === null) return false
      let clients
      try { clients = await fleetManager.transport.clients() } catch { return false }
      const client = clients.find(item => item?.id === lease.clientId)
      return omnicastLeaseIsIdle({ lease, client, reservation })
    },
  })
  const runtime = {
    workspaces,
    policy: new PermissionPolicy({ profile: config.permissionProfile, rules: config.permissionRules }),
    threads: new ThreadRegistry({
      stateFile: resolve(config.fleetStateDir ?? resolve(config.workspaceRoot, '..', '.ShiroRuntime', 'state'), '..', 'threads.json'),
    }),
    sandbox,
    // The engine mounts dsh-sandbox-local, so inside the engine this is a real
    // bwrap/landlock backend. Read defensively rather than through `inject`:
    // cordis's array form makes a service REQUIRED and would keep the whole
    // bridge unmounted on a host without one. Absent, Confinement refuses
    // narrowed modes instead of pretending to enforce them.
    sandboxProvider: () => sandboxProviderOf(ctx),
    // The engine's own tool registry, as a RESOLVER rather than a value:
    // configureMcp calls it per request, so plugins mounted after the bridge
    // still get mirrored. Mirroring it is what gives ChatGPT the DSH plugin
    // library directly, instead of only inside an agent turn.
    engineTools: () => engineToolsOf(ctx),
    // Bridge-lifetime: the designation and the nudge budget must survive across
    // MCP requests, which each build a fresh server.
    continuation: fleetManager === null ? null : new ContinuationWatchdog({
      submit: (target, text) => fleetManager.transport.submit(target.browser_client_id, text),
      pending: () => broker.waiting(),
    }).start(),
    processes,
    subagents: new SubagentRegistry({ processes }),
    terminals: new TerminalRegistry(),
    metrics: new ActionMetrics(),
    omnicastReturns,
  }
  const workerControl = new ShiroWorkerControl({ fleetManager, processes, terminals: runtime.terminals })
  runtime.workerControl = workerControl
  ctx.provide('shiroWorkers', workerControl)
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        provider: config.provider,
        model: config.model,
        execution: {
          defaultMode: config.executionMode,
          autonomousConfigured: config.autonomousProvider !== '',
          autonomousProvider: config.autonomousProvider,
          autonomousModel: config.autonomousModel,
          relayProvider: config.provider,
          relayModel: config.model,
          webProvider: config.webProvider,
          webModel: config.webModel,
          webPickerModel: config.webRelayModel,
        },
        workspaceRoot: config.workspaceRoot,
        concurrency: {
          active: controller.activeOperations().length,
          maximum: config.maxConcurrentTurns,
        },
        browserRelay: {
          configured: config.relayUrl !== '',
          url: config.relayUrl,
          pickerModel: config.webRelayModel,
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
    void handleMcpRequest(req, res, controller, config, fleetManager, runtime).catch(error => {
      process.stderr.write(`shiro-bridge: MCP request failed: ${asError(error).message}\n`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }))
        return
      }
      res.end()
    })
  })
  http.listen(config.port, '127.0.0.1')
  http.on('listening', () => {
    process.stderr.write(`shiro-bridge: http://127.0.0.1:${config.port}/mcp (workspace ${config.workspaceRoot})\n`)
  })
  return { http, controller, fleetManager, runtime, workerControl }
}

export const name = 'llm-shiro-harness-bridge'
export const inject = ['llm', 'apiProxy']

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const broker = new BridgeBroker()
  const fleetManager = config.relayUrl === '' ? null : new FleetManager({
    transport: new BrowserFleetTransport({ url: config.relayUrl, token: config.relayToken }),
    stateDir: config.fleetStateDir,
  })
  if (fleetManager !== null) {
    void fleetManager.ready.catch(error => process.stderr.write(`shiro-fleet: restore failed: ${asError(error).message}\n`))
  }
  const relay = config.relayUrl === '' ? null : new ChatGptBrowserRelay({
    url: config.relayUrl,
    token: config.relayToken,
    model: config.relayModel,
    isReservedClient: client => fleetManager?.isReservedClient(client) ?? false,
  })
  const webRelay = config.relayUrl === '' ? null : new ChatGptBrowserRelay({
    url: config.relayUrl,
    token: config.relayToken,
    model: config.webRelayModel,
    // Astra must be observed in the Web picker before a reply can enter the
    // Harness transcript. Accounts without the rollout fail closed here.
    requireSelectionVerification: true,
    isReservedClient: client => fleetManager?.isReservedClient(client) ?? false,
  })
  // 'attachments' is deliberately not a hard `inject` dependency (unlike
  // 'llm'/'apiProxy' above): it is an optional durable-image service that
  // may not be mounted in every Shiro composition, and a hard inject would
  // block this plugin from loading at all until one is. `ctx.get()` reads it
  // only at call time, mirroring how engine/packages/llm/llm-deepseek/src
  // /adapter.ts resolves it (`resolveAttachments: () => ctx.get('attachments')`).
  const adapter = new ChatGptSolAdapter(broker, config.provider, config.model, relay, () => ctx.get('attachments'))
  ctx.llm.registerAdapter([config.provider], adapter)
  // Dedicated autonomous ChatGPT Web route. Unlike the legacy provider above,
  // this route always drives the browser relay even when the current root turn
  // itself came from MCP/Web, so Harness remains the loop owner and the broker
  // never asks the caller to act as the model between local tool rounds.
  const webAdapter = new ChatGptSolAdapter(
    broker,
    config.webProvider,
    config.webModel,
    webRelay,
    () => ctx.get('attachments'),
    { browserRelayRequired: true },
  )
  ctx.llm.registerAdapter([config.webProvider], webAdapter)
  const codexCliPath = resolveCodexCliPath(config.codexCliPath)
  if (codexCliPath !== null) {
    const codexRunner = new CodexCliRunner({ cliPath: codexCliPath })
    ctx.llm.registerAdapter([config.codexProvider], new CodexCliAdapter(codexRunner, config.codexProvider, config.codexModels))
  } else if (config.codexCliPath !== '') {
    process.stderr.write(`shiro-codex: configured Codex CLI not found at ${config.codexCliPath}; route disabled\n`)
  }
  const grokCliPath = resolveGrokCliPath(config.grokCliPath)
  if (grokCliPath !== null) {
    const grokRunner = new GrokCliRunner({ cliPath: grokCliPath })
    ctx.llm.registerAdapter([config.grokProvider], new GrokBuildAdapter(grokRunner, config.grokProvider, config.grokModels))
  } else if (config.grokCliPath !== '') {
    process.stderr.write(`shiro-grok: configured Grok CLI not found at ${config.grokCliPath}; route disabled\n`)
  }
  ctx.effect(() => {
    const serving = startHttpServer(ctx, broker, config, fleetManager)
    const bindSession = (sessionId, binding, verification) => serving.controller.bindBrowser(sessionId, binding, verification)
    if (relay) relay.bindSession = bindSession
    if (webRelay) webRelay.bindSession = bindSession
    return async () => {
      // Kill every bridge-owned background process before anything else: a
      // dev server started through process_start or an interactive terminal
      // must not outlive the bridge.
      await serving.runtime.terminals.disposeAll()
      await serving.runtime.processes.disposeAll()
      await serving.fleetManager?.dispose()
      await serving.controller.dispose()
      await new Promise(resolveClose => { serving.http.close(() => resolveClose()) })
    }
  }, 'shiro-harness-bridge.serve')
}
