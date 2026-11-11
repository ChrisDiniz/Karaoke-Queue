import { StandaloneLicenseView } from './standalone-license-view'
import type {
  StandaloneCatalogImportIssuesPage,
  StandalonePlayerOptionsActionReply,
  StandalonePlayerOptionsSnapshot,
  StandalonePlayerRendererApi,
  StandalonePlayerSnapshotEnvelope,
  StandalonePlayerSubscriptionRef
} from './standalone-player-ipc-contracts'
import { isNewerStandalonePlayerOptionsSnapshot } from './standalone-player-ipc-contracts'
import type { StandaloneTransitioningSnapshot } from './standalone-player-contracts'
import type { StandalonePlayerSnapshot } from './standalone-player-contracts'
import { StandalonePlayerInteractionController } from './standalone-player-interaction'
import type {
  StandaloneCodeSubmissionStatus,
  StandalonePlayerInteractionIntent,
  StandalonePlayerMenuScreen
} from './standalone-player-interaction'
import { StandalonePlayerInteractionTransport } from './standalone-player-interaction-transport'
import type { StandaloneKeyboardStroke } from './standalone-player-keyboard'
import {
  StandalonePlayerMetadataPreviewController,
  StandaloneTransitionMetadataPreviewController,
  type StandaloneMetadataPreviewSnapshot,
  type StandaloneTransitionMetadataSnapshot
} from './standalone-player-metadata-preview'
import {
  StandaloneCurrentTrackInfoController,
  type StandaloneCurrentTrackIdentity,
  type StandaloneCurrentTrackInfoSnapshot
} from './standalone-player-current-track-info'

declare global {
  interface Window {
    standalonePlayer?: StandalonePlayerRendererApi
  }
}

const ENTRY_PANEL_INACTIVITY_MS = 5_000
const TEMPORARY_FEEDBACK_MS = 3_500
const CATALOG_ISSUES_PAGE_SIZE = 50

type CatalogDialogMode = 'closed' | 'confirmation' | 'issues'

class StandalonePlayerRenderer {
  private readonly license = new StandaloneLicenseView()
  private readonly api = window.standalonePlayer
  private readonly interaction: StandalonePlayerInteractionController
  private readonly transport: StandalonePlayerInteractionTransport
  private readonly metadata: StandalonePlayerMetadataPreviewController
  private readonly transitionMetadata: StandaloneTransitionMetadataPreviewController
  private readonly currentTrackInfo: StandaloneCurrentTrackInfoController
  private readonly unsubscribeInteraction: () => void
  private readonly unsubscribeMetadata: () => void
  private readonly unsubscribeTransitionMetadata: () => void
  private readonly unsubscribeCurrentTrackInfo: () => void
  private readonly unsubscribeCatalogRevision: () => void
  private readonly unsubscribeOptions: () => void
  private readonly unsubscribeExitConfirmation: () => void
  private readonly onResize = (): void => {
    this.renderQueueProjection()
    this.syncPlaybackSurface(true)
  }
  private optionsSnapshot: StandalonePlayerOptionsSnapshot | undefined
  private optionsToastTimer: number | undefined
  private optionsToastGeneration = 0
  private lastMenuScreen: StandalonePlayerMenuScreen = 'closed'
  private snapshotSubscription: StandalonePlayerSubscriptionRef | undefined
  private latestSnapshot: StandalonePlayerSnapshotEnvelope | undefined
  private lastNumericPanelOpen = false
  private feedbackOperationId: string | undefined
  private feedbackOutcome: StandaloneCodeSubmissionStatus['outcome'] | undefined
  private feedbackVisible = false
  private feedbackTimer: number | undefined
  private feedbackTimerGeneration = 0
  private feedbackStatus: StandaloneCodeSubmissionStatus | undefined
  private storageDismissed = false
  private storageActionPending = false
  private storageStatus = ''
  private stopConfirmationOpen = false
  private stopConfirmationStatus = ''
  private catalogDialogMode: CatalogDialogMode = 'closed'
  private catalogConfirmation: NonNullable<StandalonePlayerOptionsActionReply['confirmation']> | undefined
  private catalogConfirmationBusy = false
  private catalogDialogStatus = ''
  private catalogIssuesPageNumber = 0
  private catalogIssuesPage: StandaloneCatalogImportIssuesPage | undefined
  private catalogIssuesRequestGeneration = 0
  private catalogDialogReturnFocus: HTMLElement | undefined
  private exitConfirmationReturnFocus: HTMLElement | undefined
  private exitConfirmationReturnMenuScreen: Exclude<StandalonePlayerMenuScreen, 'exit-confirmation'> = 'main'
  private exitConfirmationRequestId: string | undefined
  private exitResolutionPending = false
  private resumeFeedbackTimer: number | undefined
  private resumeFeedbackGeneration = 0
  private playbackSurfaceVisible = false
  private playbackSurfaceGeneration = 0
  private disposed = false
  private readonly onOpenMenuCommands = (): void => {
    if (this.interaction.getSnapshot().menuScreen === 'main') this.interaction.selectMenuAction('commands')
  }
  private readonly onOpenMenuOptions = (): void => {
    if (this.interaction.getSnapshot().menuScreen === 'main') this.interaction.selectMenuAction('options')
  }
  private readonly onOpenMenuExit = (event: MouseEvent): void => {
    if (this.interaction.getSnapshot().menuScreen !== 'main') return
    const action = event.currentTarget
    this.exitConfirmationReturnFocus = action instanceof HTMLButtonElement
      ? action : document.getElementById('menu-item-exit') ?? undefined
    void this.requestExitConfirmationFromMenu()
  }
  private readonly onCancelExitConfirmation = (): void => {
    void this.resolveExitConfirmation('cancel')
  }
  private readonly onConfirmExitConfirmation = (): void => {
    void this.resolveExitConfirmation('confirm')
  }
  private readonly onChangeVideoFolder = (): void => { void this.runOptionsAction(() => this.api?.selectVideoFolder(), 'library') }
  private readonly onRefreshVideoLibrary = (): void => { void this.runOptionsAction(() => this.api?.refreshVideoLibrary(), 'library') }
  private readonly onImportMusicCatalog = (): void => { void this.runOptionsAction(() => this.api?.importMusicCatalog(), 'catalog') }
  private readonly onViewCatalogIssues = (): void => { void this.openCatalogIssues() }
  private readonly onCatalogDialogCancel = (): void => { this.closeCatalogDialog(true) }
  private readonly onCatalogDialogConfirm = (): void => { void this.confirmCatalogImport() }
  private readonly onCatalogIssuesPrevious = (): void => { void this.loadCatalogIssuesPage(this.catalogIssuesPageNumber - 1) }
  private readonly onCatalogIssuesNext = (): void => { void this.loadCatalogIssuesPage(this.catalogIssuesPageNumber + 1) }

