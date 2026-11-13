import type { safeStorage } from 'electron'
import type { OperatingMode } from './operating-mode'
import { BonjourDiscoveryPort, BonjourPlayerAdvertisementPort } from './remote-discovery'
import type { PlayerAdvertisementPort } from './remote-contracts'
import type { RemoteAuthorizationPort, RemoteBootstrapPort, RemoteDeviceIdentity,
  RemoteTransportLogger, RemoteTransportMessagePort } from './remote-contracts'
import { RemoteIdentityStore } from './remote-identity-store'
import { ElectronSafeStorageSecretProtector, type SafeStoragePort } from './remote-secret-protector'
import { createRemoteTransportServer } from './remote-transport'
import { PairingStore } from './pairing-store'
import { PairingAuthorizationAdapter } from './pairing-authorization'
import { PairingBootstrapService, type PairingPresentationPort } from './pairing-bootstrap'
import { PairingControllerClient, type PairingManagementPresentationPort } from './pairing-controller'
import { PairingRenewalCoordinator } from './pairing-renewal'
import { MainRemoteReconnectionAdapter, type ManagementRemoteDatabase } from './main-remote-reconnection'
import { RemoteReconnectionService } from './remote-reconnection-service'
import { RemoteControlIntentStore, type RemoteControlIntent } from './remote-control-intent'

export interface MainRemoteRuntimeOptions {
  mode: OperatingMode
  userDataDirectory: string
  safeStorage?: SafeStoragePort
  logger?: RemoteTransportLogger
  createAdvertiser?: () => PlayerAdvertisementPort
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
  private pairingBootstrap: PairingBootstrapService | undefined
  private pairingController: PairingControllerClient | undefined
  private managementReconnect: RemoteReconnectionService | undefined
  private managementReconnectStartTask: Promise<void> | undefined
  private managementReconnectGeneration = 0
  private managementReconnectDiscovery: BonjourDiscoveryPort | undefined
  private unsubscribeReconnectDiscovery: (() => void) | undefined
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
    const server = createRemoteTransportServer({ identity, address: options.interfaceAddress, port: options.port,
      authorization: options.authorization, bootstrap: this.pairingBootstrap,
      messagePort: options.messagePort,
      logger: this.options.logger })
    this.server = server
    try {
      await server.listen()
      if (intentGeneration !== undefined) this.assertPlayerIntentCurrent(intentGeneration)
      this.assertOpen()
      const actual = server.address()
      if (!actual) throw new Error('REMOTE_LISTENER_ADDRESS_UNAVAILABLE')
      const advertiser = this.options.createAdvertiser?.() ?? new BonjourPlayerAdvertisementPort(this.options.logger)
      this.advertiser = advertiser
      await advertiser.start({ deviceId: identity.deviceId, displayName: options.displayName,
        address: options.interfaceAddress, port: actual.port })
      if (intentGeneration !== undefined) this.assertPlayerIntentCurrent(intentGeneration)
      this.assertOpen()
      return identity
    } catch (error) {
      await this.stopPlayer()
      throw error
    }
  }

  private clearPlayerStartTask(task: Promise<RemoteDeviceIdentity>): void {
    if (this.playerStartTask === task) this.playerStartTask = undefined
  }

  async startManagementDiscovery(interfaceAddresses: readonly string[]): Promise<BonjourDiscoveryPort> {
    this.assertOpen()
    if (!['controller', 'combined'].includes(this.options.mode)) throw new Error('REMOTE_CONTROLLER_MODE_REQUIRED')
    if (this.discovery) throw new Error('REMOTE_DISCOVERY_ALREADY_STARTED')
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
      return
    }
    const generation = ++this.managementReconnectGeneration
    const expectedRevision = await this.captureManagementIntentRevision(generation)
    await this.remoteIntent.set(intent, expectedRevision, () => !this.closed && generation === this.managementReconnectGeneration)
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
    const adapter = new MainRemoteReconnectionAdapter(this.createPairingStore(), identity.deviceId, database)
    const service = new RemoteReconnectionService(adapter, undefined, status => {
      this.options.logger?.info('REMOTE_RECONNECTION_STATE', {
        playerId: status.playerId, state: status.state, reason: status.reason,
        connectionId: status.connectionId, synchronized: status.synchronized, retryAt: status.retryAt
      })
    })
    this.managementReconnect = service
    let discovery: BonjourDiscoveryPort | undefined
    try {
      const peers = await adapter.savedPeers()
      await this.assertManagementReconnectStartCurrent(intent.revision, generation, service)
      await service.start(peers)
      await this.assertManagementReconnectStartCurrent(intent.revision, generation, service)
      discovery = new BonjourDiscoveryPort(this.options.logger)
      this.managementReconnectDiscovery = discovery
      await discovery.start(interfaceAddresses)
      await this.assertManagementReconnectStartCurrent(intent.revision, generation, service)
      this.unsubscribeReconnectDiscovery = discovery.subscribe(snapshot => service.updateDiscovery(snapshot.candidates))
      service.updateDiscovery(discovery.getSnapshot().candidates)
    } catch (error) {
      if (this.managementReconnect === service) this.managementReconnect = undefined
      if (this.managementReconnectDiscovery === discovery) this.managementReconnectDiscovery = undefined
      this.unsubscribeReconnectDiscovery?.()
      this.unsubscribeReconnectDiscovery = undefined
      await Promise.allSettled([service.close(), discovery?.stop() ?? Promise.resolve()])
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

  private async stopManagementReconnection(): Promise<void> {
    const startup = this.managementReconnectStartTask
    this.unsubscribeReconnectDiscovery?.()
    this.unsubscribeReconnectDiscovery = undefined
    const service = this.managementReconnect
    this.managementReconnect = undefined
    const discovery = this.managementReconnectDiscovery
    this.managementReconnectDiscovery = undefined
    const results = await Promise.allSettled([service?.close() ?? Promise.resolve(), discovery?.stop() ?? Promise.resolve()])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    await startup?.catch(() => undefined)
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
    await this.createPlayerPairingAuthorization().revokeLocally()
  }

  private async stopPlayer(): Promise<void> {
    const advertiser = this.advertiser
    const server = this.server
    this.advertiser = undefined
    this.server = undefined
    const results = await Promise.allSettled([
      advertiser?.stop() ?? Promise.resolve(),
      server?.close() ?? Promise.resolve()
    ])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
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
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return this.closeTask
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('REMOTE_RUNTIME_CLOSED')
  }
}
