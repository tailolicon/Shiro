import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EXIT } from './cli.js'

// Where the CLI finds a running bridge, and how it proves it may talk to one.
//
// The launcher already writes both facts down: Start-Shiro.sh picks the port and
// Run-Shiro-Backend.sh exports SHIRO_BRIDGE_TOKEN from the runtime state file.
// The CLI reads the same places in the same order, so a shell that can start
// Shiro can drive it without being told anything twice.

export const DEFAULT_PORT = 23157

export class TransportError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TransportError'
    this.exitCode = EXIT.transport
  }
}

export function resolveEndpoint(env = process.env) {
  const explicit = String(env.SHIRO_BRIDGE_URL ?? '').trim()
  if (explicit !== '') {
    try {
      return new URL(explicit).toString()
    } catch {
      throw new TransportError(`SHIRO_BRIDGE_URL is not a URL: ${explicit}`)
    }
  }
  const configured = String(env.SHIRO_BRIDGE_PORT ?? '').trim()
  const port = configured === '' ? DEFAULT_PORT : Number(configured)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TransportError(`SHIRO_BRIDGE_PORT must be an integer from 1024 to 65535, got "${configured}"`)
  }
  return `http://127.0.0.1:${port}/mcp`
}

/**
 * The token, in the order a shell is most likely to have it. The default file
 * is the launcher's own, so `shiro` works in a plain terminal that never
 * sourced the backend environment.
 */
export function resolveToken(env = process.env, { readFile = path => readFileSync(path, 'utf8'), cwd = process.cwd() } = {}) {
  const inline = String(env.SHIRO_BRIDGE_TOKEN ?? '').trim()
  if (inline !== '') return inline

  const explicitFile = String(env.SHIRO_BRIDGE_TOKEN_FILE ?? '').trim()
  const defaultFile = resolve(cwd, '..', '.ShiroRuntime', 'state', 'bridge-token.txt')
  const path = explicitFile !== '' ? resolve(explicitFile) : defaultFile
  let contents
  try {
    contents = readFile(path)
  } catch (error) {
    // Naming both the file we looked at and the variable that overrides it, so
    // the fix is one line either way.
    throw new TransportError(
      explicitFile !== ''
        ? `SHIRO_BRIDGE_TOKEN_FILE could not be read (${path}): ${error.message}`
        : `no bridge token: set SHIRO_BRIDGE_TOKEN, or SHIRO_BRIDGE_TOKEN_FILE, or run from a checkout beside ${path} (${error.message})`,
    )
  }
  const token = String(contents).trim()
  if (token === '') throw new TransportError(`the bridge token file is empty: ${path}`)
  return token
}

/** Connect an MCP client to the running bridge. Imported lazily so `shiro help` needs no SDK. */
export async function connect({ env = process.env, cwd = process.cwd() } = {}) {
  const url = resolveEndpoint(env)
  const token = resolveToken(env, { cwd })
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'shiro-cli', version: '0.2.0' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  try {
    await client.connect(transport)
  } catch (error) {
    const hint = /401|unauthorized/i.test(String(error?.message))
      ? 'the bridge rejected the token; check SHIRO_BRIDGE_TOKEN against the runtime state file'
      : `no bridge answered at ${url}; start it with scripts/Start-Shiro.sh`
    throw new TransportError(`${hint} (${error?.message ?? error})`)
  }
  return { client, url, close: () => client.close().catch(() => {}) }
}
