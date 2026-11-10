import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PlayerPlaybackError,
  type PlayerPlaybackEvent,
  type PlayerPlaybackListener,
  type PlayerPlaybackState
} from '../src/player-playback-contracts'
import type {
  StandalonePlaybackPort,
  StandalonePlayerCommandRequest,
  StandalonePlayerCommandResult,
  StandaloneCelebrationMessage,
  StandalonePlayerSnapshot,
  StandaloneRecoveryPort
} from '../src/standalone-player-contracts'
import type { PlayerRecoverySnapshot } from '../src/player-playback-recovery-contracts'
import { STANDALONE_CELEBRATION_MESSAGES } from '../src/standalone-player-contracts'
import { StandalonePlayerSequence, STANDALONE_CELEBRATION_MS, STANDALONE_INITIAL_COUNTDOWN_MS, type StandaloneCountdownScheduler } from '../src/standalone-player-sequence'

class FakePlayback implements StandalonePlaybackPort {
  state: PlayerPlaybackState = { status: 'idle' }
  readonly starts: string[] = []
  readonly stops: Array<string | undefined> = []
  readonly clearedCompleted: string[] = []
  readonly clearedStopped: string[] = []
  validateCalls: string[] = []
  validationErrors = new Map<string, Error>()
  startErrors: Error[] = []
  stopErrors: Error[] = []
  validateGates = new Map<string, Deferred<void>>()
  validationStarted = new Map<string, Deferred<void>>()
  startGates = new Map<string, Deferred<void>>()
  startStarted = new Map<string, Deferred<void>>()
  stopGate: Deferred<void> | undefined
  stopStarted: Deferred<string | undefined> | undefined
  clearCompletedGate: Deferred<void> | undefined
  clearCompletedStarted: Deferred<void> | undefined
  pauseStarted: Deferred<void> | undefined
  pauseObservationGate: Deferred<void> | undefined
  pauseCalls = 0
  resumeCalls = 0
  resumeStarted: Deferred<void> | undefined
  resumeObservationGate: Deferred<void> | undefined
  nextSubscriptionAdded: Deferred<void> | undefined
  clearCompletedResult = true
  clearStoppedResult = true
  disposeCount = 0
  private attemptNumber = 0
  private commandGeneration = 0
  private readonly listeners = new Set<PlayerPlaybackListener>()

  getState(): PlayerPlaybackState { return { ...this.state } }
  get listenerCount(): number { return this.listeners.size }

  async validateMusicCode(code: string): Promise<void> {
    this.validateCalls.push(code)
    this.validationStarted.get(code)?.resolve()
    await this.validateGates.get(code)?.promise
    const error = this.validationErrors.get(code)
    if (error) throw error
  }

  async playImmediately(code: string): Promise<PlayerPlaybackState> {
    const generation = ++this.commandGeneration
    this.starts.push(code)
    this.startStarted.get(code)?.resolve()
    await this.startGates.get(code)?.promise
    if (generation !== this.commandGeneration) throw new PlayerPlaybackError('SUPERSEDED', 'A newer playback command superseded this start.')
    const error = this.startErrors.shift()
    if (error) throw error
    const state = { status: 'playing' as const, attemptId: `attempt-${++this.attemptNumber}`, musicCode: code }
    this.state = state
    this.emit({ type: 'state-changed', state })
    return this.getState()
  }

  async pause(): Promise<PlayerPlaybackState> {
    this.pauseCalls++
    if (this.pauseObservationGate) {
      const acknowledgedState = this.getState()
      this.pauseStarted?.resolve()
      const gate = this.pauseObservationGate
      this.pauseObservationGate = undefined
      void gate.promise.then(() => {
        this.state = { ...this.state, status: 'paused' }
        this.emit({ type: 'state-changed', state: this.getState() })
      })
      return acknowledgedState
    }
    this.state = { ...this.state, status: 'paused' }
    this.emit({ type: 'state-changed', state: this.getState() })
    return this.getState()
  }

  async resume(): Promise<PlayerPlaybackState> {
    this.resumeCalls++
    if (this.resumeObservationGate) {
      const acknowledgedState = { ...this.state, status: 'starting' as const }
      this.state = acknowledgedState
      this.resumeStarted?.resolve()
      const gate = this.resumeObservationGate
      this.resumeObservationGate = undefined
      void gate.promise.then(() => {
        this.state = { ...this.state, status: 'playing' }
        this.emit({ type: 'state-changed', state: this.getState() })
      })
      return acknowledgedState
    }
    this.state = { ...this.state, status: 'playing' }
    this.emit({ type: 'state-changed', state: this.getState() })
    return this.getState()
  }

  async restart(): Promise<PlayerPlaybackState> {
    this.commandGeneration++
    const musicCode = this.state.musicCode
    if (!musicCode) throw new PlayerPlaybackError('INVALID_STATE', 'No current media')
    const oldAttempt = this.state.attemptId
    if (oldAttempt) this.emit({ type: 'interrupted', attemptId: oldAttempt, musicCode, reason: 'restart' })
    const state = { status: 'playing' as const, attemptId: `attempt-${++this.attemptNumber}`, musicCode }
    this.state = state
    this.emit({ type: 'state-changed', state })
    return this.getState()
  }

  async stop(expectedAttemptId?: string): Promise<PlayerPlaybackState> {
    this.commandGeneration++
    this.stops.push(expectedAttemptId)
    this.stopStarted?.resolve(expectedAttemptId)
    await this.stopGate?.promise
    const stopError = this.stopErrors.shift()
    if (stopError) throw stopError
    if (expectedAttemptId && this.state.attemptId !== expectedAttemptId) {
      throw new PlayerPlaybackError('SUPERSEDED', 'Playback changed')
    }
    if (this.state.status === 'completed') {
      if (expectedAttemptId) throw new PlayerPlaybackError('SUPERSEDED', 'Natural completion won before Stop')
      return this.getState()
    }
    const attemptId = expectedAttemptId ?? this.state.attemptId
    const musicCode = this.state.musicCode
    if (attemptId && musicCode) this.emit({ type: 'interrupted', attemptId, musicCode, reason: 'stop' })
    this.state = { status: 'stopped', ...(attemptId ? { attemptId } : {}), ...(musicCode ? { musicCode } : {}) }
    this.emit({ type: 'state-changed', state: this.getState() })
    return this.getState()
  }

  async clearCompletedMedia(attemptId: string): Promise<boolean> {
    this.clearedCompleted.push(attemptId)
    this.clearCompletedStarted?.resolve()
    await this.clearCompletedGate?.promise
    if (!this.clearCompletedResult || this.state.status !== 'completed' || this.state.attemptId !== attemptId) return false
    this.state = { status: 'idle' }
    this.emit({ type: 'state-changed', state: this.getState() })
    return true
  }

  async clearStoppedMedia(attemptId: string): Promise<boolean> {
    this.clearedStopped.push(attemptId)
    if (!this.clearStoppedResult || this.state.status !== 'stopped' || this.state.attemptId !== attemptId) return false
    this.state = { status: 'idle' }
    this.emit({ type: 'state-changed', state: this.getState() })
    return true
  }

  async resolveRecoveryAsStopped(attemptId: string, musicCode: string): Promise<PlayerPlaybackState> {
    this.state = { status: 'stopped', attemptId, musicCode }
    return this.getState()
  }

  subscribe(listener: PlayerPlaybackListener): () => void {
    this.listeners.add(listener)
    this.nextSubscriptionAdded?.resolve()
    this.nextSubscriptionAdded = undefined
    return () => this.listeners.delete(listener)
  }

