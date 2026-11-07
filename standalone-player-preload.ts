import { contextBridge, ipcRenderer } from 'electron'
import { STANDALONE_CELEBRATION_MESSAGES } from './src/standalone-player-contracts'
import type {
  StandalonePlayerCommandRequest,
  StandalonePlayerSnapshot,
  StandaloneStableState
} from './src/standalone-player-contracts'
import {
  STANDALONE_PLAYER_IPC_CHANNELS,
  type StandaloneCurrentTrackMetadata,
  type StandaloneCatalogImportIssuesPage,
  type StandalonePlayerRendererApi,
  type StandalonePlayerIpcCommandReply,
  type StandalonePlayerMetadataPreview,
  type StandalonePlayerOptionsActionReply,
  type StandalonePlayerOptionsSnapshot,
  type StandalonePlayerSnapshotEnvelope,
  type StandalonePlayerSnapshotUpdate,
  type StandalonePlayerSubscriptionRef,
  type StandalonePlayerVideoBounds,
  type StandaloneExitConfirmationRequestReply,
  type StandaloneExitConfirmationResolution,
  type StandaloneExitConfirmationResolutionReply
} from './src/standalone-player-ipc-contracts'

interface LocalSubscription {
  readonly listener: (envelope: StandalonePlayerSnapshotEnvelope) => void
  generation?: number
  revision: number
  readonly buffered: StandalonePlayerSnapshotUpdate[]
}

const subscriptions = new Map<string, LocalSubscription>()
const catalogRevisionListeners = new Set<(revision: string | null) => void>()
const optionsListeners = new Set<(snapshot: StandalonePlayerOptionsSnapshot) => void>()
const exitConfirmationListeners = new Set<(requestId: string) => void>()
let nextSubscriptionId = 0
let newestEnvelope: StandalonePlayerSnapshotEnvelope | undefined
let snapshotListenerAttached = false
let catalogRevisionListenerAttached = false
let optionsListenerAttached = false
let exitConfirmationListenerAttached = false
const ipcErrorCodes = new Set([
  'STANDALONE_IPC_DISPOSED',
  'STANDALONE_IPC_FAILED',
  'STANDALONE_IPC_FORBIDDEN',
  'STANDALONE_IPC_INVALID_DOCUMENT',
  'STANDALONE_IPC_INVALID_LISTENER',
  'STANDALONE_IPC_INVALID_REQUEST',
  'STANDALONE_IPC_INVALID_RESPONSE',
  'STANDALONE_IPC_EXIT_FALLBACK_FAILED',
  'STANDALONE_IPC_CLOSING',
  'STANDALONE_IPC_SUBSCRIPTION_EXISTS',
  'STANDALONE_IPC_SUBSCRIPTION_LIMIT',
  'STANDALONE_OPTIONS_CLOSED'
])

const optionsLibraryScanStatuses = new Set(['not-scanned', 'scanning', 'ready', 'degraded', 'closed'])
const optionsActionCodes = new Set([
  'PLAYER_NOT_IDLE', 'LIBRARY_BUSY', 'OPTIONS_BUSY', 'OPTIONS_FAILED', 'CATALOG_IMPORT_FAILED',
  'CATALOG_CONFIRMATION_STALE'
])

function isEnvelope(value: unknown): value is StandalonePlayerSnapshotEnvelope {
  return isPlainRecord(value) && hasExactKeys(value, ['revision', 'snapshot']) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 && isSnapshot(value.snapshot)
}

