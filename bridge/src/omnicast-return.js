import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

import { fail } from './action-errors.js'
import { errorResult, resultSchema, toolResult } from './mcp-result.js'


const NONCE = /^[0-9a-f]{32}$/
const CONNECTOR = 'connector'
const INTERNAL_CLIENTS = new Set(['shiro-cli', 'shiro-python'])
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}
const READ = { ...WRITE, readOnlyHint: true, idempotentHint: true }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const RESERVATION_PHASES = new Set(['submitting', 'submitted', 'uncertain', 'closing'])


function requireNonce(value) {
  const nonce = String(value ?? '').trim().toLowerCase()
  if (!NONCE.test(nonce)) fail('INVALID_ARGUMENT', 'nonce must be exactly 32 lowercase hex characters')
  return nonce
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''))
  const b = Buffer.from(String(right ?? ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

function requireInternal(clientKind) {
  if (!INTERNAL_CLIENTS.has(clientKind)) {
    fail('PERMISSION_REQUIRED', 'only a marked local Shiro client may manage an OmniCast return lease')
  }
}

function requireConnector(clientKind) {
  if (clientKind !== CONNECTOR) {
    fail('PERMISSION_REQUIRED', 'only the inbound ChatGPT connector may submit an OmniCast result')
  }
}

function validateLease(value) {
  if (!value || typeof value !== 'object') throw new Error('OmniCast return state is not an object')
  const nonce = requireNonce(value.nonce)
  const clientId = String(value.clientId ?? '').trim()
  if (!clientId) throw new Error('OmniCast return state has no clientId')
  const openedAt = Number(value.openedAt)
  const expiresAt = Number(value.expiresAt)
  const maxBytes = Number(value.maxBytes)
  if (![openedAt, expiresAt, maxBytes].every(Number.isFinite)) {
    throw new Error('OmniCast return state has invalid numeric fields')
  }
  const text = value.text === null || value.text === undefined ? null : String(value.text)
  return {
    nonce,
    clientId,
    userTurnKey: String(value.userTurnKey ?? ''),
    openedAt,
    expiresAt,
    maxBytes,
    text,
    bytes: Number(value.bytes) || 0,
    sha256: String(value.sha256 ?? ''),
    submittedAt: value.submittedAt === null || value.submittedAt === undefined
      ? null
      : Number(value.submittedAt),
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function validateReservation(value, lease) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('relay reservation is not an object')
  }
  const nonce = requireNonce(value.nonce)
  const clientId = String(value.clientId ?? '').trim()
  const phase = String(value.phase ?? '').trim()
  const pid = Number(value.pid)
  const startedAt = Number(value.startedAt)
  const userTurnKey = String(value.userTurnKey ?? '')
  if (nonce !== lease.nonce || clientId !== lease.clientId) {
    throw new Error('relay reservation does not match its lease')
  }
  if (!RESERVATION_PHASES.has(phase)) throw new Error('relay reservation phase is invalid')
  if (!Number.isInteger(pid) || pid < 1 || !Number.isFinite(startedAt)) {
    throw new Error('relay reservation process fields are invalid')
  }
  if (phase === 'submitted' && !userTurnKey) {
    throw new Error('submitted relay reservation has no userTurnKey')
  }
  return { nonce, clientId, phase, pid, startedAt, userTurnKey }
}

/** Pure exact-turn proof used by the live fleet callback and unit tests. */
export function omnicastLeaseIsIdle({
  lease,
  client,
  reservation = null,
  now = Date.now(),
  isProcessAlive = processAlive,
}) {
  if (!client || client.activeRequest) return false
  const observation = client.tabObservation ?? {}
  const turn = observation.turn ?? {}
  const generation = observation.generation ?? {}
  const output = observation.output ?? {}
  const stopped = ['idle', 'stopped'].includes(generation.state)
  if (!stopped) return false

  if (lease.userTurnKey) {
    return turn.userKey === lease.userTurnKey && output.finalMessage === true
  }
  if (now <= lease.expiresAt) return false

  if (reservation?.phase === 'submitted') {
    return turn.userKey === reservation.userTurnKey && output.finalMessage === true
  }
  if (reservation?.phase === 'submitting') {
    if (isProcessAlive(reservation.pid)) return false
    // A dead relay process cannot inject another prompt. If it died after the
    // send, wait until the browser is visibly final before releasing tools.
    return output.finalMessage === true
  }
  if (reservation?.phase === 'uncertain') {
    // The relay handler has ended and will never issue a retry. The write may
    // already have reached the browser, so require a visibly final tab.
    return output.finalMessage === true
  }
  // No relay reservation (or our own atomic `closing` claim) means the prompt
  // was never submitted. Once the lease expired, an idle tab is sufficient.
  return reservation === null || reservation.phase === 'closing'
}


export class OmnicastReturnMailbox {
  constructor({
    now = () => Date.now(),
    controlToken = '',
    stateFile = '',
    idleProof = async () => false,
    openProof = async () => true,
  } = {}) {
    this.now = now
    this.controlToken = String(controlToken)
    this.stateFile = String(stateFile)
    this.idleProof = idleProof
    this.openProof = openProof
    this.lease = null
    if (this.stateFile && existsSync(this.stateFile)) this.#loadRequired()
  }

  #control(value) {
    if (!this.controlToken || !safeEqual(value, this.controlToken)) {
      fail('PERMISSION_REQUIRED', 'the separate OmniCast control credential is required')
    }
  }

  #loadRequired() {
    const info = lstatSync(this.stateFile)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5_000_000) {
      throw new Error('OmniCast return state must be a bounded regular file')
    }
    const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    this.lease = validateLease(parsed)
    return this.lease
  }

  #sync() {
    if (this.stateFile && existsSync(this.stateFile)) this.#loadRequired()
    // A missing state file must not silently reopen a catalog while this
    // process still remembers an active lease.
    if (this.lease === null) return null
    const reservation = this.#readReservation(this.lease)
    if (reservation?.phase === 'submitted') {
      if (this.lease.userTurnKey && this.lease.userTurnKey !== reservation.userTurnKey) {
        fail('BUSY', 'the persisted lease and relay reservation name different user turns')
      }
      // The relay owns only its nonce-bound reservation file. Shiro remains
      // the sole writer of result state, eliminating a cross-process lost
      // update with connector text/bytes/hash. The next Shiro persist makes
      // this merged key durable in the main state as well.
      this.lease.userTurnKey = reservation.userTurnKey
    }
    return this.lease
  }

  #persist() {
    if (!this.stateFile || this.lease === null) return
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.lease)}\n`, { mode: 0o600 })
    renameSync(temporary, this.stateFile)
    chmodSync(this.stateFile, 0o600)
  }

  #reservationFile(nonce) {
    return `${this.stateFile}.relay-${nonce}.lock`
  }

  #closeReservationFile(nonce) {
    return `${this.stateFile}.close-${nonce}.lock`
  }

  #promptAdmissionFile() {
    return `${this.stateFile}.prompt-admission.lock`
  }

  #claimPromptAdmission() {
    if (!this.stateFile) return null
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 })
    const file = this.#promptAdmissionFile()
    const claim = {
      version: 1,
      phase: 'opening-lease',
      claimId: randomUUID(),
      pid: process.pid,
      startedAt: this.now(),
    }
    try {
      writeFileSync(file, `${JSON.stringify(claim)}\n`, { flag: 'wx', mode: 0o600 })
      chmodSync(file, 0o600)
      return claim
    } catch (error) {
      if (error?.code !== 'EEXIST') fail('BUSY', 'prompt admission lock could not be persisted')
    }
    try {
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) {
        throw new Error('prompt admission lock is not a small regular file')
      }
      const existing = JSON.parse(readFileSync(file, 'utf8'))
      if (Number.isInteger(existing.pid) && existing.pid > 0 && !processAlive(existing.pid)) {
        unlinkSync(file)
        return this.#claimPromptAdmission()
      }
    } catch (error) {
      fail('BUSY', `prompt admission lock is invalid: ${error.message}`)
    }
    fail('BUSY', 'a browser prompt is crossing its physical-send boundary')
  }

  #releasePromptAdmission(claim) {
    if (!this.stateFile || claim === null) return
    const file = this.#promptAdmissionFile()
    try {
      const current = JSON.parse(readFileSync(file, 'utf8'))
      if (current.claimId !== claim.claimId || current.pid !== claim.pid) {
        fail('BUSY', 'prompt admission ownership changed unexpectedly')
      }
      unlinkSync(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  #readReservation(lease) {
    if (!this.stateFile) return null
    const file = this.#reservationFile(lease.nonce)
    if (!existsSync(file)) return null
    try {
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) {
        throw new Error('relay reservation path is not a small regular file')
      }
      return validateReservation(JSON.parse(readFileSync(file, 'utf8')), lease)
    } catch (error) {
      fail('BUSY', `the OmniCast relay reservation is invalid: ${error.message}`)
    }
  }

  #claimCloseReservation(lease) {
    if (!this.stateFile) return null
    const file = this.#closeReservationFile(lease.nonce)
    const closing = {
      version: 1,
      nonce: lease.nonce,
      clientId: lease.clientId,
      phase: 'closing',
      pid: process.pid,
      startedAt: this.now(),
      updatedAt: this.now(),
      userTurnKey: '',
    }
    try {
      writeFileSync(file, `${JSON.stringify(closing)}\n`, { flag: 'wx', mode: 0o600 })
      chmodSync(file, 0o600)
      return { ...closing, claimedByClose: true }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        fail('BUSY', 'the OmniCast close reservation could not be persisted')
      }
    }
    let existing
    try {
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) {
        throw new Error('close reservation path is not a small regular file')
      }
      existing = validateReservation(JSON.parse(readFileSync(file, 'utf8')), lease)
    } catch (error) {
      fail('BUSY', `the OmniCast close reservation is invalid: ${error.message}`)
    }
    if (existing.phase === 'closing'
      && this.now() > lease.expiresAt
      && !processAlive(existing.pid)) {
      try { unlinkSync(file) } catch (error) {
        if (error?.code !== 'ENOENT') fail('BUSY', 'stale close reservation could not be cleared')
      }
      return this.#claimCloseReservation(lease)
    }
    fail('BUSY', 'another server-side close proof already owns this lease')
  }

  #releaseCloseReservation(reservation) {
    if (!this.stateFile || reservation?.claimedByClose !== true) return
    try { unlinkSync(this.#closeReservationFile(reservation.nonce)) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  #clear() {
    const nonce = this.lease?.nonce ?? ''
    this.lease = null
    if (this.stateFile) {
      try { unlinkSync(this.stateFile) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (nonce) {
        const reservationFile = this.#reservationFile(nonce)
        try { unlinkSync(reservationFile) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        const closeReservationFile = this.#closeReservationFile(nonce)
        try { unlinkSync(closeReservationFile) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    }
  }

  async open({ nonce, clientId, controlToken, ttlMs = 420_000, maxBytes = 1_000_000 }) {
    this.#control(controlToken)
    nonce = requireNonce(nonce)
    clientId = String(clientId ?? '').trim()
    if (!clientId) fail('INVALID_ARGUMENT', 'clientId is required')
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 900_000) {
      fail('INVALID_ARGUMENT', 'ttlMs must be an integer from 1000 to 900000')
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4_000_000) {
      fail('INVALID_ARGUMENT', 'maxBytes must be an integer from 1 to 4000000')
    }
    const admission = this.#claimPromptAdmission()
    try {
      if (this.#sync() !== null) {
        fail('BUSY', 'an OmniCast connector-return lease already exists; reconcile it after its exact browser turn is idle')
      }
      if (typeof this.openProof !== 'function' || !await this.openProof({ clientId })) {
        fail('BUSY', 'the selected connector browser client is not proved idle')
      }
      const openedAt = this.now()
      this.lease = {
        nonce,
        clientId,
        userTurnKey: '',
        openedAt,
        expiresAt: openedAt + ttlMs,
        maxBytes,
        text: null,
        bytes: 0,
        sha256: '',
        submittedAt: null,
      }
      this.#persist()
      return this.snapshot(false)
    } finally {
      this.#releasePromptAdmission(admission)
    }
  }

  restrictsConnector() {
    // Deliberately remains true after TTL expiry. The persisted lease is also
    // read by the browser relay, so restart never silently reopens prompt paths.
    return this.#sync() !== null
  }

  requireLease(nonce) {
    nonce = requireNonce(nonce)
    const lease = this.#sync()
    if (lease === null || lease.nonce !== nonce) {
      fail('NOT_FOUND', 'OmniCast connector-return nonce is not active')
    }
    return lease
  }

  snapshot(includeText = true) {
    const lease = this.#sync()
    if (lease === null) return { state: 'idle' }
    const expired = this.now() > lease.expiresAt && lease.text === null
    const state = lease.text !== null ? 'ready' : expired ? 'expired' : 'pending'
    return {
      state,
      nonce: lease.nonce,
      client_id: lease.clientId,
      user_turn_key: lease.userTurnKey || undefined,
      expires_at: new Date(lease.expiresAt).toISOString(),
      max_bytes: lease.maxBytes,
      bytes: lease.bytes,
      sha256: lease.sha256 || undefined,
      submitted_at: lease.submittedAt === null
        ? undefined
        : new Date(lease.submittedAt).toISOString(),
      ...(includeText && lease.text !== null ? { text: lease.text } : {}),
    }
  }

  submit({ nonce, text }) {
    const lease = this.requireLease(nonce)
    if (this.now() > lease.expiresAt) fail('TIMEOUT', 'OmniCast connector-return lease expired')
    if (lease.text !== null) fail('CONFLICT', 'OmniCast connector result was already submitted')
    if (typeof text !== 'string' || text.trim() === '') fail('INVALID_ARGUMENT', 'text is required')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > lease.maxBytes) {
      fail('INVALID_ARGUMENT', `OmniCast connector result is too large (${bytes} > ${lease.maxBytes} bytes)`)
    }
    lease.text = text
    lease.bytes = bytes
    lease.sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
    lease.submittedAt = this.now()
    this.#persist()
    return { accepted: true, nonce: lease.nonce, bytes, sha256: lease.sha256 }
  }

  status({ controlToken }) {
    this.#control(controlToken)
    return this.snapshot(false)
  }

  read({ nonce, controlToken }) {
    this.#control(controlToken)
    this.requireLease(nonce)
    return this.snapshot(true)
  }

  async wait({ nonce, controlToken, waitMs = 0 }) {
    const deadline = Date.now() + Math.max(0, Math.min(30_000, Number(waitMs) || 0))
    let snapshot = this.read({ nonce, controlToken })
    while (snapshot.state === 'pending' && Date.now() < deadline) {
      await delay(Math.min(100, Math.max(1, deadline - Date.now())))
      snapshot = this.read({ nonce, controlToken })
    }
    return snapshot
  }

  async close({ nonce, controlToken }) {
    this.#control(controlToken)
    const lease = this.requireLease(nonce)
    const closeReservation = this.#claimCloseReservation(lease)
    try {
      const relayReservation = this.#readReservation(lease)
      if (typeof this.idleProof !== 'function'
        || !await this.idleProof({ ...lease }, relayReservation)) {
        fail('BUSY', 'the exact OmniCast connector browser turn is not proved idle')
      }
      this.#clear()
      return { closed: true, nonce }
    } catch (error) {
      this.#releaseCloseReservation(closeReservation)
      throw error
    }
  }
}


const publicLeaseOutput = {
  state: z.string(), nonce: z.string().optional(), client_id: z.string().optional(),
  user_turn_key: z.string().optional(), expires_at: z.string().optional(),
  max_bytes: z.number().optional(), bytes: z.number().optional(),
  sha256: z.string().optional(), submitted_at: z.string().optional(),
}


export function omnicastReturnActionSpecs({ mailbox, clientKind }) {
  if (!(mailbox instanceof OmnicastReturnMailbox)) return []
  const actions = [
    {
      name: 'omnicast_return_open',
      spec: {
        family: 'connector-return', title: 'Open a least-privilege OmniCast result lease',
        description: 'Local control-plane action. Requires a credential distinct from the MCP bearer token, persists one nonce/client-bound result lease, and temporarily restricts inbound ChatGPT connector calls to omnicast_submit_story only.',
        input: {
          nonce: z.string().regex(NONCE), client_id: z.string().min(1),
          control_token: z.string().min(1),
          ttl_ms: z.number().int().min(1_000).max(900_000).optional(),
          max_bytes: z.number().int().min(1).max(4_000_000).optional(),
        },
        output: publicLeaseOutput, annotations: WRITE,
      },
      handler: args => {
        requireInternal(clientKind)
        return mailbox.open({
          nonce: args.nonce, clientId: args.client_id, controlToken: args.control_token,
          ttlMs: args.ttl_ms, maxBytes: args.max_bytes,
        })
      },
    },
    {
      name: 'omnicast_submit_story',
      spec: {
        family: 'connector-return', title: 'Return generated prose to OmniCast',
        description: 'Submit the exact completed answer for the active nonce. During a lease this is the only Shiro action registered for the inbound ChatGPT connector. Do not put the prose in the assistant message.',
        input: { nonce: z.string().regex(NONCE), text: z.string().min(1) },
        output: { accepted: z.boolean(), nonce: z.string(), bytes: z.number(), sha256: z.string() },
        annotations: WRITE,
      },
      handler: args => {
        requireConnector(clientKind)
        return mailbox.submit(args)
      },
    },
    {
      name: 'omnicast_return_status',
      spec: {
        family: 'connector-return', title: 'Inspect the active OmniCast result lease',
        description: 'Local control-plane recovery action. Requires the separate control credential and returns no generated text.',
        input: { control_token: z.string().min(1) }, output: publicLeaseOutput,
        annotations: READ,
      },
      handler: args => {
        requireInternal(clientKind)
        return mailbox.status({ controlToken: args.control_token })
      },
    },
    {
      name: 'omnicast_return_read',
      spec: {
        family: 'connector-return', title: 'Read an OmniCast connector result',
        description: 'Local control-plane action. Long-polls one nonce-bound in-memory/persisted result; never reads browser DOM.',
        input: {
          nonce: z.string().regex(NONCE), control_token: z.string().min(1),
          wait_ms: z.number().int().min(0).max(30_000).optional(),
        },
        output: { ...publicLeaseOutput, text: z.string().optional() }, annotations: READ,
      },
      handler: args => {
        requireInternal(clientKind)
        return mailbox.wait({
          nonce: args.nonce, controlToken: args.control_token, waitMs: args.wait_ms,
        })
      },
    },
    {
      name: 'omnicast_return_close',
      spec: {
        family: 'connector-return', title: 'Atomically close an idle OmniCast result lease',
        description: 'Local control-plane action. The server itself proves the bound browser client/turn idle while the relay reservation is still active, then clears persisted state and reopens the normal catalog.',
        input: { nonce: z.string().regex(NONCE), control_token: z.string().min(1) },
        output: { closed: z.boolean(), nonce: z.string() }, annotations: WRITE,
      },
      handler: args => {
        requireInternal(clientKind)
        return mailbox.close({ nonce: args.nonce, controlToken: args.control_token })
      },
    },
  ]
  return clientKind === CONNECTOR
    ? actions.filter(action => action.name === 'omnicast_submit_story')
    : actions.filter(action => action.name !== 'omnicast_submit_story')
}


export function registerOmnicastReturnOnly(server, { mailbox, clientKind, metrics }) {
  const row = omnicastReturnActionSpecs({ mailbox, clientKind })
    .find(item => item.name === 'omnicast_submit_story')
  if (row === undefined) throw new Error('OmniCast return mailbox is unavailable')
  server.registerTool(row.name, {
    title: row.spec.title, description: row.spec.description,
    inputSchema: row.spec.input, outputSchema: resultSchema(row.spec.output),
    annotations: row.spec.annotations,
  }, async args => {
    const started = Date.now()
    try {
      const value = await row.handler(args ?? {})
      metrics?.record(row.name, Date.now() - started, true)
      return toolResult(value)
    } catch (error) {
      metrics?.record(row.name, Date.now() - started, false, error?.code ?? 'INTERNAL')
      return errorResult(error)
    }
  })
}
