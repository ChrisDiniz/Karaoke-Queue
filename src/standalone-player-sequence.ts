import { randomUUID } from 'node:crypto'
import { PlayerPlaybackError } from './player-playback-contracts'
import type { PlayerPlaybackState } from './player-playback-contracts'
import {
  createInitialStandalonePlayerSnapshot,
  type StandaloneBlockedSnapshot,
  type StandaloneCommandExecutionResult,
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
  type StandaloneTransitioningSnapshot,
  type StandaloneUncertainSnapshot
} from './standalone-player-contracts'
import {
  createStandalonePlayerComposition,
  type StandaloneCommandContext,
  type StandalonePlayerCompositionOptions,
  type StandalonePreparedCommand
} from './standalone-player-runtime'

const PLAYBACK_CONTROL_CONFIRMATION_TIMEOUT_MS = 15000

export interface StandalonePlayerSequenceOptions extends Omit<StandalonePlayerCompositionOptions,
  'getSnapshot' | 'getPlaybackCorrelation' | 'prepareCommand' | 'onPlaybackEvent'> {
  /** Injectable only to make queue occurrence identity deterministic in focused tests. */
  createEntryId?: () => string
}

interface EntryOrder {
  readonly ticket: number
  readonly priority: 'normal' | 'priority'
}

interface TransitionReservation {
  readonly tokenId: string
  kind: 'start' | 'eof' | 'cleanup' | 'next' | 'restart' | 'pause'
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
  private nextAdmissionTicket = 0
  private disposed = false
  private disposePromise: Promise<void> | undefined

  private constructor(private readonly options: StandalonePlayerSequenceOptions) {
    this.createEntryId = options.createEntryId ?? randomUUID
  }

