import { randomUUID } from 'node:crypto'
import type {
  StandaloneExitConfirmationDecision,
  StandaloneExitConfirmationRequestReply,
  StandaloneExitConfirmationResolutionReply
} from './standalone-player-ipc-contracts'

interface PendingConfirmation {
  readonly requestId: string
  readonly promise: Promise<boolean>
  readonly resolve: (confirmed: boolean) => void
  readonly reject: (error: Error) => void
  surface: 'renderer' | 'native'
  initiatedByMain: boolean
}

interface SettledConfirmation {
  readonly requestId: string
  readonly outcome: 'confirmed' | 'cancelled'
  readonly source: 'renderer' | 'native'
}

export interface StandaloneExitConfirmationResolutionResult {
  readonly reply: StandaloneExitConfirmationResolutionReply
  /** True only for the first Renderer-originated confirmation; Main may begin shutdown in a later stage. */
  readonly notifyMain: boolean
}

export interface StandaloneExitConfirmationMainRequestPorts {
  isRendererAvailable(): boolean
  sendToRenderer(requestId: string): boolean
  showNativeFallback(): Promise<boolean>
}

/** Main-owned, bounded state for one exit confirmation at a time. It never starts application shutdown. */
export class StandaloneExitConfirmationCoordinator {
  private pending: PendingConfirmation | undefined
  private lastSettled: SettledConfirmation | undefined
  private authorized = false
  private disposed = false

  constructor(private readonly createRequestId: () => string = randomUUID) {}

  requestFromRenderer(): StandaloneExitConfirmationRequestReply {
    if (this.disposed) return { outcome: 'unavailable' }
    if (this.authorized) return { outcome: 'authorized' }
    if (this.pending) {
      return this.pending.surface === 'native'
        ? { outcome: 'native-fallback' }
        : { outcome: 'pending', requestId: this.pending.requestId }
    }
    return { outcome: 'pending', requestId: this.createPending('renderer', false).requestId }
  }

  requestFromMain(ports: StandaloneExitConfirmationMainRequestPorts): Promise<boolean> {
    if (this.disposed) return Promise.reject(new Error('STANDALONE_IPC_DISPOSED'))
    if (this.authorized) return Promise.resolve(true)
    if (this.pending) {
      this.pending.initiatedByMain = true
      if (this.pending.surface === 'renderer' && !this.isRendererAvailable(ports)) {
        this.beginNativeFallback(this.pending, ports.showNativeFallback)
      }
      return this.pending.promise
    }

    const pending = this.createPending('renderer', true)
    if (this.isRendererAvailable(ports)) {
      try {
        if (ports.sendToRenderer(pending.requestId)) return pending.promise
      } catch { /* A failed send is handled by the native fallback below. */ }
    }
    this.beginNativeFallback(pending, ports.showNativeFallback)
    return pending.promise
  }

  resolveFromRenderer(
    requestId: string,
    decision: StandaloneExitConfirmationDecision
  ): StandaloneExitConfirmationResolutionResult {
    if (this.lastSettled?.requestId === requestId) {
      const outcome = this.lastSettled.source === 'renderer'
        ? this.lastSettled.outcome
        : this.lastSettled.outcome === 'confirmed' ? 'already-authorized' : 'stale'
      return { reply: { requestId, outcome }, notifyMain: false }
    }
    if (this.disposed) return { reply: { requestId, outcome: 'stale' }, notifyMain: false }
    if (this.authorized) return { reply: { requestId, outcome: 'already-authorized' }, notifyMain: false }
    const pending = this.pending
    if (!pending || pending.requestId !== requestId || pending.surface !== 'renderer') {
      return { reply: { requestId, outcome: 'stale' }, notifyMain: false }
    }

    const outcome = decision === 'confirm' ? 'confirmed' : 'cancelled'
    this.settle(pending, outcome, 'renderer')
    return {
      reply: { requestId, outcome },
      notifyMain: outcome === 'confirmed' && !pending.initiatedByMain
    }
  }

  /** Switches a pending request to one native prompt after the Renderer is lost. */
  rendererUnavailable(showNativeFallback: () => Promise<boolean>, onRendererAuthorized: () => void): void {
    const pending = this.pending
    if (!pending || pending.surface !== 'renderer') return
    this.beginNativeFallback(pending, showNativeFallback, onRendererAuthorized)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const pending = this.pending
    this.pending = undefined
    pending?.resolve(false)
  }

  /** Starts a new operator decision after a confirmed shutdown could not be made safe. */
  resetAfterFailedShutdown(): void {
    if (this.disposed || this.pending) throw new Error('STANDALONE_IPC_EXIT_CONFIRMATION_BUSY')
    this.authorized = false
    this.lastSettled = undefined
  }

  private createPending(surface: PendingConfirmation['surface'], initiatedByMain: boolean): PendingConfirmation {
    let resolve!: (confirmed: boolean) => void
    let reject!: (error: Error) => void
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    // A Renderer-only request has no Main waiter until a later lifecycle stage joins it.
    // Mark rejection handled while retaining the rejection for a Main caller that awaits the same promise.
    void promise.catch(() => undefined)
    const pending: PendingConfirmation = {
      requestId: this.createRequestId(), promise, resolve, reject, surface, initiatedByMain
    }
    this.pending = pending
    return pending
  }

  private isRendererAvailable(ports: StandaloneExitConfirmationMainRequestPorts): boolean {
    try { return ports.isRendererAvailable() }
    catch { return false }
  }

  private beginNativeFallback(pending: PendingConfirmation, showNativeFallback: () => Promise<boolean>,
    onRendererAuthorized?: () => void): void {
    if (this.pending !== pending || pending.surface === 'native') return
    pending.surface = 'native'
    void Promise.resolve().then(showNativeFallback).then(confirmed => {
      if (this.pending !== pending) return
      const notifyMain = confirmed && !pending.initiatedByMain
      this.settle(pending, confirmed ? 'confirmed' : 'cancelled', 'native')
      if (notifyMain) onRendererAuthorized?.()
    }).catch(error => {
      if (this.pending !== pending) return
      this.pending = undefined
      pending.reject(error instanceof Error ? error : new Error('STANDALONE_IPC_EXIT_FALLBACK_FAILED'))
    })
  }

  private settle(pending: PendingConfirmation, outcome: SettledConfirmation['outcome'], source: SettledConfirmation['source']): void {
    if (this.pending !== pending) return
    this.pending = undefined
    this.lastSettled = { requestId: pending.requestId, outcome, source }
    if (outcome === 'confirmed') this.authorized = true
    pending.resolve(outcome === 'confirmed')
  }
}
