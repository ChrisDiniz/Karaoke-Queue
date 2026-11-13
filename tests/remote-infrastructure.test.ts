import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import net from 'node:net'
import { randomUUID, X509Certificate } from 'node:crypto'
import { generate } from 'selfsigned'
import WebSocket from 'ws'
import { createPinnedHttpsAgent, generatePlayerCertificate, isPrivateIpv4, probeBootstrapCertificate,
  validatePlayerCertificate } from '../src/remote-tls'
import { RemoteIdentityStore } from '../src/remote-identity-store'
import { ElectronSafeStorageSecretProtector, type SafeStoragePort, type SecretProtector } from '../src/remote-secret-protector'
import { createRemoteTransportServer } from '../src/remote-transport'
import { candidateFromService, BonjourPlayerAdvertisementPort } from '../src/remote-discovery'
import { MainRemoteRuntime } from '../src/main-remote-runtime'
import { RemoteOperationalClient } from '../src/remote-operational-client'
import { REMOTE_CONTROL_PATH, REMOTE_CONTROL_SUBPROTOCOL, type RemoteAuthorizationPort,
  type RemoteDeviceIdentity, type RemoteHttpRoute, type RemoteTransportMessagePort } from '../src/remote-contracts'

const TOKEN = 'A'.repeat(43)
type DiscoveryService = Parameters<typeof candidateFromService>[0]

class FakeSecretProtector implements SecretProtector {
  available = true
  reencrypt = false
  async assertAvailable(): Promise<void> { if (!this.available) throw new Error('SECRET_STORAGE_UNAVAILABLE') }
  async encrypt(plaintext: string): Promise<Uint8Array> { return Buffer.from(`cipher:${plaintext}`, 'utf8') }
  async decrypt(ciphertext: Uint8Array) {
    const encoded = Buffer.from(ciphertext).toString('utf8')
    if (!encoded.startsWith('cipher:') && !encoded.startsWith('rotated:')) throw new Error('SECRET_STORAGE_DECRYPT_FAILED')
    const plaintext = encoded.slice(encoded.indexOf(':') + 1)
    if (this.reencrypt) return { plaintext, ciphertext: Buffer.from(`rotated:${plaintext}`), shouldReEncrypt: true }
    return { plaintext, ciphertext: Buffer.from(ciphertext), shouldReEncrypt: false }
  }
}

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kq-remote-infrastructure-'))
}

function firstPrivateIpv4Interface(): string | undefined {
  try {
    for (const interfaces of Object.values(os.networkInterfaces())) {
      const entry = interfaces?.find(value => value.family === 'IPv4' && !value.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(value.address))
      if (entry) return entry.address
    }
  } catch { return undefined }
  return undefined
}

async function availablePort(address: string): Promise<number> {
  const listener = net.createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, address, () => { listener.removeListener('error', reject); resolve() })
  })
  const port = (listener.address() as net.AddressInfo).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  return port
}

async function createPlayerIdentity(): Promise<RemoteDeviceIdentity> {
  const bundle = await generatePlayerCertificate(randomUUID())
  const deviceId = bundle.serverName.slice('player-'.length, -'.karaoke.invalid'.length)
  return {
    schemaVersion: 1, role: 'player', deviceId, createdAt: new Date().toISOString(),
    certificatePem: bundle.certificatePem, certificateFingerprintSha256: bundle.fingerprintSha256,
    privateKeyPem: bundle.privateKeyPem
  }
}

function authorizedPort(isCurrent: () => boolean = () => true): RemoteAuthorizationPort {
  return {
    async authorizeBearer(token, _connectionId, signal) {
      if (signal.aborted || token !== TOKEN) return null
      return { controllerId: 'controller-test', credentialGeneration: 1, scopes: ['transport:control', 'test:read'] }
    },
    isCurrent(_peer, _connectionId, signal) { return !signal.aborted && isCurrent() }
  }
}

async function startServer(options: {
  address?: string
  port?: number
  authorization?: RemoteAuthorizationPort
  routes?: readonly RemoteHttpRoute[]
  messagePort?: RemoteTransportMessagePort
} = {}) {
  const identity = await createPlayerIdentity()
  const server = createRemoteTransportServer({
    identity, address: options.address ?? '127.0.0.1', port: options.port ?? 0,
    authorization: options.authorization,
    routes: options.routes,
    messagePort: options.messagePort
  })
  await server.listen()
  const address = server.address()
  assert.ok(address)
  return { server, identity, address }
}

function openWebSocket(address: string, port: number, identity: RemoteDeviceIdentity, headers: Record<string, string> = {}) {
  const pin = {
    certificatePem: identity.certificatePem!,
    fingerprintSha256: identity.certificateFingerprintSha256!,
    serverName: `player-${identity.deviceId}.karaoke.invalid`
  }
  const socket = new WebSocket(`wss://${address}:${port}${REMOTE_CONTROL_PATH}`, REMOTE_CONTROL_SUBPROTOCOL, {
    agent: createPinnedHttpsAgent(pin), headers, perMessageDeflate: false, followRedirects: false,
    handshakeTimeout: 3000
  })
  return socket
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data, binary) => binary ? reject(new Error('unexpected binary message')) : resolve(data.toString()))
    socket.once('error', reject)
  })
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
}