  emit(event: PlayerPlaybackEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  endCurrent(): { attemptId: string; musicCode: string } {
    const { attemptId, musicCode } = this.state
    assert.ok(attemptId && musicCode)
    this.state = { status: 'completed', attemptId, musicCode }
    this.emit({ type: 'natural-end-candidate', attemptId, musicCode, duration: 1, endedAt: new Date(0).toISOString() })
    return { attemptId, musicCode }
  }

  async dispose(): Promise<void> {
    this.disposeCount++
    for (const gate of this.startGates.values()) gate.resolve()
  }
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

let entrySequence = 0
interface ScheduledCountdown { readonly due: number; readonly callback: () => void; cancelled: boolean }
class FakeCountdownScheduler implements StandaloneCountdownScheduler {
  nowMs = 0
  readonly timers: ScheduledCountdown[] = []
  get activeTimerCount(): number { return this.timers.filter(timer => !timer.cancelled).length }
  now(): number { return this.nowMs }
  schedule(callback: () => void, delayMs: number): ScheduledCountdown {
    const timer = { due: this.nowMs + delayMs, callback, cancelled: false }
    this.timers.push(timer)
    return timer
  }
  cancel(handle: unknown): void { (handle as ScheduledCountdown).cancelled = true }
  async elapseWithoutRunning(ms: number): Promise<void> { this.nowMs += ms }
  async advance(ms: number): Promise<void> {
    const end = this.nowMs + ms
    while (true) {
      const next = this.timers.filter(timer => !timer.cancelled && timer.due <= end)
        .sort((a, b) => a.due - b.due)[0]
      if (!next) break
      next.cancelled = true
      this.nowMs = next.due
      next.callback()
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    this.nowMs = end
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

const schedulerBySequence = new WeakMap<StandalonePlayerSequence, FakeCountdownScheduler>()
async function build(options: { playback?: FakePlayback; scheduler?: FakeCountdownScheduler;
  selectCelebrationMessage?: () => StandaloneCelebrationMessage } = {}) {
  const playback = options.playback ?? new FakePlayback()
  const errors: unknown[] = []
  const scheduler = options.scheduler ?? new FakeCountdownScheduler()
  const sequence = await StandalonePlayerSequence.create({
    createPlayback: () => playback,
    createEntryId: () => `entry-${++entrySequence}`,
    countdownScheduler: scheduler,
    ...(options.selectCelebrationMessage ? { selectCelebrationMessage: options.selectCelebrationMessage } : {}),
    onCoordinationError: error => errors.push(error)
  })
  schedulerBySequence.set(sequence, scheduler)
  return { playback, sequence, errors, scheduler }
}

function submitRaw(sequence: StandalonePlayerSequence, operationId: string, enteredCode: string,
  priority: 'normal' | 'priority' = 'normal'): Promise<StandalonePlayerCommandResult> {
  return sequence.execute({ operationId, command: { type: 'submit-code', enteredCode, priority } })
}

async function advanceInitialCountdown(sequence: StandalonePlayerSequence, scheduler = schedulerBySequence.get(sequence)!): Promise<void> {
  await scheduler.advance(5000)
  await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition !== 'transitioning')
}

async function beginCelebration(sequence: StandalonePlayerSequence, playback: FakePlayback): Promise<Extract<StandalonePlayerSnapshot, { playbackCondition: 'transitioning' }> & { phase: 'celebration' }> {
  const celebration = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'celebration')
  playback.endCurrent()
  return await celebration as Extract<StandalonePlayerSnapshot, { playbackCondition: 'transitioning' }> & { phase: 'celebration' }
}

async function advanceCelebrationTimer(sequence: StandalonePlayerSequence,
  scheduler = schedulerBySequence.get(sequence)!): Promise<void> {
  await scheduler.advance(STANDALONE_CELEBRATION_MS)
}

async function submit(sequence: StandalonePlayerSequence, operationId: string, enteredCode: string,
  priority: 'normal' | 'priority' = 'normal'): Promise<StandalonePlayerCommandResult> {
  const result = await submitRaw(sequence, operationId, enteredCode, priority)
  if (result.outcome === 'confirmed' && result.snapshot.playbackCondition === 'transitioning' &&
      result.snapshot.phase === 'countdown') await advanceInitialCountdown(sequence)
  return result
}

async function addCurrent(sequence: StandalonePlayerSequence, code = '1001'): Promise<StandalonePlayerCommandResult> {
  return submit(sequence, `add-${code}-${entrySequence}`, code)
}

async function seedPlayback(sequence: StandalonePlayerSequence): Promise<void> {
  await sequence.executeHarnessSampleStart()
  await advanceInitialCountdown(sequence)
}

function ready(snapshot: StandalonePlayerSnapshot) {
  if (snapshot.playbackCondition !== 'ready') throw new Error(`Expected ready, got ${snapshot.playbackCondition}`)
  return snapshot.state
}

function waitForSnapshot(sequence: StandalonePlayerSequence,
  predicate: (snapshot: StandalonePlayerSnapshot) => boolean): Promise<StandalonePlayerSnapshot> {
  return new Promise(resolve => {
    let unsubscribe: () => void = () => undefined
    const check = (snapshot: StandalonePlayerSnapshot) => {
      if (!predicate(snapshot)) return
      unsubscribe()
      resolve(snapshot)
    }
    unsubscribe = sequence.subscribe(check)
    check(sequence.getSnapshot())
  })
}

test('initial state is idle and has no current or pending entries', async () => {
  const { sequence } = await build()
  assert.deepEqual(sequence.getSnapshot(), {
    playbackCondition: 'ready', state: { operationalState: 'idle', current: null, pending: [] }
  })
  await sequence.dispose()
})

test('first valid idle admission runs a real five-second Main countdown before starting playback', async () => {
  const { sequence, playback, scheduler } = await build()
  const result = await submitRaw(sequence, 'first', '1001')
  assert.equal(result.outcome, 'confirmed')
  assert.deepEqual(playback.validateCalls, ['01001'])
  assert.deepEqual(playback.starts, [], 'media is not opened during countdown.')
  assert.equal(result.snapshot.playbackCondition, 'transitioning')
  if (result.snapshot.playbackCondition === 'transitioning') {
    assert.equal(result.snapshot.phase, 'countdown')
    if (result.snapshot.phase === 'countdown') {
      assert.equal(result.snapshot.remainingMs, 5000)
      assert.equal(result.snapshot.target.musicCode, '01001')
      assert.equal(result.snapshot.paused, false)
    }
  }
  await scheduler.advance(4999)
  assert.deepEqual(playback.starts, [], 'no early MP4 start is allowed.')
  const during = sequence.getSnapshot()
  assert.equal(during.playbackCondition, 'transitioning')
  if (during.playbackCondition === 'transitioning' && during.phase === 'countdown') assert.equal(during.remainingMs, 1)
  await scheduler.advance(1)
  await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition !== 'transitioning')
  assert.deepEqual(playback.starts, ['01001'])
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01001')
  await sequence.dispose()
})

test('retrying the initial Enter with the same operationId keeps one reservation, timer, and playback start', async () => {
  const { sequence, playback, scheduler } = await build()
  const request: StandalonePlayerCommandRequest = {
    operationId: 'initial-start-retry',
    command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
  }

  const [first, retry] = await Promise.all([sequence.execute(request), sequence.execute(request)])

  assert.equal(first.outcome, 'confirmed')
  assert.equal(retry.outcome, 'confirmed')
  assert.deepEqual(playback.validateCalls, ['01001'])
  assert.deepEqual(playback.starts, [])
  assert.equal(scheduler.activeTimerCount, 1)
  const snapshot = sequence.getSnapshot()
  assert.equal(snapshot.playbackCondition, 'transitioning')
  if (snapshot.playbackCondition === 'transitioning') {
    assert.deepEqual(snapshot.pending.map(entry => entry.musicCode), ['01001'])
  }

  await scheduler.advance(STANDALONE_INITIAL_COUNTDOWN_MS)
  await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.operationalState === 'playing')
  assert.deepEqual(playback.starts, ['01001'])
  await sequence.dispose()
})

test('countdown pause freezes Main time and resume continues the remaining duration without playback calls', async () => {
  const { sequence, playback, scheduler } = await build()
  await submitRaw(sequence, 'countdown-pause-target', '1001')
  await scheduler.advance(2300)
  const pause = await sequence.execute({ operationId: 'countdown-pause', command: { type: 'toggle-pause' } })
  assert.equal(pause.outcome, 'confirmed')
  assert.equal(pause.snapshot.playbackCondition, 'transitioning')
  if (pause.snapshot.playbackCondition === 'transitioning') {
    assert.equal(pause.snapshot.phase, 'countdown')
    if (pause.snapshot.phase === 'countdown') {
      assert.equal(pause.snapshot.paused, true)
      assert.equal(pause.snapshot.remainingMs, 2700)
    }
  }
  assert.deepEqual(playback.starts, [])
  assert.equal(playback.pauseCalls, 0, 'countdown pause must not call playback Pause.')
  assert.equal(playback.resumeCalls, 0, 'countdown resume must not call playback Resume.')
  await scheduler.advance(10000)
  const frozen = sequence.getSnapshot()
  assert.equal(frozen.playbackCondition, 'transitioning')
  if (frozen.playbackCondition === 'transitioning' && frozen.phase === 'countdown') assert.equal(frozen.remainingMs, 2700)
  assert.deepEqual(playback.starts, [])
  const resume = await sequence.execute({ operationId: 'countdown-resume', command: { type: 'toggle-pause' } })
  assert.equal(resume.outcome, 'confirmed')
  if (resume.snapshot.playbackCondition === 'transitioning' && resume.snapshot.phase === 'countdown') {
    assert.equal(resume.snapshot.paused, false)
    assert.equal(resume.snapshot.remainingMs, 2700)
  } else assert.fail('Expected resumed countdown snapshot')
  await scheduler.advance(2699)
  assert.deepEqual(playback.starts, [])
  await scheduler.advance(1)
  await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition !== 'transitioning')
  assert.deepEqual(playback.starts, ['01001'])
  assert.equal(playback.pauseCalls, 0)
  assert.equal(playback.resumeCalls, 0)
  await sequence.dispose()
})

test('a cancelled countdown callback cannot expire a paused countdown', async () => {
  const { sequence, scheduler, playback } = await build()
  await submitRaw(sequence, 'countdown-stale-target', '1001')
  const stale = scheduler.timers[0]
  assert.ok(stale)
  await scheduler.advance(1000)
  const pause = await sequence.execute({ operationId: 'countdown-stale-pause', command: { type: 'toggle-pause' } })
  assert.equal(pause.outcome, 'confirmed')
  stale.callback()
  await new Promise<void>(resolve => setImmediate(resolve))
  const snapshot = sequence.getSnapshot()
  assert.equal(snapshot.playbackCondition, 'transitioning')
  if (snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'countdown') {
    assert.equal(snapshot.paused, true)
    assert.equal(snapshot.remainingMs, 4000)
  }
  assert.deepEqual(playback.starts, [])
  await sequence.dispose()
})

test('Space arriving at the deadline and a stale expiry callback start the reserved item exactly once', async () => {
  const { sequence, scheduler, playback } = await build()
  await submitRaw(sequence, 'countdown-deadline-target', '1001')
  const expiry = scheduler.timers[0]
  assert.ok(expiry)
  await scheduler.elapseWithoutRunning(5000)
  const pause = await sequence.execute({ operationId: 'countdown-deadline-space', command: { type: 'toggle-pause' } })
  assert.equal(pause.outcome, 'confirmed')
  assert.equal(pause.snapshot.playbackCondition, 'transitioning')
  if (pause.snapshot.playbackCondition === 'transitioning') assert.equal(pause.snapshot.phase, 'loading')
  expiry.callback()
  await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition !== 'transitioning')
  assert.deepEqual(playback.starts, ['01001'])
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01001')
  await sequence.dispose()
})

test('disposing during countdown cancels the timer and prevents delayed autoplay', async () => {
  const { sequence, scheduler, playback } = await build()
  await submitRaw(sequence, 'countdown-dispose-target', '1001')
  const expiry = scheduler.timers[0]
  assert.ok(expiry)
  await sequence.dispose()
  expiry.callback()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(playback.starts, [])
  assert.equal(playback.disposeCount, 1)
})

