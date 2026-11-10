import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface SqliteMigrationBackupManifest {
  formatVersion: 1
  sourceFile: 'karaoke.sqlite' | 'player-music-catalog.sqlite'
  sourceSchemaVersion: number
  createdAt: string
  backupFile: string
  sha256: string
}

const ALLOWED_DATABASES = new Set(['karaoke.sqlite', 'player-music-catalog.sqlite'])
const BACKUP_DIRECTORY = 'migration-backups'

function fail(code: string): never { throw new Error(code) }

function assertRegularDirectory(directory: string): void {
  let stat: fs.Stats
  try { stat = fs.lstatSync(directory) }
  catch { fail('SQLITE_BACKUP_DIRECTORY_UNAVAILABLE') }
  const attributes = (stat! as fs.Stats & { attributes?: number }).attributes ?? 0
  if (!stat!.isDirectory() || stat!.isSymbolicLink() ||
      (process.platform === 'win32' && (attributes & 0x400) !== 0)) fail('SQLITE_BACKUP_DIRECTORY_UNTRUSTED')
}

function writeNewFile(filePath: string, contents: string): void {
  const fd = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, contents, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function syncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

function sha256(filePath: string): string {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY)
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  try {
    let count: number
    while ((count = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count))
  } finally { fs.closeSync(descriptor) }
  return hash.digest('hex')
}

function parseManifest(value: unknown): SqliteMigrationBackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SQLITE_BACKUP_MANIFEST_INVALID')
  const record = value as Record<string, unknown>
  const keys = ['formatVersion', 'sourceFile', 'sourceSchemaVersion', 'createdAt', 'backupFile', 'sha256']
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key)) ||
      record.formatVersion !== 1 || !ALLOWED_DATABASES.has(String(record.sourceFile)) ||
      !Number.isSafeInteger(record.sourceSchemaVersion) || (record.sourceSchemaVersion as number) < 0 ||
      typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
      typeof record.backupFile !== 'string' || !/^(karaoke\.sqlite|player-music-catalog\.sqlite)\.schema-\d+\.\d{8}T\d{9}Z\.[0-9a-f-]{36}\.sqlite$/.test(record.backupFile) ||
      typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
    fail('SQLITE_BACKUP_MANIFEST_INVALID')
  }
  const sourcePrefix = `${record.sourceFile}.schema-${record.sourceSchemaVersion}.`
  if (!record.backupFile.startsWith(sourcePrefix)) fail('SQLITE_BACKUP_MANIFEST_INVALID')
  return record as unknown as SqliteMigrationBackupManifest
}

/** Validate the manifest, checksum, SQLite integrity and schema before exposing a backup. */
export function verifySqliteMigrationBackup(backupDirectory: string, manifestFile: string): {
  readonly manifest: SqliteMigrationBackupManifest
  readonly backupPath: string
} {
  if (!path.isAbsolute(backupDirectory) || path.basename(manifestFile) !== manifestFile ||
      !manifestFile.endsWith('.json')) fail('SQLITE_BACKUP_MANIFEST_PATH_INVALID')
  assertRegularDirectory(backupDirectory)
  const manifestPath = path.join(backupDirectory, manifestFile)
  const manifestStat = fs.lstatSync(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4096) fail('SQLITE_BACKUP_MANIFEST_UNTRUSTED')
  let manifest: SqliteMigrationBackupManifest
  try { manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('SQLITE_')) throw error
    throw new Error('SQLITE_BACKUP_MANIFEST_INVALID', { cause: error })
  }
  const backupPath = path.join(backupDirectory, manifest.backupFile)
  const backupStat = fs.lstatSync(backupPath)
  const attributes = (backupStat as fs.Stats & { attributes?: number }).attributes ?? 0
  if (!backupStat.isFile() || backupStat.isSymbolicLink() ||
      (process.platform === 'win32' && (attributes & 0x400) !== 0) || sha256(backupPath) !== manifest.sha256) {
    fail('SQLITE_BACKUP_CHECKSUM_MISMATCH')
  }
  const database = new DatabaseSync(backupPath, { readOnly: true })
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all()
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? -1)
    if (integrity?.integrity_check !== 'ok' || foreignKeyErrors.length !== 0 || version !== manifest.sourceSchemaVersion) {
      fail('SQLITE_BACKUP_VALIDATION_FAILED')
    }
  } finally { database.close() }
  return { manifest, backupPath }
}

