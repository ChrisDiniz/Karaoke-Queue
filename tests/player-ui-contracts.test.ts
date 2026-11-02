import test from 'node:test'
import assert from 'node:assert/strict'
import { isNewPlayerOutputReturn, isStalePlayerUiRevision } from '../src/player-ui-contracts'

test('Player Renderer ignores snapshots older than its latest Main revision', () => {
  assert.equal(isStalePlayerUiRevision(undefined, 1), false, 'the initial snapshot is accepted')
  assert.equal(isStalePlayerUiRevision(4, 5), false, 'a newer snapshot is accepted')
  assert.equal(isStalePlayerUiRevision(5, 5), false, 'a duplicate revision remains idempotent')
  assert.equal(isStalePlayerUiRevision(5, 4), true, 'a delayed IPC reply cannot regress the visible state')
})

test('Player Renderer treats the first output-return revision as a baseline', () => {
  assert.equal(isNewPlayerOutputReturn(undefined, 3), false, 'the initial snapshot does not trigger navigation')
  assert.equal(isNewPlayerOutputReturn(3, 3), false, 'a repeated output-return revision is idempotent')
  assert.equal(isNewPlayerOutputReturn(3, 4), true, 'a later output-window close triggers navigation to Reprodutor')
})
