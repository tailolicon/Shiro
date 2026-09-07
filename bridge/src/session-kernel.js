import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, realpathSync, existsSync } from 'node:fs'
import { basename, dirname, resolve, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

export const defaultSessionStatePath = () => resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'shiro', 'sessions.sqlite')
const conflict = message => Object.assign(new Error(message), { code: 'CONFLICT' })
const missing = () => Object.assign(new Error('session is not registered under this workspace'), { code: 'NOT_FOUND' })
function canonical(path) {
  if (existsSync(path)) return realpathSync(path)
  return resolve(canonical(dirname(path)), basename(path))
}
export const canonicalWorkspaceRoot = root => canonical(resolve(root))
export const workspaceIdentity = root => `root:${createHash('sha256').update(canonicalWorkspaceRoot(root)).digest('hex')}`
const fenced = () => Object.assign(new Error('executor lease expired or fenced by another owner'), { code: 'FENCED' })

export function assertStateOutsideWorkspace(path, root) {
  if (path === ':memory:' || !root) return
  const rel = relative(canonical(resolve(root)), canonical(resolve(path)))
  if (rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))) {
    throw conflict('session state database must live outside the coding workspace')
  }
}

/** Synchronous, short transactions serialize ownership and receipts across connections.
 * Callers own lifecycle/recovery; opening a second connection never rewrites running work.
 */
