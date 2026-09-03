import test from 'node:test'
import assert from 'node:assert/strict'
import { subagentAdapter, SUBAGENT_ADAPTERS } from '../src/subagent-adapters.js'

// Real transcripts captured from live, authenticated runs on this machine
// (claude 2.1.251, codex-cli 0.151.0) -- see CONNECTOR_MATURITY.md for the
// probe. grok and antigravity were not signed in when this was written, so
// their fixtures below are synthetic best guesses, matched by
// `SUBAGENT_ADAPTERS.<name>.unverified === true`.

const REAL_CODEX_TRANSCRIPT = [
  '{"type":"thread.started","thread_id":"01a067af-cc3a-7632-928c-50fb482f8cca"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Under-development features enabled: default_mode_request_user_input."}}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I’ll read the file directly and preserve its wording exactly."}}',
  '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/usr/bin/bash -lc \\"sed -n \'1,200p\' note.txt\\""}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/usr/bin/bash -lc \\"sed -n \'1,200p\' note.txt\\""}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"The exact contents are “hello from a probe”."}}',
  '{"type":"turn.completed","usage":{"input_tokens":32498,"cached_input_tokens":27264,"output_tokens":134}}',
].join('\n')

const REAL_CLAUDE_RESULT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: '`note.txt` contains a single line: `hello from a claude -p probe`.',
  session_id: 'c636b664-cf0f-427e-beaa-e2353be987df',
  num_turns: 2,
  usage: { input_tokens: 4, output_tokens: 152, cache_read_input_tokens: 66266 },
  total_cost_usd: 0.242834,
})

test('every adapter is unambiguous about verified vs unverified', () => {
  assert.equal(SUBAGENT_ADAPTERS.claude.unverified, false)
  assert.equal(SUBAGENT_ADAPTERS.codex.unverified, false)
  assert.equal(SUBAGENT_ADAPTERS.grok.unverified, true)
  assert.equal(SUBAGENT_ADAPTERS.antigravity.unverified, true)
})

test('subagentAdapter refuses an unknown name by naming the real options', () => {
  assert.throws(() => subagentAdapter('gpt5'), error => {
    assert.equal(error.code, 'INVALID_ARGUMENT')
    assert.match(error.message, /claude, codex, grok, antigravity/)
    return true
  })
  assert.throws(() => subagentAdapter(undefined), error => error.code === 'INVALID_ARGUMENT')
})

// -- claude -------------------------------------------------------------

test('claude: a fresh dispatch defaults to acceptEdits, no disclaimer needed', () => {
  const argv = SUBAGENT_ADAPTERS.claude.buildArgv({ prompt: 'fix the bug' })
  assert.deepEqual(argv, ['-p', 'fix the bug', '--output-format', 'json', '--permission-mode', 'acceptEdits'])
})

