import { BrowserWindow } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeCatalogCodeForVideoMatch } from './music-catalog'
import { writeVideoLibraryConfiguration } from './video-library-configuration'
import type { OperatingMode, OperatingModeCapabilities } from './operating-mode'
import type { FileLogger } from './logging'
import type { ManualPlaybackService } from './manual-playback-service'
import type { PlayerPlaybackService } from './player-playback-service'
import type { PlayerPlaybackRecoveryCoordinator } from './player-playback-recovery'
import type { PlayerUiSnapshot } from './player-ui-contracts'
import type { PlayerVideoWindow, PlayerVideoBounds } from './player-video-window'
import type { MusicCatalogService } from './music-catalog-service'
import type { VideoLibraryService } from './video-library-service'

export interface MainPlayerIpcDependencies {
  ipcMain: Electron.IpcMain
  app: Pick<typeof import('electron').app, 'quit' | 'relaunch'>
  BrowserWindow: Pick<typeof BrowserWindow, 'fromWebContents'>
  clipboard: Pick<typeof import('electron').clipboard, 'writeText'>
  dialog: Pick<typeof import('electron').dialog, 'showOpenDialog'>
  logger: Pick<FileLogger, 'info' | 'warn' | 'error'>
  appRoot: string
  userDataDirectory: string
  getOperatingMode(): OperatingMode | null
  getModeCapabilities(): OperatingModeCapabilities | null
  getMainWindow(): BrowserWindow | null
  getPlayerVideoWindow(): PlayerVideoWindow | undefined
  getMusicCatalogService(): MusicCatalogService | undefined
  getLibraryOperationInProgress(): boolean
  setLibraryOperationInProgress(value: boolean): void
  getPlayerOperationsInProgress(): number
  getShutdownApprovedAttemptId(): string | undefined
  setPlayerQuitAllowed(value: boolean): void
  assertLibraryCanChange(): void
  setShutdownApprovedAttemptId(value: string): void
  requirePlayerIpcSender(event: Electron.IpcMainInvokeEvent): void
  requirePlayerServices(): { playback: PlayerPlaybackService; manual: ManualPlaybackService; library: VideoLibraryService; recovery: PlayerPlaybackRecoveryCoordinator }
  requirePlayerSequenceMode(): void
  assertPlayerNotChangingLibrary(): void
  runPlayerOperation<T>(operation: () => Promise<T> | T): Promise<T>
  getPlayerUiSnapshot(): PlayerUiSnapshot
  publishPlayerSnapshot(): void
  showPlayerVideoWindow(): Promise<unknown>
}

export interface MainStandaloneFullscreenIpcDependencies {
  ipcMain: Electron.IpcMain
  appRoot: string
  getOperatingMode(): OperatingMode | null
  getPlayerVideoWindow(): PlayerVideoWindow | undefined
}

function createHandlerRegistrar(ipc: Electron.IpcMain): {
  register(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any): void
  dispose(): void
} {
  const channels: string[] = []
  const dispose = (): void => {
    for (const channel of channels.splice(0).reverse()) ipc.removeHandler(channel)
  }
  return {
    register(channel, listener) {
      try {
        ipc.handle(channel, listener)
        channels.push(channel)
      } catch (error) {
        dispose()
        throw error
      }
    },
    dispose
  }
}

