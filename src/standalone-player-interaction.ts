import type {
  StandalonePlayerCommand,
  StandalonePlayerCommandRequest,
  StandalonePlayerCommandResult,
  StandalonePlayerErrorCode
} from './standalone-player-contracts'
import {
  interpretStandaloneKeyboardStroke,
  type StandaloneKeyboardStroke
} from './standalone-player-keyboard'

export type StandalonePlayerMenuScreen = 'closed' | 'main' | 'commands' | 'options' | 'exit-confirmation'

export interface StandalonePlayerInteractionSnapshot {
  readonly numericPanelOpen: boolean
  /** Preserves exactly what the operator typed; code resolution belongs to the playback service. */
  readonly enteredCode: string
  readonly menuScreen: StandalonePlayerMenuScreen
  readonly lastSubmission?: StandaloneCodeSubmissionStatus
}

export interface StandaloneCodeSubmissionStatus {
  readonly operationId: string
  readonly enteredCode: string
  readonly priority: 'normal' | 'priority'
  readonly outcome: 'pending' | 'confirmed' | 'rejected' | 'blocked' | 'uncertain'
  readonly errorCode?: StandalonePlayerErrorCode
}

/** Transport-neutral command outcome used to settle an interaction submission. */
export interface StandalonePlayerInteractionCommandOutcome {
  readonly operationId: string
  readonly outcome: 'confirmed' | 'rejected' | 'blocked' | 'uncertain'
  readonly errorCode?: StandalonePlayerErrorCode
}

export type StandalonePlayerMenuAction = 'commands' | 'options' | 'back' | 'exit'

export type StandalonePlayerInteractionIntent =
  | { readonly type: 'player-command'; readonly request: StandalonePlayerCommandRequest }
  | { readonly type: 'show-current-track-info' }
  | { readonly type: 'close-current-track-info' }
  | { readonly type: 'open-stop-confirmation' }
  | { readonly type: 'close-stop-confirmation' }
  /** The future application shell may handle this request after its own exit confirmation flow. */
  | { readonly type: 'request-application-exit' }

export interface StandalonePlayerEntryStrokeResult {
  readonly recognized: boolean
  readonly intent?: StandalonePlayerInteractionIntent
}

export type StandaloneInteractionListener = (snapshot: StandalonePlayerInteractionSnapshot) => void

/** Injected timer boundary. Implementations should schedule asynchronously and return an opaque handle. */
export interface StandaloneInteractionScheduler {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

export interface StandalonePlayerInteractionOptions {
  readonly scheduler: StandaloneInteractionScheduler
  /** Required until the approved visual design defines the inactivity duration. */
  readonly digitPanelInactivityMs: number
  /** Injected; must return fresh protocol-safe IDs for new intents. Retries reuse the emitted request. */
  readonly createOperationId: () => string
}

/** Temporary keyboard/menu state. It emits contracts for B1 but never executes playback itself. */
export class StandalonePlayerInteractionController {
  private numericPanelOpen = false
  private enteredCode = ''
  private menuScreen: StandalonePlayerMenuScreen = 'closed'
  private lastSubmission: StandaloneCodeSubmissionStatus | undefined
  private readonly pendingSubmissions = new Map<string, StandaloneCodeSubmissionStatus>()
  private readonly submissionInputRevisions = new Map<string, number>()
  private stopAllRequest: StandalonePlayerCommandRequest | undefined
  private stopAllPending = false
  private readonly listeners = new Set<StandaloneInteractionListener>()
  private timerHandle: unknown
  private timerArmed = false
  private timerGeneration = 0
  private inputRevision = 0
  private disposed = false

  constructor(private readonly options: StandalonePlayerInteractionOptions) {
    if (!Number.isFinite(options.digitPanelInactivityMs) || options.digitPanelInactivityMs <= 0) {
      throw new RangeError('digitPanelInactivityMs deve ser um número positivo.')
    }
  }

  getSnapshot(): StandalonePlayerInteractionSnapshot {
    return {
      numericPanelOpen: this.numericPanelOpen,
      enteredCode: this.enteredCode,
      menuScreen: this.menuScreen,
      ...(this.lastSubmission ? { lastSubmission: { ...this.lastSubmission } } : {})
    }
  }

  subscribe(listener: StandaloneInteractionListener): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  handleKeyStroke(stroke: StandaloneKeyboardStroke): StandalonePlayerInteractionIntent | undefined {
    return this.handleStroke(stroke, false, false).intent
  }

