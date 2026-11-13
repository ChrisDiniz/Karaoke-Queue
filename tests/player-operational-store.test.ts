import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  PlayerOperationalStore,
  PlayerOperationalStoreError,
  PLAYER_OPERATIONAL_DATABASE_FILENAME,
  readPlayerOperationalRecoveryMarker,
  restorePlayerOperationalBackup,
  verifyPlayerOperationalBackup
} from '../src/player-operational-store'
import type { OperationalEventDraft, PlayerOperationalStoreOptions } from '../src/player-operational-store'
import type { ActivateTurnPayload, JournalEvent, OperationalMessage } from '../src/operational-protocol-contracts'

const validMessages = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/operational-v1/valid-messages.json'), 'utf8')) as OperationalMessage[]
const activationFixture = validMessages.find((message): message is Extract<OperationalMessage, { kind: 'command' }> =>
  message.kind === 'command' && message.body.type === 'activate-turn')!
const controllerId = activationFixture.controllerId
const deviceId = activationFixture.deviceId
const journalId = 'journal-device-01'

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function commandFor(operationId: string, turnSuffix = operationId): OperationalMessage {
  const command = structuredClone(activationFixture)
  command.messageId = 'retry-' + operationId
  command.body.operationId = operationId
  command.body.target.turnId = 'LOG-' + turnSuffix + '-AB12'
  if (command.body.type === 'activate-turn') {
    const payload = command.body.payload as ActivateTurnPayload
    payload.tracks = payload.tracks.map(track => ({
      ...track, occurrenceId: 'occ-' + operationId + '-' + track.trackIndex
    }))
  }
  return command
}

function operationResultEvent(operationId: string, status: 'completed' | 'rejected' | 'unknown', command: OperationalMessage): OperationalEventDraft {
  assert.equal(command.kind, 'command')
  const target = command.body.target
  return {
    schemaVersion: 1,
    causationOperationId: operationId,
    sessionId: target.sessionId,
    turnId: target.turnId,
    stateRevision: target.stateRevision,
    origin: 'remote',
    type: 'operation-result',
    payload: { operationId, status }
  }
}

function options(userDataDirectory: string, extra: Partial<PlayerOperationalStoreOptions> = {}): PlayerOperationalStoreOptions {
  return { userDataDirectory, journalId, deviceId, ...extra }
}

/** Recreates the schema-1 checkpoint key so the real in-place v1→v2 migration is exercised. */
function downgradeOperationalStoreToSchema1(userDataDirectory: string): void {
  const database = new DatabaseSync(path.join(userDataDirectory, PLAYER_OPERATIONAL_DATABASE_FILENAME))
  try {
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE; ALTER TABLE checkpoints RENAME TO checkpoints_v2_test;')
    database.exec(`CREATE TABLE checkpoints (
      journal_id TEXT NOT NULL,
      checkpoint_sequence INTEGER NOT NULL CHECK (checkpoint_sequence BETWEEN 0 AND 9007199254740991),
      checkpoint_json TEXT NOT NULL,
      checkpoint_fingerprint TEXT NOT NULL CHECK (length(checkpoint_fingerprint) = 64),
      PRIMARY KEY (journal_id, checkpoint_sequence)
    ) STRICT`)
    database.exec(`INSERT INTO checkpoints(journal_id,checkpoint_sequence,checkpoint_json,checkpoint_fingerprint)
      SELECT journal_id,checkpoint_sequence,checkpoint_json,checkpoint_fingerprint FROM checkpoints_v2_test;
      DROP TABLE checkpoints_v2_test;
      ALTER TABLE journal_meta RENAME TO journal_meta_v2_test;`)
    database.exec(`CREATE TABLE journal_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), journal_id TEXT NOT NULL, device_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      next_sequence INTEGER NOT NULL CHECK (next_sequence BETWEEN 1 AND 9007199254740991),
      high_watermark INTEGER NOT NULL CHECK (high_watermark BETWEEN 0 AND 9007199254740991),
      compacted_through INTEGER NOT NULL CHECK (compacted_through BETWEEN 0 AND high_watermark),
      logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0), record_count INTEGER NOT NULL CHECK (record_count >= 0),
      reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0), reserved_records INTEGER NOT NULL CHECK (reserved_records >= 0),
      recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)), recovery_code TEXT
    ) STRICT`)
    database.exec(`INSERT INTO journal_meta SELECT singleton,journal_id,device_id,1,next_sequence,high_watermark,
      compacted_through,logical_bytes,record_count,reserved_bytes,reserved_records,recovery_required,recovery_code
      FROM journal_meta_v2_test; DROP TABLE journal_meta_v2_test; PRAGMA user_version = 1; COMMIT;`)
    database.exec('PRAGMA foreign_keys = ON')
  } finally { database.close() }
}

function expectStoreError(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof PlayerOperationalStoreError && error.code === code)
}

