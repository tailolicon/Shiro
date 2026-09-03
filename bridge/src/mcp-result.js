import { z } from 'zod'

// Shared MCP result shaping. Extracted from index.js so the direct-action
// registry (direct-actions.js) produces byte-identical result envelopes to the
// original Harness tools instead of a second, drifting implementation.

export const looseObject = () => z.record(z.string(), z.unknown())

export function toolResult(value) {
  // structuredContent gives the MCP client a machine-readable copy of the
  // outcome (validated against each tool's outputSchema); the text block
  // stays for clients that only read content.
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

export function errorResult(error) {
  // Business/tool failures surface as isError results with a stable shape so
  // the model can self-correct; only protocol failures become JSON-RPC errors.
  const source = error instanceof Error ? error : new Error(String(error))
  const failure = {
    message: source.message,
    code: typeof source.code === 'string' ? source.code : 'harness_error',
    retryable: source.retryable === true,
  }
  const payload = { error: failure }
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true }
}

/**
 * SDK 1.29 validates structuredContent against the tool's outputSchema even
 * when the result carries isError:true, and the generated JSON schema forbids
 * additional properties. Every output schema therefore has to accept BOTH the
 * success shape and the structured error shape: success fields turn optional
 * and the stable `error` object becomes an allowed property.
 */
export function resultSchema(shape) {
  const relaxed = {}
  for (const [key, value] of Object.entries(shape)) relaxed[key] = value.optional()
  relaxed.error = looseObject().optional().describe('Present instead of the success fields when the call failed: {message, code, retryable}.')
  return relaxed
}
