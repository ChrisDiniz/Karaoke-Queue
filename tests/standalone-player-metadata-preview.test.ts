import test from 'node:test'
import assert from 'node:assert/strict'
import type { StandalonePlayerMetadataPreview } from '../src/standalone-player-ipc-contracts'
import type { StandaloneCurrentTrackMetadata } from '../src/standalone-player-ipc-contracts'
import {
  StandaloneCurrentTrackInfoController,
  STANDALONE_CURRENT_TRACK_INFO_MS,
  type StandaloneCurrentTrackInfoScheduler
} from '../src/standalone-player-current-track-info'
import {
  StandalonePlayerMetadataPreviewController,
  StandaloneTransitionMetadataPreviewController
} from '../src/standalone-player-metadata-preview'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function preview(catalogRevision: string | null, title: string | null, artist: string | null): StandalonePlayerMetadataPreview {
  return { catalogRevision, title, artist }
}

interface InfoTimer { callback: () => void; delayMs: number; cancelled: boolean }

class InfoScheduler implements StandaloneCurrentTrackInfoScheduler {
  readonly timers: InfoTimer[] = []
  schedule(callback: () => void, delayMs: number): InfoTimer {
    const timer = { callback, delayMs, cancelled: false }
    this.timers.push(timer)
    return timer
  }
  cancel(handle: unknown): void { (handle as InfoTimer).cancelled = true }
}

const activeIdentity = { entryId: 'entry-1', attemptId: 'attempt-1', musicCode: '01001' }

function currentMetadata(identity = activeIdentity,
  metadata = preview('catalog-a', 'Always', 'Bon Jovi')): StandaloneCurrentTrackMetadata {
  return { ...metadata, ...identity }
}

async function flushInfoLookup(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('preview follows the latest exact buffer and ignores an older lookup that resolves later', async () => {
  const requests: Array<{ code: string; result: ReturnType<typeof deferred<StandalonePlayerMetadataPreview>> }> = []
  const controller = new StandalonePlayerMetadataPreviewController({
    lookupMetadata: code => {
      const result = deferred<StandalonePlayerMetadataPreview>()
      requests.push({ code, result })
      return result.promise
    }
  })
  controller.updateEntry(true, '1001')
  controller.updateEntry(true, '100')
  assert.deepEqual(requests.map(request => request.code), ['1001', '100'])
  requests[0].result.resolve(preview('catalog-a', 'Always', 'Bon Jovi'))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), { code: '100', catalogRevision: null, title: null, artist: null })
  requests[1].result.resolve(preview('catalog-a', null, null))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), { code: '100', catalogRevision: 'catalog-a', title: null, artist: null })
  controller.dispose()
})

test('closing or clearing the panel invalidates every outstanding metadata response', async () => {
  const request = deferred<StandalonePlayerMetadataPreview>()
  const controller = new StandalonePlayerMetadataPreviewController({ lookupMetadata: () => request.promise })
  controller.updateEntry(true, '1001')
  controller.updateEntry(false, '')
  request.resolve(preview('catalog-a', 'Always', 'Bon Jovi'))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), { code: '', catalogRevision: null, title: null, artist: null })
  controller.dispose()
})

test('a catalog revision change clears and replaces an in-flight preview', async () => {
  const requests: Array<ReturnType<typeof deferred<StandalonePlayerMetadataPreview>>> = []
  const controller = new StandalonePlayerMetadataPreviewController({
    lookupMetadata: () => {
      const request = deferred<StandalonePlayerMetadataPreview>()
      requests.push(request)
      return request.promise
    }
  })
  controller.updateEntry(true, '1001')
  controller.catalogChanged('catalog-b')
  assert.equal(requests.length, 2)
  requests[0].resolve(preview('catalog-a', 'Old Title', 'Old Artist'))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), { code: '1001', catalogRevision: 'catalog-b', title: null, artist: null })
  requests[1].resolve(preview('catalog-b', 'New Title', 'New Artist'))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), { code: '1001', catalogRevision: 'catalog-b', title: 'New Title', artist: 'New Artist' })
  controller.dispose()
})

