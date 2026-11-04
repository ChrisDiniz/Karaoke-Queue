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
  StandalonePlayerSnapshot,
  StandaloneRecoveryPort
} from '../src/standalone-player-contracts'
import type { PlayerRecoverySnapshot } from '../src/player-playback-recovery-contracts'
import { StandalonePlayerSequence } from '../src/standalone-player-sequence'

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
  pauseStarted: Deferred<void> | undefined
  pauseObservationGate: Deferred<void> | undefined
  resumeStarted: Deferred<void> | undefined
  resumeObservationGate: Deferred<void> | undefined
  nextSubscriptionAdded: Deferred<void> | undefined
  clearCompletedResult = true
  clearStoppedResult = true
  disposeCount = 0
  private attemptNumber = 0
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
    this.starts.push(code)
    this.startStarted.get(code)?.resolve()
    await this.startGates.get(code)?.promise
    const error = this.startErrors.shift()
    if (error) throw error
    const state = { status: 'playing' as const, attemptId: `attempt-${++this.attemptNumber}`, musicCode: code }
    this.state = state
    this.emit({ type: 'state-changed', state })
    return this.getState()
  }

  async pause(): Promise<PlayerPlaybackState> {
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
    this.stops.push(expectedAttemptId)
    this.stopStarted?.resolve(expectedAttemptId)
    await this.stopGate?.promise
    const stopError = this.stopErrors.shift()
    if (stopError) throw stopError
    if (expectedAttemptId && this.state.attemptId !== expectedAttemptId) {
      throw new PlayerPlaybackError('SUPERSEDED', 'Playback changed')
    }
    if (this.state.status === 'completed') throw new PlayerPlaybackError('SUPERSEDED', 'Natural completion won before Stop')
    const attemptId = expectedAttemptId ?? this.state.attemptId
    const musicCode = this.state.musicCode
    if (attemptId && musicCode) this.emit({ type: 'interrupted', attemptId, musicCode, reason: 'stop' })
    this.state = { status: 'stopped', ...(attemptId ? { attemptId } : {}), ...(musicCode ? { musicCode } : {}) }
    this.emit({ type: 'state-changed', state: this.getState() })
    return this.getState()
  }

  async clearCompletedMedia(attemptId: string): Promise<boolean> {
    this.clearedCompleted.push(attemptId)
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
async function build(options: { playback?: FakePlayback } = {}) {
  const playback = options.playback ?? new FakePlayback()
  const errors: unknown[] = []
  const sequence = await StandalonePlayerSequence.create({
    createPlayback: () => playback,
    createEntryId: () => `entry-${++entrySequence}`,
    onCoordinationError: error => errors.push(error)
  })
  return { playback, sequence, errors }
}

function submit(sequence: StandalonePlayerSequence, operationId: string, enteredCode: string,
  priority: 'normal' | 'priority' = 'normal'): Promise<StandalonePlayerCommandResult> {
  return sequence.execute({ operationId, command: { type: 'submit-code', enteredCode, priority } })
}

async function addCurrent(sequence: StandalonePlayerSequence, code = '1001'): Promise<StandalonePlayerCommandResult> {
  return submit(sequence, `add-${code}-${entrySequence}`, code)
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

test('first valid normal addition starts playback and commits it as current', async () => {
  const { sequence, playback } = await build()
  const result = await submit(sequence, 'first', '1001')
  assert.equal(result.outcome, 'confirmed')
  assert.deepEqual(playback.starts, ['01001'])
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01001')
  await sequence.dispose()
})

test('Next submitted during a technical start transition is rejected instead of falsely confirmed', async () => {
  const { sequence, playback } = await build()
  const gate = deferred<void>()
  playback.startGates.set('01001', gate)
  playback.startStarted.set('01001', deferred<void>())
  const add = submit(sequence, 'start-pending', '1001')
  await playback.startStarted.get('01001')!.promise
  const next = await sequence.execute({ operationId: 'next-during-start', command: { type: 'next' } })
  assert.equal(next.outcome, 'rejected')
  if (next.outcome === 'rejected') assert.equal(next.error.code, 'INVALID_STATE')
  gate.resolve()
  await add
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

test('EOF with pending music advances to the FIFO head', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  playback.endCurrent()
  await advanced
  assert.deepEqual(playback.starts, ['01001', '01002'])
  await sequence.dispose()
})

test('priority committed before EOF reservation takes precedence over older normal pending music', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'normal-next', '1002')
  await submit(sequence, 'priority-before-eof', '1111', 'priority')
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01111')
  playback.endCurrent()
  await advanced
  assert.deepEqual(playback.starts, ['01001', '01111'])
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01002'])
  await sequence.dispose()
})

test('EOF of the last song clears current and returns to idle', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const idle = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'idle')
  const ended = playback.endCurrent()
  await idle
  assert.deepEqual(playback.clearedCompleted, [ended.attemptId])
  await sequence.dispose()
})

