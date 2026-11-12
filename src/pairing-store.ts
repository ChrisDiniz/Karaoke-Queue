import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SecretProtector } from './remote-secret-protector'
import { buildPairingRecord, decodeBase64Url, encodeBase64Url, sha256, validatePairingContextFields } from './pairing-crypto'
import type { PairingContextFields, PairingDescriptor } from './pairing-crypto'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FAILURES = 5
const MAX_SESSION_ATTEMPTS = 3
const WINDOW_MS = 10 * 60 * 1000
const PAIRING_CONTEXT_KEYS = ['purpose', 'sessionId', 'operationId', 'attemptId', 'nonceC', 'nonceP', 'controllerId',
  'playerId', 'fingerprint', 'serverName', 'expectedGeneration', 'targetGeneration', 'basePRevision', 'baseCRevision']

export type PairingPhase = 'bound' | 'prepared' | 'committed' | 'active' | 'revoked' | 'uncertain'

export interface PairingJournal {
  operationId: string
  attemptId: string
  sessionId: string
  pairingId: string
  role: 'player' | 'controller'
  phase: PairingPhase
  context: PairingContextFields
  transcript: string
  transcriptHash: string
  descriptor: Record<string, string>
  encryptedRecoveryRoot: string
  encryptedToken?: string
  tokenHash?: string
  receipts: Array<{ type: string; tag: string }>
  prepareDigest?: string
}

export interface StoredPlayerAuthority {
  controllerId: string
  credentialGeneration: number
  authorityRevision: number
  certificateFingerprintSha256: string
  tokenHash: string
  encryptedToken: string
  encryptedRecoveryRoot: string
  pairingId: string
  phase: 'active' | 'revoked'
  scopes: ['transport:control']
}

export interface StoredControllerAuthority {
  playerId: string
  credentialGeneration: number
  authorityRevision: number
  certificatePem: string
  certificateFingerprintSha256: string
  serverName: string
  address: string
  port: number
  encryptedToken: string
  encryptedRecoveryRoot: string
  pairingId: string
  phase: 'active' | 'revoked'
}

export interface PairingAttemptReservation {
  attemptId: string
  sessionId: string
  reservedAt: string
}

export interface PairingStoreState {
  schemaVersion: 2
  storeRevision: number
  authorityRevision: number
  bootId: string
  attempts: PairingAttemptReservation[]
  playerAuthority: StoredPlayerAuthority | null
  controllerAuthorities: Record<string, StoredControllerAuthority>
  journals: PairingJournal[]
  renewal: null | {
    phase: 'staged' | 'promoting' | 'promoted' | 'revoked'
    oldFingerprint: string
    newFingerprint: string
    encryptedOldBundle: string
    encryptedNewBundle: string
    startedAt: string
  }
}

export interface PairingStoreClock {
  monotonicNow(): number
  utcNow(): Date
  bootId(): string
}

const defaultClock: PairingStoreClock = {
  monotonicNow: () => Number(process.hrtime.bigint() / 1_000_000n),
  utcNow: () => new Date(),
  bootId: () => randomUUID()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
}

