import {
  PlayerPlaybackError,
  type PlayerPlaybackPersistence,
  type PlayerPlaybackPersistenceTransition,
  type PlayerPlaybackRecoveryTarget,
  type PlayerPlaybackState
} from './player-playback-contracts'
import type { ManualPlaybackResult, ManualPlaybackService } from './manual-playback-service'
import type {
  PlayerRecoveryDiagnosticSummary,
  PlayerRecoverySnapshot,
  PlayerShutdownRequest,
  PlayerShutdownResult
} from './player-playback-recovery-contracts'
export type {
  PlayerRecoveryDiagnosticSummary,
  PlayerRecoverySnapshot,
  PlayerShutdownRequest,
  PlayerShutdownResult
} from './player-playback-recovery-contracts'
import {
  PlayerPlaybackRecoveryStore,
  PlayerPlaybackRecoveryStoreError,
  type PlayerPlaybackRecoveryRecord,
  type PlayerPlaybackRecoveryStatus
} from './player-playback-recovery-store'
import type { PlayerPlaybackService } from './player-playback-service'

function recoveryStatus(transition: PlayerPlaybackPersistenceTransition, next: PlayerPlaybackState): PlayerPlaybackRecoveryStatus {
  switch (transition) {
    case 'playback-started': return 'playing'
    case 'playback-paused': return 'paused'
    case 'natural-end-confirmed': return 'completed'
    case 'stop-confirmed':
    case 'replacement-interrupted':
    case 'shutdown-confirmed': return 'stopped'
    case 'playback-failed': return 'failed'
    case 'recovery-dismissed': return 'dismissed'
    case 'playback-uncertain':
    case 'host-terminated': return 'uncertain'
    case 'containment-updated': return next.status === 'uncertain' ? 'uncertain' : 'pending'
    default: return 'pending'
  }
}

function isRecoveryPending(record: PlayerPlaybackRecoveryRecord): boolean {
  return ['pending', 'playing', 'paused', 'uncertain'].includes(record.status)
}

/** Coordinates durable Player recovery and explicit decisions without owning playback state. */
export class PlayerPlaybackRecoveryCoordinator implements PlayerPlaybackPersistence {
  private record: PlayerPlaybackRecoveryRecord | undefined
  private readFailure: PlayerPlaybackRecoveryStoreError | undefined
  private writeFailure = false
  private playback: PlayerPlaybackRecoveryTarget | undefined
  private manual: ManualPlaybackService | undefined
  private resolvingRecoveryAttempt: string | undefined
  private startupRecoveryRequired = false
  private confirmedShutdownAttempt: string | undefined
  private shutdownPromise: Promise<PlayerShutdownResult> | undefined

  constructor(private readonly store: PlayerPlaybackRecoveryStore, private readonly now: () => Date = () => new Date()) {}

  initialize(): PlayerRecoverySnapshot {
    try {
      this.record = this.store.read()
      this.readFailure = undefined
      this.startupRecoveryRequired = Boolean(this.record && isRecoveryPending(this.record))
    } catch (error) {
      this.readFailure = error instanceof PlayerPlaybackRecoveryStoreError
        ? error
        : new PlayerPlaybackRecoveryStoreError('UNREADABLE', 'O estado de recuperação não pôde ser lido.')
      this.record = undefined
      this.startupRecoveryRequired = true
    }
    return this.getState()
  }

  attach(playback: PlayerPlaybackService, manual: ManualPlaybackService): void {
    this.attachPlayback(playback)
    this.manual = manual
  }

  /** Attaches the technical playback service without requiring the legacy sequence orchestrator. */
  attachPlayback(playback: PlayerPlaybackRecoveryTarget): void {
    if (this.playback || this.manual) throw new PlayerPlaybackError('INVALID_STATE', 'A recuperação do Player já foi conectada.')
    this.playback = playback
  }

