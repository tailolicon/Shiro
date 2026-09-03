import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { containerArguments } from './container-path.js'
import { sessionRoot } from './session-root.js'
const MAX_OUTPUT = 256 * 1024

function appendBounded(state, chunk) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const remaining = MAX_OUTPUT - state.length
  if (remaining <= 0) {
    state.truncated = true
    return
  }
  state.parts.push(value.subarray(0, remaining))
  state.length += Math.min(value.length, remaining)
  if (value.length > remaining) state.truncated = true
}

function runContainer({ workspaceRoot, command, workdir, timeoutMs, signal }) {
  return new Promise((resolveRun, rejectRun) => {
    const containerName = `shiro-task-${randomUUID()}`
    const args = containerArguments({ workspaceRoot, command, workdir, containerName })
    const child = spawn('docker', args, {
      cwd: workspaceRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = { parts: [], length: 0, truncated: false }
    const stderr = { parts: [], length: 0, truncated: false }
    child.stdout.on('data', chunk => appendBounded(stdout, chunk))
    child.stderr.on('data', chunk => appendBounded(stderr, chunk))

    let timedOut = false
    let aborted = false
    let settled = false
    const cleanupContainer = () => {
      const cleanup = spawn('docker', ['rm', '-f', containerName], { windowsHide: true, stdio: 'ignore' })
      cleanup.unref()
    }
    const stop = reason => {
      if (settled) return
      if (reason === 'timeout') timedOut = true
      if (reason === 'abort') aborted = true
      cleanupContainer()
      child.kill()
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const onAbort = () => stop('abort')
    signal?.addEventListener('abort', onAbort, { once: true })

    child.once('error', error => {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      rejectRun(error)
    })
    child.once('close', code => {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolveRun({
        exitCode: code,
        timedOut,
        aborted,
        stdout: Buffer.concat(stdout.parts).toString('utf8'),
        stderr: Buffer.concat(stderr.parts).toString('utf8'),
        truncated: stdout.truncated || stderr.truncated,
      })
    })
  })
}

export function registerContainerTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'sandbox_exec',
    description: `Run a foreground command in Shiro's isolated Linux runner. Only this session's workspace root is mounted at /workspace; the container has no network, no host filesystem, no extra capabilities, and is deleted after the command. Prefer this for tests, builds, package scripts, and commands that create child processes. Use ${process.platform === 'win32' ? 'pwsh' : 'bash'} for simple host-native inspection.`,
    parameters: {
      command: { type: 'string', required: true, description: 'POSIX shell command to run inside the isolated project container.' },
      description: { type: 'string', required: true, description: 'Short description of the operation.' },
      workdir: { type: 'string', description: "Relative directory inside this session's workspace root. Defaults to the root." },
      timeoutMs: { type: 'number', description: 'Timeout from 1000 to 600000 milliseconds. Defaults to 120000.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.stdout}${value.stderr}${value.truncated ? '\n[output truncated]' : ''}\n[exit code: ${value.exitCode ?? 'null'}]`,
      }],
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('command is required')
      const timeoutMs = args.timeoutMs ?? 120_000
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) throw new Error('timeoutMs must be an integer from 1000 to 600000')
      return runContainer({
        // Mount the session's own workspace, so a command run for a session
        // anchored elsewhere does not operate on the Shiro repository.
        workspaceRoot: sessionRoot(exec, config.workspaceRoot),
        command: args.command,
        workdir: args.workdir ?? '.',
        timeoutMs,
        signal: exec.signal,
      })
    },
    presentCall: args => ({ card: 'terminal', title: args.command, description: args.description, cwd: args.workdir }),
  }))
}

export const name = 'shiro-container-tool'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const workspaceRoot = config.workspaceRoot || process.env.SHIRO_WORKSPACE_ROOT
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') throw new Error('Shiro container tool requires workspaceRoot')
  registerContainerTool(ctx, { workspaceRoot })
}
