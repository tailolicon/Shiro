import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const endpoint = process.env.SHIRO_MCP_URL ?? 'http://127.0.0.1:23157/mcp'
const token = process.env.SHIRO_BRIDGE_TOKEN ?? 'local-shiro-integration-smoke'

function decoded(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP tool failed')
  const text = result.content?.find(block => block.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('MCP tool returned no JSON text')
  return JSON.parse(text)
}

async function call(client, name, args) {
  return decoded(await client.callTool({ name, arguments: args }))
}

function requestFrom(outcome) {
  const request = outcome.model_requests?.[0]
  if (request === undefined) throw new Error(`expected a pending model request, got ${JSON.stringify(outcome)}`)
  return request
}

function assertTool(request, name) {
  const tool = request.tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`Harness request does not expose ${name}; tools: ${request.tools.map(item => item.name).join(', ')}`)
}

async function submit(client, outcome, blocks) {
  const request = requestFrom(outcome)
  const next = await call(client, 'harness_continue', {
    request_id: request.request_id,
    blocks,
    wait_ms: 25_000,
  })
  process.stdout.write(`bridge step -> ${next.status}\n`)
  return next
}

const client = new Client({ name: 'dsh-sol-bridge-smoke', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})

try {
  await client.connect(transport)
  const tools = await client.listTools()
  process.stdout.write(`mcp tools: ${tools.tools.map(tool => tool.name).join(', ')}\n`)

  let outcome = await call(client, 'harness_start', {
    prompt: 'Integration smoke: use Harness tools to read package.json, create bridge-smoke.txt, edit it to BRIDGE_WRITE_OK, run npm test and git status, then attempt one write outside the workspace to prove it is denied. Do not push or merge.',
  })
  process.stdout.write(`start -> ${outcome.status}; session ${outcome.root_session_id}\n`)

  let request = requestFrom(outcome)
  assertTool(request, 'read')
  outcome = await submit(client, outcome, [{
    type: 'tool_call', id: 'bridge-call-read', name: 'read', arguments: { file_path: 'package.json' },
  }])

  request = requestFrom(outcome)
  assertTool(request, 'write')
  outcome = await submit(client, outcome, [{
    type: 'tool_call', id: 'bridge-call-write', name: 'write', arguments: { file_path: 'bridge-smoke.txt', content: 'BRIDGE_PENDING\n' },
  }])

  request = requestFrom(outcome)
  assertTool(request, 'edit')
  outcome = await submit(client, outcome, [{
    type: 'tool_call', id: 'bridge-call-edit', name: 'edit', arguments: {
      file_path: 'bridge-smoke.txt', old_string: 'BRIDGE_PENDING', new_string: 'BRIDGE_WRITE_OK',
    },
  }])

  request = requestFrom(outcome)
  assertTool(request, 'sandbox_exec')
  outcome = await submit(client, outcome, [{
    type: 'tool_call', id: 'bridge-call-sandbox', name: 'sandbox_exec', arguments: {
      command: 'npm test',
      description: 'Run tests in isolated container',
    },
  }])

  request = requestFrom(outcome)
  assertTool(request, 'pwsh')
  outcome = await submit(client, outcome, [{
    type: 'tool_call', id: 'bridge-call-pwsh', name: 'pwsh', arguments: {
      command: 'Get-Content bridge-smoke.txt; git status --short',
      description: 'Verify file and Git status',
    },
  }])

  request = requestFrom(outcome)
  assertTool(request, 'write')
  outcome = await submit(client, outcome, [{
    type: 'tool_call', id: 'bridge-call-deny', name: 'write', arguments: {
      file_path: '..\\outside-denied.txt', content: 'THIS_MUST_NOT_EXIST\n',
    },
  }])

  outcome = await submit(client, outcome, [{ type: 'text', text: 'SOL_BRIDGE_SMOKE_DONE' }])
  if (outcome.status !== 'completed') {
    outcome = await call(client, 'harness_status', { wait_ms: 25_000 })
  }
  if (outcome.status !== 'completed') throw new Error(`Harness did not complete: ${JSON.stringify(outcome)}`)
  process.stdout.write(`${outcome.completion.assistant_text}\n`)
} finally {
  await client.close()
}