  constructor() {
    if (!this.api) throw new Error('STANDALONE_IPC_UNAVAILABLE')
    this.interaction = new StandalonePlayerInteractionController({
      scheduler: {
        schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
        cancel: handle => window.clearTimeout(handle as number)
      },
      digitPanelInactivityMs: ENTRY_PANEL_INACTIVITY_MS,
      createOperationId: () => `c1-${window.crypto.randomUUID()}`
    })
    this.transport = new StandalonePlayerInteractionTransport(this.interaction, this.api)
    this.metadata = new StandalonePlayerMetadataPreviewController({
      lookupMetadata: code => this.api?.lookupMetadata(code) ?? Promise.reject(new Error('STANDALONE_IPC_UNAVAILABLE'))
    })
    this.transitionMetadata = new StandaloneTransitionMetadataPreviewController({
      lookupMetadata: code => this.api?.lookupMetadata(code) ?? Promise.reject(new Error('STANDALONE_IPC_UNAVAILABLE'))
    })
    this.currentTrackInfo = new StandaloneCurrentTrackInfoController({
      scheduler: {
        schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
        cancel: handle => window.clearTimeout(handle as number)
      },
      lookupCurrentTrack: () => this.api?.getCurrentTrackMetadata() ?? Promise.reject(new Error('STANDALONE_IPC_UNAVAILABLE')),
      getCurrentTrack: async () => {
        const envelope = await this.api?.getSnapshot()
        return envelope ? currentTrackFromSnapshot(envelope.snapshot) : null
      }
    })
    this.unsubscribeExitConfirmation = this.api.onExitConfirmationRequested(requestId => {
      this.showExitConfirmation(requestId)
    })
    this.unsubscribeInteraction = this.interaction.subscribe(snapshot => {
      if (snapshot.numericPanelOpen && this.currentTrackInfo.getSnapshot().open) this.currentTrackInfo.close()
      if (!snapshot.numericPanelOpen && this.lastNumericPanelOpen && this.isActivePlayback()) {
        if (this.feedbackOutcome === 'confirmed' || this.feedbackOutcome === 'rejected') {
          this.cancelFeedbackTimer()
          this.feedbackVisible = false
        }
      }
      this.lastNumericPanelOpen = snapshot.numericPanelOpen
      this.renderEntry(snapshot.numericPanelOpen, snapshot.enteredCode)
      this.metadata.updateEntry(snapshot.numericPanelOpen, snapshot.enteredCode)
      this.renderFeedback(snapshot.lastSubmission)
      this.renderStopConfirmation()
      this.renderMenu(snapshot.menuScreen)
      this.renderQueueProjection()
    })
    this.unsubscribeMetadata = this.metadata.subscribe(snapshot => this.renderMetadata(snapshot))
    this.unsubscribeTransitionMetadata = this.transitionMetadata.subscribe(snapshot => this.renderTransitionMetadata(snapshot))
    this.unsubscribeCurrentTrackInfo = this.currentTrackInfo.subscribe(snapshot => {
      this.renderCurrentTrackInfo(snapshot)
      this.renderQueueProjection()
      this.syncPlaybackSurface()
    })
    this.unsubscribeCatalogRevision = this.api.onCatalogRevisionChanged(revision => {
      this.metadata.catalogChanged(revision)
      this.transitionMetadata.catalogChanged(revision)
      this.currentTrackInfo.catalogChanged(revision)
    })
    this.unsubscribeOptions = this.api.onOptionsChanged(snapshot => {
      this.applyOptionsSnapshot(snapshot)
    })
    document.getElementById('storage-recovery-retry')?.addEventListener('click', () => void this.storageAction('recover-storage'))
    document.getElementById('storage-recovery-discard')?.addEventListener('click', () => void this.storageAction('discard-interrupted'))
    document.getElementById('storage-recovery-dismiss')?.addEventListener('click', () => {
      this.storageDismissed = true; this.renderStorageRecovery(); document.body.focus()
    })
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('pagehide', this.dispose, { once: true })
    document.getElementById('stop-confirmation-cancel')?.addEventListener('click', this.onCancelStopConfirmation)
    document.getElementById('stop-confirmation-confirm')?.addEventListener('click', this.onConfirmStopAll)
    document.getElementById('menu-item-commands')?.addEventListener('click', this.onOpenMenuCommands)
    document.getElementById('menu-item-options')?.addEventListener('click', this.onOpenMenuOptions)
    document.getElementById('menu-item-exit')?.addEventListener('click', this.onOpenMenuExit)
    document.getElementById('exit-confirmation-cancel')?.addEventListener('click', this.onCancelExitConfirmation)
    document.getElementById('exit-confirmation-confirm')?.addEventListener('click', this.onConfirmExitConfirmation)
    document.getElementById('options-change-folder')?.addEventListener('click', this.onChangeVideoFolder)
    document.getElementById('options-refresh-library')?.addEventListener('click', this.onRefreshVideoLibrary)
    document.getElementById('options-import-catalog')?.addEventListener('click', this.onImportMusicCatalog)
    document.getElementById('options-catalog-view-issues')?.addEventListener('click', this.onViewCatalogIssues)
    document.getElementById('options-catalog-dialog-cancel')?.addEventListener('click', this.onCatalogDialogCancel)
    document.getElementById('options-catalog-dialog-confirm')?.addEventListener('click', this.onCatalogDialogConfirm)
    document.getElementById('options-catalog-issues-previous')?.addEventListener('click', this.onCatalogIssuesPrevious)
    document.getElementById('options-catalog-issues-next')?.addEventListener('click', this.onCatalogIssuesNext)
    document.body.focus()
    this.renderEntry(false, '')
    this.renderMetadata(this.metadata.getSnapshot())
    this.renderMenu(this.interaction.getSnapshot().menuScreen)
    void this.api.getOptionsSnapshot().then(snapshot => {
      if (this.disposed) return
      this.applyOptionsSnapshot(snapshot)
    }).catch(() => this.showOptionsToast('Não foi possível carregar as opções.', 'error'))
    void this.api.subscribe(envelope => this.renderSnapshot(envelope)).then(subscription => {
      if (this.disposed) void this.api?.unsubscribe(subscription)
      else this.snapshotSubscription = subscription
    }).catch(() => undefined)
  }