  /**
   * Handles only numeric entry and closing an open entry panel. Returns true
   * for every recognized V1 stroke so the Renderer can prevent browser/host
   * defaults even when that command belongs to a later UI round.
   */
  handleEntryKeyStroke(stroke: StandaloneKeyboardStroke, allowSubmission = false,
    allowCountdownPause = false, confirmationOpen = false, allowPlaybackControls = false,
    currentTrackInfoOpen = false, allowMenuOpenDuringTransition = false): StandalonePlayerEntryStrokeResult {
    return this.handleStroke(stroke, true, allowSubmission, allowCountdownPause, confirmationOpen,
      allowPlaybackControls, currentTrackInfoOpen, allowMenuOpenDuringTransition)
  }

  /** Creates the single Main-authoritative Stop All request for the current confirmation attempt. */
  requestStopAll(): StandalonePlayerInteractionIntent | undefined {
    if (this.disposed || this.stopAllPending) return undefined
    if (!this.stopAllRequest) {
      this.stopAllRequest = this.playerCommand({ type: 'stop-all' }).request
    }
    this.stopAllPending = true
    return { type: 'player-command', request: this.stopAllRequest }
  }

  cancelStopAllConfirmation(): StandalonePlayerInteractionIntent | undefined {
    if (this.disposed || this.stopAllPending) return undefined
    return { type: 'close-stop-confirmation' }
  }

  /** Clears input and transient submission state only after Main confirms Stop All. */
  resetAfterStopAll(): void {
    if (this.disposed) return
    this.inputRevision++
    this.numericPanelOpen = false
    this.enteredCode = ''
    this.cancelInactivityTimer()
    this.lastSubmission = undefined
    this.pendingSubmissions.clear()
    this.submissionInputRevisions.clear()
    this.stopAllRequest = undefined
    this.stopAllPending = false
    this.publish()
  }

  private handleStroke(
    stroke: StandaloneKeyboardStroke,
    entryOnly: boolean,
    allowSubmission: boolean,
    allowCountdownPause = false,
    confirmationOpen = false,
    allowPlaybackControls = false,
    currentTrackInfoOpen = false,
    allowMenuOpenDuringTransition = false
  ): StandalonePlayerEntryStrokeResult {
    if (this.disposed) return { recognized: false }
    const action = interpretStandaloneKeyboardStroke(stroke)
    if (confirmationOpen) {
      if (action?.type === 'escape') {
        const intent = this.cancelStopAllConfirmation()
        return { recognized: true, ...(intent ? { intent } : {}) }
      }
      if (action?.type === 'confirm-normal') {
        const intent = this.requestStopAll()
        return { recognized: true, ...(intent ? { intent } : {}) }
      }
      // The confirmation owns keyboard input until it is closed; do not leak a key to playback or the page.
      return { recognized: true }
    }
    if (!action) return { recognized: false }

    // Esc is the only keyboard command available while a menu is open. Menu navigation is owned by its UI.
    if (this.menuScreen !== 'closed' && action.type !== 'escape') return { recognized: true }

    if (entryOnly) {
      switch (action.type) {
        case 'digit': this.appendDigit(action.digit); return { recognized: true }
        case 'backspace': this.removeDigit(); return { recognized: true }
        case 'confirm-normal':
          return { recognized: true, ...(allowSubmission ? { intent: this.submitCode('normal') } : {}) }
        case 'confirm-priority':
          return { recognized: true, ...(allowSubmission ? { intent: this.submitCode('priority') } : {}) }
        case 'show-current-track-info':
          if (!allowPlaybackControls || this.numericPanelOpen) return { recognized: true }
          return { recognized: true, intent: { type: 'show-current-track-info' } }
        case 'escape':
          if (currentTrackInfoOpen) return { recognized: true, intent: { type: 'close-current-track-info' } }
          this.handleEscape(allowMenuOpenDuringTransition)
          return { recognized: true }
        case 'toggle-pause':
          if (!allowCountdownPause && !allowPlaybackControls) return { recognized: true }
          this.refreshInputTimerForInteraction()
          return { recognized: true, intent: this.playerCommand({ type: 'toggle-pause' }) }
        case 'next':
        case 'restart':
          if (!allowPlaybackControls || allowCountdownPause) return { recognized: true }
          this.refreshInputTimerForInteraction()
          return { recognized: true, intent: this.playerCommand({ type: action.type }) }
        case 'confirm-stop-all': return { recognized: true, intent: { type: 'open-stop-confirmation' } }
        default: return { recognized: true }
      }
    }

    switch (action.type) {
      case 'digit':
        this.appendDigit(action.digit)
        return { recognized: true }
      case 'backspace':
        this.removeDigit()
        return { recognized: true }
      case 'confirm-normal':
        return { recognized: true, intent: this.submitCode('normal') }
      case 'confirm-priority':
        return { recognized: true, intent: this.submitCode('priority') }
      case 'show-current-track-info': return { recognized: true }
      case 'toggle-pause':
        this.refreshInputTimerForInteraction()
        return { recognized: true, intent: this.playerCommand({ type: 'toggle-pause' }) }
      case 'next':
        this.refreshInputTimerForInteraction()
        return { recognized: true, intent: this.playerCommand({ type: 'next' }) }
      case 'restart':
        this.refreshInputTimerForInteraction()
        return { recognized: true, intent: this.playerCommand({ type: 'restart' }) }
      case 'confirm-stop-all': return { recognized: true, intent: { type: 'open-stop-confirmation' } }
      case 'escape':
        this.handleEscape()
        return { recognized: true }
    }
  }

