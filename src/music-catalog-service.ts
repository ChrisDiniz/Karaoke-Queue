import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MusicCatalogError,
  MAX_MUSIC_CATALOG_FILE_BYTES,
  normalizeCatalogCodeForVideoMatch,
  normalizeMusicCatalogSearchText,
  parseMusicCatalogCsv,
  parseMusicCatalogCsvWithRecoverableIssues,
  type MusicCatalogDatabaseQuery,
  type MusicCatalogImportIssue,
  type MusicCatalogImportIssuePage,
  type MusicCatalogMetadata,
  type MusicCatalogRepository,
  type MusicCatalogRecord,
  type MusicCatalogWarning,
  type ParsedMusicCatalog,
  type ParsedMusicCatalogWithIssues
} from './music-catalog'
import type {
  VideoAvailability,
  VideoLibraryScanStatus,
  VideoLibrarySnapshot,
  VideoLookupResult
} from './video-library'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const MAX_PAGE_OFFSET = 1_000_000

export interface VideoInventoryProvider {
  getSnapshot(): VideoLibrarySnapshot
  lookup(musicCode: unknown): Promise<VideoLookupResult>
}

export interface MusicCatalogSearchOptions {
  limit?: number
  offset?: number
}

export interface MusicCatalogLibraryItem {
  musicNumber: string | null
  videoCode: string
  artist: string | null
  title: string | null
  metadataAvailable: boolean
  videoAvailability: VideoAvailability
}

export interface MusicCatalogSearchPage {
  catalogRevision: string | null
  inventoryRevision: string | null
  inventoryStatus: VideoLibraryScanStatus | 'unavailable'
  total: number
  offset: number
  limit: number
  hasMore: boolean
  items: MusicCatalogLibraryItem[]
}

export interface MusicCatalogImportResult {
  revision: string
  recordCount: number
  missingArtistCount: number
  missingTitleCount: number
  warningCount: number
  warnings: MusicCatalogWarning[]
  importedAt: string
}

export type MusicCatalogImportPreparation =
  | { readonly outcome: 'imported'; readonly result: MusicCatalogImportResult }
  | {
      readonly outcome: 'confirmation-required'
      readonly token: string
      readonly recordCount: number
      readonly issueCount: number
      readonly currentRecordCount: number
    }

export interface MusicCatalogConfirmedPartialImport {
  readonly revision: string
  readonly recordCount: number
  readonly issueCount: number
  readonly importedAt: string
}

interface PreparedStandaloneCatalogImport {
  readonly token: string
  readonly expectedGeneration: number
  readonly expectedRevision: string | null
  readonly transientReport: boolean
  readonly filePath: string
  readonly parsed: ParsedMusicCatalogWithIssues
}

export interface MusicCatalogMetadataPreview {
  readonly catalogRevision: string | null
  readonly title: string | null
  readonly artist: string | null
}

function isLinkOrReparsePoint(stats: fs.Stats | fs.BigIntStats): boolean {
  const attributes = (stats as (fs.Stats | fs.BigIntStats) & { attributes?: number }).attributes ?? 0
  return stats.isSymbolicLink() || (process.platform === 'win32' && (attributes & 0x400) !== 0)
}

function normalizedPathIdentity(filePath: string): string {
  const normalized = path.normalize(filePath)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function catalogSourceName(filePath: unknown): string | null {
  if (typeof filePath !== 'string') return null
  const name = path.basename(filePath).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255).trim()
  return name || null
}

