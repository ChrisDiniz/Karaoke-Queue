'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { PairingControllerClient } = require('../build/src/pairing-controller.js')
const { PairingStore } = require('../build/src/pairing-store.js')
const { encodeBase64Url } = require('../build/src/pairing-crypto.js')
const { parsePairingEnvelope } = require('../build/src/pairing-wire.js')
const { createBootstrapChannel, connectPinnedControlChannel } = require('../build/src/remote-clients.js')
const { generatePlayerCertificate } = require('../build/src/remote-tls.js')
const { createKaraokeDatabase } = require('../build/database.js')
const { ManagementRemoteOutbox } = require('../build/src/management-remote-outbox.js')
const { ManagementRemoteJournalInbox } = require('../build/src/management-remote-journal.js')
const { parseOperationalMessage } = require('../build/src/operational-protocol-validation.js')

class TestProtector {
  async assertAvailable() {}
  async encrypt(value) { return Buffer.from(`test-protected:${value}`) }
  async decrypt(value) {
    const text = Buffer.from(value).toString('utf8')
    if (!text.startsWith('test-protected:')) throw new Error('TEST_PROTECTOR_INVALID')
    return { plaintext: text.slice('test-protected:'.length), ciphertext: value, shouldReEncrypt: false }
  }
}

function messageBus(child, diagnostics = () => '') {
  const messages = []
  const waiters = []
  child.on('message', value => {
    const index = waiters.findIndex(waiter => waiter.match(value))
    if (index >= 0) waiters.splice(index, 1)[0].resolve(value)
    else messages.push(value)
  })
  child.on('exit', code => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`PLAYER_EXIT_${code}_WAITING_${waiter.type}: ${diagnostics()}`))
  })
  return {
    next(type, id) {
      const index = messages.findIndex(value => value?.type === type && (id === undefined || value.id === id))
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { type, match: value => value?.type === type && (id === undefined || value.id === id), resolve, reject }
        waiters.push(waiter)
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`PLAYER_MESSAGE_TIMEOUT_${type}`))
        }, 30_000)
        timer.unref()
        const originalResolve = waiter.resolve
        waiter.resolve = value => { clearTimeout(timer); originalResolve(value) }
      })
    }
  }
}

const fixture = path.join(__dirname, 'pairing-process-player.cjs')
const includeOperational = process.argv.includes('--operational')
function firstPrivateAddress() {
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      const entry = entries?.find(value => value.family === 'IPv4' && !value.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(value.address))
      if (entry) return entry.address
    }
  } catch { return undefined }
  return undefined
}
function startPlayer(profile, address) {
  const child = fork(fixture, [profile, address], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''
  const events = []
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const bus = messageBus(child, () => stderr)
  child.on('message', value => {
    if (value?.type === 'presentation') {
      events.push(value.phase)
      process.stdout.write('Player presentation fixture: ' + value.phase + '\n')
    }
  })
  return { child, bus, stderr: () => stderr, events }
}
function operationalMailbox(socket) {
  const messages = []
  const waiters = []
  let failed = null
  socket.on('message', (data, binary) => {
    try {
      if (binary) throw new Error('OPERATIONAL_BINARY_MESSAGE')
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      const message = parseOperationalMessage(bytes)
      const index = waiters.findIndex(waiter => waiter.match(message))
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
      else messages.push(message)
    } catch (error) { failed = error; for (const waiter of waiters.splice(0)) waiter.reject(error) }
  })
  socket.on('error', error => { failed = error; for (const waiter of waiters.splice(0)) waiter.reject(error) })
  socket.on('close', (code, reason) => {
    failed = failed ?? new Error(`OPERATIONAL_SOCKET_CLOSED_${code}_${reason.toString()}`)
    for (const waiter of waiters.splice(0)) waiter.reject(failed)
  })
  return { next(match) {
    if (failed) return Promise.reject(failed)
    const index = messages.findIndex(match)
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error('OPERATIONAL_MESSAGE_TIMEOUT'))
      }, 15_000)
      timer.unref()
      waiter.resolve = value => { clearTimeout(timer); resolve(value) }
      waiters.push(waiter)
    })
  } }
}

async function request(player, type, payload = {}) {
  const id = crypto.randomUUID()
  const responseType = type === 'revoke' ? 'revoked' : type
  const response = player.bus.next(responseType, id)
  player.child.send({ ...payload, type, id })
  const result = await response
  if (result.type === 'failure') throw new Error(result.code)
  return result
}