function requestHttps(options: {
  address: string; port: number; identity: RemoteDeviceIdentity; method?: string; requestPath: string;
  headers?: Record<string, string | string[]>; body?: string
}): Promise<{ statusCode: number; body: string }> {
  const pin = { certificatePem: options.identity.certificatePem!,
    fingerprintSha256: options.identity.certificateFingerprintSha256!,
    serverName: `player-${options.identity.deviceId}.karaoke.invalid` }
  const agent = createPinnedHttpsAgent(pin)
  return new Promise((resolve, reject) => {
    const request = https.request({ host: options.address, port: options.port,
      method: options.method ?? 'GET', path: options.requestPath, agent, headers: options.headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', value => chunks.push(Buffer.from(value)))
      response.once('end', () => { agent.destroy(); resolve({
        statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8')
      }) })
    })
    request.once('error', error => { agent.destroy(); reject(error) })
    if (options.body) request.write(options.body)
    request.end()
  })
}

test('Player certificate is RSA-2048/SHA-256 with valid positive serial and DER SHA-256 pin', async () => {
  const deviceId = randomUUID()
  const bundle = await generatePlayerCertificate(deviceId)
  const certificate = new X509Certificate(bundle.certificatePem)
  const serial = BigInt(`0x${certificate.serialNumber.replace(/:/g, '')}`)
  assert.ok(serial > 0n)
  assert.equal(certificate.publicKey.asymmetricKeyType, 'rsa')
  assert.equal(certificate.publicKey.asymmetricKeyDetails?.modulusLength, 2048)
  assert.equal(certificate.signatureAlgorithm, 'sha256WithRSAEncryption')
  assert.equal(bundle.serverName, `player-${deviceId}.karaoke.invalid`)
  assert.equal(certificate.subjectAltName, `DNS:${bundle.serverName}`)
  assert.equal(bundle.fingerprintSha256,
    (await import('node:crypto')).createHash('sha256').update(certificate.raw).digest('hex'))
  assert.notEqual(bundle.fingerprintSha256, certificate.fingerprint,
    'the generated pin is SHA-256 DER, not selfsigned’s SHA-1 fingerprint')
  assert.equal(validatePlayerCertificate(bundle.certificatePem, bundle.privateKeyPem, deviceId).fingerprintSha256,
    bundle.fingerprintSha256)
  assert.throws(() => validatePlayerCertificate(bundle.certificatePem, bundle.privateKeyPem, randomUUID()),
    /REMOTE_CERTIFICATE_IDENTITY_MISMATCH/)
  assert.throws(() => validatePlayerCertificate(bundle.certificatePem, 'not a private key'),
    /REMOTE_PRIVATE_KEY_INVALID/)
})

test('expired and altered certificates fail closed', async () => {
  const now = new Date()
  const expired = await generate([{ name: 'commonName', value: 'player-expired.karaoke.invalid' }], {
    keySize: 2048, algorithm: 'sha256', notBeforeDate: new Date(now.valueOf() - 10 * 86400000),
    notAfterDate: new Date(now.valueOf() - 86400000),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'player-expired.karaoke.invalid' }] }]
  })
  assert.throws(() => validatePlayerCertificate(expired.cert), /REMOTE_CERTIFICATE_EXPIRED_OR_INVALID/)
  const malformedSan = await generate([{ name: 'commonName', value: 'player-not-a-uuid.karaoke.invalid' }], {
    keySize: 2048, algorithm: 'sha256', notBeforeDate: new Date(now.valueOf() - 1000),
    notAfterDate: new Date(now.valueOf() + 86400000),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'player-not-a-uuid.karaoke.invalid' }] }]
  })
  assert.throws(() => validatePlayerCertificate(malformedSan.cert), /REMOTE_CERTIFICATE_SAN_INVALID/)
  const valid = await generatePlayerCertificate(randomUUID())
  const corrupted = valid.certificatePem.replace(/MI[A-Za-z0-9+/=]{8}/, 'AA' + 'A'.repeat(8))
  assert.throws(() => validatePlayerCertificate(corrupted), /REMOTE_CERTIFICATE_(INVALID|SIGNATURE_INVALID)/)
})

test('private endpoint policy accepts only RFC1918 IPv4 and loopback test bindings', () => {
  assert.equal(isPrivateIpv4('10.3.4.5'), true)
  assert.equal(isPrivateIpv4('172.31.4.5'), true)
  assert.equal(isPrivateIpv4('192.168.4.5'), true)
  assert.equal(isPrivateIpv4('127.0.0.1'), false)
  assert.equal(isPrivateIpv4('127.0.0.1', true), true)
  assert.equal(isPrivateIpv4('169.254.2.3'), false)
  assert.equal(isPrivateIpv4('8.8.8.8'), false)
  assert.equal(isPrivateIpv4('224.0.0.1'), false)
})

