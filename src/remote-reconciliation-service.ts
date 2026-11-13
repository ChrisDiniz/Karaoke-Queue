import { randomUUID } from 'node:crypto'
import type { OperationalMessage, OperationalQueryType } from './operational-protocol-contracts'
import { OPERATIONAL_LIMITS } from './operational-protocol-contracts'
import { parseOperationalMessageObject } from './operational-protocol-validation'
import type { ManagementRemoteJournalInbox } from './management-remote-journal'
import type { ManagementRemoteOutbox } from './management-remote-outbox'

export interface OperationalQueryPort {
  query(message: Extract<OperationalMessage, { kind: 'query' }>, signal: AbortSignal): Promise<unknown>
}

export interface ReconciliationIdentity { readonly playerDeviceId: string; readonly controllerId: string }
export interface ReconciliationHandshake { readonly journalId: string; readonly playerEpoch: string; readonly controlEpoch: string }

export type ReconciliationResult =
  | { readonly state: 'synchronized'; readonly throughSequence: number; readonly highWatermark: number; readonly pending: number }
  | { readonly state: 'recovery_required'; readonly reason: string; readonly throughSequence: number | null }

function responseRecoveryReason(message: OperationalMessage): string | null {
  if (message.kind !== 'error') return null
  if (message.body.state === 'recovery-required' || message.body.state === 'RECOVERY_REQUIRED') {
    return 'G4_PLAYER_OPERATIONAL_RECOVERY_REQUIRED'
  }
  if (message.body.code === 'REPLAY_COMPACTED') return 'MANAGEMENT_REMOTE_JOURNAL_REPLAY_COMPACTED'
  if (message.body.code === 'JOURNAL_MISMATCH') return 'MANAGEMENT_REMOTE_JOURNAL_LINEAGE_MISMATCH'
  return null
}

function inboxRecoveryReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  switch (error.message) {
    case 'MANAGEMENT_REMOTE_JOURNAL_LINEAGE_MISMATCH': return 'MANAGEMENT_REMOTE_JOURNAL_LINEAGE_MISMATCH'
    case 'MANAGEMENT_REMOTE_JOURNAL_REPLAY_COMPACTED': return 'MANAGEMENT_REMOTE_JOURNAL_REPLAY_COMPACTED'
    case 'MANAGEMENT_REMOTE_JOURNAL_CURSOR_GAP': return 'MANAGEMENT_REMOTE_JOURNAL_GAP'
    case 'MANAGEMENT_REMOTE_JOURNAL_ROLLBACK': return 'G4_REMOTE_JOURNAL_ROLLBACK'
    case 'MANAGEMENT_REMOTE_JOURNAL_RECOVERY_REQUIRED': return 'MANAGEMENT_REMOTE_JOURNAL_RECOVERY_REQUIRED'
    case 'MANAGEMENT_REMOTE_JOURNAL_EVENT_CONFLICT':
    case 'MANAGEMENT_REMOTE_JOURNAL_SNAPSHOT_CONFLICT': return 'G4_REMOTE_JOURNAL_EVIDENCE_CONFLICT'
    default: return null
  }
}

/** Reconciles durable G3 evidence. It never sends commands or emits business-consumption ACKs. */
export class ManagementRemoteReconciliationService {
  constructor(private readonly inbox: ManagementRemoteJournalInbox, private readonly outbox: ManagementRemoteOutbox,
    private readonly identity: ReconciliationIdentity, private readonly queryPort: OperationalQueryPort,
    private readonly now: () => number = () => Number(process.hrtime.bigint() / 1_000_000n),
    private readonly handshake?: ReconciliationHandshake) {}