  getState(): PlayerRecoverySnapshot {
    if (this.readFailure) {
      const code = this.readFailure.code
      return { status: 'unreadable', reason: code === 'UNSUPPORTED_VERSION' || code === 'INVALID_RECORD' ? code : 'UNREADABLE' }
    }
    if (this.writeFailure) return { status: 'unavailable', reason: 'WRITE_FAILED' }
    const record = this.record
    if (!record || record.status === 'idle') return { status: 'none' }
    if (isRecoveryPending(record)) {
      const currentPlayback = this.playback?.getState()
      const sameCurrentAttempt = currentPlayback?.attemptId === record.attemptId
      const activeInThisProcess = currentPlayback !== undefined && sameCurrentAttempt &&
        ['loading', 'starting', 'ready', 'playing', 'paused', 'stopping'].includes(currentPlayback.status)
      const uncertainInThisProcess = currentPlayback !== undefined && sameCurrentAttempt &&
        (currentPlayback.status === 'uncertain' || currentPlayback.status === 'disposed')

      // An active record is durable evidence for a future restart, but it is
      // not a recovery decision while the same attempt is progressing in this
      // process. Startup leftovers and uncertain runtime outcomes remain
      // actionable recovery states.
      if (!activeInThisProcess || this.startupRecoveryRequired || uncertainInThisProcess) {
        return {
          status: 'pending', attemptId: record.attemptId!, musicCode: record.musicCode!,
          playbackStatus: record.playbackStatus ?? 'uncertain', lastTransition: record.lastTransition,
          updatedAt: record.updatedAt
        }
      }
      return { status: 'none' }
    }
    return {
      status: 'resolved', outcome: record.status as 'completed' | 'stopped' | 'failed' | 'dismissed',
      attemptId: record.attemptId, musicCode: record.musicCode, updatedAt: record.updatedAt
    }
  }

  getDiagnosticSummary(): PlayerRecoveryDiagnosticSummary | null {
    if (this.readFailure) {
      const code = this.readFailure.code
      return { code, message: code === 'UNSUPPORTED_VERSION'
        ? 'O estado de recuperação foi criado por uma versão incompatível.'
        : code === 'INVALID_RECORD'
          ? 'O estado de recuperação contém dados inválidos e foi preservado.'
          : 'O estado de recuperação não pôde ser lido e foi preservado.' }
    }
    if (this.writeFailure) return { code: 'WRITE_FAILED', message: 'A gravação do estado de recuperação falhou; a reprodução permanece bloqueada.' }
    return null
  }

  /** Only resolves an unreadable record after the store verifies durable quarantine and idle state. */
  resolveInvalidRecovery(): { state: PlayerRecoverySnapshot; preservedFileCount: number } {
    if (!this.readFailure) throw new PlayerPlaybackError('INVALID_STATE', 'Não há estado de recuperação inválido para resolver.')
    const previousFailure = this.readFailure
    try {
      const result = this.store.resolveInvalidRecord(this.now().toISOString())
      this.record = this.store.read()
      if (!this.record || this.record.status !== 'idle' || this.record.lastTransition !== 'invalid-recovery-resolved') {
        throw new PlayerPlaybackError('RECOVERY_UNAVAILABLE', 'O estado parado após a preservação não pôde ser validado.')
      }
      this.readFailure = undefined
      this.writeFailure = false
      this.startupRecoveryRequired = false
      return { state: this.getState(), preservedFileCount: result.preservedFileCount }
    } catch (error) {
      this.readFailure = previousFailure
      throw error instanceof PlayerPlaybackError ? error
        : new PlayerPlaybackError('RECOVERY_UNAVAILABLE', 'A recuperação inválida não pôde ser preservada com segurança; a reprodução continua bloqueada.')
    }
  }

  /** Called inside PlayerPlaybackService's serialized transition before state or media effects are published. */
  persistTransition(
    next: PlayerPlaybackState,
    previous: PlayerPlaybackState,
    transition: PlayerPlaybackPersistenceTransition
  ): void {
    this.ensureWritable()
    if (!next.attemptId || !next.musicCode) return
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(next.attemptId) ||
        !/^\d{5}$/.test(next.musicCode)) {
      this.writeFailure = true
      throw new PlayerPlaybackError('RECOVERY_PERSISTENCE_FAILED', 'A identidade da reprodução não pôde ser registrada com segurança.')
    }