function validateState(value: unknown): PairingStoreState {
  if (!isRecord(value) || value.schemaVersion !== 2 || !Number.isSafeInteger(value.storeRevision) ||
      (value.storeRevision as number) < 0 || !Number.isSafeInteger(value.authorityRevision) ||
      (value.authorityRevision as number) < 0 || typeof value.bootId !== 'string' ||
      !Array.isArray(value.attempts) || !Array.isArray(value.journals) ||
      !(value.playerAuthority === null || isRecord(value.playerAuthority)) ||
      !isRecord(value.controllerAuthorities) ||
      !(value.renewal === null || isRecord(value.renewal)) ||
      Object.keys(value).sort().join(',') !==
        'attempts,authorityRevision,bootId,controllerAuthorities,journals,playerAuthority,renewal,schemaVersion,storeRevision') {
    throw new Error('PAIRING_STORE_INVALID')
  }
  for (const entry of value.attempts) {
    if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== 'attemptId,reservedAt,sessionId' ||
        typeof entry.attemptId !== 'string' || typeof entry.sessionId !== 'string' || typeof entry.reservedAt !== 'string') {
      throw new Error('PAIRING_STORE_INVALID')
    }
    decodeBase64Url(entry.attemptId, 32)
    decodeBase64Url(entry.sessionId, 32)
    if (!Number.isFinite(Date.parse(entry.reservedAt))) throw new Error('PAIRING_STORE_INVALID')
  }
  if (value.playerAuthority !== null) validatePlayerAuthority(value.playerAuthority)
  for (const [playerId, authority] of Object.entries(value.controllerAuthorities)) validateControllerAuthority(playerId, authority)
  for (const journal of value.journals) {
    if (!isRecord(journal) || typeof journal.operationId !== 'string' || typeof journal.attemptId !== 'string' ||
        typeof journal.sessionId !== 'string' || typeof journal.pairingId !== 'string' ||
        !['player', 'controller'].includes(String(journal.role)) ||
        !['bound', 'prepared', 'committed', 'active', 'revoked', 'uncertain'].includes(String(journal.phase)) ||
        typeof journal.transcript !== 'string' || typeof journal.transcriptHash !== 'string' ||
        !isRecord(journal.descriptor) || typeof journal.encryptedRecoveryRoot !== 'string' ||
        !Array.isArray(journal.receipts) || Object.keys(journal).some(key => ![
          'operationId', 'attemptId', 'sessionId', 'pairingId', 'role', 'phase', 'context', 'transcript',
          'transcriptHash', 'descriptor', 'encryptedRecoveryRoot', 'encryptedToken', 'tokenHash', 'receipts', 'prepareDigest'
        ].includes(key))) throw new Error('PAIRING_STORE_INVALID')
    const context = journal.context as PairingContextFields
    validatePairingContextFields(context)
    if (context.sessionId !== journal.sessionId || context.operationId !== journal.operationId ||
        context.attemptId !== journal.attemptId ||
        Object.keys(context as object).sort().join(',') !== [...PAIRING_CONTEXT_KEYS].sort().join(',')) {
      throw new Error('PAIRING_STORE_INVALID')
    }
    const transcript = decodeBase64Url(journal.transcript)
    const transcriptHash = decodeBase64Url(journal.transcriptHash, 32)
    if (!sha256(transcript).equals(transcriptHash) || !/^[A-Za-z0-9+/]+={0,2}$/.test(journal.encryptedRecoveryRoot) ||
        journal.encryptedRecoveryRoot.length > 96 * 1024) throw new Error('PAIRING_STORE_INVALID')
    if (journal.encryptedToken !== undefined && (typeof journal.encryptedToken !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(journal.encryptedToken) || journal.encryptedToken.length > 96 * 1024)) {
      throw new Error('PAIRING_STORE_INVALID')
    }
    if (journal.tokenHash !== undefined) decodeBase64Url(journal.tokenHash, 32)
    const descriptor = journal.descriptor
    if (Object.keys(descriptor).length) {
      try { buildPairingRecord(descriptor as unknown as PairingDescriptor) }
      catch { throw new Error('PAIRING_STORE_INVALID') }
    }
    if (!Array.isArray(journal.receipts) || journal.receipts.length > 5) throw new Error('PAIRING_STORE_INVALID')
    for (const receipt of journal.receipts) {
      if (!isRecord(receipt) || Object.keys(receipt).sort().join(',') !== 'tag,type' ||
          !['prepare', 'prepared', 'committed', 'final', 'active'].includes(String(receipt.type))) {
        throw new Error('PAIRING_STORE_INVALID')
      }
      decodeBase64Url(receipt.tag, 32)
    }
    if (journal.prepareDigest !== undefined) decodeBase64Url(journal.prepareDigest, 32)
    const expectedReceipts: Readonly<Record<string, readonly string[] | undefined>> = journal.role === 'player'
      ? { bound: ['prepare'], committed: ['prepare', 'prepared', 'committed'], active: ['prepare', 'prepared', 'committed', 'final', 'active'] }
      : { bound: [], prepared: ['prepare', 'prepared'], committed: ['prepare', 'prepared', 'committed', 'final'],
        active: ['prepare', 'prepared', 'committed', 'final', 'active'] }
    const receipts = journal.receipts as Array<{ type: string; tag: string }>
    const phase = String(journal.phase)
    if (phase === 'revoked') {
      if (!['prepare', 'prepared', 'committed', 'final', 'active'].every((type, index) => receipts[index]?.type === type) ||
          receipts.length !== 5) throw new Error('PAIRING_STORE_INVALID')
    } else if (expectedReceipts[phase] && expectedReceipts[phase]!.join(',') !== receipts.map(receipt => receipt.type).join(',')) {
      throw new Error('PAIRING_STORE_INVALID')
    }
    if (journal.phase !== 'bound' && (!journal.pairingId || !journal.tokenHash || !journal.encryptedToken)) {
      throw new Error('PAIRING_STORE_INVALID')
    }
    if (journal.pairingId) decodeBase64Url(journal.pairingId, 32)
  }
  if (value.renewal !== null) {
    const renewal = value.renewal
    if (!isRecord(renewal) || Object.keys(renewal).sort().join(',') !==
        'encryptedNewBundle,encryptedOldBundle,newFingerprint,oldFingerprint,phase,startedAt' ||
        !['staged', 'promoting', 'promoted', 'revoked'].includes(String(renewal.phase)) ||
        typeof renewal.oldFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(renewal.oldFingerprint) ||
        typeof renewal.newFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(renewal.newFingerprint) ||
        typeof renewal.startedAt !== 'string' || !Number.isFinite(Date.parse(renewal.startedAt)) ||
        typeof renewal.encryptedOldBundle !== 'string' || typeof renewal.encryptedNewBundle !== 'string') {
      throw new Error('PAIRING_STORE_INVALID')
    }
    if (['staged', 'promoting'].includes(String(renewal.phase)) &&
        (!/^[A-Za-z0-9+/]+={0,2}$/.test(renewal.encryptedOldBundle) ||
         !/^[A-Za-z0-9+/]+={0,2}$/.test(renewal.encryptedNewBundle))) throw new Error('PAIRING_STORE_INVALID')
    if (['promoted', 'revoked'].includes(String(renewal.phase)) &&
        (renewal.encryptedOldBundle !== '' || renewal.encryptedNewBundle !== '')) throw new Error('PAIRING_STORE_INVALID')
    if (value.playerAuthority === null || !['active', 'revoked'].includes(String((value.playerAuthority as Record<string, unknown>).phase))) {
      throw new Error('PAIRING_STORE_INVALID')
    }
    const currentFingerprint = (value.playerAuthority as Record<string, unknown>).certificateFingerprintSha256
    const expectedFingerprint = renewal.phase === 'staged' ? renewal.oldFingerprint
      : ['promoting', 'promoted'].includes(String(renewal.phase)) ? renewal.newFingerprint : currentFingerprint
    if ((value.playerAuthority?.phase !== 'active' &&
        !(value.playerAuthority?.phase === 'revoked' && renewal.phase !== 'staged')) ||
        currentFingerprint !== expectedFingerprint) throw new Error('PAIRING_STORE_INVALID')
  }
  return value as unknown as PairingStoreState
}

