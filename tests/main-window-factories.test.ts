import test from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import {
  createManagementWindow,
  createStandaloneWindow,
  createWelcomeWindow
} from '../src/main-window-factories'

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
    width: 1100, height: 720, minWidth: 820, minHeight: 620, show: true,
    title: 'Karaoke Queue · Configuração inicial', autoHideMenuBar: true,
    webPreferences: {
      preload: '/build/welcome-preload.js', nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true
    }
  }])
})

test('Management factory preserves the Controller surface preferences and injected startup zoom', () => {
  const capture = constructorCapture()
  createManagementWindow({ ...capture, preloadPath: '/build/preload.js', zoomFactor: 1.15 })
  assert.deepEqual(capture.options, [{
    width: 1280, height: 800, minWidth: 960, minHeight: 600,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: '/build/preload.js', zoomFactor: 1.15
    },
    title: 'Karaoke Queue', autoHideMenuBar: true
  }])
})

test('Standalone factory preserves the one-screen Player dimensions and sandboxed preload', () => {
  const capture = constructorCapture()
  createStandaloneWindow({ ...capture, preloadPath: '/build/standalone-player-preload.bundle.js' })
  assert.deepEqual(capture.options, [{
    width: 1280, height: 800, minWidth: 800, minHeight: 600, show: true,
    title: 'Karaoke Queue · Reprodutor', autoHideMenuBar: true,
    webPreferences: {
      preload: '/build/standalone-player-preload.bundle.js', nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true
    }
  }])
})
