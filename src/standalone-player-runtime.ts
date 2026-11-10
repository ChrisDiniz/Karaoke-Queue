import { normalizeCatalogCodeForVideoMatch } from './music-catalog'
import { PlayerPlaybackError } from './player-playback-contracts'
import type {
  PlayerPlaybackEvent,
  PlayerPlaybackPersistence
} from './player-playback-contracts'
import type { PlayerRecoverySnapshot } from './player-playback-recovery-contracts'
import type {
  StandaloneCatalogPort,
  StandaloneCommandExecutionResult,
  StandaloneCurrentEntry,
  StandalonePlaybackCorrelation,
  StandalonePlaybackEvent,
  StandalonePlaybackPort,
  StandalonePlayerCommand,
  StandalonePlayerCommandRequest,
  StandalonePlayerCommandResult,
  StandalonePlayerErrorCode,
  StandalonePlayerSnapshot,
  StandaloneRecoveryPort,
  StandaloneUncertainSnapshot
} from './standalone-player-contracts'

export type StandaloneCodeNormalizer = (value: unknown) => string

export class StandaloneRuntimeError extends Error {
  constructor(readonly code: 'INVALID_STATE' | 'DISPOSED', message: string) {
    super(message)
    this.name = 'StandaloneRuntimeError'
  }
}

/** Executes only synchronous reservation/commit callbacks; playback I/O runs outside this lane. */
export class StandaloneTransitionArbiter {
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private closePromise: Promise<void> | undefined

