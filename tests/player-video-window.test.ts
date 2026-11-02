// @ts-nocheck
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { PlayerVideoWindow } = require('../src/player-video-window')

function deferred() {
  let resolve
  const promise = new Promise(fulfill => { resolve = fulfill })
  return { promise, resolve }
}

test('dispose cancels a pending first view creation before it can attach a host', async () => {
  const release = deferred()
  const manager = Object.create(PlayerVideoWindow.prototype)
  let attachedHosts = 0
  Object.assign(manager, {
    view: undefined,
    host: undefined,
    viewCreation: undefined,
    hostRelease: release.promise,
    hostReleasePromises: new WeakMap(),
    mode: 'hidden',
    ownerWindow: undefined,
    outputWindow: undefined,
    allowClose: false,
    movingView: false,
    ready: false,
    inlineBounds: undefined,
    observedWindows: new WeakSet(),
    disposed: false,
    options: { playback: { attachHost: () => { attachedHosts += 1 } } }
  })

  const pendingCreation = manager.ensureView()
  assert.ok(manager.viewCreation, 'The initial asynchronous view creation must be tracked.')
  manager.dispose()
  release.resolve()

  await assert.rejects(pendingCreation, { message: 'HOST_UNAVAILABLE' })
  assert.equal(attachedHosts, 0, 'Disposal must prevent a late playback host from being attached.')
  assert.equal(manager.view, undefined, 'Disposal must not leave a hidden WebContentsView reference.')
  assert.equal(manager.host, undefined, 'Disposal must not leave a host reference.')
  assert.equal(manager.viewCreation, undefined, 'Disposal must release the pending single-flight reference.')
})
