import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildOpaqueIdentifiers, buildPairingContext, decodeBase64Url, derivePairingSchedule,
  encodeBase64Url, makeReceipt, nextReceiptDigest, opaqueUserIdentifier, sha256, verifyReceipt } from '../src/pairing-crypto'
import type { PairingDescriptor } from '../src/pairing-crypto'

const evidenceDirectory = path.join(__dirname, '../../docs/evidence/g21/final-decision')
const vector = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, 'final-profile-vector.json'), 'utf8')) as Record<string, any>

test('kq-pair/2 application transcript, HKDF tree and mutual bind proofs match the independent fixture', () => {
  const context = buildPairingContext(vector.context)
  const schedule = derivePairingSchedule(decodeBase64Url(vector.sessionKeyFixture, 64), context,
    decodeBase64Url(vector.KE1, 96), decodeBase64Url(vector.KE2, 320), decodeBase64Url(vector.KE3, 64))
  assert.equal(encodeBase64Url(schedule.transcript), vector.T)
  assert.equal(encodeBase64Url(schedule.transcriptHash), vector.TH)
  assert.equal(encodeBase64Url(schedule.recoveryRoot), vector.R)
  assert.equal(encodeBase64Url(schedule.commitPlayer), vector.commitPlayerKey)
  assert.equal(encodeBase64Url(schedule.commitController), vector.commitControllerKey)
  const identifiers = buildOpaqueIdentifiers(context)
  assert.equal(identifiers.client, `KQ-Pair-v2/controller/${encodeBase64Url(context)}`)
  assert.equal(identifiers.server, `KQ-Pair-v2/player/${encodeBase64Url(context)}`)
  assert.equal(opaqueUserIdentifier(vector.context.sessionId, vector.context.attemptId),
    `KQ-Pair-v2/${vector.context.sessionId}/${vector.context.attemptId}`)
})

test('receipts use the exact B2 E encoding, key direction, previous digest and reject altered fields', () => {
  const descriptor: PairingDescriptor = {
    transcriptHash: encodeBase64Url(Buffer.alloc(32, 1)), pairingId: encodeBase64Url(Buffer.alloc(32, 2)),
    operationId: encodeBase64Url(Buffer.alloc(32, 3)), targetGeneration: '1', basePRevision: '0',
    baseCRevision: '0', tokenHash: encodeBase64Url(sha256(Buffer.alloc(32, 4)))
  }
  const playerKey = Buffer.alloc(32, 5)
  const controllerKey = Buffer.alloc(32, 6)
  const previous = sha256(Buffer.from('fixture'))
  const prepare = makeReceipt('prepare', playerKey, descriptor, previous)
  assert(verifyReceipt(prepare, playerKey, descriptor, previous, 'prepare'))
  assert(!verifyReceipt(prepare, controllerKey, descriptor, previous, 'prepare'))
  assert(!verifyReceipt({ ...prepare, tag: encodeBase64Url(Buffer.alloc(32)) }, playerKey, descriptor, previous, 'prepare'))
  const prepared = makeReceipt('prepared', controllerKey, descriptor, nextReceiptDigest(prepare))
  assert(verifyReceipt(prepared, controllerKey, descriptor, nextReceiptDigest(prepare), 'prepared'))
  assert(!verifyReceipt(prepared, controllerKey, { ...descriptor, targetGeneration: '2' }, nextReceiptDigest(prepare), 'prepared'))
})
