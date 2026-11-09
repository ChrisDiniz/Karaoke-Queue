import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, protocol, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createKaraokeDatabase, createPlayerMusicCatalogDatabase } from './database'
import { KaraokeApplication } from './src/application'
import { createLegacyStateStorageBuffer, createStateRepository, PersistenceError } from './src/state-repository'
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
import { PlayerVideoWindow, type PlayerVideoBounds } from './src/player-video-window'
import { StandalonePlayerSequence } from './src/standalone-player-sequence'
import { installStandalonePlayerMainIpcBridge, type StandalonePlayerMainIpcBridge } from './src/standalone-player-ipc'
import { StandalonePlayerOptionsService } from './src/standalone-player-options'
import { registerMainPlayerIpcHandlers, registerMainStandaloneFullscreenHandler } from './src/main-player-ipc'
import { createMainIpcPolicy } from './src/main-ipc-policy'
import { registerMainControllerIpcHandlers, registerMainControllerWindowIpcHandlers } from './src/main-controller-ipc'
import {
  createManagementWindow as createManagementWindowSurface,
  createStandaloneWindow as createStandaloneWindowSurface,
  createWelcomeWindow as createWelcomeWindowSurface
} from './src/main-window-factories'
import { MainMediaRuntime } from './src/main-media-runtime'
import { MainStandaloneShutdownCoordinator } from './src/main-standalone-shutdown'
import { MainManagementCloseCoordinator } from './src/main-management-close'
import { MainManagementHost } from './src/main-management-host'
import { getPackagedInstallationContext, getPackagedInstalledRole } from './src/installed-role-context'
import { confirmInitialRoleThroughUac } from './src/installation-role-broker'
import { acquirePackagedInstallationState } from './src/installation-bootstrap'
import { beginInitialWelcomeSetup, completeInitialWelcomeSetup, requiresInitialWelcomeSetup, type WelcomeSetupSelection } from './src/welcome-setup'
import { registerManagementIpcHandlers } from './src/management-ipc'
import {
  getOperatingModeCapabilities,
  isOperatingMode,
  resolveOperatingMode,
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
import {
  applyWindowsFunctionApplicationId,
  applyWindowsFunctionWindowIdentity,
  getWindowsFunctionIdentity,
  getWindowsFunctionIdentityAssetPaths
} from './src/windows-function-identity'
import type { WindowsFunctionIdentity } from './src/windows-function-identity'

// main.ts requests the profile-scoped instance lock before the package-wide mutex;
// it loads this operational composition only when that lock was granted.
const hasSingleInstanceLock = true
registerPlayerMediaScheme(protocol)

let mainWindow: BrowserWindow | null = null
let welcomeWindow: BrowserWindow | null = null
let pendingWindowActivation = false
let operatingMode: OperatingMode | null = null
let modeCapabilities: OperatingModeCapabilities | null = null
let functionIdentity: WindowsFunctionIdentity | undefined
let functionIdentityAssetPaths: ReturnType<typeof getWindowsFunctionIdentityAssetPaths> | undefined
let startupInitializationComplete = false
let shutdownStarted = false
let playerQuitAllowed = false
let shutdownApprovedAttemptId: string | undefined
let libraryOperationInProgress = false
let playerOperationsInProgress = 0
let disposeControllerIpcHandlers: (() => void) | undefined
let disposeManagementIpcHandlers: (() => void) | undefined
let managementHost: MainManagementHost | undefined
let managementStartupLogged = false
let managementInitializationTask: Promise<unknown> | undefined
let managementQuitDrainRunning = false
let mainMediaRuntime: MainMediaRuntime | undefined
let mainCompositionReady = false
let appReadyLogged = false

const requirePlayerIpcSender = createMainIpcPolicy({
  getExpectedWebContents: () => mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined,
  getExpectedDocumentUrl: () => pathToFileURL(path.join(__dirname, 'src', 'index.html')).href,
  isEnabled: () => modeCapabilities?.player === true,
  forbiddenCode: 'PLAYER_IPC_FORBIDDEN'
})
const requireControllerIpcSender = createMainIpcPolicy({
  getExpectedWebContents: () => mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined,
  getExpectedDocumentUrl: () => pathToFileURL(path.join(__dirname, 'src', 'index.html')).href,
  isEnabled: () => modeCapabilities?.controller === true,
  forbiddenCode: 'CONTROLLER_IPC_FORBIDDEN'
})

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
  const win = createWelcomeWindowSurface({
    BrowserWindow, preloadPath: path.join(__dirname, 'welcome-preload.js'),
    ...(functionIdentity && functionIdentityAssetPaths
      ? { identity: functionIdentity, iconPath: functionIdentityAssetPaths.windowIconPath }
      : {})
  })
  if (operatingMode) applyFunctionWindowIdentity(win)
  welcomeWindow = win
  const expectedUrl = pathToFileURL(documentPath).href
  const assertWelcomeIpcSender = createMainIpcPolicy({
    getExpectedWebContents: () => welcomeWindow === win && !win.isDestroyed() ? win.webContents : undefined,
    getExpectedDocumentUrl: () => expectedUrl,
    isEnabled: () => welcomeWindow === win && !win.isDestroyed(),
    forbiddenCode: 'WELCOME_IPC_FORBIDDEN'
  })
  let onboardingRole: OperatingMode | null = getPackagedInstalledRole() ?? null
  let setupInProgress = false
  let modeConfirmationInProgress = false
  ipcMain.handle('welcome:get-state', event => {
    assertWelcomeIpcSender(event)
    const configuration = readVideoLibraryConfiguration(userDataDirectory)
    return {
      page: onboardingRole ? 'setup' : 'mode',
      role: onboardingRole,
      libraryRoot: configuration.roots[0] ?? null
    }
  })
  ipcMain.handle('welcome:choose-mode', async (event, mode: unknown) => {
    assertWelcomeIpcSender(event)
    if (!isOperatingMode(mode)) throw new Error('INVALID_OPERATING_MODE')
    if (modeConfirmationInProgress) throw new Error('GLOBAL_FUNCTION_CONFIRMATION_IN_PROGRESS')
    if (onboardingRole !== null) throw new Error('GLOBAL_FUNCTION_ALREADY_CONFIRMED')
    if (app.isPackaged) {
      const context = getPackagedInstallationContext()
      if (!context || context.role !== null) throw new Error('INSTALLATION_CONTEXT_UNAVAILABLE')
      modeConfirmationInProgress = true
      try {
        await confirmInitialRoleThroughUac(mode, { native: context.native, store: context.store,
          onConfirmed: () => beginInitialWelcomeSetup(userDataDirectory),
          releaseRuntimeGate: () => context.runtimeGate.release(),
          restoreRuntimeGate: () => {
            const restored = acquirePackagedInstallationState(context.native, context.store)
            if (restored.role !== null) {
              restored.runtimeGate.release()
              app.relaunch()
              app.quit()
              throw new Error('INSTALLATION_ROLE_CHANGED')
            }
            context.runtimeGate = restored.runtimeGate
          },
          relaunch: () => app.relaunch(), quit: () => app.quit(),
          quitForRecovery: () => { app.relaunch(); app.quit() } })
        return { page: 'setup', role: mode }
      } finally { modeConfirmationInProgress = false }
    }
    writeOperatingModeConfiguration(userDataDirectory, mode)
    beginInitialWelcomeSetup(userDataDirectory)
    onboardingRole = mode
    return { page: 'setup', role: mode }
  })
  ipcMain.handle('welcome:choose-library', async event => {
    assertWelcomeIpcSender(event)
    if (!onboardingRole || setupInProgress) throw new Error('WELCOME_SETUP_UNAVAILABLE')
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Selecionar pasta de vídeos', properties: ['openDirectory'] }
    const selection = owner && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || selection.filePaths.length !== 1) return { cancelled: true as const }
    return { cancelled: false as const, path: selection.filePaths[0] }
  })
  ipcMain.handle('welcome:choose-catalog', async event => {
    assertWelcomeIpcSender(event)
    if (!onboardingRole || setupInProgress) throw new Error('WELCOME_SETUP_UNAVAILABLE')
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Importar catálogo de músicas', properties: ['openFile'],
      filters: [{ name: 'Catálogo CSV', extensions: ['csv'] }] }
    const selection = owner && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || selection.filePaths.length !== 1) return { cancelled: true as const }
    return { cancelled: false as const, path: selection.filePaths[0] }
  })
  ipcMain.handle('welcome:complete-setup', async (event, rawSelection: unknown) => {
    assertWelcomeIpcSender(event)
    if (!onboardingRole || setupInProgress) throw new Error('WELCOME_SETUP_UNAVAILABLE')
    const selection = rawSelection as WelcomeSetupSelection
    setupInProgress = true
    try {
      if (app.isPackaged) {
        if (getPackagedInstalledRole() !== onboardingRole) throw new Error('WELCOME_ROLE_CHANGED')
      } else {
        const persisted = resolveOperatingMode(readOperatingModeConfiguration(userDataDirectory).mode)
        if (persisted !== onboardingRole) throw new Error('WELCOME_ROLE_CHANGED')
      }
      await completeInitialWelcomeSetup(userDataDirectory, onboardingRole, selection)
      app.relaunch()
      app.quit()
      return { completed: true as const }
    } finally { setupInProgress = false }
  })
  win.once('closed', () => {
    if (welcomeWindow === win) welcomeWindow = null
    for (const channel of ['welcome:get-state', 'welcome:choose-mode', 'welcome:choose-library',
      'welcome:choose-catalog', 'welcome:complete-setup']) ipcMain.removeHandler(channel)
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
let standaloneSequence: StandalonePlayerSequence | undefined
let standaloneIpcBridge: StandalonePlayerMainIpcBridge | undefined
let standaloneOptionsService: StandalonePlayerOptionsService | undefined
let unsubscribePlayerUiEvents: (() => void) | undefined
let unsubscribeManualUiEvents: (() => void) | undefined
let unsubscribeStandalonePlaybackDisplayEvents: (() => void) | undefined
let playerUiRevision = 0
let catalogShutdownStarted = false
let catalogShutdownComplete = false
let playerShutdownStarted = false
let playerShutdownComplete = false
let standaloneQuitAuthorized = false
let standaloneShutdownFailed = false
let standaloneShutdownTerminalFailure = false
let mainStandaloneShutdownCoordinator: MainStandaloneShutdownCoordinator | undefined
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

function prepareWindowsFunctionIdentity(mode: OperatingMode): void {
  functionIdentity = getWindowsFunctionIdentity(mode)
  const resourcesDirectory = app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, '..', 'build-resources')
  functionIdentityAssetPaths = getWindowsFunctionIdentityAssetPaths(resourcesDirectory, mode)
  for (const assetPath of [functionIdentityAssetPaths.windowIconPath, functionIdentityAssetPaths.taskbarIconPath]) {
    try {
      if (!fs.statSync(assetPath).isFile()) throw new Error('not-file')
    } catch {
      throw new Error('FUNCTION_IDENTITY_ASSET_UNAVAILABLE')
    }
  }
  applyWindowsFunctionApplicationId(app, process.platform, mode)
}

function applyFunctionWindowIdentity(win: BrowserWindow): void {
  if (!operatingMode || !functionIdentityAssetPaths) throw new Error('FUNCTION_IDENTITY_UNAVAILABLE')
  applyWindowsFunctionWindowIdentity(win, process.platform, operatingMode, functionIdentityAssetPaths)
}

function markMainAppReadyIfPossible(): void {
  if (!mainCompositionReady || (modeCapabilities?.controller && !managementHost?.isInitialized) || appReadyLogged) return
  startupInitializationComplete = true
  appReadyLogged = true
  logger.info('main', 'APP_READY', 'Aplicativo inicializado para o modo configurado.', {
    mode: operatingMode,
    controllerServicesInitialized: modeCapabilities?.controller === true,
    catalogServiceInitialized: musicCatalogService !== undefined,
    playerLibraryInitialized: videoLibrary !== undefined,
    playerServicesImplemented: playerPlaybackService !== undefined,
    manualPlaybackServiceInitialized: manualPlaybackService !== undefined,
    playerRecoveryStatus: playerPlaybackRecovery?.getState().status ?? 'none',
    operationalDatabaseInitialized: database !== undefined
  })
}

async function initializeManagementHost(legacyState?: import('./src/persistence-contracts').LegacyStateStorageDto) {
  if (!managementHost) throw new Error('MANAGEMENT_HOST_UNAVAILABLE')
  const initialization = managementHost.initialize(!licenseService?.isOperationallyAllowed(), legacyState)
  managementInitializationTask = initialization
  try {
    const snapshot = await initialization
    if (!managementStartupLogged && snapshot.didStartFreshSessionOnLoad) {
      managementStartupLogged = true
      reportSessionEvent('SESSION_STARTED', snapshot.state.currentSessionId,
        snapshot.didRecoverEndedSession ? 'after-previous-session-ended' : 'initial-session')
    }
    markMainAppReadyIfPossible()
    return snapshot
  } finally {
    if (managementInitializationTask === initialization) managementInitializationTask = undefined
  }
}

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
  throw new PersistenceError('rejected', 'LICENSE_EXPIRED')
}

