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
import { readVideoLibraryConfiguration, VideoLibraryConfigurationError } from './video-library-configuration'
import { f0DiagnosticMetrics } from './f0-diagnostics'
import { VideoLibraryIndexStore } from './video-library-index-store'
import { performance } from 'node:perf_hooks'

export interface MainMediaRuntimeOptions {
  operatingMode: OperatingMode
  userDataDirectory: string
  protocol: Protocol
  logger: Pick<FileLogger, 'info' | 'warn' | 'error'>
  isShutdownStarted(): boolean
  onLibraryChanged?(): void
  isWindowActive?(): boolean
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
  private reconciliationAdmitted = false
  private disposed = false
  private unsubscribePlaybackActivity: (() => void) | undefined
  private unsubscribeLibraryChanges: (() => void) | undefined
  private backgroundScan: Promise<void> | undefined
  private availabilityTimer: NodeJS.Timeout | undefined
  private lastAvailabilityProbeAt = 0

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

    let libraryRoots: string[]
    try {
      libraryRoots = readVideoLibraryConfiguration(this.options.userDataDirectory).roots
    } catch (error) {
      if (this.options.operatingMode !== 'combined' || !(error instanceof VideoLibraryConfigurationError)) throw error
      libraryRoots = []
      this.options.logger.error('player', 'VIDEO_LIBRARY_CONFIGURATION_INVALID',
        'A biblioteca de vídeos foi desativada porque sua configuração não pôde ser validada; a Gestão continuará disponível e o arquivo foi preservado.', error)
    }
    const indexStore = this.options.operatingMode === 'player'
      ? new VideoLibraryIndexStore(this.options.userDataDirectory)
      : undefined
    this.services.library = new DefaultVideoLibraryService(libraryRoots, {
      collectScanMetrics: this.options.operatingMode === 'player' && process.env.KQ_F0_DIAGNOSTICS === '1',
      ...(indexStore ? { indexStore } : {}),
      onIndexWriteError: error => this.options.logger.warn('player', 'VIDEO_LIBRARY_INDEX_WRITE_FAILED',
        'O inventário descartável não foi atualizado; a biblioteca em memória permanece disponível.', error)
    })
    this.unsubscribeLibraryChanges = this.services.library.subscribe(() => {
      this.options.onLibraryChanged?.()
      const availability = this.services.library?.getAvailabilitySummary()
      if (availability) void this.services.sequence?.notifyLibraryAvailability(availability.unavailableRoots === 0 &&
        availability.permissionDeniedRoots === 0 && availability.volumeMismatchRoots === 0).catch(error =>
        this.options.logger.warn('player', 'STORAGE_RECOVERY_UPDATE_FAILED', 'Não foi possível atualizar a recuperação de armazenamento.', error))
    })
    let inventory: ReturnType<VideoLibraryService['getSnapshot']>
    if (this.options.operatingMode === 'player') {
      const indexReadStartedAt = performance.now()
      const restored = await this.services.library.restorePersistentIndex()
      const indexReadDurationMs = Math.max(0, performance.now() - indexReadStartedAt)
      inventory = this.services.library.getSnapshot()
      this.options.logger.info('player', 'VIDEO_LIBRARY_INDEX_RESTORE',
        'O inventário persistente descartável foi consultado sem acessar os arquivos de mídia.', { result: restored })
      const indexMetrics = f0DiagnosticMetrics({ phase: 'library-index-load', cacheStatus: restored,
        durationMs: indexReadDurationMs, indexedFiles: inventory.counts.indexedFiles })
      if (indexMetrics) this.options.logger.info('player', 'F0_LIBRARY_INDEX_LOAD_METRICS',
        'Métricas agregadas da leitura do índice descartável; nenhum caminho ou código foi registrado.', indexMetrics)
    } else {
      inventory = await this.services.library.refresh()
      this.logLibraryScan(inventory)
    }
    if (this.options.isShutdownStarted()) return undefined
    this.services.mediaProtocol = new PlayerMediaProtocol(this.services.library)
    this.services.mediaProtocol.install(this.options.protocol)
    if (this.options.operatingMode !== 'player') {
      this.services.playback = new PlayerPlaybackService(this.services.library, this.services.mediaProtocol, this.services.recovery)
      this.services.manual = new ManualPlaybackService(this.services.playback, { autoAdvanceOnNaturalEnd: false })
      this.services.recovery.attach(this.services.playback, this.services.manual)
      this.observePlaybackActivity(this.services.playback)
    }