/** Restore only to a new path; this API never overwrites an existing database. */
export function restoreSqliteMigrationBackupToNewPath(
  backupDirectory: string,
  manifestFile: string,
  destinationPath: string
): void {
  if (!path.isAbsolute(destinationPath)) fail('SQLITE_RESTORE_PATH_INVALID')
  const destinationDirectory = path.dirname(destinationPath)
  assertRegularDirectory(destinationDirectory)
  try {
    fs.lstatSync(destinationPath)
    fail('SQLITE_RESTORE_DESTINATION_EXISTS')
  } catch (error) {
    if (error instanceof Error && error.message === 'SQLITE_RESTORE_DESTINATION_EXISTS') throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const verified = verifySqliteMigrationBackup(backupDirectory, manifestFile)
  let destinationCreated = false
  try {
    fs.copyFileSync(verified.backupPath, destinationPath, fs.constants.COPYFILE_EXCL)
    destinationCreated = true
    // FlushFileBuffers (used by Node's fsync on Windows) needs a handle opened
    // with write access even though this operation does not modify the bytes.
    const fd = fs.openSync(destinationPath, fs.constants.O_RDWR)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    const restored = new DatabaseSync(destinationPath, { readOnly: true })
    try {
      const integrity = restored.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined
      const version = Number(restored.prepare('PRAGMA user_version').get()?.user_version ?? -1)
      if (integrity?.integrity_check !== 'ok' || version !== verified.manifest.sourceSchemaVersion) {
        fail('SQLITE_RESTORE_VALIDATION_FAILED')
      }
    } finally { restored.close() }
    syncDirectory(destinationDirectory)
  } catch (error) {
    if (destinationCreated) try { fs.unlinkSync(destinationPath) } catch {}
    if (error instanceof Error && error.message.startsWith('SQLITE_')) throw error
    throw new Error('SQLITE_RESTORE_FAILED', { cause: error })
  }
}

/**
 * Take a consistent SQLite snapshot before a supported in-place schema migration.
 * The snapshot is never overwritten and is published only after integrity/readback checks.
 */
export function createSqliteMigrationBackup(options: {
  database: DatabaseSync
  databasePath: string
  userDataDirectory: string
  sourceSchemaVersion: number
}): SqliteMigrationBackupManifest {
  const sourceFile = path.basename(options.databasePath)
  if (!ALLOWED_DATABASES.has(sourceFile) || !path.isAbsolute(options.databasePath) ||
      !path.isAbsolute(options.userDataDirectory) || !Number.isSafeInteger(options.sourceSchemaVersion) ||
      options.sourceSchemaVersion < 0 || options.database.isTransaction) {
    fail('SQLITE_BACKUP_ARGUMENTS_INVALID')
  }
  const relativeSource = path.relative(path.resolve(options.userDataDirectory), path.resolve(options.databasePath))
  if (relativeSource !== sourceFile) fail('SQLITE_BACKUP_SOURCE_OUTSIDE_PROFILE')

  assertRegularDirectory(options.userDataDirectory)
  const sourceStat = fs.lstatSync(options.databasePath)
  const attributes = (sourceStat as fs.Stats & { attributes?: number }).attributes ?? 0
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || (process.platform === 'win32' && (attributes & 0x400) !== 0)) {
    fail('SQLITE_BACKUP_SOURCE_UNTRUSTED')
  }

  const directory = path.join(options.userDataDirectory, BACKUP_DIRECTORY)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertRegularDirectory(directory)

  const createdAt = new Date().toISOString()
  const stamp = createdAt.replace(/[-:.]/g, '')
  const token = crypto.randomUUID()
  const stem = `${sourceFile}.schema-${options.sourceSchemaVersion}.${stamp}.${token}`
  const backupFile = `${stem}.sqlite`
  const manifestFile = `${stem}.json`
  const temporaryDatabase = path.join(directory, `.${stem}.tmp.sqlite`)
  const temporaryManifest = path.join(directory, `.${stem}.tmp.json`)
  const finalDatabase = path.join(directory, backupFile)
  const finalManifest = path.join(directory, manifestFile)
  let databasePublished = false
  let manifestPublished = false

  try {
    if (fs.existsSync(finalDatabase) || fs.existsSync(finalManifest)) fail('SQLITE_BACKUP_TARGET_EXISTS')
    options.database.prepare('VACUUM INTO ?').run(temporaryDatabase)
    const tempStat = fs.lstatSync(temporaryDatabase)
    if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.size === 0) fail('SQLITE_BACKUP_OUTPUT_INVALID')
    fs.chmodSync(temporaryDatabase, 0o600)

    const verified = new DatabaseSync(temporaryDatabase, { readOnly: true })
    try {
      const integrity = verified.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined
      const foreignKeyErrors = verified.prepare('PRAGMA foreign_key_check').all()
      const version = Number(verified.prepare('PRAGMA user_version').get()?.user_version ?? -1)
      if (integrity?.integrity_check !== 'ok' || foreignKeyErrors.length !== 0 ||
          version !== options.sourceSchemaVersion) fail('SQLITE_BACKUP_VALIDATION_FAILED')
    } finally {
      verified.close()
    }

    const checksum = sha256(temporaryDatabase)
    const manifest: SqliteMigrationBackupManifest = {
      formatVersion: 1,
      sourceFile: sourceFile as SqliteMigrationBackupManifest['sourceFile'],
      sourceSchemaVersion: options.sourceSchemaVersion,
      createdAt,
      backupFile,
      sha256: checksum
    }
    fs.renameSync(temporaryDatabase, finalDatabase)
    databasePublished = true
    writeNewFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.renameSync(temporaryManifest, finalManifest)
    manifestPublished = true
    syncDirectory(directory)
    return manifest
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SQLITE_BACKUP_')) throw error
    throw new Error('SQLITE_BACKUP_FAILED', { cause: error })
  } finally {
    for (const filePath of [temporaryDatabase, temporaryManifest]) {
      try { fs.unlinkSync(filePath) } catch {}
    }
    // An incomplete newly-created snapshot is not a recovery point. It belongs only
    // to this invocation; complete prior backups are never removed or replaced.
    if (databasePublished && !manifestPublished) {
      try { fs.unlinkSync(finalDatabase) } catch {}
    }
  }
}
