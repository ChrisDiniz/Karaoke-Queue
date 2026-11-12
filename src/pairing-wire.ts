import { decodeBase64Url, PAIRING_VERSION } from './pairing-crypto'

export const PAIRING_MAX_BODY = 16 * 1024
const ENVELOPE_KEYS = ['attemptId', 'operationId', 'payload', 'sessionId', 'type', 'version']

const PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'request/open': ['baseCRevision', 'controllerId', 'displayName', 'nonceC', 'profile', 'purpose'],
  'response/opened': ['baseCRevision', 'basePRevision', 'expectedGeneration', 'fingerprint', 'nonceP',
    'playerId', 'serverName', 'sessionCapability', 'state', 'targetGeneration'],
  'request/poll': ['sessionCapability'],
  'request/cancel': ['sessionCapability'],
  'response/state': ['attemptsRemaining', 'remainingSeconds', 'state'],
  'proof/ake-start': ['KE1', 'sessionCapability'],
  'response/ake-response': ['KE2'],
  'proof/ake-finish': ['KE3'],
  'response/ake-confirmed': ['playerBind'],
  'confirm/controller-bind': ['controllerBind'],
  'response/prepare': ['descriptor', 'receipt', 'token', 'transcript'],
  'confirm/prepared': ['receipt'],
  'response/committed': ['receipt'],
  'confirm/final': ['receipt'],
  'response/active': ['receipt'],
  'confirm/status': ['localPhase', 'mac', 'nonce', 'pairingId', 'receiptDigest'],
  'response/status-result': ['mac', 'nonce', 'pairingId', 'phase', 'prepare', 'receiptDigest', 'receipts'],
  'response/error': ['code', 'state']
})
const PLAYER_STATES = new Set(['idle-unbound', 'awaiting-local-consent', 'code-ready', 'preparing-attempt',
  'awaiting-KE3', 'awaiting-controller-bind', 'pending', 'committed', 'active', 'rejected', 'cancelled',
  'timed-out', 'error', 'blocked', 'revoked'])
const RECOVERY_PHASES = new Set(['bound', 'prepared', 'committed', 'active'])
const ERROR_CODES = new Set(['BUSY', 'ALREADY_BOUND', 'REJECTED', 'EXPIRED', 'RATE_LIMITED', 'INVALID_MESSAGE',
  'AUTH_FAILED', 'REVISION_CONFLICT', 'STORAGE_UNAVAILABLE', 'RESULT_UNCERTAIN'])

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function validateDepth(value: unknown, depth = 0): void {
  if (depth > 6) throw new Error('PAIRING_MESSAGE_INVALID')
  if (Array.isArray(value)) for (const item of value) validateDepth(item, depth + 1)
  else if (record(value)) for (const item of Object.values(value)) validateDepth(item, depth + 1)
}