  run<T>(transition: () => T): Promise<T> {
    if (this.closed) return Promise.reject(new StandaloneRuntimeError('DISPOSED', 'A coordenação Standalone foi encerrada.'))
    const result = this.tail.then(() => {
      if (this.closed) throw new StandaloneRuntimeError('DISPOSED', 'A coordenação Standalone foi encerrada.')
      const value = transition()
      if (isPromiseLike(value)) {
        throw new StandaloneRuntimeError('INVALID_STATE', 'Uma transição Main-side deve terminar antes de iniciar I/O de playback.')
      }
      return value
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  close(): Promise<void> {
    this.closed = true
    if (!this.closePromise) this.closePromise = this.tail.then(() => undefined, () => undefined)
    return this.closePromise
  }
}

export interface StandaloneCommandContext {
  readonly playback: StandalonePlaybackPort
  readonly recovery?: StandaloneRecoveryPort
  readonly catalog?: StandaloneCatalogPort
  readonly normalizeCode: StandaloneCodeNormalizer
  readonly getSnapshot: () => StandalonePlayerSnapshot
  /** Snapshot captured only after request validation and operationId deduplication. */
  readonly submittedSnapshot?: StandalonePlayerSnapshot
  readonly transitions: StandaloneTransitionArbiter
  /** Present only for a syntactically valid `submit-code` request. */
  readonly canonicalCode?: string
}

export interface StandalonePreparedCommand {
  /** Runs outside the transition arbiter; returns technical evidence and must honor cancellation. */
  execute(signal: AbortSignal): Promise<StandaloneCommandExecutionResult>
  /** Synchronously reconciles against current/reservation and commits under the arbiter; it must not perform I/O. */
  commit(result: StandaloneCommandExecutionResult, context: StandaloneCommandContext): StandalonePlayerCommandResult
}

export type StandaloneCommandPreparation = StandalonePreparedCommand | StandalonePlayerCommandResult

export type StandaloneCommandPreparer = (
  request: StandalonePlayerCommandRequest,
  context: StandaloneCommandContext
) => StandaloneCommandPreparation

export type StandalonePlaybackEventHandler = (
  event: StandalonePlaybackEvent,
  current: StandaloneCurrentEntry,
  context: StandaloneCommandContext
) => undefined

interface ParsedRequest {
  request: StandalonePlayerCommandRequest
  fingerprint: string
}

interface OperationRecord {
  fingerprint: string
  promise: Promise<StandalonePlayerCommandResult>
}

interface InFlightOperation {
  controller: AbortController
  promise: Promise<StandalonePlayerCommandResult>
}

type PreparedEffectStart =
  | { kind: 'started'; promise: Promise<StandaloneCommandExecutionResult> }
  | { kind: 'aborted' }
  | { kind: 'threw'; error: unknown }

/** Serializes synchronous command decisions and effect starts; playback confirmations remain concurrent and outside the arbiter. */
export class StandaloneOperationCoordinator {
  private readonly operations = new Map<string, OperationRecord>()
  private readonly inFlight = new Map<string, InFlightOperation>()
  private effectStartTail: Promise<void> = Promise.resolve()
  private closing = false

  constructor(
    private readonly transitions: StandaloneTransitionArbiter,
    private readonly context: StandaloneCommandContext,
    private readonly prepare: StandaloneCommandPreparer,
    private readonly onCoordinationError: (error: unknown) => void = () => undefined
  ) {}

  execute(rawRequest: StandalonePlayerCommandRequest): Promise<StandalonePlayerCommandResult> {
    let parsed: ParsedRequest
    try {
      parsed = parseRequest(rawRequest)
    } catch (error) {
      return Promise.reject(error)
    }

    const existing = this.operations.get(parsed.request.operationId)
    if (existing) {
      if (existing.fingerprint === parsed.fingerprint) return existing.promise
      return Promise.resolve(rejectedResult(parsed.request.operationId, 'OPERATION_ID_CONFLICT', this.context.getSnapshot()))
    }
    if (this.closing) return Promise.resolve(rejectedResult(parsed.request.operationId, 'DISPOSED', this.context.getSnapshot()))

    const controller = new AbortController()
    const promise = this.perform(parsed.request, controller.signal)
    const record: OperationRecord = { fingerprint: parsed.fingerprint, promise }
    this.operations.set(parsed.request.operationId, record)
    this.inFlight.set(parsed.request.operationId, { controller, promise })
    void promise.then(
      () => this.inFlight.delete(parsed.request.operationId),
      () => this.inFlight.delete(parsed.request.operationId)
    )
    return promise
  }

  getSnapshot(): StandalonePlayerSnapshot {
    return this.context.getSnapshot()
  }

  beginClose(): void {
    if (this.closing) return
    this.closing = true
    for (const operation of this.inFlight.values()) operation.controller.abort()
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()].map(operation => operation.promise))
  }

  clear(): void {
    this.operations.clear()
    this.inFlight.clear()
  }

  private async perform(
    request: StandalonePlayerCommandRequest,
    signal: AbortSignal
  ): Promise<StandalonePlayerCommandResult> {
    if (this.closing) return rejectedResult(request.operationId, 'DISPOSED', this.context.getSnapshot())

    const submittedSnapshot = this.context.getSnapshot()
    let canonicalCode: string | undefined
    if (request.command.type === 'submit-code') {
      try { canonicalCode = this.context.normalizeCode(request.command.enteredCode) }
      catch { return rejectedResult(request.operationId, 'INVALID_MUSIC_CODE', this.context.getSnapshot()) }
    }

    let prepared: StandaloneCommandPreparation
    const commandContext: StandaloneCommandContext = { ...this.context, canonicalCode, submittedSnapshot }
    try {
      prepared = await this.transitions.run(() => {
        if (signal.aborted || this.closing) {
          return rejectedResult(request.operationId, 'DISPOSED', this.context.getSnapshot())
        }
        try {
          this.context.recovery?.assertPlaybackAllowed()
        } catch (error) {
          return rejectedResult(request.operationId, errorCode(error), this.context.getSnapshot())
        }
        const preparation = this.prepare(request, commandContext)
        return 'outcome' in preparation
          ? matchOperationId(preparation, request.operationId, this.context.getSnapshot())
          : preparation
      })
    } catch (error) {
      if (error instanceof StandaloneRuntimeError && error.code === 'DISPOSED') {
        return rejectedResult(request.operationId, 'DISPOSED', this.context.getSnapshot())
      }
      return uncertainResult(request.operationId, errorCode(error), this.context.getSnapshot())
    }

    if ('outcome' in prepared) return prepared
    const start = await this.startEffect(prepared, signal)
    if (start.kind === 'aborted') return rejectedResult(request.operationId, 'DISPOSED', this.context.getSnapshot())
    let executionResult: StandaloneCommandExecutionResult
    let executionError: unknown
    if (start.kind === 'threw') {
      executionError = start.error
      executionResult = uncertainExecutionResult(request.operationId, errorCode(start.error))
    } else {
      try {
        executionResult = matchExecutionOperationId(await start.promise, request.operationId)
      } catch (error) {
        executionError = error
        executionResult = uncertainExecutionResult(request.operationId, errorCode(error))
      }
    }
    try {
      return await this.transitions.run(() => {
        const committed = signal.aborted || this.closing
          ? prepared.commit(uncertainExecutionResult(request.operationId, 'DISPOSED'), commandContext)
          : prepared.commit(executionResult, commandContext)
        if (executionError) this.reportError(executionError)
        return matchOperationId(committed, request.operationId, this.context.getSnapshot())
      })
    } catch (error) {
      this.reportError(error)
      return uncertainResult(request.operationId, errorCode(error), this.context.getSnapshot())
    }
  }

  private startEffect(prepared: StandalonePreparedCommand, signal: AbortSignal): Promise<PreparedEffectStart> {
    const start = this.effectStartTail.then((): PreparedEffectStart => {
      if (signal.aborted || this.closing) return { kind: 'aborted' }
      try {
        // Wrap the returned Promise so this start lane releases immediately instead of awaiting host readiness/ACK.
        return { kind: 'started', promise: prepared.execute(signal) }
      } catch (error) {
        return { kind: 'threw', error }
      }
    })
    this.effectStartTail = start.then(() => undefined, () => undefined)
    return start
  }

  private reportError(error: unknown): void {
    try { this.onCoordinationError(error) } catch { /* Error reporting must not create an orphaned command rejection. */ }
  }

}

/** Relays only events that still match the authoritative current attempt; natural EOF is at-most-once per attempt. */
export class StandalonePlaybackEventCoordinator {
  private seenNaturalEndAttemptId: string | undefined
  private readonly unsubscribe: () => void
  private disposed = false
  private boundReservation: { entryId: string; musicCode: string; attemptId: string } | undefined

