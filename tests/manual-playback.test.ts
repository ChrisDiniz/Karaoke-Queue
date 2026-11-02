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
  readonly listeners = new Set<(event: import('../src/player-playback-contracts').PlayerPlaybackEvent) => void>()
  playResult: ((code: string) => Promise<PlayerPlaybackState>) | undefined
  playGate: ReturnType<typeof deferred<void>> | undefined
  validateResult: ((code: string) => Promise<void>) | undefined
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
  async stop(): Promise<PlayerPlaybackState> { this.calls.push('stop'); this.state = { ...this.state, status: 'stopped' }; return this.getState() }
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

test('sequence position changes only after the target playback is confirmed started', async () => {
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
  assert.deepEqual(engine.playedCodes, ['01001', '23242', '23242'],
    'while the start is unconfirmed, navigation must still target the same explicit next position')

  firstStart.resolve({ status: 'playing', attemptId: 'attempt-first', musicCode: '23242' })
  assert.equal((await pendingNext).outcome, 'started')
  deferStart = false
  assert.equal((await repeatedNext).outcome, 'started')
  assert.equal((await service.next()).outcome, 'started')
  assert.deepEqual(engine.playedCodes, ['01001', '23242', '23242', '00011'])
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
