import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { PlayerPlaybackError } from './player-playback-contracts'
import type { PlayerPlaybackState } from './player-playback-contracts'
import {
  createInitialStandalonePlayerSnapshot,
  type StandaloneBlockedSnapshot,
  type StandaloneCommandExecutionResult,
  type StandaloneCelebrationMessage,
  type StandaloneCurrentEntry,
  type StandalonePlaybackCorrelation,
  type StandalonePlaybackEvent,
  type StandalonePlayerCommandRequest,
  type StandalonePlayerCommandResult,
  type StandalonePlayerControl,
  type StandalonePlayerErrorCode,
  type StandalonePlayerListener,
  type StandalonePlayerSnapshot,
  type StandaloneQueueEntry,
  type StandaloneStableState,
  type StandaloneStorageRecovery,
  type StandaloneTransitioningSnapshot,
  type StandaloneUncertainSnapshot,
  STANDALONE_CELEBRATION_MESSAGES
} from './standalone-player-contracts'
import {
  createStandalonePlayerComposition,
  type StandaloneCommandContext,
  type StandalonePlayerCompositionOptions,
  type StandalonePreparedCommand
} from './standalone-player-runtime'

const PLAYBACK_CONTROL_CONFIRMATION_TIMEOUT_MS = 15000
export const STANDALONE_INITIAL_COUNTDOWN_MS = 5000
export const STANDALONE_CELEBRATION_MS = 5000
export const STANDALONE_PENDING_QUEUE_LIMIT = 30

export interface StandaloneCountdownScheduler {
  now(): number
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

const defaultCountdownScheduler: StandaloneCountdownScheduler = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface StandalonePlayerSequenceOptions extends Omit<StandalonePlayerCompositionOptions,
  'getSnapshot' | 'getPlaybackCorrelation' | 'prepareCommand' | 'onPlaybackEvent'> {
  /** Injectable only to make queue occurrence identity deterministic in focused tests. */
  createEntryId?: () => string
  /** Main-side monotonic clock and timer; injectable for deterministic countdown tests. */
  countdownScheduler?: StandaloneCountdownScheduler
  /** Injected for deterministic tests; production randomly selects one approved celebration message. */
  selectCelebrationMessage?: () => StandaloneCelebrationMessage
}

interface EntryOrder {
  readonly ticket: number
  readonly priority: 'normal' | 'priority'
}

interface TransitionReservation {
  readonly tokenId: string
  kind: 'start' | 'eof' | 'cleanup' | 'celebration' | 'next' | 'restart' | 'pause' | 'stop-all'
  target?: StandaloneQueueEntry
  readonly operationId?: string
  readonly previous?: StandaloneCurrentEntry
  targetAttemptId?: string
  endedAttemptId?: string
  naturalEndObserved?: boolean
  naturalEndWon?: boolean
  completed?: boolean
  stopConfirmed?: boolean
  pauseAction?: 'pause' | 'resume'
  startPhase?: 'countdown' | 'loading'
  countdownRemainingMs?: number
  countdownDeadlineMs?: number
  countdownPaused?: boolean
  countdownTimer?: unknown
  countdownGeneration?: number
  countdownDisplayedSecond?: number
  shutdownCountdownRemainingMs?: number
  celebrationMessage?: StandaloneCelebrationMessage
  celebrationRemainingMs?: number
  celebrationDeadlineMs?: number
  celebrationPaused?: boolean
  celebrationTimer?: unknown
  celebrationGeneration?: number
  celebrationDisplayedSecond?: number
  celebrationPendingAdmissions?: number
  celebrationExpired?: boolean
  shutdownCelebrationRemainingMs?: number
  recoverBlockedFailure?: boolean
}

/** Main-side owner of the Standalone V1 volatile sequence; it is not wired to Electron startup or IPC. */
export class StandalonePlayerSequence implements StandalonePlayerControl {
  private composition: Awaited<ReturnType<typeof createStandalonePlayerComposition>> | undefined
  private stableState: StandaloneStableState = createInitialStandalonePlayerSnapshot().state
  private pending: StandaloneQueueEntry[] = []
  private readonly entryOrder = new Map<string, EntryOrder>()
  private reservation: TransitionReservation | undefined
  private unavailable: StandaloneBlockedSnapshot | StandaloneUncertainSnapshot | undefined
  private transitional: StandaloneTransitioningSnapshot | undefined
  private readonly listeners = new Set<StandalonePlayerListener>()
  private readonly backgroundEffects = new Set<Promise<void>>()
  private readonly createEntryId: () => string
  private readonly countdownScheduler: StandaloneCountdownScheduler
  private readonly selectCelebrationMessage: () => StandaloneCelebrationMessage
  private harnessSeedOperationId: string | undefined
  private operationEpoch = 0
  private nextAdmissionTicket = 0
  private disposed = false
  private shutdownAdmissionClosed = false
  private disposePromise: Promise<void> | undefined
  private lastCommandContext: StandaloneCommandContext | undefined

  private constructor(private readonly options: StandalonePlayerSequenceOptions) {
    this.createEntryId = options.createEntryId ?? randomUUID
    this.countdownScheduler = options.countdownScheduler ?? defaultCountdownScheduler
    this.selectCelebrationMessage = options.selectCelebrationMessage ?? (() =>
      STANDALONE_CELEBRATION_MESSAGES[Math.floor(Math.random() * STANDALONE_CELEBRATION_MESSAGES.length)]!)
  }

  private storageAvailable = true
  private readonly mediaIdentities = new Map<string, string>()
  private storageRecovery: (StandaloneStorageRecovery & { countdownMs?: number }) | undefined

  /** Root loss alone does not interrupt a buffered playing attempt. */
  async notifyLibraryAvailability(available: boolean): Promise<void> {
    if (this.disposed || this.shutdownAdmissionClosed) return
    await this.composition!.transitions.run(() => {
      if (this.disposed || this.shutdownAdmissionClosed) return
      this.storageAvailable = available
      if (this.storageRecovery) { this.storageRecovery = { ...this.storageRecovery, available }; this.publish(); return }
      if (available) return
      const token = this.reservation
      if (token?.startPhase === 'countdown') {
        const remaining = this.remainingCountdownMs(token)
        this.enterStorageRecovery(token.target, 'countdown', remaining)
      } else if (token?.target && token.kind !== 'celebration' && token.kind !== 'stop-all') {
        this.enterStorageRecovery(token.target, 'transition')
        this.scheduleBackgroundEffect(async () => {
          try {
            const state = await this.composition!.playback.stop()
            if (state.status === 'stopped' && state.attemptId) await this.composition!.playback.clearStoppedMedia(state.attemptId)
          } finally { if (!this.disposed) await this.composition!.transitions.run(() => this.publish()) }
        })
      } else if (!token && this.stableState.operationalState === 'paused') {
        const current = this.stableState.current
        this.enterStorageRecovery(current, 'media')
        this.scheduleBackgroundEffect(async () => {
          try {
            const state = await this.composition!.playback.stop(current.attemptId)
            if (state.status === 'stopped') await this.composition!.playback.clearStoppedMedia(current.attemptId)
          } finally { if (!this.disposed) await this.composition!.transitions.run(() => this.publish()) }
        })
      }
    })
  }

  private storageContained(): boolean {
    const state = this.composition!.playback.getState()
    return state.status === 'idle' || state.status === 'stopped' && !state.attemptId || state.status === 'completed' ||
      ['failed', 'uncertain'].includes(state.status) && state.errorCode !== 'RECOVERY_PERSISTENCE_FAILED' &&
      ['stop-acknowledged', 'host-terminated'].includes(state.containmentStatus ?? '')
  }

  private enterStorageRecovery(target: StandaloneQueueEntry | undefined, phase: StandaloneStorageRecovery['phase'], countdownMs?: number, code: StandalonePlayerErrorCode = 'MEDIA_UNAVAILABLE'): void {
    if (this.storageRecovery) return
    const token = this.reservation
    this.storageRecovery = { target: target ? { entryId: target.entryId, musicCode: target.musicCode } : null,
      phase, wasPaused: this.stableState.operationalState === 'paused', available: this.storageAvailable,
      contained: false, positionRestorable: false, ...(countdownMs === undefined ? {} : { countdownMs }) }
    this.operationEpoch++
    if (token) this.clearReservation(token)
    this.unavailable = { playbackCondition: 'blocked', lastConfirmedState: this.stableState,
      pending: [...this.pending], error: { code } }
    this.publish()
  }

  private validateEntry(code: string, context: StandaloneCommandContext): Promise<string | void> {
    return context.playback.validatedMediaIdentity ? context.playback.validatedMediaIdentity(code) : context.playback.validateMusicCode(code)
  }

  private startEntry(entry: StandaloneQueueEntry, context: StandaloneCommandContext) {
    return context.playback.playImmediately(entry.musicCode, undefined, undefined, this.mediaIdentities.get(entry.entryId))
  }

