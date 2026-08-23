import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const token = process.env.SHIRO_BRIDGE_TOKEN
if (!token) throw new Error('SHIRO_BRIDGE_TOKEN is required')
const fakeKey = `sk-${'abcdefghijklmnop'}`

function decode(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP call failed')
  return JSON.parse(result.content.find(block => block.type === 'text').text)
}

async function call(client, name, args) {
  return decode(await client.callTool({ name, arguments: args }))
}

function request(outcome) {
  const value = outcome.model_requests?.[0]
  if (value === undefined) throw new Error(`expected model request: ${JSON.stringify(outcome)}`)
  return value
}

async function answer(client, outcome, block) {
  return call(client, 'harness_continue', {
    request_id: request(outcome).request_id,
    blocks: [block],
    wait_ms: 15_000,
  })
}

const client = new Client({ name: 'shiro-redaction-smoke', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:23157/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})

try {
  await client.connect(transport)
  await call(client, 'harness_cancel', {})
  let outcome = await call(client, 'harness_start', {
    prompt: 'Secret-redaction smoke using a generated fake key. Do not access outside the fixed root.',
    speed_profile: 'balanced',
    reasoning_effort: 'standard',
  })
  outcome = await answer(client, outcome, {
    type: 'tool_call', id: 'redaction-write', name: 'write', arguments: {
      file_path: 'bridge-redaction-smoke.txt', content: `${fakeKey}\n`,
    },
  })
  outcome = await answer(client, outcome, {
    type: 'tool_call', id: 'redaction-read', name: 'read', arguments: {
      file_path: 'bridge-redaction-smoke.txt',
    },
  })
  const relayed = JSON.stringify(request(outcome))
  if (relayed.includes(fakeKey) || !relayed.includes('sk-***')) {
    throw new Error('bridge did not redact the fake key from the relayed model request')
  }
  outcome = await answer(client, outcome, {
    type: 'tool_call', id: 'redaction-clean', name: 'sandbox_exec', arguments: {
      command: 'rm -f bridge-redaction-smoke.txt', description: 'Remove generated redaction smoke fixture',
    },
  })
  outcome = await answer(client, outcome, { type: 'text', text: 'REDACTION_BRIDGE_DONE' })
  if (outcome.status !== 'completed') outcome = await call(client, 'harness_status', { wait_ms: 15_000 })
  if (outcome.status !== 'completed') throw new Error(`redaction smoke did not complete: ${JSON.stringify(outcome)}`)
  process.stdout.write('fake secret created -> read -> redacted before ChatGPT relay -> fixture removed\n')
} finally {
  await client.close()
}
