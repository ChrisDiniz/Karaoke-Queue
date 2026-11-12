const { RemoteIdentityStore } = require('../build/src/remote-identity-store.js')
const { createRemoteTransportServer } = require('../build/src/remote-transport.js')
const { requestPinnedHttps, connectPinnedControlChannel } = require('../build/src/remote-clients.js')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')

function privateAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    const entry = entries?.find(item => item.family === 'IPv4' && !item.internal &&
      (/^10\./.test(item.address) || /^192\.168\./.test(item.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(item.address)))
    if (entry) return entry.address
  }
  throw new Error('no private IPv4 interface for process integration')
}
async function availablePort(address) {
  const socket = net.createServer()
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(0, address, () => { socket.removeListener('error', reject); resolve() })
  })
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}

const token = 'P'.repeat(43)
const protector = {
  async assertAvailable() {},
  async encrypt(value) { return Buffer.from(`test-only:${value}`) },
  async decrypt(ciphertext) {
    const plaintext = Buffer.from(ciphertext).toString().slice('test-only:'.length)
    return { plaintext, ciphertext, shouldReEncrypt: false }
  }
}

async function main() {
  const [role, profile] = process.argv.slice(2)
  const store = new RemoteIdentityStore(profile, protector)
  if (role === 'player') {
    const identity = await store.loadOrCreatePlayerIdentity()
    const address = privateAddress()
    const port = await availablePort(address)
    const server = createRemoteTransportServer({
      identity, address, port,
      authorization: {
        async authorizeBearer(value, _id, signal) {
          return value === token && !signal.aborted
            ? { controllerId: 'synthetic-controller', credentialGeneration: 1, scopes: ['transport:control', 'test:read'] }
            : null
        },
        isCurrent(_peer, _id, signal) { return !signal.aborted }
      },
      routes: [{ method: 'GET', path: '/v1/process-test', requiredScope: 'test:read',
        handle() { return { statusCode: 200, body: Buffer.from('{"process":"player"}') } } }]
    })
    await server.listen()
    process.send({ type: 'ready', address, port, deviceId: identity.deviceId,
      certificatePem: identity.certificatePem, fingerprintSha256: identity.certificateFingerprintSha256,
      serverName: `player-${identity.deviceId}.karaoke.invalid` })
    process.once('message', async message => {
      if (message === 'close') { await server.close(); process.exit(0) }
    })
    return
  }
  if (role === 'controller') {
    const identity = await store.loadOrCreateControllerIdentity()
    process.once('message', async peer => {
      const pin = { certificatePem: peer.certificatePem, fingerprintSha256: peer.fingerprintSha256,
        serverName: peer.serverName }
      const response = await requestPinnedHttps({ address: peer.address, port: peer.port, pin,
        bearer: token, method: 'GET', path: '/v1/process-test' })
      const channel = await connectPinnedControlChannel({ address: peer.address, port: peer.port, pin, bearer: token })
      channel.close()
      process.send({ type: 'connected', controllerDeviceId: identity.deviceId,
        statusCode: response.statusCode, response: response.body.toString() })
      process.exit(0)
    })
    return
  }
  throw new Error('unknown role')
}

main().catch(error => { process.stderr.write(String(error.code || error.message)); process.exit(1) })
