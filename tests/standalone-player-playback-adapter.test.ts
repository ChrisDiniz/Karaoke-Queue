import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PlayerPlaybackError, type PlayerPlaybackHost, type PlayerPlaybackHostCommand, type PlayerPlaybackHostEvent } from '../src/player-playback-contracts'
import { PlayerMediaProtocol } from '../src/player-media-protocol'
import { PlayerPlaybackRecoveryCoordinator } from '../src/player-playback-recovery'
import { PlayerPlaybackRecoveryStore } from '../src/player-playback-recovery-store'
import { VideoLibraryService } from '../src/video-library-service'
import { createStandalonePlayerWithSharedPlayback } from '../src/standalone-player-playback-adapter'
import type { StandaloneCountdownScheduler, StandalonePlayerSequence } from '../src/standalone-player-sequence'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

class PlaybackHostFake implements PlayerPlaybackHost {
  readonly hostEpoch = 'standalone-adapter-host'
  readonly ready = Promise.resolve()
  readonly commands: PlayerPlaybackHostCommand[] = []
  disposed = false
  terminationCount = 0
  nextLoadError: Error | undefined
  nextLoadGate: Deferred<void> | undefined
  nextStopGate: Deferred<void> | undefined
  private readonly subscribers = new Set<(event: PlayerPlaybackHostEvent) => void>()
  private readonly commandWaiters = new Map<PlayerPlaybackHostCommand['type'], Array<(command: PlayerPlaybackHostCommand) => void>>()
  private readonly sequenceByAttempt = new Map<string, number>()
  private readonly pendingCommands = new Set<Deferred<void>>()

  async send(command: PlayerPlaybackHostCommand): Promise<void> {
    if (this.disposed) throw new PlayerPlaybackError('HOST_TERMINATED', 'fake host disposed')
    this.commands.push(command)
    for (const waiter of this.commandWaiters.get(command.type) ?? []) waiter(command)
    this.commandWaiters.delete(command.type)

    if (command.type === 'load' && this.nextLoadGate) await this.nextLoadGate.promise
    if (command.type === 'stop' && this.nextStopGate) await this.nextStopGate.promise
    if (command.type === 'load' && this.nextLoadError) {
      const error = this.nextLoadError
      this.nextLoadError = undefined
      throw error
    }

    if (command.type === 'load') {
      this.media(command.attemptId, { type: 'loadedmetadata', duration: 30, videoWidth: 640, videoHeight: 360 })
    } else if (command.type === 'play') {
      this.media(command.attemptId, { type: 'playing', currentTime: 0, duration: 30 })
    } else if (command.type === 'pause') {
      this.media(command.attemptId, { type: 'pause', currentTime: 7, duration: 30 })
    }
  }

  nextCommand(type: PlayerPlaybackHostCommand['type']): Promise<PlayerPlaybackHostCommand> {
    return new Promise(resolve => {
      const waiters = this.commandWaiters.get(type) ?? []
      waiters.push(resolve)
      this.commandWaiters.set(type, waiters)
    })
  }

