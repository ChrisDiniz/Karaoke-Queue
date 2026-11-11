import type { IpcMainInvokeEvent } from 'electron'
import { STANDALONE_CELEBRATION_MESSAGES } from './standalone-player-contracts'
import type {
  StandalonePlayerCommandResult,
  StandalonePlayerControl,
  StandalonePlayerSnapshot,
  StandaloneStableState
} from './standalone-player-contracts'
import {
  STANDALONE_PLAYER_IPC_CHANNELS,
  type StandalonePlayerIpcCommandReply,
  type StandaloneCurrentTrackMetadata,
  type StandalonePlayerMetadataPreview,
  type StandalonePlayerMainIpcBridgeOptions,
  type StandalonePlayerOptionsActionReply,
  type StandalonePlayerOptionsData,
  type StandalonePlayerOptionsSnapshot,
  type StandaloneCatalogImportPreparation,
  type StandaloneCatalogImportIssuesPage,
  type StandalonePlayerSnapshotEnvelope,
  type StandalonePlayerSnapshotUpdate,
  type StandalonePlayerSubscriptionRef,
  type StandalonePlayerVideoBounds
} from './standalone-player-ipc-contracts'
import { validateStandalonePlayerCommandRequest } from './standalone-player-runtime'
import { isStandalonePlayerLibraryChangeAllowed } from './standalone-player-options'
import { StandaloneExitConfirmationCoordinator } from './standalone-player-exit-confirmation'

interface SubscriptionRecord {
  readonly generation: number
}

const MAX_SUBSCRIPTIONS_PER_RENDERER = 8
const EXIT_CHANNELS = new Set<string>([
  STANDALONE_PLAYER_IPC_CHANNELS.requestExitConfirmation,
  STANDALONE_PLAYER_IPC_CHANNELS.resolveExitConfirmation
])

/** Main-side transport only. It never owns or disposes the runtime/playback composition. */
export class StandalonePlayerMainIpcBridge {
  private readonly subscriptions = new Map<string, SubscriptionRecord>()
  private readonly exitAuthorizationListeners = new Set<() => void>()
  private readonly registeredChannels = new Set<string>()
  private readonly exitConfirmation = new StandaloneExitConfirmationCoordinator()
  private unsubscribeControl: () => void = () => undefined
  private unsubscribeCatalogRevision: () => void = () => undefined
  private unsubscribeOptions: () => void = () => undefined
  private currentEnvelope: StandalonePlayerSnapshotEnvelope
  private nextGeneration = 0
  private optionsRevision = 0
  private activeCommandCount = 0
  private libraryOperationInProgress = false
  private catalogOperationInProgress = false
  private acceptingRequests = true
  private activeRequestCount = 0
  private readonly requestDrainWaiters = new Set<() => void>()
  private pendingCatalogConfirmationToken: string | undefined
  private disposed = false

