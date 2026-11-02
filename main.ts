import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, protocol, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createKaraokeDatabase, createPlayerMusicCatalogDatabase } from './database'
import { validateAppStatePayload } from './src/app-state-validation'
import { LocalLicenseService } from './src/license-service'
import { createFileLogger } from './src/logging'
import { MusicCatalogService } from './src/music-catalog-service'
import { normalizeCatalogCodeForVideoMatch } from './src/music-catalog'
import { readVideoLibraryConfiguration, writeVideoLibraryConfiguration } from './src/video-library-configuration'
import { VideoLibraryService } from './src/video-library-service'
import { PlayerMediaProtocol, registerPlayerMediaScheme } from './src/player-media-protocol'
import { PlayerPlaybackService } from './src/player-playback-service'
import { ManualPlaybackService } from './src/manual-playback-service'
import type { ManualPlaybackResult } from './src/manual-playback-service'
import { PlayerPlaybackRecoveryCoordinator } from './src/player-playback-recovery'
import { PlayerPlaybackRecoveryStore } from './src/player-playback-recovery-store'
import type { PlayerUiSnapshot, PlayerLibraryStatus } from './src/player-ui-contracts'
import { isAuthorizedPlayerIpcSender } from './src/player-ui-contracts'
import { PlayerVideoWindow, type PlayerVideoBounds } from './src/player-video-window'
import {
  getOperatingModeCapabilities,
  isOperatingMode,
  requiresFirstLaunchModeSelection,
  readOperatingModeConfiguration,
  writeOperatingModeConfiguration,
  type OperatingMode,
  type OperatingModeCapabilities
} from './src/operating-mode'
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
else registerPlayerMediaScheme(protocol)

let mainWindow: BrowserWindow | null = null
let welcomeWindow: BrowserWindow | null = null
let pendingWindowActivation = false
let operatingMode: OperatingMode | null = null
let modeCapabilities: OperatingModeCapabilities | null = null
let startupInitializationComplete = false
let shutdownStarted = false
let playerQuitAllowed = false
let shutdownApprovedAttemptId: string | undefined
let libraryOperationInProgress = false

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

function createWelcomeWindow(): BrowserWindow {
  const documentPath = path.join(__dirname, 'src', 'welcome.html')
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 620,
    show: true,
    title: 'Karaoke Queue · Configuração inicial',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'welcome-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })
  welcomeWindow = win
  const expectedUrl = pathToFileURL(documentPath).href
  ipcMain.handle('welcome:choose-mode', (event, mode: unknown) => {
    const frame = event.senderFrame
    if (welcomeWindow !== win || win.isDestroyed() || event.sender !== win.webContents ||
        !frame || frame !== win.webContents.mainFrame || frame.url !== expectedUrl) {
      throw new Error('WELCOME_IPC_FORBIDDEN')
    }
    if (!isOperatingMode(mode)) throw new Error('INVALID_OPERATING_MODE')
    writeOperatingModeConfiguration(userDataDirectory, mode)
    app.relaunch()
    app.quit()
  })
  win.once('closed', () => {
    if (welcomeWindow === win) welcomeWindow = null
    ipcMain.removeHandler('welcome:choose-mode')
  })
  void win.loadFile(documentPath)
  return win
}

if (hasSingleInstanceLock) app.on('second-instance', () => {
  if (modeCapabilities && !modeCapabilities.controller && !modeCapabilities.player) return
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    if (welcomeWindow.isMinimized()) welcomeWindow.restore()
    welcomeWindow.show()
    welcomeWindow.focus()
    return
  }
  activateMainWindow()
})