test('a second Enter/P during an initial countdown cannot replace or duplicate its reserved target', async () => {
  const { sequence, playback } = await build()
  const initial = await submitRaw(sequence, 'countdown-original', '1001')
  assert.equal(initial.outcome, 'confirmed')
  const result = await submitRaw(sequence, 'countdown-second', '1002', 'priority')
  assert.equal(result.outcome, 'rejected')
  if (result.outcome === 'rejected') assert.equal(result.error.code, 'INVALID_STATE')
  assert.deepEqual(playback.validateCalls, ['01001'])
  assert.deepEqual(playback.starts, [])
  const snapshot = sequence.getSnapshot()
  assert.equal(snapshot.playbackCondition, 'transitioning')
  if (snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'countdown') {
    assert.equal(snapshot.target.musicCode, '01001')
    assert.deepEqual(snapshot.pending.map(entry => entry.musicCode), ['01001'])
  }
  await sequence.dispose()
})

test('idle validation reports physically unavailable media without starting countdown or mutating sequence', async () => {
  const playback = new FakePlayback()
  playback.validationErrors.set('09999', new PlayerPlaybackError('MEDIA_UNAVAILABLE', 'Missing sample'))
  const { sequence } = await build({ playback })
  const result = await submit(sequence, 'c2-idle-missing', '9999')
  assert.equal(result.outcome, 'rejected')
  if (result.outcome === 'rejected') assert.equal(result.error.code, 'MEDIA_UNAVAILABLE')
  assert.deepEqual(playback.starts, [])
  assert.deepEqual(ready(sequence.getSnapshot()), { operationalState: 'idle', current: null, pending: [] })
  await sequence.dispose()
})

test('Next submitted during a technical start transition is rejected instead of falsely confirmed', async () => {
  const { sequence, playback } = await build()
  const gate = deferred<void>()
  playback.startGates.set('01001', gate)
  playback.startStarted.set('01001', deferred<void>())
  const add = submitRaw(sequence, 'start-pending', '1001')
  await add
  const scheduler = schedulerBySequence.get(sequence)!
  await scheduler.advance(5000)
  await playback.startStarted.get('01001')!.promise
  const next = await sequence.execute({ operationId: 'next-during-start', command: { type: 'next' } })
  assert.equal(next.outcome, 'rejected')
  if (next.outcome === 'rejected') assert.equal(next.error.code, 'INVALID_STATE')
  gate.resolve()
  await add
  await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'playing')
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01001')
  assert.deepEqual(playback.stops, [])
  await sequence.dispose()
})

test('normal additions during playback append in FIFO order without interrupting current', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'normal-2', '1002')
  await submit(sequence, 'normal-3', '1003')
  const state = ready(sequence.getSnapshot())
  assert.equal(state.current?.musicCode, '01001')
  assert.deepEqual(state.pending.map(entry => entry.musicCode), ['01002', '01003'])
  assert.deepEqual(playback.starts, ['01001'])
  await sequence.dispose()
})

test('an active submission committed after EOF returns to idle must still wait through the initial countdown', async () => {
  const playback = new FakePlayback()
  const validationGate = deferred<void>()
  playback.validateGates.set('01002', validationGate)
  playback.validationStarted.set('01002', deferred<void>())
  const { sequence } = await build({ playback })
  await seedPlayback(sequence)
  const active = ready(sequence.getSnapshot())
  assert.equal(active.operationalState, 'playing')

  const addition = submit(sequence, 'c2-validation-races-eof', '1002')
  await playback.validationStarted.get('01002')!.promise
  await beginCelebration(sequence, playback)
  const idle = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.operationalState === 'idle')
  await advanceCelebrationTimer(sequence)
  await idle
  validationGate.resolve()

  const result = await addition
  assert.equal(result.outcome, 'confirmed')
  assert.deepEqual(playback.starts, ['01001', '01002'])
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  await sequence.dispose()
})

test('Enter and P during celebration update FIFO/LIFO without restarting the ended media or resetting the timer', async () => {
  const { sequence, playback, scheduler } = await build({ selectCelebrationMessage: () => STANDALONE_CELEBRATION_MESSAGES[0] })
  await addCurrent(sequence)
  const celebration = await beginCelebration(sequence, playback)
  assert.equal(celebration.message, STANDALONE_CELEBRATION_MESSAGES[0])
  assert.deepEqual(playback.starts, ['01001'])

  await submit(sequence, 'celebration-enter', '1002')
  await submit(sequence, 'celebration-priority', '1003', 'priority')
  const during = sequence.getSnapshot()
  assert.equal(during.playbackCondition, 'transitioning')
  if (during.playbackCondition === 'transitioning' && during.phase === 'celebration') {
    assert.deepEqual(during.pending.map(entry => entry.musicCode), ['01003', '01002'])
    assert.equal(during.remainingMs, STANDALONE_CELEBRATION_MS)
  }
  assert.deepEqual(playback.starts, ['01001'], 'admissions do not start a song during the celebration.')
  assert.deepEqual(playback.stops, [], 'the naturally ended video is not stopped or restarted.')
  assert.equal(scheduler.activeTimerCount, 1, 'submissions do not create or reset the authoritative celebration timer.')

  const started = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01003')
  await advanceCelebrationTimer(sequence)
  await started
  assert.deepEqual(playback.starts, ['01001', '01003'])
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01002'])
  await sequence.dispose()
})

test('adding while paused preserves pause and does not resume playback', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await sequence.execute({ operationId: 'pause', command: { type: 'toggle-pause' } })
  await submit(sequence, 'paused-add', '1002')
  const state = ready(sequence.getSnapshot())
  assert.equal(state.operationalState, 'paused')
  assert.deepEqual(state.pending.map(entry => entry.musicCode), ['01002'])
  assert.equal(playback.starts.length, 1)
  await sequence.dispose()
})

test('pause and resume wait for correlated playback state after early host acknowledgements', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const gate = deferred<void>()
  playback.pauseObservationGate = gate
  playback.pauseStarted = deferred<void>()
  const operation = sequence.execute({ operationId: 'pause-await-observation', command: { type: 'toggle-pause' } })
  await playback.pauseStarted.promise
  assert.equal(sequence.getSnapshot().playbackCondition, 'transitioning',
    'an accepted host command is not yet a confirmed pause')
  gate.resolve()
  const result = await operation
  assert.equal(result.outcome, 'confirmed')
  assert.equal(ready(sequence.getSnapshot()).operationalState, 'paused')

  const resumeGate = deferred<void>()
  playback.resumeObservationGate = resumeGate
  playback.resumeStarted = deferred<void>()
  const resumeOperation = sequence.execute({ operationId: 'resume-await-observation', command: { type: 'toggle-pause' } })
  await playback.resumeStarted.promise
  assert.equal(sequence.getSnapshot().playbackCondition, 'transitioning',
    'an accepted host command is not yet a confirmed resume')
  resumeGate.resolve()
  const resumed = await resumeOperation
  assert.equal(resumed.outcome, 'confirmed')
  assert.equal(ready(sequence.getSnapshot()).operationalState, 'playing')
  await sequence.dispose()
})

test('disposing while pause awaits Chromium state aborts the wait and removes its listener', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const gate = deferred<void>()
  playback.pauseObservationGate = gate
  playback.pauseStarted = deferred<void>()
  playback.nextSubscriptionAdded = deferred<void>()
  const operation = sequence.execute({ operationId: 'pause-disposed-during-confirmation', command: { type: 'toggle-pause' } })
  await playback.pauseStarted.promise
  await playback.nextSubscriptionAdded.promise
  assert.equal(playback.listenerCount, 2, 'the playback event relay and correlated confirmation wait are both subscribed')

  await sequence.dispose()
  gate.resolve()
  const result = await operation
  assert.notEqual(result.outcome, 'confirmed')
  assert.equal(playback.listenerCount, 0, 'dispose removes both the confirmation and composition event listeners')
})

test('first priority added while idle starts normally', async () => {
  const { sequence, playback } = await build()
  await submit(sequence, 'priority-idle', '1111', 'priority')
  assert.deepEqual(playback.starts, ['01111'])
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01111')
  await sequence.dispose()
})

test('priority while playing is inserted at the head without interrupting current', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'normal', '1002')
  await submit(sequence, 'priority', '1111', 'priority')
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01001')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01111', '01002'])
  assert.deepEqual(playback.starts, ['01001'])
  await sequence.dispose()
})

test('priority while paused is queued without resuming', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await sequence.execute({ operationId: 'pause', command: { type: 'toggle-pause' } })
  await submit(sequence, 'priority-paused', '1111', 'priority')
  assert.equal(ready(sequence.getSnapshot()).operationalState, 'paused')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01111'])
  assert.equal(playback.starts.length, 1)
  await sequence.dispose()
})

test('multiple priorities use LIFO order ahead of normal FIFO entries', async () => {
  const { sequence } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'normal-2', '1002')
  await submit(sequence, 'normal-3', '1003')
  await submit(sequence, 'priority-1', '1111', 'priority')
  await submit(sequence, 'priority-2', '2222', 'priority')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode),
    ['02222', '01111', '01002', '01003'])
  await sequence.dispose()
})

