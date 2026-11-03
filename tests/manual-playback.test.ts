import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ManualPlaybackService,
  type ManualPlaybackEngine
} from '../src/manual-playback-service'
import type { ManualPlaybackResult } from '../src/manual-playback-service'
import { PlayerPlaybackError, type PlayerPlaybackState } from '../src/player-playback-contracts'
import { isAuthorizedPlayerIpcSender } from '../src/player-ui-contracts'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

class PlaybackEngineDouble implements ManualPlaybackEngine {
  state: PlayerPlaybackState = { status: 'idle' }
  readonly playedCodes: string[] = []
  readonly calls: string[] = []
  readonly clearedMediaAttempts: string[] = []
  readonly clearedStoppedMediaAttempts: string[] = []
  readonly listeners = new Set<(event: import('../src/player-playback-contracts').PlayerPlaybackEvent) => void>()
  playResult: ((code: string) => Promise<PlayerPlaybackState>) | undefined
  playGate: ReturnType<typeof deferred<void>> | undefined
  validateResult: ((code: string) => Promise<void>) | undefined
  beforeStop: ((attemptId?: string) => void) | undefined
  readonly validatedCodes: string[] = []

  getState(): PlayerPlaybackState { return { ...this.state } }

  async playImmediately(code: string, validateBeforeCommit?: () => void): Promise<PlayerPlaybackState> {
    this.calls.push(`play:${code}`)
    if (this.playGate) await this.playGate.promise
    validateBeforeCommit?.()
    this.playedCodes.push(code)
    if (this.playResult) return this.playResult(code)
    this.state = { status: 'playing', attemptId: `attempt-${this.playedCodes.length}`, musicCode: code }
    return this.getState()
  }

  async validateMusicCode(code: string): Promise<void> {
    this.validatedCodes.push(code)
    await this.validateResult?.(code)
  }
  async clearCompletedMedia(attemptId: string): Promise<boolean> {
    this.clearedMediaAttempts.push(attemptId)
    return true
  }
  async clearStoppedMedia(attemptId: string): Promise<boolean> {
    this.clearedStoppedMediaAttempts.push(attemptId)
    if (this.state.status !== 'stopped' || this.state.attemptId !== attemptId) return false
    this.state = { status: 'idle' }
    return true
  }
  subscribe(listener: (event: import('../src/player-playback-contracts').PlayerPlaybackEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  naturalEnd(attemptId = this.state.attemptId, musicCode = this.state.musicCode): void {
    if (this.state.attemptId === attemptId) this.state = { status: 'completed', attemptId, musicCode }
    for (const listener of this.listeners) listener({ type: 'natural-end-candidate', attemptId: attemptId!,
      musicCode: musicCode!, duration: 10, endedAt: new Date().toISOString() })
  }

  async pause(): Promise<PlayerPlaybackState> { this.calls.push('pause'); this.state = { ...this.state, status: 'paused' }; return this.getState() }
  async resume(): Promise<PlayerPlaybackState> { this.calls.push('resume'); this.state = { ...this.state, status: 'playing' }; return this.getState() }
  async restart(): Promise<PlayerPlaybackState> { this.calls.push('restart'); this.state = { ...this.state, status: 'playing', attemptId: `restart-${this.calls.length}` }; return this.getState() }
  async stop(expectedAttemptId?: string): Promise<PlayerPlaybackState> {
    this.calls.push(expectedAttemptId ? `stop:${expectedAttemptId}` : 'stop')
    this.beforeStop?.(expectedAttemptId)
    if (expectedAttemptId && (this.state.attemptId !== expectedAttemptId || this.state.status === 'completed')) {
      throw new PlayerPlaybackError('SUPERSEDED', 'The playback attempt changed before Stop was confirmed.')
    }
    this.state = { ...this.state, status: 'stopped', containmentStatus: 'stop-acknowledged' }
    return this.getState()
  }
}

function makeService(engine = new PlaybackEngineDouble()) {
  return { engine, service: new ManualPlaybackService(engine) }
}

async function assertNoSequence(result: Promise<ManualPlaybackResult>): Promise<void> {
  const actual = await result
  assert.equal(actual.outcome, 'unavailable')
  if (actual.outcome === 'unavailable') assert.equal(actual.reason, 'NO_SEQUENCE')
}

test('manual code uses approved normalization and starts without catalog metadata', async () => {
  const { engine, service } = makeService()
  const result = await service.playByMusicCode('1001')
  assert.equal(result.outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['01001'])

  const fiveDigitResult = await service.playByMusicCode('23242')
  assert.equal(fiveDigitResult.outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['01001', '23242'])
})

test('local sequence adds normalized indexed selections, reorders and removes explicit items', async () => {
  const { service } = makeService()
  const first = await service.addToSequence('1001')
  const second = await service.addToSequence('23242')
  assert.equal(first.outcome, 'queued')
  assert.equal(second.outcome, 'queued')
  const snapshot = service.getSequence()
  assert.deepEqual(snapshot.pending.map(item => item.musicCode), ['01001', '23242'])
  assert.equal(service.reorderSequence([snapshot.pending[1].id, snapshot.pending[0].id]).outcome, 'accepted')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242', '01001'])
  assert.equal(service.removeFromSequence(snapshot.pending[1].id).outcome, 'accepted')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['01001'])
})

test('removing the current item confirms Stop and preserves pending songs without auto-advancing', async () => {
  const { engine, service } = makeService()
  const batch = await service.addBatchToSequence('1001 23242', 'remove-current-keeps-pending')
  assert.equal(batch.outcome, 'started')
  const before = service.getSequence()
  const current = before.current
  assert.ok(current)
  const activeAttemptId = engine.getState().attemptId
  assert.ok(activeAttemptId)

  const result = await service.removeCurrent(current.id, activeAttemptId)

  assert.equal(result.outcome, 'accepted')
  assert.equal(result.state.status, 'idle', 'confirmed Stop and media clearing return the UI to the idle state')
  assert.deepEqual(engine.calls.filter(call => call.startsWith('stop:')), [`stop:${activeAttemptId}`],
    'the removal must stop only the attempt it was opened for')
  assert.deepEqual(engine.clearedStoppedMediaAttempts, [activeAttemptId],
    'the stopped media may be cleared only after Stop ACK for the expected attempt')
  assert.equal(service.getSequence().current, null)
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'],
    'pending songs remain queued and are not started as a side effect of manual removal')
  assert.deepEqual(engine.playedCodes, ['01001'])
})

