import crypto from 'node:crypto'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import {
  PlayerPlaybackError,
  type PlayerPlaybackHost,
  type PlayerPlaybackHostCommand,
  type PlayerPlaybackHostEvent,
  type PlayerPlaybackMediaObservation
} from './player-playback-contracts'

const READY_CHANNEL = 'player-playback:ready'
const COMMAND_CHANNEL = 'player-playback:command'
const ACK_CHANNEL = 'player-playback:acknowledge'
const EVENT_CHANNEL = 'player-playback:event'
const COMMAND_TIMEOUT_MS = 5000
const HOST_READY_TIMEOUT_MS = 15000
const HOST_TERMINATION_TIMEOUT_MS = 3000

interface PendingCommand {
  attemptId: string
  resolve(): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

function validMediaObservation(value: unknown): value is PlayerPlaybackMediaObservation {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  if (!['loadedmetadata', 'timeupdate', 'playing', 'pause', 'ended', 'error', 'emptied', 'waiting', 'stalled'].includes(String(event.type))) return false
  for (const field of ['currentTime', 'duration', 'videoWidth', 'videoHeight', 'mediaErrorCode']) {
    if (event[field] !== undefined && (typeof event[field] !== 'number' || !Number.isFinite(event[field]))) return false
  }
  return true
}

/** A single trusted media Renderer transport. It accepts messages only from its main frame. */
export class ChromiumPlaybackHost implements PlayerPlaybackHost {
  readonly hostEpoch = crypto.randomUUID()
  readonly ready: Promise<void>
  private readonly subscribers = new Set<(event: PlayerPlaybackHostEvent) => void>()
  private readonly pending = new Map<string, PendingCommand>()
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readySettled = false
  private terminated = false
  private disposed = false
  private terminationPromise: Promise<boolean> | undefined
  private readonly readyTimer: NodeJS.Timeout
  private readonly navigationGuard: (
    details: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
    navigationUrl: string
  ) => void

