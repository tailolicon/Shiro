// `shiro` — scripting the deterministic half of the connector from a terminal.
//
// WHAT THIS IS NOT
// It is not `codex exec`. Shiro's model is ChatGPT, reached through MCP: the
// client acts as the model, answering harness_get_request with harness_continue.
// A CLI cannot drive an agent turn without being that model, so pretending to
// offer `shiro exec "<prompt>"` would produce a command that starts a turn and
// then hangs waiting for someone else to answer it.
//
// WHAT IT IS
// Every DIRECT action -- the deterministic ones, which is most of the surface --
// callable from a shell and from CI, with typed JSON in and out. `shiro call
// git_status --json`, `shiro call worktree_create --branch task-1`, `shiro call
// thread_events --session_id ... --from_seq 42`. Plus discovery, so a script can
// find the action and its schema without reading the docs.

export const USAGE = `shiro — call Shiro connector actions from a shell

  shiro actions [--family <name>] [--json]      list the actions this bridge exposes
  shiro schema <action> [--json]                 the input and output schema of one action
  shiro call <action> [--key value ...] [--json] invoke one action
  shiro status [--json]                          bridge health, the same as bridge_status

Arguments to \`call\` mirror the action's schema:
  --path src/index.js        string
  --limit 20                 number (numeric strings are coerced)
  --confirm                  boolean true
  --no-confirm               boolean false
  --paths a.txt --paths b.txt repeated keys become an array
  --json-args '{"a":1}'      raw JSON, merged last, for anything the flags cannot express

Exit codes: 0 success, 1 action error, 2 usage error, 3 transport error.

The endpoint comes from SHIRO_BRIDGE_URL (default http://127.0.0.1:23157/mcp) and the
token from SHIRO_BRIDGE_TOKEN or SHIRO_BRIDGE_TOKEN_FILE.`

export const EXIT = Object.freeze({ ok: 0, actionError: 1, usage: 2, transport: 3 })

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.exitCode = EXIT.usage
  }
}

/**
 * Parse `--key value`, `--flag`, `--no-flag`, and repeats into an argument
 * object. Values are coerced only when unambiguous: a numeric string becomes a
 * number, `true`/`false` become booleans, and anything else stays a string, so
 * a version like `--base 1.2.3` is not silently mangled.
 */
export function parseArguments(tokens) {
  const args = {}
  let index = 0
  const assign = (key, value) => {
    if (Object.hasOwn(args, key)) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value]
      return
    }
    args[key] = value
  }
  while (index < tokens.length) {
    const token = String(tokens[index])
    if (!token.startsWith('--')) throw new UsageError(`expected --key, got "${token}"`)
    const body = token.slice(2)
    if (body === '') throw new UsageError('"--" is not an argument name')
    const equals = body.indexOf('=')
    if (equals !== -1) {
      assign(body.slice(0, equals), coerce(body.slice(equals + 1)))
      index += 1
      continue
    }
    if (body.startsWith('no-')) {
      assign(body.slice(3), false)
      index += 1
      continue
    }
    const next = tokens[index + 1]
    if (next === undefined || String(next).startsWith('--')) {
      assign(body, true)
      index += 1
      continue
    }
    assign(body, coerce(String(next)))
    index += 2
  }
  return args
}

export function coerce(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return value
}

/** Merge `--json-args` last so it can express anything the flags cannot. */
export function buildCallArguments(tokens) {
  const parsed = parseArguments(tokens)
  const raw = parsed['json-args']
  delete parsed['json-args']
  if (raw === undefined) return parsed
  let extra
  try {
    extra = JSON.parse(String(raw))
  } catch (error) {
    throw new UsageError(`--json-args is not valid JSON: ${error.message}`)
  }
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new UsageError('--json-args must be a JSON object')
  }
  return { ...parsed, ...extra }
}