test('removing a manually started song confirms Stop without mutating pending items', async () => {
  const { engine, service } = makeService()
  const started = await service.playByMusicCode('1001')
  assert.equal(started.outcome, 'started')
  const queued = await service.addToSequence('23242')
  assert.equal(queued.outcome, 'queued')
  const attemptId = engine.getState().attemptId
  assert.ok(attemptId)
  const pendingBefore = service.getSequence().pending.map(item => ({ ...item }))

  const result = await service.removeCurrent(null, attemptId)

  assert.equal(result.outcome, 'accepted')
  assert.equal(result.state.status, 'idle', 'the manually started video is cleared after Stop ACK')
  assert.equal(service.getSequence().current, null, 'a standalone song does not become a sequence item when removed')
  assert.deepEqual(service.getSequence().pending, pendingBefore, 'removal preserves the explicit pending items')
  assert.deepEqual(engine.calls.filter(call => call.startsWith('stop:')), [`stop:${attemptId}`],
    'standalone removal must stop only its correlated active attempt')
  assert.deepEqual(engine.clearedStoppedMediaAttempts, [attemptId])
  assert.deepEqual(engine.playedCodes, ['01001'], 'manual removal must not auto-start a pending item')
})

test('a natural EOF racing with current-item removal never auto-advances the pending sequence', async () => {
  const engine = new PlaybackEngineDouble()
  const service = new ManualPlaybackService(engine, { autoAdvanceOnNaturalEnd: true })
  const batch = await service.addBatchToSequence('1001 23242', 'remove-current-eof-race')
  assert.equal(batch.outcome, 'started')
  const current = service.getSequence().current
  assert.ok(current)
  const attemptId = engine.getState().attemptId
  assert.ok(attemptId)

  engine.beforeStop = selectedAttemptId => engine.naturalEnd(selectedAttemptId, '01001')
  const result = await service.removeCurrent(current.id, attemptId)

  assert.notEqual(result.outcome, 'accepted', 'the removal cannot claim Stop after a natural EOF already won the race')
  assert.equal(service.getStatus().status, 'completed', 'the confirmed natural ending remains a completion outcome')
  assert.equal(service.getSequence().current, null, 'the naturally ended item is cleared from the current position')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'],
    'the next item remains pending until an explicit action after the removal race')
  assert.deepEqual(engine.playedCodes, ['01001'], 'the removal race must not start the pending item')
  assert.deepEqual(engine.clearedMediaAttempts, [attemptId], 'the naturally ended media is cleared for the matching attempt')
})

test('stale current-item removal cannot stop or remove a newer playback attempt', async () => {
  const { engine, service } = makeService()
  const batch = await service.addBatchToSequence('1001 23242', 'remove-current-stale-attempt')
  assert.equal(batch.outcome, 'started')
  const oldCurrent = service.getSequence().current
  assert.ok(oldCurrent)
  const oldAttemptId = engine.getState().attemptId
  assert.ok(oldAttemptId)

  engine.state = { status: 'playing', attemptId: 'newer-attempt', musicCode: '33333' }
  const result = await service.removeCurrent(oldCurrent.id, oldAttemptId)

  assert.notEqual(result.outcome, 'accepted', 'a confirmation for an obsolete attempt must be rejected')
  assert.equal(engine.calls.includes('stop:newer-attempt'), false,
    'stale confirmation must not send Stop to the newer attempt')
  assert.equal(engine.getState().attemptId, 'newer-attempt')
  assert.equal(service.getSequence().current?.id, oldCurrent.id,
    'a rejected stale operation must not mutate sequence ownership')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'])
})

