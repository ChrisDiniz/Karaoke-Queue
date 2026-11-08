import type { Protocol } from 'electron'
import type { FileLogger } from './logging'
import type { OperatingMode } from './operating-mode'
import { MusicCatalogService } from './music-catalog-service'
import type { MusicCatalogRepository } from './music-catalog'
import { ManualPlaybackService } from './manual-playback-service'
import { PlayerMediaProtocol } from './player-media-protocol'
import { PlayerPlaybackService } from './player-playback-service'
import { PlayerPlaybackRecoveryCoordinator } from './player-playback-recovery'
import { PlayerPlaybackRecoveryStore } from './player-playback-recovery-store'
import { StandalonePlayerSequence } from './standalone-player-sequence'
import type { VideoLibraryService } from './video-library-service'
import { VideoLibraryService as DefaultVideoLibraryService } from './video-library-service'
import { readVideoLibraryConfiguration } from './video-library-configuration'

export interface MainMediaRuntimeOptions {
  operatingMode: OperatingMode
  userDataDirectory: string
  protocol: Protocol
  logger: Pick<FileLogger, 'info' | 'warn' | 'error'>
  isShutdownStarted(): boolean
}

export interface MainMediaRuntimeServices {
  library?: VideoLibraryService
  mediaProtocol?: PlayerMediaProtocol
  recovery?: PlayerPlaybackRecoveryCoordinator
  playback?: PlayerPlaybackService
  manual?: ManualPlaybackService
  catalog?: MusicCatalogService
  sequence?: StandalonePlayerSequence
}

/** Owns construction of the single playback/recovery/library/catalog runtime selected by Main. */
export class MainMediaRuntime {
  private readonly services: MainMediaRuntimeServices = {}
  private playerInfrastructureStarted = false

  constructor(private readonly options: MainMediaRuntimeOptions) {}

  get library(): VideoLibraryService | undefined { return this.services.library }
  get mediaProtocol(): PlayerMediaProtocol | undefined { return this.services.mediaProtocol }
  get recovery(): PlayerPlaybackRecoveryCoordinator | undefined { return this.services.recovery }
  get playback(): PlayerPlaybackService | undefined { return this.services.playback }
  get manual(): ManualPlaybackService | undefined { return this.services.manual }
  get catalog(): MusicCatalogService | undefined { return this.services.catalog }
  get sequence(): StandalonePlayerSequence | undefined { return this.services.sequence }

  async initializePlayerInfrastructure(): Promise<ReturnType<VideoLibraryService['getSnapshot']> | undefined> {
    if (this.playerInfrastructureStarted) throw new Error('MAIN_MEDIA_RUNTIME_ALREADY_STARTED')
    this.playerInfrastructureStarted = true
    if (this.options.operatingMode !== 'player' && this.options.operatingMode !== 'combined') return undefined

    this.services.recovery = new PlayerPlaybackRecoveryCoordinator(
      new PlayerPlaybackRecoveryStore(this.options.userDataDirectory)
    )
    if (this.options.operatingMode !== 'player') {
      const recoveryState = this.services.recovery.initialize()
      this.logRecoveryState(recoveryState)
    }

    const libraryConfiguration = readVideoLibraryConfiguration(this.options.userDataDirectory)
    this.services.library = new DefaultVideoLibraryService(libraryConfiguration.roots)
    const inventory = await this.services.library.refresh()
    if (this.options.isShutdownStarted()) return undefined

    this.logLibraryScan(inventory)
    this.services.mediaProtocol = new PlayerMediaProtocol(this.services.library)
    this.services.mediaProtocol.install(this.options.protocol)
    if (this.options.operatingMode !== 'player') {
      this.services.playback = new PlayerPlaybackService(this.services.library, this.services.mediaProtocol, this.services.recovery)
      this.services.manual = new ManualPlaybackService(this.services.playback, { autoAdvanceOnNaturalEnd: false })
      this.services.recovery.attach(this.services.playback, this.services.manual)
    }
    return inventory
  }