  private readonly onMainFrameNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      this.discardPendingCatalogConfirmation()
      this.clearSubscriptions()
      this.exitConfirmation.rendererUnavailable(() => this.showNativeExitFallback(), () => this.publishExitAuthorization())
    }
  }

  private readonly onRendererGone = (): void => {
    this.discardPendingCatalogConfirmation()
    this.clearSubscriptions()
    this.exitConfirmation.rendererUnavailable(() => this.showNativeExitFallback(), () => this.publishExitAuthorization())
  }
  private readonly onWebContentsDestroyed = (): void => this.dispose()

  constructor(private readonly options: StandalonePlayerMainIpcBridgeOptions) {
    if (!options.expectedDocumentUrl) throw new Error('STANDALONE_IPC_INVALID_DOCUMENT')
    this.currentEnvelope = { revision: 0, snapshot: cloneSnapshot(options.control.getSnapshot()) }
    this.unsubscribeControl = options.control.subscribe(snapshot => this.publish(snapshot))
    try {
      this.registerHandlers()
      this.unsubscribeCatalogRevision = options.metadataCatalog?.subscribeToMetadataRevision(revision => {
        this.publishCatalogRevision(revision)
      }) ?? (() => undefined)
      this.unsubscribeOptions = options.options?.subscribe(snapshot => this.publishOptions(snapshot)) ?? (() => undefined)
      options.webContents.on('did-start-navigation', this.onMainFrameNavigation)
      options.webContents.on('render-process-gone', this.onRendererGone)
      options.webContents.once('destroyed', this.onWebContentsDestroyed)
    } catch (error) {
      this.clearSubscriptions()
      this.unsubscribeControl()
      this.unsubscribeCatalogRevision()
      this.unsubscribeOptions()
      this.removeRegisteredHandlers()
      options.webContents.removeListener('did-start-navigation', this.onMainFrameNavigation)
      options.webContents.removeListener('render-process-gone', this.onRendererGone)
      options.webContents.removeListener('destroyed', this.onWebContentsDestroyed)
      throw error
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.exitConfirmation.dispose()
    this.exitAuthorizationListeners.clear()
    this.clearSubscriptions()
    this.unsubscribeControl()
    this.unsubscribeCatalogRevision()
    this.unsubscribeOptions()
    this.discardPendingCatalogConfirmation()
    this.removeRegisteredHandlers()
    this.options.webContents.removeListener('did-start-navigation', this.onMainFrameNavigation)
    this.options.webContents.removeListener('render-process-gone', this.onRendererGone)
    this.options.webContents.removeListener('destroyed', this.onWebContentsDestroyed)
  }

  /** Closes new mutation/UI admissions and resolves after requests already accepted by IPC finish. */
  beginCloseAdmission(): Promise<void> {
    this.acceptingRequests = false
    if (this.activeRequestCount === 0) return Promise.resolve()
    return new Promise(resolve => this.requestDrainWaiters.add(resolve))
  }

  /** Reopens IPC after a pre-disposal shutdown gate fails, so the owner can retry or continue safely. */
  resumeAdmissionAfterFailedShutdown(): void {
    if (this.disposed) throw new Error('STANDALONE_IPC_INVALID_SHUTDOWN_STATE')
    this.acceptingRequests = true
  }

  /** Resets the exit decision after a failed safety check without reopening admissions already closed. */
  resetExitConfirmationAfterFailedShutdown(): void {
    if (this.disposed) throw new Error('STANDALONE_IPC_INVALID_SHUTDOWN_STATE')
    this.exitConfirmation.resetAfterFailedShutdown()
  }

  /** Main callers (such as the future window-close integration) join the same confirmation or native fallback. */
  requestExitConfirmationFromMain(): Promise<boolean> {
    return this.exitConfirmation.requestFromMain({
      isRendererAvailable: () => this.canSendToCurrentDocument(),
      sendToRenderer: requestId => {
        if (!this.canSendToCurrentDocument()) return false
        this.options.webContents.send(STANDALONE_PLAYER_IPC_CHANNELS.exitConfirmationRequested, { requestId })
        return true
      },
      showNativeFallback: () => this.showNativeExitFallback()
    })
  }

  /** Main-only notification seam for the later lifecycle integration; it never starts shutdown by itself. */
  onExitAuthorized(listener: () => void): () => void {
    if (this.disposed) return () => undefined
    this.exitAuthorizationListeners.add(listener)
    return () => this.exitAuthorizationListeners.delete(listener)
  }

  private registerHandlers(): void {
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 0) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      return this.cloneEnvelope(this.currentEnvelope)
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.execute, async (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 1) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      let request
      try { request = validateStandalonePlayerCommandRequest(args[0]) }
      catch { throw new Error('STANDALONE_IPC_INVALID_REQUEST') }
      if (this.libraryOperationInProgress) {
        const snapshot = this.options.control.getSnapshot()
        this.publish(snapshot)
        return this.createCommandReply({
          outcome: 'rejected', operationId: request.operationId,
          error: { code: 'INVALID_STATE' }, snapshot
        })
      }
      this.activeCommandCount++
      let result: StandalonePlayerCommandResult
      try { result = await this.options.control.execute(request) }
      finally { this.activeCommandCount-- }
      if (this.disposed) throw new Error('STANDALONE_IPC_DISPOSED')
      if (result.operationId !== request.operationId) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
      return this.createCommandReply(result)
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.lookupMetadata, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 1 || typeof args[0] !== 'string' || !/^[0-9]{1,5}$/.test(args[0])) {
        throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      }
      const catalog = this.options.metadataCatalog
      if (!catalog) return { catalogRevision: null, title: null, artist: null } satisfies StandalonePlayerMetadataPreview
      return cloneMetadataPreview(catalog.lookupMetadataByVideoCode(args[0]))
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.getCurrentTrackMetadata, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 0) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      const snapshot = this.options.control.getSnapshot()
      if (snapshot.playbackCondition !== 'ready' || snapshot.state.operationalState === 'idle') return null
      const current = snapshot.state.current
      const catalog = this.options.metadataCatalog
      const metadata = catalog
        ? cloneMetadataPreview(catalog.lookupMetadataByVideoCode(current.musicCode))
        : { catalogRevision: null, title: null, artist: null }
      return {
        ...metadata,
        entryId: current.entryId,
        attemptId: current.attemptId,
        musicCode: current.musicCode
      } satisfies StandaloneCurrentTrackMetadata
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 1) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      const subscriptionId = parseSubscriptionId(args[0])
      if (this.subscriptions.has(subscriptionId)) throw new Error('STANDALONE_IPC_SUBSCRIPTION_EXISTS')
      if (this.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_RENDERER) {
        throw new Error('STANDALONE_IPC_SUBSCRIPTION_LIMIT')
      }
      const generation = ++this.nextGeneration
      this.subscriptions.set(subscriptionId, { generation })
      return {
        subscription: { subscriptionId, generation } satisfies StandalonePlayerSubscriptionRef,
        envelope: this.cloneEnvelope(this.currentEnvelope)
      }
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.unsubscribe, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 1) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      const subscription = parseSubscriptionRef(args[0])
      const current = this.subscriptions.get(subscription.subscriptionId)
      if (!current || current.generation !== subscription.generation) return false
      this.subscriptions.delete(subscription.subscriptionId)
      return true
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.requestExitConfirmation, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 0) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      return this.exitConfirmation.requestFromRenderer()
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.resolveExitConfirmation, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 1 || !isPlainRecord(args[0]) ||
          !hasExactKeys(args[0], ['requestId', 'decision']) ||
          typeof args[0].requestId !== 'string' || !isUuid(args[0].requestId) ||
          (args[0].decision !== 'confirm' && args[0].decision !== 'cancel')) {
        throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      }
      const resolution = this.exitConfirmation.resolveFromRenderer(args[0].requestId, args[0].decision)
      if (resolution.notifyMain) this.publishExitAuthorization()
      return resolution.reply
    })
    if (this.options.options) this.registerOptionsHandlers()
    this.registerVideoSurfaceHandlers(this.options.videoSurface ?? {
      show: async () => false,
      hide: () => false
    })
  }

  private registerVideoSurfaceHandlers(surface: NonNullable<StandalonePlayerMainIpcBridgeOptions['videoSurface']>): void {
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.showPlaybackSurface, async (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 1 || !isPlayerVideoBounds(args[0])) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      return surface.show(args[0])
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.hidePlaybackSurface, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 0) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      return surface.hide()
    })
  }

  private registerOptionsHandlers(): void {
    const options = this.options.options!
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.getOptionsSnapshot, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 0) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      return this.createOptionsSnapshot(options.getSnapshot())
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.selectVideoFolder, async (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 0) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      const blocked = this.getLibraryChangeBlockCode(options.getSnapshot())
      if (blocked) return this.optionsActionReply('blocked', blocked, options.getSnapshot())
      this.libraryOperationInProgress = true
      try {
        let folderPath: string | null
        try { folderPath = await options.chooseVideoFolder() }
        catch { return this.optionsActionReply('failed', 'OPTIONS_FAILED', options.getSnapshot()) }
        if (folderPath === null) return this.optionsActionReply('cancelled', undefined, options.getSnapshot())

        // The native dialog yields to the event loop. Recheck Main-authoritative state before persisting.
        const stale = this.getLibraryChangeBlockCode(options.getSnapshot(), true)
        if (stale) return this.optionsActionReply('blocked', stale, options.getSnapshot())
        try {
          await options.applyVideoFolder(folderPath)
          return this.optionsActionReply('confirmed', undefined, options.getSnapshot())
        } catch {
          return this.optionsActionReply('failed', 'OPTIONS_FAILED', options.getSnapshot())
        }
      } finally {
        this.libraryOperationInProgress = false
      }
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.refreshVideoLibrary, async (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 0) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      const blocked = this.getLibraryChangeBlockCode(options.getSnapshot())
      if (blocked) return this.optionsActionReply('blocked', blocked, options.getSnapshot())
      this.libraryOperationInProgress = true
      try {
        const stale = this.getLibraryChangeBlockCode(options.getSnapshot(), true)
        if (stale) return this.optionsActionReply('blocked', stale, options.getSnapshot())
        try {
          await options.refreshVideoLibrary()
          return this.optionsActionReply('confirmed', undefined, options.getSnapshot())
        } catch {
          return this.optionsActionReply('failed', 'OPTIONS_FAILED', options.getSnapshot())
        }
      } finally {
        this.libraryOperationInProgress = false
      }
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.importMusicCatalog, async (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 0) throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      if (this.catalogOperationInProgress) {
        return this.optionsActionReply('blocked', 'OPTIONS_BUSY', options.getSnapshot())
      }
      this.catalogOperationInProgress = true
      let waitingForConfirmation = false
      try {
        let filePath: string | null
        try { filePath = await options.chooseCatalogFile() }
        catch { return this.optionsActionReply('failed', 'CATALOG_IMPORT_FAILED', options.getSnapshot()) }
        this.assertAuthorized(event)
        if (filePath === null) return this.optionsActionReply('cancelled', undefined, options.getSnapshot())
        try {
          const preparation = await options.prepareCatalogImport(filePath)
          this.assertAuthorized(event)
          if (preparation.outcome === 'confirmation-required') {
            this.pendingCatalogConfirmationToken = preparation.token
            waitingForConfirmation = true
            return this.optionsActionReply('confirmation-required', undefined, options.getSnapshot(), {
              token: preparation.token,
              recordCount: preparation.recordCount,
              issueCount: preparation.issueCount,
              currentRecordCount: preparation.currentRecordCount
            })
          }
          return this.optionsActionReply('confirmed', undefined, options.getSnapshot())
        } catch {
          return this.optionsActionReply('failed', 'CATALOG_IMPORT_FAILED', options.getSnapshot())
        }
      } finally {
        if (!waitingForConfirmation) this.catalogOperationInProgress = false
      }
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.confirmMusicCatalogImport, async (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 1 || typeof args[0] !== 'string' || !/^[0-9a-f-]{36}$/.test(args[0])) {
        throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      }
      const token = args[0]
      if (!this.catalogOperationInProgress || this.pendingCatalogConfirmationToken !== token) {
        return this.optionsActionReply('failed', 'CATALOG_CONFIRMATION_STALE', options.getSnapshot())
      }
      try {
        await options.confirmCatalogImport(token)
        this.pendingCatalogConfirmationToken = undefined
        this.catalogOperationInProgress = false
        return this.optionsActionReply('confirmed', undefined, options.getSnapshot())
      } catch (error) {
        if (error instanceof Error && (error.message === 'CATALOG_CHANGED_DURING_CONFIRMATION' ||
            error.message === 'CATALOG_REPORT_STALE')) {
          this.discardPendingCatalogConfirmation()
          return this.optionsActionReply('failed', 'CATALOG_CONFIRMATION_STALE', options.getSnapshot())
        }
        return this.optionsActionReply('failed', 'CATALOG_IMPORT_FAILED', options.getSnapshot())
      }
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.cancelMusicCatalogImport, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 1 || typeof args[0] !== 'string' || !/^[0-9a-f-]{36}$/.test(args[0])) {
        throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      }
      if (this.pendingCatalogConfirmationToken !== args[0]) return false
      const cancelled = options.cancelCatalogImport(args[0])
      this.pendingCatalogConfirmationToken = undefined
      this.catalogOperationInProgress = false
      return cancelled
    })
    this.handle(STANDALONE_PLAYER_IPC_CHANNELS.getCatalogImportIssuesPage, (event, ...args) => {
      this.assertAuthorized(event)
      if (args.length !== 1 || !isPlainRecord(args[0]) ||
          !hasExactKeys(args[0], ['catalogRevision', 'generation', 'offset']) ||
          typeof args[0].catalogRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args[0].catalogRevision) ||
          !Number.isSafeInteger(args[0].generation) || (args[0].generation as number) < 0 ||
          !Number.isSafeInteger(args[0].offset) || (args[0].offset as number) < 0 ||
          (args[0].offset as number) > 100_000) {
        throw new Error('STANDALONE_IPC_INVALID_REQUEST')
      }
      const page = options.getCatalogImportIssuesPage(args[0].catalogRevision, args[0].generation as number,
        args[0].offset as number, 50)
      return cloneCatalogImportIssuesPage(page)
    })
  }

  private getLibraryChangeBlockCode(
    snapshot: StandalonePlayerOptionsData,
    ownsLibraryLock = false
  ): 'PLAYER_NOT_IDLE' | 'LIBRARY_BUSY' | undefined {
    if ((!ownsLibraryLock && this.libraryOperationInProgress) || snapshot.library.scanStatus === 'scanning') return 'LIBRARY_BUSY'
    if (this.activeCommandCount > 0 || !isStandalonePlayerLibraryChangeAllowed(this.options.control.getSnapshot())) {
      return 'PLAYER_NOT_IDLE'
    }
    return undefined
  }

  private optionsActionReply(
    outcome: StandalonePlayerOptionsActionReply['outcome'],
    code: StandalonePlayerOptionsActionReply['code'],
    snapshot: StandalonePlayerOptionsData,
    confirmation?: StandalonePlayerOptionsActionReply['confirmation']
  ): StandalonePlayerOptionsActionReply {
    return {
      outcome,
      ...(code ? { code } : {}),
      ...(confirmation ? { confirmation: { ...confirmation } } : {}),
      snapshot: this.createOptionsSnapshot(snapshot)
    }
  }

  private discardPendingCatalogConfirmation(): void {
    const token = this.pendingCatalogConfirmationToken
    this.pendingCatalogConfirmationToken = undefined
    if (token) {
      try { this.options.options?.cancelCatalogImport(token) } catch { /* Disposal must not block IPC cleanup. */ }
    }
    this.catalogOperationInProgress = false
  }

  private handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
    this.options.ipcMain.handle(channel, async (event, ...args) => {
      if (this.disposed) throw new Error('STANDALONE_IPC_DISPOSED')
      this.assertAuthorized(event)
      if (!this.acceptingRequests && !EXIT_CHANNELS.has(channel)) throw new Error('STANDALONE_IPC_CLOSING')
      this.activeRequestCount++
      try { return await listener(event, ...args) }
      finally {
        this.activeRequestCount--
        if (this.activeRequestCount === 0) {
          for (const resolve of this.requestDrainWaiters) resolve()
          this.requestDrainWaiters.clear()
        }
      }
    })
    this.registeredChannels.add(channel)
  }

  private removeRegisteredHandlers(): void {
    for (const channel of this.registeredChannels) this.options.ipcMain.removeHandler(channel)
    this.registeredChannels.clear()
  }

  private assertAuthorized(event: IpcMainInvokeEvent): void {
    if (this.disposed) throw new Error('STANDALONE_IPC_DISPOSED')
    const target = this.options.webContents
    if (target.isDestroyed() || event.sender !== target || event.sender.isDestroyed()) {
      throw new Error('STANDALONE_IPC_FORBIDDEN')
    }
    const senderFrame = event.senderFrame
    let mainFrame: Electron.WebFrameMain
    try { mainFrame = target.mainFrame }
    catch { throw new Error('STANDALONE_IPC_FORBIDDEN') }
    if (!senderFrame || senderFrame !== mainFrame || senderFrame.url !== this.options.expectedDocumentUrl ||
        target.getURL() !== this.options.expectedDocumentUrl) {
      throw new Error('STANDALONE_IPC_FORBIDDEN')
    }
  }

  private async showNativeExitFallback(): Promise<boolean> {
    if (this.options.showExitFallbackDialog) return this.options.showExitFallbackDialog()
    const { BrowserWindow, dialog } = require('electron') as typeof import('electron')
    const parent = BrowserWindow.fromWebContents(this.options.webContents)
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'Karaoke Queue',
      message: 'Sair do Karaoke Queue?',
      detail: 'O aplicativo será fechado. Se houver uma música em reprodução, ela será interrompida.',
      buttons: ['Cancelar', 'Sair do aplicativo'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }
    const result = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    return result.response === 1
  }

  private publishExitAuthorization(): void {
    for (const listener of [...this.exitAuthorizationListeners]) {
      try { listener() } catch (error) {
        console.error('Standalone exit authorization listener failed.', error)
      }
    }
  }

  private publish(snapshot: StandalonePlayerSnapshot): void {
    if (this.disposed) return
    if (this.currentEnvelope.revision >= Number.MAX_SAFE_INTEGER) {
      this.clearSubscriptions()
      return
    }
    this.currentEnvelope = { revision: this.currentEnvelope.revision + 1, snapshot: cloneSnapshot(snapshot) }
    if (!this.canSendToCurrentDocument()) {
      this.clearSubscriptions()
      return
    }
    for (const [subscriptionId, record] of this.subscriptions) {
      const update: StandalonePlayerSnapshotUpdate = {
        subscriptionId,
        generation: record.generation,
        envelope: this.cloneEnvelope(this.currentEnvelope)
      }
      try { this.options.webContents.send(STANDALONE_PLAYER_IPC_CHANNELS.snapshotChanged, update) }
      catch { this.subscriptions.delete(subscriptionId) }
    }
  }

  private publishCatalogRevision(revision: string | null): void {
    if (this.disposed || !this.canSendToCurrentDocument()) return
    try {
      this.options.webContents.send(STANDALONE_PLAYER_IPC_CHANNELS.catalogRevisionChanged, { catalogRevision: revision })
    } catch { /* A catalog refresh must not affect its committed result if the Renderer is closing. */ }
  }

  private publishOptions(snapshot: StandalonePlayerOptionsData): void {
    if (this.disposed || this.optionsRevision >= Number.MAX_SAFE_INTEGER) return
    this.optionsRevision++
    if (!this.canSendToCurrentDocument()) return
    try {
      this.options.webContents.send(STANDALONE_PLAYER_IPC_CHANNELS.optionsChanged, this.createOptionsSnapshot(snapshot))
    } catch { /* Options rendering cannot affect a committed library or catalog operation. */ }
  }

  private createOptionsSnapshot(snapshot: StandalonePlayerOptionsData): StandalonePlayerOptionsSnapshot {
    return createVersionedOptionsSnapshot(snapshot, this.optionsRevision)
  }

  private createCommandReply(result: StandalonePlayerCommandResult): StandalonePlayerIpcCommandReply {
    if (result.outcome === 'confirmed') {
      return {
        outcome: result.outcome,
        operationId: result.operationId,
        ...(result.attemptId ? { attemptId: result.attemptId } : {}),
        envelope: this.cloneEnvelope(this.currentEnvelope)
      }
    }
    const error = result.outcome === 'rejected' ? result.error : result.snapshot.error
    return {
      outcome: result.outcome,
      operationId: result.operationId,
      error: { code: error.code },
      ...(result.attemptId ? { attemptId: result.attemptId } : {}),
      envelope: this.cloneEnvelope(this.currentEnvelope)
    }
  }

  private canSendToCurrentDocument(): boolean {
    const target = this.options.webContents
    if (target.isDestroyed()) return false
    try {
      return !target.isCrashed() && target.getURL() === this.options.expectedDocumentUrl &&
        target.mainFrame.url === this.options.expectedDocumentUrl
    } catch { return false }
  }

  private clearSubscriptions(): void {
    this.subscriptions.clear()
  }

  private cloneEnvelope(envelope: StandalonePlayerSnapshotEnvelope): StandalonePlayerSnapshotEnvelope {
    return { revision: envelope.revision, snapshot: cloneSnapshot(envelope.snapshot) }
  }
}