  constructor(
    private readonly ipcMain: IpcMain,
    private readonly webContents: WebContents,
    allowedDocumentUrl: string,
    private readonly terminateHost?: () => Promise<boolean>
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyTimer = setTimeout(() => this.markTerminated('Playback host did not become ready.'), HOST_READY_TIMEOUT_MS)
    this.ipcMain.handle(READY_CHANNEL, (event: IpcMainInvokeEvent) => {
      if (!this.isAuthorizedSender(event)) throw new PlayerPlaybackError('HOST_TERMINATED', 'Playback host sender is not authorized.')
      if (this.terminated || this.disposed) throw new PlayerPlaybackError('HOST_TERMINATED', 'Playback host is unavailable.')
      this.resolveReady()
      return true
    })
    this.ipcMain.handle(ACK_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!this.isAuthorizedSender(event)) throw new PlayerPlaybackError('HOST_TERMINATED', 'Playback host sender is not authorized.')
      this.receiveAcknowledgement(payload)
      return true
    })
    this.ipcMain.on(EVENT_CHANNEL, this.handleEvent)
    this.webContents.on('destroyed', this.handleDestroyed)
    this.webContents.on('render-process-gone', this.handleRendererGone)
    this.navigationGuard = (event, navigationUrl) => {
      if (navigationUrl !== allowedDocumentUrl) event.preventDefault()
    }
    this.webContents.on('will-navigate', this.navigationGuard)
    this.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  send(command: PlayerPlaybackHostCommand): Promise<void> {
    if (this.terminated || this.disposed || this.webContents.isDestroyed()) {
      return Promise.reject(new PlayerPlaybackError('HOST_TERMINATED', 'Playback host is unavailable.'))
    }
    if (!this.readySettled) return Promise.reject(new PlayerPlaybackError('HOST_NOT_READY', 'Playback host is not ready.'))
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.commandId)
        reject(new PlayerPlaybackError('COMMAND_TIMEOUT', 'The playback host did not acknowledge the command in time.'))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(command.commandId, { attemptId: command.attemptId, resolve, reject, timer })
      try {
        this.webContents.send(COMMAND_CHANNEL, command)
      } catch {
        clearTimeout(timer)
        this.pending.delete(command.commandId)
        reject(new PlayerPlaybackError('HOST_TERMINATED', 'The playback command could not reach the host.'))
      }
    })
  }

  subscribe(listener: (event: PlayerPlaybackHostEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  /** Requests bounded termination from the owner of this specific playback host. */
  terminate(): Promise<boolean> {
    if (this.terminationPromise) return this.terminationPromise
    this.terminationPromise = this.terminateOwnedHost()
    return this.terminationPromise
  }

  private async terminateOwnedHost(): Promise<boolean> {
    if (!this.terminateHost) return false
    let timer: NodeJS.Timeout | undefined
    try {
      const ownerConfirmed = await Promise.race([
        this.terminateHost(),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), HOST_TERMINATION_TIMEOUT_MS) })
      ])
      return ownerConfirmed && this.webContents.isDestroyed()
    } catch {
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.markTerminated('Playback host was disposed.')
    this.disposed = true
    this.ipcMain.removeHandler(READY_CHANNEL)
    this.ipcMain.removeHandler(ACK_CHANNEL)
    this.ipcMain.removeListener(EVENT_CHANNEL, this.handleEvent)
    this.webContents.removeListener('destroyed', this.handleDestroyed)
    this.webContents.removeListener('render-process-gone', this.handleRendererGone)
    this.webContents.removeListener('will-navigate', this.navigationGuard)
  }

  private readonly handleEvent = (event: IpcMainEvent, payload: unknown): void => {
    if (!this.isAuthorizedSender(event) || this.terminated || this.disposed || !payload || typeof payload !== 'object') return
    const value = payload as Record<string, unknown>
    if (typeof value.attemptId !== 'string' || value.attemptId.length > 80 ||
        !Number.isSafeInteger(value.sequenceNumber) || (value.sequenceNumber as number) <= 0 ||
        !validMediaObservation(value.observation)) return
    const wrapped: PlayerPlaybackHostEvent = {
      type: 'media', hostEpoch: this.hostEpoch, attemptId: value.attemptId,
      sequenceNumber: value.sequenceNumber as number, observation: value.observation
    }
    for (const listener of this.subscribers) listener(wrapped)
  }

  private receiveAcknowledgement(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const value = payload as Record<string, unknown>
    if (typeof value.commandId !== 'string' || typeof value.attemptId !== 'string' || typeof value.accepted !== 'boolean') return
    const pending = this.pending.get(value.commandId)
    if (!pending || pending.attemptId !== value.attemptId) return
    clearTimeout(pending.timer)
    this.pending.delete(value.commandId)
    if (value.accepted) pending.resolve()
    else pending.reject(new PlayerPlaybackError('PLAYBACK_FAILED', 'The playback host rejected the command.'))
  }

  private isAuthorizedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return event.sender === this.webContents && event.senderFrame === this.webContents.mainFrame
  }

  private resolveReady(): void {
    if (this.readySettled || this.terminated || this.disposed) return
    this.readySettled = true
    clearTimeout(this.readyTimer)
    this.readyResolve()
  }

  private markTerminated(_reason: string): void {
    if (this.terminated) return
    this.terminated = true
    clearTimeout(this.readyTimer)
    if (!this.readySettled) {
      this.readySettled = true
      this.readyReject(new PlayerPlaybackError('HOST_TERMINATED', 'Playback host terminated before it became ready.'))
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new PlayerPlaybackError('HOST_TERMINATED', 'Playback host terminated while a command was pending.'))
    }
    this.pending.clear()
    const event: PlayerPlaybackHostEvent = { type: 'terminated', hostEpoch: this.hostEpoch }
    for (const listener of this.subscribers) listener(event)
    this.subscribers.clear()
  }

  private readonly handleDestroyed = (): void => this.markTerminated('Playback host was destroyed.')

  private readonly handleRendererGone = (): void => this.markTerminated('Playback Renderer terminated.')
}
