import { contextBridge, ipcRenderer } from 'electron'

function safeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

async function invokeLogged<T>(channel: string, ...args: unknown[]): Promise<T> {
  try { return await ipcRenderer.invoke(channel, ...args) as T } catch (error) {
    const detail = safeError(error)
    ipcRenderer.send('diagnostics:renderer-log', {
      event: 'RENDERER_IPC_FAILED', message: `IPC ${channel} falhou: ${detail.message}`, stack: detail.stack
    })
    throw error
  }
}

process.on('uncaughtExceptionMonitor', error => {
  const detail = safeError(error)
  ipcRenderer.send('diagnostics:renderer-log', {
    event: 'RENDERER_UNCAUGHT_EXCEPTION', message: detail.message, stack: detail.stack
  })
})

process.on('unhandledRejection', reason => {
  const detail = safeError(reason)
  ipcRenderer.send('diagnostics:renderer-log', {
    event: 'RENDERER_UNHANDLED_REJECTION', message: detail.message, stack: detail.stack
  })
})

// Keep SQLite in the main process. The isolated renderer receives only the
// state load/save operations it needs, never a database connection or SQL API.
contextBridge.exposeInMainWorld('karaokeDatabase', {
  load: ()     => invokeLogged<StoredAppState>('app-data:load'),
  save: (data: AppState) => invokeLogged<boolean>('app-data:save', data)
})

contextBridge.exposeInMainWorld('karaokeLicense', {
  getStatus: () => invokeLogged<LicenseStatus>('license:get-status'),
  activate: (token: string) => invokeLogged<LicenseStatus>('license:activate', token)
})

contextBridge.exposeInMainWorld('karaokeUiScale', {
  getState: () => invokeLogged<UiScaleState>('ui-scale:get'),
  setPreference: (preference: UiScalePreference) =>
    invokeLogged<UiScaleState>('ui-scale:set-preference', preference),
  onChanged: (callback: (state: UiScaleState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UiScaleState) => callback(state)
    ipcRenderer.on('ui-scale:changed', listener)
    return () => ipcRenderer.removeListener('ui-scale:changed', listener)
  }
})

contextBridge.exposeInMainWorld('karaokePreferences', {
  getSidebarDisplayName: () => invokeLogged<string>('ui-preferences:sidebar-name:get'),
  setSidebarDisplayName: (name: string) =>
    invokeLogged<string>('ui-preferences:sidebar-name:set', name),
  changeOperatingMode: (mode: 'player') =>
    invokeLogged<{ outcome: 'restarting'; mode: 'player' }>('settings:operating-mode:change', mode)
})

contextBridge.exposeInMainWorld('karaokeDiagnostics', {
  openLogsFolder: () => invokeLogged<{ ok: boolean; error?: string }>('diagnostics:open-logs'),
  logSessionEvent: (event: string, sessionId: string | null, result?: string) =>
    ipcRenderer.send('diagnostics:session-event', { event, sessionId, result }),
  reportRendererError: (event: string, message: string, stack?: string) =>
    ipcRenderer.send('diagnostics:renderer-log', { event, message, stack })
})

contextBridge.exposeInMainWorld('karaokePlayer', {
  getSnapshot: () => invokeLogged<import('./src/player-ui-contracts').PlayerUiSnapshot>('player:get-snapshot'),
  lookupMusicCode: (code: string) => invokeLogged<import('./src/player-ui-contracts').PlayerMusicMetadata>('player:lookup-code', code),
  playNow: (code: string) => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:play-now', code),
  addToSequence: (code: string) => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:sequence:add', code),
  removeFromSequence: (itemId: string) => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:sequence:remove', itemId),
  removeCurrent: (itemId: string, attemptId: string) => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:sequence:remove-current', itemId, attemptId),
  reorderSequence: (itemIds: string[]) => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:sequence:reorder', itemIds),
  clearSequence: () => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:sequence:clear'),
  pause: () => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:pause'),
  resume: () => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:resume'),
  restart: () => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:restart'),
  stop: () => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:stop'),
  next: () => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:next'),
  previous: () => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:previous'),
  importCatalog: () => invokeLogged<import('./src/music-catalog-service').MusicCatalogImportResult | { cancelled: true }>('player:catalog:import'),
  replayPreviousRecovery: (attemptId: string) => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:recovery:replay', attemptId),
  chooseAnotherRecovery: (attemptId: string, code: string) => invokeLogged<import('./src/manual-playback-service').ManualPlaybackResult>('player:recovery:choose-another', attemptId, code),
  leaveRecoveryStopped: (attemptId: string) => invokeLogged<import('./src/player-playback-recovery').PlayerRecoverySnapshot>('player:recovery:leave-stopped', attemptId),
  resolveInvalidRecovery: () => invokeLogged<{ state: import('./src/player-playback-recovery').PlayerRecoverySnapshot; preservedFileCount: number }>('player:recovery:resolve-invalid'),
  onPlaybackEvent: (callback: (event: import('./src/player-playback-contracts').PlayerPlaybackEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: import('./src/player-playback-contracts').PlayerPlaybackEvent) => callback(value)
    ipcRenderer.on('player:playback-event', listener)
    return () => ipcRenderer.removeListener('player:playback-event', listener)
  }
})
