// @ts-nocheck
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
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

test('inline fullscreen transitions reject stale bounds and restore the surface only after fresh layout', async () => {
  const window = new EventEmitter()
  let fullScreen = false
  let boundsApplications = 0
  let visibilityChanges = []
  const publishedEvents = []
  let ownerFocusCount = 0
  let surfaceFocusCount = 0
  const owner = Object.assign(window, {
    isDestroyed: () => false,
    isFullScreen: () => fullScreen,
    isMinimized: () => false,
    restore: () => undefined,
    focus: () => { ownerFocusCount++ },
    webContents: { getZoomFactor: () => 1 }
  })
  const view = {
    setBounds: () => { boundsApplications++ },
    setVisible: visible => visibilityChanges.push(visible),
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel, value) => publishedEvents.push([channel, value]),
      focus: () => { surfaceFocusCount++ }
    }
  }
  let changeCount = 0
  const manager = Object.create(PlayerVideoWindow.prototype)
  Object.assign(manager, {
    view,
    mode: 'inline',
    ownerWindow: owner,
    inlineBounds: { x: 20, y: 30, width: 600, height: 340 },
    inlineBoundsRevision: 0,
    inlineLayoutRevision: 0,
    focusAfterInlineLayoutRevision: undefined,
    inlineVisible: true,
    windowTipRequested: true,
    windowTipDismissedForRun: false,
    observedWindows: new WeakSet(),
    options: { onChange: () => { changeCount++ } }
  })
  manager.observeWindow(owner)

  fullScreen = true
  owner.emit('enter-full-screen')
  assert.deepEqual(publishedEvents.filter(([channel]) => channel === 'player-playback:fullscreen').at(-1), ['player-playback:fullscreen', true],
    'Entering fullscreen must publish the state used to show the temporary exit hint.')
  assert.deepEqual(publishedEvents.filter(([channel]) => channel === 'player-playback:window-tip').at(-1),
    ['player-playback:window-tip', false], 'The embedded tip must hide while fullscreen is active.')
  assert.equal(manager.inlineLayoutRevision, 1, 'Entering fullscreen must invalidate the previous inline geometry.')
  assert.equal(visibilityChanges.at(-1), false, 'The native surface must remain hidden until fresh fullscreen bounds arrive.')
  const boundsAfterEnter = boundsApplications
  assert.equal(await manager.setInlineBounds({ x: 0, y: 0, width: 1200, height: 800 }, 0), false,
    'A bounds update from the preceding layout revision must be rejected.')
  assert.equal(boundsApplications, boundsAfterEnter, 'Rejecting stale bounds must not resize the native surface.')
  assert.equal(await manager.setInlineBounds({ x: 0, y: 0, width: 1200, height: 800 }, 1), true,
    'The current fullscreen layout revision must be accepted.')
  assert.equal(visibilityChanges.at(-1), true, 'Fresh fullscreen bounds must make the inline surface visible.')
  assert.equal(ownerFocusCount, 1, 'The owning window must regain focus after fullscreen layout is applied.')
  assert.equal(surfaceFocusCount, 1, 'The playback surface must regain focus after fullscreen layout is applied.')

  fullScreen = false
  owner.emit('leave-full-screen')
  assert.deepEqual(publishedEvents.filter(([channel]) => channel === 'player-playback:fullscreen').at(-1), ['player-playback:fullscreen', false],
    'Leaving fullscreen must hide the temporary exit hint.')
  assert.deepEqual(publishedEvents.filter(([channel]) => channel === 'player-playback:window-tip').at(-1),
    ['player-playback:window-tip', true], 'The embedded tip must return after leaving fullscreen.')
  assert.equal(manager.inlineLayoutRevision, 2, 'Leaving fullscreen must create a new inline layout revision.')
  assert.equal(visibilityChanges.at(-1), false, 'Fullscreen bounds must not cover the restored application shell.')
  const boundsBeforeResize = boundsApplications
  owner.emit('resize')
  assert.equal(boundsApplications, boundsBeforeResize,
    'Native resize events must not reapply fullscreen bounds while the restored layout is pending.')
  assert.equal(await manager.setInlineBounds({ x: 80, y: 100, width: 900, height: 506 }, 1), false,
    'A late fullscreen report must not override the restored window layout.')
  assert.equal(await manager.setInlineBounds({ x: 80, y: 100, width: 900, height: 506 }, 2), true,
    'The fresh restored-window geometry must be accepted.')
  assert.equal(visibilityChanges.at(-1), true, 'The native surface must return after restored bounds are applied.')
  assert.equal(ownerFocusCount, 2, 'The owner must remain focused after returning from fullscreen.')
  assert.equal(surfaceFocusCount, 2, 'The playback surface must remain shortcut-ready after returning from fullscreen.')
  assert.equal(changeCount, 3, 'Fullscreen entry, exit, and the resize event must publish current window state.')
})

test('window tip state is scoped to the inline host and dismissal lasts for the run', () => {
  const publishedEvents = []
  let fullScreen = false
  const owner = { isDestroyed: () => false, isFullScreen: () => fullScreen }
  const hostSender = {}
  const view = {
    webContents: { isDestroyed: () => false, isCrashed: () => false,
      send: (channel, value) => publishedEvents.push([channel, value]) }
  }
  const manager = Object.create(PlayerVideoWindow.prototype)
  Object.assign(manager, {
    view,
    ownerWindow: owner,
    mode: 'inline',
    windowTipRequested: false,
    windowTipDismissedForRun: false
  })

  assert.equal(manager.setWindowTipVisible(true), true)
  assert.deepEqual(publishedEvents.at(-1), ['player-playback:window-tip', true])
  assert.equal(manager.dismissWindowTip(hostSender), false, 'Only the owned playback WebContents may dismiss the tip.')
  assert.equal(manager.windowTipRequested, true, 'A rejected sender must not change tip visibility.')

  fullScreen = true
  manager.publishWindowTipState()
  assert.deepEqual(publishedEvents.at(-1), ['player-playback:window-tip', false])
  fullScreen = false
  assert.equal(manager.dismissWindowTip(view.webContents), true)
  assert.deepEqual(publishedEvents.at(-1), ['player-playback:window-tip', false])
  assert.equal(manager.setWindowTipVisible(true), true)
  assert.deepEqual(publishedEvents.at(-1), ['player-playback:window-tip', false],
    'A renderer reload must not undo a dismissal before application restart.')
})
