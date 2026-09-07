import { z } from 'zod'
import { ACTION_GAP_PROBLEM_TYPES, ACTION_GAP_SEVERITIES, ActionGapCollector, FRICTION_WEIGHTS, defaultActionGapStateDir } from './action-gap.js'
import { confirmationsAreRequired, ERROR_CODES, fail, requireConfirmation } from './action-errors.js'
import { classifyByExtension } from './artifact-kind.js'
import { CLICK_BUTTONS, clickOwnedTabElement, DOM_LIMITS, evaluateInOwnedTab, EVALUATE_LIMITS, queryOwnedTabDom, TYPE_MODES, typeIntoOwnedTabElement } from './browser-dom.js'
import { navigateOwnedTab, NAVIGATE_LIMITS, WAIT_UNTIL } from './browser-navigate.js'
import { captureOwnedTabScreenshot, SCREENSHOT_FORMATS, SCREENSHOT_LIMITS } from './browser-screenshot.js'
import { Confinement } from './confinement.js'
import { SUBAGENT_ADAPTERS } from './subagent-adapters.js'
import { SubagentRegistry } from './subagents.js'
import { EXEC_LIMITS, runCommand } from './exec-actions.js'
import * as fs from './fs-actions.js'
import * as git from './git-actions.js'
import * as media from './media-actions.js'
import { errorResult, looseObject, resultSchema, toolResult } from './mcp-result.js'
import { PermissionPolicy, PROFILES } from './permission-profile.js'
import { downloadFile, importArtifact, NET_LIMITS } from './net-actions.js'
import * as tasks from './task-actions.js'
import * as review from './review-actions.js'
import * as worktrees from './worktree-actions.js'
import { CONTROL_KEYS, TERMINAL_LIMITS, TERMINAL_SIGNALS, TerminalRegistry } from './terminal-actions.js'
import { THREAD_LIMITS } from './thread-registry.js'
import { PRIMARY_WORKSPACE_ID, WORKSPACE_LIMITS, WorkspaceRegistry } from './workspaces.js'

// The Shiro connector's direct-action surface.
//
// WHY THIS EXISTS
// Before these actions, every routine operation -- read a file, check git
// status, run the tests, stop a dev server -- had to go through harness_start,
// which creates a durable Harness session and then drives an LLM loop over MCP.
// That is the right tool for real coding work and the wrong one for control
// plane CRUD: it costs several model round-trips and a pile of context for an
// answer the bridge already knows.
//
// Everything registered here is deterministic: it never creates a Harness
// session, never enqueues a model request, and never invokes an LLM. Harness
// stays the fallback for anything that needs reasoning.
//
// SAFETY MODEL
//   * every path goes through the Sandbox of the workspace it names, so it
//     resolves inside that root even across symlinks, and a workspace can only
//     ever be one of the roots the operator allowlisted;
//   * commands are argv arrays run with shell:false unless shell=true is asked
//     for by name;
//   * child environments are an allowlist, never a copy of the bridge's env;
//   * destructive or outward-facing actions (recursive delete, overwrite,
//     git restore/reset --hard/rebase/push) require an explicit confirm=true,
//     the direct-action equivalent of the harness_respond approval gate;
//   * only bridge-started processes and Shiro-owned browser tabs are visible.

/** Rolling per-action counters. Cheap enough to keep always-on. */
export class ActionMetrics {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.startedAt = now()
    this.actions = new Map()
  }

  record(name, durationMs, ok, code) {
    const entry = this.actions.get(name) ?? { name, calls: 0, errors: 0, total_ms: 0, max_ms: 0, last_error_code: undefined, last_called_at: undefined }
    entry.calls += 1
    entry.total_ms += durationMs
    entry.max_ms = Math.max(entry.max_ms, durationMs)
    entry.last_called_at = new Date(this.now()).toISOString()
    if (!ok) {
      entry.errors += 1
      entry.last_error_code = code
    }
    this.actions.set(name, entry)
  }

  snapshot(limit = 50) {
    const all = [...this.actions.values()].sort((left, right) => right.calls - left.calls)
    return {
      uptime_ms: this.now() - this.startedAt,
      started_at: new Date(this.startedAt).toISOString(),
      total_calls: all.reduce((sum, entry) => sum + entry.calls, 0),
      total_errors: all.reduce((sum, entry) => sum + entry.errors, 0),
      actions: all.slice(0, limit).map(entry => ({
        ...entry,
        mean_ms: entry.calls === 0 ? 0 : Math.round(entry.total_ms / entry.calls),
      })),
      truncated: all.length > limit,
    }
  }
}

const workspaceField = () => z.string().optional()
  .describe('Workspace id from workspace_list/workspace_open. Omit for the primary workspace (the fixed project root), which is what every path in this call is relative to.')

const pathField = (description = 'Path relative to the workspace root (the fixed project root unless `workspace` is set). Absolute paths and anything resolving outside that root are rejected with OUTSIDE_SANDBOX.') =>
  z.string().min(1).max(4096).describe(description)

const confirmField = what => z.boolean().optional()
  .describe(`Must be true to perform this operation. ${what} Call without it first to receive PERMISSION_REQUIRED plus the exact description to relay to the user.`)

