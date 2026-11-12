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
  private closed = false
  private readonly identities: RemoteIdentityStore
  private readonly secretProtector: ElectronSafeStorageSecretProtector
  private pairingStore: PairingStore | undefined
  private pairingAuthorization: PairingAuthorizationAdapter | undefined
  private pairingBootstrap: PairingBootstrapService | undefined
  private pairingController: PairingControllerClient | undefined

  constructor(private readonly options: MainRemoteRuntimeOptions) {
    this.secretProtector = new ElectronSafeStorageSecretProtector(options.safeStorage ?? require('electron').safeStorage as typeof safeStorage)
    this.identities = new RemoteIdentityStore(options.userDataDirectory, this.secretProtector)
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
    const identity = await this.identities.loadOrCreatePlayerIdentity()
    this.assertOpen()
    this.pairingBootstrap = new PairingBootstrapService(identity, this.createPairingStore(), presentation)
  }

  startPlayer(options: StartRemotePlayerOptions): Promise<RemoteDeviceIdentity> {
    this.assertOpen()
    if (this.options.mode !== 'player') throw new Error('REMOTE_PLAYER_MODE_REQUIRED')
    if (!options.authorization) throw new Error('REMOTE_AUTHORIZATION_UNAVAILABLE')
    if (options.bootstrap && options.bootstrap !== this.pairingBootstrap) throw new Error('PAIRING_BOOTSTRAP_UNAPPROVED')
    if (this.playerStartTask || this.server || this.advertiser) throw new Error('REMOTE_PLAYER_ALREADY_STARTED')
    const task = this.startPlayerInternal(options)
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
    const task = this.startGuidedRenewalInternal(options)
    this.playerStartTask = task
    void task.then(() => this.clearPlayerStartTask(task), () => this.clearPlayerStartTask(task))
    return task
  }

  private async startGuidedRenewalInternal(options: StartRemotePlayerOptions & { presentation: PairingPresentationPort }): Promise<RemoteDeviceIdentity> {
    const renewal = new PairingRenewalCoordinator(this.createPairingStore(), this.identities)
    const current = await this.identities.loadPlayerIdentityForRenewal()
    const staged = await renewal.stage(current)
    await this.pairingBootstrap?.close()
    this.pairingBootstrap = undefined
    await this.stopPlayer()
    this.pairingBootstrap = new PairingBootstrapService(staged, this.createPairingStore(), options.presentation,
      undefined, undefined, async () => { await renewal.promoteCommitted() })
    try { return await this.startPlayerInternal(options, staged) }
    catch (error) {
      await this.pairingBootstrap.close().catch(() => undefined)
      this.pairingBootstrap = undefined
      await renewal.discardUncommitted().catch(() => undefined)
      try {
        const oldIdentity = await this.identities.loadOrCreatePlayerIdentity()
        await this.startPlayerInternal(options, oldIdentity)
      } catch { /* the old certificate may be expired; local playback remains independent */ }
      throw error
    }
  }

  private async startPlayerInternal(options: StartRemotePlayerOptions, identityOverride?: RemoteDeviceIdentity): Promise<RemoteDeviceIdentity> {
    if (!identityOverride) await new PairingRenewalCoordinator(this.createPairingStore(), this.identities).recoverBeforeListener()
    const identity = identityOverride ?? await this.identities.loadOrCreatePlayerIdentity()
    this.assertOpen()
    this.pairingBootstrap ??= new PairingBootstrapService(identity, this.createPairingStore(), undefined)
    const server = createRemoteTransportServer({ identity, address: options.interfaceAddress, port: options.port,
      authorization: options.authorization, bootstrap: this.pairingBootstrap,
      messagePort: options.messagePort,
      logger: this.options.logger })
    this.server = server
    try {
      await server.listen()
      this.assertOpen()
      const actual = server.address()
      if (!actual) throw new Error('REMOTE_LISTENER_ADDRESS_UNAVAILABLE')
      const advertiser = this.options.createAdvertiser?.() ?? new BonjourPlayerAdvertisementPort(this.options.logger)
      this.advertiser = advertiser
      await advertiser.start({ deviceId: identity.deviceId, displayName: options.displayName,
        address: options.interfaceAddress, port: actual.port })
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
    this.closeTask = (async () => {
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