test('concurrent sequence additions preserve invocation order when validation has different latency', async () => {
  const { engine, service } = makeService()
  const firstValidation = deferred<void>()
  engine.validateResult = code => code === '01001' ? firstValidation.promise : Promise.resolve()
  const first = service.addToSequence('1001')
  const second = service.addToSequence('23242')
  await Promise.resolve()
  assert.deepEqual(engine.validatedCodes, ['01001'], 'later additions wait behind the earlier explicit selection')
  firstValidation.resolve()
  assert.deepEqual((await Promise.all([first, second])).map(result => result.outcome), ['queued', 'queued'])
  assert.deepEqual(engine.validatedCodes, ['01001', '23242'])
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['01001', '23242'])
})

test('local Player starts the next explicit sequence item only after one valid natural EOF', async () => {
  const { engine } = makeService()
  const service = new ManualPlaybackService(engine, { autoAdvanceOnNaturalEnd: true })
  await service.playByMusicCode('1001')
  await service.addToSequence('23242')
  const endedAttempt = engine.state.attemptId
  engine.naturalEnd()
  engine.naturalEnd(endedAttempt, '01001')
  await Promise.resolve()
  assert.deepEqual(engine.playedCodes, ['01001', '23242'], 'duplicate EOF must not start the same pending item twice')
  assert.deepEqual(service.getSequence().pending, [])
  assert.equal(service.getStatus().musicCode, '23242')
  assert.deepEqual(engine.clearedMediaAttempts, [], 'EOF with a next item replaces the media instead of clearing the active surface')
})

test('a valid EOF during a manual Next whose replacement fails is still finalized exactly once', async () => {
  const { engine } = makeService()
  const service = new ManualPlaybackService(engine, { autoAdvanceOnNaturalEnd: true })
  const batch = await service.addBatchToSequence('1001 23242', 'eof-during-failed-next')
  assert.equal(batch.outcome, 'started')
  const endedAttempt = engine.getState().attemptId
  assert.ok(endedAttempt)

  engine.playGate = deferred<void>()
  engine.playResult = async () => {
    throw new PlayerPlaybackError('MEDIA_UNAVAILABLE', 'The next indexed video became unavailable.')
  }
  const next = service.next()
  engine.naturalEnd(endedAttempt, '01001')
  engine.playGate.resolve()
  const nextResult = await next

  assert.notEqual(nextResult.outcome, 'started', 'a failed replacement must not claim that the next song started')
  assert.equal(service.getStatus().status, 'completed', 'the valid ended attempt remains naturally completed')
  assert.equal(service.getStatus().attemptId, endedAttempt)
  assert.equal(service.getSequence().current, null, 'the ended item must not remain shown as the current song')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'],
    'a failed next item remains explicitly pending and is not silently skipped')
  assert.deepEqual(engine.clearedMediaAttempts, [endedAttempt],
    'the valid EOF is finalized and the stale last frame is cleared exactly once')
  assert.deepEqual(engine.playedCodes, ['01001', '23242'],
    'the explicit Next is attempted once, and the valid EOF must not trigger a duplicate automatic retry')
})

test('automatic transition protects its starting item while allowing later sequence edits', async () => {
  const { engine } = makeService()
  const service = new ManualPlaybackService(engine, { autoAdvanceOnNaturalEnd: true })
  await service.playByMusicCode('1001')
  await service.addToSequence('23242')
  await service.addToSequence('33333')
  await service.addToSequence('44444')
  const before = service.getSequence()
  const startingItem = before.pending[0]
  assert.ok(startingItem)
  engine.playGate = deferred<void>()
  engine.naturalEnd()

  const blockedRemoval = service.removeFromSequence(startingItem.id)
  assert.equal(blockedRemoval.outcome, 'unavailable')
  if (blockedRemoval.outcome === 'unavailable') assert.equal(blockedRemoval.reason, 'SEQUENCE_ITEM_STARTING')
  const blockedClear = service.clearSequence()
  assert.equal(blockedClear.outcome, 'unavailable')
  if (blockedClear.outcome === 'unavailable') assert.equal(blockedClear.reason, 'SEQUENCE_ITEM_STARTING')
  const blockedReorder = service.reorderSequence([before.pending[1].id, startingItem.id, before.pending[2].id])
  assert.equal(blockedReorder.outcome, 'unavailable')
  if (blockedReorder.outcome === 'unavailable') assert.equal(blockedReorder.reason, 'SEQUENCE_ITEM_STARTING')
  assert.equal(service.removeFromSequence(before.pending[2].id).outcome, 'accepted')
  assert.equal(service.reorderSequence([startingItem.id, before.pending[1].id]).outcome, 'accepted')

  engine.playGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(engine.playedCodes, ['01001', '23242'])
  assert.equal(service.getSequence().current?.musicCode, '23242')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['33333'])
})

