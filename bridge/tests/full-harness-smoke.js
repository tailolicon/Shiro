import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const token = process.env.SHIRO_BRIDGE_TOKEN ?? 'local-shiro-integration-smoke'

function decode(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'MCP call failed')
  return JSON.parse(result.content.find(block => block.type === 'text').text)
}

async function call(client, name, args) {
  return decode(await client.callTool({ name, arguments: args }))
}

function requests(outcome) {
  if (!Array.isArray(outcome.model_requests) || outcome.model_requests.length === 0) {
    throw new Error(`expected model requests, got ${JSON.stringify(outcome)}`)
  }
  return outcome.model_requests
}

function latestToolText(request) {
  for (const message of [...request.messages].reverse()) {
    if (!Array.isArray(message.content)) continue
    for (const block of [...message.content].reverse()) {
      if (block?.type !== 'tool-result' || !Array.isArray(block.content)) continue
      const text = block.content.find(item => item?.type === 'text')?.text
      if (typeof text === 'string') return text
    }
  }
  return ''
}

async function answer(client, request, blocks, waitMs = 25_000) {
  const outcome = await call(client, 'harness_continue', {
    request_id: request.request_id,
    blocks,
    wait_ms: waitMs,
  })
  process.stdout.write(`full step -> ${outcome.status}; pending ${outcome.model_requests?.length ?? 0}\n`)
  return outcome
}

const client = new Client({ name: 'dsh-full-harness-smoke', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:23157/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})

try {
  await client.connect(transport)
  await call(client, 'harness_cancel', {})
  let outcome = await call(client, 'harness_start', {
    prompt: 'Full Harness smoke: create and inspect a goal, pause it, run a foreground subagent, then run a two-child workflow. Do not modify files.',
  })
  const rootSessionId = outcome.root_session_id

  let request = requests(outcome)[0]
  outcome = await answer(client, request, [{
    type: 'tool_call', id: 'full-create-goal', name: 'create_goal', arguments: {
      objective: 'Validate goal subagent and workflow through ChatGPT bridge', max_goal_rounds: 3,
    },
  }])

  request = requests(outcome)[0]
  outcome = await answer(client, request, [{
    type: 'tool_call', id: 'full-get-goal', name: 'get_goal', arguments: {},
  }])

  request = requests(outcome)[0]
  const goalText = latestToolText(request)
  process.stdout.write(`goal result: ${goalText}\n`)
  const goalResult = JSON.parse(goalText)
  const goal = goalResult.goal ?? goalResult
  outcome = await answer(client, request, [{
    type: 'tool_call', id: 'full-pause-goal', name: 'update_goal', arguments: {
      goal_id: goal.id ?? goal.goal_id,
      revision: goal.revision,
      action: 'pause',
    },
  }])

  request = requests(outcome)[0]
  outcome = await answer(client, request, [{
    type: 'tool_call', id: 'full-subagent', name: 'subagent', arguments: {
      description: 'Bridge child smoke',
      prompt: 'Return exactly SUBAGENT_BRIDGE_OK and do not call tools.',
      run_in_background: false,
    },
  }])

  request = requests(outcome).find(item => item.session_id !== rootSessionId)
  if (request === undefined) throw new Error('foreground subagent did not produce a child model request')
  outcome = await answer(client, request, [{ type: 'text', text: 'SUBAGENT_BRIDGE_OK' }])

  request = requests(outcome).find(item => item.session_id === rootSessionId)
  if (request === undefined) throw new Error('parent did not resume after foreground subagent')
  outcome = await answer(client, request, [{
    type: 'tool_call', id: 'full-workflow', name: 'workflow', arguments: {
      meta: { name: 'bridge-parallel-smoke', description: 'Validate two concurrent Harness workflow children' },
      script: 'return await parallel([() => agent("Return exactly WORKFLOW_CHILD_A and do not call tools.", { label: "child-a" }), () => agent("Return exactly WORKFLOW_CHILD_B and do not call tools.", { label: "child-b" })])',
    },
  }], 40_000)

  const childRequests = requests(outcome).filter(item => item.session_id !== rootSessionId)
  if (childRequests.length !== 2) throw new Error(`expected two concurrent workflow model requests, got ${childRequests.length}`)
  outcome = await answer(client, childRequests[0], [{ type: 'text', text: 'WORKFLOW_CHILD_A' }])
  const remainingChild = requests(outcome).find(item => item.session_id !== rootSessionId)
  if (remainingChild === undefined) throw new Error('second workflow child disappeared')
  outcome = await answer(client, remainingChild, [{ type: 'text', text: 'WORKFLOW_CHILD_B' }], 40_000)

  request = requests(outcome).find(item => item.session_id === rootSessionId)
  if (request === undefined) throw new Error('parent did not resume after workflow')
  outcome = await answer(client, request, [{ type: 'text', text: 'FULL_HARNESS_BRIDGE_DONE' }])
  if (outcome.status !== 'completed') outcome = await call(client, 'harness_status', { wait_ms: 25_000 })
  if (outcome.status !== 'completed') throw new Error(`full Harness smoke did not complete: ${JSON.stringify(outcome)}`)
  process.stdout.write(`${outcome.completion.assistant_text}\n`)
} finally {
  await client.close()
}
