import type { safeStorage } from 'electron'
import type { OperatingMode } from './operating-mode'
import { BonjourDiscoveryPort, BonjourPlayerAdvertisementPort, createManualDiscoveryCandidate } from './remote-discovery'
import type { PlayerAdvertisementPort } from './remote-contracts'
import type { RemoteAuthorizationPort, RemoteBootstrapPort, RemoteDeviceIdentity,
  RemoteTransportLogger, RemoteTransportMessagePort } from './remote-contracts'
import { RemoteIdentityStore } from './remote-identity-store'
import { ElectronSafeStorageSecretProtector, type SafeStoragePort } from './remote-secret-protector'
import { createRemoteTransportServer } from './remote-transport'
import { PairingStore } from './pairing-store'
import { PairingAuthorizationAdapter } from './pairing-authorization'
import { PairingBootstrapService, type PairingPresentationPort } from './pairing-bootstrap'
import { PairingControllerClient, type PairingCandidateSelection, type PairingControllerResult,
  type PairingManagementPresentationPort } from './pairing-controller'
import { PairingRenewalCoordinator } from './pairing-renewal'
import { MainRemoteReconnectionAdapter, type ManagementRemoteDatabase } from './main-remote-reconnection'
import { RemoteReconnectionService } from './remote-reconnection-service'
import { toPlayerTransportConnection, toRemoteUiCandidate, toRemoteUiConnection } from './remote-ui-contracts'
import type { RemoteUiConnection } from './remote-ui-contracts'
import type { RemoteUiRole, RemoteUiSnapshot } from './remote-ui-contracts'
import type { RemotePeerStatus } from './remote-reconnection-service'
import { RemoteControlIntentStore, type RemoteControlIntent } from './remote-control-intent'
import { createMainPlayerOperationalEndpoint } from './main-player-operational-endpoint'
import type { MainPlayerOperationalEndpoint, PlayerOperationalObservation } from './main-player-operational-endpoint'

export interface MainRemoteRuntimeOptions {
  mode: OperatingMode
  userDataDirectory: string
  safeStorage?: SafeStoragePort
  logger?: RemoteTransportLogger
  createAdvertiser?: () => PlayerAdvertisementPort
  getPlayerOperationalObservation?: () => PlayerOperationalObservation
}

export interface StartRemotePlayerOptions {
  interfaceAddress: string
  displayName: string
  port: number
  authorization: RemoteAuthorizationPort
  bootstrap?: RemoteBootstrapPort
  messagePort?: RemoteTransportMessagePort
}

/** Lazy composition root: no network, safeStorage, identity or discovery work occurs on ordinary startup. */
export class MainRemoteRuntime {
  private server: ReturnType<typeof createRemoteTransportServer> | undefined
  private playerListenEndpoint: { address: string; port: number } | undefined
  private advertiser: PlayerAdvertisementPort | undefined
  private discovery: BonjourDiscoveryPort | undefined
  private closeTask: Promise<void> | undefined
  private playerStartTask: Promise<RemoteDeviceIdentity> | undefined
  private playerIntentGeneration = 0
  private closed = false
  private readonly identities: RemoteIdentityStore
  private readonly secretProtector: ElectronSafeStorageSecretProtector
  private pairingStore: PairingStore | undefined
  private pairingAuthorization: PairingAuthorizationAdapter | undefined
  private playerOperationalEndpoint: MainPlayerOperationalEndpoint | undefined
  private pairingBootstrap: PairingBootstrapService | undefined
  private pairingController: PairingControllerClient | undefined
  private managementReconnect: RemoteReconnectionService | undefined
  private managementReconnectAdapter: MainRemoteReconnectionAdapter | undefined
  private managementReconnectAdapterTask: Promise<MainRemoteReconnectionAdapter | undefined> | undefined
  private managementReconnectStartTask: Promise<void> | undefined
  private managementReconnectGeneration = 0
  private managementReconnectDiscovery: BonjourDiscoveryPort | undefined
  private unsubscribeReconnectDiscovery: (() => void) | undefined
  private unsubscribeUiDiscovery: (() => void) | undefined
  private managementDiscoveryRetainedByUi = false
  private remoteUiRevision = 0
  private remoteUiErrorCode: string | null = null
  private readonly remoteUiListeners = new Set<() => void>()
  private readonly remoteUiConnections = new Map<string, RemotePeerStatus>()
  private readonly remoteUiPlayerConnections = new Map<string, RemoteUiConnection>()
  private readonly remoteIntent: RemoteControlIntentStore

  constructor(private readonly options: MainRemoteRuntimeOptions) {
    this.secretProtector = new ElectronSafeStorageSecretProtector(options.safeStorage ?? require('electron').safeStorage as typeof safeStorage)
    this.identities = new RemoteIdentityStore(options.userDataDirectory, this.secretProtector)
    this.remoteIntent = new RemoteControlIntentStore(options.userDataDirectory)
  }

  /** Reuses the identity writer already owned by this Main runtime. */
  loadOrCreateControllerIdentity(): Promise<RemoteDeviceIdentity> {
    this.assertOpen()
    if (this.options.mode === 'player') throw new Error('REMOTE_CONTROLLER_MODE_REQUIRED')
    return this.identities.loadOrCreateControllerIdentity()
  }

  createPairingStore(): PairingStore {
    this.assertOpen()
    return this.pairingStore ??= new PairingStore(this.options.userDataDirectory, this.secretProtector)
  }