test('mDNS candidates are bounded, subnet-filtered and never treated as verified identity', () => {
  const service = {
    name: 'Karaoke Player', type: 'kq-player', protocol: 'tcp', port: 4231,
    host: 'untrusted.local', fqdn: 'Karaoke-fake._kq-player._tcp.local',
    txt: { version: '1', deviceId: randomUUID(), name: ' Player\u0000 A ' },
    addresses: ['192.168.1.42', '8.8.8.8', '192.168.1.42'], ttl: 999
  } as unknown as DiscoveryService
  const candidate = candidateFromService(service, { address: '192.168.1.20', netmask: '255.255.255.0' }, 1000)
  assert.ok(candidate)
  assert.equal(candidate.verified, false)
  assert.equal(candidate.displayName, 'Player A')
  assert.deepEqual(candidate.addresses, ['192.168.1.42'])
  assert.ok(candidate.expiresAt <= 121000)

  const forgedClaim = candidateFromService({ ...service, txt: { ...service.txt, deviceId: 'controller-admin' } } as DiscoveryService,
    { address: '192.168.1.20', netmask: '255.255.255.0' }, 2000)
  assert.equal(forgedClaim?.deviceIdClaim, null)
  assert.equal(candidateFromService({ ...service, txt: { ...service.txt, version: '99' } } as DiscoveryService,
    { address: '192.168.1.20', netmask: '255.255.255.0' }), undefined)
  assert.equal(candidateFromService({ ...service, addresses: ['8.8.8.8'] } as DiscoveryService,
    { address: '192.168.1.20', netmask: '255.255.255.0' }), undefined)
})

test('mDNS Player publisher emits bounded DNS-SD records and a TTL-zero goodbye', async () => {
  const node = new EventEmitter() as EventEmitter & {
    respond(packet: { answers: Array<{ name: string; type: string; ttl: number; data: unknown }>; additionals?: Array<unknown> }, callback?: (error?: Error) => void): void
    destroy(callback?: () => void): void
  }
  const packets: Array<{ answers: Array<{ name: string; type: string; ttl: number; data: unknown }>; additionals?: Array<unknown> }> = []
  let destroyed = false
  node.respond = (packet, callback) => { packets.push(packet); callback?.() }
  node.destroy = callback => { destroyed = true; callback?.() }
  const advertiser = new BonjourPlayerAdvertisementPort(undefined, ((options: { interface: string; bind: '0.0.0.0'; reuseAddr: true }) => {
    assert.deepEqual(options, { interface: '192.168.4.10', bind: '0.0.0.0', reuseAddr: true })
    return node
  }) as never,
    address => ({ address, netmask: '255.255.255.0' }))
  const deviceId = randomUUID()
  await advertiser.start({ deviceId, displayName: '🎤'.repeat(64), address: '192.168.4.10', port: 47831 })
  assert.equal(packets.length, 1)
  assert.equal(packets[0].answers.length, 4)
  assert.deepEqual(packets[0].answers.map(record => record.type), ['PTR', 'SRV', 'TXT', 'A'])
  const txtRecord = packets[0].answers.find(record => record.type === 'TXT')
  assert.ok(txtRecord && Array.isArray(txtRecord.data))
  assert.ok((txtRecord.data as Buffer[]).some(value => value.toString() === `deviceId=${deviceId}`))
  assert.ok((txtRecord.data as Buffer[]).every(value => value.byteLength <= 255))

  node.emit('query', { questions: [{ name: '_kq-player._tcp.local', type: 'PTR' }] }, { address: '8.8.8.8' })
  assert.equal(packets.length, 1, 'public-source queries are ignored')
  node.emit('query', { questions: [{ name: '_kq-player._tcp.local', type: 'PTR' }] }, { address: '192.168.4.20' })
  assert.equal(packets.length, 2)
  assert.equal(packets[1].answers[0].type, 'PTR')
  assert.ok((packets[1].additionals?.length ?? 0) > 0)

  await advertiser.stop()
  assert.equal(destroyed, true)
  assert.equal(packets.length, 3)
  assert.ok(packets[2].answers.every(record => record.ttl === 0))
})

test('mDNS Player publisher withdraws the old endpoint before announcing a DHCP address update', async () => {
  type Packet = { answers: Array<{ name: string; type: string; ttl: number; data: unknown }>; additionals?: Array<unknown> }
  const nodes: Array<EventEmitter & {
    packets: Packet[]
    destroyed: boolean
    respond(packet: Packet, callback?: (error?: Error) => void): void
    destroy(callback?: () => void): void
  }> = []
  const advertiser = new BonjourPlayerAdvertisementPort(undefined, ((options: { interface: string; bind: '0.0.0.0'; reuseAddr: true }) => {
    assert.equal(options.bind, '0.0.0.0')
    assert.equal(options.reuseAddr, true)
    const node = new EventEmitter() as typeof nodes[number]
    node.packets = []
    node.destroyed = false
    node.respond = (packet, callback) => { node.packets.push(packet); callback?.() }
    node.destroy = callback => { node.destroyed = true; callback?.() }
    nodes.push(node)
    return node
  }) as never, address => ({ address, netmask: '255.255.255.0' }))
  const deviceId = randomUUID()
  await advertiser.start({ deviceId, displayName: 'Player', address: '192.168.4.10', port: 47831 })
  await advertiser.update({ deviceId, displayName: 'Player', address: '192.168.4.11', port: 47831 })
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].destroyed, true)
  assert.ok(nodes[0].packets[1].answers.every(record => record.ttl === 0))
  assert.equal(nodes[1].packets[0].answers.find(record => record.type === 'A')?.data, '192.168.4.11')
  await advertiser.stop()
  assert.ok(nodes[1].packets.at(-1)?.answers.every(record => record.ttl === 0))
  assert.ok(nodes.every(node => node.destroyed))
})