function createWindow() {
  const initialSize = { width: 1280, height: 800 }
  const initialUiScale = createUiScaleState(
    uiScalePreference,
    getUiScaleFactor(initialSize.width, initialSize.height)
  )
  const documentPath = path.join(__dirname, 'src', 'index.html')
  const win = createManagementWindowSurface({
    BrowserWindow, preloadPath: path.join(__dirname, 'preload.js'),
    zoomFactor: initialUiScale.effectiveFactor,
    identity: functionIdentity!, iconPath: functionIdentityAssetPaths!.windowIconPath
  })
  applyFunctionWindowIdentity(win)
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

  const disposeWindowIpcHandlers = registerMainControllerWindowIpcHandlers({
    ipcMain,
    assertControllerIpcSender: requireControllerIpcSender,
    getUiScale: () => applyUiScale(),
    setUiScalePreference: (value: unknown) => {
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
    },
    getSidebarDisplayName: () => sidebarDisplayName,
    setSidebarDisplayName: (value: unknown) => {
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
    }
  })
  win.once('closed', disposeWindowIpcHandlers)

  if (pendingWindowActivation) activateMainWindow()
  win.loadFile(documentPath)

  const closeCoordinator = new MainManagementCloseCoordinator({
    getPort: () => {
      if (!managementHost) throw new Error('MANAGEMENT_HOST_UNAVAILABLE')
      return {
        prepareToClose: () => managementHost!.prepareToClose(),
        closeSummary: async () => managementHost!.closeSummary(),
        flushState: () => managementHost!.flush(),
        endSessionAndArchive: () => managementHost!.endSessionAndArchive(),
        cancelClose: async () => managementHost!.cancelClose()
      }
    },
    isWindowDestroyed: () => win.isDestroyed() || win.webContents.isDestroyed(),
    showMessageBox: options => dialog.showMessageBox(win, options),
    isStartupComplete: () => startupInitializationComplete,
    isLicenseOperationallyAllowed: () => Boolean(licenseService?.isOperationallyAllowed()),
    closeWindow: () => win.close(),
    logger
  })
  win.on('close', event => closeCoordinator.handleClose(event))
}