  constructor(
    playback: Pick<StandalonePlaybackPort, 'subscribe'>,
    private readonly transitions: StandaloneTransitionArbiter,
    private readonly getCorrelation: () => StandalonePlaybackCorrelation,
    private readonly onEvent: StandalonePlaybackEventHandler,
    private readonly context: StandaloneCommandContext,
    private readonly onError: (error: unknown) => void
  ) {
    this.unsubscribe = playback.subscribe(event => this.receive(event))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.seenNaturalEndAttemptId = undefined
    this.boundReservation = undefined
  }

  private receive(event: PlayerPlaybackEvent): void {
    if (this.disposed || !isStandalonePlaybackEvent(event)) return
    void this.transitions.run(() => {
      if (this.disposed) return
      const identity = eventIdentity(event)
      if (!identity) return
      const current = this.correlateReservation(event, identity)
      if (!current) return
      if (identity.attemptId && identity.attemptId !== this.seenNaturalEndAttemptId) {
        this.seenNaturalEndAttemptId = undefined
      }
      if (event.type === 'natural-end-candidate') {
        if (this.seenNaturalEndAttemptId === event.attemptId) return
        this.seenNaturalEndAttemptId = event.attemptId
      }
      try {
        const handlerResult = (this.onEvent as (...args: Parameters<StandalonePlaybackEventHandler>) => unknown)(event, current, this.context)
        if (isPromiseLike(handlerResult)) {
          void Promise.resolve(handlerResult).catch(error => this.reportError(error))
          this.reportError(new StandaloneRuntimeError('INVALID_STATE', 'Um handler de playback deve concluir sincronamente dentro do árbitro.'))
        }
      } catch (error) { this.reportError(error) }
    }).catch(error => this.reportError(error))
  }

  private reportError(error: unknown): void {
    try { this.onError(error) } catch { /* Error reporting must not create an orphaned listener rejection. */ }
  }

