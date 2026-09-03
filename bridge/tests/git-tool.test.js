import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIT_TOOLS, gateReason, runGit } from '../src/git-commands.js'

// The DSH wrapper (git-tool.js) imports @deepseek-ai/dsh-tools, a profile-only
// peer, so tests exercise the dependency-free core directly -- the same split
// container-path.js/container-tool.js uses.

const byName = new Map(GIT_TOOLS.map(spec => [spec.name, spec]))

/** Run a tool spec against a real repo the way git-tool.js's execute() does. */
function runTool(name, args, workspaceRoot) {
  const { argv, stdin } = byName.get(name).build(args, workspaceRoot)
  return runGit(workspaceRoot, argv, { stdin })
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'shiro-git-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@shiro.local')
  git('config', 'user.name', 'Shiro Test')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  git('add', 'seed.txt')
  git('commit', '-m', 'seed commit')
  return dir
}

test('all expected git tools exist and read tools are not gated for approval', async () => {
  const dir = initRepo()
  try {
    for (const name of ['git_status', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_add', 'git_commit']) {
      assert.ok(byName.has(name), `missing tool ${name}`)
    }
    const status = await runTool('git_status', {}, dir)
    assert.equal(status.exitCode, 0)
    const log = await runTool('git_log', { count: 5 }, dir)
    assert.match(log.stdout, /seed commit/)
    for (const name of ['git_status', 'git_diff', 'git_log', 'git_show']) {
      assert.equal(gateReason(name, {}), undefined, `${name} should not be gated`)
    }
    assert.equal(gateReason('git_branch', { action: 'list' }), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mutating git calls produce an approval reason', () => {
  assert.equal(gateReason('git_add', { paths: ['a.txt'] }), 'Stage 1 path(s) for commit: a.txt')
  assert.match(gateReason('git_commit', { message: 'x' }), /Create a git commit/)
  assert.equal(gateReason('git_branch', { action: 'create', name: 'feat' }), 'Create and switch to branch "feat"')
  assert.equal(gateReason('git_branch', { action: 'switch', name: 'main' }), 'Switch to branch "main"')
})

test('argv-array execution defeats shell command injection through a path argument', async () => {
  const dir = initRepo()
  try {
    const proof = join(dir, 'pwned.txt')
    // The exact PoC shape that compromised the audited dsh-gitflow plugin.
    const result = await runTool('git_diff', { path: 'x & echo INJECTED > pwned.txt & echo' }, dir)
    assert.equal(existsSync(proof), false, 'no shell ran: the injected redirect never created a file')
    assert.notEqual(result.exitCode, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('commit message travels via stdin verbatim, not through a shell', async () => {
  const dir = initRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    assert.equal((await runTool('git_add', { paths: ['a.txt'] }, dir)).exitCode, 0)
    const nasty = 'subject "; rm -rf / & echo $(whoami)'
    assert.equal((await runTool('git_commit', { message: nasty }, dir)).exitCode, 0)
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(subject, nasty)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('model-supplied paths are confined to the workspace root', () => {
  const add = byName.get('git_add')
  const diff = byName.get('git_diff')
  for (const dir of ['E:\\Project\\Shiro', '/home/tailolicon/Projects/Shiro']) {
    assert.throws(() => add.build({ paths: ['../../etc/passwd'] }, dir), /escapes the workspace/)
    assert.throws(() => diff.build({ path: '../outside' }, dir), /escapes the workspace/)
    assert.throws(() => add.build({ paths: ['C:\\Windows\\system32'] }, dir), /escapes the workspace/)
    assert.throws(() => diff.build({ path: '/etc/passwd' }, dir), /escapes the workspace/)
  }
})

test('branch and ref names that could be read as options or break ref rules are rejected', () => {
  const dir = 'E:\\Project\\Shiro'
  const branch = byName.get('git_branch')
  const show = byName.get('git_show')
  assert.throws(() => branch.build({ action: 'create', name: '-x' }, dir), /must not start with "-"/)
  assert.throws(() => branch.build({ action: 'switch', name: 'a b' }, dir), /not allowed in a git ref/)
  assert.throws(() => branch.build({ action: 'create', name: 'a..b' }, dir), /not allowed in a git ref/)
  assert.throws(() => show.build({ ref: '--upload-pack=calc' }, dir), /must not start with "-"/)
})

test('git_add + git_commit record a commit that git_log then shows', async () => {
  const dir = initRepo()
  try {
    writeFileSync(join(dir, 'feature.txt'), 'new feature\n')
    await runTool('git_add', { paths: ['feature.txt'] }, dir)
    assert.equal((await runTool('git_commit', { message: 'add feature' }, dir)).exitCode, 0)
    const log = await runTool('git_log', { count: 10 }, dir)
    assert.match(log.stdout, /add feature/)
    assert.match(log.stdout, /seed commit/)
    assert.doesNotMatch((await runTool('git_status', {}, dir)).stdout, /feature\.txt/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
