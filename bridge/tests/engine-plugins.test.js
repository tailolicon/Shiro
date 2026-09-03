import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverLanguageServers, GENERATED_BLOCK_END, GENERATED_BLOCK_START,
  KNOWN_LANGUAGE_SERVERS, mergeProfilePatch, renderOptionalPluginBlock, resolveHooksConfigPath,
} from '../src/engine-plugins.js'

test('the language-server table contains only what is installed', () => {
  const installed = new Set(['clangd', 'gopls'])
  const servers = discoverLanguageServers({ probe: command => installed.has(command) })
  assert.deepEqual(Object.keys(servers).sort(), ['clangd', 'go'])
  assert.equal(servers.go.command, 'gopls')
  assert.deepEqual(servers.go.args, ['serve'])
  assert.equal(servers.clangd.extensionToLanguage['.cpp'], 'cpp')

  // Nothing installed means an EMPTY table, which is the signal to leave the
  // plugin disabled: its config requires a non-empty table.
  assert.deepEqual(discoverLanguageServers({ probe: () => false }), {})
})

test('every known language server declares a command and an extension map', () => {
  for (const [id, entry] of Object.entries(KNOWN_LANGUAGE_SERVERS)) {
    assert.equal(typeof entry.command, 'string', `${id} command`)
    assert.notEqual(entry.command, '', `${id} command`)
    assert.ok(Array.isArray(entry.args), `${id} args`)
    assert.ok(Object.keys(entry.extensionToLanguage).length > 0, `${id} extensionToLanguage`)
    for (const extension of Object.keys(entry.extensionToLanguage)) {
      assert.match(extension, /^\.[a-z]+$/, `${id} extension ${extension}`)
    }
  }
})

test('the discovered table is what dsh-lsp-stdio expects, shape for shape', () => {
  const servers = discoverLanguageServers({ probe: command => command === 'rust-analyzer' })
  const entry = servers.rust
  // command/args/extensionToLanguage are the required LspLocalServerConfig
  // fields; everything else in that schema has a default.
  assert.deepEqual(Object.keys(entry).sort(), ['args', 'command', 'extensionToLanguage'])
  assert.ok(JSON.parse(JSON.stringify(servers)), 'the table has to survive JSON transport through the environment')
})

async function hooksFixture() {
  const base = await mkdtemp(join(tmpdir(), 'shiro-hooks-'))
  const projectRoot = join(base, 'project')
  const runtimeRoot = join(base, 'runtime')
  const outside = join(base, 'elsewhere')
  for (const directory of [projectRoot, runtimeRoot, outside]) await mkdir(directory, { recursive: true })
  await writeFile(join(projectRoot, 'hooks.json'), '{}')
  await writeFile(join(runtimeRoot, 'hooks.json'), '{}')
  await writeFile(join(outside, 'hooks.json'), '{"evil":true}')
  return { base, projectRoot, runtimeRoot, outside, cleanup: () => rm(base, { recursive: true, force: true }) }
}

test('hooks stay off unless a path is named explicitly', async () => {
  const { projectRoot, runtimeRoot, cleanup } = await hooksFixture()
  try {
    // No implicit discovery: an unset value is not "look for hooks.json".
    assert.equal(resolveHooksConfigPath(undefined, { projectRoot, runtimeRoot }), '')
    assert.equal(resolveHooksConfigPath('', { projectRoot, runtimeRoot }), '')
    assert.equal(resolveHooksConfigPath('   ', { projectRoot, runtimeRoot }), '')
  } finally {
    await cleanup()
  }
})

test('a hooks config is accepted from the project root or the runtime directory', async () => {
  const { projectRoot, runtimeRoot, cleanup } = await hooksFixture()
  try {
    assert.equal(resolveHooksConfigPath(join(projectRoot, 'hooks.json'), { projectRoot, runtimeRoot }), join(projectRoot, 'hooks.json'))
    assert.equal(resolveHooksConfigPath(join(runtimeRoot, 'hooks.json'), { projectRoot, runtimeRoot }), join(runtimeRoot, 'hooks.json'))
    // A relative path resolves against the project root, not the process cwd.
    assert.equal(resolveHooksConfigPath('hooks.json', { projectRoot, runtimeRoot }), join(projectRoot, 'hooks.json'))
  } finally {
    await cleanup()
  }
})