  createPlayerPairingAuthorization(): PairingAuthorizationAdapter {
    this.assertOpen()
    if (this.options.mode !== 'player') throw new Error('REMOTE_PLAYER_MODE_REQUIRED')
    return this.pairingAuthorization ??= new PairingAuthorizationAdapter(this.createPairingStore())
  }

  async configurePlayerPairingPresentation(presentation: PairingPresentationPort | undefined): Promise<void> {
    this.assertOpen()
    if (this.options.mode !== 'player') throw new Error('REMOTE_PLAYER_MODE_REQUIRED')
    if (this.server || this.playerStartTask) throw new Error('REMOTE_PLAYER_ALREADY_STARTED')
    if (presentation && presentation.approvedForProduction !== true) throw new Error('PAIRING_PRESENTATION_UNAPPROVED')
    await this.pairingBootstrap?.close()
    this.pairingBootstrap = undefined
    if (!presentation) return
    const intentGeneration = this.playerIntentGeneration
    const intent = await this.remoteIntent.read()
    this.assertPlayerIntentCurrent(intentGeneration)
    if (intent.intent === 'offline') throw new Error('REMOTE_PLAYER_EXPLICITLY_OFFLINE')
    if (intent.intent === 'recovery_required') throw new Error('REMOTE_PLAYER_INTENT_RECOVERY_REQUIRED')
    const identity = await this.identities.loadOrCreatePlayerIdentity()
    this.assertPlayerIntentCurrent(intentGeneration)
    this.pairingBootstrap = new PairingBootstrapService(identity, this.createPairingStore(), presentation)
    this.publishRemoteUiChange()
  }

  /** Snapshot sanitized for renderer presentation; it carries no pairing secret or operational authority. */
  async getRemoteUiSnapshot(role: RemoteUiRole, managementDatabase?: ManagementRemoteDatabase): Promise<RemoteUiSnapshot> {
    this.assertOpen()
    if (role === 'management' && managementDatabase) await this.ensureManagementReconnectAdapter(managementDatabase, false)
    let savedDevices: RemoteUiSnapshot['savedDevices'] = []
    let pairingRecoveries: RemoteUiSnapshot['pairingRecoveries'] = []
    let pairingStoreStatus: RemoteUiSnapshot['pairingStoreStatus'] = 'available'
    let playerPairing: RemoteUiSnapshot['playerPairing'] = 'unavailable'
    try {
      if (role === 'player') {
        const state = await this.createPairingStore().read()
        const unresolved = state.journals.some(item => item.role === 'player' &&
          ['bound', 'prepared', 'committed', 'uncertain'].includes(item.phase)) || state.renewal?.phase === 'promoting'
        playerPairing = unresolved ? 'recovery_required' : state.playerAuthority?.phase ?? 'unpaired'
      } else {
        // Read the durable journal even before the first pairing. Otherwise an unreadable
        // store could be presented as an empty device list and invite a duplicate pairing.
        const state = await this.createPairingStore().read()
        const unresolvedJournals = state.journals.filter(item => item.role === 'controller' &&
          ['bound', 'prepared', 'committed', 'uncertain'].includes(item.phase))
        const recoveryJournalByPlayer = new Map<string, typeof unresolvedJournals[number]>()
        for (const journal of unresolvedJournals) {
          if (!recoveryJournalByPlayer.has(journal.context.playerId)) {
            recoveryJournalByPlayer.set(journal.context.playerId, journal)
          }
        }
        pairingRecoveries = [...recoveryJournalByPlayer].map(([playerId, journal]) => ({
          playerId,
          recoveryActionAvailable: ['bound', 'prepared', 'committed'].includes(journal.phase)
        }))
        savedDevices = Object.values(state.controllerAuthorities).map(authority => {
          const journal = recoveryJournalByPlayer.get(authority.playerId)
          return {
            playerId: authority.playerId, status: authority.phase, address: authority.address, port: authority.port,
            recoveryRequired: Boolean(journal),
            recoveryActionAvailable: Boolean(journal && ['bound', 'prepared', 'committed'].includes(journal.phase))
          }
        })
      }
    } catch {
      pairingStoreStatus = 'unavailable'
      playerPairing = 'unavailable'
    }
    // Read persistent intent and capture live runtime state after asynchronous store reads. Otherwise a
    // listener started while pairing state loads could be reported as advertising with a null endpoint.
    const intentState = await this.remoteIntent.read()
    this.assertOpen()
    const discovery = this.discovery ?? this.managementReconnectDiscovery
    const candidates = role === 'management' && discovery
      ? discovery.getSnapshot().candidates.map(toRemoteUiCandidate)
      : []
    const operations = role === 'management' ? (this.managementReconnectAdapter?.listOperations() ?? []).map(record => ({
      playerId: record.playerDeviceId, operationId: record.operationId, status: record.status, updatedAt: record.updatedAt
    })) : []
    const connectionsByPlayer = new Map(this.remoteUiConnections)
    if (role === 'management') {
      for (const device of savedDevices) {
        const liveStatus = this.managementReconnect?.status(device.playerId)
        if (liveStatus) connectionsByPlayer.set(device.playerId, liveStatus)
      }
    }
    const revision = this.remoteUiRevision
    const playerServer = role === 'player' ? this.server : undefined
    const playerStartTask = this.playerStartTask
    const playerBoundAddress = playerServer?.address() ?? null
    const listener: RemoteUiSnapshot['listener'] = role !== 'player' ? 'stopped'
      : playerStartTask ? 'starting'
        : playerServer ? playerBoundAddress ? 'advertising' : 'error' : 'stopped'
    return {
      revision,
      role,
      intent: intentState.intent,
      listener,
      listenerEndpoint: role === 'player' && playerServer === this.server && playerBoundAddress && this.playerListenEndpoint
        ? { address: this.playerListenEndpoint.address, port: playerBoundAddress.port } : null,
      discovery: role === 'management' && discovery ? 'ready' : 'stopped',
      candidates,
      connections: role === 'management' ? [...connectionsByPlayer.values()].map(toRemoteUiConnection)
        : [...this.remoteUiPlayerConnections.values()],
      operations,
      savedDevices,
      pairingRecoveries,
      pairingStoreStatus,
      playerPairing,
      errorCode: listener === 'error' ? this.remoteUiErrorCode ?? 'REMOTE_LISTENER_NOT_BOUND' : this.remoteUiErrorCode
    }
  }