  subscribe(listener: (event: PlayerPlaybackHostEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  get listenerCount(): number { return this.subscribers.size }

  media(attemptId: string, observation: Extract<PlayerPlaybackHostEvent, { type: 'media' }>['observation']): void {
    const sequenceNumber = (this.sequenceByAttempt.get(attemptId) ?? 0) + 1
    this.sequenceByAttempt.set(attemptId, sequenceNumber)
    const event: PlayerPlaybackHostEvent = {
      type: 'media', hostEpoch: this.hostEpoch, attemptId, sequenceNumber, observation
    }
    for (const listener of [...this.subscribers]) listener(event)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.pendingCommands) pending.reject(new PlayerPlaybackError('HOST_TERMINATED', 'fake host disposed'))
    this.pendingCommands.clear()
    this.subscribers.clear()
  }

  async terminate(): Promise<boolean> {
    this.terminationCount++
    return true
  }
}

interface ProtocolFake {
  readonly handlers: Map<string, (request: Request) => Promise<Response>>
  readonly removed: string[]
  handle(scheme: string, handler: (request: Request) => Promise<Response>): void
  unhandle(scheme: string): void
}

function createProtocolFake(): ProtocolFake {
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  const removed: string[] = []
  return {
    handlers,
    removed,
    handle: (scheme, handler) => { handlers.set(scheme, handler) },
    unhandle: scheme => { removed.push(scheme); handlers.delete(scheme) }
  }
}

async function waitForSnapshot(
  sequence: StandalonePlayerSequence,
  predicate: (snapshot: ReturnType<StandalonePlayerSequence['getSnapshot']>) => boolean
): Promise<ReturnType<StandalonePlayerSequence['getSnapshot']>> {
  for (let turn = 0; turn < 100; turn++) {
    const snapshot = sequence.getSnapshot()
    if (predicate(snapshot)) return snapshot
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail('O estado esperado da sequência não foi publicado.')
}

interface FixtureOptions {
  readonly files?: readonly string[]
  readonly catalog?: boolean
  readonly recovery?: PlayerPlaybackRecoveryCoordinator
  readonly onCatalogLookup?: () => void
  readonly onCatalogClose?: () => void
  readonly countdownScheduler?: StandaloneCountdownScheduler
}

function createElapsedCountdownScheduler(): StandaloneCountdownScheduler {
  let now = 0
  return {
    now: () => now,
    schedule: (callback, delayMs) => {
      now += delayMs
      const handle = { cancelled: false }
      queueMicrotask(() => { if (!handle.cancelled) callback() })
      return handle
    },
    cancel: handle => { (handle as { cancelled: boolean }).cancelled = true }
  }
}

async function createFixture(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-playback-'))
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-profile-'))
  const bytes = Buffer.from('standalone-player-protocol-fixture')
  for (const filename of options.files ?? ['01001.mp4', '01002.mp4', '01003.mp4']) {
    fs.writeFileSync(path.join(root, filename), bytes)
  }
  const library = new VideoLibraryService([root])
  await library.refresh()
  const host = new PlaybackHostFake()
  const protocol = createProtocolFake()
  const mediaSources = new PlayerMediaProtocol(library)
  mediaSources.install(protocol as never)
  let mediaSourcesDisposed = 0
  let catalogClosed = 0
  const catalog = options.catalog ? {
    lookupByVideoCode: async () => {
      options.onCatalogLookup?.()
      return {
        musicNumber: '1001', videoCode: '01001', artist: 'Artista', title: 'Título',
        metadataAvailable: true, videoAvailability: 'available' as const,
        catalogRevision: 'catalog-revision', inventoryRevision: library.getSnapshot().revision,
        inventoryStatus: 'ready' as const
      }
    },
    close: async () => { catalogClosed++; options.onCatalogClose?.() }
  } : undefined
  const errors: unknown[] = []
  const sequence = await createStandalonePlayerWithSharedPlayback({
    library,
    mediaSources,
    host,
    catalog,
    recovery: options.recovery,
    disposeMediaSources: () => {
      mediaSourcesDisposed++
      mediaSources.dispose(protocol as never)
    },
    createEntryId: (() => { let id = 0; return () => `entry-${++id}` })(),
    // These adapter tests cover the real playback service/host boundary; Sequence tests cover the full 5s clock.
    countdownScheduler: options.countdownScheduler ?? createElapsedCountdownScheduler(),
    onCoordinationError: error => errors.push(error)
  })

  return {
    root, profile, bytes, library, host, protocol, mediaSources, sequence, errors,
    catalogClosed: () => catalogClosed,
    mediaSourcesDisposed: () => mediaSourcesDisposed,
    cleanup: async () => {
      await sequence.dispose()
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(profile, { recursive: true, force: true })
    }
  }
}

function submit(sequence: StandalonePlayerSequence, operationId: string, enteredCode: string) {
  return sequence.execute({ operationId, command: { type: 'submit-code', enteredCode, priority: 'normal' } }).then(async result => {
    if (result.outcome === 'confirmed' && result.snapshot.playbackCondition === 'transitioning' &&
        result.snapshot.phase === 'countdown') {
      await waitForSnapshot(sequence, snapshot => snapshot.playbackCondition === 'blocked' ||
        snapshot.playbackCondition === 'uncertain' ||
        (snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'playing'))
    }
    return result
  })
}

test('real PlayerPlaybackService composes with the Standalone sequence, library and media capability protocol', async () => {
  let catalogLookups = 0
  const recoveryProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-recovery-'))
  const recovery = new PlayerPlaybackRecoveryCoordinator(new PlayerPlaybackRecoveryStore(recoveryProfile))
  const fixture = await createFixture({ catalog: true, recovery, onCatalogLookup: () => catalogLookups++ })
  try {
    const request = { operationId: 'submit-1001', command: { type: 'submit-code' as const, enteredCode: '1001', priority: 'normal' as const } }
    const firstSubmission = fixture.sequence.execute(request)
    const retriedSubmission = fixture.sequence.execute(request)
    assert.strictEqual(retriedSubmission, firstSubmission, 'same operationId/payload shares the authoritative result')
    const firstResult = await firstSubmission
    assert.equal(firstResult.outcome, 'confirmed')
    await waitForSnapshot(fixture.sequence, snapshot => snapshot.playbackCondition === 'blocked' ||
      snapshot.playbackCondition === 'uncertain' ||
      (snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'playing'))
    assert.equal(fixture.host.commands.filter(command => command.type === 'load').length, 1)
    const firstSnapshot = fixture.sequence.getSnapshot()
    assert.equal(firstSnapshot.playbackCondition, 'ready')
    if (firstSnapshot.playbackCondition !== 'ready') assert.fail('Playback start was not committed.')
    assert.equal(firstSnapshot.state.operationalState, 'playing')
    assert.equal(firstSnapshot.state.current?.musicCode, '01001', 'un-padded operator input is normalized through the shared catalog rule')

    const load = fixture.host.commands.find((command): command is Extract<PlayerPlaybackHostCommand, { type: 'load' }> => command.type === 'load')!
    const mediaHandler = fixture.protocol.handlers.get('kq-media')
    assert.ok(mediaHandler)
    const mediaResponse = await mediaHandler(new Request(load.mediaUrl))
    assert.equal(mediaResponse.status, 200)
    assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), fixture.bytes,
      'PlayerMediaProtocol streams the unique library file without exposing a path in the host command')

    await submit(fixture.sequence, 'submit-1002', '1002')
    await submit(fixture.sequence, 'submit-1003', '1003')
    const endedFirst = waitForSnapshot(fixture.sequence, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01002')
    fixture.host.media(load.attemptId, { type: 'ended', currentTime: 30, duration: 30 })
    await endedFirst

    const currentAfterEof = fixture.sequence.getSnapshot()
    if (currentAfterEof.playbackCondition !== 'ready' || !currentAfterEof.state.current) {
      assert.fail('The next library item was not committed after natural EOF.')
    }
    const secondAttempt = currentAfterEof.state.current.attemptId
    assert.equal(currentAfterEof.state.current.musicCode, '01002')
    fixture.host.media(load.attemptId, { type: 'ended', currentTime: 30, duration: 30 })
    await new Promise<void>(resolve => setImmediate(resolve))
    const afterStaleEof = fixture.sequence.getSnapshot()
    assert.equal(afterStaleEof.playbackCondition, 'ready')
    if (afterStaleEof.playbackCondition !== 'ready') assert.fail('A stale EOF changed the sequence state.')
    assert.equal(afterStaleEof.state.current?.attemptId, secondAttempt, 'duplicate EOF for the prior attempt is ignored')
    assert.equal(afterStaleEof.state.pending.length, 1, 'stale EOF did not skip a queued item')

    const pause = await fixture.sequence.execute({ operationId: 'pause-1002', command: { type: 'toggle-pause' } })
    assert.equal(pause.outcome, 'confirmed')
    const pausedSnapshot = fixture.sequence.getSnapshot()
    assert.equal(pausedSnapshot.playbackCondition, 'ready')
    if (pausedSnapshot.playbackCondition !== 'ready') assert.fail('Pause did not settle.')
    assert.equal(pausedSnapshot.state.operationalState, 'paused')
    const resume = await fixture.sequence.execute({ operationId: 'resume-1002', command: { type: 'toggle-pause' } })
    assert.equal(resume.outcome, 'confirmed')
    const beforeRestart = fixture.sequence.getSnapshot()
    if (beforeRestart.playbackCondition !== 'ready' || !beforeRestart.state.current) assert.fail('Resume did not settle.')
    const currentEntryId = beforeRestart.state.current.entryId
    const beforeRestartAttempt = beforeRestart.state.current.attemptId
    const restart = await fixture.sequence.execute({ operationId: 'restart-1002', command: { type: 'restart' } })
    assert.equal(restart.outcome, 'confirmed')
    const afterRestart = fixture.sequence.getSnapshot()
    if (afterRestart.playbackCondition !== 'ready' || !afterRestart.state.current) assert.fail('Restart did not settle.')
    assert.equal(afterRestart.state.current.entryId, currentEntryId)
    assert.notEqual(afterRestart.state.current.attemptId, beforeRestartAttempt)

    const stopGate = deferred<void>()
    fixture.host.nextStopGate = stopGate
    const stopSeen = fixture.host.nextCommand('stop')
    const nextPromise = fixture.sequence.execute({ operationId: 'next-race', command: { type: 'next' } })
    const stopping = await stopSeen
    assert.equal(stopping.type, 'stop')
    fixture.host.media(afterRestart.state.current.attemptId, { type: 'ended', currentTime: 30, duration: 30 })
    stopGate.resolve()
    const nextResult = await nextPromise
    assert.equal(nextResult.outcome, 'confirmed')
    const afterNext = fixture.sequence.getSnapshot()
    if (afterNext.playbackCondition !== 'ready' || !afterNext.state.current) assert.fail('Next did not commit the pending item.')
    assert.equal(afterNext.state.current.musicCode, '01003')
    assert.equal(fixture.host.commands.filter(command => command.type === 'load' && command.musicCode === '01003').length, 1,
      'EOF racing with a confirmed manual Stop produces one queue advance')

    const finalNext = await fixture.sequence.execute({ operationId: 'next-to-idle', command: { type: 'next' } })
    assert.equal(finalNext.outcome, 'confirmed')
    const idle = fixture.sequence.getSnapshot()
    assert.equal(idle.playbackCondition, 'ready')
    if (idle.playbackCondition !== 'ready') assert.fail('Manual Next without a pending item did not return to idle.')
    assert.equal(idle.state.operationalState, 'idle')
    assert.equal(recoveryStoreLastTransition(recoveryProfile), 'stop-confirmed', 'manual Stop remains distinct from natural EOF')
    assert.equal(catalogLookups, 0, 'optional catalog metadata does not decide video availability or playback')
    assert.deepEqual(fixture.errors, [])

    await fixture.sequence.dispose()
    assert.equal(fixture.host.disposed, true)
    assert.equal(fixture.host.listenerCount, 0, 'host event listener is removed during shutdown')
    assert.equal(fixture.library.getSnapshot().scanStatus, 'closed')
    assert.equal(fixture.mediaSourcesDisposed(), 1)
    assert.equal(fixture.catalogClosed(), 1)
    assert.deepEqual(fixture.protocol.removed, ['kq-media'])
  } finally {
    await fixture.cleanup()
    fs.rmSync(recoveryProfile, { recursive: true, force: true })
  }
})

test('natural EOF of the last item clears the matching media and returns the integrated sequence to idle', async () => {
  const fixture = await createFixture({ files: ['01001.mp4'] })
  try {
    const result = await submit(fixture.sequence, 'single-track', '1001')
    assert.equal(result.outcome, 'confirmed')
    const playing = fixture.sequence.getSnapshot()
    if (playing.playbackCondition !== 'ready' || !playing.state.current) {
      assert.fail('The single track did not reach the playing state.')
    }
    const attemptId = playing.state.current.attemptId
    const load = fixture.host.commands.find((command): command is Extract<PlayerPlaybackHostCommand, { type: 'load' }> => command.type === 'load')
    assert.ok(load)

    const idleAfterEof = waitForSnapshot(fixture.sequence, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'idle')
    fixture.host.media(attemptId, { type: 'ended', currentTime: 30, duration: 30 })
    await idleAfterEof

    const clearCommands = fixture.host.commands.filter(command => command.type === 'clear')
    assert.equal(clearCommands.length, 1, 'the validated final EOF clears exactly its completed media attempt')
    assert.equal(clearCommands[0].attemptId, attemptId)
    assert.equal(fixture.host.commands.some(command => command.type === 'stop'), false,
      'natural EOF cleanup is not represented as a manual Stop')
    assert.equal(fixture.sequence.getSnapshot().playbackCondition, 'ready')
    const idle = fixture.sequence.getSnapshot()
    if (idle.playbackCondition !== 'ready') assert.fail('Final EOF did not settle to a ready snapshot.')
    assert.equal(idle.state.current, null)
    assert.deepEqual(idle.state.pending, [])

    fixture.host.media(load.attemptId, { type: 'ended', currentTime: 30, duration: 30 })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(fixture.host.commands.filter(command => command.type === 'clear').length, 1,
      'a duplicate terminal event cannot clear or advance the completed attempt twice')
  } finally { await fixture.cleanup() }
})

function recoveryStoreLastTransition(profile: string): string | undefined {
  return new PlayerPlaybackRecoveryStore(profile).read()?.lastTransition
}

test('a CSV match cannot make a missing video playable', async () => {
  let lookups = 0
  const fixture = await createFixture({ files: ['01001.mp4'], catalog: true, onCatalogLookup: () => lookups++ })
  try {
    const result = await submit(fixture.sequence, 'missing-video', '1002')
    assert.equal(result.outcome, 'rejected')
    if (result.outcome !== 'rejected') assert.fail('A missing video was accepted based on metadata.')
    assert.equal(result.error.code, 'MEDIA_UNAVAILABLE')
    assert.equal(fixture.sequence.getSnapshot().playbackCondition, 'ready')
    assert.equal(lookups, 0)
    assert.equal(fixture.host.commands.some(command => command.type === 'load'), false)
  } finally { await fixture.cleanup() }
})

test('known load failure blocks while retaining the reserved queue entry', async () => {
  const fixture = await createFixture()
  try {
    fixture.host.nextLoadError = new PlayerPlaybackError('MEDIA_LOAD_FAILED', 'known media load failure')
    const result = await submit(fixture.sequence, 'known-failure', '1001')
    assert.equal(result.outcome, 'confirmed', 'the request confirms the accepted countdown reservation before technical loading starts')
    const snapshot = fixture.sequence.getSnapshot()
    assert.equal(snapshot.playbackCondition, 'blocked')
    if (snapshot.playbackCondition !== 'blocked') assert.fail('Known failure was not represented as blocked.')
    assert.equal(snapshot.pending.length, 1, 'failed start remains represented for safe recovery')
    assert.equal(snapshot.pending[0].musicCode, '01001')
  } finally { await fixture.cleanup() }
})

test('uncertain host acknowledgement remains uncertain and does not duplicate playback', async () => {
  const fixture = await createFixture()
  try {
    fixture.host.nextLoadError = new PlayerPlaybackError('COMMAND_TIMEOUT', 'load acknowledgement was lost')
    const request = { operationId: 'uncertain-start', command: { type: 'submit-code' as const, enteredCode: '1001', priority: 'normal' as const } }
    const first = fixture.sequence.execute(request)
    const retry = fixture.sequence.execute(request)
    assert.strictEqual(retry, first)
    const result = await first
    assert.equal(result.outcome, 'confirmed', 'the request confirms the accepted countdown reservation before technical loading starts')
    await waitForSnapshot(fixture.sequence, snapshot => snapshot.playbackCondition === 'uncertain')
    const snapshot = fixture.sequence.getSnapshot()
    assert.equal(snapshot.playbackCondition, 'uncertain')
    if (snapshot.playbackCondition !== 'uncertain') assert.fail('Lost acknowledgement was not represented as uncertain.')
    assert.equal(snapshot.pending.length, 1)
    assert.equal(fixture.host.commands.filter(command => command.type === 'load').length, 1)
    assert.equal(fixture.host.commands.filter(command => command.type === 'stop').length, 1,
      'the existing service attempts bounded containment without retrying Load')
  } finally { await fixture.cleanup() }
})

test('startup recovery blocks playback without constructing the legacy manual sequence', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-pending-recovery-'))
  const store = new PlayerPlaybackRecoveryStore(profile)
  const timestamp = new Date(0).toISOString()
  const oldAttemptId = '9b2f5d7a-3861-4a83-86d2-0ce1d6d1903a'
  store.write({
    version: 1, revision: 1, status: 'playing', attemptId: oldAttemptId, musicCode: '01001',
    playbackStatus: 'playing', lastTransition: 'playback-started', updatedAt: timestamp, startedAt: timestamp
  })
  const recovery = new PlayerPlaybackRecoveryCoordinator(store, () => new Date(1))
  const fixture = await createFixture({ recovery })
  try {
    const initial = fixture.sequence.getSnapshot()
    assert.equal(initial.playbackCondition, 'blocked')
    assert.equal(fixture.host.commands.length, 0, 'uncertain startup recovery never autoplays')
    const result = await submit(fixture.sequence, 'blocked-by-recovery', '1001')
    assert.equal(result.outcome, 'rejected')
    assert.equal(fixture.host.commands.length, 0)
    assert.equal(recovery.getState().status, 'pending')
  } finally {
    await fixture.cleanup()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('shutdown aborts the pending sequence operation, stops playback and releases adapter resources', async () => {
  const fixture = await createFixture()
  const startGate = deferred<void>()
  try {
    fixture.host.nextLoadGate = startGate
    const loadSeen = fixture.host.nextCommand('load')
    const pendingStart = fixture.sequence.execute({ operationId: 'shutdown-start',
      command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' } })
    await loadSeen
    const stopSeen = fixture.host.nextCommand('stop')
    const disposal = fixture.sequence.dispose()
    await stopSeen
    startGate.resolve()
    await disposal
    const result = await pendingStart
    assert.equal(result.outcome, 'confirmed', 'C3 already acknowledged the countdown reservation; disposal contains the pending real host load.')
    assert.equal(fixture.host.disposed, true)
    assert.equal(fixture.host.listenerCount, 0)
    assert.equal(fixture.library.getSnapshot().scanStatus, 'closed')
    assert.equal(fixture.mediaSourcesDisposed(), 1)
  } finally {
    startGate.resolve()
    await fixture.cleanup()
  }
})

test('composition failure still releases the injected host, catalog, media protocol and library', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-compose-failure-'))
  fs.writeFileSync(path.join(root, '01001.mp4'), 'fixture')
  const library = new VideoLibraryService([root])
  await library.refresh()
  const host = new PlaybackHostFake()
  const protocol = createProtocolFake()
  const mediaSources = new PlayerMediaProtocol(library)
  mediaSources.install(protocol as never)
  let mediaSourcesDisposed = 0
  let catalogClosed = 0
  const recovery = {
    initialize: () => { throw new Error('recovery initialization failed') },
    attachPlayback: () => undefined,
    getState: () => ({ status: 'none' as const }),
    assertPlaybackAllowed: () => undefined,
    resolveInvalidRecovery: () => ({ state: { status: 'none' as const }, preservedFileCount: 0 }),
    leaveStopped: async () => ({ status: 'none' as const }),
    persistTransition: () => undefined,
    dispose: () => undefined
  }
  try {
    await assert.rejects(createStandalonePlayerWithSharedPlayback({
      library,
      mediaSources,
      host,
      catalog: { lookupByVideoCode: async () => { throw new Error('unused') }, close: async () => { catalogClosed++ } },
      recovery,
      disposeMediaSources: () => {
        mediaSourcesDisposed++
        mediaSources.dispose(protocol as never)
      },
      onCoordinationError: () => undefined
    }), /recovery initialization failed/)
    assert.equal(host.disposed, true)
    assert.equal(library.getSnapshot().scanStatus, 'closed')
    assert.equal(mediaSourcesDisposed, 1)
    assert.equal(catalogClosed, 1)
    assert.deepEqual(protocol.removed, ['kq-media'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
