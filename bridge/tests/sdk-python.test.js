import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { BridgeBroker, configureMcp } from '../src/index.js'

const run = promisify(execFile)
const HERE = fileURLToPath(new URL('.', import.meta.url))
const TOKEN = 'test-bridge-token'

/**
 * A real HTTP bridge: the same per-request server the production handler builds,
 * behind the same bearer check. The point of this file is to exercise the
 * clients over the wire, not through an in-memory transport, because that is
 * where an SSE frame or a missing header actually goes wrong.
 */
async function bridge(workspaceRoot) {
  const controller = {
    broker: new BridgeBroker(),
    async sessions() { return { workspace_id: 'project', sessions: [] } },
    async status() { return { status: 'idle' } },
  }
  const server = createServer(async (req, res) => {
    if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const mcp = new McpServer({ name: 'shiro-http-test', version: '0.0.0' })
    configureMcp(mcp, controller, { workspaceRoot, waitMs: 25_000, token: TOKEN })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { void transport.close(); void mcp.close() })
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { port, url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise(resolve => server.close(resolve)) }
}

async function havePython() {
  try {
    await run('python3', ['--version'])
    return true
  } catch {
    return false
  }
}

test('the Python SDK drives a real bridge over HTTP', async t => {
  if (!await havePython()) return t.skip('python3 is not installed')
  const root = await mkdtemp(join(tmpdir(), 'shiro-py-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'note.txt'), 'hello from python\n')
  const service = await bridge(root)
  t.after(() => service.close())

  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(HERE, '..', 'sdk'))})
from shiro import Shiro, ShiroActionError, ShiroTransportError

out = {}
with Shiro() as shiro:
    out["read"] = shiro.fs_read(path="note.txt")["content"]
    out["actions"] = len(shiro.actions())
    out["git_family"] = len(shiro.actions(family="git"))
    out["schema_has_output"] = shiro.schema("fs_read")["output"] is not None
    # None-valued arguments are omissions, so optional parameters do not have
    # to be assembled by hand.
    out["listed"] = len(shiro.fs_list(path=".", limit=None)["entries"])
    try:
        shiro.fs_read(path="missing.txt")
        out["error"] = None
    except ShiroActionError as error:
        out["error"] = [error.code, error.action, bool(str(error))]
    out["thread_id"] = shiro.thread("  session-9 ").id

# A wrong token must fail as transport, not as a confusing action error.
try:
    Shiro(token="wrong").fs_read(path="note.txt")
    out["unauthorized"] = None
except ShiroTransportError as error:
    out["unauthorized"] = "rejected the token" in str(error)

print(json.dumps(out))
`
  const { stdout } = await run('python3', ['-c', script], {
    env: { ...process.env, SHIRO_BRIDGE_URL: service.url, SHIRO_BRIDGE_TOKEN: TOKEN },
  })
  const result = JSON.parse(stdout)
  assert.match(result.read, /hello from python/)
  assert.ok(result.actions > 100, `expected the full surface, saw ${result.actions}`)
  assert.ok(result.git_family > 0)
  assert.equal(result.schema_has_output, true)
  assert.ok(result.listed >= 1)
  assert.deepEqual(result.error, ['NOT_FOUND', 'fs_read', true])
  assert.equal(result.thread_id, 'session-9')
  assert.equal(result.unauthorized, true)
})

test('the shiro command drives a real bridge over HTTP', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shiro-cli-http-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'note.txt'), 'hello from the shell\n')
  const service = await bridge(root)
  t.after(() => service.close())

  const bin = join(HERE, '..', 'bin', 'shiro.mjs')
  // SHIRO_BRIDGE_PORT is what the launcher exports, so the CLI is exercised
  // through the same variable an operator's shell would already have.
  const env = { ...process.env, SHIRO_BRIDGE_PORT: String(service.port), SHIRO_BRIDGE_TOKEN: TOKEN }
  delete env.SHIRO_BRIDGE_URL

  const read = await run('node', [bin, 'call', 'fs_read', '--path', 'note.txt', '--json'], { env })
  assert.match(JSON.parse(read.stdout).content, /hello from the shell/)

  const listed = await run('node', [bin, 'actions', '--json'], { env })
  assert.ok(JSON.parse(listed.stdout).total > 100)

  // A refused action exits 1 with the code on stderr and nothing on stdout.
  await assert.rejects(run('node', [bin, 'call', 'fs_read', '--path', 'missing.txt'], { env }), error => {
    assert.equal(error.code, 1)
    assert.equal(error.stdout, '')
    assert.match(error.stderr, /^NOT_FOUND: /)
    return true
  })

  // A bad token is a transport failure with its own exit code, not a silent 0.
  await assert.rejects(run('node', [bin, 'status'], { env: { ...env, SHIRO_BRIDGE_TOKEN: 'wrong' } }), error => {
    assert.equal(error.code, 3)
    assert.match(error.stderr, /rejected the token/)
    return true
  })

  // Nothing listening is also transport, and names the launcher script.
  await assert.rejects(run('node', [bin, 'status'], { env: { ...env, SHIRO_BRIDGE_PORT: '23999' } }), error => {
    assert.equal(error.code, 3)
    assert.match(error.stderr, /Start-Shiro\.sh/)
    return true
  })
})