export class SessionKernel {
  constructor({ path = defaultSessionStatePath(), workspaceRoot, now = Date.now, leaseMs = 30_000, executorId = randomUUID() } = {}) {
    if (!Number.isFinite(leaseMs) || leaseMs < 30) throw new Error('leaseMs must be at least 30 milliseconds')
    this.now = now
    this.leaseMs = leaseMs
    this.executorId = executorId
    this.leases = new Map()
    assertStateOutsideWorkspace(path, workspaceRoot)
    this.path = path === ':memory:' ? path : resolve(path)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      const existed = path === ':memory:' || existsSync(path)
      this.db = new DatabaseSync(path)
      if (!existed) chmodSync(path, 0o600)
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version
        if (version > 2) throw new Error(`unsupported session schema version ${version}`)
        if (version === 0) this.db.exec(`
          CREATE TABLE sessions (
            session_id TEXT PRIMARY KEY, runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('web-harness','codex-native','direct')),
            loop_owner TEXT NOT NULL CHECK(loop_owner IN ('harness','codex','direct')),
            workspace_id TEXT NOT NULL, workspace_root TEXT NOT NULL,
            requested_model TEXT, verified_model TEXT, requested_effort TEXT, verified_effort TEXT,
            browser_binding TEXT, codex_thread_id TEXT, last_event_seq INTEGER NOT NULL DEFAULT -1,
            checkpoint TEXT, recovery_state TEXT NOT NULL DEFAULT 'clean', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            CHECK ((runtime_mode='web-harness' AND loop_owner='harness') OR (runtime_mode='codex-native' AND loop_owner='codex') OR (runtime_mode='direct' AND loop_owner='direct'))
          );
          CREATE TRIGGER immutable_session_owner BEFORE UPDATE OF runtime_mode,loop_owner,workspace_id,workspace_root ON sessions
            WHEN NEW.runtime_mode != OLD.runtime_mode OR NEW.loop_owner != OLD.loop_owner OR NEW.workspace_id != OLD.workspace_id OR NEW.workspace_root != OLD.workspace_root
            BEGIN SELECT RAISE(ABORT, 'session ownership is immutable'); END;
          CREATE TABLE operations (
            operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id),
            state TEXT NOT NULL CHECK(state IN ('running','completed','cancelled','failed','interrupted')),
            after_seq INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            UNIQUE(operation_id, session_id)
          );
          CREATE UNIQUE INDEX one_running_operation ON operations(session_id) WHERE state='running';
          CREATE TABLE effects (
            effect_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id),
            operation_id TEXT NOT NULL REFERENCES operations(operation_id), name TEXT NOT NULL, arguments TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('planned','started','succeeded','failed','uncertain')),
            receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            FOREIGN KEY(operation_id, session_id) REFERENCES operations(operation_id, session_id)
          );
          PRAGMA user_version=1;
        `)
        if (version < 2) {
          // V1 stored registry aliases. They cannot survive a registry restart.
          this.db.exec(`DROP TRIGGER immutable_session_owner;
            ALTER TABLE sessions ADD COLUMN executor_id TEXT;
            ALTER TABLE sessions ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE sessions ADD COLUMN fence INTEGER NOT NULL DEFAULT 0;`)
          for (const row of this.db.prepare('SELECT session_id,workspace_root FROM sessions').all()) {
            const root = canonicalWorkspaceRoot(row.workspace_root)
            this.db.prepare('UPDATE sessions SET workspace_root=?,workspace_id=? WHERE session_id=?').run(root, workspaceIdentity(root), row.session_id)
          }
          this.db.exec(`CREATE TRIGGER immutable_session_owner BEFORE UPDATE OF runtime_mode,loop_owner,workspace_id,workspace_root ON sessions
            WHEN NEW.runtime_mode != OLD.runtime_mode OR NEW.loop_owner != OLD.loop_owner OR NEW.workspace_id != OLD.workspace_id OR NEW.workspace_root != OLD.workspace_root
            BEGIN SELECT RAISE(ABORT, 'session ownership is immutable'); END;
            PRAGMA user_version=2;`)
        }
      })
    } catch (error) { this.db?.close(); throw error }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      if (value?.then) throw new Error('SQLite transactions must be synchronous')
      this.db.exec('COMMIT')
      return value
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  claim({ session_id, runtime_mode, loop_owner, workspace_id, workspace_root }) {
    assertStateOutsideWorkspace(this.path, workspace_root)
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(session_id)
      if (old && (old.workspace_root !== canonicalWorkspaceRoot(workspace_root))) throw missing()
      if (old && (old.loop_owner !== loop_owner || old.runtime_mode !== runtime_mode)) throw conflict('session loop ownership is immutable')
      const now = this.now()
      this.db.prepare('INSERT INTO sessions(session_id,runtime_mode,loop_owner,workspace_id,workspace_root,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET updated_at=excluded.updated_at')
        .run(session_id, runtime_mode, loop_owner, workspaceIdentity(workspace_root), canonicalWorkspaceRoot(workspace_root), now, now)
      this._acquireSession(session_id)
    })
  }
  session(id, workspaceId, root) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(id)
    if (!row || row.workspace_root !== canonicalWorkspaceRoot(root)) throw missing()
    return { ...row, browser_binding: JSON.parse(row.browser_binding ?? 'null'), checkpoint: JSON.parse(row.checkpoint ?? 'null'),
      operations: this.db.prepare('SELECT * FROM operations WHERE session_id=? ORDER BY created_at').all(id).map(row => ({ ...row, data: JSON.parse(row.data) })),
      effects: this.db.prepare('SELECT effect_id,operation_id,name,state,receipt,created_at,updated_at FROM effects WHERE session_id=?').all(id).map(row => ({ ...row, receipt: JSON.parse(row.receipt ?? 'null') })) }
  }
  // All state writes and their fence checks share one SQLite write transaction.
  _assertLease(id) {
    const row = this.db.prepare('SELECT executor_id,lease_until,fence FROM sessions WHERE session_id=?').get(id)
    if (!row || row.executor_id !== this.executorId || row.fence !== this.leases.get(id) || row.lease_until <= this.now()) throw fenced()
    return row.fence
  }
  assertLease(id) { return this._assertLease(id) }
  _acquireSession(id) {
    const row = this.db.prepare('SELECT executor_id,lease_until,fence FROM sessions WHERE session_id=?').get(id)
    if (!row) throw missing()
    if (row.executor_id === this.executorId && row.lease_until > this.now() && this.leases.get(id) === row.fence) return row.fence
    if (row.executor_id !== null && row.lease_until > this.now()) throw conflict('session has a live executor lease')
    const token = row.fence + 1
    this.db.prepare('UPDATE sessions SET executor_id=?,lease_until=?,fence=? WHERE session_id=?').run(this.executorId, this.now() + this.leaseMs, token, id)
    this.leases.set(id, token)
    return token
  }
  acquireSession(id) { return this.transaction(() => this._acquireSession(id)) }
  renewLeases() {
    this.transaction(() => {
      for (const [id, token] of this.leases) {
        this.db.prepare('UPDATE sessions SET lease_until=? WHERE session_id=? AND executor_id=? AND fence=? AND lease_until>?')
          .run(this.now() + this.leaseMs, id, this.executorId, token, this.now())
      }
    })
  }
  releaseLeases() {
    this.transaction(() => {
      for (const [id, token] of this.leases) this.db.prepare('UPDATE sessions SET executor_id=NULL,lease_until=0 WHERE session_id=? AND executor_id=? AND fence=?').run(id, this.executorId, token)
    })
    this.leases.clear()
  }
  updateSession(id, fields) {
    return this.transaction(() => { this._assertLease(id); this._updateSession(id, fields) })
  }
  _updateSession(id, fields) {
    const allowed = new Set(['requested_model','verified_model','requested_effort','verified_effort','browser_binding','codex_thread_id','last_event_seq','checkpoint','recovery_state'])
    for (const key of Object.keys(fields)) if (!allowed.has(key)) throw new Error(`invalid session field ${key}`)
    const entries = Object.entries(fields)
    if (!entries.length) return
    this.db.prepare(`UPDATE sessions SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE session_id=?`)
      .run(...entries.map(([key, value]) => ['browser_binding','checkpoint'].includes(key) ? JSON.stringify(value) : value), this.now(), id)
  }
  bindBrowser(id, workspaceId, root, binding, verification = {}) {
    this.session(id, workspaceId, root)
    // Verification is explicit observed evidence, never copied from requested fields.
    if ((verification.model || verification.effort) && !verification.evidence) throw new Error('model verification requires observed evidence')
    this.updateSession(id, { browser_binding: { ...binding, observed_at: this.now(), verification_evidence: verification.evidence ?? null },
      verified_model: verification.model ?? null, verified_effort: verification.effort ?? null })
  }
  saveOperation(operation) {
    this.transaction(() => {
      this._assertLease(operation.rootSessionId)
      const session = this.db.prepare('SELECT workspace_root FROM sessions WHERE session_id=?').get(operation.rootSessionId)
      if (!session || session.workspace_root !== canonicalWorkspaceRoot(operation.workspaceRoot)) throw missing()
      const previous = this.db.prepare('SELECT session_id,after_seq FROM operations WHERE operation_id=?').get(operation.id)
      if (previous && (previous.session_id !== operation.rootSessionId || previous.after_seq !== operation.afterSeq)) throw conflict('operation identity and baseline are immutable')
      const now = this.now()
      this.db.prepare(`INSERT INTO operations VALUES(?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at`)
        .run(operation.id, operation.rootSessionId, operation.status, operation.afterSeq, JSON.stringify({ ...operation, workspace: undefined, executorAvailable: undefined }), operation.startedAt, now)
      this._updateSession(operation.rootSessionId, { last_event_seq: operation.lastEventSeq ?? operation.afterSeq,
        checkpoint: { operation_id: operation.id, after_seq: operation.afterSeq }, recovery_state: operation.recoveryState ?? 'clean' })
    })
  }
  operations(root) {
    return this.db.prepare('SELECT o.*,s.workspace_id,s.workspace_root FROM operations o JOIN sessions s USING(session_id) WHERE s.workspace_root=? ORDER BY o.created_at')
      .all(canonicalWorkspaceRoot(root)).map(row => ({
        ...JSON.parse(row.data), id: row.operation_id, rootSessionId: row.session_id,
        workspace: row.workspace_id, workspaceRoot: row.workspace_root, status: row.state,
        afterSeq: row.after_seq, startedAt: row.created_at,
      }))
  }
  planEffect({ effect_id, session_id, operation_id, name, arguments: args }) {
    this.transaction(() => {
      this._assertLease(session_id)
      const operation = this.db.prepare('SELECT session_id FROM operations WHERE operation_id=?').get(operation_id)
      if (operation?.session_id !== session_id) throw conflict('effect operation belongs to another session')
      const now = this.now()
      this.db.prepare('INSERT INTO effects VALUES(?,?,?,?,?,?,?,?,?)').run(effect_id,session_id,operation_id,name,JSON.stringify(args),'planned',null,now,now)
    })
  }
  transitionEffect(id, state, receipt = null) {
    return this.transaction(() => {
      const effect = this.db.prepare('SELECT session_id FROM effects WHERE effect_id=?').get(id)
      if (!effect) throw missing()
      this._assertLease(effect.session_id)
      const from = { started: 'planned', succeeded: 'started', failed: 'started', uncertain: 'started' }[state]
      if (!from) throw conflict('invalid effect transition')
      const result = this.db.prepare('UPDATE effects SET state=?,receipt=?,updated_at=? WHERE effect_id=? AND state=?').run(state,JSON.stringify(receipt),this.now(),id,from)
      if (result.changes !== 1) throw conflict('effect cannot be retried or transitioned from its current state')
    })
  }
  recoverEffects(operationId) {
    this.transaction(() => {
      const operation = this.db.prepare('SELECT session_id FROM operations WHERE operation_id=?').get(operationId)
      if (!operation) throw missing()
      this._assertLease(operation.session_id)
      this.db.prepare("UPDATE effects SET state='uncertain',updated_at=? WHERE operation_id=? AND state='started'").run(this.now(),operationId)
    })
  }
  /** Persist intent before dispatch. Any thrown error may have happened after a side effect. */
  async runEffect(effect, execute) {
    this.planEffect(effect)
    this.transitionEffect(effect.effect_id, 'started')
    try { const receipt = await execute(); this.transitionEffect(effect.effect_id, 'succeeded', receipt ?? null); return receipt }
    catch (error) {
      if (error.code !== 'FENCED') this.transitionEffect(effect.effect_id, 'uncertain', { error: String(error.message ?? error) })
      throw error
    }
  }
  close() { this.releaseLeases(); this.db.close() }
}
