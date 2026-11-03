import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PlayerPlaybackError, type PlayerPlaybackEvent, type PlayerPlaybackHost, type PlayerPlaybackHostCommand, type PlayerPlaybackHostEvent, type PlayerPlaybackListener } from '../src/player-playback-contracts'
import { PlayerPlaybackService } from '../src/player-playback-service'
import { VideoLibraryService } from '../src/video-library-service'

class ControlledHost implements PlayerPlaybackHost {
  readonly hostEpoch = 'test-host-epoch'
  readonly ready: Promise<void>
  readonly commands: PlayerPlaybackHostCommand[] = []
  disposed = false
  nextLoadAcknowledgement: Promise<void> | undefined
  nextPlayAcknowledgement: Promise<void> | undefined
  nextPauseAcknowledgement: Promise<void> | undefined
  nextStopAcknowledgement: Promise<void> | undefined
  nextClearError: Error | undefined
  terminateCalls = 0
  terminationConfirmed = true
  emitTerminationOnTerminate = true
  private readonly listeners = new Set<(event: PlayerPlaybackHostEvent) => void>()
  private readonly commandWaiters = new Map<string, Array<(command: PlayerPlaybackHostCommand) => void>>()

  constructor(ready: Promise<void> = Promise.resolve()) {
    this.ready = ready
  }

  async send(command: PlayerPlaybackHostCommand): Promise<void> {
    this.commands.push(command)
    for (const waiter of this.commandWaiters.get(command.type) ?? []) waiter(command)
    this.commandWaiters.delete(command.type)
    if (command.type === 'load' && this.nextLoadAcknowledgement) await this.nextLoadAcknowledgement
    if (command.type === 'play' && this.nextPlayAcknowledgement) await this.nextPlayAcknowledgement
    if (command.type === 'pause' && this.nextPauseAcknowledgement) await this.nextPauseAcknowledgement
    if (command.type === 'stop' && this.nextStopAcknowledgement) await this.nextStopAcknowledgement
    if (command.type === 'clear' && this.nextClearError) throw this.nextClearError
  }

  whenCommand(type: PlayerPlaybackHostCommand['type']): Promise<PlayerPlaybackHostCommand> {
    const existing = this.commands.slice().reverse().find(command => command.type === type)
    if (existing) return Promise.resolve(existing)
    return new Promise(resolve => {
      const waiters = this.commandWaiters.get(type) ?? []
      waiters.push(resolve)
      this.commandWaiters.set(type, waiters)
    })
  }

  whenNextCommand(type: PlayerPlaybackHostCommand['type']): Promise<PlayerPlaybackHostCommand> {
    return new Promise(resolve => {
      const waiters = this.commandWaiters.get(type) ?? []
      waiters.push(resolve)
      this.commandWaiters.set(type, waiters)
    })
  }