let database: ReturnType<typeof createKaraokeDatabase> | undefined
let playerCatalogDatabase: ReturnType<typeof createPlayerMusicCatalogDatabase> | undefined
let licenseService: LocalLicenseService | undefined
let videoLibrary: VideoLibraryService | undefined
let musicCatalogService: MusicCatalogService | undefined
let playerMediaProtocol: PlayerMediaProtocol | undefined
let playerPlaybackService: PlayerPlaybackService | undefined
let manualPlaybackService: ManualPlaybackService | undefined
let playerPlaybackRecovery: PlayerPlaybackRecoveryCoordinator | undefined
let playerVideoWindow: PlayerVideoWindow | undefined
let unsubscribePlayerUiEvents: (() => void) | undefined
let unsubscribeManualUiEvents: (() => void) | undefined
let playerUiRevision = 0
let catalogShutdownStarted = false
let catalogShutdownComplete = false
let playerShutdownStarted = false
let playerShutdownComplete = false
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
    if (!startupInitializationComplete) {
      allowWindowClose = true
      return
    }
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

function requirePlayerIpcSender(event: Electron.IpcMainInvokeEvent): void {
  const ownerWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const senderFrame = event.senderFrame
  const mainFrame = event.sender.mainFrame
  if (!isAuthorizedPlayerIpcSender({
    playerEnabled: modeCapabilities?.player === true,
    senderWebContentsId: event.sender.id,
    expectedWebContentsId: ownerWindow?.webContents.id,
    isMainFrame: Boolean(senderFrame && senderFrame === mainFrame),
    frameUrl: senderFrame?.url,
    expectedDocumentUrl: pathToFileURL(path.join(__dirname, 'src', operatingMode === 'player' ? 'player-control.html' : 'index.html')).href
  })) {
    throw new Error('PLAYER_IPC_FORBIDDEN')
  }
}

function createPlayerControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: true,
    title: 'Karaoke Queue · Reprodutor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'player-control-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })
  mainWindow = win
  win.on('close', event => {
    if (playerQuitAllowed || shutdownStarted) return
    event.preventDefault()
    app.quit()
  })
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('renderer', 'PLAYER_CONTROL_RENDERER_GONE', 'A interface do Reprodutor terminou inesperadamente.', undefined, {
      reason: details.reason, exitCode: details.exitCode
    })
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    logger.error('renderer', 'PLAYER_CONTROL_LOAD_FAILED', 'A interface do Reprodutor não pôde ser carregada.', undefined, {
      errorCode, errorDescription, isMainFrame
    })
  })
  void win.loadFile(path.join(__dirname, 'src', 'player-control.html'))
  return win
}

function requirePlayerServices() {
  if (!modeCapabilities?.player || !playerPlaybackService || !manualPlaybackService || !videoLibrary || !playerPlaybackRecovery) {
    throw new Error('PLAYER_UNAVAILABLE')
  }
  return { playback: playerPlaybackService, manual: manualPlaybackService, library: videoLibrary, recovery: playerPlaybackRecovery }
}

function requirePlayerSequenceMode(): void {
  if (operatingMode !== 'player') throw new Error('LOCAL_SEQUENCE_UNAVAILABLE_IN_COMBINED_MODE')
}

function playerLibraryStatus(): PlayerLibraryStatus {
  if (!videoLibrary) return 'unavailable'
  const snapshot = videoLibrary.getSnapshot()
  if (snapshot.configuredRootCount === 0) return 'not-configured'
  if (snapshot.scanStatus === 'scanning') return 'indexing'
  if (snapshot.scanStatus === 'ready') return snapshot.counts.availableCodes > 0 ? 'available' : 'empty'
  if (snapshot.scanStatus === 'degraded') return 'error'
  return 'unavailable'
}

