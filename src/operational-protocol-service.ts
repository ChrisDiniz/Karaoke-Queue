/** Main-only Player protocol dispatcher. Commands are journaled before a synthetic/future port is called. */
import { randomUUID } from 'node:crypto'
import { OPERATIONAL_PROTOCOL, OPERATIONAL_PROTOCOL_VERSION, OPERATIONAL_SCHEMA_VERSION } from './operational-protocol-contracts'
import type { OperationalCommandBody, OperationalMessage, OperationalTarget } from './operational-protocol-contracts'
import type { RemoteAuthorizationPort, RemoteTransportMessageContext, RemoteTransportMessagePort } from './remote-contracts'
import type { PlayerOperationalStore, PlayerOperationReceipt, OperationalEventDraft } from './player-operational-store'
import { PlayerOperationalStoreError } from './player-operational-store'
import { operationalCommandFingerprint } from './operational-command-fingerprint'
import { parseOperationalMessageObject } from './operational-protocol-validation'

type CommandMessage = Extract<OperationalMessage, { kind: 'command' }>
type QueryMessage = Extract<OperationalMessage, { kind: 'query' }>
type ErrorCode = Extract<OperationalMessage, { kind: 'error' }>['body']['code']

export interface OperationalCommandExecutionResult {
  readonly status: 'completed' | 'rejected' | 'unknown'
  readonly state: string
}

/** G3 injects only synthetic handlers. H2 must provide the real existing Player adapter later. */
export interface OperationalCommandExecutionPort {
  execute(command: OperationalCommandBody, signal: AbortSignal): Promise<OperationalCommandExecutionResult>
}

export interface OperationalSnapshotPort {
  snapshot(): Record<string, unknown>
  mediaAvailability(musicCode: string): Record<string, unknown>
}

export interface OperationalProtocolServiceOptions {
  readonly store: PlayerOperationalStore
  readonly authorization: RemoteAuthorizationPort
  readonly deviceId: string
  readonly playerEpoch: string
  readonly controlEpoch?: (context: RemoteTransportMessageContext) => string
  /** Reads the Player's owning state synchronously; absent means fail closed for every command. */
  readonly isTargetCurrent?: (target: OperationalTarget, context: RemoteTransportMessageContext) => boolean
  readonly executionPort?: OperationalCommandExecutionPort
  readonly snapshotPort?: OperationalSnapshotPort
  readonly maxAdmissions?: number
  readonly maxConcurrentExecutions?: number
  readonly executionTimeoutMs?: number
  /** Maximum time close waits for actual executor termination before returning blocked. */
  readonly shutdownTimeoutMs?: number
}

export interface OperationalServiceDrainResult {
  readonly state: 'idle' | 'blocked' | 'closed'
  readonly activeExecutions: number
  readonly pendingAdmissions: number
}

const noExecution: OperationalCommandExecutionPort = Object.freeze({
  async execute(): Promise<OperationalCommandExecutionResult> { return { status: 'unknown', state: 'no-g3-executor' } }
})

function currentControlEpoch(context: RemoteTransportMessageContext): string {
  return String(context.channel.peer.credentialGeneration)
}

function targetOf(command: OperationalCommandBody): OperationalTarget { return command.target }

function eventDraft(command: OperationalCommandBody, operationId: string,
  status: 'completed' | 'rejected' | 'unknown'): OperationalEventDraft {
  const target = targetOf(command)
  return { schemaVersion: 1, causationOperationId: operationId,
    sessionId: target.sessionId, turnId: target.turnId,
    ...('occurrenceId' in target ? { occurrenceId: target.occurrenceId, attemptId: target.attemptId } : {}),
    stateRevision: target.stateRevision, origin: 'remote', type: 'operation-result',
    payload: { operationId, status } }
}

function errorCode(error: unknown): ErrorCode {
  if (error instanceof PlayerOperationalStoreError) {
    if (error.code === 'OPERATION_ID_CONFLICT') return 'OPERATION_ID_CONFLICT'
    if (error.code === 'CURSOR_GAP') return 'CURSOR_GAP'
    if (error.code === 'REPLAY_COMPACTED') return 'REPLAY_COMPACTED'
    if (error.code === 'CURSOR_INVALID' || error.code === 'EVENT_INVALID' || error.code === 'OPERATION_INVALID') return 'INVALID_MESSAGE'
    if (error.code === 'CONSUMER_REVOKED') return 'NOT_AUTHORIZED'
    if (error.code === 'SEQUENCE_EXHAUSTED') return 'STORAGE_UNAVAILABLE'
    if (error.code === 'STORE_IN_USE') return 'BUSY'
  }
  return 'STORAGE_UNAVAILABLE'
}

