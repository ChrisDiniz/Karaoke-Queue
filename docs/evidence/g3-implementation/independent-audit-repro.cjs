// Re-run after npm run compile. Synthetic data only; checks the four audit regressions.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mock } = require('node:test')
const root = process.cwd()
const { OperationalProtocolService } = require(path.join(root, 'build/src/operational-protocol-service'))
const { PlayerOperationalStore } = require(path.join(root, 'build/src/player-operational-store'))
const { parseOperationalMessageObject } = require(path.join(root, 'build/src/operational-protocol-validation'))
const { createKaraokeDatabase } = require(path.join(root, 'build/database'))
const { ManagementRemoteOutbox } = require(path.join(root, 'build/src/management-remote-outbox'))
const { ManagementRemoteJournalInbox } = require(path.join(root, 'build/src/management-remote-journal'))
const fixtures = JSON.parse(fs.readFileSync('tests/fixtures/operational-v1/valid-messages.json', 'utf8'))

function findMessage(predicate) { return structuredClone(fixtures.find(predicate)) }
function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `kq-g3-${name}-`)) }
function makeCommand(base, id) {
  const message = structuredClone(base)
  message.messageId = `message-${id}`
  message.body.operationId = id
  message.body.target.playerEpoch = 'audit-player-epoch'
  message.body.target.controlEpoch = '3'
  return message
}

async function auditA2() {
  const snapshot = findMessage(x => x.kind === 'response' && x.body.type === 'snapshot')
  snapshot.body.payload.acceptedTurn = { sessionId: 's', turnId: 't', packageRevision: 1,
    tracks: [{ occurrenceId: 'occ-1', trackIndex: 1, musicCode: '01001' }] }
  assert.doesNotThrow(() => parseOperationalMessageObject(snapshot))
  for (const tracks of [[null], [{}], [{ occurrenceId: 'occ-1', trackIndex: 1, musicCode: 1001 }],
    [{ occurrenceId: 'occ-1', trackIndex: 1, musicCode: '01001' }, { occurrenceId: 'occ-1', trackIndex: 2, musicCode: '00042' }]]) {
    const malformed = structuredClone(snapshot)
    malformed.body.payload.acceptedTurn.tracks = tracks
    assert.throws(() => parseOperationalMessageObject(malformed), /OPERATIONAL_MESSAGE_INVALID/)
  }
  console.log('A2 RESOLVED: snapshot rejects null/partial/invalid/duplicate tracks and accepts a canonical track')
}