function validatePlayerAuthority(value: Record<string, unknown>): void {
  if (Object.keys(value).sort().join(',') !==
      'authorityRevision,certificateFingerprintSha256,controllerId,credentialGeneration,encryptedRecoveryRoot,encryptedToken,pairingId,phase,scopes,tokenHash' ||
      typeof value.controllerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.controllerId) ||
      !Number.isSafeInteger(value.credentialGeneration) || Number(value.credentialGeneration) < 0 ||
      !Number.isSafeInteger(value.authorityRevision) || Number(value.authorityRevision) < 0 ||
      typeof value.certificateFingerprintSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.certificateFingerprintSha256) ||
      typeof value.tokenHash !== 'string' || typeof value.encryptedToken !== 'string' ||
      typeof value.encryptedRecoveryRoot !== 'string' || typeof value.pairingId !== 'string' ||
      !['active', 'revoked'].includes(String(value.phase)) || !Array.isArray(value.scopes) ||
      value.scopes.length !== 1 || value.scopes[0] !== 'transport:control') throw new Error('PAIRING_STORE_INVALID')
  decodeBase64Url(value.tokenHash, 32); decodeBase64Url(value.pairingId, 32)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.encryptedToken) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encryptedRecoveryRoot)) throw new Error('PAIRING_STORE_INVALID')
}

