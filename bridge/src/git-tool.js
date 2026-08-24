import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GIT_TOOLS, gateReason, runGit } from './git-commands.js'

// Thin DSH wrapper over git-commands.js. All git logic (argv construction, path
// confinement, ref validation, approval reasons, the spawn runner) lives in the
// dependency-free git-commands.js so it can be unit-tested standalone; this file
// only binds it to defineTool and the tools/pre-execute approval seam.

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    stdout: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
  },
}

function renderResult(_args, value) {
  const body = value.stdout || value.stderr || '(no output)'
  const suffix = value.exitCode === 0
    ? (value.truncated ? '\n[output truncated]' : '')
    : `${value.stderr && value.stdout ? `\n${value.stderr}` : ''}${value.truncated ? '\n[output truncated]' : ''}\n[git exit code: ${value.exitCode ?? 'null'}]`
  return [{ type: 'text', text: `${body}${suffix}` }]
}

export function registerGitTools(ctx, { workspaceRoot }) {
  // Mutating git calls (add / commit / branch create+switch) ask the human
  // before they run; the registry routes the ask through ctx.get('approval')
  // and fails closed when no approval channel is present. Read calls and every
  // non-git tool fall straight through.
  ctx.on('tools/pre-execute', (exec, next) => {
    const reason = gateReason(exec.name, exec.arguments ?? {})
    if (reason === undefined) return next()
    return Promise.resolve({ kind: 'ask', reason })
  }, { prepend: true })

  for (const spec of GIT_TOOLS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: { schema: RESULT_SCHEMA, render: renderResult },
      async execute(args, exec) {
        const { argv, stdin } = spec.build(args, workspaceRoot)
        return runGit(workspaceRoot, argv, { stdin, signal: exec.signal })
      },
      presentCall: args => ({ card: 'terminal', title: spec.presentTitle(args), description: spec.description }),
    }))
  }
}

export const name = 'shiro-git-tool'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const workspaceRoot = config.workspaceRoot || process.env.SHIRO_WORKSPACE_ROOT
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') throw new Error('Shiro git tool requires workspaceRoot')
  registerGitTools(ctx, { workspaceRoot: resolve(workspaceRoot) })
}
