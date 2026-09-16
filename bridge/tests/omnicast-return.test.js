import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { configureMcp } from '../src/index.js'
import { OmnicastReturnMailbox, omnicastLeaseIsIdle } from '../src/omnicast-return.js'


const CONTROL = 'control-secret-not-shared-with-the-tunnel'
const CLIENT_ID = 'connector-tab-1'


function mailbox(options = {}) {
  return new OmnicastReturnMailbox({
    controlToken: CONTROL,
    idleProof: async lease => lease.clientId === CLIENT_ID,
    ...options,
  })
}


async function catalogFor(runtime, run) {
  const server = new McpServer({ name: 'omnicast-return-test', version: '0.0.0' })
  configureMcp(server, {}, { workspaceRoot: process.cwd(), waitMs: 25_000 }, null, runtime)
  const client = new Client({ name: 'omnicast-return-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}


test('mailbox requires a distinct control credential and stays locked until server-proved idle', async () => {
  let now = 1_000
  const box = mailbox({ now: () => now })
  const nonce = 'a'.repeat(32)

  await assert.rejects(box.open({
    nonce, clientId: CLIENT_ID, controlToken: 'bridge bearer token',
  }), /control credential/i)
  const opened = await box.open({
    nonce, clientId: CLIENT_ID, controlToken: CONTROL,
    ttlMs: 5_000, maxBytes: 32,
  })
  assert.equal(opened.state, 'pending')
  assert.equal(box.restrictsConnector(), true)
  assert.throws(() => box.submit({ nonce: 'b'.repeat(32), text: 'wrong' }), /nonce/i)
  assert.throws(() => box.submit({ nonce, text: 'x'.repeat(40) }), /too large/i)

  const submitted = box.submit({ nonce, text: 'story' })
  assert.equal(submitted.bytes, 5)
  assert.equal(box.read({ nonce, controlToken: CONTROL }).text, 'story')
  assert.equal(box.restrictsConnector(), true, 'ready data does not reopen broad tools')

  assert.equal((await box.close({ nonce, controlToken: CONTROL })).closed, true)
  assert.equal(box.restrictsConnector(), false)

  await box.open({
    nonce: 'c'.repeat(32), clientId: CLIENT_ID, controlToken: CONTROL,
    ttlMs: 1_000, maxBytes: 32,
  })
  now += 1_001
  assert.equal(box.read({ nonce: 'c'.repeat(32), controlToken: CONTROL }).state, 'expired')
  assert.equal(box.restrictsConnector(), true, 'expiry fails closed until idle reconciliation')
})


test('idle proof failure cannot close or reopen the broad connector catalog', async () => {
  const box = mailbox({ idleProof: async () => false })
  const nonce = 'b'.repeat(32)
  await box.open({ nonce, clientId: CLIENT_ID, controlToken: CONTROL })

  await assert.rejects(
    box.close({ nonce, controlToken: CONTROL }),
    /not proved idle/i,
  )
  assert.equal(box.restrictsConnector(), true)
})


test('an active return lease survives a bridge-style mailbox restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shiro-omnicast-return-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFile = join(directory, 'return.json')
  const nonce = 'c'.repeat(32)
  const first = mailbox({ stateFile })
  await first.open({ nonce, clientId: CLIENT_ID, controlToken: CONTROL })

  const restored = mailbox({ stateFile })
  assert.equal(restored.restrictsConnector(), true)
  restored.submit({ nonce, text: 'after restart' })
  assert.equal(restored.read({ nonce, controlToken: CONTROL }).text, 'after restart')
})


test('mailbox open is mutually exclusive with a physical browser prompt send', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shiro-omnicast-open-admission-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFile = join(directory, 'return.json')
  const admissionFile = `${stateFile}.prompt-admission.lock`
  await writeFile(admissionFile, `${JSON.stringify({
    version: 1,
    phase: 'physical-prompt-send',
    claimId: 'relay-claim',
    pid: process.pid,
    startedAt: Date.now(),
  })}\n`, { mode: 0o600 })
  const box = mailbox({ stateFile })

  await assert.rejects(box.open({
    nonce: '5'.repeat(32), clientId: CLIENT_ID, controlToken: CONTROL,
  }), /physical-send boundary/i)
  assert.equal(existsSync(stateFile), false)

  await unlink(admissionFile)
  assert.equal((await box.open({
    nonce: '5'.repeat(32), clientId: CLIENT_ID, controlToken: CONTROL,
  })).state, 'pending')
})


test('safe close removes the nonce-bound relay reservation after persisted state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shiro-omnicast-close-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFile = join(directory, 'return.json')
  const nonce = '9'.repeat(32)
  const reservationFile = `${stateFile}.relay-${nonce}.lock`
  const box = mailbox({ stateFile })
  await box.open({ nonce, clientId: CLIENT_ID, controlToken: CONTROL })
  await writeFile(reservationFile, `${JSON.stringify({
    version: 1,
    nonce,
    clientId: CLIENT_ID,
    phase: 'submitted',
    pid: process.pid,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    userTurnKey: 'user-1',
  })}\n`, { mode: 0o600 })

  await box.close({ nonce, controlToken: CONTROL })

  assert.equal(existsSync(stateFile), false)
  assert.equal(existsSync(reservationFile), false)
  assert.equal(existsSync(`${stateFile}.close-${nonce}.lock`), false)
})


