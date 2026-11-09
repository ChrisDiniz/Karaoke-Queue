import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import type { WindowsFunctionIdentity } from './windows-function-identity'

type BrowserWindowConstructor = new (options: BrowserWindowConstructorOptions) => BrowserWindow

export interface MainWindowFactoryDependencies {
  BrowserWindow: BrowserWindowConstructor
  preloadPath: string
}

export function createWelcomeWindow(
  deps: MainWindowFactoryDependencies & { identity?: WindowsFunctionIdentity; iconPath?: string }
): BrowserWindow {
  return new deps.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: true,
    title: deps.identity?.windowTitle ?? 'Karaoke Queue · Configuração inicial',
    ...(deps.iconPath ? { icon: deps.iconPath } : {}),
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
  deps: MainWindowFactoryDependencies & {
    zoomFactor: number
    identity: WindowsFunctionIdentity
    iconPath: string
  }
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
    title: deps.identity.windowTitle,
    icon: deps.iconPath,
    autoHideMenuBar: true
  })
}

export function createStandaloneWindow(
  deps: MainWindowFactoryDependencies & { identity: WindowsFunctionIdentity; iconPath: string }
): BrowserWindow {
  return new deps.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: true,
    title: deps.identity.windowTitle,
    icon: deps.iconPath,
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