  subscribeRemoteUi(listener: () => void): () => void {
    this.assertOpen()
    this.remoteUiListeners.add(listener)
    return () => this.remoteUiListeners.delete(listener)
  }

  getCurrentManagementDiscovery(): BonjourDiscoveryPort | undefined {
    return this.discovery ?? this.managementReconnectDiscovery
  }

  async queryRemoteOperationStatus(playerId: string, operationId: string): Promise<'updated' | 'not-found' | 'terminal'> {
    this.assertOpen()
    if (this.options.mode === 'player') throw new Error('REMOTE_CONTROLLER_MODE_REQUIRED')
    const connection = this.managementConnection(playerId)
    if (connection?.state === 'recovery_required') throw new Error('REMOTE_PLAYER_RECOVERY_REQUIRED')
    if (!connection || connection.state !== 'synchronized' || !connection.synchronized) {
      throw new Error('REMOTE_OPERATIONAL_CHANNEL_UNAVAILABLE')
    }
    const adapter = this.managementReconnectAdapter
    if (!adapter) throw new Error('REMOTE_OPERATIONAL_CHANNEL_UNAVAILABLE')
    const result = await adapter.queryOperationStatus(playerId, operationId, new AbortController().signal)
    this.publishRemoteUiChange()
    return result.outcome
  }

  private managementConnection(playerId: string): RemotePeerStatus | undefined {
    return this.managementReconnect?.status(playerId) ?? this.remoteUiConnections.get(playerId)
  }

  private async ensureManagementReconnectAdapter(database: ManagementRemoteDatabase,
    createIdentity = true): Promise<MainRemoteReconnectionAdapter | undefined> {
    if (this.managementReconnectAdapter) return this.managementReconnectAdapter
    if (!this.managementReconnectAdapterTask) {
      const task = this.loadManagementReconnectAdapter(database, createIdentity)
      this.managementReconnectAdapterTask = task
      void task.finally(() => {
        if (this.managementReconnectAdapterTask === task) this.managementReconnectAdapterTask = undefined
      }).catch(() => undefined)
    }
    return this.managementReconnectAdapterTask
  }

  private async loadManagementReconnectAdapter(database: ManagementRemoteDatabase,
    createIdentity: boolean): Promise<MainRemoteReconnectionAdapter | undefined> {
    const identity = createIdentity ? await this.loadOrCreateControllerIdentity() : await this.identities.loadControllerIdentity()
    if (!identity) return undefined
    this.assertOpen()
    if (this.managementReconnectAdapter) return this.managementReconnectAdapter
    const adapter = new MainRemoteReconnectionAdapter(this.createPairingStore(), identity.deviceId, database)
    this.managementReconnectAdapter = adapter
    return adapter
  }

  async pairWithDiscoveredCandidate(candidateId: string, presentation: PairingManagementPresentationPort,
    signal: AbortSignal, purpose: 'initial' | 'renewal' = 'initial'): Promise<PairingControllerResult> {
    this.assertOpen()
    const discovery = this.getCurrentManagementDiscovery()
    const candidate = discovery?.getSnapshot().candidates.find(value => value.candidateId === candidateId)
    if (!candidate || candidate.expiresAt <= Date.now()) throw new Error('REMOTE_CANDIDATE_STALE')
    const client = this.createPairingController(presentation)
    try {
      return await client.pair({ candidate, displayName: 'Gestão', purpose } satisfies PairingCandidateSelection, signal)
    } finally {
      await client.close().catch(() => undefined)
      if (this.pairingController === client) this.pairingController = undefined
    }
  }

  async pairWithManualAddress(address: string, port: number, presentation: PairingManagementPresentationPort,
    signal: AbortSignal): Promise<PairingControllerResult> {
    this.assertOpen()
    if (this.options.mode === 'player') throw new Error('REMOTE_CONTROLLER_MODE_REQUIRED')
    const candidate = createManualDiscoveryCandidate(address, port)
    const client = this.createPairingController(presentation)
    try { return await client.pair({ candidate, displayName: 'Gestão', purpose: 'initial' }, signal) }
    finally {
      await client.close().catch(() => undefined)
      if (this.pairingController === client) this.pairingController = undefined
    }
  }