test('C11 accepts 30 pending songs excluding the current track and rejects Enter/P without mutating playback or order', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'limit-normal-first', '1002')
  await submit(sequence, 'limit-normal-second', '1003')
  await submit(sequence, 'limit-priority-first', '1111', 'priority')
  await submit(sequence, 'limit-priority-second', '2222', 'priority')
  for (let index = 0; index < 25; index++) {
    await submitRaw(sequence, `limit-normal-fill-${index}`, '1002')
  }

  const at29 = ready(sequence.getSnapshot())
  assert.equal(at29.current?.musicCode, '01001')
  assert.equal(at29.pending.length, 29)

  const thirtieth = await submitRaw(sequence, 'limit-thirtieth-normal', '3333')
  assert.equal(thirtieth.outcome, 'confirmed')
  const at30 = ready(sequence.getSnapshot())
  assert.equal(at30.current?.musicCode, '01001', 'the current music is outside the 30-song pending capacity.')
  assert.equal(at30.pending.length, 30)
  assert.deepEqual(at30.pending.map(entry => entry.musicCode), [
    '02222', '01111', '01002', '01003', ...Array(25).fill('01002'), '03333'
  ], 'priority entries retain LIFO and normal entries retain FIFO at the capacity boundary.')

  let publicationCount = 0
  const unsubscribe = sequence.subscribe(() => { publicationCount++ })
  const beforeRejectedAdmission = sequence.getSnapshot()
  const playbackBeforeRejectedAdmission = playback.getState()
  const validationCountBeforeRejectedAdmission = playback.validateCalls.length
  const startsBeforeRejectedAdmission = [...playback.starts]
  const stopsBeforeRejectedAdmission = [...playback.stops]
  const timersBeforeRejectedAdmission = scheduler.activeTimerCount
  const eventsBeforeRejectedAdmission = publicationCount

  const rejectedEnter = await submitRaw(sequence, 'limit-31-enter', '4004', 'normal')
  assert.equal(rejectedEnter.outcome, 'rejected')
  if (rejectedEnter.outcome === 'rejected') assert.equal(rejectedEnter.error.code, 'QUEUE_LIMIT_REACHED')
  const rejectedPriority = await submitRaw(sequence, 'limit-31-priority', '5005', 'priority')
  assert.equal(rejectedPriority.outcome, 'rejected')
  if (rejectedPriority.outcome === 'rejected') assert.equal(rejectedPriority.error.code, 'QUEUE_LIMIT_REACHED')

  assert.deepEqual(sequence.getSnapshot(), beforeRejectedAdmission, 'capacity rejection does not publish or mutate the confirmed snapshot.')
  assert.deepEqual(playback.getState(), playbackBeforeRejectedAdmission)
  assert.equal(playback.validateCalls.length, validationCountBeforeRejectedAdmission,
    'a known-full queue rejects before media validation or playback work.')
  assert.deepEqual(playback.starts, startsBeforeRejectedAdmission)
  assert.deepEqual(playback.stops, stopsBeforeRejectedAdmission)
  assert.equal(scheduler.activeTimerCount, timersBeforeRejectedAdmission)
  assert.equal(publicationCount, eventsBeforeRejectedAdmission, 'capacity rejection does not publish sequence events.')
  unsubscribe()
  await sequence.dispose()
})

test('C11 serializes competing Enter/P admissions for the last pending slot and preserves operation idempotency', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  for (let index = 0; index < 29; index++) {
    await submitRaw(sequence, `limit-race-fill-${index}`, '1002')
  }

  const gate = deferred<void>()
  playback.validateGates.set('01003', gate)
  playback.validationStarted.set('01003', deferred<void>())
  const enterRequest: StandalonePlayerCommandRequest = {
    operationId: 'limit-race-enter', command: { type: 'submit-code', enteredCode: '1003', priority: 'normal' }
  }
  const priorityRequest: StandalonePlayerCommandRequest = {
    operationId: 'limit-race-priority', command: { type: 'submit-code', enteredCode: '1111', priority: 'priority' }
  }
  const enter = sequence.execute(enterRequest)
  await playback.validationStarted.get('01003')!.promise
  const priority = await sequence.execute(priorityRequest)
  assert.equal(priority.outcome, 'rejected', 'the first in-flight admission reserves the final slot in Main.')
  if (priority.outcome === 'rejected') assert.equal(priority.error.code, 'QUEUE_LIMIT_REACHED')
  assert.deepEqual(playback.validateCalls.at(-1), '01003', 'the rejected priority request does not start a validation effect.')

  gate.resolve()
  const accepted = await enter
  assert.equal(accepted.outcome, 'confirmed')
  assert.equal(ready(sequence.getSnapshot()).pending.length, 30)
  assert.deepEqual(await sequence.execute(enterRequest), accepted, 'retrying an accepted operationId cannot create another entry.')
  assert.deepEqual(await sequence.execute(priorityRequest), priority, 'a rejected operationId remains idempotently rejected.')
  assert.equal(ready(sequence.getSnapshot()).pending.length, 30)
  await sequence.dispose()
})

test('C11 releases an in-flight capacity reservation when media validation rejects the admission', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  for (let index = 0; index < 29; index++) {
    await submitRaw(sequence, `limit-validation-fill-${index}`, '1002')
  }

  const gate = deferred<void>()
  playback.validateGates.set('09999', gate)
  playback.validationStarted.set('09999', deferred<void>())
  playback.validationErrors.set('09999', new PlayerPlaybackError('MEDIA_UNAVAILABLE', 'Missing sample'))
  const invalidAdmission: StandalonePlayerCommandRequest = {
    operationId: 'limit-invalid-in-flight', command: { type: 'submit-code', enteredCode: '9999', priority: 'normal' }
  }
  const pendingInvalid = sequence.execute(invalidAdmission)
  await playback.validationStarted.get('09999')!.promise

  const whileReserved = await submitRaw(sequence, 'limit-rejected-while-reserved', '1111', 'priority')
  assert.equal(whileReserved.outcome, 'rejected')
  if (whileReserved.outcome === 'rejected') assert.equal(whileReserved.error.code, 'QUEUE_LIMIT_REACHED')
  assert.equal(ready(sequence.getSnapshot()).pending.length, 29,
    'an in-flight validation reserves the final slot without publishing a pending entry.')

  gate.resolve()
  const invalidResult = await pendingInvalid
  assert.equal(invalidResult.outcome, 'rejected')
  if (invalidResult.outcome === 'rejected') assert.equal(invalidResult.error.code, 'MEDIA_UNAVAILABLE')
  assert.equal(ready(sequence.getSnapshot()).pending.length, 29)

  const freshIntent = await submitRaw(sequence, 'limit-new-after-validation-failure', '1003')
  assert.equal(freshIntent.outcome, 'confirmed', 'the failed validation must release capacity for a new intent.')
  assert.equal(ready(sequence.getSnapshot()).pending.length, 30)
  await sequence.dispose()
})

test('C11 keeps a full-queue rejection idempotent after natural EOF releases a slot; a new intent can use the vacancy', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  for (let index = 0; index < 30; index++) {
    await submitRaw(sequence, `limit-eof-fill-${index}`, '1002')
  }
  const rejectedRequest: StandalonePlayerCommandRequest = {
    operationId: 'limit-rejected-before-eof', command: { type: 'submit-code', enteredCode: '3333', priority: 'normal' }
  }
  const rejected = await sequence.execute(rejectedRequest)
  assert.equal(rejected.outcome, 'rejected')
  if (rejected.outcome === 'rejected') assert.equal(rejected.error.code, 'QUEUE_LIMIT_REACHED')

  await beginCelebration(sequence, playback)
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.operationalState === 'playing' && snapshot.state.pending.length === 29)
  await advanceCelebrationTimer(sequence, scheduler)
  await advanced
  assert.deepEqual(await sequence.execute(rejectedRequest), rejected,
    'a retry of the rejected intent returns its original result even after capacity changes.')

  const newIntent = await submitRaw(sequence, 'limit-new-intent-after-eof', '3333')
  assert.equal(newIntent.outcome, 'confirmed')
  assert.equal(ready(sequence.getSnapshot()).pending.length, 30)
  await sequence.dispose()
})

test('concurrent validation completions preserve normal FIFO and priority LIFO admission order', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const codes = ['01002', '01003', '01111', '02222']
  const gates = new Map(codes.map(code => [code, deferred<void>()]))
  for (const code of codes) {
    playback.validateGates.set(code, gates.get(code)!)
    playback.validationStarted.set(code, deferred<void>())
  }
  const operations = [
    submit(sequence, 'fifo-2', '1002'),
    submit(sequence, 'fifo-3', '1003'),
    submit(sequence, 'lifo-1', '1111', 'priority'),
    submit(sequence, 'lifo-2', '2222', 'priority')
  ]
  await Promise.all(codes.map(code => playback.validationStarted.get(code)!.promise))
  for (const code of ['02222', '01111', '01003', '01002']) gates.get(code)!.resolve()
  await Promise.all(operations)
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode),
    ['02222', '01111', '01002', '01003'])
  await sequence.dispose()
})

test('natural EOF keeps the celebration for five seconds then starts the current FIFO head without a second countdown', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const celebrating = await beginCelebration(sequence, playback)
  assert.equal(celebrating.remainingMs, STANDALONE_CELEBRATION_MS)
  assert.deepEqual(playback.starts, ['01001'], 'the next video does not start before the celebration ends.')
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  await advanceCelebrationTimer(sequence, scheduler)
  await advanced
  assert.deepEqual(playback.starts, ['01001', '01002'])
  await sequence.dispose()
})

test('shutdown fences an EOF already queued in the transition arbiter before it can start the next song', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'shutdown-eof-pending', '1002')

  playback.endCurrent()
  await sequence.beginShutdown()
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))

  assert.deepEqual(playback.starts, ['01001'], 'shutdown must prevent the EOF handler from starting queued media.')
  const afterShutdown = await sequence.execute({
    operationId: 'sequence-after-shutdown', command: { type: 'toggle-pause' }
  })
  assert.equal(afterShutdown.outcome, 'rejected')
  if (afterShutdown.outcome === 'rejected') assert.equal(afterShutdown.error.code, 'DISPOSED')
  await sequence.dispose()
})