test('mDNS publisher stop waits for an in-flight DHCP update and leaves no restarted socket', async () => {
  type Packet = { answers: Array<{ name: string; type: string; ttl: number; data: unknown }>; additionals?: Array<unknown> }
  const nodes: Array<EventEmitter & {
    packets: Packet[]
    destroyed: boolean
    respond(packet: Packet, callback?: (error?: Error) => void): void
    destroy(callback?: () => void): void
  }> = []
  let signalGoodbye!: () => void
  let releaseGoodbye!: () => void
  let holdFirstGoodbye = true
  const goodbyeStarted = new Promise<void>(resolve => { signalGoodbye = resolve })
  const advertiser = new BonjourPlayerAdvertisementPort(undefined, (() => {
    const node = new EventEmitter() as typeof nodes[number]
    node.packets = []
    node.destroyed = false
    node.respond = (packet, callback) => {
      node.packets.push(packet)
      if (holdFirstGoodbye && packet.answers.length > 0 && packet.answers.every(record => record.ttl === 0)) {
        holdFirstGoodbye = false
        signalGoodbye()
        releaseGoodbye = () => callback?.()
        return
      }
      callback?.()
    }
    node.destroy = callback => { node.destroyed = true; callback?.() }
    nodes.push(node)
    return node
  }) as never, address => ({ address, netmask: '255.255.255.0' }))
  const deviceId = randomUUID()
  await advertiser.start({ deviceId, displayName: 'Player', address: '192.168.4.10', port: 47831 })

  const updating = advertiser.update({ deviceId, displayName: 'Player', address: '192.168.4.11', port: 47831 })
  await goodbyeStarted
  let stopFinished = false
  const stopping = advertiser.stop().then(() => { stopFinished = true })
  await Promise.resolve()
  assert.equal(stopFinished, false, 'stop must wait behind the in-flight update')
  releaseGoodbye()
  await Promise.all([updating, stopping])

  assert.equal(nodes.length, 2)
  assert.ok(nodes.every(node => node.destroyed), 'the newly announced socket is closed before stop resolves')
  await assert.rejects(advertiser.update({ deviceId, displayName: 'Player', address: '192.168.4.12', port: 47831 }),
    /REMOTE_ADVERTISEMENT_STOPPED/)
})

