import { contextBridge, ipcRenderer } from 'electron'
import { STANDALONE_CELEBRATION_MESSAGES } from './src/standalone-player-contracts'
import type {
  StandalonePlayerCommandRequest,
  StandalonePlayerSnapshot,
  StandaloneStableState
} from './src/standalone-player-contracts'
import {
  STANDALONE_PLAYER_IPC_CHANNELS,
  type StandalonePlayerRendererApi,
  type StandalonePlayerIpcCommandReply,
  type StandalonePlayerMetadataPreview,
  type StandalonePlayerSnapshotEnvelope,
  type StandalonePlayerSnapshotUpdate,
  type StandalonePlayerSubscriptionRef
} from './src/standalone-player-ipc-contracts'

interface LocalSubscription {
  readonly listener: (envelope: StandalonePlayerSnapshotEnvelope) => void
  generation?: number
  revision: number
  readonly buffered: StandalonePlayerSnapshotUpdate[]
}

const subscriptions = new Map<string, LocalSubscription>()
const catalogRevisionListeners = new Set<(revision: string | null) => void>()
let nextSubscriptionId = 0
let newestEnvelope: StandalonePlayerSnapshotEnvelope | undefined
let snapshotListenerAttached = false
let catalogRevisionListenerAttached = false
const ipcErrorCodes = new Set([
  'STANDALONE_IPC_DISPOSED',
  'STANDALONE_IPC_FAILED',
  'STANDALONE_IPC_FORBIDDEN',
  'STANDALONE_IPC_INVALID_DOCUMENT',
  'STANDALONE_IPC_INVALID_LISTENER',
  'STANDALONE_IPC_INVALID_REQUEST',
  'STANDALONE_IPC_INVALID_RESPONSE',
  'STANDALONE_IPC_SUBSCRIPTION_EXISTS',
  'STANDALONE_IPC_SUBSCRIPTION_LIMIT'
])

function isEnvelope(value: unknown): value is StandalonePlayerSnapshotEnvelope {
  return isPlainRecord(value) && hasExactKeys(value, ['revision', 'snapshot']) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 && isSnapshot(value.snapshot)
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

function isQueueEntry(value: unknown): boolean {
  return isPlainRecord(value) && hasExactKeys(value, ['entryId', 'musicCode']) &&
    typeof value.entryId === 'string' && value.entryId.length > 0 && value.entryId.length <= 128 &&
    typeof value.musicCode === 'string' && /^\d{5}$/.test(value.musicCode)
}

function isQueue(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= 10000 && value.every(isQueueEntry)
}

function isCurrentEntry(value: unknown): boolean {
  return isPlainRecord(value) && hasExactKeys(value, ['entryId', 'musicCode', 'attemptId']) &&
    typeof value.entryId === 'string' && value.entryId.length > 0 && value.entryId.length <= 128 &&
    typeof value.musicCode === 'string' && /^\d{5}$/.test(value.musicCode) &&
    typeof value.attemptId === 'string' && value.attemptId.length > 0 && value.attemptId.length <= 128
}

function isStableState(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['operationalState', 'current', 'pending']) || !isQueue(value.pending)) return false
  if (value.operationalState === 'idle') return value.current === null && value.pending.length === 0
  return (value.operationalState === 'playing' || value.operationalState === 'paused') && isCurrentEntry(value.current)
}

function isSnapshot(value: unknown): value is StandalonePlayerSnapshot {
  if (!isPlainRecord(value)) return false
  if (value.playbackCondition === 'ready') {
    return hasExactKeys(value, ['playbackCondition', 'state']) && isStableState(value.state)
  }
  if (value.playbackCondition === 'transitioning') {
    if (!isStableState(value.lastConfirmedState) || !isQueue(value.pending) || typeof value.phase !== 'string') return false
    if (value.phase === 'operation' || value.phase === 'resuming') return hasExactKeys(value, ['playbackCondition', 'phase', 'lastConfirmedState', 'pending'])
    if (value.phase === 'countdown') {
      return hasExactKeys(value, ['playbackCondition', 'phase', 'lastConfirmedState', 'pending', 'target', 'remainingMs', 'paused']) &&
        isQueueEntry(value.target) && Number.isSafeInteger(value.remainingMs) &&
        (value.remainingMs as number) >= 0 && (value.remainingMs as number) <= 5000 && typeof value.paused === 'boolean'
    }
    if (value.phase === 'loading') {
      return hasExactKeys(value, ['playbackCondition', 'phase', 'lastConfirmedState', 'pending', 'target']) && isQueueEntry(value.target)
    }
    if (value.phase === 'celebration') {
      return hasExactKeys(value, ['playbackCondition', 'phase', 'lastConfirmedState', 'pending', 'remainingMs', 'paused', 'message']) &&
        Number.isSafeInteger(value.remainingMs) && (value.remainingMs as number) >= 0 && (value.remainingMs as number) <= 5000 &&
        typeof value.paused === 'boolean' && typeof value.message === 'string' &&
        (STANDALONE_CELEBRATION_MESSAGES as readonly string[]).includes(value.message)
    }
    return false
  }
  if (value.playbackCondition === 'blocked' || value.playbackCondition === 'uncertain') {
    return hasExactKeys(value, ['playbackCondition', 'lastConfirmedState', 'pending', 'error']) &&
      isStableState(value.lastConfirmedState) && isQueue(value.pending) && isPlainRecord(value.error) &&
      hasExactKeys(value.error, ['code']) && typeof value.error.code === 'string' && value.error.code.length > 0 && value.error.code.length <= 64
  }
  return false
}