test('missing catalog data and failed optional lookups leave the preview empty', async () => {
  const noMatch = deferred<StandalonePlayerMetadataPreview>()
  const first = new StandalonePlayerMetadataPreviewController({ lookupMetadata: () => noMatch.promise })
  first.updateEntry(true, '99999')
  noMatch.resolve(preview(null, null, null))
  await Promise.resolve()
  assert.deepEqual(first.getSnapshot(), { code: '99999', catalogRevision: null, title: null, artist: null })
  first.dispose()

  const failed = new StandalonePlayerMetadataPreviewController({ lookupMetadata: async () => { throw new Error('optional catalog unavailable') } })
  failed.updateEntry(true, '1001')
  await Promise.resolve()
  assert.deepEqual(failed.getSnapshot(), { code: '1001', catalogRevision: null, title: null, artist: null })
  failed.dispose()
})

test('transition target metadata ignores a result for an older reserved entry', async () => {
  const requests: Array<{ code: string; result: ReturnType<typeof deferred<StandalonePlayerMetadataPreview>> }> = []
  const controller = new StandaloneTransitionMetadataPreviewController({
    lookupMetadata: code => {
      const result = deferred<StandalonePlayerMetadataPreview>()
      requests.push({ code, result })
      return result.promise
    }
  })
  controller.updateTarget({ entryId: 'entry-1', musicCode: '01001' })
  controller.updateTarget({ entryId: 'entry-2', musicCode: '02002' })
  assert.deepEqual(requests.map(request => request.code), ['01001', '02002'])
  requests[0].result.resolve(preview('catalog-a', 'Old Track', 'Old Artist'))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), {
    entryId: 'entry-2', code: '02002', catalogRevision: null, title: null, artist: null
  })
  requests[1].result.resolve(preview('catalog-a', 'New Track', 'New Artist'))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), {
    entryId: 'entry-2', code: '02002', catalogRevision: 'catalog-a', title: 'New Track', artist: 'New Artist'
  })
  controller.dispose()
})

test('a catalog change invalidates an in-flight transition preview and uses only the new revision result', async () => {
  const requests: Array<ReturnType<typeof deferred<StandalonePlayerMetadataPreview>>> = []
  const controller = new StandaloneTransitionMetadataPreviewController({
    lookupMetadata: () => {
      const request = deferred<StandalonePlayerMetadataPreview>()
      requests.push(request)
      return request.promise
    }
  })
  controller.updateTarget({ entryId: 'entry-1', musicCode: '01001' })
  controller.catalogChanged('catalog-b')
  requests[0].resolve(preview('catalog-a', 'Stale Track', 'Stale Artist'))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), {
    entryId: 'entry-1', code: '01001', catalogRevision: 'catalog-b', title: null, artist: null
  })
  requests[1].resolve(preview('catalog-b', 'Always', 'Bon Jovi'))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), {
    entryId: 'entry-1', code: '01001', catalogRevision: 'catalog-b', title: 'Always', artist: 'Bon Jovi'
  })
  controller.dispose()
})

test('closing the Renderer transition target ignores pending metadata without requiring a catalog', async () => {
  const request = deferred<StandalonePlayerMetadataPreview>()
  const controller = new StandaloneTransitionMetadataPreviewController({ lookupMetadata: () => request.promise })
  controller.updateTarget({ entryId: 'entry-1', musicCode: '09999' })
  controller.updateTarget(undefined)
  request.resolve(preview(null, null, null))
  await Promise.resolve()
  assert.deepEqual(controller.getSnapshot(), {
    entryId: null, code: '', catalogRevision: null, title: null, artist: null
  })
  controller.dispose()
})

test('current-track info shows exact Main metadata and renews its 3.5-second timer on repeated I', async () => {
  const scheduler = new InfoScheduler()
  const controller = new StandaloneCurrentTrackInfoController({
    scheduler,
    lookupCurrentTrack: async () => currentMetadata(),
    getCurrentTrack: async () => activeIdentity
  })
  controller.setCurrentTrack(activeIdentity)
  controller.show()
  await flushInfoLookup()
  assert.equal(controller.getSnapshot().open, true)
  assert.equal(controller.getSnapshot().title, 'Always')
  assert.equal(controller.getSnapshot().artist, 'Bon Jovi')
  assert.equal(scheduler.timers[0].delayMs, STANDALONE_CURRENT_TRACK_INFO_MS)

  controller.show()
  assert.equal(scheduler.timers[0].cancelled, true)
  assert.equal(scheduler.timers[1].delayMs, 3_500)
  scheduler.timers[0].callback()
  assert.equal(controller.getSnapshot().open, true, 'a canceled but already queued callback cannot close a renewed panel.')
  scheduler.timers[1].callback()
  assert.equal(controller.getSnapshot().open, false, 'the latest timer closes the panel at 3.5 seconds.')
  controller.dispose()
})

