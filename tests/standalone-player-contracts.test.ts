import test from 'node:test'
import assert from 'node:assert/strict'
import type { PlayerPlaybackService } from '../src/player-playback-service'
import {
  createInitialStandalonePlayerSnapshot,
  STANDALONE_PLAYER_COMMAND_TYPES,
  type StandalonePlaybackPort,
  type StandaloneReadySnapshot,
  type StandaloneQueueEntry
} from '../src/standalone-player-contracts'

type Assert<T extends true> = T
type SharedPlaybackServiceSatisfiesStandalonePort = Assert<
  PlayerPlaybackService extends StandalonePlaybackPort ? true : false
>
const sharedPlaybackServiceCompatibility: SharedPlaybackServiceSatisfiesStandalonePort = true

const sampleEntry: StandaloneQueueEntry = { entryId: 'entry-1', musicCode: '01001' }

const invalidIdleWithPending: StandaloneReadySnapshot = {
  playbackCondition: 'ready',
  // @ts-expect-error a stable idle snapshot cannot contain pending music
  state: { operationalState: 'idle', current: null, pending: [sampleEntry] }
}

const invalidPlayingWithoutCurrent: StandaloneReadySnapshot = {
  playbackCondition: 'ready',
  // @ts-expect-error a stable playing snapshot must have a current entry
  state: { operationalState: 'playing', current: null, pending: [] }
}

void invalidIdleWithPending
void invalidPlayingWithoutCurrent

test('initial Standalone snapshot is idle with no current or pending music', () => {
  assert.deepEqual(createInitialStandalonePlayerSnapshot(), {
    playbackCondition: 'ready',
    state: {
      operationalState: 'idle',
      current: null,
      pending: []
    }
  })
})

test('initial Standalone snapshots do not share a mutable pending array', () => {
  const first = createInitialStandalonePlayerSnapshot()
  const second = createInitialStandalonePlayerSnapshot()

  assert.notEqual(first.state.pending, second.state.pending)
})

test('Standalone command set contains V1 operations and the approved C5 stop-all command', () => {
  assert.deepEqual(STANDALONE_PLAYER_COMMAND_TYPES, ['submit-code', 'toggle-pause', 'next', 'restart', 'stop-all'])
  assert.equal(sharedPlaybackServiceCompatibility, true)
})