  createCatalog(database: MusicCatalogRepository): MusicCatalogService {
    if (this.services.catalog) throw new Error('MAIN_MEDIA_CATALOG_ALREADY_CREATED')
    this.services.catalog = new MusicCatalogService(database, this.services.library)
    const metadata = this.services.catalog.getMetadata()
    this.options.logger.info('catalog', this.options.operatingMode === 'player' ? 'PLAYER_MUSIC_CATALOG_READY' : 'MUSIC_CATALOG_READY',
      this.options.operatingMode === 'player'
        ? 'O catálogo isolado do Reprodutor foi inicializado.'
        : 'O serviço local de catálogo foi inicializado.', {
        revision: metadata.revision,
        recordCount: metadata.recordCount
      })
    return this.services.catalog
  }

  async createStandaloneSequence(disposeOptions: () => void): Promise<StandalonePlayerSequence> {
    if (this.options.operatingMode !== 'player' || !this.services.library || !this.services.mediaProtocol ||
        !this.services.recovery || !this.services.catalog) throw new Error('STANDALONE_STARTUP_DEPENDENCY_UNAVAILABLE')
    if (this.services.sequence) throw new Error('STANDALONE_SEQUENCE_ALREADY_CREATED')
    const sequence = await StandalonePlayerSequence.create({
      createPlayback: persistence => {
        if (this.services.playback) throw new Error('PLAYER_PLAYBACK_ALREADY_CREATED')
        this.services.playback = new PlayerPlaybackService(this.services.library!, this.services.mediaProtocol!, persistence)
        return this.services.playback
      },
      recovery: this.services.recovery,
      catalog: this.services.catalog,
      disposeResources: async () => {
        disposeOptions()
        await this.services.catalog?.close()
        this.services.library?.close()
      },
      onCoordinationError: error => this.options.logger.error('player', 'STANDALONE_COORDINATION_FAILED',
        'A coordenação da sequência Standalone encontrou uma falha.', error)
    })
    this.services.sequence = sequence
    return sequence
  }

  async disposeAfterFailedStartup(disposeOptions: () => void): Promise<void> {
    const sequence = this.services.sequence
    if (sequence) {
      await sequence.dispose()
      return
    }
    this.services.manual?.dispose()
    await this.services.playback?.dispose()
    this.services.recovery?.dispose()
    disposeOptions()
    await this.services.catalog?.close()
    this.services.library?.close()
  }

  private logRecoveryState(state: ReturnType<PlayerPlaybackRecoveryCoordinator['initialize']>): void {
    if (state.status === 'pending') {
      this.options.logger.warn('player', 'PLAYER_RECOVERY_PENDING', 'Uma reprodução anterior não tem término confirmado; nenhuma mídia será iniciada automaticamente.', {
        attemptId: state.attemptId, musicCode: state.musicCode, lastTransition: state.lastTransition
      })
    } else if (state.status === 'unreadable' || state.status === 'unavailable') {
      this.options.logger.error('player', 'PLAYER_RECOVERY_UNAVAILABLE', 'O Player bloqueará novos comandos de mídia porque o estado de recuperação não pôde ser validado.', {
        reason: state.reason
      })
    }
  }

  private logLibraryScan(inventory: ReturnType<VideoLibraryService['getSnapshot']>): void {
    const scanDetails = {
      revision: inventory.revision,
      scanStatus: inventory.scanStatus,
      configuredRootCount: inventory.configuredRootCount,
      scannedRootCount: inventory.scannedRootCount,
      unavailableRootCount: inventory.unavailableRootCount,
      availableCodes: inventory.counts.availableCodes,
      ambiguousCodes: inventory.counts.ambiguousCodes,
      missingCodes: inventory.counts.missingCodes,
      unreadableCodes: inventory.counts.unreadableCodes,
      unknownCodes: inventory.counts.unknownCodes
    }
    if (inventory.scanStatus === 'degraded') {
      this.options.logger.warn('player', 'VIDEO_LIBRARY_SCAN_DEGRADED', 'A biblioteca foi mantida em estado parcial; diretórios inacessíveis não foram tratados como vazios.', undefined, scanDetails)
    } else {
      this.options.logger.info('player', 'VIDEO_LIBRARY_SCAN_COMPLETED', 'A indexação local da biblioteca foi concluída.', scanDetails)
    }
  }
}