  subscribe(listener: (event: PlayerPlaybackHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: PlayerPlaybackHostEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  media(attemptId: string, sequenceNumber: number, observation: Extract<PlayerPlaybackHostEvent, { type: 'media' }>['observation']): void {
    this.emit({ type: 'media', hostEpoch: this.hostEpoch, attemptId, sequenceNumber, observation })
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  async terminate(): Promise<boolean> {
    this.terminateCalls++
    if (this.emitTerminationOnTerminate) this.emit({ type: 'terminated', hostEpoch: this.hostEpoch })
    return this.terminationConfirmed
  }
}

function makeLibrary(files: string[] = ['01001.mp4', '01002.mp4']): { library: VideoLibraryService; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-player-playback-'))
  for (const name of files) fs.writeFileSync(path.join(root, name), Buffer.from('media-index-fixture'))
  const library = new VideoLibraryService([root])
  return { library, cleanup: () => { library.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

function makeMediaSources() {
  const grants = new Set<string>()
  return {
    grants,
    grant(musicCode: string, revision: string) {
      assert.match(musicCode, /^\d{5}$/)
      assert.match(revision, /^[a-f0-9]{64}$/)
      const url = `kq-media://playback/${musicCode}-${grants.size}`
      grants.add(url)
      let active = true
      return { url, revoke: () => { if (active) grants.delete(url); active = false } }
    }
  }
}

async function settleEvents(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await settleEvents()
  }
  assert.fail('Expected test condition did not become true.')
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

async function setup(files?: string[], hostReady: Promise<void> = Promise.resolve()) {
  const fixture = makeLibrary(files)
  await fixture.library.refresh()
  const host = new ControlledHost(hostReady)
  const sources = makeMediaSources()
  const service = new PlayerPlaybackService(fixture.library, sources)
  service.attachHost(host)
  const events: PlayerPlaybackEvent[] = []
  const unsubscribe = service.subscribe((event: PlayerPlaybackEvent) => events.push(event))
  return {
    ...fixture, host, sources, service, events,
    cleanup: async () => { unsubscribe(); await service.dispose(); fixture.cleanup() }
  }
}

test('load resolves only canonical indexed codes and playback begins only after an explicit command', async () => {
  const context = await setup()
  try {
    await assert.rejects(context.service.load('1001'), (error: unknown) =>
      error instanceof PlayerPlaybackError && error.code === 'INVALID_MUSIC_CODE')
    await assert.rejects(context.service.load('01003'), (error: unknown) =>
      error instanceof PlayerPlaybackError && error.code === 'MEDIA_UNAVAILABLE')

    await context.service.load('01001')
    assert.equal(context.service.getState().status, 'loading')
    assert.equal(context.host.commands.filter(command => command.type === 'play').length, 0,
      'load must not start playback')
    context.host.media(context.service.getState().attemptId!, 1, { type: 'loadedmetadata', duration: 30, videoWidth: 320, videoHeight: 240 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'ready')

    await context.service.play()
    assert.equal(context.service.getState().status, 'starting')
    context.host.media(context.service.getState().attemptId!, 2, { type: 'playing', currentTime: 0, duration: 30 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'playing')
  } finally { await context.cleanup() }
})

test('playImmediately waits for media readiness and observed playback before reporting started', async () => {
  const context = await setup()
  try {
    const starting = context.service.playImmediately('01001')
    const load = await context.host.whenCommand('load')
    context.host.media(load.attemptId, 1, { type: 'loadedmetadata', duration: 35, videoWidth: 640, videoHeight: 480 })
    const play = await context.host.whenCommand('play')
    assert.equal(play.attemptId, load.attemptId)
    context.host.media(play.attemptId, 2, { type: 'playing', currentTime: 0.1, duration: 35 })
    const state = await starting
    assert.equal(state.status, 'playing')
    assert.equal(state.attemptId, load.attemptId)
  } finally { await context.cleanup() }
})

test('missing manual media is rejected before it can replace the current playback', async () => {
  const context = await setup(['01001.mp4'])
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 35 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 1, duration: 35 })
    await settleEvents()
    const commandsBefore = context.host.commands.length
    await assert.rejects(context.service.playImmediately('01003'), (error: unknown) =>
      error instanceof PlayerPlaybackError && error.code === 'MEDIA_UNAVAILABLE')
    assert.deepEqual(context.service.getState(), { status: 'playing', attemptId, musicCode: '01001' })
    assert.equal(context.host.commands.length, commandsBefore,
      'a failed availability lookup must not send Stop or Load to the current host')
  } finally { await context.cleanup() }
})

test('overlapping manual preflights preserve operator command order when the earlier lookup finishes last', async () => {
  const context = await setup()
  try {
    const firstLookupStarted = deferred<void>()
    const releaseFirstLookup = deferred<void>()
    const originalOpen = context.library.openForPlayback.bind(context.library)
    context.library.openForPlayback = async (code, revision) => {
      if (code === '01001') {
        firstLookupStarted.resolve()
        await releaseFirstLookup.promise
      }
      return originalOpen(code, revision)
    }

    const firstCommand = context.service.playImmediately('01001')
    await firstLookupStarted.promise
    const laterCommand = context.service.playImmediately('01002')
    const load = await context.host.whenCommand('load')
    assert.equal(load.type, 'load')
    assert.equal(load.musicCode, '01002', 'the newer operator selection must reserve first')
    context.host.media(load.attemptId, 1, { type: 'loadedmetadata', duration: 30 })
    await context.host.whenCommand('play')
    context.host.media(load.attemptId, 2, { type: 'playing', currentTime: 0.1, duration: 30 })
    assert.equal((await laterCommand).musicCode, '01002')

    releaseFirstLookup.resolve()
    await assert.rejects(firstCommand, (error: unknown) =>
      error instanceof PlayerPlaybackError && error.code === 'SUPERSEDED')
    assert.deepEqual(context.host.commands.filter(command => command.type === 'load').map(command => command.musicCode), ['01002'])
  } finally { await context.cleanup() }
})

test('Stop during playImmediately loading prevents a later automatic Play command', async () => {
  const context = await setup()
  try {
    const starting = context.service.playImmediately('01001')
    const load = await context.host.whenCommand('load')
    await context.service.stop()
    await assert.rejects(starting, (error: unknown) =>
      error instanceof PlayerPlaybackError && error.code === 'SUPERSEDED')
    assert.equal(context.service.getState().status, 'stopped')
    assert.equal(context.host.commands.some(command => command.type === 'play' && command.attemptId === load.attemptId), false)
  } finally { await context.cleanup() }
})

test('pause and resume preserve attempt identity; stop interrupts without natural completion', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 45 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 0, duration: 45 })
    await settleEvents()

    await context.service.pause()
    context.host.media(attemptId, 3, { type: 'pause', currentTime: 5, duration: 45 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'paused')
    await context.service.resume()
    assert.equal(context.service.getState().attemptId, attemptId)
    context.host.media(attemptId, 4, { type: 'playing', currentTime: 5, duration: 45 })
    await settleEvents()

    await context.service.stop()
    context.host.media(attemptId, 5, { type: 'ended', currentTime: 45, duration: 45 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'stopped')
    assert.equal(context.events.filter(event => event.type === 'natural-end-candidate').length, 0)
    assert.equal(context.events.filter(event => event.type === 'interrupted' && event.reason === 'stop').length, 1)
  } finally { await context.cleanup() }
})

test('a Stop acknowledgement timeout remains uncertain and terminates only the playback host', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 30 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 1, duration: 30 })
    await settleEvents()

    const lostAcknowledgement = deferred<void>()
    context.host.nextStopAcknowledgement = lostAcknowledgement.promise
    const stopping = context.service.stop()
    const repeatedStop = context.service.stop()
    assert.equal(repeatedStop, stopping, 'concurrent Stop commands must share the same pending result')
    await context.host.whenCommand('stop')
    assert.equal(context.service.getState().status, 'stopping', 'a pending Stop must not claim completion before its acknowledgement')
    lostAcknowledgement.reject(new PlayerPlaybackError('COMMAND_TIMEOUT', 'stop acknowledgement lost'))
    await assert.rejects(stopping, (error: unknown) => error instanceof PlayerPlaybackError && error.code === 'COMMAND_TIMEOUT')
    await waitFor(() => context.service.getState().containmentStatus === 'host-terminated')

    const state = context.service.getState()
    assert.equal(state.status, 'uncertain', 'host destruction does not resolve whether the song naturally completed')
    assert.equal(state.containmentStatus, 'host-terminated')
    assert.equal(context.host.terminateCalls, 1)
    assert.equal(context.events.some(event => event.type === 'natural-end-candidate' && event.attemptId === attemptId), false)
  } finally { await context.cleanup() }
})

