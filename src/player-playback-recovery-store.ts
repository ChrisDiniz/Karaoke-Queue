import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { isCanonicalVideoCode } from './video-library'
import type { PlayerPlaybackPersistenceTransition, PlayerPlaybackStatus } from './player-playback-contracts'

export const PLAYER_PLAYBACK_RECOVERY_FILENAME = 'player-playback-recovery.json'
const TRANSACTION_FILENAME = '.player-playback-recovery-transaction.json'
const PREVIOUS_FILENAME = '.player-playback-recovery-previous.json'
const RESOLUTION_FILENAME = '.player-playback-recovery-resolution.json'
const QUARANTINE_PREFIX = 'player-playback-recovery-quarantine-'

export type PlayerPlaybackRecoveryStatus =
  | 'idle'
  | 'pending'
  | 'playing'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'uncertain'
  | 'dismissed'

export type PlayerPlaybackRecoveryTransition = PlayerPlaybackPersistenceTransition

export interface PlayerPlaybackRecoveryRecord {
  version: 1
  revision: number
  status: PlayerPlaybackRecoveryStatus
  attemptId?: string
  musicCode?: string
  playbackStatus?: PlayerPlaybackStatus
  lastTransition: PlayerPlaybackRecoveryTransition
  updatedAt: string
  startedAt?: string
  terminalAt?: string
  reason?: string
}

export class PlayerPlaybackRecoveryStoreError extends Error {
  constructor(readonly code: 'INVALID_RECORD' | 'UNREADABLE' | 'UNSUPPORTED_VERSION' | 'WRITE_FAILED', message: string) {
    super(message)
    this.name = 'PlayerPlaybackRecoveryStoreError'
  }
}

const VERSION = 1
const MAX_BYTES = 16 * 1024
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STATUSES = new Set<PlayerPlaybackRecoveryStatus>([
  'idle', 'pending', 'playing', 'paused', 'completed', 'stopped', 'failed', 'uncertain', 'dismissed'
])
const PLAYBACK_STATUSES = new Set<PlayerPlaybackStatus>([
  'idle', 'loading', 'starting', 'ready', 'playing', 'paused', 'stopping', 'stopped',
  'completed', 'failed', 'uncertain', 'disposed'
])
const TRANSITIONS = new Set<PlayerPlaybackRecoveryTransition>([
  'load-intent', 'media-ready', 'play-intent', 'playback-started', 'pause-intent', 'playback-paused',
  'resume-intent', 'stop-intent', 'stop-confirmed', 'replacement-stop-intent', 'replacement-interrupted',
  'natural-end-confirmed', 'playback-failed', 'playback-uncertain', 'host-terminated', 'containment-updated',
  'shutdown-stop-intent', 'shutdown-confirmed', 'recovery-dismissed', 'invalid-recovery-resolved'
])

interface RecoveryTransaction {
  version: 1
  phase: 'prepared' | 'committed'
  targetRevision: number
  previousRevision?: number
}

interface RecoveryResolutionManifest {
  version: 1
  updatedAt: string
  files: Array<{
    source: typeof PLAYER_PLAYBACK_RECOVERY_FILENAME | typeof TRANSACTION_FILENAME | typeof PREVIOUS_FILENAME
    archive: string
    sha256: string
    size: number
  }>
}

function sameFileVersion(pathStats: fs.Stats, descriptorStats: fs.Stats): boolean {
  return pathStats.dev === descriptorStats.dev && pathStats.ino === descriptorStats.ino &&
    pathStats.size === descriptorStats.size && pathStats.mtimeMs === descriptorStats.mtimeMs &&
    pathStats.ctimeMs === descriptorStats.ctimeMs
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
}

