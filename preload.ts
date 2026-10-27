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
    invokeLogged<string>('ui-preferences:sidebar-name:set', name)
})

contextBridge.exposeInMainWorld('karaokeDiagnostics', {
  openLogsFolder: () => invokeLogged<{ ok: boolean; error?: string }>('diagnostics:open-logs'),
  logSessionEvent: (event: string, sessionId: string | null, result?: string) =>
    ipcRenderer.send('diagnostics:session-event', { event, sessionId, result }),
  reportRendererError: (event: string, message: string, stack?: string) =>
    ipcRenderer.send('diagnostics:renderer-log', { event, message, stack })
})
