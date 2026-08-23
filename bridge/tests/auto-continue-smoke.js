import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const token = process.env.SHIRO_BRIDGE_TOKEN
if (!token) throw new Error('SHIRO_BRIDGE_TOKEN is required')

function decode(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP call failed')
  return JSON.parse(result.content.find(block => block.type === 'text').text)
}

async function call(client, name, args) {
  return decode(await client.callTool({ name, arguments: args }))
}

function oneRequest(outcome) {
  const request = outcome.model_requests?.[0]
  if (request === undefined) throw new Error(`expected model request: ${JSON.stringify(outcome)}`)
  return request
}

const client = new Client({ name: 'shiro-auto-continue-smoke', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:23157/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})

try {
  await client.connect(transport)
  await call(client, 'harness_cancel', {})
  let outcome = await call(client, 'harness_start', {
    prompt: 'Auto-continue smoke: simulate one max-token response, then finish after the plugin resumes. Do not call tools or modify files.',
    speed_profile: 'fast',
    reasoning_effort: 'light',
  })
  const first = oneRequest(outcome)
  outcome = await call(client, 'harness_continue', {
    request_id: first.request_id,
    blocks: [{ type: 'text', text: 'AUTO_CONTINUE_PARTIAL' }],
    finish_reason: 'max-tokens',
    wait_ms: 15_000,
  })
  const resumed = oneRequest(outcome)
  if (resumed.request_id === first.request_id) throw new Error('auto-continue reused the completed request')
  outcome = await call(client, 'harness_continue', {
    request_id: resumed.request_id,
    blocks: [{ type: 'text', text: 'AUTO_CONTINUE_BRIDGE_DONE' }],
    wait_ms: 15_000,
  })
  if (outcome.status !== 'completed') outcome = await call(client, 'harness_status', { wait_ms: 15_000 })
  if (outcome.status !== 'completed' || outcome.completion?.assistant_text !== 'AUTO_CONTINUE_BRIDGE_DONE') {
    throw new Error(`auto-continue did not complete the resumed turn: ${JSON.stringify(outcome)}`)
  }
  process.stdout.write('max-tokens -> plugin follow-up -> bridge resumed -> completed\n')
} finally {
  await client.close()
}