  private prepareStorageAction(request: StandalonePlayerCommandRequest, context: StandaloneCommandContext): StandalonePreparedCommand | StandalonePlayerCommandResult {
    const recovery = this.storageRecovery
    if (!recovery || !this.storageContained() || this.reservation) return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
    const discard = request.command.type === 'discard-interrupted'
    if (!discard && !this.storageAvailable) return rejected(request.operationId, 'MEDIA_UNAVAILABLE', this.getSnapshot())
    const target = recovery.target ?? this.pending[0]
    const token = this.reserve('cleanup', undefined, request.operationId)
    this.publish()
    return {
      execute: async () => {
        try {
          let state = context.playback.getState()
          if (state.status === 'uncertain' && state.attemptId && state.musicCode) {
            if (context.recovery) await context.recovery.leaveStopped(state.attemptId)
            else await context.playback.resolveRecoveryAsStopped(state.attemptId, state.musicCode)
            state = context.playback.getState()
          }
          if (state.attemptId) {
            const cleared = state.status === 'failed' ? await context.playback.clearFailedMedia?.(state.attemptId)
              : state.status === 'completed' ? await context.playback.clearCompletedMedia(state.attemptId)
              : state.status === 'stopped' ? await context.playback.clearStoppedMedia(state.attemptId) : false
            if (!cleared) return executionUncertain(request.operationId, 'HOST_NOT_READY')
          }
          context.recovery?.assertPlaybackAllowed()
          if (!discard && target) {
            const identity = await this.validateEntry(target.musicCode, context)
            const previous = this.mediaIdentities.get(target.entryId)
            if (previous && identity !== previous) return executionRejected(request.operationId, 'MEDIA_CHANGED')
            if (identity && !previous) this.mediaIdentities.set(target.entryId, identity)
          }
          return { outcome: 'confirmed', operationId: request.operationId }
        } catch (error) { return executionRejected(request.operationId, errorCode(error)) }
      },
      commit: result => {
        if (this.disposed || this.shutdownAdmissionClosed) return rejected(request.operationId, 'DISPOSED', this.getSnapshot())
        if (this.reservation !== token || !this.storageRecovery) return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
        this.clearReservation(token)
        if (result.outcome !== 'confirmed') {
          if (result.outcome === 'uncertain') this.unavailable = { ...this.unavailable!, playbackCondition: 'uncertain', error: result.error }
          else if ('error' in result && this.unavailable) this.unavailable = { ...this.unavailable, error: result.error }
          this.publish()
          return rejected(request.operationId, 'error' in result ? result.error.code : 'PLAYBACK_FAILED', this.getSnapshot())
        }
        if (discard) {
          if (recovery.target) { this.removePending(recovery.target.entryId); this.mediaIdentities.delete(recovery.target.entryId) }
          this.stableState = { operationalState: 'idle', current: null, pending: [] }
          if (this.pending.length) {
            this.storageRecovery = { ...recovery, target: null, phase: 'transition', countdownMs: undefined }
            this.unavailable = { playbackCondition: 'blocked', lastConfirmedState: this.stableState, pending: [...this.pending], error: { code: 'MEDIA_UNAVAILABLE' } }
          } else { this.storageRecovery = undefined; this.unavailable = undefined }
          this.publish()
          return confirmed(request.operationId, this.getSnapshot())
        }
        if (!target) return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
        if (!this.pending.some(e => e.entryId === target.entryId)) this.pending.unshift(target)
        this.stableState = { operationalState: 'idle', current: null, pending: [] }
        this.storageRecovery = undefined
        this.unavailable = undefined
        const start = this.reserve('start', target, request.operationId)
        // Explicit restart uses the existing five-second countdown. A frozen countdown keeps its remaining time.
        this.beginInitialCountdown(start, context)
        if (recovery.countdownMs !== undefined) {
          this.cancelCountdownTimer(start)
          start.countdownRemainingMs = recovery.countdownMs
          start.countdownDeadlineMs = this.countdownScheduler.now() + recovery.countdownMs
          this.armCountdownTimer(start, context)
          this.publish()
        }
        return confirmed(request.operationId, this.getSnapshot())
      }
    }
  }

  private startupRecoveryPending = false

  static async create(options: StandalonePlayerSequenceOptions): Promise<StandalonePlayerSequence> {
    const owner = new StandalonePlayerSequence(options)
    owner.composition = await createStandalonePlayerComposition({
      createPlayback: options.createPlayback,
      recovery: options.recovery,
      deferStartupRecovery: options.deferStartupRecovery,
      catalog: options.catalog,
      onCoordinationError: options.onCoordinationError,
      normalizeCode: options.normalizeCode,
      disposeResources: options.disposeResources,
      getSnapshot: () => owner.getSnapshot(),
      getPlaybackCorrelation: () => owner.getPlaybackCorrelation(),
      prepareCommand: (request, context) => owner.prepareCommand(request, context),
      onPlaybackEvent: (event, current, context) => owner.onPlaybackEvent(event, current, context)
    })
    const recovery = owner.composition.getRecoveryState()
    if (options.deferStartupRecovery) {
      owner.startupRecoveryPending = true
      owner.setInitialRecoveryBlock('RECOVERY_PENDING')
    }
    else if (recovery.status === 'pending') owner.setInitialRecoveryBlock('RECOVERY_PENDING')
    else if (recovery.status === 'unreadable') owner.setInitialRecoveryBlock('RECOVERY_UNAVAILABLE')
    else if (recovery.status === 'unavailable') owner.setInitialRecoveryBlock('RECOVERY_PERSISTENCE_FAILED')
    return owner
  }

  /** Main calls this only after the fresh Chromium host is attached and ready. */
  async resolveStartupRecovery(): Promise<void> {
    if (!this.startupRecoveryPending) return
    if (this.disposed || this.shutdownAdmissionClosed) throw new Error('STANDALONE_STARTUP_CANCELLED')
    await this.composition!.recovery?.resolveStandaloneStartup?.()
    if (this.disposed || this.shutdownAdmissionClosed) throw new Error('STANDALONE_STARTUP_CANCELLED')
    const recovery = this.composition!.getRecoveryState()
    if (['pending', 'unreadable', 'unavailable'].includes(recovery.status)) {
      throw new Error('STANDALONE_STARTUP_RECOVERY_UNRESOLVED')
    }
    this.startupRecoveryPending = false
    this.unavailable = undefined
    this.publish()
  }

  getSnapshot(): StandalonePlayerSnapshot {
    const snapshot = this.getSequenceSnapshot()
    if (!this.storageRecovery) return snapshot
    const { countdownMs: _private, ...recovery } = this.storageRecovery
    return { ...snapshot, storageRecovery: { ...recovery, contained: this.storageContained() } }
  }

  private getSequenceSnapshot(): StandalonePlayerSnapshot {
    if (this.unavailable) return cloneSnapshot(this.unavailable)
    if (this.reservation) {
      return cloneSnapshot(this.createTransitioningSnapshot())
    }
    return cloneSnapshot({ playbackCondition: 'ready', state: this.stableState })
  }

  /** Fences countdown, EOF, and in-flight sequence effects before Main stops playback. */
  async beginShutdown(): Promise<void> {
    if (this.disposed) return
    this.shutdownAdmissionClosed = true
    const reservation = this.reservation
    if (reservation && (reservation.countdownTimer !== undefined ||
        reservation.startPhase === 'countdown' && !reservation.countdownPaused && reservation.countdownDeadlineMs !== undefined)) {
      reservation.shutdownCountdownRemainingMs = this.remainingCountdownMs(reservation)
      reservation.countdownDeadlineMs = undefined
      this.cancelCountdownTimer(reservation)
    }
    if (reservation && (reservation.celebrationTimer !== undefined ||
        reservation.kind === 'celebration' && !reservation.celebrationPaused && !reservation.celebrationExpired &&
        reservation.celebrationDeadlineMs !== undefined)) {
      reservation.shutdownCelebrationRemainingMs = this.remainingCelebrationMs(reservation)
      reservation.celebrationDeadlineMs = undefined
      this.cancelCelebrationTimer(reservation)
    }

    const composition = this.composition
    if (composition) await composition.transitions.run(() => undefined)
    await Promise.allSettled([...this.backgroundEffects])
  }

  /** Main-only rollback for a failed shutdown gate before playback Stop or resource disposal. */
  async resumeAfterFailedShutdown(): Promise<void> {
    if (this.disposed) throw new Error('STANDALONE_SEQUENCE_ALREADY_DISPOSED')
    if (!this.shutdownAdmissionClosed) return
    const composition = this.composition
    if (!composition) throw new Error('STANDALONE_SEQUENCE_UNAVAILABLE')
    const reservation = this.reservation
    const needsCountdown = reservation?.shutdownCountdownRemainingMs !== undefined
    const needsCelebration = reservation?.shutdownCelebrationRemainingMs !== undefined
    const context = this.lastCommandContext
    if ((needsCountdown || needsCelebration) && !context) {
      throw new Error('STANDALONE_SHUTDOWN_TIMER_CONTEXT_UNAVAILABLE')
    }

    await composition.transitions.run(() => {
      if (this.disposed) throw new Error('STANDALONE_SEQUENCE_ALREADY_DISPOSED')
      this.shutdownAdmissionClosed = false
      if (reservation && context) {
        if (reservation.shutdownCountdownRemainingMs !== undefined && reservation.startPhase === 'countdown') {
          const remainingMs = reservation.shutdownCountdownRemainingMs
          delete reservation.shutdownCountdownRemainingMs
          reservation.countdownRemainingMs = remainingMs
          reservation.countdownDeadlineMs = this.countdownScheduler.now() + remainingMs
          reservation.countdownPaused = false
          reservation.countdownGeneration = (reservation.countdownGeneration ?? 0) + 1
          this.armCountdownTimer(reservation, context)
        }
        if (reservation.shutdownCelebrationRemainingMs !== undefined && reservation.kind === 'celebration') {
          const remainingMs = reservation.shutdownCelebrationRemainingMs
          delete reservation.shutdownCelebrationRemainingMs
          reservation.celebrationRemainingMs = remainingMs
          reservation.celebrationDeadlineMs = this.countdownScheduler.now() + remainingMs
          reservation.celebrationPaused = false
          reservation.celebrationGeneration = (reservation.celebrationGeneration ?? 0) + 1
          this.armCelebrationTimer(reservation, context)
        }
      }
      this.publish()
    })
  }

  subscribe(listener: StandalonePlayerListener): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  execute(request: StandalonePlayerCommandRequest): Promise<StandalonePlayerCommandResult> {
    const composition = this.composition
    if (!composition || this.disposed) return Promise.resolve(rejected(request.operationId, 'DISPOSED', this.getSnapshot()))
    if (this.shutdownAdmissionClosed) return Promise.resolve(rejected(request.operationId, 'DISPOSED', this.getSnapshot()))
    return composition.control.execute(request)
  }

  /** Main-only sample start used by the isolated manual/E2E harness; it is not exposed through Preload or IPC. */
  executeHarnessSampleStart(): Promise<StandalonePlayerCommandResult> {
    if (this.shutdownAdmissionClosed || this.harnessSeedOperationId || this.reservation ||
        this.stableState.operationalState !== 'idle') {
      return Promise.resolve(rejected('harness-seed-unavailable', 'INVALID_STATE', this.getSnapshot()))
    }
    const operationId = `harness-seed-${randomUUID()}`
    this.harnessSeedOperationId = operationId
    return this.execute({
      operationId,
      command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
    }).finally(() => {
      if (this.harnessSeedOperationId === operationId) this.harnessSeedOperationId = undefined
    })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.shutdownAdmissionClosed = true
    this.disposed = true
    if (this.reservation) {
      this.cancelCountdownTimer(this.reservation)
      this.cancelCelebrationTimer(this.reservation)
    }
    this.listeners.clear()
    const compositionDisposal = this.composition?.dispose() ?? Promise.resolve()
    this.disposePromise = (async () => {
      await compositionDisposal
      await Promise.allSettled([...this.backgroundEffects])
    })()
    return this.disposePromise
  }

