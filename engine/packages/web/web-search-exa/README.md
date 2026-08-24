# @deepseek-ai/dsh-web-search-exa

English | [中文](README.zh.md)

An [Exa](https://exa.ai)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). With an API key it calls Exa's `POST /search` endpoint; without one it uses Exa's credential-free hosted MCP endpoint. Both paths map results into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$EXA_API_KEY` | Optional Exa API key. Empty/absent selects anonymous hosted MCP. |
| `baseURL` | `https://api.exa.ai` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable. |
| `mcpURL` | `https://mcp.exa.ai/mcp` | Hosted MCP endpoint used when no API key is configured. |
| `searchType` | `auto` | Retrieval mode sent as Exa's `type`: `auto` (Exa decides), `keyword`, or `neural`. |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`. Unset sends no default. Must be a positive integer. |
| `highlightsPerResult` | `1` | Highlight sentences requested per result (Exa's `highlightsPerUrl`). Must be a positive integer. |

```yaml
- id: web-search-exa
  name: '@deepseek-ai/dsh-web-search-exa'
  config:
    mcpURL: https://mcp.exa.ai/mcp
```

## Mapping

The keyed REST path maps Exa's flat `results[]`; the anonymous path maps `Title`/`URL`/`Published`/`Highlights` sections returned by hosted MCP. Both produce `WebSearchSource` values and omit generated `content`. A request's `maxResults` wins over the configured `numResults` default and is sent to Exa; the final bound is enforced by the seam. Provider failures surface as `WebError` `WEB_PROVIDER_ERROR`, and an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, first highlights, and publication dates or its exact `Exa search aborted`, `Exa search request failed: <error>`, and `Exa returned an unprocessable response body: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **A result with no non-blank highlight is dropped entirely** — no portable snippet to map, so fewer sources than the requested count can return.
- **Anonymous hosted MCP is rate-limited** — set `EXA_API_KEY` to switch automatically to keyed REST when higher limits are needed.
- **Only `searchType`/`numResults`/`highlightsPerResult` are exposed** — Exa's other controls (livecrawl, category, domain/date filters, full-text contents) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