test('current-track info consumes I without a confirmed current track and shows Doop missing-data copy', async () => {
  const scheduler = new InfoScheduler()
  const controller = new StandaloneCurrentTrackInfoController({
    scheduler,
    lookupCurrentTrack: async () => currentMetadata(activeIdentity, preview('catalog-a', null, null)),
    getCurrentTrack: async () => activeIdentity
  })
  controller.show()
  assert.equal(controller.getSnapshot().open, false, 'no confirmed current identity means there is no panel to show.')
  controller.setCurrentTrack(activeIdentity)
  controller.show()
  await flushInfoLookup()
  assert.equal(controller.getSnapshot().open, true)
  assert.equal(controller.getSnapshot().musicCode, '01001')
  assert.equal(controller.getSnapshot().title, null)
  assert.equal(controller.getSnapshot().artist, null)
  controller.dispose()
})

test('current-track info invalidates a delayed same-code response after the playback attempt changes', async () => {
  const requests: Array<ReturnType<typeof deferred<StandaloneCurrentTrackMetadata | null>>> = []
  let current = { ...activeIdentity }
  const controller = new StandaloneCurrentTrackInfoController({
    scheduler: new InfoScheduler(),
    lookupCurrentTrack: () => {
      const request = deferred<StandaloneCurrentTrackMetadata | null>()
      requests.push(request)
      return request.promise
    },
    getCurrentTrack: async () => current
  })
  controller.setCurrentTrack(current)
  controller.show()
  const nextAttempt = { ...current, attemptId: 'attempt-2' }
  current = nextAttempt
  controller.setCurrentTrack(nextAttempt)
  assert.equal(requests.length, 2)
  requests[0].resolve(currentMetadata())
  await flushInfoLookup()
  assert.equal(controller.getSnapshot().open, true)
  assert.equal(controller.getSnapshot().attemptId, 'attempt-2')
  assert.equal(controller.getSnapshot().title, null, 'metadata tied to attempt-1 is never published for attempt-2.')
  requests[1].resolve(currentMetadata(nextAttempt))
  await flushInfoLookup()
  assert.equal(controller.getSnapshot().title, 'Always')
  controller.dispose()
})

test('current-track info closes on track change and ignores a delayed response after EOF or idle', async () => {
  const request = deferred<StandaloneCurrentTrackMetadata | null>()
  const controller = new StandaloneCurrentTrackInfoController({
    scheduler: new InfoScheduler(),
    lookupCurrentTrack: () => request.promise,
    getCurrentTrack: async () => null
  })
  controller.setCurrentTrack(activeIdentity)
  controller.show()
  controller.setCurrentTrack({ entryId: 'entry-2', attemptId: 'attempt-2', musicCode: '02002' })
  assert.equal(controller.getSnapshot().open, false, 'a new track occurrence closes the panel immediately.')
  request.resolve(currentMetadata())
  await flushInfoLookup()
  assert.equal(controller.getSnapshot().open, false)
  assert.equal(controller.getSnapshot().title, null, 'the old response cannot repopulate the closed panel.')
  controller.setCurrentTrack(null)
  assert.equal(controller.getSnapshot().open, false)
  controller.dispose()
})

test('a catalog revision invalidates and replaces an open current-track lookup', async () => {
  const requests: Array<ReturnType<typeof deferred<StandaloneCurrentTrackMetadata | null>>> = []
  const controller = new StandaloneCurrentTrackInfoController({
    scheduler: new InfoScheduler(),
    lookupCurrentTrack: () => {
      const request = deferred<StandaloneCurrentTrackMetadata | null>()
      requests.push(request)
      return request.promise
    },
    getCurrentTrack: async () => activeIdentity
  })
  controller.setCurrentTrack(activeIdentity)
  controller.show()
  controller.catalogChanged('catalog-b')
  assert.equal(requests.length, 2)
  requests[0].resolve(currentMetadata(activeIdentity, preview('catalog-a', 'Old', 'Old Artist')))
  await flushInfoLookup()
  assert.equal(controller.getSnapshot().title, null)
  requests[1].resolve(currentMetadata(activeIdentity, preview('catalog-b', 'Always (atualizada)', 'Bon Jovi')))
  await flushInfoLookup()
  assert.equal(controller.getSnapshot().title, 'Always (atualizada)')
  controller.dispose()
})
