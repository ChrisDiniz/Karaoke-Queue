import { watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type RemoteControlIntent = 'disabled' | 'enabled' | 'offline'
export interface PersistedRemoteControlIntent { readonly version: 1; readonly intent: RemoteControlIntent; readonly revision: number }
export interface RemoteControlIntentRecovery { readonly version: 1; readonly intent: 'recovery_required'; readonly revision: null }
export type RemoteControlIntentState = PersistedRemoteControlIntent | RemoteControlIntentRecovery
export interface RemoteControlIntentStoreTestHooks {
  beforeCommit?(): void
  afterCommit?(): void
}

export const REMOTE_CONTROL_INTENT_DATABASE_FILENAME = 'remote-control-intent.sqlite'
const DATABASE_VERSION = 1
const APPLICATION_ID = 0x4b514943 // KQIC
const BUSY_TIMEOUT_MS = 5_000
const INITIALIZATION_OBSERVATION_MS = 500
const MAX_DATABASE_BYTES = 1024 * 1024
const MAX_LEGACY_BYTES = 1024
const pathLocks = new Map<string, Promise<unknown>>()
const DEFAULT_INTENT: PersistedRemoteControlIntent = Object.freeze({ version: 1, intent: 'disabled', revision: 0 })
const RECOVERY_REQUIRED: RemoteControlIntentRecovery = Object.freeze({ version: 1, intent: 'recovery_required', revision: null })

function decodeLegacyIntent(raw: string): PersistedRemoteControlIntent {
  let value: unknown
  try { value = JSON.parse(raw) } catch (error) { throw new Error('REMOTE_CONTROL_INTENT_INVALID', { cause: error }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REMOTE_CONTROL_INTENT_INVALID')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'intent,revision,version' || record.version !== 1 ||
      !['disabled', 'enabled', 'offline'].includes(String(record.intent)) ||
      !Number.isSafeInteger(record.revision) || Number(record.revision) < 0) throw new Error('REMOTE_CONTROL_INTENT_INVALID')
  return { version: 1, intent: record.intent as RemoteControlIntent, revision: Number(record.revision) }
}

function readIntent(database: DatabaseSync): PersistedRemoteControlIntent {
  const row = database.prepare('SELECT version,intent,revision FROM remote_control_intent WHERE singleton=1')
    .get() as { version?: unknown; intent?: unknown; revision?: unknown } | undefined
  if (!row || row.version !== 1 || !['disabled', 'enabled', 'offline'].includes(String(row.intent)) ||
      !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) {
    throw new Error('REMOTE_CONTROL_INTENT_INVALID')
  }
  return { version: 1, intent: row.intent as RemoteControlIntent, revision: Number(row.revision) }
}

function assertHealthyDatabase(database: DatabaseSync): void {
  try {
    const result = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined
    if (result?.integrity_check !== 'ok') throw new Error('REMOTE_CONTROL_INTENT_DATABASE_CORRUPT')
  } catch (error) {
    if (error instanceof Error && error.message === 'REMOTE_CONTROL_INTENT_DATABASE_CORRUPT') throw error
    throw new Error('REMOTE_CONTROL_INTENT_DATABASE_CORRUPT', { cause: error })
  }
}

function openIntentDatabase(filePath: string): DatabaseSync {
  try { return new DatabaseSync(filePath) }
  catch (error) { throw new Error('REMOTE_CONTROL_INTENT_DATABASE_CORRUPT', { cause: error }) }
}

function configureConnection(database: DatabaseSync): void {
  try { database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA synchronous = FULL;`) }
  catch (error) {
    if (error instanceof Error && /not a database|database disk image is malformed/i.test(error.message)) {
      throw new Error('REMOTE_CONTROL_INTENT_DATABASE_CORRUPT', { cause: error })
    }
    throw error
  }
}

function initializeOrValidateDatabase(database: DatabaseSync, initial: PersistedRemoteControlIntent = DEFAULT_INTENT): boolean {
  configureConnection(database)
  let initialized = false
  database.exec('BEGIN IMMEDIATE')
  try {
    const applicationId = Number((database.prepare('PRAGMA application_id').get() as { application_id?: unknown }).application_id)
    const version = Number((database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version)
    if (applicationId === 0 && version === 0) {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      if (tables.length !== 0) throw new Error('REMOTE_CONTROL_INTENT_DATABASE_UNSUPPORTED')
      database.exec(`CREATE TABLE remote_control_intent (
        singleton INTEGER PRIMARY KEY CHECK (singleton=1),
        version INTEGER NOT NULL CHECK (version=1),
        intent TEXT NOT NULL CHECK (intent IN ('disabled','enabled','offline')),
        revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991)
      ) STRICT;`)
      database.prepare('INSERT INTO remote_control_intent(singleton,version,intent,revision) VALUES(1,1,?,?)')
        .run(initial.intent, initial.revision)
      database.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${DATABASE_VERSION};`)
      initialized = true
    } else if (applicationId !== APPLICATION_ID || version !== DATABASE_VERSION) {
      throw new Error('REMOTE_CONTROL_INTENT_DATABASE_UNSUPPORTED')
    } else {
      readIntent(database)
    }
    database.exec('COMMIT')
    return initialized
  } catch (error) {
    if (database.isTransaction) try { database.exec('ROLLBACK') } catch { /* preserve the original database error */ }
    throw error
  }
}