test('a hooks config from anywhere else is refused, because hooks run shell commands', async () => {
  const { projectRoot, runtimeRoot, outside, cleanup } = await hooksFixture()
  try {
    assert.throws(
      () => resolveHooksConfigPath(join(outside, 'hooks.json'), { projectRoot, runtimeRoot }),
      /outside the project root and the Shiro runtime directory/,
    )
    // Traversal out of the project root is the same refusal.
    assert.throws(
      () => resolveHooksConfigPath('../elsewhere/hooks.json', { projectRoot, runtimeRoot }),
      /outside the project root/,
    )
    // A path inside the roots that does not exist is refused too, rather than
    // being handed to the plugin to fail on later.
    assert.throws(
      () => resolveHooksConfigPath(join(projectRoot, 'missing.json'), { projectRoot, runtimeRoot }),
      /does not exist or is not a regular file/,
    )
    assert.throws(() => resolveHooksConfigPath(join(projectRoot, 'hooks.json'), {}), /requires the project root/)
  } finally {
    await cleanup()
  }
})

test('nothing mountable renders no rows at all', () => {
  // The point of generating rows: a plugin that cannot work is not declared,
  // rather than declared and disabled in front of a loader that validates
  // every field at boot.
  assert.equal(renderOptionalPluginBlock({}), '')
  assert.equal(renderOptionalPluginBlock({ lspServers: {}, hooksConfigPath: '' }), '')
})

test('the rendered block is the shape the loader expects', () => {
  const block = renderOptionalPluginBlock({
    lspServers: { clangd: { command: 'clangd', args: ['--background-index'], extensionToLanguage: { '.c': 'c' } } },
    hooksConfigPath: '/home/me/Projects/Shiro/hooks.json',
    model: 'GPT-5.6 Sol',
  })
  assert.ok(block.startsWith(GENERATED_BLOCK_START))
  assert.ok(block.endsWith(GENERATED_BLOCK_END))
  assert.match(block, /^- insert:$/m)
  assert.match(block, /name: '@deepseek-ai\/dsh-lsp'/)
  assert.match(block, /name: '@deepseek-ai\/dsh-lsp-stdio'/)
  assert.match(block, /name: '@deepseek-ai\/dsh-hooks-codex'/)
  // The server table travels as a JSON literal, which is valid YAML.
  const servers = JSON.parse(/servers: (\{.*\})$/m.exec(block)[1])
  assert.equal(servers.clangd.command, 'clangd')
  assert.match(block, /configPath: '\/home\/me\/Projects\/Shiro\/hooks\.json'/)
})

test('only the applicable half is rendered', () => {
  const lspOnly = renderOptionalPluginBlock({ lspServers: { go: { command: 'gopls', args: [], extensionToLanguage: { '.go': 'go' } } } })
  assert.match(lspOnly, /dsh-lsp-stdio/)
  assert.doesNotMatch(lspOnly, /hooks-codex/)

  const hooksOnly = renderOptionalPluginBlock({ hooksConfigPath: '/p/hooks.json' })
  assert.match(hooksOnly, /hooks-codex/)
  assert.doesNotMatch(hooksOnly, /dsh-lsp/)
})

test('a single quote in a path cannot break out of the YAML string', () => {
  const block = renderOptionalPluginBlock({ hooksConfigPath: "/p/it's/hooks.json" })
  assert.match(block, /configPath: '\/p\/it''s\/hooks\.json'/)
})

test('merging preserves what the operator wrote by hand', () => {
  // The profile patch is also where the bridge is pinned; regenerating the
  // block must never touch that.
  const pin = "- id: llm-shiro-harness-bridge\n  name: file:///home/me/bridge/src/index.js\n  config:\n    waitMs: 25001\n"
  const block = renderOptionalPluginBlock({ hooksConfigPath: '/p/hooks.json' })

  const first = mergeProfilePatch(pin, block)
  assert.ok(first.includes('waitMs: 25001'), 'the pin survives')
  assert.ok(first.includes('hooks-codex'))

  // Regenerating replaces the block in place instead of appending a second one.
  const second = mergeProfilePatch(first, block)
  assert.equal(second, first)
  assert.equal(second.split(GENERATED_BLOCK_START).length - 1, 1)

  // And when nothing is mountable any more, the block is removed cleanly.
  const cleared = mergeProfilePatch(second, '')
  assert.ok(cleared.includes('waitMs: 25001'))
  assert.ok(!cleared.includes('hooks-codex'))
  assert.ok(!cleared.includes(GENERATED_BLOCK_START))
})

test('merging into an empty or absent patch file works', () => {
  const block = renderOptionalPluginBlock({ hooksConfigPath: '/p/hooks.json' })
  assert.ok(mergeProfilePatch('', block).startsWith(GENERATED_BLOCK_START))
  assert.equal(mergeProfilePatch('', ''), '')
  assert.equal(mergeProfilePatch(undefined, ''), '')
})