const truncationShape = {
  truncated: z.boolean().describe('True when the response hit a limit and more data remains.'),
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const IDEMPOTENT_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
const NETWORK_READ = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
const NETWORK_WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

/**
 * Register one direct action. Every handler returns a plain object; failures
 * throw an ActionError whose stable `code` reaches the client through the same
 * `{error:{message,code,retryable}}` envelope the Harness tools already use.
 */
function defineAction(server, registry, metrics, name, spec, handler, policy) {
  const descriptor = {
    name,
    title: spec.title,
    read_only: spec.annotations.readOnlyHint === true,
    destructive: spec.annotations.destructiveHint === true,
    // Reported as it will actually behave: advertising a confirmation the
    // bridge no longer enforces would make discovery lie.
    requires_confirmation: spec.requiresConfirmation === true && confirmationsAreRequired(),
    workspace_scoped: spec.workspaceScoped === true,
    family: spec.family,
  }
  registry.push(descriptor)
  // Workspace-scoped actions all take the same optional selector, declared in
  // one place so a new action cannot accidentally describe it differently.
  const input = spec.workspaceScoped === true ? { ...spec.input, workspace: workspaceField() } : spec.input
  // One sentence, appended once, rather than 45 hand-written variants that would
  // drift: the family descriptions all speak of "the project root", which is the
  // default workspace and stays correct when `workspace` is omitted.
  const description = spec.workspaceScoped === true
    ? `${spec.description} Paths are relative to the selected workspace, which defaults to the fixed project root; pass workspace from workspace_list to act on another opened root instead.`
    : spec.description
  server.registerTool(name, {
    title: spec.title,
    description,
    inputSchema: input,
    outputSchema: resultSchema(spec.output),
    annotations: spec.annotations,
    ...(spec.meta === undefined ? {} : { _meta: spec.meta }),
  }, async (args, extra) => {
    const started = Date.now()
    try {
      // One gate in front of every action, evaluated from this action's own
      // registry row -- captured at registration, so a new action is covered by
      // construction rather than by remembering to add it to a list.
      policy?.assertAction(descriptor)
      const outcome = await handler(args ?? {}, extra)
      metrics.record(name, Date.now() - started, true)
      // `rich` actions return media (an image block) plus the metadata object;
      // everything else returns one plain object.
      if (spec.rich === true) {
        return { content: [...outcome.content, { type: 'text', text: JSON.stringify(outcome.value) }], structuredContent: outcome.value }
      }
      return toolResult(outcome)
    } catch (error) {
      metrics.record(name, Date.now() - started, false, typeof error?.code === 'string' ? error.code : 'INTERNAL')
      return errorResult(error)
    }
  })
}

const FILE_WRITE_SHAPE = {
  path: z.string(),
  bytes: z.number().optional(),
  sha256: z.string().optional().describe('Hash of the new content; pass it back as expected_sha256 on the next update for optimistic concurrency.'),
  previous_sha256: z.string().optional(),
  mtime: z.string().optional(),
  created: z.boolean().optional(),
  unchanged: z.boolean().optional(),
  mode: z.string().optional(),
  replacements: z.number().optional(),
}

const EXEC_OUTPUT_SHAPE = {
  command: z.string(),
  argv: z.array(z.string()).optional(),
  shell: z.boolean().optional(),
  cwd: z.string(),
  exit_code: z.number().nullable().optional(),
  signal: z.string().optional(),
  timed_out: z.boolean(),
  aborted: z.boolean().optional(),
  duration_ms: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  stdout_bytes: z.number().optional(),
  stderr_bytes: z.number().optional(),
  stdout_truncated: z.boolean().optional(),
  stderr_truncated: z.boolean().optional(),
  max_output_bytes: z.number().optional(),
  sandbox: z.object({
    mode: z.string(),
    enforcement: z.string().describe('How completely the selected backend enforced the policy. "none" means the command ran unconfined.'),
    backend: z.string().optional(),
  }).optional().describe('The confinement this command actually ran under, reported so it can be verified rather than assumed.'),
}

const PROCESS_SHAPE = {
    sandbox: z.object({ mode: z.string(), enforcement: z.string(), backend: z.string().optional() }).optional().describe('The confinement this process runs under.'),
  process_id: z.string(),
  pid: z.number().nullable().optional(),
  state: z.enum(['running', 'exited', 'stopped', 'failed']),
  command: z.string(),
  argv: z.array(z.string()).optional(),
  shell: z.boolean().optional(),
  cwd: z.string(),
  label: z.string().optional(),
  started_at: z.string(),
  ended_at: z.string().optional(),
  duration_ms: z.number(),
  exit_code: z.number().nullable().optional(),
  signal: z.string().optional(),
  stdout_bytes: z.number(),
  stderr_bytes: z.number(),
  last_error: z.string().optional(),
  stdout_tail: z.string().optional(),
  stderr_tail: z.string().optional(),
  stdout_next_offset: z.number().optional(),
  stderr_next_offset: z.number().optional(),
}

const GIT_STATUS_SHAPE = {
  branch: z.string().optional(),
  head: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number(),
  behind: z.number(),
  detached: z.boolean(),
  clean: z.boolean(),
  counts: looseObject().describe('{staged, unstaged, untracked, unmerged, ignored}'),
  changes: z.array(looseObject()).describe('{path, orig_path?, status, staged, unstaged, index_status, worktree_status}'),
  total_changes: z.number(),
  ...truncationShape,
}

const FILE_STAT_LIST = z.array(looseObject()).describe('{path, additions, deletions, binary}')

/**
 * Shared fleet snapshot shape. index.js reuses it for fleet_start/status/stop so
 * the original three fleet tools and the new lifecycle tools describe exactly
 * the same object.
 */
export const FLEET_SNAPSHOT_SHAPE = {
  name: z.string(),
  status: z.string(),
  running: z.boolean(),
  size: z.number().int().optional(),
  active_workers: z.number().int().optional(),
  chat_mode: z.string().optional(),
  interval_minutes: z.number().optional(),
  stagger_seconds: z.number().optional(),
  max_session_runs: z.number().int().optional(),
  round: z.number().int().optional(),
  prompt_hash: z.string().optional(),
  config_hash: z.string().optional(),
  started_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  next_run_at: z.string().nullable().optional(),
  last_error: z.string().optional(),
  recorded_runs: z.number().int().optional(),
  not_found: z.boolean().optional(),
  summary: looseObject().optional(),
  workers: z.array(looseObject()),
}

export function registerDirectActions(server, options) {
  const { config, controller, fleetManager, processes, metrics } = options
  const workspaces = options.workspaces ?? new WorkspaceRegistry({ projectRoot: config.workspaceRoot, allowedRoots: config.workspaceAllowlist ?? [] })
  const terminals = options.terminals ?? new TerminalRegistry()
  const threads = options.threads
  const sandbox = workspaces.primary().sandbox
  const registry = []
  const policy = options.policy ?? new PermissionPolicy({ profile: config.permissionProfile, rules: config.permissionRules })
  // OS-level confinement for what the bridge spawns, through the engine's own
  // sandbox provider. Absent outside the engine, in which case a narrowed
  // profile refuses to run commands rather than running them unconfined.
  const confinement = options.confinement ?? new Confinement({ provider: options.sandboxProvider ?? null, policy })
  // Real coding-agent CLIs (claude/codex/grok/antigravity) dispatched as
  // background processes, built on the same ProcessRegistry every other
  // process_* action uses -- see subagents.js for why.
  const subagents = options.subagents ?? new SubagentRegistry({ processes })
  // The process registry is bridge-lifetime state built in index.js, so the
  // confinement is attached here rather than passed on every call.
  if (processes !== undefined && processes !== null && processes.confinement === null) processes.confinement = confinement
  if (terminals !== undefined && terminals !== null && terminals.confinement === null) terminals.confinement = confinement
  const define = (name, spec, handler) => defineAction(server, registry, metrics, name, spec, handler, policy)
  // Every workspace-scoped handler resolves its Sandbox here: an unknown id
  // fails with NOT_FOUND before a single path is touched, and omitting the
  // argument keeps the original fixed-root behaviour.
  const sandboxOf = args => workspaces.sandboxFor(args?.workspace)
  const workspaceIdOf = args => (typeof args?.workspace === 'string' && args.workspace !== '' ? args.workspace : PRIMARY_WORKSPACE_ID)
  // A Harness turn may only be anchored in a workspace the bridge already has
  // open, so an unknown id fails with NOT_FOUND before the engine sees a path
  // and the operator allowlist governs agent turns exactly as it governs
  // direct actions.
  const harnessWorkspace = args => {
    const entry = workspaces.get(args?.workspace)
    return { id: entry.id, root: entry.path }
  }
  /** Ask the relay what this build supports; unreachable relay means "no". */
  const probeRelayCapabilities = async () => {
    if (fleetManager === null || fleetManager === undefined) return {}
    try {
      return await fleetManager.transport.capabilities()
    } catch {
      return {}
    }
  }
  const workspaceUsage = workspaceId => ({
    processes: processes.runningIn(workspaceId),
    terminals: terminals.runningIn(workspaceId),
  })
  const requireFleet = () => {
    if (fleetManager === null || fleetManager === undefined) {
      fail('UNSUPPORTED', 'the ChatGPT browser fleet is not configured on this deployment; bridge_capabilities reports fleet_available=false')
    }
    return fleetManager
  }
  const actionGapCollector = options.actionGapCollector ?? new ActionGapCollector({
    stateDir: defaultActionGapStateDir(config.workspaceRoot),
    redact: options.redact,
  })

  // ----------------------------------------------------------- improvement --

  define('report_action_gap', {
    family: 'improvement',
    title: 'Report Shiro workflow friction',
    description: 'Persists one structured, redacted local report when a Shiro workflow is genuinely cumbersome, an action is missing or poorly designed, several actions should be composed, or an existing action was hard to discover. Reports are evidence for later operator review, not a request to auto-install code. Prefer one report per recurring friction pattern, not one per ordinary tool call.',
    input: {
      problem_type: z.enum(ACTION_GAP_PROBLEM_TYPES),
      task: z.string().min(1).max(2000).describe('Short description of the user task that exposed the friction.'),
      context: z.string().max(4000).optional().describe('Why the current Shiro surface made this task harder than necessary.'),
      attempted_actions: z.array(z.string().min(1).max(120)).max(30).optional().describe('Shiro actions or manual steps tried, in execution order when practical.'),
      current_workaround: z.string().max(5000).optional().describe('The cumbersome workaround currently required.'),
      suggested_action: z.string().min(1).max(120).optional().describe('Candidate action name when obvious. Exact existing-name matches are returned to help catch agent misuse.'),
      suggested_signature: z.string().max(1000).optional().describe('Compact proposed signature/schema when known; do not invent one just to fill the field.'),
      severity: z.enum(ACTION_GAP_SEVERITIES).optional().describe('Operational impact. Defaults to medium.'),
      estimated_savings_calls: z.number().int().min(0).max(100).optional().describe('Estimated direct tool calls saved per occurrence.'),
      friction: z.object({
        unnecessary_tool_calls: z.number().int().min(0).max(1000).optional(),
        retries: z.number().int().min(0).max(1000).optional(),
        permission_failures: z.number().int().min(0).max(1000).optional(),
        shell_workarounds: z.number().int().min(0).max(1000).optional(),
        schema_errors: z.number().int().min(0).max(1000).optional(),
        agent_confusion: z.number().int().min(0).max(1000).optional(),
      }).optional().describe(`Optional counters used for deterministic friction scoring. Weights: ${JSON.stringify(FRICTION_WEIGHTS)}.`),
      evidence: z.array(z.string().max(500)).max(20).optional().describe('Concise error/tool-call/timing evidence. Never include credentials or full sensitive payloads.'),
      repo_context: z.string().max(1000).optional(),
      session_context: z.string().max(1000).optional(),
      source_agent: z.string().max(120).optional().describe('Agent/model label when useful for comparing routing behavior.'),
      workspace: workspaceField().describe('Optional Shiro workspace id. When supplied, the collector records its id and project-relative context but still stores the report in Shiro local state.'),
    },
    output: {
      id: z.string(),
      fingerprint: z.string(),
      submitted_at: z.string(),
      friction_score: z.number(),
      existing_action_matches: z.array(z.string()),
      possible_agent_misuse: z.boolean(),
      queued: z.boolean(),
      state_file: z.string(),
    },
    annotations: WRITE,
  }, async args => {
    let workspaceContext
    if (args.workspace !== undefined) {
      const entry = workspaces.get(args.workspace)
      workspaceContext = { id: entry.id, name: entry.name }
    }
    return actionGapCollector.report(args, {
      knownActions: registry,
      workspaceContext,
    })
  })

  define('action_gap_summary', {
    family: 'improvement',
    title: 'Review aggregated Shiro friction',
    description: 'Reads the durable local action-gap queue and deterministically groups repeated reports by normalized fingerprint. Use this to prioritize recurring high-friction patterns before adding actions. It does not invoke an LLM, mutate reports, generate code, or install actions.',
    input: {
      limit: z.number().int().min(1).max(200).optional(),
      min_count: z.number().int().min(1).max(1000000).optional(),
      problem_type: z.enum(ACTION_GAP_PROBLEM_TYPES).optional(),
      severity: z.enum(ACTION_GAP_SEVERITIES).optional(),
    },
    output: {
      total_reports: z.number(),
      unique_gaps: z.number(),
      returned: z.number(),
      malformed_lines: z.number(),
      items: z.array(looseObject()).describe('Aggregates with count, first/last seen, max severity, friction/savings totals and a representative report.'),
      state_file: z.string(),
    },
    annotations: READ_ONLY,
  }, args => actionGapCollector.summary(args))

  // ---------------------------------------------------------------- bridge --

  define('bridge_status', {
    family: 'bridge',
    title: 'Bridge health and live workload',
    description: 'Returns bridge version, the fixed project root, uptime, active Harness root turns, running fleets, bridge-owned processes and health flags. Deterministic: no Harness session, no model call. Use bridge_capabilities for the action list and limits.',
    input: {},
    output: {
      ok: z.boolean(),
      bridge_version: z.string(),
      direct_actions_version: z.number(),
      project_root: z.string().describe('Absolute fixed root. This is the one absolute path in the public contract; every other path is relative to it.'),
      provider: z.string(),
      model: z.string(),
      uptime_ms: z.number(),
      started_at: z.string(),
      harness: looseObject().describe('{active_turns, max_concurrent_turns, pending_model_requests}'),
      fleets: looseObject().describe('{available, total, running}'),
      processes: looseObject().describe('{running, total, max}'),
      terminals: looseObject().describe('{running, total, max}'),
      workspaces: looseObject().describe('{open, max, multi_root, allowed_roots}'),
      browser_relay: looseObject().describe('{configured, url}'),
      health: looseObject().describe('Boolean flags: {git_repository, workspace_readable, fleet_manager, browser_relay}'),
    },
    annotations: READ_ONLY,
  }, async () => {
    const operations = controller.operationList({ limit: 1, all_workspaces: true })
    const processSnapshot = processes.list({ limit: 1 })
    const terminalSnapshot = terminals.list({ limit: 1 })
    let fleets = { available: fleetManager !== null && fleetManager !== undefined, total: 0, running: 0 }
    if (fleets.available) {
      try {
        const listed = await fleetManager.list()
        fleets = { available: true, total: listed.total, running: listed.running }
      } catch (error) {
        fleets = { available: true, total: 0, running: 0, error: error.message }
      }
    }
    // Health flags stay cheap on purpose: bridge_status is the endpoint a client
    // polls, so it uses a single stat for "is this a git repository" rather than
    // spawning the five git processes a full git_repo_info would cost.
    let gitRepository = false
    try {
      await fs.statPath(sandbox, { path: '.git', follow: false })
      gitRepository = true
    } catch { gitRepository = false }
    let workspaceReadable = true
    try { await sandbox.rootReal() } catch { workspaceReadable = false }
    return {
      ok: workspaceReadable,
      bridge_version: options.bridgeVersion,
      direct_actions_version: options.directActionsVersion,
      project_root: config.workspaceRoot,
      provider: config.provider,
      model: config.model,
      uptime_ms: metrics.snapshot(0).uptime_ms,
      started_at: new Date(metrics.startedAt).toISOString(),
      harness: {
        active_turns: operations.active,
        max_concurrent_turns: operations.max_concurrent_turns,
        pending_model_requests: controller.broker.snapshot().length,
      },
      fleets,
      processes: { running: processSnapshot.running, total: processSnapshot.total, max: processSnapshot.max_processes },
      terminals: { running: terminalSnapshot.running, total: terminalSnapshot.total, max: terminalSnapshot.max_terminals },
      workspaces: {
        open: workspaces.workspaces.size,
        max: WORKSPACE_LIMITS.max_open,
        multi_root: workspaces.multiRoot,
        allowed_roots: workspaces.allowedRoots.length,
      },
      browser_relay: { configured: (config.relayUrl ?? '') !== '', url: config.relayUrl ?? '' },
      health: {
        git_repository: gitRepository,
        workspace_readable: workspaceReadable,
        fleet_manager: fleets.available,
        browser_relay: (config.relayUrl ?? '') !== '',
      },
    }
  })

  define('bridge_capabilities', {
    family: 'bridge',
    title: 'Discover the exact actions and limits of this deployment',
    description: 'Returns every action this bridge exposes with its read-only/destructive/confirmation flags, the supported error codes, the speed and effort profiles, and the numeric limits (max concurrent turns, max fleet size, max output bytes, paging caps). Call this first instead of assuming a fixed action set: deployments differ, for example when the browser relay is not configured.',
    input: {},
    output: {
      bridge_version: z.string(),
      direct_actions_version: z.number(),
      project_root: z.string(),
      actions: z.array(looseObject()).describe('{name, title, family, read_only, destructive, requires_confirmation}'),
      action_count: z.number(),
      families: z.array(z.string()),
      error_codes: z.array(z.string()),
      limits: looseObject(),
      features: looseObject().describe('Boolean feature flags for optional subsystems.'),
      workspaces: looseObject().describe('{open, allowed_roots, multi_root} -- what this deployment can address beyond the project root.'),
      permission: looseObject().describe('{profile, ceiling, ...rules} -- the coarse dial in front of every action.'),
      unsupported: z.array(looseObject()).describe('Deliberately absent capabilities with the reason, so clients do not retry them.'),
    },
    annotations: READ_ONLY,
  }, async () => {
    // Relay-dependent flags are probed, never assumed: whether a capture can
    // run depends on the relay build in front of this bridge, and reporting a
    // stale true would send the client into an action that cannot work.
    const relayCapabilities = await probeRelayCapabilities()
    return {
    bridge_version: options.bridgeVersion,
    direct_actions_version: options.directActionsVersion,
    project_root: config.workspaceRoot,
    actions: [...registry, ...options.harnessActions],
    action_count: registry.length + options.harnessActions.length,
    families: [...new Set([...registry, ...options.harnessActions].map(entry => entry.family))],
    error_codes: [...ERROR_CODES],
    limits: {
      max_concurrent_turns: config.maxConcurrentTurns,
      max_fleet_size: 20,
      max_wait_ms: options.maxWaitMs,
      ...fs.FS_LIMITS,
      ...EXEC_LIMITS,
      ...git.GIT_LIMITS,
      ...tasks.TASK_LIMITS,
      ...TERMINAL_LIMITS,
      ...WORKSPACE_LIMITS,
      download_max_bytes: NET_LIMITS.max_bytes_cap,
      download_default_max_bytes: NET_LIMITS.max_bytes_default,
      image_inline_max_bytes: media.MEDIA_LIMITS.image_max_bytes,
      pdf_max_dpi: media.MEDIA_LIMITS.pdf_max_dpi,
    },
    permission: policy.snapshot(),
    features: {
      filesystem_writes: true,
      exec: true,
      shell_mode: true,
      processes: true,
      terminals: true,
      multi_root_workspaces: workspaces.multiRoot,
      harness_workspaces: true,
      thread_events: true,
      turn_steer: true,
      session_runtime_status: true,
      durable_session_kernel: controller.runtime?.kernel?.path !== ':memory:' && !!controller.runtime?.kernel && !controller.runtime?.error,
      thread_fork: controller.canFork?.() === true,
      thread_archive: true,
      git: true,
      git_network: true,
      tasks: true,
      download: true,
      file_import: true,
      images: true,
      pdf: true,
      fleet: fleetManager !== null && fleetManager !== undefined,
      browser_tabs: fleetManager !== null && fleetManager !== undefined,
      browser_screenshot: relayCapabilities.screenshot === true,
      browser_navigate: relayCapabilities.navigate === true,
      browser_dom: relayCapabilities.dom === true,
      browser_evaluate: relayCapabilities.evaluate === true,
      logs: true,
      metrics: true,
    },
    workspaces: {
      open: workspaces.records().map(entry => ({ workspace_id: entry.workspace_id, path: entry.path, primary: entry.primary })),
      allowed_roots: [...workspaces.allowedRoots],
      multi_root: workspaces.multiRoot,
    },
    unsupported: [
      { capability: 'bridge_reload', reason: 'The bridge runs as a cordis plugin inside the Harness engine process. An in-band reload would tear down the HTTP server handling the very request that asked for it, so a success response could never be delivered honestly. Restart Shiro from the launcher instead.' },
      { capability: 'harness_session_delete / harness_session_prune', reason: 'The engine apiProxy exposes list/create/history/rename/fork for sessions but no delete or archive. Removing persisted session history out of band would corrupt the engine store, so no deletion action is offered.' },
      { capability: 'config_set', reason: 'Bridge configuration is resolved once at plugin apply() time from the launcher environment; there is no runtime-mutable setting that could be changed safely. Use config_validate to check a candidate configuration before restarting.' },
      { capability: 'browser_tab_focus', reason: 'The audited relay exposes no focus route, and stealing window focus from the user is not something a background connector should do silently.' },
      ...(relayCapabilities.screenshot === true ? [] : [{ capability: 'browser_tab_screenshot (this relay build)', reason: `The action is registered and enforced end to end, but this relay exposes no ${'POST /browser/tabs/screenshot'} route and does not advertise capabilities.browser.screenshot. Capturing a background tab additionally needs a Chrome permission the bundled extension does not request (activeTab/<all_urls> for tabs.captureVisibleTab, or debugger for Page.captureScreenshot), which requires re-approving the extension. Until the relay is extended the action answers UNSUPPORTED with that reason instead of failing obscurely.` }]),
      { capability: 'full-screen terminal rendering', reason: 'terminal_read renders pty output one line at a time (cursor motion and repaints applied), which is what makes REPL and prompt transcripts readable. It is not a 2-D screen emulator, so a curses UI reads as successive repaints; pass raw=true for the exact bytes.' },
    ],
    }
  })

  // -------------------------------------------------------------- workspace --

  define('workspace_list', {
    family: 'workspace',
    title: 'List open workspaces and what else may be opened',
    description: 'Lists the workspace roots this bridge currently addresses, the operator allowlist they must come from, and -- with include_candidates=true -- the project directories inside that allowlist that could be opened. The primary workspace is the fixed project root and is always present. Every other action takes an optional `workspace` argument selecting one of these; omitting it means the primary. Deterministic and read-only.',
    input: {
      include_candidates: z.boolean().optional().describe('Also scan the allowlisted roots for openable project directories.'),
      depth: z.number().int().min(1).max(WORKSPACE_LIMITS.max_candidate_depth).optional().describe('Directory levels to scan when discovering candidates (default 1).'),
      limit: z.number().int().min(1).max(WORKSPACE_LIMITS.max_candidates).optional(),
    },
    output: {
      workspaces: z.array(looseObject()).describe('{workspace_id, name, path, primary, opened_at, running_processes, running_terminals}'),
      total: z.number(),
      max_open: z.number(),
      project_root: z.string(),
      allowed_roots: z.array(z.string()).describe('Absolute prefixes a workspace path must sit under. Empty means this deployment is single-rooted.'),
      multi_root: z.boolean(),
      candidates: z.array(looseObject()).optional().describe('{path, name, git_repository, open}'),
      candidate_count: z.number().optional(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => workspaces.list(args, entry => workspaceUsage(entry.id)))

  define('workspace_open', {
    family: 'workspace',
    title: 'Open an allowlisted directory as a workspace',
    description: 'Registers an existing directory as an addressable workspace and returns its workspace_id. The path is absolute (or ~-relative) and must resolve, symlinks included, inside one of the allowed roots reported by workspace_list; anything else fails with OUTSIDE_SANDBOX. Idempotent: opening an already-open directory returns the same id with already_open=true. Inside a workspace the usual rules are unchanged -- fs_/exec_/git_ paths stay relative to that root and cannot escape it.',
    input: {
      path: z.string().min(1).describe('Absolute directory path, for example /home/you/Projects/other-app.'),
      name: z.string().min(1).max(80).optional().describe('Short label; also seeds the workspace id.'),
    },
    output: {
      workspace_id: z.string(),
      name: z.string(),
      path: z.string(),
      primary: z.boolean(),
      opened_at: z.string(),
      already_open: z.boolean().optional(),
    },
    annotations: IDEMPOTENT_WRITE,
  }, args => workspaces.open(args))

  define('workspace_create', {
    family: 'workspace',
    title: 'Create a directory and open it as a workspace',
    description: 'Creates a directory inside the allowlist (parents included by default) and opens it as a workspace in one call, for scratch space or a new project. The allowlist is checked against the deepest existing ancestor, so a symlinked parent cannot be used to create outside the allowed roots. Returns created=false when the directory already existed.',
    input: {
      path: z.string().min(1).describe('Absolute directory path to create inside an allowed root.'),
      name: z.string().min(1).max(80).optional(),
      create_parents: z.boolean().optional().describe('Default true.'),
    },
    output: {
      workspace_id: z.string(),
      name: z.string(),
      path: z.string(),
      primary: z.boolean(),
      opened_at: z.string(),
      created: z.boolean(),
      already_open: z.boolean().optional(),
    },
    annotations: IDEMPOTENT_WRITE,
  }, args => workspaces.create(args))

  define('workspace_close', {
    family: 'workspace',
    title: 'Stop addressing one workspace',
    description: 'Removes a workspace from the addressable set. It deletes nothing on disk -- it only makes that workspace_id stop resolving. The primary workspace cannot be closed. A workspace with running processes or terminals is refused with BUSY unless force=true, and even then those keep running: stop them with process_stop / terminal_stop first if that is what you meant.',
    input: {
      workspace: z.string().min(1).describe('Workspace id from workspace_list.'),
      force: z.boolean().optional().describe('Close even while processes or terminals started in it are still running.'),
    },
    output: {
      workspace_id: z.string(),
      name: z.string(),
      path: z.string(),
      primary: z.boolean(),
      opened_at: z.string(),
      closed: z.boolean(),
      running_processes: z.number(),
      running_terminals: z.number(),
    },
    annotations: WRITE,
  }, args => workspaces.close(args, workspaceUsage(args.workspace)))

  // --------------------------------------------------------------- worktree --

  const gitSignal = extra => ({ signal: extra?.signal })

  define('worktree_create', {
    family: 'worktree',
    workspaceScoped: true,
    title: 'Create an isolated checkout and open it as a workspace',
    description: 'Adds a git worktree -- a second checkout of the same repository on its own branch, sharing one object store -- and registers it as a Shiro workspace in the same call. That workspace id then works everywhere: fs_*, exec_run, git_*, terminal_*, and harness_start({workspace}) to run a whole agent turn isolated in that checkout, which is how two tasks run in parallel without seeing each other’s edits. The destination must sit inside the operator allowlist exactly like workspace_open, and defaults to <repo>.worktrees/<branch> beside the repository. Fails with ALREADY_EXISTS when the branch is checked out elsewhere or the destination is occupied.',
    input: {
      branch: z.string().min(1).describe('Branch for the new checkout. Created from base_ref unless create_branch=false.'),
      path: z.string().min(1).optional().describe('Absolute destination. Defaults to <repo>.worktrees/<branch> beside the repository.'),
      base_ref: z.string().min(1).optional().describe('Commit or branch the new branch starts from. Defaults to the current HEAD.'),
      create_branch: z.boolean().optional().describe('Default true. false checks out an existing branch instead.'),
      name: z.string().min(1).max(80).optional().describe('Workspace label; also seeds the workspace id.'),
      repo_path: pathField('Repository directory inside the workspace. Defaults to the workspace root.').optional(),
    },
    output: {
      workspace_id: z.string().describe('Pass this as `workspace` to any action, including harness_start.'),
      path: z.string(),
      branch: z.string(),
      head: z.string().optional(),
      repository: z.string(),
      source_workspace: z.string(),
    },
    annotations: WRITE,
  }, async (args, extra) => {
    const source = workspaces.get(args.workspace)
    const repository = await worktrees.listWorktrees(source.sandbox, { path: args.repo_path }, gitSignal(extra))
    const destination = args.path ?? worktrees.defaultWorktreePath(repository.repository, args.branch)
    // Allowlist first: a checkout created somewhere the operator never allowed
    // would be a hole straight through the workspace boundary.
    workspaces.assertPathAllowed(destination)
    const opened = await workspaces.create({ path: destination, name: args.name ?? args.branch })
    try {
      const created = await worktrees.addWorktree(source.sandbox, {
        path: args.repo_path,
        branch: args.branch,
        destination,
        base_ref: args.base_ref,
        create_branch: args.create_branch,
      }, gitSignal(extra))
      return {
        workspace_id: opened.workspace_id,
        path: created.path,
        branch: created.branch,
        head: created.head,
        repository: created.repository,
        source_workspace: source.id,
      }
    } catch (error) {
      // A failed `git worktree add` must not leave a workspace pointing at an
      // empty directory that looks like a checkout.
      try { workspaces.close({ workspace: opened.workspace_id, force: true }, { processes: 0, terminals: 0 }) } catch {}
      throw error
    }
  })

  define('worktree_list', {
    family: 'worktree',
    workspaceScoped: true,
    title: 'List the checkouts of one repository',
    description: 'Every worktree of the repository, including the main checkout, with branch, HEAD, and whether git considers it locked or prunable. Entries Shiro currently has open as workspaces carry their workspace id, so this is also the map from checkout to workspace. Read-only.',
    input: { repo_path: pathField('Repository directory. Defaults to the workspace root.').optional() },
    output: {
      repository: z.string(),
      worktrees: z.array(looseObject()).describe('{path, branch?, head?, bare, detached, locked, prunable, workspace?}'),
      total: z.number(),
    },
    annotations: READ_ONLY,
  }, async (args, extra) => {
    const listed = await worktrees.listWorktrees(sandboxOf(args), { path: args.repo_path }, gitSignal(extra))
    const byPath = new Map(workspaces.records().map(entry => [entry.path, entry.workspace_id]))
    return {
      ...listed,
      worktrees: listed.worktrees.map(entry => ({ ...entry, workspace: byPath.get(entry.path) })),
    }
  })

  define('worktree_remove', {
    family: 'worktree',
    workspaceScoped: true,
    title: 'Remove a checkout',
    description: 'Removes one git worktree and closes the workspace that addressed it. A checkout with uncommitted or untracked work is refused with CONFLICT -- take a worktree_snapshot or hand the work off first -- unless force=true discards it. Requires confirm=true because it deletes a directory of work. The branch itself is not deleted.',
    input: {
      worktree: z.string().min(1).optional().describe('Workspace id of the checkout to remove. Either this or path.'),
      path: z.string().min(1).optional().describe('Absolute path of the checkout, when it is not open as a workspace.'),
      repo_path: pathField('Repository directory. Defaults to the workspace root.').optional(),
      force: z.boolean().optional().describe('Discard uncommitted and untracked work in that checkout.'),
      confirm: confirmField('It deletes a checkout directory.'),
    },
    output: {
      path: z.string(),
      removed: z.boolean(),
      forced: z.boolean(),
      repository: z.string(),
      workspace_closed: z.string().optional(),
    },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, async (args, extra) => {
    if ((args.worktree === undefined) === (args.path === undefined)) {
      fail('INVALID_ARGUMENT', 'pass exactly one of worktree (a workspace id) or path')
    }
    const entry = args.worktree === undefined ? undefined : workspaces.get(args.worktree)
    if (entry?.primary === true) fail('INVALID_ARGUMENT', 'the primary workspace is the main checkout and cannot be removed as a worktree')
    const target = entry?.path ?? args.path
    requireConfirmation(args.confirm, `Remove the checkout at ${target}${args.force === true ? ', discarding uncommitted work' : ''}`)
    const removed = await worktrees.removeWorktree(sandboxOf(args), {
      path: args.repo_path,
      worktree_path: target,
      force: args.force,
    }, gitSignal(extra))
    let closed
    if (entry !== undefined) {
      workspaces.close({ workspace: entry.id, force: true }, workspaceUsage(entry.id))
      closed = entry.id
    }
    return { ...removed, workspace_closed: closed }
  })

  define('worktree_snapshot', {
    family: 'worktree',
    workspaceScoped: true,
    title: 'Save the current working tree without changing it',
    description: 'Captures everything the working tree currently holds -- staged, unstaged, and untracked files -- as a commit pinned under refs/shiro/snapshots, then leaves the working tree and the index exactly as they were. It is a save point, not a stash: nothing is reverted, nothing is staged. Use it before a risky change, before removing a worktree, or as the first half of a handoff. Snapshots survive git gc.',
    input: {
      label: z.string().max(worktrees.WORKTREE_LIMITS.max_label_length).optional().describe('Short human label recorded with the snapshot.'),
      repo_path: pathField('Repository directory. Defaults to the workspace root.').optional(),
    },
    output: {
      snapshot_id: z.string(),
      commit: z.string(),
      base: z.string(),
      label: z.string().optional(),
      files_changed: z.number(),
      repository: z.string(),
    },
    annotations: WRITE,
  }, (args, extra) => worktrees.createSnapshot(sandboxOf(args), { path: args.repo_path, label: args.label }, gitSignal(extra)))

  define('worktree_snapshots', {
    family: 'worktree',
    workspaceScoped: true,
    title: 'List save points',
    description: 'Snapshots taken in this repository, newest ref order, with id, commit, creation time and label. Snapshots are shared by every worktree of the repository, because they are refs in one object store -- which is what makes a handoff between checkouts possible. Read-only.',
    input: { repo_path: pathField('Repository directory. Defaults to the workspace root.').optional() },
    output: {
      repository: z.string(),
      snapshots: z.array(looseObject()).describe('{snapshot_id, commit, created_at, label?}'),
      total: z.number(),
    },
    annotations: READ_ONLY,
  }, (args, extra) => worktrees.listSnapshots(sandboxOf(args), { path: args.repo_path }, gitSignal(extra)))

  define('worktree_restore', {
    family: 'worktree',
    workspaceScoped: true,
    title: 'Bring a save point back into this checkout',
    description: 'Applies a snapshot’s changes to the working tree it came from. The changes arrive as ordinary working-tree edits, so nothing is silently staged, and the patch is checked before a single byte is written: if it does not apply cleanly the call fails with GIT_CONFLICT and the tree is untouched. Requires confirm=true because it writes over files you may have changed since.',
    input: {
      snapshot_id: z.string().min(1),
      repo_path: pathField('Repository directory. Defaults to the workspace root.').optional(),
      confirm: confirmField('It writes snapshot content over the current working tree.'),
    },
    output: {
      snapshot_id: z.string(),
      commit: z.string().optional(),
      applied: z.boolean(),
      empty: z.boolean(),
      files_changed: z.number(),
      repository: z.string(),
    },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, async (args, extra) => {
    requireConfirmation(args.confirm, `Apply snapshot ${args.snapshot_id} over the current working tree`)
    const sandbox = sandboxOf(args)
    return await worktrees.applySnapshot(sandbox, sandbox, {
      path: args.repo_path,
      target_path: args.repo_path,
      snapshot_id: args.snapshot_id,
    }, gitSignal(extra))
  })

  define('worktree_handoff', {
    family: 'worktree',
    title: 'Move uncommitted work between checkouts',
    description: 'Carries in-progress work from one workspace to another: start something in the main checkout and continue it in an isolated worktree, or bring a worktree’s result back. Without snapshot_id it takes a fresh snapshot of the source first, so one call is the whole handoff. Both sides must be checkouts of the same repository -- they share an object store, so nothing is copied through a temporary file. The patch is checked before anything is written and a conflict fails with GIT_CONFLICT leaving the target untouched. Requires confirm=true because it writes into another working tree. The source is never modified.',
    input: {
      from: workspaceField(),
      to: z.string().min(1).describe('Workspace id receiving the work.'),
      snapshot_id: z.string().min(1).optional().describe('Existing snapshot to hand over. Omit to snapshot the source now.'),
      label: z.string().max(worktrees.WORKTREE_LIMITS.max_label_length).optional(),
      confirm: confirmField('It writes work into another checkout.'),
    },
    output: {
      from: z.string(),
      to: z.string(),
      snapshot_id: z.string(),
      commit: z.string().optional(),
      applied: z.boolean(),
      empty: z.boolean(),
      files_changed: z.number(),
      repository: z.string(),
    },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, async (args, extra) => {
    const source = workspaces.get(args.from)
    const target = workspaces.get(args.to)
    if (source.id === target.id) fail('INVALID_ARGUMENT', 'from and to are the same workspace; use worktree_restore to re-apply a snapshot in place')
    requireConfirmation(args.confirm, `Hand work from workspace ${source.id} into ${target.id}`)
    const snapshotId = args.snapshot_id ?? (await worktrees.createSnapshot(source.sandbox, { label: args.label ?? `handoff to ${target.id}` }, gitSignal(extra))).snapshot_id
    const applied = await worktrees.applySnapshot(source.sandbox, target.sandbox, { snapshot_id: snapshotId }, gitSignal(extra))
    return { ...applied, from: source.id, to: target.id, snapshot_id: snapshotId }
  })

  define('worktree_snapshot_drop', {
    family: 'worktree',
    workspaceScoped: true,
    title: 'Delete a save point',
    description: 'Removes one snapshot ref. The commit becomes unreachable and git gc collects it eventually. It does not touch any working tree. Requires confirm=true because a save point is often the only copy of the work it holds.',
    input: {
      snapshot_id: z.string().min(1),
      repo_path: pathField('Repository directory. Defaults to the workspace root.').optional(),
      confirm: confirmField('It discards a save point.'),
    },
    output: { snapshot_id: z.string(), commit: z.string(), deleted: z.boolean(), repository: z.string() },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, async (args, extra) => {
    requireConfirmation(args.confirm, `Delete snapshot ${args.snapshot_id}`)
    return await worktrees.dropSnapshot(sandboxOf(args), { path: args.repo_path, snapshot_id: args.snapshot_id }, gitSignal(extra))
  })

  // ------------------------------------------------------------ filesystem --

  define('fs_read', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'Read one file under the project root',
    description: 'Reads a bounded window of one file inside the fixed project root. Default is a byte window from offset 0; pass start_line/end_line for a line range instead. Returns the content plus size, mtime and the full-file sha256 to pass back as expected_sha256 when writing. When truncated is true, call again with next_offset (or next_start_line). Replaces asking Harness to read a file.',
    input: {
      path: pathField(),
      offset: z.number().int().min(0).optional().describe('Byte offset to read from. Ignored in line mode.'),
      max_bytes: z.number().int().min(1).max(fs.FS_LIMITS.read_max_bytes).optional(),
      start_line: z.number().int().min(1).optional().describe('1-based first line. Switches to line mode.'),
      end_line: z.number().int().min(1).optional().describe('1-based last line, inclusive.'),
      encoding: z.enum(['utf8', 'base64']).optional().describe('base64 is for binary files and is not available in line mode.'),
    },
    output: {
      path: z.string(),
      encoding: z.string(),
      mode: z.enum(['bytes', 'lines']),
      content: z.string(),
      byte_offset: z.number().optional(),
      bytes_returned: z.number().optional(),
      start_line: z.number().optional(),
      end_line: z.number().optional(),
      line_count: z.number().optional(),
      next_start_line: z.number().optional(),
      next_offset: z.number().optional(),
      size: z.number(),
      mtime: z.string(),
      sha256: z.string().optional().describe('Absent for files larger than the hash limit.'),
      eof: z.boolean(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => fs.readEntry(sandboxOf(args), args))

  define('fs_list', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'List a directory under the project root',
    description: 'Lists directory entries with type, size and mtime, sorted by name. Set recursive with depth for a tree. .git, node_modules, dist and similar heavy directories are skipped unless include_ignored is true. Paginate with the returned next_cursor. Related: fs_search for content, fs_stat for one path.',
    input: {
      path: pathField('Directory relative to the fixed project root. Defaults to the root itself.').optional(),
      recursive: z.boolean().optional(),
      depth: z.number().int().min(1).max(fs.FS_LIMITS.list_max_depth).optional().describe('Maximum recursion depth; only meaningful with recursive=true.'),
      glob: z.array(z.string()).max(32).optional().describe('Include patterns matched against the project-relative path (* ? ** and [] classes).'),
      exclude: z.array(z.string()).max(32).optional(),
      include_hidden: z.boolean().optional(),
      include_ignored: z.boolean().optional(),
      limit: z.number().int().min(1).max(fs.FS_LIMITS.list_max_entries).optional(),
      cursor: z.string().optional().describe('next_cursor from a previous call.'),
    },
    output: {
      path: z.string(),
      entries: z.array(looseObject()).describe('{path, name, type, size?, mtime?}'),
      total_matched: z.number(),
      returned: z.number(),
      cursor: z.number(),
      next_cursor: z.string().optional(),
      scan_capped: z.number().optional().describe('Present when the traversal hit the hard scan cap; narrow the path or glob.'),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => fs.listDirectory(sandboxOf(args), args))

  define('fs_stat', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'Metadata for one path',
    description: 'Returns type, size, mtime, ctime and permission bits for one path inside the fixed project root, plus sha256 when include_hash is true and the file is small enough. Symlinks are reported with their target; a link pointing outside the root fails with OUTSIDE_SANDBOX when followed. Fails with NOT_FOUND when the path does not exist.',
    input: {
      path: pathField(),
      include_hash: z.boolean().optional().describe('Compute sha256 of the content. Off by default because it reads the whole file.'),
      follow: z.boolean().optional().describe('Follow symlinks (default true). false reports the link itself.'),
    },
    output: {
      path: z.string(),
      type: z.enum(['file', 'directory', 'symlink', 'other']),
      size: z.number(),
      mtime: z.string(),
      ctime: z.string(),
      mode: z.string(),
      sha256: z.string().optional(),
      is_symlink: z.boolean(),
      symlink_target: z.string().optional(),
    },
    annotations: READ_ONLY,
  }, args => fs.statPath(sandboxOf(args), args))

  define('fs_search', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'Search file contents under the project root',
    description: 'Literal (default) or regular-expression content search across the fixed project root, returning bounded snippets with path, line and column, ordered by path. Heavy directories and binary files are skipped; results stop at max_results with truncated=true, and scan_capped appears when the tree was too large to walk completely -- narrow with path or glob for a complete answer on a big repository. Replaces asking Harness to grep. Related: fs_list to find files by name.',
    input: {
      query: z.string().min(1),
      path: pathField('File or directory to search. Defaults to the whole project root.').optional(),
      regex: z.boolean().optional(),
      case_sensitive: z.boolean().optional(),
      glob: z.array(z.string()).max(32).optional().describe('Only search files whose project-relative path matches one of these patterns.'),
      exclude: z.array(z.string()).max(32).optional(),
      max_results: z.number().int().min(1).max(fs.FS_LIMITS.search_max_results).optional(),
      max_matches_per_file: z.number().int().min(1).max(100).optional(),
      context_lines: z.number().int().min(0).max(5).optional(),
      include_hidden: z.boolean().optional(),
      include_ignored: z.boolean().optional(),
    },
    output: {
      query: z.string(),
      regex: z.boolean(),
      path: z.string(),
      matches: z.array(looseObject()).describe('{path, line, column, text, before?, after?}'),
      match_count: z.number(),
      files_scanned: z.number(),
      files_skipped: z.number(),
      scan_capped: z.number().optional().describe('Present when the walk hit the hard file cap before covering the whole tree: narrow with path or glob to get a complete answer.'),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => fs.searchText(sandboxOf(args), args))

  define('fs_create_file', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'Create a file under the project root',
    description: 'Creates one file with the given content, written atomically (temp file plus rename). Idempotent: creating a file that already holds exactly this content returns unchanged=true. A file that exists with different content fails with ALREADY_EXISTS unless fail_if_exists=false. Use fs_update_file to modify an existing file.',
    input: {
      path: pathField(),
      content: z.string().describe('Full file content.'),
      encoding: z.enum(['utf8', 'base64']).optional(),
      create_parents: z.boolean().optional(),
      fail_if_exists: z.boolean().optional().describe('Default true. false overwrites an existing file.'),
    },
    output: FILE_WRITE_SHAPE,
    annotations: IDEMPOTENT_WRITE,
  }, args => fs.createFile(sandboxOf(args), args))

  define('fs_update_file', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'Update an existing file',
    description: 'Rewrites a file atomically. mode=replace writes new full content, mode=replace_once swaps a single unique occurrence of find with replace (CONFLICT when it occurs more than once), mode=append adds to the end. Pass expected_sha256 from a previous fs_read or write for optimistic concurrency: a changed file fails with CONFLICT instead of clobbering.',
    input: {
      path: pathField(),
      mode: z.enum(['replace', 'replace_once', 'append']).optional(),
      content: z.string().optional().describe('Required for replace and append.'),
      find: z.string().optional().describe('replace_once: the exact text to replace, unique in the file.'),
      replace: z.string().optional().describe('replace_once: the replacement text.'),
      encoding: z.enum(['utf8', 'base64']).optional(),
      expected_sha256: z.string().optional().describe('Fail with CONFLICT unless the file currently hashes to this.'),
      create: z.boolean().optional().describe('Create the file when missing instead of failing with NOT_FOUND.'),
    },
    output: FILE_WRITE_SHAPE,
    annotations: WRITE,
  }, args => fs.updateFile(sandboxOf(args), args))

  define('fs_mkdir', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'Create a directory',
    description: 'Creates one directory inside the fixed project root. parents=true creates missing ancestors. Idempotent by default: an existing directory returns created=false; set exist_ok=false to fail with ALREADY_EXISTS instead.',
    input: {
      path: pathField(),
      parents: z.boolean().optional(),
      exist_ok: z.boolean().optional(),
    },
    output: { path: z.string(), created: z.boolean() },
    annotations: IDEMPOTENT_WRITE,
  }, args => fs.makeDirectory(sandboxOf(args), args))

  define('fs_delete', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'Delete a file or directory',
    description: 'Deletes one path inside the fixed project root. Files and empty directories delete directly; a non-empty directory needs recursive=true AND confirm=true. Optional expected_type and expected_sha256 make the delete fail with CONFLICT if the target is not what the caller last saw. Never deletes outside the root and never follows a symlink to its target.',
    input: {
      path: pathField(),
      recursive: z.boolean().optional().describe('Required to delete a non-empty directory tree.'),
      expected_type: z.enum(['file', 'directory', 'symlink']).optional(),
      expected_sha256: z.string().optional(),
      confirm: confirmField('It permanently removes a directory tree.'),
    },
    output: {
      path: z.string(),
      deleted: z.boolean(),
      type: z.string(),
      entries_removed: z.number().optional(),
    },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, async args => {
    if (args.recursive === true) {
      requireConfirmation(args.confirm, `Recursively delete the directory tree at ${args.path}`)
    }
    return await fs.deletePath(sandboxOf(args), args)
  })

  define('fs_move', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'Move or rename a path',
    description: 'Moves or renames one path inside the fixed project root. Both sides are sandbox-validated. Refuses to overwrite by default; overwrite=true additionally requires confirm=true because it destroys the destination.',
    input: {
      source: pathField(),
      destination: pathField(),
      overwrite: z.boolean().optional(),
      create_parents: z.boolean().optional(),
      confirm: confirmField('It replaces an existing destination.'),
    },
    output: {
      source: z.string(),
      destination: z.string(),
      moved: z.boolean(),
      overwrote: z.boolean().optional(),
      unchanged: z.boolean().optional(),
    },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, async args => {
    if (args.overwrite === true) requireConfirmation(args.confirm, `Overwrite ${args.destination} by moving ${args.source} onto it`)
    return await fs.movePath(sandboxOf(args), args)
  })

  define('fs_copy', {
    family: 'filesystem',
    workspaceScoped: true,
    title: 'Copy a file or directory',
    description: 'Copies one path to another inside the fixed project root. Directories need recursive=true. Refuses to overwrite by default; overwrite=true additionally requires confirm=true.',
    input: {
      source: pathField(),
      destination: pathField(),
      recursive: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      create_parents: z.boolean().optional(),
      confirm: confirmField('It replaces an existing destination.'),
    },
    output: {
      source: z.string(),
      destination: z.string(),
      copied: z.boolean(),
      type: z.string(),
      overwrote: z.boolean().optional(),
    },
    annotations: WRITE,
    requiresConfirmation: true,
  }, async args => {
    if (args.overwrite === true) requireConfirmation(args.confirm, `Overwrite ${args.destination} by copying ${args.source} onto it`)
    return await fs.copyPath(sandboxOf(args), args)
  })

  // ------------------------------------------------------- exec / processes --

  define('exec_run', {
    family: 'process',
    workspaceScoped: true,
    title: 'Run one command and wait for it',
    description: `Runs one foreground command inside the fixed project root and returns exit code, stdout, stderr, duration and truncation flags. argv is an array run without a shell, so arguments can never become shell syntax; shell=true with a command string is available for pipelines and is reported back in the result. The child environment is an allowlist plus your env overlay -- the bridge's own tokens are never inherited. Timeout defaults to ${EXEC_LIMITS.timeout_default_ms} ms. For servers and watchers use process_start; for declared scripts use task_run.`,
    input: {
      argv: z.array(z.string()).min(1).max(256).optional().describe('Executable followed by arguments, for example ["node","--test","bridge/tests/x.test.js"].'),
      command: z.string().optional().describe('Only with shell=true: a full shell command line.'),
      shell: z.boolean().optional().describe('Run command through the system shell. Off by default; prefer argv.'),
      cwd: pathField('Working directory relative to the fixed project root.').optional(),
      env: z.record(z.string(), z.string()).optional().describe('Extra environment variables layered over the allowlisted base environment.'),
      stdin: z.string().optional(),
      timeout_ms: z.number().int().min(100).max(EXEC_LIMITS.timeout_max_ms).optional(),
      max_output_bytes: z.number().int().min(1024).max(EXEC_LIMITS.output_max_bytes).optional(),
      sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('OS-level confinement for this one command, through the engine sandbox provider. Can only NARROW the permission profile, never widen it. Omitted means the profile decides. The result reports what was actually enforced.'),
    },
    output: EXEC_OUTPUT_SHAPE,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args, extra) => {
    policy.assertCommand({ argv: args.argv, command: args.command, shell: args.shell === true })
    return runCommand(sandboxOf(args), args, { signal: extra?.signal, confinement })
  })

  define('process_start', {
    family: 'process',
    workspaceScoped: true,
    title: 'Start a long-running process',
    description: 'Starts a background process inside the fixed project root (dev server, watcher, tunnel) and returns immediately with a stable process_id. Output is captured into a bounded ring buffer readable with process_logs. The process is owned by this bridge and is killed when the bridge shuts down. A command that exits immediately still appears in process_list with its exit code.',
    input: {
      argv: z.array(z.string()).min(1).max(256).optional(),
      command: z.string().optional().describe('Only with shell=true.'),
      shell: z.boolean().optional(),
      cwd: pathField('Working directory relative to the fixed project root.').optional(),
      env: z.record(z.string(), z.string()).optional(),
      label: z.string().max(120).optional().describe('Short human label shown in process_list.'),
      sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('OS-level confinement for this process, through the engine sandbox provider. Can only NARROW the permission profile, never widen it. The result reports what was actually enforced.'),
    },
    output: PROCESS_SHAPE,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => {
    policy.assertCommand({ argv: args.argv, command: args.command, shell: args.shell === true })
    return processes.start(args, { sandbox: sandboxOf(args), workspaceId: workspaceIdOf(args) })
  })

  define('process_status', {
    family: 'process',
    title: 'Inspect one bridge-owned process',
    description: 'Returns state, exit code, timing and a bounded tail of recent output for one process started with process_start. Use process_logs for cursor-based reads of the full captured output.',
    input: {
      process_id: z.string().uuid(),
      tail_bytes: z.number().int().min(0).max(65_536).optional().describe('Bytes of recent output per stream; 0 omits the tails.'),
    },
    output: PROCESS_SHAPE,
    annotations: READ_ONLY,
  }, args => processes.status(args))

  define('process_logs', {
    family: 'process',
    title: 'Read captured process output',
    description: 'Cursor-based read of one stream of a bridge-owned process. Offsets are absolute byte counts since start: pass next_offset back to continue. If the ring buffer dropped older bytes, dropped_bytes says exactly how many were lost rather than silently skipping them.',
    input: {
      process_id: z.string().uuid(),
      stream: z.enum(['stdout', 'stderr']).optional(),
      from_offset: z.number().int().min(0).optional(),
      max_bytes: z.number().int().min(256).max(EXEC_LIMITS.output_max_bytes).optional(),
    },
    output: {
      process_id: z.string(),
      stream: z.string(),
      state: z.string(),
      content: z.string(),
      offset: z.number(),
      next_offset: z.number(),
      dropped_bytes: z.number(),
      total_bytes: z.number(),
      eof: z.boolean(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => processes.logs(args))

  define('process_stop', {
    family: 'process',
    title: 'Stop a bridge-owned process',
    description: 'Sends SIGTERM to one bridge-owned process and escalates to SIGKILL after grace_ms. force=true sends SIGKILL immediately. Stopping an already-finished process is a no-op that returns already_stopped=true. It only ever signals processes this bridge started.',
    input: {
      process_id: z.string().uuid(),
      grace_ms: z.number().int().min(0).max(EXEC_LIMITS.stop_grace_max_ms).optional(),
      force: z.boolean().optional().describe('Skip SIGTERM and send SIGKILL immediately.'),
    },
    output: { ...PROCESS_SHAPE, escalated_to_sigkill: z.boolean().optional(), already_stopped: z.boolean().optional() },
    annotations: DESTRUCTIVE,
  }, args => processes.stop(args))

  define('process_list', {
    family: 'process',
    title: 'List bridge-owned processes',
    description: 'Lists only processes this bridge started, newest first. It never enumerates host processes. Filter with state to find what is still running.',
    input: {
      state: z.enum(['running', 'exited', 'stopped', 'failed']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    output: {
      processes: z.array(looseObject()),
      total: z.number(),
      running: z.number(),
      max_processes: z.number(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => processes.list(args))

  // -------------------------------------------------------- subagents --

  const SUBAGENT_SHAPE = {
    process_id: z.string(),
    agent: z.enum(Object.keys(SUBAGENT_ADAPTERS)),
    unverified: z.boolean().optional().describe('true for an adapter never exercised against a signed-in account on this deployment; treat its result shape as best-effort.'),
    state: z.enum(['starting', 'running', 'exited', 'stopped', 'failed']).optional(),
    pid: z.number().nullable().optional(),
    cwd: z.string().optional(),
    workspace: z.string().optional(),
    started_at: z.string().optional(),
    ended_at: z.string().optional(),
    duration_ms: z.number().optional(),
    exit_code: z.number().nullable().optional(),
    sandbox: z.object({ mode: z.string(), enforcement: z.string(), backend: z.string().optional() }).optional(),
    turn_done: z.boolean().optional().describe('The CLI has produced its final result; false while still running.'),
    turn_success: z.boolean().optional(),
    thread_id: z.string().optional().describe("This CLI's own session/thread id -- pass it as resume_from to continue."),
    message: z.string().optional().describe('The final reply text, once turn_done is true.'),
    usage: looseObject().optional(),
    warnings: z.array(z.string()).optional(),
    unverified_shape: z.boolean().optional().describe('The output did not match any known field name for this (unverified) adapter; message carries the raw JSON instead.'),
    resumed_from: z.string().optional(),
  }

  define('subagent_providers', {
    family: 'subagent',
    title: 'Which coding-agent CLIs are available',
    description: 'Probes claude, codex, grok and antigravity: whether each binary is installed and whether it looks signed in. authenticated is true/false only when the probe could classify it, otherwise null (unknown) -- never guessed. Call this before subagent_start on an agent you have not used yet, since an uninstalled or signed-out CLI fails at spawn, not at discovery. Read-only, no bridge-owned process is created.',
    input: {},
    output: {
      providers: z.array(looseObject()).describe('{agent, label, installed, version?, authenticated, unverified}'),
    },
    annotations: READ_ONLY,
  }, () => subagents.providers())

  define('subagent_start', {
    family: 'subagent',
    workspaceScoped: true,
    title: 'Dispatch a real coding-agent CLI as a sub-agent',
    description: `Runs claude, codex, grok or antigravity headlessly as a bridge-owned background process -- its own full agent loop, its own tool use, under its own account and sandbox, working in this workspace. Returns immediately with a process_id; poll subagent_status or subagent_log for the result, the way you would with process_start. Pass resume_from (a prior process_id, or a raw thread/session id) to continue that CLI's own conversation instead of starting fresh. dangerously_skip_permissions maps to each CLI's own full-bypass mode; where a CLI gates that behind a one-time interactive disclaimer (claude does), the CLI's own refusal -- naming its own unlock step -- surfaces in subagent_status, and Shiro never answers that dialog itself. grok and antigravity are ${SUBAGENT_ADAPTERS.grok.unverified ? 'unverified on this deployment' : 'verified'} -- see subagent_providers.`,
    input: {
      agent: z.enum(Object.keys(SUBAGENT_ADAPTERS)),
      prompt: z.string().min(1).max(50_000),
      path: pathField('Working directory the CLI runs in, relative to the workspace.').optional(),
      resume_from: z.string().optional().describe('A process_id from an earlier subagent_start, or a raw session/thread id, to continue that conversation.'),
      model: z.string().optional(),
      permission_mode: z.string().optional().describe('Passed through to the CLI (claude/grok: --permission-mode; antigravity: --mode). bypassPermissions is refused -- see dangerously_skip_permissions.'),
      sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('codex only: its own --sandbox. Default workspace-write.'),
      dangerously_skip_permissions: z.boolean().optional().describe('Full bypass of the CLI\'s own tool-approval, via its own flag/mode. If the CLI gates this behind a one-time disclaimer that was never accepted on this machine, its own refusal shows up in subagent_status.'),
    },
    output: SUBAGENT_SHAPE,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args, extra) => subagents.start(args, { sandbox: sandboxOf(args), workspaceId: args.workspace }))

  define('subagent_status', {
    family: 'subagent',
    title: 'Check on a dispatched sub-agent',
    description: 'State, resource facts and -- once turn_done -- the parsed final result of one subagent_start call. While still running, turn_done is false and message is absent; use subagent_log for a raw tail of a long-running one. Read-only.',
    input: { process_id: z.string().uuid() },
    output: SUBAGENT_SHAPE,
    annotations: READ_ONLY,
  }, args => subagents.status(args))

  define('subagent_log', {
    family: 'subagent',
    title: "Read a sub-agent's raw output",
    description: "Cursor-based read of one stream of a dispatched sub-agent's process, same convention as process_logs. Useful mid-run (codex streams NDJSON as it works) or to see exactly what a CLI printed rather than the parsed summary subagent_status gives. Read-only.",
    input: {
      process_id: z.string().uuid(),
      stream: z.enum(['stdout', 'stderr']).optional(),
      from_offset: z.number().int().min(0).optional(),
      max_bytes: z.number().int().min(256).max(EXEC_LIMITS.output_max_bytes).optional(),
    },
    output: {
      process_id: z.string(),
      stream: z.string(),
      state: z.string(),
      content: z.string(),
      offset: z.number(),
      next_offset: z.number(),
      dropped_bytes: z.number(),
      total_bytes: z.number(),
      eof: z.boolean(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => subagents.log(args))

  define('subagent_stop', {
    family: 'subagent',
    title: 'Stop a dispatched sub-agent',
    description: "Sends SIGTERM to a subagent's process and escalates to SIGKILL after grace_ms, same as process_stop. Its conversation may still be resumable through the CLI's own session store even after being stopped here -- stopping ends the process, not necessarily the underlying session.",
    input: {
      process_id: z.string().uuid(),
      grace_ms: z.number().int().min(0).max(EXEC_LIMITS.stop_grace_max_ms).optional(),
      force: z.boolean().optional(),
    },
    output: { ...SUBAGENT_SHAPE, escalated_to_sigkill: z.boolean().optional(), already_stopped: z.boolean().optional() },
    annotations: DESTRUCTIVE,
  }, args => subagents.stop(args))

  define('subagent_list', {
    family: 'subagent',
    title: 'List dispatched sub-agents',
    description: 'Lists only subagent_start-created processes, newest first -- process_list shows every bridge-owned process including these, but without which CLI each one is. Filter with state to find what is still running.',
    input: {
      state: z.enum(['running', 'exited', 'stopped', 'failed']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    output: {
      subagents: z.array(looseObject()),
      total: z.number(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => subagents.list(args))


  // GIT/TASK/HARNESS/FLEET/BROWSER/ARTIFACT/CONFIG families are appended below.
  // ----------------------------------------------------------- terminals --

  const TERMINAL_SHAPE = {
    terminal_id: z.string(),
    state: z.enum(['starting', 'running', 'exited', 'stopped', 'failed']),
    command: z.string(),
    argv: z.array(z.string()).optional(),
    cwd: z.string(),
    workspace: z.string().optional(),
    sandbox: z.object({ mode: z.string(), enforcement: z.string(), backend: z.string().optional() }).optional().describe('The confinement this terminal runs under. Everything typed into it is a descendant of the confined PTY host.'),
    label: z.string().optional(),
    pid: z.number().nullable().optional(),
    cols: z.number(),
    rows: z.number(),
    started_at: z.string(),
    ended_at: z.string().optional(),
    duration_ms: z.number(),
    exit_code: z.number().nullable().optional(),
    signal: z.number().optional(),
    output_bytes: z.number(),
    last_output_at: z.string().optional(),
    last_error: z.string().optional(),
  }

  define('terminal_start', {
    family: 'terminal',
    workspaceScoped: true,
    title: 'Open an interactive terminal (pty)',
    description: `Starts a program on a real pseudo-terminal and returns a terminal_id you can keep typing into. This is what process_start cannot do: anything that asks a question -- a Python or Node REPL, gh auth login, an npm scaffolder, ssh, a package manager prompt, a debugger, a curses UI -- needs a tty plus an input channel. Defaults to an interactive shell when argv is omitted. Up to ${TERMINAL_LIMITS.max_terminals} terminals may be open; they are owned by this bridge and die with it. Read output with terminal_read, answer with terminal_write. For a command that needs no input, exec_run is cheaper.`,
    input: {
      argv: z.array(z.string()).min(1).max(256).optional().describe('Program and arguments. Omit for the login shell (SHELL, or /bin/bash) started interactively.'),
      cwd: pathField('Working directory relative to the workspace root.').optional(),
      env: z.record(z.string(), z.string()).optional().describe('Extra environment over the allowlisted base; TERM is set to xterm-256color.'),
      cols: z.number().int().min(20).max(TERMINAL_LIMITS.max_cols).optional(),
      rows: z.number().int().min(4).max(TERMINAL_LIMITS.max_rows).optional(),
      label: z.string().max(120).optional(),
      sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('OS-level confinement for the whole terminal session, through the engine sandbox provider. Everything typed in later inherits it. Can only NARROW the permission profile.'),
    },
    output: TERMINAL_SHAPE,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => {
    policy.assertCommand({ argv: args.argv })
    return terminals.start(args, { sandbox: sandboxOf(args), workspaceId: workspaceIdOf(args) })
  })

  define('terminal_write', {
    family: 'terminal',
    title: 'Type into a terminal',
    description: `Sends keystrokes to a live terminal. input is sent verbatim, keys sends named control keys (${Object.keys(CONTROL_KEYS).join(', ')}), and submit=true appends Enter -- so answering a prompt is one call. Nothing is echoed back here: read the result with terminal_read, which can wait for the program to finish printing. Sending ctrl-c as a key is the polite interrupt; terminal_signal is the out-of-band one.`,
    input: {
      terminal_id: z.string().uuid(),
      input: z.string().optional().describe('Literal text to type.'),
      keys: z.array(z.enum(Object.keys(CONTROL_KEYS))).max(32).optional(),
      submit: z.boolean().optional().describe('Append Enter after input/keys.'),
    },
    output: { ...TERMINAL_SHAPE, bytes_written: z.number() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => terminals.write(args))

  define('terminal_read', {
    family: 'terminal',
    title: 'Read a terminal transcript',
    description: `Cursor-based read of one terminal. Offsets are absolute byte counts, so pass next_offset back to continue; dropped_bytes reports exactly what the ring buffer lost. wait_ms blocks server-side until the program has been quiet for settle_ms (default 250 ms), which turns write-then-read into a single round-trip instead of a poll loop. Output is rendered the way a terminal would paint it -- cursor moves and repaints applied, colour removed -- so a REPL echo reads as one clean line; pass raw=true for the exact bytes. Full-screen TUIs are rendered per line, not as a screen.`,
    input: {
      terminal_id: z.string().uuid(),
      from_offset: z.number().int().min(0).optional().describe('Omit to read the most recent max_bytes.'),
      max_bytes: z.number().int().min(256).max(TERMINAL_LIMITS.read_max_bytes).optional(),
      wait_ms: z.number().int().min(0).max(TERMINAL_LIMITS.wait_max_ms).optional().describe('Wait up to this long for output before answering.'),
      settle_ms: z.number().int().min(0).max(5000).optional().describe('Within wait_ms, return once output has paused this long. 0 returns at the first byte.'),
      raw: z.boolean().optional().describe('Return the untouched pty bytes including escape sequences.'),
    },
    output: {
      ...TERMINAL_SHAPE,
      content: z.string(),
      raw: z.boolean(),
      offset: z.number(),
      next_offset: z.number(),
      dropped_bytes: z.number(),
      total_bytes: z.number(),
      idle: z.boolean().describe('True when nothing new had arrived past from_offset.'),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => terminals.read(args))

  define('terminal_resize', {
    family: 'terminal',
    title: 'Resize a terminal window',
    description: 'Changes the pty window size (TIOCSWINSZ) so the program re-wraps and repaints. Programs that lay out by width -- pagers, curses apps, anything printing tables -- need this to match what you want to read.',
    input: {
      terminal_id: z.string().uuid(),
      cols: z.number().int().min(20).max(TERMINAL_LIMITS.max_cols).optional(),
      rows: z.number().int().min(4).max(TERMINAL_LIMITS.max_rows).optional(),
    },
    output: TERMINAL_SHAPE,
    annotations: IDEMPOTENT_WRITE,
  }, args => terminals.resize(args))

  define('terminal_signal', {
    family: 'terminal',
    title: 'Signal a terminal foreground job',
    description: `Sends a signal (${TERMINAL_SIGNALS.join(', ')}) to the terminal's foreground process group, the way ctrl-C does from a keyboard. Use it to interrupt a runaway command while keeping the shell alive; terminal_stop ends the whole terminal instead.`,
    input: {
      terminal_id: z.string().uuid(),
      signal: z.enum(TERMINAL_SIGNALS).optional().describe('Default INT.'),
    },
    output: { ...TERMINAL_SHAPE, sent_signal: z.string() },
    annotations: DESTRUCTIVE,
  }, args => terminals.signal(args))

  define('terminal_stop', {
    family: 'terminal',
    title: 'Close a terminal',
    description: 'Hangs up the terminal and kills its process group, escalating to SIGKILL after grace_ms. force=true kills immediately. Closing an already-finished terminal is a no-op returning already_stopped=true. The transcript stays readable with terminal_read until the bridge restarts.',
    input: {
      terminal_id: z.string().uuid(),
      grace_ms: z.number().int().min(0).max(TERMINAL_LIMITS.stop_grace_max_ms).optional(),
      force: z.boolean().optional(),
    },
    output: { ...TERMINAL_SHAPE, escalated_to_kill: z.boolean().optional(), already_stopped: z.boolean().optional() },
    annotations: DESTRUCTIVE,
  }, args => terminals.stop(args))

  define('terminal_list', {
    family: 'terminal',
    title: 'List bridge-owned terminals',
    description: 'Lists only terminals this bridge opened, newest first, with state, command, workspace and how many bytes each has produced. It never enumerates host ttys.',
    input: {
      state: z.enum(['running', 'exited', 'stopped', 'failed']).optional(),
      workspace: workspaceField(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    output: {
      terminals: z.array(looseObject()),
      total: z.number(),
      running: z.number(),
      max_terminals: z.number(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => terminals.list(args))

  // ----------------------------------------------------------------- review --

  const reviewScope = () => ({
    base: z.string().min(1).optional().describe('Revision to compare against. Defaults to HEAD.'),
    staged: z.boolean().optional().describe('Review what is staged instead of the working tree.'),
    since_snapshot: z.string().min(1).optional().describe('Snapshot id from worktree_snapshot: this is how you review exactly what a turn changed.'),
    paths: z.array(z.string()).max(50).optional().describe('Limit the review to these paths.'),
    include_untracked: z.boolean().optional().describe('New files not yet added to git are part of the review by default (they are usually what a turn created). Set false to review only tracked changes. Ignored for staged and revision comparisons, where untracked has no meaning.'),
    path: pathField('Repository directory. Defaults to the workspace root.').optional(),
  })

  define('review_diff', {
    family: 'review',
    workspaceScoped: true,
    title: 'The change under review, hunk by hunk',
    description: `Returns the diff parsed into files and hunks, each hunk carrying an opaque hunk_id you pass to review_stage_hunk or review_revert_hunk. That addressability is the point: git_diff gives you the text, this gives you something you can act on piece by piece. Compare against HEAD (default), a revision, the index, or -- with since_snapshot -- a save point taken before a turn, which is how you review exactly what that turn changed. New untracked files are included, because a file the turn just created is usually the one most worth reviewing. Bounded to ${review.REVIEW_LIMITS.max_files} files and ${review.REVIEW_LIMITS.max_hunks} hunks with truncation reported. Read-only.`,
    input: reviewScope(),
    output: {
      repository: z.string(),
      against: z.string(),
      files: z.array(looseObject()).describe('{path, old_path?, binary, hunks:[{hunk_id, header, old_start, new_start, additions, deletions, body}]}'),
      file_count: z.number(),
      hunk_count: z.number(),
      returned_hunks: z.number(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, (args, extra) => review.reviewDiff(sandboxOf(args), args, { signal: extra?.signal, confinement }))

  define('review_stage_hunk', {
    family: 'review',
    workspaceScoped: true,
    title: 'Stage one hunk',
    description: 'Stages exactly the hunk a hunk_id names, rebuilding a one-hunk patch and applying it to the index. Hunk ids are content-addressed, so an id that no longer describes the same change fails with CONFLICT telling you to re-run review_diff — acting on a stale id would stage the wrong code. Pass the same scope (base/staged/since_snapshot) you used to get the id.',
    input: { hunk_id: z.string().min(1), ...reviewScope() },
    output: {
      repository: z.string(),
      path: z.string(),
      hunk_id: z.string(),
      staged: z.boolean(),
      additions: z.number(),
      deletions: z.number(),
    },
    annotations: WRITE,
  }, (args, extra) => review.stageHunk(sandboxOf(args), args, { signal: extra?.signal, confinement }))

  define('review_revert_hunk', {
    family: 'review',
    workspaceScoped: true,
    title: 'Undo one hunk',
    description: 'Reverses exactly the hunk a hunk_id names in the working tree — the surgical alternative to git_restore, which discards a whole file. The reverse patch is checked before anything is written, so a hunk that cannot be cleanly undone fails with GIT_CONFLICT and the tree is untouched. Requires confirm=true because it throws work away.',
    input: { hunk_id: z.string().min(1), confirm: confirmField('It discards that change.'), ...reviewScope() },
    output: {
      repository: z.string(),
      path: z.string(),
      hunk_id: z.string(),
      reverted: z.boolean(),
      additions: z.number(),
      deletions: z.number(),
    },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, async (args, extra) => {
    requireConfirmation(args.confirm, `Revert hunk ${args.hunk_id}`)
    return await review.revertHunk(sandboxOf(args), args, { signal: extra?.signal, confinement })
  })

  define('review_findings', {
    family: 'review',
    workspaceScoped: true,
    title: 'Normalize and fact-check review findings',
    description: `Takes a reviewer's findings as {file, line?, priority, summary} and returns them sorted by priority (${review.PRIORITIES.join(' > ')}) with counts -- and checks each one against the diff it claims to describe. A finding whose file is not part of the change, or whose line is not inside a changed hunk, is flagged rather than passed through, because a review that points at code the change never touched is the most common way review output wastes the reader's time. Read-only: it records nothing, it validates.`,
    input: {
      findings: z.array(z.object({
        file: z.string().min(1),
        line: z.number().int().min(1).optional(),
        priority: z.enum(review.PRIORITIES).optional().describe('Defaults to medium.'),
        summary: z.string().min(1).max(review.REVIEW_LIMITS.max_summary_length),
      })).min(1).max(review.REVIEW_LIMITS.max_findings),
      ...reviewScope(),
    },
    output: {
      repository: z.string(),
      against: z.string(),
      findings: z.array(looseObject()).describe('{file, line?, priority, summary, in_changed_file, in_changed_hunk?, note?}'),
      total: z.number(),
      outside_change: z.number().describe('Findings pointing at files the change never touched.'),
      by_priority: looseObject(),
    },
    annotations: READ_ONLY,
  }, (args, extra) => review.checkFindings(sandboxOf(args), args, { signal: extra?.signal, confinement }))

  // ------------------------------------------------------------------ git --

  const gitPath = () => pathField('Repository directory relative to the fixed project root. Defaults to the root repository.').optional()

  define('git_status', {
    family: 'git',
    workspaceScoped: true,
    title: 'Working-tree status',
    description: 'Normalized porcelain-v2 status for the repository at the fixed project root: branch, HEAD, upstream, ahead/behind and one entry per change with its staged/unstaged flags. Deterministic and read-only -- this is the replacement for asking Harness "what changed?". Related: git_diff for the content, git_repo_info for remotes.',
    input: {
      path: gitPath(),
      untracked: z.boolean().optional().describe('Include untracked files (default true).'),
      include_ignored: z.boolean().optional(),
      limit: z.number().int().min(1).max(git.GIT_LIMITS.status_max_changes).optional(),
    },
    output: GIT_STATUS_SHAPE,
    annotations: READ_ONLY,
  }, args => git.status(sandboxOf(args), args, { confinement }))

  define('git_repo_info', {
    family: 'git',
    workspaceScoped: true,
    title: 'Repository identity and remotes',
    description: 'Returns the repository root (project-relative), current branch, HEAD sha, ahead/behind, dirty flag and the configured remotes with any embedded credentials redacted. Read-only. Use it once at the start of a session instead of several git calls.',
    input: { path: gitPath() },
    output: {
      is_repository: z.boolean(),
      root: z.string(),
      branch: z.string().optional(),
      detached: z.boolean(),
      head: z.string().optional(),
      upstream: z.string().optional(),
      ahead: z.number(),
      behind: z.number(),
      dirty: z.boolean(),
      changed_files: z.number(),
      remotes: z.array(looseObject()).describe('{name, fetch_url, push_url} with credentials masked.'),
    },
    annotations: READ_ONLY,
  }, args => git.repoInfo(sandboxOf(args), args, { confinement }))

  define('git_diff', {
    family: 'git',
    workspaceScoped: true,
    title: 'Diff working tree, index, or two refs',
    description: 'Bounded unified diff plus per-file additions/deletions. Default is the unstaged working tree; staged=true diffs the index against HEAD; base (and optionally head) diffs two refs. Limit the scope with paths. patch is capped at max_bytes with truncated=true -- use stat_only for a large change set first.',
    input: {
      path: gitPath(),
      staged: z.boolean().optional(),
      base: z.string().optional().describe('Ref to diff from.'),
      head: z.string().optional().describe('Ref to diff to; requires base.'),
      paths: z.array(z.string()).max(100).optional().describe('Project-relative paths to limit the diff to.'),
      context_lines: z.number().int().min(0).max(20).optional(),
      stat_only: z.boolean().optional().describe('Return only the per-file stats, no patch text.'),
      max_bytes: z.number().int().min(1000).max(git.GIT_LIMITS.diff_max_bytes).optional(),
    },
    output: {
      base: z.string().optional(),
      head: z.string().optional(),
      staged: z.boolean(),
      files: FILE_STAT_LIST,
      files_changed: z.number(),
      additions: z.number(),
      deletions: z.number(),
      patch: z.string().optional(),
      patch_bytes: z.number().optional(),
      max_bytes: z.number().optional(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => git.diff(sandboxOf(args), args, { confinement }))

  define('git_log', {
    family: 'git',
    workspaceScoped: true,
    title: 'Commit history',
    description: 'Normalized commit summaries (sha, short sha, author, dates, subject) for a ref and optional path filter, with limit/skip paging. Read-only. An empty repository returns an empty list rather than an error.',
    input: {
      path: gitPath(),
      ref: z.string().optional(),
      paths: z.array(z.string()).max(100).optional(),
      author: z.string().optional(),
      limit: z.number().int().min(1).max(git.GIT_LIMITS.log_max_count).optional(),
      skip: z.number().int().min(0).optional(),
    },
    output: {
      ref: z.string().optional(),
      commits: z.array(looseObject()).describe('{sha, short_sha, author, author_email, authored_at, committed_at, subject}'),
      returned: z.number(),
      skip: z.number(),
      next_skip: z.number().optional(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => git.log(sandboxOf(args), args, { confinement }))

  define('git_show', {
    family: 'git',
    workspaceScoped: true,
    title: 'One commit in detail',
    description: 'Metadata, per-file stats and a bounded patch for one commit-ish (default HEAD). Set include_patch=false for metadata only. Read-only.',
    input: {
      path: gitPath(),
      ref: z.string().optional(),
      include_patch: z.boolean().optional(),
      max_bytes: z.number().int().min(1000).max(git.GIT_LIMITS.diff_max_bytes).optional(),
    },
    output: {
      ref: z.string(),
      commit: looseObject().optional(),
      files: FILE_STAT_LIST,
      files_changed: z.number(),
      additions: z.number().optional(),
      deletions: z.number().optional(),
      patch: z.string().optional(),
      patch_bytes: z.number().optional(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => git.show(sandboxOf(args), args, { confinement }))

  define('git_compare', {
    family: 'git',
    workspaceScoped: true,
    title: 'Compare two refs',
    description: 'Ahead/behind counts, merge base, per-file stats and the commits between two refs (base...head, head defaults to HEAD). Read-only. Use it before a merge or a push to see exactly what would move.',
    input: {
      path: gitPath(),
      base: z.string().min(1),
      head: z.string().optional(),
      limit: z.number().int().min(1).max(git.GIT_LIMITS.log_max_count).optional(),
    },
    output: {
      base: z.string(),
      head: z.string(),
      ahead: z.number(),
      behind: z.number(),
      merge_base: z.string().optional(),
      files: FILE_STAT_LIST,
      files_changed: z.number(),
      additions: z.number(),
      deletions: z.number(),
      commits: z.array(looseObject()),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => git.compare(sandboxOf(args), args, { confinement }))

  define('git_branch_list', {
    family: 'git',
    workspaceScoped: true,
    title: 'List branches',
    description: 'Local branches (and remote-tracking branches with include_remote=true), newest commit first, with sha, upstream and which one is current. Read-only.',
    input: {
      path: gitPath(),
      include_remote: z.boolean().optional(),
      limit: z.number().int().min(1).max(git.GIT_LIMITS.branch_max).optional(),
    },
    output: {
      branches: z.array(looseObject()).describe('{name, sha, upstream?, current, remote, committed_at, subject}'),
      current: z.string().optional(),
      total: z.number(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => git.branchList(sandboxOf(args), args, { confinement }))

  define('git_branch_create', {
    family: 'git',
    workspaceScoped: true,
    title: 'Create a branch',
    description: 'Creates a branch at start_point (default HEAD) and optionally switches to it. An existing branch fails with ALREADY_EXISTS, except with checkout=true, where switching to the existing branch is the idempotent outcome. Never deletes branches.',
    input: {
      path: gitPath(),
      name: z.string().min(1),
      start_point: z.string().optional(),
      checkout: z.boolean().optional(),
    },
    output: {
      name: z.string(),
      created: z.boolean(),
      checked_out: z.boolean(),
      start_point: z.string().optional(),
      sha: z.string(),
    },
    annotations: IDEMPOTENT_WRITE,
  }, args => git.branchCreate(sandboxOf(args), args, { confinement }))

  define('git_checkout', {
    family: 'git',
    workspaceScoped: true,
    title: 'Switch to an existing ref',
    description: 'Switches the working tree to an existing branch, or detaches onto a commit with detach=true. It does not create branches (use git_branch_create) and it does not discard changes: git refuses the switch when it would overwrite local modifications, surfacing CONFLICT.',
    input: {
      path: gitPath(),
      ref: z.string().min(1),
      detach: z.boolean().optional(),
    },
    output: {
      ref: z.string(),
      branch: z.string().optional(),
      detached: z.boolean(),
      head: z.string().optional(),
      dirty: z.boolean(),
    },
    annotations: WRITE,
  }, args => git.checkout(sandboxOf(args), args, { confinement }))

  define('git_add', {
    family: 'git',
    workspaceScoped: true,
    title: 'Stage paths',
    description: 'Stages the named project-relative paths. Staging everything requires all=true and no paths, so a blanket "git add -A" can never happen by accident. Returns the updated staged/unstaged/untracked counts.',
    input: {
      path: gitPath(),
      paths: z.array(z.string()).max(100).optional(),
      all: z.boolean().optional().describe('Stage every change. Only honoured when paths is empty, and only when the user asked for it.'),
    },
    output: {
      staged_paths: z.array(z.string()),
      all: z.boolean(),
      staged: z.number(),
      unstaged: z.number(),
      untracked: z.number(),
    },
    annotations: WRITE,
  }, args => git.add(sandboxOf(args), args, { confinement }))

  define('git_commit', {
    family: 'git',
    workspaceScoped: true,
    title: 'Commit staged changes',
    description: 'Creates a commit from the staged changes and returns the new sha. The message is passed through stdin, never a shell. Pass expected_head for optimistic concurrency: a moved HEAD fails with CONFLICT. Nothing staged fails with CONFLICT unless allow_empty=true. It never pushes -- git_push does that, and requires confirmation.',
    input: {
      path: gitPath(),
      message: z.string().min(1).max(git.GIT_LIMITS.commit_message_max),
      all: z.boolean().optional().describe('Also stage tracked modifications first, like git commit -a. Untracked files are still never added.'),
      allow_empty: z.boolean().optional(),
      expected_head: z.string().optional().describe('Full or abbreviated sha the caller believes HEAD is at.'),
    },
    output: {
      committed: z.boolean(),
      sha: z.string(),
      commit: looseObject().optional(),
      all: z.boolean(),
    },
    annotations: WRITE,
  }, args => git.commit(sandboxOf(args), args, { confinement }))

  define('git_restore', {
    family: 'git',
    workspaceScoped: true,
    title: 'Discard changes in explicit paths',
    description: 'Discards working-tree changes (mode=worktree), unstages (mode=staged), or both, for explicitly named paths. Destructive: discarded working-tree edits are unrecoverable, so it requires confirm=true and never operates on the whole tree implicitly.',
    input: {
      path: gitPath(),
      paths: z.array(z.string()).min(1).max(100),
      mode: z.enum(['worktree', 'staged', 'both']).optional(),
      source: z.string().optional().describe('Restore content from this ref instead of the index.'),
      confirm: confirmField('It permanently discards uncommitted work in those paths.'),
    },
    output: {
      restored_paths: z.array(z.string()),
      mode: z.string(),
      source: z.string().optional(),
      clean: z.boolean(),
      counts: looseObject(),
    },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, args => git.restore(sandboxOf(args), args, { confinement }))

  define('git_reset', {
    family: 'git',
    workspaceScoped: true,
    title: 'Move HEAD or unstage',
    description: 'Runs git reset in soft, mixed (default) or hard mode. soft and mixed keep the working tree and are safe; hard permanently discards every uncommitted change and therefore requires confirm=true. Returns the previous and new HEAD.',
    input: {
      path: gitPath(),
      mode: z.enum(['soft', 'mixed', 'hard']).optional(),
      ref: z.string().optional().describe('Target commit-ish; defaults to HEAD.'),
      confirm: confirmField('mode=hard permanently discards all uncommitted changes.'),
    },
    output: {
      mode: z.string(),
      ref: z.string(),
      previous_head: z.string().optional(),
      head: z.string().optional(),
      clean: z.boolean(),
      counts: looseObject(),
    },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, args => git.reset(sandboxOf(args), args, { confinement }))

  define('git_merge', {
    family: 'git',
    workspaceScoped: true,
    title: 'Merge a ref, or abort a conflicted merge',
    description: 'Merges one ref into the current branch (fast_forward auto/only/never). Conflicts return GIT_CONFLICT listing the conflicted paths; resolve them with fs_update_file plus git_add and then git_commit, or call this action again with action=abort to undo the whole merge.',
    input: {
      path: gitPath(),
      action: z.enum(['merge', 'abort']).optional(),
      ref: z.string().optional().describe('Required unless action=abort.'),
      fast_forward: z.enum(['auto', 'only', 'never']).optional(),
    },
    output: {
      action: z.string(),
      merged: z.boolean().optional(),
      aborted: z.boolean().optional(),
      ref: z.string().optional(),
      fast_forward: z.string().optional(),
      head: z.string().optional(),
      output: z.string().optional(),
    },
    annotations: WRITE,
  }, args => git.merge(sandboxOf(args), args, { confinement }))

  define('git_rebase', {
    family: 'git',
    workspaceScoped: true,
    title: 'Rebase, or continue/skip/abort one in progress',
    description: 'action=start rebases the current branch onto another ref and rewrites local commit history, so it requires confirm=true. Conflicts return GIT_CONFLICT; then call action=continue after staging the resolution, action=skip, or action=abort to restore the original branch.',
    input: {
      path: gitPath(),
      action: z.enum(['start', 'continue', 'skip', 'abort']).optional(),
      onto: z.string().optional().describe('Required for action=start.'),
      confirm: confirmField('It rewrites local commit history.'),
    },
    output: {
      action: z.string(),
      rebased: z.boolean().optional(),
      aborted: z.boolean().optional(),
      head: z.string().optional(),
      output: z.string().optional(),
    },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, args => git.rebase(sandboxOf(args), args, { confinement }))

  define('git_tag_list', {
    family: 'git',
    workspaceScoped: true,
    title: 'List tags',
    description: 'Newest-first tags with their target sha, creation date and subject. Read-only.',
    input: { path: gitPath(), limit: z.number().int().min(1).max(git.GIT_LIMITS.tag_max).optional() },
    output: { tags: z.array(looseObject()).describe('{name, sha, created_at, subject}'), total: z.number(), ...truncationShape },
    annotations: READ_ONLY,
  }, args => git.tagList(sandboxOf(args), args, { confinement }))

  define('git_tag_create', {
    family: 'git',
    workspaceScoped: true,
    title: 'Create a tag',
    description: 'Creates a lightweight tag, or an annotated tag when message is supplied, at ref (default HEAD). An existing tag fails with ALREADY_EXISTS; this action never moves or deletes an existing tag. Tags stay local until git_push.',
    input: {
      path: gitPath(),
      name: z.string().min(1),
      ref: z.string().optional(),
      message: z.string().max(git.GIT_LIMITS.commit_message_max).optional(),
    },
    output: { name: z.string(), created: z.boolean(), annotated: z.boolean(), ref: z.string().optional(), sha: z.string() },
    annotations: WRITE,
  }, args => git.tagCreate(sandboxOf(args), args, { confinement }))

  define('git_remote_list', {
    family: 'git',
    workspaceScoped: true,
    title: 'List remotes',
    description: 'Lists configured remotes with fetch and push URLs. Any credential embedded in a URL (https://user:token@host/...) is masked before it leaves the bridge. Read-only, no network access.',
    input: { path: gitPath() },
    output: { remotes: z.array(looseObject()).describe('{name, fetch_url, push_url} with credentials masked.') },
    annotations: READ_ONLY,
  }, args => git.remoteList(sandboxOf(args), args, { confinement }))

  define('git_fetch', {
    family: 'git',
    workspaceScoped: true,
    title: 'Fetch from a remote',
    description: 'Contacts the remote and updates remote-tracking refs. It changes no local branch and no working-tree file, so it needs no confirmation, but it does leave the machine. Credentials come from the host git configuration; the bridge never prompts for or stores them.',
    input: {
      path: gitPath(),
      remote: z.string().optional().describe('Default origin.'),
      ref: z.string().optional(),
      prune: z.boolean().optional(),
      tags: z.boolean().optional(),
    },
    output: {
      fetched: z.boolean(),
      remote: z.string(),
      pruned: z.boolean(),
      ahead: z.number(),
      behind: z.number(),
      output: z.string(),
    },
    annotations: NETWORK_READ,
  }, args => git.fetch(sandboxOf(args), args, { confinement }))

  define('git_pull', {
    family: 'git',
    workspaceScoped: true,
    title: 'Pull from a remote',
    description: 'Fetches and integrates. Default strategy is ff-only, which can never create a merge commit or a conflict; merge and rebase are opt-in, and rebase rewrites history so it requires confirm=true. Conflicts return GIT_CONFLICT with the conflicted paths.',
    input: {
      path: gitPath(),
      remote: z.string().optional(),
      ref: z.string().optional(),
      strategy: z.enum(['ff-only', 'merge', 'rebase']).optional(),
      confirm: confirmField('strategy=rebase rewrites local commit history.'),
    },
    output: { pulled: z.boolean(), remote: z.string(), strategy: z.string(), head: z.string(), output: z.string() },
    annotations: NETWORK_WRITE,
  }, args => git.pull(sandboxOf(args), args, { confinement }))

  define('git_push', {
    family: 'git',
    workspaceScoped: true,
    title: 'Push a branch to a remote',
    description: 'The only action that publishes local work outside this machine. It always requires confirm=true, and the refusal message names the exact branch, remote and commit count to relay to the user first. force=true uses --force-with-lease and must also be asked for explicitly. Use dry_run=true to see what would be pushed without pushing.',
    input: {
      path: gitPath(),
      remote: z.string().optional().describe('Default origin.'),
      ref: z.string().optional().describe('Branch to push; defaults to the current branch.'),
      force: z.boolean().optional().describe('Force-push with lease. Requires confirm as well.'),
      set_upstream: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      confirm: confirmField('It publishes commits outside this machine.'),
    },
    output: {
      pushed: z.boolean(),
      dry_run: z.boolean(),
      remote: z.string(),
      ref: z.string(),
      force: z.boolean(),
      commits_pushed: z.number(),
      output: z.string(),
    },
    annotations: NETWORK_WRITE,
    requiresConfirmation: true,
  }, args => git.push(sandboxOf(args), args, { confinement }))

  // ----------------------------------------------------------------- tasks --

  define('task_list', {
    family: 'task',
    workspaceScoped: true,
    title: 'List declared project tasks',
    description: 'Discovers every task the repository itself declares: package.json scripts (root and one level of sub-packages) and Makefile targets. Names are unique (script, package:script, make:target). Read-only and cheap. Feed a name to task_run or test_run instead of guessing a command.',
    input: { include_packages: z.boolean().optional().describe('Also scan first-level sub-packages (default true).') },
    output: {
      tasks: z.array(looseObject()).describe('{name, source, script, cwd, package_manager?, command, declared?}'),
      total: z.number(),
      packages: z.array(looseObject()).describe('{path, name?, package_manager}'),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => tasks.listTasks(sandboxOf(args), args))

  define('task_run', {
    family: 'task',
    workspaceScoped: true,
    title: 'Run one declared task',
    description: 'Runs one task by the name task_list returned, in that task\'s own directory, using the package manager the repository actually uses. It accepts no free-form command text: only extra arguments passed after --. Returns the full process result plus passed=true when the exit code was 0.',
    input: {
      name: z.string().min(1).describe('Task name from task_list.'),
      args: z.array(z.string()).max(tasks.TASK_LIMITS.max_extra_args).optional().describe('Extra arguments passed to the script after --.'),
      timeout_ms: z.number().int().min(100).max(EXEC_LIMITS.timeout_max_ms).optional(),
      max_output_bytes: z.number().int().min(1024).max(EXEC_LIMITS.output_max_bytes).optional(),
      env: z.record(z.string(), z.string()).optional(),
      sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('OS-level confinement for this run, through the engine sandbox provider. Can only NARROW the permission profile. The result reports what was enforced.'),
    },
    output: { task: z.string(), source: z.string(), passed: z.boolean(), ...EXEC_OUTPUT_SHAPE },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args, extra) => tasks.runTask(sandboxOf(args), args, { signal: extra?.signal, confinement }))

  define('test_run', {
    family: 'task',
    workspaceScoped: true,
    title: 'Run the project test suite',
    description: 'Runs the repository\'s declared test task (root "test" script by default, or the task named in task). filter and args are appended to the test command. If no test task is declared, it fails with UNSUPPORTED and lists the tasks that do exist rather than guessing a command. Returns passed=true only on exit code 0.',
    input: {
      task: z.string().optional().describe('Explicit task name from task_list, e.g. "bridge:test".'),
      filter: z.string().optional().describe('Test name or file filter appended to the command.'),
      args: z.array(z.string()).max(tasks.TASK_LIMITS.max_extra_args).optional(),
      timeout_ms: z.number().int().min(100).max(EXEC_LIMITS.timeout_max_ms).optional(),
      max_output_bytes: z.number().int().min(1024).max(EXEC_LIMITS.output_max_bytes).optional(),
      env: z.record(z.string(), z.string()).optional(),
      sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('OS-level confinement for this run, through the engine sandbox provider. Can only NARROW the permission profile. The result reports what was enforced.'),
    },
    output: { task: z.string(), source: z.string(), passed: z.boolean(), ...EXEC_OUTPUT_SHAPE },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args, extra) => tasks.runTests(sandboxOf(args), args, { signal: extra?.signal, confinement }))

  // ------------------------------------------------- harness control plane --

  define('harness_operation_list', {
    family: 'harness',
    title: 'List Shiro root turns',
    description: 'Lists the root turns this bridge has registered in one workspace, newest first, with status, session id and pending counts. Scoped by workspace, and scoped by default: omitting workspace lists the fixed project root, never every workspace at once. Deterministic control-plane read: it inspects bridge state only and never contacts the engine or a model. Use harness_status to wait on a turn, harness_operation_get for one turn in full.',
    input: {
      status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']).optional(),
      workspace: workspaceField(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    output: {
      operations: z.array(looseObject()).describe('{operation_id, session_id, workspace, status, started_at, pending_model_requests, pending_interactions, speed_profile, reasoning_effort}'),
      workspace: z.string(),
      total: z.number(),
      active: z.number(),
      max_concurrent_turns: z.number(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, async args => {
    const workspace = harnessWorkspace(args)
    await controller.ensureRuntimeWorkspace?.(workspace)
    return controller.operationList({ ...args, workspace })
  })

  define('harness_operation_get', {
    family: 'harness',
    title: 'Inspect one Shiro root turn',
    description: 'Compact full state for one operation_id inside one workspace: status, timing, pending model-request summaries, pending interactions and every session attached to that turn. A turn belonging to another workspace fails with NOT_FOUND rather than reporting its state. Read-only and immediate; it never waits. Fetch a full request body with harness_get_request.',
    input: { operation_id: z.string().uuid(), workspace: workspaceField() },
    output: {
      operation_id: z.string(),
      session_id: z.string().optional(),
      root_session_id: z.string().optional(),
      status: z.string(),
      started_at: z.number().optional(),
      started_at_iso: z.string().optional(),
      duration_ms: z.number().optional(),
      speed_profile: z.string().optional(),
      reasoning_effort: z.string().optional(),
      pending_model_requests: z.number().optional(),
      pending_interactions: z.number().optional(),
      model_requests: z.array(looseObject()).optional(),
      interactions: z.array(looseObject()).optional(),
      sessions: z.array(z.string()).optional(),
    },
    annotations: READ_ONLY,
  }, async args => {
    const workspace = harnessWorkspace(args)
    await controller.ensureRuntimeWorkspace?.(workspace)
    return controller.operationGet(args.operation_id, workspace)
  })

  define('harness_session_get', {
    family: 'harness',
    title: 'Inspect one durable session',
    description: 'Metadata for one durable Harness session plus the root turn that currently owns it, if any. Sessions are namespaced by workspace: pass the same workspace you started the session in, or omit it for the fixed project root. A session from a different workspace fails with NOT_FOUND. Use harness_sessions to list them, harness_start with session_id to resume one.',
    input: {
      session_id: z.string().min(1),
      workspace: workspaceField(),
    },
    output: {
      workspace: z.string(),
      workspace_root: z.string(),
      workspace_id: z.string(),
      workspace_title: z.string().optional(),
      session: looseObject(),
      active_operation: looseObject().optional(),
      has_active_turn: z.boolean(),
    },
    annotations: READ_ONLY,
  }, args => controller.sessionGet(args.session_id, harnessWorkspace(args)))

  // ---------------------------------------------------------------- thread --

  define('thread_events', {
    family: 'harness',
    title: 'Read a thread as a stream of items',
    description: 'Cursor-based read of one durable thread’s event stream: prompts, model requests, tool calls, approvals, completions. Pass next_seq back as from_seq to continue. The engine serves a window of recent history rather than the whole transcript, so window_start reports the oldest event visible and cursor_behind_window says when a cursor has fallen out of it — a gap is reported, never silently skipped. Filter with types. Redacted and bounded. Read-only; use harness_status to wait for progress.',
    input: {
      session_id: z.string().min(1),
      workspace: workspaceField(),
      from_seq: z.number().int().min(-1).optional().describe('Exclusive cursor. Omit or -1 to start from the oldest visible event.'),
      limit: z.number().int().min(1).max(200).optional(),
      types: z.array(z.string()).max(20).optional().describe('Only these event types, for example ["assistant/message","tool/call"].'),
    },
    output: {
      session_id: z.string(),
      workspace: z.string(),
      events: z.array(looseObject()),
      returned: z.number(),
      from_seq: z.number(),
      next_seq: z.number(),
      window_start: z.number().nullable(),
      cursor_behind_window: z.boolean(),
      has_active_turn: z.boolean(),
      operation_id: z.string().optional(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => controller.threadEvents(args.session_id, {
    fromSeq: args.from_seq ?? -1,
    limit: args.limit ?? 50,
    types: args.types,
  }, harnessWorkspace(args)))

  define('turn_steer', {
    family: 'harness',
    title: 'Add a message to a running turn',
    description: 'Queues a message into a turn that is already running, so a task can be redirected without cancelling and restarting it. It requires a live turn on that thread: with no running turn this fails with CONFLICT rather than quietly becoming a new turn that skips the concurrency accounting. The message is queued, not injected mid-inference; poll harness_status to see the turn take it up. A thread in another workspace fails with NOT_FOUND.',
    input: {
      session_id: z.string().min(1),
      workspace: workspaceField(),
      message: z.string().min(1).max(20_000),
    },
    output: {
      session_id: z.string(),
      operation_id: z.string(),
      workspace: z.string(),
      steered: z.boolean(),
      characters: z.number(),
      instruction: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => controller.steer(args.session_id, args.message, harnessWorkspace(args)))

  define('thread_fork', {
    family: 'harness',
    title: 'Branch a thread',
    description: 'Creates a new thread that starts from an existing one, for exploring an alternative without losing the original. Whether this works depends on the engine build: the capability is probed at call time and reported by bridge_capabilities.features.thread_fork, and an engine without it answers UNSUPPORTED with that reason instead of failing inside an rpc.',
    input: {
      session_id: z.string().min(1),
      workspace: workspaceField(),
      title: z.string().min(1).max(THREAD_LIMITS.max_label_length).optional(),
    },
    output: {
      source_session_id: z.string(),
      session_id: z.string(),
      workspace: z.string(),
      forked: z.boolean(),
    },
    annotations: WRITE,
  }, args => controller.fork(args.session_id, { title: args.title }, harnessWorkspace(args)))

  define('thread_archive', {
    family: 'harness',
    title: 'Hide a thread from Shiro',
    description: 'Marks a thread archived: harness_sessions stops listing it and harness_start refuses to resume it. It does NOT delete anything — the engine exposes no delete or archive, and reaching into its store would corrupt state it owns, so the engine keeps its copy of the transcript exactly as it was. Archiving a thread whose turn is still running is refused unless force=true, and even then the turn keeps running. Reverse it with thread_unarchive.',
    input: {
      session_id: z.string().min(1),
      workspace: workspaceField(),
      label: z.string().max(THREAD_LIMITS.max_label_length).optional(),
      reason: z.string().max(THREAD_LIMITS.max_reason_length).optional(),
      force: z.boolean().optional().describe('Archive even while a turn is running.'),
    },
    output: {
      session_id: z.string(),
      archived: z.boolean(),
      archived_at: z.string(),
      workspace: z.string().optional(),
      label: z.string().optional(),
      reason: z.string().optional(),
      forced: z.boolean().optional(),
      engine_transcript_retained: z.boolean().describe('Always true: archiving is a Shiro-side marker, not a deletion.'),
    },
    annotations: WRITE,
  }, async args => {
    const workspace = harnessWorkspace(args)
    let hasActiveTurn = false
    try {
      hasActiveTurn = (await controller.sessionGet(args.session_id, workspace)).has_active_turn === true
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') throw error
      // An id the engine no longer lists can still be archived: the marker is
      // Shiro's own, and refusing would strand the entry forever.
    }
    return await threads.archive(args.session_id, { ...args, hasActiveTurn, workspace: workspace.id })
  })

  define('thread_unarchive', {
    family: 'harness',
    title: 'Bring an archived thread back',
    description: 'Removes the archive marker, so the thread is listed by harness_sessions and resumable by harness_start again. Fails with NOT_FOUND when the thread was not archived.',
    input: { session_id: z.string().min(1) },
    output: { session_id: z.string(), archived: z.boolean(), restored_at: z.string() },
    annotations: WRITE,
  }, args => threads.unarchive(args.session_id))

  define('thread_archived', {
    family: 'harness',
    title: 'List archived threads',
    description: 'The threads Shiro is hiding, newest first, with when and why each was archived. Read-only.',
    input: { limit: z.number().int().min(1).max(200).optional() },
    output: {
      threads: z.array(looseObject()).describe('{session_id, archived_at, workspace?, label?, reason?}'),
      total: z.number(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => threads.list({ limit: args.limit ?? 50 }))

  define('thread_prune', {
    family: 'harness',
    title: 'Archive old threads in bulk',
    description: 'Archives threads by age (older_than_days) and/or by count (keep_last), in one sweep. **Dry run by default**: the first call reports exactly which threads would be archived and changes nothing, and dry_run=false performs it. Threads with a running turn are never swept. Like thread_archive this hides rather than deletes; the engine keeps every transcript. At least one of older_than_days or keep_last is required, because an unbounded prune is never what was meant.',
    input: {
      workspace: workspaceField(),
      older_than_days: z.number().int().min(1).max(3650).optional(),
      keep_last: z.number().int().min(0).max(500).optional().describe('Always keep this many most-recent threads.'),
      dry_run: z.boolean().optional().describe('Default true.'),
      reason: z.string().max(THREAD_LIMITS.max_reason_length).optional(),
    },
    output: {
      dry_run: z.boolean(),
      would_archive: z.array(z.string()).optional(),
      archived: z.array(z.string()).optional(),
      count: z.number(),
      skipped_active: z.number(),
      engine_transcripts_retained: z.boolean().optional(),
    },
    annotations: WRITE,
  }, async args => {
    const workspace = harnessWorkspace(args)
    const listed = await controller.sessions(workspace)
    const candidates = listed.sessions.map(session => ({
      session_id: session.sessionId,
      updated_at: session.updatedAt ?? session.updated_at,
      created_at: session.createdAt ?? session.created_at,
      has_active_turn: controller.operationForSession(session.sessionId)?.status === 'running',
    }))
    return await threads.prune(candidates, {
      olderThanDays: args.older_than_days,
      keepLast: args.keep_last,
      dryRun: args.dry_run !== false,
      reason: args.reason,
    })
  })

  // ----------------------------------------------------------------- fleet --

  define('fleet_list', {
    family: 'fleet',
    title: 'List all ChatGPT worker fleets',
    description: 'Compact state for every server-owned fleet, most recently updated first. Read-only. Fleet names, worker slots, browser client ids and browser tab ids are all distinct from Harness session ids and root-turn operation ids.',
    input: {},
    output: { fleets: z.array(looseObject()), total: z.number(), running: z.number() },
    annotations: READ_ONLY,
  }, () => requireFleet().list())

  define('fleet_update', {
    family: 'fleet',
    title: 'Change a fleet\'s schedule or prompt',
    description: 'Updates prompt, interval_minutes, stagger_seconds or max_session_runs on an existing fleet in place. A new interval takes effect from the next scheduled run (the returned next_run_at is authoritative); the round already in flight is never interrupted. Fleet size is immutable because changing it would orphan owned browser tabs -- use fleet_stop then fleet_start for that.',
    input: {
      name: z.string().min(1).max(64),
      prompt: z.string().min(1).optional(),
      interval_minutes: z.number().positive().max(10_080).optional(),
      stagger_seconds: z.number().nonnegative().max(300).optional(),
      max_session_runs: z.number().int().min(1).max(100).optional(),
    },
    output: { ...FLEET_SNAPSHOT_SHAPE, applied: looseObject().describe('Which fields actually changed.') },
    annotations: IDEMPOTENT_WRITE,
  }, args => requireFleet().update(args.name, {
    prompt: args.prompt,
    intervalMinutes: args.interval_minutes,
    staggerSeconds: args.stagger_seconds,
    maxSessionRuns: args.max_session_runs,
  }))

  define('fleet_delete', {
    family: 'fleet',
    title: 'Forget a stopped fleet',
    description: 'Permanently removes a stopped fleet\'s persisted state and run history. This is not fleet_stop: a running fleet is refused, because deleting it would leave its browser tabs open and unowned. Deleting a fleet that does not exist returns not_found=true rather than an error.',
    input: { name: z.string().min(1).max(64) },
    output: { name: z.string(), deleted: z.boolean(), not_found: z.boolean().optional(), rounds_recorded: z.number().optional() },
    annotations: DESTRUCTIVE,
  }, args => requireFleet().remove(args.name))

  define('fleet_run_now', {
    family: 'fleet',
    title: 'Run one fleet round immediately',
    description: 'Triggers one scheduling round for a running fleet right now without waiting for the interval. If a round is already in flight the call returns with skipped_overlap in the summary instead of double-submitting. The regular schedule is unchanged.',
    input: { name: z.string().min(1).max(64) },
    output: FLEET_SNAPSHOT_SHAPE,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => requireFleet().runNow(args.name))

  define('fleet_runs', {
    family: 'fleet',
    title: 'Recent fleet round history',
    description: 'Newest-first page of recorded rounds for one fleet: round number, trigger source, per-outcome tallies and per-slot results. History is bounded per fleet, so retained_rounds says how far back it goes. Read-only.',
    input: {
      name: z.string().min(1).max(64),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().optional(),
    },
    output: {
      name: z.string(),
      runs: z.array(looseObject()).describe('{round, source, at, outcomes, workers[]}'),
      returned: z.number(),
      total: z.number(),
      cursor: z.number(),
      next_cursor: z.string().optional(),
      retained_rounds: z.number(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => requireFleet().runs(args.name, {
    limit: args.limit ?? 10,
    cursor: args.cursor === undefined ? 0 : Number.parseInt(args.cursor, 10) || 0,
  }))

  define('fleet_worker_status', {
    family: 'fleet',
    title: 'Inspect one fleet slot',
    description: 'Detail for one worker slot: its browser client and tab ids, current state, run count against max_session_runs, and its outcome in the recent rounds. Read-only.',
    input: { name: z.string().min(1).max(64), slot: z.number().int().min(1).max(20) },
    output: {
      name: z.string(),
      running: z.boolean(),
      chat_mode: z.string(),
      max_session_runs: z.number(),
      next_run_at: z.string().nullable().optional(),
      worker: looseObject().optional(),
      recent_runs: z.array(looseObject()),
    },
    annotations: READ_ONLY,
  }, args => requireFleet().workerStatus(args.name, args.slot))

  define('fleet_worker_recycle', {
    family: 'fleet',
    title: 'Recycle one fleet slot now',
    description: 'Closes one slot\'s current ChatGPT tab and resets its run budget so the next round opens a fresh conversation in the same slot, keeping slot identity stable. In normal chat mode the owned conversation is deleted first through the same verified path the automatic max_session_runs rotation uses; it refuses to act on a tab whose ownership or chat mode cannot be proven, and on a tab that is generating. This is the manual form of "each worker runs N times, then starts a clean conversation".',
    input: {
      name: z.string().min(1).max(64),
      slot: z.number().int().min(1).max(20),
      delete_conversation: z.boolean().optional().describe('Delete the owned ChatGPT conversation before closing the tab (default true; ignored in temporary chat mode, which keeps no history).'),
    },
    output: {
      name: z.string(),
      slot: z.number(),
      outcome: z.string(),
      conversation_deleted: z.boolean(),
      running: z.boolean(),
      next_run_at: z.string().nullable().optional(),
      worker: looseObject().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, args => requireFleet().recycleWorker(args.name, args.slot, { deleteConversation: args.delete_conversation !== false }))

  // --------------------------------------------------------------- browser --

  define('browser_owned_tabs', {
    family: 'browser',
    title: 'List Shiro-owned browser tabs',
    description: 'Lists the ChatGPT tabs Shiro owns through its fleets, with browser client id, tab id, URL, readiness and the fleet slot that owns each one. include_foreign=true also reports tabs the user opened, marked owned=false purely for visibility -- no write action will touch them. Read-only.',
    input: { include_foreign: z.boolean().optional() },
    output: {
      tabs: z.array(looseObject()).describe('{browser_client_id, browser_tab_id, url, ready, owned, fleet?, slot?, worker_state?, run_count?}'),
      total: z.number(),
      owned: z.number(),
      includes_foreign: z.boolean(),
    },
    annotations: READ_ONLY,
  }, args => requireFleet().ownedTabs({ includeForeign: args.include_foreign === true }))

  define('browser_tab_close', {
    family: 'browser',
    title: 'Close one Shiro-owned tab',
    description: 'Closes one verified idle Shiro-owned ChatGPT tab and releases its fleet slot. It refuses tabs that are not owned by a fleet, tabs whose chat mode cannot be verified, and tabs that are generating a response. To close a tab and immediately get a fresh conversation in the same slot, use fleet_worker_recycle instead.',
    input: { browser_tab_id: z.number().int() },
    output: {
      browser_tab_id: z.number(),
      closed: z.boolean(),
      fleet: z.string(),
      slot: z.number(),
      fleet_running: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, args => requireFleet().closeOwnedTab(args.browser_tab_id))

  define('browser_tab_send_prompt', {
    family: 'browser',
    title: 'Send one prompt to an owned tab',
    description: 'Low-level submit into one verified idle Shiro-owned tab. It counts as a run for that slot, so the max_session_runs rotation budget stays accurate. Prefer fleet_start for recurring work: this action does no scheduling, no staggering and no rotation. It refuses foreign, unverified or busy tabs.',
    input: {
      browser_tab_id: z.number().int(),
      prompt: z.string().min(1),
    },
    output: {
      browser_tab_id: z.number(),
      submitted: z.boolean(),
      fleet: z.string(),
      slot: z.number(),
      run_count: z.number(),
      max_session_runs: z.number(),
      last_user_turn_key: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => requireFleet().sendPromptToOwnedTab(args.browser_tab_id, args.prompt))

  // ------------------------------------------------------------- artifacts --

  define('browser_tab_screenshot', {
    family: 'browser',
    workspaceScoped: true,
    title: 'Capture a Shiro-owned browser tab',
    description: `Captures one verified Shiro-owned tab and writes the image into the workspace, returning its path, size, dimensions, sha256 and shiro:// resource uri -- the image is never inlined into this result, so look at it with image_open or fetch the resource. Only tabs owned by a Shiro fleet can be captured: a foreign tab is refused exactly like a tab id that does not exist, and browser_owned_tabs with include_foreign=true grants no authority. Read-only, so it is allowed while the tab is generating a response. Default ${SCREENSHOT_LIMITS.default_directory}/, viewport only unless full_page=true, at most ${SCREENSHOT_LIMITS.max_bytes_cap} bytes. Requires a relay build that exposes a screenshot route; bridge_capabilities reports features.browser_screenshot.`,
    input: {
      browser_tab_id: z.number().int().describe('Tab id from browser_owned_tabs. This is the only identity accepted: browser_client_id and relay targets are derived, never supplied.'),
      save_to: pathField('Destination image path relative to the workspace root. Defaults to a timestamped file under .shiro/screenshots/.').optional(),
      format: z.enum(SCREENSHOT_FORMATS).optional().describe('png (default) or webp.'),
      full_page: z.boolean().optional().describe('Capture the whole scrollable page instead of the viewport. Off by default.'),
      max_width: z.number().int().min(SCREENSHOT_LIMITS.min_width).max(SCREENSHOT_LIMITS.max_width).optional().describe('Downscale to this width before encoding.'),
      max_bytes: z.number().int().min(1024).max(SCREENSHOT_LIMITS.max_bytes_cap).optional(),
      timeout_ms: z.number().int().min(1000).max(SCREENSHOT_LIMITS.timeout_max_ms).optional(),
      overwrite: z.boolean().optional(),
    },
    output: {
      browser_tab_id: z.number(),
      fleet: z.string().optional(),
      slot: z.number().optional(),
      url: z.string().optional(),
      busy: z.boolean().optional(),
      path: z.string(),
      format: z.string(),
      mime_type: z.string(),
      full_page: z.boolean(),
      width: z.number().optional(),
      height: z.number().optional(),
      bytes: z.number(),
      sha256: z.string(),
      resource_uri: z.string(),
      overwrote: z.boolean(),
      captured_at: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const manager = requireFleet()
    const captured = await captureOwnedTabScreenshot(sandboxOf(args), args, {
      fleet: manager,
      transport: manager.transport,
      signal: extra?.signal,
    })
    return { ...captured, resource_uri: options.artifactUri(captured.path, workspaceIdOf(args)) }
  })

  define('browser_tab_navigate', {
    family: 'browser',
    title: 'Point a Shiro-owned tab at a URL',
    description: `Navigates one verified Shiro-owned tab and reports where the browser actually ended up after redirects. Only http and https are accepted: javascript:, data:, blob:, file:, chrome:, chrome-extension:, devtools: and about: are refused, and a redirect chain that ends on one of those fails too. localhost, 127.0.0.1 and private/LAN addresses ARE allowed -- driving a local dev server is a purpose of this action. Refuses while the tab is generating a response, and refuses to navigate a slot of a RUNNING fleet away from ChatGPT (stop the fleet first); leaving ChatGPT on a stopped fleet's tab needs confirm=true because that tab stops being usable as a ChatGPT worker. Foreign tabs are refused exactly like tab ids that do not exist.`,
    input: {
      browser_tab_id: z.number().int().describe('Tab id from browser_owned_tabs. The only identity accepted.'),
      url: z.string().min(1).max(NAVIGATE_LIMITS.max_url_length).describe('Absolute http(s) URL, including localhost and private addresses.'),
      wait_until: z.enum(WAIT_UNTIL).optional().describe("'load' (default) waits for the load event, 'commit' returns once the navigation commits, 'none' returns immediately."),
      timeout_ms: z.number().int().min(1000).max(NAVIGATE_LIMITS.timeout_max_ms).optional(),
      confirm: confirmField('It takes a ChatGPT worker tab off ChatGPT.'),
    },
    output: {
      browser_tab_id: z.number(),
      fleet: z.string().optional(),
      slot: z.number().optional(),
      requested_url: z.string(),
      url: z.string(),
      left_chatgpt: z.boolean(),
      wait_until: z.string(),
      loaded: z.boolean(),
      load_error: z.string().optional(),
      frame_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    requiresConfirmation: true,
  }, async (args, extra) => {
    const manager = requireFleet()
    policy.assertHost(args.url)
    return await navigateOwnedTab(args, { fleet: manager, transport: manager.transport, signal: extra?.signal })
  })

  define('browser_dom_query', {
    family: 'browser',
    title: 'Find elements in a Shiro-owned tab',
    description: `Runs a CSS selector in one verified Shiro-owned tab and returns bounded structured descriptors -- tag, role, accessible name, a clipped text snippet, href/src, box, visibility, enabled/editable -- each with an opaque element_id to pass to browser_tab_click or browser_tab_type. It never dumps the DOM: at most ${DOM_LIMITS.max_results} elements and ${DOM_LIMITS.max_text_bytes} bytes of text each, with total/truncated reported. Password and one-time-code fields are marked secret and their values are never returned. Element handles are scoped to this tab AND to the current document: a navigation or reload invalidates every handle, and a handle from another tab is refused. Read-only, so it works while the tab is generating.`,
    input: {
      browser_tab_id: z.number().int().describe('Tab id from browser_owned_tabs.'),
      selector: z.string().min(1).max(DOM_LIMITS.max_selector_length).describe('CSS selector, evaluated with document.querySelectorAll.'),
      max_results: z.number().int().min(1).max(DOM_LIMITS.max_results).optional(),
      max_text_bytes: z.number().int().min(0).max(DOM_LIMITS.max_text_bytes).optional(),
      visible_only: z.boolean().optional().describe('Skip elements with no box or hidden by CSS.'),
      include_hidden: z.boolean().optional().describe('Include aria-hidden elements, which are skipped by default.'),
      timeout_ms: z.number().int().min(1000).max(DOM_LIMITS.timeout_max_ms).optional(),
    },
    output: {
      browser_tab_id: z.number(),
      fleet: z.string().optional(),
      slot: z.number().optional(),
      selector: z.string(),
      url: z.string(),
      generation: z.string().describe('Document generation the handles belong to; it changes on every navigation.'),
      elements: z.array(looseObject()).describe('{element_id, tag, role?, name?, text?, type?, visible, enabled, editable, secret?, href?, src?, value?, box}'),
      total: z.number(),
      returned: z.number(),
      ...truncationShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const manager = requireFleet()
    return await queryOwnedTabDom(args, { fleet: manager, transport: manager.transport, signal: extra?.signal })
  })

  define('browser_tab_click', {
    family: 'browser',
    title: 'Click an element in a Shiro-owned tab',
    description: 'Clicks the element an element_id from browser_dom_query points at. The handle is resolved again inside the page immediately before the click and the coordinates come from where the element is at that moment, so a layout that shifted since the query cannot cause a click on the wrong thing. A handle from a replaced document or another tab fails with CONFLICT; an invisible or disabled element fails with INVALID_ARGUMENT. Refused while the tab is generating a response, since a click can cancel or steer it.',
    input: {
      browser_tab_id: z.number().int(),
      element_id: z.string().min(1).describe('Opaque handle from browser_dom_query on this same tab.'),
      button: z.enum(CLICK_BUTTONS).optional(),
      click_count: z.number().int().min(1).max(3).optional().describe('2 for a double click.'),
      timeout_ms: z.number().int().min(1000).max(DOM_LIMITS.timeout_max_ms).optional(),
    },
    output: {
      browser_tab_id: z.number(),
      element_id: z.string(),
      clicked: z.boolean(),
      button: z.string(),
      click_count: z.number(),
      tag: z.string(),
      at: looseObject().optional().describe('Viewport coordinates the click was dispatched at.'),
      url: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const manager = requireFleet()
    return await clickOwnedTabElement(args, { fleet: manager, transport: manager.transport, signal: extra?.signal })
  })

  define('browser_tab_type', {
    family: 'browser',
    title: 'Type into an element in a Shiro-owned tab',
    description: `Inserts text into the editable element an element_id points at. mode=append (default) adds to what is there, mode=replace clears it first. submit=true presses Enter afterwards; without it nothing is submitted. Text is inserted as one input event rather than simulated keystrokes, so no character can be interpreted as a shortcut. The text is never echoed back in the result -- only its length. Typing into a password or one-time-code field is refused outright: the person at the keyboard enters those. At most ${DOM_LIMITS.max_text_length} characters. Refused while the tab is generating a response.`,
    input: {
      browser_tab_id: z.number().int(),
      element_id: z.string().min(1),
      text: z.string().max(DOM_LIMITS.max_text_length),
      mode: z.enum(TYPE_MODES).optional(),
      submit: z.boolean().optional().describe('Press Enter after typing. Off by default.'),
      timeout_ms: z.number().int().min(1000).max(DOM_LIMITS.timeout_max_ms).optional(),
    },
    output: {
      browser_tab_id: z.number(),
      element_id: z.string(),
      typed: z.boolean(),
      mode: z.string(),
      characters: z.number().describe('Length of what was typed; the text itself is deliberately not returned.'),
      submitted: z.boolean(),
      tag: z.string(),
      url: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const manager = requireFleet()
    return await typeIntoOwnedTabElement(args, { fleet: manager, transport: manager.transport, signal: extra?.signal })
  })

  define('browser_tab_evaluate', {
    family: 'browser',
    title: 'Run JavaScript in a Shiro-owned tab',
    description: `Evaluates a caller-supplied expression in one verified Shiro-owned tab and returns its JSON-serialized value. This is the last resort, not the first tool: browser_dom_query, browser_tab_click, browser_tab_type, browser_tab_navigate and browser_tab_screenshot cover ordinary automation with per-action bounds, while this can do anything the page can in a tab holding a live ChatGPT session. It therefore requires confirm=true. The result is serialized and size-checked INSIDE the page, so a cyclic or enormous value never crosses the wire: over the limit fails with INVALID_ARGUMENT rather than flooding the transcript. Exceptions come back as one normalized line. Expression limit ${EVALUATE_LIMITS.max_expression_length} characters, result limit ${EVALUATE_LIMITS.max_result_bytes} bytes. Refused while the tab is generating a response.`,
    input: {
      browser_tab_id: z.number().int(),
      expression: z.string().min(1).max(EVALUATE_LIMITS.max_expression_length).describe('JavaScript expression. It is awaited, so an async expression works.'),
      max_result_bytes: z.number().int().min(1000).max(EVALUATE_LIMITS.max_result_bytes).optional(),
      timeout_ms: z.number().int().min(1000).max(DOM_LIMITS.timeout_max_ms).optional(),
      confirm: confirmField('It runs arbitrary JavaScript in a page holding a live session.'),
    },
    output: {
      browser_tab_id: z.number(),
      fleet: z.string().optional(),
      slot: z.number().optional(),
      url: z.string(),
      value_type: z.string(),
      undefined_result: z.boolean(),
      json: z.string().optional().describe('JSON text of the value; absent when the expression evaluated to undefined.'),
      bytes: z.number(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    requiresConfirmation: true,
  }, async (args, extra) => {
    const manager = requireFleet()
    return await evaluateInOwnedTab(args, { fleet: manager, transport: manager.transport, signal: extra?.signal })
  })

  define('artifact_list', {
    family: 'artifact',
    workspaceScoped: true,
    title: 'List produced files, newest first',
    description: 'Lists files under the fixed project root sorted by modification time, newest first, each classified as image, text or blob with its mime type and a shiro:// resource uri. This is how you find what a task just produced; fs_list is the name-sorted directory view. Fetch the bytes with harness_get_artifact.',
    input: {
      path: pathField('Directory to scan. Defaults to the project root.').optional(),
      glob: z.array(z.string()).max(32).optional(),
      kind: z.enum(['image', 'text', 'blob']).optional().describe('Only return artifacts of this kind.'),
      modified_since: z.string().optional().describe('ISO timestamp; only artifacts modified at or after it.'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    output: {
      path: z.string(),
      artifacts: z.array(looseObject()).describe('{path, kind, mime_type, size, mtime, resource_uri}'),
      total: z.number(),
      returned: z.number(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, async args => {
    const limit = args.limit ?? 50
    const listing = await fs.listDirectory(sandboxOf(args), {
      path: args.path ?? '.',
      recursive: true,
      depth: 8,
      glob: args.glob,
      limit: fs.FS_LIMITS.list_max_entries,
    })
    const since = args.modified_since === undefined ? null : Date.parse(args.modified_since)
    if (since !== null && Number.isNaN(since)) fail('INVALID_ARGUMENT', 'modified_since must be an ISO timestamp')
    const artifacts = listing.entries
      .filter(entry => entry.type === 'file')
      .map(entry => ({ ...entry, ...classifyByExtension(entry.path), resource_uri: options.artifactUri(entry.path, workspaceIdOf(args)) }))
      .filter(entry => args.kind === undefined || entry.kind === args.kind)
      .filter(entry => since === null || Date.parse(entry.mtime) >= since)
      .sort((left, right) => Date.parse(right.mtime) - Date.parse(left.mtime))
    const page = artifacts.slice(0, limit).map(entry => ({
      path: entry.path,
      kind: entry.kind,
      mime_type: entry.mime_type,
      size: entry.size,
      mtime: entry.mtime,
      resource_uri: entry.resource_uri,
    }))
    return {
      path: listing.path,
      artifacts: page,
      total: artifacts.length,
      returned: page.length,
      truncated: page.length < artifacts.length || listing.truncated,
    }
  })

  define('artifact_metadata', {
    family: 'artifact',
    workspaceScoped: true,
    title: 'Metadata for one produced file',
    description: 'Size, mtime, sha256, classified kind, mime type and the shiro:// resource uri for one file under the fixed project root, without transferring its bytes. Use it to decide whether an artifact is worth fetching with harness_get_artifact.',
    input: { path: pathField(), include_hash: z.boolean().optional() },
    output: {
      path: z.string(),
      kind: z.string(),
      mime_type: z.string(),
      size: z.number(),
      mtime: z.string(),
      sha256: z.string().optional(),
      resource_uri: z.string(),
      fetchable: z.boolean().describe('False when the file exceeds the artifact transfer limit.'),
      max_fetch_bytes: z.number(),
    },
    annotations: READ_ONLY,
  }, async args => {
    const meta = await fs.statPath(sandboxOf(args), { path: args.path, include_hash: args.include_hash === true })
    if (meta.type !== 'file') fail('INVALID_ARGUMENT', `path is a ${meta.type}, not a file: ${meta.path}`)
    return {
      path: meta.path,
      ...classifyByExtension(meta.path),
      size: meta.size,
      mtime: meta.mtime,
      sha256: meta.sha256,
      resource_uri: options.artifactUri(meta.path, workspaceIdOf(args)),
      fetchable: meta.size <= options.maxArtifactBytes,
      max_fetch_bytes: options.maxArtifactBytes,
    }
  })

  define('artifact_delete', {
    family: 'artifact',
    workspaceScoped: true,
    title: 'Delete one produced file',
    description: 'Deletes a single regular file under the fixed project root after explicit confirmation. It refuses directories on purpose -- removing a tree is fs_delete with recursive=true. Optional expected_sha256 makes the delete fail with CONFLICT if the file is not the one the caller inspected.',
    input: {
      path: pathField(),
      expected_sha256: z.string().optional(),
      confirm: confirmField('It permanently removes the file.'),
    },
    output: { path: z.string(), deleted: z.boolean(), type: z.string() },
    annotations: DESTRUCTIVE,
    requiresConfirmation: true,
  }, async args => {
    requireConfirmation(args.confirm, `Permanently delete the file ${args.path}`)
    return await fs.deletePath(sandboxOf(args), { path: args.path, expected_type: 'file', expected_sha256: args.expected_sha256 })
  })

  // ------------------------------------------------------ media / network --

  define('image_open', {
    family: 'media',
    workspaceScoped: true,
    title: 'Look at an image',
    description: `Returns a PNG, JPEG, GIF, WebP or BMP file as an MCP image block, so the picture itself reaches the model instead of base64 text. Use it for screenshots, rendered charts, design references and diffs of visual output. Limit ${media.MEDIA_LIMITS.image_max_bytes} bytes -- check first with image_metadata, and crop or downscale a larger file (for example with exec_run) before opening it. Related: pdf_render_page for documents, fs_read with encoding=base64 for other binary files.`,
    input: { path: pathField('Image file relative to the workspace root.') },
    output: {
      path: z.string(),
      format: z.string(),
      mime_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      size: z.number(),
      sha256: z.string(),
    },
    annotations: READ_ONLY,
    rich: true,
  }, async args => {
    const image = await media.openImage(sandboxOf(args), args, { maxBytes: options.maxArtifactBytes })
    return { value: image.meta, content: [{ type: 'image', data: image.data.toString('base64'), mimeType: image.mimeType }] }
  })

  define('image_metadata', {
    family: 'media',
    workspaceScoped: true,
    title: 'Image format and pixel size',
    description: 'Reads format, width, height, byte size and mtime out of an image container header without decoding pixels, and reports fits_inline so you know whether image_open can return it. Cheap on very large files. Related: fs_stat for generic metadata.',
    input: { path: pathField('Image file relative to the workspace root.'), include_hash: z.boolean().optional() },
    output: {
      path: z.string(),
      format: z.string(),
      mime_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      size: z.number(),
      mtime: z.string(),
      sha256: z.string().optional(),
      fits_inline: z.boolean(),
    },
    annotations: READ_ONLY,
  }, args => media.imageMetadata(sandboxOf(args), args))

  define('pdf_info', {
    family: 'media',
    workspaceScoped: true,
    title: 'PDF page count and metadata',
    description: 'Page count, title, author, producer, page size and encryption state for one PDF, via poppler pdfinfo. Call it before pdf_render_page to know the valid page range. Fails with UNSUPPORTED when poppler is not installed on the host -- the bridge never pretends a missing tool succeeded.',
    input: { path: pathField('PDF file relative to the workspace root.') },
    output: {
      path: z.string(),
      pages: z.number().optional(),
      title: z.string().optional(),
      author: z.string().optional(),
      creator: z.string().optional(),
      producer: z.string().optional(),
      creation_date: z.string().optional(),
      page_size: z.string().optional(),
      encrypted: z.boolean().optional(),
      size: z.number(),
      fields: looseObject().describe('Every raw pdfinfo field, lower_snake_cased.'),
    },
    annotations: READ_ONLY,
  }, args => media.pdfInfo(sandboxOf(args), args))

  define('pdf_render_page', {
    family: 'media',
    workspaceScoped: true,
    title: 'Render one PDF page as an image',
    description: `Rasterises a single page with poppler pdftoppm and returns it as an MCP image block, so a document can actually be looked at instead of guessed at from extracted text. Rendering streams through stdout: nothing temporary is written into the workspace unless save_to asks for it. dpi 30-${media.MEDIA_LIMITS.pdf_max_dpi} (default ${media.MEDIA_LIMITS.pdf_default_dpi}); lower it if the page exceeds the inline limit. Fails with UNSUPPORTED when poppler is missing.`,
    input: {
      path: pathField('PDF file relative to the workspace root.'),
      page: z.number().int().min(1).max(media.MEDIA_LIMITS.pdf_max_page).optional().describe('1-based page number, default 1.'),
      dpi: z.number().int().min(30).max(media.MEDIA_LIMITS.pdf_max_dpi).optional(),
      grayscale: z.boolean().optional(),
      save_to: pathField('Optional path to also write the PNG to, inside the workspace.').optional(),
    },
    output: {
      path: z.string(),
      page: z.number(),
      dpi: z.number(),
      mime_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      bytes: z.number(),
      sha256: z.string(),
      saved_to: z.string().optional(),
    },
    annotations: READ_ONLY,
    rich: true,
  }, async args => {
    const page = await media.renderPdfPage(sandboxOf(args), args, { maxBytes: options.maxArtifactBytes })
    return { value: page.meta, content: [{ type: 'image', data: page.data.toString('base64'), mimeType: page.mimeType }] }
  })

  // The file object the ChatGPT connector runtime substitutes for an attachment.
  // OpenAI's Apps SDK reference requires all four properties declared with
  // download_url and file_id required; the string branch exists because field
  // reports describe a bare id (or a /mnt/data container path) arriving instead,
  // and a schema that rejected those would turn a diagnosable answer into an
  // opaque protocol error.
  const CONNECTOR_FILE = z.union([
    z.object({
      download_url: z.string().describe('Temporary URL the connector runtime issues for the attachment.'),
      file_id: z.string().describe('Connector-side identifier for the attachment.'),
      mime_type: z.string().optional(),
      file_name: z.string().optional(),
    }),
    z.string().describe('Fallback form: a direct URL, or a bare file id / container path (reported back as UNSUPPORTED with the reason).'),
  ])

  define('artifact_import', {
    family: 'network',
    workspaceScoped: true,
    meta: { 'openai/fileParams': ['file'] },
    title: 'Import an attached file into a workspace',
    description: `Brings a file the user attached in ChatGPT into the workspace filesystem. The connector runtime replaces the attachment with a file reference carrying a temporary download_url, so a ZIP, PDF, APK, dataset, image or source archive arrives as bytes on disk instead of trying to travel through a JSON argument. destination defaults to the attachment's own file name (reduced to one safe path segment); parent directories are created. Writes atomically and returns the sha256. Same gate as download_file -- it fetches a URL and writes to disk, and download_url is model-reachable text, so it needs confirm=true and cannot be used to bypass that gate. Pass source_url instead of file for a link you already have.`,
    input: {
      file: CONNECTOR_FILE.optional().describe('The attachment, supplied by the connector runtime. Exactly one of file or source_url.'),
      source_url: z.string().optional().describe('Direct http(s) link, when there is no attachment.'),
      destination: pathField('Destination path relative to the workspace root. Defaults to the attachment file name.').optional(),
      overwrite: z.boolean().optional(),
      max_bytes: z.number().int().min(1).max(NET_LIMITS.max_bytes_cap).optional(),
      expected_sha256: z.string().optional(),
      confirm: confirmField('It fetches from an external URL and writes the file into the workspace.'),
    },
    output: {
      url: z.string(),
      final_url: z.string(),
      path: z.string(),
      status: z.number(),
      bytes: z.number(),
      sha256: z.string(),
      content_type: z.string().optional(),
      declared_mime_type: z.string().optional(),
      file_id: z.string().optional(),
      file_name: z.string().optional(),
      redirects: z.array(looseObject()),
      overwrote: z.boolean(),
      imported: z.boolean(),
      duration_ms: z.number(),
    },
    annotations: NETWORK_WRITE,
    requiresConfirmation: true,
  }, async (args, extra) => {
    requireConfirmation(args.confirm, `Import ${args.file === undefined ? args.source_url : 'the attached file'} into ${args.destination ?? 'the workspace'}`)
    if (typeof args.source_url === 'string') policy.assertHost(args.source_url)
    if (typeof args.file?.download_url === 'string') policy.assertHost(args.file.download_url)
    return await importArtifact(sandboxOf(args), args, { signal: extra?.signal })
  })

  define('download_file', {
    family: 'network',
    workspaceScoped: true,
    title: 'Download a URL into the workspace',
    description: `Fetches one http(s) URL straight to a file inside the workspace: the way to bring in an archive, dataset, font, binary or sample that is too large to pass as base64 through fs_create_file, without depending on curl or wget being installed. Writes atomically (temp file plus rename), returns the sha256, and honours expected_sha256 by discarding a mismatch. Default cap ${NET_LIMITS.max_bytes_default} bytes, hard cap ${NET_LIMITS.max_bytes_cap}; at most ${NET_LIMITS.max_redirects} redirects, each re-validated; credentials in the URL and link-local (instance-metadata) hosts are refused. This leaves the machine and writes to disk, so it requires confirm=true.`,
    input: {
      url: z.string().min(1).describe('http or https URL. Credentials embedded in the URL are rejected.'),
      path: pathField('Destination file relative to the workspace root.'),
      overwrite: z.boolean().optional().describe('Replace an existing file (default false).'),
      create_parents: z.boolean().optional().describe('Create missing parent directories instead of failing with NOT_FOUND.'),
      max_bytes: z.number().int().min(1).max(NET_LIMITS.max_bytes_cap).optional(),
      timeout_ms: z.number().int().min(1000).max(NET_LIMITS.timeout_max_ms).optional(),
      expected_sha256: z.string().optional().describe('Discard the download and fail with CONFLICT unless the content hashes to this.'),
      headers: z.record(z.string(), z.string()).optional().describe('Extra request headers, for example an Authorization header you were given.'),
      confirm: confirmField('It contacts an external server and writes the response into the workspace.'),
    },
    output: {
      url: z.string(),
      final_url: z.string(),
      path: z.string(),
      status: z.number(),
      bytes: z.number(),
      sha256: z.string(),
      content_type: z.string().optional(),
      redirects: z.array(looseObject()),
      overwrote: z.boolean(),
      duration_ms: z.number(),
    },
    annotations: NETWORK_WRITE,
    requiresConfirmation: true,
  }, async (args, extra) => {
    requireConfirmation(args.confirm, `Download ${args.url} into ${args.path}`)
    policy.assertHost(args.url)
    return await downloadFile(sandboxOf(args), args, { signal: extra?.signal })
  })

  // ------------------------------------------------------- continuation --

  const continuation = options.continuation ?? null
  const requireContinuation = () => {
    if (continuation === null) fail('UNSUPPORTED', 'the continuation watchdog is unavailable because the browser relay is not configured')
    return continuation
  }
  const CONTINUATION_SHAPE = {
    designated: z.boolean(),
    browser_client_id: z.string().optional(),
    url: z.string().optional(),
    text: z.string().optional(),
    after_minutes: z.number().optional(),
    cooldown_minutes: z.number().optional(),
    max_nudges: z.number().optional(),
    nudges: z.number().optional(),
    nudges_remaining: z.number().optional(),
    designated_at: z.number().optional(),
    last_nudge_at: z.number().nullable().optional(),
    last_error: z.string().optional(),
    recent: z.array(looseObject()).optional(),
    defaults: looseObject().optional(),
  }

  define('continuation_set', {
    family: 'config',
    title: 'Keep a turn alive past the 25-minute cut-off',
    description: 'Names the ChatGPT tab holding THIS conversation as the one Shiro may nudge. When ChatGPT is stopped by the platform mid-turn, the turn is left waiting for a model answer that never arrives; after after_minutes (27 by default, past the ~25-minute cut-off) Shiro submits text ("continue") into that tab so the turn resumes. Get browser_client_id from browser_owned_tabs with include_foreign=true -- your own conversation tab is not fleet-owned, and naming it here is what authorises this one nudge. The designation is in memory only and dies with the bridge.',
    input: {
      browser_client_id: z.string().min(1).describe('From browser_owned_tabs (include_foreign=true): the tab holding this conversation.'),
      url: z.string().optional().describe('Expected tab URL, carried through to the relay.'),
      after_minutes: z.number().min(1).max(240).optional().describe('Silence before the first nudge. Default 27.'),
      cooldown_minutes: z.number().min(1).max(60).optional().describe('Minimum gap between nudges. Default 3.'),
      max_nudges: z.number().int().min(1).max(100).optional().describe('Budget before Shiro stops on its own. Default 8.'),
      text: z.string().min(1).max(2000).optional().describe('What to submit. Default "continue".'),
    },
    output: CONTINUATION_SHAPE,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => requireContinuation().designate(args))

  define('continuation_status', {
    family: 'config',
    title: 'The continuation watchdog',
    description: 'Reports whether a continuation tab is designated, how much nudge budget is left, and the recent nudges with their outcome. Read-only.',
    input: {},
    output: CONTINUATION_SHAPE,
    annotations: READ_ONLY,
  }, () => requireContinuation().snapshot())

  define('continuation_clear', {
    family: 'config',
    title: 'Stop nudging',
    description: 'Forgets the designated tab. Turns already waiting stay waiting -- this stops Shiro from typing into the conversation, it does not cancel anything.',
    input: {},
    output: { cleared: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => requireContinuation().clear())

  define('continuation_check', {
    family: 'config',
    title: 'Run one watchdog sweep now',
    description: 'Runs the sweep the timer would run, and reports what it did. Use it to verify the designation works without waiting out the timer.',
    input: {},
    output: {
      checked: z.number(),
      nudged: z.number(),
      reason: z.string().optional(),
      error: z.string().optional(),
      session_id: z.string().nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, () => requireContinuation().sweep())

  define('permission_get', {
    family: 'config',
    title: 'The permission profile in force',
    description: 'Reports the active profile, the ceiling the launcher configured, and the command and network rules. Profiles are a coarse dial in front of the whole action surface: read-only allows reads and nothing else, workspace-write adds workspace writes but no action that leaves this machine, full allows everything. It is intent enforced at the action boundary, not a sandbox — exec_run under workspace-write can still run a program that talks to the network; what the profile guarantees is that no ACTION whose purpose is to leave the machine is reachable. Always available, at every profile.',
    input: {},
    output: {
      profile: z.enum(PROFILES),
      ceiling: z.enum(PROFILES).describe('The widest profile this bridge may use. Set by the launcher; changing it needs a restart.'),
      can_widen: z.boolean(),
      command_allow: z.array(z.string()),
      command_deny: z.array(z.string()),
      network_allow: z.array(z.string()),
      network_deny: z.array(z.string()),
    },
    annotations: READ_ONLY,
  }, () => policy.snapshot())

  define('permission_set', {
    family: 'config',
    title: 'Narrow the permission profile',
    description: 'Narrows the active profile for the rest of this bridge’s life — for example dropping to read-only before letting a task explore an unfamiliar repository. It can only narrow: a caller able to raise its own ceiling has no ceiling, so widening fails with PERMISSION_REQUIRED and needs an operator to change the launcher configuration and restart. Command and network rules are not changed here; they come from configuration too.',
    input: {
      profile: z.enum(PROFILES),
      reason: z.string().max(400).optional().describe('Recorded in the result so the narrowing is explainable later.'),
    },
    output: {
      profile: z.enum(PROFILES),
      ceiling: z.enum(PROFILES),
      reason: z.string().optional(),
    },
    annotations: WRITE,
  }, args => policy.narrow(args.profile, { reason: args.reason }))

  // ------------------------------------------------- config / logs / metrics --

  define('config_get', {
    family: 'config',
    title: 'Effective bridge configuration',
    description: 'Returns the effective non-secret configuration and limits: provider, model, fixed project root, ports, wait budget, concurrency cap, runtime directories and which optional subsystems are configured. The bridge token, the relay token and every other credential are omitted, and the whole payload is passed through the secret redactor before it leaves. Read-only.',
    input: {},
    output: {
      provider: z.string(),
      model: z.string(),
      project_root: z.string(),
      workspace_allowlist: z.array(z.string()).describe('Directory prefixes workspace_open may address. Empty means single-rooted.'),
      permission: looseObject().describe('{profile, ceiling, command_allow, command_deny, network_allow, network_deny}'),
      port: z.number(),
      wait_ms: z.number(),
      max_concurrent_turns: z.number(),
      fleet_state_dir: z.string(),
      log_dir: z.string(),
      relay: looseObject().describe('{configured, url, model} -- never the token.'),
      grok: looseObject().describe('{provider, models, cli_configured}'),
      limits: looseObject(),
      redacted: z.boolean(),
    },
    annotations: READ_ONLY,
  }, () => options.redact({
    provider: config.provider,
    model: config.model,
    project_root: config.workspaceRoot,
    permission: policy.snapshot(),
    workspace_allowlist: [...workspaces.allowedRoots],
    port: config.port,
    wait_ms: config.waitMs,
    max_concurrent_turns: config.maxConcurrentTurns,
    fleet_state_dir: config.fleetStateDir,
    log_dir: config.logDir,
    relay: { configured: (config.relayUrl ?? '') !== '', url: config.relayUrl ?? '', model: config.relayModel },
    grok: { provider: config.grokProvider, models: config.grokModels ?? [], cli_configured: (config.grokCliPath ?? '') !== '' },
    limits: { ...fs.FS_LIMITS, ...EXEC_LIMITS, ...git.GIT_LIMITS, ...tasks.TASK_LIMITS, ...TERMINAL_LIMITS, ...WORKSPACE_LIMITS },
    redacted: true,
  }))

  define('config_validate', {
    family: 'config',
    title: 'Validate a candidate configuration',
    description: 'Runs a candidate bridge configuration object through the same normalizer the plugin uses at startup and reports whether it would be accepted, without applying anything. Use it before editing the launcher configuration and restarting. There is no config_set: bridge configuration is resolved once at startup, so nothing is safely mutable at runtime.',
    input: { config: looseObject().describe('Candidate configuration, same shape as the plugin config in cordis.patch.yml.') },
    output: {
      valid: z.boolean(),
      message: z.string().optional(),
      normalized: looseObject().optional().describe('Redacted normalized configuration when valid.'),
    },
    annotations: READ_ONLY,
  }, args => {
    try {
      const normalized = options.validateConfig(args.config ?? {})
      const { token, relayToken, ...safe } = normalized
      return { valid: true, normalized: options.redact(safe) }
    } catch (error) {
      return { valid: false, message: error.message }
    }
  })

  define('logs_tail', {
    family: 'config',
    title: 'Tail a Shiro service log',
    description: 'Reads the tail of one Shiro service log by stream name from the runtime log directory, which lives beside the project root, not inside it -- the stream name is a fixed allowlist, never a caller-supplied path. Output is passed through the secret redactor. Pass next_offset back to follow the log forward.',
    input: {
      stream: z.enum(options.logStreams),
      from_offset: z.number().int().min(0).optional().describe('Byte offset to read from. Omit to read the most recent max_bytes.'),
      max_bytes: z.number().int().min(256).max(EXEC_LIMITS.output_max_bytes).optional(),
    },
    output: {
      stream: z.string(),
      content: z.string(),
      offset: z.number(),
      next_offset: z.number(),
      size: z.number(),
      redacted: z.boolean(),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => options.readLog(args))

  define('metrics_snapshot', {
    family: 'config',
    title: 'Direct-action counters',
    description: 'Per-action call counts, error counts, mean and max duration, and the last error code seen, plus bridge uptime. Instrumentation is in-process and resets when the bridge restarts. Read-only; useful for spotting an action that is failing or slow.',
    input: { limit: z.number().int().min(1).max(200).optional() },
    output: {
      uptime_ms: z.number(),
      started_at: z.string(),
      total_calls: z.number(),
      total_errors: z.number(),
      actions: z.array(looseObject()).describe('{name, calls, errors, mean_ms, max_ms, last_error_code?, last_called_at?}'),
      ...truncationShape,
    },
    annotations: READ_ONLY,
  }, args => metrics.snapshot(args.limit ?? 50))

  return registry
}