test('dispose contains an unacknowledged active Stop and records only confirmed host termination', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 30 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 1, duration: 30 })
    await settleEvents()

    const stopAcknowledgement = deferred<void>()
    context.host.nextStopAcknowledgement = stopAcknowledgement.promise
    const disposal = context.service.dispose()
    await context.host.whenCommand('stop')
    assert.equal(context.service.getState().status, 'disposed')
    stopAcknowledgement.reject(new PlayerPlaybackError('COMMAND_TIMEOUT', 'stop ack was not received'))
    await disposal

    assert.equal(context.host.terminateCalls, 1)
    assert.equal(context.service.getState().status, 'disposed')
    assert.equal(context.service.getState().containmentStatus, 'host-terminated')
    assert.equal(context.events.some(event => event.type === 'natural-end-candidate' && event.attemptId === attemptId), false)
  } finally { await context.cleanup() }
})

test('dispose preserves unconfirmed containment when the playback host cannot confirm termination', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 30 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 1, duration: 30 })
    await settleEvents()

    const stopAcknowledgement = deferred<void>()
    context.host.nextStopAcknowledgement = stopAcknowledgement.promise
    context.host.terminationConfirmed = false
    context.host.emitTerminationOnTerminate = false
    const disposal = context.service.dispose()
    await context.host.whenCommand('stop')
    stopAcknowledgement.reject(new PlayerPlaybackError('COMMAND_TIMEOUT', 'stop ack was not received'))
    await disposal

    assert.equal(context.host.terminateCalls, 1)
    assert.equal(context.service.getState().status, 'disposed')
    assert.equal(context.service.getState().containmentStatus, 'unconfirmed')
    assert.equal(context.events.some(event => event.type === 'natural-end-candidate' && event.attemptId === attemptId), false)
  } finally { await context.cleanup() }
})

