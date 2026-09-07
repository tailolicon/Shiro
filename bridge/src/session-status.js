import { redactSecrets } from './redact.js'

// A shallow allowlist at every level: arbitrary engine data, receipts and
// assistant text never enter the public projection, even under future schemas.
function text(value) {
  if (typeof value !== 'string') return null
  return redactSecrets(value)
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer ***')
    .replace(/\b(api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|credential)\s*[=:]\s*[^\s,;"']+/gi, '$1=***')
    .replace(/-----BEGIN[^\n]*PRIVATE KEY[^\n]*-----[\s\S]*/g, '***PRIVATE KEY***')
}
function url(value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    if (!['https:', 'http:'].includes(parsed.protocol)) return null
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''
    return text(parsed.href)
  } catch { return null }
}
const number = value => Number.isFinite(value) ? value : null
export function publicSessionStatus(row, { durable, workspace, now }) {
  const binding = row.browser_binding
  return {
    durable, available: true, session_id: text(row.session_id), runtime_mode: text(row.runtime_mode), loop_owner: text(row.loop_owner),
    workspace: text(workspace), workspace_id: text(row.workspace_id), workspace_root: text(row.workspace_root),
    requested_model: text(row.requested_model), verified_model: text(row.verified_model),
    requested_effort: text(row.requested_effort), verified_effort: text(row.verified_effort),
    codex_thread_id: text(row.codex_thread_id), recovery_state: text(row.recovery_state),
    last_event_seq: number(row.last_event_seq), created_at: number(row.created_at), updated_at: number(row.updated_at),
    checkpoint: row.checkpoint ? { operation_id: text(row.checkpoint.operation_id), after_seq: number(row.checkpoint.after_seq) } : null,
    executor: { lease_active: !!row.executor_id && row.lease_until > now, lease_until: number(row.lease_until), fence: number(row.fence) },
    browser_binding: binding ? { client_id: text(binding.client_id), tab_id: typeof binding.tab_id === 'number' ? number(binding.tab_id) : text(binding.tab_id),
      conversation_id: text(binding.conversation_id), url: url(binding.url), requested_browser_model: text(binding.requested_browser_model),
      selection_source: text(binding.selection_source), observed_at: number(binding.observed_at) } : null,
    operations: row.operations.map(operation => ({ operation_id: text(operation.operation_id), state: text(operation.state),
      after_seq: number(operation.after_seq), created_at: number(operation.created_at), updated_at: number(operation.updated_at) })),
    effects: row.effects.map(effect => ({ effect_id: text(effect.effect_id), operation_id: text(effect.operation_id), name: text(effect.name),
      state: text(effect.state), created_at: number(effect.created_at), updated_at: number(effect.updated_at) })),
  }
}
