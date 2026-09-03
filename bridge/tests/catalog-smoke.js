import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const token = process.env.SHIRO_BRIDGE_TOKEN
if (!token) throw new Error('SHIRO_BRIDGE_TOKEN is required')

function decode(result) {
  if (result.isError) throw new Error(result.content?.find(block => block.type === 'text')?.text ?? 'MCP call failed')
  if (result.structuredContent !== undefined) return result.structuredContent
  return JSON.parse(result.content.find(block => block.type === 'text').text)
}

function requireTool(catalog, name) {
  const tool = catalog.tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`${name} missing from MCP catalog`)
  if (typeof tool.title !== 'string' || tool.title === '') throw new Error(`${name} missing title`)
  if (tool.outputSchema === undefined) throw new Error(`${name} missing outputSchema`)
  for (const field of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    if (typeof tool.annotations?.[field] !== 'boolean') throw new Error(`${name} missing annotation ${field}`)
  }
  return tool
}

const expectedTools = [
  'fleet_start',
  'fleet_status',
  'fleet_stop',
  'harness_profiles',
  'harness_start',
  'harness_sessions',
  'harness_get_request',
  'harness_continue',
  'harness_status',
  'harness_respond',
  'harness_get_artifact',
  'harness_cancel',
]

// A live catalog must also carry the deterministic direct actions. This is a
// spot check across families, not the full inventory: bridge_capabilities is
// the authoritative list and is verified against tools/list below.
const expectedDirectActions = [
  'bridge_status', 'bridge_capabilities',
  'fs_read', 'fs_list', 'fs_search', 'fs_update_file', 'fs_delete',
  'exec_run', 'process_start', 'process_logs', 'process_stop',
  'git_status', 'git_diff', 'git_commit', 'git_push',
  'task_list', 'test_run',
  'harness_operation_list', 'fleet_list', 'fleet_worker_recycle',
  'browser_owned_tabs', 'artifact_list', 'config_get', 'logs_tail',
]

const client = new Client({ name: 'shiro-catalog-smoke', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:23157/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})

