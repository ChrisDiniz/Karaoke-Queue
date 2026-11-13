import { randomUUID } from 'node:crypto'
import { encodeBase64Url } from './pairing-crypto'
import type { ManagementOutboxDatabase } from './management-remote-outbox'
import { ManagementRemoteOutbox } from './management-remote-outbox'
import type { ManagementRemoteJournalDatabase } from './management-remote-journal'
import { ManagementRemoteJournalInbox } from './management-remote-journal'
import { ManagementRemoteReconciliationService } from './remote-reconciliation-service'
import { RemoteOperationalClient } from './remote-operational-client'
import type { RemoteReconnectPort, RemotePeerChannel, SavedRemotePeer } from './remote-reconnection-service'
import type { PairingStore, StoredControllerAuthority } from './pairing-store'
import type { RemoteOperationalClient as ClientType } from './remote-operational-client'

export type ManagementRemoteDatabase = ManagementOutboxDatabase & ManagementRemoteJournalDatabase

/** Main-owned adapter joining saved G2 authorities, the pinned G1 WSS client and G3 durable ports. */
export class MainRemoteReconnectionAdapter implements RemoteReconnectPort {
  private readonly clients = new WeakMap<RemotePeerChannel, ClientType>()
  private readonly inbox: ManagementRemoteJournalInbox
  private readonly outbox: ManagementRemoteOutbox

  constructor(private readonly pairingStore: PairingStore, private readonly controllerId: string,
    database: ManagementRemoteDatabase, private readonly monotonicNow: () => number =
      () => Number(process.hrtime.bigint() / 1_000_000n)) {
    this.inbox = new ManagementRemoteJournalInbox(database, { controllerId })
    this.outbox = new ManagementRemoteOutbox(database, { deviceId: controllerId, controllerId })
  }

  async savedPeers(): Promise<SavedRemotePeer[]> {
    const state = await this.pairingStore.read()
    return Object.values(state.controllerAuthorities).filter(authority => authority.phase === 'active')
      .map(authority => ({ playerId: authority.playerId, fingerprintSha256: authority.certificateFingerprintSha256,
        serverName: authority.serverName, port: authority.port, lastAddress: authority.address,
        active: true, credentialGeneration: authority.credentialGeneration }))
  }

  async connect(peer: SavedRemotePeer, address: string, signal: AbortSignal, candidatePort = peer.port): Promise<RemotePeerChannel> {
    if (signal.aborted) throw new Error('REMOTE_RECONNECT_ABORTED')
    const authority = await this.currentAuthority(peer)
    const token = await this.pairingStore.decryptSecret(authority.encryptedToken)
    let bearer: string
    try { bearer = encodeBase64Url(token) } finally { token.fill(0) }
    if (signal.aborted) throw new Error('REMOTE_RECONNECT_ABORTED')
    const cursor = this.inbox.cursor(peer.playerId)
    const client = await RemoteOperationalClient.connect({ address, port: candidatePort,
      pin: { certificatePem: authority.certificatePem, fingerprintSha256: authority.certificateFingerprintSha256,
        serverName: authority.serverName }, bearer,
      identity: { playerId: peer.playerId, controllerId: this.controllerId, journalId: cursor?.journalId,
        credentialGeneration: authority.credentialGeneration },
      authorizedPeer: { controllerId: this.controllerId, credentialGeneration: authority.credentialGeneration,
        scopes: ['transport:control'] }, signal })
    if (signal.aborted) { await client.close(); throw new Error('REMOTE_RECONNECT_ABORTED') }
    const ready = await client.ready()
    const channel = client as unknown as RemotePeerChannel
    this.clients.set(channel, client)
    Object.defineProperties(channel, {
      connectionId: { value: randomUUID(), enumerable: true },
      playerId: { value: peer.playerId, enumerable: true },
      fingerprintSha256: { value: authority.certificateFingerprintSha256, enumerable: true },
      credentialGeneration: { value: authority.credentialGeneration, enumerable: true },
      playerEpoch: { value: ready.body.playerEpoch, enumerable: true },
      controlEpoch: { value: ready.body.controlEpoch, enumerable: true },
      journalId: { value: ready.body.journalId, enumerable: true },
      onClose: { value: client.onDisconnect.bind(client), enumerable: true }
    })
    return channel
  }

  async reconcile(peer: SavedRemotePeer, channel: RemotePeerChannel, signal: AbortSignal): Promise<
    { state: 'synchronized' } | { state: 'recovery_required'; reason: string }> {
    const client = this.clients.get(channel)
    if (!client) throw new Error('REMOTE_RECONCILIATION_CHANNEL_UNKNOWN')
    const ready = await client.ready()
    const reconciler = new ManagementRemoteReconciliationService(this.inbox, this.outbox,
      { playerDeviceId: peer.playerId, controllerId: this.controllerId }, client, this.monotonicNow,
      { journalId: ready.body.journalId, playerEpoch: ready.body.playerEpoch, controlEpoch: ready.body.controlEpoch })
    const result = await reconciler.reconcile(signal)
    return result.state === 'synchronized' ? { state: 'synchronized' } :
      { state: 'recovery_required', reason: result.reason }
  }

  async isAuthorizationCurrent(peer: SavedRemotePeer, channel: RemotePeerChannel): Promise<boolean> {
    try {
      const current = await this.currentAuthority(peer)
      return current.phase === 'active' && current.credentialGeneration === channel.credentialGeneration &&
        current.certificateFingerprintSha256 === channel.fingerprintSha256 &&
        channel.playerId === current.playerId
    } catch { return false }
  }

  private async currentAuthority(peer: SavedRemotePeer): Promise<StoredControllerAuthority> {
    const state = await this.pairingStore.read()
    const authority = state.controllerAuthorities[peer.playerId]
    if (!authority || authority.phase !== 'active' || authority.credentialGeneration !== peer.credentialGeneration ||
        authority.certificateFingerprintSha256 !== peer.fingerprintSha256 || authority.serverName !== peer.serverName ||
        authority.port !== peer.port) throw new Error('REMOTE_AUTHORIZATION_REVOKED')
    return authority
  }
}
