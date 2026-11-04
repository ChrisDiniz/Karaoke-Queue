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
  /** The future application shell may handle this request after its own exit confirmation flow. */
  | { readonly type: 'request-application-exit' }

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
  private readonly listeners = new Set<StandaloneInteractionListener>()
  private timerHandle: unknown
  private timerArmed = false
  private timerGeneration = 0
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
    if (this.disposed) return undefined
    const action = interpretStandaloneKeyboardStroke(stroke)
    if (!action) return undefined

    // Esc is the only keyboard command available while a menu is open. Menu navigation is owned by its UI.
    if (this.menuScreen !== 'closed' && action.type !== 'escape') return undefined

    switch (action.type) {
      case 'digit':
        this.appendDigit(action.digit)
        return undefined
      case 'backspace':
        this.removeDigit()
        return undefined
      case 'confirm-normal':
        return this.submitCode('normal')
      case 'confirm-priority':
        return this.submitCode('priority')
      case 'toggle-pause':
        this.refreshInputTimerForInteraction()
        return this.playerCommand({ type: 'toggle-pause' })
      case 'next':
        this.refreshInputTimerForInteraction()
        return this.playerCommand({ type: 'next' })
      case 'restart':
        this.refreshInputTimerForInteraction()
        return this.playerCommand({ type: 'restart' })
      case 'escape':
        this.handleEscape()
        return undefined
    }
  }

  /** Called by a future menu UI; no menu contents or visual behavior are implemented here. */
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

  /** Resolves the UI-owned exit confirmation without closing the application in this module. */
  resolveExitConfirmation(confirmed: boolean): StandalonePlayerInteractionIntent | undefined {
    if (this.disposed || this.menuScreen !== 'exit-confirmation') return undefined
    if (!confirmed) {
      this.menuScreen = 'main'
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
    if (this.lastSubmission?.operationId === result.operationId) {
      this.lastSubmission = settled
      this.publish()
    }
    return settled
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
    this.listeners.clear()
  }

  private appendDigit(digit: string): void {
    if (!this.numericPanelOpen) this.numericPanelOpen = true
    if (this.enteredCode.length < 5) this.enteredCode += digit
    this.resetInactivityTimer()
    this.publish()
  }

  private removeDigit(): void {
    if (!this.numericPanelOpen) return
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

  private handleEscape(): void {
    if (this.numericPanelOpen) {
      this.numericPanelOpen = false
      this.enteredCode = ''
      this.cancelInactivityTimer()
      this.publish()
      return
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