function spawnWorker(mode: string, userData: string, commandPath = ''): ChildProcess {
  return spawn(process.execPath, [path.join(process.cwd(), 'tests/player-operational-store-worker.cjs'),
    mode, userData, commandPath, journalId, deviceId], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
}

function waitForMessage(child: ChildProcess, expectedType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('message', (message: unknown) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === expectedType) resolve()
      else reject(new Error('worker sent an invalid ' + expectedType + ' barrier'))
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => reject(new Error('worker exited before ' + expectedType + ': ' + String(code) + '/' + String(signal))))
  })
}

function waitForReady(child: ChildProcess): Promise<void> { return waitForMessage(child, 'ready') }

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

function killAbruptly(child: ChildProcess): void {
  assert.equal(child.kill('SIGKILL'), true, 'the operating system accepted the worker termination request')
}

function assertAbruptExit(result: { code: number | null; signal: NodeJS.Signals | null }): void {
  if (process.platform === 'win32') {
    const windowsTermination = result.signal === 'SIGKILL' && result.code === null ||
      result.signal === null && typeof result.code === 'number' && result.code !== 0
    assert.ok(windowsTermination, 'Windows Node may report forced termination as SIGKILL or as a non-zero exit code')
  } else {
    assert.deepEqual(result, { code: null, signal: 'SIGKILL' })
  }
}

