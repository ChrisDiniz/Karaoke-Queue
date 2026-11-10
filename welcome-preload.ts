import { contextBridge, ipcRenderer } from 'electron'
import type { OperatingMode } from './src/operating-mode'

contextBridge.exposeInMainWorld('karaokeWelcome', Object.freeze({
  getState: () => ipcRenderer.invoke('welcome:get-state'),
  chooseMode: (mode: OperatingMode) => ipcRenderer.invoke('welcome:choose-mode', mode),
  chooseLibrary: () => ipcRenderer.invoke('welcome:choose-library'),
  chooseCatalog: () => ipcRenderer.invoke('welcome:choose-catalog'),
  confirmCatalog: (token: string) => ipcRenderer.invoke('welcome:confirm-catalog', token),
  cancelCatalog: (token: string) => ipcRenderer.invoke('welcome:cancel-catalog', token),
  catalogIssues: (offset: number) => ipcRenderer.invoke('welcome:catalog-issues', offset),
  onMediaChanged: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on('welcome:media-changed', listener)
    return () => ipcRenderer.removeListener('welcome:media-changed', listener)
  },
  completeSetup: (selection: { libraryRoot?: string; catalogFile?: string }) =>
    ipcRenderer.invoke('welcome:complete-setup', selection)
}))
