import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from './action-errors.js'
import { runCommand } from './exec-actions.js'

// Declared project tasks: package scripts and Make targets.
//
// "Run the tests", "run lint", "build" are the most common thing a client asks
// a coding agent to do, and none of them needs model reasoning once the task is
// declared in the repository. task_list discovers what exists, task_run and
// test_run execute one *named* task -- never free-form shell text -- so the
// command that runs is always something the repository itself declared.

export const TASK_LIMITS = Object.freeze({
  max_packages: 20,
  max_tasks: 300,
  max_extra_args: 32,
  makefile_max_bytes: 512_000,
  package_json_max_bytes: 2_000_000,
})

const LOCKFILES = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
]

const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', '.venv', '__pycache__',
])

async function readJson(absolute) {
  const info = await stat(absolute).catch(() => null)
  if (info === null || !info.isFile() || info.size > TASK_LIMITS.package_json_max_bytes) return null
  try {
    return JSON.parse(await readFile(absolute, 'utf8'))
  } catch {
    return null
  }
}

async function detectPackageManager(directory) {
  for (const candidate of LOCKFILES) {
    const info = await stat(join(directory, candidate.file)).catch(() => null)
    if (info !== null) return candidate.manager
  }
  return 'npm'
}

/**
 * Make target names, extracted without running make: any `target:` rule that is
 * not a variable assignment, a pattern rule, or a special `.` directive.
 */
function parseMakeTargets(text) {
  const targets = []
  for (const line of text.split('\n')) {
    if (line.startsWith('\t') || line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z0-9][A-Za-z0-9_.\/-]*)\s*::?(?!=)/.exec(line)
    if (match === null) continue
    const name = match[1]
    if (name.startsWith('.') || targets.includes(name)) continue
    targets.push(name)
  }
  return targets
}

/** task_list: every declared package script and Make target under the root. */
export async function listTasks(sandbox, args = {}) {
  const rootReal = await sandbox.rootReal()
  const directories = ['.']
  if (args.include_packages !== false) {
    const items = await readdir(rootReal, { withFileTypes: true }).catch(() => [])
    items.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const item of items) {
      if (!item.isDirectory() || item.name.startsWith('.') || SKIP_DIRECTORIES.has(item.name)) continue
      if (directories.length > TASK_LIMITS.max_packages) break
      const manifest = await stat(join(rootReal, item.name, 'package.json')).catch(() => null)
      const makefile = await stat(join(rootReal, item.name, 'Makefile')).catch(() => null)
      if (manifest !== null || makefile !== null) directories.push(item.name)
    }
  }

  const tasks = []
  const packages = []
  for (const directory of directories) {
    const absolute = directory === '.' ? rootReal : join(rootReal, directory)
    const manifest = await readJson(join(absolute, 'package.json'))
    if (manifest !== null && manifest.scripts !== null && typeof manifest.scripts === 'object') {
      // A sub-package usually has no lockfile of its own; fall back to whatever
      // the repository root uses so `bridge:test` runs under the real manager.
      const own = await detectPackageManager(absolute)
      const manager = own === 'npm' && directory !== '.' ? await detectPackageManager(rootReal) : own
      packages.push({ path: directory, name: typeof manifest.name === 'string' ? manifest.name : undefined, package_manager: manager })
      for (const [script, command] of Object.entries(manifest.scripts)) {
        if (typeof command !== 'string') continue
        if (tasks.length >= TASK_LIMITS.max_tasks) break
        tasks.push({
          name: directory === '.' ? script : `${directory}:${script}`,
          source: 'package.json',
          script,
          cwd: directory,
          package_manager: manager,
          command: `${manager} run ${script}`,
          declared: command,
        })
      }
    }
    const makefilePath = join(absolute, 'Makefile')
    const makeInfo = await stat(makefilePath).catch(() => null)
    if (makeInfo !== null && makeInfo.isFile() && makeInfo.size <= TASK_LIMITS.makefile_max_bytes) {
      const text = await readFile(makefilePath, 'utf8').catch(() => '')
      for (const target of parseMakeTargets(text)) {
        if (tasks.length >= TASK_LIMITS.max_tasks) break
        tasks.push({
          name: directory === '.' ? `make:${target}` : `${directory}:make:${target}`,
          source: 'Makefile',
          script: target,
          cwd: directory,
          command: `make ${target}`,
        })
      }
    }
  }
  return {
    tasks,
    total: tasks.length,
    packages,
    truncated: tasks.length >= TASK_LIMITS.max_tasks,
  }
}