    return inventory
  }


  /** Main calls this only after the document, IPC, host and startup recovery are operational. */
  admitStandaloneReconciliation(): boolean {
    if (this.disposed || this.options.isShutdownStarted() || this.options.operatingMode !== 'player' ||
        !this.services.library || this.services.sequence?.getSnapshot().playbackCondition !== 'ready') return false
    if (this.reconciliationAdmitted) return true
    this.reconciliationAdmitted = true
    const admitted = f0DiagnosticMetrics({ phase: 'library-reconciliation-admitted' })
    if (admitted) this.options.logger.info('player', 'F0_LIBRARY_RECONCILIATION_ADMITTED',
      'Reconciliação admitida após o gate operacional Standalone.', admitted)
    this.backgroundScan = Promise.resolve().then(async () => {
      if (this.disposed || this.options.isShutdownStarted()) return
      const completed = await this.services.library!.refresh()
      if (this.disposed || this.options.isShutdownStarted()) return
      this.logLibraryScan(completed)
      const scanMetrics = f0DiagnosticMetrics({
        phase: 'library-scan',
        indexedFiles: completed.counts.indexedFiles, availableCodes: completed.counts.availableCodes,
        ...this.services.library!.getScanDiagnosticSnapshot()
      })
      if (scanMetrics) this.options.logger.info('player', 'F0_LIBRARY_SCAN_METRICS',
        'Métricas agregadas da varredura F0; nenhum caminho ou código de música foi registrado.', scanMetrics)
    }).catch(error => {
      this.options.logger.error('player', 'VIDEO_LIBRARY_BACKGROUND_SCAN_FAILED',
        'A reconciliação da biblioteca em segundo plano falhou; o último inventário completo foi preservado.', error)
    })
    this.startAvailabilityMonitor()
    return true
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
      deferStartupRecovery: true,
      createPlayback: persistence => {
        if (this.services.playback) throw new Error('PLAYER_PLAYBACK_ALREADY_CREATED')
        this.services.playback = new PlayerPlaybackService(this.services.library!, this.services.mediaProtocol!, persistence)
        return this.services.playback
      },
      recovery: this.services.recovery,
      catalog: this.services.catalog,
      disposeResources: async () => {
        this.disposed = true
        this.stopAvailabilityMonitor()
        this.unsubscribePlaybackActivity?.()
        this.unsubscribePlaybackActivity = undefined
        this.unsubscribeLibraryChanges?.()
        this.unsubscribeLibraryChanges = undefined
        disposeOptions()
        await this.services.catalog?.close()
        this.services.library?.close()
      },
      onCoordinationError: error => this.options.logger.error('player', 'STANDALONE_COORDINATION_FAILED',
        'A coordenação da sequência Standalone encontrou uma falha.', error)
    })
    this.services.playback?.enableStorageMonitoring()
    this.services.sequence = sequence
    if (this.services.playback) this.observePlaybackActivity(this.services.playback)
    return sequence
  }

  async disposeAfterFailedStartup(disposeOptions: () => void): Promise<void> {
    this.disposed = true
    this.unsubscribePlaybackActivity?.()
    this.unsubscribePlaybackActivity = undefined
    this.unsubscribeLibraryChanges?.()
    this.unsubscribeLibraryChanges = undefined
    this.stopAvailabilityMonitor()
    this.services.library?.close()
    await this.backgroundScan?.catch(() => undefined)
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

  private observePlaybackActivity(playback: PlayerPlaybackService): void {
    this.unsubscribePlaybackActivity?.()
    const update = (status = playback.getState().status): void => {
      this.services.library?.setPlaybackActive(!['idle', 'completed'].includes(status) && !(status === 'stopped' && !playback.getState().attemptId))
    }
    update()
    this.unsubscribePlaybackActivity = playback.subscribe(event => {
      if (event.type === 'state-changed') {
        update(event.state.status)
        if (this.services.sequence?.getSnapshot().storageRecovery) {
          const availability = this.services.library?.getAvailabilitySummary()
          if (availability) void this.services.sequence.notifyLibraryAvailability(availability.unavailableRoots === 0 &&
            availability.permissionDeniedRoots === 0 && availability.volumeMismatchRoots === 0).catch(() => undefined)
        }
      }
      if (event.type === 'error') void this.probeLibraryAvailability()
    })
  }

  probeLibraryAvailability(): Promise<ReturnType<VideoLibraryService['getSnapshot']> | undefined> {
    if (this.disposed || !this.reconciliationAdmitted || this.options.operatingMode !== 'player' || !this.services.library || this.options.isShutdownStarted()) {
      return Promise.resolve(undefined)
    }
    return this.services.library.probeAvailability().catch(error => {
      this.options.logger.warn('player', 'VIDEO_LIBRARY_AVAILABILITY_PROBE_FAILED',
        'A sonda da raiz da biblioteca falhou; o último estado confirmado foi preservado.', error)
      return this.services.library?.getSnapshot()
    })
  }

  private startAvailabilityMonitor(): void {
    if (this.availabilityTimer || this.options.operatingMode !== 'player') return
    this.availabilityTimer = setInterval(() => {
      if (this.options.isShutdownStarted()) return
      const active = this.options.isWindowActive?.() ?? true
      const minimumIntervalMs = active ? 5_000 : 30_000
      const now = Date.now()
      if (now - this.lastAvailabilityProbeAt < minimumIntervalMs) return
      this.lastAvailabilityProbeAt = now
      void this.probeLibraryAvailability()
    }, 5_000)
    this.availabilityTimer.unref()
  }

  private stopAvailabilityMonitor(): void {
    if (this.availabilityTimer) clearInterval(this.availabilityTimer)
    this.availabilityTimer = undefined
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