function deliver(subscription: LocalSubscription, envelope: StandalonePlayerSnapshotEnvelope): void {
  if (envelope.revision <= subscription.revision) return
  subscription.revision = envelope.revision
  const current = cloneEnvelope(envelope)
  try { subscription.listener(current) } catch { /* Renderer callbacks cannot break IPC listener cleanup. */ }
}

function adopt(envelope: StandalonePlayerSnapshotEnvelope): StandalonePlayerSnapshotEnvelope {
  if (!newestEnvelope || envelope.revision > newestEnvelope.revision) newestEnvelope = freezeEnvelope(envelope)
  for (const subscription of subscriptions.values()) {
    if (subscription.generation !== undefined) deliver(subscription, newestEnvelope)
  }
  return newestEnvelope
}

function freezeEnvelope(envelope: StandalonePlayerSnapshotEnvelope): StandalonePlayerSnapshotEnvelope {
  return deepFreeze(cloneEnvelope(envelope))
}

function cloneEnvelope(envelope: StandalonePlayerSnapshotEnvelope): StandalonePlayerSnapshotEnvelope {
  return { revision: envelope.revision, snapshot: cloneSnapshot(envelope.snapshot) }
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
    if (snapshot.phase === 'celebration') return {
      ...base,
      phase: 'celebration',
      remainingMs: snapshot.remainingMs,
      paused: snapshot.paused,
      message: snapshot.message
    }
    if (snapshot.phase === 'resuming') return { ...base, phase: 'resuming' }
    return { ...base, phase: 'operation' }
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
    current: { entryId: state.current.entryId, musicCode: state.current.musicCode, attemptId: state.current.attemptId },
    pending
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function onSnapshotChanged(_event: Electron.IpcRendererEvent, value: unknown): void {
  if (!isPlainRecord(value) || typeof value.subscriptionId !== 'string' ||
      !Number.isSafeInteger(value.generation) || !isEnvelope(value.envelope)) return
  const subscription = subscriptions.get(value.subscriptionId)
  if (!subscription) return
  const update = value as unknown as StandalonePlayerSnapshotUpdate
  if (subscription.generation === undefined) {
    subscription.buffered.push(update)
    return
  }
  if (subscription.generation === update.generation) adopt(update.envelope)
}

function ensureSnapshotListener(): void {
  if (snapshotListenerAttached) return
  ipcRenderer.on(STANDALONE_PLAYER_IPC_CHANNELS.snapshotChanged, onSnapshotChanged)
  snapshotListenerAttached = true
}

function removeSnapshotListenerWhenUnused(): void {
  if (!snapshotListenerAttached || subscriptions.size > 0) return
  ipcRenderer.removeListener(STANDALONE_PLAYER_IPC_CHANNELS.snapshotChanged, onSnapshotChanged)
  snapshotListenerAttached = false
}

function onCatalogRevisionChanged(_event: Electron.IpcRendererEvent, value: unknown): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['catalogRevision']) ||
      !(value.catalogRevision === null || (typeof value.catalogRevision === 'string' && value.catalogRevision.length <= 128))) return
  for (const listener of [...catalogRevisionListeners]) {
    try { listener(value.catalogRevision as string | null) } catch { /* A UI observer cannot affect the IPC bridge. */ }
  }
}

function removeCatalogRevisionListenerWhenUnused(): void {
  if (!catalogRevisionListenerAttached || catalogRevisionListeners.size > 0) return
  ipcRenderer.removeListener(STANDALONE_PLAYER_IPC_CHANNELS.catalogRevisionChanged, onCatalogRevisionChanged)
  catalogRevisionListenerAttached = false
}

function clearCatalogRevisionListeners(): void {
  catalogRevisionListeners.clear()
  removeCatalogRevisionListenerWhenUnused()
}

window.addEventListener('pagehide', clearCatalogRevisionListeners, { once: true })

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try { return await ipcRenderer.invoke(channel, ...args) as T }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    const candidate = message.match(/\b(STANDALONE_IPC_[A-Z_]+)\b/)?.[1]
    const knownCode = candidate && ipcErrorCodes.has(candidate) ? candidate : 'STANDALONE_IPC_FAILED'
    throw new Error(knownCode)
  }
}