test('dispose during a pending Stop preserves the active attempt identity and waits for containment', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 30 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 1, duration: 30 })
    await settleEvents()

    const stopAcknowledgement = deferred<void>()
    context.host.nextStopAcknowledgement = stopAcknowledgement.promise
    const stopping = context.service.stop()
    await context.host.whenCommand('stop')
    const disposal = context.service.dispose()
    assert.equal(context.service.getState().status, 'stopping',
      'dispose must wait for the in-flight Stop instead of discarding its attempt identity')
    stopAcknowledgement.reject(new PlayerPlaybackError('COMMAND_TIMEOUT', 'stop ack was lost during disposal'))

    const [stopResult] = await Promise.allSettled([stopping, disposal])
    assert.equal(stopResult.status, 'rejected')
    assert.equal(context.host.terminateCalls, 1)
    assert.equal(context.service.getState().status, 'disposed')
    assert.equal(context.service.getState().attemptId, attemptId)
    assert.equal(context.service.getState().containmentStatus, 'host-terminated')
    assert.equal(context.events.some(event => event.type === 'natural-end-candidate' && event.attemptId === attemptId), false)
  } finally { await context.cleanup() }
})

test('restart creates a new attempt and rejects terminal events from the interrupted attempt', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const previousAttempt = context.service.getState().attemptId!
    context.host.media(previousAttempt, 1, { type: 'loadedmetadata', duration: 60 })
    await settleEvents()
    await context.service.play()
    context.host.media(previousAttempt, 2, { type: 'playing', currentTime: 2, duration: 60 })
    await settleEvents()

    const restartPromise = context.service.restart()
    const restartLoad = await context.host.whenNextCommand('load')
    const restartedAttempt = restartLoad.attemptId
    assert.notEqual(restartedAttempt, previousAttempt)
    context.host.media(restartedAttempt, 1, { type: 'loadedmetadata', duration: 60 })
    await context.host.whenNextCommand('play')
    context.host.media(restartedAttempt, 2, { type: 'playing', currentTime: 0, duration: 60 })
    await restartPromise
    assert.equal(context.host.commands.at(-1)?.type, 'play')
    context.host.media(previousAttempt, 3, { type: 'ended', currentTime: 60, duration: 60 })
    await settleEvents()
    assert.equal(context.events.filter(event => event.type === 'natural-end-candidate').length, 0)
    assert.notEqual(context.service.getState().status, 'completed')
  } finally { await context.cleanup() }
})

test('a valid natural end is emitted once; duplicate terminal events are ignored', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 20 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 0, duration: 20 })
    await settleEvents()
    context.host.media(attemptId, 3, { type: 'ended', currentTime: 20, duration: 20 })
    await settleEvents()
    context.host.media(attemptId, 4, { type: 'ended', currentTime: 20, duration: 20 })
    await settleEvents()

    assert.equal(context.service.getState().status, 'completed')
    assert.equal(context.events.filter(event => event.type === 'natural-end-candidate').length, 1)
  } finally { await context.cleanup() }
})

