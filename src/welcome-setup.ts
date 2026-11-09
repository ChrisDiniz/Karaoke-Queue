import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createKaraokeDatabase, createPlayerMusicCatalogDatabase } from '../database'
import { MusicCatalogService } from './music-catalog-service'
import { writeVideoLibraryConfiguration } from './video-library-configuration'
import type { OperatingMode } from './operating-mode'

export const WELCOME_SETUP_FILENAME = 'welcome-setup.json'
const PROFILE_DATA_FILES = [
  'operating-mode.json',
  'karaoke.sqlite', 'karaoke.sqlite-wal', 'karaoke.sqlite-shm', 'karaoke-data.json',
  'ui-preferences.json', 'video-library.json', 'player-music-catalog.sqlite',
  'player-playback-recovery.json', '.player-playback-recovery-transaction.json',
  '.player-playback-recovery-previous.json'
]

export interface WelcomeSetupState {
  version: 1
  status: 'pending' | 'complete'
}

export interface WelcomeSetupSelection {
  libraryRoot?: string
  catalogFile?: string
}

function setupPath(userDataDirectory: string): string {
  return path.join(userDataDirectory, WELCOME_SETUP_FILENAME)
}

function entryExists(directory: string, name: string): boolean {
  try { fs.lstatSync(path.join(directory, name)); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
}

function parseState(value: unknown): WelcomeSetupState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WELCOME_SETUP_STATE_INVALID')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || record.version !== 1 ||
      (record.status !== 'pending' && record.status !== 'complete')) throw new Error('WELCOME_SETUP_STATE_INVALID')
  return { version: 1, status: record.status }
}

export function readWelcomeSetupState(userDataDirectory: string): WelcomeSetupState | null {
  const filePath = setupPath(userDataDirectory)
  let descriptor: number
  try {
    const stats = fs.lstatSync(filePath)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('WELCOME_SETUP_STATE_INVALID')
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error instanceof Error && error.message === 'WELCOME_SETUP_STATE_INVALID'
      ? error : new Error('WELCOME_SETUP_STATE_UNREADABLE')
  }
  try {
    const stats = fs.fstatSync(descriptor)
    if (!stats.isFile() || stats.size > 4096) throw new Error('WELCOME_SETUP_STATE_INVALID')
    const bytes = fs.readFileSync(descriptor)
    if (bytes.byteLength > 4096) throw new Error('WELCOME_SETUP_STATE_INVALID')
    let json: unknown
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new Error('WELCOME_SETUP_STATE_INVALID') }
    return parseState(json)
  } finally { fs.closeSync(descriptor) }
}

/** Legacy profiles keep their existing setup and are never forced through new-user onboarding. */
export function requiresInitialWelcomeSetup(userDataDirectory: string): boolean {
  const state = readWelcomeSetupState(userDataDirectory)
  if (state) return state.status === 'pending'
  return !PROFILE_DATA_FILES.some(name => entryExists(userDataDirectory, name))
}

/** Persists a retryable setup intent after a role has been explicitly selected. */
export function beginInitialWelcomeSetup(userDataDirectory: string): void {
  const current = readWelcomeSetupState(userDataDirectory)
  if (current?.status === 'complete' || current?.status === 'pending') return
  writeState(userDataDirectory, { version: 1, status: 'pending' })
}

function writeState(userDataDirectory: string, state: WelcomeSetupState): void {
  fs.mkdirSync(userDataDirectory, { recursive: true })
  const target = setupPath(userDataDirectory)
  const temporary = path.join(userDataDirectory, `.welcome-setup.${process.pid}.${crypto.randomUUID()}.tmp`)
  let descriptor: number | undefined
  let published = false
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, target)
    published = true
    try {
      const directoryDescriptor = fs.openSync(userDataDirectory, fs.constants.O_RDONLY)
      try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
    } catch (error) { if (process.platform !== 'win32') throw error }
  } catch {
    throw new Error('WELCOME_SETUP_STATE_WRITE_FAILED')
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
    if (!published) try { fs.unlinkSync(temporary) } catch {}
  }
}

function validateSelectedLibraryRoot(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('WELCOME_LIBRARY_PATH_INVALID')
  }
  let stats: fs.Stats
  try { stats = fs.statSync(value) } catch { throw new Error('WELCOME_LIBRARY_UNAVAILABLE') }
  if (!stats.isDirectory()) throw new Error('WELCOME_LIBRARY_UNAVAILABLE')
  try { fs.accessSync(value, fs.constants.R_OK) } catch { throw new Error('WELCOME_LIBRARY_UNAVAILABLE') }
  return path.normalize(value)
}

async function importInitialCatalog(userDataDirectory: string, role: OperatingMode, filePath: string): Promise<void> {
  const database = role === 'player'
    ? createPlayerMusicCatalogDatabase(userDataDirectory)
    : createKaraokeDatabase(userDataDirectory)
  const service = new MusicCatalogService(database)
  try { await service.importFile(filePath) }
  finally {
    await service.close()
    database.close()
  }
}

/**
 * Writes the per-account setup marker only after any selected library/catalog changes are committed.
 * A pending marker makes a crash retryable without treating a partially created catalog as legacy data.
 */
export async function completeInitialWelcomeSetup(
  userDataDirectory: string,
  role: OperatingMode,
  selection: WelcomeSetupSelection
): Promise<void> {
  if (role !== 'player' && role !== 'combined') throw new Error('WELCOME_SETUP_ROLE_INVALID')
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
      Object.keys(selection).some(key => key !== 'libraryRoot' && key !== 'catalogFile') ||
      (selection.libraryRoot !== undefined && typeof selection.libraryRoot !== 'string') ||
      (selection.catalogFile !== undefined && typeof selection.catalogFile !== 'string')) {
    throw new Error('WELCOME_SETUP_SELECTION_INVALID')
  }

  const current = readWelcomeSetupState(userDataDirectory)
  if (current?.status === 'complete') return
  if (!current) writeState(userDataDirectory, { version: 1, status: 'pending' })

  if (selection.libraryRoot !== undefined) {
    const root = validateSelectedLibraryRoot(selection.libraryRoot)
    writeVideoLibraryConfiguration(userDataDirectory, [root])
  }
  if (selection.catalogFile !== undefined) {
    if (!path.isAbsolute(selection.catalogFile) || selection.catalogFile.includes('\0')) {
      throw new Error('WELCOME_CATALOG_PATH_INVALID')
    }
    await importInitialCatalog(userDataDirectory, role, selection.catalogFile)
  }
  writeState(userDataDirectory, { version: 1, status: 'complete' })
}