test('claude: resume_from becomes --resume, model becomes --model', () => {
  const argv = SUBAGENT_ADAPTERS.claude.buildArgv({ prompt: 'now add tests', resumeFrom: 'c636b664-cf0f-427e-beaa-e2353be987df', model: 'opus' })
  assert.deepEqual(argv, ['-p', 'now add tests', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--resume', 'c636b664-cf0f-427e-beaa-e2353be987df', '--model', 'opus'])
})

test('claude: bypassPermissions is refused with the exact unlock command, not silently dropped', () => {
  assert.throws(() => SUBAGENT_ADAPTERS.claude.buildArgv({ prompt: 'x', permissionMode: 'bypassPermissions' }), error => {
    assert.equal(error.code, 'PERMISSION_REQUIRED')
    assert.match(error.message, /claude --dangerously-skip-permissions/)
    return true
  })
  // The boolean escape hatch maps to the same gated mode for claude, and is
  // refused the same way rather than silently taking a different, ungated path.
  assert.throws(() => SUBAGENT_ADAPTERS.claude.buildArgv({ prompt: 'x', dangerouslySkipPermissions: true }), error => error.code === 'PERMISSION_REQUIRED')
  // Any other mode passes straight through -- only the disclaimer-gated one is blocked.
  assert.deepEqual(
    SUBAGENT_ADAPTERS.claude.buildArgv({ prompt: 'x', permissionMode: 'dontAsk' }).slice(-2),
    ['--permission-mode', 'dontAsk'],
  )
})

test('claude: parses the real captured JSON result', () => {
  const parsed = SUBAGENT_ADAPTERS.claude.parseTranscript(REAL_CLAUDE_RESULT)
  assert.deepEqual(parsed, {
    done: true,
    success: true,
    threadId: 'c636b664-cf0f-427e-beaa-e2353be987df',
    message: '`note.txt` contains a single line: `hello from a claude -p probe`.',
    subtype: 'success',
    usage: { input_tokens: 4, output_tokens: 152, cached_input_tokens: 66266 },
    turns: 2,
  })
})

test('claude: an is_error result is a done-but-failed turn, not a parse failure', () => {
  const failed = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in', session_id: 'x' })
  const parsed = SUBAGENT_ADAPTERS.claude.parseTranscript(failed)
  assert.equal(parsed.done, true)
  assert.equal(parsed.success, false)
  assert.equal(parsed.message, 'Not logged in')
})

test('claude: no output yet (still running) is reported as not-done, never thrown', () => {
  assert.deepEqual(SUBAGENT_ADAPTERS.claude.parseTranscript(''), { done: false })
  assert.deepEqual(SUBAGENT_ADAPTERS.claude.parseTranscript('   '), { done: false })
  assert.deepEqual(SUBAGENT_ADAPTERS.claude.parseTranscript('not json at all'), { done: false })
})

// -- codex ----------------------------------------------------------------

test('codex: a fresh dispatch sandboxes to workspace-write and sets cwd', () => {
  const argv = SUBAGENT_ADAPTERS.codex.buildArgv({ prompt: 'add a test' })
  assert.deepEqual(argv, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', '.', 'add a test'])
})

test('codex: an explicit sandbox is honoured', () => {
  const argv = SUBAGENT_ADAPTERS.codex.buildArgv({ prompt: 'x', sandbox: 'read-only' })
  assert.deepEqual(argv.slice(3, 5), ['--sandbox', 'read-only'])
})

test('codex: resume drops -C/--sandbox, matching what the real CLI accepts', () => {
  const argv = SUBAGENT_ADAPTERS.codex.buildArgv({ prompt: 'continue', resumeFrom: '01a067af-cc3a-7632-928c-50fb482f8cca' })
  assert.deepEqual(argv, ['exec', 'resume', '01a067af-cc3a-7632-928c-50fb482f8cca', '--json', '--skip-git-repo-check', 'continue'])
  assert.ok(!argv.includes('--sandbox'), 'codex exec resume rejects --sandbox as an unexpected argument')
  assert.ok(!argv.includes('-C'), 'codex exec resume has no -C flag')
})

test('codex: dangerously_skip_permissions has no disclaimer to block, so it passes straight through', () => {
  const argv = SUBAGENT_ADAPTERS.codex.buildArgv({ prompt: 'x', dangerouslySkipPermissions: true })
  assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(!argv.includes('--sandbox'), 'the bypass flag and --sandbox are mutually exclusive on the real CLI')
})

test('codex: parses the real captured NDJSON transcript, non-fatal error item included as a warning', () => {
  const parsed = SUBAGENT_ADAPTERS.codex.parseTranscript(REAL_CODEX_TRANSCRIPT)
  assert.equal(parsed.done, true)
  assert.equal(parsed.success, true)
  assert.equal(parsed.threadId, '01a067af-cc3a-7632-928c-50fb482f8cca')
  // The LAST agent_message is the reply, not the first ("I'll read the file...").
  assert.match(parsed.message, /The exact contents are/)
  assert.deepEqual(parsed.usage, { input_tokens: 32498, output_tokens: 134, cached_input_tokens: 27264 })
  assert.deepEqual(parsed.warnings, ['Under-development features enabled: default_mode_request_user_input.'])
})

test('codex: a trailing incomplete NDJSON line (still streaming) is skipped, not thrown', () => {
  const partial = '{"type":"thread.started","thread_id":"abc"}\n{"type":"item.started","item":{"id":"item_1","typ'
  const parsed = SUBAGENT_ADAPTERS.codex.parseTranscript(partial)
  assert.equal(parsed.done, false)
  assert.equal(parsed.threadId, 'abc', 'the complete leading line still parses')
})

test('codex: turn.failed or a top-level error event ends the turn as failed', () => {
  const failed = '{"type":"thread.started","thread_id":"x"}\n{"type":"turn.failed"}'
  const parsed = SUBAGENT_ADAPTERS.codex.parseTranscript(failed)
  assert.equal(parsed.done, true)
  assert.equal(parsed.success, false)
})

// -- grok and antigravity: unverified, must degrade rather than assume ----

test('grok: argv construction mirrors claude\'s shape, same disclaimer refusal', () => {
  assert.deepEqual(SUBAGENT_ADAPTERS.grok.buildArgv({ prompt: 'x' }), ['-p', 'x', '--output-format', 'json'])
  assert.throws(() => SUBAGENT_ADAPTERS.grok.buildArgv({ prompt: 'x', permissionMode: 'bypassPermissions' }), error => error.code === 'PERMISSION_REQUIRED')
  assert.deepEqual(
    SUBAGENT_ADAPTERS.grok.buildArgv({ prompt: 'x', resumeFrom: 'sess-1' }),
    ['-p', 'x', '--output-format', 'json', '--resume', 'sess-1'],
  )
})

test('grok: a plausible result shape parses even though it was never run for real', () => {
  const guess = JSON.stringify({ result: 'the answer', session_id: 'sess-1', usage: { input_tokens: 10, output_tokens: 5 } })
  const parsed = SUBAGENT_ADAPTERS.grok.parseTranscript(guess)
  assert.equal(parsed.done, true)
  assert.equal(parsed.message, 'the answer')
  assert.equal(parsed.threadId, 'sess-1')
  assert.equal(parsed.unverifiedShape, undefined, 'a recognized shape is not flagged as unrecognized')
})

test('grok: a shape matching none of the guessed keys degrades to the raw JSON, flagged, never thrown', () => {
  const surprising = JSON.stringify({ totally: 'unexpected', nested: { data: 1 } })
  const parsed = SUBAGENT_ADAPTERS.grok.parseTranscript(surprising)
  assert.equal(parsed.done, true)
  assert.equal(parsed.unverifiedShape, true)
  assert.match(parsed.message, /"totally":"unexpected"/)
})

test('antigravity: argv uses --print/--conversation/--mode, matching its own --help text', () => {
  assert.deepEqual(SUBAGENT_ADAPTERS.antigravity.buildArgv({ prompt: 'x' }), ['--print', 'x', '--output-format', 'json', '--mode', 'accept-edits'])
  assert.deepEqual(
    SUBAGENT_ADAPTERS.antigravity.buildArgv({ prompt: 'x', resumeFrom: 'conv-1' }),
    ['--print', 'x', '--output-format', 'json', '--mode', 'accept-edits', '--conversation', 'conv-1'],
  )
})

test('antigravity: no disclaimer is known for its bypass flag, so it is not blocked', () => {
  const argv = SUBAGENT_ADAPTERS.antigravity.buildArgv({ prompt: 'x', dangerouslySkipPermissions: true })
  assert.ok(argv.includes('--dangerously-skip-permissions'))
})

test('antigravity: defensive parsing matches grok\'s degrade-not-throw behaviour', () => {
  assert.deepEqual(SUBAGENT_ADAPTERS.antigravity.parseTranscript(''), { done: false })
  const guess = JSON.stringify({ response: 'ok', conversation_id: 'c-1' })
  const parsed = SUBAGENT_ADAPTERS.antigravity.parseTranscript(guess)
  assert.equal(parsed.message, 'ok')
  assert.equal(parsed.threadId, 'c-1')
})
