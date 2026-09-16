import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { CodexCliRunner } from '../src/codex-cli.js'
import { CodexCliAdapter } from '../src/index.js'
import { RelayError } from '../src/chatgpt-relay.js'

const request = {
  request_id: 'req-1',
  session_id: null,
  purpose: 'conversation',
  provider: 'shiro-codex',
  model: 'gpt-5.6-sol',
  system: 'system prompt',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [{ name: 'read' }, { name: 'bash' }],
  generation: { reasoning_effort: 'standard', speed_profile: 'balanced' },
}

function reply(overrides = {}) {
  return JSON.stringify({
    blocks: [{
      type: 'tool_call',
      text: null,
      id: 'c1',
      name: 'read',
      arguments: JSON.stringify({ file_path: 'a.txt' }),
    }],
    finishReason: 'tool-calls',
    ...overrides,
  })
}

/** Fake spawn whose scripted lifecycle begins when the runner closes stdin. */
function fakeSpawn(script, captured = {}) {
  return (cliPath, args, options) => {
    captured.cliPath = cliPath
    captured.args = args
    captured.options = options
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    let plan
    child.stdin.end = input => {
      captured.input = input
      plan = script(args)
      const responseFile = args[args.indexOf('--output-last-message') + 1]
      if (plan.reply !== undefined) writeFileSync(responseFile, plan.reply, 'utf8')
      setImmediate(() => {
        if (plan.stdout) child.stdout.emit('data', plan.stdout)
        if (plan.stderr) child.stderr.emit('data', plan.stderr)
        if (!plan.hang) child.emit('close', plan.code ?? 0)
      })
    }
    child.kill = () => setImmediate(() => child.emit('close', plan?.code ?? 1))
    return child
  }
}

const usageEvent = JSON.stringify({
  type: 'turn.completed',
  usage: {
    input_tokens: 120,
    cached_input_tokens: 40,
    cache_write_input_tokens: 8,
    output_tokens: 20,
    reasoning_output_tokens: 6,
  },
})

test('codex runner isolates the CLI, constrains output, and maps usage', async () => {
  const captured = {}
  const runner = new CodexCliRunner({
    cliPath: '/fake/codex',
    spawnImpl: fakeSpawn(args => {
      captured.schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'))
      return { reply: reply(), stdout: `${usageEvent}\n` }
    }, captured),
  })
  const result = await runner.complete(request, undefined, { model: 'gpt-5.6-sol', effort: 'max' })
  assert.equal(result.finishReason, 'tool-calls')
  assert.deepEqual(result.blocks[0], { type: 'tool_call', id: 'c1', name: 'read', arguments: { file_path: 'a.txt' } })
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    outputTokens: 20,
    cacheReadTokens: 40,
    cacheWriteTokens: 8,
    reasoningTokens: 6,
  })
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--output-schema', '--output-last-message']) {
    assert.ok(captured.args.includes(flag), `missing ${flag}`)
  }
  assert.equal(captured.args[captured.args.indexOf('--sandbox') + 1], 'read-only')
  assert.equal(captured.args[captured.args.indexOf('--model') + 1], 'gpt-5.6-sol')
  assert.ok(captured.args.includes('model_reasoning_effort="xhigh"'))
  for (const feature of ['apps', 'multi_agent', 'shell_tool', 'unified_exec']) {
    const at = captured.args.findIndex((arg, index) => arg === '--disable' && captured.args[index + 1] === feature)
    assert.notEqual(at, -1, `feature ${feature} was not disabled`)
  }
  assert.equal(captured.args.at(-1), '-')
  assert.match(captured.input, /EXACT_HARNESS_REQUEST_JSON/)
  assert.match(captured.input, /"request_id":"req-1"/)
  assert.equal(captured.schema.additionalProperties, false)
  assert.deepEqual(captured.schema.properties.blocks.items.required, ['type', 'text', 'id', 'name', 'arguments'])
})

test('codex runner rejects tool calls outside the Harness surface', async () => {
  const runner = new CodexCliRunner({
    cliPath: '/fake/codex',
    spawnImpl: fakeSpawn(() => ({
      reply: reply({
        blocks: [{ type: 'tool_call', text: null, id: 'x', name: 'delete_everything', arguments: '{}' }],
      }),
      stdout: `${usageEvent}\n`,
    })),
  })
  await assert.rejects(runner.complete(request, undefined, {}), /unavailable Harness tool/)
})

test('codex runner classifies CLI exits and timeouts', async () => {
  const rateLimited = new CodexCliRunner({
    cliPath: '/fake/codex',
    spawnImpl: fakeSpawn(() => ({ code: 1, stderr: 'Usage limit reached; retry later' })),
  })
  await assert.rejects(rateLimited.complete(request, undefined, {}), error => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'RATE_LIMIT')
    return true
  })

  const timedOut = new CodexCliRunner({
    cliPath: '/fake/codex',
    timeoutMs: 30,
    spawnImpl: fakeSpawn(() => ({ hang: true, code: 1 })),
  })
  await assert.rejects(timedOut.complete(request, undefined, {}), error => {
    assert.equal(error.code, 'TIMEOUT')
    return true
  })
})

test('codex adapter lists models, emits usage, and surfaces aborts', async () => {
  const runner = new CodexCliRunner({
    cliPath: '/fake/codex',
    spawnImpl: fakeSpawn(() => ({
      reply: reply({
        blocks: [{ type: 'text', text: 'READY', id: null, name: null, arguments: null }],
        finishReason: 'stop',
      }),
      stdout: `${usageEvent}\n`,
    })),
  })
  const adapter = new CodexCliAdapter(runner, 'shiro-codex', ['gpt-5.6-sol', 'gpt-6-astra'])
  assert.deepEqual((await adapter.listModels('shiro-codex')).map(model => model.id), ['gpt-5.6-sol', 'gpt-6-astra'])
  await assert.rejects(adapter.resolveModel('shiro-codex', 'unknown'), /unknown Codex model/)
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'shiro-codex', model: 'gpt-5.6-sol', messages: request.messages, tools: request.tools,
  })) chunks.push(chunk)
  assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.inputTokens, 120)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })

  const controller = new AbortController()
  const hanging = new CodexCliAdapter(new CodexCliRunner({
    cliPath: '/fake/codex',
    spawnImpl: fakeSpawn(() => ({ hang: true, code: 1 })),
  }), 'shiro-codex', ['gpt-5.6-sol'])
  const pending = (async () => {
    const out = []
    for await (const chunk of hanging.stream({
      provider: 'shiro-codex', model: 'gpt-5.6-sol', messages: request.messages, tools: request.tools,
      signal: controller.signal,
    })) out.push(chunk)
    return out
  })()
  setTimeout(() => controller.abort(), 20)
  assert.equal((await pending).at(-1).reason.kind, 'aborted')
})
