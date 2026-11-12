import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { REMOTE_CONTROL_SUBPROTOCOL, type RemoteAuthorizationPort, type RemoteDeviceIdentity } from '../src/remote-contracts'
import { createBootstrapChannel, connectPinnedControlChannel, requestPinnedHttps } from '../src/remote-clients'
import { generatePlayerCertificate, isPrivateIpv4, probeBootstrapCertificate } from '../src/remote-tls'
import { createRemoteTransportServer } from '../src/remote-transport'

const TOKEN = 'B'.repeat(43)

function firstPrivateInterface(): string | undefined {
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      const entry = entries?.find(value => value.family === 'IPv4' && !value.internal && isPrivateIpv4(value.address))
      if (entry) return entry.address
    }
  } catch { return undefined }
  return undefined
}

async function freeTcpPort(address: string): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, address, () => { server.removeListener('error', reject); resolve() })
  })
  const bound = server.address()
  assert.ok(bound && typeof bound !== 'string')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return bound.port
}

test('pinned HTTPS/WSS clients and restricted bootstrap work over an explicit private interface', {
  skip: !firstPrivateInterface() ? 'no eligible private IPv4 interface' : false
}, async () => {
  const address = firstPrivateInterface()
  assert.ok(address)
  const deviceId = randomUUID()
  const bundle = await generatePlayerCertificate(deviceId)
  const identity: RemoteDeviceIdentity = {
    schemaVersion: 1, role: 'player', deviceId, createdAt: new Date().toISOString(),
    certificatePem: bundle.certificatePem, certificateFingerprintSha256: bundle.fingerprintSha256,
    privateKeyPem: bundle.privateKeyPem
  }
  const authorized: RemoteAuthorizationPort = {
    async authorizeBearer(token, _connectionId, signal) {
      return !signal.aborted && token === TOKEN
        ? { controllerId: 'test-controller', credentialGeneration: 1, scopes: ['transport:control', 'test:read'] }
        : null
    },
    isCurrent(_peer, _connectionId, signal) { return !signal.aborted }
  }
  const bootstrapOperations: string[] = []
  const port = await freeTcpPort(address)
  const server = createRemoteTransportServer({ identity, address, port, authorization: authorized,
    bootstrap: { handle(context) {
      bootstrapOperations.push(context.operation)
      return { statusCode: 200, body: Buffer.from(JSON.stringify({ operation: context.operation })) }
    } },
    routes: [{ method: 'GET', path: '/v1/test', requiredScope: 'test:read',
      handle() { return { statusCode: 200, body: Buffer.from('{"ok":true}') } } }],
    messagePort: { onMessage() {} }
  })

  await server.listen()
  try {
    const pin = { certificatePem: identity.certificatePem!, fingerprintSha256: identity.certificateFingerprintSha256!,
      serverName: `player-${deviceId}.karaoke.invalid` }
    const response = await requestPinnedHttps({ address, port, pin, bearer: TOKEN, method: 'GET', path: '/v1/test' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body.toString()), { ok: true })

    const control = await connectPinnedControlChannel({ address, port, pin, bearer: TOKEN })
    assert.equal(control.ready.type, 'transport-ready')
    assert.equal(control.ready.transportVersion, 1)
    assert.equal(control.socket.protocol, REMOTE_CONTROL_SUBPROTOCOL)
    assert.ok(control.socket.listenerCount('error') > 0)
    assert.doesNotThrow(() => control.socket.emit('error', new Error('synthetic post-handshake failure')))
    const malformedClosed = once(control.socket, 'close')
    // A client frame must be masked. Exercise ws's real parser error on the server.
    ;(control.socket as unknown as { _socket: net.Socket })._socket.write(Buffer.from([0x81, 0x01, 0x61]))
    const [closeCode] = await malformedClosed
    assert.equal(closeCode, 1002)
    control.close()

    const candidate = await probeBootstrapCertificate(address, port)
    assert.equal(candidate.fingerprintSha256, pin.fingerprintSha256)
    assert.equal(candidate.deviceIdClaim, deviceId)
    const bootstrap = createBootstrapChannel({ address, port, candidatePin: candidate })
    try {
      const bootstrapResponse = await bootstrap.request('request', Buffer.from('{"pairing":"test"}'))
      assert.equal(bootstrapResponse.statusCode, 200)
      assert.deepEqual(JSON.parse(Buffer.from(bootstrapResponse.body).toString()), { operation: 'request' })
      assert.deepEqual(bootstrapOperations, ['request'])
    } finally { bootstrap.close() }

    const attacker = await generatePlayerCertificate(randomUUID())
    await assert.rejects(requestPinnedHttps({ address, port,
      pin: { certificatePem: attacker.certificatePem, fingerprintSha256: attacker.fingerprintSha256,
        serverName: attacker.serverName }, bearer: TOKEN, method: 'GET', path: '/v1/test' }))
  } finally { await server.close() }
})
