'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const net = require('node:net')
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
const { MainRemoteReconnectionAdapter } = require('../build/src/main-remote-reconnection.js')
const { RemoteReconnectionService } = require('../build/src/remote-reconnection-service.js')
const { MainRemoteRuntime } = require('../build/src/main-remote-runtime.js')

class TestProtector {
  async assertAvailable() {}
  async encrypt(value) { return Buffer.from(`test-protected:${value}`) }
  async decrypt(value) {
    const text = Buffer.from(value).toString('utf8')
    if (!text.startsWith('test-protected:')) throw new Error('TEST_PROTECTOR_INVALID')
    return { plaintext: text.slice('test-protected:'.length), ciphertext: value, shouldReEncrypt: false }
  }
}

function testSafeStorage() {
  return {
    getSelectedStorageBackend() { return 'gnome_libsecret' },
    isEncryptionAvailable() { return true },
    async isAsyncEncryptionAvailable() { return true },
    encryptString(value) { return Buffer.from(`test-protected:${value}`) },
    async encryptStringAsync(value) { return Buffer.from(`test-protected:${value}`) },
    decryptString(value) {
      const text = Buffer.from(value).toString('utf8')
      if (!text.startsWith('test-protected:')) throw new Error('TEST_SAFE_STORAGE_INVALID')
      return text.slice('test-protected:'.length)
    },
    async decryptStringAsync(value) {
      const text = Buffer.from(value).toString('utf8')
      if (!text.startsWith('test-protected:')) throw new Error('TEST_SAFE_STORAGE_INVALID')
      return { result: text.slice('test-protected:'.length), shouldReEncrypt: false }
    }
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
      return this.nextWhere(value => value?.type === type && (id === undefined || value.id === id), type)
    },
    nextWhere(match, label = 'matching-message') {
      const index = messages.findIndex(match)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { type: label, match, resolve, reject }
        waiters.push(waiter)
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`PLAYER_MESSAGE_TIMEOUT_${label}`))
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
async function availablePort(address, excludePort) {
  let excludedListener
  if (excludePort !== undefined) {
    excludedListener = net.createServer()
    await new Promise((resolve, reject) => {
      excludedListener.once('error', reject)
      excludedListener.listen(excludePort, address, () => { excludedListener.removeListener('error', reject); resolve() })
    })
  }
  const listener = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, address, () => { listener.removeListener('error', reject); resolve() })
    })
    return listener.address().port
  } finally {
    await new Promise(resolve => listener.close(resolve))
    if (excludedListener) await new Promise(resolve => excludedListener.close(resolve))
  }
}
function startPlayer(profile, address, port) {
  const child = fork(fixture, [profile, address, String(port)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
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
function startManagementRuntime(profile, address) {
  const child = fork(path.join(__dirname, 'pairing-process-management.cjs'), [profile, address],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  return { child, bus: messageBus(child, () => stderr), stderr: () => stderr }
}
async function stopManagementRuntime(management) {
  if (!management || management.child.exitCode !== null) return
  const id = crypto.randomUUID()
  const closed = management.bus.next('closed', id)
  management.child.send({ type: 'close', id })
  const result = await closed
  if (result.type === 'failure') throw new Error(`MANAGEMENT_CLOSE_${result.code}`)
  await new Promise(resolve => management.child.once('exit', resolve))
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
  const responseType = type === 'revoke' ? 'revoked' : type === 'set-offline' ? 'remote-offline' :
    type === 'enable-remote' ? 'remote-enabled' : type === 'wait-operation-terminal' ? 'operation-terminal' : type
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
  const originalPlayerPort = await availablePort(address)
  let player = startPlayer(playerProfile, address, originalPlayerPort)
  let controllerClient
  try {
    const ready = await player.bus.next('ready')
    const controllerId = '11111111-1111-4111-8111-111111111111'
    await fs.writeFile(path.join(controllerProfile, 'remote-controller-identity.json'), JSON.stringify({
      schemaVersion: 1, role: 'controller', deviceId: controllerId, createdAt: new Date().toISOString()
    }), { mode: 0o600 })
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
      undefined, channelFactory(['response/prepare', 'response/active']))
    const selection = { candidate, displayName: candidate.displayName, purpose: 'initial' }
    await assert.rejects(controllerClient.pair(selection), /TEST_ACK_LOST/)
    await assert.rejects(controllerClient.recover(selection), /TEST_ACK_LOST/)
    const paired = await controllerClient.recover(selection)
    assert.equal(paired.playerId, ready.deviceId)
    assert.equal(paired.phase, 'active-awaiting-reconciliation')
    assert.equal(wrongThenCorrect.count, 2, 'the first wrong code is retried as a fresh OPAQUE attempt')
    let g4UnknownOperationId

    const savedManager = (await managerStore.read()).controllerAuthorities[ready.deviceId]
    assert.equal(savedManager.phase, 'active')
    const managerToken = await managerStore.decryptSecret(savedManager.encryptedToken)
    const activeSnapshot = await request(player, 'snapshot', { token: encodeBase64Url(managerToken) })
    assert.equal(activeSnapshot.state.playerAuthority.phase, 'active')
    assert.equal(activeSnapshot.unauthorized, false)

    let g4ExecutionCount
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
      const admittedFirst = player.bus.nextWhere(value => value.type === 'operation-admitted' &&
        value.operationId === operationId, 'first-operation-admitted')
      outbox.transmit(ready.deviceId, operationId, { send(message) {
        operationalChannel.socket.send(JSON.stringify(message))
        return true
      } })
      assert.equal((await admittedFirst).operationId, operationId,
        'Player Main durably admits the first synthetic intent before its handler runs')
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
      g4UnknownOperationId = crypto.randomUUID()
      const uncertainCommand = structuredClone(commandMessage)
      uncertainCommand.messageId = crypto.randomUUID()
      uncertainCommand.body.operationId = g4UnknownOperationId
      uncertainCommand.body.target = { ...uncertainCommand.body.target, turnId: 'LOG-1762900000001-CD34',
        occurrenceId: 'occ-unknown-test', attemptId: 'attempt-unknown-test' }
      outbox.prepare(ready.deviceId, uncertainCommand)
      const admittedUncertain = player.bus.nextWhere(value => value.type === 'operation-admitted' &&
        value.operationId === g4UnknownOperationId, 'uncertain-operation-admitted')
      outbox.transmit(ready.deviceId, g4UnknownOperationId, { send(message) {
        operationalChannel.socket.send(JSON.stringify(message))
        return true
      } })
      assert.equal((await admittedUncertain).operationId, g4UnknownOperationId,
        'Player durably admits the second synthetic operation before its execution result is observed')
      const terminalUncertain = await request(player, 'wait-operation-terminal', { controllerId, operationId: g4UnknownOperationId })
      assert.equal(terminalUncertain.drain.state, 'idle')
      assert.equal(terminalUncertain.status.status, 'completed', 'the Player has durable terminal evidence before Management restarts')
      assert.equal(outbox.get(ready.deviceId, g4UnknownOperationId).status, 'unknown')
      g4ExecutionCount = (await request(player, 'execution-count')).value
      assert.equal(g4ExecutionCount, 2, 'both deterministic synthetic operations execute once before G4 recovery')
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
    if (includeOperational) {
      let reconnectDatabase = createKaraokeDatabase(controllerProfile)
      const runtimeStatuses = []
      let resolveRuntimeSync
      let rejectRuntimeSync
      const runtimeSync = new Promise((resolve, reject) => { resolveRuntimeSync = resolve; rejectRuntimeSync = reject })
      const runtimeTimer = setTimeout(() => rejectRuntimeSync(new Error('G4_MAIN_RUNTIME_SYNC_TIMEOUT_' +
        JSON.stringify(runtimeStatuses.slice(-12)))), 20_000)
      runtimeTimer.unref()
      const remoteRuntime = new MainRemoteRuntime({ mode: 'controller', userDataDirectory: controllerProfile,
        safeStorage: testSafeStorage(), logger: {
          info(event, details) {
            if (event !== 'REMOTE_RECONNECTION_STATE') return
            runtimeStatuses.push(details)
            if (details.state === 'synchronized') resolveRuntimeSync(details)
          }, warn() {}, error() {}
        } })
      try {
        await remoteRuntime.setRemoteControlIntent('enabled')
        const reconnectStart = remoteRuntime.startManagementReconnection(reconnectDatabase, [address])
        const concurrentReconnectStart = remoteRuntime.startManagementReconnection(reconnectDatabase, [address])
        assert.strictEqual(concurrentReconnectStart, reconnectStart,
          'concurrent Main requests share the same startup task and cannot create a second coordinator')
        await reconnectStart
        const runtimeConnection = await runtimeSync
        clearTimeout(runtimeTimer)
        assert.ok(runtimeConnection.connectionId, 'Main runtime owns and reports the elected WSS connection')
        assert.equal(runtimeConnection.synchronized, true, 'Main runtime reports synchronization only after G3 reconciliation')
        const recoveredOperation = new ManagementRemoteOutbox(reconnectDatabase, {
          deviceId: controllerId, controllerId
        }).get(ready.deviceId, g4UnknownOperationId)
        assert.equal(recoveredOperation.status, 'completed',
          'Main-owned G4 queries the original operationId and recovers the durable result after its response was not applied')
        assert.equal((await request(player, 'execution-count')).value, g4ExecutionCount,
          'G4 status recovery does not invoke the synthetic physical handler again')
      } finally { clearTimeout(runtimeTimer); await remoteRuntime.close() }

      reconnectDatabase.close()
      const firstManagementRuntime = startManagementRuntime(controllerProfile, address)
      try {
        await firstManagementRuntime.bus.next('started')
        const firstProcessReconnect = await firstManagementRuntime.bus.next('synchronized')
        assert.ok(firstProcessReconnect.connectionId,
          'an independent Management Main process resumes the saved G2 authority and G4 runtime after restart')
      } finally { await stopManagementRuntime(firstManagementRuntime) }

      const restartedManagementRuntime = startManagementRuntime(controllerProfile, address)
      try {
        await restartedManagementRuntime.bus.next('started')
        const restartedManagementSync = await restartedManagementRuntime.bus.next('synchronized')
        assert.ok(restartedManagementSync.connectionId,
          'a second Management process recovers from the same durable intent and SQLite inbox')
      } finally { await stopManagementRuntime(restartedManagementRuntime) }
      reconnectDatabase = createKaraokeDatabase(controllerProfile)

      const adapter = new MainRemoteReconnectionAdapter(managerStore, '11111111-1111-4111-8111-111111111111', reconnectDatabase)
      const statusEvents = []
      const waitForStatus = predicate => {
        const existing = [...statusEvents].reverse().find(predicate)
        if (existing) return Promise.resolve(existing)
        return new Promise((resolve, reject) => {
          const waiter = { predicate, resolve, reject }
          const timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1);
            reject(new Error('G4_RECONNECTION_STATUS_TIMEOUT_' + JSON.stringify(statusEvents.slice(-12)))) }, 20_000)
          timer.unref()
          const originalResolve = waiter.resolve
          waiter.resolve = value => { clearTimeout(timer); originalResolve(value) }
          waiters.push(waiter)
        })
      }
      const waiters = []
      const service = new RemoteReconnectionService(adapter, undefined, status => {
        statusEvents.push(status)
        for (const waiter of [...waiters]) if (waiter.predicate(status)) {
          waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(status)
        }
      })
      try {
        const firstSynchronized = waitForStatus(status => status.state === 'synchronized')
        await service.start(await adapter.savedPeers())
        service.updateDiscovery([candidate])
        const first = await firstSynchronized
        assert.ok(first.connectionId, 'G4 coordinator elected the real pinned WSS connection after G3 ready and replay')
        const unknownBeforeRestart = new ManagementRemoteOutbox(reconnectDatabase, {
          deviceId: controllerId, controllerId
        }).get(ready.deviceId, g4UnknownOperationId)
        assert.equal(unknownBeforeRestart.status, 'completed', 'G4 reconciliation retains the terminal status after Management process restart')

        const oldConnectionId = first.connectionId
        const reconnected = waitForStatus(status => status.state === 'synchronized' && status.connectionId !== oldConnectionId)
        await stopPlayer(player)
        const replacementPort = await availablePort(address, originalPlayerPort)
        player = startPlayer(playerProfile, address, replacementPort)
        const restartedReady = await player.bus.next('ready')
        assert.notEqual(restartedReady.port, originalPlayerPort,
          'the controlled Player restart advertises a different port for the updated locator')
        service.updateDiscovery([{ ...candidate, port: restartedReady.port, addresses: [address],
          observedAt: Date.now(), expiresAt: Date.now() + 60_000 }])
        const second = await reconnected
        assert.notEqual(second.connectionId, oldConnectionId, 'restart fences the old WSS channel and elects a new one')
        assert.equal(second.state, 'synchronized', 'G4 completes snapshot, replay and status reconciliation after Player restart')
        const unknownAfterRestart = new ManagementRemoteOutbox(reconnectDatabase, {
          deviceId: controllerId, controllerId
        }).get(ready.deviceId, g4UnknownOperationId)
        assert.equal(unknownAfterRestart.status, 'completed', 'Player restart retains the authenticated terminal outcome')
        const count = await request(player, 'execution-count')
        assert.equal(count.value, 0, 'reconnect and status query execute no physical handler')
      } finally { await service.close(); reconnectDatabase.close() }

      // Restart both peers after the independent Management/Player recovery assertions above.
      await stopPlayer(player)
      player = startPlayer(playerProfile, address, originalPlayerPort)
      await player.bus.next('ready')
      const bothRestartedManagement = startManagementRuntime(controllerProfile, address)
      try {
        await bothRestartedManagement.bus.next('started')
        const bothRestartedSync = await bothRestartedManagement.bus.next('synchronized')
        assert.ok(bothRestartedSync.connectionId,
          'after both peers have stopped, saved authority and SQLite recovery converge on process restart')
      } finally { await stopManagementRuntime(bothRestartedManagement) }

      // G4.3: the Player's durable local offline choice must fence its real Main runtime
      // across process restart, and only an explicit local enable may reopen the pinned WSS.
      const offlineManagement = startManagementRuntime(controllerProfile, address)
      try {
        await offlineManagement.bus.next('started')
        const online = await offlineManagement.bus.next('synchronized')
        const offlineAcknowledged = await request(player, 'set-offline')
        assert.equal(offlineAcknowledged.type, 'remote-offline')
        await offlineManagement.bus.nextWhere(value => value.type === 'backoff' &&
          value.reason === 'REMOTE_CHANNEL_CLOSED', 'player-offline-channel-fenced')

        await stopPlayer(player)
        player = startPlayer(playerProfile, address, originalPlayerPort)
        const offlineRestart = await player.bus.next('ready')
        assert.equal(offlineRestart.remoteOffline, true,
          'the Player process reconstructs its explicit offline decision from durable local intent')
        const refusedWhileOffline = offlineManagement.bus.nextWhere(value => value.type === 'backoff' &&
          value.reason !== null && value.reason !== 'REMOTE_CHANNEL_CLOSED', 'offline-reconnect-refused')
        const nextSync = offlineManagement.bus.nextWhere(value => value.type === 'synchronized' &&
          value.connectionId !== online.connectionId, 'explicitly-enabled-runtime-resynchronized')
        const refusal = await refusedWhileOffline
        assert.notEqual(refusal.reason, null,
          'Management retries only the saved endpoint and receives a transport failure while Player remains offline')

        await request(player, 'enable-remote')
        const enabledSync = await nextSync
        assert.notEqual(enabledSync.connectionId, online.connectionId,
          'explicit local enable starts a fresh, fenced WSS channel without new pairing')
        assert.equal(enabledSync.details?.synchronized, true,
          'reopening the listener still requires G2 authorization and G3 reconciliation before synchronization')

        await request(player, 'set-offline')
        await offlineManagement.bus.nextWhere(value => value.type === 'backoff' &&
          value.reason === 'REMOTE_CHANNEL_CLOSED', 'offline-before-store-loss')
        await stopPlayer(player)
        await fs.writeFile(path.join(playerProfile, 'remote-control-intent.json'),
          JSON.stringify({ version: 1, intent: 'enabled', revision: 1 }))
        await fs.unlink(path.join(playerProfile, 'remote-control-intent.sqlite'))
        player = startPlayer(playerProfile, address, originalPlayerPort)
        const uncertainRestart = await player.bus.next('ready')
        assert.equal(uncertainRestart.remoteRecoveryRequired, true,
          'lost offline SQLite plus retained G2 identity blocks listener startup instead of importing stale enabled JSON')
        const refusedAfterLoss = await offlineManagement.bus.nextWhere(value => value.type === 'backoff' &&
          value.reason !== null && value.reason !== 'REMOTE_CHANNEL_CLOSED', 'lost-intent-reconnect-refused')
        assert.notEqual(refusedAfterLoss.reason, null)
        const stateId = crypto.randomUUID()
        const remoteState = offlineManagement.bus.next('remote-state-snapshot', stateId)
        offlineManagement.child.send({ type: 'get-remote-state', id: stateId })
        const blockedStatus = await remoteState
        assert.notEqual(blockedStatus.state?.state, 'synchronized',
          'Management has no authorized/synchronized channel while Player intent recovery is uncertain')
        assert.equal(blockedStatus.state?.connectionId, null,
          'an absent offline-intent store never leaves an authorized remote channel elected')
        assert.equal(blockedStatus.state?.synchronized, false)

        const recoveredSync = offlineManagement.bus.nextWhere(value => value.type === 'synchronized' &&
          value.connectionId !== enabledSync.connectionId, 'explicit-reenable-after-intent-recovery')
        await request(player, 'enable-remote')
        const afterExplicitRecovery = await recoveredSync
        assert.equal(afterExplicitRecovery.details?.synchronized, true,
          'a fresh explicit local choice restores the listener and normal G2/G3 reconciliation')
      } finally { await stopManagementRuntime(offlineManagement) }
    }
    const playerFile = await fs.readFile(path.join(playerProfile, 'remote-authorization.json'), 'utf8')
    assert.equal(playerFile.includes(encodeBase64Url(managerToken)), false, 'the bearer is protected at rest')

    await stopPlayer(player)
    player = startPlayer(playerProfile, address, originalPlayerPort)
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
    player = startPlayer(playerProfile, address, originalPlayerPort)
    const afterRevokeRestart = await player.bus.next('ready')
    assert.equal(afterRevokeRestart.state.playerAuthority.phase, 'revoked')
    const deniedAfterRestart = await request(player, 'snapshot', { token: encodeBase64Url(managerToken) })
    assert.equal(deniedAfterRestart.unauthorized, true, 'durable local revocation survives restart')
    if (includeOperational) {
      const revocationDatabase = createKaraokeDatabase(controllerProfile)
      const revocationAdapter = new MainRemoteReconnectionAdapter(managerStore, controllerId, revocationDatabase)
      const revocationStatuses = []
      let resolveRevokedReconnect
      const revokedReconnect = new Promise(resolve => { resolveRevokedReconnect = resolve })
      const revocationService = new RemoteReconnectionService(revocationAdapter, undefined, status => {
        revocationStatuses.push(status)
        if (status.state === 'conflict' && status.reason === 'REMOTE_AUTHORIZATION_REVOKED') resolveRevokedReconnect(status)
      })
      const revocationTimer = setTimeout(() => resolveRevokedReconnect(new Error('G4_REVOCATION_RECONNECT_TIMEOUT_' +
        JSON.stringify(revocationStatuses.slice(-12)))), 10_000)
      revocationTimer.unref()
      try {
        await revocationService.start(await revocationAdapter.savedPeers())
        revocationService.updateDiscovery([{ ...candidate, port: afterRevokeRestart.port, addresses: [address],
          observedAt: Date.now(), expiresAt: Date.now() + 60_000 }])
        const status = await revokedReconnect
        if (status instanceof Error) throw status
        assert.equal(status.state, 'conflict', 'G4 does not retry a revoked G2 bearer as a transient network failure')
        assert.equal(status.reason, 'REMOTE_AUTHORIZATION_REVOKED')
      } finally { clearTimeout(revocationTimer); await revocationService.close(); revocationDatabase.close() }
    }
    await controllerClient.close()
    assert.deepEqual(managerPresentationOutcomes, ['active'], 'closing after commit does not relabel the completed pairing as cancelled')
    console.log(includeOperational
      ? 'pairing-process-integration: PASS (G2 pairing, Main-owned G4 reconnect/restart/fencing, G3 replay and uncertain-operation preservation over pinned TLS/WSS, independent SQLite processes)'
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
