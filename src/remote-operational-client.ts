import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { OperationalMessage, OperationalQueryType } from './operational-protocol-contracts'
import { parseOperationalMessageObject } from './operational-protocol-validation'
import { connectPinnedControlChannel, type PinnedControlChannel } from './remote-clients'
import type { PinnedCertificate } from './remote-tls'
import type { RemoteAuthorizedPeer } from './remote-contracts'
import { REMOTE_LIMITS } from './remote-contracts'
import { ManagementRemoteReconciliationService } from './remote-reconciliation-service'
import type { OperationalQueryPort } from './remote-reconciliation-service'

export interface OperationalPeerIdentity {
  readonly playerId: string
  readonly controllerId: string
  readonly playerEpoch?: string
  readonly controlEpoch?: string
  readonly journalId?: string
  readonly credentialGeneration: number
}

function normalizeConnectionError(error: unknown): Error {
  if (error instanceof Error && /^Unexpected server response: (401|403)$/.test(error.message)) {
    return new Error('REMOTE_AUTHORIZATION_REVOKED', { cause: error })
  }
  return error instanceof Error ? error : new Error('REMOTE_OPERATIONAL_CONNECT_FAILED')
}

/** Real pinned WSS client. G1 transport-ready is followed by the G3 operational hello/ready. */
export class RemoteOperationalClient implements OperationalQueryPort {
  private readonly pending = new Map<string, { resolve(value: OperationalMessage): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout> }>()
  private readonly readyTask: Promise<Extract<OperationalMessage, { kind: 'ready' }>>
  private closed = false
  private closeTask: Promise<void> | undefined
  private readonly closeListeners = new Set<() => void>()

  private constructor(private readonly socket: WebSocket, readonly peer: OperationalPeerIdentity,
    readonly authorizedPeer: RemoteAuthorizedPeer, private readonly timeoutMs: number = REMOTE_LIMITS.httpRequestTimeoutMs) {
    this.readyTask = this.handshake()
    socket.on('message', this.onMessage)
    socket.on('close', this.onClose)
    socket.on('error', this.onError)
  }

  static async connect(options: { address: string; port: number; pin: PinnedCertificate; bearer: string;
    identity: OperationalPeerIdentity; authorizedPeer: RemoteAuthorizedPeer; timeoutMs?: number; signal?: AbortSignal }): Promise<RemoteOperationalClient> {
    let transport: PinnedControlChannel
    try {
      transport = await connectPinnedControlChannel({ address: options.address, port: options.port,
        pin: options.pin, bearer: options.bearer, timeoutMs: options.timeoutMs, signal: options.signal })
    } catch (error) { throw normalizeConnectionError(error) }
    if (options.signal?.aborted) { transport.close(); throw new Error('REMOTE_OPERATIONAL_CONNECT_ABORTED') }
    const client = new RemoteOperationalClient(transport.socket, options.identity, options.authorizedPeer,
      options.timeoutMs ?? REMOTE_LIMITS.httpRequestTimeoutMs)
    let abort: (() => void) | undefined
    try {
      if (options.signal) {
        await Promise.race([client.readyTask, new Promise<never>((_resolve, reject) => {
          abort = () => { void client.close(); reject(new Error('REMOTE_OPERATIONAL_CONNECT_ABORTED')) }
          options.signal?.addEventListener('abort', abort, { once: true })
          if (options.signal?.aborted) abort()
        })])
      } else await client.readyTask
      return client
    }
    catch (error) {
      await client.close().catch(() => undefined)
      throw normalizeConnectionError(error)
    }
    finally { if (abort) options.signal?.removeEventListener('abort', abort) }
  }

  async ready(): Promise<Extract<OperationalMessage, { kind: 'ready' }>> { return this.readyTask }