function isPlayerVideoBounds(value: unknown): value is StandalonePlayerVideoBounds {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['x', 'y', 'width', 'height'])) return false
  return [value.x, value.y, value.width, value.height].every(item => typeof item === 'number' && Number.isFinite(item)) &&
    Math.abs(value.x as number) <= 10000 && Math.abs(value.y as number) <= 10000 &&
    (value.width as number) >= 0 && (value.width as number) <= 10000 &&
    (value.height as number) >= 0 && (value.height as number) <= 10000
}

export function installStandalonePlayerMainIpcBridge(
  options: StandalonePlayerMainIpcBridgeOptions
): StandalonePlayerMainIpcBridge {
  return new StandalonePlayerMainIpcBridge(options)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

const OPTIONS_LIBRARY_SCAN_STATUSES = new Set(['not-scanned', 'scanning', 'ready', 'degraded', 'closed'])
const OPTIONS_ACTION_CODES = new Set([
  'PLAYER_NOT_IDLE', 'LIBRARY_BUSY', 'OPTIONS_BUSY', 'OPTIONS_FAILED', 'CATALOG_IMPORT_FAILED',
  'CATALOG_CONFIRMATION_STALE'
])

function cloneOptionsData(value: unknown): StandalonePlayerOptionsData {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['library', 'catalog']) ||
      !isPlainRecord(value.library) || !hasExactKeys(value.library, ['folderName', 'scanStatus', 'indexedFiles']) ||
      !(value.library.folderName === null || (typeof value.library.folderName === 'string' && value.library.folderName.length <= 255)) ||
      typeof value.library.scanStatus !== 'string' || !OPTIONS_LIBRARY_SCAN_STATUSES.has(value.library.scanStatus) ||
      !(value.library.indexedFiles === null || (Number.isSafeInteger(value.library.indexedFiles) && (value.library.indexedFiles as number) >= 0)) ||
      !isPlainRecord(value.catalog) || !hasExactKeys(value.catalog,
        ['fileName', 'recordCount', 'importedAt', 'revision', 'importIssueCount', 'importGeneration']) ||
      !(value.catalog.fileName === null || (typeof value.catalog.fileName === 'string' && value.catalog.fileName.length <= 255)) ||
      !Number.isSafeInteger(value.catalog.recordCount) || (value.catalog.recordCount as number) < 0 ||
      !(value.catalog.importedAt === null || (typeof value.catalog.importedAt === 'string' && value.catalog.importedAt.length <= 128)) ||
      !(value.catalog.revision === null || (typeof value.catalog.revision === 'string' && /^[a-f0-9]{64}$/.test(value.catalog.revision))) ||
      !Number.isSafeInteger(value.catalog.importIssueCount) || (value.catalog.importIssueCount as number) < 0 ||
      (value.catalog.importIssueCount as number) > 100_000 ||
      !Number.isSafeInteger(value.catalog.importGeneration) || (value.catalog.importGeneration as number) < 0) {
    throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
  }
  return {
    library: {
      folderName: value.library.folderName,
      scanStatus: value.library.scanStatus as StandalonePlayerOptionsSnapshot['library']['scanStatus'],
      indexedFiles: value.library.indexedFiles as number | null
    },
    catalog: {
      fileName: value.catalog.fileName,
      recordCount: value.catalog.recordCount as number,
      importedAt: value.catalog.importedAt,
      revision: value.catalog.revision as string | null,
      importIssueCount: value.catalog.importIssueCount as number,
      importGeneration: value.catalog.importGeneration as number
    }
  }
}

