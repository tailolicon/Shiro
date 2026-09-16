import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCallArguments, coerce, EXIT, parseArguments, renderResult, runCli, UsageError } from '../src/cli.js'
import { clientRequestHeaders, DEFAULT_PORT, resolveEndpoint, resolveToken, SHIRO_CLIENT_HEADER, TransportError } from '../src/cli-connect.js'

/** A stand-in for the MCP client: records calls, replays canned answers. */
function fakeClient({ tools = [], results = {} } = {}) {
  const calls = []
  return {
    calls,
    async listTools() { return { tools } },
    async callTool(request) {
      calls.push(request)
      const answer = results[request.name]
      if (answer === undefined) return { structuredContent: { ok: true } }
      return typeof answer === 'function' ? answer(request) : answer
    },
  }
}

function capture() {
  const lines = []
  const errors = []
  return { lines, errors, log: line => lines.push(String(line)), error: line => errors.push(String(line)) }
}

const CATALOG = {
  structuredContent: {
    families: ['filesystem', 'git'],
    actions: [
      { name: 'git_status', family: 'git', read_only: true, destructive: false, requires_confirmation: false },
      { name: 'fs_read', family: 'filesystem', read_only: true, destructive: false, requires_confirmation: false },
      { name: 'fs_delete', family: 'filesystem', read_only: false, destructive: true, requires_confirmation: true },
    ],
  },
}

test('flags become typed arguments the way the schemas expect', () => {
  assert.deepEqual(parseArguments(['--path', 'src/a.js', '--limit', '20']), { path: 'src/a.js', limit: 20 })
  assert.deepEqual(parseArguments(['--confirm']), { confirm: true })
  assert.deepEqual(parseArguments(['--no-confirm']), { confirm: false })
  assert.deepEqual(parseArguments(['--path=src/a.js']), { path: 'src/a.js' })
  // A trailing flag before another flag is a boolean, not a swallowed value.
  assert.deepEqual(parseArguments(['--recursive', '--path', 'x']), { recursive: true, path: 'x' })
  // Repeats build the array shape the array-valued actions take.
  assert.deepEqual(parseArguments(['--paths', 'a.txt', '--paths', 'b.txt']), { paths: ['a.txt', 'b.txt'] })
})

test('coercion is conservative: only unambiguous scalars change type', () => {
  assert.equal(coerce('20'), 20)
  assert.equal(coerce('-3'), -3)
  assert.equal(coerce('true'), true)
  assert.equal(coerce('null'), null)
  // Things that merely look numeric stay strings, because a version or a sha
  // that arrived as a number would be silently wrong.
  assert.equal(coerce('1.2.3'), '1.2.3')
  assert.equal(coerce('007abc'), '007abc')
  assert.equal(coerce('9007199254740993'), '9007199254740993', 'beyond safe integers, keep the text')
  assert.equal(coerce('main'), 'main')
})

test('a malformed argument list is a usage error, not a mystery call', () => {
  assert.throws(() => parseArguments(['path', 'x']), UsageError)
  assert.throws(() => parseArguments(['--']), UsageError)
  assert.throws(() => buildCallArguments(['--json-args', 'not json']), /not valid JSON/)
  assert.throws(() => buildCallArguments(['--json-args', '[1,2]']), /must be a JSON object/)
})

test('--json-args expresses what flags cannot, and wins on conflict', () => {
  const args = buildCallArguments(['--path', 'a.txt', '--json-args', '{"nested":{"deep":true},"path":"b.txt"}'])
  assert.deepEqual(args, { path: 'b.txt', nested: { deep: true } })
})

test('help works without a bridge', async () => {
  const out = capture()
  assert.equal(await runCli(['help'], { client: null, ...out }), EXIT.ok)
  assert.match(out.lines.join('\n'), /shiro call <action>/)
  assert.equal(await runCli([], { client: null, ...out }), EXIT.ok)
})

test('actions lists the surface and can be narrowed to one family', async () => {
  const client = fakeClient({ results: { bridge_capabilities: CATALOG } })
  const out = capture()
  assert.equal(await runCli(['actions'], { client, ...out }), EXIT.ok)
  const text = out.lines.join('\n')
  assert.match(text, /git_status/)
  assert.match(text, /fs_delete .*destructive confirm/)
  assert.match(text, /3 actions/)

  const narrowed = capture()
  await runCli(['actions', '--family', 'git'], { client, ...narrowed })
  assert.match(narrowed.lines.join('\n'), /1 action\b/)
  assert.doesNotMatch(narrowed.lines.join('\n'), /fs_read/)
})

