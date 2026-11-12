import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PairingBootstrapService, type PairingPresentationPort } from '../src/pairing-bootstrap'
import { encodeBase64Url } from '../src/pairing-crypto'
import { PairingStore } from '../src/pairing-store'
import type { SecretProtector } from '../src/remote-secret-protector'
import { generatePlayerCertificate } from '../src/remote-tls'
import { encodePairingEnvelope, parsePairingEnvelope, type PairingEnvelope } from '../src/pairing-wire'

class TestProtector implements SecretProtector {
  async assertAvailable(): Promise<void> {}
  async encrypt(value: string): Promise<Uint8Array> { return Buffer.from(`test:${value}`) }
  async decrypt(value: Uint8Array) {
    const plaintext = Buffer.from(value).toString('utf8')
    if (!plaintext.startsWith('test:')) throw new Error('TEST_PROTECTOR_INVALID')
    return { plaintext: plaintext.slice(5), ciphertext: value, shouldReEncrypt: false }
  }
}

function id(): string { return encodeBase64Url(randomBytes(32)) }
function open(nonceC = id()): PairingEnvelope {
  return { version: 'kq-pair/2', type: 'request/open', sessionId: '', operationId: '', attemptId: '', payload: {
    baseCRevision: '0', controllerId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Gestão de teste', nonceC, profile: 'opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4', purpose: 'initial'
  } }
}

async function call(service: PairingBootstrapService, envelope: PairingEnvelope): Promise<PairingEnvelope> {
  const operation = envelope.type.startsWith('request/') ? 'request'
    : envelope.type.startsWith('proof/') ? 'proof' : 'confirm'
  const response = await service.handle({ operation, body: encodePairingEnvelope(envelope), connectionId: 'test', socket: new Socket() })
  if (!response.body) throw new Error('PAIRING_FIXTURE_RESPONSE_MISSING')
  return parsePairingEnvelope(response.body)
}

test('Player bootstrap stays disabled without an approved local presentation; consent, single-session, cancellation and timeout fail closed', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-pair-bootstrap-lifecycle-'))
  const playerId = '22222222-2222-4222-8222-222222222222'
  const certificate = await generatePlayerCertificate(playerId)
  const identity = { schemaVersion: 1 as const, role: 'player' as const, deviceId: playerId,
    createdAt: new Date().toISOString(), certificatePem: certificate.certificatePem,
    certificateFingerprintSha256: certificate.fingerprintSha256, privateKeyPem: certificate.privateKeyPem }
  const store = new PairingStore(directory, new TestProtector())
  const consentClosures: string[] = []
  const consentBarrier: PairingPresentationPort = { approvedForProduction: true,
    requestConsent: () => new Promise<boolean>(() => undefined), showTemporaryCode() {},
    closePairing(value) { consentClosures.push(value.outcome) } }
  try {
    const disabled = new PairingBootstrapService(identity, store, undefined)
    assert.equal(disabled.enabled, false)
    const denied = await call(disabled, open())
    assert.equal(denied.type, 'response/error')
    assert.equal(denied.payload.code, 'STORAGE_UNAVAILABLE')
    assert.equal((await store.read()).journals.length, 0)
    await disabled.close()

    const cancellable = new PairingBootstrapService(identity, store, consentBarrier)
    const opened = await call(cancellable, open())
    assert.equal(opened.type, 'response/opened')
    const second = await call(cancellable, open())
    assert.equal(second.type, 'response/error')
    assert.equal(second.payload.code, 'BUSY', 'a second Controller cannot replace an in-flight local request')
    const cancel = { version: 'kq-pair/2' as const, type: 'request/cancel', sessionId: opened.sessionId,
      operationId: opened.operationId, attemptId: '', payload: { sessionCapability: opened.payload.sessionCapability as string } }
    const cancelled = await call(cancellable, cancel)
    assert.equal(cancelled.type, 'response/state')
    assert.equal(cancelled.payload.state, 'cancelled')
    assert.ok(consentClosures.includes('cancelled'))
    assert.equal((await store.read()).journals.length, 0)
    await cancellable.close()

    let monotonicNow = 0
    const expiring = new PairingBootstrapService(identity, store, consentBarrier,
      { monotonicNow: () => monotonicNow, utcNow: () => new Date(0) })
    const pending = await call(expiring, open())
    assert.equal(pending.type, 'response/opened')
    monotonicNow = 120_001
    const poll = { version: 'kq-pair/2' as const, type: 'request/poll', sessionId: pending.sessionId,
      operationId: pending.operationId, attemptId: '', payload: { sessionCapability: pending.payload.sessionCapability as string } }
    const expired = await call(expiring, poll)
    assert.equal(expired.type, 'response/error')
    assert.equal(expired.payload.code, 'EXPIRED')
    assert.ok(consentClosures.includes('timed-out'))
    assert.equal((await store.read()).playerAuthority, null)
    await expiring.close()
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
