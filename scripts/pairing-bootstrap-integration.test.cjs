const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Socket } = require('node:net')
const { MainOpaqueWorker } = require('../build/src/opaque-worker-client.js')
const { PairingBootstrapService } = require('../build/src/pairing-bootstrap.js')
const { PairingStore } = require('../build/src/pairing-store.js')
const { PairingAuthorizationAdapter } = require('../build/src/pairing-authorization.js')
const { generatePlayerCertificate } = require('../build/src/remote-tls.js')
const cryptoProfile = require('../build/src/pairing-crypto.js')
const wire = require('../build/src/pairing-wire.js')

class TestProtector {
  constructor() { this.encryptCalls = 0 }
  async assertAvailable() {}
  async encrypt(value) {
    this.encryptCalls++
    const barrier = this.beforeEncrypt
    if (barrier) await barrier(this.encryptCalls)
    return Buffer.from(`test-encrypted:${value}`)
  }
  async decrypt(value) {
    const text = Buffer.from(value).toString('utf8')
    if (!text.startsWith('test-encrypted:')) throw new Error('TEST_CIPHER_INVALID')
    return { plaintext: text.slice('test-encrypted:'.length), ciphertext: value, shouldReEncrypt: false }
  }
}

async function durableTestWrite(filePath, content) {
  const temporary = `${filePath}.${crypto.randomUUID()}.test-tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally { await handle.close() }
  await fs.rename(temporary, filePath)
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(filePath), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}

function b64(value) { return Buffer.from(value).toString('base64url') }
function id() { return b64(crypto.randomBytes(32)) }
function envelope(type, sessionId, operationId, attemptId, payload) {
  return { version: 'kq-pair/2', type, sessionId, operationId, attemptId, payload }
}
function requestContext(type, message) {
  const operation = type.startsWith('request/') ? 'request' : type.startsWith('proof/') ? 'proof' : 'confirm'
  return { operation, body: wire.encodePairingEnvelope(message), connectionId: crypto.randomUUID(), socket: new Socket() }
}

let releaseConsent
let codeShown
const presentationOutcomes = []
const consentPromise = new Promise(resolve => { releaseConsent = resolve })
const codePromise = new Promise(resolve => { codeShown = resolve })
const presentation = {
  approvedForProduction: true,
  requestConsent: () => consentPromise,
  showTemporaryCode: value => codeShown(value.groupedCode.replace(' ', '')),
  closePairing: async value => { presentationOutcomes.push(value.outcome) }
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-g2-pairing-e2e-'))
  const mode = process.argv.find(argument => argument.startsWith('--'))?.slice(2)
  let signalWriteEntered
  let signalDurableWrite
  let releaseWrite
  let signalEncryptEntered
  let releaseEncrypt
  const writeEntered = new Promise(resolve => { signalWriteEntered = resolve })
  const durableWriteEntered = new Promise(resolve => { signalDurableWrite = resolve })
  const writeGate = new Promise(resolve => { releaseWrite = resolve })
  const encryptEntered = new Promise(resolve => { signalEncryptEntered = resolve })
  const encryptGate = new Promise(resolve => { releaseEncrypt = resolve })
  const controllerWorker = new MainOpaqueWorker(path.join(__dirname, '../build/src/opaque-pairing-worker.js'))
  let service
  try {
    const playerId = '22222222-2222-4222-8222-222222222222'
    const controllerId = '11111111-1111-4111-8111-111111111111'
    const certificate = await generatePlayerCertificate(playerId)
    const identity = { schemaVersion: 1, role: 'player', deviceId: playerId, createdAt: new Date().toISOString(),
      certificatePem: certificate.certificatePem, certificateFingerprintSha256: certificate.fingerprintSha256,
      privateKeyPem: certificate.privateKeyPem }
    const protector = new TestProtector()
    const write = mode?.startsWith('cancel-after-write-') || mode === 'close-during-write' ||
      mode === 'revoke-after-write-admission'
      ? async (filePath, content) => {
        const candidate = JSON.parse(content)
        const isFirstJournal = candidate.journals.some(item => item.role === 'player' && item.phase === 'bound')
        if (!isFirstJournal) return durableTestWrite(filePath, content)
        signalWriteEntered()
        if (mode !== 'cancel-after-write-durable') await writeGate
        if (mode === 'cancel-after-write-unreadable') {
          await fs.writeFile(filePath, '{injected-unreadable-state')
          throw new Error('INJECTED_UNCERTAIN_WRITE_AND_READ_FAILURE')
        }
        if (mode === 'cancel-after-write-failure') throw new Error('INJECTED_WRITE_FAILED_BEFORE_COMMIT')
        await durableTestWrite(filePath, content)
        if (mode === 'cancel-after-write-durable') {
          signalDurableWrite()
          await writeGate
        }
        if (mode === 'cancel-after-write-ack-lost') throw new Error('INJECTED_ACK_LOST_AFTER_DURABLE_WRITE')
      }
      : undefined
    const store = new PairingStore(directory, protector, undefined, write)
    if (mode === 'revoke-after-write-admission') {
      const oldToken = crypto.randomBytes(32)
      await store.transact(async state => {
        state.authorityRevision = 3
        state.playerAuthority = { controllerId, credentialGeneration: 1, authorityRevision: 3,
          certificateFingerprintSha256: certificate.fingerprintSha256,
          tokenHash: crypto.createHash('sha256').update(oldToken).digest('base64url'),
          encryptedToken: await store.encryptSecret(oldToken),
          encryptedRecoveryRoot: await store.encryptSecret(crypto.randomBytes(32)),
          pairingId: id(), phase: 'active', scopes: ['transport:control'] }
      })
      oldToken.fill(0)
    }
    const authorization = new PairingAuthorizationAdapter(store)
    service = new PairingBootstrapService(identity, store, presentation, undefined, undefined,
      mode === 'revoke-after-write-admission' ? async () => {} : undefined)
    const open = envelope('request/open', '', '', '', { controllerId, displayName: 'Gestão de teste', nonceC: id(),
      purpose: mode === 'revoke-after-write-admission' ? 'renewal' : 'initial', baseCRevision: '0',
      profile: 'opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4' })
    const opened = wire.parsePairingEnvelope((await service.handle(requestContext(open.type, open))).body)
    assert.equal(opened.type, 'response/opened')
    const duplicateOpen = wire.parsePairingEnvelope((await service.handle(requestContext(open.type, open))).body)
    assert.equal(opened.sessionId, duplicateOpen.sessionId)
    const otherOpen = { ...open, payload: { ...open.payload, nonceC: id() } }
    const busy = await service.handle(requestContext(otherOpen.type, otherOpen))
    assert.equal(busy.statusCode, 409)
    releaseConsent(true)
    const code = await codePromise
    assert.match(code, /^\d{8}$/)

    const attemptId = id()
    const context = { purpose: open.payload.purpose, sessionId: opened.sessionId, operationId: opened.operationId,
      attemptId, nonceC: open.payload.nonceC, nonceP: opened.payload.nonceP,
      controllerId, playerId, fingerprint: opened.payload.fingerprint, serverName: opened.payload.serverName,
      expectedGeneration: opened.payload.expectedGeneration, targetGeneration: opened.payload.targetGeneration,
      basePRevision: opened.payload.basePRevision, baseCRevision: opened.payload.baseCRevision }
    const userIdentifier = cryptoProfile.opaqueUserIdentifier(opened.sessionId, attemptId)
    const started = await controllerWorker.run({ operation: 'controller-start', password: code, context })
    const akeStart = envelope('proof/ake-start', opened.sessionId, opened.operationId, attemptId,
      { sessionCapability: opened.payload.sessionCapability, KE1: started.KE1 })
    const akeResponse = wire.parsePairingEnvelope((await service.handle(requestContext(akeStart.type, akeStart))).body)
    assert.equal(akeResponse.type, 'response/ake-response')
    const controllerFinish = await controllerWorker.run({ operation: 'controller-finish', password: code, ke2: akeResponse.payload.KE2 })
    const akeFinish = envelope('proof/ake-finish', opened.sessionId, opened.operationId, attemptId, { KE3: controllerFinish.KE3 })
    const playerBindResponse = wire.parsePairingEnvelope((await service.handle(requestContext(akeFinish.type, akeFinish))).body)
    assert.equal(playerBindResponse.type, 'response/ake-confirmed')
    const controllerProof = await controllerWorker.run({ operation: 'controller-confirm-player-bind', playerBind: playerBindResponse.payload.playerBind })
    const bindRequest = envelope('confirm/controller-bind', opened.sessionId, opened.operationId, attemptId,
      { controllerBind: controllerProof.controllerBind })
    if (mode === 'cancel-at-prepare') {
      protector.beforeEncrypt = async calls => { if (calls === 1) assert.equal(await service.cancelLocally(), true) }
    }
    if (mode === 'cancel-during-vault' || mode === 'cancel-before-admission') {
      const targetCall = mode === 'cancel-during-vault' ? 1 : 2
      protector.beforeEncrypt = async calls => {
        if (calls !== targetCall) return
        signalEncryptEntered()
        await encryptGate
      }
    }
    const bindTask = service.handle(requestContext(bindRequest.type, bindRequest))
    if (mode === 'cancel-during-vault' || mode === 'cancel-before-admission') {
      await encryptEntered
      const cancellation1 = service.cancelLocally()
      const cancellation2 = service.cancelLocally()
      assert.equal(await cancellation1, true, 'pre-admission cancellation must be confirmed')
      assert.equal(await cancellation2, true, 'duplicate pre-admission cancellation must be idempotent')
      releaseEncrypt()
    } else if (mode === 'revoke-after-write-admission') {
      await writeEntered
      const revocation = authorization.revokeLocally()
      releaseWrite()
      await revocation
    } else if (mode === 'cancel-after-write-admission' || mode === 'cancel-after-write-failure' ||
        mode === 'cancel-after-write-ack-lost' || mode === 'cancel-after-write-durable' || mode === 'cancel-after-write-unreadable') {
      await (mode === 'cancel-after-write-durable' ? durableWriteEntered : writeEntered)
      const cancellation1 = service.cancelLocally()
      const cancellation2 = service.cancelLocally()
      releaseWrite()
      const results = await Promise.all([cancellation1, cancellation2])
      const expected = mode === 'cancel-after-write-failure'
      assert.deepEqual(results, [expected, expected], 'post-admission cancellation must await durable reconciliation')
    } else if (mode === 'close-during-write') {
      await writeEntered
      const closing = service.close()
      releaseWrite()
      await closing
    }
    const prepareResponse = wire.parsePairingEnvelope((await bindTask).body)
    if (mode === 'cancel-after-write-unreadable') {
      assert.equal(prepareResponse.payload.code, 'RESULT_UNCERTAIN')
      assert.equal(prepareResponse.payload.state, 'blocked')
      await assert.rejects(store.read())
      await assert.rejects(new PairingStore(directory, protector).read())
      assert.equal(await authorization.authorizeBearer(id(), 'unreadable', new AbortController().signal), null)
      assert.equal(await fs.readFile(path.join(directory, 'remote-authorization.json'), 'utf8'), '{injected-unreadable-state')
      console.log('cancel-after-write-unreadable: PASS')
      return
    }
    if (mode === 'revoke-after-write-admission') {
      assert.equal(prepareResponse.type, 'response/prepare', 'the already-admitted journal remains recoverable')
      const descriptor = prepareResponse.payload.descriptor
      const root = Buffer.from(controllerProof.recoveryRoot, 'base64url')
      const keyC = cryptoProfile.derivePairingKey(root, Buffer.from(controllerProof.transcriptHash, 'base64url'), 'commit-controller')
      const preparedReceipt = cryptoProfile.makeReceipt('prepared', keyC, descriptor,
        cryptoProfile.nextReceiptDigest(prepareResponse.payload.receipt))
      const prepared = envelope('confirm/prepared', opened.sessionId, opened.operationId, attemptId,
        { receipt: preparedReceipt })
      const commitResponse = wire.parsePairingEnvelope((await service.handle(requestContext(prepared.type, prepared))).body)
      root.fill(0); keyC.fill(0)
      assert.notEqual(commitResponse.type, 'response/committed', 'revoked renewal must not advance its pending journal')
      assert.equal((await store.read()).playerAuthority.phase, 'revoked')
      assert.equal((await store.read()).journals.find(item => item.role === 'player').phase, 'bound')
      assert.equal(await authorization.authorizeBearer(String(prepareResponse.payload.token), 'revoked-renewal',
        new AbortController().signal), null)
      console.log('revoke-after-write-admission: PASS')
      return
    }
    if (mode === 'cancel-at-prepare' || mode === 'cancel-during-vault' || mode === 'cancel-before-admission' ||
        mode === 'cancel-after-write-admission' || mode === 'cancel-after-write-failure' ||
        mode === 'cancel-after-write-ack-lost' || mode === 'cancel-after-write-durable' || mode === 'close-during-write') {
      const persistedAfterInterruption = await store.read()
      if (mode === 'cancel-after-write-admission' || mode === 'cancel-after-write-ack-lost' ||
          mode === 'cancel-after-write-durable' || mode === 'close-during-write') {
        assert.equal(persistedAfterInterruption.journals.length, 1, 'an admitted durable journal must be retained')
        assert.equal(persistedAfterInterruption.journals[0].phase, 'bound')
        assert.equal(persistedAfterInterruption.playerAuthority, null, 'pending journal never grants operational authority')
        const pendingToken = await store.decryptSecret(persistedAfterInterruption.journals[0].encryptedToken)
        const authorization = new PairingAuthorizationAdapter(store)
        assert.equal(await authorization.authorizeBearer(b64(pendingToken), 'pending-not-authorized', new AbortController().signal), null)
        pendingToken.fill(0)
      } else {
        assert.equal(persistedAfterInterruption.journals.length, 0, 'confirmed cancellation must leave no first journal')
        const restarted = new PairingStore(directory, protector)
        assert.equal((await restarted.read()).journals.length, 0, 'restart must preserve confirmed pre-admission cancellation')
      }
      assert.notEqual(prepareResponse.type, 'response/prepare', 'an interrupted first bind must not publish prepare')
      if (mode === 'cancel-after-write-failure') assert.equal(prepareResponse.payload.code, 'REJECTED')
      if (mode === 'cancel-after-write-ack-lost' || mode === 'cancel-after-write-durable') {
        const restarted = new PairingStore(directory, protector)
        const recovered = await restarted.read()
        assert.equal(recovered.journals.length, 1, 'restart must preserve a journal whose write ACK was lost')
        const authorization = new PairingAuthorizationAdapter(restarted)
        const token = await restarted.decryptSecret(recovered.journals[0].encryptedToken)
        assert.equal(await authorization.authorizeBearer(b64(token), 'restart-pending', new AbortController().signal), null)
        token.fill(0)
      }
      if (mode === 'cancel-after-write-failure') {
        const restarted = new PairingStore(directory, protector)
        assert.equal((await restarted.read()).journals.length, 0, 'restart confirms a failed pre-commit write stayed absent')
      }
      if (mode === 'close-during-write') assert.equal(service.enabled, false)
      console.log(`${mode}: PASS`)
      return
    }
    assert.equal(prepareResponse.type, 'response/prepare')
    const descriptor = prepareResponse.payload.descriptor
    const root = Buffer.from(controllerProof.recoveryRoot, 'base64url')
    const th = Buffer.from(controllerProof.transcriptHash, 'base64url')
    const keyP = cryptoProfile.derivePairingKey(root, th, 'commit-player')
    const keyC = cryptoProfile.derivePairingKey(root, th, 'commit-controller')
    const preparedReceipt = cryptoProfile.makeReceipt('prepared', keyC, descriptor,
      cryptoProfile.nextReceiptDigest(prepareResponse.payload.receipt))
    const prepared = envelope('confirm/prepared', opened.sessionId, opened.operationId, attemptId, { receipt: preparedReceipt })
    const committedResponse = wire.parsePairingEnvelope((await service.handle(requestContext(prepared.type, prepared))).body)
    assert.equal(committedResponse.type, 'response/committed')
    const finalReceipt = cryptoProfile.makeReceipt('final', keyC, descriptor,
      cryptoProfile.nextReceiptDigest(committedResponse.payload.receipt))
    const final = envelope('confirm/final', opened.sessionId, opened.operationId, attemptId, { receipt: finalReceipt })
    const activeResponse = wire.parsePairingEnvelope((await service.handle(requestContext(final.type, final))).body)
    assert.equal(activeResponse.type, 'response/active')
    assert(cryptoProfile.verifyReceipt(activeResponse.payload.receipt, keyP, descriptor,
      cryptoProfile.nextReceiptDigest(finalReceipt), 'active'))
    const persisted = await store.read()
    assert.equal(persisted.authorityRevision, 3)
    assert.equal(persisted.playerAuthority.phase, 'active')
    assert.deepEqual(persisted.playerAuthority.scopes, ['transport:control'])
    assert.equal(persisted.journals[0].phase, 'active')
    const bearer = prepareResponse.payload.token
    const peer = await authorization.authorizeBearer(bearer, 'test-connection', new AbortController().signal)
    assert(peer)
    assert.equal(peer.controllerId, controllerId)
    assert.deepEqual(peer.scopes, ['transport:control'])
    assert.equal(await authorization.authorizeBearer(id(), 'bad', new AbortController().signal), null)
    assert.equal(await authorization.isCurrent(peer, 'test-connection', new AbortController().signal), true)
    const concurrentCancel = service.cancelLocally()
    await Promise.all([authorization.revokeLocally(), service.close()])
    assert.equal(await concurrentCancel, false, 'an active authority cannot be reported as cancelled during revoke/shutdown')
    assert.equal(await authorization.authorizeBearer(bearer, 'after-revoke', new AbortController().signal), null)
    assert.equal((await store.read()).playerAuthority.phase, 'revoked')
    await controllerWorker.close()
    await service.close()
    assert.deepEqual(presentationOutcomes, ['active'], 'shutdown cannot relabel a completed pairing as cancelled')
    console.log('pairing-bootstrap-integration: PASS (real OPAQUE, local consent fixture, durable 5-receipt commit, bearer scope, revocation)')
  } finally {
    await service?.close()
    await controllerWorker.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
