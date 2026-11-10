import { canMoveManagementTurn, getManagementPlayOrder } from './management-projections'
import type { NewQueueEntry } from './application'
import type {
  ManagementCommand, ManagementCommandReply, ManagementRendererBridge,
  ManagementRendererClientPort, ManagementSnapshot, ManagementStateDto
} from './management-contracts'
import { LEGACY_STATE_STORAGE_KEYS, PersistenceError, type LegacyStateStorageDto } from './persistence-contracts'

export interface ManagementLegacyStorageHandoff {
  read(): LegacyStateStorageDto
  clearImported(values: LegacyStateStorageDto): void
}

const EMPTY_LEGACY_STORAGE: LegacyStateStorageDto = Object.fromEntries(
  Object.values(LEGACY_STATE_STORAGE_KEYS).map(key => [key, null])
) as LegacyStateStorageDto

const EMPTY_STATE: ManagementStateDto = {
  queue: [], history: [], sessions: [], currentSessionId: null, priorityIds: [],
  fixedTurnPositions: {}, frozenTurnIds: [], queueOrderPolicyVersion: 0,
  regularsSinceDebut: 0, currentTurnAutomatic: false, nextTurnId: null,
  currentTurnId: null, lastReset: null
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(freezeDeep)
    Object.freeze(value)
  }
  return value
}

/** Renderer adapter: it holds only a frozen serializable confirmed projection. */
export class ManagementClient implements ManagementRendererClientPort {
  private confirmedState = freezeDeep(structuredClone(EMPTY_STATE))
  private hostEpoch = ''
  private revision = -1
  private recoveredEndedSession = false
  private freshSessionOnLoad = false
  private importedLegacyStorage = false
  private connected = false
  private connecting: Promise<ManagementSnapshot> | null = null
  private unsubscribeBridge: (() => void) | null = null
  private bufferedSnapshots: ManagementSnapshot[] = []
  private readonly listeners = new Set<(snapshot: ManagementSnapshot) => void>()
  private readonly retryOperationIds = new Map<string, string>()

  constructor(
    private readonly bridge: ManagementRendererBridge,
    private readonly legacyStorage?: ManagementLegacyStorageHandoff
  ) {}

  get state() { return this.confirmedState }
  get didRecoverEndedSession(): boolean { return this.recoveredEndedSession }
  get didStartFreshSessionOnLoad(): boolean { return this.freshSessionOnLoad }

  connect(): Promise<ManagementSnapshot> {
    if (this.connecting) return this.connecting
    if (this.connected) return Promise.resolve(this.currentSnapshot())
    this.bufferedSnapshots = []
    this.unsubscribeBridge?.()
    this.unsubscribeBridge = this.bridge.onStateChanged(snapshot => {
      if (this.connecting) this.bufferedSnapshots.push(snapshot)
      else this.apply(snapshot, false)
    })
    const legacyState = this.legacyStorage?.read() ?? EMPTY_LEGACY_STORAGE
    this.connecting = this.bridge.initialize(legacyState).then(snapshot => {
      this.apply(snapshot, true)
      for (const buffered of this.bufferedSnapshots) this.apply(buffered, false)
      this.bufferedSnapshots = []
      this.connected = true
      if (snapshot.didImportLegacyStorage) {
        try { this.legacyStorage?.clearImported(legacyState) } catch { /* keep legacy values if local cleanup fails */ }
      }
      return this.currentSnapshot()
    }).finally(() => { this.connecting = null })
    return this.connecting
  }

