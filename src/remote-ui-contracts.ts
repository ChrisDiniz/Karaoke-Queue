import type { DiscoveryCandidate } from './remote-contracts'
import type { RemoteConnectionState, RemotePeerStatus } from './remote-reconnection-service'

export type RemoteUiRole = 'player' | 'management'
export type RemoteUiIntent = 'disabled' | 'enabled' | 'offline' | 'recovery_required'
export type RemoteUiDiscoveryState = 'stopped' | 'searching' | 'ready' | 'unavailable'

export interface RemoteUiCandidate {
  readonly candidateId: string
  readonly displayName: string
  readonly addresses: readonly string[]
  readonly port: number
  readonly observedAt: number
  readonly expiresAt: number
  readonly verified: false
  /** Unverified mDNS claim. It may select a saved record, never authenticate that record. */
  readonly claimedDeviceId: string | null
}

export interface RemoteUiConnection {
  readonly deviceId: string
  readonly deviceRole: 'player' | 'controller'
  readonly state: RemoteConnectionState
  readonly reason: string | null
  readonly retryAt: number | null
  /** Technical reconciliation only; never represents business-control authority. */
  readonly reconciled: boolean
}

export interface RemoteUiOperation {
  readonly playerId: string
  readonly operationId: string
  readonly status: 'not-sent' | 'rejected' | 'accepted' | 'completed' | 'unknown'
  readonly updatedAt: number
}

export interface RemoteUiSavedDevice {
  readonly playerId: string
  readonly status: 'active' | 'revoked'
  readonly address: string
  readonly port: number
  readonly recoveryRequired: boolean
  /** True only for G2 journal phases supported by the existing recovery client. */
  readonly recoveryActionAvailable: boolean
}

/** Sanitized projection of an unresolved Controller G2 journal, including pre-authority initial pairing. */
export interface RemoteUiPairingRecovery {
  readonly playerId: string
  /** True only for journal phases supported by the existing G2 recovery client. */
  readonly recoveryActionAvailable: boolean
}

export type RemoteUiPlayerPairingState = 'unpaired' | 'active' | 'revoked' | 'recovery_required' | 'unavailable'

export interface RemoteUiSnapshot {
  readonly revision: number
  readonly role: RemoteUiRole
  readonly intent: RemoteUiIntent
  readonly listener: 'stopped' | 'starting' | 'advertising' | 'error'
  readonly listenerEndpoint: { readonly address: string; readonly port: number } | null
  readonly discovery: RemoteUiDiscoveryState
  readonly candidates: readonly RemoteUiCandidate[]
  readonly connections: readonly RemoteUiConnection[]
  readonly operations: readonly RemoteUiOperation[]
  readonly savedDevices: readonly RemoteUiSavedDevice[]
  readonly pairingRecoveries: readonly RemoteUiPairingRecovery[]
  /** Pairing state is unavailable when its durable journal cannot be read; callers must not offer a new pairing. */
  readonly pairingStoreStatus: 'available' | 'unavailable'
  readonly playerPairing: RemoteUiPlayerPairingState
  readonly errorCode: string | null
}

export type RemoteUiCandidatePairingAction =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'recovery'; readonly playerId: string }
  | { readonly kind: 'recovery-blocked'; readonly playerId: string }
  | { readonly kind: 'renewal'; readonly playerId: string }
  | { readonly kind: 'saved' | 'initial' }

export type PlayerPairingUiEvent =
  | { readonly type: 'consent-request'; readonly requestId: string; readonly revision: number;
      readonly displayName: string; readonly purpose: 'initial' | 'renewal'; readonly remainingMs: number }
  | { readonly type: 'temporary-code'; readonly requestId: string; readonly revision: number;
      readonly groupedCode: string; readonly remainingMs: number }
  | { readonly type: 'closed'; readonly requestId: string; readonly revision: number;
      readonly outcome: 'rejected' | 'cancelled' | 'timed-out' | 'active' | 'error' }

export type ManagementPairingUiEvent =
  | { readonly type: 'recovery-started'; readonly requestId: string; readonly revision: number;
      readonly playerName: string }
  | { readonly type: 'waiting-consent'; readonly requestId: string; readonly revision: number;
      readonly playerName: string; readonly purpose: 'initial' | 'renewal' }
  | { readonly type: 'code-request'; readonly requestId: string; readonly revision: number;
      readonly playerName: string; readonly remainingMs: number; readonly purpose: 'initial' | 'renewal' }
  | { readonly type: 'closed'; readonly requestId: string; readonly revision: number;
      readonly outcome: 'cancelled' | 'active' | 'error' }

export interface RemoteUiActionReply {
  readonly outcome: 'started' | 'completed' | 'cancelled' | 'failed'
  readonly code?: string
}

export interface PairingUiEventCursor {
  readonly requestId?: string
  readonly revision: number
  readonly terminal: boolean
}

/** Accept events only for the newest Main-owned pairing presentation. */
export function advancePairingUiEventCursor(current: PairingUiEventCursor,
  event: { readonly requestId: string; readonly revision: number }, terminal = false): PairingUiEventCursor | null {
  if (!Number.isSafeInteger(event.revision) || event.revision < current.revision) return null
  if (event.revision === current.revision && (event.requestId !== current.requestId || current.terminal)) return null
  return { requestId: event.requestId, revision: event.revision, terminal }
}

