import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PlayerPlaybackError,
  type PlayerPlaybackEvent,
  type PlayerPlaybackListener,
  type PlayerPlaybackPersistence,
  type PlayerPlaybackPersistenceTransition,
  type PlayerPlaybackRecoveryTarget,
  type PlayerPlaybackState
} from '../src/player-playback-contracts'
import type { PlayerRecoverySnapshot } from '../src/player-playback-recovery-contracts'
import type { PlayerPlaybackRecoveryCoordinator } from '../src/player-playback-recovery'
import {
  createInitialStandalonePlayerSnapshot,
  type StandaloneCatalogPort,
  type StandaloneCommandExecutionResult,
  type StandaloneCurrentEntry,
  type StandalonePlaybackCorrelation,
  type StandalonePlaybackPort,
  type StandaloneBlockedSnapshot,
  type StandalonePlayerCommandRequest,
  type StandalonePlayerCommandResult,
  type StandalonePlayerErrorCode,
  type StandalonePlayerSnapshot,
  type StandaloneUncertainSnapshot,
  type StandaloneRecoveryPort
} from '../src/standalone-player-contracts'

type Assert<T extends true> = T
type SharedRecoveryCoordinatorSatisfiesStandalonePort = Assert<
  PlayerPlaybackRecoveryCoordinator extends StandaloneRecoveryPort ? true : false
>
const sharedRecoveryCompatibility: SharedRecoveryCoordinatorSatisfiesStandalonePort = true
import {
  createStandalonePlayerComposition,
  StandaloneRuntimeError,
  StandaloneTransitionArbiter,
  type StandalonePlayerComposition,
  type StandalonePlayerCompositionOptions,
  type StandaloneCommandPreparer,
  type StandaloneCommandContext,
  type StandalonePreparedCommand,
  type StandalonePlaybackEventHandler
} from '../src/standalone-player-runtime'

const asynchronousPlaybackHandler = async () => undefined
// @ts-expect-error Playback event handlers must not escape the synchronous arbiter.
const invalidAsyncPlaybackHandler: StandalonePlaybackEventHandler = asynchronousPlaybackHandler
void invalidAsyncPlaybackHandler

class FakePlayback implements StandalonePlaybackPort {
  state: PlayerPlaybackState = { status: 'idle' }
  disposeCount = 0
  private readonly listeners = new Set<PlayerPlaybackListener>()

  get listenerCount(): number { return this.listeners.size }

  getState(): PlayerPlaybackState { return { ...this.state } }
  async validateMusicCode(): Promise<void> {}
  async playImmediately(musicCode: string): Promise<PlayerPlaybackState> {
    this.state = { status: 'playing', attemptId: `attempt-${musicCode}`, musicCode }
    return this.getState()
  }
  async pause(): Promise<PlayerPlaybackState> { this.state = { ...this.state, status: 'paused' }; return this.getState() }
  async resume(): Promise<PlayerPlaybackState> { this.state = { ...this.state, status: 'playing' }; return this.getState() }
  async restart(): Promise<PlayerPlaybackState> { return this.getState() }
  async stop(): Promise<PlayerPlaybackState> { this.state = { ...this.state, status: 'stopped' }; return this.getState() }
  async clearCompletedMedia(): Promise<boolean> { return true }
  async clearStoppedMedia(): Promise<boolean> { return true }
  async resolveRecoveryAsStopped(expectedAttemptId: string, musicCode: string): Promise<PlayerPlaybackState> {
    this.state = { status: 'stopped', attemptId: expectedAttemptId, musicCode }
    return this.getState()
  }
  subscribe(listener: PlayerPlaybackListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: PlayerPlaybackEvent): void {
    for (const listener of this.listeners) listener(event)
  }
  async dispose(): Promise<void> { this.disposeCount++ }
}

interface FakeRecoveryOptions {
  initial?: PlayerRecoverySnapshot
  assertError?: Error
  initializeError?: Error
}