  subscribe(listener: (snapshot: ManagementSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getPlayOrder() { return getManagementPlayOrder(this.confirmedState) }
  canMoveTurn(id: string, targetPosition: number): boolean {
    return canMoveManagementTurn(this.confirmedState, id, targetPosition)
  }

  addEntries(entries: NewQueueEntry[], selectCurrent = false) {
    return this.execute({ type: 'addEntries', entries, selectCurrent })
  }
  editEntry(id: string, input: NewQueueEntry) { return this.execute({ type: 'editEntry', id, input }) }
  cancelAndAdvance(id: string) { return this.execute({ type: 'cancelAndAdvance', id }) }
  completeAndAdvance(id: string, _doneAt = Date.now()) { return this.execute({ type: 'completeAndAdvance', id }) }
  moveTurn(id: string, targetPosition: number) { return this.execute({ type: 'moveTurn', id, targetPosition }) }
  pinNext(id: string) { return this.execute({ type: 'pinNext', id }) }
  unpin(id: string) { return this.execute({ type: 'unpin', id }) }
  promoteToCurrent(id: string) { return this.execute({ type: 'promoteToCurrent', id }) }
  freezeThrough(id: string) { return this.execute({ type: 'freezeThrough', id }) }
  releaseFreeze() { return this.execute({ type: 'releaseFreeze' }) }
  startNewSession() { return this.execute({ type: 'startNewSession' }) }
  ensureSession() { return this.execute({ type: 'ensureSession' }) }
  resetTableHistory(table: string) { return this.execute({ type: 'resetTableHistory', table }) }
  recoverPersistence() { return this.execute({ type: 'recoverPersistence' }) }

  async flush(): Promise<void> { await this.bridge.flush() }
  closeSummary() {
    const state = this.confirmedState
    const session = state.sessions.find(item => item.id === state.currentSessionId)
    const ids = new Set(state.queue.filter(entry => entry.status === 'pending').map(entry => entry.id))
    if (state.currentTurnId && state.queue.some(entry => entry.id === state.currentTurnId)) ids.add(state.currentTurnId)
    return { sessionActive: Boolean(session && session.endedAt == null), uncompletedCount: ids.size,
      sessionId: session?.id ?? null }
  }

  get closeSessionEnded(): boolean {
    const current = this.confirmedState.sessions.find(session => session.id === this.confirmedState.currentSessionId)
    return !current || current.endedAt != null
  }

  private async execute(command: ManagementCommand): Promise<any> {
    if (!this.connected) await this.connect()
    const fingerprint = JSON.stringify(command)
    const operationId = this.retryOperationIds.get(fingerprint) ?? this.newOperationId()
    try {
      const reply = await this.bridge.command({ operationId, command }) as ManagementCommandReply
      this.retryOperationIds.delete(fingerprint)
      this.apply(reply.snapshot, false)
      void this.bridge.acknowledge(operationId).catch(() => undefined)
      return reply.result
    } catch (error) {
      try {
        const snapshot = await this.bridge.getSnapshot()
        const hostChanged = Boolean(this.hostEpoch && snapshot.hostEpoch !== this.hostEpoch)
        if (hostChanged) this.retryOperationIds.clear()
        this.apply(snapshot, true)
        if (!hostChanged) this.retryOperationIds.set(fingerprint, operationId)
      } catch { this.retryOperationIds.set(fingerprint, operationId) }
      throw this.normalizeError(error)
    }
  }

  private normalizeError(error: unknown): unknown {
    const message = error instanceof Error ? error.message : String(error)
    const match = /^KQ_PERSISTENCE_ERROR:(rejected|failed|uncertain):(.*)$/s.exec(message)
    return match ? new PersistenceError(match[1] as PersistenceError['outcome'], match[2]) : error
  }

  private newOperationId(): string {
    try { return crypto.randomUUID() } catch { return `management-${Date.now()}-${Math.random().toString(36).slice(2)}` }
  }

  private apply(snapshot: ManagementSnapshot, allowEpochChange: boolean): void {
    if (!snapshot || typeof snapshot.hostEpoch !== 'string' || !Number.isSafeInteger(snapshot.revision) || !snapshot.state) return
    if (this.hostEpoch && snapshot.hostEpoch !== this.hostEpoch && !allowEpochChange) return
    if (snapshot.hostEpoch === this.hostEpoch && snapshot.revision <= this.revision) return
    if (snapshot.hostEpoch !== this.hostEpoch) {
      this.hostEpoch = snapshot.hostEpoch
      this.revision = -1
    }
    this.confirmedState = freezeDeep(structuredClone(snapshot.state))
    this.revision = snapshot.revision
    this.recoveredEndedSession = snapshot.didRecoverEndedSession
    this.freshSessionOnLoad = snapshot.didStartFreshSessionOnLoad
    this.importedLegacyStorage = snapshot.didImportLegacyStorage
    const confirmed = this.currentSnapshot()
    for (const listener of this.listeners) listener(confirmed)
  }

  private currentSnapshot(): ManagementSnapshot {
    return { hostEpoch: this.hostEpoch, revision: this.revision, state: this.confirmedState,
      didRecoverEndedSession: this.recoveredEndedSession, didStartFreshSessionOnLoad: this.freshSessionOnLoad,
      didImportLegacyStorage: this.importedLegacyStorage }
  }
}