function sameFileVersion(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function readSelectedCatalog(filePath: unknown): Promise<Buffer> {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    throw new MusicCatalogError('INVALID_INPUT', 'O arquivo do catálogo precisa ser selecionado por um caminho absoluto válido.')
  }

  const selectedPath = path.resolve(filePath)
  let handle: fs.promises.FileHandle | undefined
  try {
    const before = await fs.promises.lstat(selectedPath, { bigint: true })
    if (isLinkOrReparsePoint(before) || !before.isFile()) {
      throw new MusicCatalogError('UNSAFE_FILE', 'O catálogo precisa ser um arquivo regular local.')
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
    handle = await fs.promises.open(selectedPath, flags)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || isLinkOrReparsePoint(before) ||
        (opened.dev !== before.dev || (before.ino !== 0n && opened.ino !== before.ino))) {
      throw new MusicCatalogError('UNSAFE_FILE', 'O arquivo selecionado mudou durante a abertura.')
    }
    if (opened.size > BigInt(MAX_MUSIC_CATALOG_FILE_BYTES)) {
      throw new MusicCatalogError('FILE_TOO_LARGE', 'O arquivo CSV excede o limite de 32 MiB.')
    }
    const canonicalPath = await fs.promises.realpath(selectedPath)
    if (normalizedPathIdentity(canonicalPath) !== normalizedPathIdentity(selectedPath)) {
      throw new MusicCatalogError('UNSAFE_FILE', 'O caminho selecionado atravessa um link ou atalho de filesystem.')
    }

    const chunks: Buffer[] = []
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let totalBytes = 0
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > MAX_MUSIC_CATALOG_FILE_BYTES) {
        throw new MusicCatalogError('FILE_TOO_LARGE', 'O arquivo CSV excede o limite de 32 MiB.')
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
    }
    const afterRead = await handle.stat({ bigint: true })
    const currentPath = await fs.promises.lstat(selectedPath, { bigint: true })
    if (!sameFileVersion(opened, afterRead) || isLinkOrReparsePoint(currentPath) ||
        currentPath.dev !== opened.dev || (opened.ino !== 0n && currentPath.ino !== opened.ino)) {
      throw new MusicCatalogError('FILE_CHANGED', 'O arquivo CSV mudou durante a leitura. Selecione novamente uma cópia estável do catálogo.')
    }
    return Buffer.concat(chunks, totalBytes)
  } catch (error) {
    if (error instanceof MusicCatalogError) throw error
    throw new MusicCatalogError('FILE_READ_FAILED', 'Não foi possível ler o arquivo CSV selecionado. Verifique se ele ainda está disponível e acessível.')
  } finally {
    if (handle) {
      try { await handle.close() } catch {}
    }
  }
}

function validatePage(options: MusicCatalogSearchOptions): { limit: number; offset: number } {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE
  const offset = options.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) {
    throw new MusicCatalogError('INVALID_SEARCH_QUERY', `A paginação deve usar limite entre 1 e ${MAX_PAGE_SIZE} e deslocamento válido.`)
  }
  return { limit, offset }
}

function availabilityForCode(
  code: string,
  snapshot: VideoLibrarySnapshot | undefined
): { revision: string | null; status: VideoLibraryScanStatus | 'unavailable'; availability: VideoAvailability } {
  if (!snapshot) return { revision: null, status: 'unavailable', availability: 'unknown' }

  if (snapshot.scanStatus === 'scanning' || snapshot.scanStatus === 'not-scanned' || snapshot.scanStatus === 'closed') {
    return { revision: snapshot.revision, status: snapshot.scanStatus, availability: 'unknown' }
  }
  const item = snapshot.items.find(candidate => candidate.musicCode === code)
  if (item) return { revision: snapshot.revision, status: snapshot.scanStatus, availability: item.availability }
  if (snapshot.scanStatus === 'ready') {
    return { revision: snapshot.revision, status: snapshot.scanStatus, availability: 'missing' }
  }
  return { revision: snapshot.revision, status: snapshot.scanStatus, availability: 'unknown' }
}

function itemFromRecord(
  record: MusicCatalogRecord,
  snapshot: VideoLibrarySnapshot | undefined
): { item: MusicCatalogLibraryItem; inventoryRevision: string | null; inventoryStatus: VideoLibraryScanStatus | 'unavailable' } {
  const inventory = availabilityForCode(record.videoCode, snapshot)
  return {
    item: {
      musicNumber: record.musicNumber,
      videoCode: record.videoCode,
      artist: record.artist,
      title: record.title,
      metadataAvailable: record.artist !== null || record.title !== null,
      videoAvailability: inventory.availability
    },
    inventoryRevision: inventory.revision,
    inventoryStatus: inventory.status
  }
}

