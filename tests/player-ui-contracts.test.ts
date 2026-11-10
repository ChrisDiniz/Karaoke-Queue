import test from 'node:test'
import assert from 'node:assert/strict'
import { isCurrentPlayerShutdownDialogRequest, isCurrentRemovalOperationPending, isNewPlayerOutputReturn, isStalePlayerUiRevision, playerCurrentTrackCode, playerPlaybackEventNotice } from '../src/player-ui-contracts'

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

test('Player shutdown dialog ignores a delayed request after cancellation or attempt replacement', () => {
  assert.equal(isCurrentPlayerShutdownDialogRequest(4, 4, 'attempt-a', 'attempt-a'), true,
    'the latest active request may show its confirmation dialog')
  assert.equal(isCurrentPlayerShutdownDialogRequest(4, 5, 'attempt-a', undefined), false,
    'cancellation invalidates an awaited dialog setup')
  assert.equal(isCurrentPlayerShutdownDialogRequest(4, 5, 'attempt-a', 'attempt-a'), false,
    'a late cancel acknowledgement cannot close a newer request for the same playback attempt')
  assert.equal(isCurrentPlayerShutdownDialogRequest(4, 5, 'attempt-a', 'attempt-b'), false,
    'a delayed request cannot replace a newer shutdown attempt')
})

test('current-song removal dialog remains open until the correlated Main Stop and media clear finish', () => {
  assert.equal(isCurrentRemovalOperationPending(true, 'attempt-a', 'attempt-a'), true,
    'a stopping snapshot for the target attempt must not close the dialog before the Stop acknowledgement')
  assert.equal(isCurrentRemovalOperationPending(true, 'attempt-a', undefined), true,
    'the dialog must remain open while the confirmed stop has cleared the attempt but Main has not returned')
  assert.equal(isCurrentRemovalOperationPending(true, 'attempt-a', 'attempt-b'), false,
    'a newer attempt must invalidate a stale removal decision')
  assert.equal(isCurrentRemovalOperationPending(false, 'attempt-a', 'attempt-a'), false,
    'the dialog may close after the correlated operation resolves')
})

test('Player UI identifies the actual failed Next attempt rather than the previous sequence selection', () => {
  assert.equal(playerCurrentTrackCode('01001', { status: 'failed', musicCode: '01002' }), '01002',
    'a failure from a newly attempted Next item must not be displayed against the previous sequence song')
  assert.equal(playerCurrentTrackCode('01001', { status: 'playing', musicCode: '01002' }), '01002',
    'the active playback attempt remains the visible track while sequence snapshots reconcile')
  assert.equal(playerCurrentTrackCode('01001', { status: 'stopped', musicCode: '01002' }), '01001',
    'a stopped sequence retains its authoritative current selection')
  assert.equal(playerCurrentTrackCode(null, { status: 'completed', musicCode: '01002' }), undefined,
    'a completed final EOF clears the visible selection')
})

test('Player UI reports when a confirmed EOF cannot clear or contain its final video surface', () => {
  assert.equal(playerPlaybackEventNotice({ type: 'surface-cleanup-failed', attemptId: 'attempt-1',
    musicCode: '01001', errorCode: 'HOST_CONTAINMENT_FAILED' }),
  'A música terminou, mas o Player não confirmou a limpeza da imagem final.',
  'the UI must surface a display cleanup failure without relabeling the confirmed EOF')
  assert.equal(playerPlaybackEventNotice({ type: 'natural-end-candidate', attemptId: 'attempt-1',
    musicCode: '01001', duration: 10, endedAt: '2026-11-02T00:00:00.000Z' }), undefined,
  'a normal natural-end event does not produce a failure notice')
})