test('confirmed final EOF clears only the matching media attempt and resets in-memory progress', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 20 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 1, duration: 20 })
    context.host.media(attemptId, 3, { type: 'timeupdate', currentTime: 12, duration: 20 })
    await settleEvents()
    context.host.media(attemptId, 4, { type: 'ended', currentTime: 20, duration: 20 })
    await settleEvents()

    assert.equal(context.service.getState().status, 'completed')
    assert.equal(context.service.getProgress(), null, 'confirmed natural completion must not expose stale elapsed time')
    assert.equal(await context.service.clearCompletedMedia('old-attempt'), false,
      'a stale completion identity cannot clear a selected media source')
    assert.equal(context.host.commands.some(command => command.type === 'clear'), false)

    assert.equal(await context.service.clearCompletedMedia(attemptId), true)
    const clear = context.host.commands.at(-1)
    assert.equal(clear?.type, 'clear')
    assert.equal(clear?.attemptId, attemptId)
    assert.equal(context.service.getState().status, 'idle', 'confirmed media cleanup returns the visual service to idle')
    assert.equal(context.service.getState().musicCode, undefined)
    assert.equal(context.service.getProgress(), null)
    assert.equal(await context.service.clearCompletedMedia(attemptId), false, 'duplicate cleanup is idempotent')
  } finally { await context.cleanup() }
})

test('a failed final-frame clear destroys only the playback host when termination is confirmed', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 20 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 0, duration: 20 })
    await settleEvents()
    context.host.media(attemptId, 3, { type: 'ended', currentTime: 20, duration: 20 })
    await settleEvents()
    context.host.nextClearError = new PlayerPlaybackError('COMMAND_TIMEOUT', 'clear acknowledgement timed out')

    assert.equal(await context.service.clearCompletedMedia(attemptId), true)
    assert.equal(context.host.terminateCalls, 1)
    assert.equal(context.host.disposed, true)
    assert.equal(context.service.getState().status, 'completed',
      'Removing the surface must preserve the already-confirmed natural completion.')
    assert.equal(context.service.getState().attemptId, attemptId)
  } finally { await context.cleanup() }
})

test('an unconfirmed final-frame clear remains an explicit containment failure', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 20 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 0, duration: 20 })
    await settleEvents()
    context.host.media(attemptId, 3, { type: 'ended', currentTime: 20, duration: 20 })
    await settleEvents()
    context.host.nextClearError = new PlayerPlaybackError('COMMAND_TIMEOUT', 'clear acknowledgement timed out')
    context.host.terminationConfirmed = false
    context.host.emitTerminationOnTerminate = false

    await assert.rejects(context.service.clearCompletedMedia(attemptId), { code: 'HOST_CONTAINMENT_FAILED' })
    assert.ok(context.events.some(event => event.type === 'surface-cleanup-failed' &&
      event.attemptId === attemptId && event.musicCode === '01001' && event.errorCode === 'HOST_CONTAINMENT_FAILED'),
    'unconfirmed cleanup must publish a correlated UI event without changing the confirmed EOF state')
    assert.equal(context.host.disposed, false)
    assert.equal(context.service.getState().status, 'completed',
      'A failed visual cleanup must not rewrite the confirmed playback outcome.')
    assert.equal(context.service.getState().attemptId, attemptId)
  } finally { await context.cleanup() }
})

test('ended without observed play or reliable duration is uncertain, never a completion candidate', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 0 })
    await settleEvents()
    context.host.media(attemptId, 2, { type: 'ended', currentTime: 0, duration: 0 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'uncertain')
    assert.equal(context.events.filter(event => event.type === 'natural-end-candidate').length, 0)
    assert.equal(context.events.filter(event => event.type === 'uncertain').length, 1)
  } finally { await context.cleanup() }
})

test('host termination invalidates active playback and later EOF cannot complete it', async () => {
  const context = await setup()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 15 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 1, duration: 15 })
    await settleEvents()
    context.host.emit({ type: 'terminated', hostEpoch: context.host.hostEpoch })
    await settleEvents()
    context.host.media(attemptId, 3, { type: 'ended', currentTime: 15, duration: 15 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'uncertain')
    assert.equal(context.events.filter(event => event.type === 'natural-end-candidate').length, 0)
    assert.equal(context.host.disposed, true)
  } finally { await context.cleanup() }
})