function videoCodeForLookup(value: unknown): string {
  if (typeof value === 'string' && /^[0-9]{5}$/.test(value)) return value
  return normalizeCatalogCodeForVideoMatch(value)
}

/** Main-process catalog orchestration; storage remains on the Controller's existing SQLite handle. */
export class MusicCatalogService {
  private importTail: Promise<void> = Promise.resolve()
  private pendingImports = 0
  private closing = false
  private closePromise: Promise<void> | undefined
  private welcomeIssues: readonly MusicCatalogImportIssue[] = []
  private preparedStandaloneImport: PreparedStandaloneCatalogImport | undefined
  private readonly revisionListeners = new Set<(revision: string | null) => void>()

  constructor(
    private readonly repository: MusicCatalogRepository,
    private readonly inventoryProvider?: VideoInventoryProvider
  ) {}

  getMetadata(): MusicCatalogMetadata {
    this.ensureOpen()
    return this.repository.getMusicCatalogMetadata()
  }

  /** Exact metadata-only lookup. It does not consult video inventory or decide playback availability. */
  lookupMetadataByVideoCode(value: unknown): MusicCatalogMetadataPreview {
    this.ensureOpen()
    const videoCode = videoCodeForLookup(value)
    const result = this.repository.getMusicCatalogRecordByVideoCode(videoCode)
    return {
      catalogRevision: result.metadata.revision,
      title: result.record?.title ?? null,
      artist: result.record?.artist ?? null
    }
  }

  /** Notifies active UI previews after a catalog replacement has committed. */
  subscribeToMetadataRevision(listener: (revision: string | null) => void): () => void {
    this.ensureOpen()
    if (typeof listener !== 'function') throw new TypeError('O listener da revisão do catálogo precisa ser uma função.')
    this.revisionListeners.add(listener)
    return () => this.revisionListeners.delete(listener)
  }

  importFile(filePath: unknown): Promise<MusicCatalogImportResult> {
    return this.enqueueImport(async () => {
      if (this.preparedStandaloneImport) {
        throw new MusicCatalogError('CATALOG_IMPORT_BUSY', 'Há uma confirmação de catálogo pendente.')
      }
      return this.performImport(filePath)
    })
  }

  /** Prepares a Standalone replacement; only invalid music-number rows may be skipped. */
  prepareStandaloneImport(filePath: unknown, transientReport = false): Promise<MusicCatalogImportPreparation> {
    return this.enqueueImport(async () => {
      if (this.preparedStandaloneImport) {
        throw new MusicCatalogError('CATALOG_IMPORT_BUSY', 'Há uma confirmação de catálogo pendente.')
      }
      if (!transientReport && (!this.repository.replaceMusicCatalogWithImportIssues || !this.repository.getMusicCatalogImportIssuePage)) {
        throw new MusicCatalogError('DATABASE_FAILURE', 'O relatório de importação parcial não está disponível neste armazenamento de catálogo.')
      }
      const bytes = await readSelectedCatalog(filePath)
      const parsed = parseMusicCatalogCsvWithRecoverableIssues(bytes)
      const current = this.repository.getMusicCatalogMetadata()
      if (parsed.issues.length === 0) {
        this.welcomeIssues = []
        const result = this.commitCatalog(parsed, filePath)
        return { outcome: 'imported', result }
      }
      const currentReport = this.repository.getMusicCatalogImportIssuePage?.(0, 1)
      const token = randomUUID()
      this.preparedStandaloneImport = {
        token,
        expectedGeneration: currentReport?.generation ?? 0,
        expectedRevision: current.revision, transientReport,
        filePath: filePath as string,
        parsed
      }
      return {
        outcome: 'confirmation-required',
        token,
        recordCount: parsed.recordCount,
        issueCount: parsed.issues.length,
        currentRecordCount: current.recordCount
      }
    })
  }