test('identity is durable, secret-protected, coalesced and does not regenerate corrupt state', async () => {
  const directory = await temporaryDirectory()
  const protector = new FakeSecretProtector()
  const store = new RemoteIdentityStore(directory, protector)
  try {
    const [first, concurrent] = await Promise.all([store.loadOrCreatePlayerIdentity(), store.loadOrCreatePlayerIdentity()])
    assert.equal(first.deviceId, concurrent.deviceId)
    assert.ok(first.privateKeyPem)
    const identityPath = path.join(directory, 'remote-player-identity.json')
    const stored = await fs.readFile(identityPath, 'utf8')
    assert.equal(stored.includes(first.privateKeyPem!), false)
    assert.equal(JSON.parse(stored).certificateFingerprintSha256, first.certificateFingerprintSha256)
    if (process.platform !== 'win32') assert.equal((await fs.stat(identityPath)).mode & 0o777, 0o600)

    const reencrypting = new FakeSecretProtector()
    reencrypting.reencrypt = true
    const reloaded = await new RemoteIdentityStore(directory, reencrypting).loadOrCreatePlayerIdentity()
    assert.equal(reloaded.deviceId, first.deviceId)
    assert.equal((await fs.readFile(identityPath, 'utf8')).includes('rotated:'), false,
      'the updated protected blob remains base64 encoded in the durable record')
    const reencrypted = JSON.parse(await fs.readFile(identityPath, 'utf8'))
    assert.ok(Buffer.from(reencrypted.encryptedPrivateKey, 'base64').toString('utf8').startsWith('rotated:'))

    await fs.writeFile(identityPath, '{broken', 'utf8')
    await assert.rejects(new RemoteIdentityStore(directory, protector).loadOrCreatePlayerIdentity(),
      /REMOTE_IDENTITY_FILE_INVALID/)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('identity creation fails closed when secure storage is unavailable or persistence fails', async () => {
  const directory = await temporaryDirectory()
  const unavailable = new FakeSecretProtector()
  unavailable.available = false
  try {
    await assert.rejects(new RemoteIdentityStore(directory, unavailable).loadOrCreatePlayerIdentity(),
      /SECRET_STORAGE_UNAVAILABLE/)
    assert.equal((await fs.readdir(directory)).length, 0)
    const blockedPath = path.join(directory, 'not-a-directory')
    await fs.writeFile(blockedPath, 'x')
    const store = new RemoteIdentityStore(blockedPath, new FakeSecretProtector())
    await assert.rejects(store.loadOrCreatePlayerIdentity())
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('safeStorage uses Windows async re-encryption and rejects Linux basic_text backend', async () => {
  let asyncEncrypted = 0
  const windowsStorage: SafeStoragePort = {
    async isAsyncEncryptionAvailable() { return true }, isEncryptionAvailable() { return true },
    getSelectedStorageBackend() { return 'unknown' },
    async encryptStringAsync(value) { asyncEncrypted++; return Buffer.from(`win:${value}`) },
    async decryptStringAsync() { return { result: 'secret', shouldReEncrypt: true } },
    encryptString(value) { return Buffer.from(value) }, decryptString() { return 'unused' }
  }
  const windows = new ElectronSafeStorageSecretProtector(windowsStorage, 'win32')
  const result = await windows.decrypt(Buffer.from('old-cipher'))
  assert.equal(result.plaintext, 'secret')
  assert.equal(result.shouldReEncrypt, true)
  assert.equal(Buffer.from(result.ciphertext).toString(), 'win:secret')
  assert.equal(asyncEncrypted, 1)

  let plaintextFallbackCalled = false
  const linuxStorage: SafeStoragePort = {
    async isAsyncEncryptionAvailable() { return true }, isEncryptionAvailable() { return true },
    getSelectedStorageBackend() { return 'basic_text' },
    async encryptStringAsync() { return Buffer.from('unused') },
    async decryptStringAsync() { return { result: 'unused', shouldReEncrypt: false } },
    encryptString() { plaintextFallbackCalled = true; return Buffer.from('unsafe') },
    decryptString() { plaintextFallbackCalled = true; return 'unsafe' }
  }
  const linux = new ElectronSafeStorageSecretProtector(linuxStorage, 'linux')
  await assert.rejects(linux.encrypt('secret'), /SECRET_STORAGE_UNAVAILABLE/)
  assert.equal(plaintextFallbackCalled, false)
})

test('transport denies control by default and enforces authenticated closed-version hello', async () => {
  const denied = await startServer()
  try {
    const unauthorized = openWebSocket('127.0.0.1', denied.address.port, denied.identity, { Authorization: `Bearer ${TOKEN}` })
    const status = await new Promise<number>((resolve, reject) => {
      unauthorized.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0) })
      unauthorized.once('error', reject)
    })
    assert.equal(status, 401)
  } finally { await denied.server.close() }

  const authorized = await startServer({ authorization: authorizedPort() })
  try {
    const client = openWebSocket('127.0.0.1', authorized.address.port, authorized.identity, { Authorization: `Bearer ${TOKEN}` })
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    const readyPromise = nextMessage(client)
    client.send(JSON.stringify({ type: 'transport-hello', transportVersion: 1, capabilities: [] }))
    assert.deepEqual(JSON.parse(await readyPromise), { type: 'transport-ready', transportVersion: 1, capabilities: [] })
    const closed = waitForClose(client)
    client.send(JSON.stringify({ type: 'not-a-g1-message' }))
    assert.equal((await closed).code, 1008)
  } finally { await authorized.server.close() }
})

test('transport rejects incompatible hello and invalid payload without dispatching messages', async () => {
  let dispatched = 0
  const state = { current: true }
  const fixture = await startServer({ authorization: authorizedPort(() => state.current),
    messagePort: { onMessage() { dispatched++ } } })
  try {
    const client = openWebSocket('127.0.0.1', fixture.address.port, fixture.identity, { Authorization: `Bearer ${TOKEN}` })
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    const closed = waitForClose(client)
    client.send(JSON.stringify({ type: 'transport-hello', transportVersion: 2, capabilities: [] }))
    assert.equal((await closed).code, 1002)
    assert.equal(dispatched, 0)

    const second = openWebSocket('127.0.0.1', fixture.address.port, fixture.identity, { Authorization: `Bearer ${TOKEN}` })
    await new Promise<void>((resolve, reject) => { second.once('open', resolve); second.once('error', reject) })
    const ready = nextMessage(second)
    second.send(JSON.stringify({ type: 'transport-hello', transportVersion: 1, capabilities: [] }))
    await ready
    const malformed = waitForClose(second)
    second.send('{invalid-json')
    assert.equal((await malformed).code, 1007)
    assert.equal(dispatched, 0)
  } finally { await fixture.server.close() }
})

test('WSS admits only one authorized control connection and rechecks revocation per message', async () => {
  let current = true
  let dispatched = 0
  let dispatchResolved: (() => void) | undefined
  const fixture = await startServer({ authorization: authorizedPort(() => current),
    messagePort: { onMessage() { dispatched++; dispatchResolved?.() } } })
  try {
    const first = openWebSocket('127.0.0.1', fixture.address.port, fixture.identity, { Authorization: `Bearer ${TOKEN}` })
    await new Promise<void>((resolve, reject) => { first.once('open', resolve); first.once('error', reject) })
    const firstReady = nextMessage(first)
    first.send(JSON.stringify({ type: 'transport-hello', transportVersion: 1, capabilities: [] }))
    await firstReady

    const second = openWebSocket('127.0.0.1', fixture.address.port, fixture.identity, { Authorization: `Bearer ${TOKEN}` })
    const conflictStatus = await new Promise<number>((resolve, reject) => {
      second.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0) })
      second.once('error', reject)
    })
    assert.equal(conflictStatus, 409)

    const firstDispatch = new Promise<void>(resolve => { dispatchResolved = resolve })
    first.send(JSON.stringify({ protocolVersion: 1, schemaVersion: 1, kind: 'hello', messageId: 'm-1',
      deviceId: fixture.identity.deviceId, controllerId: 'controller-test',
      body: { protocol: 'kq-operation/1', protocolVersion: 1, schemaVersion: 1 } }))
    await firstDispatch
    dispatchResolved = undefined
    assert.equal(dispatched, 1)
    current = false
    const closed = waitForClose(first)
    first.send(JSON.stringify({ protocolVersion: 1, schemaVersion: 1, kind: 'hello', messageId: 'm-2',
      deviceId: fixture.identity.deviceId, controllerId: 'controller-test',
      body: { protocol: 'kq-operation/1', protocolVersion: 1, schemaVersion: 1 } }))
    assert.equal((await closed).code, 1008)
    assert.equal(dispatched, 1)
  } finally { await fixture.server.close() }
})