  private syncLicenseVisibility(): void {
    const snapshot = this.latestSnapshot?.snapshot
    this.license.setAvailable(Boolean(snapshot?.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'idle' && this.interaction.getSnapshot().menuScreen === 'closed' &&
      !this.stopConfirmationOpen && this.catalogDialogMode === 'closed'))
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || event.isComposing) return
    // Ctrl/Command+R is not a Standalone command; suppress Chromium's reload shortcut even when an input owns focus.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    const storageModal = document.getElementById('storage-recovery-modal')
    if (storageModal && !storageModal.hidden && !this.stopConfirmationOpen && this.interaction.getSnapshot().menuScreen !== 'exit-confirmation') {
      if (event.ctrlKey && event.code === 'Space') {
        event.preventDefault(); event.stopImmediatePropagation(); this.dispatch({ type: 'open-stop-confirmation' }); return
      }
      if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation()
        const buttons = [...storageModal.querySelectorAll<HTMLButtonElement>('button')].filter(b => !b.hidden && !b.disabled)
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
        return
      }
      // Enter/Space retain native focused-button activation; all other app shortcuts stay fenced.
      if (event.key !== 'Enter' && event.code !== 'Space') { event.preventDefault(); event.stopImmediatePropagation() }
      return
    }
    if (this.license.handleKeyDown(event)) return
    if (this.catalogDialogMode !== 'closed') {
      this.handleCatalogDialogKeyDown(event)
      return
    }
    if (!this.stopConfirmationOpen && this.isEditableTarget(event.target)) return
    if (event.repeat) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    const menuScreen = this.interaction.getSnapshot().menuScreen
    if (menuScreen !== 'closed' && !this.stopConfirmationOpen) {
      this.handleMenuKeyDown(event, menuScreen)
      return
    }
    const stroke: StandaloneKeyboardStroke = {
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey
    }
    const result = this.interaction.handleEntryKeyStroke(stroke, this.canSubmit(), this.isCountdownOrCelebration(),
      this.stopConfirmationOpen, this.canUsePlaybackControls(), this.currentTrackInfo.getSnapshot().open,
      this.isCountdownOrCelebration())
    if (result.recognized) {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (result.intent) this.dispatch(result.intent)
    }
  }

  private dispatch(intent: StandalonePlayerInteractionIntent): void {
    if (intent.type === 'show-current-track-info') {
      this.currentTrackInfo.show()
      return
    }
    if (intent.type === 'close-current-track-info') {
      this.currentTrackInfo.close()
      return
    }
    if (intent.type === 'open-stop-confirmation') {
      this.stopConfirmationOpen = true
      this.stopConfirmationStatus = ''
      this.renderStopConfirmation()
      window.requestAnimationFrame(() => document.getElementById('stop-confirmation-cancel')?.focus())
      return
    }
    if (intent.type === 'close-stop-confirmation') {
      this.stopConfirmationOpen = false
      this.stopConfirmationStatus = ''
      this.renderStopConfirmation()
      document.body.focus()
      return
    }
    if (intent.type !== 'player-command') return
    const isStopAll = intent.request.command.type === 'stop-all'
    if (isStopAll) this.renderStopConfirmation()
    void this.transport.dispatch(intent)?.then(reply => {
      if (this.disposed) return
      this.renderSnapshot(reply.envelope)
      if (isStopAll) {
        if (reply.outcome === 'confirmed') {
          this.stopConfirmationOpen = false
          this.stopConfirmationStatus = ''
          this.clearFeedback()
          this.interaction.resetAfterStopAll()
          document.body.focus()
        } else {
          this.stopConfirmationStatus = reply.outcome === 'blocked' || reply.outcome === 'uncertain'
            ? 'Não foi possível confirmar o encerramento.' : ''
        }
        this.renderStopConfirmation()
      }
    }).catch(() => {
      if (this.disposed) return
      // An IPC failure can follow a committed Main-side operation. Keep its identity and mark the result uncertain;
      // never create a new operationId or retry automatically.
      this.interaction.applyCommandOutcome({
        operationId: intent.request.operationId,
        outcome: 'uncertain',
        errorCode: 'PLAYBACK_FAILED'
      })
      if (isStopAll) {
        this.stopConfirmationStatus = 'Não foi possível confirmar o encerramento.'
        this.renderStopConfirmation()
      }
    })
  }

  private readonly onCancelStopConfirmation = (): void => {
    const intent = this.interaction.cancelStopAllConfirmation()
    if (intent) this.dispatch(intent)
  }

  private readonly onConfirmStopAll = (): void => {
    const intent = this.interaction.requestStopAll()
    if (intent) this.dispatch(intent)
  }

  private renderStopConfirmation(): void {
    this.renderStorageRecovery()
    this.syncLicenseVisibility()
    const modal = document.getElementById('standalone-stop-confirmation')
    if (modal) modal.hidden = !this.stopConfirmationOpen
    const pending = this.interaction.getStopAllPending()
    for (const id of ['stop-confirmation-cancel', 'stop-confirmation-confirm']) {
      const button = document.getElementById(id) as HTMLButtonElement | null
      if (button) button.disabled = pending
    }
    const status = document.getElementById('stop-confirmation-status')
    if (status) {
      status.textContent = this.stopConfirmationStatus
      status.hidden = this.stopConfirmationStatus.length === 0
    }
    this.syncPlaybackSurface()
  }

  private renderMenu(menuScreen: StandalonePlayerMenuScreen): void {
    const mainMenu = document.getElementById('standalone-main-menu')
    const commands = document.getElementById('standalone-commands-screen')
    const options = document.getElementById('standalone-options-screen')
    const exitConfirmation = document.getElementById('standalone-exit-confirmation')
    this.renderStorageRecovery()
    const showingExitConfirmation = menuScreen === 'exit-confirmation'
    if (mainMenu) {
      mainMenu.hidden = menuScreen !== 'main' && !showingExitConfirmation
      mainMenu.inert = showingExitConfirmation
      if (showingExitConfirmation) mainMenu.setAttribute('aria-hidden', 'true')
      else mainMenu.removeAttribute('aria-hidden')
    }
    if (commands) commands.hidden = menuScreen !== 'commands'
    if (options) options.hidden = menuScreen !== 'options'
    if (exitConfirmation) exitConfirmation.hidden = !showingExitConfirmation
    for (const id of ['exit-confirmation-cancel', 'exit-confirmation-confirm']) {
      const button = document.getElementById(id) as HTMLButtonElement | null
      if (button) button.disabled = this.exitResolutionPending
    }
    document.body.dataset.menuScreen = menuScreen
    this.syncLicenseVisibility()
    this.syncPlaybackSurface()
    if (menuScreen === this.lastMenuScreen) return

    const previous = this.lastMenuScreen
    this.lastMenuScreen = menuScreen
    window.requestAnimationFrame(() => {
      if (this.disposed || this.interaction.getSnapshot().menuScreen !== menuScreen) return
      if (menuScreen === 'main') {
        const returnTarget = previous === 'exit-confirmation' ? this.exitConfirmationReturnFocus : undefined
        this.exitConfirmationReturnFocus = undefined
        const fallbackId = previous === 'options' ? 'menu-item-options'
          : previous === 'exit-confirmation' ? 'menu-item-commands' : 'menu-item-commands'
        const button = returnTarget instanceof HTMLButtonElement && returnTarget.isConnected && !returnTarget.disabled
          ? returnTarget : document.getElementById(fallbackId) as HTMLButtonElement | null
        if (button && !button.disabled) button.focus()
      } else if (menuScreen === 'exit-confirmation') {
        document.getElementById('exit-confirmation-cancel')?.focus()
      } else if (menuScreen === 'commands') {
        document.getElementById('commands-screen-title')?.focus()
      } else if (menuScreen === 'options') {
        const button = document.getElementById('options-change-folder') as HTMLButtonElement | null
        if (button && !button.disabled) button.focus()
      } else if (menuScreen === 'closed' && previous !== 'closed') {
        this.exitConfirmationReturnFocus = undefined
        // A later user action can focus the idle activation control before this
        // animation frame. Do not steal that focus while returning from a menu.
        if (!document.activeElement?.closest('#standalone-license-controls, #standalone-license-modal')) {
          document.body.focus()
        }
      }
    })
  }

  private async requestExitConfirmationFromMenu(): Promise<void> {
    try {
      const request = await this.api?.requestExitConfirmation()
      if (this.disposed || request?.outcome !== 'pending') return
      this.showExitConfirmation(request.requestId)
    } catch {
      // A failed Main request cannot open a local-only confirmation or imply that exit was authorized.
    }
  }

  private showExitConfirmation(requestId: string): void {
    if (this.disposed || this.exitConfirmationRequestId && this.exitConfirmationRequestId !== requestId) return
    if (!this.exitConfirmationRequestId) {
      const current = this.interaction.getSnapshot().menuScreen
      this.exitConfirmationReturnMenuScreen = current === 'exit-confirmation' ? 'main' : current
      if (current !== 'main') this.exitConfirmationReturnFocus = undefined
      this.exitConfirmationRequestId = requestId
    }
    const current = this.interaction.getSnapshot().menuScreen
    if (current === 'main') this.interaction.selectMenuAction('exit')
    else if (current !== 'exit-confirmation') this.interaction.showExitConfirmation()
  }

  private async resolveExitConfirmation(decision: 'confirm' | 'cancel'): Promise<void> {
    const requestId = this.exitConfirmationRequestId
    if (!requestId || this.exitResolutionPending || this.disposed) return
    this.exitResolutionPending = true
    this.renderMenu(this.interaction.getSnapshot().menuScreen)
    try {
      const result = await this.api?.resolveExitConfirmation({ requestId, decision })
      if (this.disposed) return
      const expectedOutcome = decision === 'confirm' ? 'confirmed' : 'cancelled'
      if (result?.requestId !== requestId || result.outcome !== expectedOutcome) {
        this.exitResolutionPending = false
        this.renderMenu(this.interaction.getSnapshot().menuScreen)
        return
      }
      this.exitConfirmationRequestId = undefined
      this.exitResolutionPending = false
      const intent = this.interaction.resolveExitConfirmation(decision === 'confirm', this.exitConfirmationReturnMenuScreen)
      this.exitConfirmationReturnMenuScreen = 'main'
      if (intent) this.dispatch(intent)
    } catch {
      if (this.disposed) return
      this.exitResolutionPending = false
      this.renderMenu(this.interaction.getSnapshot().menuScreen)
      // Keep the modal and its Main-issued request identity when settlement is uncertain.
    }
  }

  private renderOptionsSnapshot(snapshot: StandalonePlayerOptionsSnapshot): void {
    const folder = document.getElementById('options-video-folder-name')
    if (folder) folder.textContent = snapshot.library.folderName ?? 'Nenhuma pasta selecionada'

    const libraryState = document.getElementById('options-library-state')
    const libraryCount = document.getElementById('options-library-count')
    const libraryUnconfirmed = document.getElementById('options-library-unconfirmed')
    const indexing = document.getElementById('options-library-indexing')
    const refresh = document.getElementById('options-refresh-library') as HTMLButtonElement | null
    const isScanning = snapshot.library.scanStatus === 'scanning'
    const isReady = snapshot.library.scanStatus === 'ready' && snapshot.library.folderName !== null
    const isDegraded = snapshot.library.scanStatus === 'degraded'

    if (libraryState) {
      libraryState.textContent = isDegraded ? 'Pasta indisponível' : 'Pasta disponível'
      libraryState.hidden = !isReady && !isDegraded
      libraryState.classList.toggle('degraded', isDegraded)
    }
    if (libraryCount) {
      libraryCount.textContent = `${new Intl.NumberFormat('pt-BR').format(snapshot.library.indexedFiles ?? 0)} vídeos indexados`
      libraryCount.hidden = !isReady
    }
    if (libraryUnconfirmed) {
      libraryUnconfirmed.textContent = 'A disponibilidade da pasta não pôde ser confirmada.'
      libraryUnconfirmed.hidden = !isDegraded
    }
    if (indexing) indexing.hidden = !isScanning
    if (refresh) refresh.disabled = isScanning || snapshot.library.folderName === null

    const catalogHasData = snapshot.catalog.fileName !== null
    const catalogFile = document.getElementById('options-catalog-file-name')
    const catalogAction = document.getElementById('options-catalog-action-label')
    const catalogState = document.getElementById('options-catalog-state')
    const catalogCount = document.getElementById('options-catalog-count')
    const catalogImportedAt = document.getElementById('options-catalog-imported-at')
    if (catalogFile) catalogFile.textContent = snapshot.catalog.fileName ?? 'Nenhum catálogo importado'
    if (catalogAction) catalogAction.textContent = catalogHasData ? 'Alterar CSV' : 'Importar CSV'
    if (catalogState) {
      catalogState.textContent = 'CSV importado'
      catalogState.hidden = !catalogHasData
    }
    if (catalogCount) {
      catalogCount.replaceChildren()
      if (catalogHasData) {
        const count = document.createElement('strong')
        count.textContent = new Intl.NumberFormat('pt-BR').format(snapshot.catalog.recordCount)
        catalogCount.append(count, document.createTextNode(snapshot.catalog.recordCount === 1
          ? ' música cadastrada' : ' músicas cadastradas'))
      }
      catalogCount.hidden = !catalogHasData
    }
    if (catalogImportedAt) {
      catalogImportedAt.textContent = snapshot.catalog.importedAt
        ? `Última importação: ${formatCatalogImportDate(snapshot.catalog.importedAt)}`
        : ''
      catalogImportedAt.hidden = !catalogHasData || snapshot.catalog.importedAt === null
    }
    const catalogIssues = document.getElementById('options-catalog-issues')
    const catalogIssueCount = document.getElementById('options-catalog-issues-count')
    const catalogImportButton = document.getElementById('options-import-catalog') as HTMLButtonElement | null
    if (catalogIssues) catalogIssues.hidden = snapshot.catalog.importIssueCount === 0
    if (catalogIssueCount) {
      const count = new Intl.NumberFormat('pt-BR').format(snapshot.catalog.importIssueCount)
      catalogIssueCount.textContent = snapshot.catalog.importIssueCount === 1
        ? `${count} registro ignorado —`
        : `${count} registros ignorados —`
    }
    if (catalogImportButton) catalogImportButton.disabled = this.catalogDialogMode === 'confirmation'
  }

  private applyOptionsSnapshot(snapshot: StandalonePlayerOptionsSnapshot): boolean {
    if (!isNewerStandalonePlayerOptionsSnapshot(this.optionsSnapshot, snapshot)) return false
    this.optionsSnapshot = snapshot
    this.renderOptionsSnapshot(snapshot)
    this.renderStorageRecovery()
    return true
  }

  private async runOptionsAction(
    action: () => Promise<StandalonePlayerOptionsActionReply> | undefined,
    operation: 'library' | 'catalog'
  ): Promise<void> {
    if (!this.api) return
    try {
      const pending = action()
      if (!pending) return
      const reply = await pending
      if (this.disposed) return
      const snapshotApplied = this.applyOptionsSnapshot(reply.snapshot)
      if (reply.outcome === 'confirmation-required' && reply.confirmation) {
        this.openCatalogConfirmation(reply.confirmation)
        return
      }
      if (reply.outcome === 'cancelled' || reply.outcome === 'confirmed') {
        if (snapshotApplied && operation === 'library' && reply.outcome === 'confirmed' &&
            reply.snapshot.library.scanStatus === 'degraded') {
          this.showOptionsToast('A pasta não está acessível. A configuração foi mantida; tente atualizar ou escolher outra pasta.', 'error')
        }
        return
      }
      const message = reply.code === 'PLAYER_NOT_IDLE'
        ? 'Só é possível alterar a biblioteca com o Player ocioso.'
        : reply.code === 'LIBRARY_BUSY'
          ? 'A biblioteca está sendo atualizada. Tente novamente ao final.'
          : reply.code === 'OPTIONS_BUSY'
            ? 'Já existe uma operação de catálogo em andamento.'
            : reply.code === 'CATALOG_IMPORT_FAILED'
              ? 'Não foi possível importar o CSV. O catálogo anterior foi mantido.'
              : 'Não foi possível atualizar a biblioteca.'
      this.showOptionsToast(message, 'error')
    } catch {
      if (!this.disposed) this.showOptionsToast('Não foi possível concluir a operação.', 'error')
    }
  }

  private openCatalogConfirmation(confirmation: NonNullable<StandalonePlayerOptionsActionReply['confirmation']>): void {
    this.catalogConfirmation = { ...confirmation }
    this.catalogConfirmationBusy = false
    this.catalogDialogStatus = ''
    this.catalogDialogMode = 'confirmation'
    this.catalogDialogReturnFocus = document.getElementById('options-import-catalog') ?? undefined
    this.renderCatalogDialog()
    this.syncPlaybackSurface()
    window.requestAnimationFrame(() => document.getElementById('options-catalog-dialog-cancel')?.focus())
  }

  private async confirmCatalogImport(): Promise<void> {
    const confirmation = this.catalogConfirmation
    if (!confirmation || this.catalogConfirmationBusy || !this.api) return
    this.catalogConfirmationBusy = true
    this.catalogDialogStatus = 'Importando os registros válidos…'
    this.renderCatalogDialog()
    try {
      const reply = await this.api.confirmMusicCatalogImport(confirmation.token)
      if (this.disposed) return
      this.applyOptionsSnapshot(reply.snapshot)
      if (reply.outcome === 'confirmed') {
        this.catalogConfirmation = undefined
        this.catalogConfirmationBusy = false
        this.closeCatalogDialog(false)
        return
      }
      if (reply.code === 'CATALOG_CONFIRMATION_STALE') {
        this.catalogConfirmation = undefined
        this.catalogConfirmationBusy = false
        this.closeCatalogDialog(false)
        this.showOptionsToast('O catálogo mudou durante a confirmação. Revise o estado atual antes de importar novamente.', 'error')
        return
      }
      this.catalogDialogStatus = 'Não foi possível salvar o catálogo. O catálogo anterior foi mantido; você pode tentar novamente ou cancelar.'
    } catch {
      if (!this.disposed) this.catalogDialogStatus = 'Não foi possível confirmar a importação. O catálogo anterior foi mantido; tente novamente ou cancele.'
    } finally {
      if (!this.disposed) {
        this.catalogConfirmationBusy = false
        this.renderCatalogDialog()
      }
    }
  }

  private async openCatalogIssues(): Promise<void> {
    const revision = this.optionsSnapshot?.catalog.revision
    if (!this.api || !revision || this.catalogDialogMode !== 'closed') return
    this.catalogDialogMode = 'issues'
    this.catalogConfirmation = undefined
    this.catalogIssuesPageNumber = 0
    this.catalogIssuesPage = undefined
    this.catalogDialogStatus = 'Carregando problemas…'
    this.catalogDialogReturnFocus = document.getElementById('options-catalog-view-issues') ?? undefined
    this.renderCatalogDialog()
    this.syncPlaybackSurface()
    window.requestAnimationFrame(() => document.getElementById('options-catalog-dialog-cancel')?.focus())
    await this.loadCatalogIssuesPage(0, revision, this.optionsSnapshot?.catalog.importGeneration)
  }

  private async loadCatalogIssuesPage(pageNumber: number, expectedRevision?: string, expectedGeneration?: number): Promise<void> {
    if (!this.api || this.catalogDialogMode !== 'issues' || !Number.isSafeInteger(pageNumber) || pageNumber < 0) return
    const revision = expectedRevision ?? this.optionsSnapshot?.catalog.revision
    const reportGeneration = expectedGeneration ?? this.optionsSnapshot?.catalog.importGeneration
    if (!revision || reportGeneration === undefined) return
    const requestGeneration = ++this.catalogIssuesRequestGeneration
    this.catalogDialogStatus = 'Carregando problemas…'
    this.renderCatalogDialog()
    try {
      const page = await this.api.getCatalogImportIssuesPage(revision, reportGeneration,
        pageNumber * CATALOG_ISSUES_PAGE_SIZE)
      if (this.disposed || requestGeneration !== this.catalogIssuesRequestGeneration || this.catalogDialogMode !== 'issues') return
      if (page.catalogRevision !== revision || page.generation !== reportGeneration ||
          this.optionsSnapshot?.catalog.revision !== revision ||
          this.optionsSnapshot?.catalog.importGeneration !== reportGeneration) {
        this.closeCatalogDialog(false)
        this.showOptionsToast('O catálogo foi atualizado. Abra novamente os problemas da importação atual.', 'error')
        return
      }
      this.catalogIssuesPage = page
      this.catalogIssuesPageNumber = pageNumber
      this.catalogDialogStatus = page.total === 0 ? 'Não há problemas registrados para este catálogo.' : ''
    } catch {
      if (!this.disposed && requestGeneration === this.catalogIssuesRequestGeneration) {
        this.catalogDialogStatus = 'Não foi possível carregar os problemas deste catálogo.'
      }
    }
    if (!this.disposed) this.renderCatalogDialog()
  }

  private renderCatalogDialog(): void {
    const dialog = document.getElementById('options-catalog-dialog')
    const title = document.getElementById('options-catalog-dialog-title')
    const description = document.getElementById('options-catalog-dialog-description')
    const summary = document.getElementById('options-catalog-confirmation-summary')
    const status = document.getElementById('options-catalog-dialog-status')
    const listWrap = document.getElementById('options-catalog-issues-list-wrap')
    const list = document.getElementById('options-catalog-issues-list')
    const actions = document.getElementById('options-catalog-dialog-actions')
    const close = document.getElementById('options-catalog-dialog-cancel') as HTMLButtonElement | null
    const confirm = document.getElementById('options-catalog-dialog-confirm') as HTMLButtonElement | null
    const previous = document.getElementById('options-catalog-issues-previous') as HTMLButtonElement | null
    const next = document.getElementById('options-catalog-issues-next') as HTMLButtonElement | null
    const pageLabel = document.getElementById('options-catalog-issues-page')
    const isConfirmation = this.catalogDialogMode === 'confirmation'
    const isIssues = this.catalogDialogMode === 'issues'
    if (dialog) dialog.hidden = !isConfirmation && !isIssues
    if (title) title.textContent = isConfirmation ? 'Substituir catálogo?' : 'Problemas na importação'
    if (description) {
      description.textContent = isConfirmation
        ? 'O catálogo anterior só será substituído depois da sua confirmação. Cancelar mantém os dados atuais.'
        : ` ${new Intl.NumberFormat('pt-BR').format(this.catalogIssuesPage?.total ?? this.optionsSnapshot?.catalog.importIssueCount ?? 0)} ${
          (this.catalogIssuesPage?.total ?? this.optionsSnapshot?.catalog.importIssueCount ?? 0) === 1
            ? 'registro foi ignorado durante a importação.' : 'registros foram ignorados durante a importação.'}`.trim()
    }
    const confirmation = this.catalogConfirmation
    if (summary) {
      summary.hidden = !isConfirmation || !confirmation
      summary.textContent = confirmation
        ? `${new Intl.NumberFormat('pt-BR').format(confirmation.recordCount)} músicas válidas serão importadas e ${new Intl.NumberFormat('pt-BR').format(confirmation.issueCount)} ${confirmation.issueCount === 1 ? 'registro será ignorado' : 'registros serão ignorados'}. ${confirmation.currentRecordCount > 0
          ? `O catálogo atual, com ${new Intl.NumberFormat('pt-BR').format(confirmation.currentRecordCount)} ${confirmation.currentRecordCount === 1 ? 'música' : 'músicas'}, será substituído.`
          : 'Um novo catálogo será criado.'}`
        : ''
    }
    if (status) {
      status.textContent = this.catalogDialogStatus
      status.hidden = this.catalogDialogStatus.length === 0
    }
    if (listWrap) listWrap.hidden = !isIssues || !this.catalogIssuesPage || this.catalogIssuesPage.total === 0
    if (list) {
      list.replaceChildren()
      for (const issue of this.catalogIssuesPage?.issues ?? []) {
        const item = document.createElement('li')
        item.className = 'catalog-issue-item'
        const line = document.createElement('div')
        line.textContent = `Linha ${issue.rowNumber}`
        const field = document.createElement('div')
        field.textContent = `Campo: ${issue.field}`
        const value = document.createElement('div')
        value.textContent = `Valor: ${issue.value}`
        const reason = document.createElement('div')
        reason.textContent = `Motivo: ${issue.reason}`
        item.append(line, field, value, reason)
        list.append(item)
      }
    }
    const total = this.catalogIssuesPage?.total ?? 0
    const pageCount = Math.max(1, Math.ceil(total / CATALOG_ISSUES_PAGE_SIZE))
    if (pageLabel) {
      const first = total === 0 ? 0 : this.catalogIssuesPageNumber * CATALOG_ISSUES_PAGE_SIZE + 1
      const last = Math.min(total, (this.catalogIssuesPageNumber + 1) * CATALOG_ISSUES_PAGE_SIZE)
      pageLabel.textContent = total === 0 ? '' : `Registros ${first}–${last} de ${new Intl.NumberFormat('pt-BR').format(total)}`
    }
    if (previous) previous.disabled = !isIssues || this.catalogIssuesPageNumber <= 0 || this.catalogDialogStatus.length > 0
    if (next) next.disabled = !isIssues || this.catalogIssuesPageNumber + 1 >= pageCount || this.catalogDialogStatus.length > 0
    if (previous) previous.hidden = !isIssues
    if (next) next.hidden = !isIssues
    if (pageLabel) pageLabel.hidden = !isIssues
    if (actions) actions.classList.toggle('catalog-confirmation-actions', isConfirmation)
    if (close) {
      close.textContent = isConfirmation ? 'Cancelar' : 'Fechar'
      close.disabled = this.catalogConfirmationBusy
    }
    if (confirm) {
      confirm.hidden = !isConfirmation
      confirm.disabled = this.catalogConfirmationBusy
      confirm.textContent = this.catalogConfirmationBusy ? 'Importando…' : 'Importar válidas'
    }
    const importButton = document.getElementById('options-import-catalog') as HTMLButtonElement | null
    if (importButton) importButton.disabled = isConfirmation
  }

  private closeCatalogDialog(cancelPending: boolean): void {
    if (this.catalogDialogMode === 'closed' || (this.catalogConfirmationBusy && cancelPending)) return
    const token = cancelPending && this.catalogDialogMode === 'confirmation'
      ? this.catalogConfirmation?.token : undefined
    this.catalogIssuesRequestGeneration++
    this.catalogDialogMode = 'closed'
    this.catalogConfirmation = undefined
    this.catalogConfirmationBusy = false
    this.catalogDialogStatus = ''
    this.catalogIssuesPage = undefined
    this.renderCatalogDialog()
    this.syncPlaybackSurface()
    if (token) void this.api?.cancelMusicCatalogImport(token).catch(() => undefined)
    const restore = this.catalogDialogReturnFocus
    this.catalogDialogReturnFocus = undefined
    window.requestAnimationFrame(() => {
      if (!this.disposed && restore?.isConnected) restore.focus()
    })
  }

  private handleCatalogDialogKeyDown(event: KeyboardEvent): void {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.repeat) return
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (this.catalogConfirmationBusy) {
        this.catalogDialogStatus = 'A importação já está sendo confirmada.'
        this.renderCatalogDialog()
      } else {
        this.closeCatalogDialog(true)
      }
      return
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const focusable = [...(document.getElementById('options-catalog-dialog')
        ?.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])') ?? [])]
      if (focusable.length === 0) return
      const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current === focusable.length - 1 ? 0 : current + 1)
      focusable[next].focus()
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLButtonElement && !event.target.disabled) {
      event.target.click()
    }
  }

  private showOptionsToast(message: string, kind: 'error'): void {
    this.showToast('options-toast', message, kind)
  }

  private showQueueLimitToast(): void {
    this.showToast('queue-limit-toast', 'Fila cheia. O limite é de 30 músicas aguardando.', 'info')
  }

  private showToast(toastId: 'options-toast' | 'queue-limit-toast', message: string, kind: 'error' | 'info'): void {
    const toast = document.getElementById(toastId)
    const text = toast?.querySelector('span')
    if (!toast || !text) return
    this.clearOptionsToastTimer()
    for (const otherId of ['options-toast', 'queue-limit-toast'] as const) {
      if (otherId !== toastId) {
        const otherToast = document.getElementById(otherId)
        if (otherToast) otherToast.hidden = true
      }
    }
    toast.dataset.kind = kind
    text.textContent = message
    toast.hidden = false
    const generation = this.optionsToastGeneration
    this.optionsToastTimer = window.setTimeout(() => {
      if (this.disposed || generation !== this.optionsToastGeneration) return
      toast.hidden = true
      this.optionsToastTimer = undefined
      this.optionsToastGeneration++
    }, TEMPORARY_FEEDBACK_MS)
  }

  private clearOptionsToastTimer(): void {
    this.optionsToastGeneration++
    if (this.optionsToastTimer !== undefined) window.clearTimeout(this.optionsToastTimer)
    this.optionsToastTimer = undefined
  }

  private clearOptionsToast(): void {
    this.clearOptionsToastTimer()
    for (const toastId of ['options-toast', 'queue-limit-toast'] as const) {
      const toast = document.getElementById(toastId)
      if (toast) toast.hidden = true
    }
  }

  private handleMenuKeyDown(event: KeyboardEvent, menuScreen: StandalonePlayerMenuScreen): void {
    event.preventDefault()
    event.stopImmediatePropagation()

    if (menuScreen === 'exit-confirmation') {
      this.handleExitConfirmationKeyDown(event)
      return
    }

    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const result = this.interaction.handleEntryKeyStroke({
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey
      }, this.canSubmit(), this.isCountdownOrCelebration(), false, this.canUsePlaybackControls(),
      this.currentTrackInfo.getSnapshot().open)
      if (result.intent) this.dispatch(result.intent)
      return
    }

    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
        !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      this.moveMenuFocus(event.key === 'ArrowDown' ? 1 : -1, menuScreen)
      return
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      this.moveMenuFocus(event.shiftKey ? -1 : 1, menuScreen)
      return
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const active = document.activeElement
      if (active instanceof HTMLButtonElement && !active.disabled &&
          (active.closest('[data-menu-screen="main"]') || active.closest('#standalone-options-screen'))) {
        active.click()
      }
    }
  }

  private handleExitConfirmationKeyDown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key === 'Escape') {
      this.onCancelExitConfirmation()
      return
    }
    if (event.key === 'Enter') {
      this.onConfirmExitConfirmation()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = [...(document.getElementById('standalone-exit-confirmation')
      ?.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])') ?? [])]
    if (focusable.length === 0) return
    const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.shiftKey
      ? (current <= 0 ? focusable.length - 1 : current - 1)
      : (current < 0 || current === focusable.length - 1 ? 0 : current + 1)
    focusable[next].focus()
  }

  private getMenuFocusableElements(menuScreen: StandalonePlayerMenuScreen): HTMLButtonElement[] {
    const selector = menuScreen === 'main'
      ? '#standalone-main-menu button:not(:disabled)'
      : menuScreen === 'options'
        ? '#standalone-options-screen button:not(:disabled)'
        : '#standalone-commands-screen button:not(:disabled)'
    return [...document.querySelectorAll<HTMLButtonElement>(selector)]
  }

  private moveMenuFocus(direction: -1 | 1, menuScreen: StandalonePlayerMenuScreen): void {
    const focusable = this.getMenuFocusableElements(menuScreen)
    if (focusable.length === 0) {
      document.getElementById(menuScreen === 'main' ? 'main-menu-dialog'
        : menuScreen === 'options' ? 'options-screen-title' : 'commands-screen-title')?.focus()
      return
    }
    const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
    const next = current < 0 ? 0 : (current + direction + focusable.length) % focusable.length
    focusable[next].focus()
  }

  private readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.license.dispose()
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('pagehide', this.dispose)
    document.getElementById('stop-confirmation-cancel')?.removeEventListener('click', this.onCancelStopConfirmation)
    document.getElementById('stop-confirmation-confirm')?.removeEventListener('click', this.onConfirmStopAll)
    document.getElementById('menu-item-commands')?.removeEventListener('click', this.onOpenMenuCommands)
    document.getElementById('menu-item-options')?.removeEventListener('click', this.onOpenMenuOptions)
    document.getElementById('menu-item-exit')?.removeEventListener('click', this.onOpenMenuExit)
    document.getElementById('exit-confirmation-cancel')?.removeEventListener('click', this.onCancelExitConfirmation)
    document.getElementById('exit-confirmation-confirm')?.removeEventListener('click', this.onConfirmExitConfirmation)
    document.getElementById('options-change-folder')?.removeEventListener('click', this.onChangeVideoFolder)
    document.getElementById('options-refresh-library')?.removeEventListener('click', this.onRefreshVideoLibrary)
    document.getElementById('options-import-catalog')?.removeEventListener('click', this.onImportMusicCatalog)
    this.unsubscribeInteraction()
    this.unsubscribeMetadata()
    this.unsubscribeTransitionMetadata()
    this.unsubscribeCurrentTrackInfo()
    this.unsubscribeCatalogRevision()
    this.unsubscribeOptions()
    this.unsubscribeExitConfirmation()
    this.interaction.dispose()
    this.metadata.dispose()
    this.transitionMetadata.dispose()
    this.currentTrackInfo.dispose()
    this.cancelFeedbackTimer()
    this.cancelResumeFeedbackTimer()
    this.clearOptionsToast()
    const subscription = this.snapshotSubscription
    this.snapshotSubscription = undefined
    if (subscription) void this.api?.unsubscribe(subscription).catch(() => undefined)
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
  }

  private renderEntry(panelOpen: boolean, code: string): void {
    const playingPanel = document.getElementById('standalone-playing-panel')
    if (playingPanel) playingPanel.hidden = !this.isActivePlayback() || !panelOpen
    const showInput = panelOpen && code.length > 0
    for (const id of ['idle-code-digits', 'playing-code-digits']) {
      const digits = document.getElementById(id)
      if (!digits) continue
      const displayed = code.length > 0 ? [...code] : ['—', '—', '—', '—', '—']
      digits.classList.toggle('has-value', code.length > 0)
      digits.replaceChildren()
      displayed.forEach((value, index) => {
        const span = document.createElement('span')
        span.textContent = value
        digits.append(span)
        if (index < displayed.length - 1) digits.append(document.createTextNode(' '))
      })
      digits.setAttribute('aria-label', showInput ? `Código digitado: ${code}` : 'Nenhum código digitado')
    }
  }

  private renderMetadata(preview: StandaloneMetadataPreviewSnapshot): void {
    this.setMetadataValue('idle-title', preview.title)
    this.setMetadataValue('idle-artist', preview.artist)
    this.setMetadataValue('playing-title', preview.title)
    this.setMetadataValue('playing-artist', preview.artist)
  }

  private setMetadataValue(id: string, value: string | null): void {
    const element = document.getElementById(id)
    if (!element) return
    const available = value !== null && value.length > 0
    element.textContent = available ? value : '—'
    element.classList.toggle('empty', !available)
  }

  private async storageAction(type: 'recover-storage' | 'discard-interrupted'): Promise<void> {
    if (!this.api || this.storageActionPending) return
    this.storageActionPending = true; this.storageStatus = 'Verificando contenção e arquivo…'; this.renderStorageRecovery()
    try {
      const reply = await this.api.execute({ operationId: crypto.randomUUID(), command: { type } })
      this.renderSnapshot(reply.envelope)
      this.storageStatus = reply.outcome === 'confirmed' ? '' : 'Não foi possível recuperar. O arquivo pode estar ausente, inacessível ou ter sido substituído. A fila foi mantida.'
    } catch { this.storageStatus = 'Não foi possível confirmar a operação. A recuperação permanece protegida.' }
    finally { this.storageActionPending = false; this.renderStorageRecovery() }
  }

  private renderStorageRecovery(): void {
    const modal = document.getElementById('storage-recovery-modal')
    if (!modal) return
    const snapshot = this.latestSnapshot?.snapshot
    const recovery = snapshot?.storageRecovery
    const degraded = this.optionsSnapshot?.library.scanStatus === 'degraded'
    if (!degraded) this.storageDismissed = false
    const informational = !recovery && degraded && snapshot?.playbackCondition === 'ready' && snapshot.state.operationalState === 'idle' && !this.storageDismissed
    const show = Boolean(recovery || informational) && !this.stopConfirmationOpen && this.interaction.getSnapshot().menuScreen !== 'exit-confirmation'
    const opening = modal.hidden && show
    modal.hidden = !show
    const title = document.getElementById('storage-recovery-title')!
    title.textContent = recovery ? 'Reprodução interrompida — recuperação' : 'Biblioteca indisponível'
    const copy = document.getElementById('storage-recovery-copy')!
    const code = snapshot?.playbackCondition === 'blocked' || snapshot?.playbackCondition === 'uncertain' ? snapshot.error.code : ''
    const reason = code === 'MEDIA_CHANGED' ? 'O arquivo foi substituído. ' : code === 'MEDIA_STALLED'
      ? 'A mídia deixou de avançar por 15 segundos. ' : code === 'MEDIA_LOAD_FAILED'
      ? 'Falha na leitura ou carregamento do vídeo. ' : 'O acesso seguro à mídia não pôde ser confirmado. '
    copy.textContent = recovery ? `${reason}${recovery.available ? 'A biblioteca está acessível. ' : 'A biblioteca está indisponível. '}${recovery.wasPaused ? 'A música estava pausada por você. ' : ''}${recovery.contained ? '' : 'A contenção da mídia ainda não foi confirmada. '}${recovery.target ? 'A música foi preservada. ' : 'A tentativa atual foi encerrada. ' }As demais músicas e prioridades foram mantidas nesta sessão. A posição não pode ser restaurada com segurança; a recuperação reinicia do início. Nada será reproduzido automaticamente.`
      : 'Não foi possível acessar a biblioteca. Configuração e índice foram preservados. Reconecte o armazenamento; nenhuma música será iniciada automaticamente.'
    const retry = document.getElementById('storage-recovery-retry') as HTMLButtonElement
    const discard = document.getElementById('storage-recovery-discard') as HTMLButtonElement
    retry.hidden = discard.hidden = !recovery
    retry.disabled = this.storageActionPending || !recovery?.contained || !recovery?.available
    discard.disabled = this.storageActionPending || !recovery?.contained || !recovery?.target
    retry.textContent = recovery?.target ? 'Reiniciar música do início' : 'Iniciar próxima música'
    document.getElementById('storage-recovery-dismiss')!.hidden = !informational
    document.getElementById('storage-recovery-status')!.textContent = this.storageStatus
    if (opening) requestAnimationFrame(() => {
      if (!modal.hidden) ((modal.querySelector('button:not([hidden]):not(:disabled)') as HTMLElement) ?? modal).focus()
    })
  }

  private renderSnapshot(envelope: StandalonePlayerSnapshotEnvelope): void {
    if (this.disposed) return
    if (this.latestSnapshot && envelope.revision < this.latestSnapshot.revision) return
    const previousState = this.latestSnapshot
      ? this.latestSnapshot.snapshot.playbackCondition === 'ready'
        ? this.latestSnapshot.snapshot.state
        : this.latestSnapshot.snapshot.lastConfirmedState
      : undefined
    const previousPhase = this.latestSnapshot?.snapshot.playbackCondition === 'transitioning'
      ? this.latestSnapshot.snapshot.phase : undefined
    this.latestSnapshot = envelope
    this.renderStorageRecovery()
    const snapshot = envelope.snapshot
    this.currentTrackInfo.setCurrentTrack(currentTrackFromSnapshot(snapshot))
    const state = snapshot.playbackCondition === 'ready' ? snapshot.state : snapshot.lastConfirmedState
    const isPlaying = state.operationalState === 'playing' || state.operationalState === 'paused'
    const transition = snapshot.playbackCondition === 'transitioning' ? snapshot : undefined
    const resumeConfirmedFromPaused = snapshot.playbackCondition === 'ready' &&
      state.operationalState === 'playing' && previousState?.operationalState === 'paused' &&
      previousState.current?.entryId === state.current?.entryId &&
      previousState.current?.attemptId === state.current?.attemptId
    const countdown = transition?.phase === 'countdown' ? transition : undefined
    const loading = transition?.phase === 'loading' ? transition : undefined
    const celebration = transition?.phase === 'celebration' ? transition : undefined
    const transitionTarget = countdown?.target ?? loading?.target
    if ((previousState?.operationalState === 'idle' && state.operationalState === 'playing') ||
        (previousPhase === 'celebration' && !celebration)) {
      this.interaction.closeNumericEntry()
    }
    const idlePanel = document.getElementById('standalone-idle-panel')
    const playingPanel = document.getElementById('standalone-playing-panel')
    const idleArt = document.getElementById('standalone-idle-art')
    const countdownPanel = document.getElementById('standalone-countdown')
    const loadingPanel = document.getElementById('standalone-loading')
    const celebrationPanel = document.getElementById('standalone-celebration')
    const pausedIndicator = document.getElementById('standalone-paused-indicator')
    const resumeIndicator = document.getElementById('standalone-resuming-indicator')
    const isInitialTransition = Boolean(countdown || loading)
    if (idlePanel) idlePanel.hidden = isPlaying || isInitialTransition
    if (playingPanel) playingPanel.hidden = !isPlaying || !this.interaction.getSnapshot().numericPanelOpen
    if (idleArt) idleArt.hidden = isPlaying || isInitialTransition
    this.syncLicenseVisibility()
    if (countdownPanel) countdownPanel.hidden = !countdown
    if (loadingPanel) loadingPanel.hidden = !loading
    if (celebrationPanel) celebrationPanel.hidden = !celebration
    if (transition?.phase === 'resuming') {
      this.cancelResumeFeedbackTimer()
      if (resumeIndicator) {
        resumeIndicator.hidden = false
        delete resumeIndicator.dataset.confirmed
      }
    } else if (previousPhase === 'resuming' || resumeConfirmedFromPaused) {
      if (snapshot.playbackCondition === 'ready' && state.operationalState === 'playing') {
        if (resumeIndicator) {
          resumeIndicator.hidden = false
          resumeIndicator.dataset.confirmed = 'true'
        }
        this.armResumeFeedbackTimer()
      } else {
        this.cancelResumeFeedbackTimer()
        if (resumeIndicator) {
          resumeIndicator.hidden = true
          delete resumeIndicator.dataset.confirmed
        }
      }
    } else if (state.operationalState === 'paused') {
      this.cancelResumeFeedbackTimer()
      if (resumeIndicator) {
        resumeIndicator.hidden = true
        delete resumeIndicator.dataset.confirmed
      }
    } else if (state.operationalState !== 'playing') {
      this.cancelResumeFeedbackTimer()
      if (resumeIndicator) {
        resumeIndicator.hidden = true
        delete resumeIndicator.dataset.confirmed
      }
    }
    if (pausedIndicator) pausedIndicator.hidden = state.operationalState !== 'paused' || transition?.phase === 'resuming'
    this.renderQueueProjection()
    if (countdown) this.renderCountdown(countdown)
    if (celebration) this.renderCelebration(celebration)
    this.transitionMetadata.updateTarget(transitionTarget)
    if (countdownPanel) countdownPanel.dataset.paused = countdown?.paused === true ? 'true' : 'false'
    if (celebrationPanel) celebrationPanel.dataset.paused = celebration?.paused === true ? 'true' : 'false'
    document.body.dataset.transitionPhase = transition?.phase ?? 'none'
    document.body.dataset.operationalState = state.operationalState
    this.renderFeedback(this.feedbackStatus)
    this.renderStopConfirmation()
    this.syncPlaybackSurface()
  }

  private syncPlaybackSurface(updateBounds = false): void {
    const api = this.api
    if (!api) return
    const snapshot = this.latestSnapshot?.snapshot
    const state = snapshot?.playbackCondition === 'ready' ? snapshot.state : snapshot?.lastConfirmedState
    // Playback and controls share one document. Dialogs and panels overlay that
    // compositor; they must never detach or hide the active MP4.
    const shouldShow = state !== undefined &&
      (state.operationalState === 'playing' || state.operationalState === 'paused')

    if (!shouldShow) {
      if (this.playbackSurfaceVisible) {
        this.playbackSurfaceVisible = false
        this.playbackSurfaceGeneration++
        void api.hidePlaybackSurface().catch(() => undefined)
      }
      return
    }
    if (this.playbackSurfaceVisible && !updateBounds) return
    this.playbackSurfaceVisible = true
    const generation = ++this.playbackSurfaceGeneration
    const stage = document.getElementById('playback-stage')
    if (!stage) return
    const bounds = stage.getBoundingClientRect()
    void api.showPlaybackSurface({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height
    }).then(shown => {
      if (this.disposed || generation !== this.playbackSurfaceGeneration) return
      if (!shown) this.playbackSurfaceVisible = false
    }).catch(() => {
      if (generation === this.playbackSurfaceGeneration) this.playbackSurfaceVisible = false
    })
  }

  private renderQueue(entries: readonly { readonly musicCode: string }[]): void {
    const windowElement = document.getElementById('standalone-queue-window')
    if (!windowElement) return
    const codes = entries.slice(0, 5).map(entry => entry.musicCode.replace(/^0+(?=\d)/, ''))
    const track = document.createElement('div')
    track.className = 'queue-track'
    track.dataset.count = String(codes.length)
    track.setAttribute('aria-label', `Próximas músicas: ${codes.join(', ')}`)
    codes.forEach((code, index) => {
      const value = document.createElement('span')
      value.className = 'queue-code'
      value.textContent = code
      track.append(value)
      if (index < codes.length - 1) {
        const separator = document.createElement('i')
        separator.className = 'queue-separator'
        separator.setAttribute('aria-hidden', 'true')
        track.append(separator)
      }
    })
    windowElement.replaceChildren(track)
  }

  private renderQueueProjection(): void {
    const queuePanel = document.getElementById('standalone-queue')
    const snapshot = this.latestSnapshot?.snapshot
    if (!queuePanel || !snapshot) {
      if (queuePanel) queuePanel.hidden = true
      return
    }

    const state = snapshot.playbackCondition === 'ready' ? snapshot.state : snapshot.lastConfirmedState
    const pendingEntries = snapshot.playbackCondition === 'ready' ? snapshot.state.pending : snapshot.pending
    // Keep the hidden projection current too: numeric-entry visibility must not
    // discard a queue update while Main snapshots continue arriving.
    this.renderQueue(pendingEntries)

    const resumeIndicator = document.getElementById('standalone-resuming-indicator')
    const visible = snapshot.playbackCondition === 'ready' && state.operationalState === 'playing' &&
      pendingEntries.length > 0 && !this.interaction.getSnapshot().numericPanelOpen &&
      !this.currentTrackInfo.getSnapshot().open && resumeIndicator?.hidden !== false
    queuePanel.hidden = !visible
    if (visible) this.updateQueueGlide()
  }

  private updateQueueGlide(): void {
    const windowElement = document.getElementById('standalone-queue-window')
    const track = windowElement?.querySelector<HTMLElement>('.queue-track')
    if (!windowElement || !track) return
    const style = window.getComputedStyle(windowElement)
    const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
    const availableWidth = Math.max(0, windowElement.clientWidth - horizontalPadding)
    const safeTravel = Math.max(0, availableWidth - track.getBoundingClientRect().width)
    track.style.setProperty('--queue-glide-start', `${Math.min(8, safeTravel)}px`)
    track.style.setProperty('--queue-glide-end', `${Math.min(78, safeTravel)}px`)
  }

  private armResumeFeedbackTimer(): void {
    this.cancelResumeFeedbackTimer()
    const generation = this.resumeFeedbackGeneration
    this.resumeFeedbackTimer = window.setTimeout(() => {
      if (this.disposed || generation !== this.resumeFeedbackGeneration) return
      this.resumeFeedbackTimer = undefined
      this.resumeFeedbackGeneration++
      const indicator = document.getElementById('standalone-resuming-indicator')
      if (indicator) {
        indicator.hidden = true
        delete indicator.dataset.confirmed
      }
      if (this.latestSnapshot) this.renderSnapshot(this.latestSnapshot)
    }, 1_500)
  }

  private cancelResumeFeedbackTimer(): void {
    this.resumeFeedbackGeneration++
    if (this.resumeFeedbackTimer !== undefined) window.clearTimeout(this.resumeFeedbackTimer)
    this.resumeFeedbackTimer = undefined
  }

  private renderCountdown(snapshot: Extract<StandaloneTransitioningSnapshot, { phase: 'countdown' }>): void {
    const seconds = Math.ceil(snapshot.remainingMs / 1000)
    const number = document.getElementById('countdown-number')
    const ring = document.getElementById('countdown-ring')
    if (number) number.textContent = String(seconds)
    if (ring) ring.setAttribute('aria-label', `${seconds} segundos restantes${snapshot.paused ? ', pausado' : ''}`)
  }

  private renderCelebration(snapshot: Extract<StandaloneTransitioningSnapshot, { phase: 'celebration' }>): void {
    const seconds = Math.ceil(snapshot.remainingMs / 1000)
    const heading = document.getElementById('celebration-message')
    const continueRow = document.getElementById('celebration-continue')
    const continueText = document.getElementById('celebration-continue-text')
    const footer = document.getElementById('celebration-footer')
    const hasNext = snapshot.pending.length > 0
    if (heading) heading.textContent = snapshot.message
    if (continueRow) continueRow.hidden = !hasNext
    if (continueText) continueText.textContent = snapshot.paused
      ? 'A fila continuará automaticamente'
      : `A fila continuará automaticamente em ${seconds}s`
    if (footer) {
      footer.textContent = snapshot.paused
        ? `Pausado — ${seconds}s restantes`
        : hasNext ? 'Aguarde um instante' : `Voltando ao estado ocioso em ${seconds}s`
    }
    const screen = document.getElementById('standalone-celebration')
    if (screen) {
      screen.dataset.paused = snapshot.paused ? 'true' : 'false'
      screen.setAttribute('aria-label', `Celebração após o término natural da música. ${seconds} segundos restantes${snapshot.paused ? ', temporizador pausado' : ''}`)
    }
  }

  private renderTransitionMetadata(preview: StandaloneTransitionMetadataSnapshot): void {
    const code = preview.code
    if (!code) return
    const displayCode = code.replace(/^0+(?=\d)/, '')
    for (const [titleId, artistId, codeId] of [
      ['countdown-title', 'countdown-artist', 'countdown-code'],
      ['loading-title', 'loading-artist', 'loading-code']
    ]) {
      const title = document.getElementById(titleId)
      const artist = document.getElementById(artistId)
      const codeElement = document.getElementById(codeId)
      if (title) title.textContent = preview.title || 'Dados indisponíveis'
      if (artist) artist.textContent = preview.artist || 'Dados indisponíveis'
      if (codeElement) {
        codeElement.textContent = displayCode
        codeElement.setAttribute('aria-label', `Código ${displayCode}`)
      }
    }
  }

  private renderCurrentTrackInfo(snapshot: StandaloneCurrentTrackInfoSnapshot): void {
    const panel = document.getElementById('standalone-current-track-info')
    if (panel) panel.hidden = !snapshot.open
    const number = document.getElementById('current-track-info-number')
    if (number) {
      const code = snapshot.musicCode.replace(/^0+(?=\d)/, '')
      const displayed = code ? [...code] : []
      number.classList.toggle('has-value', Boolean(snapshot.title || snapshot.artist))
      number.replaceChildren()
      displayed.forEach((digit, index) => {
        const span = document.createElement('span')
        span.textContent = digit
        number.append(span)
        if (index < displayed.length - 1) number.append(document.createTextNode(' '))
      })
      number.setAttribute('aria-label', code ? `Número atual: ${code}` : 'Nenhum número atual')
    }
    const title = document.getElementById('current-track-info-title')
    if (title) title.textContent = snapshot.title || 'Dados indisponíveis'
    const artist = document.getElementById('current-track-info-artist')
    if (artist) artist.textContent = snapshot.artist || 'Dados indisponíveis'
  }

  private canSubmit(): boolean {
    const snapshot = this.latestSnapshot?.snapshot
    // C2 can validate idle media to show an authoritative missing-video result, but Sequence has a Main-side
    // guard that rejects valid idle admissions until C3 supplies the real countdown.
    return snapshot?.playbackCondition === 'ready' ||
      (snapshot?.playbackCondition === 'transitioning' && snapshot.phase === 'celebration' && snapshot.remainingMs > 0)
  }

  private isCountdownOrCelebration(): boolean {
    const snapshot = this.latestSnapshot?.snapshot
    return snapshot?.playbackCondition === 'transitioning' &&
      (snapshot.phase === 'countdown' || snapshot.phase === 'celebration')
  }

  private canUsePlaybackControls(): boolean {
    const snapshot = this.latestSnapshot?.snapshot
    return snapshot?.playbackCondition === 'ready' &&
      (snapshot.state.operationalState === 'playing' || snapshot.state.operationalState === 'paused')
  }

  private isActivePlayback(): boolean {
    const snapshot = this.latestSnapshot?.snapshot
    const state = snapshot?.playbackCondition === 'ready' ? snapshot.state : snapshot?.lastConfirmedState
    return state?.operationalState === 'playing' || state?.operationalState === 'paused'
  }

  private renderFeedback(status: StandaloneCodeSubmissionStatus | undefined): void {
    if (status) {
      this.feedbackStatus = status
      if (status.operationId !== this.feedbackOperationId) {
        this.cancelFeedbackTimer()
        this.feedbackOperationId = status.operationId
        this.feedbackOutcome = 'pending'
        this.feedbackVisible = false
      }
      if (status.outcome !== this.feedbackOutcome) {
        this.feedbackOutcome = status.outcome
        if (status.outcome === 'confirmed') {
          this.feedbackVisible = !this.isActivePlayback() || this.lastNumericPanelOpen
          if (this.feedbackVisible) this.armFeedbackTimer(status.operationId)
        } else if (status.outcome === 'rejected') {
          if (status.errorCode === 'QUEUE_LIMIT_REACHED') {
            this.feedbackVisible = false
            this.showQueueLimitToast()
          }
          // A valid idle submission is intentionally deferred to C3; keep its entry visible without inventing a
          // rejection screen. Physically missing media still receives the approved idle error feedback.
          if (status.errorCode === 'QUEUE_LIMIT_REACHED' || status.errorCode === 'INVALID_STATE' ||
              (this.isActivePlayback() && !this.lastNumericPanelOpen)) this.feedbackVisible = false
          else {
            this.feedbackVisible = true
            this.armFeedbackTimer(status.operationId)
          }
        } else if (status.outcome === 'blocked' || status.outcome === 'uncertain') {
          this.cancelFeedbackTimer()
          this.feedbackVisible = true
        } else {
          this.feedbackVisible = false
        }
      }
    }

    const idle = document.getElementById('idle-feedback')
    const playing = document.getElementById('playing-feedback')
    const active = this.isActivePlayback()
    const visible = Boolean(this.feedbackStatus && this.feedbackVisible &&
      (!active || this.lastNumericPanelOpen))
    if (!visible || !this.feedbackStatus) {
      if (idle) idle.hidden = true
      if (playing) playing.hidden = true
      return
    }
    const target = active ? playing : idle
    const other = active ? idle : playing
    if (other) other.hidden = true
    if (!target) return
    const statusValue = this.feedbackStatus
    const kind = statusValue.outcome === 'confirmed' ? 'success'
      : statusValue.outcome === 'blocked' || statusValue.outcome === 'uncertain' ? 'persistent' : 'error'
    target.dataset.kind = kind
    const message = target.querySelector('span')
    if (message) message.textContent = this.feedbackMessage(statusValue, active)
    target.hidden = false
  }

  private feedbackMessage(status: StandaloneCodeSubmissionStatus, active: boolean): string {
    if (status.outcome === 'confirmed') {
      return status.priority === 'priority'
        ? `Código ${status.enteredCode} priorizado. Será a próxima música após a atual.`
        : `Código ${status.enteredCode} adicionado ao final da sequência.`
    }
    if (status.outcome === 'blocked') return 'A operação foi bloqueada. O estado da reprodução permanece preservado.'
    if (status.outcome === 'uncertain') return 'Resultado da operação não confirmado. O estado atual foi preservado para recuperação.'
    if (status.outcome === 'rejected') {
      if (status.errorCode === 'MEDIA_UNKNOWN') {
        return active
          ? `A disponibilidade do vídeo do código ${status.enteredCode} não pôde ser confirmada. A música atual continua; a fila não muda.`
          : `A disponibilidade do vídeo do código ${status.enteredCode} não pôde ser confirmada.`
      }
      if (active && status.errorCode === 'MEDIA_UNAVAILABLE') {
        return `O vídeo do código ${status.enteredCode} não está disponível. A música atual continua; a fila não muda.`
      }
      if (status.errorCode === 'INVALID_MUSIC_CODE' || status.errorCode === 'MEDIA_UNAVAILABLE') {
        return `Código ${status.enteredCode} não encontrado.`
      }
      return `Não foi possível adicionar o código ${status.enteredCode}.`
    }
    return ''
  }

  private armFeedbackTimer(operationId: string): void {
    this.cancelFeedbackTimer()
    const generation = this.feedbackTimerGeneration
    this.feedbackTimer = window.setTimeout(() => {
      if (this.disposed || generation !== this.feedbackTimerGeneration || this.feedbackOperationId !== operationId) return
      this.feedbackTimer = undefined
      this.feedbackTimerGeneration++
      this.feedbackVisible = false
      this.renderFeedback(this.feedbackStatus)
    }, TEMPORARY_FEEDBACK_MS)
  }

  private cancelFeedbackTimer(): void {
    this.feedbackTimerGeneration++
    if (this.feedbackTimer !== undefined) window.clearTimeout(this.feedbackTimer)
    this.feedbackTimer = undefined
  }

  private clearFeedback(): void {
    this.cancelFeedbackTimer()
    this.feedbackStatus = undefined
    this.feedbackOperationId = undefined
    this.feedbackOutcome = undefined
    this.feedbackVisible = false
    const idle = document.getElementById('idle-feedback')
    const playing = document.getElementById('playing-feedback')
    if (idle) idle.hidden = true
    if (playing) playing.hidden = true
  }
}

function currentTrackFromSnapshot(snapshot: StandalonePlayerSnapshot): StandaloneCurrentTrackIdentity | null {
  if (snapshot.playbackCondition !== 'ready' || snapshot.state.operationalState === 'idle') return null
  return {
    entryId: snapshot.state.current.entryId,
    attemptId: snapshot.state.current.attemptId,
    musicCode: snapshot.state.current.musicCode
  }
}

function formatCatalogImportDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date)
  const now = new Date()
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
    return `Hoje, ${time}`
  }
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

new StandalonePlayerRenderer()