  private getPlaybackCorrelation(): StandalonePlaybackCorrelation {
    const current = this.stableState.current
    const reservation = this.reservation
    return {
      current: current ? { ...current } : null,
      reservation: reservation?.target ? { ...reservation.target,
        ...(reservation.targetAttemptId ? { attemptId: reservation.targetAttemptId } : {}) } : null
    }
  }

  private prepareCommand(request: StandalonePlayerCommandRequest, context: StandaloneCommandContext) {
    this.lastCommandContext = context
    if (this.disposed) return rejected(request.operationId, 'DISPOSED', this.getSnapshot())
    const snapshot = this.getSnapshot()
    if (request.command.type === 'recover-storage' || request.command.type === 'discard-interrupted') return this.prepareStorageAction(request, context)
    const recoverContainedFailure = request.command.type === 'stop-all' && (Boolean(this.storageRecovery && this.storageContained()) ||
      snapshot.playbackCondition === 'blocked' && this.hasContainedKnownFailure(snapshot, context))
    if ((snapshot.playbackCondition === 'blocked' || snapshot.playbackCondition === 'uncertain') &&
        !recoverContainedFailure) {
      return unavailableResult(request.operationId, snapshot)
    }
    // Stop All is explicitly allowed to cancel any known, non-recovery transition,
    // including countdown, loading, Next, Restart, and celebration.
    if (request.command.type === 'stop-all') {
      if (this.reservation?.kind === 'stop-all') return rejected(request.operationId, 'INVALID_STATE', snapshot)
      return this.prepareStopAll(request, context, recoverContainedFailure)
    }
    if (this.reservation) {
      if (this.reservation.kind === 'celebration') {
        if (request.command.type === 'toggle-pause') {
          return this.toggleCelebration(request, this.reservation, context)
        }
        if (request.command.type === 'submit-code' && !this.reservation.celebrationExpired) {
          return this.prepareAdmission(request, request.command.priority, context)
        }
        return rejected(request.operationId, 'INVALID_STATE', snapshot)
      }
      if (this.reservation.kind === 'start' && request.command.type === 'toggle-pause' &&
          this.reservation.startPhase === 'countdown') {
        return this.toggleInitialCountdown(request, this.reservation, context)
      }
      if (this.reservation.kind === 'stop-all') return rejected(request.operationId, 'INVALID_STATE', snapshot)
      if (request.command.type !== 'submit-code' || this.reservation.kind === 'start' ||
          this.reservation.kind === 'eof' || this.reservation.kind === 'cleanup') {
        return rejected(request.operationId, 'INVALID_STATE', snapshot)
      }
    }

    switch (request.command.type) {
      case 'submit-code': return this.prepareAdmission(request, request.command.priority, context)
      case 'toggle-pause': return this.prepareTogglePause(request, context)
      case 'next': return this.prepareNext(request, context)
      case 'restart': return this.prepareRestart(request, context)
    }
  }

  private prepareAdmission(request: StandalonePlayerCommandRequest, priority: 'normal' | 'priority',
    context: StandaloneCommandContext): StandalonePreparedCommand | StandalonePlayerCommandResult {
    const code = context.canonicalCode
    if (!code) return rejected(request.operationId, 'INVALID_MUSIC_CODE', this.getSnapshot())
    const preparedEpoch = this.operationEpoch
    if (this.reservation?.kind === 'start') {
      return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
    }
    // entryOrder contains confirmed pending entries and admission slots reserved by requests
    // whose media validation is still in flight. The current track is removed when its start
    // is confirmed, so this serial check excludes it and prevents concurrent over-admission.
    if (this.entryOrder.size >= STANDALONE_PENDING_QUEUE_LIMIT) {
      return rejected(request.operationId, 'QUEUE_LIMIT_REACHED', this.getSnapshot())
    }
    const ticket = this.nextAdmissionTicket++
    const entry: StandaloneQueueEntry = { entryId: this.createEntryId(), musicCode: code }
    this.entryOrder.set(entry.entryId, { ticket, priority })
    const startNow = !this.reservation && this.stableState.operationalState === 'idle'
    const celebration = this.reservation?.kind === 'celebration' ? this.reservation : undefined
    if (celebration) celebration.celebrationPendingAdmissions = (celebration.celebrationPendingAdmissions ?? 0) + 1
    let startup: TransitionReservation | undefined
    if (startNow) {
      this.pending.push(entry)
      startup = this.reserve('start', entry, request.operationId)
      this.publish()
    }

    return {
      execute: async signal => {
        if (signal.aborted) return executionRejected(request.operationId, 'DISPOSED')
        try { const identity = await this.validateEntry(code, context); if (identity) this.mediaIdentities.set(entry.entryId, identity) }
        catch (error) { return executionRejected(request.operationId, errorCode(error)) }
        if (!startup) return { outcome: 'confirmed', operationId: request.operationId }
        return { outcome: 'confirmed', operationId: request.operationId }
      },
      commit: (result, commitContext) => {
        if (preparedEpoch !== this.operationEpoch) {
          return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
        }
        if (startup) {
          if (result.outcome === 'rejected') return this.cancelUnstartedAdmission(startup, entry, result.error.code, context)
          if (result.outcome !== 'confirmed') return this.failReservation(startup, result.outcome, result.error.code)
          return this.beginInitialCountdown(startup, commitContext)
        }
        return this.commitAdmission(request, entry, ticket, priority, result, context, celebration)
      }
    }
  }

  private commitAdmission(request: StandalonePlayerCommandRequest, entry: StandaloneQueueEntry, ticket: number,
    priority: 'normal' | 'priority', result: StandaloneCommandExecutionResult,
    context: StandaloneCommandContext, celebration?: TransitionReservation): StandalonePlayerCommandResult {
    if (this.unavailable) {
      this.entryOrder.delete(entry.entryId)
      this.settleCelebrationAdmission(celebration, context)
      return unavailableResult(request.operationId, this.unavailable)
    }
    if (result.outcome === 'rejected') {
      this.entryOrder.delete(entry.entryId)
      this.settleCelebrationAdmission(celebration, context)
      return rejected(request.operationId, result.error.code, this.getSnapshot())
    }
    if (result.outcome === 'blocked') {
      this.entryOrder.delete(entry.entryId)
      const blocked = this.block(request.operationId, result.error.code)
      this.settleCelebrationAdmission(celebration, context)
      return blocked
    }
    if (result.outcome === 'uncertain') {
      this.entryOrder.delete(entry.entryId)
      const uncertain = this.markUncertain(request.operationId, result.error.code)
      this.settleCelebrationAdmission(celebration, context)
      return uncertain
    }

    this.entryOrder.set(entry.entryId, { ticket, priority })
    this.insertPending(entry, priority, ticket)
    if (!this.reservation && this.stableState.operationalState === 'idle') {
      const startup = this.reserve('start', this.pending[0], request.operationId)
      this.beginInitialCountdown(startup, context)
      this.settleCelebrationAdmission(celebration, context)
      return confirmed(request.operationId, this.getSnapshot())
    }
    this.syncStablePending()
    this.publish()
    this.settleCelebrationAdmission(celebration, context)
    return confirmed(request.operationId, this.getSnapshot())
  }

  private prepareTogglePause(request: StandalonePlayerCommandRequest, context: StandaloneCommandContext) {
    if (!this.storageAvailable && this.stableState.operationalState === 'paused') {
      this.scheduleBackgroundEffect(() => this.notifyLibraryAvailability(false))
      return rejected(request.operationId, 'MEDIA_UNAVAILABLE', this.getSnapshot())
    }
    const current = this.stableState.current
    if (!current) return confirmed(request.operationId, this.getSnapshot())
    const action = this.stableState.operationalState === 'playing' ? 'pause' : 'resume'
    const token = this.reserve('pause', undefined, request.operationId, current)
    token.pauseAction = action
    this.publish()
    return this.preparedTransition(request, token, async signal => {
      if (signal.aborted) return executionRejected(request.operationId, 'DISPOSED')
      try {
        const expectedStatus = action === 'pause' ? 'paused' : 'playing'
        const started = await context.transitions.run(() => {
          if (signal.aborted || this.reservation !== token || this.unavailable) return undefined
          return { promise: action === 'pause' ? context.playback.pause() : context.playback.resume() }
        })
        if (!started) return executionRejected(request.operationId, 'SUPERSEDED')
        const state = await this.executeAndConfirmPlaybackControl(
          started.promise,
          expectedStatus,
          current,
          context,
          signal
        )
        return { outcome: 'confirmed', operationId: request.operationId, attemptId: state.attemptId }
      } catch (error) {
        return isUncertainError(error) ? executionUncertain(request.operationId, errorCode(error))
          : executionRejected(request.operationId, errorCode(error))
      }
    }, result => this.commitPause(token, current, result))
  }

  private beginInitialCountdown(token: TransitionReservation,
    context: StandaloneCommandContext): StandalonePlayerCommandResult {
    if (this.reservation !== token || !token.target || this.pending[0]?.entryId !== token.target.entryId) {
      return this.failReservation(token, 'uncertain', 'INVALID_STATE')
    }
    token.startPhase = 'countdown'
    token.countdownRemainingMs = STANDALONE_INITIAL_COUNTDOWN_MS
    token.countdownDeadlineMs = this.countdownScheduler.now() + STANDALONE_INITIAL_COUNTDOWN_MS
    token.countdownPaused = false
    token.countdownDisplayedSecond = 5
    token.countdownGeneration = (token.countdownGeneration ?? 0) + 1
    this.publish()
    this.armCountdownTimer(token, context)
    return confirmed(token.operationId ?? 'standalone-countdown', this.getSnapshot())
  }

  private toggleInitialCountdown(request: StandalonePlayerCommandRequest, token: TransitionReservation,
    context: StandaloneCommandContext): StandalonePlayerCommandResult {
    if (this.reservation !== token || token.startPhase !== 'countdown') {
      return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
    }
    if (token.countdownPaused) {
      const remainingMs = token.countdownRemainingMs ?? 0
      if (remainingMs <= 0) {
        this.enterInitialLoading(token, context)
        return confirmed(request.operationId, this.getSnapshot())
      }
      token.countdownPaused = false
      token.countdownDeadlineMs = this.countdownScheduler.now() + remainingMs
      token.countdownGeneration = (token.countdownGeneration ?? 0) + 1
      this.armCountdownTimer(token, context)
      this.publish()
      return confirmed(request.operationId, this.getSnapshot())
    }

    const remainingMs = this.remainingCountdownMs(token)
    if (remainingMs <= 0) {
      this.enterInitialLoading(token, context)
      return confirmed(request.operationId, this.getSnapshot())
    }
    this.cancelCountdownTimer(token)
    token.countdownPaused = true
    token.countdownRemainingMs = remainingMs
    token.countdownDeadlineMs = undefined
    this.publish()
    return confirmed(request.operationId, this.getSnapshot())
  }

