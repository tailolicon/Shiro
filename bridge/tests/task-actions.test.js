import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../src/sandbox.js'
import { listTasks, runTask, runTests } from '../src/task-actions.js'

// npm is the runner every Node install ships with, so the fixture deliberately
// carries a package-lock.json: the discovery must pick the manager the project
// declares, not a hardcoded default.
async function fixture({ withTests = true, withMake = true, withPackages = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shiro-task-'))
  await writeFile(join(root, 'package-lock.json'), '{}')
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: {
      ...(withTests ? { test: 'node -e "console.log(\'tests ok\', process.argv.slice(1).join(\',\'))"' } : {}),
      lint: 'node -e "process.exit(2)"',
      echo: 'node -e "console.log(process.env.FIXTURE_FLAG || \'unset\')"',
    },
  }, null, 2))
  if (withMake) await writeFile(join(root, 'Makefile'), '.PHONY: build\n\nbuild:\n\t@echo built\n\nclean:\n\t@echo cleaned\n\nVAR := value\n')
  if (withPackages) {
    await mkdir(join(root, 'pkg'))
    await writeFile(join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'inner', scripts: { test: 'node -e "console.log(\'inner\')"' } }))
  }
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', scripts: { test: 'exit 1' } }))
  return { root, sandbox: new Sandbox(root), cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

test('task_list discovers package scripts and Make targets without running anything', async () => {
  const { sandbox, cleanup } = await fixture()
  try {
    const catalog = await listTasks(sandbox, {})
    const names = catalog.tasks.map(task => task.name)
    assert.ok(names.includes('test'))
    assert.ok(names.includes('lint'))
    assert.ok(names.includes('pkg:test'))
    assert.ok(names.includes('make:build'))
    assert.ok(names.includes('make:clean'))
    assert.ok(!names.some(name => name.startsWith('node_modules')), 'dependency scripts must never be offered as project tasks')
    assert.ok(!names.includes('make:VAR'), 'variable assignments are not targets')
    assert.ok(!names.includes('make:.PHONY'))

    assert.equal(catalog.tasks.find(task => task.name === 'test').package_manager, 'npm')
    assert.equal(catalog.tasks.find(task => task.name === 'test').command, 'npm run test')
    assert.equal(catalog.tasks.find(task => task.name === 'pkg:test').cwd, 'pkg')

    const rootOnly = await listTasks(sandbox, { include_packages: false })
    assert.ok(!rootOnly.tasks.some(task => task.name === 'pkg:test'))
  } finally {
    await cleanup()
  }
})

test('task_run executes one declared task and refuses anything undeclared', async () => {
  const { sandbox, cleanup } = await fixture()
  try {
    const passing = await runTask(sandbox, { name: 'test' })
    assert.equal(passing.passed, true)
    assert.equal(passing.exit_code, 0)
    assert.match(passing.stdout, /tests ok/)

    const failing = await runTask(sandbox, { name: 'lint' })
    assert.equal(failing.passed, false)
    assert.equal(failing.exit_code, 2)

    const inner = await runTask(sandbox, { name: 'pkg:test' })
    assert.equal(inner.cwd, 'pkg')
    assert.match(inner.stdout, /inner/)

    const made = await runTask(sandbox, { name: 'make:build' })
    assert.equal(made.source, 'Makefile')
    assert.match(made.stdout, /built/)

    const withEnv = await runTask(sandbox, { name: 'echo', env: { FIXTURE_FLAG: 'on' } })
    assert.match(withEnv.stdout, /on/)

    // Only declared names run; there is no free-form command channel.
    await rejects(runTask(sandbox, { name: 'rm -rf /' }), 'NOT_FOUND')
    await rejects(runTask(sandbox, { name: 'node_modules/dep:test' }), 'NOT_FOUND')
    await rejects(runTask(sandbox, {}), 'INVALID_ARGUMENT')
    await rejects(runTask(sandbox, { name: 'test', args: [1] }), 'INVALID_ARGUMENT')
  } finally {
    await cleanup()
  }
})

test('test_run finds the declared suite, forwards filters, and explains itself when there is none', async () => {
  const { sandbox, cleanup } = await fixture()
  try {
    const run = await runTests(sandbox, {})
    assert.equal(run.task, 'test')
    assert.equal(run.passed, true)

    const filtered = await runTests(sandbox, { filter: 'only-this' })
    assert.match(filtered.stdout, /only-this/)

    const explicit = await runTests(sandbox, { task: 'pkg:test' })
    assert.equal(explicit.task, 'pkg:test')

    await rejects(runTests(sandbox, { task: 'nope' }), 'NOT_FOUND')
  } finally {
    await cleanup()
  }
})

test('test_run reports UNSUPPORTED with the real task list rather than guessing a command', async () => {
  const { sandbox, cleanup } = await fixture({ withTests: false, withMake: false, withPackages: false })
  try {
    await assert.rejects(runTests(sandbox, {}), error => {
      assert.equal(error.code, 'UNSUPPORTED')
      assert.match(error.message, /lint/)
      return true
    })
  } finally {
    await cleanup()
  }
})