export interface ManagementRemoteUiBridge {
  getSnapshot(): Promise<RemoteUiSnapshot>
  onSnapshot(listener: (snapshot: RemoteUiSnapshot) => void): () => void
  startDiscovery(): Promise<RemoteUiActionReply>
  refreshDiscovery(): Promise<RemoteUiActionReply>
  onPairingEvent(listener: (event: ManagementPairingUiEvent) => void): () => void
  pair(candidateId: string): Promise<RemoteUiActionReply>
  renewPairing(candidateId: string): Promise<RemoteUiActionReply>
  recoverPairing(playerId: string, candidateId: string): Promise<RemoteUiActionReply>
  submitPairingCode(requestId: string, revision: number, code: string): Promise<boolean>
  cancelPairing(requestId: string, revision: number): Promise<boolean>
  queryOperation(playerId: string, operationId: string): Promise<RemoteUiActionReply>
  revokePeerLocally(playerId: string): Promise<RemoteUiActionReply>
  pairManualAddress(address: string, port: number): Promise<RemoteUiActionReply>
}

export interface PlayerRemoteUiBridge {
  isAvailable(): Promise<boolean>
  getSnapshot(): Promise<RemoteUiSnapshot>
  getNetworkInterfaces(): Promise<readonly { readonly address: string; readonly label: string }[]>
  onSnapshot(listener: (snapshot: RemoteUiSnapshot) => void): () => void
  onPairingEvent(listener: (event: PlayerPairingUiEvent) => void): () => void
  enableDiscovery(interfaceAddress: string): Promise<RemoteUiActionReply>
  disableDiscovery(): Promise<RemoteUiActionReply>
  renewCertificate(interfaceAddress: string): Promise<RemoteUiActionReply>
  revokePairing(): Promise<RemoteUiActionReply>
  answerConsent(requestId: string, revision: number, accepted: boolean): Promise<boolean>
  cancelPairing(requestId: string, revision: number): Promise<RemoteUiActionReply>
}

export function toRemoteUiConnection(status: RemotePeerStatus): RemoteUiConnection {
  return {
    deviceId: status.playerId,
    deviceRole: 'player',
    state: status.state,
    reason: safeReason(status.reason),
    retryAt: status.retryAt,
    reconciled: status.state === 'synchronized' && status.synchronized
  }
}

export function toPlayerTransportConnection(controllerId: string, state: 'authorized' | 'closed'): RemoteUiConnection {
  return { deviceId: controllerId, deviceRole: 'controller', state, reason: null, retryAt: null, reconciled: false }
}

/** A discovery claim selects a persisted recovery record; it never authenticates the Player. */
export function findPairingRecovery(recoveries: readonly RemoteUiPairingRecovery[], claimedDeviceId: string | null):
  RemoteUiPairingRecovery | undefined {
  return claimedDeviceId ? recoveries.find(recovery => recovery.playerId === claimedDeviceId) : undefined
}

/** Selects only a UI action; the unverified discovery claim is revalidated by Main and G2 before recovery. */
export function getCandidatePairingAction(snapshot: RemoteUiSnapshot, candidate: RemoteUiCandidate):
  RemoteUiCandidatePairingAction {
  if (snapshot.pairingStoreStatus === 'unavailable') return { kind: 'unavailable' }
  const saved = snapshot.savedDevices.find(device => device.playerId === candidate.claimedDeviceId && device.status === 'active')
  const recovery = findPairingRecovery(snapshot.pairingRecoveries, candidate.claimedDeviceId)
  if (saved?.recoveryRequired || recovery) {
    const playerId = saved?.playerId ?? recovery!.playerId
    const available = saved?.recoveryRequired ? saved.recoveryActionAvailable : recovery?.recoveryActionAvailable ?? false
    return available ? { kind: 'recovery', playerId } : { kind: 'recovery-blocked', playerId }
  }
  if (!saved) return { kind: 'initial' }
  const connection = snapshot.connections.find(value => value.deviceRole === 'player' && value.deviceId === saved.playerId)
  if (connection?.state === 'conflict' &&
      ['REMOTE_CERTIFICATE_PIN_MISMATCH', 'REMOTE_CERTIFICATE_EXPIRED'].includes(connection.reason ?? '')) {
    return { kind: 'renewal', playerId: saved.playerId }
  }
  return { kind: 'saved' }
}

export function toRemoteUiCandidate(candidate: DiscoveryCandidate): RemoteUiCandidate {
  return {
    candidateId: candidate.candidateId,
    displayName: candidate.displayName.slice(0, 64),
    addresses: candidate.addresses.filter(address => address.length <= 45).slice(0, 4),
    port: candidate.port,
    observedAt: candidate.observedAt,
    expiresAt: candidate.expiresAt,
    verified: false,
    claimedDeviceId: candidate.deviceIdClaim
  }
}

export function safeReason(reason: string | null): string | null {
  return reason && /^[A-Z0-9_]{1,64}$/.test(reason) ? reason : reason ? 'REMOTE_CONNECTION_ERROR' : null
}