test('a failed pre-stop shutdown restores an active countdown with its frozen remaining time', async () => {
  const { sequence, playback, scheduler } = await build()
  await submitRaw(sequence, 'shutdown-resume-countdown', '1001')
  await scheduler.elapseWithoutRunning(1200)
  const beforeShutdown = sequence.getSnapshot()
  assert.equal(beforeShutdown.playbackCondition, 'transitioning')
  if (beforeShutdown.playbackCondition !== 'transitioning' || beforeShutdown.phase !== 'countdown') {
    throw new Error('Expected an active countdown before shutdown.')
  }
  const remainingMs = beforeShutdown.remainingMs

  await sequence.beginShutdown()
  await scheduler.elapseWithoutRunning(3000)
  const frozen = sequence.getSnapshot()
  assert.equal(frozen.playbackCondition, 'transitioning')
  if (frozen.playbackCondition !== 'transitioning' || frozen.phase !== 'countdown') throw new Error('Countdown changed while shutdown was fenced.')
  assert.equal(frozen.remainingMs, remainingMs)
  assert.equal(scheduler.activeTimerCount, 0)

  await sequence.resumeAfterFailedShutdown()
  const resumed = sequence.getSnapshot()
  assert.equal(resumed.playbackCondition, 'transitioning')
  if (resumed.playbackCondition !== 'transitioning' || resumed.phase !== 'countdown') throw new Error('Countdown did not resume after shutdown failure.')
  assert.equal(resumed.remainingMs, remainingMs)
  assert.equal(scheduler.activeTimerCount, 1)
  await scheduler.advance(remainingMs)
  const playing = await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.operationalState === 'playing')
  assert.equal(playing.playbackCondition, 'ready')
  assert.deepEqual(playback.starts, ['01001'])
  await sequence.dispose()
})

test('a failed pre-stop shutdown restores an active celebration and its FIFO continuation', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'shutdown-resume-celebration-queued', '1002')
  const celebration = await beginCelebration(sequence, playback)
  await scheduler.elapseWithoutRunning(1700)
  const beforeShutdown = sequence.getSnapshot()
  assert.equal(beforeShutdown.playbackCondition, 'transitioning')
  if (beforeShutdown.playbackCondition !== 'transitioning' || beforeShutdown.phase !== 'celebration') {
    throw new Error('Expected an active celebration before shutdown.')
  }
  const remainingMs = beforeShutdown.remainingMs
  assert.ok(remainingMs < celebration.remainingMs)

  await sequence.beginShutdown()
  await scheduler.elapseWithoutRunning(4000)
  const frozen = sequence.getSnapshot()
  assert.equal(frozen.playbackCondition, 'transitioning')
  if (frozen.playbackCondition !== 'transitioning' || frozen.phase !== 'celebration') throw new Error('Celebration changed while shutdown was fenced.')
  assert.equal(frozen.remainingMs, remainingMs)
  assert.equal(scheduler.activeTimerCount, 0)

  await sequence.resumeAfterFailedShutdown()
  const resumed = sequence.getSnapshot()
  assert.equal(resumed.playbackCondition, 'transitioning')
  if (resumed.playbackCondition !== 'transitioning' || resumed.phase !== 'celebration') throw new Error('Celebration did not resume after shutdown failure.')
  assert.equal(resumed.remainingMs, remainingMs)
  assert.equal(scheduler.activeTimerCount, 1)
  const nextPlaying = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.current?.musicCode === '01002')
  await scheduler.advance(remainingMs)
  await nextPlaying
  assert.deepEqual(playback.starts, ['01001', '01002'])
  await sequence.dispose()
})

test('shutdown freezes a countdown whose timer callback is already queued in the transition arbiter', async () => {
  const { sequence, playback, scheduler } = await build()
  await submitRaw(sequence, 'shutdown-queued-countdown-callback', '1001')
  await scheduler.elapseWithoutRunning(1000)
  const firedTimer = scheduler.timers.find(timer => !timer.cancelled)
  assert.ok(firedTimer)
  firedTimer.cancelled = true
  firedTimer.callback()
  const shutdown = sequence.beginShutdown()
  await shutdown

  const frozen = sequence.getSnapshot()
  if (frozen.playbackCondition !== 'transitioning' || frozen.phase !== 'countdown') {
    throw new Error('The queued countdown callback must not advance playback during shutdown.')
  }
  assert.equal(frozen.remainingMs, 4000)
  assert.equal(scheduler.activeTimerCount, 0)

  await sequence.resumeAfterFailedShutdown()
  const resumed = sequence.getSnapshot()
  if (resumed.playbackCondition !== 'transitioning' || resumed.phase !== 'countdown') {
    throw new Error('The countdown callback queued before shutdown must be recoverable.')
  }
  assert.equal(resumed.remainingMs, 4000)
  assert.equal(scheduler.activeTimerCount, 1)
  await scheduler.advance(4000)
  const playing = await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.operationalState === 'playing')
  assert.equal(playing.playbackCondition, 'ready')
  assert.deepEqual(playback.starts, ['01001'])
  await sequence.dispose()
})

test('shutdown freezes a celebration whose timer callback is already queued in the transition arbiter', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'shutdown-queued-celebration-callback', '1002')
  await beginCelebration(sequence, playback)
  await scheduler.elapseWithoutRunning(1000)
  const firedTimer = scheduler.timers.find(timer => !timer.cancelled)
  assert.ok(firedTimer)
  firedTimer.cancelled = true
  firedTimer.callback()
  const shutdown = sequence.beginShutdown()
  await shutdown

  const frozen = sequence.getSnapshot()
  if (frozen.playbackCondition !== 'transitioning' || frozen.phase !== 'celebration') {
    throw new Error('The queued celebration callback must not advance the sequence during shutdown.')
  }
  assert.equal(frozen.remainingMs, 4000)
  assert.equal(scheduler.activeTimerCount, 0)

  await sequence.resumeAfterFailedShutdown()
  const resumed = sequence.getSnapshot()
  if (resumed.playbackCondition !== 'transitioning' || resumed.phase !== 'celebration') {
    throw new Error('The celebration callback queued before shutdown must be recoverable.')
  }
  assert.equal(resumed.remainingMs, 4000)
  assert.equal(scheduler.activeTimerCount, 1)
  const nextPlaying = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.current?.musicCode === '01002')
  await scheduler.advance(4000)
  await nextPlaying
  assert.deepEqual(playback.starts, ['01001', '01002'])
  await sequence.dispose()
})

test('priority committed before EOF remains ahead of FIFO at celebration expiry', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'normal-next', '1002')
  await submit(sequence, 'priority-before-eof', '1111', 'priority')
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01111')
  await beginCelebration(sequence, playback)
  assert.deepEqual(playback.starts, ['01001'])
  await advanceCelebrationTimer(sequence, scheduler)
  await advanced
  assert.deepEqual(playback.starts, ['01001', '01111'])
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01002'])
  await sequence.dispose()
})

test('natural EOF with an empty queue celebrates for five seconds then clears current and returns to idle', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  const idle = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'idle')
  const ended = playback.getState()
  const celebrating = await beginCelebration(sequence, playback)
  assert.deepEqual(playback.clearedCompleted, [], 'completed media is retained through the celebration window.')
  assert.equal(celebrating.pending.length, 0)
  await advanceCelebrationTimer(sequence, scheduler)
  await idle
  assert.deepEqual(playback.clearedCompleted, [ended.attemptId])
  assert.deepEqual(ready(sequence.getSnapshot()), { operationalState: 'idle', current: null, pending: [] })
  await sequence.dispose()
})

test('celebration messages are chosen from the approved forty-message set and remain fixed for that EOF', async () => {
  assert.equal(STANDALONE_CELEBRATION_MESSAGES.length, 40)
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const current = ready(sequence.getSnapshot()).current!
  const celebrating = await beginCelebration(sequence, playback)
  assert.ok((STANDALONE_CELEBRATION_MESSAGES as readonly string[]).includes(celebrating.message))
  playback.emit({ type: 'natural-end-candidate', attemptId: current.attemptId,
    musicCode: current.musicCode, duration: 1, endedAt: new Date(1).toISOString() })
  const afterDuplicate = sequence.getSnapshot()
  assert.equal(afterDuplicate.playbackCondition, 'transitioning')
  if (afterDuplicate.playbackCondition === 'transitioning' && afterDuplicate.phase === 'celebration') {
    assert.equal(afterDuplicate.message, celebrating.message)
  }
  await sequence.dispose()
})

test('Space pauses and resumes only the celebration timer from its frozen remainder', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  const current = ready(sequence.getSnapshot()).current!
  await beginCelebration(sequence, playback)
  await scheduler.advance(2300)
  const paused = await sequence.execute({ operationId: 'celebration-pause', command: { type: 'toggle-pause' } })
  assert.equal(paused.outcome, 'confirmed')
  assert.equal(paused.snapshot.playbackCondition, 'transitioning')
  if (paused.snapshot.playbackCondition === 'transitioning' && paused.snapshot.phase === 'celebration') {
    assert.equal(paused.snapshot.paused, true)
    assert.equal(paused.snapshot.remainingMs, 2700)
  }
  assert.equal(playback.pauseCalls, 0)
  assert.equal(playback.resumeCalls, 0)
  await scheduler.advance(3000)
  assert.equal(sequence.getSnapshot().playbackCondition, 'transitioning', 'elapsed wall time does not consume a paused celebration.')

  await sequence.execute({ operationId: 'celebration-resume', command: { type: 'toggle-pause' } })
  const beforeFinalRemainder = sequence.getSnapshot()
  assert.equal(beforeFinalRemainder.playbackCondition, 'transitioning')
  if (beforeFinalRemainder.playbackCondition === 'transitioning' && beforeFinalRemainder.phase === 'celebration') {
    assert.equal(beforeFinalRemainder.paused, false)
    assert.equal(beforeFinalRemainder.remainingMs, 2700)
  }
  await scheduler.advance(2699)
  assert.equal(sequence.getSnapshot().playbackCondition, 'transitioning')
  await scheduler.advance(1)
  await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'idle')
  assert.deepEqual(playback.clearedCompleted, [current.attemptId])
  assert.equal(playback.pauseCalls, 0)
  assert.equal(playback.resumeCalls, 0)
  await sequence.dispose()
})

