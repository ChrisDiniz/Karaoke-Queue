import type { OperatingMode } from './operating-mode'
import path from 'node:path'

export interface WindowsFunctionIdentity {
  readonly mode: OperatingMode
  readonly displayName: string
  readonly windowTitle: string
  readonly appUserModelId: string
  readonly pngIconFile: string
  readonly icoIconFile: string
}

const IDENTITIES: Record<OperatingMode, WindowsFunctionIdentity> = {
  player: {
    mode: 'player',
    displayName: 'Karaoke Queue — Reprodutor',
    windowTitle: 'Karaoke Queue · Reprodutor',
    appUserModelId: 'com.karaoke.queue.player',
    pngIconFile: 'karaoke-player.png',
    icoIconFile: 'karaoke-player.ico'
  },
  combined: {
    mode: 'combined',
    displayName: 'Karaoke Queue — Tudo em um',
    windowTitle: 'Karaoke Queue · Tudo em um',
    appUserModelId: 'com.karaoke.queue.combined',
    pngIconFile: 'karaoke-combined.png',
    icoIconFile: 'karaoke-combined.ico'
  }
}

export function getWindowsFunctionIdentity(mode: OperatingMode): WindowsFunctionIdentity {
  return IDENTITIES[mode]
}

export function getWindowsFunctionIdentityAssetPaths(
  resourcesDirectory: string,
  mode: OperatingMode
): { readonly windowIconPath: string; readonly taskbarIconPath: string } {
  const identity = getWindowsFunctionIdentity(mode)
  return {
    windowIconPath: path.join(resourcesDirectory, 'identity', identity.pngIconFile),
    taskbarIconPath: path.join(resourcesDirectory, 'identity', identity.icoIconFile)
  }
}

export interface AppUserModelIdTarget {
  setAppUserModelId(id: string): void
}

/** Apply the role-specific taskbar grouping without changing Electron's app name or userData path. */
export function applyWindowsFunctionApplicationId(
  target: AppUserModelIdTarget,
  platform: string,
  mode: OperatingMode
): void {
  if (platform !== 'win32') return
  target.setAppUserModelId(getWindowsFunctionIdentity(mode).appUserModelId)
}

export interface FunctionIdentityWindowTarget {
  setTitle(title: string): void
  setIcon(iconPath: string): void
  setAppDetails?(details: { appId: string; appIconPath: string }): void
}

/** Apply window and taskbar identity from the confirmed function, never from Renderer input. */
export function applyWindowsFunctionWindowIdentity(
  target: FunctionIdentityWindowTarget,
  platform: string,
  mode: OperatingMode,
  paths: { readonly windowIconPath: string; readonly taskbarIconPath: string }
): void {
  const identity = getWindowsFunctionIdentity(mode)
  target.setTitle(identity.windowTitle)
  target.setIcon(paths.windowIconPath)
  if (platform === 'win32') {
    if (!target.setAppDetails) throw new Error('WINDOW_TASKBAR_IDENTITY_UNAVAILABLE')
    target.setAppDetails({ appId: identity.appUserModelId, appIconPath: paths.taskbarIconPath })
  }
}