test('a batch appended while Next is starting a reserved item remains after that item', async () => {
  const { engine } = makeService()
  const service = new ManualPlaybackService(engine)
  await service.playByMusicCode('1001')
  await service.addToSequence('23242')

  const reserved = service.getSequence().pending[0]
  assert.ok(reserved)
  engine.playGate = deferred<void>()
  const next = service.next()

  assert.deepEqual(engine.calls.filter(call => call === 'play:23242'), ['play:23242'])
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'])

  const batch = await service.addBatchToSequence('33333', 'batch-while-next-starts')
  assert.equal(batch.outcome, 'queued')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242', '33333'])

  const removal = service.removeFromSequence(reserved.id)
  assert.equal(removal.outcome, 'unavailable')
  if (removal.outcome === 'unavailable') assert.equal(removal.reason, 'SEQUENCE_ITEM_STARTING')
  const reorder = service.reorderSequence([service.getSequence().pending[1].id, reserved.id])
  assert.equal(reorder.outcome, 'unavailable')
  if (reorder.outcome === 'unavailable') assert.equal(reorder.reason, 'SEQUENCE_ITEM_STARTING')

  engine.playGate.resolve()
  const started = await next

  assert.equal(started.outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['01001', '23242'], 'the reserved item starts exactly once')
  assert.equal(service.getSequence().current?.id, reserved.id)
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['33333'])
})

test('Next and Previous cannot duplicate a song while natural-end auto-advance is starting it', async () => {
  const { engine } = makeService()
  const service = new ManualPlaybackService(engine, { autoAdvanceOnNaturalEnd: true })
  await service.playByMusicCode('1001')
  await service.addToSequence('23242')
  const pending = service.getSequence().pending[0]
  assert.ok(pending)
  engine.playGate = deferred<void>()
  engine.naturalEnd()
  assert.equal((await service.next()).outcome, 'unavailable')
  assert.equal((await service.previous()).outcome, 'unavailable')
  assert.deepEqual(engine.calls.filter(call => call === 'play:23242'), ['play:23242'])
  engine.playGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.getSequence().current?.id, pending.id)
  assert.deepEqual(engine.playedCodes, ['01001', '23242'])
})

test('Player IPC sender check requires the registered top-level application window', () => {
  const valid = {
    playerEnabled: true, senderWebContentsId: 5, expectedWebContentsId: 5,
    isMainFrame: true, frameUrl: 'file:///app/src/index.html', expectedDocumentUrl: 'file:///app/src/index.html'
  }
  assert.equal(isAuthorizedPlayerIpcSender(valid), true)
  assert.equal(isAuthorizedPlayerIpcSender({ ...valid, senderWebContentsId: 6 }), false)
  assert.equal(isAuthorizedPlayerIpcSender({ ...valid, expectedWebContentsId: undefined }), false)
  assert.equal(isAuthorizedPlayerIpcSender({ ...valid, isMainFrame: false }), false)
  assert.equal(isAuthorizedPlayerIpcSender({ ...valid, frameUrl: 'file:///app/other.html' }), false)
  assert.equal(isAuthorizedPlayerIpcSender({ ...valid, playerEnabled: false }), false)
})

test('stop and stale natural EOF never advance the local sequence', async () => {
  const { engine } = makeService()
  const service = new ManualPlaybackService(engine, { autoAdvanceOnNaturalEnd: true })
  await service.playByMusicCode('1001')
  await service.addToSequence('23242')
  const staleAttempt = engine.state.attemptId
  await service.stop()
  engine.naturalEnd(staleAttempt, '01001')
  assert.deepEqual(engine.playedCodes, ['01001'])
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'])
})

test('manual Play Now preserves other explicit items and consumes one matching queued occurrence', async () => {
  const { engine, service } = makeService()
  await service.addToSequence('1001')
  await service.addToSequence('23242')
  assert.equal((await service.playByMusicCode('1001')).outcome, 'started')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'])
  assert.equal((await service.playByMusicCode('11')).outcome, 'started')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'])
  assert.deepEqual(engine.playedCodes, ['01001', '00011'])
})

test('invalid identifiers are rejected without dispatching playback', async () => {
  const { engine, service } = makeService()
  for (const value of ['', ' 1001', '01001', '100100', 1001, 'abc']) {
    const result = await service.playByMusicCode(value)
    assert.equal(result.outcome, 'failed')
    if (result.outcome === 'failed') assert.equal(result.reason, 'INVALID_MUSIC_NUMBER')
  }
  assert.deepEqual(engine.calls, [])
})