function validateControllerAuthority(playerId: string, value: unknown): void {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !==
      'address,authorityRevision,certificateFingerprintSha256,certificatePem,credentialGeneration,encryptedRecoveryRoot,encryptedToken,pairingId,phase,playerId,port,serverName' ||
      value.playerId !== playerId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(playerId) ||
      !Number.isSafeInteger(value.credentialGeneration) || Number(value.credentialGeneration) < 0 ||
      !Number.isSafeInteger(value.authorityRevision) || Number(value.authorityRevision) < 0 ||
      typeof value.certificatePem !== 'string' || value.certificatePem.length > 32 * 1024 ||
      typeof value.certificateFingerprintSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.certificateFingerprintSha256) ||
      typeof value.serverName !== 'string' || typeof value.address !== 'string' ||
      !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535 ||
      typeof value.encryptedToken !== 'string' || typeof value.encryptedRecoveryRoot !== 'string' ||
      typeof value.pairingId !== 'string' || !['active', 'revoked'].includes(String(value.phase))) {
    throw new Error('PAIRING_STORE_INVALID')
  }
  decodeBase64Url(value.pairingId, 32)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.encryptedToken) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encryptedRecoveryRoot)) throw new Error('PAIRING_STORE_INVALID')
}

function emptyState(bootId: string): PairingStoreState {
  return { schemaVersion: 2, storeRevision: 0, authorityRevision: 0, bootId, attempts: [],
    playerAuthority: null, controllerAuthorities: {}, journals: [], renewal: null }
}

const serialByPath = new Map<string, Promise<void>>()

async function withPathLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = serialByPath.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const current = previous.catch(() => undefined).then(() => gate)
  serialByPath.set(key, current)
  await previous.catch(() => undefined)
  try { return await operation() }
  finally {
    release()
    if (serialByPath.get(key) === current) serialByPath.delete(key)
  }
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, filePath)
    if (process.platform !== 'win32') {
      const directoryHandle = await fs.open(directory, 'r')
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    }
    const actual = await fs.readFile(filePath, 'utf8')
    if (actual !== content) throw new Error('PAIRING_STORE_READBACK_MISMATCH')
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** One versioned G2 authorization file; writes serialize per canonical path and publish only after readback. */
export class PairingStore {
  private readonly filePath: string
  private readonly bootId: string
  private readonly recoveredAttempts = new Set<string>()
  private readonly attemptTimes = new Map<string, number>()
  private recoveryCooldownUntil = 0

  constructor(
    userDataDirectory: string,
    private readonly protector: SecretProtector,
    private readonly clock: PairingStoreClock = defaultClock,
    private readonly write = writeAtomically
  ) {
    this.filePath = path.join(userDataDirectory, 'remote-authorization.json')
    this.bootId = clock.bootId()
  }

  async read(): Promise<PairingStoreState> {
    return withPathLock(this.filePath, async () => this.readUnlocked())
  }

  async transact<T>(
    mutate: (candidate: PairingStoreState) => T | Promise<T>,
    expectedStoreRevision?: number
  ): Promise<{ state: PairingStoreState; result: T }> {
    return withPathLock(this.filePath, () => this.transactUnlocked(mutate, expectedStoreRevision))
  }

  async encryptSecret(value: Uint8Array): Promise<string> {
    await this.protector.assertAvailable()
    const encrypted = await this.protector.encrypt(encodeBase64Url(value))
    return Buffer.from(encrypted).toString('base64')
  }

  async assertSecureStorageAvailable(): Promise<void> {
    await this.protector.assertAvailable()
  }

