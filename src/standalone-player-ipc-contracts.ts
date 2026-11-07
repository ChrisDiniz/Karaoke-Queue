import type {
  StandalonePlayerCommandRequest,
  StandalonePlayerError,
  StandalonePlayerSnapshot
} from './standalone-player-contracts'

export const enum STANDALONE_PLAYER_IPC_CHANNELS {
  getSnapshot = 'standalone:v1:get-snapshot',
  execute = 'standalone:v1:execute',
  subscribe = 'standalone:v1:subscribe',
  unsubscribe = 'standalone:v1:unsubscribe',
  snapshotChanged = 'standalone:v1:snapshot-changed',
  lookupMetadata = 'standalone:v1:lookup-metadata',
  getCurrentTrackMetadata = 'standalone:v1:get-current-track-metadata',
  catalogRevisionChanged = 'standalone:v1:catalog-revision-changed',
  getOptionsSnapshot = 'standalone:v1:options:get-snapshot',
  selectVideoFolder = 'standalone:v1:options:select-video-folder',
  refreshVideoLibrary = 'standalone:v1:options:refresh-video-library',
  importMusicCatalog = 'standalone:v1:options:import-music-catalog',
  confirmMusicCatalogImport = 'standalone:v1:options:confirm-music-catalog-import',
  cancelMusicCatalogImport = 'standalone:v1:options:cancel-music-catalog-import',
  getCatalogImportIssuesPage = 'standalone:v1:options:get-catalog-import-issues-page',
  optionsChanged = 'standalone:v1:options:changed',
  requestExitConfirmation = 'standalone:v1:exit:request-confirmation',
  resolveExitConfirmation = 'standalone:v1:exit:resolve-confirmation',
  exitConfirmationRequested = 'standalone:v1:exit:confirmation-requested',
  showPlaybackSurface = 'standalone:v1:playback-surface:show',
  hidePlaybackSurface = 'standalone:v1:playback-surface:hide'
}

export type StandaloneExitConfirmationDecision = 'confirm' | 'cancel'

export type StandaloneExitConfirmationRequestReply =
  | { readonly outcome: 'pending'; readonly requestId: string }
  | { readonly outcome: 'authorized' | 'native-fallback' | 'unavailable' }

export interface StandaloneExitConfirmationResolution {
  readonly requestId: string
  readonly decision: StandaloneExitConfirmationDecision
}

export interface StandaloneExitConfirmationResolutionReply {
  readonly requestId: string
  readonly outcome: 'confirmed' | 'cancelled' | 'stale' | 'already-authorized'
}

export type StandaloneOptionsLibraryScanStatus = 'not-scanned' | 'scanning' | 'ready' | 'degraded' | 'closed'

/** Renderer-safe options summary: names only, never filesystem paths or diagnostics. */
export interface StandalonePlayerOptionsData {
  readonly library: {
    readonly folderName: string | null
    readonly scanStatus: StandaloneOptionsLibraryScanStatus
    readonly indexedFiles: number | null
  }
  readonly catalog: {
    readonly fileName: string | null
    readonly recordCount: number
    readonly importedAt: string | null
    readonly revision: string | null
    readonly importIssueCount: number
    readonly importGeneration: number
  }
}

/** Main-issued, monotonic revision prevents old option replies/events replacing newer UI state. */
export interface StandalonePlayerOptionsSnapshot extends StandalonePlayerOptionsData {
  readonly revision: number
}

export type StandalonePlayerOptionsActionCode =
  | 'PLAYER_NOT_IDLE'
  | 'LIBRARY_BUSY'
  | 'OPTIONS_BUSY'
  | 'OPTIONS_FAILED'
  | 'CATALOG_IMPORT_FAILED'
  | 'CATALOG_CONFIRMATION_STALE'

export interface StandalonePlayerOptionsActionReply {
  readonly outcome: 'confirmed' | 'cancelled' | 'blocked' | 'failed' | 'confirmation-required'
  readonly code?: StandalonePlayerOptionsActionCode
  readonly confirmation?: {
    readonly token: string
    readonly recordCount: number
    readonly issueCount: number
    readonly currentRecordCount: number
  }
  readonly snapshot: StandalonePlayerOptionsSnapshot
}

export interface StandaloneCatalogImportIssuesPage {
  readonly catalogRevision: string | null
  readonly generation: number
  readonly total: number
  readonly offset: number
  readonly issues: ReadonlyArray<{
    readonly rowNumber: number
    readonly field: 'numero'
    readonly value: string
    readonly code: 'INVALID_MUSIC_NUMBER'
    readonly reason: string
  }>
}

export type StandaloneCatalogImportPreparation =
  | { readonly outcome: 'imported' }
  | {
      readonly outcome: 'confirmation-required'
      readonly token: string
      readonly recordCount: number
      readonly issueCount: number
      readonly currentRecordCount: number
    }

