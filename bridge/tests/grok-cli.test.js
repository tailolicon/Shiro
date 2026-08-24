import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { GrokCliRunner } from '../src/grok-cli.js'
import { GrokBuildAdapter } from '../src/index.js'
import { RelayError } from '../src/chatgpt-relay.js'

const request = {
  request_id: 'req-1',
  session_id: null,
  purpose: 'conversation',
  provider: 'shiro-grok',
  model: 'grok-4.6',
  system: 'system prompt',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [{ name: 'read' }, { name: 'pwsh' }],
  generation: { reasoning_effort: 'standard', speed_profile: 'balanced' },
}

/**
 * Fake `spawn` producing a scripted child process. `script` receives the
 * argv and returns { code, stdout, stderr, hang } — `hang` children only
 * close after kill() (for timeout/abort tests).
 */
function fakeSpawn(script, captured = {}) {
  return (cliPath, args) => {
    captured.cliPath = cliPath
    captured.args = args
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const plan = script(args)
    child.kill = () => setImmediate(() => child.emit('close', plan.code ?? 1))
    setImmediate(() => {
      if (plan.stdout) child.stdout.emit('data', plan.stdout)
      if (plan.stderr) child.stderr.emit('data', plan.stderr)
      if (!plan.hang) child.emit('close', plan.code ?? 0)
    })
    return child
  }
}

function envelope(overrides = {}) {
  return JSON.stringify({
    text: '',
    stopReason: 'end_turn',
    thought: '',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 8,
      reasoning_tokens: 6,
      total_tokens: 168,
    },
    structuredOutput: {
      blocks: [{ type: 'tool_call', id: 'c1', name: 'read', arguments: { file_path: 'a.txt' } }],
      finishReason: 'tool-calls',
    },
    ...overrides,
  })
}

test('grok runner maps structuredOutput, thought and usage into a Harness reply', async () => {
  const captured = {}
  const runner = new GrokCliRunner({
    cliPath: 'C:/fake/grok.exe',
    spawnImpl: fakeSpawn(() => ({ stdout: envelope({ thought: 'planning the read' }) }), captured),
  })
  const result = await runner.complete(request, undefined, { model: 'grok-4.6', effort: 'max' })
  assert.equal(result.finishReason, 'tool-calls')
  assert.deepEqual(result.blocks[0], { type: 'reasoning', text: 'planning the read' })
  assert.equal(result.blocks[1].type, 'tool_call')
  assert.equal(result.blocks[1].name, 'read')
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 40,
    cacheWriteTokens: 8,
    reasoningTokens: 6,
  })
})

test('grok runner disables the CLI agent surface and maps efforts onto CLI levels', async () => {
  const captured = {}
  const runner = new GrokCliRunner({
    cliPath: 'C:/fake/grok.exe',
    spawnImpl: fakeSpawn((args) => {
      // The prompt travels by file (Windows argv limit); capture its content
      // while the temp file still exists.
      const promptFile = args[args.indexOf('--prompt-file') + 1]
      captured.prompt = readFileSync(promptFile, 'utf8')
      return { stdout: envelope() }
    }, captured),
  })
  await runner.complete(request, undefined, { model: 'grok-4.5', effort: 'light' })
  for (const flag of ['--tools=', '--no-subagents', '--no-plan', '--disable-web-search', '--verbatim', '--json-schema']) {
    assert.ok(captured.args.includes(flag), `missing ${flag}`)
  }
  assert.equal(captured.args[captured.args.indexOf('--max-turns') + 1], '2')
  assert.equal(captured.args[captured.args.indexOf('-m') + 1], 'grok-4.5')
  assert.equal(captured.args[captured.args.indexOf('--reasoning-effort') + 1], 'low')
  assert.match(captured.prompt, /EXACT_HARNESS_REQUEST_JSON/)
  assert.match(captured.prompt, /"request_id":"req-1"/)
  // The CLI path is schema-constrained, so it keeps the unfenced instruction.
  assert.match(captured.prompt, /no Markdown fence/)
})