function fakeRecovery(options: FakeRecoveryOptions = {}) {
  let state = options.initial ?? { status: 'none' as const }
  let attachedPlayback: PlayerPlaybackRecoveryTarget | undefined
  let disposeCount = 0
  let initializeCount = 0
  const recovery: StandaloneRecoveryPort = {
    initialize: () => { initializeCount++; if (options.initializeError) throw options.initializeError; return state },
    attachPlayback: playback => { attachedPlayback = playback },
    getState: () => state,
    assertPlaybackAllowed: () => { if (options.assertError) throw options.assertError },
    resolveInvalidRecovery: () => ({ state, preservedFileCount: 0 }),
    leaveStopped: async () => state,
    persistTransition: (_next: PlayerPlaybackState, _previous: PlayerPlaybackState,
      _transition: PlayerPlaybackPersistenceTransition) => undefined,
    dispose: () => { disposeCount++ }
  }
  return {
    recovery,
  get attachedPlayback(): PlayerPlaybackRecoveryTarget | undefined { return attachedPlayback },
    get disposeCount() { return disposeCount },
    get initializeCount() { return initializeCount },
    setState(next: PlayerRecoverySnapshot) { state = next }
  }
}

interface BuildOptions {
  recovery?: StandaloneRecoveryPort
  catalog?: StandaloneCatalogPort
  prepareCommand?: StandaloneCommandPreparer
  getSnapshot?: () => StandalonePlayerSnapshot
  getPlaybackCorrelation?: () => StandalonePlaybackCorrelation
  onPlaybackEvent?: StandalonePlayerCompositionOptions['onPlaybackEvent']
  onCoordinationError?: (error: unknown) => void
}

async function buildComposition(options: BuildOptions = {}) {
  const playback = new FakePlayback()
  const errors: unknown[] = []
  const events: Array<{ event: PlayerPlaybackEvent; current: StandaloneCurrentEntry }> = []
  let created = 0
  let receivedPersistence: PlayerPlaybackPersistence | undefined
  const composition = await createStandalonePlayerComposition({
    createPlayback: persistence => {
      created++
      receivedPersistence = persistence
      return playback
    },
    recovery: options.recovery,
    catalog: options.catalog,
    getSnapshot: options.getSnapshot ?? createInitialStandalonePlayerSnapshot,
    getPlaybackCorrelation: options.getPlaybackCorrelation ?? (() => ({ current: null, reservation: null })),
    prepareCommand: options.prepareCommand ?? ((request, context) => ({
      outcome: 'confirmed', operationId: request.operationId, snapshot: context.getSnapshot() as Extract<StandalonePlayerSnapshot, { playbackCondition: 'ready' }>
    })),
    onPlaybackEvent: options.onPlaybackEvent ?? ((event, current) => { events.push({ event, current }); return undefined }),
    onCoordinationError: options.onCoordinationError ?? (error => errors.push(error))
  })
  return {
    composition,
    playback,
    events,
    errors,
    get created() { return created },
    get receivedPersistence() { return receivedPersistence }
  }
}

function confirmed(operationId: string, snapshot = createInitialStandalonePlayerSnapshot()): StandalonePlayerCommandResult {
  return { outcome: 'confirmed', operationId, snapshot }
}

function executionConfirmed(operationId: string): StandaloneCommandExecutionResult {
  return { outcome: 'confirmed', operationId }
}

function preparedCommand(
  execute: (signal: AbortSignal) => Promise<StandaloneCommandExecutionResult>,
  commit: (result: StandaloneCommandExecutionResult, context: StandaloneCommandContext) => StandalonePlayerCommandResult = commitExecution
): StandalonePreparedCommand {
  return { execute, commit }
}

function commitExecution(
  execution: StandaloneCommandExecutionResult,
  context: StandaloneCommandContext
): StandalonePlayerCommandResult {
  const snapshot = context.getSnapshot()
  switch (execution.outcome) {
    case 'confirmed':
      return snapshot.playbackCondition === 'ready'
        ? confirmed(execution.operationId, snapshot)
        : uncertainFromSnapshot(execution.operationId, snapshot, 'INVALID_STATE')
    case 'rejected':
      return { outcome: 'rejected', operationId: execution.operationId, error: execution.error, snapshot }
    case 'blocked': {
      const lastConfirmedState = snapshot.playbackCondition === 'ready' ? snapshot.state : snapshot.lastConfirmedState
      const pending = snapshot.playbackCondition === 'ready' ? snapshot.state.pending : snapshot.pending
      return { outcome: 'blocked', operationId: execution.operationId,
        snapshot: { playbackCondition: 'blocked', lastConfirmedState, pending: [...pending], error: execution.error } }
    }
    case 'uncertain': return uncertainFromSnapshot(execution.operationId, snapshot, execution.error.code)
  }
}

