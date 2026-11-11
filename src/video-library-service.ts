import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  isCanonicalVideoCode,
  isSupportedVideoExtension,
  parseVideoCode,
  type VideoAvailability,
  type VideoLibraryCounts,
  type VideoLibraryDiagnostic,
  type VideoLibraryInventoryItem,
  type VideoLibraryScanStatus,
  type VideoLibrarySnapshot,
  type VideoMediaOpenResult,
  type VideoLookupResult
} from './video-library'
import { normalizeVideoLibraryRoots } from './video-library-configuration'
import type { VideoLibraryIndexDocument, VideoLibraryIndexStore } from './video-library-index-store'

interface IndexedVideo {
  rootId: string
  rootIndex: number
  configuredRoot: string
  canonicalRoot: string
  absolutePath: string
  canonicalPath: string
  relativePath: string
  musicCode: string
  device: string
  inode: string
  size: number
  modifiedAt: number
}

interface RootIndex {
  canonicalRoot: string
  files: IndexedVideo[]
  scanSucceeded: boolean
  diagnostics: VideoLibraryDiagnostic[]
  unreadableCodes: Set<string>
  invalidFilenameCount: number
  unreadableFileCount: number
}

interface RootScanResult {
  canonicalRoot: string
  files: IndexedVideo[]
  diagnostics: VideoLibraryDiagnostic[]
  invalidFilenameCount: number
  unreadableFileCount: number
}

export type VideoLibraryRootAvailability = 'unknown' | 'available' | 'unavailable' | 'permission-denied' | 'volume-mismatch'

export interface VideoLibraryAvailabilitySummary {
  epoch: number
  availableRoots: number
  unavailableRoots: number
  permissionDeniedRoots: number
  volumeMismatchRoots: number
  unknownRoots: number
}

/** Main-only, pathless counters for the opt-in F0 diagnostic run. */
export interface VideoLibraryScanMetrics {
  durationMs: number
  directoriesEnumerated: number
  entriesEnumerated: number
  lstatCalls: number
  statCalls: number
  realpathCalls: number
  candidateFiles: number
  cacheHits: number
  fileOpens: number
  fileCloses: number
  bytesRead: number
  playbackYieldCount: number
  playbackYieldDurationMs: number
}

export interface VideoLibraryServiceOptions {
  collectScanMetrics?: boolean
  indexStore?: VideoLibraryIndexStore
  onIndexWriteError?: (error: unknown) => void
}

function emptyScanMetrics(): VideoLibraryScanMetrics {
  return { durationMs: 0, directoriesEnumerated: 0, entriesEnumerated: 0,
    lstatCalls: 0, statCalls: 0, realpathCalls: 0, candidateFiles: 0, cacheHits: 0,
    fileOpens: 0, fileCloses: 0, bytesRead: 0, playbackYieldCount: 0, playbackYieldDurationMs: 0 }
}

class RootScanFailure extends Error {
  constructor(
    readonly filesystemCode: string,
    readonly diagnostics: VideoLibraryDiagnostic[],
    readonly unreadableCodes: Set<string>,
    readonly invalidFilenameCount = 0,
    readonly unreadableFileCount = 0
  ) {
    super(filesystemCode)
    this.name = 'RootScanFailure'
  }
}

const INITIAL_COUNTS: VideoLibraryCounts = {
  availableCodes: 0,
  ambiguousCodes: 0,
  missingCodes: 0,
  unreadableCodes: 0,
  unknownCodes: 0,
  indexedFiles: 0,
  invalidFilenames: 0,
  unreadableFiles: 0
}
const MAX_RETAINED_DIAGNOSTICS = 2000

function rootIdentity(root: string): string {
  const normalized = path.normalize(path.resolve(root))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function pathIdentity(filePath: string): string {
  const normalized = path.normalize(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function filesystemCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 40)
  }
  return 'FILESYSTEM_ERROR'
}

function isLinkOrReparsePoint(stats: fs.Stats | fs.BigIntStats): boolean {
  const attributes = (stats as fs.Stats & { attributes?: number }).attributes ?? 0
  return stats.isSymbolicLink() || (process.platform === 'win32' && (attributes & 0x400) !== 0)
}

function bigintStatsSize(stats: fs.BigIntStats): number | undefined {
  const size = Number(stats.size)
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}

function bigintStatsMtimeMs(stats: fs.BigIntStats): number {
  return Number(stats.mtimeNs) / 1_000_000
}

function countsFromItems(items: VideoLibraryInventoryItem[], invalidFilenames: number, unreadableFiles: number): VideoLibraryCounts {
  const counts = { ...INITIAL_COUNTS, invalidFilenames, unreadableFiles }
  for (const item of items) {
    counts.indexedFiles += item.candidateCount
    switch (item.availability) {
      case 'available': counts.availableCodes++; break
      case 'ambiguous': counts.ambiguousCodes++; break
      case 'missing': counts.missingCodes++; break
      case 'unreadable': counts.unreadableCodes++; break
      case 'unknown': counts.unknownCodes++; break
    }
  }
  return counts
}

