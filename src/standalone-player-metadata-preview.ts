import type { StandalonePlayerMetadataPreview } from './standalone-player-ipc-contracts'
import type { StandaloneQueueEntry } from './standalone-player-contracts'

export interface StandaloneMetadataPreviewSnapshot extends StandalonePlayerMetadataPreview {
  readonly code: string
}

export interface StandaloneMetadataPreviewLookup {
  lookupMetadata(code: string): Promise<StandalonePlayerMetadataPreview>
}

export type StandaloneMetadataPreviewListener = (snapshot: StandaloneMetadataPreviewSnapshot) => void

/** Renderer-only preview state. Main remains authoritative for catalog contents; every async result is generation-checked. */
export class StandalonePlayerMetadataPreviewController {
  private code = ''
  private panelOpen = false
  private generation = 0
  private catalogGeneration = 0
  private catalogRevision: string | null = null
  private title: string | null = null
  private artist: string | null = null
  private disposed = false
  private readonly listeners = new Set<StandaloneMetadataPreviewListener>()

  constructor(private readonly lookup: StandaloneMetadataPreviewLookup) {}

  getSnapshot(): StandaloneMetadataPreviewSnapshot {
    return {
      code: this.code,
      catalogRevision: this.catalogRevision,
      title: this.title,
      artist: this.artist
    }
  }

  subscribe(listener: StandaloneMetadataPreviewListener): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  updateEntry(panelOpen: boolean, code: string): void {
    if (this.disposed) return
    const currentCode = panelOpen ? code : ''
    if (this.panelOpen === panelOpen && this.code === currentCode) return
    this.panelOpen = panelOpen
    this.code = currentCode
    this.generation++
    this.title = null
    this.artist = null
    this.publish()
    if (this.panelOpen && this.code) this.startLookup()
  }

  catalogChanged(revision: string | null): void {
    if (this.disposed || revision === this.catalogRevision) return
    this.catalogRevision = revision
    this.catalogGeneration++
    this.generation++
    this.title = null
    this.artist = null
    this.publish()
    if (this.panelOpen && this.code) this.startLookup()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.listeners.clear()
    this.code = ''
    this.panelOpen = false
    this.title = null
    this.artist = null
  }

  private startLookup(): void {
    const code = this.code
    const generation = ++this.generation
    const catalogGeneration = this.catalogGeneration
    void this.lookup.lookupMetadata(code).then(result => {
      if (this.disposed || generation !== this.generation || catalogGeneration !== this.catalogGeneration ||
          !this.panelOpen || this.code !== code) return
      this.catalogRevision = result.catalogRevision
      this.title = result.title
      this.artist = result.artist
      this.publish()
    }).catch(() => {
      // Missing/unavailable optional catalog data is an empty preview, never a playback failure.
    })
  }

  private publish(): void {
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { /* A view observer cannot mutate the catalog preview state. */ }
    }
  }
}

export interface StandaloneTransitionMetadataSnapshot extends StandalonePlayerMetadataPreview {
  readonly entryId: string | null
  readonly code: string
}

/** Renderer-only metadata for the Main-reserved countdown/loading target; every lookup is reservation-correlated. */
export class StandaloneTransitionMetadataPreviewController {
  private target: StandaloneQueueEntry | undefined
  private catalogRevision: string | null = null
  private title: string | null = null
  private artist: string | null = null
  private generation = 0
  private catalogGeneration = 0
  private disposed = false
  private readonly listeners = new Set<(snapshot: StandaloneTransitionMetadataSnapshot) => void>()

  constructor(private readonly lookup: StandaloneMetadataPreviewLookup) {}

  getSnapshot(): StandaloneTransitionMetadataSnapshot {
    return {
      entryId: this.target?.entryId ?? null,
      code: this.target?.musicCode ?? '',
      catalogRevision: this.catalogRevision,
      title: this.title,
      artist: this.artist
    }
  }

  subscribe(listener: (snapshot: StandaloneTransitionMetadataSnapshot) => void): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  updateTarget(target: StandaloneQueueEntry | undefined): void {
    if (this.disposed || (this.target?.entryId === target?.entryId && this.target?.musicCode === target?.musicCode)) return
    this.target = target ? { entryId: target.entryId, musicCode: target.musicCode } : undefined
    this.generation++
    this.title = null
    this.artist = null
    this.publish()
    if (this.target) this.startLookup()
  }

  catalogChanged(revision: string | null): void {
    if (this.disposed || revision === this.catalogRevision) return
    this.catalogRevision = revision
    this.catalogGeneration++
    this.generation++
    this.title = null
    this.artist = null
    this.publish()
    if (this.target) this.startLookup()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.target = undefined
    this.listeners.clear()
  }

  private startLookup(): void {
    const target = this.target
    if (!target) return
    const generation = ++this.generation
    const catalogGeneration = this.catalogGeneration
    void this.lookup.lookupMetadata(target.musicCode).then(result => {
      if (this.disposed || generation !== this.generation || catalogGeneration !== this.catalogGeneration ||
          this.target?.entryId !== target.entryId || this.target.musicCode !== target.musicCode) return
      this.catalogRevision = result.catalogRevision
      this.title = result.title
      this.artist = result.artist
      this.publish()
    }).catch(() => {
      // Optional catalog failure leaves the reserved target and its playback unchanged.
    })
  }

  private publish(): void {
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { /* The visual preview cannot mutate the authoritative target. */ }
    }
  }
}
