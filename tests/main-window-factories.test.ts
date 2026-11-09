import test from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import {
  createManagementWindow,
  createStandaloneWindow,
  createWelcomeWindow
} from '../src/main-window-factories'
import { getWindowsFunctionIdentity } from '../src/windows-function-identity'

function constructorCapture() {
  const options: BrowserWindowConstructorOptions[] = []
  class FakeBrowserWindow {
    constructor(value: BrowserWindowConstructorOptions) { options.push(value) }
  }
  return { BrowserWindow: FakeBrowserWindow as unknown as new (options: BrowserWindowConstructorOptions) => BrowserWindow, options }
}

test('Welcome factory preserves its dimensions, preload, and restricted security preferences', () => {
  const capture = constructorCapture()
  createWelcomeWindow({ ...capture, preloadPath: '/build/welcome-preload.js' })
  assert.deepEqual(capture.options, [{
    width: 1280, height: 800, minWidth: 960, minHeight: 600, show: true,
    title: 'Karaoke Queue · Configuração inicial', autoHideMenuBar: true,
    webPreferences: {
      preload: '/build/welcome-preload.js', nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true
    }
  }])
})

test('confirmed-role welcome setup uses the persisted function title and icon', () => {
  const capture = constructorCapture()
  createWelcomeWindow({ ...capture, preloadPath: '/build/welcome-preload.js',
    identity: getWindowsFunctionIdentity('player'), iconPath: '/resources/player.png' })
  assert.equal(capture.options[0]?.title, 'Karaoke Queue · Reprodutor')
  assert.equal(capture.options[0]?.icon, '/resources/player.png')
})

test('Management factory preserves the Controller surface preferences and injected startup zoom', () => {
  const capture = constructorCapture()
  createManagementWindow({ ...capture, preloadPath: '/build/preload.js', zoomFactor: 1.15,
    identity: getWindowsFunctionIdentity('combined'), iconPath: '/resources/combined.png' })
  assert.deepEqual(capture.options, [{
    width: 1280, height: 800, minWidth: 960, minHeight: 600,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: '/build/preload.js', zoomFactor: 1.15
    },
    title: 'Karaoke Queue · Tudo em um', icon: '/resources/combined.png', autoHideMenuBar: true
  }])
})

test('Standalone factory preserves the one-screen Player dimensions and sandboxed preload', () => {
  const capture = constructorCapture()
  createStandaloneWindow({ ...capture, preloadPath: '/build/standalone-player-preload.bundle.js',
    identity: getWindowsFunctionIdentity('player'), iconPath: '/resources/player.png' })
  assert.deepEqual(capture.options, [{
    width: 1280, height: 800, minWidth: 800, minHeight: 600, show: true,
    title: 'Karaoke Queue · Reprodutor', icon: '/resources/player.png', autoHideMenuBar: true,
    webPreferences: {
      preload: '/build/standalone-player-preload.bundle.js', nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true
    }
  }])
})
