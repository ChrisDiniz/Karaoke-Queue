import type { PlayerPlaybackHost, PlayerPlaybackPersistence, PlayerMediaSourceProvider } from './player-playback-contracts'
import { PlayerPlaybackError } from './player-playback-contracts'
import { PlayerPlaybackService } from './player-playback-service'
import type { VideoLibraryService } from './video-library-service'
import type {
  StandaloneCatalogPort,
  StandalonePlaybackPort
} from './standalone-player-contracts'
import { StandalonePlayerSequence, type StandalonePlayerSequenceOptions } from './standalone-player-sequence'

export interface StandalonePlayerPlaybackAdapterOptions {
  /** A scanned Main-side library. It remains the sole authority for video availability. */
  readonly library: VideoLibraryService
  /** Normally the existing PlayerMediaProtocol backed by the same library. */
  readonly mediaSources: PlayerMediaSourceProvider
  /** A host created by the owning Main lifecycle; production uses ChromiumPlaybackHost. */
  readonly host: PlayerPlaybackHost
  /** Metadata lookup is optional and is never used to decide whether playback may start. */
  readonly catalog?: StandaloneCatalogPort & { close?: () => void | Promise<void> }
  /** Must unregister/dispose the media source, including its Electron protocol handler when installed. */
  readonly disposeMediaSources: () => void | Promise<void>
}

export interface StandalonePlayerWithSharedPlaybackOptions extends
  Omit<StandalonePlayerSequenceOptions, 'createPlayback' | 'catalog' | 'disposeResources'>,
  StandalonePlayerPlaybackAdapterOptions {}

/**
 * Builds the existing technical PlayerPlaybackService for the Standalone sequence.
 * It owns one host/service pair and its injected library, media source and optional catalog.
 */
export class StandalonePlayerPlaybackAdapter {
  private playback: PlayerPlaybackService | undefined
  private factoryUsed = false
  private disposePromise: Promise<void> | undefined

  constructor(private readonly options: StandalonePlayerPlaybackAdapterOptions) {}

  readonly createPlayback = (persistence?: PlayerPlaybackPersistence): StandalonePlaybackPort => {
    if (this.factoryUsed || this.disposePromise) {
      throw new PlayerPlaybackError('INVALID_STATE', 'O adaptador Standalone já criou ou encerrou seu serviço de playback.')
    }
    this.factoryUsed = true
    const playback = new PlayerPlaybackService(this.options.library, this.options.mediaSources, persistence)
    this.playback = playback
    playback.attachHost(this.options.host)
    return playback
  }

  /** Runtime calls this after the playback service and recovery have stopped using these resources. */
  readonly disposeResources = (): Promise<void> => {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = (async () => {
      let firstError: unknown
      try {
        if (this.playback) await this.playback.dispose()
        else this.options.host.dispose()
      } catch (error) { firstError = error }

      try { await this.options.disposeMediaSources() } catch (error) { firstError ??= error }
      try { await this.options.catalog?.close?.() } catch (error) { firstError ??= error }
      try { this.options.library.close() } catch (error) { firstError ??= error }

      if (firstError) throw firstError
    })()
    return this.disposePromise
  }
}

/** Main-side composition helper. No Electron startup, IPC, mode, Controller, or UI is touched. */
export async function createStandalonePlayerWithSharedPlayback(
  options: StandalonePlayerWithSharedPlaybackOptions
): Promise<StandalonePlayerSequence> {
  const { library, mediaSources, host, catalog, disposeMediaSources, ...sequenceOptions } = options
  const adapter = new StandalonePlayerPlaybackAdapter({ library, mediaSources, host, catalog, disposeMediaSources })
  try {
    return await StandalonePlayerSequence.create({
      ...sequenceOptions,
      catalog,
      createPlayback: adapter.createPlayback,
      disposeResources: adapter.disposeResources
    })
  } catch (error) {
    try { await adapter.disposeResources() } catch { /* Keep the composition failure as the reported cause. */ }
    throw error
  }
}