function isOptionsSnapshot(value: unknown): value is StandalonePlayerOptionsSnapshot {
  return isPlainRecord(value) && hasExactKeys(value, ['revision', 'library', 'catalog']) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 &&
    isPlainRecord(value.library) && hasExactKeys(value.library, ['folderName', 'scanStatus', 'indexedFiles']) &&
    (value.library.folderName === null || (typeof value.library.folderName === 'string' && value.library.folderName.length <= 255)) &&
    typeof value.library.scanStatus === 'string' && optionsLibraryScanStatuses.has(value.library.scanStatus) &&
    (value.library.indexedFiles === null || (Number.isSafeInteger(value.library.indexedFiles) && (value.library.indexedFiles as number) >= 0)) &&
    isPlainRecord(value.catalog) && hasExactKeys(value.catalog,
      ['fileName', 'recordCount', 'importedAt', 'revision', 'importIssueCount', 'importGeneration']) &&
    (value.catalog.fileName === null || (typeof value.catalog.fileName === 'string' && value.catalog.fileName.length <= 255)) &&
    Number.isSafeInteger(value.catalog.recordCount) && (value.catalog.recordCount as number) >= 0 &&
    (value.catalog.importedAt === null || (typeof value.catalog.importedAt === 'string' && value.catalog.importedAt.length <= 128)) &&
    (value.catalog.revision === null || (typeof value.catalog.revision === 'string' && /^[a-f0-9]{64}$/.test(value.catalog.revision))) &&
    Number.isSafeInteger(value.catalog.importIssueCount) && (value.catalog.importIssueCount as number) >= 0 &&
    (value.catalog.importIssueCount as number) <= 100_000 &&
    Number.isSafeInteger(value.catalog.importGeneration) && (value.catalog.importGeneration as number) >= 0
}

function isOptionsActionReply(value: unknown): value is StandalonePlayerOptionsActionReply {
  if (!isPlainRecord(value) || !['confirmed', 'cancelled', 'blocked', 'failed', 'confirmation-required'].includes(String(value.outcome)) ||
      (value.code !== undefined && (typeof value.code !== 'string' || !optionsActionCodes.has(value.code))) ||
      !isOptionsSnapshot(value.snapshot)) return false
  const hasConfirmation = value.confirmation !== undefined
  const expected = ['outcome', 'snapshot']
  if (value.code !== undefined) expected.push('code')
  if (hasConfirmation) expected.push('confirmation')
  if (!hasExactKeys(value, expected)) return false
  if (value.outcome === 'confirmation-required') {
    return isPlainRecord(value.confirmation) && hasExactKeys(value.confirmation,
      ['token', 'recordCount', 'issueCount', 'currentRecordCount']) &&
      typeof value.confirmation.token === 'string' && /^[0-9a-f-]{36}$/.test(value.confirmation.token) &&
      Number.isSafeInteger(value.confirmation.recordCount) && (value.confirmation.recordCount as number) > 0 &&
      Number.isSafeInteger(value.confirmation.issueCount) && (value.confirmation.issueCount as number) > 0 &&
      Number.isSafeInteger(value.confirmation.currentRecordCount) && (value.confirmation.currentRecordCount as number) >= 0
  }
  return !hasConfirmation
}

