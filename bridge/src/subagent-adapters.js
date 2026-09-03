// One adapter per coding-agent CLI: how to invoke it headlessly, and how to
// read back what it did. Pure and I/O-free on purpose -- argv construction and
// transcript parsing are the parts worth testing without spawning a real CLI,
// and the parts most likely to drift when a CLI's own flags change.
//
// VERIFIED vs UNVERIFIED, and why that distinction is kept visible:
// claude and codex were both live-tested on this machine (real auth, real
// runs) -- their output shapes below are confirmed. grok and antigravity are
// installed but NOT signed in here, so their parsers are built from --help
// text alone and kept deliberately defensive: an unexpected shape must fall
// back to "no structured result yet", never throw. The first authenticated
// run of either is the real test; `unverified: true` on those two adapters is
// carried through to bridge_capabilities so a caller is told, not left to
// find out the hard way.
//
// THE ONE-TIME DISCLAIMER, NOT BYPASSED
// Both claude and grok name a `bypassPermissions` mode that Anthropic/xAI gate
// behind an interactive one-time acceptance (`claude --dangerously-skip-permissions`
// run once, by a person, in a real terminal). Shiro will not script past that:
// requesting it here fails with the exact command to run instead. codex's and
// antigravity's bypass flags carry no such gate and are passed through as
// asked, because there is nothing here to circumvent.

import { fail } from './action-errors.js'

const CLAUDE_BLOCKED_MODES = new Set(['bypassPermissions'])
const GROK_BLOCKED_MODES = new Set(['bypassPermissions'])

function blockDisclaimerGatedMode(mode, blocked, unlockCommand) {
  if (mode !== undefined && blocked.has(mode)) {
    fail('PERMISSION_REQUIRED', `permission_mode "${mode}" needs a one-time interactive disclaimer Shiro will not script past: run "${unlockCommand}" yourself once, in a real terminal, then this mode works from here.`)
  }
}

/** First JSON value in text that parses, scanning from the end -- the CLI's own trailing noise (a stray log line) must not hide a valid final result. */
function lastJsonObject(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return null
  // The common case: the whole (or only remaining) output is one JSON object.
  try {
    const value = JSON.parse(trimmed)
    if (value !== null && typeof value === 'object') return value
  } catch { /* fall through to line scanning */ }
  const lines = trimmed.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object') return value
    } catch { /* keep scanning backward */ }
  }
  return null
}

/** Every complete JSON line, in order, skipping ones that do not parse. */
function jsonLines(text) {
  const lines = String(text ?? '').split('\n')
  const values = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object') values.push(value)
    } catch { /* an incomplete trailing line while still running -- skip it */ }
  }
  return values
}

function usageFrom(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const pick = (...keys) => {
    for (const key of keys) if (Number.isFinite(raw[key])) return raw[key]
    return undefined
  }
  const usage = {
    input_tokens: pick('input_tokens', 'inputTokens'),
    output_tokens: pick('output_tokens', 'outputTokens'),
    cached_input_tokens: pick('cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens'),
  }
  return Object.values(usage).some(value => value !== undefined) ? usage : undefined
}

// -- claude ------------------------------------------------------------------
//
// Verified live: `claude -p <prompt> --output-format json --permission-mode
// acceptEdits` prints exactly one JSON object on completion:
//   {type:"result", subtype:"success"|..., is_error, result:"<text>",
//    session_id, num_turns, usage:{...}, total_cost_usd, duration_ms, ...}
// `--bare` was tried and rejected: it restricts auth to ANTHROPIC_API_KEY,
// which breaks OAuth/subscription accounts (this one included) outright.