test('actions --json emits a payload a script can consume', async () => {
  const client = fakeClient({ results: { bridge_capabilities: CATALOG } })
  const out = capture()
  await runCli(['actions', '--json'], { client, ...out })
  const payload = JSON.parse(out.lines.join('\n'))
  assert.equal(payload.total, 3)
  assert.deepEqual(payload.actions.map(action => action.name), ['fs_delete', 'fs_read', 'git_status'])
  assert.deepEqual(payload.families, ['filesystem', 'git'])
})

test('schema reports the input and output contract of one action', async () => {
  const client = fakeClient({
    tools: [{
      name: 'fs_read',
      title: 'Read a file',
      description: 'Read a UTF-8 file from the workspace.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative path' } }, required: ['path'] },
      outputSchema: { type: 'object', properties: { content: { type: 'string' } } },
    }],
  })
  const out = capture()
  assert.equal(await runCli(['schema', 'fs_read'], { client, ...out }), EXIT.ok)
  assert.match(out.lines.join('\n'), /--path \(required\): workspace-relative path/)

  const json = capture()
  await runCli(['schema', 'fs_read', '--json'], { client, ...json })
  const payload = JSON.parse(json.lines.join('\n'))
  assert.equal(payload.output.properties.content.type, 'string', 'the output schema is what makes this scriptable')

  await assert.rejects(runCli(['schema', 'nope'], { client, ...capture() }), /no action named nope/)
  await assert.rejects(runCli(['schema'], { client, ...capture() }), UsageError)
})

test('call forwards the parsed arguments and prints the structured result', async () => {
  const client = fakeClient({ results: { git_log: { structuredContent: { commits: [1, 2], head: 'abc123' } } } })
  const out = capture()
  assert.equal(await runCli(['call', 'git_log', '--limit', '2'], { client, ...out }), EXIT.ok)
  assert.deepEqual(client.calls[0], { name: 'git_log', arguments: { limit: 2 } })
  assert.match(out.lines.join('\n'), /commits: 2 items/)
  assert.match(out.lines.join('\n'), /head: abc123/)
})

test('an action error exits 1 with the code on stderr, so a script can branch', async () => {
  const client = fakeClient({
    results: { fs_read: { isError: true, structuredContent: { error: { code: 'NOT_FOUND', message: 'no such file: x.txt' } } } },
  })
  const out = capture()
  assert.equal(await runCli(['call', 'fs_read', '--path', 'x.txt'], { client, ...out }), EXIT.actionError)
  assert.equal(out.lines.length, 0, 'nothing on stdout, so `shiro call ... | jq` does not see half an answer')
  assert.match(out.errors.join('\n'), /^NOT_FOUND: no such file/)

  const json = capture()
  await runCli(['call', 'fs_read', '--path', 'x.txt', '--json'], { client, ...json })
  assert.equal(JSON.parse(json.errors.join('\n')).error.code, 'NOT_FOUND')
})

test('--json anywhere in the line is the output switch, not an action argument', async () => {
  const client = fakeClient({ results: { git_status: { structuredContent: { branch: 'main' } } } })
  const out = capture()
  await runCli(['call', 'git_status', '--json'], { client, ...out })
  assert.deepEqual(client.calls[0].arguments, {}, '--json never reaches the action')
  assert.deepEqual(JSON.parse(out.lines.join('\n')), { branch: 'main' })
})

test('an unknown command is a usage error', async () => {
  await assert.rejects(runCli(['exec', 'do the thing'], { client: fakeClient(), ...capture() }), error => {
    assert.equal(error.exitCode, EXIT.usage)
    assert.match(error.message, /unknown command "exec"/)
    return true
  })
  await assert.rejects(runCli(['call'], { client: fakeClient(), ...capture() }), /call needs an action name/)
})

test('rendering keeps multi-line values readable and single-line values greppable', () => {
  assert.match(renderResult({ stdout: 'one\ntwo' }), /stdout: \n {2}one\n {2}two/)
  assert.equal(renderResult({ ok: true, count: 3 }), 'ok: true\ncount: 3')
  assert.equal(renderResult({ a: 1 }, { json: true }), '{\n  "a": 1\n}')
})

