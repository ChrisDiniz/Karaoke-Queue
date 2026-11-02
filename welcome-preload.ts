import { contextBridge, ipcRenderer } from 'electron'
import type { OperatingMode } from './src/operating-mode'

contextBridge.exposeInMainWorld('karaokeWelcome', Object.freeze({
  chooseMode: (mode: OperatingMode) => ipcRenderer.invoke('welcome:choose-mode', mode)
}))