  async recoverManagementPairing(playerId: string, candidateId: string,
    presentation: PairingManagementPresentationPort, signal: AbortSignal): Promise<PairingControllerResult> {
    this.assertOpen()
    if (this.options.mode === 'player') throw new Error('REMOTE_CONTROLLER_MODE_REQUIRED')
    const discovery = this.getCurrentManagementDiscovery()
    const candidate = discovery?.getSnapshot().candidates.find(value => value.candidateId === candidateId)
    if (!candidate || candidate.expiresAt <= Date.now()) throw new Error('REMOTE_CANDIDATE_STALE')
    if (candidate.deviceIdClaim !== playerId) throw new Error('PAIRING_RECOVERY_IDENTITY_MISMATCH')
    const state = await this.createPairingStore().read()
    const journal = state.journals.find(item => item.role === 'controller' && item.context.playerId === playerId &&
      ['bound', 'prepared', 'committed'].includes(item.phase))
    if (!journal) throw new Error('PAIRING_RECOVERY_NOT_FOUND')
    const client = this.createPairingController(presentation)
    try {
      return await client.recover({ candidate, displayName: 'Gestão', purpose: journal.context.purpose }, signal)
    } finally {
      await client.close().catch(() => undefined)
      if (this.pairingController === client) this.pairingController = undefined
    }
  }

  async enableManagementReconnection(database: ManagementRemoteDatabase,
    interfaceAddresses: readonly string[]): Promise<void> {
    const service = this.managementReconnect
    if (!service) {
      await this.setRemoteControlIntent('enabled')
      await this.startManagementReconnection(database, interfaceAddresses)
      return
    }
    const generation = this.managementReconnectGeneration
    const adapter = this.managementReconnectAdapter
    if (!adapter) throw new Error('REMOTE_RECONNECTION_ADAPTER_UNAVAILABLE')
    const peers = await adapter.savedPeers()
    if (this.managementReconnect !== service || generation !== this.managementReconnectGeneration) {
      throw new Error('REMOTE_RECONNECTION_START_FENCED')
    }
    await service.start(peers)
    const discovery = this.getCurrentManagementDiscovery()
    if (discovery) service.updateDiscovery(discovery.getSnapshot().candidates)
    this.publishRemoteUiChange()
  }

  async acceptG2PairingUpdate(playerId: string): Promise<void> {
    this.assertOpen()
    if (this.options.mode === 'player') throw new Error('REMOTE_CONTROLLER_MODE_REQUIRED')
    const state = await this.createPairingStore().read()
    if (state.controllerAuthorities[playerId]?.phase !== 'active') throw new Error('PAIRING_AUTHORITY_NOT_ACTIVE')
    await this.managementReconnect?.removePeer(playerId, 'REMOTE_PAIRING_AUTHORITY_UPDATED')
    this.remoteUiConnections.delete(playerId)
    this.publishRemoteUiChange()
  }

  async cancelPlayerPairing(): Promise<boolean> {
    this.assertOpen()
    if (this.options.mode !== 'player') throw new Error('REMOTE_PLAYER_MODE_REQUIRED')
    return this.pairingBootstrap?.cancelLocally() ?? false
  }

  private publishRemoteUiChange(errorCode?: string): void {
    this.remoteUiRevision++
    this.remoteUiErrorCode = errorCode && /^[A-Z0-9_]{1,64}$/.test(errorCode) ? errorCode : null
    for (const listener of [...this.remoteUiListeners]) {
      try { listener() } catch { /* Renderer subscribers cannot affect remote services. */ }
    }
  }

  private attachUiDiscovery(discovery: BonjourDiscoveryPort): void {
    this.unsubscribeUiDiscovery?.()
    this.unsubscribeUiDiscovery = discovery.subscribe(() => this.publishRemoteUiChange())
    this.publishRemoteUiChange()
  }

  startPlayer(options: StartRemotePlayerOptions): Promise<RemoteDeviceIdentity> {
    this.assertOpen()
    if (this.options.mode !== 'player') throw new Error('REMOTE_PLAYER_MODE_REQUIRED')
    if (!options.authorization) throw new Error('REMOTE_AUTHORIZATION_UNAVAILABLE')
    if (options.bootstrap && options.bootstrap !== this.pairingBootstrap) throw new Error('PAIRING_BOOTSTRAP_UNAPPROVED')
    if (this.playerStartTask || this.server || this.advertiser) throw new Error('REMOTE_PLAYER_ALREADY_STARTED')
    const generation = this.playerIntentGeneration
    const task = this.remoteIntent.read().then(intent => {
      this.assertPlayerIntentCurrent(generation)
      if (intent.intent === 'offline') throw new Error('REMOTE_PLAYER_EXPLICITLY_OFFLINE')
      if (intent.intent === 'recovery_required') throw new Error('REMOTE_PLAYER_INTENT_RECOVERY_REQUIRED')
      return this.startPlayerInternal(options, undefined, generation)
    })
    this.playerStartTask = task
    void task.then(() => this.clearPlayerStartTask(task), () => this.clearPlayerStartTask(task))
    return task
  }

