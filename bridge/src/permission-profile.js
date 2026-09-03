import { fail } from './action-errors.js'

// Permission profiles: one coarse dial in front of the whole action surface.
//
// Shiro already gates individual dangerous calls with confirm=true, and confines
// every path to a workspace. What it lacked is the thing an operator sets ONCE
// for a session: "this run may read but not write", "this run may change files
// but must not reach the network". Per-call confirmation cannot express that --
// it asks about one call at a time, and the answer is easy to give a hundred
// times in a row.
//
// The gate is deliberately coarse and honest about it. A profile is a statement
// of intent enforced at the action boundary; it is not a sandbox. `exec_run`
// under workspace-write can still run curl, because containing that would mean
// controlling the child process's network, which this layer does not do. What
// the profile guarantees is that no ACTION whose whole purpose is to leave the
// machine or to write is reachable, and that command and host rules are applied
// to the actions that do take commands and URLs.

export const PROFILES = Object.freeze(['read-only', 'workspace-write', 'full'])

// Ordered least to most capable. A profile may be narrowed at runtime and never
// widened: a caller that could raise its own ceiling has no ceiling.
const RANK = Object.freeze({ 'read-only': 0, 'workspace-write': 1, full: 2 })

// Actions that leave the machine, regardless of how they are annotated. The
// browser family reaches a live browser session; the network family fetches.
const OUTWARD_FAMILIES = new Set(['network', 'browser'])
// The fleet family splits: reading a fleet reports state this bridge persisted
// on disk, but starting, stopping or steering one opens browser tabs and submits
// prompts to ChatGPT. A coverage test caught fleet_start passing as a local
// write because the family alone did not say which half an action was in.
const OUTWARD_ON_WRITE_FAMILIES = new Set(['fleet'])
const OUTWARD_ACTIONS = new Set(['git_fetch', 'git_pull', 'git_push'])

// Reads that must stay available at every profile, because they are how a
// client discovers what it may do and what went wrong.
const ALWAYS_ALLOWED = new Set([
  'bridge_status', 'bridge_capabilities', 'config_get', 'config_validate',
  'metrics_snapshot', 'logs_tail', 'permission_get', 'permission_set',
])

export function normalizeProfile(value, fallback = 'full') {
  const profile = String(value ?? '').trim()
  if (profile === '') return fallback
  if (!PROFILES.includes(profile)) {
    throw new Error(`permissionProfile must be one of ${PROFILES.join(', ')}`)
  }
  return profile
}

/** Compile the operator's command and network rules once, at startup. */
export function normalizeRules(rules = {}) {
  const commandAllow = toPatternList(rules.commandAllow ?? rules.command_allow, 'commandAllow')
  const commandDeny = toPatternList(rules.commandDeny ?? rules.command_deny, 'commandDeny')
  const networkAllow = toHostList(rules.networkAllow ?? rules.network_allow, 'networkAllow')
  const networkDeny = toHostList(rules.networkDeny ?? rules.network_deny, 'networkDeny')
  return Object.freeze({ commandAllow, commandDeny, networkAllow, networkDeny })
}

function toPatternList(value, label) {
  const items = Array.isArray(value) ? value : typeof value === 'string' && value.trim() !== '' ? value.split(/[,\n]/) : []
  return Object.freeze(items.map(entry => {
    const pattern = String(entry).trim()
    if (pattern === '') return null
    if (pattern.length > 200) throw new Error(`${label} entries are at most 200 characters`)
    return pattern
  }).filter(entry => entry !== null))
}

function toHostList(value, label) {
  return Object.freeze(toPatternList(value, label).map(entry => entry.toLowerCase()))
}

/**
 * Glob match for a command: `*` matches within a segment, and a bare name
 * matches the executable regardless of the path it was found at, because
 * `/usr/bin/git` and `git` are the same decision.
 */
export function matchesCommand(pattern, command) {
  const target = String(command ?? '')
  const bare = target.split('/').pop() ?? target
  const expression = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
  return expression.test(target) || expression.test(bare)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Host match: an exact host, or a leading dot for "this domain and below". */
export function matchesHost(pattern, hostname) {
  const host = String(hostname ?? '').toLowerCase()
  if (pattern.startsWith('.')) return host === pattern.slice(1) || host.endsWith(pattern)
  if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1))
  return host === pattern
}

/**
 * May this action run at all under this profile?
 * @param descriptor the registry row: {name, family, read_only, destructive}.
 */
