import type { safeStorage } from 'electron'
import type { OperatingMode } from './operating-mode'
import { BonjourDiscoveryPort, BonjourPlayerAdvertisementPort } from './remote-discovery'
import type { PlayerAdvertisementPort } from './remote-contracts'
import type { RemoteAuthorizationPort, RemoteBootstrapPort, RemoteDeviceIdentity,
  RemoteTransportLogger, RemoteTransportMessagePort } from './remote-contracts'
import { RemoteIdentityStore } from './remote-identity-store'
import { ElectronSafeStorageSecretProtector, type SafeStoragePort } from './remote-secret-protector'
import { createRemoteTransportServer } from './remote-transport'

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

  constructor(private readonly options: MainRemoteRuntimeOptions) {
    this.identities = new RemoteIdentityStore(options.userDataDirectory,
      new ElectronSafeStorageSecretProtector(options.safeStorage ?? require('electron').safeStorage as typeof safeStorage))
  }

  startPlayer(options: StartRemotePlayerOptions): Promise<RemoteDeviceIdentity> {
    this.assertOpen()
    if (this.options.mode !== 'player') throw new Error('REMOTE_PLAYER_MODE_REQUIRED')
    if (!options.authorization) throw new Error('REMOTE_AUTHORIZATION_UNAVAILABLE')
    if (this.playerStartTask || this.server || this.advertiser) throw new Error('REMOTE_PLAYER_ALREADY_STARTED')
    const task = this.startPlayerInternal(options)
    this.playerStartTask = task
    void task.then(() => this.clearPlayerStartTask(task), () => this.clearPlayerStartTask(task))
    return task
  }

  private async startPlayerInternal(options: StartRemotePlayerOptions): Promise<RemoteDeviceIdentity> {
    const identity = await this.identities.loadOrCreatePlayerIdentity()
    this.assertOpen()
    const server = createRemoteTransportServer({ identity, address: options.interfaceAddress, port: options.port,
      authorization: options.authorization, bootstrap: options.bootstrap, messagePort: options.messagePort,
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