const claude = {
  id: 'claude',
  probeAuthArgv: ['auth', 'status'],
  classifyAuth(stdout) {
    try {
      // Only the boolean is read: the rest of this payload is account email
      // and org name, which has no business leaving the machine in a tool result.
      return JSON.parse(stdout).loggedIn === true
    } catch {
      return null
    }
  },
  label: 'Claude Code CLI',
  binary: 'claude',
  unverified: false,
  defaultPermissionMode: 'acceptEdits',
  unlockCommand: 'claude --dangerously-skip-permissions',

  buildArgv({ prompt, resumeFrom, model, permissionMode, dangerouslySkipPermissions }) {
    if (dangerouslySkipPermissions === true) blockDisclaimerGatedMode('bypassPermissions', CLAUDE_BLOCKED_MODES, this.unlockCommand)
    blockDisclaimerGatedMode(permissionMode, CLAUDE_BLOCKED_MODES, this.unlockCommand)
    const mode = permissionMode ?? this.defaultPermissionMode
    const argv = ['-p', prompt, '--output-format', 'json']
    if (mode !== undefined) argv.push('--permission-mode', mode)
    if (typeof resumeFrom === 'string' && resumeFrom !== '') argv.push('--resume', resumeFrom)
    if (typeof model === 'string' && model !== '') argv.push('--model', model)
    return argv
  },

  parseTranscript(stdout) {
    const result = lastJsonObject(stdout)
    if (result === null || result.type !== 'result') return { done: false }
    return {
      done: true,
      success: result.is_error !== true,
      threadId: typeof result.session_id === 'string' ? result.session_id : undefined,
      message: typeof result.result === 'string' ? result.result : undefined,
      subtype: typeof result.subtype === 'string' ? result.subtype : undefined,
      usage: usageFrom(result.usage),
      turns: Number.isFinite(result.num_turns) ? result.num_turns : undefined,
    }
  },
}

// -- codex --------------------------------------------------------------------
//
// Verified live: `codex exec --json --sandbox <mode> -C <dir> <prompt>` streams
// NDJSON as it runs -- thread.started (carries thread_id), item.started/
// completed (agent_message / command_execution / occasional non-fatal "error"
// items -- one such item appeared mid-run in testing and the turn still
// completed successfully, so its presence alone is not failure), turn.completed
// (carries usage). Resume drops -C/--sandbox: `codex exec resume <thread_id>
// --json <prompt>` inherits the original session's own settings.

const codex = {
  id: 'codex',
  probeAuthArgv: ['login', 'status'],
  classifyAuth(stdout, stderr) {
    // Observed live: codex prints this to STDERR, not stdout.
    const text = `${stdout}\n${stderr}`.toLowerCase()
    if (text.includes('not logged in')) return false
    if (text.includes('logged in')) return true
    return null
  },
  label: 'Codex CLI',
  binary: 'codex',
  unverified: false,
  defaultSandbox: 'workspace-write',
  unlockCommand: null, // no disclaimer gate to name; --dangerously-bypass-approvals-and-sandbox just works

  buildArgv({ prompt, resumeFrom, model, sandbox, dangerouslySkipPermissions }) {
    if (typeof resumeFrom === 'string' && resumeFrom !== '') {
      const argv = ['exec', 'resume', resumeFrom, '--json', '--skip-git-repo-check']
      if (typeof model === 'string' && model !== '') argv.push('-m', model)
      if (dangerouslySkipPermissions === true) argv.push('--dangerously-bypass-approvals-and-sandbox')
      argv.push(prompt)
      return argv
    }
    const argv = ['exec', '--json', '--skip-git-repo-check']
    if (dangerouslySkipPermissions === true) {
      argv.push('--dangerously-bypass-approvals-and-sandbox')
    } else {
      argv.push('--sandbox', sandbox ?? this.defaultSandbox)
    }
    if (typeof model === 'string' && model !== '') argv.push('-m', model)
    argv.push('-C', '.', prompt)
    return argv
  },

  parseTranscript(stdout) {
    const events = jsonLines(stdout)
    let threadId
    let message
    let usage
    let done = false
    let success = true
    const warnings = []
    for (const event of events) {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') message = event.item.text
      if (event.type === 'item.completed' && event.item?.type === 'error' && typeof event.item.message === 'string') warnings.push(event.item.message)
      if (event.type === 'turn.completed') { done = true; usage = usageFrom(event.usage) }
      if (event.type === 'turn.failed' || event.type === 'error') { done = true; success = false }
    }
    return { done, success, threadId, message, usage, warnings: warnings.length > 0 ? warnings : undefined }
  },
}

// -- grok -----------------------------------------------------------------
//
// UNVERIFIED: this account is not signed in to Grok CLI (`grok login`), so
// `grok -p <prompt> --output-format json` has not been run for real. Built
// from `grok --help` text only: --output-format json is documented as a
// single-result mode (distinct from the streaming-json/streaming-messages-json
// NDJSON variants), and --resume takes a session id or title. The key names
// below are a best guess at the common shape other single-result CLIs use;
// parseTranscript is written to degrade to "no result yet" on any mismatch
// rather than throw, so a wrong guess fails soft. Update the key names here
// once a real transcript exists.