async function auditA1() {
  const directory = temp('a1')
  const base = findMessage(x => x.kind === 'command' && x.body.type === 'pause')
  const { deviceId, controllerId } = base
  const store = new PlayerOperationalStore({ userDataDirectory: directory, deviceId, journalId: 'audit-journal', initializeIfMissing: true })
  let releaseFirst
  let startFirst
  let executions = 0
  let live = 0
  let peak = 0
  const started = new Promise(resolve => { startFirst = resolve })
  const messages = []
  let notifyUnknown
  const unknownEvent = new Promise(resolve => { notifyUnknown = resolve })
  const channel = { connectionId: 'audit-a1', peer: { controllerId, credentialGeneration: 3, scopes: ['transport:control'] },
    signal: new AbortController().signal,
    send(value) {
      const message = parseOperationalMessageObject(typeof value === 'string' ? JSON.parse(value) : JSON.parse(Buffer.from(value).toString('utf8')))
      messages.push(message)
      if (message.kind === 'event' && message.body.type === 'operation-result' && message.body.payload.status === 'unknown') notifyUnknown()
      return true
    }, close() {} }
  const service = new OperationalProtocolService({ store, deviceId, playerEpoch: 'audit-player-epoch',
    maxConcurrentExecutions: 1, executionTimeoutMs: 10, shutdownTimeoutMs: 5,
    authorization: { async isCurrent() { return true }, async authorizeBearer() { return null } },
    isTargetCurrent: () => true,
    executionPort: { execute() {
      executions++; live++; peak = Math.max(peak, live); startFirst()
      return new Promise(resolve => { releaseFirst = result => { live--; resolve(result) } })
    } } })
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await service.onMessage({ channel, payload: { ...findMessage(x => x.kind === 'hello'), deviceId, controllerId } })
    await service.onMessage({ channel, payload: makeCommand(base, 'audit-a1-first') })
    await started
    mock.timers.tick(10)
    await unknownEvent
    assert.equal(store.lookupOperation(controllerId, 'audit-a1-first').status, 'unknown')
    const wait = service.waitForIdle(5)
    mock.timers.tick(5)
    assert.deepEqual(await wait, { state: 'blocked', activeExecutions: 1, pendingAdmissions: 0 })
    await service.onMessage({ channel, payload: makeCommand(base, 'audit-a1-second') })
    assert.equal(executions, 1)
    assert.equal(peak, 1)
    assert.equal(live, 1)
    assert.equal(store.lookupOperation(controllerId, 'audit-a1-second'), null)
    const shutdown = service.close()
    mock.timers.tick(5)
    assert.deepEqual(await shutdown, { state: 'blocked', activeExecutions: 1, pendingAdmissions: 0 })
    releaseFirst({ status: 'completed', state: 'late-result' })
    assert.deepEqual(await service.waitForIdle(5), { state: 'closed', activeExecutions: 0, pendingAdmissions: 0 })
    assert.equal(store.lookupOperation(controllerId, 'audit-a1-first').status, 'unknown')
    console.log('A1 RESOLVED: timeout keeps the slot and drain blocked until the handler actually settles')
  } finally {
    mock.timers.reset()
    try { releaseFirst?.({ status: 'unknown', state: 'cleanup' }) } catch {}
    await service.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function auditA4() {
  const directory = temp('a4')
  const base = findMessage(x => x.kind === 'command' && x.body.type === 'pause')
  const { deviceId, controllerId } = base
  const database = createKaraokeDatabase(directory)
  try {
    const outbox = new ManagementRemoteOutbox(database, { deviceId: controllerId, controllerId })
    const intent = makeCommand(base, 'audit-a4')
    const record = outbox.prepare(deviceId, intent).record
    outbox.transmit(deviceId, intent.body.operationId, { send() { return true } })
    const response = (status, result, seq) => parseOperationalMessageObject({ protocolVersion: 1, schemaVersion: 1,
      kind: 'response', messageId: `status-${status}-${seq}`, deviceId, controllerId,
      body: { correlationId: `query-${seq}`, type: 'operation-status', payload: { operationId: intent.body.operationId,
        fingerprint: record.fingerprint, status, result, eventSequence: seq } } })
    assert.equal(outbox.acceptStatus(deviceId, response('accepted', null, 1)).status, 'accepted')
    assert.equal(outbox.acceptStatus(deviceId, response('accepted', null, 1)).status, 'accepted')
    assert.equal(outbox.acceptStatus(deviceId, response('completed', { status: 'completed' }, 2)).status, 'completed')
    assert.equal(outbox.acceptStatus(deviceId, response('completed', { status: 'completed' }, 2)).status, 'completed')
    assert.throws(() => outbox.acceptStatus(deviceId, response('completed', { status: 'conflicting' }, 2)), /TERMINAL_CONFLICT/)
    assert.equal(outbox.get(deviceId, intent.body.operationId).status, 'completed')
    console.log('A4 RESOLVED: identical accepted/completed retries are idempotent; conflicting terminal result is rejected')
  } finally { database.close(); fs.rmSync(directory, { recursive: true, force: true }) }
}

async function auditA3() {
  const directory = temp('a3')
  const base = findMessage(x => x.kind === 'response' && x.body.type === 'snapshot')
  const { deviceId, controllerId } = base
  const database = createKaraokeDatabase(directory)
  try {
    const inbox = new ManagementRemoteJournalInbox(database, { controllerId })
    base.body.payload.highWatermark = 13
    base.body.payload.compactedThrough = 0
    const cursor = inbox.persistSnapshot(deviceId, base)
    assert.equal(cursor.highWatermark, 13)
    assert.equal(cursor.snapshotHighWatermark, 13)
    assert.equal(cursor.throughSequence, 0)
    assert.deepEqual(inbox.readEvents(deviceId, 0, 32), [])
    assert.throws(() => inbox.readEvents(deviceId, 13, 32), /GAP/)
    console.log('A3 RESOLVED: snapshot preserves received cursor at 0; announced watermark 13 remains separate and replay must start at 0')
  } finally { database.close(); fs.rmSync(directory, { recursive: true, force: true }) }
}

async function main() {
  await auditA1()
  await auditA2()
  await auditA3()
  await auditA4()
}
main().catch(error => { console.error(error); process.exitCode = 1 })