export function evaluateAction(profile, descriptor) {
  const name = String(descriptor?.name ?? '')
  if (ALWAYS_ALLOWED.has(name)) return { allowed: true }
  const level = RANK[profile] ?? RANK.full
  if (level >= RANK.full) return { allowed: true }

  const outward = OUTWARD_FAMILIES.has(descriptor?.family)
    || OUTWARD_ACTIONS.has(name)
    || (OUTWARD_ON_WRITE_FAMILIES.has(descriptor?.family) && descriptor?.read_only !== true)
  if (descriptor?.read_only === true && !outward) return { allowed: true }

  if (level === RANK['read-only']) {
    return {
      allowed: false,
      reason: `the permission profile is read-only, so ${name} is not available. Read actions still work; ask the operator to restart Shiro with a wider profile, and note that permission_set can only narrow.`,
    }
  }
  // workspace-write: writes are fine, leaving the machine is not.
  if (outward) {
    return {
      allowed: false,
      reason: `the permission profile is workspace-write, so ${name} is not available: it reaches outside this machine. Workspace reads and writes still work.`,
    }
  }
  return { allowed: true }
}

/**
 * Command rules for the actions that take a command. Deny wins over allow, and
 * a non-empty allowlist means "only these".
 */
export function evaluateCommand(rules, { argv, command, shell } = {}) {
  const executable = Array.isArray(argv) && argv.length > 0 ? String(argv[0]) : ''
  const line = String(command ?? '')
  const subject = executable !== '' ? executable : line
  if (subject === '') return { allowed: true }

  for (const pattern of rules.commandDeny) {
    if (matchesCommand(pattern, executable) || (line !== '' && line.includes(pattern))) {
      return { allowed: false, reason: `command rules deny ${subject} (matched "${pattern}")` }
    }
  }
  if (rules.commandAllow.length === 0) return { allowed: true }
  if (shell === true && executable === '') {
    // A shell line is not one command; an allowlist cannot vouch for it.
    return { allowed: false, reason: 'command rules define an allowlist, so shell=true is not available: pass argv so the executable can be checked' }
  }
  for (const pattern of rules.commandAllow) {
    if (matchesCommand(pattern, executable)) return { allowed: true }
  }
  return { allowed: false, reason: `command rules allow only ${rules.commandAllow.join(', ')}; ${subject} is not among them` }
}

/** Host rules for the actions that take a URL. Deny wins; allowlist is exclusive. */
export function evaluateHost(rules, url) {
  let hostname
  try {
    hostname = new URL(String(url)).hostname
  } catch {
    return { allowed: true } // URL validity is the action's own error to report.
  }
  for (const pattern of rules.networkDeny) {
    if (matchesHost(pattern, hostname)) return { allowed: false, reason: `network rules deny ${hostname} (matched "${pattern}")` }
  }
  if (rules.networkAllow.length === 0) return { allowed: true }
  for (const pattern of rules.networkAllow) {
    if (matchesHost(pattern, hostname)) return { allowed: true }
  }
  return { allowed: false, reason: `network rules allow only ${rules.networkAllow.join(', ')}; ${hostname} is not among them` }
}

/**
 * The live profile for a bridge. Narrowing is allowed at runtime; widening is
 * not, and the ceiling comes from operator configuration that only a restart
 * can change.
 */
export class PermissionPolicy {
  constructor({ profile = 'full', rules = {} } = {}) {
    this.ceiling = normalizeProfile(profile)
    this.profile = this.ceiling
    this.rules = normalizeRules(rules)
  }

  narrow(profile, { reason } = {}) {
    const next = normalizeProfile(profile, this.profile)
    if ((RANK[next] ?? 0) > (RANK[this.profile] ?? 0)) {
      fail('PERMISSION_REQUIRED', `the permission profile can only be narrowed at runtime: it is ${this.profile} and ${next} is wider. The ceiling (${this.ceiling}) comes from the launcher configuration, so widening needs an operator and a restart.`)
    }
    this.profile = next
    return { profile: this.profile, ceiling: this.ceiling, reason: typeof reason === 'string' && reason !== '' ? reason.slice(0, 400) : undefined }
  }

  snapshot() {
    return {
      profile: this.profile,
      ceiling: this.ceiling,
      can_widen: false,
      command_allow: [...this.rules.commandAllow],
      command_deny: [...this.rules.commandDeny],
      network_allow: [...this.rules.networkAllow],
      network_deny: [...this.rules.networkDeny],
    }
  }

  /** Called by every action before its handler runs. */
  assertAction(descriptor) {
    const verdict = evaluateAction(this.profile, descriptor)
    if (!verdict.allowed) fail('PERMISSION_REQUIRED', verdict.reason)
  }

  assertCommand(input) {
    const verdict = evaluateCommand(this.rules, input)
    if (!verdict.allowed) fail('PERMISSION_REQUIRED', verdict.reason)
  }

  assertHost(url) {
    const verdict = evaluateHost(this.rules, url)
    if (!verdict.allowed) fail('PERMISSION_REQUIRED', verdict.reason)
  }
}
