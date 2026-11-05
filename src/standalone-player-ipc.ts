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
  type StandalonePlayerMetadataPreview,
  type StandalonePlayerMainIpcBridgeOptions,
  type StandalonePlayerSnapshotEnvelope,
  type StandalonePlayerSnapshotUpdate,
  type StandalonePlayerSubscriptionRef
} from './standalone-player-ipc-contracts'
import { validateStandalonePlayerCommandRequest } from './standalone-player-runtime'

interface SubscriptionRecord {
  readonly generation: number
}

const MAX_SUBSCRIPTIONS_PER_RENDERER = 8

/** Main-side transport only. It never owns or disposes the runtime/playback composition. */
export class StandalonePlayerMainIpcBridge {
  private readonly subscriptions = new Map<string, SubscriptionRecord>()
  private readonly registeredChannels = new Set<string>()
  private unsubscribeControl: () => void = () => undefined
  private unsubscribeCatalogRevision: () => void = () => undefined
  private currentEnvelope: StandalonePlayerSnapshotEnvelope
  private nextGeneration = 0
  private disposed = false

  private readonly onMainFrameNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame && !details.isSameDocument) this.clearSubscriptions()
  }

  private readonly onRendererGone = (): void => this.clearSubscriptions()
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
      options.webContents.on('did-start-navigation', this.onMainFrameNavigation)
      options.webContents.on('render-process-gone', this.onRendererGone)
      options.webContents.once('destroyed', this.onWebContentsDestroyed)
    } catch (error) {
      this.clearSubscriptions()
      this.unsubscribeControl()
      this.unsubscribeCatalogRevision()
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
    this.clearSubscriptions()
    this.unsubscribeControl()
    this.unsubscribeCatalogRevision()
    this.removeRegisteredHandlers()
    this.options.webContents.removeListener('did-start-navigation', this.onMainFrameNavigation)
    this.options.webContents.removeListener('render-process-gone', this.onRendererGone)
    this.options.webContents.removeListener('destroyed', this.onWebContentsDestroyed)
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
      const result = await this.options.control.execute(request)
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
  }

  private handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
    this.options.ipcMain.handle(channel, listener)
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

export function installStandalonePlayerMainIpcBridge(
  options: StandalonePlayerMainIpcBridgeOptions
): StandalonePlayerMainIpcBridge {
  return new StandalonePlayerMainIpcBridge(options)
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
