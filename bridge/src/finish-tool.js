import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Register Shiro's terminal result tool.
 *
 * A normal model tool-call step owes the agent loop another model request so
 * the model can interpret the tool result. When the model has already computed
 * the exact user-facing answer, that extra round is pure latency. DSH exposes
 * `exec.concludeTurn()` precisely for this case: the successful tool result is
 * committed durably, then the loop closes once the inbox is drained.
 */
export function registerFinishTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'submit_final',
    description: 'Finish the current Shiro turn immediately with the exact user-facing response. Call this only when all required work is complete and no further tool call or reasoning round is needed. The text becomes the final response; do not add another answer after calling it.',
    parameters: {
      text: { type: 'string', required: true, description: 'Exact final response to return to the user.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args, exec) {
      if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('text is required')
      exec.concludeTurn()
      return Promise.resolve(args.text)
    },
    presentCall: () => ({ card: 'generic', title: 'Submit final response', kind: 'execute' }),
  }))
}

export const name = 'shiro-finish-tool'
export const inject = ['tools']

export function apply(ctx) {
  registerFinishTool(ctx)
}