function isCatalogImportIssuesPage(value: unknown): value is StandaloneCatalogImportIssuesPage {
  return isPlainRecord(value) && hasExactKeys(value, ['catalogRevision', 'generation', 'total', 'offset', 'issues']) &&
    (value.catalogRevision === null || (typeof value.catalogRevision === 'string' && /^[a-f0-9]{64}$/.test(value.catalogRevision))) &&
    Number.isSafeInteger(value.generation) && (value.generation as number) >= 0 &&
    Number.isSafeInteger(value.total) && (value.total as number) >= 0 && (value.total as number) <= 100_000 &&
    Number.isSafeInteger(value.offset) && (value.offset as number) >= 0 && Array.isArray(value.issues) &&
    value.issues.length <= 100 && value.issues.every(issue => isPlainRecord(issue) &&
      hasExactKeys(issue, ['rowNumber', 'field', 'value', 'code', 'reason']) &&
      Number.isSafeInteger(issue.rowNumber) && (issue.rowNumber as number) > 0 && issue.field === 'numero' &&
      typeof issue.value === 'string' && issue.value.length <= 4096 && issue.code === 'INVALID_MUSIC_NUMBER' &&
      typeof issue.reason === 'string' && issue.reason.length <= 512)
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isExitConfirmationRequestReply(value: unknown): value is StandaloneExitConfirmationRequestReply {
  if (!isPlainRecord(value) || typeof value.outcome !== 'string') return false
  if (value.outcome === 'pending') {
    return hasExactKeys(value, ['outcome', 'requestId']) && typeof value.requestId === 'string' && isUuid(value.requestId)
  }
  return hasExactKeys(value, ['outcome']) && ['authorized', 'native-fallback', 'unavailable'].includes(value.outcome)
}

function isExitConfirmationResolutionReply(value: unknown): value is StandaloneExitConfirmationResolutionReply {
  return isPlainRecord(value) && hasExactKeys(value, ['requestId', 'outcome']) &&
    typeof value.requestId === 'string' && isUuid(value.requestId) &&
    ['confirmed', 'cancelled', 'stale', 'already-authorized'].includes(String(value.outcome))
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

function onOptionsChanged(_event: Electron.IpcRendererEvent, value: unknown): void {
  if (!isOptionsSnapshot(value)) return
  const snapshot = cloneOptionsSnapshot(value)
  for (const listener of [...optionsListeners]) {
    try { listener(snapshot) } catch { /* Renderer observers cannot break the restricted preload bridge. */ }
  }
}

function removeOptionsListenerWhenUnused(): void {
  if (!optionsListenerAttached || optionsListeners.size > 0) return
  ipcRenderer.removeListener(STANDALONE_PLAYER_IPC_CHANNELS.optionsChanged, onOptionsChanged)
  optionsListenerAttached = false
}

function clearOptionsListeners(): void {
  optionsListeners.clear()
  removeOptionsListenerWhenUnused()
}

function onExitConfirmationRequested(_event: Electron.IpcRendererEvent, value: unknown): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['requestId']) ||
      typeof value.requestId !== 'string' || !isUuid(value.requestId)) return
  for (const listener of [...exitConfirmationListeners]) {
    try { listener(value.requestId) } catch { /* UI observers cannot affect the restricted IPC bridge. */ }
  }
}

function removeExitConfirmationListenerWhenUnused(): void {
  if (!exitConfirmationListenerAttached || exitConfirmationListeners.size > 0) return
  ipcRenderer.removeListener(STANDALONE_PLAYER_IPC_CHANNELS.exitConfirmationRequested, onExitConfirmationRequested)
  exitConfirmationListenerAttached = false
}

function clearExitConfirmationListeners(): void {
  exitConfirmationListeners.clear()
  removeExitConfirmationListenerWhenUnused()
}