/** Owns no playback state. Its transient structures only serialize admission and track hello per live channel. */
export class OperationalProtocolService implements RemoteTransportMessagePort {
  private readonly greeted = new WeakSet<object>()
  private admissionTail: Promise<void> = Promise.resolve()
  private pendingAdmissions = 0
  private activeExecutions = 0
  private readonly executionTasks = new Set<Promise<void>>()
  private closed = false
  private drainState: 'running' | 'draining' | 'blocked' | 'closed' = 'running'
  private readonly idleWaiters = new Set<() => void>()
  private readonly executor: OperationalCommandExecutionPort

  constructor(private readonly options: OperationalProtocolServiceOptions) {
    if (!options.store || !options.authorization || !options.deviceId || !options.playerEpoch) {
      throw new Error('OPERATIONAL_SERVICE_OPTIONS_INVALID')
    }
    this.executor = options.executionPort ?? noExecution
    if (!Number.isSafeInteger(options.maxAdmissions ?? 64) || (options.maxAdmissions ?? 64) < 1 ||
        !Number.isSafeInteger(options.maxConcurrentExecutions ?? 32) || (options.maxConcurrentExecutions ?? 32) < 1 ||
        !Number.isSafeInteger(options.executionTimeoutMs ?? 30_000) || (options.executionTimeoutMs ?? 30_000) < 1 ||
        !Number.isSafeInteger(options.shutdownTimeoutMs ?? 5_000) || (options.shutdownTimeoutMs ?? 5_000) < 1) {
      throw new Error('OPERATIONAL_SERVICE_OPTIONS_INVALID')
    }
  }

  onMessage(context: RemoteTransportMessageContext): Promise<void> {
    return this.receive(context)
  }

  async close(): Promise<OperationalServiceDrainResult> {
    this.closed = true
    this.drainState = 'draining'
    const result = await this.waitForIdle(this.options.shutdownTimeoutMs ?? 5_000)
    const state = result.state === 'blocked' ? 'blocked' : 'closed'
    this.drainState = state
    return { ...result, state }
  }