test('playback engine failures are translated into unavailable and uncertain results', async () => {
  const hostEngine = new PlaybackEngineDouble()
  hostEngine.playResult = async () => { throw new PlayerPlaybackError('HOST_UNAVAILABLE', 'no host') }
  const hostService = new ManualPlaybackService(hostEngine)
  const hostResult = await hostService.playByMusicCode('1001')
  assert.equal(hostResult.outcome, 'unavailable')
  if (hostResult.outcome === 'unavailable') assert.equal(hostResult.reason, 'HOST_UNAVAILABLE')

  const uncertainEngine = new PlaybackEngineDouble()
  uncertainEngine.state = { status: 'uncertain', errorCode: 'COMMAND_TIMEOUT', containmentStatus: 'unconfirmed' }
  uncertainEngine.playResult = async () => { throw new PlayerPlaybackError('COMMAND_TIMEOUT', 'ack unknown') }
  const uncertainResult = await new ManualPlaybackService(uncertainEngine).playByMusicCode('1001')
  assert.equal(uncertainResult.outcome, 'uncertain')
  if (uncertainResult.outcome === 'uncertain') assert.equal(uncertainResult.state.containmentStatus, 'unconfirmed')
})

test('Next and Previous are unavailable without a sequence and never guess adjacent codes', async () => {
  const { engine, service } = makeService()
  await assertNoSequence(service.next())
  await assertNoSequence(service.previous())
  assert.deepEqual(engine.calls, [])

  await service.playByMusicCode('1001')
  await assertNoSequence(service.next())
  assert.deepEqual(engine.playedCodes, ['01001'])
})

test('sequence navigation follows explicit entries and does not wrap at either boundary', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('100')
  service.setNavigationSequence(['100', '23242', '11'], 0)

  assert.equal((await service.previous()).outcome, 'boundary')
  assert.deepEqual(engine.playedCodes, ['00100'])
  assert.equal((await service.next()).outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['00100', '23242'])
  assert.equal((await service.next()).outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['00100', '23242', '00011'])
  const endBoundary = await service.next()
  assert.equal(endBoundary.outcome, 'boundary')
  if (endBoundary.outcome === 'boundary') assert.equal(endBoundary.reason, 'SEQUENCE_BOUNDARY')
  assert.equal((await service.previous()).outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['00100', '23242', '00011', '23242'])
})

test('duplicate codes remain distinct explicit sequence positions', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  service.setNavigationSequence(['1001', '1001', '23242'], 0)

  assert.equal((await service.next()).outcome, 'started')
  assert.equal((await service.next()).outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['01001', '01001', '23242'])
})

test('invalid sequence entries reject the whole update without skipping or replacing the old sequence', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  service.setNavigationSequence(['1001', '23242'], 0)
  assert.throws(() => service.setNavigationSequence(['1001', 'bad', '23242'], 0), PlayerPlaybackError)
  assert.equal((await service.next()).outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['01001', '23242'])
})

test('manual selection outside the current sequence clears navigation context', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  service.setNavigationSequence(['1001', '23242'], 0)
  await service.playByMusicCode('11')
  await assertNoSequence(service.next())
  assert.deepEqual(engine.playedCodes, ['01001', '00011'])
})

test('manual selection clears the old sequence when a new attempt fails after replacing the selected code', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  service.setNavigationSequence(['1001', '23242'], 0)
  engine.playResult = async code => {
    engine.state = { status: 'failed', attemptId: 'failed-new-attempt', musicCode: code, errorCode: 'MEDIA_LOAD_FAILED' }
    throw new PlayerPlaybackError('MEDIA_LOAD_FAILED', 'media failed after replacement')
  }

  const result = await service.playByMusicCode('11')
  assert.equal(result.outcome, 'failed')
  await assertNoSequence(service.next())
  assert.deepEqual(engine.playedCodes, ['01001', '00011'])
})

test('manual selection clears a new sequence installed while playback startup is pending when its cursor no longer matches', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  service.setNavigationSequence(['1001', '23242'], 0)

  const starting = deferred<PlayerPlaybackState>()
  engine.playResult = async code => {
    assert.equal(code, '00011')
    return starting.promise
  }
  const pendingSelection = service.playByMusicCode('11')

  // This is a fresh context for the still-current old selection. The pending
  // manual selection must clear it after 00011 becomes the active playback.
  service.setNavigationSequence(['1001', '23242'], 0)
  starting.resolve({ status: 'playing', attemptId: 'manual-selection', musicCode: '00011' })

  assert.equal((await pendingSelection).outcome, 'started')
  await assertNoSequence(service.next())
  assert.deepEqual(engine.playedCodes, ['01001', '00011'])
})

