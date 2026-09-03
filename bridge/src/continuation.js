import { fail } from './action-errors.js'

// Keeping a turn alive across ChatGPT's 25-minute cut-off.
//
// THE PROBLEM THIS SOLVES
// When ChatGPT drives Shiro, ChatGPT IS the model: a turn advances only while it
// keeps answering harness_get_request with harness_continue. The platform stops
// it after about 25 minutes of work. The turn does not fail -- it sits in
// `model_input_required` forever, waiting for an answer that is never coming.
// Three such turns were found on this machine, two of them ten hours old.
//
// So Shiro types "continue" into the conversation itself. At minute 27 -- past
// the cut-off, and long enough that a merely slow answer is not interrupted.
//
// WHY A DESIGNATED TAB
// The conversation lives in the operator's own ChatGPT tab, which is exactly
// what browser ownership refuses to touch: a fleet tab is Shiro's, a personal
// tab is not. Rather than weaken that rule for every action, the operator names
// ONE tab and grants it ONE capability -- receiving this nudge. Nothing else in
// the browser family accepts a designated tab, and the designation is in memory
// only, so it dies with the bridge rather than outliving the intent.

export const CONTINUATION_DEFAULTS = Object.freeze({
  after_minutes: 27,
  text: 'continue',
  max_nudges: 8,
  cooldown_minutes: 3,
})

const MINUTE = 60_000

export class ContinuationWatchdog {
  /**
   * @param submit (tabIdentity, text) => Promise, the relay's passive-prompt path.
   * @param pending () => [{request_id, session_id, waiting_ms}], turns waiting on the model.
   */
  constructor({ submit, pending, now = () => Date.now(), log = () => {} } = {}) {
    this.submit = submit
    this.pending = pending
    this.now = now
    this.log = log
    this.target = null
    this.history = []
    this.timer = null
  }

  /** Name the tab, and the policy. Re-designating replaces the previous target. */
  designate(args = {}) {
    const clientId = String(args.browser_client_id ?? '').trim()
    if (clientId === '') fail('INVALID_ARGUMENT', 'browser_client_id is required: take it from browser_owned_tabs with include_foreign=true, choosing the tab holding this conversation')
    const afterMinutes = numberIn(args.after_minutes, CONTINUATION_DEFAULTS.after_minutes, 1, 240, 'after_minutes')
    const cooldownMinutes = numberIn(args.cooldown_minutes, CONTINUATION_DEFAULTS.cooldown_minutes, 1, 60, 'cooldown_minutes')
    const maxNudges = numberIn(args.max_nudges, CONTINUATION_DEFAULTS.max_nudges, 1, 100, 'max_nudges')
    const text = String(args.text ?? CONTINUATION_DEFAULTS.text).trim()
    if (text === '') fail('INVALID_ARGUMENT', 'text must not be empty')
    if (text.length > 2000) fail('INVALID_ARGUMENT', 'text is at most 2000 characters')

    this.target = {
      browser_client_id: clientId,
      url: typeof args.url === 'string' ? args.url : undefined,
      after_ms: afterMinutes * MINUTE,
      cooldown_ms: cooldownMinutes * MINUTE,
      max_nudges: maxNudges,
      text,
      designated_at: this.now(),
      nudges: 0,
      last_nudge_at: null,
      last_error: undefined,
    }
    this.history = []
    return this.snapshot()
  }

  clear() {
    const had = this.target !== null
    this.target = null
    return { cleared: had }
  }

  snapshot() {
    if (this.target === null) return { designated: false, defaults: { ...CONTINUATION_DEFAULTS } }
    const { after_ms: afterMs, cooldown_ms: cooldownMs, ...rest } = this.target
    return {
      designated: true,
      ...rest,
      after_minutes: Math.round(afterMs / MINUTE),
      cooldown_minutes: Math.round(cooldownMs / MINUTE),
      nudges_remaining: Math.max(0, this.target.max_nudges - this.target.nudges),
      recent: this.history.slice(-10),
    }
  }

  /**
   * One sweep. Returns what it did, so the action and the tests observe the
   * same thing the timer does.
   */
  async sweep() {
    const target = this.target
    if (target === null) return { checked: 0, nudged: 0, reason: 'no continuation tab is designated' }
    const now = this.now()
    if (target.nudges >= target.max_nudges) return { checked: 0, nudged: 0, reason: `the nudge budget (${target.max_nudges}) is spent; re-designate to reset it` }
    if (target.last_nudge_at !== null && now - target.last_nudge_at < target.cooldown_ms) {
      return { checked: 0, nudged: 0, reason: 'still inside the cooldown after the last nudge' }
    }

    let waiting
    try {
      waiting = await this.pending()
    } catch (error) {
      return { checked: 0, nudged: 0, reason: `could not read pending turns: ${error?.message ?? error}` }
    }
    const stalled = (Array.isArray(waiting) ? waiting : []).filter(row => Number(row?.waiting_ms ?? 0) >= target.after_ms)
    if (stalled.length === 0) return { checked: waiting?.length ?? 0, nudged: 0, reason: 'no turn has been waiting long enough' }

    // One nudge per sweep even when several turns are stalled: the message goes
    // into a conversation, and two "continue" lines in a row read as noise to
    // the model that has to act on them.
    const oldest = stalled.reduce((worst, row) => (Number(row.waiting_ms) > Number(worst.waiting_ms) ? row : worst), stalled[0])
    const entry = { at: new Date(now).toISOString(), session_id: oldest.session_id, waiting_ms: Number(oldest.waiting_ms), ok: false }
    try {
      await this.submit({ browser_client_id: target.browser_client_id, url: target.url }, target.text)
      entry.ok = true
      target.nudges += 1
      target.last_nudge_at = now
      target.last_error = undefined
    } catch (error) {
      // A failed nudge does NOT spend the budget or start the cooldown: the
      // turn is still stalled, and refusing to retry would strand it.
      entry.error = String(error?.message ?? error)
      target.last_error = entry.error
    }
    this.history.push(entry)
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50)
    this.log('continuation.nudge', entry)
    return { checked: waiting.length, nudged: entry.ok ? 1 : 0, ...(entry.error === undefined ? {} : { error: entry.error }), session_id: oldest.session_id }
  }

  /** Start sweeping. Unref'd so the watchdog never holds the process open. */
  start({ everyMs = 30_000 } = {}) {
    this.stop()
    this.timer = setInterval(() => { void this.sweep().catch(() => {}) }, everyMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}

function numberIn(value, fallback, min, max, label) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) fail('INVALID_ARGUMENT', `${label} must be between ${min} and ${max}`)
  return number
}