  async decryptSecret(ciphertext: string): Promise<Buffer> {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) || ciphertext.length > 96 * 1024) {
      throw new Error('PAIRING_SECRET_INVALID')
    }
    await this.protector.assertAvailable()
    const result = await this.protector.decrypt(Buffer.from(ciphertext, 'base64'))
    return decodeBase64Url(result.plaintext)
  }

  async reserveAttempt(sessionId: string, attemptId: string): Promise<void> {
    decodeBase64Url(sessionId, 32)
    decodeBase64Url(attemptId, 32)
    await withPathLock(this.filePath, async () => {
      const currentTime = this.clock.monotonicNow()
      const current = await this.readUnlocked()
      const isRestart = current.bootId !== this.bootId && current.attempts.length > 0
      if (isRestart && !this.recoveredAttempts.size) {
        for (const attempt of current.attempts) this.recoveredAttempts.add(attempt.attemptId)
        this.recoveryCooldownUntil = currentTime + WINDOW_MS
      }
      if (this.recoveryCooldownUntil && currentTime < this.recoveryCooldownUntil) throw new Error('PAIRING_LOCKED')

      const priorBoot = current.attempts.filter(attempt => this.recoveredAttempts.has(attempt.attemptId))
      if (priorBoot.length) {
        await this.transactUnlocked(state => {
          state.attempts = state.attempts.filter(item => !this.recoveredAttempts.has(item.attemptId))
        })
        current.attempts = current.attempts.filter(item => !this.recoveredAttempts.has(item.attemptId))
        priorBoot.forEach(item => this.recoveredAttempts.delete(item.attemptId))
      }

      let active = current.attempts.filter(attempt => !this.recoveredAttempts.has(attempt.attemptId))
      const expired = active.filter(item => {
        const created = this.attemptTimes.get(item.attemptId)
        return created === undefined || currentTime - created >= WINDOW_MS
      })
      if (expired.length) {
        await this.transactUnlocked(state => {
          state.attempts = state.attempts.filter(item => !expired.some(old => old.attemptId === item.attemptId))
        })
        for (const item of expired) this.attemptTimes.delete(item.attemptId)
        active = active.filter(item => !expired.some(old => old.attemptId === item.attemptId))
      }
      if (active.some(item => item.attemptId === attemptId)) return
      const sessionAttempts = active.filter(item => item.sessionId === sessionId).length
      if (active.length >= MAX_FAILURES || sessionAttempts >= MAX_SESSION_ATTEMPTS) throw new Error('PAIRING_LOCKED')
      await this.transactUnlocked(state => {
        if (!state.attempts.some(item => item.attemptId === attemptId)) {
          state.attempts.push({ attemptId, sessionId, reservedAt: this.clock.utcNow().toISOString() })
        }
      })
      this.attemptTimes.set(attemptId, currentTime)
    })
  }

  async completeAttempt(attemptId: string, authenticated: boolean): Promise<void> {
    decodeBase64Url(attemptId, 32)
    if (!authenticated) return
    await this.transact(state => { state.attempts = state.attempts.filter(item => item.attemptId !== attemptId) })
    this.recoveredAttempts.delete(attemptId)
    this.attemptTimes.delete(attemptId)
  }

  private async transactUnlocked<T>(
    mutate: (candidate: PairingStoreState) => T | Promise<T>,
    expectedStoreRevision?: number
  ): Promise<{ state: PairingStoreState; result: T }> {
    const current = await this.readUnlocked()
    if (expectedStoreRevision !== undefined && current.storeRevision !== expectedStoreRevision) {
      throw new Error('PAIRING_REVISION_CONFLICT')
    }
    const candidate = structuredClone(current)
    const result = await mutate(candidate)
    candidate.storeRevision++
    // An unrelated write must not relabel surviving reservations as belonging to this boot.
    candidate.bootId = candidate.attempts.length && current.bootId !== this.bootId ? current.bootId : this.bootId
    validateState(candidate)
    await this.write(this.filePath, `${JSON.stringify(candidate)}\n`)
    const confirmed = await this.readUnlocked()
    if (confirmed.storeRevision !== candidate.storeRevision) throw new Error('PAIRING_STORE_RESULT_UNCERTAIN')
    return { state: structuredClone(confirmed), result }
  }

  private async readUnlocked(): Promise<PairingStoreState> {
    let metadata
    try { metadata = await fs.lstat(this.filePath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(this.bootId)
      throw new Error('PAIRING_STORE_READ_FAILED', { cause: error })
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FILE_BYTES) throw new Error('PAIRING_STORE_INVALID')
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(this.filePath))) }
    catch (error) { throw new Error('PAIRING_STORE_READ_FAILED', { cause: error }) }
    return validateState(value)
  }
}