  /** Atomically commits a staged partial import only if the catalog has not changed since preview. */
  confirmStandaloneImport(token: unknown): Promise<MusicCatalogConfirmedPartialImport> {
    return this.enqueueImport(async () => {
      const prepared = this.preparedStandaloneImport
      if (!prepared || typeof token !== 'string' || token !== prepared.token) {
        throw new MusicCatalogError('CATALOG_REPORT_STALE', 'A confirmação de importação não está mais disponível.')
      }
      const replace = this.repository.replaceMusicCatalogWithImportIssues
      if (!replace && !prepared.transientReport) throw new MusicCatalogError('DATABASE_FAILURE', 'O armazenamento não aceita relatórios de importação.')
      const importedAt = new Date().toISOString()
      try {
        if (replace) replace.call(this.repository, prepared.parsed.records, {
          revision: prepared.parsed.revision,
          importedAt,
          sourceName: catalogSourceName(prepared.filePath)
          }, prepared.parsed.issues, prepared.expectedGeneration)
        else this.repository.replaceMusicCatalog(prepared.parsed.records, {
          revision: prepared.parsed.revision, importedAt, sourceName: catalogSourceName(prepared.filePath)
        }, prepared.expectedRevision)
      } catch (error) {
        if (error instanceof MusicCatalogError && error.code === 'CATALOG_CHANGED_DURING_CONFIRMATION') {
          this.preparedStandaloneImport = undefined
        }
        throw error
      }
      const committed = this.repository.getMusicCatalogMetadata()
      if (committed.revision !== prepared.parsed.revision || committed.recordCount !== prepared.parsed.recordCount) {
        throw new MusicCatalogError('DATABASE_FAILURE', 'A importação não confirmou a nova revisão do catálogo.')
      }
      this.welcomeIssues = prepared.parsed.issues
      this.preparedStandaloneImport = undefined
      this.publishRevision(committed.revision)
      return {
        revision: committed.revision,
        recordCount: committed.recordCount,
        issueCount: prepared.parsed.issues.length,
        importedAt: committed.importedAt ?? importedAt
      }
    })
  }

  cancelStandaloneImport(token: unknown): boolean {
    this.ensureOpen()
    const prepared = this.preparedStandaloneImport
    if (!prepared || typeof token !== 'string' || token !== prepared.token) return false
    this.preparedStandaloneImport = undefined
    return true
  }

  getWelcomeImportIssues(offset = 0, limit = 50): { total: number; offset: number; issues: MusicCatalogImportIssue[] } {
    this.ensureOpen()
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('CATALOG_ISSUE_PAGE_INVALID')
    const issues = this.preparedStandaloneImport?.parsed.issues ?? this.welcomeIssues
    return { total: issues.length, offset, issues: issues.slice(offset, offset + limit).map(issue => ({ ...issue })) }
  }

  getStandaloneImportIssuePage(offset: number, limit: number): MusicCatalogImportIssuePage {
    this.ensureOpen()
    const getPage = this.repository.getMusicCatalogImportIssuePage
    if (!getPage) throw new MusicCatalogError('DATABASE_FAILURE', 'O relatório de importação não está disponível neste armazenamento de catálogo.')
    return getPage.call(this.repository, offset, limit)
  }