function createVersionedOptionsSnapshot(value: unknown, revision: number): StandalonePlayerOptionsSnapshot {
  return { ...cloneOptionsData(value), revision }
}

function cloneVersionedOptionsSnapshot(value: unknown): StandalonePlayerOptionsSnapshot {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['revision', 'library', 'catalog']) ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
  }
  return { ...cloneOptionsData({ library: value.library, catalog: value.catalog }), revision: value.revision as number }
}

export function validateStandalonePlayerOptionsActionReply(value: unknown): StandalonePlayerOptionsActionReply {
  if (!isPlainRecord(value) ||
      !['confirmed', 'cancelled', 'blocked', 'failed', 'confirmation-required'].includes(String(value.outcome)) ||
      !(value.code === undefined || (typeof value.code === 'string' && OPTIONS_ACTION_CODES.has(value.code)))) {
    throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
  }
  const allowedKeys = ['outcome', 'snapshot']
  if (value.code !== undefined) allowedKeys.push('code')
  if (value.confirmation !== undefined) allowedKeys.push('confirmation')
  if (!hasExactKeys(value, allowedKeys)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
  if (value.outcome === 'confirmation-required') {
    if (!isPlainRecord(value.confirmation) || !hasExactKeys(value.confirmation,
        ['token', 'recordCount', 'issueCount', 'currentRecordCount']) ||
        typeof value.confirmation.token !== 'string' || !/^[0-9a-f-]{36}$/.test(value.confirmation.token) ||
        !Number.isSafeInteger(value.confirmation.recordCount) || (value.confirmation.recordCount as number) < 1 ||
        !Number.isSafeInteger(value.confirmation.issueCount) || (value.confirmation.issueCount as number) < 1 ||
        !Number.isSafeInteger(value.confirmation.currentRecordCount) || (value.confirmation.currentRecordCount as number) < 0) {
      throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    }
  } else if (value.confirmation !== undefined) {
    throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
  }
  return {
    outcome: value.outcome as StandalonePlayerOptionsActionReply['outcome'],
    ...(value.code ? { code: value.code as StandalonePlayerOptionsActionReply['code'] } : {}),
    ...(value.confirmation ? { confirmation: { ...value.confirmation } as NonNullable<StandalonePlayerOptionsActionReply['confirmation']> } : {}),
    snapshot: cloneVersionedOptionsSnapshot(value.snapshot)
  }
}

function cloneCatalogImportIssuesPage(value: unknown): StandaloneCatalogImportIssuesPage {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['catalogRevision', 'generation', 'total', 'offset', 'issues']) ||
      !(value.catalogRevision === null || (typeof value.catalogRevision === 'string' && /^[a-f0-9]{64}$/.test(value.catalogRevision))) ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 ||
      !Number.isSafeInteger(value.total) || (value.total as number) < 0 || (value.total as number) > 100_000 ||
      !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
      !Array.isArray(value.issues) || value.issues.length > 100 || !value.issues.every(issue =>
        isPlainRecord(issue) && hasExactKeys(issue, ['rowNumber', 'field', 'value', 'code', 'reason']) &&
        Number.isSafeInteger(issue.rowNumber) && (issue.rowNumber as number) > 0 && issue.field === 'numero' &&
        typeof issue.value === 'string' && issue.value.length <= 4096 && issue.code === 'INVALID_MUSIC_NUMBER' &&
        typeof issue.reason === 'string' && issue.reason.length <= 512)) {
    throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
  }
  return {
    catalogRevision: value.catalogRevision as string | null,
    generation: value.generation as number,
    total: value.total as number,
    offset: value.offset as number,
    issues: value.issues.map(issue => ({
      rowNumber: issue.rowNumber as number,
      field: 'numero',
      value: issue.value as string,
      code: 'INVALID_MUSIC_NUMBER',
      reason: issue.reason as string
    }))
  }
}