test('a validation started during celebration delays the final FIFO/LIFO choice until it commits', async () => {
  const playback = new FakePlayback()
  const validationGate = deferred<void>()
  playback.validateGates.set('01111', validationGate)
  playback.validationStarted.set('01111', deferred<void>())
  const { sequence, scheduler } = await build({ playback })
  await addCurrent(sequence)
  await beginCelebration(sequence, playback)

  const admission = submitRaw(sequence, 'celebration-slow-priority', '1111', 'priority')
  await playback.validationStarted.get('01111')!.promise
  await advanceCelebrationTimer(sequence, scheduler)
  const expiredPending = sequence.getSnapshot()
  assert.equal(expiredPending.playbackCondition, 'transitioning')
  if (expiredPending.playbackCondition === 'transitioning' && expiredPending.phase === 'celebration') {
    assert.equal(expiredPending.remainingMs, 0)
  }
  assert.deepEqual(playback.starts, ['01001'], 'expiry does not start from a queue snapshot while an admitted validation is unresolved.')

  validationGate.resolve()
  const result = await admission
  assert.equal(result.outcome, 'confirmed')
  await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01111')
  assert.deepEqual(playback.starts, ['01001', '01111'])
  await sequence.dispose()
})

test('Next is rejected during celebration and cannot skip its timer or create a manual EOF transition', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await beginCelebration(sequence, playback)
  const result = await sequence.execute({ operationId: 'next-during-celebration', command: { type: 'next' } })
  assert.equal(result.outcome, 'rejected')
  if (result.outcome === 'rejected') assert.equal(result.error.code, 'INVALID_STATE')
  const during = sequence.getSnapshot()
  assert.equal(during.playbackCondition, 'transitioning')
  if (during.playbackCondition === 'transitioning') assert.equal(during.phase, 'celebration')
  assert.deepEqual(playback.starts, ['01001'])
  await advanceCelebrationTimer(sequence, scheduler)
  await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'idle')
  await sequence.dispose()
})

test('disposing during celebration cancels its timer and never starts a queued song later', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'dispose-celebration-queued', '1002')
  await beginCelebration(sequence, playback)
  assert.equal(scheduler.activeTimerCount, 1)
  await sequence.dispose()
  assert.equal(scheduler.activeTimerCount, 0)
  await scheduler.advance(STANDALONE_CELEBRATION_MS)
  assert.deepEqual(playback.starts, ['01001'])
})

test('Space at an elapsed deadline settles the celebration once and makes a stale timer callback harmless', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'deadline-space-next', '1002')
  await beginCelebration(sequence, playback)
  await scheduler.elapseWithoutRunning(STANDALONE_CELEBRATION_MS)
  const nextStarted = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01002')
  const pauseAtDeadline = await sequence.execute({ operationId: 'space-at-celebration-deadline', command: { type: 'toggle-pause' } })
  assert.equal(pauseAtDeadline.outcome, 'confirmed')
  await scheduler.advance(0)
  await nextStarted
  assert.deepEqual(playback.starts, ['01001', '01002'])
  assert.equal(playback.pauseCalls, 0)
  assert.equal(playback.resumeCalls, 0)
  assert.equal(scheduler.activeTimerCount, 0)
  await sequence.dispose()
})

test('dispose during a background EOF start settles the tracked effect and disposes playback once', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const gate = deferred<void>()
  playback.startGates.set('01002', gate)
  playback.startStarted.set('01002', deferred<void>())
  await beginCelebration(sequence, playback)
  const ended = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'loading')
  await advanceCelebrationTimer(sequence, scheduler)
  await ended
  await playback.startStarted.get('01002')!.promise
  await sequence.dispose()
  assert.equal(playback.disposeCount, 1)
  assert.deepEqual(playback.starts, ['01001', '01002'])
})

test('manual Next stops current and starts the next queued song', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const oldAttempt = ready(sequence.getSnapshot()).current!.attemptId
  const result = await sequence.execute({ operationId: 'next', command: { type: 'next' } })
  assert.equal(result.outcome, 'confirmed')
  assert.deepEqual(playback.stops, [oldAttempt])
  assert.deepEqual(playback.starts, ['01001', '01002'])
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  assert.equal(sequence.getSnapshot().playbackCondition, 'ready')
  await sequence.dispose()
})

test('a priority admitted during manual Next stays behind its already reserved head', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued-before-next', '1002')
  const stopStarted = deferred<string | undefined>()
  const allowStop = deferred<void>()
  playback.stopStarted = stopStarted
  playback.stopGate = allowStop

  const next = sequence.execute({ operationId: 'next-with-reserved-head', command: { type: 'next' } })
  await stopStarted.promise
  await submit(sequence, 'priority-during-next', '1111', 'priority')

  const duringStop = sequence.getSnapshot()
  assert.equal(duringStop.playbackCondition, 'transitioning')
  if (duringStop.playbackCondition === 'transitioning') {
    assert.deepEqual(duringStop.pending.map(entry => entry.musicCode), ['01002', '01111'])
  }
  allowStop.resolve()
  assert.equal((await next).outcome, 'confirmed')
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01111'])
  await sequence.dispose()
})

test('manual Next without a pending song stops and returns to idle without synthetic EOF', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const attemptId = ready(sequence.getSnapshot()).current!.attemptId
  const result = await sequence.execute({ operationId: 'next-empty', command: { type: 'next' } })
  assert.equal(result.outcome, 'confirmed')
  assert.deepEqual(playback.clearedCompleted, [])
  assert.deepEqual(playback.clearedStopped, [attemptId])
  assert.equal(ready(sequence.getSnapshot()).operationalState, 'idle')
  await sequence.dispose()
})

test('manual Next is rejected while playback is paused and performs no stop or start', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'paused-next-queue', '1002')
  await sequence.execute({ operationId: 'paused-next-pause', command: { type: 'toggle-pause' } })
  const stopCount = playback.stops.length
  const startCount = playback.starts.length
  const result = await sequence.execute({ operationId: 'paused-next-blocked', command: { type: 'next' } })
  assert.equal(result.outcome, 'rejected')
  if (result.outcome === 'rejected') assert.equal(result.error.code, 'INVALID_STATE')
  assert.equal(playback.stops.length, stopCount)
  assert.equal(playback.starts.length, startCount)
  assert.equal(ready(sequence.getSnapshot()).operationalState, 'paused')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01002'])
  await sequence.dispose()
})

test('Stop All atomically stops playback, clears FIFO/LIFO, returns idle, and is idempotent', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'stop-all-normal-1', '1002')
  await submit(sequence, 'stop-all-normal-2', '1003')
  await submit(sequence, 'stop-all-priority-1', '1004', 'priority')
  await submit(sequence, 'stop-all-priority-2', '1005', 'priority')
  const previousAttemptId = ready(sequence.getSnapshot()).current!.attemptId
  const request: StandalonePlayerCommandRequest = {
    operationId: 'stop-all-once', command: { type: 'stop-all' }
  }
  const [first, duplicate] = await Promise.all([sequence.execute(request), sequence.execute(request)])
  assert.deepEqual(duplicate, first, 'duplicate delivery shares one result and does not repeat effects.')
  assert.equal(first.outcome, 'confirmed')
  assert.deepEqual(playback.stops, [undefined], 'Stop All uses one unqualified stop to supersede pending playback commands.')
  assert.deepEqual(playback.clearedStopped, [previousAttemptId])
  assert.deepEqual(ready(sequence.getSnapshot()), { operationalState: 'idle', current: null, pending: [] })
  assert.equal(playback.getState().status, 'idle')
  assert.deepEqual(await sequence.execute(request), first, 'a completed retry reuses the cached result.')
  const conflict = await sequence.execute({ operationId: request.operationId, command: { type: 'next' } })
  assert.equal(conflict.outcome, 'rejected')
  if (conflict.outcome === 'rejected') assert.equal(conflict.error.code, 'OPERATION_ID_CONFLICT')
  assert.equal(playback.stops.length, 1)
  await sequence.dispose()
})

test('Stop All cancels an initial countdown and a stale expiry cannot autoplay', async () => {
  const { sequence, playback, scheduler } = await build()
  await submitRaw(sequence, 'stop-all-countdown-entry', '1001')
  const expiry = scheduler.timers.find(timer => !timer.cancelled)
  assert.ok(expiry)
  const result = await sequence.execute({ operationId: 'stop-all-countdown', command: { type: 'stop-all' } })
  assert.equal(result.outcome, 'confirmed')
  assert.deepEqual(ready(sequence.getSnapshot()), { operationalState: 'idle', current: null, pending: [] })
  expiry.callback()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(playback.starts, [])
  assert.equal(scheduler.activeTimerCount, 0)
  await sequence.dispose()
})

test('Stop All cancels a celebration and stale expiry cannot start queued music', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'stop-all-celebration-normal', '1002')
  await submit(sequence, 'stop-all-celebration-priority', '1003', 'priority')
  const celebration = await beginCelebration(sequence, playback)
  const expiry = scheduler.timers.find(timer => !timer.cancelled)
  assert.ok(expiry)
  const result = await sequence.execute({ operationId: 'stop-all-celebration', command: { type: 'stop-all' } })
  assert.equal(result.outcome, 'confirmed')
  assert.deepEqual(playback.clearedCompleted, [celebration.lastConfirmedState.current!.attemptId])
  assert.deepEqual(ready(sequence.getSnapshot()), { operationalState: 'idle', current: null, pending: [] })
  expiry.callback()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(playback.starts, ['01001'])
  assert.equal(scheduler.activeTimerCount, 0)
  await sequence.dispose()
})

test('Stop All failure never claims idle and preserves pending state for recovery', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'stop-all-failure-pending', '1002')
  const confirmedBefore = ready(sequence.getSnapshot())
  playback.clearStoppedResult = false
  const result = await sequence.execute({ operationId: 'stop-all-failure', command: { type: 'stop-all' } })
  assert.equal(result.outcome, 'blocked')
  assert.equal(result.snapshot.playbackCondition, 'blocked')
  assert.equal(result.snapshot.lastConfirmedState.current?.attemptId, confirmedBefore.current?.attemptId)
  assert.deepEqual(result.snapshot.pending.map(entry => entry.musicCode), ['01002'])
  assert.equal(playback.getState().status, 'stopped', 'the sequence does not claim successful media clearing.')
  await sequence.dispose()
})

