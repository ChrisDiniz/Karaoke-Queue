import { createKaraokeDatabase, createPlayerMusicCatalogDatabase } from '../database'
import type { OperatingMode } from './operating-mode'
import { MusicCatalogService } from './music-catalog-service'
import { VideoLibraryService } from './video-library-service'
import { readVideoLibraryConfiguration, writeVideoLibraryConfiguration } from './video-library-configuration'

/** Only the Welcome window owns this short-lived media composition. No queue host. */
export class WelcomeMediaSetup {
  private readonly library: VideoLibraryService
  private database?: ReturnType<typeof createKaraokeDatabase> | ReturnType<typeof createPlayerMusicCatalogDatabase>
  private catalog?: MusicCatalogService
  private token?: string
  private closeTask?: Promise<void>
  private closed = false
  private busy = false
  constructor(private readonly directory: string, private readonly role: OperatingMode,
    private readonly publish: (state: ReturnType<WelcomeMediaSetup['snapshot']>) => void) {
    this.library = new VideoLibraryService(readVideoLibraryConfiguration(directory).roots)
  }
  snapshot() {
    const snapshot = this.library.getSnapshot()
    return { library: { scanStatus: snapshot.scanStatus, counts: snapshot.counts }, pendingCatalog: !!this.token }
  }
  get pendingCatalog(): boolean { return !!this.token }
  async applyLibrary(root: string): Promise<void> {
    this.assertAvailable()
    this.busy = true
    const previous = [...this.library.roots]
    try {
      writeVideoLibraryConfiguration(this.directory, [root])
      const scan = this.library.configureRoots([root])
      this.publish(this.snapshot())
      await scan
    } catch (error) { writeVideoLibraryConfiguration(this.directory, previous); throw error }
    finally { this.busy = false; if (!this.closed) this.publish(this.snapshot()) }
  }
  async prepareCatalog(file: string) {
    this.assertAvailable()
    this.busy = true
    try {
      if (!this.catalog) {
        this.database = this.role === 'player' ? createPlayerMusicCatalogDatabase(this.directory) : createKaraokeDatabase(this.directory)
        this.catalog = new MusicCatalogService(this.database)
      }
      const result = await this.catalog.prepareStandaloneImport(file, this.role === 'combined')
      this.token = result.outcome === 'confirmation-required' ? result.token : undefined
      return result
    } finally { this.busy = false }
  }
  async confirmCatalog(token: unknown) {
    this.assertAvailable()
    if (!this.catalog || !this.token || token !== this.token) throw new Error('CATALOG_REPORT_STALE')
    this.busy = true
    try { const result = await this.catalog.confirmStandaloneImport(token); this.token = undefined; return result }
    finally { this.busy = false }
  }
  cancelCatalog(token: unknown): void {
    this.assertAvailable()
    if (!this.catalog || !this.token || token !== this.token) throw new Error('CATALOG_REPORT_STALE')
    this.catalog.cancelStandaloneImport(token); this.token = undefined
  }
  issues(offset: number) {
    this.assertAvailable()
    return this.catalog?.getWelcomeImportIssues(offset, 50) ?? { total: 0, offset: 0, issues: [] }
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.closed = true
    this.library.close()
    this.closeTask = (async () => {
      await this.catalog?.close()
      this.database?.close()
    })()
    return this.closeTask
  }
  private assertAvailable(): void {
    if (this.closed || this.busy) throw new Error('WELCOME_MEDIA_BUSY')
  }
}