  private correlateReservation(
    event: StandalonePlaybackEvent,
    identity: { attemptId?: string; musicCode?: string }
  ): StandaloneCurrentEntry | null {
    if (!identity.attemptId || !identity.musicCode) return null
    const correlation = this.getCorrelation()
    const engineState = this.context.playback.getState()
    if (engineState.attemptId !== identity.attemptId || engineState.musicCode !== identity.musicCode) return null
    if (event.type === 'natural-end-candidate' && engineState.status !== 'completed') return null

    const current = correlation.current
    if (current?.attemptId === identity.attemptId && current.musicCode === identity.musicCode) return current

    const reservation = correlation.reservation
    if (!reservation || reservation.musicCode !== identity.musicCode) {
      this.boundReservation = undefined
      return null
    }
    if (this.boundReservation && (this.boundReservation.entryId !== reservation.entryId ||
        this.boundReservation.musicCode !== reservation.musicCode)) this.boundReservation = undefined
    if (reservation.attemptId) {
      if (reservation.attemptId !== identity.attemptId) return null
      return { entryId: reservation.entryId, musicCode: reservation.musicCode, attemptId: identity.attemptId }
    }
    if (this.boundReservation?.entryId === reservation.entryId &&
        this.boundReservation.musicCode === reservation.musicCode) {
      if (this.boundReservation.attemptId === identity.attemptId) return { ...reservation, attemptId: identity.attemptId }
      if (event.type !== 'state-changed' || !['loading', 'ready', 'starting', 'playing', 'paused'].includes(event.state.status)) return null
    }
    if (event.type !== 'state-changed' || !['loading', 'ready', 'starting', 'playing', 'paused'].includes(event.state.status)) {
      return null
    }
    this.boundReservation = { entryId: reservation.entryId, musicCode: reservation.musicCode, attemptId: identity.attemptId }
    return { entryId: reservation.entryId, musicCode: reservation.musicCode, attemptId: identity.attemptId }
  }
}

export interface StandalonePlayerCompositionOptions {
  /** Creates exactly one shared playback service with the supplied persistence boundary. */
  createPlayback(persistence?: PlayerPlaybackPersistence): StandalonePlaybackPort
  recovery?: StandaloneRecoveryPort
  catalog?: StandaloneCatalogPort
  getSnapshot(): StandalonePlayerSnapshot
  getPlaybackCorrelation(): StandalonePlaybackCorrelation
  prepareCommand: StandaloneCommandPreparer
  onPlaybackEvent: StandalonePlaybackEventHandler
  onCoordinationError(error: unknown): void
  normalizeCode?: StandaloneCodeNormalizer
  /** Called once after playback and recovery stop using resources owned by a concrete adapter. */
  disposeResources?(): void | Promise<void>
}

export interface StandalonePlayerComposition {
  readonly playback: StandalonePlaybackPort
  readonly recovery?: StandaloneRecoveryPort
  readonly catalog?: StandaloneCatalogPort
  readonly transitions: StandaloneTransitionArbiter
  readonly control: StandaloneOperationCoordinator
  getRecoveryState(): PlayerRecoverySnapshot | { status: 'none' }
  dispose(): Promise<void>
}

/** Injected Main-side composition. It creates no windows, IPC handlers, queues, or Controller services. */
export async function createStandalonePlayerComposition(
  options: StandalonePlayerCompositionOptions
): Promise<StandalonePlayerComposition> {
  let playback: StandalonePlaybackPort | undefined
  let recoveryStarted = false
  let resourcesDisposed = false
  const disposeResources = async (): Promise<void> => {
    if (resourcesDisposed) return
    resourcesDisposed = true
    await options.disposeResources?.()
  }
  try {
    if (options.recovery) {
      recoveryStarted = true
      options.recovery.initialize()
    }
    playback = options.createPlayback(options.recovery)
    options.recovery?.attachPlayback(playback)

    const transitions = new StandaloneTransitionArbiter()
    const normalizeCode = options.normalizeCode ?? normalizeCatalogCodeForVideoMatch
    const context: StandaloneCommandContext = {
      playback,
      recovery: options.recovery,
      catalog: options.catalog,
      normalizeCode,
      getSnapshot: options.getSnapshot,
      transitions
    }
    const control = new StandaloneOperationCoordinator(transitions, context, options.prepareCommand, options.onCoordinationError)
    const playbackEvents = new StandalonePlaybackEventCoordinator(
      playback, transitions, options.getPlaybackCorrelation, options.onPlaybackEvent, context, options.onCoordinationError
    )

    let disposePromise: Promise<void> | undefined
    return {
      playback,
      recovery: options.recovery,
      catalog: options.catalog,
      transitions,
      control,
      getRecoveryState: () => options.recovery?.getState() ?? { status: 'none' },
      dispose: () => {
        if (disposePromise) return disposePromise
        control.beginClose()
        playbackEvents.dispose()
        disposePromise = (async () => {
          let disposalError: unknown
          await transitions.close()
          try { await playback!.dispose() } catch (error) { disposalError = error }
          await control.drain()
          try { options.recovery?.dispose() } catch (error) { disposalError ??= error }
          try { await disposeResources() } catch (error) { disposalError ??= error }
          control.clear()
          if (disposalError) throw disposalError
        })()
        return disposePromise
      }
    }
  } catch (error) {
    try { await playback?.dispose() } catch { /* Preserve the construction failure while containing the owned playback service. */ }
    if (recoveryStarted) {
      try { options.recovery?.dispose() } catch { /* Preserve the construction failure. */ }
    }
    try { await disposeResources() } catch { /* Preserve the construction failure while cleaning adapter-owned resources. */ }
    throw error
  }
}

function parseRequest(value: unknown): ParsedRequest {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['operationId', 'command']) ||
      typeof value.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.operationId) ||
      !isPlainRecord(value.command)) {
    throw new StandaloneRuntimeError('INVALID_STATE', 'A solicitação Standalone é inválida.')
  }
  const command = value.command
  let normalized: StandalonePlayerCommand
  if (command.type === 'submit-code' && hasOnlyKeys(command, ['type', 'enteredCode', 'priority']) &&
      typeof command.enteredCode === 'string' && command.enteredCode.length <= 1024 &&
      (command.priority === 'normal' || command.priority === 'priority')) {
    normalized = { type: 'submit-code', enteredCode: command.enteredCode, priority: command.priority }
  } else if (command.type === 'toggle-pause' && hasOnlyKeys(command, ['type'])) {
    normalized = { type: 'toggle-pause' }
  } else if (command.type === 'next' && hasOnlyKeys(command, ['type'])) {
    normalized = { type: 'next' }
  } else if (command.type === 'restart' && hasOnlyKeys(command, ['type'])) {
    normalized = { type: 'restart' }
  } else if (command.type === 'stop-all' && hasOnlyKeys(command, ['type'])) {
    normalized = { type: 'stop-all' }
  } else {
    throw new StandaloneRuntimeError('INVALID_STATE', 'O comando Standalone é inválido.')
  }
  const request = { operationId: value.operationId, command: normalized }
  return { request, fingerprint: commandFingerprint(normalized) }
}