  /** Explicit Player-local annual renewal; the new certificate is staged before its pairing listener starts. */
  startGuidedPlayerCertificateRenewal(options: StartRemotePlayerOptions & { presentation: PairingPresentationPort }): Promise<RemoteDeviceIdentity> {
    this.assertOpen()
    if (this.options.mode !== 'player') throw new Error('REMOTE_PLAYER_MODE_REQUIRED')
    if (options.presentation.approvedForProduction !== true) throw new Error('PAIRING_PRESENTATION_UNAPPROVED')
    if (!options.authorization) throw new Error('REMOTE_AUTHORIZATION_UNAVAILABLE')
    if (options.bootstrap) throw new Error('PAIRING_BOOTSTRAP_UNAPPROVED')
    if (this.playerStartTask) throw new Error('REMOTE_PLAYER_ALREADY_STARTED')
    const generation = this.playerIntentGeneration
    const task = this.remoteIntent.read().then(intent => {
      this.assertPlayerIntentCurrent(generation)
      if (intent.intent === 'offline') throw new Error('REMOTE_PLAYER_EXPLICITLY_OFFLINE')
      if (intent.intent === 'recovery_required') throw new Error('REMOTE_PLAYER_INTENT_RECOVERY_REQUIRED')
      return this.startGuidedRenewalInternal(options, generation)
    })
    this.playerStartTask = task
    void task.then(() => this.clearPlayerStartTask(task), () => this.clearPlayerStartTask(task))
    return task
  }

  private async startGuidedRenewalInternal(options: StartRemotePlayerOptions & { presentation: PairingPresentationPort },
    generation: number): Promise<RemoteDeviceIdentity> {
    const renewal = new PairingRenewalCoordinator(this.createPairingStore(), this.identities)
    const current = await this.identities.loadPlayerIdentityForRenewal()
    this.assertPlayerIntentCurrent(generation)
    const staged = await renewal.stage(current)
    this.assertPlayerIntentCurrent(generation)
    await this.pairingBootstrap?.close()
    this.pairingBootstrap = undefined
    await this.stopPlayer()
    this.pairingBootstrap = new PairingBootstrapService(staged, this.createPairingStore(), options.presentation,
      undefined, undefined, async () => { await renewal.promoteCommitted() })
    try { return await this.startPlayerInternal(options, staged, generation) }
    catch (error) {
      await this.pairingBootstrap.close().catch(() => undefined)
      this.pairingBootstrap = undefined
      await renewal.discardUncommitted().catch(() => undefined)
      try {
        const oldIdentity = await this.identities.loadOrCreatePlayerIdentity()
        await this.startPlayerInternal(options, oldIdentity, generation)
      } catch { /* the old certificate may be expired; local playback remains independent */ }
      throw error
    }
  }

  private async startPlayerInternal(options: StartRemotePlayerOptions, identityOverride?: RemoteDeviceIdentity,
    intentGeneration?: number): Promise<RemoteDeviceIdentity> {
    if (!identityOverride) {
      await new PairingRenewalCoordinator(this.createPairingStore(), this.identities).recoverBeforeListener()
      if (intentGeneration !== undefined) this.assertPlayerIntentCurrent(intentGeneration)
    }
    const identity = identityOverride ?? await this.identities.loadOrCreatePlayerIdentity()
    if (intentGeneration !== undefined) this.assertPlayerIntentCurrent(intentGeneration)
    this.assertOpen()
    this.pairingBootstrap ??= new PairingBootstrapService(identity, this.createPairingStore(), undefined)
    const messagePort = options.messagePort ?? this.ensurePlayerOperationalEndpoint(identity.deviceId, options.authorization).messagePort
    let server: ReturnType<typeof createRemoteTransportServer>
    server = createRemoteTransportServer({ identity, address: options.interfaceAddress, port: options.port,
      authorization: options.authorization, bootstrap: this.pairingBootstrap,
      messagePort,
      logger: this.options.logger,
      onPeerState: event => {
        const serverIsCurrent = this.server === server
        const intentIsCurrent = intentGeneration === undefined || intentGeneration === this.playerIntentGeneration
        if (!serverIsCurrent || !intentIsCurrent) {
          this.options.logger?.warn('REMOTE_PLAYER_PEER_STATE_IGNORED', {
            state: event.state, serverIsCurrent, intentIsCurrent
          })
          return
        }
        if (event.state === 'authorized') this.remoteUiPlayerConnections.set(event.controllerId,
          toPlayerTransportConnection(event.controllerId, 'authorized'))
        else this.remoteUiPlayerConnections.delete(event.controllerId)
        this.options.logger?.info('REMOTE_PLAYER_PEER_STATE', {
          state: event.state, ...(event.closeCode === undefined ? {} : { closeCode: event.closeCode })
        })
        this.publishRemoteUiChange()
      } })
    this.server = server
    try {
      await server.listen()
      if (intentGeneration !== undefined) this.assertPlayerIntentCurrent(intentGeneration)
      this.assertOpen()
      const actual = server.address()
      if (!actual) throw new Error('REMOTE_LISTENER_ADDRESS_UNAVAILABLE')
      this.playerListenEndpoint = { address: options.interfaceAddress, port: actual.port }
      const advertiser = this.options.createAdvertiser?.() ?? new BonjourPlayerAdvertisementPort(this.options.logger)
      this.advertiser = advertiser
      await advertiser.start({ deviceId: identity.deviceId, displayName: options.displayName,
        address: options.interfaceAddress, port: actual.port })
      if (intentGeneration !== undefined) this.assertPlayerIntentCurrent(intentGeneration)
      this.assertOpen()
      this.publishRemoteUiChange()
      return identity
    } catch (error) {
      await this.stopPlayer()
      throw error
    }
  }

  private clearPlayerStartTask(task: Promise<RemoteDeviceIdentity>): void {
    if (this.playerStartTask !== task) return
    this.playerStartTask = undefined
    this.publishRemoteUiChange()
  }

