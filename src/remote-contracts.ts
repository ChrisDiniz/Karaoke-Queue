import type { Socket } from 'node:net'

export const REMOTE_TRANSPORT_VERSION = 1 as const
export const REMOTE_CONTROL_PATH = '/v1/control' as const
export const REMOTE_CONTROL_SUBPROTOCOL = 'kq-transport.v1' as const
export const REMOTE_DISCOVERY_TYPE = 'kq-player' as const
export const REMOTE_BOOTSTRAP_PATHS = [
  '/v1/pair/request',
  '/v1/pair/proof',
  '/v1/pair/confirm'
] as const

export const REMOTE_LIMITS = Object.freeze({
  maxCandidates: 64,
  maxDiscoveryNameLength: 64,
  maxTxtBytes: 512,
  maxGlobalConnections: 16,
  maxConnectionsPerAddress: 4,
  maxAddressEntries: 128,
  maxHttpHeaderBytes: 8192,
  maxHttpHeaders: 32,
  maxHttpBodyBytes: 16 * 1024,
  maxWebSocketMessageBytes: 64 * 1024,
  maxCapabilities: 16,
  maxCapabilityLength: 32,
  maxBufferedBytes: 256 * 1024,
  maxPendingMessages: 64,
  tlsHandshakeTimeoutMs: 5000,
  httpHeadersTimeoutMs: 8000,
  httpRequestTimeoutMs: 10000,
  httpKeepAliveTimeoutMs: 5000,
  authorizationTimeoutMs: 5000,
  helloTimeoutMs: 5000,
  heartbeatIntervalMs: 15000,
  heartbeatTimeoutMs: 10000,
  shutdownTimeoutMs: 3000
})

export type RemoteDeviceRole = 'player' | 'controller'

export interface RemoteDeviceIdentity {
  schemaVersion: 1
  deviceId: string
  role: RemoteDeviceRole
  certificatePem?: string
  certificateFingerprintSha256?: string
  privateKeyPem?: string
  createdAt: string
}

export interface DiscoveryCandidate {
  /** New for each observed candidate; this value does not identify or authorize a peer. */
  candidateId: string
  instanceName: string
  displayName: string
  deviceIdClaim: string | null
  interfaceAddress: string
  addresses: string[]
  port: number
  observedAt: number
  expiresAt: number
  verified: false
}

export interface DiscoverySnapshot {
  candidates: DiscoveryCandidate[]
  updatedAt: number
}

export interface DiscoveryPort {
  start(interfaceAddresses: readonly string[]): Promise<void>
  refresh(): Promise<void>
  getSnapshot(): DiscoverySnapshot
  subscribe(listener: (snapshot: DiscoverySnapshot) => void): () => void
  stop(): Promise<void>
}

export interface PlayerAdvertisement {
  deviceId: string
  displayName: string
  address: string
  port: number
}

export interface PlayerAdvertisementPort {
  start(advertisement: PlayerAdvertisement): Promise<void>
  update(advertisement: PlayerAdvertisement): Promise<void>
  stop(): Promise<void>
}

export interface RemoteAuthorizedPeer {
  controllerId: string
  credentialGeneration: number
  scopes: readonly string[]
}

/** G1 transport asks G2 for authority; identity claims in messages never populate this object. */
export interface RemoteAuthorizationPort {
  authorizeBearer(token: string, connectionId: string, signal: AbortSignal): Promise<RemoteAuthorizedPeer | null>
  isCurrent(peer: RemoteAuthorizedPeer, connectionId: string, signal: AbortSignal): Promise<boolean> | boolean
}

export const denyAllRemoteAuthorization: RemoteAuthorizationPort = Object.freeze({
  async authorizeBearer(): Promise<null> { return null },
  isCurrent(): boolean { return false }
})

export interface RemoteRequestContext {
  connectionId: string
  peer: RemoteAuthorizedPeer
  method: string
  path: string
  headers: Readonly<Record<string, string>>
  body: Uint8Array
}

export interface RemoteHttpResponse {
  statusCode: number
  body?: Uint8Array
  contentType?: 'application/json' | 'application/octet-stream'
}

export interface RemoteHttpRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  requiredScope: string
  handle(context: RemoteRequestContext): Promise<RemoteHttpResponse> | RemoteHttpResponse
}

export interface RemoteBootstrapRequestContext {
  connectionId: string
  operation: 'request' | 'proof' | 'confirm'
  body: Uint8Array
  socket: Socket
}

/** G1 owns the bounded bootstrap transport; only G2 can supply a protocol handler. */
export interface RemoteBootstrapPort {
  handle(context: RemoteBootstrapRequestContext): Promise<RemoteHttpResponse> | RemoteHttpResponse
}

export interface RemoteTransportReady {
  type: 'transport-ready'
  transportVersion: 1
  capabilities: string[]
}

export interface RemoteTransportChannel {
  connectionId: string
  peer: RemoteAuthorizedPeer
  send(data: string | Uint8Array): boolean
  close(code?: number, reason?: string): void
}

export interface RemoteTransportMessageContext {
  channel: RemoteTransportChannel
  payload: unknown
}

export interface RemoteTransportMessagePort {
  onMessage(context: RemoteTransportMessageContext): void
}

export interface RemoteTransportLifecycle {
  listen(): Promise<void>
  close(): Promise<void>
  address(): { address: string; family: string; port: number } | null
}

export interface RemoteTransportLogger {
  info(event: string, details?: Record<string, string | number | boolean | null>): void
  warn(event: string, details?: Record<string, string | number | boolean | null>): void
  error(event: string, details?: Record<string, string | number | boolean | null>): void
}

export function createTransportReady(capabilities: readonly string[]): RemoteTransportReady {
  const unique = [...new Set(capabilities)]
  if (unique.length > REMOTE_LIMITS.maxCapabilities || unique.some(value =>
      !/^[A-Za-z0-9._-]{1,32}$/.test(value))) throw new Error('REMOTE_CAPABILITIES_INVALID')
  return { type: 'transport-ready', transportVersion: REMOTE_TRANSPORT_VERSION, capabilities: unique }
}