  private toggleCelebration(request: StandalonePlayerCommandRequest, token: TransitionReservation,
    context: StandaloneCommandContext): StandalonePlayerCommandResult {
    if (this.reservation !== token || token.kind !== 'celebration' || token.celebrationExpired) {
      return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
    }
    if (token.celebrationPaused) {
      const remainingMs = token.celebrationRemainingMs ?? 0
      if (remainingMs <= 0) {
        this.expireCelebration(token, context)
        return confirmed(request.operationId, this.getSnapshot())
      }
      token.celebrationPaused = false
      token.celebrationDeadlineMs = this.countdownScheduler.now() + remainingMs
      token.celebrationGeneration = (token.celebrationGeneration ?? 0) + 1
      this.armCelebrationTimer(token, context)
      this.publish()
      return confirmed(request.operationId, this.getSnapshot())
    }

    const remainingMs = this.remainingCelebrationMs(token)
    if (remainingMs <= 0) {
      this.expireCelebration(token, context)
      return confirmed(request.operationId, this.getSnapshot())
    }
    this.cancelCelebrationTimer(token)
    token.celebrationPaused = true
    token.celebrationRemainingMs = remainingMs
    token.celebrationDeadlineMs = undefined
    token.celebrationGeneration = (token.celebrationGeneration ?? 0) + 1
    this.publish()
    return confirmed(request.operationId, this.getSnapshot())
  }

  private remainingCelebrationMs(token: TransitionReservation): number {
    if (token.shutdownCelebrationRemainingMs !== undefined) return Math.max(0, token.shutdownCelebrationRemainingMs)
    if (token.celebrationExpired) return 0
    if (token.celebrationPaused) return Math.max(0, token.celebrationRemainingMs ?? 0)
    if (token.celebrationDeadlineMs === undefined) return 0
    return Math.max(0, token.celebrationDeadlineMs - this.countdownScheduler.now())
  }

  private armCelebrationTimer(token: TransitionReservation, context: StandaloneCommandContext): void {
    if (this.disposed || this.reservation !== token || token.kind !== 'celebration' ||
        token.celebrationPaused || token.celebrationExpired) return
    if (token.celebrationTimer !== undefined) this.countdownScheduler.cancel(token.celebrationTimer)
    const remainingMs = this.remainingCelebrationMs(token)
    const seconds = Math.ceil(remainingMs / 1000)
    const delayMs = remainingMs <= 0 ? 0 : Math.max(1, remainingMs - Math.max(0, seconds - 1) * 1000)
    const generation = token.celebrationGeneration ?? 0
    token.celebrationTimer = this.countdownScheduler.schedule(() => {
      token.celebrationTimer = undefined
      void context.transitions.run(() => this.onCelebrationTimer(token, generation, context)).catch(error => {
        if (this.disposed) return
        try { this.options.onCoordinationError(error) } catch { /* Timer reporting cannot create an orphan rejection. */ }
      })
    }, delayMs)
  }

  private onCelebrationTimer(token: TransitionReservation, generation: number,
    context: StandaloneCommandContext): void {
    if (this.shutdownAdmissionClosed || this.disposed || this.unavailable || this.reservation !== token || token.kind !== 'celebration' ||
        token.celebrationPaused || token.celebrationExpired || generation !== token.celebrationGeneration) return
    token.celebrationTimer = undefined
    const remainingMs = this.remainingCelebrationMs(token)
    if (remainingMs <= 0) {
      this.expireCelebration(token, context)
      return
    }
    const seconds = Math.ceil(remainingMs / 1000)
    if (seconds !== token.celebrationDisplayedSecond) {
      token.celebrationDisplayedSecond = seconds
      this.publish()
    }
    this.armCelebrationTimer(token, context)
  }

  private expireCelebration(token: TransitionReservation, context: StandaloneCommandContext): void {
    if (this.disposed || this.unavailable || this.reservation !== token || token.kind !== 'celebration' ||
        token.celebrationExpired) return
    this.cancelCelebrationTimer(token)
    token.celebrationExpired = true
    token.celebrationRemainingMs = 0
    token.celebrationDeadlineMs = undefined
    token.celebrationPaused = false
    if ((token.celebrationPendingAdmissions ?? 0) > 0) {
      this.publish()
      return
    }
    this.completeCelebration(token, context)
  }

  private settleCelebrationAdmission(token: TransitionReservation | undefined,
    context: StandaloneCommandContext): void {
    if (!token || token.kind !== 'celebration') return
    token.celebrationPendingAdmissions = Math.max(0, (token.celebrationPendingAdmissions ?? 0) - 1)
    if (token.celebrationExpired && token.celebrationPendingAdmissions === 0 && this.reservation === token && !this.unavailable) {
      this.completeCelebration(token, context)
    }
  }

  private completeCelebration(token: TransitionReservation, context: StandaloneCommandContext): void {
    if (this.disposed || this.unavailable || this.reservation !== token || token.kind !== 'celebration' ||
        !token.celebrationExpired || (token.celebrationPendingAdmissions ?? 0) > 0) return
    this.cancelCelebrationTimer(token)
    const ended = token.previous
    if (!ended) { this.failReservation(token, 'uncertain', 'INVALID_STATE'); return }
    if (this.pending.length > 0) {
      token.kind = 'eof'
      token.target = this.pending[0]
      token.startPhase = 'loading'
      this.publish()
      this.scheduleBackgroundEffect(() => this.runReservedStart(token, context))
      return
    }
    this.scheduleBackgroundEffect(async () => {
      try {
        const cleared = await context.playback.clearCompletedMedia(ended.attemptId)
        await context.transitions.run(() => {
          if (this.reservation !== token || this.unavailable) return
          if (!cleared) { this.failReservation(token, 'blocked', 'HOST_NOT_READY'); return }
          this.finishWithoutCurrent(token, context)
        })
      } catch (error) {
        const result = executionFailure(token.operationId ?? 'playback-event', error)
        await context.transitions.run(() => this.failExecution(token, result))
      }
    })
  }

  private cancelCelebrationTimer(token: TransitionReservation): void {
    if (token.celebrationTimer !== undefined) this.countdownScheduler.cancel(token.celebrationTimer)
    token.celebrationTimer = undefined
    token.celebrationGeneration = (token.celebrationGeneration ?? 0) + 1
  }

  private remainingCountdownMs(token: TransitionReservation): number {
    if (token.shutdownCountdownRemainingMs !== undefined) return Math.max(0, token.shutdownCountdownRemainingMs)
    if (token.countdownPaused) return Math.max(0, token.countdownRemainingMs ?? 0)
    if (token.countdownDeadlineMs === undefined) return 0
    return Math.max(0, token.countdownDeadlineMs - this.countdownScheduler.now())
  }

  private armCountdownTimer(token: TransitionReservation, context: StandaloneCommandContext): void {
    if (this.disposed || this.reservation !== token || token.startPhase !== 'countdown' || token.countdownPaused) return
    if (token.countdownTimer !== undefined) this.countdownScheduler.cancel(token.countdownTimer)
    const remainingMs = this.remainingCountdownMs(token)
    const seconds = Math.ceil(remainingMs / 1000)
    const delayMs = remainingMs <= 0 ? 0 : Math.max(1, remainingMs - Math.max(0, seconds - 1) * 1000)
    const generation = token.countdownGeneration ?? 0
    token.countdownTimer = this.countdownScheduler.schedule(() => {
      token.countdownTimer = undefined
      void context.transitions.run(() => this.onCountdownTimer(token, generation, context)).catch(error => {
        if (this.disposed) return
        try { this.options.onCoordinationError(error) } catch { /* Timer reporting cannot create an orphan rejection. */ }
      })
    }, delayMs)
  }

  private onCountdownTimer(token: TransitionReservation, generation: number,
    context: StandaloneCommandContext): void {
    if (this.shutdownAdmissionClosed || this.disposed || this.unavailable || this.reservation !== token || token.startPhase !== 'countdown' ||
        token.countdownPaused || generation !== token.countdownGeneration) return
    token.countdownTimer = undefined
    const remainingMs = this.remainingCountdownMs(token)
    if (remainingMs <= 0) {
      this.enterInitialLoading(token, context)
      return
    }
    const seconds = Math.ceil(remainingMs / 1000)
    if (seconds !== token.countdownDisplayedSecond) {
      token.countdownDisplayedSecond = seconds
      this.publish()
    }
    this.armCountdownTimer(token, context)
  }

  private enterInitialLoading(token: TransitionReservation, context: StandaloneCommandContext): void {
    if (this.disposed || this.unavailable || this.reservation !== token || token.startPhase !== 'countdown') return
    this.cancelCountdownTimer(token)
    token.startPhase = 'loading'
    token.countdownRemainingMs = undefined
    token.countdownDeadlineMs = undefined
    token.countdownPaused = false
    token.countdownDisplayedSecond = undefined
    this.publish()
    this.scheduleBackgroundEffect(() => this.runReservedStart(token, context))
  }

  private cancelCountdownTimer(token: TransitionReservation): void {
    if (token.countdownTimer !== undefined) this.countdownScheduler.cancel(token.countdownTimer)
    token.countdownTimer = undefined
    token.countdownGeneration = (token.countdownGeneration ?? 0) + 1
  }