/** Human-readable rendering; --json prints the structured payload verbatim. */
export function renderResult(payload, { json = false } = {}) {
  if (json) return JSON.stringify(payload, null, 2)
  if (payload === null || typeof payload !== 'object') return String(payload)
  const lines = []
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      lines.push(`${key}: ${value.length} item${value.length === 1 ? '' : 's'}`)
      continue
    }
    if (value !== null && typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`)
      continue
    }
    const text = String(value)
    lines.push(`${key}: ${text.includes('\n') ? `\n${text.replace(/^/gm, '  ')}` : text}`)
  }
  return lines.join('\n')
}

function tableOfActions(actions, { family } = {}) {
  return actions
    .filter(action => family === undefined || action.family === family)
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * @param client something with listTools() and callTool({name, arguments}) --
 *   an MCP client, or a double in tests.
 */
export async function runCli(argv, { client, log = console.log, error = console.error } = {}) {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    log(USAGE)
    return EXIT.ok
  }

  const jsonIndex = rest.indexOf('--json')
  const json = jsonIndex !== -1
  const tokens = json ? [...rest.slice(0, jsonIndex), ...rest.slice(jsonIndex + 1)] : rest

  if (command === 'actions') {
    const { family } = parseArguments(tokens)
    const catalog = await client.callTool({ name: 'bridge_capabilities', arguments: {} })
    const body = catalog.structuredContent ?? {}
    const actions = tableOfActions(body.actions ?? [], { family: typeof family === 'string' ? family : undefined })
    if (json) {
      log(JSON.stringify({ actions, total: actions.length, families: body.families ?? [] }, null, 2))
      return EXIT.ok
    }
    for (const action of actions) {
      const flags = [action.read_only ? 'read' : 'write', action.destructive ? 'destructive' : null, action.requires_confirmation ? 'confirm' : null]
      log(`${action.name.padEnd(28)} ${action.family.padEnd(12)} ${flags.filter(Boolean).join(' ')}`)
    }
    log(`\n${actions.length} action${actions.length === 1 ? '' : 's'}`)
    return EXIT.ok
  }

  if (command === 'schema') {
    const [name] = tokens
    if (name === undefined || name.startsWith('--')) throw new UsageError('schema needs an action name')
    const catalog = await client.listTools()
    const tool = (catalog.tools ?? []).find(entry => entry.name === name)
    if (tool === undefined) throw new UsageError(`no action named ${name}; try "shiro actions"`)
    if (json) {
      log(JSON.stringify({ name: tool.name, description: tool.description, input: tool.inputSchema, output: tool.outputSchema }, null, 2))
      return EXIT.ok
    }
    log(`${tool.name} — ${tool.title ?? ''}\n\n${tool.description}\n`)
    log('input:')
    for (const [key, value] of Object.entries(tool.inputSchema?.properties ?? {})) {
      const required = (tool.inputSchema?.required ?? []).includes(key) ? ' (required)' : ''
      log(`  --${key}${required}: ${value.description ?? value.type ?? ''}`)
    }
    return EXIT.ok
  }

  if (command === 'status') {
    const result = await client.callTool({ name: 'bridge_status', arguments: {} })
    log(renderResult(result.structuredContent ?? {}, { json }))
    return result.isError === true ? EXIT.actionError : EXIT.ok
  }

  if (command === 'call') {
    const [name, ...callTokens] = tokens
    if (name === undefined || name.startsWith('--')) throw new UsageError('call needs an action name')
    const args = buildCallArguments(callTokens)
    const result = await client.callTool({ name, arguments: args })
    const payload = result.structuredContent ?? {}
    if (result.isError === true) {
      // The stable error shape reaches the shell as JSON on stderr, so a script
      // can branch on `code` instead of parsing prose.
      error(json ? JSON.stringify(payload, null, 2) : `${payload.error?.code ?? 'ERROR'}: ${payload.error?.message ?? 'action failed'}`)
      return EXIT.actionError
    }
    log(renderResult(payload, { json }))
    return EXIT.ok
  }

  throw new UsageError(`unknown command "${command}"`)
}