function parseSubscriptionId(value: unknown): string {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['subscriptionId']) ||
      typeof value.subscriptionId !== 'string' || !/^sp-[1-9][0-9]{0,9}$/.test(value.subscriptionId)) {
    throw new Error('STANDALONE_IPC_INVALID_REQUEST')
  }
  return value.subscriptionId
}

function parseSubscriptionRef(value: unknown): StandalonePlayerSubscriptionRef {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['subscriptionId', 'generation']) ||
      typeof value.subscriptionId !== 'string' || !/^sp-[1-9][0-9]{0,9}$/.test(value.subscriptionId) ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    throw new Error('STANDALONE_IPC_INVALID_REQUEST')
  }
  return { subscriptionId: value.subscriptionId, generation: value.generation as number }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function cloneMetadataPreview(value: unknown): StandalonePlayerMetadataPreview {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['catalogRevision', 'title', 'artist']) ||
      !(value.catalogRevision === null || (typeof value.catalogRevision === 'string' && value.catalogRevision.length <= 128)) ||
      !(value.title === null || (typeof value.title === 'string' && value.title.length <= 4096)) ||
      !(value.artist === null || (typeof value.artist === 'string' && value.artist.length <= 4096))) {
    throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
  }
  return { catalogRevision: value.catalogRevision, title: value.title, artist: value.artist }
}

