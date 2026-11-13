import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKaraokeDatabase } from '../database'
import { ManagementRemoteJournalInbox } from '../src/management-remote-journal'
import { ManagementRemoteOutbox } from '../src/management-remote-outbox'
import { operationalCommandFingerprint } from '../src/operational-command-fingerprint'
import { ManagementRemoteReconciliationService } from '../src/remote-reconciliation-service'
import type { OperationalMessage } from '../src/operational-protocol-contracts'

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/operational-v1/valid-messages.json'), 'utf8')) as OperationalMessage[]
const playerDeviceId = 'device-player-01', controllerId = 'controller-local-01'
function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'kq-g4-reconcile-')) }
function response(type: 'snapshot' | 'journal-page', correlationId: string, hwm = 0): OperationalMessage {
  const item = structuredClone(fixture.find(value => value.kind === 'response' && value.body.type === type)!) as any
  item.deviceId = playerDeviceId; item.controllerId = controllerId; item.body.correlationId = correlationId
  if (type === 'snapshot') { item.body.payload.highWatermark = hwm; item.body.payload.compactedThrough = 0 }
  else {
    const events = item.body.payload.events.slice(0, hwm)
    item.body.payload.events = events; item.body.payload.highWatermark = hwm
    item.body.payload.throughSequence = events.at(-1)?.eventSequence ?? 0; item.body.payload.hasMore = false
  }
  return item
}

