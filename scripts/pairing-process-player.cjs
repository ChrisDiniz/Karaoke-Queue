'use strict'

const fs = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { MainRemoteRuntime } = require('../build/src/main-remote-runtime.js')
const { RemoteControlIntentStore } = require('../build/src/remote-control-intent.js')
const { generatePlayerCertificate } = require('../build/src/remote-tls.js')
const { PlayerOperationalStore } = require('../build/src/player-operational-store.js')
const { OperationalProtocolService } = require('../build/src/operational-protocol-service.js')
const protocolFixtures = require('../tests/fixtures/operational-v1/valid-messages.json')

const profile = process.argv[2]
const address = process.argv[3]
const requestedPort = process.argv[4] ? Number(process.argv[4]) : undefined
const playerId = '22222222-2222-4222-8222-222222222222'
const controllerId = '11111111-1111-4111-8111-111111111111'
const identityFile = path.join(profile, 'g4-player-runtime-identity.json')

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

function noOpAdvertiser() {
  return { async start() {}, async update() {}, async stop() {} }
}

async function availablePort(bindAddress) {
  const listener = net.createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, bindAddress, () => { listener.removeListener('error', reject); resolve() })
  })
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

async function main() {
  const port = requestedPort ?? await availablePort(address)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PLAYER_FIXTURE_PORT_INVALID')
  let executionCount = 0
  let runtime
  let pairingStore
  let authorization
  let operationalStore
  let operationalService
  let startOptions
  let identity
  let displayedCode = ''
  let remoteOffline = false
  let remoteRecoveryRequired = false
  const snapshotTemplate = structuredClone(protocolFixtures.find(value => value.kind === 'response' &&
    value.body.type === 'snapshot').body.payload)

  // Seed the same fixed device identity used by the process assertions through the real
  // RemoteIdentityStore on-disk schema. The private key remains protected by test safeStorage.
  // Bootstrap the fresh local intent before seeding a G2 identity, which is evidence of prior
  // remote initialization on subsequent process starts.
  await new RemoteControlIntentStore(profile).read()
  const storedIdentityPath = path.join(profile, 'remote-player-identity.json')
  try { await fs.access(storedIdentityPath) }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const certificate = await generatePlayerCertificate(playerId)
    const encryptedPrivateKey = testSafeStorage().encryptString(certificate.privateKeyPem)
    await fs.writeFile(storedIdentityPath, JSON.stringify({ schemaVersion: 1, role: 'player', deviceId: playerId,
      createdAt: new Date().toISOString(), certificatePem: certificate.certificatePem,
      certificateFingerprintSha256: certificate.fingerprintSha256,
      encryptedPrivateKey: encryptedPrivateKey.toString('base64') }) + '\n', { mode: 0o600 })
  }

  runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: profile, safeStorage: testSafeStorage(),
    createAdvertiser: noOpAdvertiser })
  const localIntent = await new RemoteControlIntentStore(profile).read()
  if (localIntent.intent !== 'offline' && localIntent.intent !== 'recovery_required') {
    await runtime.configurePlayerPairingPresentation({
      approvedForProduction: true,
      async requestConsent() { process.send({ type: 'presentation', phase: 'consent' }); return true },
      async showTemporaryCode(value) {
        displayedCode = value.groupedCode.replace(' ', '')
        process.send({ type: 'presentation', phase: 'code-ready' })
      },
      async closePairing(value) { process.send({ type: 'presentation', phase: value.outcome }) }
    })
  }
  pairingStore = runtime.createPairingStore()
  authorization = runtime.createPlayerPairingAuthorization()
  operationalStore = new PlayerOperationalStore({ userDataDirectory: profile,
    journalId: 'journal-' + playerId, deviceId: playerId, initializeIfMissing: true })
  const playerEpoch = 'player-epoch-' + process.pid
  operationalService = new OperationalProtocolService({ store: operationalStore, authorization,
    deviceId: playerId, playerEpoch,
    snapshotPort: { snapshot() {
      const metadata = operationalStore.getMetadata()
      return { ...snapshotTemplate, journalId: metadata.journalId, deviceId: playerId, playerEpoch,
        controlEpoch: '1', highWatermark: metadata.highWatermark, compactedThrough: metadata.compactedThrough }
    }, mediaAvailability() { return { available: false } } },
    isTargetCurrent: () => true,
    executionPort: { async execute() {
      executionCount++
      return { status: 'completed', state: 'synthetic-integration-handler' }
    } } })
  const observedOperationalMessagePort = { async onMessage(context) {
    await operationalService.onMessage(context)
    if (context.payload?.kind === 'command') process.send({ type: 'operation-admitted',
      operationId: context.payload.body.operationId })
    if (context.payload?.kind === 'ack') process.send({ type: 'operational-ack-committed',
      consumerId: context.payload.body.payload.consumerId, throughSequence: context.payload.body.payload.throughSequence })
  } }
  startOptions = { interfaceAddress: address, displayName: 'Player G4 fixture', port,
    authorization, messagePort: observedOperationalMessagePort }

  try { identity = await runtime.startPlayer(startOptions) }
  catch (error) {
    if (!(error instanceof Error) || !['REMOTE_PLAYER_EXPLICITLY_OFFLINE', 'REMOTE_PLAYER_INTENT_RECOVERY_REQUIRED']
        .includes(error.message)) throw error
    remoteOffline = error.message === 'REMOTE_PLAYER_EXPLICITLY_OFFLINE'
    remoteRecoveryRequired = error.message === 'REMOTE_PLAYER_INTENT_RECOVERY_REQUIRED'
    identity = JSON.parse(await fs.readFile(identityFile, 'utf8'))
  }
  if (!remoteOffline) await fs.writeFile(identityFile, JSON.stringify({ schemaVersion: 1, role: 'player',
    deviceId: identity.deviceId, certificatePem: identity.certificatePem,
    certificateFingerprintSha256: identity.certificateFingerprintSha256,
    serverName: `player-${identity.deviceId}.karaoke.invalid` }), { mode: 0o600 })

  process.on('message', async message => {
    try {
      if (message?.type === 'displayed-code') {
        process.send({ type: 'displayed-code', id: message.id, value: displayedCode })
      } else if (message?.type === 'snapshot') {
        const state = await pairingStore.read()
        process.send({ type: 'snapshot', id: message.id, state,
          unauthorized: await authorization.authorizeBearer(message.token ?? '', 'fixture', new AbortController().signal) === null })
      } else if (message?.type === 'revoke') {
        await authorization.revokeLocally()
        process.send({ type: 'revoked', id: message.id })
      } else if (message?.type === 'set-offline') {
        await runtime.setRemoteControlIntent('offline')
        remoteOffline = true
        process.send({ type: 'remote-offline', id: message.id, revision: 1 })
      } else if (message?.type === 'enable-remote') {
        await runtime.setRemoteControlIntent('enabled')
        authorization = runtime.createPlayerPairingAuthorization()
        startOptions = { ...startOptions, authorization }
        await runtime.startPlayer(startOptions)
        remoteOffline = false
        remoteRecoveryRequired = false
        process.send({ type: 'remote-enabled', id: message.id })
      } else if (message?.type === 'execution-count') {
        process.send({ type: 'execution-count', id: message.id, value: executionCount })
      } else if (message?.type === 'wait-operation-terminal') {
        const drain = await operationalService.waitForIdle(5000)
        const status = operationalStore.getOperationStatus({ controllerId: message.controllerId,
          operationId: message.operationId })
        process.send({ type: 'operation-terminal', id: message.id, drain, status })
      } else if (message?.type === 'journal-cursor') {
        process.send({ type: 'journal-cursor', id: message.id,
          value: operationalStore.getConsumerCursor(message.controllerId) })
      } else if (message?.type === 'close') {
        await runtime.close()
        await operationalService.close()
        operationalStore.close()
        process.send({ type: 'closed', id: message.id })
        process.disconnect()
      }
    } catch (error) {
      process.send({ type: 'failure', id: message?.id, code: error?.message ?? 'UNKNOWN' })
    }
  })

  const state = await pairingStore.read()
  process.send({ type: 'ready', deviceId: playerId, certificatePem: identity.certificatePem,
    fingerprintSha256: identity.certificateFingerprintSha256, serverName: identity.serverName ?? `player-${playerId}.karaoke.invalid`,
    port, remoteOffline, remoteRecoveryRequired, state })
}

main().catch(async error => {
  process.stderr.write('PAIRING_PLAYER_FIXTURE_FATAL=' + (error?.stack ?? error?.message ?? 'UNKNOWN') + '\n')
  process.send({ type: 'fatal', code: error?.message ?? 'UNKNOWN' })
  process.exitCode = 1
})
