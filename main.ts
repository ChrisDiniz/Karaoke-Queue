import { app, BrowserWindow, crashReporter, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createKaraokeDatabase } from './database'
import { validateAppStatePayload } from './src/app-state-validation'
import { LocalLicenseService } from './src/license-service'
import { createFileLogger } from './src/logging'
import {
  createUiScaleState,
  getUiScaleFactor,
  normalizeUiScalePreference,
  type UiScalePreference,
  type UiScaleState
} from './src/ui/ui-scale'
import {
  DEFAULT_SIDEBAR_DISPLAY_NAME,
  validateSidebarDisplayName
} from './src/ui/sidebar-display-name'

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let mainWindow: BrowserWindow | null = null
let pendingWindowActivation = false

function activateMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    pendingWindowActivation = true
    return
  }
  pendingWindowActivation = false
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

if (hasSingleInstanceLock) app.on('second-instance', activateMainWindow)

let database: ReturnType<typeof createKaraokeDatabase> | undefined
let licenseService: LocalLicenseService | undefined
let uiScalePreference: UiScalePreference = 'auto'
let sidebarDisplayName = DEFAULT_SIDEBAR_DISPLAY_NAME
let uiScaleFilePath = ''
const userDataDirectory = app.getPath('userData')
const logger = createFileLogger({
  logsDirectory: path.join(userDataDirectory, 'logs'),
  userDataDirectory
})
const previousExecution = hasSingleInstanceLock
  ? logger.startRun()
  : { previousRunId: null, previousStatus: null }
let fatalMainFailure = false

if (hasSingleInstanceLock) {
  try {
    app.setPath('crashDumps', logger.crashesDirectory)
    crashReporter.start({ uploadToServer: false, productName: app.getName() })
    logger.pruneCrashDumps()
  } catch (error) {
    logger.warn('main', 'CRASH_REPORTER_INIT_FAILED', 'Não foi possível iniciar a captura local de minidumps.', error)
  }
}

if (hasSingleInstanceLock) {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    fatalMainFailure = true
    logger.fatal('main', 'MAIN_UNCAUGHT_EXCEPTION', `Exceção não capturada (${origin}).`, error)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('main', 'MAIN_UNHANDLED_REJECTION', 'Promise rejeitada sem tratamento no processo principal.', reason)
  })
}

if (hasSingleInstanceLock && previousExecution.previousStatus === 'normal') {
  logger.info('main', 'APP_PREVIOUS_RUN_NORMAL', 'A execução anterior confirmou saída normal.', {
    previousRunId: previousExecution.previousRunId
  })
}

function reportSessionEvent(event: string, sessionId: unknown, result?: string): void {
  const allowedEvents = new Set([
    'SESSION_STARTED', 'SESSION_RESUMED', 'SESSION_CLOSE_REQUESTED',
    'SESSION_CLOSE_CANCELLED', 'SESSION_ENDED', 'SESSION_PERSISTED'
  ])
  if (!allowedEvents.has(event)) return
  const safeSessionId = typeof sessionId === 'string' && sessionId.length <= 120 ? sessionId : undefined
  const details = {
    ...(safeSessionId ? { sessionId: safeSessionId } : {}),
    ...(typeof result === 'string' ? { result: result.slice(0, 80) } : {})
  }
  logger.info('session', event, event.replaceAll('_', ' ').toLowerCase(), details)
}

interface PersistedUiPreferences {
  scalePreference?: unknown
  sidebarDisplayName?: unknown
}

function readPersistedUiPreferences(filePath: string): PersistedUiPreferences {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedUiPreferences
    return stored && typeof stored === 'object' ? stored : {}
  } catch {
    return {}
  }
}

function normalizeStoredSidebarName(value: unknown): string {
  try { return validateSidebarDisplayName(value) } catch { return DEFAULT_SIDEBAR_DISPLAY_NAME }
}