test('ambiguous duplicate library codes are rejected and do not issue a load command', async () => {
  const context = await setup(['01001.mp4', '01001 - alternate.mkv'])
  try {
    await assert.rejects(context.service.load('01001'), (error: unknown) =>
      error instanceof PlayerPlaybackError && error.code === 'MEDIA_AMBIGUOUS')
    assert.equal(context.host.commands.some(command => command.type === 'load'), false)
  } finally { await context.cleanup() }
})

test('Stop completes while a load acknowledgement is delayed and stale load completion cannot revive playback', async () => {
  const context = await setup()
  const heldAcknowledgement = deferred<void>()
  context.host.nextLoadAcknowledgement = heldAcknowledgement.promise
  try {
    let loadSettled = false
    const loadCommandSent = context.host.whenCommand('load')
    const pendingLoad = context.service.load('01001').finally(() => { loadSettled = true })
    await loadCommandSent

    await context.service.stop()
    assert.equal(context.service.getState().status, 'stopped')
    assert.equal(loadSettled, false, 'load remains pending only on its deliberately held host acknowledgement')
    assert.equal(context.host.commands.at(-1)?.type, 'stop')

    heldAcknowledgement.resolve()
    await pendingLoad
    assert.equal(context.service.getState().status, 'stopped', 'late acknowledgement must not restore loading/ready state')
    assert.equal(context.events.some(event => event.type === 'natural-end-candidate'), false)
  } finally {
    heldAcknowledgement.resolve()
    await context.cleanup()
  }
})

test('Pause queued immediately after Resume is sent even while the Resume acknowledgement is pending', async () => {
  const context = await setup()
  const heldResume = deferred<void>()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 35 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 3, duration: 35 })
    await settleEvents()
    await context.service.pause()
    context.host.media(attemptId, 3, { type: 'pause', currentTime: 3, duration: 35 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'paused')

    context.host.nextPlayAcknowledgement = heldResume.promise
    const resumePromise = context.service.resume()
    await waitFor(() => context.host.commands.at(-1)?.type === 'play')
    const commandCountBeforePause = context.host.commands.length
    const pausePromise = context.service.pause()
    await waitFor(() => context.host.commands.length > commandCountBeforePause)
    assert.equal(context.host.commands.at(-1)?.type, 'pause',
      'Pause must re-evaluate the state after queued Resume instead of returning a stale paused no-op')

    context.host.media(attemptId, 4, { type: 'pause', currentTime: 3, duration: 35 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'paused')
    heldResume.resolve()
    await Promise.all([resumePromise, pausePromise])
    assert.equal(context.service.getState().status, 'paused')
    assert.equal(context.service.getState().attemptId, attemptId)
  } finally {
    heldResume.resolve()
    await context.cleanup()
  }
})

test('Restart queued after Load(B) reserves B as the selected music code', async () => {
  const context = await setup()
  const delayedOpen = deferred<void>()
  const bLookupStarted = deferred<void>()
  const openForPlayback = context.library.openForPlayback.bind(context.library)
  let firstBLookup = true
  context.library.openForPlayback = async (code: unknown, revision?: string) => {
    if (code === '01002' && firstBLookup) {
      firstBLookup = false
      bLookupStarted.resolve()
      await delayedOpen.promise
    }
    return openForPlayback(code, revision)
  }
  try {
    await context.service.load('01001')
    const loadB = context.service.load('01002')
    await bLookupStarted.promise
    const restartLoadPromise = context.host.whenNextCommand('load')
    const restartB = context.service.restart()
    const restartLoad = await restartLoadPromise
    assert.equal(restartLoad.type, 'load')
    assert.equal(restartLoad.musicCode, '01002')
    context.host.media(restartLoad.attemptId, 1, { type: 'loadedmetadata', duration: 30 })
    await context.host.whenCommand('play')
    context.host.media(restartLoad.attemptId, 2, { type: 'playing', currentTime: 0, duration: 30 })
    await restartB
    assert.equal(context.service.getState().musicCode, '01002')
    assert.equal(context.host.commands.filter(command => command.type === 'load').at(-1)?.musicCode, '01002')

    delayedOpen.resolve()
    await assert.rejects(loadB, (error: unknown) =>
      error instanceof PlayerPlaybackError && error.code === 'SUPERSEDED')
    assert.equal(context.service.getState().musicCode, '01002', 'the older Load(B) continuation cannot overwrite the restart attempt')
  } finally {
    delayedOpen.resolve()
    await context.cleanup()
  }
})