test('Next clears a replacement sequence installed during pending navigation when its cursor no longer matches the started code', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  service.setNavigationSequence(['1001', '23242', '11'], 0)

  const starting = deferred<PlayerPlaybackState>()
  engine.playResult = async code => {
    assert.equal(code, '23242')
    return starting.promise
  }
  const pendingNext = service.next()

  // Replace the navigation context while the old Next still targets 23242.
  // Its selected position remains aligned with A until that pending start wins.
  service.setNavigationSequence(['1001', '11'], 0)
  starting.resolve({ status: 'playing', attemptId: 'next-b', musicCode: '23242' })

  assert.equal((await pendingNext).outcome, 'started')
  await assertNoSequence(service.next())
  assert.deepEqual(engine.playedCodes, ['01001', '23242'])
})

test('failed pending Next clears a replacement sequence anchored to the previous selection', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  service.setNavigationSequence(['1001', '23242'], 0)

  const starting = deferred<PlayerPlaybackState>()
  engine.playResult = async code => {
    assert.equal(code, '23242')
    return starting.promise
  }
  const pendingNext = service.next()
  service.setNavigationSequence(['1001', '11'], 0)
  engine.state = { status: 'failed', attemptId: 'failed-next-b', musicCode: '23242', errorCode: 'MEDIA_LOAD_FAILED' }
  starting.reject(new PlayerPlaybackError('MEDIA_LOAD_FAILED', 'B failed before playback started'))

  const result = await pendingNext
  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') assert.equal(result.reason, 'MEDIA_LOAD_FAILED')
  await assertNoSequence(service.next())
  assert.deepEqual(engine.playedCodes, ['01001', '23242'])
})

test('concurrent Next commands do not start the same sequence item more than once', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  service.setNavigationSequence(['1001', '23242', '11'], 0)
  const firstStart = deferred<PlayerPlaybackState>()
  let deferStart = true
  engine.playResult = async code => {
    if (deferStart && code === '23242') return firstStart.promise
    engine.state = { status: 'playing', attemptId: `attempt-${engine.calls.length}`, musicCode: code }
    return engine.getState()
  }

  const pendingNext = service.next()
  assert.deepEqual(engine.playedCodes, ['01001', '23242'])
  const repeatedNext = service.next()
  const repeatedResult = await repeatedNext
  assert.equal(repeatedResult.outcome, 'unavailable')
  if (repeatedResult.outcome === 'unavailable') assert.equal(repeatedResult.reason, 'SEQUENCE_ITEM_STARTING')
  assert.deepEqual(engine.playedCodes, ['01001', '23242'],
    'while the start is unconfirmed, a repeated Next must not restart the same explicit item')

  firstStart.resolve({ status: 'playing', attemptId: 'attempt-first', musicCode: '23242' })
  assert.equal((await pendingNext).outcome, 'started')
  deferStart = false
  assert.equal((await service.next()).outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['01001', '23242', '00011'])
})

test('concurrent Previous commands do not start the same sequence item more than once', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('23242')
  service.setNavigationSequence(['1001', '23242', '11'], 1)
  const firstStart = deferred<PlayerPlaybackState>()
  engine.playResult = async code => {
    if (code === '01001') return firstStart.promise
    engine.state = { status: 'playing', attemptId: `attempt-${engine.calls.length}`, musicCode: code }
    return engine.getState()
  }

  const pendingPrevious = service.previous()
  assert.deepEqual(engine.playedCodes, ['23242', '01001'])
  const repeatedPrevious = await service.previous()
  assert.equal(repeatedPrevious.outcome, 'unavailable')
  if (repeatedPrevious.outcome === 'unavailable') assert.equal(repeatedPrevious.reason, 'SEQUENCE_ITEM_STARTING')
  assert.deepEqual(engine.playedCodes, ['23242', '01001'],
    'while a previous item is starting, repeated navigation must not restart that item')

  firstStart.resolve({ status: 'playing', attemptId: 'attempt-previous', musicCode: '01001' })
  assert.equal((await pendingPrevious).outcome, 'started')
  assert.equal((await service.previous()).outcome, 'boundary')
  assert.deepEqual(engine.playedCodes, ['23242', '01001'])
})

test('manual controls delegate to the single playback engine', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  assert.equal((await service.pause()).outcome, 'accepted')
  assert.equal((await service.resume()).outcome, 'accepted')
  assert.equal((await service.restart()).outcome, 'accepted')
  assert.equal((await service.stop()).outcome, 'accepted')
  assert.deepEqual(engine.calls, ['play:01001', 'pause', 'resume', 'restart', 'stop'])
})

test('manual selection matching the current explicit position preserves navigation', async () => {
  const { engine, service } = makeService()
  await service.playByMusicCode('1001')
  service.setNavigationSequence(['1001', '23242'], 0)
  assert.equal((await service.playByMusicCode('1001')).outcome, 'started')
  assert.equal((await service.next()).outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['01001', '01001', '23242'])
})

test('disposed manual service rejects future commands', async () => {
  const { engine, service } = makeService()
  service.dispose()
  await assert.rejects(service.playByMusicCode('1001'), PlayerPlaybackError)
  assert.deepEqual(engine.calls, [])
})