function getPlayerUiSnapshot(): PlayerUiSnapshot {
  const { playback, manual, library, recovery } = requirePlayerServices()
  const inventory = library.getSnapshot()
  const catalogMetadata = musicCatalogService?.getMetadata() ?? { revision: null, importedAt: null, recordCount: 0, sourceName: null }
  return {
    revision: ++playerUiRevision,
    mode: operatingMode as 'player' | 'combined',
    library: {
      status: playerLibraryStatus(), scanStatus: inventory.scanStatus,
      indexedFiles: inventory.counts.indexedFiles, availableCodes: inventory.counts.availableCodes,
      ambiguousCodes: inventory.counts.ambiguousCodes, missingCodes: inventory.counts.missingCodes,
      unreadableCodes: inventory.counts.unreadableCodes, unknownCodes: inventory.counts.unknownCodes,
      lastIndexedAt: inventory.scannedAt,
      configuredFolders: [...library.roots]
    },
    playback: playback.getState(),
    progress: playback.getProgress(),
    sequence: manual.getSequence(),
    catalog: { status: catalogMetadata.revision ? 'available' : 'not-configured', metadata: catalogMetadata },
    recovery: recovery.getState(),
    recoveryDiagnostic: recovery.getDiagnosticSummary(),
    videoWindow: playerVideoWindow?.getSnapshot() ?? { open: false, fullScreen: false, ready: false, location: 'hidden', returnToInlineRevision: 0 }
  }
}