test('Stop before host.ready supersedes a pending Load without sending media commands', async () => {
  const hostReady = deferred<void>()
  const context = await setup(undefined, hostReady.promise)
  try {
    const load = context.service.load('01001')
    await context.service.stop()
    assert.equal(context.service.getState().status, 'stopped')
    assert.deepEqual(context.host.commands, [], 'no command may be sent before host readiness')

    hostReady.resolve()
    await assert.rejects(load, (error: unknown) =>
      error instanceof PlayerPlaybackError && error.code === 'SUPERSEDED')
    assert.equal(context.service.getState().status, 'stopped')
    assert.deepEqual(context.host.commands, [], 'the stale Load continuation must not send load/play after readiness')
  } finally {
    hostReady.resolve()
    await context.cleanup()
  }
})

test('a command timeout after observed playback becomes uncertain and ignores delayed EOF', async () => {
  const context = await setup()
  const playAcknowledgement = deferred<void>()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 40 })
    await settleEvents()

    context.host.nextPlayAcknowledgement = playAcknowledgement.promise
    const play = context.service.play()
    await waitFor(() => context.host.commands.some(command => command.type === 'play'))
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 8, duration: 40 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'playing', 'the host observed playback before its ACK timed out')

    const timeout = new PlayerPlaybackError('COMMAND_TIMEOUT', 'Controlled command acknowledgement timeout.')
    playAcknowledgement.reject(timeout)
    await assert.rejects(play, (error: unknown) => error === timeout)
    assert.equal(context.service.getState().status, 'uncertain')
    assert.ok(context.events.some(event => event.type === 'uncertain' && event.attemptId === attemptId &&
      event.reason === 'command-outcome-unknown'))
    assert.ok(context.host.commands.some(command => command.type === 'stop' && command.attemptId === attemptId),
      'unknown command outcome should request best-effort stop')

    context.host.media(attemptId, 3, { type: 'ended', currentTime: 40, duration: 40 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'uncertain')
    assert.equal(context.events.filter(event => event.type === 'natural-end-candidate').length, 0,
      'EOF arriving after uncertain timeout cannot become a completion candidate')
  } finally {
    playAcknowledgement.resolve()
    await context.cleanup()
  }
})

test('a Pause timeout after observed playback becomes uncertain and ignores delayed EOF', async () => {
  const context = await setup()
  const pauseAcknowledgement = deferred<void>()
  try {
    await context.service.load('01001')
    const attemptId = context.service.getState().attemptId!
    context.host.media(attemptId, 1, { type: 'loadedmetadata', duration: 40 })
    await settleEvents()
    await context.service.play()
    context.host.media(attemptId, 2, { type: 'playing', currentTime: 8, duration: 40 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'playing')

    context.host.nextPauseAcknowledgement = pauseAcknowledgement.promise
    const pause = context.service.pause()
    await context.host.whenCommand('pause')
    assert.equal(context.service.getState().status, 'playing', 'the active attempt was observed playing before Pause timed out')

    const timeout = new PlayerPlaybackError('COMMAND_TIMEOUT', 'Controlled pause acknowledgement timeout.')
    pauseAcknowledgement.reject(timeout)
    await assert.rejects(pause, (error: unknown) => error === timeout)
    assert.equal(context.service.getState().status, 'uncertain')
    assert.ok(context.events.some(event => event.type === 'uncertain' && event.attemptId === attemptId &&
      event.reason === 'command-outcome-unknown'))
    assert.ok(context.host.commands.some(command => command.type === 'stop' && command.attemptId === attemptId),
      'unknown Pause outcome should request best-effort stop')

    context.host.media(attemptId, 3, { type: 'ended', currentTime: 40, duration: 40 })
    await settleEvents()
    assert.equal(context.service.getState().status, 'uncertain')
    assert.equal(context.events.filter(event => event.type === 'natural-end-candidate').length, 0,
      'EOF arriving after a Pause timeout cannot become a completion candidate')
  } finally {
    pauseAcknowledgement.resolve()
    await context.cleanup()
  }
})