const grok = {
  id: 'grok',
  probeAuthArgv: ['models'],
  classifyAuth(stdout) {
    if (/not authenticated/i.test(stdout)) return false
    if (/available models/i.test(stdout)) return true
    return null
  },
  label: 'Grok Build CLI',
  binary: 'grok',
  unverified: true,
  unlockCommand: 'grok --permission-mode bypassPermissions (interactively, once)',

  buildArgv({ prompt, resumeFrom, model, permissionMode, dangerouslySkipPermissions }) {
    if (dangerouslySkipPermissions === true) blockDisclaimerGatedMode('bypassPermissions', GROK_BLOCKED_MODES, this.unlockCommand)
    blockDisclaimerGatedMode(permissionMode, GROK_BLOCKED_MODES, this.unlockCommand)
    const argv = ['-p', prompt, '--output-format', 'json']
    if (permissionMode !== undefined) argv.push('--permission-mode', permissionMode)
    if (typeof resumeFrom === 'string' && resumeFrom !== '') argv.push('--resume', resumeFrom)
    if (typeof model === 'string' && model !== '') argv.push('-m', model)
    return argv
  },

  parseTranscript(stdout) {
    const result = lastJsonObject(stdout)
    if (result === null) return { done: false }
    // Defensive key scanning: the exact field names are unconfirmed (see the
    // module comment), so several plausible spellings are tried in order.
    const message = firstString(result, ['result', 'response', 'text', 'message', 'content'])
    const threadId = firstString(result, ['session_id', 'sessionId', 'thread_id', 'threadId'])
    if (message === undefined && threadId === undefined && result.usage === undefined) {
      // Nothing recognizable came back; report the raw JSON rather than
      // silently claiming there is no result.
      return { done: true, success: true, message: JSON.stringify(result), unverifiedShape: true }
    }
    return { done: true, success: result.error === undefined && result.is_error !== true, threadId, message, usage: usageFrom(result.usage) }
  },
}

// -- antigravity ------------------------------------------------------------
//
// UNVERIFIED for the same reason: `agy` (confirmed real, installed at
// ~/.local/bin/agy, v1.1.25) is not signed in on this machine. Flags are from
// `agy --help`: --print/-p for one-shot, --output-format json for a single
// result, --conversation <id> to resume, --mode accept-edits|plan for the
// permission surface (no bypassPermissions-style value was documented, so
// nothing is blocked here), --dangerously-skip-permissions as a plain boolean
// with no disclaimer step observed.

const antigravity = {
  id: 'antigravity',
  probeAuthArgv: ['models'],
  classifyAuth(stdout, stderr) {
    const text = `${stdout}\n${stderr}`
    if (/sign in/i.test(text)) return false
    if (/available|^-|^\*/im.test(text)) return true
    return null
  },
  label: 'Antigravity CLI',
  binary: 'agy',
  unverified: true,
  defaultMode: 'accept-edits',

  buildArgv({ prompt, resumeFrom, model, permissionMode, dangerouslySkipPermissions }) {
    const argv = ['--print', prompt, '--output-format', 'json']
    argv.push('--mode', permissionMode ?? this.defaultMode)
    if (dangerouslySkipPermissions === true) argv.push('--dangerously-skip-permissions')
    if (typeof resumeFrom === 'string' && resumeFrom !== '') argv.push('--conversation', resumeFrom)
    if (typeof model === 'string' && model !== '') argv.push('--model', model)
    return argv
  },

  parseTranscript(stdout) {
    const result = lastJsonObject(stdout)
    if (result === null) return { done: false }
    const message = firstString(result, ['result', 'response', 'text', 'message', 'content'])
    const threadId = firstString(result, ['conversation_id', 'conversationId', 'session_id', 'sessionId'])
    if (message === undefined && threadId === undefined) {
      return { done: true, success: true, message: JSON.stringify(result), unverifiedShape: true }
    }
    return { done: true, success: result.error === undefined && result.is_error !== true, threadId, message, usage: usageFrom(result.usage) }
  },
}

function firstString(object, keys) {
  for (const key of keys) if (typeof object?.[key] === 'string' && object[key] !== '') return object[key]
  return undefined
}

export const SUBAGENT_ADAPTERS = Object.freeze({ claude, codex, grok, antigravity })

export function subagentAdapter(name) {
  const adapter = SUBAGENT_ADAPTERS[String(name ?? '')]
  if (adapter === undefined) {
    fail('INVALID_ARGUMENT', `agent must be one of ${Object.keys(SUBAGENT_ADAPTERS).join(', ')}, got "${name}"`)
  }
  return adapter
}
