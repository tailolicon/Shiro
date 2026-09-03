import { connect } from './cli-connect.js'

// The JavaScript SDK: the connector as a set of ordinary async functions.
//
// A raw MCP client already reaches every action, so the SDK earns its place by
// doing the three things a caller would otherwise hand-write every time:
// unwrapping structuredContent, turning `isError` into a THROWN error that
// carries the bridge's own error code, and letting a thread be picked up by id
// rather than reconstructed.

export class ShiroActionError extends Error {
  constructor({ code, message, details }, action) {
    super(message ?? `${action} failed`)
    this.name = 'ShiroActionError'
    this.code = code ?? 'INTERNAL'
    this.action = action
    if (details !== undefined) this.details = details
  }
}

// Reserved on the client object, so `shiro.call` is the method and not an
// attempt to invoke an action named "call".
const RESERVED = new Set(['call', 'actions', 'schema', 'thread', 'close', 'client', 'then'])

/**
 * Wrap an MCP client. Any action is reachable two ways:
 *   await shiro.call('fs_read', { path })
 *   await shiro.fs_read({ path })
 * The second is a Proxy over the first: the action list is the bridge's, not a
 * generated stub, so a bridge newer than this file still exposes everything.
 */
export function createClient(client, { close } = {}) {
  const api = {
    client,

    async call(name, args = {}) {
      if (typeof name !== 'string' || name.trim() === '') throw new TypeError('an action name is required')
      const result = await client.callTool({ name, arguments: args })
      const payload = result.structuredContent ?? {}
      if (result.isError === true) throw new ShiroActionError(payload.error ?? {}, name)
      return payload
    },

    /** The action registry, so a caller can feature-detect instead of assuming. */
    async actions({ family } = {}) {
      const { actions = [] } = await api.call('bridge_capabilities')
      return family === undefined ? actions : actions.filter(action => action.family === family)
    },

    /** The input/output schema of one action, for callers that generate UI or validate. */
    async schema(name) {
      const { tools = [] } = await client.listTools()
      const tool = tools.find(entry => entry.name === name)
      if (tool === undefined) throw new ShiroActionError({ code: 'NOT_FOUND', message: `no action named ${name}` }, 'schema')
      return { name: tool.name, title: tool.title, description: tool.description, input: tool.inputSchema, output: tool.outputSchema }
    },

    /**
     * Resume by thread id. A durable session outlives the process that started
     * it, so the SDK's unit of continuity is the id, not an object held in
     * memory: a script that crashed can pick the same thread back up.
     */
    thread(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new TypeError('a session id is required')
      const id = sessionId.trim()
      return {
        id,
        events: ({ from_seq, limit, types } = {}) => api.call('thread_events', { session_id: id, from_seq, limit, types }),
        log: ({ limit } = {}) => api.call('harness_session_log', { session_id: id, limit }),
        status: ({ wait_ms } = {}) => api.call('harness_status', { session_id: id, wait_ms }),
        continue: args => api.call('harness_continue', { ...args, session_id: id }),
        steer: ({ message }) => api.call('turn_steer', { session_id: id, message }),
        cancel: ({ reason } = {}) => api.call('harness_cancel', { session_id: id, reason }),
        fork: ({ at_seq, label } = {}) => api.call('thread_fork', { session_id: id, at_seq, label }),
        archive: ({ reason } = {}) => api.call('thread_archive', { session_id: id, reason }),
      }
    },

    async close() { await close?.() },
  }

  return new Proxy(api, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || RESERVED.has(property) || property in target) {
        return Reflect.get(target, property, receiver)
      }
      if (property.startsWith('_') || /[^a-z0-9_]/.test(property)) return undefined
      return (args = {}) => target.call(property, args)
    },
  })
}

/** Connect to a running bridge using the launcher's own environment conventions. */
export async function connectShiro(options = {}) {
  const session = await connect(options)
  return createClient(session.client, { close: session.close })
}