/** Main-owned SQLite state for the explicit remote mode choice. Lost/corrupt initialized state fails closed. */
export class RemoteControlIntentStore {
  private readonly filePath: string
  private readonly legacyFilePath: string
  private readonly remoteHistoryPaths: readonly string[]
  constructor(userDataDirectory: string, private readonly testHooks: RemoteControlIntentStoreTestHooks = {}) {
    this.filePath = path.join(userDataDirectory, REMOTE_CONTROL_INTENT_DATABASE_FILENAME)
    this.legacyFilePath = path.join(userDataDirectory, 'remote-control-intent.json')
    // These G2 files are created only when a remote identity/binding has existed. They provide
    // independent evidence that an absent intent database is loss, not a fresh remote bootstrap.
    this.remoteHistoryPaths = ['remote-player-identity.json', 'remote-controller-identity.json',
      'remote-authorization.json'].map(name => path.join(userDataDirectory, name))
  }

  read(): Promise<RemoteControlIntentState> {
    return this.withLock(async () => {
      let stat: Awaited<ReturnType<typeof fs.lstat>>
      try { stat = await fs.lstat(this.filePath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (await this.hasRemoteHistory()) return RECOVERY_REQUIRED
          const legacy = await this.readLegacyIntent()
          return this.initializeAbsentDatabase(legacy ?? DEFAULT_INTENT)
        }
        throw error
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DATABASE_BYTES) {
        throw new Error('REMOTE_CONTROL_INTENT_DATABASE_INVALID')
      }
      if (stat.size === 0 && !await this.waitForConcurrentInitialization()) {
        throw new Error('REMOTE_CONTROL_INTENT_DATABASE_INVALID')
      }
      const database = openIntentDatabase(this.filePath)
      try {
        configureConnection(database)
        assertHealthyDatabase(database)
        validateExistingDatabase(database)
        return readIntent(database)
      } finally { database.close() }
    })
  }