  async startManagementDiscovery(interfaceAddresses: readonly string[]): Promise<BonjourDiscoveryPort> {
    this.assertOpen()
    if (!['controller', 'combined'].includes(this.options.mode)) throw new Error('REMOTE_CONTROLLER_MODE_REQUIRED')
    const current = this.discovery ?? this.managementReconnectDiscovery
    if (current) {
      this.discovery = current
      this.managementDiscoveryRetainedByUi = true
      this.attachUiDiscovery(current)
      return current
    }
    const discovery = new BonjourDiscoveryPort(this.options.logger)
    this.discovery = discovery
    try { await discovery.start(interfaceAddresses) }
    catch (error) {
      this.discovery = undefined
      this.options.logger?.warn('REMOTE_DISCOVERY_START_FAILED', {
        code: error instanceof Error ? error.message : 'UNKNOWN'
      })
      throw error
    }
    this.attachUiDiscovery(discovery)
    this.managementDiscoveryRetainedByUi = true
    if (this.managementReconnect) {
      this.unsubscribeReconnectDiscovery?.()
      this.unsubscribeReconnectDiscovery = discovery.subscribe(snapshot =>
        this.managementReconnect?.updateDiscovery(snapshot.candidates))
      this.managementReconnect.updateDiscovery(discovery.getSnapshot().candidates)
    }
    return discovery
  }

  /** Persist the local choice before confirming it. Explicit offline fences and closes the Player listener. */
  async setRemoteControlIntent(intent: RemoteControlIntent): Promise<void> {
    this.assertOpen()
    if (this.options.mode === 'player' && intent === 'disabled') throw new Error('REMOTE_PLAYER_INTENT_INVALID')
    if (this.options.mode !== 'player' && intent === 'offline') throw new Error('REMOTE_MANAGEMENT_INTENT_INVALID')
    if (this.options.mode === 'player' && intent === 'offline') {
      const generation = ++this.playerIntentGeneration
      this.pairingAuthorization?.fenceImmediately()
      const revisionRead = this.capturePlayerIntentRevision(generation)
      const stopping = this.stopPlayer()
      try {
        const expectedRevision = await revisionRead
        await this.remoteIntent.set(intent, expectedRevision, () => !this.closed && generation === this.playerIntentGeneration)
        this.assertPlayerIntentCurrent(generation)
      }
      finally {
        await stopping
        this.pairingAuthorization = undefined
      }
      this.assertPlayerIntentCurrent(generation)
      this.publishRemoteUiChange()
      return
    }
    if (this.options.mode === 'player' && intent === 'enabled') {
      const generation = ++this.playerIntentGeneration
      const expectedRevision = await this.capturePlayerIntentRevision(generation)
      await this.stopPlayer()
      this.assertPlayerIntentCurrent(generation)
      await this.remoteIntent.set(intent, expectedRevision, () => !this.closed && generation === this.playerIntentGeneration)
      this.assertPlayerIntentCurrent(generation)
      this.pairingAuthorization = undefined
      this.publishRemoteUiChange()
      return
    }
    if (intent === 'disabled') {
      const generation = ++this.managementReconnectGeneration
      const revisionRead = this.captureManagementIntentRevision(generation)
      const stopping = this.stopManagementReconnection()
      const expectedRevision = await revisionRead
      await this.remoteIntent.set(intent, expectedRevision, () => !this.closed && generation === this.managementReconnectGeneration)
      await stopping
      this.assertOpen()
      if (generation !== this.managementReconnectGeneration) throw new Error('REMOTE_CONTROL_INTENT_TRANSITION_FENCED')
      this.publishRemoteUiChange()
      return
    }
    const generation = ++this.managementReconnectGeneration
    const expectedRevision = await this.captureManagementIntentRevision(generation)
    await this.remoteIntent.set(intent, expectedRevision, () => !this.closed && generation === this.managementReconnectGeneration)
    this.publishRemoteUiChange()
  }

  private async capturePlayerIntentRevision(generation: number): Promise<number | null> {
    const state = await this.remoteIntent.read()
    this.assertPlayerIntentCurrent(generation)
    return state.revision
  }

  private async captureManagementIntentRevision(generation: number): Promise<number | null> {
    const state = await this.remoteIntent.read()
    this.assertOpen()
    if (generation !== this.managementReconnectGeneration) throw new Error('REMOTE_CONTROL_INTENT_TRANSITION_FENCED')
    return state.revision
  }

  /** Reconnects only after a durable local enabled choice. Missing configuration remains disabled. */
  async resumeManagementReconnection(database: ManagementRemoteDatabase,
    interfaceAddresses: readonly string[]): Promise<void> {
    if (this.options.mode === 'player') return
    const intent = await this.remoteIntent.read()
    if (intent.intent !== 'enabled') return
    try { await this.startManagementReconnection(database, interfaceAddresses) }
    catch (error) {
      this.options.logger?.warn('REMOTE_RECONNECTION_START_FAILED', {
        code: error instanceof Error ? error.message : 'UNKNOWN'
      })
    }
  }

