import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionRoot } from '../src/session-root.js'

const FALLBACK = '/home/user/Projects/Shiro'

/** The shape dsh hands a tool: exec.agent.session.header.cwd, often absent. */
function exec(cwd) {
  return { agent: { session: { header: cwd === undefined ? {} : { cwd } } } }
}

test('a session anchored elsewhere moves the tool with it', () => {
  assert.equal(sessionRoot(exec('/home/user/Projects/other-app'), FALLBACK), '/home/user/Projects/other-app')
  assert.equal(sessionRoot(exec('/home/user/Projects/other-app/'), FALLBACK), '/home/user/Projects/other-app')
  // Normalized, so a traversal in the header cannot land somewhere unexpected.
  assert.equal(sessionRoot(exec('/home/user/Projects/a/../b'), FALLBACK), '/home/user/Projects/b')
})

test('every non-session caller keeps the configured project root', () => {
  // No agent at all: a direct registry call, not an agent turn.
  assert.equal(sessionRoot({}, FALLBACK), FALLBACK)
  assert.equal(sessionRoot(undefined, FALLBACK), FALLBACK)
  // An agent whose session simply has no cwd (see the engine's resume tests).
  assert.equal(sessionRoot(exec(undefined), FALLBACK), FALLBACK)
  assert.equal(sessionRoot({ agent: {} }, FALLBACK), FALLBACK)
})

test('a cwd that is not a usable absolute path never reanchors the tool', () => {
  // A relative cwd would silently resolve against the bridge process's own
  // working directory, which is never what the session meant.
  assert.equal(sessionRoot(exec('relative/path'), FALLBACK), FALLBACK)
  assert.equal(sessionRoot(exec(''), FALLBACK), FALLBACK)
  assert.equal(sessionRoot(exec('   '), FALLBACK), FALLBACK)
  assert.equal(sessionRoot(exec('/tmp/with\0nul'), FALLBACK), FALLBACK)
  assert.equal(sessionRoot(exec(42), FALLBACK), FALLBACK)
  assert.equal(sessionRoot(exec(null), FALLBACK), FALLBACK)
})