test('Shiro merges the relay-owned turn receipt without risking connector result overwrite', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shiro-omnicast-merge-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFile = join(directory, 'return.json')
  const nonce = '6'.repeat(32)
  const box = mailbox({ stateFile })
  await box.open({ nonce, clientId: CLIENT_ID, controlToken: CONTROL })
  await writeFile(`${stateFile}.relay-${nonce}.lock`, `${JSON.stringify({
    version: 1,
    nonce,
    clientId: CLIENT_ID,
    phase: 'submitted',
    pid: process.pid,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    userTurnKey: 'user-turn-from-relay',
  })}\n`, { mode: 0o600 })

  assert.equal(box.status({ controlToken: CONTROL }).user_turn_key, 'user-turn-from-relay')
  box.submit({ nonce, text: 'connector-owned prose' })

  const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(persisted.userTurnKey, 'user-turn-from-relay')
  assert.equal(persisted.text, 'connector-owned prose')
})


test('close claims the relay reservation atomically and releases that claim on failed proof', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shiro-omnicast-close-race-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateFile = join(directory, 'return.json')
  const nonce = '8'.repeat(32)
  let releaseProof
  const proofStarted = new Promise(resolve => { releaseProof = resolve })
  let finishProof
  const proofFinished = new Promise(resolve => { finishProof = resolve })
  const box = mailbox({
    stateFile,
    idleProof: async (_lease, reservation) => {
      assert.equal(reservation.phase, 'submitted')
      assert.equal(reservation.userTurnKey, 'user-close-race')
      releaseProof()
      await proofFinished
      return false
    },
  })
  await box.open({ nonce, clientId: CLIENT_ID, controlToken: CONTROL })
  await writeFile(`${stateFile}.relay-${nonce}.lock`, `${JSON.stringify({
    version: 1,
    nonce,
    clientId: CLIENT_ID,
    phase: 'submitted',
    pid: process.pid,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    userTurnKey: 'user-close-race',
  })}\n`, { mode: 0o600 })

  const closing = box.close({ nonce, controlToken: CONTROL })
  await proofStarted
  const reservationFile = `${stateFile}.close-${nonce}.lock`
  const reservation = JSON.parse(await (await import('node:fs/promises')).readFile(reservationFile, 'utf8'))
  assert.equal(reservation.phase, 'closing')
  await assert.rejects(
    box.close({ nonce, controlToken: CONTROL }),
    /another server-side close proof/i,
  )
  finishProof()
  await assert.rejects(closing, /not proved idle/i)
  assert.equal(existsSync(reservationFile), false)
  assert.equal(box.restrictsConnector(), true)
})


test('idle proof is exact for submitted turns and safely recovers expired unsubmitted leases', () => {
  const lease = {
    nonce: '7'.repeat(32), clientId: CLIENT_ID, userTurnKey: '', expiresAt: 2_000,
  }
  const idleClient = {
    id: CLIENT_ID,
    activeRequest: null,
    tabObservation: {
      turn: { userKey: 'user-1' },
      generation: { state: 'stopped' },
      output: { finalMessage: true },
    },
  }
  assert.equal(omnicastLeaseIsIdle({ lease, client: idleClient, now: 1_999 }), false)
  assert.equal(omnicastLeaseIsIdle({ lease, client: idleClient, now: 2_001 }), true)
  assert.equal(omnicastLeaseIsIdle({
    lease,
    client: idleClient,
    now: 2_001,
    reservation: { phase: 'submitting', pid: 123 },
    isProcessAlive: () => true,
  }), false)
  assert.equal(omnicastLeaseIsIdle({
    lease,
    client: idleClient,
    now: 2_001,
    reservation: { phase: 'uncertain', pid: process.pid },
    isProcessAlive: () => true,
  }), true)
  assert.equal(omnicastLeaseIsIdle({
    lease,
    client: idleClient,
    now: 2_001,
    reservation: { phase: 'submitted', userTurnKey: 'user-1' },
  }), true)
  assert.equal(omnicastLeaseIsIdle({
    lease: { ...lease, userTurnKey: 'different-turn' },
    client: idleClient,
    now: 2_001,
  }), false)
})