function cloneSnapshot(snapshot: StandalonePlayerSnapshot): StandalonePlayerSnapshot {
  if (snapshot.storageRecovery) {
    const { storageRecovery: r, ...base } = snapshot
    return { ...cloneSnapshot(base), storageRecovery: { available: r.available, contained: r.contained,
      phase: r.phase, wasPaused: r.wasPaused, positionRestorable: false,
      target: r.target ? { entryId: r.target.entryId, musicCode: r.target.musicCode } : null } }
  }
  if (snapshot.playbackCondition === 'ready') return { playbackCondition: 'ready', state: cloneStableState(snapshot.state) }
  if (snapshot.playbackCondition === 'transitioning') {
    const base = {
      playbackCondition: 'transitioning' as const,
      lastConfirmedState: cloneStableState(snapshot.lastConfirmedState),
      pending: snapshot.pending.map(entry => ({ entryId: entry.entryId, musicCode: entry.musicCode }))
    }
    if (snapshot.phase === 'countdown') return {
      ...base,
      phase: 'countdown',
      target: { entryId: snapshot.target.entryId, musicCode: snapshot.target.musicCode },
      remainingMs: snapshot.remainingMs,
      paused: snapshot.paused
    }
    if (snapshot.phase === 'loading') return {
      ...base,
      phase: 'loading',
      target: { entryId: snapshot.target.entryId, musicCode: snapshot.target.musicCode }
    }
    if (snapshot.phase === 'celebration') {
      if (!STANDALONE_CELEBRATION_MESSAGES.includes(snapshot.message)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
      return {
        ...base,
        phase: 'celebration',
        remainingMs: snapshot.remainingMs,
        paused: snapshot.paused,
        message: snapshot.message
      }
    }
    if (snapshot.phase === 'resuming') return { ...base, phase: 'resuming' }
    return {
      ...base,
      phase: 'operation'
    }
  }
  return {
    playbackCondition: snapshot.playbackCondition,
    lastConfirmedState: cloneStableState(snapshot.lastConfirmedState),
    pending: snapshot.pending.map(entry => ({ entryId: entry.entryId, musicCode: entry.musicCode })),
    error: { code: snapshot.error.code }
  }
}

function cloneStableState(state: StandaloneStableState): StandaloneStableState {
  const pending = state.pending.map(entry => ({ entryId: entry.entryId, musicCode: entry.musicCode }))
  if (state.operationalState === 'idle') return { operationalState: 'idle', current: null, pending: [] }
  return {
    operationalState: state.operationalState,
    current: {
      entryId: state.current.entryId,
      musicCode: state.current.musicCode,
      attemptId: state.current.attemptId
    },
    pending
  }
}