  /** A host ACK means the command was accepted; Chromium's media event confirms its effect. */
  private async executeAndConfirmPlaybackControl(
    command: Promise<PlayerPlaybackState>,
    expectedStatus: 'playing' | 'paused',
    current: StandaloneCurrentEntry,
    context: StandaloneCommandContext,
    signal: AbortSignal
  ): Promise<PlayerPlaybackState> {
    const commandState = await command
    const matches = (state: PlayerPlaybackState): boolean =>
      state.status === expectedStatus && state.attemptId === current.attemptId && state.musicCode === current.musicCode
    if (matches(commandState)) return commandState
    const terminalError = (state: PlayerPlaybackState): PlayerPlaybackError | undefined => {
      if (state.attemptId !== current.attemptId || state.musicCode !== current.musicCode) {
        return new PlayerPlaybackError('SUPERSEDED', 'A reprodução mudou antes da confirmação do comando.')
      }
      if (state.status === 'failed') return new PlayerPlaybackError(state.errorCode ?? 'PLAYBACK_FAILED', 'A reprodução falhou.')
      if (state.status === 'uncertain') return new PlayerPlaybackError(state.errorCode ?? 'COMMAND_TIMEOUT', 'O resultado do comando é incerto.')
      if (state.status === 'completed' || state.status === 'stopped' || state.status === 'disposed' || state.status === 'idle') {
        return new PlayerPlaybackError('SUPERSEDED', 'A reprodução terminou antes da confirmação do comando.')
      }
      return undefined
    }
    const terminal = terminalError(commandState)
    if (terminal) throw terminal

    return new Promise<PlayerPlaybackState>((resolve, reject) => {
      let settled = false
      let unsubscribe: () => void = () => undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        unsubscribe()
        signal.removeEventListener('abort', abort)
        if (timer) clearTimeout(timer)
      }
      const finish = (error?: Error, state?: PlayerPlaybackState): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve(state!)
      }
      const inspect = (state: PlayerPlaybackState): void => {
        if (matches(state)) { finish(undefined, state); return }
        const error = terminalError(state)
        if (error) finish(error)
      }
      const abort = (): void => finish(new PlayerPlaybackError('DISPOSED', 'A reprodução foi encerrada antes da confirmação do comando.'))
      if (signal.aborted) { abort(); return }
      unsubscribe = context.playback.subscribe(event => {
        if (event.type === 'state-changed') inspect(event.state)
        else if ('attemptId' in event && event.attemptId === current.attemptId && event.type === 'error') {
          finish(new PlayerPlaybackError(event.errorCode, 'O host de reprodução reportou uma falha.'))
        } else if ('attemptId' in event && event.attemptId === current.attemptId && event.type === 'uncertain') {
          finish(new PlayerPlaybackError('COMMAND_TIMEOUT', 'O resultado do comando é incerto.'))
        }
      })
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(new PlayerPlaybackError('COMMAND_TIMEOUT', 'O estado esperado do playback não foi observado.')),
        PLAYBACK_CONTROL_CONFIRMATION_TIMEOUT_MS)
      // Subscribe first, then read the authoritative state to close the event-before-subscribe race.
      inspect(context.playback.getState())
    })
  }

  private prepareNext(request: StandalonePlayerCommandRequest, context: StandaloneCommandContext) {
    const current = this.stableState.current
    const submittedSnapshot = context.submittedSnapshot
    if (!submittedSnapshot || submittedSnapshot.playbackCondition !== 'ready') {
      return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
    }
    const capturedAttemptId = submittedSnapshot.state.current?.attemptId
    if (submittedSnapshot.state.operationalState !== 'playing' || capturedAttemptId === undefined) {
      return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
    }
    if (!current || capturedAttemptId !== current.attemptId) {
      return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
    }
    const engine = context.playback.getState()
    if (engine.status === 'completed' && engine.attemptId === current.attemptId) {
      return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
    }
    if (engine.status !== 'playing' || engine.attemptId !== current.attemptId || engine.musicCode !== current.musicCode) {
      if (engine.status === 'paused') return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
      return this.markUncertain(request.operationId, engine.errorCode ?? 'PLAYBACK_FAILED')
    }
    const token = this.reserve('next', this.pending[0], request.operationId, current)
    this.publish()
    return this.preparedTransition(request, token, async signal => {
      if (signal.aborted) return executionRejected(request.operationId, 'DISPOSED')
      let stopped: PlayerPlaybackState
      try {
        const started = await context.transitions.run(() => {
          if (signal.aborted || this.reservation !== token || this.unavailable) return undefined
          return { promise: context.playback.stop(current.attemptId) }
        })
        if (!started) return executionRejected(request.operationId, 'SUPERSEDED')
        stopped = await started.promise
      }
      catch (error) {
        if (isCurrentCompleted(context.playback.getState(), current)) {
          return this.runNaturalEndAfterNext(token, current, request.operationId, context)
        }
        return isUncertainError(error) ? executionUncertain(request.operationId, errorCode(error))
          : executionRejected(request.operationId, errorCode(error))
      }
      if (stopped.status !== 'stopped' || stopped.attemptId !== current.attemptId) {
        if (isCurrentCompleted(context.playback.getState(), current)) {
          return this.runNaturalEndAfterNext(token, current, request.operationId, context)
        }
        return executionUncertain(request.operationId, stopped.errorCode ?? 'PLAYBACK_FAILED', stopped.attemptId)
      }

      type Selection = { readonly failure: StandaloneCommandExecutionResult } | { readonly target: StandaloneQueueEntry | undefined }
      const selected = await context.transitions.run<Selection>(() => {
        if (this.unavailable) return { failure: executionForUnavailable(request.operationId, this.unavailable) }
        if (this.reservation !== token) return { failure: executionRejected(request.operationId, 'INVALID_STATE') }
        token.stopConfirmed = true
        if (!token.target && this.pending.length) token.target = this.pending[0]
        this.publish()
        return { target: token.target }
      })
      if ('failure' in selected) return selected.failure
      if (selected.target) {
        try {
          const started = await context.transitions.run(() => {
            if (signal.aborted || this.reservation !== token || this.unavailable) return undefined
            return { promise: this.startEntry(selected.target!, context) }
          })
          if (!started) return executionRejected(request.operationId, 'SUPERSEDED')
          const state = await started.promise
          return isConfirmedPlaying(state, selected.target.musicCode)
            ? { outcome: 'confirmed', operationId: request.operationId, attemptId: state.attemptId }
            : executionUncertain(request.operationId, state.errorCode ?? 'PLAYBACK_FAILED', state.attemptId)
        } catch (error) { return executionFailure(request.operationId, error) }
      }
      try {
        const cleared = await context.playback.clearStoppedMedia(current.attemptId)
        return cleared ? { outcome: 'confirmed', operationId: request.operationId }
          : { outcome: 'blocked', operationId: request.operationId, error: { code: 'HOST_NOT_READY' } }
      } catch (error) { return executionFailure(request.operationId, error) }
    }, result => this.commitNext(token, result, context))
  }

  private prepareRestart(request: StandalonePlayerCommandRequest, context: StandaloneCommandContext) {
    const current = this.stableState.current
    if (!current || (this.stableState.operationalState !== 'playing' && this.stableState.operationalState !== 'paused')) {
      return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
    }
    const engine = context.playback.getState()
    if (engine.status !== this.stableState.operationalState || engine.attemptId !== current.attemptId || engine.musicCode !== current.musicCode) {
      if (engine.status === 'completed' && engine.attemptId === current.attemptId) {
        return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
      }
      if (engine.status === 'playing' || engine.status === 'paused') return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
      return this.markUncertain(request.operationId, engine.errorCode ?? 'PLAYBACK_FAILED')
    }
    const token = this.reserve('restart', { entryId: current.entryId, musicCode: current.musicCode }, request.operationId, current)
    token.startPhase = 'loading'
    this.publish()
    return this.preparedTransition(request, token, async signal => {
      if (signal.aborted) return executionRejected(request.operationId, 'DISPOSED')
      try {
        const started = await context.transitions.run(() => {
          if (signal.aborted || this.reservation !== token || this.unavailable) return undefined
          return { promise: context.playback.restart() }
        })
        if (!started) return executionRejected(request.operationId, 'SUPERSEDED')
        const state = await started.promise
        if (!isConfirmedPlaying(state, current.musicCode) || state.attemptId === current.attemptId) {
          return executionUncertain(request.operationId, state.errorCode ?? 'PLAYBACK_FAILED', state.attemptId)
        }
        return { outcome: 'confirmed', operationId: request.operationId, attemptId: state.attemptId }
      } catch (error) { return executionFailure(request.operationId, error) }
    }, result => this.commitRestart(token, current, result))
  }

  private prepareStopAll(request: StandalonePlayerCommandRequest, context: StandaloneCommandContext,
    recoverBlockedFailure = false) {
    this.operationEpoch++
    const previous = this.reservation
    if (previous) {
      this.cancelCountdownTimer(previous)
      this.cancelCelebrationTimer(previous)
    }
    const token = this.reserve('stop-all', undefined, request.operationId, this.stableState.current ?? undefined)
    token.recoverBlockedFailure = recoverBlockedFailure
    this.publish()
    return this.preparedTransition(request, token, async signal => {
      if (signal.aborted) return executionRejected(request.operationId, 'DISPOSED')
      try {
        if (this.storageRecovery && this.storageContained()) {
          const state = context.playback.getState()
          if (state.status === 'uncertain' && state.attemptId && state.musicCode) {
            if (context.recovery) await context.recovery.leaveStopped(state.attemptId)
            else await context.playback.resolveRecoveryAsStopped(state.attemptId, state.musicCode)
          }
        }
        if (this.storageRecovery) context.recovery?.assertPlaybackAllowed()
        // The unqualified Stop also advances PlayerPlaybackService's command generation,
        // invalidating any older pending load/start/restart before this operation commits.
        const started = await context.transitions.run(() => {
          if (signal.aborted || this.disposed || (this.unavailable && !token.recoverBlockedFailure) ||
              this.reservation !== token) return undefined
          return { promise: context.playback.stop() }
        })
        if (!started) return executionRejected(request.operationId, 'SUPERSEDED')
        const stopped = await started.promise
        if (stopped.status === 'stopped' && stopped.attemptId) {
          const cleared = await context.playback.clearStoppedMedia(stopped.attemptId)
          if (!cleared && context.playback.getState().status !== 'idle') {
            return { outcome: 'blocked', operationId: request.operationId, error: { code: 'HOST_NOT_READY' } }
          }
        } else if (stopped.status === 'completed' && stopped.attemptId) {
          const cleared = await context.playback.clearCompletedMedia(stopped.attemptId)
          if (!cleared && context.playback.getState().status !== 'idle') {
            return { outcome: 'blocked', operationId: request.operationId, error: { code: 'HOST_NOT_READY' } }
          }
        } else if (stopped.status === 'failed' && stopped.attemptId && token.recoverBlockedFailure) {
          const cleared = await context.playback.clearFailedMedia?.(stopped.attemptId)
          if (!cleared && context.playback.getState().status !== 'idle') {
            return { outcome: 'blocked', operationId: request.operationId, error: { code: 'HOST_NOT_READY' } }
          }
        } else if ((stopped.status !== 'idle' && stopped.status !== 'stopped') || stopped.attemptId) {
          return executionUncertain(request.operationId, stopped.errorCode ?? 'PLAYBACK_FAILED', stopped.attemptId)
        }

        const finalState = context.playback.getState()
        if (finalState.status !== 'idle' && !(finalState.status === 'stopped' && !finalState.attemptId)) {
          return executionUncertain(request.operationId, finalState.errorCode ?? 'PLAYBACK_FAILED', finalState.attemptId)
        }
        return { outcome: 'confirmed', operationId: request.operationId }
      } catch (error) {
        return executionUncertain(request.operationId, errorCode(error), context.playback.getState().attemptId)
      }
    }, result => this.commitStopAll(token, result, context))
  }

  private preparedTransition(request: StandalonePlayerCommandRequest, token: TransitionReservation,
    execute: (signal: AbortSignal) => Promise<StandaloneCommandExecutionResult>,
    commit: (result: StandaloneCommandExecutionResult) => StandalonePlayerCommandResult): StandalonePreparedCommand {
    return {
      execute,
      commit: result => {
        if (this.unavailable && !(token.kind === 'stop-all' && token.recoverBlockedFailure)) {
          return unavailableResult(request.operationId, this.unavailable)
        }
        if (token.completed) return confirmed(request.operationId, this.getSnapshot())
        if (token.kind === 'pause' && token.naturalEndWon) return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
        if (this.reservation !== token) return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
        return commit(result)
      }
    }
  }

  private commitPause(token: TransitionReservation, current: StandaloneCurrentEntry,
    result: StandaloneCommandExecutionResult): StandalonePlayerCommandResult {
    if (result.outcome === 'rejected') return this.rejectReservation(token, result.error.code)
    if (result.outcome !== 'confirmed') return this.failReservation(token, result.outcome, result.error.code)
    if (!result.attemptId || result.attemptId !== current.attemptId) return this.failReservation(token, 'uncertain', 'PLAYBACK_FAILED')
    const state = token.pauseAction === 'pause' ? 'paused' : 'playing'
    this.clearReservation(token)
    this.stableState = { operationalState: state, current, pending: [...this.pending] }
    if (state === 'paused' && !this.storageAvailable) this.scheduleBackgroundEffect(() => this.notifyLibraryAvailability(false))
    this.publish()
    return confirmed(token.operationId!, this.getSnapshot(), current.attemptId)
  }

  private commitNext(token: TransitionReservation, result: StandaloneCommandExecutionResult,
    context: StandaloneCommandContext): StandalonePlayerCommandResult {
    if (this.unavailable) return unavailableResult(token.operationId!, this.unavailable)
    if (token.completed) return confirmed(token.operationId!, this.getSnapshot())
    if (this.reservation !== token) return rejected(token.operationId!, 'INVALID_STATE', this.getSnapshot())
    if (result.outcome === 'rejected') return this.rejectReservation(token, result.error.code)
    if (result.outcome !== 'confirmed') return this.failReservation(token, result.outcome, result.error.code)
    if (token.target) {
      if (!result.attemptId || !isCurrentState(context.playback.getState(), result.attemptId, token.target.musicCode, 'playing')) {
        return this.failReservation(token, 'uncertain', 'PLAYBACK_FAILED')
      }
      return this.confirmStart(token, result.attemptId)
    }
    if (!token.stopConfirmed && !token.naturalEndWon) return this.failReservation(token, 'blocked', 'HOST_NOT_READY')
    return this.finishWithoutCurrent(token, context)
  }

  private commitRestart(token: TransitionReservation, current: StandaloneCurrentEntry,
    result: StandaloneCommandExecutionResult): StandalonePlayerCommandResult {
    if (result.outcome === 'rejected') return this.rejectReservation(token, result.error.code)
    if (result.outcome !== 'confirmed') return this.failReservation(token, result.outcome, result.error.code)
    if (!result.attemptId || result.attemptId === current.attemptId) return this.failReservation(token, 'uncertain', 'PLAYBACK_FAILED')
    this.clearReservation(token)
    this.stableState = { operationalState: 'playing', current: { ...current, attemptId: result.attemptId }, pending: [...this.pending] }
    this.publish()
    return confirmed(token.operationId!, this.getSnapshot(), result.attemptId)
  }

  private commitStopAll(token: TransitionReservation, result: StandaloneCommandExecutionResult,
    context: StandaloneCommandContext): StandalonePlayerCommandResult {
    if (this.unavailable && !token.recoverBlockedFailure) return unavailableResult(token.operationId!, this.unavailable)
    if (this.reservation !== token) return rejected(token.operationId!, 'SUPERSEDED', this.getSnapshot())
    if (result.outcome === 'rejected') return this.rejectReservation(token, result.error.code)
    if (result.outcome !== 'confirmed') return this.failReservation(token, result.outcome, result.error.code)
    const playback = context.playback.getState()
    if (playback.status !== 'idle' && !(playback.status === 'stopped' && !playback.attemptId)) {
      return this.failReservation(token, 'uncertain', playback.errorCode ?? 'PLAYBACK_FAILED')
    }
    this.storageRecovery = undefined
    this.mediaIdentities.clear()
    this.pending = []
    this.entryOrder.clear()
    this.stableState = { operationalState: 'idle', current: null, pending: [] }
    this.unavailable = undefined
    this.clearReservation(token)
    this.publish()
    return confirmed(token.operationId!, this.getSnapshot())
  }

  /** Called synchronously while A2.2's shared transition arbiter is held. */
  private onPlaybackEvent(event: StandalonePlaybackEvent, current: StandaloneCurrentEntry,
    context: StandaloneCommandContext): undefined {
    this.lastCommandContext = context
    if (this.shutdownAdmissionClosed || this.disposed || this.unavailable) return undefined
    if (event.type === 'state-changed') {
      const token = this.reservation
      if (token?.target && token.target.entryId === current.entryId && token.target.musicCode === current.musicCode &&
          token.previous?.attemptId !== current.attemptId) token.targetAttemptId = current.attemptId
      return undefined
    }
    if (event.type === 'interrupted') return undefined
    if (event.type === 'natural-end-candidate') {
      this.handleNaturalEndEvent(event, current, context)
      return undefined
    }
    if (!this.isRelevantEventAttempt(current)) return undefined
    const playbackState = event.type === 'uncertain' ? context.playback.getState() : undefined
    const code = event.type === 'uncertain'
      ? playbackState?.attemptId === current.attemptId ? playbackState.errorCode ?? 'COMMAND_TIMEOUT' : 'COMMAND_TIMEOUT'
      : event.errorCode
    if (event.type === 'error' && ['MEDIA_LOAD_FAILED', 'MEDIA_UNAVAILABLE', 'MEDIA_UNKNOWN', 'MEDIA_STALLED', 'MEDIA_CHANGED'].includes(code) ||
        event.type === 'uncertain' && !this.storageAvailable && code !== 'RECOVERY_PERSISTENCE_FAILED') {
      this.enterStorageRecovery(this.reservation?.target ?? this.stableState.current ?? undefined,
        this.reservation ? 'transition' : 'media', undefined, code)
      this.scheduleBackgroundEffect(async () => {
        if (context.playback.getState().status === 'failed') await context.playback.clearFailedMedia?.(current.attemptId)
        if (!this.disposed) await context.transitions.run(() => this.publish())
      })
      return undefined
    }
    if (this.reservation) this.failReservation(this.reservation, event.type === 'uncertain' ? 'uncertain' : 'blocked', code)
    else if (event.type === 'uncertain') this.markUncertain('playback-event', code)
    else this.block('playback-event', code)
    return undefined
  }

  private handleNaturalEndEvent(event: Extract<StandalonePlaybackEvent, { type: 'natural-end-candidate' }>,
    current: StandaloneCurrentEntry, context: StandaloneCommandContext): void {
    const engine = context.playback.getState()
    if (engine.status !== 'completed' || engine.attemptId !== event.attemptId || engine.musicCode !== event.musicCode) return
    const token = this.reservation
    if (token) {
      if (token.kind === 'next' && token.previous?.attemptId === current.attemptId) {
        token.naturalEndObserved = true
        token.endedAttemptId = current.attemptId
        return
      }
      if (token.kind === 'restart' && token.previous?.attemptId === current.attemptId) {
        token.naturalEndObserved = true
        token.endedAttemptId = current.attemptId
        return
      }
      if (token.kind === 'pause' && token.previous?.attemptId === current.attemptId) {
        token.naturalEndWon = true
        this.clearReservation(token)
        this.reserveNaturalTransition(current, context)
        this.publish()
        return
      }
      if (token.target && token.target.entryId === current.entryId && token.target.musicCode === current.musicCode &&
          token.targetAttemptId === current.attemptId) {
        token.completed = true
        this.removePending(token.target.entryId)
        this.clearReservation(token)
        this.reserveNaturalTransition(current, context)
        this.publish()
      }
      return
    }
    const active = this.stableState.current
    if (!active || active.entryId !== current.entryId || active.attemptId !== current.attemptId) return
    this.reserveNaturalTransition(active, context)
    this.publish()
  }

  private reserveNaturalTransition(ended: StandaloneCurrentEntry, context: StandaloneCommandContext): TransitionReservation {
    this.mediaIdentities.delete(ended.entryId)
    const token = this.reserve('celebration', undefined, 'playback-event', ended)
    token.celebrationMessage = this.selectCelebrationMessage()
    token.celebrationRemainingMs = STANDALONE_CELEBRATION_MS
    token.celebrationDeadlineMs = this.countdownScheduler.now() + STANDALONE_CELEBRATION_MS
    token.celebrationPaused = false
    token.celebrationPendingAdmissions = 0
    token.celebrationDisplayedSecond = Math.ceil(STANDALONE_CELEBRATION_MS / 1000)
    token.celebrationGeneration = (token.celebrationGeneration ?? 0) + 1
    this.armCelebrationTimer(token, context)
    return token
  }

  private async runReservedStart(token: TransitionReservation, context: StandaloneCommandContext): Promise<void> {
    if (this.shutdownAdmissionClosed || this.reservation !== token || this.unavailable ||
        !token.target || token.startPhase === 'countdown') return
    const start = await context.transitions.run(() => {
      if (this.shutdownAdmissionClosed || this.disposed || this.unavailable || this.reservation !== token ||
          !token.target || token.startPhase === 'countdown') return undefined
      if (token.startPhase !== 'loading') {
        token.startPhase = 'loading'
        this.publish()
      }
      return { promise: this.startEntry(token.target, context) }
    })
    if (!start) return
    try {
      const state = await start.promise
      const result: StandaloneCommandExecutionResult = isConfirmedPlaying(state, token.target.musicCode)
        ? { outcome: 'confirmed', operationId: token.operationId!, attemptId: state.attemptId }
        : executionUncertain(token.operationId!, state.errorCode ?? 'PLAYBACK_FAILED', state.attemptId)
      await context.transitions.run(() => this.commitEventStart(token, result, context))
    } catch (error) {
      const result = executionFailure(token.operationId!, error)
      await context.transitions.run(() => this.failExecution(token, result))
    }
  }

  private async runNaturalEndAfterNext(token: TransitionReservation, current: StandaloneCurrentEntry,
    operationId: string, context: StandaloneCommandContext): Promise<StandaloneCommandExecutionResult> {
    type Decision = { readonly failure: StandaloneCommandExecutionResult } | { readonly target: StandaloneQueueEntry | undefined }
    const reserved = await context.transitions.run<Decision>(() => {
      if (this.shutdownAdmissionClosed || this.disposed) return { failure: executionRejected(operationId, 'DISPOSED') }
      if (this.unavailable) return { failure: executionForUnavailable(operationId, this.unavailable) }
      if (this.reservation !== token) return { failure: executionRejected(operationId, 'INVALID_STATE') }
      token.kind = 'eof'
      token.naturalEndWon = true
      token.endedAttemptId = current.attemptId
      if (!token.target) token.target = this.pending[0]
      this.publish()
      return { target: token.target }
    })
    if ('failure' in reserved) return reserved.failure
    if (reserved.target) {
      try {
        const start = await context.transitions.run(() => {
          if (this.shutdownAdmissionClosed || this.disposed || this.unavailable ||
              this.reservation !== token || !token.target) return undefined
          return { promise: this.startEntry(token.target, context) }
        })
        if (!start) return executionRejected(operationId, 'SUPERSEDED')
        const state = await start.promise
        return isConfirmedPlaying(state, reserved.target.musicCode)
          ? { outcome: 'confirmed', operationId, attemptId: state.attemptId }
          : executionUncertain(operationId, state.errorCode ?? 'PLAYBACK_FAILED', state.attemptId)
      } catch (error) { return executionFailure(operationId, error) }
    }
    try {
      const cleared = await context.playback.clearCompletedMedia(current.attemptId)
      return cleared ? { outcome: 'confirmed', operationId }
        : { outcome: 'blocked', operationId, error: { code: 'HOST_NOT_READY' } }
    } catch (error) { return executionFailure(operationId, error) }
  }

  private commitEventStart(token: TransitionReservation, result: StandaloneCommandExecutionResult,
    context: StandaloneCommandContext): void {
    if (this.unavailable || this.reservation !== token) return
    if (result.outcome !== 'confirmed') { this.failExecution(token, result); return }
    if (!result.attemptId || !token.target || !isCurrentState(context.playback.getState(), result.attemptId, token.target.musicCode, 'playing')) {
      this.failReservation(token, 'uncertain', 'PLAYBACK_FAILED')
      return
    }
    this.confirmStart(token, result.attemptId)
  }

  private finishWithoutCurrent(token: TransitionReservation, context: StandaloneCommandContext): StandalonePlayerCommandResult {
    if (this.reservation !== token) return confirmed(token.operationId ?? 'playback-event', this.getSnapshot())
    this.clearReservation(token)
    if (this.pending.length) {
      const first = this.pending[0]
      const start = this.reserve('start', first, token.operationId)
      this.publish()
      this.scheduleBackgroundEffect(() => this.runReservedStart(start, context))
      return confirmed(token.operationId ?? 'playback-event', this.getSnapshot())
    }
    this.stableState = { operationalState: 'idle', current: null, pending: [] }
    this.publish()
    return confirmed(token.operationId ?? 'playback-event', this.getSnapshot())
  }

  private cancelUnstartedAdmission(token: TransitionReservation, entry: StandaloneQueueEntry,
    code: StandalonePlayerErrorCode, context: StandaloneCommandContext): StandalonePlayerCommandResult {
    if (this.reservation === token) {
      this.removePending(entry.entryId)
      this.clearReservation(token)
      if (this.pending.length) {
        const start = this.reserve('start', this.pending[0], token.operationId)
        this.publish()
        this.scheduleBackgroundEffect(() => this.runReservedStart(start, context))
      } else {
        this.stableState = { operationalState: 'idle', current: null, pending: [] }
        this.publish()
      }
    }
    return rejected(token.operationId ?? 'unknown', code, this.getSnapshot())
  }

  private confirmStart(token: TransitionReservation, attemptId: string): StandalonePlayerCommandResult {
    if (!token.target || this.reservation !== token || this.pending[0]?.entryId !== token.target.entryId) {
      return this.failReservation(token, 'uncertain', 'INVALID_STATE')
    }
    if (this.stableState.current && this.stableState.current.entryId !== token.target.entryId) this.mediaIdentities.delete(this.stableState.current.entryId)
    this.removePending(token.target.entryId)
    const current: StandaloneCurrentEntry = { ...token.target, attemptId }
    this.clearReservation(token)
    this.stableState = { operationalState: 'playing', current, pending: [...this.pending] }
    token.completed = true
    this.publish()
    return confirmed(token.operationId ?? 'playback-event', this.getSnapshot(), attemptId)
  }

  private commitAdmissionOrder(entry: StandaloneQueueEntry, priority: 'normal' | 'priority', ticket: number): void {
    const reservedHead = this.reservation?.target && this.pending[0]?.entryId === this.reservation.target.entryId ? 1 : 0
    let index = reservedHead
    if (priority === 'priority') {
      while (index < this.pending.length) {
        const order = this.entryOrder.get(this.pending[index].entryId)
        if (!order || order.priority !== 'priority' || order.ticket < ticket) break
        index++
      }
    } else {
      while (index < this.pending.length && this.entryOrder.get(this.pending[index].entryId)?.priority === 'priority') index++
      while (index < this.pending.length) {
        const order = this.entryOrder.get(this.pending[index].entryId)
        if (!order || order.priority !== 'normal' || order.ticket > ticket) break
        index++
      }
    }
    this.pending.splice(index, 0, entry)
  }

  private insertPending(entry: StandaloneQueueEntry, priority: 'normal' | 'priority', ticket: number): void {
    this.entryOrder.set(entry.entryId, { priority, ticket })
    this.commitAdmissionOrder(entry, priority, ticket)
  }

  private removePending(entryId: string): void {
    this.pending = this.pending.filter(entry => entry.entryId !== entryId)
    this.entryOrder.delete(entryId)
  }

  private syncStablePending(): void {
    if (this.stableState.operationalState !== 'idle') {
      this.stableState = { operationalState: this.stableState.operationalState,
        current: this.stableState.current, pending: [...this.pending] }
    }
  }

  private rejectReservation(token: TransitionReservation, code: StandalonePlayerErrorCode): StandalonePlayerCommandResult {
    this.clearReservation(token)
    this.reorderPending()
    this.syncStablePending()
    this.publish()
    return rejected(token.operationId ?? 'unknown', code, this.getSnapshot())
  }

  private failReservation(token: TransitionReservation, outcome: 'blocked' | 'uncertain',
    code: StandalonePlayerErrorCode): StandalonePlayerCommandResult {
    if (token.completed) return confirmed(token.operationId ?? 'playback-event', this.getSnapshot())
    if (this.reservation !== token) {
      return this.unavailable
        ? unavailableResult(token.operationId ?? 'playback-event', this.unavailable)
        : rejected(token.operationId ?? 'playback-event', 'INVALID_STATE', this.getSnapshot())
    }
    if (outcome === 'blocked' && token.target && ['MEDIA_UNAVAILABLE', 'MEDIA_UNKNOWN', 'MEDIA_LOAD_FAILED', 'MEDIA_CHANGED'].includes(code)) {
      this.enterStorageRecovery(token.target, 'transition', undefined, code)
      return unavailableResult(token.operationId ?? 'playback-event', this.getSnapshot() as StandaloneBlockedSnapshot)
    }
    const lastConfirmedState = this.transitional?.lastConfirmedState ?? this.stableState
    this.clearReservation(token)
    const unavailable: StandaloneBlockedSnapshot | StandaloneUncertainSnapshot = outcome === 'blocked'
      ? { playbackCondition: 'blocked', lastConfirmedState, pending: [...this.pending], error: { code } }
      : { playbackCondition: 'uncertain', lastConfirmedState, pending: [...this.pending], error: { code } }
    this.unavailable = unavailable
    this.publish()
    return unavailableResult(token.operationId ?? 'playback-event', unavailable)
  }

  private setInitialRecoveryBlock(code: StandalonePlayerErrorCode): void {
    this.unavailable = { playbackCondition: 'blocked', lastConfirmedState: this.stableState,
      pending: [], error: { code } }
  }

  private failExecution(token: TransitionReservation, result: StandaloneCommandExecutionResult): StandalonePlayerCommandResult {
    if (result.outcome === 'rejected') return this.rejectReservation(token, result.error.code)
    if (result.outcome === 'confirmed') return confirmed(token.operationId ?? result.operationId, this.getSnapshot())
    return this.failReservation(token, result.outcome, result.error.code)
  }

  private block(operationId: string, code: StandalonePlayerErrorCode): StandalonePlayerCommandResult {
    if (!this.unavailable) {
      this.unavailable = { playbackCondition: 'blocked', lastConfirmedState: this.transitional?.lastConfirmedState ?? this.stableState,
        pending: [...this.pending], error: { code } }
      this.reservation = undefined
      this.transitional = undefined
      this.publish()
    }
    return unavailableResult(operationId, this.unavailable)
  }

  private markUncertain(operationId: string, code: StandalonePlayerErrorCode): StandalonePlayerCommandResult {
    if (!this.unavailable) {
      this.unavailable = { playbackCondition: 'uncertain', lastConfirmedState: this.transitional?.lastConfirmedState ?? this.stableState,
        pending: [...this.pending], error: { code } }
      this.reservation = undefined
      this.transitional = undefined
      this.publish()
    }
    return unavailableResult(operationId, this.unavailable)
  }

  private isRelevantEventAttempt(current: StandaloneCurrentEntry): boolean {
    const active = this.stableState.current
    if (active?.entryId === current.entryId && active.attemptId === current.attemptId) {
      const token = this.reservation
      if (token?.kind === 'next' && token.previous?.attemptId === current.attemptId && token.stopConfirmed) return false
      return true
    }
    const token = this.reservation
    if (token?.target?.entryId === current.entryId && token.target.musicCode === current.musicCode &&
        (!token.targetAttemptId || token.targetAttemptId === current.attemptId)) return true
    if (token?.previous?.entryId === current.entryId && token.previous.attemptId === current.attemptId) {
      return !(token.kind === 'next' && token.stopConfirmed)
    }
    return false
  }

  private hasContainedKnownFailure(snapshot: StandaloneBlockedSnapshot | StandaloneUncertainSnapshot,
    context: StandaloneCommandContext): boolean {
    if (snapshot.playbackCondition !== 'blocked') return false
    const playback = context.playback.getState()
    return playback.status === 'failed' && playback.errorCode === snapshot.error.code &&
      ['stop-acknowledged', 'host-terminated'].includes(playback.containmentStatus ?? '')
  }

  private reserve(kind: TransitionReservation['kind'], target?: StandaloneQueueEntry,
    operationId?: string, previous?: StandaloneCurrentEntry): TransitionReservation {
    const token: TransitionReservation = { tokenId: randomUUID(), kind, target, operationId, previous }
    this.reservation = token
    this.transitional = { playbackCondition: 'transitioning', phase: 'operation',
      lastConfirmedState: this.transitional?.lastConfirmedState ?? this.stableState, pending: [...this.pending] }
    return token
  }

  private clearReservation(token: TransitionReservation): void {
    if (this.reservation === token) {
      this.cancelCountdownTimer(token)
      this.cancelCelebrationTimer(token)
      this.reservation = undefined
      this.transitional = undefined
    }
  }

  private reorderPending(): void {
    const reserved = this.reservation?.target && this.pending[0]?.entryId === this.reservation.target.entryId
      ? this.pending.shift() : undefined
    this.pending.sort((left, right) => {
      const a = this.entryOrder.get(left.entryId)
      const b = this.entryOrder.get(right.entryId)
      if (a?.priority !== b?.priority) return a?.priority === 'priority' ? -1 : 1
      return a?.priority === 'priority' ? (b?.ticket ?? 0) - (a?.ticket ?? 0) : (a?.ticket ?? 0) - (b?.ticket ?? 0)
    })
    if (reserved) this.pending.unshift(reserved)
  }

  private publish(): void {
    if (this.reservation) {
      this.transitional = this.createTransitioningSnapshot()
    }
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch (error) {
        try { this.options.onCoordinationError(error) } catch { /* Reporting cannot break an authoritative state change. */ }
      }
    }
  }

  private createTransitioningSnapshot(): StandaloneTransitioningSnapshot {
    const token = this.reservation
    const base = {
      playbackCondition: 'transitioning' as const,
      lastConfirmedState: this.transitional?.lastConfirmedState ?? this.stableState,
      pending: this.pending.map(entry => ({ ...entry }))
    }
    if (token?.kind === 'start' && token.target && token.startPhase === 'countdown') {
      return {
        ...base,
        phase: 'countdown',
        target: { ...token.target },
        remainingMs: Math.min(STANDALONE_INITIAL_COUNTDOWN_MS, Math.ceil(this.remainingCountdownMs(token))),
        paused: token.countdownPaused === true
      }
    }
    if (token?.kind === 'celebration') {
      return {
        ...base,
        phase: 'celebration',
        remainingMs: Math.min(STANDALONE_CELEBRATION_MS, Math.ceil(this.remainingCelebrationMs(token))),
        paused: token.celebrationPaused === true,
        message: token.celebrationMessage ?? STANDALONE_CELEBRATION_MESSAGES[0]
      }
    }
    if ((token?.kind === 'start' || token?.kind === 'eof' || token?.kind === 'restart') &&
        token.target && token.startPhase === 'loading') {
      return { ...base, phase: 'loading', target: { ...token.target } }
    }
    if (token?.kind === 'pause' && token.pauseAction === 'resume') return { ...base, phase: 'resuming' }
    return { ...base, phase: 'operation' }
  }

  private scheduleBackgroundEffect(effect: () => Promise<void>): void {
    const task = Promise.resolve().then(() => this.disposed ? undefined : effect())
      .catch(error => {
        if (this.disposed) return
        try { this.options.onCoordinationError(error) } catch { /* Background reporting cannot create an orphan rejection. */ }
      })
    this.backgroundEffects.add(task)
    void task.finally(() => this.backgroundEffects.delete(task)).catch(() => undefined)
  }
}

