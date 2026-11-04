import { contextBridge, ipcRenderer } from 'electron'
import type {
  StandalonePlayerCommandRequest,
  StandalonePlayerSnapshot,
  StandaloneStableState
} from './src/standalone-player-contracts'
import {
  STANDALONE_PLAYER_IPC_CHANNELS,
  type StandalonePlayerRendererApi,
  type StandalonePlayerIpcCommandReply,
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
let nextSubscriptionId = 0
let newestEnvelope: StandalonePlayerSnapshotEnvelope | undefined
let snapshotListenerAttached = false
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
  return isPlainRecord(value) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 &&
    isPlainRecord(value.snapshot) &&
    ['ready', 'transitioning', 'blocked', 'uncertain'].includes(String(value.snapshot.playbackCondition))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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
    return {
      playbackCondition: 'transitioning',
      lastConfirmedState: cloneStableState(snapshot.lastConfirmedState),
      pending: snapshot.pending.map(entry => ({ entryId: entry.entryId, musicCode: entry.musicCode }))
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

contextBridge.exposeInMainWorld('standalonePlayer', api)
