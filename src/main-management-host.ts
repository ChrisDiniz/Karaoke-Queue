import { randomUUID } from 'node:crypto'
import type { KaraokeApplication } from './application'
import {
  toManagementStateDto, type ManagementCommand, type ManagementCommandReply,
  type ManagementCommandRequest, type ManagementSnapshot
} from './management-contracts'
import type { LegacyStateStorageDto } from './persistence-contracts'

export interface MainManagementHostOptions {
  hostEpoch?: string
  publish?(snapshot: ManagementSnapshot): void
  installLegacyStorage?(values: LegacyStateStorageDto): void
}

/** Sole Main-process owner for operational Management state and its confirmed revision. */
export class MainManagementHost {
  private readonly hostEpoch: string
  private revision = 0
  private initialization: Promise<ManagementSnapshot> | null = null
  private initialized = false
  private didImportLegacyStorage = false
  private readonly receipts = new Map<string, { fingerprint: string; result: unknown }>()
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<ManagementCommandReply> }>()
  private readonly subscribers = new Set<(snapshot: ManagementSnapshot) => void>()

  constructor(
    private readonly application: KaraokeApplication,
    private readonly options: MainManagementHostOptions = {}
  ) {
    this.hostEpoch = options.hostEpoch ?? randomUUID()
  }

  get isInitialized(): boolean { return this.initialized }

  initialize(readOnly = false, legacyState?: LegacyStateStorageDto): Promise<ManagementSnapshot> {
    if (this.initialization) return this.initialization
    if (legacyState) this.options.installLegacyStorage?.(legacyState)
    const initialization = (async () => {
      this.didImportLegacyStorage = await this.application.load(readOnly) || this.didImportLegacyStorage
      if (!readOnly) await this.application.ensureCurrentTurn()
      this.initialized = true
      this.revision = 1
      return this.snapshot()
    })()
    this.initialization = initialization
    void initialization.catch(() => {
      if (!this.initialized && this.initialization === initialization) this.initialization = null
    })
    return initialization
  }

  snapshot(): ManagementSnapshot {
    this.assertInitialized()
    return this.createSnapshot()
  }

  subscribe(listener: (snapshot: ManagementSnapshot) => void): () => void {
    this.subscribers.add(listener)
    let active = true
    return () => { if (active) { active = false; this.subscribers.delete(listener) } }
  }

  async execute(request: ManagementCommandRequest): Promise<ManagementCommandReply> {
    this.assertInitialized()
    if (!request || typeof request.operationId !== 'string' || request.operationId.length < 1 || request.operationId.length > 128) {
      throw new Error('INVALID_MANAGEMENT_OPERATION_ID')
    }
    const fingerprint = JSON.stringify(request.command)
    const previous = this.receipts.get(request.operationId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('MANAGEMENT_OPERATION_ID_CONFLICT')
      return { operationId: request.operationId, result: structuredClone(previous.result), snapshot: this.createSnapshot() }
    }
    const pending = this.inFlight.get(request.operationId)
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new Error('MANAGEMENT_OPERATION_ID_CONFLICT')
      return structuredClone(await pending.promise)
    }
    const operation = this.executeOnce(request, fingerprint)
    this.inFlight.set(request.operationId, { fingerprint, promise: operation })
    try { return structuredClone(await operation) }
    finally {
      if (this.inFlight.get(request.operationId)?.promise === operation) this.inFlight.delete(request.operationId)
    }
  }

  acknowledge(operationId: string): void {
    this.receipts.delete(operationId)
  }

  private async executeOnce(request: ManagementCommandRequest, fingerprint: string): Promise<ManagementCommandReply> {
    const result = await this.runCommand(request.command)
    // KaraokeApplication resolves only after its repository write is confirmed and
    // publishes its candidate. The DTO is created afterward, never before commit.
    this.revision++
    const reply: ManagementCommandReply = {
      operationId: request.operationId,
      result: structuredClone(result),
      snapshot: this.createSnapshot()
    }
    // Retain only the small result until the Renderer acknowledges receipt. This
    // is process-local retry protection, not a durable journal across restart.
    this.receipts.set(request.operationId, { fingerprint, result: structuredClone(result) })
    this.publish(reply.snapshot)
    return reply
  }

  async prepareToClose(): Promise<void> { this.assertInitialized(); await this.application.prepareToClose() }
  cancelClose(): void { this.assertInitialized(); this.application.cancelClose() }
  async flush(): Promise<void> { this.assertInitialized(); await this.application.flush() }

  closeSummary(): { sessionActive: boolean; uncompletedCount: number; sessionId: string | null } {
    this.assertInitialized()
    const state = this.application.state
    const session = state.sessions.find(item => item.id === state.currentSessionId)
    const pending = state.queue.filter(entry => entry.status === 'pending')
    const ids = new Set(pending.map(entry => entry.id))
    if (state.currentTurnId && state.queue.some(entry => entry.id === state.currentTurnId)) ids.add(state.currentTurnId)
    return { sessionActive: Boolean(session && session.endedAt == null), uncompletedCount: ids.size,
      sessionId: session?.id ?? null }
  }

  async endSessionAndArchive(): Promise<boolean> {
    this.assertInitialized()
    const result = await this.application.endCurrentSession()
    this.revision++
    this.publish(this.createSnapshot())
    return result
  }

  private async runCommand(command: ManagementCommand): Promise<unknown> {
    if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
      throw new Error('INVALID_MANAGEMENT_COMMAND')
    }
    switch (command.type) {
      case 'addEntries': return this.application.addEntries(command.entries, command.selectCurrent)
      case 'editEntry': return this.application.editEntry(command.id, command.input)
      case 'cancelAndAdvance': return this.application.cancelAndAdvance(command.id)
      case 'completeAndAdvance': return this.application.completeAndAdvance(command.id)
      case 'moveTurn': return this.application.moveTurn(command.id, command.targetPosition)
      case 'pinNext': return this.application.pinNext(command.id)
      case 'unpin': return this.application.unpin(command.id)
      case 'promoteToCurrent': return this.application.promoteToCurrent(command.id)
      case 'freezeThrough': return this.application.freezeThrough(command.id)
      case 'releaseFreeze': return this.application.releaseFreeze()
      case 'startNewSession': return this.application.startNewSession()
      case 'ensureSession': return this.application.ensureSession()
      case 'resetTableHistory': return this.application.resetTableHistory(command.table)
      case 'recoverPersistence': return this.application.recoverPersistence()
      default: return this.unreachable(command)
    }
  }

  private createSnapshot(): ManagementSnapshot {
    return structuredClone({
      hostEpoch: this.hostEpoch,
      revision: this.revision,
      state: toManagementStateDto(this.application.state),
      didRecoverEndedSession: this.application.didRecoverEndedSession,
      didStartFreshSessionOnLoad: this.application.didStartFreshSessionOnLoad,
      didImportLegacyStorage: this.didImportLegacyStorage
    })
  }

  private publish(snapshot: ManagementSnapshot): void {
    const copy = structuredClone(snapshot)
    this.options.publish?.(copy)
    for (const subscriber of this.subscribers) subscriber(structuredClone(copy))
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('MANAGEMENT_HOST_NOT_INITIALIZED')
  }

  private unreachable(value: never): never { throw new Error(`UNSUPPORTED_MANAGEMENT_COMMAND:${String(value)}`) }
}
