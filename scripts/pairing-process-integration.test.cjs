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
const { createBootstrapChannel } = require('../build/src/remote-clients.js')
const { generatePlayerCertificate } = require('../build/src/remote-tls.js')

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
    const playerFile = await fs.readFile(path.join(playerProfile, 'remote-authorization.json'), 'utf8')
    assert.equal(playerFile.includes(encodeBase64Url(managerToken)), false, 'the bearer is protected at rest')

    await stopPlayer(player)
    player = startPlayer(playerProfile, address)
    const restarted = await player.bus.next('ready')
    assert.equal(restarted.state.playerAuthority.phase, 'active')
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
    console.log('pairing-process-integration: PASS (separate Player/Management processes, real OPAQUE, wrong-code retry, bilateral persistence, restart, revocation)')
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
