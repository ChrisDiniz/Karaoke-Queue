import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PLAYER_PLAYBACK_RECOVERY_FILENAME,
  PlayerPlaybackRecoveryStore,
  PlayerPlaybackRecoveryStoreError,
  type PlayerPlaybackRecoveryRecord
} from '../src/player-playback-recovery-store'
import { ManualPlaybackService } from '../src/manual-playback-service'
import { PlayerPlaybackRecoveryCoordinator } from '../src/player-playback-recovery'
import {
  type PlayerPlaybackHost,
  type PlayerPlaybackHostCommand,
  type PlayerPlaybackHostEvent
} from '../src/player-playback-contracts'
import { PlayerPlaybackService } from '../src/player-playback-service'
import { VideoLibraryService } from '../src/video-library-service'

const ATTEMPT_ID = 'dfe2b381-6c40-4d43-b94f-72fe8acb3d30'
const NOW = '2026-10-31T12:30:00.000Z'

function record(overrides: Partial<PlayerPlaybackRecoveryRecord> = {}): PlayerPlaybackRecoveryRecord {
  return {
    version: 1,
    revision: 1,
    status: 'pending',
    attemptId: ATTEMPT_ID,
    musicCode: '01001',
    playbackStatus: 'starting',
    lastTransition: 'play-intent',
    updatedAt: NOW,
    startedAt: NOW,
    ...overrides
  }
}

function withStore(run: (root: string, store: PlayerPlaybackRecoveryStore) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-store-'))
  try { run(root, new PlayerPlaybackRecoveryStore(root)) }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
}

class RecoveryTestHost implements PlayerPlaybackHost {
  readonly hostEpoch = 'ece91ee1-01fc-4b56-91d0-a49157d9e88f'
  readonly ready = Promise.resolve()
  readonly commands: PlayerPlaybackHostCommand[] = []
  onCommand: ((command: PlayerPlaybackHostCommand) => void) | undefined
  failNextStop: Error | undefined
  stopAcknowledgement: Promise<void> | undefined
  onStopCommandStarted: (() => void) | undefined
  terminateCalls = 0
  terminateResult = true
  private listeners = new Set<(event: PlayerPlaybackHostEvent) => void>()
  private sequenceByAttempt = new Map<string, number>()

  async send(command: PlayerPlaybackHostCommand): Promise<void> {
    this.commands.push(command)
    this.onCommand?.(command)
    if (command.type === 'stop' && this.failNextStop) {
      const error = this.failNextStop
      this.failNextStop = undefined
      throw error
    }
    if (command.type === 'stop' && this.stopAcknowledgement) {
      this.onStopCommandStarted?.()
      await this.stopAcknowledgement
      this.stopAcknowledgement = undefined
      this.onStopCommandStarted = undefined
    }
    if (command.type === 'load') {
      this.emitMedia(command.attemptId, { type: 'loadedmetadata', duration: 20, videoWidth: 320, videoHeight: 240 })
    } else if (command.type === 'play') {
      this.emitMedia(command.attemptId, { type: 'playing', currentTime: 0.1, duration: 20 })
    } else if (command.type === 'pause') {
      this.emitMedia(command.attemptId, { type: 'pause', currentTime: 1, duration: 20 })
    }
  }

