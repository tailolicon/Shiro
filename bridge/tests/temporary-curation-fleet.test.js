import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Resolved from this file, not from the working directory: `node --test` may be
// run from the repository root or from bridge/, and a cwd-relative path made the
// suite pass or fail depending on which.
const scriptPath = fileURLToPath(new URL('../../scripts/ChatGPT-Temporary-Curation-30m.console.js', import.meta.url))
const expectedPromptSha256 = '3858472f9594294ddab028ac6967ef56f246c62c9aefd27bb4b2788bc7e6e973'

function embeddedPrompt(script) {
  const marker = 'const PROMPT = String.raw`'
  const start = script.indexOf(marker)
  assert.notEqual(start, -1, 'console script must embed the worker prompt')
  const contentStart = start + marker.length
  const contentEnd = script.indexOf('`;\n\n  const INTERVAL_MS', contentStart)
  assert.notEqual(contentEnd, -1, 'console script must terminate the embedded worker prompt')
  return script.slice(contentStart, contentEnd)
}

test('temporary curation fleet embeds the supplied prompt exactly', async () => {
  const script = await fs.readFile(scriptPath, 'utf8')
  const prompt = embeddedPrompt(script).replaceAll('\r\n', '\n')
  assert.equal(createHash('sha256').update(prompt).digest('hex'), expectedPromptSha256)
})

test('temporary curation fleet requires ten live tabs and uses bounded staggered scheduling', async () => {
  const script = await fs.readFile(scriptPath, 'utf8')
  assert.match(script, /const INTERVAL_MS = 30 \* 60 \* 1000;/)
  assert.match(script, /const FLEET_SIZE = 5;/)
  assert.match(script, /activeFleet\.length !== FLEET_SIZE/)
  assert.match(script, /if \(activeFleet\.length === FLEET_SIZE\)/)
  assert.match(script, /const initialDelay = \(fleetSlot - 1\) \* START_STAGGER_MS;/)
  assert.match(script, /const MAX_SENDS_PER_TEMP_CHAT = 12;/)
  assert.match(script, /const MAX_HEAP_RATIO = 0\.80;/)
  assert.doesNotMatch(script, /URL parameter/)
})

test('temporary curation fleet fails closed on Temporary Chat and slot ownership', async () => {
  const script = await fs.readFile(scriptPath, 'utf8')
  assert.match(script, /if \(!temporaryEvidence\)/)
  assert.match(script, /if \(!temporaryChatEvidence\(\)\)/)
  assert.match(script, /if \(!ownsFleetSlot\(\)\)/)
  assert.match(script, /all \$\{FLEET_SIZE\} fleet slots are already active/)
  assert.match(script, /ChatGPT is still generating; skipped this 30-minute slot/)
})
