/**
 * `ExaSearchProvider`: a `WebSearchProvider` backed by the Exa search API (`POST /search` with
 * highlight contents). It maps the first non-blank highlight to `snippet`, maps
 * `publishedDate` to `publishedAt`, drops entries without a snippet, and omits `content`
 * because Exa returns no generated answer.
 * @module @deepseek-ai/dsh-web-search-exa/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ExaError, ExaResult, ExaSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const EXA_PROVIDER_ID = 'exa'

/** Default Exa search endpoint; `/search` is the operation. */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'

/** Hosted Exa MCP endpoint used when no API key is configured. */
export const EXA_DEFAULT_MCP_URL = 'https://mcp.exa.ai/mcp'

/** Default retrieval mode: let Exa pick between keyword and neural search. */
export const EXA_DEFAULT_SEARCH_TYPE = 'auto'

/** Default number of highlight sentences requested per result. */
export const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Attribution header for anonymous hosted-MCP requests. */
const MCP_SOURCE = 'shiro'

/** Exa's hosted MCP tool for ordinary web search. */
const MCP_TOOL = 'web_search_exa'

/** Keep model-facing snippets bounded even when MCP returns full page text. */
const MAX_MCP_SNIPPET_CHARS = 500

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface ExaSearchProviderOptions {
  /** Exa API key. Empty selects the anonymous hosted-MCP path. */
  apiKey: string
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Anonymous hosted-MCP endpoint used when `apiKey` is empty. */
  mcpURL?: string
  /** Retrieval mode sent as Exa's `type`. */
  searchType: 'auto' | 'keyword' | 'neural'
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
  /** Highlight sentences requested per result (Exa's `highlightsPerUrl`). */
  highlightsPerResult: number
}

/**
 * Map one Exa result to a normalized source, or `undefined` when it carries no
 * portable snippet (an entry with no highlight is dropped — the seam has no
 * other field to derive a snippet from, and inventing one would lie).
 *
 * @param result - one entry of Exa's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank highlight.
 */
export function mapExaResult(result: ExaResult): WebSearchSource | undefined {
  const snippet = result.highlights?.find(highlight => highlight.trim().length > 0)
  if (snippet === undefined) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
    ...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * Map an Exa response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; snippet-less entries are dropped
 *   ({@link mapExaResult}).
 */
export function mapExaResponse(response: ExaSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapExaResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // Exa returns no generated answer, so `content` is omitted. The web service owns the
  // final `maxResults` truncation, so this provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The Exa-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class ExaSearchProvider implements WebSearchProvider {
  readonly id = EXA_PROVIDER_ID

  constructor(private readonly options: ExaSearchProviderOptions) {}

  available(): boolean {
    const endpointAvailable = this.options.apiKey.length > 0
      ? isValidBaseUrl(this.options.baseURL)
      : isValidBaseUrl(this.options.mcpURL ?? EXA_DEFAULT_MCP_URL)
    return endpointAvailable
      && isPositiveInteger(this.options.highlightsPerResult)
      && (this.options.numResults === undefined || isPositiveInteger(this.options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (this.options.apiKey.length === 0) return await this.searchAnonymous(request, signal)

    // A per-request bound wins over the configured default; either may be absent.
    const numResults = request.maxResults ?? this.options.numResults
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          type: this.options.searchType,
          contents: { highlights: { highlightsPerUrl: this.options.highlightsPerResult } },
          ...numResults !== undefined ? { numResults } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Exa search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Exa API error (HTTP ${status})`
      try {
        const parsed = await response.json() as ExaError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as ExaSearchResponse
      return mapExaResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Exa returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /** Search through Exa's credential-free hosted MCP endpoint. */
  private async searchAnonymous(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const numResults = request.maxResults ?? this.options.numResults
    let response: Response
    try {
      response = await fetch(this.options.mcpURL ?? EXA_DEFAULT_MCP_URL, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          'x-exa-source': MCP_SOURCE,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `shiro-${crypto.randomUUID()}`,
          method: 'tools/call',
          params: {
            name: MCP_TOOL,
            arguments: {
              query: request.query,
              ...numResults !== undefined ? { numResults } : {},
            },
          },
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa anonymous search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Exa anonymous search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const detail = response.status === 429
        ? 'Exa anonymous search rate limit reached; configure EXA_API_KEY for higher limits'
        : `Exa anonymous MCP error (HTTP ${response.status})`
      throw new WebError(detail, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = parseMcpPayload(await response.text())
      if (payload === undefined) throw new Error('response was neither JSON nor MCP event-stream data')
      if (payload.error !== undefined) {
        throw new Error(String(payload.error.message ?? JSON.stringify(payload.error)))
      }
      const content = payload.result?.content
      if (payload.result?.isError === true || !Array.isArray(content)) {
        const detail = Array.isArray(content)
          ? content.map(item => typeof item.text === 'string' ? item.text : '').filter(Boolean).join('\n')
          : 'missing result content'
        throw new Error(detail || 'MCP tool returned an error')
      }
      const text = content
        .map(item => typeof item.text === 'string' ? item.text : '')
        .filter(Boolean)
        .join('\n\n')
      return { sources: parseMcpSources(text), truncated: false }
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa anonymous search aborted', 'WEB_ABORTED', { cause: error })
      if (error instanceof WebError) throw error
      throw new WebError(`Exa anonymous MCP returned an unprocessable response: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

interface McpPayload {
  error?: { message?: unknown }
  result?: {
    isError?: boolean
    content?: Array<{ text?: unknown }>
  }
}

/** Parse either a plain JSON MCP response or the first event-stream data frame. */
function parseMcpPayload(text: string): McpPayload | undefined {
  const frames = text.split(/\r?\n\r?\n/)
  for (const frame of frames) {
    const data = frame.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (data.length === 0) continue
    try { return JSON.parse(data) as McpPayload } catch {}
  }
  try { return JSON.parse(text) as McpPayload } catch { return undefined }
}

/** Normalize Exa's text sections into the provider-neutral source shape. */
function parseMcpSources(text: string): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const sections = text.replace(/\r/g, '')
    .split(/\n\s*---\s*\n(?=Title:\s*)|\n{2,}(?=Title:\s*)/)
    .map(section => section.trim())
    .filter(section => section.startsWith('Title:'))
  for (const section of sections) {
    const title = section.match(/^Title:\s*(.*)$/m)?.[1]?.trim()
    const url = section.match(/^URL:\s*(.*)$/m)?.[1]?.trim()
    const published = section.match(/^Published(?: Date)?:\s*(.*)$/m)?.[1]?.trim()
    const highlights = section.match(/^Highlights:\s*\n([\s\S]*)$/m)?.[1]?.trim()
    if (!url || !highlights) continue
    sources.push({
      url,
      ...title ? { title } : {},
      snippet: highlights.slice(0, MAX_MCP_SNIPPET_CHARS),
      ...published && published !== 'N/A' ? { publishedAt: published } : {},
    })
  }
  return sources
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a request limit that can be sent to Exa (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