test('WSS validates operational JSON raw before dispatch and fences envelope identity', async () => {
  const received: unknown[] = []
  let dispatchResolve: (() => void) | undefined
  const fixture = await startServer({ authorization: authorizedPort(),
    messagePort: { onMessage(context) { received.push(context.payload); dispatchResolve?.() } } })
  const connect = async () => {
    const client = openWebSocket('127.0.0.1', fixture.address.port, fixture.identity, { Authorization: 'Bearer ' + TOKEN })
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    const ready = nextMessage(client)
    client.send(JSON.stringify({ type: 'transport-hello', transportVersion: 1, capabilities: [] }))
    await ready
    return client
  }
  try {
    const valid = {
      protocolVersion: 1, schemaVersion: 1, kind: 'hello', messageId: 'wire-message-1',
      deviceId: fixture.identity.deviceId, controllerId: 'controller-test',
      body: { protocol: 'kq-operation/1', protocolVersion: 1, schemaVersion: 1 }
    }
    const client = await connect()
    const dispatched = new Promise<void>(resolve => { dispatchResolve = resolve })
    client.send(JSON.stringify(valid))
    await dispatched
    dispatchResolve = undefined
    assert.deepEqual(received, [valid], 'a schema-valid operational message reaches only the registered port')
    const clientClosed = waitForClose(client)
    client.close()
    await clientClosed

    const activate = {
      ...valid, kind: 'command', messageId: 'wire-message-2',
      body: { operationId: 'op-1', type: 'activate-turn',
        target: { sessionId: 'session-1', turnId: 'LOG-1762900000000-AB12', controlEpoch: 'control-1',
          playerEpoch: 'player-1', stateRevision: 1 },
        payload: { packageRevision: 1, managementRevision: 1, singerName: 'Singer', table: 'Table 1',
          tracks: [{ occurrenceId: 'occ-1', trackIndex: 1, musicCode: '01001' }] } }
    }
    const rawVariants = [
      JSON.stringify(valid).replace('"messageId":"wire-message-1"',
        '"messageId":"wire-message-1","messageId":"wire-message-1"'),
      JSON.stringify(valid).replace('"protocol":"kq-operation/1"',
        '"protocol":"kq-operation/1","protocol":"kq-operation/1"'),
      JSON.stringify(activate).replace('"musicCode":"01001"',
        '"musicCode":"01001","musicCode":"01001"'),
      JSON.stringify({ type: 'activate-turn', operationId: 'op-bypass', payload: {} }),
      '{invalid-json'
    ]
    for (const raw of rawVariants) {
      const rejected = await connect()
      const closed = waitForClose(rejected)
      rejected.send(raw)
      assert.equal((await closed).code, 1007)
      assert.equal(received.length, 1, 'invalid raw input cannot reach an operational handler')
    }

    const wrongIdentity = await connect()
    const wrongIdentityClosed = waitForClose(wrongIdentity)
    wrongIdentity.send(JSON.stringify({ ...valid, messageId: 'wire-message-3', controllerId: 'unpaired-controller' }))
    assert.equal((await wrongIdentityClosed).code, 1008)
    assert.equal(received.length, 1)

    const oversized = await connect()
    const oversizedClosed = waitForClose(oversized)
    oversized.send('😀'.repeat(16 * 1024 + 1))
    assert.equal((await oversizedClosed).code, 1009)
    assert.equal(received.length, 1)
  } finally { await fixture.server.close() }
})

