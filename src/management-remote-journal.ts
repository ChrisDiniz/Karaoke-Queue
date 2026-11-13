/** Durable Management inbox for Player events; it does not apply domain/business mutations. */
import { createHash } from 'node:crypto'
import type { JournalEvent, OperationalMessage } from './operational-protocol-contracts'
import { parseOperationalMessageObject } from './operational-protocol-validation'

export interface ManagementRemoteJournalCursor {
  readonly playerDeviceId: string
  readonly controllerId: string
  readonly journalId: string
  /** Highest contiguous event sequence actually present in the inbox. */
  readonly throughSequence: number
  /** Player's advertised sequence; this does not advance the received or H3-applied cursor. */
  readonly highWatermark: number
  readonly snapshotHighWatermark: number
  readonly compactedThrough: number
  readonly legacyThroughSequence: number | null
  readonly recoveryRequired: boolean
  readonly updatedAt: number
}

export interface ManagementRemoteJournalDatabase {
  remoteJournal: {
    getCursor(playerDeviceId: string, controllerId: string): ManagementRemoteJournalCursor | null
    persistPage(input: { playerDeviceId: string; controllerId: string; journalId: string; afterSequence: number;
      throughSequence: number; highWatermark: number; compactedThrough: number; hasMore: boolean;
      events: Array<{ sequence: number; event: JournalEvent; fingerprint: string }> }): ManagementRemoteJournalCursor
    persistSnapshot(input: { playerDeviceId: string; controllerId: string; journalId: string; highWatermark: number;
      compactedThrough: number; snapshot: OperationalMessage; fingerprint: string }): ManagementRemoteJournalCursor
    listEvents(input: { playerDeviceId: string; controllerId: string; afterSequence: number; limit: number }):
      Array<{ sequence: number; event: JournalEvent; fingerprint: string }>
    getLatestSnapshot(playerDeviceId: string, controllerId: string): OperationalMessage | null
  }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[\x21-\x7e]+$/.test(value)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
  }
  return value
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex')
}

function response(input: unknown, type: 'journal-page' | 'snapshot'): Extract<OperationalMessage, { kind: 'response' }> {
  const message = parseOperationalMessageObject(input) as OperationalMessage
  if (message.kind !== 'response' || message.body.type !== type) throw new Error('MANAGEMENT_REMOTE_JOURNAL_RESPONSE_INVALID')
  return message as Extract<OperationalMessage, { kind: 'response' }>
}

/** Validates and stores event pages/snapshots in Main's durable inbox. This is not the H3 applied cursor. */
export class ManagementRemoteJournalInbox {
  constructor(private readonly database: ManagementRemoteJournalDatabase,
    private readonly identity: { readonly controllerId: string }) {
    if (!database?.remoteJournal || !isId(identity.controllerId)) throw new Error('MANAGEMENT_REMOTE_JOURNAL_OPTIONS_INVALID')
  }

  /** `afterSequence` is the query cursor correlated with this response. */
  persistPage(playerDeviceId: string, afterSequence: number, input: unknown): ManagementRemoteJournalCursor {
    const message = response(input, 'journal-page')
    if (!isId(playerDeviceId) || message.deviceId !== playerDeviceId || message.controllerId !== this.identity.controllerId ||
        !Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('MANAGEMENT_REMOTE_JOURNAL_IDENTITY_MISMATCH')
    const payload = message.body.payload as unknown as {
      journalId: string; events: JournalEvent[]; throughSequence: number; highWatermark: number;
      hasMore: boolean; compactedThrough: number
    }
    if (!Array.isArray(payload.events)) throw new Error('MANAGEMENT_REMOTE_JOURNAL_PAGE_INVALID')
    const events = payload.events.map(event => ({ sequence: event.eventSequence, event, fingerprint: fingerprint(event) }))
    return this.database.remoteJournal.persistPage({ playerDeviceId, controllerId: this.identity.controllerId,
      journalId: payload.journalId, afterSequence, throughSequence: payload.throughSequence,
      highWatermark: payload.highWatermark, compactedThrough: payload.compactedThrough,
      hasMore: payload.hasMore, events })
  }

  persistSnapshot(playerDeviceId: string, input: unknown): ManagementRemoteJournalCursor {
    const message = response(input, 'snapshot')
    if (!isId(playerDeviceId) || message.deviceId !== playerDeviceId || message.controllerId !== this.identity.controllerId) {
      throw new Error('MANAGEMENT_REMOTE_JOURNAL_IDENTITY_MISMATCH')
    }
    const snapshot = message.body.payload as unknown as { journalId: string; highWatermark: number; compactedThrough: number }
    const durableSnapshot: Extract<OperationalMessage, { kind: 'response' }> = { ...message,
      messageId: `inbox-snapshot-${snapshot.highWatermark}`,
      body: { ...message.body, correlationId: `inbox-snapshot-${snapshot.highWatermark}` } }
    return this.database.remoteJournal.persistSnapshot({ playerDeviceId, controllerId: this.identity.controllerId,
      journalId: snapshot.journalId, highWatermark: snapshot.highWatermark, compactedThrough: snapshot.compactedThrough,
      snapshot: durableSnapshot, fingerprint: fingerprint(durableSnapshot) })
  }

  cursor(playerDeviceId: string): ManagementRemoteJournalCursor | null {
    return this.database.remoteJournal.getCursor(playerDeviceId, this.identity.controllerId)
  }

  readEvents(playerDeviceId: string, afterSequence: number, limit: number): Array<{ sequence: number; event: JournalEvent; fingerprint: string }> {
    return this.database.remoteJournal.listEvents({ playerDeviceId, controllerId: this.identity.controllerId, afterSequence, limit })
  }

  latestSnapshot(playerDeviceId: string): OperationalMessage | null {
    return this.database.remoteJournal.getLatestSnapshot(playerDeviceId, this.identity.controllerId)
  }

}
