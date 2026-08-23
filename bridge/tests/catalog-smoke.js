import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const token = process.env.SHIRO_BRIDGE_TOKEN
if (!token) throw new Error('SHIRO_BRIDGE_TOKEN is required')

function decode(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP call failed')
  return JSON.parse(result.content.find(block => block.type === 'text').text)
}

const client = new Client({ name: 'shiro-catalog-smoke', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:23157/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})

try {
  await client.connect(transport)
  const catalog = await client.listTools()
  const startTool = catalog.tools.find(tool => tool.name === 'harness_start')
  if (startTool === undefined) throw new Error('harness_start missing from MCP catalog')
  const required = startTool.inputSchema?.required ?? []
  for (const field of ['prompt', 'speed_profile', 'reasoning_effort']) {
    if (!required.includes(field)) throw new Error(`harness_start does not require ${field}`)
  }
  const profiles = decode(await client.callTool({ name: 'harness_profiles', arguments: {} }))
  if (profiles.speed_profiles?.length !== 3 || profiles.reasoning_efforts?.length !== 4) {
    throw new Error(`unexpected Shiro profiles: ${JSON.stringify(profiles)}`)
  }
  await client.callTool({ name: 'harness_cancel', arguments: {} })
  const outcome = decode(await client.callTool({ name: 'harness_start', arguments: {
    prompt: 'Catalog smoke; do not call tools.',
    speed_profile: 'balanced',
    reasoning_effort: 'standard',
  } }))
  const names = outcome.model_requests?.[0]?.tools?.map(tool => tool.name) ?? []
  if (!names.includes('sandbox_exec')) throw new Error(`sandbox_exec missing from catalog: ${names.join(', ')}`)
  process.stdout.write(`3 speed profiles, 4 effort levels; sandbox_exec exposed with ${names.length} Harness tools\n`)
  await client.callTool({ name: 'harness_cancel', arguments: {} })
} finally {
  await client.close()
}
