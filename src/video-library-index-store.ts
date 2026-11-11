import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { parseVideoCode } from './video-library'
import { normalizeVideoLibraryRoots } from './video-library-configuration'

export const VIDEO_LIBRARY_INDEX_FILENAME = 'video-library-index.json'
export const VIDEO_LIBRARY_INDEX_VERSION = 1
const PARSER_POLICY_VERSION = 1
const MAX_INDEX_BYTES = 64 * 1024 * 1024
const MAX_ROOTS = 32
const MAX_ENTRIES = 250_000
const MAX_RELATIVE_PATH_LENGTH = 32_768

export interface VideoLibraryIndexEntry {
  relativePath: string
  musicCode: string
  size: number
  mtimeMs: number
  /** Decimal strings preserve Windows 64-bit file identities without JSON number rounding. */
  device: string
  inode: string
}

export interface VideoLibraryIndexRoot {
  rootKey: string
  configuredPath: string
  canonicalRoot: string
  entries: VideoLibraryIndexEntry[]
}

export interface VideoLibraryIndexDocument {
  version: 1
  generation: number
  configurationFingerprint: string
  scanCompletedAt: string
  roots: VideoLibraryIndexRoot[]
}

export interface VideoLibraryIndexWriteInput {
  /** Main-owned generation; older generations are never allowed to replace newer ones. */
  generation: number
  configuredRoots: unknown
  roots: Array<{ configuredPath: string; canonicalRoot: string; entries: VideoLibraryIndexEntry[] }>
  scanCompletedAt?: string
}

export type VideoLibraryIndexReadResult =
  | { status: 'missing' }
  | { status: 'invalid'; reason: 'unreadable' | 'too-large' | 'invalid-utf8' | 'invalid-json' | 'invalid-record' | 'unsupported-version' }
  | { status: 'stale'; reason: 'configuration-mismatch' }
  | { status: 'valid'; index: VideoLibraryIndexDocument }

export class VideoLibraryIndexStoreError extends Error {
  constructor(readonly code: 'INVALID_INDEX' | 'STALE_GENERATION' | 'WRITE_FAILED', message: string) {
    super(message)
    this.name = 'VideoLibraryIndexStoreError'
  }
}