window.addEventListener('pagehide', clearCatalogRevisionListeners, { once: true })
window.addEventListener('pagehide', clearOptionsListeners, { once: true })
window.addEventListener('pagehide', clearExitConfirmationListeners, { once: true })

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
  getCurrentTrackMetadata: async () => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.getCurrentTrackMetadata)
    if (received === null) return null
    if (!isCurrentTrackMetadata(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return {
      catalogRevision: received.catalogRevision,
      title: received.title,
      artist: received.artist,
      entryId: received.entryId,
      attemptId: received.attemptId,
      musicCode: received.musicCode
    }
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
  getOptionsSnapshot: async () => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.getOptionsSnapshot)
    if (!isOptionsSnapshot(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return cloneOptionsSnapshot(received)
  },
  selectVideoFolder: async () => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.selectVideoFolder)
    if (!isOptionsActionReply(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return cloneOptionsActionReply(received)
  },
  refreshVideoLibrary: async () => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.refreshVideoLibrary)
    if (!isOptionsActionReply(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return cloneOptionsActionReply(received)
  },
  importMusicCatalog: async () => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.importMusicCatalog)
    if (!isOptionsActionReply(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return cloneOptionsActionReply(received)
  },
  confirmMusicCatalogImport: async (token: string) => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.confirmMusicCatalogImport, token)
    if (!isOptionsActionReply(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return cloneOptionsActionReply(received)
  },
  cancelMusicCatalogImport: async (token: string) => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.cancelMusicCatalogImport, token)
    if (typeof received !== 'boolean') throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return received
  },
  getCatalogImportIssuesPage: async (catalogRevision: string, generation: number, offset: number) => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.getCatalogImportIssuesPage,
      { catalogRevision, generation, offset })
    if (!isCatalogImportIssuesPage(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return received
  },
  onOptionsChanged: (listener: (snapshot: StandalonePlayerOptionsSnapshot) => void) => {
    if (typeof listener !== 'function') throw new Error('STANDALONE_IPC_INVALID_LISTENER')
    optionsListeners.add(listener)
    if (!optionsListenerAttached) {
      ipcRenderer.on(STANDALONE_PLAYER_IPC_CHANNELS.optionsChanged, onOptionsChanged)
      optionsListenerAttached = true
    }
    return () => {
      optionsListeners.delete(listener)
      removeOptionsListenerWhenUnused()
    }
  },
  requestExitConfirmation: async () => {
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.requestExitConfirmation)
    if (!isExitConfirmationRequestReply(received)) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return received
  },
  resolveExitConfirmation: async (resolution: StandaloneExitConfirmationResolution) => {
    if (!isPlainRecord(resolution) || !hasExactKeys(resolution, ['requestId', 'decision']) ||
        typeof resolution.requestId !== 'string' || !isUuid(resolution.requestId) ||
        (resolution.decision !== 'confirm' && resolution.decision !== 'cancel')) {
      throw new Error('STANDALONE_IPC_INVALID_REQUEST')
    }
    const received = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.resolveExitConfirmation, resolution)
    if (!isExitConfirmationResolutionReply(received) || received.requestId !== resolution.requestId) {
      throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    }
    return received
  },
  onExitConfirmationRequested: (listener: (requestId: string) => void) => {
    if (typeof listener !== 'function') throw new Error('STANDALONE_IPC_INVALID_LISTENER')
    if (!exitConfirmationListenerAttached) {
      ipcRenderer.on(STANDALONE_PLAYER_IPC_CHANNELS.exitConfirmationRequested, onExitConfirmationRequested)
      exitConfirmationListenerAttached = true
    }
    exitConfirmationListeners.add(listener)
    return () => {
      exitConfirmationListeners.delete(listener)
      removeExitConfirmationListenerWhenUnused()
    }
  },
  showPlaybackSurface: async (bounds: StandalonePlayerVideoBounds) => {
    if (!isPlainRecord(bounds) || !hasExactKeys(bounds, ['x', 'y', 'width', 'height']) ||
        ![bounds.x, bounds.y, bounds.width, bounds.height].every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('STANDALONE_IPC_INVALID_REQUEST')
    }
    const result = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.showPlaybackSurface, bounds)
    if (typeof result !== 'boolean') throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return result
  },
  hidePlaybackSurface: async () => {
    const result = await invoke<unknown>(STANDALONE_PLAYER_IPC_CHANNELS.hidePlaybackSurface)
    if (typeof result !== 'boolean') throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
    return result
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

function isCurrentTrackMetadata(value: unknown): value is StandaloneCurrentTrackMetadata {
  return isPlainRecord(value) && hasExactKeys(value, [
    'catalogRevision', 'title', 'artist', 'entryId', 'attemptId', 'musicCode'
  ]) &&
    (value.catalogRevision === null || (typeof value.catalogRevision === 'string' && value.catalogRevision.length <= 128)) &&
    (value.title === null || (typeof value.title === 'string' && value.title.length <= 4096)) &&
    (value.artist === null || (typeof value.artist === 'string' && value.artist.length <= 4096)) &&
    typeof value.entryId === 'string' && value.entryId.length > 0 && value.entryId.length <= 128 &&
    typeof value.attemptId === 'string' && value.attemptId.length > 0 && value.attemptId.length <= 128 &&
    typeof value.musicCode === 'string' && /^[0-9]{5}$/.test(value.musicCode)
}

function cloneOptionsSnapshot(snapshot: StandalonePlayerOptionsSnapshot): StandalonePlayerOptionsSnapshot {
  return { revision: snapshot.revision, library: { ...snapshot.library }, catalog: { ...snapshot.catalog } }
}

function cloneOptionsActionReply(reply: StandalonePlayerOptionsActionReply): StandalonePlayerOptionsActionReply {
  return {
    outcome: reply.outcome,
    ...(reply.code ? { code: reply.code } : {}),
    ...(reply.confirmation ? { confirmation: { ...reply.confirmation } } : {}),
    snapshot: cloneOptionsSnapshot(reply.snapshot)
  }
}

contextBridge.exposeInMainWorld('standalonePlayer', api)