function confirmed(operationId: string, snapshot: StandalonePlayerSnapshot, attemptId?: string): StandalonePlayerCommandResult {
  return { outcome: 'confirmed', operationId, snapshot: cloneSnapshot(snapshot), ...(attemptId ? { attemptId } : {}) }
}

function rejected(operationId: string, code: StandalonePlayerErrorCode,
  snapshot: StandalonePlayerSnapshot): StandalonePlayerCommandResult {
  return { outcome: 'rejected', operationId, error: { code }, snapshot: cloneSnapshot(snapshot) }
}

function unavailableResult(operationId: string, snapshot: StandaloneBlockedSnapshot | StandaloneUncertainSnapshot): StandalonePlayerCommandResult {
  return snapshot.playbackCondition === 'blocked'
    ? { outcome: 'blocked', operationId, snapshot: cloneBlocked(snapshot) }
    : { outcome: 'uncertain', operationId, snapshot: cloneUncertain(snapshot) }
}

function executionForUnavailable(operationId: string,
  snapshot: StandaloneBlockedSnapshot | StandaloneUncertainSnapshot): StandaloneCommandExecutionResult {
  return { outcome: snapshot.playbackCondition, operationId, error: { ...snapshot.error } }
}

function executionRejected(operationId: string, code: StandalonePlayerErrorCode): StandaloneCommandExecutionResult {
  return { outcome: 'rejected', operationId, error: { code } }
}