test('a valid batch preserves code order and starts only its first item when idle', async () => {
  const { engine, service } = makeService()

  const result = await service.addBatchToSequence('1001, 23242\n33333 44444', 'batch-ordered')

  assert.equal(result.outcome, 'started')
  assert.deepEqual(result.acceptedCodes, ['01001', '23242', '33333', '44444'])
  assert.deepEqual(engine.validatedCodes, ['01001', '23242', '33333', '44444'])
  assert.deepEqual(engine.calls, ['play:01001'])
  assert.deepEqual(service.getSequence().current?.musicCode, '01001')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242', '33333', '44444'])
})

test('a batch validates atomically and reports invalid entries without changing an existing sequence', async () => {
  const { engine, service } = makeService()
  await service.addToSequence('55555')
  const before = service.getSequence()
  engine.validateResult = async code => {
    if (code === '23242') throw new PlayerPlaybackError('MEDIA_UNKNOWN', 'indexed video not found')
  }

  const result = await service.addBatchToSequence('1001, invalid, 23242', 'batch-invalid')

  assert.equal(result.outcome, 'failed')
  assert.deepEqual(result.invalidEntries?.map(entry => entry.value), ['invalid', '23242'])
  assert.deepEqual(service.getSequence(), before, 'no valid prefix may be committed when any item fails validation')
  assert.deepEqual(engine.calls, [])
})

test('the same batch request id is idempotent, while distinct submissions can intentionally repeat a code', async () => {
  const { engine, service } = makeService()
  const first = await service.addBatchToSequence('1001, 23242', 'batch-idempotency')
  const stateAfterFirst = service.getSequence()
  const callCountAfterFirst = engine.calls.length

  const retry = await service.addBatchToSequence('1001, 23242', 'batch-idempotency')
  assert.deepEqual(retry, first, 'retrying a logical request returns the cached result')
  assert.deepEqual(service.getSequence(), stateAfterFirst)
  assert.equal(engine.calls.length, callCountAfterFirst)

  const conflictingRetry = await service.addBatchToSequence('33333', 'batch-idempotency')
  assert.equal(conflictingRetry.outcome, 'failed')
  assert.equal(conflictingRetry.reason, 'REQUEST_ID_CONFLICT')
  assert.deepEqual(service.getSequence(), stateAfterFirst)

  const intentionalDuplicate = await service.addBatchToSequence('1001', 'batch-distinct-repeat')
  assert.equal(intentionalDuplicate.outcome, 'queued')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242', '01001'])
  assert.equal(engine.calls.filter(call => call.startsWith('play:')).length, 1)
})

test('concurrent retries of the same batch request share one validation and one playback effect', async () => {
  const { engine, service } = makeService()
  const validation = deferred<void>()
  engine.validateResult = () => validation.promise

  const original = service.addBatchToSequence('1001 23242', 'batch-in-flight')
  const retry = service.addBatchToSequence('1001 23242', 'batch-in-flight')
  await Promise.resolve()
  assert.deepEqual(engine.calls, [], 'no playback side effect may occur before batch validation completes')

  validation.resolve()
  const [firstResult, retryResult] = await Promise.all([original, retry])

  assert.deepEqual(retryResult, firstResult)
  assert.deepEqual(engine.validatedCodes, ['01001', '23242'], 'same request retry must not repeat batch validation')
  assert.equal(engine.calls.filter(call => call === 'play:01001').length, 1)
  assert.deepEqual(service.getSequence().current?.musicCode, '01001')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'])
})

test('batch additions during playback or pause append without interrupting or starting another item', async t => {
  for (const paused of [false, true]) {
    await t.test(paused ? 'paused' : 'playing', async () => {
      const { engine, service } = makeService()
      await service.playByMusicCode('55555')
      if (paused) await service.pause()
      const callsBefore = [...engine.calls]
      const stateBefore = engine.getState()

      const result = await service.addBatchToSequence('1001 23242', `batch-active-${paused}`)

      assert.equal(result.outcome, 'queued')
      assert.deepEqual(engine.calls, callsBefore, 'adding to the sequence cannot stop or replace active playback')
      assert.deepEqual(engine.getState(), stateBefore, 'the current state and attempt are preserved')
      assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['01001', '23242'])
    })
  }
})

test('a batch during media preparation queues without being treated as idle', async () => {
  const engine = new PlaybackEngineDouble()
  engine.state = { status: 'loading', attemptId: 'preparing-attempt', musicCode: '05555' }
  const service = new ManualPlaybackService(engine)

  const result = await service.addBatchToSequence('1001 23242', 'batch-preparing')

  assert.equal(result.outcome, 'queued')
  assert.deepEqual(engine.calls, [], 'preparing playback must not be replaced by an add action')
  assert.deepEqual(engine.getState(), { status: 'loading', attemptId: 'preparing-attempt', musicCode: '05555' })
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['01001', '23242'])
})