  startManagementReconnection(database: ManagementRemoteDatabase,
    interfaceAddresses: readonly string[]): Promise<void> {
    try { this.assertOpen() } catch (error) { return Promise.reject(error) }
    if (!['controller', 'combined'].includes(this.options.mode)) return Promise.reject(new Error('REMOTE_CONTROLLER_MODE_REQUIRED'))
    if (this.managementReconnectStartTask) return this.managementReconnectStartTask
    if (this.managementReconnect) return Promise.reject(new Error('REMOTE_RECONNECTION_ALREADY_STARTED'))
    const generation = this.managementReconnectGeneration
    const startup = this.startManagementReconnectionInternal(database, interfaceAddresses, generation)
    let task: Promise<void>
    task = startup.finally(() => { if (this.managementReconnectStartTask === task) this.managementReconnectStartTask = undefined })
    this.managementReconnectStartTask = task
    return task
  }

  private async startManagementReconnectionInternal(database: ManagementRemoteDatabase,
    interfaceAddresses: readonly string[], generation: number): Promise<void> {
    const intent = await this.remoteIntent.read()
    if (intent.intent !== 'enabled') throw new Error('REMOTE_RECONNECTION_NOT_ENABLED')
    const identity = await this.loadOrCreateControllerIdentity()
    await this.assertManagementReconnectStartCurrent(intent.revision, generation)
    const adapter = await this.ensureManagementReconnectAdapter(database, true)
    if (!adapter) throw new Error('REMOTE_RECONNECTION_ADAPTER_UNAVAILABLE')
    this.managementReconnectAdapter = adapter
    let service!: RemoteReconnectionService
    service = new RemoteReconnectionService(adapter, undefined, status =>
      this.publishManagementReconnectStatus(service, generation, status))
    this.managementReconnect = service
    let discovery: BonjourDiscoveryPort | undefined
    try {
      const peers = await adapter.savedPeers()
      await this.assertManagementReconnectStartCurrent(intent.revision, generation, service)
      await service.start(peers)
      await this.assertManagementReconnectStartCurrent(intent.revision, generation, service)
      discovery = this.discovery ?? new BonjourDiscoveryPort(this.options.logger)
      const startDiscovery = discovery !== this.discovery
      this.managementReconnectDiscovery = discovery
      if (startDiscovery) await discovery.start(interfaceAddresses)
      await this.assertManagementReconnectStartCurrent(intent.revision, generation, service)
      this.unsubscribeReconnectDiscovery = discovery.subscribe(snapshot => service.updateDiscovery(snapshot.candidates))
      service.updateDiscovery(discovery.getSnapshot().candidates)
      if (this.discovery === discovery) this.attachUiDiscovery(discovery)
      this.publishRemoteUiChange()
    } catch (error) {
      if (this.managementReconnect === service) this.managementReconnect = undefined
      if (this.managementReconnectAdapter === adapter) this.managementReconnectAdapter = undefined
      if (this.managementReconnectDiscovery === discovery) this.managementReconnectDiscovery = undefined
      this.unsubscribeReconnectDiscovery?.()
      this.unsubscribeReconnectDiscovery = undefined
      await Promise.allSettled([service.close(), discovery && discovery !== this.discovery ? discovery.stop() : Promise.resolve()])
      throw error
    }
  }

  private async assertManagementReconnectStartCurrent(expectedRevision: number, generation: number,
    service?: RemoteReconnectionService): Promise<void> {
    const current = await this.remoteIntent.read()
    this.assertOpen()
    if (generation !== this.managementReconnectGeneration || current.intent !== 'enabled' ||
        current.revision !== expectedRevision || service && this.managementReconnect !== service) {
      throw new Error('REMOTE_RECONNECTION_START_FENCED')
    }
  }

  private assertPlayerIntentCurrent(generation: number): void {
    this.assertOpen()
    if (generation !== this.playerIntentGeneration) throw new Error('REMOTE_PLAYER_START_FENCED')
  }

  private publishManagementReconnectStatus(service: RemoteReconnectionService, generation: number,
    status: RemotePeerStatus): void {
    const generationIsCurrent = generation === this.managementReconnectGeneration
    const serviceIsCurrent = this.managementReconnect === service
    if (this.closed || !generationIsCurrent || !serviceIsCurrent) {
      this.options.logger?.warn('REMOTE_RECONNECTION_STATE_IGNORED', {
        state: status.state, generationIsCurrent, serviceIsCurrent, runtimeIsOpen: !this.closed
      })
      return
    }
    this.remoteUiConnections.set(status.playerId, status)
    this.publishRemoteUiChange()
    this.options.logger?.info('REMOTE_RECONNECTION_STATE', {
      playerId: status.playerId, state: status.state, reason: status.reason,
      connectionId: status.connectionId, synchronized: status.synchronized, retryAt: status.retryAt,
      ...(status.closeCode === undefined ? {} : { closeCode: status.closeCode })
    })
  }

  private async stopManagementReconnection(): Promise<void> {
    const startup = this.managementReconnectStartTask
    this.unsubscribeReconnectDiscovery?.()
    this.unsubscribeReconnectDiscovery = undefined
    const service = this.managementReconnect
    this.managementReconnect = undefined
    const discovery = this.managementReconnectDiscovery
    this.managementReconnectDiscovery = undefined
    const keepDiscovery = Boolean(discovery && (discovery === this.discovery || this.managementDiscoveryRetainedByUi))
    if (keepDiscovery && discovery) this.discovery = discovery
    const results = await Promise.allSettled([service?.close() ?? Promise.resolve(),
      discovery && !keepDiscovery ? discovery.stop() : Promise.resolve()])
    if (!this.closed && service) {
      for (const playerId of this.remoteUiConnections.keys()) {
        const finalStatus = service.status(playerId)
        if (finalStatus) this.remoteUiConnections.set(playerId, finalStatus)
      }
    }
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    await startup?.catch(() => undefined)
    if (!this.closed) this.publishRemoteUiChange()
  }

