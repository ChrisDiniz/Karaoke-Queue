import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { FileLogger } from './logging'
import type { LocalLicenseService } from './license-service'

type IpcEventListener = (event: IpcMainEvent, ...args: unknown[]) => void

export interface MainControllerIpcDependencies {
  ipcMain: IpcMain
  getLicenseService(): LocalLicenseService | undefined
  logger: Pick<FileLogger, 'info' | 'warn' | 'error'>
  openLogs(): Promise<string>
  assertControllerIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): void
  reportSessionEvent(event: string, sessionId: unknown, result?: string): void
}

export interface MainControllerWindowIpcDependencies {
  ipcMain: IpcMain
  assertControllerIpcSender(event: IpcMainInvokeEvent): void
  getUiScale(): unknown
  setUiScalePreference(value: unknown): unknown
  getSidebarDisplayName(): string
  setSidebarDisplayName(value: unknown): string
}

interface MainIpcRegistration {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void
  on(channel: string, listener: IpcEventListener): void
  dispose(): void
}

function createRegistration(ipcMain: IpcMain): MainIpcRegistration {
  const handledChannels: string[] = []
  const eventListeners: Array<{ channel: string; listener: IpcEventListener }> = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const { channel, listener } of eventListeners.splice(0).reverse()) ipcMain.removeListener(channel, listener)
    for (const channel of handledChannels.splice(0).reverse()) ipcMain.removeHandler(channel)
  }
  return {
    handle(channel, listener) {
      try {
        ipcMain.handle(channel, listener)
        handledChannels.push(channel)
      } catch (error) { dispose(); throw error }
    },
    on(channel, listener) {
      try {
        ipcMain.on(channel, listener)
        eventListeners.push({ channel, listener })
      } catch (error) { dispose(); throw error }
    },
    dispose
  }
}

function listenForAuthorizedController(
  deps: MainControllerIpcDependencies,
  channel: string,
  listener: (event: IpcMainEvent, ...args: unknown[]) => void
): IpcEventListener {
  return (event, ...args) => {
    try { deps.assertControllerIpcSender(event) }
    catch (error) {
      deps.logger.warn('ipc', 'CONTROLLER_IPC_FORBIDDEN', 'Um evento IPC de Controller não autorizado foi descartado.', undefined, {
        channel, reason: error instanceof Error ? error.message : String(error)
      })
      return
    }
    listener(event, ...args)
  }
}

export function registerMainControllerIpcHandlers(deps: MainControllerIpcDependencies): () => void {
  const registration = createRegistration(deps.ipcMain)
  const handle = registration.handle.bind(registration)

  handle('license:get-status', event => {
    deps.assertControllerIpcSender(event)
    const service = deps.getLicenseService()
    if (!service) throw new Error('LICENSE_SERVICE_UNAVAILABLE')
    return service.getStatus()
  })
  handle('license:activate', (event, token: unknown) => {
    deps.assertControllerIpcSender(event)
    const service = deps.getLicenseService()
    if (!service) throw new Error('LICENSE_SERVICE_UNAVAILABLE')
    try { return service.activate(token) } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_ACTIVATION_TOKEN') throw error
      deps.logger.error('license', 'LICENSE_ACTIVATION_PERSIST_FAILED', 'Falha ao persistir a ativação local.', error)
      throw error
    }
  })
  registration.on('diagnostics:renderer-log', listenForAuthorizedController(deps, 'diagnostics:renderer-log', (_event, payload) => {
    if (!payload || typeof payload !== 'object') return
    const value = payload as { event?: unknown; message?: unknown; stack?: unknown }
    const message = typeof value.message === 'string' ? value.message.slice(0, 12000) : 'Erro do renderer sem mensagem.'
    const stack = typeof value.stack === 'string' ? new Error(value.stack) : undefined
    if (typeof value.event === 'string' && /^PERSISTENCE_(OPERATION_FAILED|WRITE_FAILED|UNCERTAIN|RETRY|ACK_RECOVERED|RECOVERY_STARTED|RECOVERED|RECONCILED)$/.test(value.event)) {
      const level = /FAILED|UNCERTAIN/.test(value.event) ? 'error' : 'info'
      if (level === 'error') deps.logger.error('renderer', value.event, message)
      else deps.logger.info('renderer', value.event, message)
      return
    }
    const eventName = value.event === 'RENDERER_UNHANDLED_REJECTION' ? 'RENDERER_UNHANDLED_REJECTION'
      : value.event === 'RENDERER_IPC_FAILED' ? 'RENDERER_IPC_FAILED'
        : 'RENDERER_UNCAUGHT_EXCEPTION'
    deps.logger.error('renderer', eventName, message, stack)
  }))
  handle('diagnostics:open-logs', async event => {
    deps.assertControllerIpcSender(event)
    try {
      const error = await deps.openLogs()
      if (error) {
        deps.logger.warn('main', 'LOG_FOLDER_OPEN_FAILED', 'O sistema não conseguiu abrir a pasta de logs.', undefined, { error })
        return { ok: false, error }
      }
      deps.logger.info('main', 'LOG_FOLDER_OPENED', 'O operador abriu a pasta de logs.')
      return { ok: true }
    } catch (error) {
      deps.logger.error('main', 'LOG_FOLDER_OPEN_FAILED', 'Falha ao abrir a pasta de logs.', error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  registration.on('diagnostics:session-event', listenForAuthorizedController(deps, 'diagnostics:session-event', (_event, payload) => {
    if (!payload || typeof payload !== 'object') return
    const value = payload as { event?: unknown; sessionId?: unknown; result?: unknown }
    if (typeof value.event === 'string') deps.reportSessionEvent(value.event,
      value.sessionId, typeof value.result === 'string' ? value.result : undefined)
  }))
  return () => registration.dispose()
}

export function registerMainControllerWindowIpcHandlers(deps: MainControllerWindowIpcDependencies): () => void {
  const registration = createRegistration(deps.ipcMain)
  const handle = registration.handle.bind(registration)
  handle('ui-scale:get', event => { deps.assertControllerIpcSender(event); return deps.getUiScale() })
  handle('ui-scale:set-preference', (event, value: unknown) => {
    deps.assertControllerIpcSender(event)
    return deps.setUiScalePreference(value)
  })
  handle('ui-preferences:sidebar-name:get', event => {
    deps.assertControllerIpcSender(event)
    return deps.getSidebarDisplayName()
  })
  handle('ui-preferences:sidebar-name:set', (event, value: unknown) => {
    deps.assertControllerIpcSender(event)
    return deps.setSidebarDisplayName(value)
  })
  return () => registration.dispose()
}