  /** Lifecycle/testing barrier; this observes service tasks and does not alter operation state. */
  async waitForIdle(timeoutMs = this.options.shutdownTimeoutMs ?? 5_000): Promise<OperationalServiceDrainResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('OPERATIONAL_DRAIN_TIMEOUT_INVALID')
    if (this.pendingAdmissions === 0 && this.activeExecutions === 0) return this.drainResult(this.closed ? 'closed' : 'idle')
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolveIdle!: () => void
    const idle = new Promise<void>(resolve => { resolveIdle = resolve; this.idleWaiters.add(resolve) })
    const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), timeoutMs) })
    const outcome = await Promise.race([idle.then(() => 'idle' as const), deadline])
    if (timer) clearTimeout(timer)
    this.idleWaiters.delete(resolveIdle)
    return this.drainResult(outcome === 'idle' ? (this.closed ? 'closed' : 'idle') : 'blocked')
  }

  private drainResult(state: 'idle' | 'closed' | 'blocked'): OperationalServiceDrainResult {
    return { state, activeExecutions: this.activeExecutions, pendingAdmissions: this.pendingAdmissions }
  }

  private notifyIfIdle(): void {
    if (this.pendingAdmissions !== 0 || this.activeExecutions !== 0) return
    if (this.closed) this.drainState = 'closed'
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private send(context: RemoteTransportMessageContext, message: OperationalMessage): void {
    const validated = parseOperationalMessageObject(message)
    try { context.channel.send(JSON.stringify(validated)) }
    catch { /* A closed transport loses delivery, not the durable operation outcome. */ }
  }

  private sendError(context: RemoteTransportMessageContext, correlationId: string | null,
    code: ErrorCode, state: string): void {
    this.send(context, { protocolVersion: OPERATIONAL_PROTOCOL_VERSION, schemaVersion: OPERATIONAL_SCHEMA_VERSION,
      kind: 'error', messageId: randomUUID(), deviceId: this.options.deviceId,
      controllerId: context.channel.peer.controllerId, body: { correlationId, code, state } })
  }

  private async isCurrent(context: RemoteTransportMessageContext): Promise<boolean> {
    const peer = context.channel.peer
    if (!peer || !peer.controllerId || !peer.scopes.includes('transport:control')) return false
    try {
      return await this.options.authorization.isCurrent(peer, context.channel.connectionId,
        context.channel.signal ? context.channel.signal : new AbortController().signal)
    } catch { return false }
  }

  private async receive(context: RemoteTransportMessageContext): Promise<void> {
    if (this.closed || this.drainState !== 'running') return
    let message: OperationalMessage
    try { message = parseOperationalMessageObject(context.payload) as OperationalMessage }
    catch { this.sendError(context, null, 'INVALID_MESSAGE', 'schema-invalid'); return }
    if (message.deviceId !== this.options.deviceId || message.controllerId !== context.channel.peer.controllerId) {
      context.channel.close(1008, 'IDENTITY_MISMATCH')
      return
    }
    if (!await this.isCurrent(context)) { context.channel.close(1008, 'REVOKED'); return }
    if (message.kind === 'hello') {
      this.greeted.add(context.channel)
      const metadata = this.options.store.getMetadata()
      const controlEpoch = this.options.controlEpoch?.(context) ?? currentControlEpoch(context)
      this.send(context, { protocolVersion: 1, schemaVersion: 1, kind: 'ready', messageId: randomUUID(),
        deviceId: this.options.deviceId, controllerId: context.channel.peer.controllerId,
        body: { protocol: OPERATIONAL_PROTOCOL, protocolVersion: 1, schemaVersion: 1,
          journalId: metadata.journalId, playerEpoch: this.options.playerEpoch, controlEpoch } })
      return
    }
    if (!this.greeted.has(context.channel)) {
      this.sendError(context, message.messageId, 'INVALID_MESSAGE', 'operational-hello-required')
      return
    }
    if (message.kind === 'command') { await this.admit(context, message); return }
    if (message.kind === 'query') { await this.query(context, message); return }
    if (message.kind === 'ack') {
      if (message.body.payload.consumerId !== message.controllerId) {
        this.sendError(context, message.body.correlationId, 'NOT_AUTHORIZED', 'ack-consumer-identity-mismatch')
        return
      }
      let localJournalId: string
      try { localJournalId = this.options.store.getMetadata().journalId }
      catch (error) {
        this.sendError(context, message.body.correlationId, 'STORAGE_UNAVAILABLE',
          error instanceof PlayerOperationalStoreError ? error.code.toLowerCase().replaceAll('_', '-') : 'journal-metadata-unavailable')
        return
      }
      if (message.body.payload.journalId !== localJournalId) {
        this.sendError(context, message.body.correlationId, 'JOURNAL_MISMATCH', 'ack-journal-id-mismatch')
        return
      }
      if (!await this.isCurrent(context)) { context.channel.close(1008, 'REVOKED'); return }
      try {
        this.options.store.ackConsumed({ controllerId: message.controllerId,
          journalId: message.body.payload.journalId, consumerId: message.body.payload.consumerId,
          throughSequence: message.body.payload.throughSequence })
      } catch (error) {
        this.sendError(context, message.body.correlationId,
          error instanceof PlayerOperationalStoreError && error.code === 'CURSOR_INVALID' ? 'CURSOR_GAP' : errorCode(error),
          error instanceof PlayerOperationalStoreError ? error.code.toLowerCase().replaceAll('_', '-') : 'ack-persistence-failed')
      }
      return
    }
    this.sendError(context, message.messageId, 'INVALID_MESSAGE', 'message-direction-invalid')
  }

  private async admit(context: RemoteTransportMessageContext, message: CommandMessage): Promise<void> {
    const maxPending = this.options.maxAdmissions ?? 64
    const maxExecutions = this.options.maxConcurrentExecutions ?? 32
    if (this.pendingAdmissions >= maxPending || this.activeExecutions >= maxExecutions) {
      this.sendError(context, message.messageId, 'BUSY', 'admission-capacity')
      return
    }
    this.pendingAdmissions++
    const prior = this.admissionTail
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    this.admissionTail = prior.catch(() => undefined).then(() => gate)
    await prior.catch(() => undefined)
    try {
      if (this.closed || !await this.isCurrent(context)) { context.channel.close(1008, 'REVOKED'); return }
      const command = message.body
      const target = command.target
      const expectedPlayerEpoch = this.options.playerEpoch
      const expectedControlEpoch = this.options.controlEpoch?.(context) ?? currentControlEpoch(context)
      const epochsMatch = target.playerEpoch === expectedPlayerEpoch && target.controlEpoch === expectedControlEpoch
      const priorOperation = this.options.store.lookupOperation(message.controllerId, command.operationId)
      const fingerprint = operationalCommandFingerprint(command)
      if (priorOperation && priorOperation.fingerprint !== fingerprint) {
        this.sendError(context, message.messageId, 'OPERATION_ID_CONFLICT', 'operation-id-content-conflict')
        return
      }
      if (!priorOperation && this.activeExecutions >= maxExecutions) {
        this.sendError(context, message.messageId, 'BUSY', 'execution-capacity')
        return
      }
      if (!await this.isCurrent(context)) { context.channel.close(1008, 'REVOKED'); return }
      if (!priorOperation && (!epochsMatch || this.options.isTargetCurrent?.(target, context) !== true)) {
        const rejected = this.options.store.recordRejectedOperation({ controllerId: message.controllerId,
          command: message, state: epochsMatch ? 'TARGET_VALIDATION_UNAVAILABLE_OR_STALE' : 'STALE_TARGET' })
        this.emitReceipt(context, message.controllerId, command.operationId, rejected)
        return
      }
      const receipt = this.options.store.acceptOperation({ controllerId: message.controllerId, command: message })
      if (receipt.duplicate) {
        this.sendOperationStatus(context, message, command.operationId)
        return
      }
      if (this.activeExecutions >= maxExecutions) {
        // Admission was serialized; no other handler can consume a slot before this point.
        this.sendError(context, message.messageId, 'BUSY', 'execution-capacity')
        return
      }
      this.activeExecutions++
      this.emitReceipt(context, message.controllerId, command.operationId, receipt)
      const task = this.executeAccepted(context, message.controllerId, command, receipt)
      this.executionTasks.add(task)
      void task.finally(() => this.executionTasks.delete(task))
    } catch (error) {
      this.sendError(context, message.messageId, errorCode(error), error instanceof PlayerOperationalStoreError ? error.code : 'admission-failed')
    } finally {
      release()
      this.pendingAdmissions--
      this.notifyIfIdle()
    }
  }

  private emitReceipt(context: RemoteTransportMessageContext, controllerId: string, operationId: string,
    receipt: PlayerOperationReceipt): void {
    try {
      const page = this.options.store.readPage({ controllerId, correlationId: operationId,
        afterSequence: Math.max(0, receipt.terminalEventSequence ?? receipt.acceptedEventSequence) - 1, limit: 1 })
      const event = page.events.find(item => item.causationOperationId === operationId)
      if (!event) return
      this.send(context, { protocolVersion: 1, schemaVersion: 1, kind: 'event', messageId: randomUUID(),
        deviceId: this.options.deviceId, controllerId, body: event })
    } catch (error) {
      this.sendError(context, operationId, errorCode(error), 'operation-receipt-unavailable')
    }
  }

  private sendOperationStatus(context: RemoteTransportMessageContext, message: CommandMessage, operationId: string): void {
    try {
      const value = this.options.store.getOperationStatus({ controllerId: message.controllerId, operationId })
      if (!value) return
      this.send(context, { protocolVersion: 1, schemaVersion: 1, kind: 'response', messageId: randomUUID(),
        deviceId: this.options.deviceId, controllerId: message.controllerId,
        body: { correlationId: message.messageId, type: 'operation-status', payload: value } })
    } catch (error) {
      this.sendError(context, message.messageId, errorCode(error), 'operation-status-unavailable')
    }
  }

  private async executeAccepted(context: RemoteTransportMessageContext, controllerId: string,
    message: CommandMessage['body'], receipt: PlayerOperationReceipt): Promise<void> {
    const controller = new AbortController()
    const timeoutMs = this.options.executionTimeoutMs ?? 30_000
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let resolveDeadline!: () => void
    const deadline = new Promise<'deadline'>(resolve => { resolveDeadline = () => resolve('deadline') })
    const execution = Promise.resolve().then(() => this.executor.execute(message, controller.signal))
    const observedExecution = execution.then(value => ({ kind: 'result' as const, value }), error => ({ kind: 'error' as const, error }))
    timer = setTimeout(() => { timedOut = true; controller.abort(); resolveDeadline() }, timeoutMs)
    try {
      const first = await Promise.race([observedExecution, deadline])
      if (first === 'deadline') {
        const terminal = this.options.store.finishOperation({ controllerId, operationId: message.operationId,
          status: 'unknown', events: [eventDraft(message, message.operationId, 'unknown')] })
        this.emitReceipt(context, controllerId, message.operationId, terminal)
        // AbortSignal is cooperative. Retain the slot and task until the original handler settles.
        await observedExecution
        return
      }
      const outcome = first.kind === 'result' ? first.value : { status: 'unknown' as const, state: 'executor-rejected' }
      const result = outcome && ['completed', 'rejected', 'unknown'].includes(outcome.status) &&
        typeof outcome.state === 'string' && outcome.state.length <= 64
        ? outcome : { status: 'unknown' as const, state: 'executor-result-invalid' }
      const terminal = this.options.store.finishOperation({ controllerId, operationId: message.operationId,
        status: result.status, events: [eventDraft(message, message.operationId, result.status)] })
      this.emitReceipt(context, controllerId, message.operationId, terminal)
    } catch (error) {
      this.sendError(context, message.operationId, errorCode(error), 'terminal-result-unconfirmed')
      // The store's startup recovery will conservatively mark any still-accepted record unknown.
      void receipt
    } finally {
      if (timer) clearTimeout(timer)
      // This is deliberately independent of the response path: only settlement of the
      // original executor promise releases the slot after timeout, even if sending failed.
      if (timedOut) await observedExecution
      this.activeExecutions = Math.max(0, this.activeExecutions - 1)
      this.notifyIfIdle()
    }
  }

  private async query(context: RemoteTransportMessageContext, message: QueryMessage): Promise<void> {
    if (!await this.isCurrent(context)) { context.channel.close(1008, 'REVOKED'); return }
    const correlationId = message.body.queryId
    try {
      if (message.body.type === 'operation-status') {
        const value = this.options.store.getOperationStatus({ controllerId: message.controllerId,
          operationId: String(message.body.payload.operationId) })
        const payload = value ?? { operationId: String(message.body.payload.operationId), fingerprint: null,
          status: 'not-found' as const, result: null, eventSequence: null }
        this.respond(context, correlationId, 'operation-status', payload)
        return
      }
      if (message.body.type === 'journal-page') {
        const page = this.options.store.readPage({ controllerId: message.controllerId, correlationId,
          afterSequence: Number(message.body.payload.afterSequence), limit: Number(message.body.payload.limit) })
        if (page.journalId !== message.body.payload.journalId) {
          this.sendError(context, correlationId, 'JOURNAL_MISMATCH', 'journal-id-mismatch')
          return
        }
        this.respond(context, correlationId, 'journal-page', page as unknown as Record<string, unknown>)
        return
      }
      const provider = this.options.snapshotPort
      if (!provider) {
        this.sendError(context, correlationId,
          message.body.type === 'media-availability' ? 'MEDIA_UNAVAILABLE' : 'RESULT_UNCERTAIN',
          message.body.type === 'media-availability' ? 'media-query-adapter-unavailable' : 'snapshot-adapter-unavailable')
        return
      }
      const payload = message.body.type === 'media-availability'
        ? provider.mediaAvailability(String(message.body.payload.musicCode)) : provider.snapshot()
      if (message.body.type === 'snapshot') {
        const response = this.responseEnvelope(context, correlationId, message.body.type, payload)
        this.options.store.saveCheckpoint({ controllerId: message.controllerId, correlationId, snapshot: response })
        this.send(context, response)
      } else this.respond(context, correlationId, message.body.type, payload)
    } catch (error) {
      this.sendError(context, correlationId, errorCode(error), error instanceof PlayerOperationalStoreError ? error.code : 'query-failed')
    }
  }

  private respond(context: RemoteTransportMessageContext, correlationId: string,
    type: Extract<OperationalMessage, { kind: 'response' }>['body']['type'], payload: Record<string, unknown>): void {
    this.send(context, this.responseEnvelope(context, correlationId, type, payload))
  }

  private responseEnvelope(context: RemoteTransportMessageContext, correlationId: string,
    type: Extract<OperationalMessage, { kind: 'response' }>['body']['type'], payload: Record<string, unknown>): OperationalMessage {
    return { protocolVersion: 1, schemaVersion: 1, kind: 'response', messageId: randomUUID(),
      deviceId: this.options.deviceId, controllerId: context.channel.peer.controllerId,
      body: { correlationId, type, payload } }
  }
}