  createPairingController(presentation: PairingManagementPresentationPort): PairingControllerClient {
    this.assertOpen()
    if (!['controller', 'combined'].includes(this.options.mode)) throw new Error('REMOTE_CONTROLLER_MODE_REQUIRED')
    if (this.pairingController) throw new Error('PAIRING_CONTROLLER_ALREADY_CONFIGURED')
    this.pairingController = new PairingControllerClient(
      () => this.identities.loadOrCreateControllerIdentity(), this.createPairingStore(), presentation)
    return this.pairingController
  }

  async revokePlayerPairingLocally(): Promise<void> {
    this.assertOpen()
    if (this.options.mode !== 'player') throw new Error('REMOTE_PLAYER_MODE_REQUIRED')
    const authority = (await this.createPairingStore().read()).playerAuthority
    if (!authority || authority.phase !== 'active') throw new Error('PAIRING_NOT_ACTIVE')
    await this.createPlayerPairingAuthorization().revokeLocally()
    this.server?.closeController(authority.controllerId)
    this.remoteUiPlayerConnections.delete(authority.controllerId)
    this.publishRemoteUiChange()
  }

  async revokeManagementPeerLocally(playerId: string): Promise<void> {
    this.assertOpen()
    if (this.options.mode === 'player') throw new Error('REMOTE_CONTROLLER_MODE_REQUIRED')
    const state = await this.createPairingStore().read()
    const authority = state.controllerAuthorities[playerId]
    if (!authority || authority.phase !== 'active') throw new Error('PAIRING_NOT_ACTIVE')
    if (state.journals.some(item => item.role === 'controller' && item.context.playerId === playerId &&
        ['bound', 'prepared', 'committed', 'uncertain'].includes(item.phase))) throw new Error('PAIRING_RESULT_UNCERTAIN')
    await this.createPairingStore().transact(candidate => {
      const current = candidate.controllerAuthorities[playerId]
      if (!current || current.phase !== 'active' ||
          candidate.journals.some(item => item.role === 'controller' && item.context.playerId === playerId &&
            ['bound', 'prepared', 'committed', 'uncertain'].includes(item.phase))) throw new Error('PAIRING_REVISION_CONFLICT')
      current.phase = 'revoked'
      current.authorityRevision++
      candidate.authorityRevision++
      for (const journal of candidate.journals) {
        if (journal.role === 'controller' && journal.pairingId === current.pairingId && journal.phase === 'active') journal.phase = 'revoked'
      }
    }, state.storeRevision)
    try { await this.managementReconnect?.removePeer(playerId) }
    catch {
      this.publishRemoteUiChange()
      throw new Error('LOCAL_REVOCATION_CONFIRMED_CHANNEL_CLOSE_FAILED')
    }
    this.remoteUiConnections.delete(playerId)
    this.publishRemoteUiChange()
  }

  private async stopPlayer(): Promise<void> {
    const advertiser = this.advertiser
    const server = this.server
    this.advertiser = undefined
    this.server = undefined
    this.playerListenEndpoint = undefined
    this.remoteUiPlayerConnections.clear()
    const results = await Promise.allSettled([
      advertiser?.stop() ?? Promise.resolve(),
      server?.close() ?? Promise.resolve()
    ])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    if (!this.closed) this.publishRemoteUiChange()
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.closed = true
    ++this.playerIntentGeneration
    this.managementReconnectGeneration++
    this.closeTask = (async () => {
      await this.stopManagementReconnection()
      await this.pairingController?.close()
      this.pairingController = undefined
      this.pairingAuthorization?.fenceImmediately()
      await this.pairingBootstrap?.close()
      this.pairingBootstrap = undefined
      const discovery = this.discovery
      this.discovery = undefined
      const playerStart = this.playerStartTask
      const stopPlayerAfterStart = (async () => {
        await playerStart?.catch(() => undefined)
        await this.stopPlayer()
      })()
      const results = await Promise.allSettled([stopPlayerAfterStart, discovery?.stop() ?? Promise.resolve()])
      this.unsubscribeUiDiscovery?.()
      this.unsubscribeUiDiscovery = undefined
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      if (this.playerOperationalEndpoint) {
        const drained = await this.playerOperationalEndpoint.close()
        if (drained.state === 'blocked') throw new Error('REMOTE_OPERATIONAL_SERVICE_DRAIN_BLOCKED')
        this.playerOperationalEndpoint = undefined
      }
      this.remoteUiListeners.clear()
    })()
    return this.closeTask
  }

  private ensurePlayerOperationalEndpoint(deviceId: string, authorization: RemoteAuthorizationPort): MainPlayerOperationalEndpoint {
    if (this.options.mode !== 'player') throw new Error('REMOTE_PLAYER_MODE_REQUIRED')
    if (this.playerOperationalEndpoint) return this.playerOperationalEndpoint
    const endpoint = createMainPlayerOperationalEndpoint({
      userDataDirectory: this.options.userDataDirectory,
      deviceId,
      authorization,
      observe: this.options.getPlayerOperationalObservation ?? (() => ({
        playbackStatus: 'uncertain', libraryRevision: 'library-unavailable'
      }))
    })
    this.playerOperationalEndpoint = endpoint
    return endpoint
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('REMOTE_RUNTIME_CLOSED')
  }
}