  /** Applies an action selected by the Renderer menu without mutating playback state. */
  selectMenuAction(action: StandalonePlayerMenuAction): void {
    if (this.disposed) return
    if (this.menuScreen === 'main') {
      switch (action) {
        case 'commands': this.menuScreen = 'commands'; break
        case 'options': this.menuScreen = 'options'; break
        case 'back': this.menuScreen = 'closed'; break
        case 'exit': this.menuScreen = 'exit-confirmation'; break
      }
      this.publish()
      return
    }
    if ((this.menuScreen === 'commands' || this.menuScreen === 'options') && action === 'back') {
      this.menuScreen = 'main'
      this.publish()
    }
  }

  /** Opens the existing exit-confirmation state for a Main-originated request. */
  showExitConfirmation(): void {
    if (this.disposed || this.menuScreen === 'exit-confirmation') return
    this.menuScreen = 'exit-confirmation'
    this.publish()
  }

  /** Resolves the UI-owned exit confirmation without closing the application in this module. */
  resolveExitConfirmation(
    confirmed: boolean,
    cancelTo: Exclude<StandalonePlayerMenuScreen, 'exit-confirmation'> = 'main'
  ): StandalonePlayerInteractionIntent | undefined {
    if (this.disposed || this.menuScreen !== 'exit-confirmation') return undefined
    if (!confirmed) {
      this.menuScreen = cancelTo
      this.publish()
      return undefined
    }
    this.menuScreen = 'closed'
    this.publish()
    return { type: 'request-application-exit' }
  }

  /** Applies only the authoritative B1 result for the latest code submission; no result is inferred locally. */
  applyCommandResult(result: StandalonePlayerCommandResult): StandaloneCodeSubmissionStatus | undefined {
    return this.applyCommandOutcome({
      operationId: result.operationId,
      outcome: result.outcome,
      ...(result.outcome === 'confirmed' ? {} : {
        errorCode: result.outcome === 'rejected' ? result.error.code : result.snapshot.error.code
      })
    })
  }

  /** Applies a result mapped from an authorized transport without coupling B2 to Electron IPC. */
  applyCommandOutcome(result: StandalonePlayerInteractionCommandOutcome): StandaloneCodeSubmissionStatus | undefined {
    if (this.disposed) return undefined
    if (this.stopAllRequest?.operationId === result.operationId) {
      this.stopAllPending = false
      if (result.outcome === 'confirmed' || result.outcome === 'rejected') this.stopAllRequest = undefined
      return undefined
    }
    const submission = this.pendingSubmissions.get(result.operationId)
    if (!submission) return undefined

    let settled: StandaloneCodeSubmissionStatus
    if (result.outcome === 'confirmed') {
      settled = { ...submission, outcome: 'confirmed' }
    } else {
      settled = {
        ...submission,
        outcome: result.outcome,
        ...(result.errorCode ? { errorCode: result.errorCode } : {})
      }
    }
    this.pendingSubmissions.delete(result.operationId)
    const submissionInputRevision = this.submissionInputRevisions.get(result.operationId)
    this.submissionInputRevisions.delete(result.operationId)
    if (this.lastSubmission?.operationId === result.operationId) {
      this.lastSubmission = settled
      if (result.outcome === 'rejected' && submissionInputRevision === this.inputRevision &&
          this.numericPanelOpen && this.enteredCode.length === 0) {
        this.enteredCode = submission.enteredCode
      }
      this.publish()
    }
    return settled
  }