test('HTTPS routes are absent without registration, reject Origin and require authorization scopes', async () => {
  const fixture = await startServer({ authorization: authorizedPort(), routes: [{
    method: 'GET', path: '/v1/test', requiredScope: 'test:read',
    handle() { return { statusCode: 200, body: Buffer.from('{"ok":true}') } }
  }] })
  try {
    const response = await requestHttps({ address: '127.0.0.1', port: fixture.address.port, identity: fixture.identity,
      requestPath: '/v1/test', headers: { Authorization: `Bearer ${TOKEN}` } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body), { ok: true })
    const origin = await requestHttps({ address: '127.0.0.1', port: fixture.address.port, identity: fixture.identity,
      requestPath: '/v1/test', headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'null' } })
    assert.equal(origin.statusCode, 403)
    const missing = await requestHttps({ address: '127.0.0.1', port: fixture.address.port, identity: fixture.identity,
      requestPath: '/v1/unregistered', headers: { Authorization: `Bearer ${TOKEN}` } })
    assert.equal(missing.statusCode, 404)
  } finally { await fixture.server.close() }
})

test('pinned client rejects a different certificate before a route can be used', async () => {
  const expected = await createPlayerIdentity()
  const attacker = await createPlayerIdentity()
  const server = https.createServer({ key: attacker.privateKeyPem, cert: attacker.certificatePem,
    minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }, (_request, response) => response.end('unexpected'))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await assert.rejects(requestHttps({ address: '127.0.0.1', port: address.port, identity: expected,
      requestPath: '/v1/test', headers: { Authorization: `Bearer ${TOKEN}` } }))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('Player transport safely contains the reset from a real unauthenticated TLS identity probe', async () => {
  const address = firstPrivateIpv4Interface()
  assert.ok(address, 'the unauthenticated TLS probe accepts LAN IPv4 endpoints only')
  const port = await availablePort(address)
  const fixture = await startServer({ address, port })
  try {
    const observed = await probeBootstrapCertificate(address, fixture.address.port)
    assert.equal(observed.fingerprintSha256, fixture.identity.certificateFingerprintSha256)
    assert.equal(observed.deviceIdClaim, fixture.identity.deviceId)
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally { await fixture.server.close() }
})

test('transport close racing listen is idempotent and leaves no bound listener', async () => {
  const identity = await createPlayerIdentity()
  const server = createRemoteTransportServer({ identity, address: '127.0.0.1', port: 0 })
  const listening = server.listen()
  const firstClose = server.close()
  const secondClose = server.close()
  const listenResult = await Promise.allSettled([listening])
  await Promise.all([firstClose, secondClose])
  if (listenResult[0].status === 'rejected') assert.match(listenResult[0].reason.message, /REMOTE_TRANSPORT_CLOSING/)
  assert.equal(server.address(), null)
  await assert.rejects(server.listen(), /REMOTE_TRANSPORT_CLOSING/)
})

test('transport shutdown aborts in-flight authorization before releasing listener', async () => {
  let authorizationStarted: (() => void) | undefined
  let authorizationSignal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { authorizationStarted = resolve })
  const identity = await createPlayerIdentity()
  const server = createRemoteTransportServer({ identity, address: '127.0.0.1', port: 0,
    authorization: {
      authorizeBearer(_token, _connectionId, signal) {
        authorizationSignal = signal
        authorizationStarted?.()
        return new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }))
      },
      isCurrent() { return false }
    } })
  await server.listen()
  const address = server.address()
  assert.ok(address)
  const client = openWebSocket('127.0.0.1', address.port, identity, { Authorization: `Bearer ${TOKEN}` })
  client.on('error', () => undefined)
  await started
  await server.close()
  assert.equal(authorizationSignal?.aborted, true)
  assert.equal(server.address(), null)
  client.terminate()
})

test('G4 abort during operational hello closes the pinned WSS channel without waiting for timeout', async () => {
  const address = firstPrivateIpv4Interface()
  assert.ok(address, 'the WSS client policy requires a private IPv4 interface for the real transport test')
  const port = await availablePort(address)
  let observedHello!: () => void
  const helloObserved = new Promise<void>(resolve => { observedHello = resolve })
  const { server, identity, address: serverAddress } = await startServer({ address, port,
    authorization: authorizedPort(), messagePort: {
    onMessage(context) {
      const payload = context.payload as { kind?: string }
      if (payload.kind === 'hello') observedHello()
    }
  } })
  const abort = new AbortController()
  const connection = RemoteOperationalClient.connect({ address, port: serverAddress.port,
    pin: { certificatePem: identity.certificatePem!, fingerprintSha256: identity.certificateFingerprintSha256!,
      serverName: `player-${identity.deviceId}.karaoke.invalid` },
    bearer: TOKEN, identity: { playerId: identity.deviceId, controllerId: 'controller-test', credentialGeneration: 1 },
    authorizedPeer: { controllerId: 'controller-test', credentialGeneration: 1, scopes: ['transport:control'] },
    signal: abort.signal })
  try {
    await helloObserved
    abort.abort()
    await assert.rejects(connection, /REMOTE_OPERATIONAL_CONNECT_ABORTED/)
  } finally { await server.close() }
})

