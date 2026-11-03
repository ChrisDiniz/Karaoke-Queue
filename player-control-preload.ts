import { contextBridge, ipcRenderer } from 'electron'
import type { KaraokePlayerBridge, PlayerUiSnapshot } from './src/player-ui-contracts'

const bridge: KaraokePlayerBridge = {
  getSnapshot: () => ipcRenderer.invoke('player:get-snapshot'),
  onSnapshot(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: PlayerUiSnapshot) => callback(value)
    ipcRenderer.on('player:snapshot', listener)
    return () => ipcRenderer.removeListener('player:snapshot', listener)
  },
  lookupMusicCode: code => ipcRenderer.invoke('player:lookup-code', code),
  playNow: code => ipcRenderer.invoke('player:play-now', code),
  addToSequence: code => ipcRenderer.invoke('player:sequence:add', code),
  addBatchToSequence: (rawText, requestId) => ipcRenderer.invoke('player:sequence:add-batch', rawText, requestId),
  changeOperatingMode: mode => ipcRenderer.invoke('player:mode:change', mode),
  removeFromSequence: itemId => ipcRenderer.invoke('player:sequence:remove', itemId),
  removeCurrent: (itemId, attemptId) => ipcRenderer.invoke('player:sequence:remove-current', itemId, attemptId),
  reorderSequence: itemIds => ipcRenderer.invoke('player:sequence:reorder', itemIds),
  clearSequence: () => ipcRenderer.invoke('player:sequence:clear'),
  pause: () => ipcRenderer.invoke('player:pause'),
  resume: () => ipcRenderer.invoke('player:resume'),
  restart: () => ipcRenderer.invoke('player:restart'),
  stop: () => ipcRenderer.invoke('player:stop'),
  next: () => ipcRenderer.invoke('player:next'),
  previous: () => ipcRenderer.invoke('player:previous'),
  importCatalog: () => ipcRenderer.invoke('player:catalog:import'),
  selectLibraryFolder: () => ipcRenderer.invoke('player:library:select-folder'),
  refreshLibrary: () => ipcRenderer.invoke('player:library:refresh'),
  showVideoWindow: () => ipcRenderer.invoke('player:video:show'),
  setWindowTipVisible: visible => ipcRenderer.invoke('player:video:window-tip', visible),
  onWindowTipDismissed(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (value && typeof value === 'object' && 'permanentlyDismissed' in value &&
          typeof value.permanentlyDismissed === 'boolean') {
        callback(value.permanentlyDismissed)
      }
    }
    ipcRenderer.on('player:window-tip-dismissed', listener)
    return () => ipcRenderer.removeListener('player:window-tip-dismissed', listener)
  },
  showPlayerInline: bounds => ipcRenderer.invoke('player:video:inline', bounds),
  updatePlayerInlineBounds: (bounds, layoutRevision) => ipcRenderer.invoke('player:video:inline-bounds', bounds, layoutRevision),
  setPlayerInlineVisible: visible => ipcRenderer.invoke('player:video:inline-visibility', visible),
  hidePlayerInline: () => ipcRenderer.invoke('player:video:inline-hide'),
  toggleVideoFullScreen: () => ipcRenderer.invoke('player:video:fullscreen-toggle'),
  exitVideoFullScreen: () => ipcRenderer.invoke('player:video:fullscreen-exit'),
  replayPreviousRecovery: attemptId => ipcRenderer.invoke('player:recovery:replay', attemptId),
  chooseAnotherRecovery: (attemptId, code) => ipcRenderer.invoke('player:recovery:choose-another', attemptId, code),
  leaveRecoveryStopped: attemptId => ipcRenderer.invoke('player:recovery:leave-stopped', attemptId),
  resolveInvalidRecovery: () => ipcRenderer.invoke('player:recovery:resolve-invalid'),
  copyRecoveryDiagnostic: () => ipcRenderer.invoke('player:recovery:copy-diagnostic'),
  cancelShutdown: attemptId => ipcRenderer.invoke('player:shutdown:cancel', attemptId),
  confirmShutdown: attemptId => ipcRenderer.invoke('player:shutdown:confirm', attemptId),
  finishShutdown: attemptId => ipcRenderer.invoke('player:shutdown:finish', attemptId),
  onShutdownRequest(callback) {
    const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof callback>[0]) => callback(request)
    ipcRenderer.on('player:shutdown-request', listener)
    return () => ipcRenderer.removeListener('player:shutdown-request', listener)
  },
  onPlaybackEvent(callback) {
    const listener = (_event: Electron.IpcRendererEvent, event: Parameters<typeof callback>[0]) => callback(event)
    ipcRenderer.on('player:playback-event', listener)
    return () => ipcRenderer.removeListener('player:playback-event', listener)
  }
}

contextBridge.exposeInMainWorld('karaokePlayer', Object.freeze(bridge))
