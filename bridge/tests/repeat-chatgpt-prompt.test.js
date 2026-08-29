import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  nextScheduledTime,
  normalizeLoopbackRelayUrl,
  parseRepeatPromptArgs,
  resolveRepeatPromptConfig,
  submitPromptThroughShiro,
} from '../../scripts/Repeat-ChatGPT-Prompt.mjs'

test('repeat prompt CLI defaults to 27 minutes and accepts a prompt file', () => {
  const options = parseRepeatPromptArgs(['--prompt-file', 'prompt.txt', '--wait-first', '--session', 'conversation-1'])
  assert.equal(options.intervalMinutes, 27)
  assert.equal(options.promptFile, 'prompt.txt')
  assert.equal(options.waitFirst, true)
  assert.equal(options.sessionId, 'conversation-1')
  assert.throws(() => parseRepeatPromptArgs(['--interval-minutes', '0', '--prompt', 'hello']), /positive number/)
  assert.throws(() => parseRepeatPromptArgs(['--prompt', 'one', '--prompt-file', 'two.txt']), /either/)
})

test('repeat prompt config reads the Shiro runtime relay settings and multiline prompt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shiro-repeat-prompt-'))
  try {
    const promptFile = path.join(directory, 'prompt.txt')
    const envFile = path.join(directory, 'chatgpt-relay.env')
    await fs.writeFile(promptFile, 'line one\nline two\n', 'utf8')
    await fs.writeFile(envFile, 'PORT=23158\nAPI_TOKEN=test-token\n', 'utf8')
    const config = await resolveRepeatPromptConfig(
      parseRepeatPromptArgs(['--prompt-file', promptFile]),
      { runtimeEnvPath: envFile, environment: {}, currentDirectory: directory },
    )
    assert.equal(config.prompt, 'line one\nline two\n')
    assert.equal(config.relayUrl, 'http://127.0.0.1:23158')
    assert.equal(config.apiToken, 'test-token')
    assert.equal(config.intervalMs, 27 * 60_000)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('repeat prompt submits through the passive Shiro bridge endpoint', async () => {
  const calls = []
  const result = await submitPromptThroughShiro({
    relayUrl: 'http://127.0.0.1:23158',
    apiToken: 'secret-token',
    prompt: 'continue',
    sessionId: 'conversation-1',
    sourceClientId: 'tab-1',
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return Response.json({ ok: true, result: { submitted: true } })
    },
  })

  assert.equal(result.ok, true)
  assert.equal(calls[0].url, 'http://127.0.0.1:23158/browser/passive-prompt')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    message: 'continue',
    sessionId: 'conversation-1',
    sourceClientId: 'tab-1',
    timeoutMs: 60_000,
  })
})

test('repeat prompt stays loopback-only and skips elapsed schedule slots', () => {
  assert.equal(normalizeLoopbackRelayUrl('http://localhost:23158/'), 'http://localhost:23158')
  assert.throws(() => normalizeLoopbackRelayUrl('https://example.com'), /loopback/)
  assert.equal(nextScheduledTime(1_000, 4_500, 1_000), 5_000)
})
