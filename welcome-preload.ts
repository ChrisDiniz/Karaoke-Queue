import { contextBridge, ipcRenderer } from 'electron'
import type { OperatingMode } from './src/operating-mode'

contextBridge.exposeInMainWorld('karaokeWelcome', Object.freeze({
  getState: () => ipcRenderer.invoke('welcome:get-state'),
  chooseMode: (mode: OperatingMode) => ipcRenderer.invoke('welcome:choose-mode', mode),
  chooseLibrary: () => ipcRenderer.invoke('welcome:choose-library'),
  chooseCatalog: () => ipcRenderer.invoke('welcome:choose-catalog'),
  completeSetup: (selection: { libraryRoot?: string; catalogFile?: string }) =>
    ipcRenderer.invoke('welcome:complete-setup', selection)
}))
