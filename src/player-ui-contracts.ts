import type { ManualBatchPlaybackResult, ManualPlaybackResult, ManualSequenceSnapshot } from './manual-playback-service'
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

/** Prevents an awaited shutdown-dialog setup from reopening after cancel or attempt replacement. */
export function isCurrentPlayerShutdownDialogRequest(
  requestGeneration: number,
  currentGeneration: number,
  requestAttemptId: string,
  pendingAttemptId: string | undefined
): boolean {
  return requestGeneration === currentGeneration && requestAttemptId === pendingAttemptId
}

/** Keeps a confirmed-removal dialog open while its correlated Stop/clear request is awaiting Main. */
export function isCurrentRemovalOperationPending(
  operationPending: boolean,
  targetAttemptId: string,
  currentAttemptId: string | undefined
): boolean {
  return operationPending && (!currentAttemptId || currentAttemptId === targetAttemptId)
}

/** Uses the correlated playback attempt as the visible track during preparation, errors, and uncertain outcomes. */
export function playerCurrentTrackCode(
  sequenceCurrentCode: string | null | undefined,
  playback: Pick<PlayerUiSnapshot['playback'], 'status' | 'musicCode'>
): string | undefined {
  if (playback.status === 'completed') return undefined
  if (playback.musicCode && ['loading', 'ready', 'starting', 'playing', 'paused', 'stopping', 'failed', 'uncertain'].includes(playback.status)) {
    return playback.musicCode
  }
  return sequenceCurrentCode ?? playback.musicCode ?? undefined
}

export function playerPlaybackEventNotice(event: PlayerPlaybackEvent): string | undefined {
  if (event.type === 'surface-cleanup-failed') {
    return 'A música terminou, mas o Player não confirmou a limpeza da imagem final.'
  }
  return undefined
}

/** Narrow Main/Preload boundary. Configured folders are read-only display data; it exposes no filesystem operations, SQLite handles, or engine APIs. */
export interface KaraokePlayerBridge {
  getSnapshot(): Promise<PlayerUiSnapshot>
  onSnapshot(callback: (snapshot: PlayerUiSnapshot) => void): () => void
  lookupMusicCode(code: string): Promise<PlayerMusicMetadata>
  playNow(code: string): Promise<ManualPlaybackResult>
  addToSequence(code: string): Promise<ManualPlaybackResult>
  addBatchToSequence(rawText: string, requestId: string): Promise<ManualBatchPlaybackResult>
  removeFromSequence(itemId: string): Promise<ManualPlaybackResult>
  removeCurrent(itemId: string | null, attemptId: string): Promise<ManualPlaybackResult>
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
  setWindowTipVisible(visible: boolean): Promise<boolean>
  onWindowTipDismissed(callback: (permanentlyDismissed: boolean) => void): () => void
  showPlayerInline(bounds: PlayerVideoBounds): Promise<PlayerVideoWindowSnapshot>
  updatePlayerInlineBounds(bounds: PlayerVideoBounds, layoutRevision: number): Promise<boolean>
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
