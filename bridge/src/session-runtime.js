import { SessionKernel, defaultSessionStatePath } from './session-kernel.js'
import { recoveryHistory } from './session-recovery.js'
import { publicSessionStatus } from './session-status.js'

/** Runtime lifecycle owns leases; opening SQLite alone never performs recovery. */
export class SessionRuntime {
  constructor(config) {
    this.error = null
    this.ownsKernel = !config.sessionKernel
    try {
      this.kernel = config.sessionKernel ?? new SessionKernel({
        path: config.sessionStatePath ?? process.env.SHIRO_SESSION_STATE_PATH ?? defaultSessionStatePath(),
        workspaceRoot: config.workspaceRoot, now: config.sessionClock, leaseMs: config.sessionLeaseMs,
      })
      if (config.sessionHeartbeat !== false) {
        this.heartbeat = setInterval(() => {
          try { this.kernel.renewLeases() } catch (error) { this.error = error.message }
        }, Math.max(10, Math.floor(this.kernel.leaseMs / 3)))
        this.heartbeat.unref()
      }
    } catch (error) { this.error = error.message; this.kernel = null }
  }
  require() {
    if (!this.kernel || this.error) throw Object.assign(new Error('durable session state unavailable'), { code: 'UNAVAILABLE' })
    return this.kernel
  }
  persist(operation) {
    try { this.require().saveOperation(operation) } catch (error) {
      if (!['FENCED', 'CONFLICT', 'NOT_FOUND'].includes(error.code)) this.error = error.message
      throw error
    }
  }
  async recover(controller, readHistory, completion, scope) {
    if (!this.kernel) return
    const acquired = new Set()
    try {
      for (const saved of this.kernel.operations(scope.root)) {
        let owned = false
        try { this.kernel.assertLease(saved.rootSessionId); owned = true } catch {}
        if (owned && !acquired.has(saved.rootSessionId)) {
          const existing = controller.operations.get(saved.id)
          if (existing) { existing.workspace = scope.id; continue }
        }
        const operation = { ...saved, workspace: scope.id, workspaceRoot: scope.root }
        if (!owned) {
          try { this.kernel.acquireSession(operation.rootSessionId); acquired.add(operation.rootSessionId); owned = true }
          catch (error) { if (error.code !== 'CONFLICT') throw error }
        }
        if (acquired.has(operation.rootSessionId)) {
          this.kernel.recoverEffects(operation.id)
          const cancel = this.kernel.session(operation.rootSessionId, scope.id, scope.root).effects.find(effect => effect.effect_id === `cancel:${operation.id}` && effect.state === 'succeeded')
          if (cancel && operation.status !== 'cancelled') {
            operation.status = 'cancelled'
            operation.recoveryState = 'cancellation-accepted-effects-unverified'
            this.persist(operation)
          }
          if (operation.status === 'running' || operation.status === 'interrupted') {
            operation.status = 'interrupted'
            operation.recoveryState = 'interrupted-unverified'
            try {
              const workspace = await controller.workspace(scope.root)
              if (workspace.workspace.sessionIds.includes(operation.rootSessionId)) {
                const page = await recoveryHistory(beforeSeq => readHistory(operation.rootSessionId, beforeSeq), operation.afterSeq)
                const done = page && completion(page, operation.afterSeq)
                const starts = page?.events.filter(({ event }) => event.seq > operation.afterSeq && event.type === 'turn/start') ?? []
                const ends = page?.events.filter(({ event }) => event.seq > operation.afterSeq && event.type === 'turn/end') ?? []
                const dispatch = this.kernel.session(operation.rootSessionId, scope.id, scope.root).effects.find(effect => effect.operation_id === operation.id && effect.name === 'harness.prompt' && effect.state === 'succeeded')
                if (dispatch && starts.length === 1 && ends.length === 1 && starts[0].event.seq < done?.event.seq && done?.event.data?.reason?.kind === 'completed') {
                  operation.completion = done
                  operation.status = 'completed'
                  operation.recoveryState = 'reconciled-terminal'
                  operation.lastEventSeq = done.event.seq
                }
              }
            } catch { /* Unavailable history is not proof. Fencing is checked again by persist. */ }
            this.persist(operation)
          }
        }
        // A live foreign owner is visible as running, never as recovered execution.
        operation.executorAvailable = owned
        controller.operations.set(operation.id, operation)
        controller.operationsBySession.set(operation.rootSessionId, operation)
        controller.lastOperationId = operation.id
      }
    } catch (error) {
      if (error.code !== 'FENCED') this.error = error.message
    }
  }
  status(sessionId, workspaceId, root) {
    if (!this.kernel || this.error) return { durable: false, available: false, recovery_state: 'storage-unavailable' }
    return publicSessionStatus(this.kernel.session(sessionId, workspaceId, root), { durable: this.kernel.path !== ':memory:', workspace: workspaceId, now: this.kernel.now() })
  }
  close() {
    clearInterval(this.heartbeat)
    if (this.ownsKernel) this.kernel?.close()
    else this.kernel?.releaseLeases()
  }
}
