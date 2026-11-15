import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { OperationalMessage } from '../src/operational-protocol-contracts'
import type { RemoteAuthorizationPort, RemoteTransportMessageContext } from '../src/remote-contracts'
import { createMainPlayerOperationalEndpoint } from '../src/main-player-operational-endpoint'
import { parseOperationalMessageObject } from '../src/operational-protocol-validation'

const playerId = '22222222-2222-4222-8222-222222222222'
const controllerId = '11111111-1111-4111-8111-111111111111'
const hello: OperationalMessage = { protocolVersion: 1, schemaVersion: 1, kind: 'hello',
  messageId: 'hello-test', deviceId: playerId, controllerId,
  body: { protocol: 'kq-operation/1', protocolVersion: 1, schemaVersion: 1 } }

function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'kq-g5-player-protocol-')) }

function channel(out: OperationalMessage[], credentialGeneration = 7,
  connectionId = 'connection-test'): RemoteTransportMessageContext['channel'] {
  return {
    connectionId,
    peer: { controllerId, credentialGeneration, scopes: ['transport:control'] },
    send(data) { out.push(parseOperationalMessageObject(JSON.parse(String(data)) as unknown) as OperationalMessage); return true },
    close() {}
  }
}

function context(payload: OperationalMessage, activeChannel: RemoteTransportMessageContext['channel']): RemoteTransportMessageContext {
  return { channel: activeChannel, payload }
}

function auth(): RemoteAuthorizationPort {
  return { async authorizeBearer() { return null }, async isCurrent() { return true } }
}

test('Main Player exposes only G3 hello and durable status/reconciliation queries before H', async t => {
  const directory = temp()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let observation = { playbackStatus: 'playing', libraryRevision: 'library-4' }
  const endpoint = createMainPlayerOperationalEndpoint({ userDataDirectory: directory, deviceId: playerId,
    authorization: auth(), observe: () => observation })
  const out: OperationalMessage[] = []
  const activeChannel = channel(out)

  await endpoint.messagePort.onMessage(context(hello, activeChannel))
  const ready = out.at(-1)
  assert.equal(ready?.kind, 'ready')
  if (ready?.kind !== 'ready') throw new Error('G3_READY_MISSING')
  assert.equal(ready.body.journalId, `journal-${playerId}`)
  assert.equal(ready.body.playerEpoch, endpoint.playerEpoch)
  assert.match(ready.body.controlEpoch, /^[0-9a-f-]{36}$/)
  assert.notEqual(ready.body.controlEpoch, '7', 'G4 control epoch is separate from G2 credential generation')

  const snapshotQuery: OperationalMessage = { protocolVersion: 1, schemaVersion: 1, kind: 'query',
    messageId: 'snapshot-message', deviceId: playerId, controllerId,
    body: { queryId: 'snapshot-query', type: 'snapshot', payload: {} } }
  await endpoint.messagePort.onMessage(context(snapshotQuery, activeChannel))
  const snapshotResponse = out.at(-1)
  assert.equal(snapshotResponse?.kind, 'response')
  if (snapshotResponse?.kind !== 'response' || snapshotResponse.body.type !== 'snapshot') {
    throw new Error(`G3_SNAPSHOT_RESPONSE_MISSING:${JSON.stringify(snapshotResponse)}`)
  }
  const firstSnapshot = snapshotResponse.body.payload as Record<string, any>
  assert.equal(snapshotResponse.body.correlationId, 'snapshot-query')
  assert.equal(firstSnapshot.observedState.status, 'playing')
  assert.equal(firstSnapshot.libraryRevision, 'library-4')
  assert.equal(firstSnapshot.mode, 'paired')
  assert.equal(firstSnapshot.controlEpoch, ready.body.controlEpoch)
  assert.equal(firstSnapshot.active, null,
    'the local Standalone sequence is not represented as an accepted remote turn')

  observation = { playbackStatus: 'paused', libraryRevision: 'library-5' }
  const nextSnapshotQuery = { ...snapshotQuery, messageId: 'snapshot-message-2',
    body: { ...snapshotQuery.body, queryId: 'snapshot-query-2' } } as OperationalMessage
  await endpoint.messagePort.onMessage(context(nextSnapshotQuery, activeChannel))
  const next = out.at(-1)
  assert.equal(next?.kind, 'response', JSON.stringify(next))
  if (next?.kind !== 'response' || next.body.type !== 'snapshot') throw new Error('G3_UPDATED_SNAPSHOT_MISSING')
  const nextSnapshot = next.body.payload as Record<string, any>
  assert.equal(nextSnapshot.observedState.status, 'playing',
    'G3 checkpoint projection remains immutable for the same Player epoch and journal cursor')
  assert.equal(nextSnapshot.libraryRevision, 'library-4')
  assert.equal(nextSnapshot.stateRevision, firstSnapshot.stateRevision)
  assert.equal(nextSnapshot.controlEpoch, firstSnapshot.controlEpoch)

  const statusQuery: OperationalMessage = { protocolVersion: 1, schemaVersion: 1, kind: 'query',
    messageId: 'status-message', deviceId: playerId, controllerId,
    body: { queryId: 'status-query', type: 'operation-status', payload: { operationId: 'original-operation-id' } } }
  await endpoint.messagePort.onMessage(context(statusQuery, activeChannel))
  const status = out.at(-1)
  assert.equal(status?.kind, 'response')
  if (status?.kind !== 'response' || status.body.type !== 'operation-status') throw new Error('G3_STATUS_RESPONSE_MISSING')
  assert.deepEqual(status.body.payload, { operationId: 'original-operation-id', fingerprint: null,
    status: 'not-found', result: null, eventSequence: null })

  await endpoint.close()
})