  async reconcile(signal: AbortSignal, budgetMs = 30_000): Promise<ReconciliationResult> {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 30_000) throw new Error('G4_RECOVERY_BUDGET_INVALID')
    const deadline = this.now() + budgetMs
    let savedCursor = this.inbox.cursor(this.identity.playerDeviceId)
    const pending = this.outbox.recoverable(this.identity.playerDeviceId)
    let snapshotMessage: Extract<OperationalMessage, { kind: 'response' }> | undefined
    for (let generation = 0; generation < 8; generation++) {
      this.assertLive(signal, deadline)
      const snapshot = await this.query('snapshot', {}, signal, deadline)
      this.assertLive(signal, deadline)
      if (snapshot.kind !== 'response' || snapshot.body.type !== 'snapshot') {
        const blocked = responseRecoveryReason(snapshot)
        if (blocked) return this.recovery(blocked, savedCursor?.throughSequence ?? null)
        const detail = snapshot.kind === 'error' ? `${snapshot.body.code}_${snapshot.body.state}` :
          snapshot.kind === 'response' ? snapshot.body.type : snapshot.kind
        throw new Error(`G4_SNAPSHOT_RESPONSE_INVALID_${detail}`)
      }
      const payload = snapshot.body.payload as unknown as { journalId: string; highWatermark: number; compactedThrough: number }
      if (this.handshake && payload.journalId !== this.handshake.journalId) {
        return this.recovery('MANAGEMENT_REMOTE_JOURNAL_LINEAGE_MISMATCH', savedCursor?.throughSequence ?? null)
      }
      const snapshotEpochs = snapshot.body.payload as unknown as { playerEpoch: string; controlEpoch: string }
      if (this.handshake && (snapshotEpochs.playerEpoch !== this.handshake.playerEpoch ||
          snapshotEpochs.controlEpoch !== this.handshake.controlEpoch)) {
        return this.recovery('G4_OPERATIONAL_EPOCH_CHANGED_DURING_HANDSHAKE', savedCursor?.throughSequence ?? null)
      }
      if (savedCursor?.recoveryRequired) return this.recovery('MANAGEMENT_REMOTE_JOURNAL_RECOVERY_REQUIRED', savedCursor.throughSequence)
      if (savedCursor && savedCursor.journalId !== payload.journalId) return this.recovery('MANAGEMENT_REMOTE_JOURNAL_LINEAGE_MISMATCH', savedCursor.throughSequence)
      if (savedCursor && payload.highWatermark < savedCursor.highWatermark) {
        return this.recovery('G4_REMOTE_JOURNAL_ROLLBACK', savedCursor.throughSequence)
      }
      let through = savedCursor?.throughSequence ?? 0
      if (through < payload.compactedThrough) return this.recovery('MANAGEMENT_REMOTE_JOURNAL_REPLAY_COMPACTED', savedCursor ? through : null)
      if (!savedCursor && payload.compactedThrough > 0) return this.recovery('MANAGEMENT_REMOTE_JOURNAL_REPLAY_COMPACTED', null)

      let pageHighWatermark = payload.highWatermark
      while (through < pageHighWatermark) {
        this.assertLive(signal, deadline)
        const response = await this.query('journal-page', { journalId: payload.journalId,
          afterSequence: through, limit: OPERATIONAL_LIMITS.maxPageEvents }, signal, deadline)
        this.assertLive(signal, deadline)
        if (response.kind === 'error') {
          const reason = responseRecoveryReason(response) ?? 'G4_JOURNAL_PAGE_REJECTED'
          return this.recovery(reason, through)
        }
        if (response.kind !== 'response' || response.body.type !== 'journal-page') throw new Error('G4_JOURNAL_PAGE_RESPONSE_INVALID')
        const page = response.body.payload as unknown as { journalId: string; events: unknown[]; highWatermark: number; throughSequence: number }
        if (page.journalId !== payload.journalId) return this.recovery('MANAGEMENT_REMOTE_JOURNAL_LINEAGE_MISMATCH', through)
        const priorThrough = through
        // SQLite persistence is synchronous. This is the admission point: cancellation is
        // checked immediately before it, and no asynchronous continuation can interleave
        // between this check and the durable transaction.
        this.assertLive(signal, deadline)
        try { savedCursor = this.inbox.persistPage(this.identity.playerDeviceId, through, response) }
        catch (error) {
          const reason = inboxRecoveryReason(error)
          if (reason) return this.recovery(reason, through)
          throw error
        }
        through = savedCursor.throughSequence
        if (page.highWatermark < savedCursor.highWatermark) return this.recovery('G4_REMOTE_JOURNAL_ROLLBACK', through)
        pageHighWatermark = page.highWatermark
        if (through <= priorThrough && through < pageHighWatermark) return this.recovery('MANAGEMENT_REMOTE_JOURNAL_GAP', through)
      }
      // Snapshot persistence can fence an incomplete prefix in the v9 inbox. Persist it only
      // when the durable received cursor proves that the snapshot watermark is already covered.
      const freshSnapshot = await this.query('snapshot', {}, signal, deadline)
      this.assertLive(signal, deadline)
      if (freshSnapshot.kind !== 'response' || freshSnapshot.body.type !== 'snapshot') {
        const blocked = responseRecoveryReason(freshSnapshot)
        if (blocked) return this.recovery(blocked, this.inbox.cursor(this.identity.playerDeviceId)?.throughSequence ?? null)
        const detail = freshSnapshot.kind === 'error' ? `${freshSnapshot.body.code}_${freshSnapshot.body.state}` :
          freshSnapshot.kind === 'response' ? freshSnapshot.body.type : freshSnapshot.kind
        throw new Error(`G4_SNAPSHOT_RESPONSE_INVALID_${detail}`)
      }
      const fresh = freshSnapshot.body.payload as unknown as { journalId: string; highWatermark: number; compactedThrough: number }
      const freshEpochs = freshSnapshot.body.payload as unknown as { playerEpoch: string; controlEpoch: string }
      if (this.handshake && (freshEpochs.playerEpoch !== this.handshake.playerEpoch ||
          freshEpochs.controlEpoch !== this.handshake.controlEpoch)) {
        return this.recovery('G4_OPERATIONAL_EPOCH_CHANGED_DURING_HANDSHAKE', this.inbox.cursor(this.identity.playerDeviceId)?.throughSequence ?? null)
      }
      savedCursor = this.inbox.cursor(this.identity.playerDeviceId)
      if (fresh.journalId !== payload.journalId) return this.recovery('MANAGEMENT_REMOTE_JOURNAL_LINEAGE_MISMATCH', savedCursor?.throughSequence ?? null)
      if (fresh.highWatermark < payload.highWatermark || fresh.compactedThrough < payload.compactedThrough ||
          savedCursor && fresh.highWatermark < savedCursor.highWatermark) {
        return this.recovery('G4_REMOTE_JOURNAL_ROLLBACK', savedCursor?.throughSequence ?? null)
      }
      if (fresh.compactedThrough > (savedCursor?.throughSequence ?? 0)) {
        return this.recovery('MANAGEMENT_REMOTE_JOURNAL_REPLAY_COMPACTED', savedCursor?.throughSequence ?? null)
      }
      if ((savedCursor?.throughSequence ?? 0) < fresh.highWatermark) continue
      snapshotMessage = freshSnapshot
      // Snapshot admission is synchronous with the cancellation fence. If persistence has
      // already been admitted, its committed evidence remains valid; later cancellation still
      // prevents this attempt from reporting synchronized.
      this.assertLive(signal, deadline)
      try { this.inbox.persistSnapshot(this.identity.playerDeviceId, freshSnapshot) }
      catch (error) {
        const reason = inboxRecoveryReason(error)
        if (reason) return this.recovery(reason, savedCursor?.throughSequence ?? null)
        throw error
      }
      break
    }
    if (!snapshotMessage) return this.recovery('G4_JOURNAL_NOT_QUIESCENT_WITHIN_BUDGET', this.inbox.cursor(this.identity.playerDeviceId)?.throughSequence ?? null)