function executionUncertain(operationId: string, code: StandalonePlayerErrorCode,
  attemptId?: string): StandaloneCommandExecutionResult {
  return { outcome: 'uncertain', operationId, error: { code }, ...(attemptId ? { attemptId } : {}) }
}

function executionFailure(operationId: string, error: unknown): StandaloneCommandExecutionResult {
  const code = errorCode(error)
  if (isUncertainError(error)) return executionUncertain(operationId, code)
  return { outcome: 'blocked', operationId, error: { code } }
}

function errorCode(error: unknown): StandalonePlayerErrorCode {
  return error instanceof PlayerPlaybackError ? error.code : 'PLAYBACK_FAILED'
}

function isUncertainError(error: unknown): boolean {
  if (!(error instanceof PlayerPlaybackError)) return true
  return ['COMMAND_TIMEOUT', 'HOST_CONTAINMENT_FAILED', 'RECOVERY_PERSISTENCE_FAILED', 'SUPERSEDED'].includes(error.code)
}

function isConfirmedPlaying(state: PlayerPlaybackState, musicCode: string): state is PlayerPlaybackState & { attemptId: string } {
  return state.status === 'playing' && Boolean(state.attemptId) && state.musicCode === musicCode
}

function isCurrentState(state: PlayerPlaybackState, attemptId: string, musicCode: string,
  status: 'playing'): boolean {
  return state.status === status && state.attemptId === attemptId && state.musicCode === musicCode
}