  static async create(options: StandalonePlayerSequenceOptions): Promise<StandalonePlayerSequence> {
    const owner = new StandalonePlayerSequence(options)
    owner.composition = await createStandalonePlayerComposition({
      createPlayback: options.createPlayback,
      recovery: options.recovery,
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
    if (recovery.status === 'pending') owner.setInitialRecoveryBlock('RECOVERY_PENDING')
    else if (recovery.status === 'unreadable') owner.setInitialRecoveryBlock('RECOVERY_UNAVAILABLE')
    else if (recovery.status === 'unavailable') owner.setInitialRecoveryBlock('RECOVERY_PERSISTENCE_FAILED')
    return owner
  }

  getSnapshot(): StandalonePlayerSnapshot {
    if (this.unavailable) return cloneSnapshot(this.unavailable)
    if (this.reservation) {
      return cloneSnapshot({
        playbackCondition: 'transitioning',
        lastConfirmedState: this.transitional?.lastConfirmedState ?? this.stableState,
        pending: this.pending
      })
    }
    return cloneSnapshot({ playbackCondition: 'ready', state: this.stableState })
  }

  subscribe(listener: StandalonePlayerListener): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  execute(request: StandalonePlayerCommandRequest): Promise<StandalonePlayerCommandResult> {
    const composition = this.composition
    if (!composition || this.disposed) return Promise.resolve(rejected(request.operationId, 'DISPOSED', this.getSnapshot()))
    return composition.control.execute(request)
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
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
    if (this.disposed) return rejected(request.operationId, 'DISPOSED', this.getSnapshot())
    const snapshot = this.getSnapshot()
    if (snapshot.playbackCondition === 'blocked' || snapshot.playbackCondition === 'uncertain') {
      return unavailableResult(request.operationId, snapshot)
    }
    if (this.reservation && request.command.type !== 'submit-code') {
      return rejected(request.operationId, 'INVALID_STATE', snapshot)
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
    const ticket = this.nextAdmissionTicket++
    const entry: StandaloneQueueEntry = { entryId: this.createEntryId(), musicCode: code }
    this.entryOrder.set(entry.entryId, { ticket, priority })
    const startNow = !this.reservation && this.stableState.operationalState === 'idle'
    let startup: TransitionReservation | undefined
    if (startNow) {
      this.pending.push(entry)
      startup = this.reserve('start', entry, request.operationId)
      this.publish()
    }

    return {
      execute: async signal => {
        if (signal.aborted) return executionRejected(request.operationId, 'DISPOSED')
        try { await context.playback.validateMusicCode(code) }
        catch (error) { return executionRejected(request.operationId, errorCode(error)) }
        if (!startup) return { outcome: 'confirmed', operationId: request.operationId }
        try {
          const state = await context.playback.playImmediately(code)
          return isConfirmedPlaying(state, code)
            ? { outcome: 'confirmed', operationId: request.operationId, attemptId: state.attemptId }
            : executionUncertain(request.operationId, state.errorCode ?? 'PLAYBACK_FAILED', state.attemptId)
        } catch (error) { return executionFailure(request.operationId, error) }
      },
      commit: (result, commitContext) => {
        if (startup) {
          if (result.outcome === 'rejected') return this.cancelUnstartedAdmission(startup, entry, result.error.code, context)
          return this.commitStart(startup, result, commitContext)
        }
        return this.commitAdmission(request, entry, ticket, priority, result, context)
      }
    }
  }

  private commitAdmission(request: StandalonePlayerCommandRequest, entry: StandaloneQueueEntry, ticket: number,
    priority: 'normal' | 'priority', result: StandaloneCommandExecutionResult,
    context: StandaloneCommandContext): StandalonePlayerCommandResult {
    if (this.unavailable) {
      this.entryOrder.delete(entry.entryId)
      return unavailableResult(request.operationId, this.unavailable)
    }
    if (result.outcome === 'rejected') {
      this.entryOrder.delete(entry.entryId)
      return rejected(request.operationId, result.error.code, this.getSnapshot())
    }
    if (result.outcome === 'blocked') {
      this.entryOrder.delete(entry.entryId)
      return this.block(request.operationId, result.error.code)
    }
    if (result.outcome === 'uncertain') {
      this.entryOrder.delete(entry.entryId)
      return this.markUncertain(request.operationId, result.error.code)
    }

    this.entryOrder.set(entry.entryId, { ticket, priority })
    this.insertPending(entry, priority, ticket)
    if (!this.reservation && this.stableState.operationalState === 'idle') {
      const startup = this.reserve('start', this.pending[0], request.operationId)
      this.publish()
      this.scheduleBackgroundEffect(() => this.runReservedStart(startup, context))
      return confirmed(request.operationId, this.getSnapshot())
    }
    this.syncStablePending()
    this.publish()
    return confirmed(request.operationId, this.getSnapshot())
  }

  private prepareTogglePause(request: StandalonePlayerCommandRequest, context: StandaloneCommandContext) {
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
        const state = await this.executeAndConfirmPlaybackControl(
          action === 'pause' ? context.playback.pause() : context.playback.resume(),
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
    if (capturedAttemptId === undefined) return confirmed(request.operationId, this.getSnapshot())
    if (!current || capturedAttemptId !== current.attemptId) {
      return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
    }
    const engine = context.playback.getState()
    if (engine.status === 'completed' && engine.attemptId === current.attemptId) {
      return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
    }
    const token = this.reserve('next', this.pending[0], request.operationId, current)
    this.publish()
    return this.preparedTransition(request, token, async signal => {
      if (signal.aborted) return executionRejected(request.operationId, 'DISPOSED')
      let stopped: PlayerPlaybackState
      try { stopped = await context.playback.stop(current.attemptId) }
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
          const state = await context.playback.playImmediately(selected.target.musicCode)
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
    if (!current) return confirmed(request.operationId, this.getSnapshot())
    const engine = context.playback.getState()
    if (engine.status === 'completed' && engine.attemptId === current.attemptId) {
      return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
    }
    const token = this.reserve('restart', { entryId: current.entryId, musicCode: current.musicCode }, request.operationId, current)
    this.publish()
    return this.preparedTransition(request, token, async signal => {
      if (signal.aborted) return executionRejected(request.operationId, 'DISPOSED')
      try {
        const state = await context.playback.restart()
        if (!isConfirmedPlaying(state, current.musicCode) || state.attemptId === current.attemptId) {
          return executionUncertain(request.operationId, state.errorCode ?? 'PLAYBACK_FAILED', state.attemptId)
        }
        return { outcome: 'confirmed', operationId: request.operationId, attemptId: state.attemptId }
      } catch (error) { return executionFailure(request.operationId, error) }
    }, result => this.commitRestart(token, current, result))
  }

  private preparedTransition(request: StandalonePlayerCommandRequest, token: TransitionReservation,
    execute: (signal: AbortSignal) => Promise<StandaloneCommandExecutionResult>,
    commit: (result: StandaloneCommandExecutionResult) => StandalonePlayerCommandResult): StandalonePreparedCommand {
    return {
      execute,
      commit: result => {
        if (this.unavailable) return unavailableResult(request.operationId, this.unavailable)
        if (token.completed) return confirmed(request.operationId, this.getSnapshot())
        if (token.kind === 'pause' && token.naturalEndWon) return rejected(request.operationId, 'SUPERSEDED', this.getSnapshot())
        if (this.reservation !== token) return rejected(request.operationId, 'INVALID_STATE', this.getSnapshot())
        return commit(result)
      }
    }
  }

  private commitStart(token: TransitionReservation, result: StandaloneCommandExecutionResult,
    context: StandaloneCommandContext): StandalonePlayerCommandResult {
    if (this.unavailable) return unavailableResult(token.operationId ?? result.operationId, this.unavailable)
    if (token.completed) return confirmed(token.operationId ?? result.operationId, this.getSnapshot())
    if (this.reservation !== token) return rejected(token.operationId ?? result.operationId, 'INVALID_STATE', this.getSnapshot())
    if (result.outcome === 'rejected') return this.cancelUnstartedAdmission(token, token.target!, result.error.code, context)
    if (result.outcome !== 'confirmed') return this.failReservation(token, result.outcome, result.error.code)
    if (!result.attemptId || !token.target || this.pending[0]?.entryId !== token.target.entryId) {
      return this.failReservation(token, 'uncertain', 'PLAYBACK_FAILED')
    }
    const engine = context.playback.getState()
    if (!isCurrentState(engine, result.attemptId, token.target.musicCode, 'playing')) {
      return this.failReservation(token, 'uncertain', engine.errorCode ?? 'PLAYBACK_FAILED')
    }
    return this.confirmStart(token, result.attemptId)
  }

  private commitPause(token: TransitionReservation, current: StandaloneCurrentEntry,
    result: StandaloneCommandExecutionResult): StandalonePlayerCommandResult {
    if (result.outcome === 'rejected') return this.rejectReservation(token, result.error.code)
    if (result.outcome !== 'confirmed') return this.failReservation(token, result.outcome, result.error.code)
    if (!result.attemptId || result.attemptId !== current.attemptId) return this.failReservation(token, 'uncertain', 'PLAYBACK_FAILED')
    const state = token.pauseAction === 'pause' ? 'paused' : 'playing'
    this.clearReservation(token)
    this.stableState = { operationalState: state, current, pending: [...this.pending] }
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

  /** Called synchronously while A2.2's shared transition arbiter is held. */
  private onPlaybackEvent(event: StandalonePlaybackEvent, current: StandaloneCurrentEntry,
    context: StandaloneCommandContext): undefined {
    if (this.disposed || this.unavailable) return undefined
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
        const followUp = this.reserveNaturalTransition(current)
        this.publish()
        this.scheduleNaturalEffect(followUp, current, context)
        return
      }
      if (token.target && token.target.entryId === current.entryId && token.target.musicCode === current.musicCode &&
          token.targetAttemptId === current.attemptId) {
        token.completed = true
        this.removePending(token.target.entryId)
        this.clearReservation(token)
        const followUp = this.reserveNaturalTransition(current)
        this.publish()
        this.scheduleNaturalEffect(followUp, current, context)
      }
      return
    }
    const active = this.stableState.current
    if (!active || active.entryId !== current.entryId || active.attemptId !== current.attemptId) return
    const followUp = this.reserveNaturalTransition(active)
    this.publish()
    this.scheduleNaturalEffect(followUp, active, context)
  }

  private reserveNaturalTransition(ended: StandaloneCurrentEntry): TransitionReservation {
    return this.reserve(this.pending.length ? 'eof' : 'cleanup', this.pending[0], 'playback-event', ended)
  }

  private scheduleNaturalEffect(token: TransitionReservation, ended: StandaloneCurrentEntry,
    context: StandaloneCommandContext): void {
      this.scheduleBackgroundEffect(() => this.runNaturalEffect(token, ended, context))
  }

  private async runNaturalEffect(token: TransitionReservation, ended: StandaloneCurrentEntry,
    context: StandaloneCommandContext): Promise<void> {
    if (this.reservation !== token || this.unavailable) return
    if (token.target) {
      try {
        const state = await context.playback.playImmediately(token.target.musicCode)
        const result: StandaloneCommandExecutionResult = isConfirmedPlaying(state, token.target.musicCode)
          ? { outcome: 'confirmed', operationId: token.operationId!, attemptId: state.attemptId }
          : executionUncertain(token.operationId!, state.errorCode ?? 'PLAYBACK_FAILED', state.attemptId)
        await context.transitions.run(() => this.commitEventStart(token, result, context))
      } catch (error) {
        const result = executionFailure(token.operationId!, error)
        await context.transitions.run(() => this.failExecution(token, result))
      }
      return
    }
    try {
      const cleared = await context.playback.clearCompletedMedia(ended.attemptId)
      await context.transitions.run(() => {
        if (this.reservation !== token || this.unavailable) return
        if (!cleared) { this.failReservation(token, 'blocked', 'HOST_NOT_READY'); return }
        this.finishWithoutCurrent(token, context)
      })
    } catch (error) {
      const result = executionFailure(token.operationId!, error)
      await context.transitions.run(() => this.failExecution(token, result))
    }
  }

  private async runReservedStart(token: TransitionReservation, context: StandaloneCommandContext): Promise<void> {
    if (this.reservation !== token || this.unavailable || !token.target) return
    try {
      const state = await context.playback.playImmediately(token.target.musicCode)
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
        const state = await context.playback.playImmediately(reserved.target.musicCode)
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

  private reserve(kind: TransitionReservation['kind'], target?: StandaloneQueueEntry,
    operationId?: string, previous?: StandaloneCurrentEntry): TransitionReservation {
    const token: TransitionReservation = { tokenId: randomUUID(), kind, target, operationId, previous }
    this.reservation = token
    this.transitional = { playbackCondition: 'transitioning',
      lastConfirmedState: this.transitional?.lastConfirmedState ?? this.stableState, pending: [...this.pending] }
    return token
  }

  private clearReservation(token: TransitionReservation): void {
    if (this.reservation === token) {
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
      this.transitional = { playbackCondition: 'transitioning',
        lastConfirmedState: this.transitional?.lastConfirmedState ?? this.stableState, pending: [...this.pending] }
    }
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch (error) {
        try { this.options.onCoordinationError(error) } catch { /* Reporting cannot break an authoritative state change. */ }
      }
    }
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
  if (snapshot.playbackCondition === 'ready') {
    const state = snapshot.state
    return { playbackCondition: 'ready', state: state.operationalState === 'idle'
      ? { operationalState: 'idle', current: null, pending: [] }
      : { operationalState: state.operationalState, current: { ...state.current }, pending: state.pending.map(entry => ({ ...entry })) } }
  }
  if (snapshot.playbackCondition === 'transitioning') {
    return { playbackCondition: 'transitioning', lastConfirmedState: cloneStableState(snapshot.lastConfirmedState),
      pending: snapshot.pending.map(entry => ({ ...entry })) }
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