test('reconciliation commits contiguous SQLite inbox before snapshot and never emits business ACK', async () => {
  const directory = temp(), db = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(db, { controllerId })
  const outbox = new ManagementRemoteOutbox(db, { deviceId: controllerId, controllerId })
  let snapshotCalls = 0, pageCalls = 0, ackCalls = 0
  const reconciler = new ManagementRemoteReconciliationService(inbox, outbox, { playerDeviceId, controllerId }, {
    async query(request) {
      const type = request.body.type
      if (type === 'snapshot') return response('snapshot', request.body.queryId, snapshotCalls++ === 0 ? 2 : 2)
      if (type === 'journal-page') { pageCalls++; return response('journal-page', request.body.queryId, 2) }
      throw new Error('unexpected query')
    }
  })
  try {
    const result = await reconciler.reconcile(new AbortController().signal)
    assert.deepEqual(result, { state: 'synchronized', throughSequence: 2, highWatermark: 2, pending: 0 })
    assert.equal(inbox.cursor(playerDeviceId)?.recoveryRequired, false)
    assert.equal(inbox.readEvents(playerDeviceId, 0, 32).length, 2)
    assert.equal(snapshotCalls, 2); assert.equal(pageCalls, 1); assert.equal(ackCalls, 0)
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('a compacted prefix without a local cursor stays recovery_required and preserves evidence', async () => {
  const directory = temp(), db = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(db, { controllerId })
  const outbox = new ManagementRemoteOutbox(db, { deviceId: controllerId, controllerId })
  const reconciler = new ManagementRemoteReconciliationService(inbox, outbox, { playerDeviceId, controllerId }, {
    async query(request) { return response('snapshot', request.body.queryId, 4) as any }
  })
  try {
    const snapshot = response('snapshot', 'fixture-correlation', 4) as any
    snapshot.body.payload.compactedThrough = 2
    const blocked = new ManagementRemoteReconciliationService(inbox, outbox, { playerDeviceId, controllerId }, {
      async query(request) { const value = structuredClone(snapshot); value.body.correlationId = request.body.queryId; return value }
    })
    const result = await blocked.reconcile(new AbortController().signal)
    assert.deepEqual(result, { state: 'recovery_required', reason: 'MANAGEMENT_REMOTE_JOURNAL_REPLAY_COMPACTED', throughSequence: null })
    assert.equal(inbox.cursor(playerDeviceId), null)
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Player recovery-required during snapshot handshake remains blocked and is never called synchronized', async () => {
  const directory = temp(), db = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(db, { controllerId })
  const outbox = new ManagementRemoteOutbox(db, { deviceId: controllerId, controllerId })
  const reconciler = new ManagementRemoteReconciliationService(inbox, outbox, { playerDeviceId, controllerId }, {
    async query(request) {
      const item = structuredClone(fixture.find(value => value.kind === 'error')!) as any
      item.deviceId = playerDeviceId; item.controllerId = controllerId
      item.body = { correlationId: request.body.queryId, code: 'STORAGE_UNAVAILABLE', state: 'recovery-required' }
      return item
    }
  })
  try {
    const result = await reconciler.reconcile(new AbortController().signal)
    assert.deepEqual(result, { state: 'recovery_required', reason: 'G4_PLAYER_OPERATIONAL_RECOVERY_REQUIRED', throughSequence: null })
    assert.equal(inbox.cursor(playerDeviceId), null, 'the failed Player store does not advance the Management inbox')
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('operation-status not-found cannot resolve an outbox intent that was already transmitted', async () => {
  const directory = temp(), db = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(db, { controllerId })
  const outbox = new ManagementRemoteOutbox(db, { deviceId: controllerId, controllerId })
  const command = structuredClone(fixture.find(value => value.kind === 'command')!) as Extract<OperationalMessage, { kind: 'command' }>
  const operationId = command.body.operationId
  command.deviceId = playerDeviceId; command.controllerId = controllerId
  outbox.prepare(playerDeviceId, command)
  outbox.transmit(playerDeviceId, operationId, { send() { return true } })
  const queried: string[] = []
  const reconciler = new ManagementRemoteReconciliationService(inbox, outbox, { playerDeviceId, controllerId }, {
    async query(request) {
      if (request.body.type === 'snapshot') return response('snapshot', request.body.queryId, 0)
      if (request.body.type === 'operation-status') {
        queried.push(String(request.body.payload.operationId))
        const status = structuredClone(fixture.find(value => value.kind === 'response' && value.body.type === 'operation-status')!) as any
        status.deviceId = playerDeviceId; status.controllerId = controllerId
        status.body.correlationId = request.body.queryId
        status.body.payload = { operationId, fingerprint: null, status: 'not-found', result: null, eventSequence: null }
        return status
      }
      throw new Error('unexpected query')
    }
  })
  try {
    const result = await reconciler.reconcile(new AbortController().signal)
    assert.equal(result.state, 'synchronized')
    assert.deepEqual(queried, [operationId])
    const retained = outbox.get(playerDeviceId, operationId)
    assert.ok(retained)
    assert.equal(retained.status, 'unknown',
      'missing Player evidence cannot prove that a transmitted physical effect never happened')
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('the durable Management inbox retains multiple epoch snapshots at one journal watermark', () => {
  const directory = temp(), db = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(db, { controllerId })
  try {
    const beforeRestart = response('snapshot', 'snapshot-before-restart', 0)
    inbox.persistSnapshot(playerDeviceId, beforeRestart)
    const afterRestart = structuredClone(beforeRestart) as Extract<OperationalMessage, { kind: 'response' }>
    afterRestart.body.payload.playerEpoch = 'player-9'
    afterRestart.body.correlationId = 'snapshot-after-restart'
    inbox.persistSnapshot(playerDeviceId, afterRestart)
    assert.equal((inbox.latestSnapshot(playerDeviceId) as any).body.payload.playerEpoch, 'player-9')
    assert.throws(() => {
      const conflicting = structuredClone(afterRestart)
      conflicting.body.payload.stateRevision = Number(conflicting.body.payload.stateRevision) + 1
      conflicting.body.correlationId = 'snapshot-conflict-same-epoch'
      inbox.persistSnapshot(playerDeviceId, conflicting)
    }, /MANAGEMENT_REMOTE_JOURNAL_SNAPSHOT_CONFLICT/)
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('stale and mismatched response correlations are rejected', async () => {
  const directory = temp(), db = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(db, { controllerId })
  const outbox = new ManagementRemoteOutbox(db, { deviceId: controllerId, controllerId })
  const reconciler = new ManagementRemoteReconciliationService(inbox, outbox, { playerDeviceId, controllerId }, {
    async query(request) { return response('snapshot', 'old-query-id', 0) }
  })
  try { await assert.rejects(reconciler.reconcile(new AbortController().signal), /CORRELATION_INVALID/) }
  finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('cancellation immediately before fresh snapshot persistence leaves the SQLite inbox unchanged', async () => {
  const directory = temp(), db = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(db, { controllerId })
  const outbox = new ManagementRemoteOutbox(db, { deviceId: controllerId, controllerId })
  const abort = new AbortController(); let snapshotCalls = 0
  const reconciler = new ManagementRemoteReconciliationService(inbox, outbox, { playerDeviceId, controllerId }, {
    async query(request) {
      const result = response('snapshot', request.body.queryId, 0)
      if (++snapshotCalls === 2) abort.abort()
      return result
    }
  })
  try {
    await assert.rejects(reconciler.reconcile(abort.signal), /G4_RECOVERY_CANCELLED/)
    assert.equal(inbox.latestSnapshot(playerDeviceId), null)
    assert.equal(inbox.cursor(playerDeviceId), null)
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('cancellation after synchronous snapshot admission preserves evidence but cannot report synchronized', async () => {
  const directory = temp(), db = createKaraokeDatabase(directory)
  const baseInbox = new ManagementRemoteJournalInbox(db, { controllerId })
  const outbox = new ManagementRemoteOutbox(db, { deviceId: controllerId, controllerId })
  const abort = new AbortController()
  const inbox = {
    cursor: baseInbox.cursor.bind(baseInbox),
    readEvents: baseInbox.readEvents.bind(baseInbox),
    persistPage: baseInbox.persistPage.bind(baseInbox),
    persistSnapshot(deviceId: string, snapshot: OperationalMessage) {
      baseInbox.persistSnapshot(deviceId, snapshot)
      abort.abort()
    }
  } as unknown as ManagementRemoteJournalInbox
  const reconciler = new ManagementRemoteReconciliationService(inbox, outbox, { playerDeviceId, controllerId }, {
    async query(request) { return response('snapshot', request.body.queryId, 0) }
  })
  try {
    await assert.rejects(reconciler.reconcile(abort.signal), /G4_RECOVERY_CANCELLED/)
    assert.ok(baseInbox.latestSnapshot(playerDeviceId), 'committed evidence remains available for the next connection')
    assert.equal(baseInbox.cursor(playerDeviceId)?.throughSequence, 0,
      'snapshot records its metadata but does not advance the received or applied event cursor')
    assert.equal(baseInbox.readEvents(playerDeviceId, 0, 32).length, 0)
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('cancellation after an operation-status response does not accept its late durable result', async () => {
  const directory = temp(), db = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(db, { controllerId })
  const outbox = new ManagementRemoteOutbox(db, { deviceId: controllerId, controllerId })
  const command = structuredClone(fixture.find(value => value.kind === 'command')!) as Extract<OperationalMessage, { kind: 'command' }>
  const operationId = command.body.operationId
  command.deviceId = playerDeviceId; command.controllerId = controllerId
  outbox.prepare(playerDeviceId, command)
  outbox.transmit(playerDeviceId, operationId, { send() { return true } })
  const abort = new AbortController()
  const reconciler = new ManagementRemoteReconciliationService(inbox, outbox, { playerDeviceId, controllerId }, {
    async query(request) {
      if (request.body.type === 'snapshot') return response('snapshot', request.body.queryId, 0)
      const status = structuredClone(fixture.find(value => value.kind === 'response' && value.body.type === 'operation-status')!) as any
      status.deviceId = playerDeviceId; status.controllerId = controllerId
      status.body.correlationId = request.body.queryId
      status.body.payload = { operationId, fingerprint: operationalCommandFingerprint(command.body), status: 'completed',
        result: { state: 'synthetic' }, eventSequence: 0 }
      abort.abort()
      return status
    }
  })
  try {
    await assert.rejects(reconciler.reconcile(abort.signal), /G4_RECOVERY_CANCELLED/)
    assert.equal(outbox.get(playerDeviceId, operationId)?.status, 'unknown')
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})