function identity(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function rootKey(configuredPath: string): string {
  return crypto.createHash('sha256').update(identity(configuredPath)).digest('hex')
}

export function videoLibraryConfigurationFingerprint(roots: unknown): string {
  const normalizedRoots = normalizeVideoLibraryRoots(roots)
  return crypto.createHash('sha256').update(JSON.stringify({
    indexVersion: VIDEO_LIBRARY_INDEX_VERSION,
    parserPolicyVersion: PARSER_POLICY_VERSION,
    roots: normalizedRoots.map(root => identity(root))
  })).digest('hex')
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isFilesystemIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function validateEntry(value: unknown, canonicalRoot: string, seenPaths: Set<string>): VideoLibraryIndexEntry | undefined {
  if (!isRecord(value) || !exactKeys(value, ['relativePath', 'musicCode', 'size', 'mtimeMs', 'device', 'inode'])) return undefined
  const { relativePath, musicCode, size, mtimeMs, device, inode } = value
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > MAX_RELATIVE_PATH_LENGTH ||
      /[\0\x01-\x1f\x7f]/.test(relativePath) || path.isAbsolute(relativePath)) return undefined
  const parts = relativePath.split(/[\\/]/)
  if (parts.some(part => part === '..' || part === '' || part === '.')) return undefined
  const normalized = path.normalize(relativePath)
  if (normalized !== relativePath || !isInside(canonicalRoot, path.resolve(canonicalRoot, normalized))) return undefined
  if (typeof musicCode !== 'string' || !/^\d{5}$/.test(musicCode) ||
      parseVideoCode(path.basename(relativePath)) !== musicCode) return undefined
  if (!isNonNegativeSafeInteger(size) || !isFiniteNumber(mtimeMs) ||
      !isFilesystemIdentity(device) || !isFilesystemIdentity(inode)) return undefined
  const key = identity(relativePath)
  if (seenPaths.has(key)) return undefined
  seenPaths.add(key)
  return { relativePath, musicCode, size, mtimeMs, device, inode }
}

function validateDocument(value: unknown): VideoLibraryIndexDocument | undefined {
  if (!isRecord(value) || !exactKeys(value, ['version', 'generation', 'configurationFingerprint', 'scanCompletedAt', 'roots'])) return undefined
  if (value.version !== VIDEO_LIBRARY_INDEX_VERSION || !isNonNegativeSafeInteger(value.generation) || value.generation < 1 ||
      typeof value.configurationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.configurationFingerprint) ||
      typeof value.scanCompletedAt !== 'string' || value.scanCompletedAt.length > 40 || !Number.isFinite(Date.parse(value.scanCompletedAt)) ||
      !Array.isArray(value.roots) || value.roots.length > MAX_ROOTS) return undefined

  const roots: VideoLibraryIndexRoot[] = []
  const seenKeys = new Set<string>()
  let entryCount = 0
  for (const candidate of value.roots) {
    if (!isRecord(candidate) || !exactKeys(candidate, ['rootKey', 'configuredPath', 'canonicalRoot', 'entries']) ||
        typeof candidate.configuredPath !== 'string' || typeof candidate.canonicalRoot !== 'string' ||
        !path.isAbsolute(candidate.configuredPath) || !path.isAbsolute(candidate.canonicalRoot) ||
        path.normalize(candidate.configuredPath) !== candidate.configuredPath ||
        path.normalize(candidate.canonicalRoot) !== candidate.canonicalRoot ||
        candidate.rootKey !== rootKey(candidate.configuredPath) || seenKeys.has(candidate.rootKey as string) ||
        !Array.isArray(candidate.entries)) return undefined
    seenKeys.add(candidate.rootKey)
    const entries: VideoLibraryIndexEntry[] = []
    const seenPaths = new Set<string>()
    for (const entryValue of candidate.entries) {
      entryCount++
      if (entryCount > MAX_ENTRIES) return undefined
      const entry = validateEntry(entryValue, candidate.canonicalRoot, seenPaths)
      if (!entry) return undefined
      entries.push(entry)
    }
    roots.push({ rootKey: candidate.rootKey, configuredPath: candidate.configuredPath,
      canonicalRoot: candidate.canonicalRoot, entries })
  }
  return {
    version: 1,
    generation: value.generation,
    configurationFingerprint: value.configurationFingerprint,
    scanCompletedAt: value.scanCompletedAt,
    roots
  }
}