test('Stop All supersedes an already preparing playback start and prevents delayed autoplay', async () => {
  const { sequence, playback, scheduler } = await build()
  const startGate = deferred<void>()
  const startStarted = deferred<void>()
  playback.startGates.set('01001', startGate)
  playback.startStarted.set('01001', startStarted)
  await submitRaw(sequence, 'stop-all-load-entry', '1001')
  await scheduler.advance(STANDALONE_INITIAL_COUNTDOWN_MS)
  await startStarted.promise
  const stopAll = await sequence.execute({ operationId: 'stop-all-during-load', command: { type: 'stop-all' } })
  assert.equal(stopAll.outcome, 'confirmed')
  assert.deepEqual(ready(sequence.getSnapshot()), { operationalState: 'idle', current: null, pending: [] })
  startGate.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(ready(sequence.getSnapshot()), { operationalState: 'idle', current: null, pending: [] })
  assert.equal(playback.getState().status, 'stopped')
  assert.deepEqual(playback.starts, ['01001'], 'the stale attempt was requested once but did not commit after Stop All.')
  await sequence.dispose()
})

test('natural EOF confirmed before Stop ACK advances once; delayed EOF for the old attempt is stale', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const old = ready(sequence.getSnapshot()).current!
  const stopStarted = deferred<string | undefined>()
  const allowStop = deferred<void>()
  playback.stopStarted = stopStarted
  playback.stopGate = allowStop
  const request: StandalonePlayerCommandRequest = { operationId: 'next-race', command: { type: 'next' } }
  const next = sequence.execute(request)
  await stopStarted.promise
  assert.equal(sequence.execute(request), next)
  const conflictingRetry = await sequence.execute({
    operationId: request.operationId,
    command: { type: 'toggle-pause' }
  })
  assert.equal(conflictingRetry.outcome, 'rejected')
  if (conflictingRetry.outcome === 'rejected') assert.equal(conflictingRetry.error.code, 'OPERATION_ID_CONFLICT')
  playback.endCurrent()
  allowStop.resolve()
  await next
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  assert.deepEqual(playback.starts, ['01001', '01002'])
  playback.state = { status: 'completed', attemptId: old.attemptId, musicCode: old.musicCode }
  playback.emit({ type: 'natural-end-candidate', attemptId: old.attemptId, musicCode: old.musicCode, duration: 1, endedAt: new Date(1).toISOString() })
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  await sequence.dispose()
})

test('shutdown prevents a queued Next from starting its successor when natural EOF wins Stop', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'next-shutdown-queue', '1002')
  const stopStarted = deferred<string | undefined>()
  const allowStop = deferred<void>()
  playback.stopStarted = stopStarted
  playback.stopGate = allowStop

  const next = sequence.execute({ operationId: 'next-shutdown-eof-race', command: { type: 'next' } })
  await stopStarted.promise
  playback.endCurrent()
  const shutdown = sequence.beginShutdown()
  allowStop.resolve()
  await Promise.all([next, shutdown])

  assert.deepEqual(playback.starts, ['01001'], 'shutdown must fence the successor after EOF beats the pending Stop.')
  await sequence.dispose()
})

test('shutdown closing admission between EOF reservation and Next successor start blocks that start', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'next-shutdown-after-eof-reserve', '1002')
  const stopStarted = deferred<string | undefined>()
  const allowStop = deferred<void>()
  playback.stopStarted = stopStarted
  playback.stopGate = allowStop

  const next = sequence.execute({ operationId: 'next-shutdown-after-eof-reserve-race', command: { type: 'next' } })
  await stopStarted.promise
  let shutdown: Promise<void> | undefined
  const unsubscribe = sequence.subscribe(snapshot => {
    if (shutdown || snapshot.playbackCondition !== 'transitioning' || snapshot.phase !== 'operation') return
    shutdown = sequence.beginShutdown()
  })
  playback.endCurrent()
  allowStop.resolve()
  await next
  assert.ok(shutdown, 'natural EOF reservation should synchronously trigger shutdown admission closure.')
  await shutdown
  unsubscribe()

  assert.deepEqual(playback.starts, ['01001'], 'shutdown must block the second arbiter step from starting queued media.')
  await sequence.dispose()
})

test('a conflicting retry cannot erase a Next intention waiting behind an event decision', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const current = ready(sequence.getSnapshot()).current!
  playback.emit({ type: 'state-changed', state: playback.getState() })

  const request: StandalonePlayerCommandRequest = { operationId: 'queued-next', command: { type: 'next' } }
  const next = sequence.execute(request)
  const malformedRetry = sequence.execute({
    operationId: request.operationId,
    command: { type: 'next', unexpected: true }
  } as unknown as StandalonePlayerCommandRequest)
  await assert.rejects(malformedRetry)
  const conflict = await sequence.execute({
    operationId: request.operationId,
    command: { type: 'toggle-pause' }
  })
  assert.equal(conflict.outcome, 'rejected')
  if (conflict.outcome === 'rejected') assert.equal(conflict.error.code, 'OPERATION_ID_CONFLICT')

  const result = await next
  assert.equal(result.outcome, 'confirmed')
  assert.deepEqual(playback.stops, [current.attemptId])
  assert.equal(ready(sequence.getSnapshot()).operationalState, 'idle')
  await sequence.dispose()
})

test('a concurrent Next cannot bypass celebration and the queued successor starts once after the timer', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued-1', '1002')
  await submit(sequence, 'queued-2', '1003')
  await beginCelebration(sequence, playback)
  const result = await sequence.execute({ operationId: 'next-after-eof-reserve', command: { type: 'next' } })
  assert.equal(result.outcome, 'rejected')
  if (result.outcome === 'rejected') assert.equal(result.error.code, 'INVALID_STATE')
  assert.deepEqual(playback.starts, ['01001'])
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  await advanceCelebrationTimer(sequence, scheduler)
  await advanced
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01003'])
  assert.deepEqual(playback.starts, ['01001', '01002'])
  await sequence.dispose()
})

test('uncertain Stop blocks later natural EOF and preserves pending music without autoplay', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  playback.stopErrors.push(new PlayerPlaybackError('COMMAND_TIMEOUT', 'Stop acknowledgement lost'))
  const result = await sequence.execute({ operationId: 'uncertain-next', command: { type: 'next' } })
  assert.equal(result.outcome, 'uncertain')
  playback.endCurrent()
  const snapshot = sequence.getSnapshot()
  assert.equal(snapshot.playbackCondition, 'uncertain')
  if (snapshot.playbackCondition === 'uncertain') {
    assert.deepEqual(snapshot.pending.map(entry => entry.musicCode), ['01002'])
  }
  assert.deepEqual(playback.starts, ['01001'])
  await sequence.dispose()
})

test('an uncertain event for current attempt while Next waits prevents its reserved start', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const current = ready(sequence.getSnapshot()).current!
  const stopStarted = deferred<string | undefined>()
  const allowStop = deferred<void>()
  playback.stopStarted = stopStarted
  playback.stopGate = allowStop
  const next = sequence.execute({ operationId: 'next-blocked-by-event', command: { type: 'next' } })
  await stopStarted.promise
  const uncertain = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'uncertain')
  playback.emit({ type: 'uncertain', attemptId: current.attemptId, musicCode: current.musicCode, reason: 'command-outcome-unknown' })
  await uncertain
  allowStop.resolve()
  const result = await next
  assert.equal(result.outcome, 'uncertain')
  assert.deepEqual(playback.starts, ['01001'])
  const snapshot = sequence.getSnapshot()
  assert.equal(snapshot.playbackCondition, 'uncertain')
  if (snapshot.playbackCondition === 'uncertain') assert.deepEqual(snapshot.pending.map(entry => entry.musicCode), ['01002'])
  await sequence.dispose()
})

test('an uncertain host event preserves its matching technical error code', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const current = ready(sequence.getSnapshot()).current!
  playback.state = {
    status: 'uncertain', attemptId: current.attemptId, musicCode: current.musicCode,
    errorCode: 'HOST_TERMINATED', containmentStatus: 'host-terminated'
  }
  const uncertain = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'uncertain')
  playback.emit({ type: 'uncertain', attemptId: current.attemptId, musicCode: current.musicCode, reason: 'host-terminated' })
  const snapshot = await uncertain
  assert.equal(snapshot.playbackCondition, 'uncertain')
  if (snapshot.playbackCondition === 'uncertain') assert.equal(snapshot.error.code, 'HOST_TERMINATED')
  await sequence.dispose()
})

test('EOF is deduplicated and does not advance twice', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued-1', '1002')
  await submit(sequence, 'queued-2', '1003')
  const current = ready(sequence.getSnapshot()).current!
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  const celebrating = await beginCelebration(sequence, playback)
  playback.emit({ type: 'natural-end-candidate', attemptId: current.attemptId, musicCode: current.musicCode, duration: 1, endedAt: new Date(2).toISOString() })
  const afterDuplicate = sequence.getSnapshot()
  assert.equal(afterDuplicate.playbackCondition, 'transitioning')
  if (afterDuplicate.playbackCondition === 'transitioning' && afterDuplicate.phase === 'celebration') {
    assert.equal(afterDuplicate.message, celebrating.message, 'a duplicate EOF does not reroll the message.')
    assert.equal(afterDuplicate.remainingMs, STANDALONE_CELEBRATION_MS, 'a duplicate EOF does not restart the timer.')
  }
  assert.equal(scheduler.activeTimerCount, 1)
  await advanceCelebrationTimer(sequence, scheduler)
  await advanced
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01003'])
  assert.deepEqual(playback.starts, ['01001', '01002'])
  await sequence.dispose()
})