function uncertainFromSnapshot(
  operationId: string,
  snapshot: StandalonePlayerSnapshot,
  code: StandalonePlayerErrorCode
): StandalonePlayerCommandResult {
  const lastConfirmedState = snapshot.playbackCondition === 'ready' ? snapshot.state : snapshot.lastConfirmedState
  const pending = snapshot.playbackCondition === 'ready' ? snapshot.state.pending : snapshot.pending
  const uncertain: StandaloneUncertainSnapshot = {
    playbackCondition: 'uncertain', lastConfirmedState, pending: [...pending], error: { code }
  }
  return { outcome: 'uncertain', operationId, snapshot: uncertain }
}

function currentEntry(entryId: string, musicCode: string, attemptId: string): StandaloneCurrentEntry {
  return { entryId, musicCode, attemptId }
}

function nextTransition(composition: StandalonePlayerComposition): Promise<void> {
  return composition.transitions.run(() => undefined)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('composition injects one playback service, recovery persistence, and optional catalog without Electron', async () => {
  const recovery = fakeRecovery()
  const catalog: StandaloneCatalogPort = { lookupByVideoCode: async () => { throw new Error('catalog is optional in this test') } }
  const built = await buildComposition({ recovery: recovery.recovery, catalog })

  assert.equal(built.created, 1)
  assert.equal(built.receivedPersistence, recovery.recovery)
  assert.equal(recovery.attachedPlayback, built.playback)
  assert.equal(recovery.initializeCount, 1)
  assert.equal(built.composition.catalog, catalog)
  assert.deepEqual(built.composition.getRecoveryState(), { status: 'none' })

  await built.composition.dispose()
  assert.equal(built.playback.disposeCount, 1)
  assert.equal(recovery.disposeCount, 1)
})

test('shared playback recovery coordinator satisfies the Standalone port without a manual service', () => {
  assert.equal(sharedRecoveryCompatibility, true)
})

test('same operationId and payload share one in-flight execution and its confirmed result', async () => {
  const gate = deferred<StandaloneCommandExecutionResult>()
  const executed = deferred<void>()
  let preparationCount = 0
  let effectCount = 0
  const built = await buildComposition({
    prepareCommand: request => {
      preparationCount++
      return preparedCommand(async () => { effectCount++; executed.resolve(); return gate.promise })
    }
  })
  const request: StandalonePlayerCommandRequest = { operationId: 'intent-1', command: { type: 'next' } }
  const first = built.composition.control.execute(request)
  const retry = built.composition.control.execute(request)
  assert.equal(first, retry)
  await executed.promise
  assert.equal(preparationCount, 1)
  assert.equal(effectCount, 1)

  gate.resolve(executionConfirmed('intent-1'))
  assert.deepEqual(await first, confirmed('intent-1'))
  assert.deepEqual(await built.composition.control.execute(request), confirmed('intent-1'))
  assert.equal(effectCount, 1)
  await built.composition.dispose()
})

test('Stop All request parsing is exact and duplicate deliveries share one Main effect', async () => {
  const gate = deferred<StandaloneCommandExecutionResult>()
  const started = deferred<void>()
  let preparationCount = 0
  let effectCount = 0
  const built = await buildComposition({
    prepareCommand: request => {
      preparationCount++
      return preparedCommand(async () => { effectCount++; started.resolve(); return gate.promise })
    }
  })
  const request: StandalonePlayerCommandRequest = { operationId: 'stop-all-runtime', command: { type: 'stop-all' } }
  const first = built.composition.control.execute(request)
  const retry = built.composition.control.execute(request)
  assert.equal(first, retry)
  await started.promise
  const conflict = await built.composition.control.execute({ operationId: request.operationId, command: { type: 'toggle-pause' } })
  assert.equal(conflict.outcome, 'rejected')
  if (conflict.outcome === 'rejected') assert.equal(conflict.error.code, 'OPERATION_ID_CONFLICT')
  assert.equal(preparationCount, 1)
  assert.equal(effectCount, 1)
  gate.resolve(executionConfirmed(request.operationId))
  assert.deepEqual(await first, confirmed(request.operationId))
  assert.deepEqual(await built.composition.control.execute(request), confirmed(request.operationId))
  assert.equal(effectCount, 1)
  await built.composition.dispose()
})

test('distinct command intentions are prepared and started in order without waiting for prior playback confirmation', async () => {
  const firstStarted = deferred<void>()
  const secondStarted = deferred<void>()
  const releaseFirst = deferred<void>()
  const releaseSecond = deferred<void>()
  const prepared: string[] = []
  const effects: string[] = []
  const built = await buildComposition({
    prepareCommand: request => {
      prepared.push(request.operationId)
      return preparedCommand(async () => {
        effects.push(`start:${request.operationId}`)
        if (request.operationId === 'first') {
          firstStarted.resolve()
          await releaseFirst.promise
        } else {
          secondStarted.resolve()
          await releaseSecond.promise
        }
        effects.push(`end:${request.operationId}`)
        return executionConfirmed(request.operationId)
      })
    }
  })
  const first = built.composition.control.execute({ operationId: 'first', command: { type: 'next' } })
  const second = built.composition.control.execute({ operationId: 'second', command: { type: 'restart' } })
  await Promise.all([firstStarted.promise, secondStarted.promise])
  assert.deepEqual(prepared, ['first', 'second'])
  assert.deepEqual(effects, ['start:first', 'start:second'])

  releaseSecond.resolve()
  assert.equal((await second).outcome, 'confirmed')
  releaseFirst.resolve()
  assert.equal((await first).outcome, 'confirmed')
  assert.deepEqual(effects, ['start:first', 'start:second', 'end:second', 'end:first'])
  await built.composition.dispose()
})

test('reusing an operationId with another payload conflicts; a new ID remains a distinct intention', async () => {
  let preparationCount = 0
  const built = await buildComposition({
    prepareCommand: request => { preparationCount++; return confirmed(request.operationId) }
  })
  const original = { operationId: 'same-id', command: { type: 'next' } } as const
  const result = await built.composition.control.execute(original)
  const conflict = await built.composition.control.execute({
    operationId: 'same-id', command: { type: 'restart' }
  })
  assert.equal(result.outcome, 'confirmed')
  assert.equal(conflict.outcome, 'rejected')
  if (conflict.outcome === 'rejected') assert.equal(conflict.error.code, 'OPERATION_ID_CONFLICT')
  await built.composition.control.execute({ operationId: 'new-id', command: { type: 'next' } })
  assert.equal(preparationCount, 2)
  await built.composition.dispose()
})

test('retrying an uncertain operation returns its cached uncertainty without replaying effects', async () => {
  let effectCount = 0
  const built = await buildComposition({
    prepareCommand: () => preparedCommand(async () => { effectCount++; throw new Error('response lost') })
  })
  const request = { operationId: 'uncertain-1', command: { type: 'toggle-pause' } } as const
  const first = await built.composition.control.execute(request)
  const retry = await built.composition.control.execute(request)
  assert.equal(first.outcome, 'uncertain')
  assert.deepEqual(retry, first)
  assert.equal(effectCount, 1)
  await built.composition.dispose()
})

test('recovery blocks new operational commands before preparation or playback', async () => {
  let preparationCount = 0
  const recovery = fakeRecovery({
    assertError: new PlayerPlaybackError('RECOVERY_PENDING', 'recovery decision required')
  })
  const built = await buildComposition({
    recovery: recovery.recovery,
    prepareCommand: request => { preparationCount++; return confirmed(request.operationId) }
  })
  const result = await built.composition.control.execute({ operationId: 'blocked-by-recovery', command: { type: 'next' } })
  assert.equal(result.outcome, 'rejected')
  if (result.outcome === 'rejected') assert.equal(result.error.code, 'RECOVERY_PENDING')
  assert.equal(preparationCount, 0)
  assert.equal(built.playback.state.status, 'idle')
  await built.composition.dispose()
})

test('composition disposes recovery when initialization fails before playback construction', async () => {
  const recovery = fakeRecovery({ initializeError: new Error('recovery store unavailable') })
  let playbackFactoryCalls = 0
  await assert.rejects(createStandalonePlayerComposition({
    createPlayback: () => { playbackFactoryCalls++; return new FakePlayback() },
    recovery: recovery.recovery,
    getSnapshot: createInitialStandalonePlayerSnapshot,
    getPlaybackCorrelation: () => ({ current: null, reservation: null }),
    prepareCommand: request => confirmed(request.operationId),
    onPlaybackEvent: () => undefined,
    onCoordinationError: () => undefined
  }), /recovery store unavailable/)
  assert.equal(playbackFactoryCalls, 0)
  assert.equal(recovery.disposeCount, 1)
})

test('known typed failure stays rejected while an uncaught post-preparation failure is uncertain', async () => {
  const known = await buildComposition({ prepareCommand: request => ({
    outcome: 'rejected', operationId: request.operationId, error: { code: 'MEDIA_UNAVAILABLE' },
    snapshot: createInitialStandalonePlayerSnapshot()
  }) })
  const knownResult = await known.composition.control.execute({ operationId: 'known-failure', command: { type: 'next' } })
  assert.equal(knownResult.outcome, 'rejected')
  if (knownResult.outcome === 'rejected') assert.equal(knownResult.error.code, 'MEDIA_UNAVAILABLE')
  await known.composition.dispose()

  const uncertain = await buildComposition({ prepareCommand: () => preparedCommand(async () => { throw new Error('unknown engine outcome') }) })
  const uncertainResult = await uncertain.composition.control.execute({ operationId: 'unknown-failure', command: { type: 'next' } })
  assert.equal(uncertainResult.outcome, 'uncertain')
  await uncertain.composition.dispose()
})

test('a prepared blocked result preserves the pending head without claiming success', async () => {
  const current = currentEntry('current-entry', '01001', 'attempt-current')
  const head = { entryId: 'pending-head', musicCode: '01002' }
  const blockedSnapshot: StandaloneBlockedSnapshot = {
    playbackCondition: 'blocked',
    lastConfirmedState: { operationalState: 'playing', current, pending: [head] },
    pending: [head],
    error: { code: 'MEDIA_LOAD_FAILED' }
  }
  const built = await buildComposition({
    prepareCommand: request => ({ outcome: 'blocked', operationId: request.operationId, snapshot: blockedSnapshot })
  })
  const result = await built.composition.control.execute({ operationId: 'blocked-next', command: { type: 'next' } })
  assert.equal(result.outcome, 'blocked')
  if (result.outcome === 'blocked') assert.deepEqual(result.snapshot.pending, [head])
  await built.composition.dispose()
})

test('numeric submissions are normalized before preparation and invalid codes have no effect', async () => {
  const codes: Array<string | undefined> = []
  let preparationCount = 0
  const built = await buildComposition({
    prepareCommand: (request, context) => {
      preparationCount++
      codes.push(context.canonicalCode)
      return confirmed(request.operationId)
    }
  })
  const valid = await built.composition.control.execute({
    operationId: 'valid-code', command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
  })
  const invalid = await built.composition.control.execute({
    operationId: 'invalid-code', command: { type: 'submit-code', enteredCode: '0', priority: 'normal' }
  })
  assert.equal(valid.outcome, 'confirmed')
  assert.deepEqual(codes, ['01001'])
  assert.equal(invalid.outcome, 'rejected')
  if (invalid.outcome === 'rejected') assert.equal(invalid.error.code, 'INVALID_MUSIC_CODE')
  assert.equal(preparationCount, 1)
  await built.composition.dispose()
})

test('duplicate and stale natural EOF events are filtered, while a new attempt can complete', async () => {
  let correlation: StandalonePlaybackCorrelation = { current: currentEntry('entry-a', '01001', 'attempt-a'), reservation: null }
  const built = await buildComposition({ getPlaybackCorrelation: () => correlation })
  built.playback.state = { status: 'completed', attemptId: 'attempt-a', musicCode: '01001' }
  const eofA: PlayerPlaybackEvent = {
    type: 'natural-end-candidate', attemptId: 'attempt-a', musicCode: '01001', duration: 100, endedAt: 'now'
  }
  built.playback.emit(eofA)
  built.playback.emit(eofA)
  await nextTransition(built.composition)
  assert.equal(built.events.filter(item => item.event.type === 'natural-end-candidate').length, 1)

  correlation = { current: currentEntry('entry-b', '01001', 'attempt-b'), reservation: null }
  built.playback.state = { status: 'playing', attemptId: 'attempt-b', musicCode: '01001' }
  built.playback.emit({ type: 'state-changed', state: built.playback.getState() })
  await nextTransition(built.composition)
  built.playback.emit(eofA)
  await nextTransition(built.composition)
  built.playback.state = { status: 'completed', attemptId: 'attempt-b', musicCode: '01001' }
  const eofB: PlayerPlaybackEvent = {
    type: 'natural-end-candidate', attemptId: 'attempt-b', musicCode: '01001', duration: 80, endedAt: 'later'
  }
  built.playback.emit(eofB)
  built.playback.emit(eofB)
  await nextTransition(built.composition)
  assert.equal(built.events.filter(item => item.event.type === 'natural-end-candidate').length, 2)
  assert.equal(built.errors.length, 0)
  await built.composition.dispose()
})

test('EOF is processed while Next awaits playback and its eventual commit re-enters the arbiter', async () => {
  let eofProcessed = false
  const order: string[] = []
  const started = deferred<void>()
  const confirmPlayback = deferred<StandaloneCommandExecutionResult>()
  const correlation: StandalonePlaybackCorrelation = {
    current: currentEntry('current', '01001', 'attempt-current'), reservation: null
  }
  const built = await buildComposition({
    getPlaybackCorrelation: () => correlation,
    onPlaybackEvent: event => {
      if (event.type === 'natural-end-candidate') {
        eofProcessed = true
        order.push('eof')
      }
      return undefined
    },
    prepareCommand: request => preparedCommand(
      async () => { started.resolve(); return confirmPlayback.promise },
      (execution, context) => {
        assert.equal(eofProcessed, true)
        order.push('commit')
        return commitExecution(execution, context)
      }
    )
  })
  const next = built.composition.control.execute({ operationId: 'next-vs-eof', command: { type: 'next' } })
  await started.promise
  built.playback.state = { status: 'completed', attemptId: 'attempt-current', musicCode: '01001' }
  built.playback.emit({
    type: 'natural-end-candidate', attemptId: 'attempt-current', musicCode: '01001', duration: 50, endedAt: 'now'
  })
  await nextTransition(built.composition)
  assert.deepEqual(order, ['eof'])
  confirmPlayback.resolve(executionConfirmed('next-vs-eof'))
  assert.equal((await next).outcome, 'confirmed')
  assert.deepEqual(order, ['eof', 'commit'])
  await built.composition.dispose()
})

test('a throwing EOF handler is reported and its duplicate remains at-most-once', async () => {
  const correlation: StandalonePlaybackCorrelation = {
    current: currentEntry('entry-a', '01001', 'attempt-a'), reservation: null
  }
  const handlerError = new Error('state commit failed')
  let handlerCalls = 0
  const reported: unknown[] = []
  const built = await buildComposition({
    getPlaybackCorrelation: () => correlation,
    onPlaybackEvent: () => { handlerCalls++; throw handlerError },
    onCoordinationError: error => reported.push(error)
  })
  built.playback.state = { status: 'completed', attemptId: 'attempt-a', musicCode: '01001' }
  const eof: PlayerPlaybackEvent = {
    type: 'natural-end-candidate', attemptId: 'attempt-a', musicCode: '01001', duration: 100, endedAt: 'now'
  }
  built.playback.emit(eof)
  built.playback.emit(eof)
  await nextTransition(built.composition)
  assert.equal(handlerCalls, 1)
  assert.deepEqual(reported, [handlerError])
  await built.composition.dispose()
})

test('a JavaScript async event handler is rejected and its Promise rejection is observed', async () => {
  const correlation: StandalonePlaybackCorrelation = {
    current: currentEntry('entry-a', '01001', 'attempt-a'), reservation: null
  }
  const errors: unknown[] = []
  const asyncHandler = async () => { throw new Error('late async handler failure') }
  const built = await buildComposition({
    getPlaybackCorrelation: () => correlation,
    onPlaybackEvent: asyncHandler as unknown as StandalonePlaybackEventHandler,
    onCoordinationError: error => errors.push(error)
  })
  built.playback.state = { status: 'playing', attemptId: 'attempt-a', musicCode: '01001' }
  built.playback.emit({ type: 'state-changed', state: built.playback.getState() })
  await nextTransition(built.composition)
  assert.ok(errors[0] instanceof StandaloneRuntimeError)
  assert.equal((errors[0] as StandaloneRuntimeError).code, 'INVALID_STATE')
  assert.ok(errors.some(error => error instanceof Error && error.message === 'late async handler failure'))
  await built.composition.dispose()
})

test('reserved attempt binds from current engine state for early EOF; Stop is never reclassified as EOF', async () => {
  let correlation: StandalonePlaybackCorrelation = {
    current: currentEntry('current', '01001', 'attempt-current'),
    reservation: { entryId: 'reserved', musicCode: '01002' }
  }
  const built = await buildComposition({ getPlaybackCorrelation: () => correlation })
  built.playback.state = { status: 'playing', attemptId: 'attempt-reserved', musicCode: '01002' }
  built.playback.emit({ type: 'state-changed', state: built.playback.getState() })
  await nextTransition(built.composition)
  built.playback.state = { status: 'completed', attemptId: 'attempt-reserved', musicCode: '01002' }
  built.playback.emit({
    type: 'natural-end-candidate', attemptId: 'attempt-reserved', musicCode: '01002', duration: 30, endedAt: 'now'
  })
  await nextTransition(built.composition)
  assert.equal(built.events.at(-1)?.current.entryId, 'reserved')

  correlation = { current: currentEntry('stopped-entry', '01003', 'attempt-stopped'), reservation: null }
  built.playback.state = { status: 'stopped', attemptId: 'attempt-stopped', musicCode: '01003' }
  built.playback.emit({ type: 'interrupted', attemptId: 'attempt-stopped', musicCode: '01003', reason: 'stop' })
  built.playback.emit({
    type: 'natural-end-candidate', attemptId: 'attempt-stopped', musicCode: '01003', duration: 30, endedAt: 'late'
  })
  await nextTransition(built.composition)
  assert.equal(built.events.filter(item => item.event.type === 'interrupted').length, 1)
  assert.equal(built.events.filter(item => item.event.type === 'natural-end-candidate').length, 1)
  await built.composition.dispose()
})

test('dispose is idempotent, aborts in-flight effects, unsubscribes, and disposes owned resources', async () => {
  const started = deferred<AbortSignal>()
  const built = await buildComposition({
    prepareCommand: request => ({
      ...preparedCommand(signal => new Promise(resolve => {
        started.resolve(signal)
        signal.addEventListener('abort', () => resolve({ outcome: 'uncertain', operationId: request.operationId, error: { code: 'DISPOSED' } }), { once: true })
      }))
    })
  })
  assert.equal(built.playback.listenerCount, 1)
  const operation = built.composition.control.execute({ operationId: 'pending-at-dispose', command: { type: 'next' } })
  const signal = await started.promise
  const dispose = built.composition.dispose()
  assert.equal(built.composition.dispose(), dispose)
  assert.equal(signal.aborted, true)
  const duringDispose = await built.composition.control.execute({ operationId: 'during-dispose', command: { type: 'next' } })
  assert.equal(duringDispose.outcome, 'rejected')
  if (duringDispose.outcome === 'rejected') assert.equal(duringDispose.error.code, 'DISPOSED')
  assert.equal((await operation).outcome, 'uncertain')
  await dispose
  assert.equal(built.playback.listenerCount, 0)
  assert.equal(built.playback.disposeCount, 1)
  assert.equal(built.composition.control.getSnapshot().playbackCondition, 'ready')
  const afterClose = await built.composition.control.execute({ operationId: 'after-close', command: { type: 'next' } })
  assert.equal(afterClose.outcome, 'rejected')
  if (afterClose.outcome === 'rejected') assert.equal(afterClose.error.code, 'DISPOSED')
  assert.equal(built.events.length, 0)
})

test('transition arbiter orders synchronous decisions and rejects asynchronous callbacks', async () => {
  const arbiter = new StandaloneTransitionArbiter()
  const order: number[] = []
  const first = arbiter.run(() => { order.push(1) })
  const second = arbiter.run(() => { order.push(2) })
  await Promise.all([first, second])
  assert.deepEqual(order, [1, 2])
  await assert.rejects(arbiter.run(async () => undefined), { code: 'INVALID_STATE' })
  await arbiter.close()
  await assert.rejects(arbiter.run(() => undefined), { code: 'DISPOSED' })
})
