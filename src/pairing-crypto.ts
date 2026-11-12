import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

export const PAIRING_VERSION = 'kq-pair/2' as const
export const OPAQUE_PROFILE = 'opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4' as const

export type ByteField = string | Uint8Array

export function encodeFields(...fields: readonly ByteField[]): Buffer {
  const parts: Buffer[] = []
  for (const field of fields) {
    const bytes = typeof field === 'string' ? Buffer.from(field, 'utf8') : Buffer.from(field)
    if (bytes.byteLength > 0xffff_ffff) throw new Error('PAIRING_FIELD_TOO_LARGE')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.byteLength)
    parts.push(length, bytes)
  }
  return Buffer.concat(parts)
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function decodeBase64Url(value: unknown, expectedLength?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('PAIRING_ENCODING_INVALID')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error('PAIRING_ENCODING_INVALID')
  }
  return decoded
}

export function randomPairingId(): string {
  return encodeBase64Url(randomBytes(32))
}

export interface PairingContextFields {
  purpose: 'initial' | 'renewal'
  sessionId: string
  operationId: string
  attemptId: string
  nonceC: string
  nonceP: string
  controllerId: string
  playerId: string
  fingerprint: string
  serverName: string
  expectedGeneration: string
  targetGeneration: string
  basePRevision: string
  baseCRevision: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REVISION = /^(0|[1-9][0-9]{0,15})$/

export function validatePairingContextFields(value: PairingContextFields): void {
  for (const key of ['sessionId', 'operationId', 'attemptId', 'nonceC', 'nonceP'] as const) decodeBase64Url(value[key], 32)
  decodeBase64Url(value.fingerprint, 32)
  if (!UUID.test(value.controllerId) || !UUID.test(value.playerId) ||
      !['initial', 'renewal'].includes(value.purpose) ||
      !REVISION.test(value.expectedGeneration) || !REVISION.test(value.targetGeneration) ||
      !REVISION.test(value.basePRevision) || !REVISION.test(value.baseCRevision) ||
      BigInt(value.targetGeneration) !== BigInt(value.expectedGeneration) + 1n ||
      value.serverName !== `player-${value.playerId}.karaoke.invalid`) throw new Error('PAIRING_CONTEXT_INVALID')
}

export function buildPairingContext(value: PairingContextFields): Buffer {
  validatePairingContextFields(value)
  return encodeFields('KQ-Pair-context', PAIRING_VERSION, OPAQUE_PROFILE, value.purpose,
    decodeBase64Url(value.sessionId), decodeBase64Url(value.operationId), decodeBase64Url(value.attemptId),
    decodeBase64Url(value.nonceC), decodeBase64Url(value.nonceP), value.controllerId, value.playerId,
    'controller', 'player', decodeBase64Url(value.fingerprint), value.serverName,
    value.expectedGeneration, value.targetGeneration, value.basePRevision, value.baseCRevision, '120')
}

export function buildOpaqueIdentifiers(context: Uint8Array): { client: string; server: string } {
  const encoded = encodeBase64Url(context)
  return { client: `KQ-Pair-v2/controller/${encoded}`, server: `KQ-Pair-v2/player/${encoded}` }
}

export function opaqueUserIdentifier(sessionId: string, attemptId: string): string {
  decodeBase64Url(sessionId, 32)
  decodeBase64Url(attemptId, 32)
  return `KQ-Pair-v2/${sessionId}/${attemptId}`
}

export function sha256(value: Uint8Array): Buffer {
  return createHash('sha256').update(value).digest()
}

export function derivePairingKey(ikm: Uint8Array, transcriptHash: Uint8Array, label: string): Buffer {
  if (transcriptHash.byteLength !== 32 || !/^[a-z-]{1,64}$/.test(label)) throw new Error('PAIRING_KDF_INPUT_INVALID')
  return Buffer.from(hkdfSync('sha256', ikm, transcriptHash, encodeFields('KQ-Pair-v2', label), 32))
}

export interface PairingKeySchedule {
  transcript: Buffer
  transcriptHash: Buffer
  recoveryRoot: Buffer
  bindPlayer: Buffer
  bindController: Buffer
  commitPlayer: Buffer
  commitController: Buffer
  recoveryPlayer: Buffer
  recoveryController: Buffer
}

export function derivePairingSchedule(
  sessionKey: Uint8Array,
  context: Uint8Array,
  ke1: Uint8Array,
  ke2: Uint8Array,
  ke3: Uint8Array
): PairingKeySchedule {
  if (sessionKey.byteLength !== 64 || ke1.byteLength !== 96 || ke2.byteLength !== 320 || ke3.byteLength !== 64) {
    throw new Error('PAIRING_OPAQUE_WIDTH_INVALID')
  }
  const transcript = encodeFields('KQ-Pair-transcript', PAIRING_VERSION, OPAQUE_PROFILE, context, ke1, ke2, ke3)
  const transcriptHash = sha256(transcript)
  const derive = (ikm: Uint8Array, label: string): Buffer => derivePairingKey(ikm, transcriptHash, label)
  const recoveryRoot = derive(sessionKey, 'recovery-root')
  return {
    transcript, transcriptHash, recoveryRoot,
    bindPlayer: derive(sessionKey, 'bind-player'),
    bindController: derive(sessionKey, 'bind-controller'),
    commitPlayer: derive(recoveryRoot, 'commit-player'),
    commitController: derive(recoveryRoot, 'commit-controller'),
    recoveryPlayer: derive(recoveryRoot, 'recovery-player'),
    recoveryController: derive(recoveryRoot, 'recovery-controller')
  }
}

export function pairingMac(key: Uint8Array, ...fields: readonly ByteField[]): Buffer {
  if (key.byteLength !== 32) throw new Error('PAIRING_MAC_KEY_INVALID')
  return createHmac('sha256', key).update(encodeFields(...fields)).digest()
}

export function equalPairingMac(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.byteLength === 32 && expected.byteLength === 32 && timingSafeEqual(actual, expected)
}

export interface PairingDescriptor {
  transcriptHash: string
  pairingId: string
  operationId: string
  targetGeneration: string
  basePRevision: string
  baseCRevision: string
  tokenHash: string
}

export function buildPairingRecord(descriptor: PairingDescriptor): Buffer {
  decodeBase64Url(descriptor.transcriptHash, 32)
  decodeBase64Url(descriptor.pairingId, 32)
  decodeBase64Url(descriptor.operationId, 32)
  decodeBase64Url(descriptor.tokenHash, 32)
  if (!REVISION.test(descriptor.targetGeneration) || !REVISION.test(descriptor.basePRevision) ||
      !REVISION.test(descriptor.baseCRevision)) throw new Error('PAIRING_DESCRIPTOR_INVALID')
  return encodeFields('KQ-Pair-record', PAIRING_VERSION, decodeBase64Url(descriptor.transcriptHash),
    decodeBase64Url(descriptor.pairingId), decodeBase64Url(descriptor.operationId), descriptor.targetGeneration,
    descriptor.basePRevision, descriptor.baseCRevision, decodeBase64Url(descriptor.tokenHash))
}

export function makeReceipt(
  type: 'prepare' | 'prepared' | 'committed' | 'final' | 'active',
  key: Uint8Array,
  descriptor: PairingDescriptor,
  previous: Uint8Array
): { type: typeof type; tag: string } {
  if (previous.byteLength !== 32) throw new Error('PAIRING_RECEIPT_PREVIOUS_INVALID')
  const body = encodeFields('KQ-Pair-receipt', PAIRING_VERSION, type,
    decodeBase64Url(descriptor.transcriptHash), decodeBase64Url(descriptor.pairingId),
    decodeBase64Url(descriptor.operationId), descriptor.targetGeneration, descriptor.basePRevision,
    descriptor.baseCRevision, decodeBase64Url(descriptor.tokenHash), previous)
  return { type, tag: encodeBase64Url(createHmac('sha256', key).update(body).digest()) }
}

export function verifyReceipt(
  receipt: { type: string; tag: string },
  key: Uint8Array,
  descriptor: PairingDescriptor,
  previous: Uint8Array,
  expectedType: 'prepare' | 'prepared' | 'committed' | 'final' | 'active'
): boolean {
  if (receipt.type !== expectedType || key.byteLength !== 32 || previous.byteLength !== 32) return false
  let actual: Buffer
  try { actual = decodeBase64Url(receipt.tag, 32) } catch { return false }
  const body = encodeFields('KQ-Pair-receipt', PAIRING_VERSION, expectedType,
    decodeBase64Url(descriptor.transcriptHash, 32), decodeBase64Url(descriptor.pairingId, 32),
    decodeBase64Url(descriptor.operationId, 32), descriptor.targetGeneration, descriptor.basePRevision,
    descriptor.baseCRevision, decodeBase64Url(descriptor.tokenHash, 32), previous)
  const expected = createHmac('sha256', key).update(body).digest()
  return timingSafeEqual(actual, expected)
}

export function nextReceiptDigest(receipt: { type: string; tag: string }): Buffer {
  decodeBase64Url(receipt.tag, 32)
  return sha256(encodeFields(receipt.type, decodeBase64Url(receipt.tag)))
}

export function receiptChainDigest(receipts: readonly { type: string; tag: string }[], descriptor: PairingDescriptor): Buffer {
  let previous = sha256(buildPairingRecord(descriptor))
  for (const receipt of receipts) {
    const type = receipt.type as 'prepare' | 'prepared' | 'committed' | 'final' | 'active'
    if (!['prepare', 'prepared', 'committed', 'final', 'active'].includes(type)) throw new Error('PAIRING_RECEIPT_INVALID')
    previous = nextReceiptDigest(receipt)
  }
  return previous
}