test('Player G5 protocol rejects command, ACK, and media queries before G3 mutation paths', async t => {
  const directory = temp()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const endpoint = createMainPlayerOperationalEndpoint({ userDataDirectory: directory, deviceId: playerId,
    authorization: auth(), observe: () => ({ playbackStatus: 'idle', libraryRevision: 'library-0' }) })
  const out: OperationalMessage[] = []
  const activeChannel = channel(out)
  const command: OperationalMessage = { protocolVersion: 1, schemaVersion: 1, kind: 'command',
    messageId: 'command-message', deviceId: playerId, controllerId,
    body: { operationId: 'operation-never-admitted', type: 'pause',
      target: { sessionId: 'session', turnId: 'turn', controlEpoch: '7', playerEpoch: endpoint.playerEpoch,
        stateRevision: 0, occurrenceId: 'occurrence', attemptId: 'attempt' }, payload: {} } }
  const ack: OperationalMessage = { protocolVersion: 1, schemaVersion: 1, kind: 'ack',
    messageId: 'ack-message', deviceId: playerId, controllerId,
    body: { correlationId: 'ack-correlation', type: 'consumed',
      payload: { journalId: `journal-${playerId}`, throughSequence: 0, consumerId: controllerId } } }
  const mediaQuery: OperationalMessage = { protocolVersion: 1, schemaVersion: 1, kind: 'query',
    messageId: 'media-query-message', deviceId: playerId, controllerId,
    body: { queryId: 'media-query', type: 'media-availability', payload: { musicCode: '01234' } } }

  for (const message of [command, ack, mediaQuery]) {
    await endpoint.messagePort.onMessage(context(message, activeChannel))
    const denied = out.at(-1)
    assert.equal(denied?.kind, 'error')
    if (denied?.kind !== 'error') throw new Error('G5_OPERATIONAL_SCOPE_DENIAL_MISSING')
    assert.equal(denied.body.code, 'NOT_AUTHORIZED')
    assert.equal(denied.body.correlationId, message.messageId)
  }

  await endpoint.close()
})

test('G2 credential renewal preserves the Player-owned G4 control epoch', async t => {
  const directory = temp()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const endpoint = createMainPlayerOperationalEndpoint({ userDataDirectory: directory, deviceId: playerId,
    authorization: auth(), observe: () => ({ playbackStatus: 'idle', libraryRevision: 'library-0' }) })
  const snapshotQuery: OperationalMessage = { protocolVersion: 1, schemaVersion: 1, kind: 'query',
    messageId: 'snapshot-message', deviceId: playerId, controllerId,
    body: { queryId: 'snapshot-query', type: 'snapshot', payload: {} } }
  const observed: Array<Record<string, any>> = []
  const controlEpochs: string[] = []

  for (const generation of [1, 2]) {
    const out: OperationalMessage[] = []
    const activeChannel = channel(out, generation, `connection-${generation}`)
    await endpoint.messagePort.onMessage(context({ ...hello, messageId: `hello-${generation}` }, activeChannel))
    const ready = out.at(-1)
    assert.equal(ready?.kind, 'ready')
    if (ready?.kind !== 'ready') throw new Error('G4_RENEWED_READY_MISSING')
    assert.match(ready.body.controlEpoch, /^[0-9a-f-]{36}$/)
    assert.notEqual(ready.body.controlEpoch, String(generation),
      'G4 control epoch is an independent identifier, not the G2 credential generation')
    controlEpochs.push(ready.body.controlEpoch)

    await endpoint.messagePort.onMessage(context({ ...snapshotQuery, messageId: `snapshot-${generation}`,
      body: { ...snapshotQuery.body, queryId: `snapshot-query-${generation}` } }, activeChannel))
    const response = out.at(-1)
    assert.equal(response?.kind, 'response', JSON.stringify(response))
    if (response?.kind !== 'response' || response.body.type !== 'snapshot') throw new Error('G4_RENEWED_SNAPSHOT_MISSING')
    observed.push(response.body.payload as Record<string, any>)
    assert.equal(observed[generation - 1]?.controlEpoch, ready.body.controlEpoch,
      'the snapshot carries the same independent control epoch as this authorized channel handshake')
  }

  assert.equal(controlEpochs[0], controlEpochs[1],
    'G2 credential renewal is not a G4 authority/mode transition and keeps the Player-owned control epoch')
  assert.equal(observed[0]?.playerEpoch, observed[1]?.playerEpoch,
    'credential renewal does not invent a new Player operational process epoch')
  assert.equal(observed[0]?.hostEpoch, observed[1]?.hostEpoch,
    'credential renewal preserves the G4 host epoch while the Player process remains alive')
  assert.equal(observed[0]?.stateRevision, observed[1]?.stateRevision,
    'the durable G3 checkpoint remains immutable across G2 credential renewal')
  await endpoint.close()
})