test('grok runner rejects tool calls that are not in the Harness tool list', async () => {
  const runner = new GrokCliRunner({
    cliPath: 'C:/fake/grok.exe',
    spawnImpl: fakeSpawn(() => ({
      stdout: envelope({
        structuredOutput: { blocks: [{ type: 'tool_call', id: 'x', name: 'delete_everything', arguments: {} }] },
      }),
    })),
  })
  await assert.rejects(runner.complete(request, undefined, {}), /unavailable Harness tool/)
})

test('grok runner classifies failure exits with retryable codes', async () => {
  const rateLimited = new GrokCliRunner({
    cliPath: 'C:/fake/grok.exe',
    spawnImpl: fakeSpawn(() => ({ code: 1, stderr: 'Error: rate limit exceeded, retry later' })),
  })
  await assert.rejects(rateLimited.complete(request, undefined, {}), (error) => {
    assert.ok(error instanceof RelayError)
    assert.equal(error.code, 'RATE_LIMIT')
    return true
  })

  const generic = new GrokCliRunner({
    cliPath: 'C:/fake/grok.exe',
    spawnImpl: fakeSpawn(() => ({ code: 3, stderr: 'boom' })),
  })
  await assert.rejects(generic.complete(request, undefined, {}), (error) => {
    assert.equal(error.code, 'SERVER')
    return true
  })

  const missing = new GrokCliRunner({
    cliPath: 'C:/fake/grok.exe',
    spawnImpl: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
      return child
    },
  })
  await assert.rejects(missing.complete(request, undefined, {}), (error) => {
    assert.equal(error.code, 'TRANSPORT')
    return true
  })
})

test('grok runner times out hung CLI calls with a retryable TIMEOUT', async () => {
  const runner = new GrokCliRunner({
    cliPath: 'C:/fake/grok.exe',
    timeoutMs: 30,
    spawnImpl: fakeSpawn(() => ({ hang: true, code: 1 })),
  })
  await assert.rejects(runner.complete(request, undefined, {}), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    return true
  })
})

test('grok adapter surfaces a user abort as an aborted finish', async () => {
  const controller = new AbortController()
  const runner = new GrokCliRunner({
    cliPath: 'C:/fake/grok.exe',
    spawnImpl: fakeSpawn(() => ({ hang: true, code: 1 })),
  })
  const adapter = new GrokBuildAdapter(runner, 'shiro-grok', ['grok-4.6'])
  const pending = (async () => {
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'shiro-grok', model: 'grok-4.6', messages: request.messages, tools: request.tools,
      signal: controller.signal,
    })) chunks.push(chunk)
    return chunks
  })()
  setTimeout(() => controller.abort(), 20)
  const chunks = await pending
  assert.deepEqual(chunks.at(-1).reason.kind, 'aborted')
})

test('grok adapter lists its models, rejects unknown ones, and honors max_tokens stops', async () => {
  const runner = new GrokCliRunner({
    cliPath: 'C:/fake/grok.exe',
    spawnImpl: fakeSpawn(() => ({
      stdout: envelope({
        stopReason: 'max_tokens',
        structuredOutput: { blocks: [{ type: 'text', text: 'partial…' }] },
      }),
    })),
  })
  const adapter = new GrokBuildAdapter(runner, 'shiro-grok', ['grok-4.6', 'grok-4.5'])
  const models = await adapter.listModels('shiro-grok')
  assert.deepEqual(models.map(model => model.id), ['grok-4.6', 'grok-4.5'])
  assert.equal(models[0].reasoning.defaultEffort, 'standard')
  await assert.rejects(adapter.resolveModel('shiro-grok', 'grok-99'), /unknown Grok model/)

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'shiro-grok', model: 'grok-4.6', messages: request.messages, tools: request.tools,
  })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.equal(usage.usage.inputTokens, 100)
})