async function createStandalonePlayerWindow(): Promise<BrowserWindow> {
  const documentPath = path.join(__dirname, 'src', 'standalone-player.html')
  const win = createStandaloneWindowSurface({
    BrowserWindow, preloadPath: path.join(__dirname, 'standalone-player-preload.bundle.js'),
    identity: functionIdentity!, iconPath: functionIdentityAssetPaths!.windowIconPath
  })
  applyFunctionWindowIdentity(win)
  mainWindow = win
  win.on('close', event => {
    if (standaloneQuitAuthorized) return
    event.preventDefault()
    if (startupInitializationComplete) requestStandaloneExitConfirmation()
  })
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('renderer', 'STANDALONE_RENDERER_GONE', 'A interface Standalone terminou inesperadamente.', undefined, {
      reason: details.reason, exitCode: details.exitCode
    })
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error('renderer', 'STANDALONE_PRELOAD_FAILED', 'O contrato restrito do Player não pôde ser carregado.', error, {
      preloadPath: path.basename(preloadPath)
    })
  })
  const expectedDocumentUrl = pathToFileURL(documentPath).href
  if (!standaloneSequence || !standaloneOptionsService || !musicCatalogService || !playerVideoWindow) {
    throw new Error('STANDALONE_STARTUP_INCOMPLETE')
  }
  const playbackHostReady = playerVideoWindow.attachControlWindow(win, expectedDocumentUrl)
  standaloneIpcBridge = installStandalonePlayerMainIpcBridge({
    ipcMain,
    webContents: win.webContents,
    expectedDocumentUrl,
    control: standaloneSequence,
    metadataCatalog: musicCatalogService,
    options: standaloneOptionsService,
    videoSurface: {
      show: async bounds => {
        try {
          const result = await playerVideoWindow!.showInline(bounds, false)
          playerVideoWindow!.publishDisplayStatus(playerDisplayStatus())
          if (result.location !== 'inline') {
            logger.warn('player', 'STANDALONE_VIDEO_SURFACE_NOT_INLINE', 'A superfície Chromium não assumiu a área de playback Standalone.', {
              location: result.location
            })
          }
          return result.location === 'inline'
        } catch (error) {
          logger.error('player', 'STANDALONE_VIDEO_SURFACE_SHOW_FAILED', 'A superfície Chromium não pôde ser exibida no Player Standalone.', error)
          return false
        }
      },
      hide: () => playerVideoWindow?.setInlineVisible(false) ?? true
    }
  })
  standaloneIpcBridge.onExitAuthorized(() => { void beginStandaloneShutdown() })
  await win.loadFile(documentPath)
  await playbackHostReady
  return win
}