const api: StandalonePlayerRendererApi = Object.freeze({
  getSnapshot: async () => {
    const received = await invoke<StandalonePlayerSnapshotEnvelope>(STANDALONE_PLAYER_IPC_CHANNELS.getSnapshot)
    if (!isEnvelope(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return cloneEnvelope(adopt(received))
  },
  execute: async (request: StandalonePlayerCommandRequest) => {
    const received = await invoke<StandalonePlayerIpcCommandReply>(STANDALONE_PLAYER_IPC_CHANNELS.execute, request)
    if (!isPlainRecord(received) || received.operationId !== request.operationId ||
        !['confirmed', 'rejected', 'blocked', 'uncertain'].includes(String(received.outcome)) ||
        !isEnvelope(received.envelope)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    const envelope = adopt(received.envelope)
    return { ...received, envelope: cloneEnvelope(envelope) }
  },
  lookupMetadata: async (code: string) => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.lookupMetadata, code)
    if (!isMetadataPreview(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return { catalogRevision: received.catalogRevision, title: received.title, artist: received.artist }
  },
  onCatalogRevisionChanged: (listener: (revision: string | null) => void) => {
    if (typeof listener !== 'function') throw new Error('STANDALONE_IPC_INVALID_LISTENER')
    if (!catalogRevisionListenerAttached) {
      ipcRenderer.on(STANDALONE_PLAYER_IPC_CHANNELS.catalogRevisionChanged, onCatalogRevisionChanged)
      catalogRevisionListenerAttached = true
    }
    catalogRevisionListeners.add(listener)
    return () => {
      catalogRevisionListeners.delete(listener)
      removeCatalogRevisionListenerWhenUnused()
    }
  },
  subscribe: async (listener: (envelope: StandalonePlayerSnapshotEnvelope) => void) => {
    if (typeof listener !== 'function') throw new Error('STANDALONE_IPC_INVALID_LISTENER')
    ensureSnapshotListener()
    const subscriptionId = `sp-${++nextSubscriptionId}`
    const local: LocalSubscription = { listener, revision: -1, buffered: [] }
    subscriptions.set(subscriptionId, local)
    let mainSubscription: StandalonePlayerSubscriptionRef | undefined
    try {
      const response = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.subscribe, { subscriptionId })
      mainSubscription = readSubscriptionRef(response, subscriptionId)
      if (!mainSubscription || !isPlainRecord(response) || !isEnvelope(response.envelope)) {
        throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
      }
      local.generation = mainSubscription.generation
      const initial = adopt(response.envelope)
      deliver(local, initial)
      local.buffered.sort((left, right) => left.envelope.revision - right.envelope.revision)
      for (const update of local.buffered) {
        if (update.generation === local.generation) adopt(update.envelope)
      }
      local.buffered.length = 0
      return { subscriptionId, generation: local.generation }
    } catch (error) {
      if (mainSubscription) {
        await invoke<boolean>(STANDALONE_PLAYER_IPC_CHANNELS.unsubscribe, mainSubscription).catch(() => false)
      }
      subscriptions.delete(subscriptionId)
      removeSnapshotListenerWhenUnused()
      throw error
    }
  },
  unsubscribe: async (subscription: StandalonePlayerSubscriptionRef) => {
    const local = subscriptions.get(subscription.subscriptionId)
    if (local && local.generation === subscription.generation) subscriptions.delete(subscription.subscriptionId)
    removeSnapshotListenerWhenUnused()
    return invoke<boolean>(STANDALONE_PLAYER_IPC_CHANNELS.unsubscribe, subscription)
  }
})

function readSubscriptionRef(value: unknown, expectedId: string): StandalonePlayerSubscriptionRef | undefined {
  if (!isPlainRecord(value) || !isPlainRecord(value.subscription) ||
      value.subscription.subscriptionId !== expectedId || !Number.isSafeInteger(value.subscription.generation) ||
      (value.subscription.generation as number) < 1) return undefined
  return { subscriptionId: expectedId, generation: value.subscription.generation as number }
}

function isMetadataPreview(value: unknown): value is StandalonePlayerMetadataPreview {
  return isPlainRecord(value) && hasExactKeys(value, ['catalogRevision', 'title', 'artist']) &&
    (value.catalogRevision === null || (typeof value.catalogRevision === 'string' && value.catalogRevision.length <= 128)) &&
    (value.title === null || (typeof value.title === 'string' && value.title.length <= 4096)) &&
    (value.artist === null || (typeof value.artist === 'string' && value.artist.length <= 4096))
}

contextBridge.exposeInMainWorld('standalonePlayer', api)