export function registerMainPlayerIpcHandlers(deps: MainPlayerIpcDependencies): () => void {
  const registrar = createHandlerRegistrar(deps.ipcMain)
  const registerHandler = registrar.register.bind(registrar)
  const { app, BrowserWindow, clipboard, dialog, logger, userDataDirectory } = deps

  registerHandler('player:get-snapshot', event => {
    deps.requirePlayerIpcSender(event)
    return deps.getPlayerUiSnapshot()
  })
  registerHandler('player:lookup-code', async (event, code: unknown) => {
    deps.requirePlayerIpcSender(event)
    const { library } = deps.requirePlayerServices()
    const catalog = deps.getMusicCatalogService()
    if (catalog) {
      const item = await catalog.lookupByVideoCode(code)
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
  registerHandler('player:play-now', async (event, code: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (deps.getOperatingMode() !== 'player') throw new Error('MANUAL_CODE_PLAY_UNAVAILABLE_IN_COMBINED_MODE')
    return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.playByMusicCode(code))
  })
  registerHandler('player:sequence:add', async (event, code: unknown) => {
    deps.requirePlayerIpcSender(event); deps.requirePlayerSequenceMode()
    return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.addToSequence(code))
  })
  registerHandler('player:sequence:add-batch', async (event, rawText: unknown, requestId: unknown) => {
    deps.requirePlayerIpcSender(event); deps.requirePlayerSequenceMode(); deps.assertPlayerNotChangingLibrary()
    if (typeof rawText !== 'string' || rawText.length > 4096 || typeof requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new Error('INVALID_BATCH_INPUT')
    return deps.runPlayerOperation(async () => {
      const services = deps.requirePlayerServices()
      const recovery = services.recovery.getState()
      if (recovery.status === 'pending') throw new Error('RECOVERY_PENDING')
      if (recovery.status === 'unreadable' || recovery.status === 'unavailable') throw new Error('RECOVERY_UNAVAILABLE')
      const playbackWindow = deps.getPlayerVideoWindow()
      if (!playbackWindow) throw new Error('HOST_UNAVAILABLE')
      await playbackWindow.preparePlaybackHost()
      deps.assertPlayerNotChangingLibrary()
      return services.manual.addBatchToSequence(rawText, requestId)
    })
  })
  registerHandler('player:sequence:remove', (event, itemId: unknown) => {
    deps.requirePlayerIpcSender(event); deps.requirePlayerSequenceMode()
    return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.removeFromSequence(itemId))
  })
  registerHandler('player:sequence:remove-current', (event, itemId: unknown, attemptId: unknown) => {
    deps.requirePlayerIpcSender(event); deps.requirePlayerSequenceMode()
    return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.removeCurrent(itemId, attemptId))
  })
  registerHandler('player:sequence:reorder', (event, itemIds: unknown) => {
    deps.requirePlayerIpcSender(event); deps.requirePlayerSequenceMode()
    return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.reorderSequence(Array.isArray(itemIds) ? itemIds : []))
  })
  registerHandler('player:sequence:clear', event => {
    deps.requirePlayerIpcSender(event); deps.requirePlayerSequenceMode()
    return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.clearSequence())
  })
  registerHandler('player:pause', event => { deps.requirePlayerIpcSender(event); return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.pause()) })
  registerHandler('player:resume', event => { deps.requirePlayerIpcSender(event); return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.resume()) })
  registerHandler('player:restart', event => { deps.requirePlayerIpcSender(event); return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.restart()) })
  registerHandler('player:stop', event => { deps.requirePlayerIpcSender(event); return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.stop()) })
  registerHandler('player:next', event => { deps.requirePlayerIpcSender(event); deps.requirePlayerSequenceMode(); return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.next()) })
  registerHandler('player:previous', event => { deps.requirePlayerIpcSender(event); deps.requirePlayerSequenceMode(); return deps.runPlayerOperation(() => deps.requirePlayerServices().manual.previous()) })
  registerHandler('player:catalog:import', async event => {
    deps.requirePlayerIpcSender(event)
    return deps.runPlayerOperation(async () => {
      const catalog = deps.getMusicCatalogService()
      if (!catalog) throw new Error('PLAYER_CATALOG_UNAVAILABLE')
      const options: Electron.OpenDialogOptions = { title: 'Importar catálogo de músicas', properties: ['openFile'],
        filters: [{ name: 'Catálogo CSV', extensions: ['csv'] }] }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const selection = owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      if (selection.canceled || selection.filePaths.length !== 1) return { cancelled: true as const }
      const result = await catalog.importFile(selection.filePaths[0])
      deps.publishPlayerSnapshot()
      return result
    })
  })
  registerHandler('player:library:select-folder', async event => {
    deps.requirePlayerIpcSender(event)
    deps.assertPlayerNotChangingLibrary()
    const { library } = deps.requirePlayerServices()
    if (deps.getLibraryOperationInProgress()) throw new Error('VIDEO_LIBRARY_BUSY')
    deps.assertLibraryCanChange()
    deps.setLibraryOperationInProgress(true)
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
      deps.publishPlayerSnapshot()
      await scan
      logger.info('player', 'VIDEO_LIBRARY_ROOT_CHANGED', 'A pasta da biblioteca local foi atualizada.', {
        configuredRootCount: 1, indexedFiles: library.getSnapshot().counts.indexedFiles
      })
      return deps.getPlayerUiSnapshot()
    } finally {
      deps.setLibraryOperationInProgress(false)
      deps.publishPlayerSnapshot()
    }
  })
  registerHandler('player:library:refresh', async event => {
    deps.requirePlayerIpcSender(event)
    deps.assertPlayerNotChangingLibrary()
    const { library } = deps.requirePlayerServices()
    if (deps.getLibraryOperationInProgress()) throw new Error('VIDEO_LIBRARY_BUSY')
    deps.assertLibraryCanChange()
    deps.setLibraryOperationInProgress(true)
    try {
      const scan = library.refresh()
      deps.publishPlayerSnapshot()
      await scan
      return deps.getPlayerUiSnapshot()
    } finally { deps.setLibraryOperationInProgress(false); deps.publishPlayerSnapshot() }
  })
  registerHandler('player:video:show', async event => { deps.requirePlayerIpcSender(event); return deps.showPlayerVideoWindow() })
  registerHandler('player:video:window-tip', (event, visible: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (typeof visible !== 'boolean') throw new Error('INVALID_PLAYER_WINDOW_TIP_STATE')
    return deps.getPlayerVideoWindow()?.setWindowTipVisible(visible) ?? false
  })
  registerHandler('player-video:window-tip-dismissed', (event, permanentlyDismissed: unknown) => {
    const videoWindow = deps.getPlayerVideoWindow()
    const senderFrame = event.senderFrame
    const playbackDocumentName = deps.getOperatingMode() === 'player' ? 'standalone-player.html' : 'player-playback.html'
    const expectedDocumentUrl = pathToFileURL(path.join(deps.appRoot, 'src', playbackDocumentName)).href
    if (typeof permanentlyDismissed !== 'boolean' || !senderFrame || senderFrame !== event.sender.mainFrame ||
        senderFrame.url !== expectedDocumentUrl || !videoWindow?.dismissWindowTip(event.sender)) {
      throw new Error('PLAYER_IPC_FORBIDDEN')
    }
    const ownerWindow = deps.getMainWindow()
    if (ownerWindow && !ownerWindow.isDestroyed() && !ownerWindow.webContents.isDestroyed()) {
      ownerWindow.webContents.send('player:window-tip-dismissed', { permanentlyDismissed })
    }
    return true
  })
  registerHandler('player:video:inline', async (event, bounds: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (!bounds || typeof bounds !== 'object') throw new Error('INVALID_PLAYER_VIEW_BOUNDS')
    return deps.getPlayerVideoWindow()!.showInline(bounds as PlayerVideoBounds)
  })
  registerHandler('player:video:inline-bounds', async (event, bounds: unknown, layoutRevision: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (!bounds || typeof bounds !== 'object') throw new Error('INVALID_PLAYER_VIEW_BOUNDS')
    if (typeof layoutRevision !== 'number' || !Number.isSafeInteger(layoutRevision) || layoutRevision < 0) {
      throw new Error('INVALID_PLAYER_LAYOUT_REVISION')
    }
    return deps.getPlayerVideoWindow()?.setInlineBounds(bounds as PlayerVideoBounds, layoutRevision) ?? false
  })
  registerHandler('player:video:inline-visibility', (event, visible: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (typeof visible !== 'boolean') throw new Error('INVALID_PLAYER_VIDEO_VISIBILITY')
    return deps.getPlayerVideoWindow()?.setInlineVisible(visible) ?? false
  })
  registerHandler('player:video:inline-hide', event => {
    deps.requirePlayerIpcSender(event)
    if (!deps.getPlayerVideoWindow()?.hideInline()) throw new Error('PLAYER_ACTIVE_INLINE')
    deps.publishPlayerSnapshot()
    return deps.getPlayerVideoWindow()?.getSnapshot()
  })
  registerHandler('player-video:set-fullscreen', (event, action: unknown) => {
    if (!deps.getPlayerVideoWindow()) return false
    const videoWindow = deps.getPlayerVideoWindow()
    if (!videoWindow) return false
    const senderFrame = event.senderFrame
    const playbackDocumentName = deps.getOperatingMode() === 'player' ? 'standalone-player.html' : 'player-playback.html'
    const expectedDocumentUrl = pathToFileURL(path.join(deps.appRoot, 'src', playbackDocumentName)).href
    if (!senderFrame || senderFrame !== event.sender.mainFrame || senderFrame.url !== expectedDocumentUrl) {
      throw new Error('PLAYER_IPC_FORBIDDEN')
    }
    return videoWindow.setFullScreen(event.sender, action)
  })
  registerHandler('player:video:fullscreen-toggle', event => {
    deps.requirePlayerIpcSender(event)
    return deps.getPlayerVideoWindow()?.toggleFullScreenFromControl() ?? false
  })
  registerHandler('player:video:fullscreen-exit', event => {
    deps.requirePlayerIpcSender(event)
    return deps.getPlayerVideoWindow()?.exitFullScreenFromControl() ?? false
  })
  registerHandler('player:recovery:replay', async (event, attemptId: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_RECOVERY_ATTEMPT')
    deps.assertPlayerNotChangingLibrary()
    return deps.requirePlayerServices().recovery.replayPrevious(attemptId)
  })
  registerHandler('player:recovery:choose-another', async (event, attemptId: unknown, code: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_RECOVERY_ATTEMPT')
    deps.assertPlayerNotChangingLibrary()
    return deps.requirePlayerServices().recovery.chooseAnother(attemptId, code)
  })
  registerHandler('player:recovery:leave-stopped', async (event, attemptId: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_RECOVERY_ATTEMPT')
    return deps.requirePlayerServices().recovery.leaveStopped(attemptId)
  })
  registerHandler('player:recovery:resolve-invalid', event => {
    deps.requirePlayerIpcSender(event)
    return deps.requirePlayerServices().recovery.resolveInvalidRecovery()
  })
  registerHandler('player:recovery:copy-diagnostic', event => {
    deps.requirePlayerIpcSender(event)
    const summary = deps.requirePlayerServices().recovery.getDiagnosticSummary()
    if (!summary) return { copied: false }
    const safeText = `${summary.code}: ${summary.message}`.slice(0, 1000)
    clipboard.writeText(safeText)
    return { copied: true }
  })
  registerHandler('player:shutdown:cancel', (event, attemptId: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_SHUTDOWN_ATTEMPT')
    const result = deps.requirePlayerServices().recovery.cancelShutdown(attemptId)
    deps.publishPlayerSnapshot()
    return result
  })
  registerHandler('player:shutdown:confirm', async (event, attemptId: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string') throw new Error('INVALID_SHUTDOWN_ATTEMPT')
    const result = await deps.requirePlayerServices().recovery.confirmShutdown(attemptId)
    deps.setShutdownApprovedAttemptId(attemptId)
    deps.publishPlayerSnapshot()
    return result
  })
  registerHandler('player:shutdown:finish', (event, attemptId: unknown) => {
    deps.requirePlayerIpcSender(event)
    if (typeof attemptId !== 'string' || deps.getShutdownApprovedAttemptId() !== attemptId) throw new Error('SHUTDOWN_NOT_CONFIRMED')
    deps.setPlayerQuitAllowed(true)
    deps.getPlayerVideoWindow()?.allowWindowClose()
    app.quit()
  })
  return () => registrar.dispose()
}

export function registerMainStandaloneFullscreenHandler(deps: MainStandaloneFullscreenIpcDependencies): () => void {
  const registrar = createHandlerRegistrar(deps.ipcMain)
  registrar.register('player-video:set-fullscreen', (event, action: unknown) => {
    const senderFrame = event.senderFrame
    const expectedDocumentUrl = pathToFileURL(path.join(deps.appRoot, 'src', 'standalone-player.html')).href
    const videoWindow = deps.getPlayerVideoWindow()
    if (deps.getOperatingMode() !== 'player' || !videoWindow || !senderFrame ||
        senderFrame !== event.sender.mainFrame || senderFrame.url !== expectedDocumentUrl) {
      throw new Error('PLAYER_IPC_FORBIDDEN')
    }
    return videoWindow.setFullScreen(event.sender, action)
  })
  return () => registrar.dispose()
}