function createRevision(
  scanStatus: VideoLibraryScanStatus,
  configuredRootCount: number,
  scannedRootCount: number,
  unavailableRootCount: number,
  items: VideoLibraryInventoryItem[]
): string {
  const publicState = {
    version: 1,
    scanStatus,
    configuredRootCount,
    scannedRootCount,
    unavailableRootCount,
    items: items.map(item => ({ ...item }))
  }
  return crypto.createHash('sha256').update(JSON.stringify(publicState)).digest('hex')
}

function errorIs(error: unknown, ...codes: string[]): boolean {
  return error !== null && typeof error === 'object' && 'code' in error &&
    typeof error.code === 'string' && codes.includes(error.code)
}

/** Main-process-only filesystem index. Its public inventory and diagnostics contain no absolute paths. */
export class VideoLibraryService {
  private rootPaths: readonly string[]
  private readonly rootIndexes = new Map<string, RootIndex>()
  private readonly knownCodes = new Set<string>()
  private publishedSnapshot: VideoLibrarySnapshot
  private diagnostics: VideoLibraryDiagnostic[] = []
  private scanInProgress = false
  private refreshRequested = false
  private refreshPromise: Promise<VideoLibrarySnapshot> | undefined
  private closed = false
  private scanMetrics = emptyScanMetrics()
  private readonly collectScanMetrics: boolean
  private readonly indexStore?: VideoLibraryIndexStore
  private readonly onIndexWriteError?: (error: unknown) => void
  private indexGeneration = 0
  private configurationEpoch = 0
  private playbackActive = false
  private readonly playbackWaiters = new Set<() => void>()
  private readonly snapshotListeners = new Set<(snapshot: VideoLibrarySnapshot) => void>()
  private readonly availability = new Map<string, VideoLibraryRootAvailability>()
  private availabilityEpoch = 0
  private probePromise: Promise<VideoLibrarySnapshot> | undefined
  private scanSequence = 0

  constructor(roots: unknown, options: VideoLibraryServiceOptions = {}) {
    this.rootPaths = Object.freeze(normalizeVideoLibraryRoots(roots))
    this.collectScanMetrics = options.collectScanMetrics === true
    this.indexStore = options.indexStore
    this.onIndexWriteError = options.onIndexWriteError
    const items: VideoLibraryInventoryItem[] = []
    const scanStatus: VideoLibraryScanStatus = 'not-scanned'
    this.publishedSnapshot = {
      version: 1,
      revision: createRevision(scanStatus, this.rootPaths.length, 0, 0, items),
      scanStatus,
      scannedAt: null,
      configuredRootCount: this.rootPaths.length,
      scannedRootCount: 0,
      unavailableRootCount: 0,
      counts: { ...INITIAL_COUNTS },
      items
    }
  }

  get roots(): readonly string[] { return this.rootPaths }

  /** Loads only a complete Main-owned cache; each selected file is still revalidated before playback. */
  async restorePersistentIndex(): Promise<'missing' | 'invalid' | 'stale' | 'restored' | 'unavailable'> {
    if (!this.indexStore) return 'missing'
    const result = await this.indexStore.read(this.rootPaths)
    if (result.status !== 'valid') return result.status
    this.restoreIndexDocument(result.index)
    this.notifySnapshotListeners()
    return 'restored'
  }