    let queried = 0
    for (const record of pending) {
      this.assertLive(signal, deadline)
      if (record.status === 'not-sent') continue
      if (queried++ >= OPERATIONAL_LIMITS.maxSnapshotOperations) break
      const status = await this.query('operation-status', { operationId: record.operationId }, signal, deadline)
      this.assertLive(signal, deadline)
      if (status.kind === 'response' && status.body.type === 'operation-status') {
        this.assertLive(signal, deadline)
        this.outbox.acceptStatus(this.identity.playerDeviceId, status)
      }
      // not-found is deliberately not interpreted as proof that a transmitted effect did not occur.
    }
    const cursor = this.inbox.cursor(this.identity.playerDeviceId)
    this.assertLive(signal, deadline)
    if (!cursor || cursor.recoveryRequired) return this.recovery('MANAGEMENT_REMOTE_JOURNAL_RECOVERY_REQUIRED', cursor?.throughSequence ?? null)
    return { state: 'synchronized', throughSequence: cursor.throughSequence, highWatermark: cursor.highWatermark,
      pending: this.outbox.recoverable(this.identity.playerDeviceId).length }
  }

  private async query(type: OperationalQueryType, payload: Record<string, unknown>, signal: AbortSignal,
    deadline: number): Promise<OperationalMessage> {
    this.assertLive(signal, deadline)
    const request = ManagementRemoteReconciliationService.createQuery(this.identity.playerDeviceId, this.identity.controllerId, type, payload)
    const raw = await this.queryPort.query(request, signal)
    this.assertLive(signal, deadline)
    const parsed = parseOperationalMessageObject(raw) as OperationalMessage
    if (parsed.deviceId !== this.identity.playerDeviceId || parsed.controllerId !== this.identity.controllerId) {
      throw new Error('G4_RESPONSE_IDENTITY_MISMATCH')
    }
    if (parsed.kind === 'error') {
      if (parsed.body.correlationId !== request.body.queryId) throw new Error('G4_RESPONSE_CORRELATION_INVALID')
      return parsed
    }
    if (parsed.kind !== 'response' || parsed.body.type !== type || parsed.body.correlationId !== request.body.queryId) {
      throw new Error('G4_RESPONSE_CORRELATION_INVALID')
    }
    this.assertLive(signal, deadline)
    return parsed
  }

  private assertLive(signal: AbortSignal, deadline?: number): void {
    if (signal.aborted) throw new Error('G4_RECOVERY_CANCELLED')
    if (deadline !== undefined && this.now() >= deadline) throw new Error('G4_RECOVERY_TIMEOUT')
  }

  private recovery(reason: string, throughSequence: number | null): ReconciliationResult {
    return { state: 'recovery_required', reason, throughSequence }
  }

  /** Helpers for real WSS adapters to create bounded, independently correlated G3 queries. */
  static createQuery(deviceId: string, controllerId: string, type: OperationalQueryType,
    payload: Record<string, unknown>): Extract<OperationalMessage, { kind: 'query' }> {
    const queryId = randomUUID()
    return parseOperationalMessageObject({ protocolVersion: 1, schemaVersion: 1, kind: 'query', messageId: randomUUID(),
      deviceId, controllerId, body: { queryId, type, payload } }) as Extract<OperationalMessage, { kind: 'query' }>
  }
}
