import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import readline from 'node:readline'
import { redactSecrets } from './redact.js'

export const ACTION_GAP_PROBLEM_TYPES = Object.freeze([
  'missing_action',
  'bad_action_design',
  'composite_action',
  'agent_misuse',
])

export const ACTION_GAP_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical'])

export const FRICTION_WEIGHTS = Object.freeze({
  unnecessary_tool_calls: 1,
  retries: 3,
  permission_failures: 2,
  shell_workarounds: 2,
  schema_errors: 3,
  agent_confusion: 2,
})

const SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 })
const REPORT_FILE = 'reports.jsonl'

function cleanText(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function cleanActionName(value) {
  return cleanText(value).replace(/[^a-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '')
}

function boundedCount(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1000, Math.trunc(value)))
}

export function calculateFrictionScore(metrics = {}) {
  return Object.entries(FRICTION_WEIGHTS).reduce((score, [key, weight]) => {
    return score + boundedCount(metrics?.[key]) * weight
  }, 0)
}

export function actionGapFingerprint(report) {
  const problemType = ACTION_GAP_PROBLEM_TYPES.includes(report?.problem_type)
    ? report.problem_type
    : 'unknown'
  const suggested = cleanActionName(report?.suggested_action)
  const attempted = Array.isArray(report?.attempted_actions)
    ? [...new Set(report.attempted_actions.map(cleanActionName).filter(Boolean))].sort()
    : []
  const task = cleanText(report?.task)

  // Prefer the capability/action identity when the caller knows it. That lets
  // many differently-worded complaints about the same missing/bad action land
  // in one bucket. Otherwise fall back to the attempted chain, then task text.
  const identity = suggested !== ''
    ? `suggested:${suggested}`
    : attempted.length > 0
      ? `attempted:${attempted.join(',')}`
      : `task:${task}`
  return createHash('sha256').update(`${problemType}|${identity}`).digest('hex').slice(0, 24)
}

export function defaultActionGapStateDir(workspaceRoot) {
  return join(workspaceRoot, '.shiro', 'action-gaps')
}

function exactActionMatches(suggestedAction, knownActions) {
  const needle = cleanActionName(suggestedAction)
  if (needle === '') return []
  return knownActions
    .map(action => typeof action === 'string' ? action : action?.name)
    .filter(name => typeof name === 'string' && cleanActionName(name) === needle)
}

function representative(record) {
  return {
    task: record.task,
    context: record.context,
    attempted_actions: record.attempted_actions,
    current_workaround: record.current_workaround,
    suggested_action: record.suggested_action,
    suggested_signature: record.suggested_signature,
    evidence: record.evidence,
    repo_context: record.repo_context,
    session_context: record.session_context,
    source_agent: record.source_agent,
    existing_action_matches: record.existing_action_matches,
  }
}

export class ActionGapCollector {
  constructor({ stateDir, redact = redactSecrets, now = () => new Date(), id = randomUUID } = {}) {
    if (typeof stateDir !== 'string' || stateDir.trim() === '') throw new Error('ActionGapCollector requires stateDir')
    this.stateDir = stateDir
    this.reportFile = join(stateDir, REPORT_FILE)
    this.redact = redact
    this.now = now
    this.id = id
    // Serialize appends inside one bridge process. The file itself is opened in
    // append mode, so separate processes also cannot overwrite prior records.
    this.writeTail = Promise.resolve()
  }