function isCurrentCompleted(state: PlayerPlaybackState, current: StandaloneCurrentEntry): boolean {
  return state.status === 'completed' && state.attemptId === current.attemptId && state.musicCode === current.musicCode
}

function cloneSnapshot(snapshot: StandalonePlayerSnapshot): StandalonePlayerSnapshot {
  if (snapshot.storageRecovery) {
    const { storageRecovery, ...base } = snapshot
    return { ...cloneSnapshot(base), storageRecovery: { ...storageRecovery, target: storageRecovery.target ? { ...storageRecovery.target } : null } }
  }
  if (snapshot.playbackCondition === 'ready') {
    const state = snapshot.state
    return { playbackCondition: 'ready', state: state.operationalState === 'idle'
      ? { operationalState: 'idle', current: null, pending: [] }
      : { operationalState: state.operationalState, current: { ...state.current }, pending: state.pending.map(entry => ({ ...entry })) } }
  }
  if (snapshot.playbackCondition === 'transitioning') {
    const base = { playbackCondition: 'transitioning' as const,
      lastConfirmedState: cloneStableState(snapshot.lastConfirmedState), pending: snapshot.pending.map(entry => ({ ...entry })) }
    if (snapshot.phase === 'countdown') return { ...base, phase: 'countdown', target: { ...snapshot.target },
      remainingMs: snapshot.remainingMs, paused: snapshot.paused }
    if (snapshot.phase === 'loading') return { ...base, phase: 'loading', target: { ...snapshot.target } }
    if (snapshot.phase === 'celebration') return { ...base, phase: 'celebration', remainingMs: snapshot.remainingMs,
      paused: snapshot.paused, message: snapshot.message }
    return { ...base, phase: 'operation' }
  }
  return { playbackCondition: snapshot.playbackCondition, lastConfirmedState: cloneStableState(snapshot.lastConfirmedState),
    pending: snapshot.pending.map(entry => ({ ...entry })), error: { ...snapshot.error } }
}

function cloneBlocked(snapshot: StandaloneBlockedSnapshot): StandaloneBlockedSnapshot {
  return { playbackCondition: 'blocked', lastConfirmedState: cloneStableState(snapshot.lastConfirmedState),
    pending: snapshot.pending.map(entry => ({ ...entry })), error: { ...snapshot.error } }
}

function cloneUncertain(snapshot: StandaloneUncertainSnapshot): StandaloneUncertainSnapshot {
  return { playbackCondition: 'uncertain', lastConfirmedState: cloneStableState(snapshot.lastConfirmedState),
    pending: snapshot.pending.map(entry => ({ ...entry })), error: { ...snapshot.error } }
}

function cloneStableState(state: StandaloneStableState): StandaloneStableState {
  return state.operationalState === 'idle'
    ? { operationalState: 'idle', current: null, pending: [] }
    : { operationalState: state.operationalState, current: { ...state.current }, pending: state.pending.map(entry => ({ ...entry })) }
}