test('a batch cannot start playback while recovery outcome is uncertain', async () => {
  const engine = new PlaybackEngineDouble()
  engine.state = { status: 'uncertain', errorCode: 'RECOVERY_PENDING', containmentStatus: 'unconfirmed' }
  const service = new ManualPlaybackService(engine)

  const result = await service.addBatchToSequence('1001', 'batch-recovery-blocked')

  assert.ok(result.outcome === 'unavailable' || result.outcome === 'uncertain')
  assert.notEqual(result.outcome, 'started')
  assert.notEqual(result.outcome, 'queued')
  assert.deepEqual(service.getSequence().pending, [])
  assert.deepEqual(engine.validatedCodes, [])
  assert.deepEqual(engine.calls, [])
})

test('a batch still starts explicitly when its validation completes after a natural EOF', async () => {
  const { engine } = makeService()
  const service = new ManualPlaybackService(engine, { autoAdvanceOnNaturalEnd: true })
  await service.playByMusicCode('1001')
  const validation = deferred<void>()
  engine.validateResult = code => code === '23242' ? validation.promise : Promise.resolve()

  const batch = service.addBatchToSequence('23242', 'batch-racing-final-eof')
  await Promise.resolve()
  assert.deepEqual(engine.validatedCodes, ['23242'])
  const endedAttempt = engine.state.attemptId
  engine.naturalEnd(endedAttempt, '01001')
  assert.equal(service.getSequence().current, null)

  validation.resolve()
  const result = await batch
  assert.equal(result.outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['01001', '23242'])
  assert.equal(service.getSequence().current?.musicCode, '23242')
  assert.deepEqual(service.getSequence().pending, [])
})

test('a batch validated during pending EOF auto-advance appends after the reserved item without starting it twice', async () => {
  const { engine } = makeService()
  const service = new ManualPlaybackService(engine, { autoAdvanceOnNaturalEnd: true })
  await service.playByMusicCode('1001')
  await service.addToSequence('23242')

  const autoAdvanceStart = deferred<void>()
  engine.playGate = autoAdvanceStart
  const endedAttempt = engine.state.attemptId
  engine.naturalEnd(endedAttempt, '01001')

  assert.equal(engine.getState().status, 'completed', 'the next-item start remains unacknowledged behind the controlled gate')
  assert.deepEqual(engine.calls.filter(call => call === 'play:23242'), ['play:23242'])
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242'])

  const batchValidation = deferred<void>()
  engine.validateResult = code => code === '33333' ? batchValidation.promise : Promise.resolve()
  const batch = service.addBatchToSequence('33333', 'batch-during-auto-advance')
  await Promise.resolve()
  assert.equal(engine.validatedCodes.at(-1), '33333')
  assert.equal(engine.getState().status, 'completed')

  batchValidation.resolve()
  const result = await batch
  assert.equal(result.outcome, 'queued')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['23242', '33333'])
  assert.deepEqual(engine.calls.filter(call => call === 'play:23242'), ['play:23242'],
    'the batch must not issue a second start for the item already reserved by EOF auto-advance')

  autoAdvanceStart.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(engine.playedCodes, ['01001', '23242'])
  assert.equal(service.getSequence().current?.musicCode, '23242')
  assert.deepEqual(service.getSequence().pending.map(item => item.musicCode), ['33333'])
})

test('final natural EOF clears the selected song once and a stale EOF cannot clear a newer selection', async () => {
  const { engine } = makeService()
  const service = new ManualPlaybackService(engine, { autoAdvanceOnNaturalEnd: true })

  const firstBatch = await service.addBatchToSequence('1001', 'batch-final-eof-first')
  assert.equal(firstBatch.outcome, 'started')
  const firstAttempt = engine.state.attemptId
  engine.naturalEnd(firstAttempt, '01001')
  assert.equal(service.getSequence().current, null)
  assert.deepEqual(service.getSequence().pending, [])
  assert.equal(service.getStatus().status, 'completed', 'natural completion remains distinct from Stop')
  assert.deepEqual(engine.clearedMediaAttempts, [firstAttempt])

  const secondBatch = await service.addBatchToSequence('23242', 'batch-final-eof-second')
  assert.equal(secondBatch.outcome, 'started')
  const secondCurrent = service.getSequence().current
  assert.equal(secondCurrent?.musicCode, '23242')

  engine.naturalEnd(firstAttempt, '01001')
  assert.equal(service.getSequence().current?.id, secondCurrent?.id,
    'a duplicate event for the completed attempt cannot clear the newer current item')
  assert.deepEqual(engine.clearedMediaAttempts, [firstAttempt], 'the old attempt is asked to clear its media only once')
  assert.equal(service.getStatus().attemptId, engine.state.attemptId)
  assert.equal(service.getStatus().status, 'playing')
})