function requestStandaloneExitConfirmation(): void {
  const bridge = standaloneIpcBridge
  if (!bridge || standaloneQuitAuthorized) return
  if (standaloneShutdownTerminalFailure) {
    const options: Electron.MessageBoxOptions = {
      type: 'error', title: 'Encerramento não recuperável',
      message: 'O encerramento seguro falhou depois do início do descarte de recursos.',
      detail: 'O processo permanece aberto e não tentará descartar os mesmos recursos novamente. Mantenha o aplicativo aberto e trate esta falha antes de encerrar o Windows.',
      buttons: ['Voltar ao aplicativo'], defaultId: 0
    }
    const win = mainWindow
    void (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
      .catch(() => undefined)
    return
  }
  void bridge.requestExitConfirmationFromMain().then(confirmed => {
    if (confirmed) void beginStandaloneShutdown()
  }).catch(error => {
    logger.error('player', 'STANDALONE_EXIT_CONFIRMATION_FAILED', 'Não foi possível confirmar a saída do Reprodutor.', error)
    const win = mainWindow
    const detail = error instanceof Error ? error.message : String(error)
    const options: Electron.MessageBoxOptions = {
      type: 'error', title: 'Não foi possível confirmar a saída',
      message: 'O Reprodutor continuará aberto.', detail, buttons: ['Voltar ao Player'], defaultId: 0
    }
    void (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
      .catch(() => undefined)
  })
}

function beginStandaloneShutdown(): Promise<void> {
  if (!mainStandaloneShutdownCoordinator) return Promise.reject(new Error('STANDALONE_SHUTDOWN_UNAVAILABLE'))
  return mainStandaloneShutdownCoordinator.begin()
}

async function closeStandaloneAfterStartupFailure(): Promise<void> {
  try {
    standaloneIpcBridge?.dispose()
    if (mainMediaRuntime) await mainMediaRuntime.disposeAfterFailedStartup(() => standaloneOptionsService?.dispose())
    else if (standaloneSequence) await standaloneSequence.dispose()
    else {
      await playerPlaybackService?.dispose()
      playerPlaybackRecovery?.dispose()
      standaloneOptionsService?.dispose()
      await musicCatalogService?.close()
      videoLibrary?.close()
    }
    await playerVideoWindow?.dispose()
    standaloneQuitAuthorized = true
    playerQuitAllowed = true
    app.quit()
  } catch (error) {
    fatalMainFailure = true
    logger.fatal('player', 'STANDALONE_STARTUP_CLEANUP_FAILED',
      'O processo permaneceu aberto porque a limpeza após uma falha de inicialização não foi confirmada.', error)
  }
}

function synchronizeMainMediaRuntimeReferences(): void {
  if (!mainMediaRuntime) return
  videoLibrary ??= mainMediaRuntime.library
  playerMediaProtocol ??= mainMediaRuntime.mediaProtocol
  playerPlaybackRecovery ??= mainMediaRuntime.recovery
  playerPlaybackService ??= mainMediaRuntime.playback
  manualPlaybackService ??= mainMediaRuntime.manual
  musicCatalogService ??= mainMediaRuntime.catalog
  standaloneSequence ??= mainMediaRuntime.sequence
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
    videoWindow: playerVideoWindow?.getSnapshot() ?? {
      open: false, fullScreen: false, ready: false, location: 'hidden', inlineLayoutRevision: 0, returnToInlineRevision: 0
    }
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

function runPlayerOperation<T>(operation: () => Promise<T> | T): Promise<T> {
  assertPlayerNotChangingLibrary()
  playerOperationsInProgress++
  try {
    return Promise.resolve(operation()).finally(() => { playerOperationsInProgress-- })
  } catch (error) {
    playerOperationsInProgress--
    return Promise.reject(error)
  }
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

let disposePlayerIpcHandlers: (() => void) | undefined
let disposeStandaloneFullscreenHandler: (() => void) | undefined


if (hasSingleInstanceLock) app.whenReady().then(async () => {
  try {
    const packagedRole = getPackagedInstalledRole()
    if (app.isPackaged && packagedRole === null) {
      createWelcomeWindow()
      return
    }
    if (app.isPackaged) {
      if (packagedRole !== 'player' && packagedRole !== 'combined') throw new Error('GLOBAL_FUNCTION_UNAVAILABLE')
      operatingMode = packagedRole
      modeCapabilities = getOperatingModeCapabilities(operatingMode)
      prepareWindowsFunctionIdentity(operatingMode)
      if (requiresInitialWelcomeSetup(userDataDirectory)) {
        createWelcomeWindow()
        return
      }
    } else {
      if (requiresFirstLaunchModeSelection(userDataDirectory)) {
        createWelcomeWindow()
        return
      }
      if (requiresInitialWelcomeSetup(userDataDirectory)) {
        createWelcomeWindow()
        return
      }
      const configuration = readOperatingModeConfiguration(userDataDirectory)
      operatingMode = resolveOperatingMode(configuration.mode)
      modeCapabilities = getOperatingModeCapabilities(operatingMode)
      prepareWindowsFunctionIdentity(operatingMode)
    }
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
      `${detail}\n\nO estado operacional foi preservado. Corrija operating-mode.json para iniciar no modo Tudo em um.`
    )
    app.quit()
    return
  }

  let databaseInitializationFailed = false
  try {
    licenseService = new LocalLicenseService(path.join(userDataDirectory, 'license-state.json'))

    mainMediaRuntime = new MainMediaRuntime({
      operatingMode: operatingMode!, userDataDirectory, protocol, logger,
      isShutdownStarted: () => shutdownStarted
    })
    if (modeCapabilities!.player) {
      const inventory = await mainMediaRuntime.initializePlayerInfrastructure()
      if (shutdownStarted) {
        await mainMediaRuntime.disposeAfterFailedStartup(() => undefined)
        return
      }
      if (!inventory) throw new Error('PLAYER_MEDIA_RUNTIME_UNAVAILABLE')
      videoLibrary = mainMediaRuntime.library
      playerMediaProtocol = mainMediaRuntime.mediaProtocol
      playerPlaybackRecovery = mainMediaRuntime.recovery
      playerPlaybackService = mainMediaRuntime.playback
      manualPlaybackService = mainMediaRuntime.manual
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
      musicCatalogService = mainMediaRuntime.createCatalog(openedDatabase)

      const legacyStorage = createLegacyStateStorageBuffer()
      const managementRepository = createStateRepository({
        async load() { return openedDatabase.loadState() },
        async save(state) {
          requireLicenseForOperationalWrite(openedDatabase.loadState(), state)
          openedDatabase.saveState(state)
          return true
        }
      }, legacyStorage.storage)
      managementHost = new MainManagementHost(new KaraokeApplication(managementRepository), {
        installLegacyStorage: values => legacyStorage.replace(values)
      })
      const existingManagementState = openedDatabase.loadState()
      if (Object.keys(existingManagementState).length > 0) await initializeManagementHost()

      disposeManagementIpcHandlers = registerManagementIpcHandlers({
        ipcMain,
        host: managementHost,
        logger,
        assertSender: requireControllerIpcSender,
        initializeHost: legacyState => initializeManagementHost(legacyState),
        sendState: snapshot => {
          const win = mainWindow
          if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('management:state-changed', snapshot)
          }
        }
      })

      disposeControllerIpcHandlers = registerMainControllerIpcHandlers({
        ipcMain,
        getLicenseService: () => licenseService,
        logger,
        openLogs: () => shell.openPath(logger.logsDirectory),
        assertControllerIpcSender: requireControllerIpcSender,
        reportSessionEvent
      })
      createWindow()
    }

    if (modeCapabilities!.player && !modeCapabilities!.controller) {
      playerCatalogDatabase = createPlayerMusicCatalogDatabase(userDataDirectory)
      musicCatalogService = mainMediaRuntime!.createCatalog(playerCatalogDatabase)
    }

    if (modeCapabilities!.player && operatingMode !== 'player') {
      disposePlayerIpcHandlers = registerMainPlayerIpcHandlers({
        ipcMain, app, BrowserWindow, clipboard, dialog, logger, appRoot: __dirname, userDataDirectory,
        getOperatingMode: () => operatingMode,
        getModeCapabilities: () => modeCapabilities,
        getMainWindow: () => mainWindow,
        getPlayerVideoWindow: () => playerVideoWindow,
        getMusicCatalogService: () => musicCatalogService,
        getLibraryOperationInProgress: () => libraryOperationInProgress,
        setLibraryOperationInProgress: value => { libraryOperationInProgress = value },
        getPlayerOperationsInProgress: () => playerOperationsInProgress,
        getShutdownApprovedAttemptId: () => shutdownApprovedAttemptId,
        setPlayerQuitAllowed: value => { playerQuitAllowed = value },
        assertLibraryCanChange,
        setShutdownApprovedAttemptId: value => { shutdownApprovedAttemptId = value },
        requirePlayerIpcSender, requirePlayerServices, requirePlayerSequenceMode,
        assertPlayerNotChangingLibrary, runPlayerOperation, getPlayerUiSnapshot,
        publishPlayerSnapshot, showPlayerVideoWindow
      })
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
      if (!videoLibrary || !playerMediaProtocol || !playerPlaybackRecovery || !musicCatalogService) {
        throw new Error('STANDALONE_STARTUP_DEPENDENCY_UNAVAILABLE')
      }
      standaloneSequence = await mainMediaRuntime!.createStandaloneSequence(() => standaloneOptionsService?.dispose())
      playerPlaybackService = mainMediaRuntime!.playback
      const recoveryState = playerPlaybackRecovery.getState()
      if (recoveryState.status === 'pending') {
        logger.warn('player', 'PLAYER_RECOVERY_PENDING', 'Uma reprodução anterior não tem término confirmado; nenhuma mídia será iniciada automaticamente.', {
          attemptId: recoveryState.attemptId, musicCode: recoveryState.musicCode,
          lastTransition: recoveryState.lastTransition
        })
      } else if (recoveryState.status === 'unreadable' || recoveryState.status === 'unavailable') {
        logger.error('player', 'PLAYER_RECOVERY_UNAVAILABLE', 'O Player bloqueará novos comandos de mídia porque o estado de recuperação não pôde ser validado.', {
          reason: recoveryState.status === 'unreadable' ? recoveryState.reason : recoveryState.reason
        })
      }
      playerVideoWindow = new PlayerVideoWindow({
        ipcMain,
        playback: playerPlaybackService!,
        getControlWindow: () => mainWindow ?? undefined,
        windowIdentity: functionIdentity!,
        iconPaths: functionIdentityAssetPaths!,
        onChange: () => undefined
      })
      disposeStandaloneFullscreenHandler = registerMainStandaloneFullscreenHandler({
        ipcMain, appRoot: __dirname,
        getOperatingMode: () => operatingMode,
        getPlayerVideoWindow: () => playerVideoWindow
      })
      unsubscribeStandalonePlaybackDisplayEvents = playerPlaybackService!.subscribe(event => {
        if (event.type === 'state-changed') {
          playerVideoWindow?.publishDisplayStatus(playerDisplayStatus())
        }
      })
      standaloneOptionsService = new StandalonePlayerOptionsService({
        library: videoLibrary,
        catalog: musicCatalogService,
        userDataDirectory,
        dialogs: {
          chooseVideoFolder: async () => {
            const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
            const options: Electron.OpenDialogOptions = {
              title: 'Selecionar pasta de vídeos', properties: ['openDirectory']
            }
            const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
            return !selection.canceled && selection.filePaths.length === 1 ? selection.filePaths[0]! : null
          },
          chooseCatalogFile: async () => {
            const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
            const options: Electron.OpenDialogOptions = {
              title: 'Importar catálogo de músicas', properties: ['openFile'],
              filters: [{ name: 'Catálogo CSV', extensions: ['csv'] }]
            }
            const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
            return !selection.canceled && selection.filePaths.length === 1 ? selection.filePaths[0]! : null
          }
        }
      })
      mainStandaloneShutdownCoordinator = new MainStandaloneShutdownCoordinator({
        getBridge: () => standaloneIpcBridge,
        getSequence: () => standaloneSequence,
        getRecovery: () => playerPlaybackRecovery,
        getPlayback: () => playerPlaybackService,
        getVideoWindow: () => playerVideoWindow,
        logger,
        quit: () => app.quit(),
        setQuitAuthorized: value => { standaloneQuitAuthorized = value },
        setPlayerQuitAllowed: value => { playerQuitAllowed = value },
        setShutdownFailed: value => { standaloneShutdownFailed = value },
        setTerminalFailure: value => { standaloneShutdownTerminalFailure = value },
        showShutdownFailure: options => {
          const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
          return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)
        }
      })
      await createStandalonePlayerWindow()
    }

    app.on('child-process-gone', (_event, details) => {
      logger.error('electron', 'CHILD_PROCESS_GONE', 'Um subprocesso do Electron terminou inesperadamente.', undefined, {
        type: details.type, reason: details.reason, exitCode: details.exitCode
      })
    })
    mainCompositionReady = true
    markMainAppReadyIfPossible()
  } catch (error: unknown) {
    synchronizeMainMediaRuntimeReferences()
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
    if (operatingMode === 'player') void closeStandaloneAfterStartupFailure()
    else app.quit()
  }
})

if (hasSingleInstanceLock) app.on('before-quit', (event) => {
  if (modeCapabilities?.controller && managementInitializationTask) {
    event.preventDefault()
    if (!managementQuitDrainRunning) {
      managementQuitDrainRunning = true
      void managementInitializationTask.catch(() => undefined).finally(() => {
        managementQuitDrainRunning = false
        app.quit()
      })
    }
    return
  }
  if (operatingMode === 'player') {
    if (standaloneQuitAuthorized) {
      shutdownStarted = true
      logger.info('player', 'STANDALONE_QUIT_AUTHORIZED', 'O Electron recebeu a saída após a coordenação Standalone.')
      return
    }
    event.preventDefault()
    if (startupInitializationComplete && standaloneIpcBridge && standaloneSequence) {
      requestStandaloneExitConfirmation()
    } else if (standaloneSequence || playerPlaybackService || playerVideoWindow) {
      void closeStandaloneAfterStartupFailure()
    } else {
      // No media or Standalone resources were created; the failed startup can close directly.
      standaloneQuitAuthorized = true
      app.quit()
    }
    return
  }
  const shutdownRequest = playerPlaybackRecovery?.requestShutdown()
  if (shutdownRequest?.outcome === 'confirmation-required') {
    event.preventDefault()
    logger.warn('player', 'PLAYER_SHUTDOWN_CONFIRMATION_REQUIRED', 'O encerramento aguarda decisão explícita para interromper a reprodução ativa.', {
      attemptId: shutdownRequest.attemptId, playbackStatus: shutdownRequest.playbackStatus
    })
    const win = mainWindow
    if (modeCapabilities?.player && win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
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
  disposeManagementIpcHandlers?.()
  disposeManagementIpcHandlers = undefined
  disposeControllerIpcHandlers?.()
  disposeControllerIpcHandlers = undefined
  disposePlayerIpcHandlers?.()
  disposePlayerIpcHandlers = undefined
  disposeStandaloneFullscreenHandler?.()
  disposeStandaloneFullscreenHandler = undefined
  standaloneIpcBridge?.dispose()
  standaloneIpcBridge = undefined
  standaloneOptionsService?.dispose()
  standaloneOptionsService = undefined
  unsubscribePlayerUiEvents?.()
  unsubscribePlayerUiEvents = undefined
  unsubscribeManualUiEvents?.()
  unsubscribeManualUiEvents = undefined
  unsubscribeStandalonePlaybackDisplayEvents?.()
  unsubscribeStandalonePlaybackDisplayEvents = undefined
  playerVideoWindow?.dispose()
  playerVideoWindow = undefined
  playerMediaProtocol?.dispose(protocol);
  (videoLibrary ?? mainMediaRuntime?.library)?.close()
  try { playerCatalogDatabase?.close() } catch (error) {
    fatalMainFailure = true
    logger.error('catalog', 'PLAYER_CATALOG_CLOSE_FAILED', 'Falha ao fechar o armazenamento isolado do catálogo do Reprodutor.', error)
  }
  try { database?.close() } catch (error) {
    fatalMainFailure = true
    logger.error('sqlite', 'SQLITE_CLOSE_FAILED', 'Falha ao fechar a conexão SQLite.', error)
  }
  try {
    getPackagedInstallationContext()?.runtimeGate?.release()
  } catch (error) {
    fatalMainFailure = true
    logger.error('installation', 'RUNTIME_GATE_RELEASE_FAILED', 'A exclusividade global será mantida até o processo terminar.', error)
  }
  logger.finishRun(fatalMainFailure || standaloneShutdownFailed ? 'failed' : 'normal')
})

if (hasSingleInstanceLock) app.on('window-all-closed', () => {
  if (modeCapabilities && !modeCapabilities.controller && modeCapabilities.player) {
    app.quit()
    return
  }
  app.quit()
})
