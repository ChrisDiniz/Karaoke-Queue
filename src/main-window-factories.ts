import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

type BrowserWindowConstructor = new (options: BrowserWindowConstructorOptions) => BrowserWindow

export interface MainWindowFactoryDependencies {
  BrowserWindow: BrowserWindowConstructor
  preloadPath: string
}

export function createWelcomeWindow(deps: MainWindowFactoryDependencies): BrowserWindow {
  return new deps.BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 620,
    show: true,
    title: 'Karaoke Queue · Configuração inicial',
    autoHideMenuBar: true,
    webPreferences: {
      preload: deps.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })
}

export function createManagementWindow(
  deps: MainWindowFactoryDependencies & { zoomFactor: number }
): BrowserWindow {
  return new deps.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: deps.preloadPath,
      zoomFactor: deps.zoomFactor
    },
    title: 'Karaoke Queue',
    autoHideMenuBar: true
  })
}

export function createStandaloneWindow(deps: MainWindowFactoryDependencies): BrowserWindow {
  return new deps.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: true,
    title: 'Karaoke Queue · Reprodutor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: deps.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })
}
