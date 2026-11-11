import type { MusicCatalogImportIssuePage } from './music-catalog'
import type { MusicCatalogImportPreparation, MusicCatalogService } from './music-catalog-service'
import type { StandalonePlayerSnapshot } from './standalone-player-contracts'
import type {
  StandaloneOptionsLibraryScanStatus,
  StandalonePlayerOptionsData
} from './standalone-player-ipc-contracts'
import { writeVideoLibraryConfiguration } from './video-library-configuration'
import type { VideoLibraryService } from './video-library-service'

export interface StandalonePlayerOptionsDialogPort {
  chooseVideoFolder(): Promise<string | null>
  chooseCatalogFile(): Promise<string | null>
}

export interface StandalonePlayerOptionsServiceOptions {
  readonly library: VideoLibraryService
  readonly catalog: MusicCatalogService
  readonly userDataDirectory: string
  readonly dialogs: StandalonePlayerOptionsDialogPort
}

/** Strict Main-side occupancy check used again after any asynchronous folder dialog. */
export function isStandalonePlayerLibraryChangeAllowed(snapshot: StandalonePlayerSnapshot): boolean {
  if (snapshot.playbackCondition !== 'ready') return false
  return snapshot.state.operationalState === 'idle' && snapshot.state.current === null &&
    snapshot.state.pending.length === 0
}

/** Main-side options operations. Paths are used here but never included in the Renderer DTO. */
export class StandalonePlayerOptionsService {
  private readonly listeners = new Set<(snapshot: StandalonePlayerOptionsData) => void>()
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeLibrary: () => void
  private disposed = false

  constructor(private readonly options: StandalonePlayerOptionsServiceOptions) {
    this.unsubscribeCatalog = options.catalog.subscribeToMetadataRevision(() => this.publish())
    this.unsubscribeLibrary = options.library.subscribe(() => this.publish())
  }

  getSnapshot(): StandalonePlayerOptionsData {
    const library = this.options.library.getSnapshot()
    const roots = this.options.library.roots
    const metadata = this.options.catalog.getMetadata()
    const issueSummary = this.options.catalog.getStandaloneImportIssuePage(0, 1)
    const scanStatus = library.scanStatus as StandaloneOptionsLibraryScanStatus
    return {
      library: {
        folderName: roots.length === 1 ? safeBaseName(roots[0]) : null,
        scanStatus,
        indexedFiles: scanStatus === 'ready' && roots.length > 0 ? library.counts.indexedFiles : null
      },
      catalog: {
        fileName: safeBaseName(metadata.sourceName),
        recordCount: metadata.recordCount,
        importedAt: metadata.importedAt,
        revision: metadata.revision,
        importIssueCount: issueSummary.total,
        importGeneration: issueSummary.generation
      }
    }
  }

  subscribe(listener: (snapshot: StandalonePlayerOptionsData) => void): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  chooseVideoFolder(): Promise<string | null> {
    this.ensureOpen()
    return this.options.dialogs.chooseVideoFolder()
  }

  async applyVideoFolder(folderPath: string): Promise<void> {
    this.ensureOpen()
    const previousRoots = [...this.options.library.roots]
    writeVideoLibraryConfiguration(this.options.userDataDirectory, [folderPath])
    const scan = this.options.library.configureRoots([folderPath])
    this.publish()
    try {
      await scan
    } catch (error) {
      // A failed operation must not leave configuration and the live service on different roots.
      writeVideoLibraryConfiguration(this.options.userDataDirectory, previousRoots)
      this.publish()
      throw error
    }
    this.publish()
  }

  async refreshVideoLibrary(): Promise<void> {
    this.ensureOpen()
    const scan = this.options.library.refresh()
    this.publish()
    await scan
    this.publish()
  }

  chooseCatalogFile(): Promise<string | null> {
    this.ensureOpen()
    return this.options.dialogs.chooseCatalogFile()
  }

  async prepareCatalogImport(filePath: string): Promise<MusicCatalogImportPreparation> {
    this.ensureOpen()
    const result = await this.options.catalog.prepareStandaloneImport(filePath)
    if (result.outcome === 'imported') this.publish()
    return result
  }

  async confirmCatalogImport(token: string): Promise<void> {
    this.ensureOpen()
    await this.options.catalog.confirmStandaloneImport(token)
    this.publish()
  }

  cancelCatalogImport(token: string): boolean {
    this.ensureOpen()
    return this.options.catalog.cancelStandaloneImport(token)
  }

  getCatalogImportIssuesPage(catalogRevision: string, generation: number, offset: number, limit: number): MusicCatalogImportIssuePage {
    this.ensureOpen()
    const page = this.options.catalog.getStandaloneImportIssuePage(offset, limit)
    if (page.catalogRevision !== catalogRevision || page.generation !== generation) throw new Error('CATALOG_REPORT_STALE')
    return page
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeCatalog()
    this.unsubscribeLibrary()
    this.listeners.clear()
  }

  private publish(): void {
    if (this.disposed) return
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { /* Options UI observers cannot affect Main-side commits. */ }
    }
  }

  private ensureOpen(): void {
    if (this.disposed) throw new Error('STANDALONE_OPTIONS_CLOSED')
  }
}

function safeBaseName(value: string | null | undefined): string | null {
  if (!value) return null
  // Treat both separator styles as path boundaries even when a persisted value
  // originated on the other OS; never fall back to returning a filesystem root.
  const normalized = value.replace(/[\\/]+$/g, '')
  const baseName = normalized.slice(Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\')) + 1)
  return safeLabel(baseName)
}

function safeLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const sanitized = value.replace(/[\0-\x1f\x7f]/g, '').slice(0, 255)
  return sanitized.length > 0 ? sanitized : null
}