  onDisconnect(listener: () => void): () => void {
    if (this.closed) { listener(); return () => undefined }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async query(message: Extract<OperationalMessage, { kind: 'query' }>, signal: AbortSignal): Promise<OperationalMessage> {
    await this.readyTask
    if (this.closed || signal.aborted) throw new Error('REMOTE_OPERATIONAL_CHANNEL_CLOSED')
    if (this.pending.size >= REMOTE_LIMITS.maxPendingMessages) throw new Error('REMOTE_OPERATIONAL_BUSY')
    const id = message.body.queryId
    if (this.pending.has(id)) throw new Error('REMOTE_OPERATIONAL_QUERY_DUPLICATE')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, new Error('REMOTE_OPERATIONAL_QUERY_TIMEOUT'))
      }, this.timeoutMs)
      timer.unref()
      const abort = (): void => this.settle(id, new Error('REMOTE_OPERATIONAL_QUERY_ABORTED'))
      const cleanup = (): void => signal.removeEventListener('abort', abort)
      const originalResolve = resolve
      const originalReject = reject
      this.pending.set(id, { resolve: value => { cleanup(); originalResolve(value) },
        reject: error => { cleanup(); originalReject(error) }, timer })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      try {
        if (this.socket.readyState !== WebSocket.OPEN) throw new Error('REMOTE_OPERATIONAL_CHANNEL_CLOSED')
        this.socket.send(JSON.stringify(message), error => { if (error) this.settle(id, error) })
      } catch (error) { this.settle(id, error instanceof Error ? error : new Error('REMOTE_OPERATIONAL_SEND_FAILED')) }
    })
  }

  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    if (this.closed) return
    this.closed = true
    for (const id of [...this.pending.keys()]) this.settle(id, new Error('REMOTE_OPERATIONAL_CHANNEL_CLOSED'))
    if (this.socket.readyState === WebSocket.CLOSED) { this.closeTask = Promise.resolve(); return this.closeTask }
    this.closeTask = new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve() }, REMOTE_LIMITS.shutdownTimeoutMs)
      timer.unref()
      this.socket.once('close', () => { clearTimeout(timer); resolve() })
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'G4 shutdown')
      else this.socket.terminate()
    })
    return this.closeTask
  }

  private handshake(): Promise<Extract<OperationalMessage, { kind: 'ready' }>> {
    return new Promise((resolve, reject) => {
      const helloMessageId = randomUUID()
      const timer = setTimeout(() => reject(new Error('REMOTE_OPERATIONAL_READY_TIMEOUT')), REMOTE_LIMITS.helloTimeoutMs)
      timer.unref()
      const onMessage = (data: WebSocket.RawData, binary: boolean): void => {
        if (binary) { cleanup(); reject(new Error('REMOTE_OPERATIONAL_READY_INVALID')); return }
        try {
          const message = parseOperationalMessageObject(JSON.parse(this.decode(data))) as OperationalMessage
            if (message.kind === 'error' && message.body.correlationId === helloMessageId &&
                message.body.code === 'STORAGE_UNAVAILABLE' && message.body.state === 'recovery-required') {
              throw new Error('REMOTE_PLAYER_RECOVERY_REQUIRED')
            }
          if (message.kind !== 'ready' || message.deviceId !== this.peer.playerId || message.controllerId !== this.peer.controllerId ||
              (this.peer.playerEpoch !== undefined && message.body.playerEpoch !== this.peer.playerEpoch) ||
              (this.peer.controlEpoch !== undefined && message.body.controlEpoch !== this.peer.controlEpoch)) {
            throw new Error('REMOTE_OPERATIONAL_READY_MISMATCH')
          }
          cleanup(); resolve(message)
        } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error('REMOTE_OPERATIONAL_READY_INVALID')) }
      }
      const onClose = (): void => { cleanup(); reject(new Error('REMOTE_OPERATIONAL_CHANNEL_CLOSED')) }
      const cleanup = (): void => {
        clearTimeout(timer); this.socket.removeListener('message', onMessage); this.socket.removeListener('close', onClose)
      }
      this.socket.once('message', onMessage); this.socket.once('close', onClose)
      const hello = { protocolVersion: 1, schemaVersion: 1, kind: 'hello', messageId: helloMessageId,
        deviceId: this.peer.playerId, controllerId: this.peer.controllerId,
        body: { protocol: 'kq-operation/1', protocolVersion: 1, schemaVersion: 1 } }
      try { this.socket.send(JSON.stringify(hello), error => { if (error) { cleanup(); reject(error) } }) }
      catch (error) { cleanup(); reject(error instanceof Error ? error : new Error('REMOTE_OPERATIONAL_HELLO_FAILED')) }
    })
  }

  private readonly onMessage = (data: WebSocket.RawData, binary: boolean): void => {
    if (binary) { void this.close(); return }
    let message: OperationalMessage
    try { message = parseOperationalMessageObject(JSON.parse(this.decode(data))) as OperationalMessage }
    catch { void this.close(); return }
    if (message.deviceId !== this.peer.playerId || message.controllerId !== this.peer.controllerId) { void this.close(); return }
    if (message.kind === 'response') {
      const pending = this.pending.get(message.body.correlationId)
      if (pending) this.settle(message.body.correlationId, undefined, message)
    } else if (message.kind === 'error' && message.body.correlationId) {
      this.settle(message.body.correlationId, undefined, message)
    }
  }

  private readonly onClose = (): void => {
    this.closed = true
    for (const id of [...this.pending.keys()]) this.settle(id, new Error('REMOTE_OPERATIONAL_CHANNEL_CLOSED'))
    for (const listener of [...this.closeListeners]) { try { listener() } catch { /* lifecycle observer isolation */ } }
    this.closeListeners.clear()
  }
  private readonly onError = (error: Error): void => {
    for (const id of [...this.pending.keys()]) this.settle(id, error)
  }

  private decode(data: WebSocket.RawData): string {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  private settle(id: string, error?: Error, value?: OperationalMessage): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id); clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else if (value) pending.resolve(value)
    else pending.reject(new Error('REMOTE_OPERATIONAL_EMPTY_RESPONSE'))
  }
}

export function createOperationalQuery(deviceId: string, controllerId: string, type: OperationalQueryType,
  payload: Record<string, unknown>): Extract<OperationalMessage, { kind: 'query' }> {
  return ManagementRemoteReconciliationService.createQuery(deviceId, controllerId, type, payload)
}