function publishPlayerSnapshot(): void {
  const win = mainWindow
  if (!modeCapabilities?.player || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try { win.webContents.send('player:snapshot', getPlayerUiSnapshot()) }
  catch (error) { logger.warn('player', 'PLAYER_SNAPSHOT_PUBLISH_FAILED', 'O estado do Reprodutor não pôde ser enviado à interface.', error) }
}

function playerDisplayStatus(): 'idle' | 'loading' | 'playing' | 'paused' | 'failed' | 'uncertain' {
  const status = playerPlaybackService?.getState().status
  if (status === 'failed') return 'failed'
  if (status === 'uncertain') return 'uncertain'
  if (status === 'playing') return 'playing'
  if (status === 'paused') return 'paused'
  if (['loading', 'starting', 'ready', 'stopping'].includes(status ?? '')) return 'loading'
  return 'idle'
}

function assertPlayerNotChangingLibrary(): void {
  if (libraryOperationInProgress) throw new Error('VIDEO_LIBRARY_BUSY')
}

function assertLibraryCanChange(): void {
  if (playerPlaybackRecovery?.requestShutdown().outcome === 'confirmation-required') {
    throw new Error('PLAYER_ACTIVE')
  }
}

async function showPlayerVideoWindow(focus = true): Promise<ReturnType<NonNullable<typeof playerVideoWindow>['getSnapshot']>> {
  if (operatingMode !== 'player' || !playerVideoWindow) throw new Error('HOST_UNAVAILABLE')
  await playerVideoWindow.show(focus)
  publishPlayerSnapshot()
  return playerVideoWindow.getSnapshot()
}

function registerPlayerIpcHandlers(): void {
  ipcMain.handle('player:get-snapshot', event => {
    requirePlayerIpcSender(event)
    return getPlayerUiSnapshot()
  })
  ipcMain.handle('player:lookup-code', async (event, code: unknown) => {
    requirePlayerIpcSender(event)
    const { library } = requirePlayerServices()
    if (musicCatalogService) {
      const item = await musicCatalogService.lookupByVideoCode(code)
      return {
        videoCode: item.videoCode, artist: item.artist, title: item.title,
        metadataAvailable: item.metadataAvailable, videoAvailability: item.videoAvailability
      }
    }
    const normalized = normalizeCatalogCodeForVideoMatch(code)
    const item = await library.lookup(normalized)
    return { videoCode: normalized, artist: null, title: null, metadataAvailable: false,
      videoAvailability: item.status === 'invalid-code' ? 'unknown' : item.status }
  })
  ipcMain.handle('player:play-now', async (event, code: unknown) => {
    requirePlayerIpcSender(event)
    if (operatingMode !== 'player') throw new Error('MANUAL_CODE_PLAY_UNAVAILABLE_IN_COMBINED_MODE')
    assertPlayerNotChangingLibrary()
    return requirePlayerServices().manual.playByMusicCode(code)
  })
  ipcMain.handle('player:sequence:add', async (event, code: unknown) => {
    requirePlayerIpcSender(event); requirePlayerSequenceMode(); assertPlayerNotChangingLibrary()
    return requirePlayerServices().manual.addToSequence(code)
  })
  ipcMain.handle('player:sequence:remove', (event, itemId: unknown) => {
    requirePlayerIpcSender(event); requirePlayerSequenceMode(); assertPlayerNotChangingLibrary()
    return requirePlayerServices().manual.removeFromSequence(itemId)
  })
  ipcMain.handle('player:sequence:reorder', (event, itemIds: unknown) => {
    requirePlayerIpcSender(event); requirePlayerSequenceMode(); assertPlayerNotChangingLibrary()
    return requirePlayerServices().manual.reorderSequence(Array.isArray(itemIds) ? itemIds : [])
  })
  ipcMain.handle('player:sequence:clear', event => {
    requirePlayerIpcSender(event); requirePlayerSequenceMode(); assertPlayerNotChangingLibrary()
    return requirePlayerServices().manual.clearSequence()
  })
  ipcMain.handle('player:pause', event => { requirePlayerIpcSender(event); assertPlayerNotChangingLibrary(); return requirePlayerServices().manual.pause() })
  ipcMain.handle('player:resume', event => { requirePlayerIpcSender(event); assertPlayerNotChangingLibrary(); return requirePlayerServices().manual.resume() })
  ipcMain.handle('player:restart', event => { requirePlayerIpcSender(event); assertPlayerNotChangingLibrary(); return requirePlayerServices().manual.restart() })
  ipcMain.handle('player:stop', event => { requirePlayerIpcSender(event); assertPlayerNotChangingLibrary(); return requirePlayerServices().manual.stop() })
  ipcMain.handle('player:next', event => { requirePlayerIpcSender(event); requirePlayerSequenceMode(); assertPlayerNotChangingLibrary(); return requirePlayerServices().manual.next() })
  ipcMain.handle('player:previous', event => { requirePlayerIpcSender(event); requirePlayerSequenceMode(); assertPlayerNotChangingLibrary(); return requirePlayerServices().manual.previous() })
  ipcMain.handle('player:catalog:import', async event => {
    requirePlayerIpcSender(event)
    if (!musicCatalogService) throw new Error('PLAYER_CATALOG_UNAVAILABLE')
    const options: Electron.OpenDialogOptions = { title: 'Importar catálogo de músicas', properties: ['openFile'],
      filters: [{ name: 'Catálogo CSV', extensions: ['csv'] }] }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const selection = owner && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || selection.filePaths.length !== 1) return { cancelled: true as const }
    const result = await musicCatalogService.importFile(selection.filePaths[0])
    publishPlayerSnapshot()
    return result
  })
  ipcMain.handle('player:library:select-folder', async event => {
    requirePlayerIpcSender(event)
    const { library } = requirePlayerServices()
    if (libraryOperationInProgress) throw new Error('VIDEO_LIBRARY_BUSY')
    assertLibraryCanChange()
    libraryOperationInProgress = true
    try {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = { title: 'Selecionar pasta de vídeos', properties: ['openDirectory'] }
      const selection = owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      if (selection.canceled || selection.filePaths.length !== 1) return { cancelled: true as const }
      const selectedRoot = selection.filePaths[0]
      writeVideoLibraryConfiguration(userDataDirectory, [selectedRoot])
      const scan = library.configureRoots([selectedRoot])
      publishPlayerSnapshot()
      await scan
      logger.info('player', 'VIDEO_LIBRARY_ROOT_CHANGED', 'A pasta da biblioteca local foi atualizada.', {
        configuredRootCount: 1, indexedFiles: library.getSnapshot().counts.indexedFiles
      })
      return getPlayerUiSnapshot()
    } finally {
      libraryOperationInProgress = false
      publishPlayerSnapshot()
    }
  })
  ipcMain.handle('player:library:refresh', async event => {
    requirePlayerIpcSender(event)
    const { library } = requirePlayerServices()
    if (libraryOperationInProgress) throw new Error('VIDEO_LIBRARY_BUSY')
    assertLibraryCanChange()
    libraryOperationInProgress = true
    try {
      const scan = library.refresh()
      publishPlayerSnapshot()
      await scan
      return getPlayerUiSnapshot()
    } finally { libraryOperationInProgress = false; publishPlayerSnapshot() }
  })
  ipcMain.handle('player:video:show', async event => { requirePlayerIpcSender(event); return showPlayerVideoWindow() })
  ipcMain.handle('player:video:inline', async (event, bounds: unknown) => {
    requirePlayerIpcSender(event)
    if (!bounds || typeof bounds !== 'object') throw new Error('INVALID_PLAYER_VIEW_BOUNDS')
    return playerVideoWindow!.showInline(bounds as PlayerVideoBounds)
  })
  ipcMain.handle('player:video:inline-bounds', async (event, bounds: unknown) => {
    requirePlayerIpcSender(event)
    if (!bounds || typeof bounds !== 'object') throw new Error('INVALID_PLAYER_VIEW_BOUNDS')
    await playerVideoWindow?.setInlineBounds(bounds as PlayerVideoBounds)
    return true
  })
  ipcMain.handle('player:video:inline-visibility', (event, visible: unknown) => {
    requirePlayerIpcSender(event)
    if (typeof visible !== 'boolean') throw new Error('INVALID_PLAYER_VIDEO_VISIBILITY')
    return playerVideoWindow?.setInlineVisible(visible) ?? false
  })
  ipcMain.handle('player:video:inline-hide', event => {
    requirePlayerIpcSender(event)
    if (!playerVideoWindow?.hideInline()) throw new Error('PLAYER_ACTIVE_INLINE')
    publishPlayerSnapshot()
    return playerVideoWindow?.getSnapshot()
  })
  ipcMain.handle('player-video:set-fullscreen', (event, action: unknown) => {
    if (!playerVideoWindow) return false
    return playerVideoWindow.setFullScreen(event.sender, action)
  })
  ipcMain.handle('player:video:fullscreen-toggle', event => {
    requirePlayerIpcSender(event)
    return playerVideoWindow?.toggleFullScreenFromControl() ?? false
  })
  ipcMain.handle('player:video:fullscreen-exit', event => {
    requirePlayerIpcSender(event)
    return playerVideoWindow?.exitFullScreenFromControl() ?? false
  })
  ipcMain.handle('player:recovery:replay', async (event, attemptId: unknown) => {
    requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_RECOVERY_ATTEMPT')
    assertPlayerNotChangingLibrary()
    return requirePlayerServices().recovery.replayPrevious(attemptId)
  })
  ipcMain.handle('player:recovery:choose-another', async (event, attemptId: unknown, code: unknown) => {
    requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_RECOVERY_ATTEMPT')
    assertPlayerNotChangingLibrary()
    return requirePlayerServices().recovery.chooseAnother(attemptId, code)
  })
  ipcMain.handle('player:recovery:leave-stopped', async (event, attemptId: unknown) => {
    requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_RECOVERY_ATTEMPT')
    return requirePlayerServices().recovery.leaveStopped(attemptId)
  })
  ipcMain.handle('player:recovery:resolve-invalid', event => {
    requirePlayerIpcSender(event)
    return requirePlayerServices().recovery.resolveInvalidRecovery()
  })
  ipcMain.handle('player:recovery:copy-diagnostic', event => {
    requirePlayerIpcSender(event)
    const summary = requirePlayerServices().recovery.getDiagnosticSummary()
    if (!summary) return { copied: false }
    const safeText = `${summary.code}: ${summary.message}`.slice(0, 1000)
    clipboard.writeText(safeText)
    return { copied: true }
  })
  ipcMain.handle('player:shutdown:cancel', (event, attemptId: unknown) => {
    requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_SHUTDOWN_ATTEMPT')
    const result = requirePlayerServices().recovery.cancelShutdown(attemptId)
    publishPlayerSnapshot()
    return result
  })
  ipcMain.handle('player:shutdown:confirm', async (event, attemptId: unknown) => {
    requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_SHUTDOWN_ATTEMPT')
    const result = await requirePlayerServices().recovery.confirmShutdown(attemptId)
    shutdownApprovedAttemptId = attemptId
    publishPlayerSnapshot()
    return result
  })
  ipcMain.handle('player:shutdown:finish', (event, attemptId: unknown) => {
    requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string' || shutdownApprovedAttemptId !== attemptId) throw new Error('SHUTDOWN_NOT_CONFIRMED')
    playerQuitAllowed = true
    playerVideoWindow?.allowWindowClose()
    app.quit()
  })
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  try {
    if (requiresFirstLaunchModeSelection(userDataDirectory)) {
      createWelcomeWindow()
      return
    }
    const configuration = readOperatingModeConfiguration(userDataDirectory)
    operatingMode = configuration.mode
    modeCapabilities = getOperatingModeCapabilities(configuration.mode)
    if (!modeCapabilities.controller) pendingWindowActivation = false
    logger.info('main', 'OPERATING_MODE_RESOLVED', 'O modo de operação foi validado.', {
      mode: operatingMode,
      controllerEnabled: modeCapabilities.controller,
      playerEnabled: modeCapabilities.player
    })
  } catch (error: unknown) {
    fatalMainFailure = true
    const detail = error instanceof Error ? error.message : 'Configuração inválida.'
    logger.fatal('main', 'OPERATING_MODE_CONFIGURATION_INVALID', 'A configuração de modo é inválida; nenhum serviço operacional foi iniciado.', error)
    dialog.showErrorBox(
      'Configuração do modo inválida',
      `${detail}\n\nO estado operacional foi preservado. Corrija ou remova operating-mode.json para iniciar no modo Controller padrão.`
    )
    app.quit()
    return
  }

  let databaseInitializationFailed = false
  try {
    licenseService = new LocalLicenseService(path.join(userDataDirectory, 'license-state.json'))

    if (modeCapabilities!.player) {
      playerPlaybackRecovery = new PlayerPlaybackRecoveryCoordinator(
        new PlayerPlaybackRecoveryStore(userDataDirectory)
      )
      const recoveryState = playerPlaybackRecovery.initialize()
      if (recoveryState.status === 'pending') {
        logger.warn('player', 'PLAYER_RECOVERY_PENDING', 'Uma reprodução anterior não tem término confirmado; nenhuma mídia será iniciada automaticamente.', {
          attemptId: recoveryState.attemptId, musicCode: recoveryState.musicCode,
          lastTransition: recoveryState.lastTransition
        })
      } else if (recoveryState.status === 'unreadable' || recoveryState.status === 'unavailable') {
        logger.error('player', 'PLAYER_RECOVERY_UNAVAILABLE', 'O estado de recuperação não pôde ser validado; o Player bloqueará novos comandos de mídia.', {
          reason: recoveryState.reason
        })
      }
      const libraryConfiguration = readVideoLibraryConfiguration(userDataDirectory)
      videoLibrary = new VideoLibraryService(libraryConfiguration.roots)
      const inventory = await videoLibrary.refresh()
      if (shutdownStarted) return
      const scanDetails = {
        revision: inventory.revision,
        scanStatus: inventory.scanStatus,
        configuredRootCount: inventory.configuredRootCount,
        scannedRootCount: inventory.scannedRootCount,
        unavailableRootCount: inventory.unavailableRootCount,
        availableCodes: inventory.counts.availableCodes,
        ambiguousCodes: inventory.counts.ambiguousCodes,
        missingCodes: inventory.counts.missingCodes,
        unreadableCodes: inventory.counts.unreadableCodes,
        unknownCodes: inventory.counts.unknownCodes
      }
      if (inventory.scanStatus === 'degraded') {
        logger.warn('player', 'VIDEO_LIBRARY_SCAN_DEGRADED', 'A biblioteca foi mantida em estado parcial; diretórios inacessíveis não foram tratados como vazios.', undefined, scanDetails)
      } else {
        logger.info('player', 'VIDEO_LIBRARY_SCAN_COMPLETED', 'A indexação local da biblioteca foi concluída.', scanDetails)
      }
      playerMediaProtocol = new PlayerMediaProtocol(videoLibrary)
      playerMediaProtocol.install(protocol)
      playerPlaybackService = new PlayerPlaybackService(videoLibrary, playerMediaProtocol, playerPlaybackRecovery)
      manualPlaybackService = new ManualPlaybackService(playerPlaybackService, {
        autoAdvanceOnNaturalEnd: operatingMode === 'player'
      })
      playerPlaybackRecovery.attach(playerPlaybackService, manualPlaybackService)
    }

    if (modeCapabilities!.controller) {
      uiScaleFilePath = path.join(userDataDirectory, 'ui-preferences.json')
      const uiPreferences = readPersistedUiPreferences(uiScaleFilePath)
      uiScalePreference = normalizeUiScalePreference(uiPreferences.scalePreference)
      sidebarDisplayName = normalizeStoredSidebarName(uiPreferences.sidebarDisplayName)

      let openedDatabase: ReturnType<typeof createKaraokeDatabase>
      try {
        openedDatabase = createKaraokeDatabase(userDataDirectory)
      } catch (error) {
        databaseInitializationFailed = true
        throw error
      }
      database = openedDatabase
      musicCatalogService = new MusicCatalogService(openedDatabase, videoLibrary)
      const catalogMetadata = musicCatalogService.getMetadata()
      logger.info('catalog', 'MUSIC_CATALOG_READY', 'O serviço local de catálogo foi inicializado.', {
        revision: catalogMetadata.revision,
        recordCount: catalogMetadata.recordCount
      })

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
    }

    if (modeCapabilities!.player && !modeCapabilities!.controller) {
      playerCatalogDatabase = createPlayerMusicCatalogDatabase(userDataDirectory)
      musicCatalogService = new MusicCatalogService(playerCatalogDatabase, videoLibrary)
      const catalogMetadata = musicCatalogService.getMetadata()
      logger.info('catalog', 'PLAYER_MUSIC_CATALOG_READY', 'O catálogo isolado do Reprodutor foi inicializado.', {
        revision: catalogMetadata.revision, recordCount: catalogMetadata.recordCount
      })
    }

    if (modeCapabilities!.player) {
      registerPlayerIpcHandlers()
      unsubscribePlayerUiEvents = playerPlaybackService!.subscribe(event => {
        const win = mainWindow
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send('player:playback-event', event)
        }
        if (event.type === 'state-changed' || event.type === 'progress') {
          playerVideoWindow?.publishDisplayStatus(playerDisplayStatus())
          publishPlayerSnapshot()
        }
      })
      unsubscribeManualUiEvents = manualPlaybackService!.subscribe(() => publishPlayerSnapshot())
    }

    if (operatingMode === 'player') {
      createPlayerControlWindow()
      playerVideoWindow = new PlayerVideoWindow({
        ipcMain,
        playback: playerPlaybackService!,
        getControlWindow: () => mainWindow ?? undefined,
        onChange: () => publishPlayerSnapshot()
      })
    }

    app.on('child-process-gone', (_event, details) => {
      logger.error('electron', 'CHILD_PROCESS_GONE', 'Um subprocesso do Electron terminou inesperadamente.', undefined, {
        type: details.type, reason: details.reason, exitCode: details.exitCode
      })
    })
    startupInitializationComplete = true
    logger.info('main', 'APP_READY', 'Aplicativo inicializado para o modo configurado.', {
      mode: operatingMode,
      controllerServicesInitialized: modeCapabilities!.controller,
      catalogServiceInitialized: musicCatalogService !== undefined,
      playerLibraryInitialized: videoLibrary !== undefined,
      playerServicesImplemented: playerPlaybackService !== undefined,
      manualPlaybackServiceInitialized: manualPlaybackService !== undefined,
      playerRecoveryStatus: playerPlaybackRecovery?.getState().status ?? 'none',
      operationalDatabaseInitialized: database !== undefined
    })
  } catch (error: unknown) {
    fatalMainFailure = true
    logger.fatal('main', 'APP_INITIALIZATION_FAILED', 'Falha crítica durante a inicialização.', error)
    if (databaseInitializationFailed) {
      logger.error('sqlite', 'SQLITE_INITIALIZATION_FAILED', 'Falha ao inicializar o banco SQLite.', error)
    }
    const detail = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox(databaseInitializationFailed ? 'Não foi possível abrir os dados do Karaoke Queue' : 'Não foi possível iniciar o Karaoke Queue',
      databaseInitializationFailed
        ? `O banco local não pôde ser inicializado. Seus dados antigos foram preservados.\n\n${detail}`
        : `A inicialização foi interrompida. Os dados operacionais foram preservados.\n\n${detail}`)
    app.quit()
  }
})