test('SQLite store accepts, deduplicates by operation fingerprint, finalizes, pages, checkpoints, and survives restart', () => {
  const userData = temporaryDirectory('kq-operational-store-basic-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true }))
  try {
    const command = commandFor('op-basic')
    const accepted = store.acceptOperation({ controllerId, command })
    assert.equal(accepted.status, 'accepted')
    assert.equal(accepted.duplicate, false)
    const beforeDuplicate = store.getMetadata()
    const retry = structuredClone(command) as Extract<OperationalMessage, { kind: 'command' }>
    retry.messageId = 'different-message-id'
    assert.deepEqual(store.acceptOperation({ controllerId, command: retry }), { ...accepted, duplicate: true })
    assert.equal(store.getMetadata().highWatermark, beforeDuplicate.highWatermark)

    const changed = structuredClone(command) as Extract<OperationalMessage, { kind: 'command' }>
    if (changed.body.type === 'activate-turn') (changed.body.payload as ActivateTurnPayload).singerName = 'Outro nome'
    expectStoreError('OPERATION_ID_CONFLICT', () => store.acceptOperation({ controllerId, command: changed }))

    const finalEvent = operationResultEvent('op-basic', 'completed', command)
    const completed = store.finishOperation({ controllerId, operationId: 'op-basic', status: 'completed', events: [finalEvent] })
    assert.equal(completed.status, 'completed')
    assert.equal(store.getOperationStatus({ controllerId, operationId: 'op-basic' })?.status, 'completed')
    assert.equal(store.getOperationStatus({ controllerId, operationId: 'missing-op' }), null)
    const page = store.readPage({ controllerId, correlationId: 'query-page', afterSequence: 0, limit: 32 })
    assert.deepEqual(page.events.map(event => event.eventSequence), [1, 2])
    assert.equal(page.throughSequence, 2)
    assert.equal(page.highWatermark, 2)
    assert.equal(page.hasMore, false)

    const snapshot: OperationalMessage = {
      protocolVersion: 1, schemaVersion: 1, kind: 'response', messageId: 'snapshot-1', deviceId, controllerId,
      body: { correlationId: 'snapshot-query', type: 'snapshot', payload: {
        journalId, deviceId, playerEpoch: 'player-8', hostEpoch: 'host-1', controlEpoch: 'control-3',
        stateRevision: 17, mode: 'paired', observedState: { status: 'idle' }, acceptedTurn: null, active: null,
        libraryRevision: 'library-1', highWatermark: 2, compactedThrough: 0, operations: []
      } }
    }
    assert.equal(store.saveCheckpoint({ controllerId, correlationId: 'snapshot-query', snapshot }).duplicate, false)
    const snapshotRetry = structuredClone(snapshot) as Extract<OperationalMessage, { kind: 'response' }>
    snapshotRetry.messageId = 'snapshot-transport-retry'
    snapshotRetry.body.correlationId = 'snapshot-query-retry'
    assert.equal(store.saveCheckpoint({ controllerId, correlationId: 'snapshot-query-retry', snapshot: snapshotRetry }).duplicate, true)
    const restartedSnapshot = structuredClone(snapshot) as Extract<OperationalMessage, { kind: 'response' }>
    restartedSnapshot.messageId = 'snapshot-after-player-restart'
    restartedSnapshot.body.correlationId = 'snapshot-after-player-restart-query'
    restartedSnapshot.body.payload.playerEpoch = 'player-9'
    assert.equal(store.saveCheckpoint({ controllerId, correlationId: 'snapshot-after-player-restart-query',
      snapshot: restartedSnapshot }).duplicate, false, 'a new Player epoch may checkpoint the same journal watermark')
    assert.throws(() => {
      const conflicting = structuredClone(restartedSnapshot) as Extract<OperationalMessage, { kind: 'response' }>
      conflicting.body.correlationId = 'snapshot-conflicting-same-epoch'
      conflicting.body.payload.stateRevision = Number(conflicting.body.payload.stateRevision) + 1
      store.saveCheckpoint({ controllerId, correlationId: 'snapshot-conflicting-same-epoch', snapshot: conflicting })
    }, (error: unknown) => {
      assert.ok(error instanceof PlayerOperationalStoreError)
      assert.equal(error.code, 'CHECKPOINT_CONFLICT')
      return true
    },
      'same-epoch evidence at one watermark remains immutable')
    assert.equal(store.getLatestCheckpoint()?.sequence, 2)
    assert.equal(store.getLatestCheckpoint()?.snapshot.body.payload.playerEpoch, 'player-9')
  } finally { store.close() }

  const checkpointDatabase = new DatabaseSync(path.join(userData, PLAYER_OPERATIONAL_DATABASE_FILENAME), { readOnly: true })
  try {
    assert.equal((checkpointDatabase.prepare('SELECT COUNT(*) AS count FROM checkpoints').get() as { count: number }).count, 2,
      'the old-epoch checkpoint remains alongside the restart snapshot')
  } finally { checkpointDatabase.close() }

  const reopened = new PlayerOperationalStore(options(userData))
  try {
    const record = reopened.lookupOperation(controllerId, 'op-basic')
    assert.equal(record?.status, 'completed')
    assert.equal(record?.fingerprint, storeFingerprintFor(commandFor('op-basic')))
    assert.equal(reopened.getMetadata().highWatermark, 2)
    assert.equal(reopened.getLatestCheckpoint()?.sequence, 2)
  } finally { reopened.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('schema-1 migration preserves journal evidence and keys its checkpoint by the stored Player epoch', () => {
  const userData = temporaryDirectory('kq-operational-store-schema1-migration-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true }))
  const command = commandFor('op-schema1-migration')
  store.acceptOperation({ controllerId, command })
  store.finishOperation({ controllerId, operationId: 'op-schema1-migration', status: 'completed',
    events: [operationResultEvent('op-schema1-migration', 'completed', command)] })
  const template = structuredClone(validMessages.find((message): message is Extract<OperationalMessage, { kind: 'response' }> =>
    message.kind === 'response' && message.body.type === 'snapshot')!)
  template.deviceId = deviceId
  template.controllerId = controllerId
  template.body.correlationId = 'schema1-migration-snapshot'
  const metadataBefore = store.getMetadata()
  template.body.payload = { ...template.body.payload, journalId, deviceId, playerEpoch: 'player-before-migration',
    highWatermark: metadataBefore.highWatermark, compactedThrough: metadataBefore.compactedThrough }
  store.saveCheckpoint({ controllerId, correlationId: 'schema1-migration-snapshot', snapshot: template })
  const metadataBeforeMigration = store.getMetadata()
  store.close()

  downgradeOperationalStoreToSchema1(userData)
  const migrated = new PlayerOperationalStore(options(userData))
  try {
    const metadataAfter = migrated.getMetadata()
    assert.equal(metadataAfter.schemaVersion, 2)
    assert.equal(metadataAfter.highWatermark, metadataBefore.highWatermark)
    assert.equal(metadataAfter.logicalBytes, metadataBeforeMigration.logicalBytes)
    assert.equal(metadataAfter.recordCount, metadataBeforeMigration.recordCount)
    assert.equal(migrated.lookupOperation(controllerId, 'op-schema1-migration')?.status, 'completed')
    assert.equal(migrated.readPage({ controllerId, correlationId: 'schema1-migration-page', afterSequence: 0, limit: 32 }).events.length, 2)
    assert.equal(migrated.getLatestCheckpoint()?.snapshot.body.payload.playerEpoch, 'player-before-migration')
  } finally { migrated.close() }
  const database = new DatabaseSync(path.join(userData, PLAYER_OPERATIONAL_DATABASE_FILENAME), { readOnly: true })
  try {
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2)
    assert.equal((database.prepare('SELECT player_epoch FROM checkpoints').get() as { player_epoch: string }).player_epoch,
      'player-before-migration')
  } finally { database.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

function storeFingerprintFor(command: OperationalMessage): string {
  assert.equal(command.kind, 'command')
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value
  return crypto.createHash('sha256').update(JSON.stringify(canonical({ protocolVersion: 1, schemaVersion: 1,
    type: command.body.type, target: command.body.target, payload: command.body.payload }))).digest('hex')
}

test('restart converts every accepted operation to unknown with durable uncertainty events', () => {
  const userData = temporaryDirectory('kq-operational-store-restart-')
  const first = new PlayerOperationalStore(options(userData, { initializeIfMissing: true }))
  const command = commandFor('op-pending-restart')
  first.acceptOperation({ controllerId, command })
  assert.equal(first.lookupOperation(controllerId, 'op-pending-restart')?.status, 'accepted')
  first.close()

  const restarted = new PlayerOperationalStore(options(userData))
  try {
    const record = restarted.lookupOperation(controllerId, 'op-pending-restart')
    assert.equal(record?.status, 'unknown')
    assert.equal(record?.terminalEventSequence, 3)
    const page = restarted.readPage({ controllerId, correlationId: 'restart-query', afterSequence: 0, limit: 32 })
    assert.deepEqual(page.events.map(event => event.type), ['operation-result', 'uncertain', 'operation-result'])
    assert.equal(restarted.acceptOperation({ controllerId, command }).status, 'unknown')
    assert.equal(restarted.getMetadata().highWatermark, 3)
  } finally { restarted.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('event retry after a lost acknowledgement returns the original sequence without duplicating the journal', () => {
  const userData = temporaryDirectory('kq-operational-store-event-retry-')
  let appendCommitted = false
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true, testHooks: {
    afterCommit(_operationId, writeKind) {
      if (writeKind === 'append-event' && !appendCommitted) {
        appendCommitted = true
        throw new Error('synthetic event acknowledgement loss')
      }
    }
  } }))
  try {
    store.acceptOperation({ controllerId, command: commandFor('op-event-retry') })
    const event: OperationalEventDraft = {
      schemaVersion: 1, causationOperationId: 'op-event-retry', sessionId: 'session-legacy-12',
      turnId: 'LOG-op-event-retry-AB12', occurrenceId: 'occ-op-event-retry-1', attemptId: 'attempt-event-retry',
      stateRevision: 17, origin: 'remote', type: 'attempt-started', payload: { musicCode: '01001' }
    }
    const first = store.appendEvent({ controllerId, operationId: 'op-event-retry', event })
    const retry = store.appendEvent({ controllerId, operationId: 'op-event-retry', event })
    assert.equal(first.eventSequence, 2)
    assert.equal(retry.eventSequence, 2)
    assert.equal(store.getMetadata().highWatermark, 2)
    assert.equal(store.getMetadata().recordCount, 4)
  } finally { store.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('parallel operation submissions receive a single contiguous event sequence', () => {
  const userData = temporaryDirectory('kq-operational-store-concurrent-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true }))
  try {
    const receipts = Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() =>
      store.acceptOperation({ controllerId, command: commandFor('op-parallel-' + index) })))
    return Promise.all(receipts).then(results => {
      assert.equal(new Set(results.map(receipt => receipt.acceptedEventSequence)).size, 20)
      assert.deepEqual(store.readPage({ controllerId, correlationId: 'parallel-page', afterSequence: 0, limit: 32 })
        .events.map(event => event.eventSequence), Array.from({ length: 20 }, (_, index) => index + 1))
      assert.equal(store.getMetadata().recordCount, 60)
    }).finally(() => { store.close(); fs.rmSync(userData, { recursive: true, force: true }) })
  } catch (error) {
    store.close()
    fs.rmSync(userData, { recursive: true, force: true })
    throw error
  }
})

test('exclusive SQLite ownership rejects a competing connection and a competing process', async () => {
  const userData = temporaryDirectory('kq-operational-store-owner-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true, busyTimeoutMs: 25 }))
  expectStoreError('STORE_IN_USE', () => new PlayerOperationalStore(options(userData, { busyTimeoutMs: 25 })))
  store.close()

  const child = spawnWorker('hold-lock', userData)
  await waitForReady(child)
  expectStoreError('STORE_IN_USE', () => new PlayerOperationalStore(options(userData, { busyTimeoutMs: 25 })))
  child.send('CLOSE')
  assert.deepEqual(await waitForExit(child), { code: 0, signal: null })
  const reopened = new PlayerOperationalStore(options(userData))
  reopened.close()
  fs.rmSync(userData, { recursive: true, force: true })
})

test('process death before commit rolls back the intent; process death after commit recovers as unknown', async () => {
  const beforeDirectory = temporaryDirectory('kq-operational-store-crash-before-')
  const beforeStore = new PlayerOperationalStore(options(beforeDirectory, { initializeIfMissing: true }))
  beforeStore.close()
  const uncommitted = spawnWorker('uncommitted-crash', beforeDirectory)
  const uncommittedExit = waitForExit(uncommitted)
  await waitForReady(uncommitted)
  killAbruptly(uncommitted)
  assertAbruptExit(await uncommittedExit)
  const afterBeforeCrash = new PlayerOperationalStore(options(beforeDirectory))
  assert.equal(afterBeforeCrash.lookupOperation(controllerId, 'op-crash-before-commit'), null)
  assert.equal(afterBeforeCrash.getMetadata().highWatermark, 0)
  afterBeforeCrash.close()
  fs.rmSync(beforeDirectory, { recursive: true, force: true })

  const afterDirectory = temporaryDirectory('kq-operational-store-crash-after-')
  const afterStore = new PlayerOperationalStore(options(afterDirectory, { initializeIfMissing: true }))
  afterStore.close()
  const commandFile = path.join(afterDirectory, 'synthetic-command.json')
  fs.writeFileSync(commandFile, JSON.stringify({ controllerId, message: commandFor('op-ack-lost') }))
  const acceptedThenKilled = spawnWorker('accept-and-die', afterDirectory, commandFile)
  const acceptedExit = waitForExit(acceptedThenKilled)
  await waitForMessage(acceptedThenKilled, 'committed')
  killAbruptly(acceptedThenKilled)
  assertAbruptExit(await acceptedExit)
  const recovered = new PlayerOperationalStore(options(afterDirectory))
  try {
    assert.equal(recovered.lookupOperation(controllerId, 'op-ack-lost')?.status, 'unknown')
    const retry = recovered.acceptOperation({ controllerId, command: commandFor('op-ack-lost') })
    assert.equal(retry.status, 'unknown')
    assert.equal(retry.duplicate, true)
    assert.equal(recovered.getMetadata().highWatermark, 3)
  } finally { recovered.close(); fs.rmSync(afterDirectory, { recursive: true, force: true }) }
})

test('process death while SQLite is processing COMMIT rolls back the complete candidate transaction', {
  skip: typeof DatabaseSync.prototype.setAuthorizer !== 'function'
}, async () => {
  const userData = temporaryDirectory('kq-operational-store-crash-during-commit-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true }))
  store.close()
  const commandFile = path.join(userData, 'synthetic-command.json')
  fs.writeFileSync(commandFile, JSON.stringify({ controllerId, message: commandFor('op-crash-during-commit') }))
  const child = spawnWorker('accept-during-commit', userData, commandFile)
  const exited = waitForExit(child)
  try {
    await waitForMessage(child, 'commit-entered')
    killAbruptly(child)
    assertAbruptExit(await exited)
    const recovered = new PlayerOperationalStore(options(userData))
    try {
      assert.equal(recovered.lookupOperation(controllerId, 'op-crash-during-commit'), null)
      assert.equal(recovered.getMetadata().highWatermark, 0)
    } finally { recovered.close() }
  } finally { fs.rmSync(userData, { recursive: true, force: true }) }
})

test('quota reserves terminal capacity for accepted operations and releases unused reservation on completion', () => {
  const userData = temporaryDirectory('kq-operational-store-quota-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true, maxLogicalBytes: 100_000, maxRecords: 20 }))
  try {
    const first = commandFor('op-reserved-one')
    store.acceptOperation({ controllerId, command: first })
    const reserved = store.getMetadata()
    assert.equal(reserved.reservedRecords, 8)
    assert.ok(reserved.reservedBytes >= 8 * 8192)
    expectStoreError('QUOTA_EXCEEDED', () => store.acceptOperation({ controllerId, command: commandFor('op-reserved-two') }))
    store.finishOperation({ controllerId, operationId: 'op-reserved-one', status: 'completed',
      events: [operationResultEvent('op-reserved-one', 'completed', first)] })
    assert.equal(store.getMetadata().reservedRecords, 0)
    assert.equal(store.acceptOperation({ controllerId, command: commandFor('op-reserved-two') }).status, 'accepted')
  } finally { store.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('SQLite max_page_count simulates disk full and leaves no partially accepted operation', () => {
  const userData = temporaryDirectory('kq-operational-store-full-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true, maxDatabasePages: 20 }))
  try {
    let failure: unknown
    for (let index = 0; index < 100; index++) {
      try { store.acceptOperation({ controllerId, command: commandFor('op-full-' + index) }) }
      catch (error) { failure = error; break }
    }
    assert.ok(failure instanceof PlayerOperationalStoreError)
    assert.equal(failure.code, 'STORE_WRITE_FAILED')
    assert.equal(store.lookupOperation(controllerId, 'op-full-99'), null)
    assert.equal(store.getMetadata().recordCount, 3 * store.getMetadata().highWatermark)
  } finally { store.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('an unreadable write readback fences the store and retains committed evidence', () => {
  const userData = temporaryDirectory('kq-operational-store-uncertain-')
  let fired = false
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true, testHooks: {
    afterCommit() { if (!fired) { fired = true; throw new Error('synthetic acknowledgement loss') } },
    failReadback() { throw new Error('synthetic readback outage') }
  } }))
  expectStoreError('RESULT_UNCERTAIN', () => store.acceptOperation({ controllerId, command: commandFor('op-readback-failed') }))
  assert.equal(readPlayerOperationalRecoveryMarker(userData)?.code, 'write-readback-unavailable')
  store.close()
  const db = new DatabaseSync(path.join(userData, PLAYER_OPERATIONAL_DATABASE_FILENAME), { readOnly: true })
  try {
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM operations WHERE operation_id='op-readback-failed'").get()?.count), 1)
  } finally { db.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('backup includes committed WAL state and restore with an advanced external cursor stays fenced', () => {
  const source = temporaryDirectory('kq-operational-store-backup-source-')
  const destination = temporaryDirectory('kq-operational-store-backup-destination-')
  const store = new PlayerOperationalStore(options(source, { initializeIfMissing: true }))
  const command = commandFor('op-backup')
  store.acceptOperation({ controllerId, command })
  store.finishOperation({ controllerId, operationId: 'op-backup', status: 'completed',
    events: [operationResultEvent('op-backup', 'completed', command)] })
  const backup = store.createBackup()
  assert.equal(verifyPlayerOperationalBackup(source, backup.manifestFile).manifest.highWatermark, 2)
  const restored = restorePlayerOperationalBackup({ sourceUserDataDirectory: source, manifestFile: backup.manifestFile,
    destinationUserDataDirectory: destination, externalCursor: { journalId, throughSequence: 9 } })
  assert.equal(restored.recoveryRequired, true)
  assert.equal(restored.reason, 'restore-external-cursor-ahead')
  assert.equal(readPlayerOperationalRecoveryMarker(destination)?.externalCursor?.throughSequence, 9)
  expectStoreError('RECOVERY_REQUIRED', () => new PlayerOperationalStore(options(destination)))
  assert.ok(fs.existsSync(backup.backupPath))
  assert.ok(fs.existsSync(restored.databasePath))
  store.close()
  fs.rmSync(source, { recursive: true, force: true })
  fs.rmSync(destination, { recursive: true, force: true })
})

test('schema mismatch, corruption, and missing database fail closed without replacing evidence', () => {
  const incompatibleDirectory = temporaryDirectory('kq-operational-store-schema-')
  const incompatible = new PlayerOperationalStore(options(incompatibleDirectory, { initializeIfMissing: true }))
  incompatible.close()
  const schemaDatabase = new DatabaseSync(path.join(incompatibleDirectory, PLAYER_OPERATIONAL_DATABASE_FILENAME))
  schemaDatabase.exec('PRAGMA user_version = 77')
  schemaDatabase.close()
  const schemaBytes = fs.readFileSync(path.join(incompatibleDirectory, PLAYER_OPERATIONAL_DATABASE_FILENAME))
  expectStoreError('STORE_SCHEMA_UNSUPPORTED', () => new PlayerOperationalStore(options(incompatibleDirectory)))
  assert.deepEqual(fs.readFileSync(path.join(incompatibleDirectory, PLAYER_OPERATIONAL_DATABASE_FILENAME)), schemaBytes)
  assert.equal(readPlayerOperationalRecoveryMarker(incompatibleDirectory)?.code, 'unsupported-schema')
  fs.rmSync(incompatibleDirectory, { recursive: true, force: true })

  const corruptDirectory = temporaryDirectory('kq-operational-store-corrupt-')
  const corruptStore = new PlayerOperationalStore(options(corruptDirectory, { initializeIfMissing: true }))
  corruptStore.close()
  const databasePath = path.join(corruptDirectory, PLAYER_OPERATIONAL_DATABASE_FILENAME)
  const corrupt = fs.readFileSync(databasePath)
  corrupt[0] = 0
  fs.writeFileSync(databasePath, corrupt)
  expectStoreError('STORE_CORRUPT', () => new PlayerOperationalStore(options(corruptDirectory)))
  assert.deepEqual(fs.readFileSync(databasePath), corrupt)
  assert.equal(readPlayerOperationalRecoveryMarker(corruptDirectory)?.code, 'store-corrupt')
  fs.rmSync(corruptDirectory, { recursive: true, force: true })

  const missingDirectory = temporaryDirectory('kq-operational-store-missing-')
  const missingStore = new PlayerOperationalStore(options(missingDirectory, { initializeIfMissing: true }))
  missingStore.close()
  fs.unlinkSync(path.join(missingDirectory, PLAYER_OPERATIONAL_DATABASE_FILENAME))
  expectStoreError('STORE_MISSING', () => new PlayerOperationalStore(options(missingDirectory, { initializeIfMissing: true })))
  assert.equal(fs.existsSync(path.join(missingDirectory, PLAYER_OPERATIONAL_DATABASE_FILENAME)), false)
  fs.rmSync(missingDirectory, { recursive: true, force: true })
})

test('revoking a consumer preserves its journal history and cursor metadata', () => {
  const userData = temporaryDirectory('kq-operational-store-revoked-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true }))
  try {
    store.acceptOperation({ controllerId, command: commandFor('op-after-revocation') })
    store.markConsumerRevoked(controllerId, '2026-11-12T12:00:00.000Z')
    assert.equal(store.getConsumerRevocation(controllerId), '2026-11-12T12:00:00.000Z')
    assert.equal(store.lookupOperation(controllerId, 'op-after-revocation')?.status, 'accepted')
    assert.equal(store.readPage({ controllerId, correlationId: 'history-after-revoke', afterSequence: 0, limit: 8 }).events.length, 1)
  } finally { store.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('numeric cursors are safe integers and unknown gaps are rejected', () => {
  const userData = temporaryDirectory('kq-operational-store-cursor-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true }))
  try {
    expectStoreError('CURSOR_INVALID', () => store.readPage({ controllerId, correlationId: 'bad-high',
      afterSequence: Number.MAX_SAFE_INTEGER + 1, limit: 1 }))
    expectStoreError('CURSOR_INVALID', () => store.readPage({ controllerId, correlationId: 'future', afterSequence: 1, limit: 1 }))
    expectStoreError('CURSOR_INVALID', () => store.readPage({ controllerId, correlationId: 'negative', afterSequence: -1, limit: 1 }))
  } finally { store.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('ACK is monotonic and compaction preserves dedupe tombstones across restart', () => {
  const userData = temporaryDirectory('kq-operational-store-compaction-')
  let store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true,
    testHooks: { afterCommit(_id, kind) { if (kind === 'ack') throw new Error('simulated-lost-ack-return') } } }))
  const command = commandFor('op-compaction')
  try {
    store.acceptOperation({ controllerId, command })
    store.finishOperation({ controllerId, operationId: 'op-compaction', status: 'completed',
      events: [operationResultEvent('op-compaction', 'completed', command)] })
    const metadata = store.getMetadata()
    const checkpoint: OperationalMessage = {
      protocolVersion: 1, schemaVersion: 1, kind: 'response', messageId: 'snapshot-compaction', deviceId, controllerId,
      body: { correlationId: 'query-compaction', type: 'snapshot', payload: {
        journalId, deviceId, playerEpoch: 'player-8', hostEpoch: 'host-1', controlEpoch: 'control-3',
        stateRevision: 17, mode: 'paired', observedState: { status: 'idle' }, acceptedTurn: null, active: null,
        libraryRevision: 'library-1', highWatermark: metadata.highWatermark,
        compactedThrough: metadata.compactedThrough, operations: []
      } }
    }
    store.saveCheckpoint({ controllerId, correlationId: 'query-compaction', snapshot: checkpoint })
    const ackAfterLostReturn = store.ackConsumed({ controllerId, journalId, consumerId: controllerId, throughSequence: 2 })
    assert.equal(ackAfterLostReturn.throughSequence, 2)
    assert.equal(ackAfterLostReturn.duplicate, true, 'readback confirms the commit after the caller loses its return')
    assert.equal(store.ackConsumed({ controllerId, journalId, consumerId: controllerId, throughSequence: 1 }).throughSequence, 2)
    const compacted = store.compactJournal()
    assert.equal(compacted.compactedThrough, 2)
    assert.equal(compacted.eventsDeleted, 2)
    assert.equal(compacted.operationsDeleted, 1)
    assert.equal(store.getMetadata().recordCount, 2, 'permanent tombstone and current checkpoint remain counted')
    expectStoreError('REPLAY_COMPACTED', () => store.readPage({ controllerId, correlationId: 'expired-replay', afterSequence: 0, limit: 8 }))
    assert.equal(store.readPage({ controllerId, correlationId: 'at-eof', afterSequence: 2, limit: 8 }).events.length, 0)
    assert.equal(store.lookupOperation(controllerId, 'op-compaction')?.compacted, true)
    assert.equal(store.getOperationStatus({ controllerId, operationId: 'op-compaction' })?.result?.status, 'completed')
    const duplicate = store.acceptOperation({ controllerId, command })
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.status, 'completed')
    const changed = structuredClone(command)
    if (changed.kind === 'command' && changed.body.type === 'activate-turn') {
      ;(changed.body.payload as ActivateTurnPayload).singerName = 'Outro cantor'
    }
    expectStoreError('OPERATION_ID_CONFLICT', () => store.acceptOperation({ controllerId, command: changed }))
    assert.equal(store.getMetadata().highWatermark, 2, 'retry after compaction does not create a new event')
  } finally { store.close() }

  store = new PlayerOperationalStore(options(userData))
  try {
    assert.equal(store.getMetadata().compactedThrough, 2)
    assert.equal(store.lookupOperation(controllerId, 'op-compaction')?.status, 'completed')
    assert.equal(store.getConsumerCursor(controllerId)?.throughSequence, 2)
    assert.equal(store.getLatestCheckpoint()?.sequence, 2)
  } finally { store.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('process death immediately after compaction commit recovers the compacted prefix and dedupe proof', async () => {
  const userData = temporaryDirectory('kq-operational-store-compaction-crash-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true }))
  store.close()
  const command = commandFor('op-compaction-crash')
  const commandPath = path.join(userData, 'compact-command.json')
  fs.writeFileSync(commandPath, JSON.stringify({ controllerId, message: command }), 'utf8')
  const child = spawnWorker('compact-and-die-after-commit', userData, commandPath)
  const committed = waitForMessage(child, 'compact-committed')
  const exited = waitForExit(child)
  try {
    await committed
    killAbruptly(child)
    assertAbruptExit(await exited)
    const recovered = new PlayerOperationalStore(options(userData))
    try {
      assert.equal(recovered.getMetadata().compactedThrough, 2)
      assert.equal(recovered.lookupOperation(controllerId, 'op-compaction-crash')?.status, 'completed')
      assert.equal(recovered.lookupOperation(controllerId, 'op-compaction-crash')?.compacted, true)
      assert.equal(recovered.readPage({ controllerId, correlationId: 'post-crash-eof', afterSequence: 2, limit: 8 }).events.length, 0)
    } finally { recovered.close() }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    fs.rmSync(userData, { recursive: true, force: true })
  }
})

test('unreadable compaction readback fails closed and preserves committed SQLite evidence', () => {
  const userData = temporaryDirectory('kq-operational-store-compaction-uncertain-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true, testHooks: {
    afterCommit(_id, kind) { if (kind === 'compact') throw new Error('simulated-lost-compaction-return') },
    failReadback(kind) { if (kind === 'compact') throw new Error('simulated-unreadable-compaction-readback') }
  } }))
  const command = commandFor('op-compaction-uncertain')
  store.acceptOperation({ controllerId, command })
  store.finishOperation({ controllerId, operationId: 'op-compaction-uncertain', status: 'completed',
    events: [operationResultEvent('op-compaction-uncertain', 'completed', command)] })
  const metadata = store.getMetadata()
  const snapshot: OperationalMessage = { protocolVersion: 1, schemaVersion: 1, kind: 'response',
    messageId: 'snapshot-uncertain', deviceId, controllerId, body: { correlationId: 'query-uncertain', type: 'snapshot',
      payload: { journalId, deviceId, playerEpoch: 'p', hostEpoch: 'h', controlEpoch: 'c', stateRevision: 1,
        mode: 'paired', observedState: { status: 'idle' }, acceptedTurn: null, active: null,
        libraryRevision: 'lib', highWatermark: metadata.highWatermark, compactedThrough: metadata.compactedThrough,
        operations: [] } } }
  store.saveCheckpoint({ controllerId, correlationId: 'query-uncertain', snapshot })
  store.ackConsumed({ controllerId, journalId, consumerId: controllerId, throughSequence: metadata.highWatermark })
  expectStoreError('RESULT_UNCERTAIN', () => store.compactJournal())
  assert.equal(readPlayerOperationalRecoveryMarker(userData)?.code, 'journal-compaction-readback-unavailable')
  store.close()
  const raw = new DatabaseSync(path.join(userData, PLAYER_OPERATIONAL_DATABASE_FILENAME), { readOnly: true })
  try {
    assert.equal(raw.prepare('SELECT compacted_through FROM journal_meta WHERE singleton=1').get()?.compacted_through, 2)
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM operation_tombstones').get()?.count, 1)
  } finally { raw.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})

test('accepted and unknown operations block journal compaction and revoked consumers cannot advance ACK', () => {
  const userData = temporaryDirectory('kq-operational-store-retain-unknown-')
  const store = new PlayerOperationalStore(options(userData, { initializeIfMissing: true }))
  try {
    const command = commandFor('op-uncertain-retained')
    store.acceptOperation({ controllerId, command })
    const metadata = store.getMetadata()
    const checkpoint: OperationalMessage = {
      protocolVersion: 1, schemaVersion: 1, kind: 'response', messageId: 'snapshot-unknown', deviceId, controllerId,
      body: { correlationId: 'query-unknown', type: 'snapshot', payload: {
        journalId, deviceId, playerEpoch: 'player-8', hostEpoch: 'host-1', controlEpoch: 'control-3',
        stateRevision: 17, mode: 'paired', observedState: { status: 'uncertain' }, acceptedTurn: null, active: null,
        libraryRevision: 'library-1', highWatermark: metadata.highWatermark,
        compactedThrough: metadata.compactedThrough, operations: []
      } }
    }
    store.saveCheckpoint({ controllerId, correlationId: 'query-unknown', snapshot: checkpoint })
    store.ackConsumed({ controllerId, journalId, consumerId: controllerId, throughSequence: metadata.highWatermark })
    assert.equal(store.compactJournal().compactedThrough, 0)
    store.markConsumerRevoked(controllerId, '2026-11-12T12:00:00.000Z')
    expectStoreError('CONSUMER_REVOKED', () => store.ackConsumed({ controllerId, journalId, consumerId: controllerId, throughSequence: 1 }))
    assert.equal(store.getConsumerCursor(controllerId)?.throughSequence, 1)
    assert.equal(store.lookupOperation(controllerId, 'op-uncertain-retained')?.command?.operationId, 'op-uncertain-retained')
  } finally { store.close(); fs.rmSync(userData, { recursive: true, force: true }) }
})