function validateRecord(value: unknown): PlayerPlaybackRecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O registro local de recuperação do Player não é um objeto válido.')
  }
  const record = value as Record<string, unknown>
  const allowed = new Set(['version', 'revision', 'status', 'attemptId', 'musicCode', 'playbackStatus',
    'lastTransition', 'updatedAt', 'startedAt', 'terminalAt', 'reason'])
  if (Object.keys(record).some(key => !allowed.has(key)) ||
      ['version', 'revision', 'status', 'lastTransition', 'updatedAt'].some(key => !(key in record))) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O registro de recuperação contém campos ausentes ou desconhecidos.')
  }
  if (record.version !== VERSION) {
    throw new PlayerPlaybackRecoveryStoreError('UNSUPPORTED_VERSION', 'A versão do registro de recuperação do Player não é compatível.')
  }
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1 ||
      typeof record.status !== 'string' || !STATUSES.has(record.status as PlayerPlaybackRecoveryStatus) ||
      typeof record.lastTransition !== 'string' || !TRANSITIONS.has(record.lastTransition as PlayerPlaybackRecoveryTransition) ||
      !isTimestamp(record.updatedAt)) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O registro de recuperação contém valores inválidos.')
  }
  if (record.attemptId !== undefined && (typeof record.attemptId !== 'string' || !ID_PATTERN.test(record.attemptId))) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'A identidade da tentativa no registro de recuperação é inválida.')
  }
  if (record.musicCode !== undefined && !isCanonicalVideoCode(record.musicCode)) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O código de música no registro de recuperação é inválido.')
  }
  if (record.playbackStatus !== undefined &&
      (typeof record.playbackStatus !== 'string' || !PLAYBACK_STATUSES.has(record.playbackStatus as PlayerPlaybackStatus))) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O estado de reprodução no registro de recuperação é inválido.')
  }
  if ((record.attemptId === undefined) !== (record.musicCode === undefined)) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'A identidade e o código da tentativa precisam aparecer juntos.')
  }
  if (record.status !== 'idle' && (!record.attemptId || !record.playbackStatus)) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O estado de recuperação precisa identificar tentativa, código e estado de reprodução.')
  }
  if (record.startedAt !== undefined && !isTimestamp(record.startedAt)) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O horário inicial do registro de recuperação é inválido.')
  }
  if (record.terminalAt !== undefined && !isTimestamp(record.terminalAt)) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O horário terminal do registro de recuperação é inválido.')
  }
  if (record.reason !== undefined && (typeof record.reason !== 'string' || record.reason.length > 80 || /[\0-\x1f]/.test(record.reason))) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O motivo do registro de recuperação é inválido.')
  }
  const transition = record.lastTransition as PlayerPlaybackRecoveryTransition
  const status = record.status as PlayerPlaybackRecoveryStatus
  const playbackStatus = record.playbackStatus as PlayerPlaybackStatus | undefined
  const pendingTransitionStates: Partial<Record<PlayerPlaybackRecoveryTransition, PlayerPlaybackStatus[]>> = {
    'load-intent': ['loading'],
    'media-ready': ['ready'],
    'play-intent': ['starting'],
    'pause-intent': ['starting', 'playing'],
    'resume-intent': ['starting'],
    'stop-intent': ['stopping'],
    'replacement-stop-intent': ['stopping'],
    'shutdown-stop-intent': ['stopping']
  }
  const coherent = status === 'pending'
    ? pendingTransitionStates[transition]?.includes(playbackStatus!) === true && record.terminalAt === undefined
    : status === 'playing'
      ? transition === 'playback-started' && playbackStatus === 'playing' && record.terminalAt === undefined
      : status === 'paused'
        ? transition === 'playback-paused' && playbackStatus === 'paused' && record.terminalAt === undefined
        : status === 'uncertain'
          ? ['playback-uncertain', 'host-terminated', 'containment-updated'].includes(transition) &&
            playbackStatus === 'uncertain' && record.terminalAt === undefined
          : status === 'completed'
            ? transition === 'natural-end-confirmed' && playbackStatus === 'completed' && record.terminalAt !== undefined
            : status === 'stopped'
              ? ['stop-confirmed', 'replacement-interrupted', 'shutdown-confirmed'].includes(transition) &&
                playbackStatus === 'stopped' && record.terminalAt !== undefined
              : status === 'failed'
                ? transition === 'playback-failed' && playbackStatus === 'failed' && record.terminalAt !== undefined
                : status === 'dismissed'
                  ? transition === 'recovery-dismissed' && playbackStatus === 'stopped' && record.terminalAt !== undefined
                  : status === 'idle'
                    ? transition === 'invalid-recovery-resolved' && playbackStatus === 'idle' &&
                      record.attemptId === undefined && record.musicCode === undefined &&
                      record.startedAt === undefined && record.terminalAt === undefined
                    : false
  if (!coherent || (status !== 'idle' && record.startedAt === undefined)) {
    throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O estado, a transição e os horários do registro de recuperação são incoerentes.')
  }
  return { ...record } as unknown as PlayerPlaybackRecoveryRecord
}

