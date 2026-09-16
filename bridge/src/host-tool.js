import { defineTool } from '@deepseek-ai/dsh-tools'
import { HOST_TOOLS } from './host-info.js'

// Thin DSH wrapper over host-info.js. The core is dependency-free so the
// read-only host snapshot can be unit-tested without the engine peer; this
// file only binds it to defineTool. Nothing here sends signals or opens
// /proc/<pid>/environ.

function renderResult(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function registerHostTools(ctx) {
  for (const spec of HOST_TOOLS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: spec.outputSchema,
        render: renderResult,
      },
      execute: args => spec.execute(args ?? {}),
      presentCall: args => ({ card: 'generic', title: spec.presentTitle(args ?? {}), description: spec.description }),
    }))
  }
}

export const name = 'shiro-host-tool'
export const inject = ['tools']

export function apply(ctx) {
  registerHostTools(ctx)
}
