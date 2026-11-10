import type { StandaloneCurrentTrackMetadata } from './standalone-player-ipc-contracts'

export const STANDALONE_CURRENT_TRACK_INFO_MS = 3_500

export interface StandaloneCurrentTrackIdentity {
  readonly entryId: string
  readonly attemptId: string
  readonly musicCode: string
}

export interface StandaloneCurrentTrackInfoSnapshot {
  readonly open: boolean
  readonly entryId: string | null
  readonly attemptId: string | null
  readonly musicCode: string
  readonly catalogRevision: string | null
  readonly title: string | null
  readonly artist: string | null
}

export interface StandaloneCurrentTrackInfoScheduler {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

export interface StandaloneCurrentTrackInfoOptions {
  readonly scheduler: StandaloneCurrentTrackInfoScheduler
  readonly lookupCurrentTrack: () => Promise<StandaloneCurrentTrackMetadata | null>
  /** Re-reads the Main snapshot after lookup so a delayed response cannot reopen a stale track. */
  readonly getCurrentTrack: () => Promise<StandaloneCurrentTrackIdentity | null>
}

export type StandaloneCurrentTrackInfoListener = (snapshot: StandaloneCurrentTrackInfoSnapshot) => void

/** Renderer presentation state for I; Main remains authoritative for the current occurrence and metadata. */
export class StandaloneCurrentTrackInfoController {
  private current: StandaloneCurrentTrackIdentity | null = null
  private open = false
  private catalogRevision: string | null = null
  private title: string | null = null
  private artist: string | null = null
  private timerHandle: unknown
  private timerGeneration = 0
  private lookupGeneration = 0
  private catalogGeneration = 0
  private disposed = false
  private readonly listeners = new Set<StandaloneCurrentTrackInfoListener>()

  constructor(private readonly options: StandaloneCurrentTrackInfoOptions) {}

  getSnapshot(): StandaloneCurrentTrackInfoSnapshot {
    return {
      open: this.open,
      entryId: this.open ? this.current?.entryId ?? null : null,
      attemptId: this.open ? this.current?.attemptId ?? null : null,
      musicCode: this.open ? this.current?.musicCode ?? '' : '',
      catalogRevision: this.catalogRevision,
      title: this.open ? this.title : null,
      artist: this.open ? this.artist : null
    }
  }

  subscribe(listener: StandaloneCurrentTrackInfoListener): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setCurrentTrack(current: StandaloneCurrentTrackIdentity | null): void {
    if (this.disposed || sameIdentity(this.current, current)) return
    const previous = this.current
    this.current = current ? { ...current } : null
    if (!sameOccurrence(previous, this.current)) {
      this.invalidateLookup()
      this.title = null
      this.artist = null
      if (this.open) this.close()
      return
    }

    // A restart keeps the same queue occurrence but creates a new playback attempt.
    // Any in-flight query belongs to the old attempt and must not update this panel.
    if (this.open) this.startLookup()
  }

  show(): void {
    if (this.disposed || !this.current) return
    this.open = true
    this.armTimer(this.current)
    this.publish()
    this.startLookup()
  }

  close(): void {
    if (this.disposed) return
    const wasOpen = this.open
    this.open = false
    this.cancelTimer()
    this.invalidateLookup()
    this.title = null
    this.artist = null
    if (wasOpen) this.publish()
  }

  catalogChanged(revision: string | null): void {
    if (this.disposed || revision === this.catalogRevision) return
    this.catalogRevision = revision
    this.catalogGeneration++
    this.invalidateLookup()
    if (this.open && this.current) this.startLookup()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelTimer()
    this.invalidateLookup()
    this.current = null
    this.listeners.clear()
  }

  private startLookup(): void {
    const expected = this.current
    if (!this.open || !expected) return
    const generation = ++this.lookupGeneration
    const catalogGeneration = this.catalogGeneration
    void this.options.lookupCurrentTrack().then(async result => {
      if (!this.isCurrentLookup(generation, catalogGeneration, expected)) return
      if (!result || !sameIdentity(result, expected)) {
        this.close()
        return
      }
      const mainCurrent = await this.options.getCurrentTrack()
      if (!this.isCurrentLookup(generation, catalogGeneration, expected)) return
      if (!sameIdentity(mainCurrent, expected)) {
        this.close()
        return
      }
      this.catalogRevision = result.catalogRevision
      this.title = result.title
      this.artist = result.artist
      this.publish()
    }).catch(async () => {
      if (!this.isCurrentLookup(generation, catalogGeneration, expected)) return
      try {
        const mainCurrent = await this.options.getCurrentTrack()
        if (!this.isCurrentLookup(generation, catalogGeneration, expected)) return
        if (!sameIdentity(mainCurrent, expected)) {
          this.close()
          return
        }
      } catch {
        this.close()
        return
      }
      // Catalog data is optional. A confirmed current track remains displayable without metadata.
      this.title = null
      this.artist = null
      this.publish()
    })
  }

  private isCurrentLookup(generation: number, catalogGeneration: number,
    expected: StandaloneCurrentTrackIdentity): boolean {
    return !this.disposed && this.open && generation === this.lookupGeneration &&
      catalogGeneration === this.catalogGeneration && sameIdentity(this.current, expected)
  }

  private armTimer(expected: StandaloneCurrentTrackIdentity): void {
    this.cancelTimer()
    const generation = ++this.timerGeneration
    this.timerHandle = this.options.scheduler.schedule(() => {
      if (this.disposed || generation !== this.timerGeneration || !this.open ||
          !sameIdentity(this.current, expected)) return
      this.timerHandle = undefined
      this.close()
    }, STANDALONE_CURRENT_TRACK_INFO_MS)
  }

  private cancelTimer(): void {
    this.timerGeneration++
    if (this.timerHandle !== undefined) this.options.scheduler.cancel(this.timerHandle)
    this.timerHandle = undefined
  }

  private invalidateLookup(): void {
    this.lookupGeneration++
  }

  private publish(): void {
    const snapshot = this.getSnapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { /* A view observer cannot affect playback or current-track state. */ }
    }
  }
}

function sameOccurrence(left: StandaloneCurrentTrackIdentity | null,
  right: StandaloneCurrentTrackIdentity | null): boolean {
  return left?.entryId === right?.entryId && left?.musicCode === right?.musicCode
}

function sameIdentity(left: StandaloneCurrentTrackIdentity | null,
  right: StandaloneCurrentTrackIdentity | null): boolean {
  return sameOccurrence(left, right) && left?.attemptId === right?.attemptId
}