  subscribe(listener: (snapshot: VideoLibrarySnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  /** The playback owner marks active media so background reconciliation yields without timers. */
  setPlaybackActive(active: boolean): void {
    if (this.playbackActive === active) return
    this.playbackActive = active
    if (!active) {
      for (const resolve of this.playbackWaiters) resolve()
      this.playbackWaiters.clear()
    }
  }

  /** A published complete inventory remains usable while a newer generation is being scanned. */
  isInventoryRevisionPlayable(revision: string): boolean {
    return !this.closed && this.publishedSnapshot.scanStatus === 'ready' && this.publishedSnapshot.revision === revision
  }

  getAvailabilitySummary(): VideoLibraryAvailabilitySummary {
    const counts: VideoLibraryAvailabilitySummary = { epoch: this.availabilityEpoch,
      availableRoots: 0, unavailableRoots: 0, permissionDeniedRoots: 0, volumeMismatchRoots: 0, unknownRoots: 0 }
    for (const root of this.rootPaths) {
      const state = this.availability.get(rootIdentity(root)) ?? 'unknown'
      if (state === 'available') counts.availableRoots++
      else if (state === 'permission-denied') counts.permissionDeniedRoots++
      else if (state === 'volume-mismatch') counts.volumeMismatchRoots++
      else if (state === 'unavailable') counts.unavailableRoots++
      else counts.unknownRoots++
    }
    return counts
  }

  /** Probes roots only; cached file paths remain subject to per-playback validation. */
  probeAvailability(): Promise<VideoLibrarySnapshot> {
    if (this.closed) return Promise.resolve(this.getSnapshot())
    if (this.probePromise) return this.probePromise
    const roots = [...this.rootPaths]
    const configurationEpoch = this.configurationEpoch
    const scanSequence = this.scanSequence
    const inventoryRevision = this.publishedSnapshot.revision
    const operation = this.probeRoots(roots, configurationEpoch, scanSequence, inventoryRevision)
    const wrapped = operation.finally(() => {
      if (this.probePromise === wrapped) this.probePromise = undefined
    })
    this.probePromise = wrapped
    return wrapped
  }

  private async probeRoots(roots: readonly string[], configurationEpoch: number, scanSequence: number,
    inventoryRevision: string): Promise<VideoLibrarySnapshot> {
    const outcomes: Array<{ rootId: string; success: boolean; diagnostics: VideoLibraryDiagnostic[] }> = []
    let changed = false
    let reconnected = false
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      if (this.closed || configurationEpoch !== this.configurationEpoch) return this.getSnapshot()
      const configuredRoot = roots[rootIndex]
      const rootId = rootIdentity(configuredRoot)
      const previousState = this.availability.get(rootId) ?? 'unknown'
      let nextState: VideoLibraryRootAvailability = 'available'
      let filesystemError: string | undefined
      try {
        const canonicalRoot = await fs.promises.realpath(configuredRoot)
        const stats = await fs.promises.stat(canonicalRoot, { bigint: true })
        if (!stats.isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' })
        await fs.promises.access(canonicalRoot, fs.constants.R_OK)
        const cachedRoot = this.rootIndexes.get(rootId)
        if (cachedRoot && pathIdentity(cachedRoot.canonicalRoot) !== pathIdentity(canonicalRoot)) {
          nextState = 'volume-mismatch'
        } else if (cachedRoot) {
          const cachedDevices = new Set(cachedRoot.files.map(file => file.device))
          if (cachedDevices.size > 0 && !cachedDevices.has(stats.dev.toString())) nextState = 'volume-mismatch'
        }
      } catch (error) {
        filesystemError = filesystemCode(error)
        nextState = filesystemError === 'EACCES' || filesystemError === 'EPERM' ? 'permission-denied' : 'unavailable'
      }
      if (this.closed || configurationEpoch !== this.configurationEpoch) return this.getSnapshot()
      // A later scan publication invalidates the probe result that started against an older inventory.
      if (scanSequence !== this.scanSequence || inventoryRevision !== this.publishedSnapshot.revision) return this.getSnapshot()
      if (previousState !== nextState) {
        this.availabilityEpoch++
        this.availability.set(rootId, nextState)
        changed = true
        const current = this.rootIndexes.get(rootId)
        if (current) this.rootIndexes.set(rootId, { ...current, scanSucceeded: nextState === 'available' })
        if (previousState === 'unavailable' || previousState === 'permission-denied') reconnected ||= nextState === 'available'
      }
      outcomes.push({ rootId, success: nextState === 'available', diagnostics: nextState === 'available' ? [] : [{
        code: 'ROOT_UNAVAILABLE', rootIndex,
        filesystemCode: filesystemError ?? (nextState === 'volume-mismatch' ? 'VOLUME_IDENTITY_CHANGED' : 'EACCES')
      }] })
    }
    if (changed && !this.closed && configurationEpoch === this.configurationEpoch &&
        scanSequence === this.scanSequence && inventoryRevision === this.publishedSnapshot.revision) {
      const successfulRoots = outcomes.filter(outcome => outcome.success).length
      this.publishSnapshot(successfulRoots, outcomes.length - successfulRoots, outcomes)
      if (reconnected && !roots.some(root => this.availability.get(rootIdentity(root)) === 'volume-mismatch')) {
        void this.refresh().catch(() => undefined)
      }
    }
    return this.getSnapshot()
  }

  private async waitForBackgroundPermit(metrics?: VideoLibraryScanMetrics): Promise<boolean> {
    // An idle notification can be followed by another attempt before this waiter resumes.
    // Recheck instead of treating the notification itself as a lasting permit.
    while (this.playbackActive && !this.closed) {
      const startedAt = metrics ? performance.now() : 0
      if (metrics) metrics.playbackYieldCount++
      await new Promise<void>(resolve => this.playbackWaiters.add(resolve))
      if (metrics) metrics.playbackYieldDurationMs += Math.max(0, performance.now() - startedAt)
    }
    return !this.closed
  }

  private restoreIndexDocument(index: VideoLibraryIndexDocument): void {
    const rootIndexes = new Map<string, RootIndex>()
    const outcomes: Array<{ rootId: string; success: boolean; diagnostics: VideoLibraryDiagnostic[] }> = []
    index.roots.forEach((root, rootIndex) => {
      const rootId = rootIdentity(root.configuredPath)
      const files: IndexedVideo[] = root.entries.map(entry => {
        const absolutePath = path.resolve(root.canonicalRoot, entry.relativePath)
        return {
          rootId, rootIndex, configuredRoot: root.configuredPath, canonicalRoot: root.canonicalRoot,
          absolutePath, canonicalPath: absolutePath, relativePath: entry.relativePath,
          musicCode: entry.musicCode, device: entry.device, inode: entry.inode,
          size: entry.size, modifiedAt: entry.mtimeMs
        }
      })
      rootIndexes.set(rootId, { canonicalRoot: root.canonicalRoot, files, scanSucceeded: true, diagnostics: [], unreadableCodes: new Set(),
        invalidFilenameCount: 0, unreadableFileCount: 0 })
      outcomes.push({ rootId, success: true, diagnostics: [] })
    })
    this.rootIndexes.clear()
    for (const [id, value] of rootIndexes) this.rootIndexes.set(id, value)
    this.knownCodes.clear()
    for (const root of rootIndexes.values()) for (const file of root.files) this.knownCodes.add(file.musicCode)
    this.indexGeneration = index.generation
    this.publishSnapshot(outcomes.length, 0, outcomes, rootIndexes, index.scanCompletedAt)
  }

  /** Replacing roots invalidates an in-flight scan; callers persist configuration first. */
  async configureRoots(roots: unknown): Promise<VideoLibrarySnapshot> {
    if (this.closed) throw new Error('A biblioteca de vídeos já foi encerrada.')
    const nextRoots = Object.freeze(normalizeVideoLibraryRoots(roots))
    this.configurationEpoch++
    this.availabilityEpoch++
    this.availability.clear()
    this.rootPaths = nextRoots
    this.rootIndexes.clear()
    this.knownCodes.clear()
    this.diagnostics = []
    const items: VideoLibraryInventoryItem[] = []
    this.publishedSnapshot = {
      version: 1,
      revision: createRevision('not-scanned', nextRoots.length, 0, 0, items),
      scanStatus: 'not-scanned', scannedAt: null, configuredRootCount: nextRoots.length,
      scannedRootCount: 0, unavailableRootCount: 0, counts: { ...INITIAL_COUNTS }, items
    }
    this.notifySnapshotListeners()
    return this.refresh()
  }

  getSnapshot(): VideoLibrarySnapshot {
    const snapshot = this.publishedSnapshot
    return {
      ...snapshot,
      scanStatus: this.closed ? 'closed' : this.scanInProgress ? 'scanning' : snapshot.scanStatus,
      counts: { ...snapshot.counts },
      items: snapshot.items.map(item => ({ ...item }))
    }
  }

  getDiagnostics(): VideoLibraryDiagnostic[] {
    return this.diagnostics.map(diagnostic => ({
      ...diagnostic,
      conflictingPaths: diagnostic.conflictingPaths ? [...diagnostic.conflictingPaths] : undefined
    }))
  }

  /** Aggregate scan counters only; never includes paths, filenames, or music codes. */
  getScanMetrics(): VideoLibraryScanMetrics {
    return { ...this.scanMetrics }
  }

  /** Opt-in diagnostic snapshot for F0; it intentionally contains no inventory entries or paths. */
  getScanDiagnosticSnapshot(): VideoLibraryScanMetrics & {
    scanInProgress: boolean
    scanStatus: VideoLibraryScanStatus
  } {
    return {
      ...this.scanMetrics,
      scanInProgress: this.scanInProgress,
      scanStatus: this.scanInProgress ? 'scanning' : this.publishedSnapshot.scanStatus
    }
  }

  /** Concurrent requests coalesce into one follow-up scan, so a newer request cannot be lost. */
  refresh(): Promise<VideoLibrarySnapshot> {
    if (this.closed) return Promise.reject(new Error('A biblioteca de vídeos já foi encerrada.'))
    if (this.rootPaths.some(root => this.availability.get(rootIdentity(root)) === 'volume-mismatch')) {
      return Promise.resolve(this.getSnapshot())
    }
    this.refreshRequested = true
    if (!this.refreshPromise) this.refreshPromise = this.drainRefreshRequests()
    return this.refreshPromise
  }

  private async drainRefreshRequests(): Promise<VideoLibrarySnapshot> {
    try {
      while (this.refreshRequested && !this.closed) {
        this.refreshRequested = false
        await this.scanOnce()
      }
      return this.getSnapshot()
    } finally {
      this.refreshPromise = undefined
    }
  }

  private async scanOnce(): Promise<void> {
    this.scanSequence++
    const scanEpoch = this.configurationEpoch
    const scanRoots = this.rootPaths
    this.scanInProgress = true
    this.notifySnapshotListeners()
    const startedAt = this.collectScanMetrics ? performance.now() : 0
    const metrics = this.collectScanMetrics ? emptyScanMetrics() : undefined
    this.scanMetrics = metrics ?? emptyScanMetrics()
    const rootOutcomes: Array<{ rootId: string; success: boolean; diagnostics: VideoLibraryDiagnostic[] }> = []
    const nextRootIndexes = new Map(this.rootIndexes)
    let successfulRoots = 0

    try {
      for (let rootIndex = 0; rootIndex < scanRoots.length; rootIndex++) {
        if (this.closed || scanEpoch !== this.configurationEpoch) return
        if (!await this.waitForBackgroundPermit(metrics)) return
        const configuredRoot = scanRoots[rootIndex]
        const rootId = rootIdentity(configuredRoot)
        try {
          const result = await this.scanRoot(configuredRoot, rootId, rootIndex, nextRootIndexes.get(rootId), metrics, scanEpoch)
          if (!result || this.closed || scanEpoch !== this.configurationEpoch) return
          nextRootIndexes.set(rootId, {
            canonicalRoot: result.canonicalRoot,
            files: result.files,
            scanSucceeded: true,
            diagnostics: result.diagnostics,
            unreadableCodes: new Set(),
            invalidFilenameCount: result.invalidFilenameCount,
            unreadableFileCount: result.unreadableFileCount
          })
          rootOutcomes.push({ rootId, success: true, diagnostics: result.diagnostics })
          successfulRoots++
        } catch (error) {
          if (this.closed || scanEpoch !== this.configurationEpoch) return
          const previous = nextRootIndexes.get(rootId)
          const failure = error instanceof RootScanFailure
            ? error
            : new RootScanFailure(filesystemCode(error), [{
              code: 'ROOT_UNAVAILABLE', rootIndex, filesystemCode: filesystemCode(error)
            }], new Set())
          const rootDiagnostics = failure.diagnostics.length > 0 ? failure.diagnostics : [{
            code: 'ROOT_UNAVAILABLE' as const, rootIndex, filesystemCode: failure.filesystemCode
          }]
          nextRootIndexes.set(rootId, {
            canonicalRoot: previous?.canonicalRoot ?? configuredRoot,
            files: previous?.files ?? [],
            scanSucceeded: false,
            diagnostics: [...(previous?.diagnostics ?? []), ...rootDiagnostics].slice(0, MAX_RETAINED_DIAGNOSTICS),
            unreadableCodes: failure.unreadableCodes,
            invalidFilenameCount: previous?.invalidFilenameCount ?? failure.invalidFilenameCount,
            unreadableFileCount: failure.unreadableFileCount
          })
          rootOutcomes.push({ rootId, success: false, diagnostics: rootDiagnostics })
        }
      }

      // A private candidate can finish after playback becomes active. Keep the old
      // capability revision published until media is idle, then recheck all epochs.
      if (!await this.waitForBackgroundPermit(metrics)) return
      if (!this.closed && scanEpoch === this.configurationEpoch) {
        if (scanRoots.some(root => {
          const state = this.availability.get(rootIdentity(root))
          return state === 'unavailable' || state === 'permission-denied' || state === 'volume-mismatch'
        })) return
        for (const outcome of rootOutcomes) {
          const previous = this.availability.get(outcome.rootId) ?? 'unknown'
          const diagnosticCode = outcome.diagnostics[0]?.filesystemCode
          const next = outcome.success ? 'available'
            : diagnosticCode === 'EACCES' || diagnosticCode === 'EPERM' ? 'permission-denied' : 'unavailable'
          if (previous !== next) {
            this.availabilityEpoch++
            this.availability.set(outcome.rootId, next)
          }
        }
        this.rootIndexes.clear()
        for (const [id, value] of nextRootIndexes) this.rootIndexes.set(id, value)
        this.publishSnapshot(successfulRoots, scanRoots.length - successfulRoots, rootOutcomes, nextRootIndexes)
        if (successfulRoots === scanRoots.length && this.indexStore) {
          const roots = scanRoots.map(configuredPath => {
            const rootId = rootIdentity(configuredPath)
            const scanned = nextRootIndexes.get(rootId)
            return {
              configuredPath,
              canonicalRoot: scanned?.canonicalRoot ?? configuredPath,
              entries: (scanned?.files ?? []).map(file => ({ relativePath: file.relativePath,
                musicCode: file.musicCode, size: file.size, mtimeMs: file.modifiedAt,
                device: file.device, inode: file.inode }))
            }
          })
          try {
            const generation = this.indexGeneration + 1
            this.indexGeneration = generation
            const index = await this.indexStore.writeComplete({ generation,
              configuredRoots: scanRoots, roots })
            if (index.generation !== generation) throw new Error('VIDEO_LIBRARY_INDEX_GENERATION_MISMATCH')
          } catch (error) {
            this.onIndexWriteError?.(error)
          }
        }
      }
    } finally {
      if (metrics) metrics.durationMs = Math.max(0, performance.now() - startedAt)
      this.scanInProgress = false
      this.notifySnapshotListeners()
    }
  }

  private async scanRoot(configuredRoot: string, rootId: string, rootIndex: number, priorRoot: RootIndex | undefined,
    metrics: VideoLibraryScanMetrics | undefined, scanEpoch: number): Promise<RootScanResult | undefined> {
    let canonicalRoot: string
    let rootStats: fs.BigIntStats
    try {
      if (metrics) metrics.realpathCalls++
      canonicalRoot = await fs.promises.realpath(configuredRoot)
      if (metrics) metrics.statCalls++
      rootStats = await fs.promises.stat(canonicalRoot, { bigint: true })
      if (!rootStats.isDirectory()) {
        throw Object.assign(new Error('Configured root is not a directory.'), { code: 'ENOTDIR' })
      }
    } catch (error) {
      throw new RootScanFailure(filesystemCode(error), [{
        code: 'ROOT_UNAVAILABLE', rootIndex, filesystemCode: filesystemCode(error)
      }], new Set())
    }

    const files: IndexedVideo[] = []
    const cachedFiles = new Map((priorRoot && pathIdentity(priorRoot.canonicalRoot) === pathIdentity(canonicalRoot) ? priorRoot.files : [])
      .map(file => [pathIdentity(file.relativePath), file]))
    const diagnostics: VideoLibraryDiagnostic[] = []
    const unreadableCodes = new Set<string>()
    const visitedDirectories = new Set<string>([pathIdentity(canonicalRoot)])
    let failureCode: string | undefined
    let invalidFilenameCount = 0
    let unreadableFileCount = 0
    const pushDiagnostic = (diagnostic: VideoLibraryDiagnostic): void => {
      if (diagnostics.length < MAX_RETAINED_DIAGNOSTICS) diagnostics.push(diagnostic)
    }

    const visit = async (directoryPath: string, relativeDirectory: string): Promise<void> => {
      if (this.closed || scanEpoch !== this.configurationEpoch) return
      if (!await this.waitForBackgroundPermit(metrics)) return
      let entries: fs.Dirent[]
      try {
        if (metrics) metrics.directoriesEnumerated++
        entries = await fs.promises.readdir(directoryPath, { withFileTypes: true })
        if (metrics) metrics.entriesEnumerated += entries.length
      } catch (error) {
        failureCode ??= filesystemCode(error)
        pushDiagnostic({
          code: 'ROOT_UNAVAILABLE', rootIndex, relativePath: relativeDirectory || undefined,
          filesystemCode: filesystemCode(error)
        })
        return
      }
      if (!await this.waitForBackgroundPermit(metrics)) return
      entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

      for (const entry of entries) {
        if (this.closed || scanEpoch !== this.configurationEpoch) return
        if (!await this.waitForBackgroundPermit(metrics)) return
        if (entry.name === '.' || entry.name === '..') continue
        const absolutePath = path.join(directoryPath, entry.name)
        const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
        if (entry.isSymbolicLink()) {
          pushDiagnostic({ code: 'UNSAFE_ENTRY', rootIndex, relativePath })
          continue
        }

        let entryStats: fs.BigIntStats
        try {
          if (metrics) metrics.lstatCalls++
          entryStats = await fs.promises.lstat(absolutePath, { bigint: true })
        } catch (error) {
          failureCode ??= filesystemCode(error)
          pushDiagnostic({ code: 'UNSAFE_ENTRY', rootIndex, relativePath, filesystemCode: filesystemCode(error) })
          continue
        }
        if (isLinkOrReparsePoint(entryStats)) {
          pushDiagnostic({ code: 'UNSAFE_ENTRY', rootIndex, relativePath })
          continue
        }

        if (entryStats.isDirectory()) {
          if (entryStats.dev !== rootStats.dev) {
            pushDiagnostic({ code: 'UNSAFE_ENTRY', rootIndex, relativePath })
            continue
          }
          let canonicalDirectory: string
          try {
            if (metrics) metrics.realpathCalls++
            canonicalDirectory = await fs.promises.realpath(absolutePath)
          } catch (error) {
            failureCode ??= filesystemCode(error)
            pushDiagnostic({ code: 'UNSAFE_ENTRY', rootIndex, relativePath, filesystemCode: filesystemCode(error) })
            continue
          }
          if (!isWithinRoot(canonicalRoot, canonicalDirectory)) {
            pushDiagnostic({ code: 'UNSAFE_ENTRY', rootIndex, relativePath })
            continue
          }
          if (pathIdentity(canonicalDirectory) !== pathIdentity(path.resolve(absolutePath)) ||
              visitedDirectories.has(pathIdentity(canonicalDirectory))) {
            pushDiagnostic({ code: 'UNSAFE_ENTRY', rootIndex, relativePath })
            continue
          }
          visitedDirectories.add(pathIdentity(canonicalDirectory))
          await visit(absolutePath, relativePath)
          continue
        }

        if (!entryStats.isFile() || !isSupportedVideoExtension(entry.name)) continue
        if (metrics) metrics.candidateFiles++
        const musicCode = parseVideoCode(entry.name)
        if (!musicCode) {
          invalidFilenameCount++
          pushDiagnostic({ code: 'INVALID_FILENAME', rootIndex, relativePath })
          continue
        }

        const entrySize = bigintStatsSize(entryStats)
        if (entrySize === undefined) {
          unreadableCodes.add(musicCode)
          unreadableFileCount++
          pushDiagnostic({ code: 'UNREADABLE_FILE', rootIndex, musicCode, relativePath, filesystemCode: 'FILE_TOO_LARGE' })
          continue
        }
        const entryModifiedAt = bigintStatsMtimeMs(entryStats)
        const entryDevice = entryStats.dev.toString()
        const entryInode = entryStats.ino.toString()
        const cached = cachedFiles.get(pathIdentity(relativePath))
        if (cached && entryDevice === cached.device && entryInode !== '0' && cached.inode !== '0' &&
            entryInode === cached.inode && entrySize === cached.size && entryModifiedAt === cached.modifiedAt) {
          files.push({ ...cached, rootId, rootIndex, configuredRoot, canonicalRoot,
            absolutePath, canonicalPath: path.resolve(absolutePath), relativePath, musicCode })
          if (metrics) metrics.cacheHits++
          continue
        }

        let handle: fs.promises.FileHandle | undefined
        try {
          const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
          if (metrics) metrics.fileOpens++
          handle = await fs.promises.open(absolutePath, flags)
          if (metrics) metrics.statCalls++
          const openedStats = await handle.stat({ bigint: true })
          if (!openedStats.isFile()) throw Object.assign(new Error('Media candidate is not a regular file.'), { code: 'EINVAL' })
          if (metrics) metrics.realpathCalls++
          const canonicalPath = await fs.promises.realpath(absolutePath)
          if (metrics) metrics.lstatCalls++
          const currentStats = await fs.promises.lstat(absolutePath, { bigint: true })
          const expectedPath = path.resolve(absolutePath)
          if (isLinkOrReparsePoint(currentStats) || !isWithinRoot(canonicalRoot, canonicalPath) ||
              pathIdentity(canonicalPath) !== pathIdentity(expectedPath)) {
            throw Object.assign(new Error('Media candidate moved outside its configured root.'), { code: 'ELOOP' })
          }
          if (openedStats.dev !== entryStats.dev || (entryStats.ino !== 0n && openedStats.ino !== entryStats.ino) ||
              openedStats.size !== entryStats.size || openedStats.mtimeNs !== entryStats.mtimeNs ||
              currentStats.dev !== openedStats.dev || (openedStats.ino !== 0n && currentStats.ino !== openedStats.ino)) {
            throw Object.assign(new Error('Media candidate changed during indexing.'), { code: 'ESTALE' })
          }
          files.push({
            rootId,
            rootIndex,
            configuredRoot,
            canonicalRoot,
            absolutePath,
            canonicalPath,
            relativePath,
            musicCode,
            device: openedStats.dev.toString(),
            inode: openedStats.ino.toString(),
            size: entrySize,
            modifiedAt: entryModifiedAt
          })
        } catch (error) {
          failureCode ??= filesystemCode(error)
          unreadableCodes.add(musicCode)
          unreadableFileCount++
          pushDiagnostic({
            code: 'UNREADABLE_FILE', rootIndex, musicCode, relativePath,
            filesystemCode: filesystemCode(error)
          })
        } finally {
          if (handle) {
            try { await handle.close(); if (metrics) metrics.fileCloses++ } catch (error) {
              failureCode ??= filesystemCode(error)
              unreadableFileCount++
              pushDiagnostic({ code: 'UNREADABLE_FILE', rootIndex, musicCode, relativePath, filesystemCode: filesystemCode(error) })
            }
          }
        }
      }
    }

    await visit(canonicalRoot, '')
    if (failureCode) throw new RootScanFailure(failureCode, diagnostics, unreadableCodes, invalidFilenameCount, unreadableFileCount)
    return { canonicalRoot, files, diagnostics, invalidFilenameCount, unreadableFileCount }
  }

  private publishSnapshot(
    scannedRootCount: number,
    unavailableRootCount: number,
    rootOutcomes: Array<{ rootId: string; success: boolean; diagnostics: VideoLibraryDiagnostic[] }>,
    rootIndexes: Map<string, RootIndex> = this.rootIndexes,
    scannedAt = new Date().toISOString()
  ): void {
    const incomplete = unavailableRootCount > 0
    const allFiles = new Map<string, IndexedVideo & { fresh: boolean }>()
    const unreadableCodes = new Set<string>()
    const diagnosticList: VideoLibraryDiagnostic[] = []
    let invalidFilenameCount = 0
    let unreadableFileCount = 0

    for (const outcome of rootOutcomes) {
      const root = rootIndexes.get(outcome.rootId)
      if (!root) continue
      for (const diagnostic of outcome.diagnostics) diagnosticList.push(diagnostic)
      invalidFilenameCount += root.invalidFilenameCount
      unreadableFileCount += root.unreadableFileCount
      for (const code of root.unreadableCodes) unreadableCodes.add(code)
      for (const file of root.files) {
        const key = pathIdentity(file.canonicalPath)
        const existing = allFiles.get(key)
        if (existing) {
          existing.fresh ||= outcome.success
        } else {
          allFiles.set(key, { ...file, fresh: outcome.success })
        }
      }
    }

    const groups = new Map<string, Array<IndexedVideo & { fresh: boolean }>>()
    for (const file of allFiles.values()) {
      const group = groups.get(file.musicCode) ?? []
      group.push(file)
      groups.set(file.musicCode, group)
      this.knownCodes.add(file.musicCode)
    }
    for (const code of unreadableCodes) this.knownCodes.add(code)

    const items: VideoLibraryInventoryItem[] = []
    const sortedCodes = [...this.knownCodes].sort()
    for (const musicCode of sortedCodes) {
      const records = groups.get(musicCode) ?? []
      const freshCount = records.filter(record => record.fresh).length
      let availability: VideoAvailability
      if (freshCount > 1) availability = 'ambiguous'
      else if (records.length === 0 && unreadableCodes.has(musicCode)) availability = 'unreadable'
      else if (incomplete || records.some(record => !record.fresh)) availability = 'unknown'
      else if (freshCount === 1) availability = 'available'
      else availability = 'missing'

      items.push({ musicCode, availability, candidateCount: records.length })
      if (availability === 'ambiguous') {
        const conflictingPaths = records.map(record => `${record.rootIndex}:${record.relativePath}`)
          .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        diagnosticList.push({ code: 'DUPLICATE_CODE', rootIndex: records[0]?.rootIndex ?? 0, musicCode, conflictingPaths })
      }
    }

    const scanStatus: VideoLibraryScanStatus = incomplete ? 'degraded' : 'ready'
    const counts = countsFromItems(items, invalidFilenameCount, unreadableFileCount)
    const revision = createRevision(scanStatus, this.rootPaths.length, scannedRootCount, unavailableRootCount, items)
    this.diagnostics = diagnosticList.slice(0, MAX_RETAINED_DIAGNOSTICS)
    this.publishedSnapshot = {
      version: 1,
      revision,
      scanStatus,
      scannedAt,
      configuredRootCount: this.rootPaths.length,
      scannedRootCount,
      unavailableRootCount,
      counts,
      items
    }
    this.notifySnapshotListeners()
  }

  private notifySnapshotListeners(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.snapshotListeners) {
      try { listener(snapshot) } catch { /* Observers cannot interrupt library publication. */ }
    }
  }

  async lookup(value: unknown): Promise<VideoLookupResult> {
    const opened = await this.openForPlayback(value)
    if (opened.status !== 'available') return opened
    try {
      return { status: 'available', musicCode: opened.musicCode, filePath: opened.filePath }
    } finally {
      await opened.handle.close().catch(() => undefined)
    }
  }

  /** Opens only the unique indexed candidate and retains its validated handle for the media stream. */
  async openForPlayback(value: unknown, expectedRevision?: string): Promise<VideoMediaOpenResult> {
    if (!isCanonicalVideoCode(value)) {
      return { status: 'invalid-code', musicCode: typeof value === 'string' ? value.slice(0, 5) : '' }
    }
    const musicCode = value
    const snapshot = this.publishedSnapshot
    if (this.closed || snapshot.scanStatus === 'not-scanned' || snapshot.scanStatus === 'closed' ||
        (expectedRevision !== undefined && expectedRevision !== snapshot.revision)) {
      return { status: 'unknown', musicCode }
    }
    const item = snapshot.items.find(candidate => candidate.musicCode === musicCode)
    if (!item) return { status: snapshot.scanStatus === 'degraded' ? 'unknown' : 'missing', musicCode }
    if (snapshot.scanStatus !== 'ready') {
      return { status: item.availability === 'available' ? 'unknown' : item.availability, musicCode }
    }
    if (item.availability !== 'available') {
      return { status: item.availability, musicCode }
    }

    const records = [...this.rootIndexes.values()].flatMap(root => root.scanSucceeded ? root.files : [])
      .filter(file => file.musicCode === musicCode)
    const uniqueRecords = [...new Map(records.map(file => [pathIdentity(file.canonicalPath), file])).values()]
    if (uniqueRecords.length !== 1) return { status: uniqueRecords.length > 1 ? 'ambiguous' : 'unknown', musicCode }
    const file = uniqueRecords[0]

    let handle: fs.promises.FileHandle | undefined
    try {
      const canonicalRoot = await fs.promises.realpath(file.configuredRoot)
      if (pathIdentity(canonicalRoot) !== pathIdentity(file.canonicalRoot)) return { status: 'unknown', musicCode }
      const rootStats = await fs.promises.stat(canonicalRoot, { bigint: true })
      if (!rootStats.isDirectory()) return { status: 'missing', musicCode }
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
      handle = await fs.promises.open(file.absolutePath, flags)
      const openedStats = await handle.stat({ bigint: true })
      if (!openedStats.isFile()) return { status: 'unknown', musicCode }
      const canonicalPath = await fs.promises.realpath(file.absolutePath)
      const currentStats = await fs.promises.lstat(file.absolutePath, { bigint: true })
      if (isLinkOrReparsePoint(currentStats) || !isWithinRoot(canonicalRoot, canonicalPath)) {
        return { status: 'unknown', musicCode }
      }
      const openedSize = bigintStatsSize(openedStats)
      if (pathIdentity(canonicalPath) !== pathIdentity(file.canonicalPath) ||
          openedStats.dev.toString() !== file.device || (file.inode !== '0' && openedStats.ino.toString() !== file.inode) ||
          openedSize !== file.size || bigintStatsMtimeMs(openedStats) !== file.modifiedAt) {
        return { status: 'unknown', musicCode }
      }
      if (this.closed || this.publishedSnapshot.revision !== snapshot.revision) {
        return { status: 'unknown', musicCode }
      }
      const result = {
        status: 'available' as const,
        musicCode,
        revision: snapshot.revision,
        extension: path.extname(file.canonicalPath).toLowerCase(),
        size: openedSize,
        filePath: file.canonicalPath,
        handle
      }
      handle = undefined
      return result
    } catch (error) {
      if (errorIs(error, 'ENOENT', 'ENOTDIR')) return { status: 'missing', musicCode }
      if (errorIs(error, 'EACCES', 'EPERM', 'EROFS')) return { status: 'unreadable', musicCode }
      return { status: 'unknown', musicCode }
    } finally {
      if (handle) {
        try { await handle.close() } catch {}
      }
    }
  }

  close(): void {
    this.closed = true
    this.configurationEpoch++
    this.availabilityEpoch++
    this.refreshRequested = false
    for (const resolve of this.playbackWaiters) resolve()
    this.playbackWaiters.clear()
    this.notifySnapshotListeners()
  }
}
