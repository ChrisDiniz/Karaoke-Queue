import test from 'node:test'
import assert from 'node:assert/strict'
import { MainStandaloneShutdownCoordinator, canFinishStandaloneShutdown, withShutdownDeadline } from '../src/main-standalone-shutdown'
import type { PlayerRecoverySnapshot } from '../src/player-playback-recovery-contracts'
import type { PlayerPlaybackState } from '../src/player-playback-contracts'

function coordinatorSetup(options: {
  admission?: () => Promise<void>
  sequenceDispose?: () => Promise<void>
  initialPlayback?: PlayerPlaybackState
  afterDisposePlayback?: PlayerPlaybackState
} = {}) {
  const calls: string[] = []
  let recovery: PlayerRecoverySnapshot = { status: 'none' }
  let playbackState = options.initialPlayback ?? { status: 'idle' as const }
  const bridge = {
    beginCloseAdmission: () => { calls.push('close-admission'); return options.admission?.() ?? Promise.resolve() },
    resumeAdmissionAfterFailedShutdown: () => { calls.push('resume-admission') },
    resetExitConfirmationAfterFailedShutdown: () => { calls.push('reset-confirmation') }
  }
  const sequence = {
    beginShutdown: async () => { calls.push('sequence-begin') },
    resumeAfterFailedShutdown: async () => { calls.push('sequence-resume') },
    dispose: async () => { calls.push('sequence-dispose'); await options.sequenceDispose?.(); if (options.afterDisposePlayback) playbackState = options.afterDisposePlayback }
  }
  const playback = {
    getState: () => ({ ...playbackState }),
    stopForShutdown: async (attemptId: string) => {
      calls.push(`stop:${attemptId}`)
      playbackState = { status: 'stopped', attemptId, containmentStatus: 'stop-acknowledged' }
      recovery = { status: 'resolved', outcome: 'stopped', attemptId, updatedAt: 'now' }
    },
    retryShutdownContainment: async () => { calls.push('retry-containment') }
  }
  const videoWindow = {
    dispose: async () => { calls.push('video-dispose') },
    allowWindowClose: () => { calls.push('allow-close') }
  }
  let quitAuthorized = false
  let playerQuitAllowed = false
  let shutdownFailed = false
  let terminalFailure = false
  const logger = {
    info: (_origin: string, event: string) => calls.push(`info:${event}`),
    error: (_origin: string, event: string) => calls.push(`error:${event}`)
  }
  const coordinator = new MainStandaloneShutdownCoordinator({
    getBridge: () => bridge as never,
    getSequence: () => sequence as never,
    getRecovery: () => ({ verifyPersistedState: () => recovery }) as never,
    getPlayback: () => playback as never,
    getVideoWindow: () => videoWindow as never,
    logger,
    quit: () => calls.push('quit'),
    setQuitAuthorized: value => { quitAuthorized = value },
    setPlayerQuitAllowed: value => { playerQuitAllowed = value },
    setShutdownFailed: value => { shutdownFailed = value },
    setTerminalFailure: value => { terminalFailure = value },
    showShutdownFailure: async options => { calls.push(`dialog:${options.title}`); return {} }
  })
  return { coordinator, calls, flags: () => ({ quitAuthorized, playerQuitAllowed, shutdownFailed, terminalFailure }) }
}

test('shutdown safety predicate rejects uncertain/active states and requires matching confirmed recovery', () => {
  const none: PlayerRecoverySnapshot = { status: 'none' }
  assert.equal(canFinishStandaloneShutdown(none, undefined), true)
  assert.equal(canFinishStandaloneShutdown({ status: 'unreadable', reason: 'INVALID_RECORD' }, undefined), false)
  assert.equal(canFinishStandaloneShutdown(none, { status: 'playing', attemptId: 'a' }), false)
  assert.equal(canFinishStandaloneShutdown({ status: 'resolved', outcome: 'stopped', attemptId: 'a', updatedAt: 'now' },
    { status: 'stopped', attemptId: 'a', containmentStatus: 'stop-acknowledged' }), true)
  assert.equal(canFinishStandaloneShutdown({ status: 'resolved', outcome: 'completed', attemptId: 'other', updatedAt: 'now' },
    { status: 'completed', attemptId: 'a' }), false)
  assert.equal(canFinishStandaloneShutdown({ status: 'pending', attemptId: 'a', musicCode: '01001',
    playbackStatus: 'uncertain', lastTransition: 'containment-updated', updatedAt: 'now' },
    { status: 'uncertain', attemptId: 'a', containmentStatus: 'host-terminated' }), true)
})

test('shutdown drains IPC and sequence before Stop, disposal, recovery recheck and quit', async () => {
  const context = coordinatorSetup({
    initialPlayback: { status: 'playing', attemptId: 'attempt-1' },
    afterDisposePlayback: { status: 'stopped', attemptId: 'attempt-1', containmentStatus: 'stop-acknowledged' }
  })
  await context.coordinator.begin()
  assert.deepEqual(context.calls, [
    'close-admission', 'sequence-begin', 'stop:attempt-1', 'sequence-dispose', 'video-dispose',
    'allow-close', 'info:STANDALONE_SHUTDOWN_CONFIRMED', 'quit'
  ])
  assert.deepEqual(context.flags(), { quitAuthorized: true, playerQuitAllowed: true, shutdownFailed: false, terminalFailure: false })
})

test('concurrent shutdown requests share one drain and one disposal', async () => {
  let release!: () => void
  const admission = new Promise<void>(resolve => { release = resolve })
  const context = coordinatorSetup({ admission: () => admission })
  const first = context.coordinator.begin()
  const second = context.coordinator.begin()
  assert.equal(first, second)
  release()
  await first
  assert.equal(context.calls.filter(call => call === 'sequence-dispose').length, 1)
})

test('a failure before irreversible disposal restores admission and can be retried', async () => {
  let attempts = 0
  const context = coordinatorSetup({ admission: async () => {
    attempts++
    if (attempts === 1) throw new Error('transient IPC drain failure')
  } })
  await context.coordinator.begin()
  assert.ok(context.calls.includes('resume-admission'))
  assert.ok(context.calls.includes('reset-confirmation'))
  assert.equal(context.flags().shutdownFailed, true)
  await context.coordinator.begin()
  assert.equal(attempts, 2)
  assert.equal(context.flags().quitAuthorized, true)
})

test('a failure after resource disposal starts is terminal and never claims safe quit', async () => {
  const context = coordinatorSetup({ sequenceDispose: async () => { throw new Error('dispose failed') } })
  await context.coordinator.begin()
  assert.equal(context.flags().terminalFailure, true)
  assert.equal(context.flags().quitAuthorized, false)
  assert.equal(context.calls.includes('quit'), false)
  const callCount = context.calls.length
  await context.coordinator.begin()
  assert.equal(context.calls.length, callCount)
})

test('shutdown deadlines reject an already-expired operation without treating it as completed', async () => {
  await assert.rejects(withShutdownDeadline(Promise.resolve(), Date.now() - 1, 'DRAIN_TIMEOUT'), /DRAIN_TIMEOUT/)
})
