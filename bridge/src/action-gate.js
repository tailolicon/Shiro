import { errorResult } from './mcp-result.js'

// One permission gate for the whole tool surface.
//
// The surface is registered from two places -- the direct actions build theirs
// from a table in direct-actions.js, the harness and fleet actions are written
// out by hand in index.js -- and for a while only the first place consulted the
// policy. That is the failure mode this module exists to prevent: a profile that
// says "read-only" while `harness_start` (an agent that can write anything) and
// `fleet_start` (a live browser) stayed reachable.
//
// So the decision lives here, both registration paths call it, and
// permission-coverage.test.js asserts it holds for EVERY registered tool rather
// than for the ones someone remembered.

/**
 * @param descriptors the registry rows: {name, family, read_only, destructive}.
 * @returns a function wrapping one handler in the policy check.
 */
export function createActionGate({ policy = null, descriptors = [] } = {}) {
  const byName = new Map(descriptors.map(descriptor => [descriptor.name, descriptor]))

  return function gate(name, handler) {
    const descriptor = byName.get(name)
    if (descriptor === undefined) {
      // A tool with no registry row cannot be judged, and silently allowing it
      // is exactly the hole this module closes.
      throw new Error(`${name} has no action descriptor, so its permission cannot be decided`)
    }
    return async (args, extra) => {
      try {
        policy?.assertAction(descriptor)
      } catch (error) {
        return errorResult(error)
      }
      return await handler(args, extra)
    }
  }
}