function findTask(catalog, name) {
  const task = catalog.tasks.find(candidate => candidate.name === name)
  if (task === undefined) {
    fail('NOT_FOUND', `no declared task named "${name}". Call task_list to see the ${catalog.total} declared task(s).`)
  }
  return task
}

function extraArguments(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  if (list.length > TASK_LIMITS.max_extra_args) fail('INVALID_ARGUMENT', `args accepts at most ${TASK_LIMITS.max_extra_args} entries`)
  for (const item of list) {
    if (typeof item !== 'string') fail('INVALID_ARGUMENT', 'every args entry must be a string')
    if (item.includes('\0')) fail('INVALID_ARGUMENT', 'args entries must not contain NUL bytes')
  }
  return list
}

function taskArgv(task, extra) {
  if (task.source === 'Makefile') return ['make', task.script, ...extra]
  // `--` keeps extra arguments as arguments to the script, not to the runner.
  return extra.length === 0
    ? [task.package_manager, 'run', task.script]
    : [task.package_manager, 'run', task.script, '--', ...extra]
}

async function execute(sandbox, task, extra, args, options) {
  const argv = taskArgv(task, extra)
  const result = await runCommand(sandbox, {
    argv,
    cwd: task.cwd,
    timeout_ms: args.timeout_ms,
    max_output_bytes: args.max_output_bytes,
    env: args.env,
    // Forwarded explicitly: this object is rebuilt field by field rather than
    // spread, so anything not named here is silently dropped -- which is how
    // sandbox_mode reached the schema, reached this function, and still had no
    // effect on the command that actually ran.
    sandbox_mode: args.sandbox_mode,
  }, options)
  return {
    task: task.name,
    source: task.source,
    cwd: task.cwd,
    ...result,
    passed: result.exit_code === 0 && !result.timed_out,
  }
}

/** task_run: run one declared task by name, never free-form shell text. */
export async function runTask(sandbox, args = {}, options = {}) {
  if (typeof args.name !== 'string' || args.name === '') fail('INVALID_ARGUMENT', 'name is required; call task_list for the declared task names')
  const catalog = await listTasks(sandbox, {})
  const task = findTask(catalog, args.name)
  return await execute(sandbox, task, extraArguments(args.args), args, options)
}

const TEST_SCRIPT_NAMES = ['test', 'tests', 'test:unit', 'check']

/** test_run: run the repository's declared test task, or explain what exists. */
export async function runTests(sandbox, args = {}, options = {}) {
  const catalog = await listTasks(sandbox, {})
  let task
  if (typeof args.task === 'string' && args.task !== '') {
    task = findTask(catalog, args.task)
  } else {
    task = catalog.tasks.find(candidate => candidate.cwd === '.' && TEST_SCRIPT_NAMES.includes(candidate.script))
      ?? catalog.tasks.find(candidate => TEST_SCRIPT_NAMES.includes(candidate.script))
  }
  if (task === undefined) {
    fail('UNSUPPORTED', `this repository declares no test task. Declared tasks: ${catalog.tasks.map(candidate => candidate.name).join(', ') || '(none)'}. Run a specific command with exec_run instead.`)
  }
  const extra = extraArguments(args.args)
  if (typeof args.filter === 'string' && args.filter !== '') extra.push(args.filter)
  return await execute(sandbox, task, extra, args, options)
}