  subscribe(listener: (event: PlayerPlaybackHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitMedia(attemptId: string, observation: Extract<PlayerPlaybackHostEvent, { type: 'media' }>['observation']): void {
    const sequenceNumber = (this.sequenceByAttempt.get(attemptId) ?? 0) + 1
    this.sequenceByAttempt.set(attemptId, sequenceNumber)
    const event: PlayerPlaybackHostEvent = { type: 'media', hostEpoch: this.hostEpoch, attemptId, sequenceNumber, observation }
    for (const listener of this.listeners) listener(event)
  }

  async terminate(): Promise<boolean> {
    this.terminateCalls++
    if (this.terminateResult) {
      for (const listener of this.listeners) listener({ type: 'terminated', hostEpoch: this.hostEpoch })
    }
    return this.terminateResult
  }

  dispose(): void { this.listeners.clear() }
}

async function makeRecovery(initial?: PlayerPlaybackRecoveryRecord) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-coordinator-'))
  const libraryRoot = path.join(root, 'media')
  fs.mkdirSync(libraryRoot)
  fs.writeFileSync(path.join(libraryRoot, '01001.mp4'), 'indexed test media')
  fs.writeFileSync(path.join(libraryRoot, '01002.mp4'), 'indexed test media 2')
  const store = new PlayerPlaybackRecoveryStore(path.join(root, 'profile'))
  if (initial) store.write(initial)
  const coordinator = new PlayerPlaybackRecoveryCoordinator(store, () => new Date(NOW))
  coordinator.initialize()
  const library = new VideoLibraryService([libraryRoot])
  const host = new RecoveryTestHost()
  const mediaSources = {
    grant(musicCode: string) {
      return { url: `kq-media://test/${musicCode}`, revoke() {} }
    }
  }
  await library.refresh()
  const playback = new PlayerPlaybackService(library, mediaSources, coordinator)
  const manual = new ManualPlaybackService(playback)
  playback.attachHost(host)
  coordinator.attach(playback, manual)
  return {
    root, store, coordinator, playback, manual, host,
    async cleanup() {
      manual.dispose()
      await playback.dispose()
      library.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

test('missing recovery file is an empty state and reading does not create a file', () => {
  withStore((root, store) => {
    assert.equal(store.read(), undefined)
    assert.equal(fs.existsSync(path.join(root, PLAYER_PLAYBACK_RECOVERY_FILENAME)), false)
  })
})

test('versioned active playback record is atomically persisted and read back', () => {
  withStore((root, store) => {
    const active = record({ status: 'playing', playbackStatus: 'playing', lastTransition: 'playback-started', startedAt: NOW })
    assert.deepEqual(store.write(active), active)
    assert.deepEqual(store.read(), active)
    assert.deepEqual(fs.readdirSync(root), [PLAYER_PLAYBACK_RECOVERY_FILENAME],
      'successful atomic replacement leaves no temporary files behind')
  })
})

test('confirmed natural completion and Stop remain distinct durable terminal outcomes', () => {
  withStore((_root, store) => {
    const completed = record({ status: 'completed', playbackStatus: 'completed', lastTransition: 'natural-end-confirmed',
      startedAt: NOW, terminalAt: NOW, reason: 'natural-end-candidate' })
    store.write(completed)
    assert.deepEqual(store.read(), completed)

    const stopped = record({ revision: 2, status: 'stopped', playbackStatus: 'stopped', lastTransition: 'stop-confirmed',
      startedAt: NOW, terminalAt: NOW, reason: 'operator-stop' })
    store.write(stopped)
    assert.deepEqual(store.read(), stopped)
    assert.notEqual(store.read()?.status, 'completed')
  })
})

test('uncertain process termination remains an identified unresolved attempt', () => {
  withStore((_root, store) => {
    const uncertain = record({ status: 'uncertain', playbackStatus: 'uncertain', lastTransition: 'host-terminated',
      reason: 'process-ended-without-confirmed-terminal-outcome' })
    store.write(uncertain)
    assert.deepEqual(store.read(), uncertain)
  })
})

test('truncated or malformed JSON is rejected and preserved byte-for-byte', () => {
  withStore((root, store) => {
    const target = path.join(root, PLAYER_PLAYBACK_RECOVERY_FILENAME)
    const corrupt = Buffer.from('{"version":1,"status":"playing"')
    fs.writeFileSync(target, corrupt)
    assert.throws(() => store.read(), (error: unknown) =>
      error instanceof PlayerPlaybackRecoveryStoreError && error.code === 'UNREADABLE')
    assert.deepEqual(fs.readFileSync(target), corrupt)
  })
})

test('semantically contradictory playback recovery records are rejected and preserved byte-for-byte', () => {
  withStore((root, store) => {
    const target = path.join(root, PLAYER_PLAYBACK_RECOVERY_FILENAME)
    const contradictory = Buffer.from(`${JSON.stringify(record({
      status: 'completed',
      playbackStatus: 'playing',
      lastTransition: 'playback-uncertain',
      startedAt: NOW,
      terminalAt: NOW
    }))}\n`)
    fs.writeFileSync(target, contradictory)

    assert.throws(() => store.read(), (error: unknown) =>
      error instanceof PlayerPlaybackRecoveryStoreError && error.code === 'INVALID_RECORD')
    assert.deepEqual(fs.readFileSync(target), contradictory,
      'the store must preserve contradictory evidence for diagnosis rather than rewriting it')
  })
})

test('unsupported recovery schema version is not treated as empty and remains untouched', () => {
  withStore((root, store) => {
    const target = path.join(root, PLAYER_PLAYBACK_RECOVERY_FILENAME)
    const raw = Buffer.from(JSON.stringify({ ...record(), version: 2 }))
    fs.writeFileSync(target, raw)
    assert.throws(() => store.read(), (error: unknown) =>
      error instanceof PlayerPlaybackRecoveryStoreError && error.code === 'UNSUPPORTED_VERSION')
    assert.deepEqual(fs.readFileSync(target), raw)
  })
})

test('invalid identifiers, paths, unknown fields and invalid timestamps are rejected before writing', () => {
  withStore((root, store) => {
    const target = path.join(root, PLAYER_PLAYBACK_RECOVERY_FILENAME)
    const invalidRecords: unknown[] = [
      { ...record(), musicCode: '1001' },
      { ...record(), attemptId: '../outside' },
      { ...record(), absolutePath: '/outside/video.mp4' },
      { ...record(), updatedAt: 'not-a-date' },
      { ...record(), status: 'playing', attemptId: undefined, musicCode: undefined }
    ]
    for (const invalid of invalidRecords) {
      assert.throws(() => store.write(invalid as PlayerPlaybackRecoveryRecord), (error: unknown) =>
        error instanceof PlayerPlaybackRecoveryStoreError && error.code === 'INVALID_RECORD')
      assert.equal(fs.existsSync(target), false)
    }
  })
})

test('write failure does not delete or rewrite the existing recovery evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-write-failure-'))
  const nonDirectory = path.join(root, 'not-a-directory')
  fs.writeFileSync(nonDirectory, 'preserve')
  try {
    const store = new PlayerPlaybackRecoveryStore(nonDirectory)
    assert.throws(() => store.write(record()), (error: unknown) =>
      error instanceof PlayerPlaybackRecoveryStoreError && error.code === 'WRITE_FAILED')
    assert.equal(fs.readFileSync(nonDirectory, 'utf8'), 'preserve')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a directory-sync failure after replacing the record rolls back to the previous conservative snapshot on read', () => {
  class FailThirdDirectorySyncStore extends PlayerPlaybackRecoveryStore {
    directorySyncCalls = 0
    failOnCall = 0
    protected override syncDirectory(): void {
      this.directorySyncCalls++
      if (this.directorySyncCalls === this.failOnCall) throw new Error('simulated directory fsync failure')
      super.syncDirectory()
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-ambiguous-write-'))
  try {
    const store = new FailThirdDirectorySyncStore(root)
    const previous = record()
    store.write(previous)
    store.directorySyncCalls = 0
    store.failOnCall = 3 // previous snapshot, prepared marker, then replacement record
    const completed = record({ revision: 2, status: 'completed', playbackStatus: 'completed',
      lastTransition: 'natural-end-confirmed', terminalAt: NOW })
    assert.throws(() => store.write(completed), (error: unknown) =>
      error instanceof PlayerPlaybackRecoveryStoreError && error.code === 'WRITE_FAILED')
    assert.deepEqual(store.read(), previous,
      'an uncommitted terminal replacement is rolled back to the durable active attempt')
    assert.equal(store.read()?.status, 'pending')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('replacing a record leaves only the latest complete record', () => {
  withStore((root, store) => {
    store.write(record())
    const next = record({ revision: 2, status: 'paused', playbackStatus: 'paused', lastTransition: 'playback-paused' })
    store.write(next)
    assert.deepEqual(store.read(), next)
    assert.deepEqual(fs.readdirSync(root), [PLAYER_PLAYBACK_RECOVERY_FILENAME])
  })
})

test('active recovery is exposed as pending on startup and never autoplays', async () => {
  const context = await makeRecovery(record({ status: 'playing', playbackStatus: 'playing',
    lastTransition: 'playback-started', startedAt: NOW }))
  try {
    assert.deepEqual(context.coordinator.getState(), {
      status: 'pending', attemptId: ATTEMPT_ID, musicCode: '01001', playbackStatus: 'playing',
      lastTransition: 'playback-started', updatedAt: NOW
    })
    assert.equal(context.playback.getState().status, 'idle')
    assert.deepEqual(context.host.commands, [], 'startup recovery never sends a media command')
  } finally { await context.cleanup() }
})

test('Standalone fresh startup durably marks an inherited paused attempt stopped without replay', async () => {
  const context = await makeRecovery(record({ status: 'paused', playbackStatus: 'paused',
    lastTransition: 'playback-paused', startedAt: NOW }))
  try {
    assert.equal(context.coordinator.getState().status, 'pending')
    const result = await context.coordinator.resolveStandaloneStartup()
    assert.deepEqual(result, { status: 'resolved', outcome: 'dismissed', attemptId: ATTEMPT_ID,
      musicCode: '01001', updatedAt: NOW })
    assert.equal(context.store.read()?.status, 'dismissed')
    assert.equal(context.store.read()?.reason, 'startup-prior:paused:playback-paused',
      'the terminal record retains the interrupted state as diagnostic evidence')
    assert.equal(context.store.read()?.startedAt, NOW)
    assert.equal(context.playback.getState().status, 'idle')
    assert.equal(context.host.commands.some(command => command.type === 'load' || command.type === 'play'), false,
      'startup recovery must not load or play prior media')
    assert.equal(context.host.commands.some(command => command.type === 'clear' && command.attemptId === ATTEMPT_ID), true,
      'startup recovery confirms the new media surface contains no old attempt before becoming idle')
    assert.doesNotThrow(() => context.coordinator.assertPlaybackAllowed())
  } finally { await context.cleanup() }
})

test('Standalone startup resolves inherited playing, loading, and uncertain records without restoring playback', async () => {
  const previousStates: Array<Partial<PlayerPlaybackRecoveryRecord>> = [
    { status: 'playing', playbackStatus: 'playing', lastTransition: 'playback-started' },
    { status: 'pending', playbackStatus: 'loading', lastTransition: 'load-intent' },
    { status: 'uncertain', playbackStatus: 'uncertain', lastTransition: 'playback-uncertain' }
  ]
  for (const prior of previousStates) {
    const context = await makeRecovery(record(prior))
    try {
      const result = await context.coordinator.resolveStandaloneStartup()
      assert.equal(result.status, 'resolved')
      if (result.status === 'resolved') assert.equal(result.outcome, 'dismissed')
      assert.equal(context.store.read()?.status, 'dismissed')
      assert.equal(context.store.read()?.reason, `startup-prior:${prior.playbackStatus}:${prior.lastTransition}`)
      assert.equal(context.playback.getState().status, 'idle')
      assert.equal(context.host.commands.some(command => command.type === 'load' || command.type === 'play'), false)
      assert.deepEqual(context.host.commands.filter(command => command.type === 'clear').map(command => command.attemptId), [ATTEMPT_ID])
    } finally { await context.cleanup() }
  }
})

test('Standalone startup keeps recovery pending when the fresh media host does not confirm its idle surface', async () => {
  const context = await makeRecovery(record({ status: 'paused', playbackStatus: 'paused',
    lastTransition: 'playback-paused', startedAt: NOW }))
  try {
    context.playback.clearFreshStartupRecovery = async () => false
    await assert.rejects(context.coordinator.resolveStandaloneStartup(), { code: 'RECOVERY_UNAVAILABLE' })
    assert.equal(context.store.read()?.status, 'paused', 'failed containment must not publish a terminal recovery record')
    assert.equal(context.coordinator.getState().status, 'pending')
    assert.equal(context.playback.getState().status, 'idle')
    assert.throws(() => context.coordinator.assertPlaybackAllowed(), { code: 'RECOVERY_PENDING' })
    assert.deepEqual(context.host.commands, [])
  } finally { await context.cleanup() }
})

test('startup recovery pending blocks new manual playback until an explicit recovery action', async () => {
  const context = await makeRecovery(record({ status: 'playing', playbackStatus: 'playing', lastTransition: 'playback-started' }))
  try {
    const result = await context.manual.playByMusicCode('1002')
    assert.equal(result.outcome, 'unavailable')
    if (result.outcome === 'unavailable') assert.equal(result.reason, 'RECOVERY_PENDING')
    assert.deepEqual(context.host.commands, [], 'a blocked recovery must have no external media side effect')
    const replay = await context.coordinator.replayPrevious(ATTEMPT_ID)
    assert.equal(replay.outcome, 'started')
    assert.notEqual(replay.state.attemptId, ATTEMPT_ID)
  } finally { await context.cleanup() }
})

test('a new in-process playback is not shown as startup recovery but remains recoverable after restart', async () => {
  const context = await makeRecovery()
  try {
    const started = await context.manual.playByMusicCode('1001')
    assert.equal(started.outcome, 'started')
    assert.equal(context.coordinator.getState().status, 'none',
      'the active attempt must not open a recovery decision over the live Player controls')
    assert.equal(context.store.read()?.status, 'playing',
      'the unresolved attempt remains durably recorded for a later process restart')

    const restartedCoordinator = new PlayerPlaybackRecoveryCoordinator(context.store, () => new Date(NOW))
    const recovered = restartedCoordinator.initialize()
    assert.equal(recovered.status, 'pending', 'the next process must still require an explicit recovery decision')
    if (recovered.status === 'pending') assert.equal(recovered.attemptId, started.state.attemptId)
  } finally { await context.cleanup() }
})

test('confirmed terminal records are restored as resolved, not crash-pending', async () => {
  const completed = record({ status: 'completed', playbackStatus: 'completed',
    lastTransition: 'natural-end-confirmed', terminalAt: NOW, startedAt: NOW })
  const context = await makeRecovery(completed)
  try {
    assert.deepEqual(context.coordinator.getState(), {
      status: 'resolved', outcome: 'completed', attemptId: ATTEMPT_ID, musicCode: '01001', updatedAt: NOW
    })
    assert.equal(context.host.commands.length, 0)
  } finally { await context.cleanup() }
})

test('explicit replay re-resolves the code, creates a new attempt, and invalidates the old recovery action', async () => {
  const context = await makeRecovery(record({ status: 'uncertain', playbackStatus: 'uncertain',
    lastTransition: 'playback-uncertain' }))
  try {
    const oldAttempt = context.coordinator.getState()
    assert.equal(oldAttempt.status, 'pending')
    assert.equal(context.host.commands.length, 0)

    const result = await context.coordinator.replayPrevious(ATTEMPT_ID)
    assert.equal(result.outcome, 'started')
    assert.equal(result.state.musicCode, '01001')
    assert.notEqual(result.state.attemptId, ATTEMPT_ID)
    assert.equal(context.coordinator.getState().status, 'none',
      'the new active attempt is not a recovery prompt within the current process')
    assert.equal(context.store.read()?.status, 'playing', 'the new active attempt remains durably recoverable')
    const restartedCoordinator = new PlayerPlaybackRecoveryCoordinator(context.store, () => new Date(NOW))
    const restartedRecovery = restartedCoordinator.initialize()
    assert.equal(restartedRecovery.status, 'pending', 'a later process restart must expose the active record')
    if (restartedRecovery.status === 'pending') assert.equal(restartedRecovery.attemptId, result.state.attemptId)
    assert.equal(context.host.commands.some(command => command.type === 'load' && 'musicCode' in command && command.musicCode === '01001'), true)
    await assert.rejects(context.coordinator.replayPrevious(ATTEMPT_ID), /obsoleta|pendente/)
  } finally { await context.cleanup() }
})

test('choose another requires the expected recovery identity and uses normal manual validation', async () => {
  const context = await makeRecovery(record({ status: 'pending', playbackStatus: 'starting', lastTransition: 'play-intent' }))
  try {
    await assert.rejects(context.coordinator.chooseAnother('00000000-0000-4000-8000-000000000000', '1002'), /obsoleta/)
    const result = await context.coordinator.chooseAnother(ATTEMPT_ID, '1002')
    assert.equal(result.outcome, 'started')
    assert.equal(result.state.musicCode, '01002')
    assert.notEqual(result.state.attemptId, ATTEMPT_ID)
    assert.equal(context.host.commands.some(command => command.type === 'load' && 'musicCode' in command && command.musicCode === '01002'), true)
  } finally { await context.cleanup() }
})

test('leave stopped resolves pending recovery and runtime state without natural completion', async () => {
  const context = await makeRecovery(record({ status: 'uncertain', playbackStatus: 'uncertain',
    lastTransition: 'host-terminated' }))
  try {
    const resolved = await context.coordinator.leaveStopped(ATTEMPT_ID)
    assert.deepEqual(resolved, {
      status: 'resolved', outcome: 'dismissed', attemptId: ATTEMPT_ID, musicCode: '01001', updatedAt: NOW
    })
    assert.equal(context.store.read()?.lastTransition, 'recovery-dismissed')
    assert.equal(context.store.read()?.status, 'dismissed')
    assert.equal(context.playback.getState().status, 'stopped')
    assert.equal(context.playback.getState().attemptId, ATTEMPT_ID)
    assert.deepEqual(context.host.commands, [])
    await assert.rejects(context.coordinator.leaveStopped(ATTEMPT_ID), /obsoleta|pendente/)
  } finally { await context.cleanup() }
})

test('concurrent leave stopped decisions resolve one recovery attempt only once', async () => {
  const context = await makeRecovery(record({ status: 'uncertain', playbackStatus: 'uncertain',
    lastTransition: 'host-terminated' }))
  try {
    const results = await Promise.allSettled([
      context.coordinator.leaveStopped(ATTEMPT_ID),
      context.coordinator.leaveStopped(ATTEMPT_ID)
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.equal(rejected?.status, 'rejected')
    if (rejected?.status === 'rejected') assert.match(String(rejected.reason), /resolvida|obsoleta|pendente/)
    assert.equal(context.store.read()?.status, 'dismissed')
    assert.equal(context.store.read()?.lastTransition, 'recovery-dismissed')
    assert.equal(context.store.read()?.revision, 2, 'the duplicate decision must not write a second terminal revision')
    assert.equal(context.playback.getState().status, 'stopped')
    assert.equal(context.host.commands.length, 0)
  } finally { await context.cleanup() }
})

test('confirmed shutdown retries bounded host containment for an uncertain attempt without active playback', async () => {
  const context = await makeRecovery()
  try {
    const started = await context.manual.playByMusicCode('1001')
    const attemptId = started.state.attemptId!
    context.host.failNextStop = new Error('simulated stop timeout')
    context.host.terminateResult = false
    const firstStop = await context.manual.stop()
    assert.equal(firstStop.outcome, 'uncertain')
    assert.equal(context.playback.getState().containmentStatus, 'unconfirmed')
    assert.equal(context.host.terminateCalls, 1)

    const shutdown = context.coordinator.requestShutdown()
    assert.equal(shutdown.outcome, 'confirmation-required')
    if (shutdown.outcome !== 'confirmation-required') return
    const result = await context.coordinator.confirmShutdown(attemptId)
    assert.equal(result.outcome, 'uncertain')
    assert.equal(context.host.terminateCalls, 2, 'shutdown tries one additional bounded termination of the owned host')
    assert.equal(context.store.read()?.status, 'uncertain')
    assert.equal(context.store.read()?.playbackStatus, 'uncertain')
    assert.equal(context.playback.getState().status, 'disposed')
    assert.equal(context.playback.getState().containmentStatus, 'unconfirmed')
  } finally { await context.cleanup() }
})

test('Main shutdown stop persists and verifies a terminal recovery transition before service disposal', async () => {
  const context = await makeRecovery()
  try {
    const started = await context.manual.playByMusicCode('1001')
    assert.equal(started.outcome, 'started')
    const attemptId = started.state.attemptId!
    const stopped = await context.playback.stopForShutdown(attemptId)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.attemptId, attemptId)
    assert.equal(context.store.read()?.lastTransition, 'shutdown-confirmed')
    assert.equal(context.store.read()?.status, 'stopped')
    assert.deepEqual(context.coordinator.verifyPersistedState(), {
      status: 'resolved', outcome: 'stopped', attemptId, musicCode: '01001', updatedAt: NOW
    })
  } finally { await context.cleanup() }
})

test('an EOF arriving while shutdown Stop awaits host acknowledgement cannot become a natural completion', async () => {
  const context = await makeRecovery()
  const naturalEnds: string[] = []
  try {
    const started = await context.manual.playByMusicCode('1001')
    assert.equal(started.outcome, 'started')
    const attemptId = started.state.attemptId!
    let acknowledgeStop!: () => void
    let signalStopStarted!: () => void
    const stopAcknowledgement = new Promise<void>(resolve => { acknowledgeStop = resolve })
    const stopStarted = new Promise<void>(resolve => { signalStopStarted = resolve })
    context.host.stopAcknowledgement = stopAcknowledgement
    context.host.onStopCommandStarted = signalStopStarted
    context.playback.subscribe(event => {
      if (event.type === 'natural-end-candidate') naturalEnds.push(event.attemptId)
    })

    const shutdown = context.playback.stopForShutdown(attemptId)
    await stopStarted
    assert.equal(context.store.read()?.lastTransition, 'shutdown-stop-intent',
      'The shutdown intent must be durable before the Stop reaches its host.')
    context.host.emitMedia(attemptId, { type: 'ended', currentTime: 20, duration: 20 })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(naturalEnds, [], 'A late ended event for the shutdown-owned attempt must be ignored.')
    assert.equal(context.store.read()?.lastTransition, 'shutdown-stop-intent',
      'The racing EOF must not overwrite the durable shutdown transition.')

    acknowledgeStop()
    const stopped = await shutdown
    assert.equal(stopped.status, 'stopped')
    assert.equal(context.store.read()?.lastTransition, 'shutdown-confirmed')
    assert.equal(context.store.read()?.status, 'stopped')
    assert.deepEqual(naturalEnds, [])
  } finally { await context.cleanup() }
})

test('Main shutdown can retry uncertain containment while recovery and playback owners remain alive', async () => {
  const context = await makeRecovery()
  try {
    const started = await context.manual.playByMusicCode('1001')
    assert.equal(started.outcome, 'started')
    context.host.failNextStop = new Error('simulated missing shutdown Stop acknowledgement')
    context.host.terminateResult = false
    await assert.rejects(context.playback.stopForShutdown(started.state.attemptId), /simulated missing shutdown Stop acknowledgement/)
    assert.equal(context.playback.getState().status, 'uncertain')
    assert.equal(context.playback.getState().containmentStatus, 'unconfirmed')
    assert.equal(context.coordinator.verifyPersistedState().status, 'pending')

    const retried = await context.playback.retryShutdownContainment()
    assert.equal(retried.status, 'uncertain')
    assert.equal(retried.containmentStatus, 'stop-acknowledged')
    assert.equal(retried.errorCode, undefined)
    assert.equal(context.store.read()?.lastTransition, 'containment-updated')
    assert.equal(context.coordinator.verifyPersistedState().status, 'pending')
  } finally { await context.cleanup() }
})

test('recovery read-back blocks shutdown when the previously confirmed record disappears', async () => {
  const context = await makeRecovery(record({ status: 'playing', playbackStatus: 'playing',
    lastTransition: 'playback-started' }))
  try {
    fs.unlinkSync(context.store.filePath)
    const verified = context.coordinator.verifyPersistedState()
    assert.deepEqual(verified, { status: 'unavailable', reason: 'WRITE_FAILED' })
  } finally { await context.cleanup() }
})

test('recovery read-back blocks a valid same-attempt record with divergent confirmed contents', async () => {
  const context = await makeRecovery(record({ status: 'playing', playbackStatus: 'playing',
    lastTransition: 'playback-started' }))
  try {
    const confirmed = context.store.read()!
    context.store.write({ ...confirmed, status: 'uncertain', playbackStatus: 'uncertain',
      lastTransition: 'playback-uncertain' })
    const verified = context.coordinator.verifyPersistedState()
    assert.deepEqual(verified, { status: 'unavailable', reason: 'WRITE_FAILED' },
      'matching attempt and revision do not prove that the confirmed recovery transition remains intact')
  } finally { await context.cleanup() }
})

test('shutdown requires an explicit decision for active playback; cancellation preserves it and confirmation stops it', async () => {
  const context = await makeRecovery()
  try {
    const started = await context.manual.playByMusicCode('1001')
    assert.equal(started.outcome, 'started')
    const attemptId = started.state.attemptId!
    const required = context.coordinator.requestShutdown()
    assert.deepEqual(required, { outcome: 'confirmation-required', attemptId, musicCode: '01001', playbackStatus: 'playing' })

    assert.deepEqual(context.coordinator.cancelShutdown(attemptId), { outcome: 'cancelled', attemptId })
    assert.equal(context.playback.getState().status, 'playing')
    assert.equal(context.coordinator.getState().status, 'none')
    assert.equal(context.store.read()?.status, 'playing')

    const confirming = context.coordinator.confirmShutdown(attemptId)
    await assert.rejects(context.manual.playByMusicCode('1002'), /encerrado/,
      'confirmed shutdown closes manual command admission before Stop is acknowledged')
    const confirmed = await confirming
    assert.equal(confirmed.outcome, 'stopped')
    assert.equal(context.playback.getState().status, 'disposed')
    assert.equal(context.store.read()?.status, 'stopped')
    assert.equal(context.store.read()?.lastTransition, 'stop-confirmed')
    assert.equal(context.host.commands.filter(command => command.type === 'stop').length, 1)
    assert.notEqual(confirmed.recovery.status, 'pending')
  } finally { await context.cleanup() }
})

test('shutdown decisions reject stale attempts and do not stop a newer selection', async () => {
  const context = await makeRecovery()
  try {
    const first = await context.manual.playByMusicCode('1001')
    const oldAttempt = first.state.attemptId!
    await context.manual.playByMusicCode('1002')
    const current = context.playback.getState()
    assert.notEqual(current.attemptId, oldAttempt)
    assert.throws(() => context.coordinator.cancelShutdown(oldAttempt), /outra tentativa/)
    await assert.rejects(context.coordinator.confirmShutdown(oldAttempt), /obsoleta/)
    assert.equal(context.playback.getState().status, 'playing')
    assert.equal(context.playback.getState().attemptId, current.attemptId)
  } finally { await context.cleanup() }
})

test('playback intent and each terminal transition are durable before the corresponding event is published', async () => {
  const context = await makeRecovery()
  const observedBeforeHostCommand: Array<{ type: string; record: PlayerPlaybackRecoveryRecord | undefined }> = []
  const naturalEndRecords: Array<PlayerPlaybackRecoveryRecord | undefined> = []
  context.host.onCommand = command => observedBeforeHostCommand.push({ type: command.type, record: context.store.read() })
  context.playback.subscribe(event => {
    if (event.type === 'natural-end-candidate') naturalEndRecords.push(context.store.read())
  })
  try {
    const started = await context.manual.playByMusicCode('1001')
    assert.equal(started.outcome, 'started')
    const load = observedBeforeHostCommand.find(item => item.type === 'load')
    const play = observedBeforeHostCommand.find(item => item.type === 'play')
    assert.equal(load?.record?.status, 'pending')
    assert.equal(load?.record?.lastTransition, 'load-intent')
    assert.equal(load?.record?.attemptId, started.state.attemptId)
    assert.equal(play?.record?.status, 'pending')
    assert.equal(play?.record?.lastTransition, 'play-intent')

    context.host.emitMedia(started.state.attemptId!, { type: 'ended', currentTime: 20, duration: 20 })
    for (let turn = 0; turn < 20 && naturalEndRecords.length === 0; turn++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.equal(naturalEndRecords.length, 1)
    assert.equal(naturalEndRecords[0]?.status, 'completed')
    assert.equal(naturalEndRecords[0]?.lastTransition, 'natural-end-confirmed')
    assert.equal(context.coordinator.getState().status, 'resolved')
  } finally { await context.cleanup() }
})

test('failure to persist natural EOF keeps the prior durable attempt pending and emits no completion candidate', async () => {
  const context = await makeRecovery()
  const naturalEnds: string[] = []
  context.playback.subscribe(event => { if (event.type === 'natural-end-candidate') naturalEnds.push(event.attemptId) })
  try {
    const started = await context.manual.playByMusicCode('1001')
    assert.equal(started.outcome, 'started')
    const originalWrite = context.store.write.bind(context.store)
    context.store.write = candidate => {
      if (candidate.status === 'completed') throw new PlayerPlaybackRecoveryStoreError('WRITE_FAILED', 'injected persistence failure')
      return originalWrite(candidate)
    }
    context.host.emitMedia(started.state.attemptId!, { type: 'ended', currentTime: 20, duration: 20 })
    for (let turn = 0; turn < 20 && context.playback.getState().status !== 'uncertain'; turn++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.equal(context.playback.getState().status, 'uncertain')
    assert.equal(context.playback.getState().errorCode, 'RECOVERY_PERSISTENCE_FAILED')
    assert.deepEqual(naturalEnds, [])
    assert.equal(context.store.read()?.status, 'playing', 'the last committed active record is preserved')
    assert.equal(context.coordinator.getState().status, 'unavailable')
  } finally { await context.cleanup() }
})

test('unacknowledged Stop remains uncertain after bounded host containment', async () => {
  const context = await makeRecovery()
  try {
    const started = await context.manual.playByMusicCode('1001')
    assert.equal(started.outcome, 'started')
    context.host.failNextStop = new Error('simulated missing Stop acknowledgement')
    const stopped = await context.manual.stop()
    assert.equal(stopped.outcome, 'uncertain')
    assert.equal(context.playback.getState().status, 'uncertain')
    assert.equal(context.playback.getState().containmentStatus, 'host-terminated')
    assert.equal(context.store.read()?.status, 'uncertain')
    assert.equal(context.store.read()?.lastTransition, 'containment-updated')
    assert.equal(context.coordinator.getState().status, 'pending')
  } finally { await context.cleanup() }
})

test('corrupt recovery data is not overwritten and blocks playback without preventing service construction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-corrupt-'))
  const profile = path.join(root, 'profile')
  fs.mkdirSync(profile)
  const store = new PlayerPlaybackRecoveryStore(profile)
  const bytes = Buffer.from('{broken recovery evidence')
  fs.writeFileSync(store.filePath, bytes)
  const coordinator = new PlayerPlaybackRecoveryCoordinator(store)
  assert.equal(coordinator.initialize().status, 'unreadable')

  const libraryRoot = path.join(root, 'media')
  fs.mkdirSync(libraryRoot)
  fs.writeFileSync(path.join(libraryRoot, '01001.mp4'), 'test media')
  const library = new VideoLibraryService([libraryRoot])
  await library.refresh()
  const host = new RecoveryTestHost()
  const playback = new PlayerPlaybackService(library, {
    grant: musicCode => ({ url: `kq-media://test/${musicCode}`, revoke() {} })
  }, coordinator)
  const manual = new ManualPlaybackService(playback)
  playback.attachHost(host)
  coordinator.attach(playback, manual)
  try {
    const result = await manual.playByMusicCode('1001')
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.reason, 'RECOVERY_UNAVAILABLE')
    assert.deepEqual(host.commands, [], 'unreadable recovery prevents external media effects')
    assert.deepEqual(fs.readFileSync(store.filePath), bytes)
  } finally {
    manual.dispose()
    await playback.dispose()
    library.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('explicit invalid recovery resolution archives the exact evidence and permits only a stopped startup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-quarantine-'))
  const store = new PlayerPlaybackRecoveryStore(root)
  const corrupt = Buffer.from('{broken recovery evidence with useful diagnostics')
  fs.writeFileSync(store.filePath, corrupt)
  const coordinator = new PlayerPlaybackRecoveryCoordinator(store, () => new Date(NOW))
  assert.equal(coordinator.initialize().status, 'unreadable')
  try {
    const result = coordinator.resolveInvalidRecovery()
    assert.equal(result.state.status, 'none')
    assert.equal(result.preservedFileCount, 1)
    assert.deepEqual(store.read(), {
      version: 1, revision: 1, status: 'idle', playbackStatus: 'idle',
      lastTransition: 'invalid-recovery-resolved', updatedAt: NOW
    })
    const archives = fs.readdirSync(root).filter(name => name.startsWith('player-playback-recovery-quarantine-'))
    assert.equal(archives.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(root, archives[0])), corrupt)
    assert.equal(new PlayerPlaybackRecoveryCoordinator(new PlayerPlaybackRecoveryStore(root)).initialize().status, 'none',
      'a process restart must observe the verified stopped record without replaying the old attempt')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('recovery resolution stays blocked and preserves a source entry replaced during quarantine move', () => {
  class ReplaceSourceDuringMoveStore extends PlayerPlaybackRecoveryStore {
    replacement: Buffer | undefined
    protected override moveSourceToArchive(sourcePath: string, archivePath: string): void {
      fs.writeFileSync(sourcePath, this.replacement!)
      super.moveSourceToArchive(sourcePath, archivePath)
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-replaced-source-'))
  const store = new ReplaceSourceDuringMoveStore(root)
  const original = Buffer.from('{original invalid recovery evidence}')
  const replacement = Buffer.from('{concurrent replacement evidence}')
  store.replacement = replacement
  fs.writeFileSync(store.filePath, original)
  const coordinator = new PlayerPlaybackRecoveryCoordinator(store, () => new Date(NOW))
  assert.equal(coordinator.initialize().status, 'unreadable')
  try {
    assert.throws(() => coordinator.resolveInvalidRecovery(), /preservada com segurança/)
    assert.equal(coordinator.getState().status, 'unreadable')
    assert.equal(fs.existsSync(store.filePath), false, 'the moved entry remains quarantined rather than being unlinked')
    const archive = fs.readdirSync(root).find(name => name.startsWith('player-playback-recovery-quarantine-'))
    assert.ok(archive)
    assert.deepEqual(fs.readFileSync(path.join(root, archive)), replacement)
    assert.throws(() => new PlayerPlaybackRecoveryStore(root).read(), /preservada/,
      'the manifest mismatch remains blocking after restart')
    assert.equal(fs.existsSync(store.filePath), false, 'no safe idle recovery record is written')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('recovery resolution resumes after idle is durable but before its manifest is removed', () => {
  class FailAfterIdleRecordStore extends PlayerPlaybackRecoveryStore {
    failed = false
    protected override writeAtomicPath(filePath: string, content: string | Uint8Array): void {
      super.writeAtomicPath(filePath, content)
      if (filePath === this.filePath && !this.failed) {
        this.failed = true
        throw new Error('simulated interruption after durable idle record')
      }
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-idle-journal-'))
  const store = new FailAfterIdleRecordStore(root)
  const corrupt = Buffer.from('{invalid source evidence before idle commit}')
  fs.writeFileSync(store.filePath, corrupt)
  const coordinator = new PlayerPlaybackRecoveryCoordinator(store, () => new Date(NOW))
  assert.equal(coordinator.initialize().status, 'unreadable')
  try {
    assert.throws(() => coordinator.resolveInvalidRecovery(), /preservada com segurança/)
    assert.equal(coordinator.getState().status, 'unreadable')
    const idle = new PlayerPlaybackRecoveryStore(root).read()
    assert.equal(idle?.status, 'idle')
    assert.equal(idle?.lastTransition, 'invalid-recovery-resolved')
    assert.equal(fs.readdirSync(root).some(name => name === '.player-playback-recovery-resolution.json'), false,
      'startup completes the already-committed resolution journal')
    const archive = fs.readdirSync(root).find(name => name.startsWith('player-playback-recovery-quarantine-'))
    assert.ok(archive)
    assert.deepEqual(fs.readFileSync(path.join(root, archive)), corrupt)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed quarantine remains blocked and a restart resumes the durable resolution manifest', () => {
  class FailFirstDirectorySyncStore extends PlayerPlaybackRecoveryStore {
    shouldFail = true
    protected override syncDirectory(): void {
      if (this.shouldFail) { this.shouldFail = false; throw new Error('injected directory sync failure') }
      super.syncDirectory()
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-quarantine-failure-'))
  const failingStore = new FailFirstDirectorySyncStore(root)
  const corrupt = Buffer.from('{keep this recovery evidence}')
  fs.writeFileSync(failingStore.filePath, corrupt)
  const coordinator = new PlayerPlaybackRecoveryCoordinator(failingStore, () => new Date(NOW))
  assert.equal(coordinator.initialize().status, 'unreadable')
  try {
    assert.throws(() => coordinator.resolveInvalidRecovery(), /preservada com segurança/)
    assert.equal(coordinator.getState().status, 'unreadable')
    assert.deepEqual(fs.readFileSync(failingStore.filePath), corrupt,
      'the original file remains available when writing the resolution journal fails')

    const restartedStore = new PlayerPlaybackRecoveryStore(root)
    assert.equal(restartedStore.read()?.lastTransition, 'invalid-recovery-resolved')
    const archives = fs.readdirSync(root).filter(name => name.startsWith('player-playback-recovery-quarantine-'))
    assert.equal(archives.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(root, archives[0])), corrupt)
    assert.equal(new PlayerPlaybackRecoveryCoordinator(restartedStore).initialize().status, 'none')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
