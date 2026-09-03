// Stable error vocabulary for Shiro's direct connector actions.
//
// Direct actions are deterministic control-plane calls (filesystem, exec,
// process, git, tasks) that never reach an LLM, so their failures have to be
// machine-classifiable: the MCP client picks the next move from `code`, not
// from prose. index.js#errorResult already forwards `error.code` and
// `error.retryable` into the structured tool result, so throwing an
// ActionError from anywhere inside an action handler produces the documented
// `{error:{message,code,retryable}}` shape without extra plumbing.

export const ERROR_CODES = Object.freeze([
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'CONFLICT',
  'INVALID_ARGUMENT',
  'OUTSIDE_SANDBOX',
  'PERMISSION_REQUIRED',
  'TIMEOUT',
  'PROCESS_FAILED',
  'GIT_CONFLICT',
  'BUSY',
  'UNSUPPORTED',
  'INTERNAL',
])

const CODE_SET = new Set(ERROR_CODES)

// Codes worth another attempt without changing the arguments. TIMEOUT/BUSY are
// transient by definition; everything else needs a different call.
const RETRYABLE = new Set(['TIMEOUT', 'BUSY'])

export class ActionError extends Error {
  constructor(code, message, { retryable, details } = {}) {
    super(message)
    this.name = 'ActionError'
    this.code = CODE_SET.has(code) ? code : 'INTERNAL'
    this.retryable = retryable ?? RETRYABLE.has(this.code)
    if (details !== undefined) this.details = details
  }
}

export function fail(code, message, options) {
  throw new ActionError(code, message, options)
}

const ERRNO_CODES = {
  ENOENT: 'NOT_FOUND',
  ENOTDIR: 'NOT_FOUND',
  EEXIST: 'ALREADY_EXISTS',
  ENOTEMPTY: 'CONFLICT',
  EPERM: 'PERMISSION_REQUIRED',
  EACCES: 'PERMISSION_REQUIRED',
  EISDIR: 'INVALID_ARGUMENT',
  EINVAL: 'INVALID_ARGUMENT',
  ELOOP: 'OUTSIDE_SANDBOX',
  ENAMETOOLONG: 'INVALID_ARGUMENT',
  EMFILE: 'BUSY',
  ENFILE: 'BUSY',
  EBUSY: 'BUSY',
  ENOSPC: 'INTERNAL',
}

/**
 * Translate a Node fs/child_process errno into the public vocabulary. Raw
 * errno strings must never reach the client as `code`: they are a different
 * namespace and would make `NOT_FOUND` handling depend on the host platform.
 */
export function asActionError(error, fallbackCode = 'INTERNAL', prefix = '') {
  if (error instanceof ActionError) return error
  const source = error instanceof Error ? error : new Error(String(error))
  const mapped = typeof source.code === 'string' ? ERRNO_CODES[source.code] : undefined
  const message = prefix === '' ? source.message : `${prefix}: ${source.message}`
  return new ActionError(mapped ?? fallbackCode, message)
}

/** Run one fs/exec step, converting any errno failure into an ActionError. */
export async function guard(operation, { code = 'INTERNAL', prefix = '' } = {}) {
  try {
    return await operation()
  } catch (error) {
    throw asActionError(error, code, prefix)
  }
}

/**
 * Confirmation gate for destructive or outward-facing direct actions.
 *
 * Harness tool calls ask the human through harness_respond; a direct action
 * has no interaction channel, so the equivalent gate is an explicit `confirm`
 * argument the model can only set after relaying the exact operation. Refusing
 * with PERMISSION_REQUIRED (never performing the work) keeps the existing
 * "no silent privilege widening" rule intact.
 */
export function requireConfirmation(confirmed, description) {
  if (confirmed === true) return
  fail('PERMISSION_REQUIRED', `${description}. This is destructive or leaves the machine, so it runs only when the user has approved it: repeat the call with confirm=true after explicit user confirmation.`)
}