try {
  await client.connect(transport)

  const catalog = await client.listTools()
  for (const name of expectedTools) requireTool(catalog, name)
  for (const name of expectedDirectActions) requireTool(catalog, name)
  const startTool = requireTool(catalog, 'harness_start')
  const required = startTool.inputSchema?.required ?? []
  if (!required.includes('prompt')) throw new Error('harness_start must require prompt')
  for (const field of ['speed_profile', 'reasoning_effort']) {
    if (required.includes(field)) throw new Error(`harness_start must keep ${field} optional for cached-client compatibility`)
  }
  if (requireTool(catalog, 'harness_cancel').annotations.destructiveHint !== true) {
    throw new Error('harness_cancel must advertise destructiveHint:true')
  }
  if (requireTool(catalog, 'fleet_status').annotations.readOnlyHint !== true) {
    throw new Error('fleet_status must advertise readOnlyHint:true')
  }
  if (requireTool(catalog, 'fleet_stop').annotations.destructiveHint !== true) {
    throw new Error('fleet_stop must advertise destructiveHint:true')
  }
  const fleetRequired = requireTool(catalog, 'fleet_start').inputSchema?.required ?? []
  for (const field of ['name', 'size', 'prompt']) {
    if (!fleetRequired.includes(field)) throw new Error(`fleet_start must require ${field}`)
  }
  for (const name of ['harness_continue', 'harness_status', 'harness_respond']) {
    const maximum = requireTool(catalog, name).inputSchema?.properties?.wait_ms?.maximum
    if (maximum !== 30000) throw new Error(`${name}.wait_ms maximum must be 30000, got ${maximum}`)
  }

  // bridge_capabilities is the contract clients feature-detect against, so a
  // live bridge must report exactly the actions it actually registered, and
  // must answer without touching the engine.
  const capabilities = await client.callTool({ name: 'bridge_capabilities', arguments: {} })
  if (capabilities.isError) throw new Error(`bridge_capabilities failed: ${JSON.stringify(capabilities.structuredContent)}`)
  const reported = capabilities.structuredContent.actions.map(action => action.name).sort()
  const registered = catalog.tools.map(tool => tool.name).sort()
  if (JSON.stringify(reported) !== JSON.stringify(registered)) {
    throw new Error(`bridge_capabilities lists ${reported.length} actions but tools/list has ${registered.length}`)
  }
  const liveStatus = await client.callTool({ name: 'bridge_status', arguments: {} })
  if (liveStatus.isError) throw new Error(`bridge_status failed: ${JSON.stringify(liveStatus.structuredContent)}`)
  if (liveStatus.structuredContent.project_root !== capabilities.structuredContent.project_root) {
    throw new Error('bridge_status and bridge_capabilities disagree about the fixed project root')
  }
  const escaped = await client.callTool({ name: 'fs_read', arguments: { path: '../../../etc/passwd' } })
  if (escaped.isError !== true || escaped.structuredContent?.error?.code !== 'OUTSIDE_SANDBOX') {
    throw new Error('a live bridge must reject a path escaping the fixed project root with OUTSIDE_SANDBOX')
  }

  const resources = await client.listResources()
  const resourceUris = resources.resources.map(resource => resource.uri)
  for (const uri of ['shiro://sessions', 'shiro://status']) {
    if (!resourceUris.includes(uri)) throw new Error(`${uri} missing from MCP resources`)
  }
  const templates = await client.listResourceTemplates()
  const templateUris = templates.resourceTemplates.map(template => template.uriTemplate)
  for (const uri of ['shiro://artifact{?path}', 'shiro://session-log{?session_id,limit}']) {
    if (!templateUris.includes(uri)) throw new Error(`${uri} missing from MCP resource templates`)
  }
  const prompts = await client.listPrompts()
  const promptNames = prompts.prompts.map(prompt => prompt.name)
  for (const name of ['review-code', 'fix-tests', 'resume-session']) {
    if (!promptNames.includes(name)) throw new Error(`${name} missing from MCP prompts`)
  }

  const profiles = decode(await client.callTool({ name: 'harness_profiles', arguments: {} }))
  if (profiles.speed_profiles?.length !== 3 || profiles.reasoning_efforts?.length !== 4) {
    throw new Error(`unexpected Shiro profiles: ${JSON.stringify(profiles)}`)
  }

  await client.callTool({ name: 'harness_cancel', arguments: {} })
  let outcome = decode(await client.callTool({ name: 'harness_start', arguments: {
    prompt: 'Catalog smoke; inspect the request only and do not execute Harness tools.',
  } }))
  if (outcome.state === 'running') {
    outcome = decode(await client.callTool({ name: 'harness_status', arguments: { wait_ms: 30000 } }))
  }
  if (outcome.state !== 'model_input_required') {
    throw new Error(`catalog smoke expected model_input_required, got ${JSON.stringify(outcome)}`)
  }
  const requestId = outcome.request_id ?? outcome.model_requests?.[0]?.request_id
  if (typeof requestId !== 'string' || requestId === '') throw new Error('model request summary missing request_id')
  const request = decode(await client.callTool({ name: 'harness_get_request', arguments: { request_id: requestId } }))
  const harnessToolNames = request.tools?.map(tool => tool.name) ?? []
  if (!harnessToolNames.includes('sandbox_exec')) {
    throw new Error(`sandbox_exec missing from fetched Harness request: ${harnessToolNames.join(', ')}`)
  }

  process.stdout.write(`${catalog.tools.length} MCP tools (${expectedTools.length} original + direct actions); 2 static resources; 2 resource templates; 3 prompts; ${harnessToolNames.length} Harness tools in fetched request\n`)
  await client.callTool({ name: 'harness_cancel', arguments: {} })
} finally {
  await client.close()
}
