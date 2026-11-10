import type { KaraokeApplication, ReadonlyAppState } from './application'
import type { LegacyStateStorageDto } from './persistence-contracts'

/** Explicit serializable input used by the local Main/Renderer command bridge. */
export interface ManagementQueueEntryInputDto {
  readonly name: string
  readonly songNumber: string
  readonly songNumber2: string
  readonly table: string
}

export interface ManagementQueueEntryDto {
  readonly id: string
  readonly name: string
  readonly songNumber: string
  readonly songNumber2: string
  readonly table: string
  readonly insertedAt: number
  readonly status: EntryStatus
  readonly sessionId: string | null
  readonly doneAt?: number
  readonly cancelledAt?: number
}

export interface ManagementSessionDto {
  readonly id: string
  readonly startedAt: number
  readonly endedAt: number | null
}

/** Explicit structured-clone-safe view; it contains no application/service references. */
export interface ManagementStateDto {
  readonly queue: readonly ManagementQueueEntryDto[]
  readonly history: readonly ManagementQueueEntryDto[]
  readonly sessions: readonly ManagementSessionDto[]
  readonly currentSessionId: string | null
  readonly priorityIds: readonly string[]
  readonly fixedTurnPositions: Readonly<Record<string, number>>
  readonly frozenTurnIds: readonly string[]
  readonly queueOrderPolicyVersion: number
  readonly regularsSinceDebut: number
  readonly currentTurnAutomatic: boolean
  readonly nextTurnId: string | null
  readonly currentTurnId: string | null
  readonly lastReset: string | null
}

export interface ManagementSnapshot {
  readonly hostEpoch: string
  readonly revision: number
  readonly state: ManagementStateDto
  readonly didRecoverEndedSession: boolean
  readonly didStartFreshSessionOnLoad: boolean
  readonly didImportLegacyStorage: boolean
}

export type ManagementCommand =
  | { type: 'addEntries'; entries: ManagementQueueEntryInputDto[]; selectCurrent: boolean }
  | { type: 'editEntry'; id: string; input: ManagementQueueEntryInputDto }
  | { type: 'cancelAndAdvance'; id: string }
  | { type: 'completeAndAdvance'; id: string }
  | { type: 'moveTurn'; id: string; targetPosition: number }
  | { type: 'pinNext'; id: string }
  | { type: 'unpin'; id: string }
  | { type: 'promoteToCurrent'; id: string }
  | { type: 'freezeThrough'; id: string }
  | { type: 'releaseFreeze' }
  | { type: 'startNewSession' }
  | { type: 'ensureSession' }
  | { type: 'resetTableHistory'; table: string }
  | { type: 'recoverPersistence' }

export interface ManagementCommandRequest {
  readonly operationId: string
  readonly command: ManagementCommand
}

export interface ManagementCommandReply<T = unknown> {
  readonly operationId: string
  readonly result: T
  readonly snapshot: ManagementSnapshot
}

export type ManagementApplicationPort = Pick<Readonly<KaraokeApplication>,
  'state' | 'getPlayOrder' | 'canMoveTurn' | 'addEntries' | 'editEntry' | 'cancelAndAdvance' |
  'completeAndAdvance' | 'moveTurn' | 'pinNext' | 'unpin' | 'promoteToCurrent' |
  'freezeThrough' | 'releaseFreeze' | 'startNewSession' | 'ensureSession' |
  'resetTableHistory' | 'recoverPersistence'> & {
    readonly didRecoverEndedSession: boolean
    readonly didStartFreshSessionOnLoad: boolean
    flush(): Promise<void>
  }

export interface ManagementRendererClientPort extends ManagementApplicationPort {
  connect(): Promise<ManagementSnapshot>
  closeSummary(): { sessionActive: boolean; uncompletedCount: number; sessionId: string | null }
}

export interface ManagementRendererBridge {
  initialize(legacyState: LegacyStateStorageDto): Promise<ManagementSnapshot>
  getSnapshot(): Promise<ManagementSnapshot>
  command(request: ManagementCommandRequest): Promise<ManagementCommandReply>
  acknowledge(operationId: string): Promise<void>
  flush(): Promise<void>
  onStateChanged(callback: (snapshot: ManagementSnapshot) => void): () => void
}

export function toManagementStateDto(state: ReadonlyAppState): ManagementStateDto {
  return {
    queue: state.queue.map(entry => ({
      id: entry.id, name: entry.name, songNumber: entry.songNumber, songNumber2: entry.songNumber2,
      table: entry.table, insertedAt: entry.insertedAt, status: entry.status, sessionId: entry.sessionId,
      ...(entry.doneAt === undefined ? {} : { doneAt: entry.doneAt }),
      ...(entry.cancelledAt === undefined ? {} : { cancelledAt: entry.cancelledAt })
    })),
    history: state.history.map(entry => ({
      id: entry.id, name: entry.name, songNumber: entry.songNumber, songNumber2: entry.songNumber2,
      table: entry.table, insertedAt: entry.insertedAt, status: entry.status, sessionId: entry.sessionId,
      ...(entry.doneAt === undefined ? {} : { doneAt: entry.doneAt }),
      ...(entry.cancelledAt === undefined ? {} : { cancelledAt: entry.cancelledAt })
    })),
    sessions: state.sessions.map(session => ({ id: session.id, startedAt: session.startedAt, endedAt: session.endedAt })),
    currentSessionId: state.currentSessionId,
    priorityIds: [...state.priorityIds],
    fixedTurnPositions: { ...state.fixedTurnPositions },
    frozenTurnIds: [...state.frozenTurnIds],
    queueOrderPolicyVersion: state.queueOrderPolicyVersion,
    regularsSinceDebut: state.regularsSinceDebut,
    currentTurnAutomatic: state.currentTurnAutomatic,
    nextTurnId: state.nextTurnId,
    currentTurnId: state.currentTurnId,
    lastReset: state.lastReset
  }
}