/** Main-only disposable inventory cache. It does not open SQLite or media files. */
export class VideoLibraryIndexStore {
  readonly filePath: string
  private writeTail: Promise<void> = Promise.resolve()

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, VIDEO_LIBRARY_INDEX_FILENAME)
  }

  async read(configuredRoots: unknown): Promise<VideoLibraryIndexReadResult> {
    const normalizedRoots = normalizeVideoLibraryRoots(configuredRoots)
    let handle: fs.promises.FileHandle
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
      handle = await fs.promises.open(this.filePath, flags)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
      return { status: 'invalid', reason: 'unreadable' }
    }

    let bytes: Buffer
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) return { status: 'invalid', reason: 'unreadable' }
      if (stats.size > MAX_INDEX_BYTES) return { status: 'invalid', reason: 'too-large' }
      bytes = await handle.readFile()
      if (bytes.byteLength > MAX_INDEX_BYTES) return { status: 'invalid', reason: 'too-large' }
    } catch {
      return { status: 'invalid', reason: 'unreadable' }
    } finally {
      await handle.close().catch(() => undefined)
    }

    let raw: string
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { return { status: 'invalid', reason: 'invalid-utf8' } }
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch { return { status: 'invalid', reason: 'invalid-json' } }
    if (isRecord(parsed) && parsed.version !== VIDEO_LIBRARY_INDEX_VERSION) {
      return { status: 'invalid', reason: 'unsupported-version' }
    }
    const index = validateDocument(parsed)
    if (!index) return { status: 'invalid', reason: 'invalid-record' }
    if (index.configurationFingerprint !== videoLibraryConfigurationFingerprint(normalizedRoots) ||
        index.roots.length !== normalizedRoots.length ||
        index.roots.some((root, indexPosition) => identity(root.configuredPath) !== identity(normalizedRoots[indexPosition]))) {
      return { status: 'stale', reason: 'configuration-mismatch' }
    }
    return { status: 'valid', index }
  }

  /** Writes only a caller-supplied complete generation through a same-directory atomic replace. */
  writeComplete(input: VideoLibraryIndexWriteInput): Promise<VideoLibraryIndexDocument> {
    const configuredRoots = normalizeVideoLibraryRoots(input.configuredRoots)
    if (!isNonNegativeSafeInteger(input.generation) || input.generation < 1 ||
        input.roots.length !== configuredRoots.length || input.roots.some((root, indexPosition) =>
          identity(root.configuredPath) !== identity(configuredRoots[indexPosition]))) {
      return Promise.reject(new VideoLibraryIndexStoreError('INVALID_INDEX', 'A geração completa do índice não corresponde à configuração atual.'))
    }
    const scanCompletedAt = input.scanCompletedAt ?? new Date().toISOString()
    const roots: VideoLibraryIndexRoot[] = input.roots.map(root => ({
      rootKey: rootKey(root.configuredPath),
      configuredPath: path.normalize(root.configuredPath),
      canonicalRoot: path.normalize(root.canonicalRoot),
      entries: root.entries.map(entry => ({ ...entry }))
    }))
    const index = validateDocument({
      version: VIDEO_LIBRARY_INDEX_VERSION,
      generation: input.generation,
      configurationFingerprint: videoLibraryConfigurationFingerprint(configuredRoots),
      scanCompletedAt,
      roots
    })
    if (!index) return Promise.reject(new VideoLibraryIndexStoreError('INVALID_INDEX', 'A geração completa do índice contém dados inválidos.'))
    const serialized = `${JSON.stringify(index)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INDEX_BYTES) {
      return Promise.reject(new VideoLibraryIndexStoreError('INVALID_INDEX', 'O índice excede o tamanho máximo permitido.'))
    }

    const operation = this.writeTail.then(async () => {
      await this.writeAtomic(serialized, index)
      return index
    })
    this.writeTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async writeAtomic(serialized: string, index: VideoLibraryIndexDocument): Promise<void> {
    const directory = path.dirname(this.filePath)
    const temporaryPath = path.join(directory, `.${VIDEO_LIBRARY_INDEX_FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`)
    let handle: fs.promises.FileHandle | undefined
    try {
      await fs.promises.mkdir(directory, { recursive: true })
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      handle = await fs.promises.open(temporaryPath, flags, 0o600)
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined

      const existing = await this.readAnyIndex()
      if (existing && index.generation < existing.generation) {
        throw new VideoLibraryIndexStoreError('STALE_GENERATION', 'Uma geração antiga não pode substituir o índice mais recente.')
      }
      if (existing && index.generation === existing.generation) {
        if (JSON.stringify(index) === JSON.stringify(existing)) {
          await fs.promises.unlink(temporaryPath)
          return
        }
        throw new VideoLibraryIndexStoreError('STALE_GENERATION', 'A mesma geração não pode identificar dois inventários diferentes.')
      }
      await fs.promises.rename(temporaryPath, this.filePath)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await fs.promises.unlink(temporaryPath).catch(() => undefined)
      if (error instanceof VideoLibraryIndexStoreError) throw error
      throw new VideoLibraryIndexStoreError('WRITE_FAILED', 'Não foi possível persistir a geração completa do índice.')
    }
  }

  private async readAnyIndex(): Promise<VideoLibraryIndexDocument | undefined> {
    let handle: fs.promises.FileHandle
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
      handle = await fs.promises.open(this.filePath, flags)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return undefined
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > MAX_INDEX_BYTES) return undefined
      const bytes = await handle.readFile()
      if (bytes.byteLength > MAX_INDEX_BYTES) return undefined
      let parsed: unknown
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
      catch { return undefined }
      const index = validateDocument(parsed)
      return index
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
}