  /** Closes and clears the transient numeric entry when the UI leaves idle for active playback. */
  closeNumericEntry(): void {
    if (this.disposed || !this.numericPanelOpen) return
    this.inputRevision++
    this.numericPanelOpen = false
    this.enteredCode = ''
    this.cancelInactivityTimer()
    this.publish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelInactivityTimer()
    this.numericPanelOpen = false
    this.enteredCode = ''
    this.menuScreen = 'closed'
    this.lastSubmission = undefined
    this.pendingSubmissions.clear()
    this.submissionInputRevisions.clear()
    this.stopAllRequest = undefined
    this.stopAllPending = false
    this.listeners.clear()
  }

  private appendDigit(digit: string): void {
    this.inputRevision++
    if (!this.numericPanelOpen) this.numericPanelOpen = true
    if (this.enteredCode.length < 5) this.enteredCode += digit
    this.resetInactivityTimer()
    this.publish()
  }

  private removeDigit(): void {
    if (!this.numericPanelOpen) return
    this.inputRevision++
    this.enteredCode = this.enteredCode.slice(0, -1)
    this.resetInactivityTimer()
    this.publish()
  }

  private submitCode(priority: 'normal' | 'priority'): StandalonePlayerInteractionIntent | undefined {
    if (!this.numericPanelOpen) return undefined
    if (this.enteredCode.length === 0) {
      this.resetInactivityTimer()
      return undefined
    }

    const command: StandalonePlayerCommand = { type: 'submit-code', enteredCode: this.enteredCode, priority }
    const intent = this.playerCommand(command)
    const submission: StandaloneCodeSubmissionStatus = {
      operationId: intent.request.operationId,
      enteredCode: this.enteredCode,
      priority,
      outcome: 'pending'
    }
    this.lastSubmission = submission
    this.pendingSubmissions.set(submission.operationId, submission)
    this.submissionInputRevisions.set(submission.operationId, this.inputRevision)
    this.enteredCode = ''
    this.resetInactivityTimer()
    this.publish()
    return intent
  }

  private playerCommand(command: StandalonePlayerCommand): Extract<StandalonePlayerInteractionIntent, { type: 'player-command' }> {
    const operationId = this.options.createOperationId()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
      throw new Error('createOperationId retornou um identificador inválido.')
    }
    const immutableCommand = Object.freeze(command)
    const request = Object.freeze({ operationId, command: immutableCommand })
    return Object.freeze({ type: 'player-command', request })
  }

  private handleEscape(openMenuDuringTransition = false): void {
    if (this.numericPanelOpen) {
      this.closeNumericEntry()
      if (!openMenuDuringTransition) return
    }
    if (this.menuScreen === 'closed') {
      this.menuScreen = 'main'
    } else if (this.menuScreen === 'main') {
      this.menuScreen = 'closed'
    } else {
      // Esc returns to the parent level; for exit confirmation this acts as cancel.
      this.menuScreen = 'main'
    }
    this.publish()
  }

  getStopAllPending(): boolean { return this.stopAllPending }

  private refreshInputTimerForInteraction(): void {
    if (this.numericPanelOpen) this.resetInactivityTimer()
  }

  private resetInactivityTimer(): void {
    this.cancelInactivityTimer()
    const generation = this.timerGeneration
    this.timerArmed = true
    this.timerHandle = this.options.scheduler.schedule(() => {
      if (this.disposed || !this.timerArmed || generation !== this.timerGeneration) return
      this.timerArmed = false
      this.timerHandle = undefined
      this.timerGeneration++
      if (!this.numericPanelOpen) return
      this.inputRevision++
      this.numericPanelOpen = false
      this.enteredCode = ''
      this.publish()
    }, this.options.digitPanelInactivityMs)
  }

  private cancelInactivityTimer(): void {
    this.timerGeneration++
    if (this.timerArmed) this.options.scheduler.cancel(this.timerHandle)
    this.timerArmed = false
    this.timerHandle = undefined
  }

  private publish(): void {
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { /* An observer cannot change authoritative interaction state. */ }
    }
  }
}
