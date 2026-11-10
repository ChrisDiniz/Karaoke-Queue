import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'

/** Final product functions. Controller is accepted only when reading old profiles. */
export type OperatingMode = 'player' | 'combined'
export type PersistedOperatingMode = OperatingMode | 'controller'

export interface OperatingModeConfiguration {
  version: 1
  mode: PersistedOperatingMode
}

export interface OperatingModeCapabilities {
  controller: boolean
  player: boolean
}

export class OperatingModeConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperatingModeConfigurationError'
  }
}

export const OPERATING_MODE_CONFIGURATION_FILENAME = 'operating-mode.json'

const CONFIGURATION_VERSION = 1
const MAX_CONFIGURATION_BYTES = 4096
const VALID_MODES = new Set<OperatingMode>(['player', 'combined'])
const VALID_PERSISTED_MODES = new Set<PersistedOperatingMode>(['controller', 'player', 'combined'])

export function isOperatingMode(value: unknown): value is OperatingMode {
  return typeof value === 'string' && VALID_MODES.has(value as OperatingMode)
}

function isPersistedOperatingMode(value: unknown): value is PersistedOperatingMode {
  return typeof value === 'string' && VALID_PERSISTED_MODES.has(value as PersistedOperatingMode)
}

/** Resolve the legacy persisted label in memory without rewriting its profile. */
export function resolveOperatingMode(mode: PersistedOperatingMode): OperatingMode {
  switch (mode) {
    case 'controller': return 'combined'
    case 'player':
    case 'combined': return mode
    default: throw new OperatingModeConfigurationError('O modo de operação não é reconhecido.')
  }
}

export function getOperatingModeCapabilities(mode: OperatingMode): OperatingModeCapabilities {
  switch (mode) {
    case 'player': return { controller: false, player: true }
    case 'combined': return { controller: true, player: true }
    default: throw new OperatingModeConfigurationError('O modo de operação não é reconhecido.')
  }
}

function configurationPath(userDataDirectory: string): string {
  return path.join(userDataDirectory, OPERATING_MODE_CONFIGURATION_FILENAME)
}

function entryExists(directory: string, name: string): boolean {
  try { fs.lstatSync(path.join(directory, name)); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
}

/** Show first-run mode selection only for a truly fresh profile, preserving legacy Controller data. */
export function requiresFirstLaunchModeSelection(userDataDirectory: string): boolean {
  if (entryExists(userDataDirectory, OPERATING_MODE_CONFIGURATION_FILENAME)) return false
  const existingProfileFiles = [
    'karaoke.sqlite', 'karaoke.sqlite-wal', 'karaoke.sqlite-shm', 'karaoke-data.json',
    'ui-preferences.json', 'video-library.json', 'player-music-catalog.sqlite',
    'player-playback-recovery.json', '.player-playback-recovery-transaction.json',
    '.player-playback-recovery-previous.json'
  ]
  return !existingProfileFiles.some(name => entryExists(userDataDirectory, name))
}

function parseConfiguration(value: unknown): OperatingModeConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatingModeConfigurationError('O arquivo de modo precisa conter um objeto JSON.')
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !keys.includes('version') || !keys.includes('mode')) {
    throw new OperatingModeConfigurationError('O arquivo de modo deve conter somente os campos "version" e "mode".')
  }
  if (record.version !== CONFIGURATION_VERSION) {
    throw new OperatingModeConfigurationError('A versão do arquivo de modo não é compatível com esta versão do aplicativo.')
  }
  if (!isPersistedOperatingMode(record.mode)) {
    throw new OperatingModeConfigurationError('O modo configurado é inválido. Use controller (legado), player ou combined.')
  }

  return { version: CONFIGURATION_VERSION, mode: record.mode }
}

/** Missing configuration uses the historical Controller value as a legacy Combined alias. */
export function readOperatingModeConfiguration(userDataDirectory: string): OperatingModeConfiguration {
  const filePath = configurationPath(userDataDirectory)
  let descriptor: number
  try {
    const linkStats = fs.lstatSync(filePath)
    if (!linkStats.isFile() || linkStats.isSymbolicLink()) {
      throw new OperatingModeConfigurationError('operating-mode.json não é um arquivo regular.')
    }
    const flags = fs.constants.O_RDONLY |
      (fs.constants.O_NONBLOCK ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0)
    descriptor = fs.openSync(filePath, flags)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: CONFIGURATION_VERSION, mode: 'controller' }
    }
    if (error instanceof OperatingModeConfigurationError) throw error
    throw new OperatingModeConfigurationError('Não foi possível ler operating-mode.json. Verifique o acesso ao perfil do aplicativo.')
  }

  let raw: string
  try {
    const stats = fs.fstatSync(descriptor)
    if (!stats.isFile()) {
      throw new OperatingModeConfigurationError('operating-mode.json não é um arquivo regular.')
    }
    if (stats.size > MAX_CONFIGURATION_BYTES) {
      throw new OperatingModeConfigurationError('operating-mode.json excede o tamanho permitido.')
    }
    const bytes = fs.readFileSync(descriptor)
    if (bytes.byteLength > MAX_CONFIGURATION_BYTES) {
      throw new OperatingModeConfigurationError('operating-mode.json excede o tamanho permitido.')
    }
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    if (error instanceof OperatingModeConfigurationError) throw error
    throw new OperatingModeConfigurationError('operating-mode.json não pôde ser lido como UTF-8 válido. A configuração foi preservada.')
  } finally {
    fs.closeSync(descriptor)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new OperatingModeConfigurationError('operating-mode.json contém JSON inválido. A configuração foi preservada.')
  }
  return parseConfiguration(parsed)
}

/** Persist only a final product function; the current process keeps its resolved mode. */
export function writeOperatingModeConfiguration(userDataDirectory: string, mode: OperatingMode): void {
  if (!isOperatingMode(mode)) {
    throw new OperatingModeConfigurationError('O modo de operação é inválido. Use player ou combined.')
  }

  const targetPath = configurationPath(userDataDirectory)
  const temporaryPath = path.join(userDataDirectory,
    `.operating-mode.${process.pid}.${crypto.randomUUID()}.tmp`)
  const configuration = { version: CONFIGURATION_VERSION, mode } satisfies OperatingModeConfiguration
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
    throw new OperatingModeConfigurationError('Não foi possível salvar operating-mode.json. A configuração anterior foi preservada.')
  }
}