test('dispose during a background EOF start settles the tracked effect and disposes playback once', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const gate = deferred<void>()
  playback.startGates.set('01002', gate)
  playback.startStarted.set('01002', deferred<void>())
  playback.endCurrent()
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

test('EOF reserved before a concurrent Next wins once and the stale Next does not skip the successor', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued-1', '1002')
  await submit(sequence, 'queued-2', '1003')
  const gate = deferred<void>()
  playback.startGates.set('01002', gate)
  playback.startStarted.set('01002', deferred<void>())
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  playback.endCurrent()
  await playback.startStarted.get('01002')!.promise
  const next = sequence.execute({ operationId: 'next-after-eof-reserve', command: { type: 'next' } })
  gate.resolve()
  await next
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
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued-1', '1002')
  await submit(sequence, 'queued-2', '1003')
  const current = ready(sequence.getSnapshot()).current!
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  playback.endCurrent()
  playback.emit({ type: 'natural-end-candidate', attemptId: current.attemptId, musicCode: current.musicCode, duration: 1, endedAt: new Date(2).toISOString() })
  await advanced
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01003'])
  assert.deepEqual(playback.starts, ['01001', '01002'])
  await sequence.dispose()
})

test('normal addition linearized before EOF becomes the next song', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const gate = deferred<void>()
  playback.validationStarted.set('01002', deferred<void>())
  playback.validateGates.set('01002', gate)
  const add = submit(sequence, 'add-before-eof', '1002')
  await playback.validationStarted.get('01002')!.promise
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  playback.endCurrent()
  gate.resolve()
  await add
  await advanced
  assert.equal(ready(sequence.getSnapshot()).current?.musicCode, '01002')
  await sequence.dispose()
})

test('priority committed after EOF reserved its head does not preempt that reserved next song', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'normal-next', '1002')
  const gate = deferred<void>()
  playback.validationStarted.set('01111', deferred<void>())
  playback.validateGates.set('01111', gate)
  const add = submit(sequence, 'priority-before-eof', '1111', 'priority')
  await playback.validationStarted.get('01111')!.promise
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  playback.endCurrent()
  gate.resolve()
  await add
  await advanced
  assert.deepEqual(playback.starts, ['01001', '01002'])
  assert.deepEqual(ready(sequence.getSnapshot()).pending.map(entry => entry.musicCode), ['01111'])
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
  assert.equal(result.outcome, 'blocked')
  assert.equal(result.snapshot.playbackCondition, 'blocked')
  assert.deepEqual(result.snapshot.pending.map(entry => entry.musicCode), ['01001'])
  assert.deepEqual(playback.starts, ['01001'])
  const retry = await submit(sequence, 'blocked-retry', '1002')
  assert.equal(retry.outcome, 'blocked')
  assert.deepEqual(playback.starts, ['01001'])
  assert.equal(sequence.getSnapshot().playbackCondition, 'blocked')
  await sequence.dispose()
})

test('known failure to start the next song blocks without dropping the reserved head', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  playback.startErrors.push(new PlayerPlaybackError('MEDIA_LOAD_FAILED', 'Next media failed'))
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'blocked')
  playback.endCurrent()
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
  assert.equal(result.outcome, 'uncertain')
  assert.equal(result.snapshot.playbackCondition, 'uncertain')
  assert.deepEqual(result.snapshot.pending.map(entry => entry.musicCode), ['01001'])
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

test('restart preserves the current entry identity and replaces only attemptId', async () => {
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  const before = ready(sequence.getSnapshot()).current!
  const result = await sequence.execute({ operationId: 'restart', command: { type: 'restart' } })
  const after = ready(sequence.getSnapshot()).current!
  assert.equal(result.outcome, 'confirmed')
  assert.equal(after.entryId, before.entryId)
  assert.notEqual(after.attemptId, before.attemptId)
  assert.equal(playback.starts.length, 1)
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
  const { sequence, playback } = await build()
  await addCurrent(sequence)
  await submit(sequence, 'queued', '1002')
  const old = ready(sequence.getSnapshot()).current!
  const advanced = waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === '01002')
  playback.endCurrent()
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
