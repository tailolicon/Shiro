import { randomUUID } from 'node:crypto'
import { ActionError } from './action-errors.js'
import { jsonSchemaToZodShape } from './json-schema-zod.js'
import { errorResult } from './mcp-result.js'

// The DSH plugin library, exposed to the connector as first-class MCP tools.
//
// WHY THIS EXISTS
// ChatGPT Web has no equivalent of Codex's skills. What it does have, once it is
// talking to Shiro, is an engine with plugins already mounted. Until now that
// surface was reachable only from INSIDE an agent turn: the model could use it
// while Shiro drove the loop, but ChatGPT itself could not.
//
// SCOPE, measured against a running engine rather than assumed: the engine
// registers tools in LAYERS. `schemas()` with no scope returns the GLOBAL
// layer, which is what deployment-level plugins register into -- that is what
// gets mirrored. An agent's own tools (fs, bash, LSP, todo/plan, subagent) live
// in per-preset scope layers and are deliberately not visible here: they exist
// to run inside an agent loop with a live session, and harness_start remains
// the way to reach them.
//
// So the bridge mirrors it. `ctx.tools.schemas()` is the engine's own registry,
// so the mirrored set is whatever the deployment actually mounts, and it grows
// on its own when an operator adds a plugin -- nothing here enumerates tools by
// hand, and nothing needs editing when the engine gains one.
//
// WHAT THIS IS NOT
// It is not a second implementation of anything. Every call lands in the same
// `ctx.tools.execute` the agent loop uses, under the same guards, hooks and
// policies. The bridge contributes a name, a schema conversion, and honest
// reporting of what came back.

/** Tool names the bridge already owns; a mirrored collision is prefixed instead of overwriting. */
export const MIRROR_PREFIX = 'dsh_'

/** Tools whose whole purpose is the agent loop, so an agentless call is meaningless. */
const LOOP_ONLY = new Set([
  // `run_code` is the code-mode transport: it dispatches OTHER tools and only
  // exists when the deployment collapses its surface into one call.
  'run_code',
])

/**
 * The engine's tool registry, or null when the host provides none.
 *
 * `ctx.tools` is NOT how to read it: cordis enforces declared injection and
 * throws `cannot get property "tools" without inject` for anything a plugin
 * did not list. Catching that throw is what made the mirror silently register
 * zero tools -- it looked like "no engine here" when the engine was right
 * there. `ctx.reflect.get(name, strict)` is cordis's own documented way to
 * read a service without the inject requirement, returning undefined rather
 * than throwing when it is genuinely absent.
 *
 * Injecting `tools` instead would be worse: cordis's array form makes an
 * injected service REQUIRED, so the whole bridge would stay unmounted on a
 * host that has no tool registry.
 */
export function engineToolsOf(ctx) {
  const usable = tools => (tools !== null && tools !== undefined
    && typeof tools.schemas === 'function'
    && typeof tools.execute === 'function'
    ? tools
    : null)
  try {
    // strict=false: accept an implementation whose providing fiber is not
    // active yet, which is the normal state while plugins are still mounting.
    const reflected = ctx?.reflect?.get?.('tools', false)
    if (usable(reflected) !== null) return reflected
  } catch { /* fall through to the direct read below */ }
  try {
    return usable(ctx?.tools ?? null)
  } catch {
    return null
  }
}

/**
 * The engine's tools, as rows the connector can register.
 * @param taken names already registered by the bridge, so a mirror never shadows one.
 */
