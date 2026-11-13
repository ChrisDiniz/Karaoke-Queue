/** Durable Management-side intent outbox. It never executes Player operations. */
import { randomUUID } from 'node:crypto'
import type { OperationStatusPayload, OperationalCommandBody, OperationalMessage } from './operational-protocol-contracts'
import { parseOperationalMessageObject } from './operational-protocol-validation'
import { operationalCommandFingerprint } from './operational-command-fingerprint'

export type ManagementOutboxStatus = 'not-sent' | 'rejected' | 'accepted' | 'completed' | 'unknown'

export interface ManagementOutboxRecord {
  readonly playerDeviceId: string
  readonly controllerId: string
  readonly operationId: string
  readonly fingerprint: string
  readonly command: unknown
  readonly status: ManagementOutboxStatus
  readonly detail: unknown | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ManagementOutboxDatabase {
  remoteOutbox: {
    enqueue(input: Omit<ManagementOutboxRecord, 'status' | 'detail' | 'createdAt' | 'updatedAt'>):
      { record: ManagementOutboxRecord; duplicate: boolean }
    get(playerDeviceId: string, controllerId: string, operationId: string): ManagementOutboxRecord | null
    listRecoverable(playerDeviceId: string, controllerId: string): ManagementOutboxRecord[]
    markTransmissionStarted(playerDeviceId: string, controllerId: string, operationId: string): ManagementOutboxRecord
    recordRemoteStatus(input: { playerDeviceId: string; controllerId: string; operationId: string; fingerprint: string;
      status: Exclude<ManagementOutboxStatus, 'not-sent'>; detail: unknown }): ManagementOutboxRecord
  }
}

export interface OperationalSendPort {
  /** True means accepted by the local transport queue only, not durably accepted by the Player. */
  send(message: OperationalMessage): boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export class ManagementRemoteOutbox {
  constructor(private readonly database: ManagementOutboxDatabase,
    private readonly identity: { readonly deviceId: string; readonly controllerId: string }) {}

  /** Persists one immutable command before it can be sent. Reusing an ID with different content conflicts. */
  prepare(playerDeviceId: string, input: unknown): { readonly record: ManagementOutboxRecord; readonly duplicate: boolean } {
    const envelope = parseOperationalMessageObject(input) as OperationalMessage
    if (envelope.kind !== 'command' || envelope.controllerId !== this.identity.controllerId ||
        envelope.deviceId !== playerDeviceId || playerDeviceId.length < 1) throw new Error('MANAGEMENT_OUTBOX_COMMAND_INVALID')
    const command = (envelope as Extract<OperationalMessage, { kind: 'command' }>).body
    return this.database.remoteOutbox.enqueue({ playerDeviceId, controllerId: this.identity.controllerId,
      operationId: command.operationId, fingerprint: operationalCommandFingerprint(command), command })
  }

  get(playerDeviceId: string, operationId: string): ManagementOutboxRecord | null {
    return this.database.remoteOutbox.get(playerDeviceId, this.identity.controllerId, operationId)
  }

  recoverable(playerDeviceId: string): readonly ManagementOutboxRecord[] {
    return this.database.remoteOutbox.listRecoverable(playerDeviceId, this.identity.controllerId)
  }

  /** Persist uncertainty before crossing the SQLite/WSS boundary. A send failure remains unknown. */
  transmit(playerDeviceId: string, operationId: string, port: OperationalSendPort): ManagementOutboxRecord {
    const record = this.database.remoteOutbox.markTransmissionStarted(playerDeviceId, this.identity.controllerId, operationId)
    const command = record.command as OperationalCommandBody
    const envelope = parseOperationalMessageObject({ protocolVersion: 1, schemaVersion: 1, kind: 'command',
      messageId: randomUUID(), deviceId: playerDeviceId, controllerId: this.identity.controllerId, body: command }) as
      Extract<OperationalMessage, { kind: 'command' }>
    if (envelope.kind !== 'command' || operationalCommandFingerprint(envelope.body) !== record.fingerprint) {
      throw new Error('MANAGEMENT_OUTBOX_FINGERPRINT_MISMATCH')
    }
    try { port.send(envelope) } catch { /* durable state is already unknown */ }
    return this.get(playerDeviceId, operationId) ?? record
  }

  statusQuery(playerDeviceId: string, operationId: string): OperationalMessage {
    const intent = this.get(playerDeviceId, operationId)
    if (!intent) throw new Error('MANAGEMENT_OUTBOX_NOT_FOUND')
    return parseOperationalMessageObject({ protocolVersion: 1, schemaVersion: 1, kind: 'query',
      messageId: randomUUID(), deviceId: playerDeviceId, controllerId: this.identity.controllerId,
      body: { queryId: randomUUID(), type: 'operation-status', payload: { operationId } } }) as OperationalMessage
  }

  /** Stores only Player-authenticated, schema-validated status evidence for this controller and device. */
  acceptStatus(playerDeviceId: string, input: unknown): ManagementOutboxRecord | null {
    const message = parseOperationalMessageObject(input) as OperationalMessage
    if (message.deviceId !== playerDeviceId || message.controllerId !== this.identity.controllerId) {
      throw new Error('MANAGEMENT_OUTBOX_RESPONSE_IDENTITY_MISMATCH')
    }
    if (message.kind === 'event' && message.body.type === 'operation-result') {
      const operationResult = message.body as { type: 'operation-result'; payload: { operationId: string;
        status: 'accepted' | 'completed' | 'rejected' | 'unknown' } }
      const operationId = operationResult.payload.operationId
      const intent = this.get(playerDeviceId, operationId)
      if (!intent) return null
      return this.database.remoteOutbox.recordRemoteStatus({ playerDeviceId, controllerId: this.identity.controllerId,
        operationId, fingerprint: intent.fingerprint, status: operationResult.payload.status,
        detail: { operationId, status: operationResult.payload.status, eventSequence: (message.body as { eventSequence: number }).eventSequence,
          result: { status: operationResult.payload.status } } })
    }
    if (message.kind === 'response' && message.body.type === 'operation-status') {
      const statusResponse = message.body as unknown as { correlationId: string; type: 'operation-status'; payload: OperationStatusPayload }
      const result = statusResponse.payload
      const intent = this.get(playerDeviceId, result.operationId)
      if (!intent || result.status === 'not-found') return intent
      if (result.fingerprint === null) throw new Error('MANAGEMENT_OUTBOX_STATUS_INVALID')
      return this.database.remoteOutbox.recordRemoteStatus({ playerDeviceId, controllerId: this.identity.controllerId,
        operationId: result.operationId, fingerprint: result.fingerprint, status: result.status,
        detail: { operationId: result.operationId, status: result.status, eventSequence: result.eventSequence,
          result: result.result } })
    }
    return null
  }
}