test('G4 pinned WSS surfaces a Player recovery-required hello as a blocked state', async () => {
  const address = firstPrivateIpv4Interface()
  assert.ok(address, 'the WSS client policy requires a private IPv4 interface for the real transport test')
  const port = await availablePort(address)
  let playerId = ''
  const { server, identity, address: serverAddress } = await startServer({ address, port,
    authorization: authorizedPort(), messagePort: {
      onMessage(context) {
        const hello = context.payload as { kind?: string; messageId?: string }
        if (hello.kind !== 'hello' || !hello.messageId) return
        context.channel.send(JSON.stringify({ protocolVersion: 1, schemaVersion: 1, kind: 'error',
          messageId: randomUUID(), deviceId: playerId, controllerId: 'controller-test',
          body: { correlationId: hello.messageId, code: 'STORAGE_UNAVAILABLE', state: 'recovery-required' } }))
      }
    } })
  playerId = identity.deviceId
  try {
    await assert.rejects(RemoteOperationalClient.connect({ address, port: serverAddress.port,
      pin: { certificatePem: identity.certificatePem!, fingerprintSha256: identity.certificateFingerprintSha256!,
        serverName: `player-${identity.deviceId}.karaoke.invalid` },
      bearer: TOKEN, identity: { playerId, controllerId: 'controller-test', credentialGeneration: 1 },
      authorizedPeer: { controllerId: 'controller-test', credentialGeneration: 1, scopes: ['transport:control'] } }),
    /REMOTE_PLAYER_RECOVERY_REQUIRED/)
  } finally { await server.close() }
})

test('Main remote runtime waits for an in-flight Player start and cleans resources before close resolves', async () => {
  const directory = await temporaryDirectory()
  let advertiserStarted: (() => void) | undefined
  let releaseAdvertiser: (() => void) | undefined
  let advertiserStopped = 0
  const started = new Promise<void>(resolve => { advertiserStarted = resolve })
  const advertiserGate = new Promise<void>(resolve => { releaseAdvertiser = resolve })
  const storage: SafeStoragePort = {
    async isAsyncEncryptionAvailable() { return true }, isEncryptionAvailable() { return true },
    getSelectedStorageBackend() { return 'gnome_libsecret' },
    async encryptStringAsync(value) { return Buffer.from(`safe:${value}`) },
    async decryptStringAsync(value) { return { result: Buffer.from(value).toString().slice(5), shouldReEncrypt: false } },
    encryptString(value) { return Buffer.from(`safe:${value}`) },
    decryptString(value) { return Buffer.from(value).toString().slice(5) }
  }
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: storage,
    createAdvertiser: () => ({
      async start() { advertiserStarted?.(); await advertiserGate },
      async update() {},
      async stop() { advertiserStopped++ }
    }) })
  try {
    const start = runtime.startPlayer({ interfaceAddress: '127.0.0.1', displayName: 'Test Player', port: 0,
      authorization: { async authorizeBearer() { return null }, isCurrent() { return false } } })
    await started
    const close = runtime.close()
    releaseAdvertiser?.()
    await assert.rejects(start, /REMOTE_RUNTIME_CLOSED/)
    await close
    assert.equal(advertiserStopped, 1)
    await assert.rejects(runtime.startManagementDiscovery(['127.0.0.1']), /REMOTE_RUNTIME_CLOSED/)
  } finally {
    releaseAdvertiser?.()
    await runtime.close().catch(() => undefined)
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('Main remote runtime rejects a second Player start after the listener is active', async () => {
  const directory = await temporaryDirectory()
  let advertiserStops = 0
  const storage: SafeStoragePort = {
    async isAsyncEncryptionAvailable() { return true }, isEncryptionAvailable() { return true },
    getSelectedStorageBackend() { return 'gnome_libsecret' },
    async encryptStringAsync(value) { return Buffer.from(`safe:${value}`) },
    async decryptStringAsync(value) { return { result: Buffer.from(value).toString().slice(5), shouldReEncrypt: false } },
    encryptString(value) { return Buffer.from(`safe:${value}`) },
    decryptString(value) { return Buffer.from(value).toString().slice(5) }
  }
  const runtime = new MainRemoteRuntime({ mode: 'player', userDataDirectory: directory, safeStorage: storage,
    createAdvertiser: () => ({
      async start() {},
      async update() {},
      async stop() { advertiserStops++ }
    }) })
  try {
    const options = { interfaceAddress: '127.0.0.1', displayName: 'Test Player', port: 0,
      authorization: { async authorizeBearer() { return null }, isCurrent() { return false } } }
    await runtime.startPlayer(options)
    assert.throws(() => runtime.startPlayer(options), /REMOTE_PLAYER_ALREADY_STARTED/)
  } finally {
    await runtime.close()
    assert.equal(advertiserStops, 1)
    await fs.rm(directory, { recursive: true, force: true })
  }
})
