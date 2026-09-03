import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fail } from './action-errors.js'

// Thread lifecycle Shiro owns, on top of engine sessions it does not.
//
// The engine's session API exposes list/create/history/prompt/cancel. It has no
// archive, no delete and no prune, and reaching into its store to fake them
// would corrupt state the engine believes it owns. So the lifecycle Shiro can
// honestly offer is a Shiro-side one: an archive marker that hides a thread from
// Shiro's own listings and refuses to resume it, while the engine's copy of the
// conversation stays exactly as the engine left it.
//
// That distinction is the whole design. "Archived" here means "Shiro will not
// show or resume this", not "the transcript is gone" -- and the actions say so
// rather than implying a deletion that did not happen.

export const THREAD_LIMITS = Object.freeze({
  max_label_length: 120,
  max_reason_length: 400,
  max_prune: 500,
})

const STATE_VERSION = 1

export class ThreadRegistry {
  constructor({ stateFile, now = () => Date.now() } = {}) {
    if (typeof stateFile !== 'string' || stateFile.trim() === '') throw new Error('ThreadRegistry requires a state file path')
    this.stateFile = stateFile
    this.now = now
    this.threads = new Map()
    this.ready = this.#load()
  }

  async #load() {
    let raw
    try {
      raw = await readFile(this.stateFile, 'utf8')
    } catch {
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A corrupt marker file must not stop the bridge: the worst case is that
      // archived threads reappear, which is visible and recoverable.
      return
    }
    for (const entry of Array.isArray(parsed?.threads) ? parsed.threads : []) {
      if (typeof entry?.session_id !== 'string' || entry.session_id === '') continue
      this.threads.set(entry.session_id, entry)
    }
  }

  async #persist() {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const payload = { version: STATE_VERSION, threads: [...this.threads.values()] }
    const temporary = join(dirname(this.stateFile), `.threads.${process.pid}.${this.now()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temporary, this.stateFile)
  }

  /** Archived threads are hidden from listings and refused for resume. */
  isArchived(sessionId) {
    return this.threads.get(sessionId)?.archived === true
  }

  record(sessionId) {
    return this.threads.get(sessionId)
  }

  /**
   * Archive one thread. `hasActiveTurn` is supplied by the caller because only
   * the controller knows it: archiving a thread whose turn is still running
   * would hide work that is still happening.
   */
  async archive(sessionId, { label, reason, hasActiveTurn = false, force = false, workspace } = {}) {
    await this.ready
    const id = String(sessionId ?? '').trim()
    if (id === '') fail('INVALID_ARGUMENT', 'session_id is required')
    if (hasActiveTurn && force !== true) {
      fail('BUSY', `thread ${id} still has a running turn; cancel it with harness_cancel first, or pass force=true to archive it anyway (the turn keeps running)`)
    }
    const entry = {
      session_id: id,
      archived: true,
      archived_at: new Date(this.now()).toISOString(),
      workspace: typeof workspace === 'string' && workspace !== '' ? workspace : undefined,
      label: typeof label === 'string' && label !== '' ? label.slice(0, THREAD_LIMITS.max_label_length) : undefined,
      reason: typeof reason === 'string' && reason !== '' ? reason.slice(0, THREAD_LIMITS.max_reason_length) : undefined,
      forced: force === true ? true : undefined,
    }
    this.threads.set(id, entry)
    await this.#persist()
    return { ...entry, engine_transcript_retained: true }
  }

  async unarchive(sessionId) {
    await this.ready
    const id = String(sessionId ?? '').trim()
    const entry = this.threads.get(id)
    if (entry === undefined || entry.archived !== true) {
      fail('NOT_FOUND', `thread ${id} is not archived`)
    }
    this.threads.delete(id)
    await this.#persist()
    return { session_id: id, archived: false, restored_at: new Date(this.now()).toISOString() }
  }

  /**
   * Bulk archive by age or count. Dry run by default: a sweep that silently
   * hid a hundred threads on its first call would be the wrong default.
   */
  async prune(candidates, { olderThanDays, keepLast, dryRun = true, reason } = {}) {
    await this.ready
    const rows = [...(candidates ?? [])]
      .filter(row => typeof row?.session_id === 'string' && row.session_id !== '')
      .filter(row => !this.isArchived(row.session_id))
      .sort((left, right) => Date.parse(right.updated_at ?? right.created_at ?? 0) - Date.parse(left.updated_at ?? left.created_at ?? 0))

    let selected = rows
    if (Number.isFinite(olderThanDays)) {
      const cutoff = this.now() - (Number(olderThanDays) * 86_400_000)
      selected = selected.filter(row => {
        const stamp = Date.parse(row.updated_at ?? row.created_at ?? '')
        // A thread with no timestamp is never swept: unknown age is not old age.
        return Number.isFinite(stamp) && stamp < cutoff
      })
    }
    if (Number.isInteger(keepLast) && keepLast >= 0) {
      const keep = new Set(rows.slice(0, keepLast).map(row => row.session_id))
      selected = selected.filter(row => !keep.has(row.session_id))
    }
    if (olderThanDays === undefined && keepLast === undefined) {
      fail('INVALID_ARGUMENT', 'pass older_than_days, keep_last, or both: an unbounded prune is never what was meant')
    }
    selected = selected.filter(row => row.has_active_turn !== true).slice(0, THREAD_LIMITS.max_prune)

    if (dryRun) {
      return {
        dry_run: true,
        would_archive: selected.map(row => row.session_id),
        count: selected.length,
        skipped_active: rows.filter(row => row.has_active_turn === true).length,
      }
    }
    for (const row of selected) {
      this.threads.set(row.session_id, {
        session_id: row.session_id,
        archived: true,
        archived_at: new Date(this.now()).toISOString(),
        reason: typeof reason === 'string' && reason !== '' ? reason.slice(0, THREAD_LIMITS.max_reason_length) : 'pruned',
      })
    }
    if (selected.length > 0) await this.#persist()
    return {
      dry_run: false,
      archived: selected.map(row => row.session_id),
      count: selected.length,
      skipped_active: rows.filter(row => row.has_active_turn === true).length,
      engine_transcripts_retained: true,
    }
  }

  /** Archived rows, newest first. */
  async list({ limit = 50 } = {}) {
    await this.ready
    const all = [...this.threads.values()]
      .filter(entry => entry.archived === true)
      .sort((left, right) => Date.parse(right.archived_at ?? 0) - Date.parse(left.archived_at ?? 0))
    return { threads: all.slice(0, limit), total: all.length, truncated: all.length > limit }
  }
}
