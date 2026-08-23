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
  await client.callTool({ name: 'harness_cancel', arguments: {} })
  const outcome = decode(await client.callTool({ name: 'harness_start', arguments: { prompt: 'Catalog smoke; do not call tools.' } }))
  const names = outcome.model_requests?.[0]?.tools?.map(tool => tool.name) ?? []
  if (!names.includes('sandbox_exec')) throw new Error(`sandbox_exec missing from catalog: ${names.join(', ')}`)
  process.stdout.write(`sandbox_exec exposed with ${names.length} Harness tools\n`)
  await client.callTool({ name: 'harness_cancel', arguments: {} })
} finally {
  await client.close()
}