/** Player-only versioned file store. It never opens or mutates Controller SQLite. */
export class PlayerPlaybackRecoveryStore {
  readonly filePath: string

  constructor(private readonly userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, PLAYER_PLAYBACK_RECOVERY_FILENAME)
  }

  read(): PlayerPlaybackRecoveryRecord | undefined {
    this.recoverInvalidResolution()
    this.recoverInterruptedWrite()
    return this.readRecordFromPath(this.filePath)
  }

  private readRecordFromPath(filePath: string): PlayerPlaybackRecoveryRecord | undefined {
    let descriptor: number
    let linkStats: fs.Stats
    try {
      linkStats = fs.lstatSync(filePath)
      const attributes = (linkStats as fs.Stats & { attributes?: number }).attributes ?? 0
      if (!linkStats.isFile() || linkStats.isSymbolicLink() || (process.platform === 'win32' && (attributes & 0x400) !== 0)) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'O registro de recuperação do Player não é um arquivo regular.')
      }
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY |
        (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (error instanceof PlayerPlaybackRecoveryStoreError) throw error
      throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'Não foi possível ler o registro de recuperação do Player; o arquivo foi preservado.')
    }

    let bytes: Buffer
    try {
      const stats = fs.fstatSync(descriptor)
      if (!stats.isFile() || !sameFileVersion(linkStats, stats) || stats.size > MAX_BYTES) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'O registro de recuperação do Player é inválido ou excede o tamanho permitido; o arquivo foi preservado.')
      }
      const bounded = Buffer.allocUnsafe(MAX_BYTES + 1)
      let offset = 0
      while (offset < bounded.byteLength) {
        const count = fs.readSync(descriptor, bounded, offset, bounded.byteLength - offset, null)
        if (count === 0) break
        offset += count
      }
      if (offset > MAX_BYTES) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'O registro de recuperação do Player excede o tamanho permitido; o arquivo foi preservado.')
      }
      if (!sameFileVersion(stats, fs.fstatSync(descriptor))) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'O registro de recuperação mudou durante a leitura; o arquivo foi preservado.')
      }
      bytes = bounded.subarray(0, offset)
    } catch (error) {
      if (error instanceof PlayerPlaybackRecoveryStoreError) throw error
      throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'O registro de recuperação do Player não pôde ser lido; o arquivo foi preservado.')
    } finally {
      fs.closeSync(descriptor)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'O registro de recuperação do Player está truncado ou não contém UTF-8/JSON válido; o arquivo foi preservado.')
    }
    return validateRecord(parsed)
  }

  protected syncDirectory(): void {
    if (process.platform === 'win32') return
    const directoryDescriptor = fs.openSync(this.userDataDirectory, fs.constants.O_RDONLY)
    try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
  }

  protected moveSourceToArchive(sourcePath: string, archivePath: string): void {
    fs.renameSync(sourcePath, archivePath)
  }

  private transactionPath(): string { return path.join(this.userDataDirectory, TRANSACTION_FILENAME) }
  private previousPath(): string { return path.join(this.userDataDirectory, PREVIOUS_FILENAME) }
  private resolutionPath(): string { return path.join(this.userDataDirectory, RESOLUTION_FILENAME) }

  /** Preserves invalid recovery files and creates a verified safe idle record. */
  resolveInvalidRecord(updatedAt: string): { preservedFileCount: number } {
    if (!isTimestamp(updatedAt)) throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O horário da resolução é inválido.')
    fs.mkdirSync(this.userDataDirectory, { recursive: true })
    let manifest = this.readResolutionManifest()
    if (!manifest) {
      let invalid = false
      try {
        const current = this.read()
        if (current) throw new PlayerPlaybackRecoveryStoreError('INVALID_RECORD', 'O estado de recuperação já é válido.')
      } catch (error) {
        if (error instanceof PlayerPlaybackRecoveryStoreError && error.code === 'INVALID_RECORD' && error.message === 'O estado de recuperação já é válido.') throw error
        invalid = true
      }
      if (!invalid) throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'Não há recuperação inválida a resolver.')
      const sources = [PLAYER_PLAYBACK_RECOVERY_FILENAME, TRANSACTION_FILENAME, PREVIOUS_FILENAME] as const
      const contents: Array<{ source: typeof sources[number]; bytes: Buffer }> = []
      for (const source of sources) {
        const bytes = this.readBytesFromPath(path.join(this.userDataDirectory, source))
        if (bytes) contents.push({ source, bytes })
      }
      if (contents.length === 0) throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'Não há evidência de recuperação inválida para preservar.')
      const archiveCount = fs.readdirSync(this.userDataDirectory).filter(name => name.startsWith(QUARANTINE_PREFIX)).length
      if (archiveCount + contents.length > 50) throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'O limite local de evidências preservadas foi atingido.')
      manifest = {
        version: 1, updatedAt,
        files: contents.map(({ source, bytes }) => ({
          source, archive: `${QUARANTINE_PREFIX}${crypto.randomUUID()}.bin`,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength
        }))
      }
      this.writeAtomicPath(this.resolutionPath(), `${JSON.stringify(manifest)}\n`)
    }
    this.completeInvalidResolution(manifest)
    return { preservedFileCount: manifest.files.length }
  }

  private readResolutionManifest(): RecoveryResolutionManifest | undefined {
    const bytes = this.readBytesFromPath(this.resolutionPath())
    if (!bytes) return undefined
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'A transação de preservação está inválida; os dados foram preservados.') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'A transação de preservação está inválida.')
    const item = value as Record<string, unknown>
    if (Object.keys(item).some(key => !['version', 'updatedAt', 'files'].includes(key)) || item.version !== 1 ||
        !isTimestamp(item.updatedAt) || !Array.isArray(item.files) || item.files.length < 1 || item.files.length > 3) {
      throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'A transação de preservação contém valores inválidos.')
    }
    const allowed = new Set([PLAYER_PLAYBACK_RECOVERY_FILENAME, TRANSACTION_FILENAME, PREVIOUS_FILENAME])
    const files: RecoveryResolutionManifest['files'] = []
    for (const raw of item.files) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'A transação de preservação contém um item inválido.')
      const file = raw as Record<string, unknown>
      const archiveValid = typeof file.archive === 'string' &&
        /^player-playback-recovery-quarantine-[0-9a-f-]{36}\.bin$/.test(file.archive)
      if (Object.keys(file).some(key => !['source', 'archive', 'sha256', 'size'].includes(key)) ||
          typeof file.source !== 'string' || !allowed.has(file.source) || !archiveValid ||
          typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
          !Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > MAX_BYTES ||
          files.some(entry => entry.source === file.source || entry.archive === file.archive)) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'A transação de preservação contém valores inválidos.')
      }
      files.push(file as unknown as RecoveryResolutionManifest['files'][number])
    }
    return { version: 1, updatedAt: item.updatedAt as string, files }
  }

  private completeInvalidResolution(manifest: RecoveryResolutionManifest): void {
    for (const item of manifest.files) {
      const archivePath = path.join(this.userDataDirectory, item.archive)
      const archived = this.readBytesFromPath(archivePath)
      if (archived) {
        if (archived.byteLength !== item.size || crypto.createHash('sha256').update(archived).digest('hex') !== item.sha256) {
          throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'A evidência preservada não passou na verificação.')
        }
        if (this.readBytesFromPath(path.join(this.userDataDirectory, item.source))) {
          const idle = item.source === PLAYER_PLAYBACK_RECOVERY_FILENAME
            ? this.readResolvedIdleRecord(manifest)
            : undefined
          if (!idle) throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'O arquivo original reapareceu após a preservação; a recuperação permanece bloqueada.')
        }
        continue
      }
      const sourcePath = path.join(this.userDataDirectory, item.source)
      const source = this.readBytesFromPath(sourcePath)
      if (!source || source.byteLength !== item.size || crypto.createHash('sha256').update(source).digest('hex') !== item.sha256) {
        throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'A evidência original mudou antes da preservação.')
      }
      try {
        // Same-directory rename removes the exact verified directory entry atomically.
        // The post-rename hash check fails closed if another local writer replaced it.
        this.moveSourceToArchive(sourcePath, archivePath)
      } catch {
        throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'O arquivo de recuperação não pôde ser movido para quarentena; a reprodução continua bloqueada.')
      }
      this.syncDirectory()
      const verified = this.readBytesFromPath(archivePath)
      if (!verified || verified.byteLength !== item.size || crypto.createHash('sha256').update(verified).digest('hex') !== item.sha256) {
        throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'A evidência movida para quarentena não passou na verificação; ela foi preservada e a reprodução continua bloqueada.')
      }
      if (this.readBytesFromPath(sourcePath)) {
        throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'O arquivo original reapareceu após a preservação; a recuperação permanece bloqueada.')
      }
    }

    for (const item of manifest.files) {
      const sourcePath = path.join(this.userDataDirectory, item.source)
      const source = this.readBytesFromPath(sourcePath)
      let current: PlayerPlaybackRecoveryRecord | undefined
      if (item.source === PLAYER_PLAYBACK_RECOVERY_FILENAME) {
        try { current = this.readRecordFromPath(this.filePath) } catch { current = undefined }
      }
      if (current && this.isResolvedIdleRecord(current, manifest)) continue
      if (source) throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'A evidência original ainda está presente; a recuperação continua bloqueada.')
    }

    const existing = this.readRecordFromPath(this.filePath)
    if (existing?.status !== 'idle' || existing.lastTransition !== 'invalid-recovery-resolved') {
      const idle = validateRecord({ version: 1, revision: 1, status: 'idle', playbackStatus: 'idle',
        lastTransition: 'invalid-recovery-resolved', updatedAt: manifest.updatedAt })
      this.writeAtomicPath(this.filePath, `${JSON.stringify(idle)}\n`)
    }
    const verifiedIdle = this.readRecordFromPath(this.filePath)
    if (!verifiedIdle || verifiedIdle.status !== 'idle' || verifiedIdle.lastTransition !== 'invalid-recovery-resolved') {
      throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'O estado parado após a preservação não pôde ser confirmado.')
    }
    fs.unlinkSync(this.resolutionPath())
    this.syncDirectory()
  }

  private readResolvedIdleRecord(manifest: RecoveryResolutionManifest): PlayerPlaybackRecoveryRecord | undefined {
    try {
      const record = this.readRecordFromPath(this.filePath)
      return record && this.isResolvedIdleRecord(record, manifest) ? record : undefined
    } catch { return undefined }
  }

  private isResolvedIdleRecord(record: PlayerPlaybackRecoveryRecord, manifest: RecoveryResolutionManifest): boolean {
    return record.version === 1 && record.revision === 1 && record.status === 'idle' &&
      record.playbackStatus === 'idle' && record.lastTransition === 'invalid-recovery-resolved' &&
      record.updatedAt === manifest.updatedAt && record.attemptId === undefined &&
      record.musicCode === undefined && record.startedAt === undefined && record.terminalAt === undefined &&
      record.reason === undefined
  }

  private recoverInvalidResolution(): void {
    const manifest = this.readResolutionManifest()
    if (manifest) this.completeInvalidResolution(manifest)
  }

  private readTransaction(): RecoveryTransaction | undefined {
    const bytes = this.readBytesFromPath(this.transactionPath())
    if (!bytes) return undefined
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'A transação do estado de recuperação está corrompida; os arquivos foram preservados.') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'A transação do estado de recuperação é inválida; os arquivos foram preservados.')
    }
    const record = value as Record<string, unknown>
    if (Object.keys(record).some(key => !['version', 'phase', 'targetRevision', 'previousRevision'].includes(key)) ||
        record.version !== 1 || !['prepared', 'committed'].includes(String(record.phase)) ||
        !Number.isSafeInteger(record.targetRevision) || (record.targetRevision as number) < 1 ||
        (record.previousRevision !== undefined && (!Number.isSafeInteger(record.previousRevision) ||
          (record.previousRevision as number) < 1 || (record.previousRevision as number) >= (record.targetRevision as number)))) {
      throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'A transação do estado de recuperação contém valores inválidos; os arquivos foram preservados.')
    }
    return record as unknown as RecoveryTransaction
  }

  private readBytesFromPath(filePath: string): Buffer | undefined {
    let descriptor: number
    let linkStats: fs.Stats
    try {
      linkStats = fs.lstatSync(filePath)
      const attributes = (linkStats as fs.Stats & { attributes?: number }).attributes ?? 0
      if (!linkStats.isFile() || linkStats.isSymbolicLink() || (process.platform === 'win32' && (attributes & 0x400) !== 0)) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'Um arquivo auxiliar do estado de recuperação não é regular; os arquivos foram preservados.')
      }
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY |
        (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (error instanceof PlayerPlaybackRecoveryStoreError) throw error
      throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'Um arquivo auxiliar do estado de recuperação não pôde ser lido; os arquivos foram preservados.')
    }
    try {
      const stats = fs.fstatSync(descriptor)
      if (!stats.isFile() || !sameFileVersion(linkStats, stats) || stats.size > MAX_BYTES) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'Um arquivo auxiliar do estado de recuperação excede o tamanho permitido; os arquivos foram preservados.')
      }
      const bytes = Buffer.allocUnsafe(MAX_BYTES + 1)
      let offset = 0
      while (offset < bytes.byteLength) {
        const count = fs.readSync(descriptor, bytes, offset, bytes.byteLength - offset, null)
        if (count === 0) break
        offset += count
      }
      if (offset > MAX_BYTES) throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'Um arquivo auxiliar do estado de recuperação excede o tamanho permitido; os arquivos foram preservados.')
      if (!sameFileVersion(stats, fs.fstatSync(descriptor))) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'Um arquivo auxiliar mudou durante a leitura; os arquivos foram preservados.')
      }
      return bytes.subarray(0, offset)
    } catch (error) {
      if (error instanceof PlayerPlaybackRecoveryStoreError) throw error
      throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'Um arquivo auxiliar do estado de recuperação não pôde ser lido; os arquivos foram preservados.')
    } finally { fs.closeSync(descriptor) }
  }

  protected writeAtomicPath(filePath: string, content: string | Uint8Array): void {
    const temporaryPath = path.join(this.userDataDirectory,
      `.player-recovery-write.${process.pid}.${crypto.randomUUID()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
      if (typeof content === 'string') fs.writeFileSync(descriptor, content, 'utf8')
      else fs.writeFileSync(descriptor, content)
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      fs.renameSync(temporaryPath, filePath)
      this.syncDirectory()
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch {}
      }
      try { fs.unlinkSync(temporaryPath) } catch {}
      throw error
    }
  }

  private removeTransactionFiles(): void {
    try {
      fs.unlinkSync(this.transactionPath())
      this.syncDirectory()
    } catch {
      // Keep the previous snapshot until removal of the transaction marker is durable.
      return
    }
    try {
      fs.unlinkSync(this.previousPath())
      this.syncDirectory()
    } catch { /* A leftover backup is ignored when no transaction marker exists. */ }
  }

  private recoverInterruptedWrite(): void {
    const transaction = this.readTransaction()
    if (!transaction) return
    const target = this.readRecordFromPath(this.filePath)
    if (transaction.phase === 'committed') {
      if (!target || target.revision !== transaction.targetRevision) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'O registro confirmado não corresponde à transação; os arquivos foram preservados.')
      }
      this.removeTransactionFiles()
      return
    }

    if (transaction.previousRevision !== undefined) {
      const previous = this.readRecordFromPath(this.previousPath())
      if (!previous || previous.revision !== transaction.previousRevision) {
        throw new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'A cópia anterior da transação não pôde ser validada; os arquivos foram preservados.')
      }
      this.writeAtomicPath(this.filePath, `${JSON.stringify(previous)}\n`)
    } else if (target) {
      fs.unlinkSync(this.filePath)
      this.syncDirectory()
    }
    this.removeTransactionFiles()
  }

  write(value: PlayerPlaybackRecoveryRecord): PlayerPlaybackRecoveryRecord {
    const record = validateRecord(value)
    try {
      fs.mkdirSync(this.userDataDirectory, { recursive: true })
      const previous = this.read()
      if (this.readTransaction()) throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'Há uma transação anterior de recuperação que ainda precisa ser resolvida.')
      try { fs.unlinkSync(this.previousPath()) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (previous) this.writeAtomicPath(this.previousPath(), `${JSON.stringify(previous)}\n`)
      const prepared: RecoveryTransaction = {
        version: 1, phase: 'prepared', targetRevision: record.revision,
        previousRevision: previous?.revision
      }
      this.writeAtomicPath(this.transactionPath(), `${JSON.stringify(prepared)}\n`)
      this.writeAtomicPath(this.filePath, `${JSON.stringify(record)}\n`)
      const committed: RecoveryTransaction = { ...prepared, phase: 'committed' }
      this.writeAtomicPath(this.transactionPath(), `${JSON.stringify(committed)}\n`)
      this.removeTransactionFiles()
      return record
    } catch (error) {
      if (error instanceof PlayerPlaybackRecoveryStoreError) throw error
      throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'Não foi possível confirmar a gravação do estado de recuperação do Player.')
    }
  }
}
