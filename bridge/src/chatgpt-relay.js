import { randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

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
  return null
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

function relayPrompt(request) {
  return [
    'You are the language-model component inside Shiro, a DeepSeek Harness agent.',
    'The Harness owns every tool, plugin, permission, subagent, workflow, terminal, filesystem and Git operation.',
    'Never claim to execute a tool yourself. When a tool is needed, request it and let Harness execute it.',
    'Return exactly one JSON object with no Markdown fence or surrounding prose.',
    'Schema: {"blocks":[{"type":"text","text":"..."}|{"type":"reasoning","text":"visible concise reasoning summary"}|{"type":"tool_call","id":"unique-id","name":"exact available tool name","arguments":{}}],"finishReason":"stop"|"tool-calls"|"max-tokens"}.',
    'Use only tool names and argument shapes present in the exact Harness request below.',
    'If tools are required, prefer tool_call blocks and set finishReason to tool-calls. Do not fabricate tool results.',
    'The request contains the complete current context, including prior Harness tool results.',
    '',
    'EXACT_HARNESS_REQUEST_JSON',
    JSON.stringify(request),
  ].join('\n')
}

export class ChatGptBrowserRelay {
  constructor({ url, token, model = 'GPT-5.6 Sol', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
    this.url = normalizeLoopbackUrl(url)
    this.token = asRequiredString(token, 'relayToken')
    this.model = asRequiredString(model, 'relayModel')
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
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

  async complete(request, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await this.fetch(`${this.url}/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: relayPrompt(request),
        model: this.model,
        effort: effortForRelay(request.generation?.reasoning_effort),
        newSession: true,
        autoOpenTab: true,
      }),
      signal: combined,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`ChatGPT browser relay HTTP ${response.status}: ${body.detail ?? body.error ?? 'request failed'}`)
    const rawText = String(body.response ?? body.answer ?? '')
    if (rawText.trim() === '') throw new Error('ChatGPT browser relay returned an empty response')
    const payload = extractJson(rawText)
    const allowedTools = new Set((request.tools ?? []).map(tool => tool?.name).filter(name => typeof name === 'string'))
    const blocks = normalizeBlocks(payload, rawText, allowedTools)
    if (blocks.length === 0) throw new Error('ChatGPT browser relay returned no usable blocks')
    const inferred = blocks.some(block => block.type === 'tool_call') ? 'tool-calls' : 'stop'
    return {
      blocks,
      finishReason: ['stop', 'tool-calls', 'max-tokens'].includes(payload?.finishReason) ? payload.finishReason : inferred,
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}