function channelFactory(dropTypes = []) {
  const drops = [...dropTypes]
  return (address, port, pin) => {
    const channel = createBootstrapChannel({ address, port, candidatePin: pin })
    return {
      async request(operation, body, signal) {
        const response = await channel.request(operation, body, signal)
        if (response.statusCode < 200 || response.statusCode >= 300) return response
        const envelope = parsePairingEnvelope(response.body)
        const index = drops.indexOf(envelope.type)
        if (index >= 0) {
          drops.splice(index, 1)
          throw new Error('TEST_ACK_LOST')
        }
        return response
      },
      close() { channel.close() }
    }
  }
}

async function stopPlayer(player) {
  if (!player || player.child.exitCode !== null) return
  const id = crypto.randomUUID()
  const closed = player.bus.next('closed', id)
  player.child.send({ type: 'close', id })
  await closed
  await new Promise(resolve => player.child.once('exit', resolve))
}

async function main() {
  const address = firstPrivateAddress()
  if (!address) {
    console.log('pairing-process-integration: NOT RUN (no RFC1918 IPv4 interface available)')
    return
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-g2-process-pairing-'))
  const playerProfile = path.join(root, 'player')
  const controllerProfile = path.join(root, 'controller')
  await fs.mkdir(playerProfile); await fs.mkdir(controllerProfile)
  const protector = new TestProtector()
  let player = startPlayer(playerProfile, address)
  let controllerClient
  try {
    const ready = await player.bus.next('ready')
    const candidate = { candidateId: crypto.randomUUID(), instanceName: 'player-test', displayName: 'Player de teste',
      deviceIdClaim: ready.deviceId, interfaceAddress: address, addresses: [address], port: ready.port,
      observedAt: Date.now(), expiresAt: Date.now() + 60_000, verified: false }
    const managerStore = new PairingStore(controllerProfile, protector)
    const wrongThenCorrect = async () => {
      const first = await request(player, 'snapshot', { token: '' })
      assert.equal(first.state.playerAuthority, null, 'deny-all remains before the final bilateral commit')
      assert.equal(first.unauthorized, true)
      const actual = (await request(player, 'displayed-code')).value
      if (typeof actual !== 'string' || !/^\d{8}$/.test(actual)) throw new Error('PAIRING_FIXTURE_CODE_FORMAT_INVALID')
      const wrong = actual === '00000000' ? '99999999' : '00000000'
      const entered = wrongThenCorrect.count++ === 0 ? wrong : actual
      return entered
    }
    wrongThenCorrect.count = 0
    const managerPresentationOutcomes = []
    const presentation = { approvedForProduction: true,
      async enterTemporaryCode() { return wrongThenCorrect() },
      async closePairing(value) { managerPresentationOutcomes.push(value.outcome) } }
    const clock = { monotonicNow: () => Number(process.hrtime.bigint() / 1_000_000n),
      wait: async milliseconds => {
        if (milliseconds === 6_000) await new Promise(resolve => setTimeout(resolve, milliseconds))
        else await new Promise(resolve => setImmediate(resolve))
      } }
    const attackerId = '33333333-3333-4333-8333-333333333333'
    const attacker = await generatePlayerCertificate(attackerId)
    const attackerPresentationOutcomes = []
    const attackerPresentation = { approvedForProduction: true,
      async enterTemporaryCode() { throw new Error('PAIRING_MUST_NOT_REACH_CODE_ENTRY') },
      async closePairing(value) { attackerPresentationOutcomes.push(value.outcome) } }
    const attackerClient = new PairingControllerClient(
      async () => ({ schemaVersion: 1, role: 'controller', deviceId: '11111111-1111-4111-8111-111111111111',
        createdAt: new Date().toISOString() }), managerStore, attackerPresentation, clock,
      async () => ({ certificatePem: attacker.certificatePem, fingerprintSha256: attacker.fingerprintSha256,
        serverName: attacker.serverName, deviceIdClaim: attackerId }), channelFactory())
    const falseDiscovery = { ...candidate, deviceIdClaim: attackerId }
    await assert.rejects(attackerClient.pair({ candidate: falseDiscovery, displayName: falseDiscovery.displayName, purpose: 'initial' }))
    assert.equal((await managerStore.read()).journals.length, 0, 'false mDNS identity cannot leave trust state')
    await attackerClient.close()
    assert.deepEqual(attackerPresentationOutcomes, [], 'closing an idle failed client does not report a spurious cancellation')
    const untouchedPlayer = await request(player, 'snapshot', { token: '' })
    assert.equal(untouchedPlayer.state.journals.length, 0, 'false certificate pin cannot reach the real Player')
    await attackerClient.close()

    controllerClient = new PairingControllerClient(
      async () => ({ schemaVersion: 1, role: 'controller', deviceId: '11111111-1111-4111-8111-111111111111',
        createdAt: new Date().toISOString() }), managerStore, presentation, clock,
      async () => ({ certificatePem: ready.certificatePem, fingerprintSha256: ready.fingerprintSha256,
        serverName: ready.serverName, deviceIdClaim: ready.deviceId }), channelFactory(['response/prepare', 'response/active']))
    const selection = { candidate, displayName: candidate.displayName, purpose: 'initial' }
    await assert.rejects(controllerClient.pair(selection), /TEST_ACK_LOST/)
    await assert.rejects(controllerClient.recover(selection), /TEST_ACK_LOST/)
    const paired = await controllerClient.recover(selection)
    assert.equal(paired.playerId, ready.deviceId)
    assert.equal(paired.phase, 'active-awaiting-reconciliation')
    assert.equal(wrongThenCorrect.count, 2, 'the first wrong code is retried as a fresh OPAQUE attempt')

    const savedManager = (await managerStore.read()).controllerAuthorities[ready.deviceId]
    assert.equal(savedManager.phase, 'active')
    const managerToken = await managerStore.decryptSecret(savedManager.encryptedToken)
    const activeSnapshot = await request(player, 'snapshot', { token: encodeBase64Url(managerToken) })
    assert.equal(activeSnapshot.state.playerAuthority.phase, 'active')
    assert.equal(activeSnapshot.unauthorized, false)

    if (includeOperational) {
      const managementDatabase = createKaraokeDatabase(controllerProfile)
      let managementDatabaseClosed = false
      const outbox = new ManagementRemoteOutbox(managementDatabase, {
      deviceId: '11111111-1111-4111-8111-111111111111', controllerId: '11111111-1111-4111-8111-111111111111'
    })
    let operationalChannel
    try {
      operationalChannel = await connectPinnedControlChannel({ address, port: ready.port,
        pin: { certificatePem: ready.certificatePem, fingerprintSha256: ready.fingerprintSha256, serverName: ready.serverName },
        bearer: encodeBase64Url(managerToken) })
      const mailbox = operationalMailbox(operationalChannel.socket)
      operationalChannel.socket.send(JSON.stringify({ protocolVersion: 1, schemaVersion: 1, kind: 'hello',
        messageId: crypto.randomUUID(), deviceId: ready.deviceId, controllerId: '11111111-1111-4111-8111-111111111111',
        body: { protocol: 'kq-operation/1', protocolVersion: 1, schemaVersion: 1 } }))
      const operationalReady = await mailbox.next(message => message.kind === 'ready')
      assert.equal(operationalReady.body.journalId, 'journal-' + ready.deviceId)

      const operationId = crypto.randomUUID()
      const commandMessage = { protocolVersion: 1, schemaVersion: 1, kind: 'command', messageId: crypto.randomUUID(),
        deviceId: ready.deviceId, controllerId: '11111111-1111-4111-8111-111111111111', body: {
          operationId, type: 'pause', target: { sessionId: 'session-process-test', turnId: 'LOG-1762900000000-AB12',
            controlEpoch: operationalReady.body.controlEpoch, playerEpoch: operationalReady.body.playerEpoch,
            stateRevision: 0, occurrenceId: 'occ-process-test', attemptId: 'attempt-process-test' }, payload: {} } }
      outbox.prepare(ready.deviceId, commandMessage)
      const acceptedEvent = mailbox.next(message => message.kind === 'event' && message.body.type === 'operation-result' &&
        message.body.payload.operationId === operationId && message.body.payload.status === 'accepted')
      const completedEvent = mailbox.next(message => message.kind === 'event' && message.body.type === 'operation-result' &&
        message.body.payload.operationId === operationId && message.body.payload.status === 'completed')
      outbox.transmit(ready.deviceId, operationId, { send(message) {
        operationalChannel.socket.send(JSON.stringify(message))
        return true
      } })
      await acceptedEvent
      await completedEvent
      assert.equal(outbox.get(ready.deviceId, operationId).status, 'unknown', 'lost application responses remain uncertain in the durable outbox')
      const firstExecutionCount = await request(player, 'execution-count')
      assert.equal(firstExecutionCount.value, 1)

      let retryMessage
      const statusResponse = mailbox.next(message => message.kind === 'response' && message.body.type === 'operation-status' &&
        message.body.payload.operationId === operationId)
      outbox.transmit(ready.deviceId, operationId, { send(message) {
        retryMessage = message
        operationalChannel.socket.send(JSON.stringify(message))
        return true
      } })
      const recovered = await statusResponse
      assert.equal(recovered.body.payload.status, 'completed')
      assert.equal(outbox.acceptStatus(ready.deviceId, recovered).status, 'completed')
      assert.equal(outbox.get(ready.deviceId, operationId).status, 'completed')
      assert.equal(retryMessage.body.operationId, operationId, 'retry preserves the original operation ID')
      const finalExecutionCount = await request(player, 'execution-count')
      assert.equal(finalExecutionCount.value, 1, 'Player dedupe prevents a second handler invocation')

      const journalInbox = new ManagementRemoteJournalInbox(managementDatabase, {
        controllerId: '11111111-1111-4111-8111-111111111111'
      })
      const pageResponsePromise = mailbox.next(message => message.kind === 'response' && message.body.type === 'journal-page')
      operationalChannel.socket.send(JSON.stringify({ protocolVersion: 1, schemaVersion: 1, kind: 'query',
        messageId: crypto.randomUUID(), deviceId: ready.deviceId, controllerId: '11111111-1111-4111-8111-111111111111',
        body: { queryId: crypto.randomUUID(), type: 'journal-page', payload: {
          journalId: operationalReady.body.journalId, afterSequence: 0, limit: 32 } } }))
      const pageResponse = await pageResponsePromise
      const durableCursor = journalInbox.persistPage(ready.deviceId, 0, pageResponse)
      assert.equal(durableCursor.throughSequence, 2)
      assert.deepEqual(journalInbox.readEvents(ready.deviceId, 0, 32).map(item => item.sequence), [1, 2])
      // This harness acts as a synthetic consumer only after its inbox commit and page assertions above.
      const ack = parseOperationalMessage(JSON.stringify({ protocolVersion: 1, schemaVersion: 1, kind: 'ack',
        messageId: crypto.randomUUID(), deviceId: ready.deviceId, controllerId: '11111111-1111-4111-8111-111111111111',
        body: { correlationId: crypto.randomUUID(), type: 'consumed', payload: { journalId: operationalReady.body.journalId,
          throughSequence: durableCursor.throughSequence, consumerId: '11111111-1111-4111-8111-111111111111' } } }))
      operationalChannel.socket.send(JSON.stringify(ack))
      const ackCommit = await player.bus.next('operational-ack-committed')
      assert.equal(ackCommit.throughSequence, 2)
      const playerCursor = await request(player, 'journal-cursor', { controllerId: '11111111-1111-4111-8111-111111111111' })
      assert.equal(playerCursor.value.throughSequence, 2, 'Player committed the consumer ACK received over real pinned WSS')
      managementDatabase.close()
      managementDatabaseClosed = true
      const reopenedManagementDatabase = createKaraokeDatabase(controllerProfile)
      try {
        const reopenedInbox = new ManagementRemoteJournalInbox(reopenedManagementDatabase, {
          controllerId: '11111111-1111-4111-8111-111111111111'
        })
        assert.equal(reopenedInbox.cursor(ready.deviceId).throughSequence, 2,
          'Management event page and cursor survive an independent database restart')
      } finally { reopenedManagementDatabase.close() }
      } finally {
        operationalChannel?.close()
        if (!managementDatabaseClosed) managementDatabase.close()
      }
    }
    const playerFile = await fs.readFile(path.join(playerProfile, 'remote-authorization.json'), 'utf8')
    assert.equal(playerFile.includes(encodeBase64Url(managerToken)), false, 'the bearer is protected at rest')

    await stopPlayer(player)
    player = startPlayer(playerProfile, address)
    const restarted = await player.bus.next('ready')
    assert.equal(restarted.state.playerAuthority.phase, 'active')
    if (includeOperational) {
      const persistedCursor = await request(player, 'journal-cursor', { controllerId: '11111111-1111-4111-8111-111111111111' })
      assert.equal(persistedCursor.value.throughSequence, 2, 'Player consumer cursor survives process restart')
    }
    const afterRestart = await request(player, 'snapshot', { token: encodeBase64Url(managerToken) })
    assert.equal(afterRestart.unauthorized, false, 'persisted active authority survives a Player restart')
    await request(player, 'revoke')
    await stopPlayer(player)
    player = startPlayer(playerProfile, address)
    const afterRevokeRestart = await player.bus.next('ready')
    assert.equal(afterRevokeRestart.state.playerAuthority.phase, 'revoked')
    const deniedAfterRestart = await request(player, 'snapshot', { token: encodeBase64Url(managerToken) })
    assert.equal(deniedAfterRestart.unauthorized, true, 'durable local revocation survives restart')
    await controllerClient.close()
    assert.deepEqual(managerPresentationOutcomes, ['active'], 'closing after commit does not relabel the completed pairing as cancelled')
    console.log(includeOperational
      ? 'pairing-process-integration: PASS (G2 pairing plus G3.3/G3.4 pinned TLS/WSS outbox retry, Player dedupe, event replay, ACK and independent persistence)'
      : 'pairing-process-integration: PASS (separate Player/Management processes, real OPAQUE, wrong-code retry, bilateral persistence, restart, revocation)')
  } finally {
    await controllerClient?.close().catch(() => undefined)
    await stopPlayer(player)
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