    const timestamp = this.now().toISOString()
    const status = recoveryStatus(transition, next)
    const sameAttempt = this.record?.attemptId === next.attemptId
    const terminal = ['completed', 'stopped', 'failed', 'dismissed'].includes(status)
    this.writeRecord({
      status,
      attemptId: next.attemptId,
      musicCode: next.musicCode,
      playbackStatus: next.status,
      lastTransition: transition,
      updatedAt: timestamp,
      startedAt: sameAttempt ? this.record?.startedAt : timestamp,
      terminalAt: terminal ? timestamp : undefined,
      reason: next.errorCode ?? (transition === 'natural-end-confirmed' ? 'natural-end-candidate' : terminal ? transition : undefined)
    })
    if (this.resolvingRecoveryAttempt) this.startupRecoveryRequired = false
  }

  assertPlaybackAllowed(recoveryAttemptId?: string): void {
    this.ensureWritable()
    const state = this.getState()
    if (this.startupRecoveryRequired && state.status === 'pending') {
      if (!recoveryAttemptId || recoveryAttemptId !== state.attemptId ||
          this.resolvingRecoveryAttempt !== recoveryAttemptId) {
        throw new PlayerPlaybackError('RECOVERY_PENDING', 'Resolva explicitamente a reprodução anterior antes de iniciar outra música.')
      }
      this.requirePendingAttempt(recoveryAttemptId)
    }
  }

  async replayPrevious(expectedAttemptId: string): Promise<ManualPlaybackResult> {
    const record = this.requirePendingAttempt(expectedAttemptId)
    const manualInput = record.musicCode!.replace(/^0+(?=\d)/, '')
    return this.runRecoverySelection(expectedAttemptId, manualInput)
  }

  async chooseAnother(expectedAttemptId: string, musicCode: unknown): Promise<ManualPlaybackResult> {
    this.requirePendingAttempt(expectedAttemptId)
    return this.runRecoverySelection(expectedAttemptId, musicCode)
  }

  private async runRecoverySelection(expectedAttemptId: string, musicCode: unknown): Promise<ManualPlaybackResult> {
    if (this.resolvingRecoveryAttempt) throw new PlayerPlaybackError('SUPERSEDED', 'Outra ação de recuperação já está em andamento.')
    this.resolvingRecoveryAttempt = expectedAttemptId
    try {
      this.requirePendingAttempt(expectedAttemptId)
      return await this.requireManual().playByMusicCode(musicCode,
        () => { this.requirePendingAttempt(expectedAttemptId) }, expectedAttemptId)
    } finally {
      if (this.resolvingRecoveryAttempt === expectedAttemptId) this.resolvingRecoveryAttempt = undefined
    }
  }

  async leaveStopped(expectedAttemptId: string): Promise<PlayerRecoverySnapshot> {
    const record = this.requirePendingAttempt(expectedAttemptId)
    if (this.resolvingRecoveryAttempt === expectedAttemptId) {
      throw new PlayerPlaybackError('SUPERSEDED', 'A recuperação já está sendo resolvida.')
    }
    this.resolvingRecoveryAttempt = expectedAttemptId
    try {
      await this.requirePlayback().resolveRecoveryAsStopped(expectedAttemptId, record.musicCode!)
      this.startupRecoveryRequired = false
      return this.getState()
    } finally {
      if (this.resolvingRecoveryAttempt === expectedAttemptId) this.resolvingRecoveryAttempt = undefined
    }
  }

  requestShutdown(): PlayerShutdownRequest {
    const state = this.playback?.getState() ?? { status: 'idle' as const }
    const mayStillPlay = ['loading', 'starting', 'ready', 'playing', 'paused', 'stopping'].includes(state.status) ||
      (state.status === 'uncertain' && !['stop-acknowledged', 'host-terminated'].includes(state.containmentStatus ?? ''))
    if (mayStillPlay && state.attemptId) {
      return { outcome: 'confirmation-required', attemptId: state.attemptId,
        musicCode: state.musicCode, playbackStatus: state.status }
    }
    return { outcome: 'allowed' }
  }

  cancelShutdown(expectedAttemptId: string): PlayerShutdownResult {
    const state = this.requirePlayback().getState()
    if (this.confirmedShutdownAttempt === expectedAttemptId) {
      throw new PlayerPlaybackError('SUPERSEDED', 'O encerramento já foi confirmado e não pode ser cancelado.')
    }
    if (state.attemptId !== expectedAttemptId || this.requestShutdown().outcome !== 'confirmation-required') {
      throw new PlayerPlaybackError('SUPERSEDED', 'A decisão de encerramento pertence a outra tentativa.')
    }
    return { outcome: 'cancelled', attemptId: expectedAttemptId }
  }

  confirmShutdown(expectedAttemptId: string): Promise<PlayerShutdownResult> {
    if (this.shutdownPromise) {
      if (this.confirmedShutdownAttempt !== expectedAttemptId) {
        return Promise.reject(new PlayerPlaybackError('SUPERSEDED', 'Outro encerramento já está em andamento.'))
      }
      return this.shutdownPromise
    }
    const current = this.requestShutdown()
    if (current.outcome !== 'confirmation-required' || current.attemptId !== expectedAttemptId) {
      return Promise.reject(new PlayerPlaybackError('SUPERSEDED', 'A decisão de encerramento está obsoleta.'))
    }
    this.confirmedShutdownAttempt = expectedAttemptId
    this.shutdownPromise = this.performConfirmedShutdown(expectedAttemptId)
    return this.shutdownPromise
  }

  private async performConfirmedShutdown(expectedAttemptId: string): Promise<PlayerShutdownResult> {
    try { await this.requireManual().stopAndClose() } catch { /* The typed playback state below remains authoritative. */ }
    const state = this.requirePlayback().getState()
    if (state.attemptId !== expectedAttemptId) throw new PlayerPlaybackError('SUPERSEDED', 'A tentativa mudou durante o encerramento.')
    const outcome = state.status === 'stopped' ? 'stopped' : state.status === 'completed' ? 'completed' : 'uncertain'
    await this.requirePlayback().dispose()
    return { outcome, attemptId: expectedAttemptId, recovery: this.getState() }
  }

  dispose(): void {
    this.manual = undefined
    this.playback = undefined
  }

  private writeRecord(record: Omit<PlayerPlaybackRecoveryRecord, 'version' | 'revision' | 'updatedAt'> & { updatedAt?: string }): void {
    const next: PlayerPlaybackRecoveryRecord = {
      version: 1,
      revision: (this.record?.revision ?? 0) + 1,
      ...record,
      updatedAt: record.updatedAt ?? this.now().toISOString()
    }
    try {
      this.record = this.store.write(next)
    } catch (error) {
      this.writeFailure = true
      const code = error instanceof PlayerPlaybackRecoveryStoreError ? error.code : 'WRITE_FAILED'
      throw new PlayerPlaybackError('RECOVERY_PERSISTENCE_FAILED', `O estado de recuperação não pôde ser confirmado (${code}).`)
    }
  }

  private ensureWritable(): void {
    if (this.readFailure) throw new PlayerPlaybackError('RECOVERY_UNAVAILABLE', 'O registro de recuperação não pôde ser validado; a reprodução permanece bloqueada.')
    if (this.writeFailure) throw new PlayerPlaybackError('RECOVERY_UNAVAILABLE', 'A persistência de recuperação falhou; reinicie o Player para tentar novamente.')
  }

  private requirePendingAttempt(expectedAttemptId: string): PlayerPlaybackRecoveryRecord {
    this.ensureWritable()
    const snapshot = this.getState()
    if (snapshot.status !== 'pending' || snapshot.attemptId !== expectedAttemptId || !this.record?.musicCode) {
      throw new PlayerPlaybackError('SUPERSEDED', 'A ação de recuperação está obsoleta ou não há recuperação pendente.')
    }
    return this.record
  }

  private requireManual(): ManualPlaybackService {
    if (!this.manual) throw new PlayerPlaybackError('RECOVERY_UNAVAILABLE', 'O serviço manual do Player ainda não está inicializado.')
    return this.manual
  }

  private requirePlayback(): PlayerPlaybackRecoveryTarget {
    if (!this.playback) throw new PlayerPlaybackError('RECOVERY_UNAVAILABLE', 'O serviço de playback ainda não está inicializado.')
    return this.playback
  }
}