export function engineToolCatalog(tools, { taken = new Set() } = {}) {
  if (tools === null) return []
  let schemas
  try {
    schemas = tools.schemas()
  } catch {
    return []
  }
  if (!Array.isArray(schemas)) return []
  const rows = []
  const used = new Set(taken)
  for (const schema of schemas) {
    const engineName = String(schema?.name ?? '').trim()
    if (engineName === '' || LOOP_ONLY.has(engineName)) continue
    // A mirrored tool keeps its own name so it reads the way the plugin's own
    // documentation does; only a genuine collision with a bridge action is
    // renamed, and deterministically, because the client caches tool lists.
    let name = engineName
    if (used.has(name)) name = `${MIRROR_PREFIX}${engineName}`
    if (used.has(name)) continue
    used.add(name)
    rows.push({
      name,
      engine_name: engineName,
      description: String(schema?.description ?? '').trim(),
      parameters: schema?.parameters ?? { type: 'object', properties: {} },
      renamed: name !== engineName,
    })
  }
  return rows
}

/** ContentBlock[] from the engine -> MCP content, dropping shapes MCP cannot carry. */
function toMcpContent(blocks) {
  if (!Array.isArray(blocks)) return []
  const content = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image' && typeof block.data === 'string') {
      content.push({ type: 'image', data: block.data, mimeType: String(block.mimeType ?? block.mime_type ?? 'image/png') })
      continue
    }
    // Anything else is preserved as text rather than silently dropped: a block
    // the connector cannot render is still information the caller asked for.
    content.push({ type: 'text', text: JSON.stringify(block) })
  }
  return content
}

/**
 * Register every engine tool as its own MCP tool.
 *
 * @param descriptorSink receives one registry row per mirrored tool, so
 *   bridge_capabilities and the permission gate see them like any other action.
 */
export function registerEngineTools(server, {
  tools,
  descriptors = [],
  policy = null,
  metrics = null,
  taken = new Set(),
  limit = 200,
} = {}) {
  const catalog = engineToolCatalog(tools, { taken })
  const registered = []
  for (const row of catalog.slice(0, limit)) {
    // Mirrored tools are declared as writes that reach outward. The bridge
    // cannot see what an arbitrary plugin does, and guessing "read-only" for
    // something that might write or fetch is the wrong way to be wrong.
    const descriptor = {
      name: row.name,
      title: row.name,
      family: 'plugin',
      read_only: false,
      destructive: false,
      requires_confirmation: false,
      workspace_scoped: false,
    }
    descriptors.push(descriptor)

    let inputSchema
    try {
      inputSchema = jsonSchemaToZodShape(row.parameters)
    } catch {
      inputSchema = {}
    }

    try {
      server.registerTool(row.name, {
        title: row.name,
        description: `${row.description}\n\n[DSH plugin tool${row.renamed ? `, registered as ${row.name} because ${row.engine_name} is already a Shiro action` : ''}. Runs in the engine, outside any agent turn.]`.trim(),
        inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      }, async (args, extra) => {
        const started = Date.now()
        try {
          policy?.assertAction(descriptor)
          const result = await tools.execute({
            callId: randomUUID(),
            name: row.engine_name,
            arguments: args ?? {},
            signal: extra?.signal ?? new AbortController().signal,
          })
          metrics?.record(row.name, Date.now() - started, result?.isError !== true)
          if (result?.isError === true) {
            const failure = result.error ?? {}
            return {
              isError: true,
              content: toMcpContent(result.content),
              structuredContent: { error: { code: String(failure.code ?? 'PROCESS_FAILED'), message: String(failure.message ?? 'the plugin tool failed'), retryable: false } },
            }
          }
          const content = toMcpContent(result?.content)
          return {
            content: content.length > 0 ? content : [{ type: 'text', text: JSON.stringify(result?.value ?? null) }],
            structuredContent: { value: result?.value ?? null },
          }
        } catch (error) {
          metrics?.record(row.name, Date.now() - started, false, typeof error?.code === 'string' ? error.code : 'INTERNAL')
          return errorResult(error instanceof ActionError ? error : new ActionError('PROCESS_FAILED', `${row.engine_name} failed: ${error?.message ?? error}`))
        }
      })
      registered.push(row)
    } catch {
      // One unregisterable tool (a name MCP rejects, a schema that will not
      // convert) must not take the whole mirror down with it.
      descriptors.pop()
    }
  }
  return { registered, available: catalog.length, truncated: catalog.length > registered.length }
}