  async report(input, { knownActions = [], workspaceContext } = {}) {
    const timestamp = this.now().toISOString()
    const frictionScore = calculateFrictionScore(input.friction)
    const existingMatches = exactActionMatches(input.suggested_action, knownActions)
    const possibleAgentMisuse = input.problem_type === 'missing_action' && existingMatches.length > 0

    const raw = {
      id: this.id(),
      fingerprint: actionGapFingerprint(input),
      submitted_at: timestamp,
      problem_type: input.problem_type,
      severity: input.severity ?? 'medium',
      task: input.task,
      context: input.context,
      attempted_actions: input.attempted_actions,
      current_workaround: input.current_workaround,
      suggested_action: input.suggested_action,
      suggested_signature: input.suggested_signature,
      evidence: input.evidence,
      estimated_savings_calls: input.estimated_savings_calls,
      friction: input.friction,
      friction_score: frictionScore,
      repo_context: input.repo_context,
      session_context: input.session_context,
      source_agent: input.source_agent,
      workspace: workspaceContext,
      existing_action_matches: existingMatches,
      possible_agent_misuse: possibleAgentMisuse,
    }
    const record = this.redact(raw)
    const line = `${JSON.stringify(record)}\n`

    const write = async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
      const handle = await open(this.reportFile, 'a', 0o600)
      try {
        await handle.write(line)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    const pending = this.writeTail.then(write, write)
    this.writeTail = pending.catch(() => {})
    await pending

    return {
      id: record.id,
      fingerprint: record.fingerprint,
      submitted_at: record.submitted_at,
      friction_score: record.friction_score,
      existing_action_matches: record.existing_action_matches ?? [],
      possible_agent_misuse: record.possible_agent_misuse === true,
      queued: true,
      state_file: REPORT_FILE,
    }
  }

  async summary({ limit = 50, min_count = 1, problem_type, severity } = {}) {
    const groups = new Map()
    let totalReports = 0
    let malformedLines = 0

    try {
      const stream = createReadStream(this.reportFile, { encoding: 'utf8' })
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of lines) {
        if (line.trim() === '') continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          malformedLines += 1
          continue
        }
        if (problem_type && record.problem_type !== problem_type) continue
        if (severity && record.severity !== severity) continue
        totalReports += 1
        const key = typeof record.fingerprint === 'string' && record.fingerprint !== ''
          ? record.fingerprint
          : actionGapFingerprint(record)
        const current = groups.get(key)
        if (!current) {
          groups.set(key, {
            fingerprint: key,
            problem_type: record.problem_type,
            count: 1,
            first_seen: record.submitted_at,
            last_seen: record.submitted_at,
            max_severity: record.severity ?? 'medium',
            total_friction_score: Number(record.friction_score) || 0,
            total_estimated_savings_calls: Number(record.estimated_savings_calls) || 0,
            possible_agent_misuse_count: record.possible_agent_misuse === true ? 1 : 0,
            representative: representative(record),
          })
          continue
        }
        current.count += 1
        if (String(record.submitted_at ?? '') < String(current.first_seen ?? '')) current.first_seen = record.submitted_at
        if (String(record.submitted_at ?? '') > String(current.last_seen ?? '')) {
          current.last_seen = record.submitted_at
          current.representative = representative(record)
        }
        if ((SEVERITY_RANK[record.severity] ?? 0) > (SEVERITY_RANK[current.max_severity] ?? 0)) current.max_severity = record.severity
        current.total_friction_score += Number(record.friction_score) || 0
        current.total_estimated_savings_calls += Number(record.estimated_savings_calls) || 0
        if (record.possible_agent_misuse === true) current.possible_agent_misuse_count += 1
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }

    const items = [...groups.values()]
      .filter(item => item.count >= min_count)
      .map(item => ({
        ...item,
        mean_friction_score: item.count === 0 ? 0 : Math.round((item.total_friction_score / item.count) * 100) / 100,
        mean_estimated_savings_calls: item.count === 0 ? 0 : Math.round((item.total_estimated_savings_calls / item.count) * 100) / 100,
      }))
      .sort((left, right) => right.count - left.count || right.total_friction_score - left.total_friction_score || String(right.last_seen).localeCompare(String(left.last_seen)))
      .slice(0, limit)

    return {
      total_reports: totalReports,
      unique_gaps: groups.size,
      returned: items.length,
      malformed_lines: malformedLines,
      items,
      state_file: REPORT_FILE,
    }
  }
}