test('connector sees only nonce-bound submit while a mailbox lease is active', async () => {
  const box = mailbox()
  const nonce = 'd'.repeat(32)
  await box.open({ nonce, clientId: CLIENT_ID, controlToken: CONTROL, ttlMs: 30_000, maxBytes: 1_000 })

  await catalogFor({
    requestClientKind: 'connector',
    requestDefaultExecutionMode: 'relay',
    omnicastReturns: box,
  }, async client => {
    const catalog = await client.listTools()
    assert.deepEqual(catalog.tools.map(tool => tool.name), ['omnicast_submit_story'])
    const result = await client.callTool({
      name: 'omnicast_submit_story',
      arguments: { nonce, text: 'connector payload' },
    })
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent.accepted, true)
    assert.equal(box.read({ nonce, controlToken: CONTROL }).text, 'connector payload')
  })
})


test('spoofing the local client header is useless without the control credential', async () => {
  const box = mailbox()
  await catalogFor({
    requestClientKind: 'shiro-python',
    requestDefaultExecutionMode: 'autonomous',
    omnicastReturns: box,
  }, async client => {
    const opened = await client.callTool({
      name: 'omnicast_return_open',
      arguments: {
        nonce: 'e'.repeat(32), client_id: CLIENT_ID,
        control_token: 'the ordinary bridge bearer token',
      },
    })
    assert.equal(opened.isError, true)
    assert.equal(box.restrictsConnector(), false)
  })
})


test('a spoofed local marker still receives only submit while a lease is active', async () => {
  const box = mailbox()
  const nonce = '1'.repeat(32)
  await box.open({ nonce, clientId: CLIENT_ID, controlToken: CONTROL })

  await catalogFor({
    requestClientKind: 'shiro-python',
    requestControlAuthorized: false,
    requestDefaultExecutionMode: 'autonomous',
    omnicastReturns: box,
  }, async client => {
    const catalog = await client.listTools()
    assert.deepEqual(catalog.tools.map(tool => tool.name), ['omnicast_submit_story'])
  })
})


test('local open -> connector submit -> local read and atomic idle-close round-trips over MCP', async () => {
  const box = mailbox()
  const nonce = 'f'.repeat(32)

  await catalogFor({
    requestClientKind: 'shiro-python', requestDefaultExecutionMode: 'autonomous',
    requestControlAuthorized: true, omnicastReturns: box,
  }, async client => {
    const opened = await client.callTool({
      name: 'omnicast_return_open',
      arguments: {
        nonce, client_id: CLIENT_ID, control_token: CONTROL,
        ttl_ms: 30_000, max_bytes: 1_000,
      },
    })
    assert.equal(opened.isError, undefined)
  })

  await catalogFor({
    requestClientKind: 'connector', requestDefaultExecutionMode: 'relay',
    omnicastReturns: box,
  }, async client => {
    const submitted = await client.callTool({
      name: 'omnicast_submit_story', arguments: { nonce, text: 'full story' },
    })
    assert.equal(submitted.isError, undefined)
  })

  await catalogFor({
    requestClientKind: 'shiro-python', requestDefaultExecutionMode: 'autonomous',
    requestControlAuthorized: true, omnicastReturns: box,
  }, async client => {
    const read = await client.callTool({
      name: 'omnicast_return_read',
      arguments: { nonce, control_token: CONTROL, wait_ms: 0 },
    })
    assert.equal(read.structuredContent.text, 'full story')
    const closed = await client.callTool({
      name: 'omnicast_return_close',
      arguments: { nonce, control_token: CONTROL },
    })
    assert.equal(closed.isError, undefined)
    assert.equal(closed.structuredContent.closed, true)
  })

  assert.equal(box.restrictsConnector(), false)
})
