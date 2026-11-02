import type { ManualPlaybackResult, ManualSequenceSnapshot } from './manual-playback-service'
import type { PlayerPlaybackEvent, PlayerPlaybackProgress, PlayerPlaybackState } from './player-playback-contracts'
import type { PlayerRecoveryDiagnosticSummary, PlayerRecoverySnapshot, PlayerShutdownRequest, PlayerShutdownResult } from './player-playback-recovery'
import type { MusicCatalogImportResult } from './music-catalog-service'
import type { MusicCatalogMetadata } from './music-catalog'
import type { VideoLibraryScanStatus } from './video-library'
import type { PlayerVideoBounds, PlayerVideoWindowSnapshot } from './player-video-window'

export type PlayerLibraryStatus = 'not-configured' | 'empty' | 'indexing' | 'available' | 'unavailable' | 'error'

export interface PlayerLibraryUiState {
  readonly status: PlayerLibraryStatus
  readonly scanStatus: VideoLibraryScanStatus
  readonly indexedFiles: number
  readonly availableCodes: number
  readonly ambiguousCodes: number
  readonly missingCodes: number
  readonly unreadableCodes: number
  readonly unknownCodes: number
  readonly lastIndexedAt: string | null
  readonly configuredFolders: readonly string[]
}

export interface PlayerMusicMetadata {
  readonly videoCode: string
  readonly artist: string | null
  readonly title: string | null
  readonly metadataAvailable: boolean
  readonly videoAvailability: 'available' | 'ambiguous' | 'missing' | 'unreadable' | 'unknown'
}

export interface PlayerUiSnapshot {
  readonly revision: number
  readonly mode: 'player' | 'combined'
  readonly library: PlayerLibraryUiState
  readonly playback: PlayerPlaybackState
  readonly progress: PlayerPlaybackProgress | null
  readonly sequence: ManualSequenceSnapshot
  readonly catalog: {
    readonly status: 'available' | 'not-configured'
    readonly metadata: MusicCatalogMetadata
  }
  readonly recovery: PlayerRecoverySnapshot
  readonly recoveryDiagnostic: PlayerRecoveryDiagnosticSummary | null
  readonly videoWindow: PlayerVideoWindowSnapshot
}

/** Renderer snapshots may arrive from IPC events and awaited replies in either order. */
export function isStalePlayerUiRevision(currentRevision: number | undefined, nextRevision: number): boolean {
  return currentRevision !== undefined && nextRevision < currentRevision
}

/** The first snapshot establishes a baseline; only a later output-X return signals navigation. */
export function isNewPlayerOutputReturn(currentRevision: number | undefined, nextRevision: number): boolean {
  return currentRevision !== undefined && nextRevision > currentRevision
}

/** Narrow Main/Preload boundary. Configured folders are read-only display data; it exposes no filesystem operations, SQLite handles, or engine APIs. */
export interface KaraokePlayerBridge {
  getSnapshot(): Promise<PlayerUiSnapshot>
  onSnapshot(callback: (snapshot: PlayerUiSnapshot) => void): () => void
  lookupMusicCode(code: string): Promise<PlayerMusicMetadata>
  playNow(code: string): Promise<ManualPlaybackResult>
  addToSequence(code: string): Promise<ManualPlaybackResult>
  removeFromSequence(itemId: string): Promise<ManualPlaybackResult>
  reorderSequence(itemIds: string[]): Promise<ManualPlaybackResult>
  clearSequence(): Promise<ManualPlaybackResult>
  pause(): Promise<ManualPlaybackResult>
  resume(): Promise<ManualPlaybackResult>
  restart(): Promise<ManualPlaybackResult>
  stop(): Promise<ManualPlaybackResult>
  next(): Promise<ManualPlaybackResult>
  previous(): Promise<ManualPlaybackResult>
  importCatalog(): Promise<MusicCatalogImportResult | { cancelled: true }>
  selectLibraryFolder(): Promise<{ cancelled: true } | PlayerUiSnapshot>
  refreshLibrary(): Promise<PlayerUiSnapshot>
  showVideoWindow(): Promise<PlayerVideoWindowSnapshot>
  showPlayerInline(bounds: PlayerVideoBounds): Promise<PlayerVideoWindowSnapshot>
  updatePlayerInlineBounds(bounds: PlayerVideoBounds): Promise<boolean>
  setPlayerInlineVisible(visible: boolean): Promise<boolean>
  hidePlayerInline(): Promise<PlayerVideoWindowSnapshot | undefined>
  toggleVideoFullScreen(): Promise<boolean>
  exitVideoFullScreen(): Promise<boolean>
  replayPreviousRecovery(attemptId: string): Promise<ManualPlaybackResult>
  chooseAnotherRecovery(attemptId: string, code: string): Promise<ManualPlaybackResult>
  leaveRecoveryStopped(attemptId: string): Promise<PlayerRecoverySnapshot>
  resolveInvalidRecovery(): Promise<{ state: PlayerRecoverySnapshot; preservedFileCount: number }>
  copyRecoveryDiagnostic(): Promise<{ copied: boolean }>
  cancelShutdown(attemptId: string): Promise<PlayerShutdownResult>
  confirmShutdown(attemptId: string): Promise<PlayerShutdownResult>
  finishShutdown(attemptId: string): Promise<void>
  onShutdownRequest(callback: (request: Extract<PlayerShutdownRequest, { outcome: 'confirmation-required' }>) => void): () => void
  onPlaybackEvent(callback: (event: PlayerPlaybackEvent) => void): () => void
}

export function isAuthorizedPlayerIpcSender(input: {
  playerEnabled: boolean
  senderWebContentsId: number
  expectedWebContentsId: number | undefined
  isMainFrame: boolean
  frameUrl: string | undefined
  expectedDocumentUrl: string
}): boolean {
  return input.playerEnabled && input.expectedWebContentsId !== undefined &&
    input.senderWebContentsId === input.expectedWebContentsId && input.isMainFrame &&
    input.frameUrl === input.expectedDocumentUrl
}