function validatePayload(type: string, value: unknown): void {
  const keys = PAYLOAD_KEYS[type]
  if (!keys || !record(value) || !exactKeys(value, keys)) throw new Error('PAIRING_MESSAGE_INVALID')
  for (const [key, item] of Object.entries(value)) {
    if (key === 'descriptor' || key === 'receipt') validateNestedRecord(key, item)
    if (key === 'receipts') {
      if (!Array.isArray(item) || item.length > 5) throw new Error('PAIRING_MESSAGE_INVALID')
      for (const receipt of item) validateNestedRecord('receipt', receipt)
    }
    if (key === 'prepare' && item !== null) {
      if (!record(item) || !exactKeys(item, ['transcript', 'descriptor', 'token', 'receipt'])) throw new Error('PAIRING_MESSAGE_INVALID')
      validateNestedRecord('descriptor', item.descriptor)
      validateNestedRecord('receipt', item.receipt)
      if (typeof item.transcript !== 'string' || typeof item.token !== 'string') throw new Error('PAIRING_MESSAGE_INVALID')
      decodeBase64Url(item.transcript)
      decodeBase64Url(item.token, 32)
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.length > PAIRING_MAX_BODY) throw new Error('PAIRING_MESSAGE_INVALID')
    if (['KE1', 'KE2', 'KE3'].includes(key)) {
      const width = key === 'KE1' ? 96 : key === 'KE2' ? 320 : 64
      decodeBase64Url(item, width)
    }
    if (['nonceC', 'nonceP', 'sessionCapability', 'nonce', 'pairingId', 'token', 'mac', 'playerBind', 'controllerBind', 'receiptDigest', 'fingerprint'].includes(key)) {
      if (key === 'pairingId' && item === '' && type === 'confirm/status') continue
      const length = key === 'token' || key === 'pairingId' || key === 'sessionCapability' || key === 'nonceC' || key === 'nonceP' || key === 'nonce' || key === 'fingerprint' ? 32 :
        key === 'receiptDigest' || key === 'mac' || key.endsWith('Bind') ? 32 : undefined
      if (length) decodeBase64Url(item, length)
      else if (typeof item !== 'string') throw new Error('PAIRING_MESSAGE_INVALID')
    }
    if (key === 'displayName' && (typeof item !== 'string' || [...item].length > 64 || /[\u0000-\u001f\u007f]/u.test(item))) {
      throw new Error('PAIRING_MESSAGE_INVALID')
    }
    if (key === 'displayName' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(String(item))) {
      throw new Error('PAIRING_MESSAGE_INVALID')
    }
    if (key === 'profile' && item !== 'opaque-3dh-ristretto255-sha512-argon2id-m65536-t3-p4') throw new Error('PAIRING_PROFILE_UNSUPPORTED')
    if (key === 'purpose' && !['initial', 'renewal'].includes(String(item))) throw new Error('PAIRING_MESSAGE_INVALID')
  }
  const stringKeys = Object.keys(value)
  for (const key of stringKeys) if (!['descriptor', 'receipt', 'receipts', 'prepare'].includes(key) && typeof value[key] !== 'string') {
    throw new Error('PAIRING_MESSAGE_INVALID')
  }
  if ('baseCRevision' in value && !/^(0|[1-9][0-9]{0,15})$/.test(String(value.baseCRevision))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('basePRevision' in value && !/^(0|[1-9][0-9]{0,15})$/.test(String(value.basePRevision))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('expectedGeneration' in value && !/^(0|[1-9][0-9]{0,15})$/.test(String(value.expectedGeneration))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('targetGeneration' in value && !/^(0|[1-9][0-9]{0,15})$/.test(String(value.targetGeneration))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('remainingSeconds' in value && !/^(0|[1-9][0-9]{0,2})$/.test(String(value.remainingSeconds))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('attemptsRemaining' in value && !/^(0|[1-3])$/.test(String(value.attemptsRemaining))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('controllerId' in value && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value.controllerId))) {
    throw new Error('PAIRING_MESSAGE_INVALID')
  }
  if ('playerId' in value && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value.playerId))) {
    throw new Error('PAIRING_MESSAGE_INVALID')
  }
  if ('serverName' in value && value.serverName !== `player-${String(value.playerId)}.karaoke.invalid`) {
    throw new Error('PAIRING_MESSAGE_INVALID')
  }
  if ('state' in value && !PLAYER_STATES.has(String(value.state))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('localPhase' in value && !RECOVERY_PHASES.has(String(value.localPhase))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('phase' in value && !['pending', 'committed', 'active'].includes(String(value.phase))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('code' in value && !ERROR_CODES.has(String(value.code))) throw new Error('PAIRING_MESSAGE_INVALID')
  if ('transcript' in value) decodeBase64Url(value.transcript)
  if ('token' in value) decodeBase64Url(value.token, 32)
  if ('nonce' in value) decodeBase64Url(value.nonce, 32)
  if ('pairingId' in value && !(type === 'confirm/status' && value.pairingId === '')) decodeBase64Url(value.pairingId, 32)
  if ('fingerprint' in value) decodeBase64Url(value.fingerprint, 32)
}

function validateNestedRecord(kind: 'descriptor' | 'receipt', value: unknown): void {
  if (!record(value)) throw new Error('PAIRING_MESSAGE_INVALID')
  if (kind === 'receipt') {
    if (!exactKeys(value, ['type', 'tag']) || !['prepare', 'prepared', 'committed', 'final', 'active'].includes(String(value.type))) {
      throw new Error('PAIRING_MESSAGE_INVALID')
    }
    decodeBase64Url(value.tag, 32)
    return
  }
  if (!exactKeys(value, ['transcriptHash', 'pairingId', 'operationId', 'targetGeneration', 'basePRevision', 'baseCRevision', 'tokenHash'])) {
    throw new Error('PAIRING_MESSAGE_INVALID')
  }
  for (const key of ['transcriptHash', 'pairingId', 'operationId', 'tokenHash']) decodeBase64Url(value[key], 32)
  for (const key of ['targetGeneration', 'basePRevision', 'baseCRevision']) {
    if (typeof value[key] !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value[key])) throw new Error('PAIRING_MESSAGE_INVALID')
  }
}

export interface PairingEnvelope {
  version: typeof PAIRING_VERSION
  type: string
  sessionId: string
  operationId: string
  attemptId: string
  payload: Record<string, unknown>
}

export function encodePairingEnvelope(envelope: PairingEnvelope): Buffer {
  validatePairingEnvelope(envelope)
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8')
  if (bytes.length > PAIRING_MAX_BODY) throw new Error('PAIRING_MESSAGE_TOO_LARGE')
  return bytes
}

export function parsePairingEnvelope(bytes: Uint8Array): PairingEnvelope {
  if (!bytes.byteLength || bytes.byteLength > PAIRING_MAX_BODY) throw new Error('PAIRING_MESSAGE_TOO_LARGE')
  let source: string
  let parsed: unknown
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    parsed = JSON.parse(source)
  } catch { throw new Error('PAIRING_MESSAGE_INVALID') }
  validateDepth(parsed)
  if (!record(parsed)) throw new Error('PAIRING_MESSAGE_INVALID')
  const envelope = parsed as unknown as PairingEnvelope
  validatePairingEnvelope(envelope)
  if (JSON.stringify(envelope) !== source) throw new Error('PAIRING_MESSAGE_NONCANONICAL')
  return envelope
}

export function validatePairingEnvelope(value: unknown): asserts value is PairingEnvelope {
  if (!record(value) || !exactKeys(value, ENVELOPE_KEYS) || value.version !== PAIRING_VERSION ||
      typeof value.type !== 'string' || !Object.hasOwn(PAYLOAD_KEYS, value.type) ||
      typeof value.sessionId !== 'string' || typeof value.operationId !== 'string' || typeof value.attemptId !== 'string') {
    throw new Error('PAIRING_MESSAGE_INVALID')
  }
  if (value.type === 'request/open') {
    if (value.sessionId !== '' || value.operationId !== '' || value.attemptId !== '') throw new Error('PAIRING_MESSAGE_INVALID')
  } else {
    const isOpenError = value.type === 'response/error' && value.sessionId === '' && value.operationId === '' && value.attemptId === ''
    if (!isOpenError) {
      decodeBase64Url(value.sessionId, 32)
      decodeBase64Url(value.operationId, 32)
      const attemptOptional = ['request/poll', 'request/cancel', 'response/opened', 'response/state', 'response/error', 'confirm/status'].includes(value.type)
      if (value.attemptId === '' && !attemptOptional) throw new Error('PAIRING_MESSAGE_INVALID')
      if (value.attemptId !== '') decodeBase64Url(value.attemptId, 32)
    }
  }
  validatePayload(value.type, value.payload)
}

export function pairingPayloadKeys(type: string): readonly string[] | undefined {
  return PAYLOAD_KEYS[type]
}