test('normal addition linearized before EOF becomes the next song', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  const gate = deferred<void>()
  playback.validationStarted.set('01002', deferred<void>())
  playback.validateGates.set('01002', gate)
  const add = submit(sequence, 'add-before-eof', '1002')
  await playback.validationStarted.get('01002')!.promise
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  await beginCelebration(sequence, playback)
  gate.resolve()
  await add
  await advanceCelebrationTimer(sequence, scheduler)
  await advanced
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  await sequence.dispose()
})

test('priority committed during celebration becomes the next song at expiry', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'normal-next', '1002')
  const gate = deferred<void>()
  playback.validationStarted.set('01111', deferred<void>())
  playback.validateGates.set('01111', gate)
  const add = submit(sequence, 'priority-before-eof', '1111', 'priority')
  await playback.validationStarted.get('01111')!.promise
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01111')
  await beginCelebration(sequence, playback)
  gate.resolve()
  await add
  await advanceCelebrationTimer(sequence, scheduler)
  await advanced
  assert.deepEqual(playback.starts, ['01001', '01111'])
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01002'])
  await sequence.dispose()
})

test('known validation failure leaves the queue unchanged', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  playback.validationErrors.set('01002', new PlayerPlaybackError('MEDIA_UNAVAILABLE', 'Missing'))
  const result = await submit(sequence, 'missing', '1002')
  assert.equal(result.outcome, 'rejected')
  assert.deepEqual(ready(sequence.getSnapshot()).pending, [])
  assert.deepEqual(playback.starts, ['01001'])
  await sequence.dispose()
})

test('known failure to start preserves the first pending entry in blocked state', async () => {
  const { sequence, playback } = await build()
  playback.startErrors.push(new PlayerPlaybackError('HOST_UNAVAILABLE', 'No host'))
  const result = await submit(sequence, 'start-fail', '1001')
  assert.equal(result.outcome, 'confirmed', 'the code is accepted into the Main reservation before the countdown.')
  const failedSnapshot = sequence.getSnapshot()
  assert.equal(failedSnapshot.playbackCondition, 'blocked', 'the technical start failure blocks after countdown expiry.')
  assert.deepEqual(failedSnapshot.pending.map(entry => entry.musicCode), ['01001'])
  assert.deepEqual(playback.starts, ['01001'])
  const retry = await submit(sequence, 'blocked-retry', '1002')
  assert.equal(retry.outcome, 'blocked')
  assert.deepEqual(playback.starts, ['01001'])
  assert.equal(sequence.getSnapshot().playbackCondition, 'blocked')
  await sequence.dispose()
})

test('known failure to start the next song blocks without dropping the reserved head', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  playback.startErrors.push(new PlayerPlaybackError('MEDIA_LOAD_FAILED', 'Next media failed'))
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'blocked')
  await beginCelebration(sequence, playback)
  await advanceCelebrationTimer(sequence, scheduler)
  await advanced
  const snapshot = sequence.getSnapshot()
  assert.equal(snapshot.playbackCondition, 'blocked')
  assert.deepEqual(snapshot.pending.map(entry => entry.musicCode), ['01002'])
  assert.deepEqual(playback.starts, ['01001', '01002'])
  assert.equal(playback.getState().status, 'completed')
  await sequence.dispose()
})

test('uncertain start is not treated as success or known failure and retains pending entry', async () => {
  const { sequence, playback } = await build()
  playback.startErrors.push(new PlayerPlaybackError('COMMAND_TIMEOUT', 'No acknowledgement'))
  const result = await submit(sequence, 'start-uncertain', '1001')
  assert.equal(result.outcome, 'confirmed', 'admission is confirmed before countdown, independently of later host certainty.')
  const uncertainSnapshot = sequence.getSnapshot()
  assert.equal(uncertainSnapshot.playbackCondition, 'uncertain')
  assert.deepEqual(uncertainSnapshot.pending.map(entry => entry.musicCode), ['01001'])
  assert.deepEqual(playback.starts, ['01001'])
  await sequence.dispose()
})

test('same operationId and payload does not duplicate a music entry', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const request: StandalonePlayerCommandRequest = { operationId: 'same-add', command: { type: 'submit-code', enteredCode: '1002', priority: 'normal' } }
  await Promise.all([sequence.execute(request), sequence.execute(request)])
  assert.equal(ready(sequence.getSnapshot()).pending.length, 1)
  assert.equal(playback.validateCalls.filter(code => code === '01002').length, 1)
  await sequence.dispose()
})

test('same operationId with a different payload is rejected without changing the queue', async () => {
  const { sequence } = await build()
  await addCurrent(sequence)
  const first = await submit(sequence, 'conflict', '1002')
  const second = await submit(sequence, 'conflict', '1003')
  assert.equal(first.outcome, 'confirmed')
  assert.equal(second.outcome, 'rejected')
  if (second.outcome === 'rejected') assert.equal(second.error.code, 'OPERATION_ID_CONFLICT')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01002'])
  await sequence.dispose()
})

test('different operationIds for the same code create separate queue occurrences', async () => {
  const { sequence } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'duplicate-song-1', '1002')
  await submit(sequence, 'duplicate-song-2', '1002')
  const entries = ready(sequence.getSnapshot()).pending
  assert.deepEqual(entries.map(entry => entry.musicCode), ['01002', '01002'])
  assert.notEqual(entries[0].entryId, entries[1].entryId)
  await sequence.dispose()
})

test('restart preserves the current entry and pending queue while replacing only attemptId', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'restart-preserved-queue', '1002')
  await submit(sequence, 'restart-preserved-priority', '1003', 'priority')
  const before = ready(sequence.getSnapshot()).current!
  const result = await sequence.execute({ operationId: 'restart', command: { type: 'restart' } })
  const after = ready(sequence.getSnapshot()).current!
  assert.equal(result.outcome, 'confirmed')
  assert.equal(after.entryId, before.entryId)
  assert.notEqual(after.attemptId, before.attemptId)
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01003', '01002'])
  assert.equal(playback.starts.length, 1)
  assert.equal(sequence.getSnapshot().playbackCondition, 'ready', 'Restart does not enter EOF celebration.')
  await sequence.dispose()
})

test('toggle pause preserves queue and resumes only when explicitly requested', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  await sequence.execute({ operationId: 'pause', command: { type: 'toggle-pause' } })
  assert.equal(ready(sequence.getSnapshot()).operationalState, 'paused')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01002'])
  await sequence.execute({ operationId: 'resume', command: { type: 'toggle-pause' } })
  assert.equal(ready(sequence.getSnapshot()).operationalState, 'playing')
  assert.equal(playback.starts.length, 1)
  await sequence.dispose()
})

test('mutating a returned snapshot cannot mutate the authoritative queue', async () => {
  const { sequence } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const snapshot = sequence.getSnapshot()
  assert.equal(snapshot.playbackCondition, 'ready')
  if (snapshot.playbackCondition === 'ready') {
    ;(snapshot.state.pending as Array<{ entryId: string; musicCode: string }>).push({ entryId: 'fake', musicCode: '09999' })
  }
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01002'])
  await sequence.dispose()
})

test('EOF event from an obsolete attempt cannot affect a newer current song', async () => {
  const { sequence, playback, scheduler } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const old = ready(sequence.getSnapshot()).current!
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  await beginCelebration(sequence, playback)
  await advanceCelebrationTimer(sequence, scheduler)
  await advanced
  playback.state = { status: 'completed', attemptId: old.attemptId, musicCode: old.musicCode }
  playback.emit({ type: 'natural-end-candidate', attemptId: old.attemptId, musicCode: old.musicCode, duration: 1, endedAt: new Date(3).toISOString() })
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  assert.deepEqual(playback.starts, ['01001', '01002'])
  await sequence.dispose()
})

test('late error and uncertain events for a prior attempt do not block the new current entry', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const old = ready(sequence.getSnapshot()).current!
  await sequence.execute({ operationId: 'next-stale-errors', command: { type: 'next' } })
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  playback.emit({ type: 'error', attemptId: old.attemptId, musicCode: old.musicCode, errorCode: 'PLAYBACK_FAILED' })
  playback.emit({ type: 'uncertain', attemptId: old.attemptId, musicCode: old.musicCode, reason: 'command-outcome-unknown' })
  const add = await submit(sequence, 'after-stale-events', '1003')
  assert.equal(add.outcome, 'confirmed')
  assert.equal(sequence.getSnapshot().playbackCondition, 'ready')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01003'])
  await sequence.dispose()
})

test('startup recovery remains blocked and does not autoplay or admit a song', async () => {
  const playback = new FakePlayback()
  const recoveryState: PlayerRecoverySnapshot = {
    status: 'pending', attemptId: 'recovery-attempt', musicCode: '01001', playbackStatus: 'playing',
    lastTransition: 'playback-started', updatedAt: new Date(0).toISOString()
  }
  const recovery: StandaloneRecoveryPort = {
    initialize: () => recoveryState,
    attachPlayback: () => undefined,
    getState: () => recoveryState,
    assertPlaybackAllowed: () => { throw new PlayerPlaybackError('RECOVERY_PENDING', 'Recovery decision required') },
    resolveInvalidRecovery: () => ({ state: recoveryState, preservedFileCount: 0 }),
    leaveStopped: async () => recoveryState,
    persistTransition: () => undefined,
    dispose: () => undefined
  }
  const sequence = await StandalonePlayerSequence.create({
    createPlayback: () => playback,
    recovery,
    onCoordinationError: () => undefined
  })
  assert.equal(sequence.getSnapshot().playbackCondition, 'blocked')
  const result = await submit(sequence, 'recovery-blocked-add', '1002')
  assert.equal(result.outcome, 'rejected')
  assert.deepEqual(playback.starts, [])
  const snapshot = sequence.getSnapshot()
  assert.equal(snapshot.playbackCondition, 'blocked')
  if (snapshot.playbackCondition === 'blocked') assert.deepEqual(snapshot.pending, [])
  await sequence.dispose()
})
