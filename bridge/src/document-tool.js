import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DOCUMENT_TOOLS } from './document-extract.js'
import { Sandbox } from './sandbox.js'
import { sessionRoot } from './session-root.js'

// Thin DSH wrapper over document-extract.js. Path confinement follows the
// session cwd (session-root.js), the same rule shiro-git-tool and
// shiro-container-tool use, so an agent turn anchored in another workspace
// cannot read a DOCX from the Shiro repository by accident.

function renderResult(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function registerDocumentTools(ctx, { workspaceRoot }) {
  for (const spec of DOCUMENT_TOOLS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: spec.outputSchema,
        render: renderResult,
      },
      async execute(args, exec) {
        const root = sessionRoot(exec, workspaceRoot)
        return spec.execute(new Sandbox(root), args ?? {})
      },
      presentCall: args => ({ card: 'generic', title: spec.presentTitle(args ?? {}), description: spec.description }),
    }))
  }
}

export const name = 'shiro-document-tool'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const workspaceRoot = config.workspaceRoot || process.env.SHIRO_WORKSPACE_ROOT
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') throw new Error('Shiro document tool requires workspaceRoot')
  registerDocumentTools(ctx, { workspaceRoot: resolve(workspaceRoot) })
}
