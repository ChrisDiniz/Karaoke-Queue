import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
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

interface IndexedVideo {
  rootId: string
  rootIndex: number
  configuredRoot: string
  canonicalRoot: string
  absolutePath: string
  canonicalPath: string
  relativePath: string
  musicCode: string
  device: number
  inode: number
  size: number
  modifiedAt: number
}

interface RootIndex {
  files: IndexedVideo[]
  scanSucceeded: boolean
  diagnostics: VideoLibraryDiagnostic[]
  unreadableCodes: Set<string>
  invalidFilenameCount: number
  unreadableFileCount: number
}

interface RootScanResult {
  files: IndexedVideo[]
  diagnostics: VideoLibraryDiagnostic[]
  invalidFilenameCount: number
  unreadableFileCount: number
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

function isLinkOrReparsePoint(stats: fs.Stats): boolean {
  const attributes = (stats as fs.Stats & { attributes?: number }).attributes ?? 0
  return stats.isSymbolicLink() || (process.platform === 'win32' && (attributes & 0x400) !== 0)
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

  constructor(roots: unknown) {
    this.rootPaths = Object.freeze(normalizeVideoLibraryRoots(roots))
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

  /** Replaces configured roots only between scans; callers persist the new configuration first. */
  async configureRoots(roots: unknown): Promise<VideoLibrarySnapshot> {
    if (this.closed) throw new Error('A biblioteca de vídeos já foi encerrada.')
    if (this.scanInProgress || this.refreshPromise) throw new Error('VIDEO_LIBRARY_BUSY')
    const nextRoots = Object.freeze(normalizeVideoLibraryRoots(roots))
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

  /** Concurrent requests coalesce into one follow-up scan, so a newer request cannot be lost. */
  refresh(): Promise<VideoLibrarySnapshot> {
    if (this.closed) return Promise.reject(new Error('A biblioteca de vídeos já foi encerrada.'))
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
    this.scanInProgress = true
    const rootOutcomes: Array<{ rootId: string; success: boolean; diagnostics: VideoLibraryDiagnostic[] }> = []
    let successfulRoots = 0

    try {
      for (let rootIndex = 0; rootIndex < this.rootPaths.length; rootIndex++) {
        if (this.closed) return
        const configuredRoot = this.rootPaths[rootIndex]
        const rootId = rootIdentity(configuredRoot)
        try {
          const result = await this.scanRoot(configuredRoot, rootId, rootIndex)
          this.rootIndexes.set(rootId, {
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
          const previous = this.rootIndexes.get(rootId)
          const failure = error instanceof RootScanFailure
            ? error
            : new RootScanFailure(filesystemCode(error), [{
              code: 'ROOT_UNAVAILABLE', rootIndex, filesystemCode: filesystemCode(error)
            }], new Set())
          const rootDiagnostics = failure.diagnostics.length > 0 ? failure.diagnostics : [{
            code: 'ROOT_UNAVAILABLE' as const, rootIndex, filesystemCode: failure.filesystemCode
          }]
          this.rootIndexes.set(rootId, {
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

      if (!this.closed) this.publishSnapshot(successfulRoots, this.rootPaths.length - successfulRoots, rootOutcomes)
    } finally {
      this.scanInProgress = false
    }
  }

  private async scanRoot(configuredRoot: string, rootId: string, rootIndex: number): Promise<RootScanResult> {
    let canonicalRoot: string
    let rootStats: fs.Stats
    try {
      canonicalRoot = await fs.promises.realpath(configuredRoot)
      rootStats = await fs.promises.stat(canonicalRoot)
      if (!rootStats.isDirectory()) {
        throw Object.assign(new Error('Configured root is not a directory.'), { code: 'ENOTDIR' })
      }
    } catch (error) {
      throw new RootScanFailure(filesystemCode(error), [{
        code: 'ROOT_UNAVAILABLE', rootIndex, filesystemCode: filesystemCode(error)
      }], new Set())
    }

    const files: IndexedVideo[] = []
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
      if (this.closed) return
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(directoryPath, { withFileTypes: true })
      } catch (error) {
        failureCode ??= filesystemCode(error)
        pushDiagnostic({
          code: 'ROOT_UNAVAILABLE', rootIndex, relativePath: relativeDirectory || undefined,
          filesystemCode: filesystemCode(error)
        })
        return
      }
      entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

      for (const entry of entries) {
        if (this.closed) return
        if (entry.name === '.' || entry.name === '..') continue
        const absolutePath = path.join(directoryPath, entry.name)
        const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
        if (entry.isSymbolicLink()) {
          pushDiagnostic({ code: 'UNSAFE_ENTRY', rootIndex, relativePath })
          continue
        }

        let entryStats: fs.Stats
        try {
          entryStats = await fs.promises.lstat(absolutePath)
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
        const musicCode = parseVideoCode(entry.name)
        if (!musicCode) {
          invalidFilenameCount++
          pushDiagnostic({ code: 'INVALID_FILENAME', rootIndex, relativePath })
          continue
        }

        let handle: fs.promises.FileHandle | undefined
        try {
          const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
          handle = await fs.promises.open(absolutePath, flags)
          const openedStats = await handle.stat()
          if (!openedStats.isFile()) throw Object.assign(new Error('Media candidate is not a regular file.'), { code: 'EINVAL' })
          const canonicalPath = await fs.promises.realpath(absolutePath)
          const currentStats = await fs.promises.lstat(absolutePath)
          const expectedPath = path.resolve(absolutePath)
          if (isLinkOrReparsePoint(currentStats) || !isWithinRoot(canonicalRoot, canonicalPath) ||
              pathIdentity(canonicalPath) !== pathIdentity(expectedPath)) {
            throw Object.assign(new Error('Media candidate moved outside its configured root.'), { code: 'ELOOP' })
          }
          if (openedStats.dev !== entryStats.dev || (entryStats.ino !== 0 && openedStats.ino !== entryStats.ino) ||
              currentStats.dev !== openedStats.dev || (openedStats.ino !== 0 && currentStats.ino !== openedStats.ino)) {
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
            device: openedStats.dev,
            inode: openedStats.ino,
            size: openedStats.size,
            modifiedAt: openedStats.mtimeMs
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
            try { await handle.close() } catch (error) {
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
    return { files, diagnostics, invalidFilenameCount, unreadableFileCount }
  }

  private publishSnapshot(
    scannedRootCount: number,
    unavailableRootCount: number,
    rootOutcomes: Array<{ rootId: string; success: boolean; diagnostics: VideoLibraryDiagnostic[] }>
  ): void {
    const incomplete = unavailableRootCount > 0
    const allFiles = new Map<string, IndexedVideo & { fresh: boolean }>()
    const unreadableCodes = new Set<string>()
    const diagnosticList: VideoLibraryDiagnostic[] = []
    let invalidFilenameCount = 0
    let unreadableFileCount = 0

    for (const outcome of rootOutcomes) {
      const root = this.rootIndexes.get(outcome.rootId)
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
      scannedAt: new Date().toISOString(),
      configuredRootCount: this.rootPaths.length,
      scannedRootCount,
      unavailableRootCount,
      counts,
      items
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
    if (this.closed || this.scanInProgress || snapshot.scanStatus === 'not-scanned' || snapshot.scanStatus === 'closed' ||
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
      const rootStats = await fs.promises.stat(canonicalRoot)
      if (!rootStats.isDirectory()) return { status: 'missing', musicCode }
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
      handle = await fs.promises.open(file.absolutePath, flags)
      const openedStats = await handle.stat()
      if (!openedStats.isFile()) return { status: 'unknown', musicCode }
      const canonicalPath = await fs.promises.realpath(file.absolutePath)
      const currentStats = await fs.promises.lstat(file.absolutePath)
      if (isLinkOrReparsePoint(currentStats) || !isWithinRoot(canonicalRoot, canonicalPath)) {
        return { status: 'unknown', musicCode }
      }
      if (pathIdentity(canonicalPath) !== pathIdentity(file.canonicalPath) ||
          openedStats.dev !== file.device || (file.inode !== 0 && openedStats.ino !== file.inode) ||
          openedStats.size !== file.size || openedStats.mtimeMs !== file.modifiedAt) {
        return { status: 'unknown', musicCode }
      }
      if (this.closed || this.scanInProgress || this.publishedSnapshot.revision !== snapshot.revision) {
        return { status: 'unknown', musicCode }
      }
      const result = {
        status: 'available' as const,
        musicCode,
        revision: snapshot.revision,
        extension: path.extname(file.canonicalPath).toLowerCase(),
        size: openedStats.size,
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
    this.refreshRequested = false
  }
}
