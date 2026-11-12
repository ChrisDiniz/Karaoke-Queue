import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeBase64Url } from '../src/pairing-crypto'
import { encodePairingEnvelope, parsePairingEnvelope } from '../src/pairing-wire'
import { canCancelPairing, transitionControllerPairing, transitionPlayerPairing } from '../src/pairing-state-machine'

const id = (byte: number): string => encodeBase64Url(Buffer.alloc(32, byte))

test('pairing wire accepts only canonical versioned open messages and exact schemas', () => {
  const message = { version: 'kq-pair/2' as const, type: 'request/open', sessionId: '', operationId: '', attemptId: '',
    payload: { baseCRevision: '0', controllerId: '11111111-1111-4111-8111-111111111111', displayName: 'Gestão',
      nonceC: id(1), profile: 'opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4', purpose: 'initial' } }
  const encoded = encodePairingEnvelope(message)
  assert.deepEqual(parsePairingEnvelope(encoded), message)
  const duplicateKey = Buffer.from('{"version":"kq-pair/2","version":"kq-pair/2","type":"request/open","sessionId":"","operationId":"","attemptId":"","payload":{"baseCRevision":"0","controllerId":"11111111-1111-4111-8111-111111111111","displayName":"Gestão","nonceC":"' + id(1) + '","profile":"opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4","purpose":"initial"}}')
  assert.throws(() => parsePairingEnvelope(duplicateKey), /PAIRING_MESSAGE_NONCANONICAL/)
  assert.throws(() => parsePairingEnvelope(Buffer.from(encoded.toString('utf8').replace('kq-pair/2', 'kq-pair/1'))), /PAIRING_MESSAGE_INVALID/)
  assert.throws(() => encodePairingEnvelope({ ...message, payload: { ...message.payload, unexpected: 'x' } }), /PAIRING_MESSAGE_INVALID/)
})

test('AKE messages require canonical 32-byte session, operation, attempt and OPAQUE fields', () => {
  const envelope = { version: 'kq-pair/2' as const, type: 'proof/ake-start', sessionId: id(1), operationId: id(2), attemptId: id(3),
    payload: { KE1: encodeBase64Url(Buffer.alloc(96)), sessionCapability: id(4) } }
  assert.deepEqual(parsePairingEnvelope(encodePairingEnvelope(envelope)), envelope)
  assert.throws(() => encodePairingEnvelope({ ...envelope, attemptId: '' }), /PAIRING_MESSAGE_INVALID/)
  assert.throws(() => encodePairingEnvelope({ ...envelope, payload: { ...envelope.payload,
    KE1: encodeBase64Url(Buffer.alloc(95)) } }), /PAIRING_ENCODING_INVALID/)
})

test('state machines forbid cancellation after durable pending and reject invalid phase jumps', () => {
  assert.equal(transitionPlayerPairing('idle-unbound', 'awaiting-local-consent'), 'awaiting-local-consent')
  assert.equal(transitionPlayerPairing('preparing-attempt', 'cancelled'), 'cancelled')
  assert.equal(canCancelPairing('preparing-attempt'), true)
  assert.equal(transitionPlayerPairing('awaiting-controller-bind', 'pending'), 'pending')
  assert.throws(() => transitionPlayerPairing('pending', 'cancelled'), /PAIRING_STATE_TRANSITION_INVALID/)
  assert.equal(transitionControllerPairing('saving-committed', 'awaiting-active'), 'awaiting-active')
  assert.throws(() => transitionControllerPairing('active-awaiting-reconciliation', 'cancelled'), /PAIRING_STATE_TRANSITION_INVALID/)
})
