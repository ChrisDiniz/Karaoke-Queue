import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  applyWindowsFunctionApplicationId,
  applyWindowsFunctionWindowIdentity,
  getWindowsFunctionIdentity,
  getWindowsFunctionIdentityAssetPaths
} from '../src/windows-function-identity'

test('function identity is distinct while retaining the installed application identity', () => {
  const player = getWindowsFunctionIdentity('player')
  const combined = getWindowsFunctionIdentity('combined')
  assert.equal(player.appUserModelId, 'com.karaoke.queue.player')
  assert.equal(combined.appUserModelId, 'com.karaoke.queue.combined')
  assert.notEqual(player.windowTitle, combined.windowTitle)
  assert.notEqual(player.icoIconFile, combined.icoIconFile)
  assert.equal(player.mode, 'player')
  assert.equal(combined.mode, 'combined')
})

test('identity asset paths resolve from protected resources without deriving them from userData', () => {
  assert.deepEqual(getWindowsFunctionIdentityAssetPaths('/program/resources', 'player'), {
    windowIconPath: path.join('/program/resources', 'identity', 'karaoke-player.png'),
    taskbarIconPath: path.join('/program/resources', 'identity', 'karaoke-player.ico')
  })
  assert.deepEqual(getWindowsFunctionIdentityAssetPaths('/program/resources', 'combined'), {
    windowIconPath: path.join('/program/resources', 'identity', 'karaoke-combined.png'),
    taskbarIconPath: path.join('/program/resources', 'identity', 'karaoke-combined.ico')
  })
})

test('application model ID is only changed on Windows and never changes package or userData names', () => {
  const ids: string[] = []
  const target = { setAppUserModelId(id: string) { ids.push(id) } }
  applyWindowsFunctionApplicationId(target, 'linux', 'player')
  assert.deepEqual(ids, [])
  applyWindowsFunctionApplicationId(target, 'win32', 'combined')
  assert.deepEqual(ids, ['com.karaoke.queue.combined'])
})

test('window title, icon, and taskbar identity come from the confirmed function mapping', () => {
  const calls: unknown[] = []
  const target = {
    setTitle(value: string) { calls.push(['title', value]) },
    setIcon(value: string) { calls.push(['icon', value]) },
    setAppDetails(value: { appId: string; appIconPath: string }) { calls.push(['appDetails', value]) }
  }
  const paths = { windowIconPath: '/resources/player.png', taskbarIconPath: '/resources/player.ico' }
  applyWindowsFunctionWindowIdentity(target, 'win32', 'player', paths)
  assert.deepEqual(calls, [
    ['title', 'Karaoke Queue · Reprodutor'],
    ['icon', '/resources/player.png'],
    ['appDetails', { appId: 'com.karaoke.queue.player', appIconPath: '/resources/player.ico' }]
  ])
})

test('a missing Windows taskbar API fails closed instead of reporting role identity applied', () => {
  assert.throws(() => applyWindowsFunctionWindowIdentity({
    setTitle() {}, setIcon() {}
  }, 'win32', 'combined', {
    windowIconPath: '/resources/combined.png', taskbarIconPath: '/resources/combined.ico'
  }), /WINDOW_TASKBAR_IDENTITY_UNAVAILABLE/)
})