  set(intent: RemoteControlIntent, expectedRevision: number | null, canAdmit?: () => boolean): Promise<PersistedRemoteControlIntent> {
    if (!['disabled', 'enabled', 'offline'].includes(intent)) return Promise.reject(new Error('REMOTE_CONTROL_INTENT_INVALID'))
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      return Promise.reject(new Error('REMOTE_CONTROL_INTENT_REVISION_REQUIRED'))
    }
    return this.withLock(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      let initial = DEFAULT_INTENT
      let databaseExists = true
      try {
        const stat = await fs.lstat(this.filePath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DATABASE_BYTES) throw new Error('REMOTE_CONTROL_INTENT_DATABASE_INVALID')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        databaseExists = false
      }
      if (!databaseExists) {
        if (expectedRevision !== null) throw new Error('REMOTE_CONTROL_INTENT_REVISION_CONFLICT')
        const hasRemoteHistory = await this.hasRemoteHistory()
        // set() is the explicit local recovery/choice operation. If history exists, do not let
        // retained JSON resurrect the old authorization; start from closed and apply this choice.
        if (!hasRemoteHistory) initial = await this.readLegacyIntent() ?? DEFAULT_INTENT
      } else if (expectedRevision === null) throw new Error('REMOTE_CONTROL_INTENT_REVISION_CONFLICT')
      // The Main caller can supersede this request while filesystem preparation is awaiting.
      // Admit the durable transition only after that preparation and then keep admission+SQLite
      // transaction synchronous so a newer Main request cannot interleave before commit.
      if (canAdmit && !canAdmit()) throw new Error('REMOTE_CONTROL_INTENT_TRANSITION_FENCED')
      const database = openIntentDatabase(this.filePath)
      try {
        let initialized = false
        if (!databaseExists) initialized = initializeOrValidateDatabase(database, initial)
        else {
          configureConnection(database)
          assertHealthyDatabase(database)
          validateExistingDatabase(database)
        }
        if (canAdmit && !canAdmit()) throw new Error('REMOTE_CONTROL_INTENT_TRANSITION_FENCED')
        database.exec('BEGIN IMMEDIATE')
        try {
          if (canAdmit && !canAdmit()) throw new Error('REMOTE_CONTROL_INTENT_TRANSITION_FENCED')
          const current = readIntent(database)
          if (expectedRevision === null && (!initialized || current.revision !== initial.revision) ||
              expectedRevision !== null && expectedRevision !== current.revision) {
            throw new Error('REMOTE_CONTROL_INTENT_REVISION_CONFLICT')
          }
          if (current.intent === intent) {
            database.exec('COMMIT')
            return current
          }
          const candidate: PersistedRemoteControlIntent = { version: 1, intent, revision: current.revision + 1 }
          database.prepare('UPDATE remote_control_intent SET intent=?,revision=? WHERE singleton=1 AND revision=?')
            .run(candidate.intent, candidate.revision, current.revision)
          this.testHooks.beforeCommit?.()
          database.exec('COMMIT')
          this.testHooks.afterCommit?.()
          const readback = readIntent(database)
          if (JSON.stringify(readback) !== JSON.stringify(candidate)) throw new Error('REMOTE_CONTROL_INTENT_READBACK_MISMATCH')
          return readback
        } catch (error) {
          if (database.isTransaction) try { database.exec('ROLLBACK') } catch { /* preserve the original write error */ }
          throw error
        }
      } finally { database.close() }
    })
  }

  private async initializeAbsentDatabase(initial: PersistedRemoteControlIntent): Promise<PersistedRemoteControlIntent> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const database = openIntentDatabase(this.filePath)
    try {
      // Two independent Main processes can both observe ENOENT. BEGIN IMMEDIATE makes the
      // second initializer observe and validate the first one's committed schema.
      initializeOrValidateDatabase(database, initial)
      assertHealthyDatabase(database)
      return readIntent(database)
    } finally { database.close() }
  }

  private async hasRemoteHistory(): Promise<boolean> {
    for (const filePath of this.remoteHistoryPaths) {
      try {
        const stat = await fs.lstat(filePath)
        if (stat.isFile() || stat.isSymbolicLink()) return true
        throw new Error('REMOTE_CONTROL_INTENT_HISTORY_INVALID')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
    return false
  }

  /** A second Main may observe SQLite's file after open but before its initializing COMMIT. */
  private waitForConcurrentInitialization(): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false
      let watcher: ReturnType<typeof watch> | undefined
      const timeout = setTimeout(() => finish(false), INITIALIZATION_OBSERVATION_MS)
      const finish = (initialized: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        watcher?.close()
        resolve(initialized)
      }
      const check = (): void => {
        void fs.stat(this.filePath).then(stat => {
          if (stat.isFile() && stat.size > 0) finish(true)
        }, () => undefined)
      }
      try {
        watcher = watch(path.dirname(this.filePath), (_event, filename) => {
          if (filename?.toString() === path.basename(this.filePath)) check()
        })
        check()
      } catch { finish(false) }
    })
  }

  private async readLegacyIntent(): Promise<PersistedRemoteControlIntent | undefined> {
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try { stat = await fs.lstat(this.legacyFilePath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEGACY_BYTES) {
      throw new Error('REMOTE_CONTROL_INTENT_LEGACY_INVALID')
    }
    return decodeLegacyIntent(await fs.readFile(this.legacyFilePath, 'utf8'))
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = pathLocks.get(this.filePath) ?? Promise.resolve()
    const task = prior.then(operation, operation)
    const settled = task.catch(() => undefined)
    pathLocks.set(this.filePath, settled)
    return task.finally(() => { if (pathLocks.get(this.filePath) === settled) pathLocks.delete(this.filePath) })
  }
}

function validateExistingDatabase(database: DatabaseSync): void {
  const applicationId = Number((database.prepare('PRAGMA application_id').get() as { application_id?: unknown }).application_id)
  const version = Number((database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version)
  if (applicationId !== APPLICATION_ID || version !== DATABASE_VERSION) {
    throw new Error('REMOTE_CONTROL_INTENT_DATABASE_UNSUPPORTED')
  }
  readIntent(database)
}
