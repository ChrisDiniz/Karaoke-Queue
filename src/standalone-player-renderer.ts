import type { StandalonePlayerRendererApi, StandalonePlayerSnapshotEnvelope, StandalonePlayerSubscriptionRef } from './standalone-player-ipc-contracts'
import type { StandaloneTransitioningSnapshot } from './standalone-player-contracts'
import { StandalonePlayerInteractionController } from './standalone-player-interaction'
import type { StandaloneCodeSubmissionStatus, StandalonePlayerInteractionIntent } from './standalone-player-interaction'
import { StandalonePlayerInteractionTransport } from './standalone-player-interaction-transport'
import type { StandaloneKeyboardStroke } from './standalone-player-keyboard'
import {
  StandalonePlayerMetadataPreviewController,
  StandaloneTransitionMetadataPreviewController,
  type StandaloneMetadataPreviewSnapshot,
  type StandaloneTransitionMetadataSnapshot
} from './standalone-player-metadata-preview'

declare global {
  interface Window {
    standalonePlayer?: StandalonePlayerRendererApi
  }
}

const ENTRY_PANEL_INACTIVITY_MS = 5_000
const TEMPORARY_FEEDBACK_MS = 3_500

class StandalonePlayerRenderer {
  private readonly api = window.standalonePlayer
  private readonly interaction: StandalonePlayerInteractionController
  private readonly transport: StandalonePlayerInteractionTransport
  private readonly metadata: StandalonePlayerMetadataPreviewController
  private readonly transitionMetadata: StandaloneTransitionMetadataPreviewController
  private readonly unsubscribeInteraction: () => void
  private readonly unsubscribeMetadata: () => void
  private readonly unsubscribeTransitionMetadata: () => void
  private readonly unsubscribeCatalogRevision: () => void
  private readonly onResize = (): void => this.renderQueueProjection()
  private snapshotSubscription: StandalonePlayerSubscriptionRef | undefined
  private latestSnapshot: StandalonePlayerSnapshotEnvelope | undefined
  private lastNumericPanelOpen = false
  private feedbackOperationId: string | undefined
  private feedbackOutcome: StandaloneCodeSubmissionStatus['outcome'] | undefined
  private feedbackVisible = false
  private feedbackTimer: number | undefined
  private feedbackTimerGeneration = 0
  private feedbackStatus: StandaloneCodeSubmissionStatus | undefined
  private stopConfirmationOpen = false
  private stopConfirmationStatus = ''
  private resumeFeedbackTimer: number | undefined
  private resumeFeedbackGeneration = 0
  private disposed = false

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
    this.unsubscribeInteraction = this.interaction.subscribe(snapshot => {
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
      this.renderQueueProjection()
    })
    this.unsubscribeMetadata = this.metadata.subscribe(snapshot => this.renderMetadata(snapshot))
    this.unsubscribeTransitionMetadata = this.transitionMetadata.subscribe(snapshot => this.renderTransitionMetadata(snapshot))
    this.unsubscribeCatalogRevision = this.api.onCatalogRevisionChanged(revision => {
      this.metadata.catalogChanged(revision)
      this.transitionMetadata.catalogChanged(revision)
    })
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('pagehide', this.dispose, { once: true })
    document.getElementById('stop-confirmation-cancel')?.addEventListener('click', this.onCancelStopConfirmation)
    document.getElementById('stop-confirmation-confirm')?.addEventListener('click', this.onConfirmStopAll)
    document.body.focus()
    this.renderEntry(false, '')
    this.renderMetadata(this.metadata.getSnapshot())
    void this.api.subscribe(envelope => this.renderSnapshot(envelope)).then(subscription => {
      if (this.disposed) void this.api?.unsubscribe(subscription)
      else this.snapshotSubscription = subscription
    }).catch(() => undefined)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || event.isComposing) return
    // Ctrl/Command+R is not a Standalone command; suppress Chromium's reload shortcut even when an input owns focus.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (!this.stopConfirmationOpen && this.isEditableTarget(event.target)) return
    if (event.repeat) {
      event.preventDefault()
      event.stopImmediatePropagation()
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
    const result = this.interaction.handleEntryKeyStroke(stroke, this.canSubmit(), this.isInitialCountdown(),
      this.stopConfirmationOpen, this.canUsePlaybackControls())
    if (result.recognized) {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (result.intent) this.dispatch(result.intent)
    }
  }

  private dispatch(intent: StandalonePlayerInteractionIntent): void {
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
  }

  private readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('pagehide', this.dispose)
    document.getElementById('stop-confirmation-cancel')?.removeEventListener('click', this.onCancelStopConfirmation)
    document.getElementById('stop-confirmation-confirm')?.removeEventListener('click', this.onConfirmStopAll)
    this.unsubscribeInteraction()
    this.unsubscribeMetadata()
    this.unsubscribeTransitionMetadata()
    this.unsubscribeCatalogRevision()
    this.interaction.dispose()
    this.metadata.dispose()
    this.transitionMetadata.dispose()
    this.cancelFeedbackTimer()
    this.cancelResumeFeedbackTimer()
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
    const snapshot = envelope.snapshot
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
      pendingEntries.length > 0 && !this.interaction.getSnapshot().numericPanelOpen && resumeIndicator?.hidden !== false
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

  private canSubmit(): boolean {
    const snapshot = this.latestSnapshot?.snapshot
    // C2 can validate idle media to show an authoritative missing-video result, but Sequence has a Main-side
    // guard that rejects valid idle admissions until C3 supplies the real countdown.
    return snapshot?.playbackCondition === 'ready' ||
      (snapshot?.playbackCondition === 'transitioning' && snapshot.phase === 'celebration' && snapshot.remainingMs > 0)
  }

  private isInitialCountdown(): boolean {
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
          // A valid idle submission is intentionally deferred to C3; keep its entry visible without inventing a
          // rejection screen. Physically missing media still receives the approved idle error feedback.
          if (status.errorCode === 'INVALID_STATE' || (this.isActivePlayback() && !this.lastNumericPanelOpen)) this.feedbackVisible = false
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

new StandalonePlayerRenderer()