test('the endpoint comes from the same variables the launcher exports', () => {
  assert.equal(resolveEndpoint({}), `http://127.0.0.1:${DEFAULT_PORT}/mcp`)
  assert.equal(resolveEndpoint({ SHIRO_BRIDGE_PORT: '23999' }), 'http://127.0.0.1:23999/mcp')
  assert.equal(resolveEndpoint({ SHIRO_BRIDGE_URL: 'http://box.local:8080/mcp' }), 'http://box.local:8080/mcp')
  assert.throws(() => resolveEndpoint({ SHIRO_BRIDGE_PORT: '80' }), TransportError)
  assert.throws(() => resolveEndpoint({ SHIRO_BRIDGE_URL: 'not a url' }), /is not a URL/)
})

test('the bundled CLI marks requests so local tasks retain the configured loop owner', () => {
  assert.deepEqual(clientRequestHeaders('secret'), {
    authorization: 'Bearer secret',
    [SHIRO_CLIENT_HEADER]: 'shiro-cli',
  })
})

test('the token is found in the environment or in the launcher state file', () => {
  assert.equal(resolveToken({ SHIRO_BRIDGE_TOKEN: ' secret ' }), 'secret')
  assert.equal(
    resolveToken({ SHIRO_BRIDGE_TOKEN_FILE: '/state/token.txt' }, { readFile: path => (path === '/state/token.txt' ? 'from-file\n' : '') }),
    'from-file',
  )
  // The failure names the file it looked at, because "unauthorized" alone is
  // the least useful thing this could say.
  assert.throws(
    () => resolveToken({}, { readFile: () => { throw new Error('ENOENT') }, cwd: '/home/x/Projects/Shiro/bridge' }),
    error => {
      assert.equal(error.exitCode, EXIT.transport)
      assert.match(error.message, /\.ShiroRuntime\/state\/bridge-token\.txt/)
      return true
    },
  )
  assert.throws(() => resolveToken({ SHIRO_BRIDGE_TOKEN_FILE: '/x' }, { readFile: () => '   ' }), /token file is empty/)
})

// The tests above use a client double so they can assert on exact wire calls.
// This one uses the real server, the real MCP client and the real action
// registry, because the thing most likely to break is not the parser but the
// assumption that a printed result matches the shape an action actually returns.
test('the CLI drives the real action surface end to end', async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { BridgeBroker, configureMcp } = await import('../src/index.js')

  const root = await mkdtemp(join(tmpdir(), 'shiro-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'note.txt'), 'hello from the workspace\n')

  const controller = {
    broker: new BridgeBroker(),
    async sessions() { return { workspace_id: 'project', sessions: [] } },
    async status() { return { status: 'idle' } },
  }
  const server = new McpServer({ name: 'shiro-cli-e2e', version: '0.0.0' })
  configureMcp(server, controller, { workspaceRoot: root, waitMs: 25_000, token: 'x' })
  const client = new Client({ name: 'shiro-cli-e2e-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })

  // Discovery: the catalog the CLI lists is the catalog the bridge registers.
  const listed = capture()
  assert.equal(await runCli(['actions', '--json'], { client, ...listed }), EXIT.ok)
  const catalog = JSON.parse(listed.lines.join('\n'))
  assert.ok(catalog.total > 100, `expected the full surface, saw ${catalog.total}`)
  assert.ok(catalog.actions.some(action => action.name === 'fs_read'))

  // Schema: an action found by discovery can be described without prior knowledge.
  const described = capture()
  await runCli(['schema', 'fs_read', '--json'], { client, ...described })
  assert.equal(JSON.parse(described.lines.join('\n')).name, 'fs_read')

  // Call: flags become the arguments the real schema wants, and the printed
  // result is the real structured content.
  const read = capture()
  assert.equal(await runCli(['call', 'fs_read', '--path', 'note.txt', '--json'], { client, ...read }), EXIT.ok)
  assert.match(JSON.parse(read.lines.join('\n')).content, /hello from the workspace/)

  // A real refusal carries a real error code out to the exit status.
  const missing = capture()
  assert.equal(await runCli(['call', 'fs_read', '--path', 'nope.txt'], { client, ...missing }), EXIT.actionError)
  assert.match(missing.errors.join('\n'), /^NOT_FOUND: /)

  // Numeric coercion has to survive the schema: a string "2" would be rejected.
  const listing = capture()
  assert.equal(await runCli(['call', 'fs_list', '--path', '.', '--limit', '5', '--json'], { client, ...listing }), EXIT.ok)
  assert.ok(JSON.parse(listing.lines.join('\n')).entries.length >= 1)
})