if (hasSingleInstanceLock) app.on('before-quit', (event) => {
  const shutdownRequest = playerPlaybackRecovery?.requestShutdown()
  if (shutdownRequest?.outcome === 'confirmation-required') {
    event.preventDefault()
    logger.warn('player', 'PLAYER_SHUTDOWN_CONFIRMATION_REQUIRED', 'O encerramento aguarda decisão explícita para interromper a reprodução ativa.', {
      attemptId: shutdownRequest.attemptId, playbackStatus: shutdownRequest.playbackStatus
    })
    const win = mainWindow
    if (operatingMode === 'player' && win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('player:shutdown-request', shutdownRequest)
    }
    return
  }
  shutdownStarted = true
  manualPlaybackService?.dispose()
  logger.info('main', 'APP_QUIT_SEQUENCE_STARTED', 'O Electron iniciou a sequência normal de saída.')
  if (playerPlaybackService && !playerShutdownComplete) {
    event.preventDefault()
    if (!playerShutdownStarted) {
      playerShutdownStarted = true
      void playerPlaybackService.dispose().then(() => {
        playerShutdownComplete = true
        playerPlaybackRecovery?.dispose()
        playerQuitAllowed = true
        playerVideoWindow?.allowWindowClose()
        app.quit()
      }, error => {
        fatalMainFailure = true
        logger.error('player', 'PLAYER_PLAYBACK_CLOSE_FAILED', 'Falha ao encerrar o serviço de reprodução.', error)
        playerShutdownComplete = true
        playerPlaybackRecovery?.dispose()
        playerQuitAllowed = true
        playerVideoWindow?.allowWindowClose()
        app.quit()
      })
    }
    return
  }
  if (musicCatalogService && !catalogShutdownComplete) {
    event.preventDefault()
    if (!catalogShutdownStarted) {
      catalogShutdownStarted = true
      void musicCatalogService.close().then(() => {
        catalogShutdownComplete = true
        app.quit()
      }, error => {
        fatalMainFailure = true
        logger.error('catalog', 'MUSIC_CATALOG_CLOSE_FAILED', 'Falha ao aguardar o encerramento seguro do catálogo.', error)
        catalogShutdownComplete = true
        app.quit()
      })
    }
  }
})
if (hasSingleInstanceLock) app.on('will-quit', () => {
  unsubscribePlayerUiEvents?.()
  unsubscribePlayerUiEvents = undefined
  unsubscribeManualUiEvents?.()
  unsubscribeManualUiEvents = undefined
  playerVideoWindow?.dispose()
  playerVideoWindow = undefined
  playerMediaProtocol?.dispose(protocol)
  videoLibrary?.close()
  try { playerCatalogDatabase?.close() } catch (error) {
    fatalMainFailure = true
    logger.error('catalog', 'PLAYER_CATALOG_CLOSE_FAILED', 'Falha ao fechar o armazenamento isolado do catálogo do Reprodutor.', error)
  }
  try { database?.close() } catch (error) {
    fatalMainFailure = true
    logger.error('sqlite', 'SQLITE_CLOSE_FAILED', 'Falha ao fechar a conexão SQLite.', error)
  }
  logger.finishRun(fatalMainFailure ? 'failed' : 'normal')
})

if (hasSingleInstanceLock) app.on('window-all-closed', () => {
  if (modeCapabilities && !modeCapabilities.controller && modeCapabilities.player) {
    app.quit()
    return
  }
  app.quit()
})