function writeUiPreferences(filePath: string, updates: {
  scalePreference?: UiScalePreference
  sidebarDisplayName?: string
}): void {
  const stored = readPersistedUiPreferences(filePath)
  const next = {
    scalePreference: updates.scalePreference ?? normalizeUiScalePreference(stored.scalePreference),
    sidebarDisplayName: updates.sidebarDisplayName ?? normalizeStoredSidebarName(stored.sidebarDisplayName)
  }
  const temporaryPath = `${filePath}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(temporaryPath, JSON.stringify(next), 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

function canonicalJson(value: unknown): string {
  const canonical = (input: any): any => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === 'object'
      ? Object.fromEntries(Object.keys(input).sort().filter(key => input[key] !== undefined)
        .map(key => [key, canonical(input[key])]))
      : input
  return JSON.stringify(canonical(value))
}

function operationalState(state: StoredAppState): unknown {
  return {
    queue: state.queue ?? [], history: state.history ?? [], sessions: state.sessions ?? [],
    currentSessionId: state.currentSessionId ?? null,
    priorityIds: state.priorityIds ?? [], fixedTurnPositions: state.fixedTurnPositions ?? {},
    frozenTurnIds: state.frozenTurnIds ?? [], nextTurnId: state.nextTurnId ?? null,
    currentTurnId: state.currentTurnId ?? null, queueOrderPolicyVersion: state.queueOrderPolicyVersion ?? 0,
    regularsSinceDebut: state.regularsSinceDebut ?? 0, currentTurnAutomatic: state.currentTurnAutomatic ?? false,
    lastReset: state.lastReset ?? null
  }
}

function requireLicenseForOperationalWrite(current: StoredAppState, next: StoredAppState): void {
  if (licenseService?.isOperationallyAllowed()) return
  if (canonicalJson(operationalState(current)) === canonicalJson(operationalState(next))) return
  throw new Error('LICENSE_EXPIRED')
}

function createWindow() {
  const initialSize = { width: 1280, height: 800 }
  const initialUiScale = createUiScaleState(
    uiScalePreference,
    getUiScaleFactor(initialSize.width, initialSize.height)
  )
  const win = new BrowserWindow({
    ...initialSize,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      zoomFactor: initialUiScale.effectiveFactor
    },
    title: 'Karaoke Queue',
    autoHideMenuBar: true
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('renderer', 'RENDERER_PROCESS_GONE', 'O processo de interface terminou inesperadamente.', undefined, {
      reason: details.reason, exitCode: details.exitCode
    })
  })
  win.webContents.on('unresponsive', () => {
    logger.warn('renderer', 'RENDERER_UNRESPONSIVE', 'A interface deixou de responder.')
  })
  win.webContents.on('responsive', () => {
    logger.info('renderer', 'RENDERER_RESPONSIVE', 'A interface voltou a responder.')
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logger.error('renderer', 'RENDERER_LOAD_FAILED', 'Falha ao carregar conteúdo da interface.', undefined, {
      errorCode, errorDescription, isMainFrame
    })
  })

  let appliedUiScale = initialUiScale.effectiveFactor
  let lastUiScaleState = initialUiScale
  const publishUiScaleState = (state: UiScaleState) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('ui-scale:changed', state)
  }
  const applyUiScale = (notify = false) => {
    const [width, height] = win.getContentSize()
    const state = createUiScaleState(uiScalePreference, getUiScaleFactor(width, height))
    if (state.effectiveFactor !== appliedUiScale) {
      appliedUiScale = state.effectiveFactor
      win.webContents.setZoomFactor(state.effectiveFactor)
    }
    const stateChanged = state.preference !== lastUiScaleState.preference
      || state.automaticFactor !== lastUiScaleState.automaticFactor
      || state.effectiveFactor !== lastUiScaleState.effectiveFactor
    lastUiScaleState = state
    if (notify && stateChanged) publishUiScaleState(state)
    return state
  }

  win.on('resize', () => applyUiScale(true))
  win.webContents.on('did-finish-load', () => applyUiScale(true))

  ipcMain.handle('ui-scale:get', () => applyUiScale())
  ipcMain.handle('ui-scale:set-preference', (_event, value: unknown) => {
    try {
      const nextPreference = normalizeUiScalePreference(value)
      if (nextPreference !== value) throw new Error('Invalid UI scale preference')
      if (!licenseService?.isOperationallyAllowed()) throw new Error('LICENSE_EXPIRED')
      writeUiPreferences(uiScaleFilePath, { scalePreference: nextPreference })
      uiScalePreference = nextPreference
      const state = applyUiScale()
      if (!state) throw new Error('Window is unavailable')
      publishUiScaleState(state)
      return state
    } catch (error) {
      logger.error('main', 'UI_SCALE_PREFERENCE_SAVE_FAILED', 'Falha ao aplicar ou persistir a escala da interface.', error)
      throw error
    }
  })

  ipcMain.handle('ui-preferences:sidebar-name:get', () => sidebarDisplayName)
  ipcMain.handle('ui-preferences:sidebar-name:set', (_event, value: unknown) => {
    try {
      const nextName = validateSidebarDisplayName(value)
      if (!licenseService?.isOperationallyAllowed()) throw new Error('LICENSE_EXPIRED')
      writeUiPreferences(uiScaleFilePath, { sidebarDisplayName: nextName })
      sidebarDisplayName = nextName
      return sidebarDisplayName
    } catch (error) {
      logger.warn('main', 'SIDEBAR_DISPLAY_NAME_SAVE_FAILED', 'Falha ao validar ou persistir o nome exibido na sidebar.', error)
      throw error
    }
  })

  if (pendingWindowActivation) activateMainWindow()
  win.loadFile(path.join(__dirname, 'src', 'index.html'))

  let closeFlowRunning = false
  let allowWindowClose = false
  const closeAfterPersisting = () => {
    allowWindowClose = true
    win.close()
  }
  const showCloseError = async (error: unknown) => {
    logger.error('main', 'APP_CLOSE_PERSISTENCE_FAILED', 'O aplicativo não fechou porque a persistência falhou.', error)
    if (win.isDestroyed()) return
    const detail = error instanceof Error ? error.message : String(error)
    await dialog.showMessageBox(win, {
      type: 'error', title: 'Não foi possível fechar o Karaoke Queue',
      message: 'Os dados da sessão não foram confirmados no banco.',
      detail: `${detail}\n\nO aplicativo permanecerá aberto para proteger a sessão.`,
      buttons: ['Voltar ao aplicativo'], defaultId: 0
    }).catch(() => undefined)
  }

  win.on('close', event => {
    if (allowWindowClose) return
    event.preventDefault()
    if (closeFlowRunning) return
    closeFlowRunning = true
    logger.info('main', 'APP_CLOSE_REQUESTED', 'O operador solicitou o fechamento do aplicativo.')

    void (async () => {
      await win.webContents.executeJavaScript('window.__kqueue.prepareToClose()')
      const closeSummary = await win.webContents.executeJavaScript('window.__kqueue.closeSummary()') as {
        sessionActive: boolean
        uncompletedCount: number
        sessionId: string | null
      }
      if (!licenseService?.isOperationallyAllowed()) {
        await win.webContents.executeJavaScript('window.__kqueue.flushState()')
        logger.info('main', 'APP_CLOSE_DECISION', 'O aplicativo expirado foi fechado sem encerrar nem modificar a sessão.', {
          sessionId: closeSummary.sessionId, sessionRemainsOpen: closeSummary.sessionActive
        })
        closeAfterPersisting()
        return
      }
      if (!closeSummary.sessionActive) {
        await win.webContents.executeJavaScript('window.__kqueue.flushState()')
        logger.info('main', 'APP_CLOSE_DECISION', 'O aplicativo foi fechado sem sessão ativa.')
        closeAfterPersisting()
        return
      }

      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Karaoke Queue',
        message: 'Como deseja fechar o aplicativo?',
        buttons: ['Encerrar sessão e sair', 'Sair sem encerrar sessão', 'Cancelar'],
        defaultId: 2,
        cancelId: 2
      })
      if (response === 2) {
        logger.info('main', 'APP_CLOSE_CANCELLED', 'O operador cancelou o fechamento do aplicativo.')
        return
      }

      if (response === 0) {
        logger.info('session', 'SESSION_CLOSE_REQUESTED', 'O operador solicitou o encerramento da sessão.', {
          sessionId: closeSummary.sessionId
        })
        if (closeSummary.uncompletedCount > 0) {
          const count = closeSummary.uncompletedCount
          const label = count === 1 ? 'apresentação não concluída' : 'apresentações não concluídas'
          const confirmation = await dialog.showMessageBox(win, {
            type: 'warning',
            title: 'Confirmar encerramento da sessão',
            message: `Há ${count} ${label}, incluindo a Vez atual se estiver selecionada.`,
            detail: 'Elas serão arquivadas como pendentes no histórico da sessão. A nova sessão não herdará essa fila.',
            buttons: ['Encerrar e arquivar pendências', 'Voltar ao aplicativo'],
            defaultId: 1,
            cancelId: 1
          })
          if (confirmation.response !== 0) {
            logger.info('session', 'SESSION_CLOSE_CANCELLED', 'O operador cancelou a confirmação de encerramento.', {
              sessionId: closeSummary.sessionId
            })
            return
          }
        }
        const ended = await win.webContents.executeJavaScript('window.__kqueue.endSessionAndArchive()')
        if (ended !== true) throw new Error('A sessão ativa não foi encerrada.')
        logger.info('session', 'SESSION_ENDED', 'A sessão foi encerrada e arquivada.', { sessionId: closeSummary.sessionId })
        logger.info('session', 'SESSION_PERSISTED', 'O encerramento da sessão foi confirmado no banco.', { sessionId: closeSummary.sessionId })
      } else {
        await win.webContents.executeJavaScript('window.__kqueue.flushState()')
        logger.info('main', 'APP_CLOSE_DECISION', 'O operador saiu sem encerrar a sessão.', {
          sessionId: closeSummary.sessionId, sessionRemainsOpen: closeSummary.sessionActive
        })
      }

      closeAfterPersisting()
    })().catch(error => {
      logger.error('main', 'APP_CLOSE_FLOW_FAILED', 'Falha durante o fluxo de fechamento.', error)
      return showCloseError(error)
    }).finally(() => {
      closeFlowRunning = false
      if (!allowWindowClose && !win.isDestroyed()) {
        void win.webContents.executeJavaScript('window.__kqueue?.cancelClose()').catch(() => undefined)
      }
    })
  })
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  try {
    licenseService = new LocalLicenseService(path.join(app.getPath('userData'), 'license-state.json'))
    uiScaleFilePath = path.join(app.getPath('userData'), 'ui-preferences.json')
    const uiPreferences = readPersistedUiPreferences(uiScaleFilePath)
    uiScalePreference = normalizeUiScalePreference(uiPreferences.scalePreference)
    sidebarDisplayName = normalizeStoredSidebarName(uiPreferences.sidebarDisplayName)
    const openedDatabase = createKaraokeDatabase(app.getPath('userData'))
    database = openedDatabase
    ipcMain.handle('app-data:load', () => {
      try { return openedDatabase.loadState() } catch (error) {
        logger.error('sqlite', 'SQLITE_LOAD_FAILED', 'Falha ao carregar o estado do aplicativo.', error)
        throw error
      }
    })
    ipcMain.handle('license:get-status', () => licenseService!.getStatus())
    ipcMain.handle('license:activate', (_event, token: unknown) => {
      try { return licenseService!.activate(token) } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_ACTIVATION_TOKEN') throw error
        logger.error('license', 'LICENSE_ACTIVATION_PERSIST_FAILED', 'Falha ao persistir a ativação local.', error)
        throw error
      }
    })
    ipcMain.handle('app-data:save', (_e, data) => {
      try {
        const state = validateAppStatePayload(data)
        requireLicenseForOperationalWrite(openedDatabase.loadState(), state)
        openedDatabase.saveState(state)
        return true
      } catch (error) {
        const invalidPayload = error instanceof Error && error.message.startsWith('INVALID_APP_STATE_PAYLOAD:')
        logger.error('sqlite', invalidPayload ? 'APP_STATE_SAVE_REJECTED' : 'SQLITE_SAVE_FAILED',
          invalidPayload ? 'O payload de estado do aplicativo foi rejeitado.' : 'Falha ao persistir o estado do aplicativo.', error)
        throw error
      }
    })
    ipcMain.on('diagnostics:renderer-log', (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const value = payload as { event?: unknown; message?: unknown; stack?: unknown }
      const message = typeof value.message === 'string' ? value.message.slice(0, 12000) : 'Erro do renderer sem mensagem.'
      const stack = typeof value.stack === 'string' ? new Error(value.stack) : undefined
      if (typeof value.event === 'string' && /^PERSISTENCE_(OPERATION_FAILED|WRITE_FAILED|UNCERTAIN|RETRY|ACK_RECOVERED|RECOVERY_STARTED|RECOVERED|RECONCILED)$/.test(value.event)) {
        const level = /FAILED|UNCERTAIN/.test(value.event) ? 'error' : 'info'
        logger[level]('renderer', value.event, message)
        return
      }
      const event = value.event === 'RENDERER_UNHANDLED_REJECTION' ? 'RENDERER_UNHANDLED_REJECTION'
        : value.event === 'RENDERER_IPC_FAILED' ? 'RENDERER_IPC_FAILED'
          : 'RENDERER_UNCAUGHT_EXCEPTION'
      logger.error('renderer', event, message, stack)
    })
    ipcMain.handle('diagnostics:open-logs', async () => {
      try {
        const error = await shell.openPath(logger.logsDirectory)
        if (error) {
          logger.warn('main', 'LOG_FOLDER_OPEN_FAILED', 'O sistema não conseguiu abrir a pasta de logs.', undefined, { error })
          return { ok: false, error }
        }
        logger.info('main', 'LOG_FOLDER_OPENED', 'O operador abriu a pasta de logs.')
        return { ok: true }
      } catch (error) {
        logger.error('main', 'LOG_FOLDER_OPEN_FAILED', 'Falha ao abrir a pasta de logs.', error)
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    ipcMain.on('diagnostics:session-event', (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const value = payload as { event?: unknown; sessionId?: unknown; result?: unknown }
      if (typeof value.event === 'string') reportSessionEvent(value.event,
        value.sessionId, typeof value.result === 'string' ? value.result : undefined)
    })
    createWindow()
    app.on('child-process-gone', (_event, details) => {
      logger.error('electron', 'CHILD_PROCESS_GONE', 'Um subprocesso do Electron terminou inesperadamente.', undefined, {
        type: details.type, reason: details.reason, exitCode: details.exitCode
      })
    })
    logger.info('main', 'APP_READY', 'Aplicativo e persistência local inicializados.')
  } catch (error: unknown) {
    fatalMainFailure = true
    logger.fatal('main', 'APP_INITIALIZATION_FAILED', 'Falha crítica durante a inicialização.', error)
    logger.error('sqlite', 'SQLITE_INITIALIZATION_FAILED', 'Falha ao inicializar o banco SQLite.', error)
    const detail = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox(
      'Não foi possível abrir os dados do Karaoke Queue',
      `O banco local não pôde ser inicializado. Seus dados antigos foram preservados.\n\n${detail}`
    )
    app.quit()
  }
})

if (hasSingleInstanceLock) app.on('before-quit', () => logger.info('main', 'APP_QUIT_SEQUENCE_STARTED', 'O Electron iniciou a sequência normal de saída.'))
if (hasSingleInstanceLock) app.on('will-quit', () => {
  try { database?.close() } catch (error) {
    fatalMainFailure = true
    logger.error('sqlite', 'SQLITE_CLOSE_FAILED', 'Falha ao fechar a conexão SQLite.', error)
  }
  logger.finishRun(fatalMainFailure ? 'failed' : 'normal')
})

if (hasSingleInstanceLock) app.on('window-all-closed', () => {
  app.quit()
})