/** Shared boundary validator for transports that must reject malformed requests before IPC dispatch. */
export function validateStandalonePlayerCommandRequest(value: unknown): StandalonePlayerCommandRequest {
  return parseRequest(value).request
}

function commandFingerprint(command: StandalonePlayerCommand): string {
  switch (command.type) {
    case 'submit-code': return JSON.stringify([command.type, command.enteredCode, command.priority])
    case 'toggle-pause':
    case 'next':
    case 'restart':
    case 'stop-all': return JSON.stringify([command.type])
  }
}

function rejectedResult(
  operationId: string,
  code: StandalonePlayerErrorCode,
  snapshot: StandalonePlayerSnapshot
): StandalonePlayerCommandResult {
  return { outcome: 'rejected', operationId, error: { code }, snapshot }
}

function uncertainResult(
  operationId: string,
  code: StandalonePlayerErrorCode,
  snapshot: StandalonePlayerSnapshot
): StandalonePlayerCommandResult {
  const lastConfirmedState = snapshot.playbackCondition === 'ready' ? snapshot.state : snapshot.lastConfirmedState
  const pending = snapshot.playbackCondition === 'ready' ? snapshot.state.pending : snapshot.pending
  const uncertainSnapshot: StandaloneUncertainSnapshot = {
    playbackCondition: 'uncertain',
    lastConfirmedState,
    pending: [...pending],
    error: { code }
  }
  return { outcome: 'uncertain', operationId, snapshot: uncertainSnapshot }
}

function matchOperationId(
  result: StandalonePlayerCommandResult,
  expectedOperationId: string,
  snapshot: StandalonePlayerSnapshot
): StandalonePlayerCommandResult {
  if (result.operationId === expectedOperationId) return result
  return uncertainResult(expectedOperationId, 'PLAYBACK_FAILED', snapshot)
}

function uncertainExecutionResult(
  operationId: string,
  code: StandalonePlayerErrorCode
): StandaloneCommandExecutionResult {
  return { outcome: 'uncertain', operationId, error: { code } }
}

function matchExecutionOperationId(
  result: StandaloneCommandExecutionResult,
  expectedOperationId: string
): StandaloneCommandExecutionResult {
  if (result.operationId === expectedOperationId) return result
  return uncertainExecutionResult(expectedOperationId, 'PLAYBACK_FAILED')
}

function errorCode(error: unknown): StandalonePlayerErrorCode {
  return error instanceof PlayerPlaybackError ? error.code : 'PLAYBACK_FAILED'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function')
}

function isStandalonePlaybackEvent(event: PlayerPlaybackEvent): event is StandalonePlaybackEvent {
  return ['state-changed', 'natural-end-candidate', 'interrupted', 'uncertain', 'error', 'surface-cleanup-failed'].includes(event.type)
}

function eventIdentity(event: StandalonePlaybackEvent): { attemptId?: string; musicCode?: string } | undefined {
  if (event.type === 'state-changed') {
    return { attemptId: event.state.attemptId, musicCode: event.state.musicCode }
  }
  return { attemptId: event.attemptId, musicCode: event.musicCode }
}
