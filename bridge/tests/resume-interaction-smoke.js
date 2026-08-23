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

function oneRequest(outcome) {
  const request = outcome.model_requests?.[0]
  if (request === undefined) throw new Error(`expected one model request, got ${JSON.stringify(outcome)}`)
  return request
}

async function answer(client, outcome, blocks) {
  return call(client, 'harness_continue', {
    request_id: oneRequest(outcome).request_id,
    blocks,
    wait_ms: 25_000,
  })
}

const client = new Client({ name: 'dsh-resume-interaction-smoke', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:23157/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})

try {
  await client.connect(transport)
  const catalog = await call(client, 'harness_sessions', {})
  const resumed = catalog.sessions.find(session => session.parentSessionId === undefined && session.blank === false)
  if (resumed === undefined) throw new Error('no durable root session is available to resume')
  let outcome = await call(client, 'harness_start', {
    session_id: resumed.sessionId,
    prompt: 'Resume and interaction smoke: ask one question, then test and reject one wider write approval. Do not create the outside file.',
  })
  const first = oneRequest(outcome)
  if (first.messages.length < 5) throw new Error('resumed model request did not carry durable prior history')

  outcome = await answer(client, outcome, [{
    type: 'tool_call', id: 'resume-question', name: 'ask_user_question', arguments: {
      questions: [{
        id: 'continue-smoke',
        header: 'Smoke',
        question: 'Continue the safe bridge smoke?',
        options: [{ label: 'Continue', description: 'Proceed with the sandbox denial test.' }, { label: 'Stop' }],
      }],
    },
  }])
  if (outcome.status !== 'user_input_required' || outcome.interactions?.[0]?.type !== 'question/requested') {
    throw new Error(`question was not relayed: ${JSON.stringify(outcome)}`)
  }
  outcome = await call(client, 'harness_respond', {
    interaction_id: outcome.interactions[0].interaction_id,
    answers: [{ id: 'continue-smoke', selected: ['Continue'] }],
    wait_ms: 25_000,
  })

  outcome = await answer(client, outcome, [{
    type: 'tool_call', id: 'resume-deny-first', name: 'write', arguments: {
      file_path: '..\\approval-denied.txt', content: 'THIS_MUST_NOT_EXIST\n',
    },
  }])
  outcome = await answer(client, outcome, [{
    type: 'tool_call', id: 'resume-deny-approval', name: 'write', arguments: {
      file_path: '..\\approval-denied.txt',
      content: 'THIS_MUST_NOT_EXIST\n',
      sandbox_permissions: 'danger-full-access',
      justification: 'Test that the bridge relays and safely rejects wider access.',
    },
  }])
  if (outcome.status !== 'user_input_required' || outcome.interactions?.[0]?.type !== 'approval/requested') {
    throw new Error(`approval was not relayed: ${JSON.stringify(outcome)}`)
  }
  outcome = await call(client, 'harness_respond', {
    interaction_id: outcome.interactions[0].interaction_id,
    approval_outcome: 'rejected',
    wait_ms: 25_000,
  })

  outcome = await answer(client, outcome, [{ type: 'text', text: 'RESUME_INTERACTION_DONE' }])
  if (outcome.status !== 'completed') outcome = await call(client, 'harness_status', { wait_ms: 25_000 })
  if (outcome.status !== 'completed') throw new Error(`resume interaction smoke did not complete: ${JSON.stringify(outcome)}`)
  process.stdout.write(`resumed ${resumed.sessionId}; question relayed; approval rejected; ${outcome.completion.assistant_text}\n`)
} finally {
  await client.close()
}