/** Main-only file selection and service operations; file paths never cross this boundary. */
export interface StandalonePlayerOptionsMainPort {
  getSnapshot(): StandalonePlayerOptionsData
  subscribe(listener: (snapshot: StandalonePlayerOptionsData) => void): () => void
  chooseVideoFolder(): Promise<string | null>
  applyVideoFolder(folderPath: string): Promise<void>
  refreshVideoLibrary(): Promise<void>
  chooseCatalogFile(): Promise<string | null>
  prepareCatalogImport(filePath: string): Promise<StandaloneCatalogImportPreparation>
  confirmCatalogImport(token: string): Promise<void>
  cancelCatalogImport(token: string): boolean
  getCatalogImportIssuesPage(catalogRevision: string, generation: number, offset: number, limit: number): StandaloneCatalogImportIssuesPage
}

export interface StandalonePlayerMetadataPreview {
  readonly catalogRevision: string | null
  readonly title: string | null
  readonly artist: string | null
}

/** Metadata tied by Main to one confirmed playback occurrence; no renderer-supplied code is accepted. */
export interface StandaloneCurrentTrackMetadata extends StandalonePlayerMetadataPreview {
  readonly entryId: string
  readonly attemptId: string
  readonly musicCode: string
}

export interface StandaloneMetadataCatalogPort {
  lookupMetadataByVideoCode(value: unknown): StandalonePlayerMetadataPreview
  subscribeToMetadataRevision(listener: (revision: string | null) => void): () => void
}

export interface StandalonePlayerSnapshotEnvelope {
  readonly revision: number
  readonly snapshot: StandalonePlayerSnapshot
}

export interface StandalonePlayerSubscriptionRef {
  readonly subscriptionId: string
  /** Main-issued generation makes a delayed unsubscribe from a previous document harmless. */
  readonly generation: number
}

export interface StandalonePlayerSnapshotUpdate extends StandalonePlayerSubscriptionRef {
  readonly envelope: StandalonePlayerSnapshotEnvelope
}

export type StandalonePlayerIpcCommandReply =
  | {
      readonly outcome: 'confirmed'
      readonly operationId: string
      readonly attemptId?: string
      readonly envelope: StandalonePlayerSnapshotEnvelope
    }
  | {
      readonly outcome: 'rejected' | 'blocked' | 'uncertain'
      readonly operationId: string
      readonly error: StandalonePlayerError
      readonly attemptId?: string
      readonly envelope: StandalonePlayerSnapshotEnvelope
    }

export interface StandalonePlayerRendererApi {
  getSnapshot(): Promise<StandalonePlayerSnapshotEnvelope>
  execute(request: StandalonePlayerCommandRequest): Promise<StandalonePlayerIpcCommandReply>
  lookupMetadata(code: string): Promise<StandalonePlayerMetadataPreview>
  getCurrentTrackMetadata(): Promise<StandaloneCurrentTrackMetadata | null>
  onCatalogRevisionChanged(listener: (revision: string | null) => void): () => void
  getOptionsSnapshot(): Promise<StandalonePlayerOptionsSnapshot>
  selectVideoFolder(): Promise<StandalonePlayerOptionsActionReply>
  refreshVideoLibrary(): Promise<StandalonePlayerOptionsActionReply>
  importMusicCatalog(): Promise<StandalonePlayerOptionsActionReply>
  confirmMusicCatalogImport(token: string): Promise<StandalonePlayerOptionsActionReply>
  cancelMusicCatalogImport(token: string): Promise<boolean>
  getCatalogImportIssuesPage(catalogRevision: string, generation: number, offset: number): Promise<StandaloneCatalogImportIssuesPage>
  onOptionsChanged(listener: (snapshot: StandalonePlayerOptionsSnapshot) => void): () => void
  requestExitConfirmation(): Promise<StandaloneExitConfirmationRequestReply>
  resolveExitConfirmation(resolution: StandaloneExitConfirmationResolution): Promise<StandaloneExitConfirmationResolutionReply>
  onExitConfirmationRequested(listener: (requestId: string) => void): () => void
  showPlaybackSurface(bounds: StandalonePlayerVideoBounds): Promise<boolean>
  hidePlaybackSurface(): Promise<boolean>
  /** Calls listener with a consistent initial snapshot before resolving, then with newer revisions only. */
  subscribe(listener: (envelope: StandalonePlayerSnapshotEnvelope) => void): Promise<StandalonePlayerSubscriptionRef>
  unsubscribe(subscription: StandalonePlayerSubscriptionRef): Promise<boolean>
}

export interface StandalonePlayerVideoBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Returns true only for a snapshot newer than the one already rendered. */
export function isNewerStandalonePlayerOptionsSnapshot(
  current: StandalonePlayerOptionsSnapshot | undefined,
  candidate: StandalonePlayerOptionsSnapshot
): boolean {
  return current === undefined || candidate.revision > current.revision
}

export interface StandalonePlayerMainIpcBridgeOptions {
  readonly ipcMain: Electron.IpcMain
  readonly webContents: Electron.WebContents
  readonly expectedDocumentUrl: string
  readonly control: import('./standalone-player-contracts').StandalonePlayerControl
  readonly metadataCatalog?: StandaloneMetadataCatalogPort
  readonly options?: StandalonePlayerOptionsMainPort
  readonly videoSurface?: {
    show(bounds: StandalonePlayerVideoBounds): Promise<boolean>
    hide(): boolean
  }
  /** Test seam for the native fallback; production defaults to Electron's native message box. */
  readonly showExitFallbackDialog?: () => Promise<boolean>
}