  private enqueueImport<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new MusicCatalogError('CATALOG_CLOSED', 'O serviço de catálogo está encerrando.'))
    const queued = this.pendingImports === 0 ? operation() : this.importTail.then(operation)
    this.pendingImports++
    this.importTail = queued.then(() => undefined, () => undefined).finally(() => {
      this.pendingImports--
    })
    return queued
  }

  private performImport(filePath: unknown): Promise<MusicCatalogImportResult> {
    return this.performStrictImport(filePath)
  }

  private async performStrictImport(filePath: unknown): Promise<MusicCatalogImportResult> {
    this.ensureOpen()
    const bytes = await readSelectedCatalog(filePath)
    const parsed = parseMusicCatalogCsv(bytes)
    return this.commitCatalog(parsed, filePath)
  }

  private commitCatalog(
    parsed: ParsedMusicCatalog,
    filePath: unknown
  ): MusicCatalogImportResult {
    const importedAt = new Date().toISOString()
    this.repository.replaceMusicCatalog(parsed.records, {
      revision: parsed.revision, importedAt, sourceName: catalogSourceName(filePath)
    })
    const committed = this.repository.getMusicCatalogMetadata()
    if (committed.revision !== parsed.revision || committed.recordCount !== parsed.recordCount) {
      throw new MusicCatalogError('DATABASE_FAILURE', 'A importação não confirmou a nova revisão do catálogo.')
    }
    this.publishRevision(committed.revision)
    return {
      revision: committed.revision,
      recordCount: committed.recordCount,
      missingArtistCount: parsed.missingArtistCount,
      missingTitleCount: parsed.missingTitleCount,
      warningCount: parsed.warningCount,
      warnings: parsed.warnings,
      importedAt: committed.importedAt ?? importedAt
    }
  }

  private publishRevision(revision: string | null): void {
    for (const listener of [...this.revisionListeners]) {
      try { listener(revision) } catch { /* A preview listener cannot roll back a committed catalog import. */ }
    }
  }

  search(query: unknown, options: MusicCatalogSearchOptions = {}): MusicCatalogSearchPage {
    this.ensureOpen()
    const normalizedText = normalizeMusicCatalogSearchText(query)
    const { limit, offset } = validatePage(options)
    const rawQuery = (query as string).trim()
    const isNumericQuery = /^[0-9]{1,5}$/.test(rawQuery)
    const databaseQuery: MusicCatalogDatabaseQuery = {
      originalCodePrefix: isNumericQuery && rawQuery[0] !== '0' ? rawQuery : null,
      videoCodePrefix: isNumericQuery ? rawQuery : null,
      normalizedText: isNumericQuery ? '' : normalizedText,
      limit,
      offset
    }
    const result = this.repository.searchMusicCatalog(databaseQuery)
    const snapshot = this.inventoryProvider?.getSnapshot()
    const mapped = result.records.map(record => itemFromRecord(record, snapshot))
    return {
      catalogRevision: result.metadata.revision,
      inventoryRevision: snapshot?.revision ?? null,
      inventoryStatus: snapshot?.scanStatus ?? 'unavailable',
      total: result.total,
      offset,
      limit,
      hasMore: offset + result.records.length < result.total,
      items: mapped.map(value => value.item)
    }
  }

  async lookupByVideoCode(value: unknown): Promise<MusicCatalogLibraryItem & {
    catalogRevision: string | null
    inventoryRevision: string | null
    inventoryStatus: VideoLibraryScanStatus | 'unavailable'
  }> {
    this.ensureOpen()
    const videoCode = videoCodeForLookup(value)
    const result = this.repository.getMusicCatalogRecordByVideoCode(videoCode)
    const snapshot = this.inventoryProvider?.getSnapshot()
    let inventory = availabilityForCode(videoCode, snapshot)
    if (snapshot?.scanStatus === 'ready' && this.inventoryProvider) {
      const lookup = await this.inventoryProvider.lookup(videoCode)
      const currentSnapshot = this.inventoryProvider.getSnapshot()
      inventory = currentSnapshot.revision === snapshot.revision && currentSnapshot.scanStatus === 'ready'
        ? { revision: snapshot.revision, status: snapshot.scanStatus, availability: lookup.status === 'invalid-code' ? 'unknown' : lookup.status }
        : { revision: currentSnapshot.revision, status: currentSnapshot.scanStatus, availability: 'unknown' }
    }
    return {
      musicNumber: result.record?.musicNumber ?? null,
      videoCode,
      artist: result.record?.artist ?? null,
      title: result.record?.title ?? null,
      metadataAvailable: result.record !== null && (result.record.artist !== null || result.record.title !== null),
      videoAvailability: inventory.availability,
      catalogRevision: result.metadata.revision,
      inventoryRevision: inventory.revision,
      inventoryStatus: inventory.status
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true
      this.closePromise = this.importTail.then(() => {
        this.preparedStandaloneImport = undefined
        this.revisionListeners.clear()
      })
    }
    return this.closePromise
  }

  private ensureOpen(): void {
    if (this.closing) throw new MusicCatalogError('CATALOG_CLOSED', 'O serviço de catálogo está encerrado.')
  }
}
