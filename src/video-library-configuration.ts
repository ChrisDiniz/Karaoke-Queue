import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'

export const VIDEO_LIBRARY_CONFIGURATION_FILENAME = 'video-library.json'
const CONFIGURATION_VERSION = 1
const MAX_ROOTS = 32
const MAX_ROOT_PATH_LENGTH = 32768
const MAX_CONFIGURATION_BYTES = 1024 * 1024

export interface VideoLibraryConfiguration {
  version: 1
  roots: string[]
}

export class VideoLibraryConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoLibraryConfigurationError'
  }
}

function configurationPath(userDataDirectory: string): string {
  return path.join(userDataDirectory, VIDEO_LIBRARY_CONFIGURATION_FILENAME)
}

function normalizeRoot(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0 ||
      value.length > MAX_ROOT_PATH_LENGTH || /[\0\x01-\x1f\x7f]/.test(value)) {
    throw new VideoLibraryConfigurationError('Cada pasta da biblioteca precisa ser um caminho absoluto válido.')
  }
  if (!path.isAbsolute(value)) {
    throw new VideoLibraryConfigurationError('As pastas da biblioteca precisam usar caminhos absolutos.')
  }
  try {
    return path.normalize(value)
  } catch {
    throw new VideoLibraryConfigurationError('Um caminho da biblioteca não pôde ser normalizado.')
  }
}

function rootIdentity(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function normalizeVideoLibraryRoots(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > MAX_ROOTS) {
    throw new VideoLibraryConfigurationError(`A configuração deve conter uma lista com até ${MAX_ROOTS} pastas.`)
  }

  const roots: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const root = normalizeRoot(value)
    const identity = rootIdentity(root)
    if (seen.has(identity)) {
      throw new VideoLibraryConfigurationError('A configuração contém uma pasta duplicada.')
    }
    seen.add(identity)
    roots.push(root)
  }
  return roots
}

function parseConfiguration(value: unknown): VideoLibraryConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VideoLibraryConfigurationError('video-library.json precisa conter um objeto JSON.')
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !keys.includes('version') || !keys.includes('roots')) {
    throw new VideoLibraryConfigurationError('video-library.json deve conter somente "version" e "roots".')
  }
  if (record.version !== CONFIGURATION_VERSION) {
    throw new VideoLibraryConfigurationError('A versão de video-library.json não é compatível com esta versão do aplicativo.')
  }
  return { version: CONFIGURATION_VERSION, roots: normalizeVideoLibraryRoots(record.roots) }
}

/** Missing configuration means no configured roots; reading never creates or rewrites the file. */
export function readVideoLibraryConfiguration(userDataDirectory: string): VideoLibraryConfiguration {
  const filePath = configurationPath(userDataDirectory)
  let descriptor: number
  try {
    const linkStats = fs.lstatSync(filePath)
    if (!linkStats.isFile() || linkStats.isSymbolicLink()) {
      throw new VideoLibraryConfigurationError('video-library.json não é um arquivo regular.')
    }
    const flags = fs.constants.O_RDONLY |
      (fs.constants.O_NONBLOCK ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0)
    descriptor = fs.openSync(filePath, flags)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: CONFIGURATION_VERSION, roots: [] }
    }
    if (error instanceof VideoLibraryConfigurationError) throw error
    throw new VideoLibraryConfigurationError('Não foi possível ler video-library.json. Verifique o acesso ao perfil do aplicativo.')
  }

  let raw: string
  try {
    const stats = fs.fstatSync(descriptor)
    if (!stats.isFile()) throw new VideoLibraryConfigurationError('video-library.json não é um arquivo regular.')
    if (stats.size > MAX_CONFIGURATION_BYTES) {
      throw new VideoLibraryConfigurationError('video-library.json excede o tamanho permitido.')
    }
    const bytes = fs.readFileSync(descriptor)
    if (bytes.byteLength > MAX_CONFIGURATION_BYTES) {
      throw new VideoLibraryConfigurationError('video-library.json excede o tamanho permitido.')
    }
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    if (error instanceof VideoLibraryConfigurationError) throw error
    throw new VideoLibraryConfigurationError('video-library.json não pôde ser lido como UTF-8 válido. A configuração foi preservada.')
  } finally {
    fs.closeSync(descriptor)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new VideoLibraryConfigurationError('video-library.json contém JSON inválido. A configuração foi preservada.')
  }
  return parseConfiguration(parsed)
}

/** Persist only validated roots with atomic replacement; directory existence is checked during scanning. */
export function writeVideoLibraryConfiguration(userDataDirectory: string, roots: unknown): void {
  const configuration: VideoLibraryConfiguration = {
    version: CONFIGURATION_VERSION,
    roots: normalizeVideoLibraryRoots(roots)
  }
  const targetPath = configurationPath(userDataDirectory)
  const temporaryPath = path.join(userDataDirectory,
    `.video-library.${process.pid}.${crypto.randomUUID()}.tmp`)
  let descriptor: number | undefined

  try {
    fs.mkdirSync(userDataDirectory, { recursive: true })
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, targetPath)
  } catch {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try { fs.unlinkSync(temporaryPath) } catch {}
    throw new VideoLibraryConfigurationError('Não foi possível salvar video-library.json. A configuração anterior foi preservada.')
  }
}
