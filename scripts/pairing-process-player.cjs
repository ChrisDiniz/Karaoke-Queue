'use strict'

const crypto = require('node:crypto')
const net = require('node:net')
const fs = require('node:fs/promises')
const path = require('node:path')
const { PairingBootstrapService } = require('../build/src/pairing-bootstrap.js')
const { PairingAuthorizationAdapter } = require('../build/src/pairing-authorization.js')
const { PairingStore } = require('../build/src/pairing-store.js')
const { generatePlayerCertificate } = require('../build/src/remote-tls.js')
const { createRemoteTransportServer } = require('../build/src/remote-transport.js')

class TestProtector {
  async assertAvailable() {}
  async encrypt(value) { return Buffer.from(`test-protected:${value}`) }
  async decrypt(value) {
    const text = Buffer.from(value).toString('utf8')
    if (!text.startsWith('test-protected:')) throw new Error('TEST_PROTECTOR_INVALID')
    return { plaintext: text.slice('test-protected:'.length), ciphertext: value, shouldReEncrypt: false }
  }
}

const profile = process.argv[2]
const address = process.argv[3]
const playerId = '22222222-2222-4222-8222-222222222222'
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
let displayedCode = ''
const certificate = (async () => {
  const identityFile = path.join(profile, 'pairing-test-identity.json')
  let bundle
  try { bundle = JSON.parse(await fs.readFile(identityFile, 'utf8')) }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error
    bundle = await generatePlayerCertificate(playerId)
    await fs.writeFile(identityFile, JSON.stringify(bundle), { mode: 0o600 })
  }
  const identity = { schemaVersion: 1, role: 'player', deviceId: playerId, createdAt: new Date().toISOString(),
    certificatePem: bundle.certificatePem, certificateFingerprintSha256: bundle.fingerprintSha256,
    privateKeyPem: bundle.privateKeyPem }
  const store = new PairingStore(profile, new TestProtector())
  const presentation = {
    approvedForProduction: true,
    requestConsent: async () => { process.send({ type: 'presentation', phase: 'consent' }); return true },
    showTemporaryCode: async value => {
      displayedCode = value.groupedCode.replace(' ', '')
      process.send({ type: 'presentation', phase: 'code-ready' })
    },
    closePairing: async value => process.send({ type: 'presentation', phase: value.outcome })
  }
  const service = new PairingBootstrapService(identity, store, presentation)
  const authorization = new PairingAuthorizationAdapter(store)
  const port = await availablePort(address)
  const server = createRemoteTransportServer({ identity, address, port, authorization,
    bootstrap: service, messagePort: { onMessage() {} } })
  await server.listen()
  process.on('message', async message => {
    try {
      if (message?.type === 'displayed-code') {
        process.send({ type: 'displayed-code', id: message.id, value: displayedCode })
      } else if (message?.type === 'snapshot') {
        const state = await store.read()
        process.send({ type: 'snapshot', id: message.id, state,
          unauthorized: await authorization.authorizeBearer(message.token ?? '', 'fixture', new AbortController().signal) === null })
      } else if (message?.type === 'revoke') {
        await authorization.revokeLocally()
        process.send({ type: 'revoked', id: message.id })
      } else if (message?.type === 'close') {
        await server.close()
        await service.close()
        process.send({ type: 'closed', id: message.id })
        process.disconnect()
      }
    } catch (error) {
      process.send({ type: 'failure', id: message?.id, code: error?.message ?? 'UNKNOWN' })
    }
  })
  const state = await store.read()
  process.send({ type: 'ready', deviceId: playerId, certificatePem: bundle.certificatePem,
    fingerprintSha256: bundle.fingerprintSha256, serverName: bundle.serverName, port, state })
})().catch(error => {
  process.stderr.write('PAIRING_PLAYER_FIXTURE_FATAL=' + (error?.stack ?? error?.message ?? 'UNKNOWN') + '\n')
  process.send({ type: 'fatal', code: error?.message ?? 'UNKNOWN' })
  process.exitCode = 1
})
