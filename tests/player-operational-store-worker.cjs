const fs = require('node:fs')
const { PlayerOperationalStore } = require('../build/src/player-operational-store.js')

const [mode, userDataDirectory, commandPath, journalId = 'journal-device-01', deviceId = 'device-player-01'] = process.argv.slice(2)

function openStore() {
  return new PlayerOperationalStore({ userDataDirectory, journalId, deviceId })
}

if (mode === 'hold-lock') {
  const store = openStore()
  process.send({ type: 'ready' })
  process.on('message', () => {
    store.close()
    process.exit(0)
  })
} else if (mode === 'accept-and-die') {
  const store = openStore()
  const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'))
  store.acceptOperation({ controllerId: command.controllerId, command: command.message })
  process.send({ type: 'committed' })
} else if (mode === 'accept-during-commit') {
  const { constants } = require('node:sqlite')
  const store = openStore()
  if (typeof store.database.setAuthorizer !== 'function') throw new Error('SQLITE_COMMIT_AUTHORIZER_UNAVAILABLE')
  store.database.setAuthorizer((actionCode, operation) => {
    if (actionCode === constants.SQLITE_TRANSACTION && operation === 'COMMIT') {
      process.send({ type: 'commit-entered' })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
    return constants.SQLITE_OK
  })
  const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'))
  store.acceptOperation({ controllerId: command.controllerId, command: command.message })
} else if (mode === 'compact-and-die-after-commit') {
  const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'))
  const store = new PlayerOperationalStore({ userDataDirectory, journalId, deviceId,
    testHooks: { afterCommit(_id, kind) {
      if (kind === 'compact') {
        process.send({ type: 'compact-committed' })
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      }
    } } })
  store.acceptOperation({ controllerId: command.controllerId, command: command.message })
  const body = command.message.body
  const target = body.target
  store.finishOperation({ controllerId: command.controllerId, operationId: body.operationId, status: 'completed', events: [{
    schemaVersion: 1, causationOperationId: body.operationId, sessionId: target.sessionId, turnId: target.turnId,
    ...('occurrenceId' in target ? { occurrenceId: target.occurrenceId, attemptId: target.attemptId } : {}),
    stateRevision: target.stateRevision, origin: 'remote', type: 'operation-result',
    payload: { operationId: body.operationId, status: 'completed' }
  }] })
  const metadata = store.getMetadata()
  const snapshot = { protocolVersion: 1, schemaVersion: 1, kind: 'response', messageId: 'crash-snapshot',
    deviceId, controllerId: command.controllerId, body: { correlationId: 'crash-checkpoint', type: 'snapshot', payload: {
      journalId, deviceId, playerEpoch: 'player-crash', hostEpoch: 'host-crash', controlEpoch: 'control-crash',
      stateRevision: 0, mode: 'paired', observedState: { status: 'idle' }, acceptedTurn: null, active: null,
      libraryRevision: 'library-crash', highWatermark: metadata.highWatermark,
      compactedThrough: metadata.compactedThrough, operations: [] } } }
  store.saveCheckpoint({ controllerId: command.controllerId, correlationId: 'crash-checkpoint', snapshot })
  store.ackConsumed({ controllerId: command.controllerId, journalId, consumerId: command.controllerId,
    throughSequence: metadata.highWatermark })
  store.compactJournal()
} else if (mode === 'uncommitted-crash') {
  const { DatabaseSync } = require('node:sqlite')
  const databasePath = require('node:path').join(userDataDirectory, 'player-operational.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA busy_timeout = 3000; PRAGMA locking_mode = EXCLUSIVE; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
  database.prepare(`INSERT INTO operation_tombstones(journal_id,controller_id,operation_id,fingerprint,status,
    accepted_sequence,terminal_sequence,receipt_json) VALUES(?,?,?,?,?,?,NULL,?)`)
    .run(journalId, 'controller-local-01', 'op-crash-before-commit', 'a'.repeat(64), 'accepted', 999,
      JSON.stringify({ status: 'accepted', acceptedEventSequence: 999 }))
  process.send({ type: 'ready' })
} else {
  process.stderr.write('UNKNOWN_MODE\n')
  process.exit(2)
}
