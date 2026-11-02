import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  calculateMusicCatalogRevision,
  normalizeCatalogCodeForVideoMatch,
  normalizeMusicCatalogText
} from './src/music-catalog'
import type {
  MusicCatalogDatabasePage,
  MusicCatalogDatabaseQuery,
  MusicCatalogMetadata,
  MusicCatalogRecord,
  MusicCatalogRepository
} from './src/music-catalog'

const DATABASE_FILENAME = 'karaoke.sqlite'
const LEGACY_FILENAME = 'karaoke-data.json'
const LEGACY_MIGRATION = 'electron-store-v1'
const BASE_SCHEMA_VERSION = 4
const PREVIOUS_SCHEMA_VERSION = 5
const SCHEMA_VERSION = 6

interface DatabaseEntry {
  id: string
  sessionId: string | null
  name: string
  songNumber: string
  songNumber2: string
  table: string
  insertedAt: number
  status: EntryStatus
  doneAt: number | null
  cancelledAt: number | null
  queueOrder: number | null
  historyOrder: number | null
}

interface DatabaseSession {
  id: string
  startedAt: number
  endedAt: number | null
  order: number
}

interface DatabaseSnapshot {
  sessions: DatabaseSession[]
  entries: Map<string, DatabaseEntry>
  appState: {
    currentSessionId: string | null
    priorityIdsJson: string
    fixedTurnPositionsJson: string
    frozenTurnIdsJson: string
    queueOrderPolicyVersion: number
    regularsSinceDebut: number
    currentTurnAutomatic: number
    nextTurnId: string | null
    currentTurnId: string | null
    lastReset: string | null
    trialStartedAt: number | null
    licenseActivated: number
  }
}

interface DatabaseEntryRow {
  id: string
  session_id: string | null
  name: string
  song_number: string
  song_number2: string
  table_number: string
  inserted_at: number
  status: EntryStatus
  done_at: number | null
  cancelled_at: number | null
  queue_order: number | null
  history_order: number | null
}

interface DatabaseSessionRow {
  id: string
  started_at: number
  ended_at: number | null
}

interface DatabaseAppStateRow {
  current_session_id: string | null
  priority_ids_json: string
  fixed_turn_positions_json: string
  frozen_turn_ids_json: string
  queue_order_policy_version: number
  regulars_since_debut: number
  current_turn_automatic: number
  next_turn_id: string | null
  current_turn_id: string | null
  last_reset: string | null
  trial_started_at: number | null
  license_activated: number
}

interface DatabaseMusicCatalogRow {
  music_number: string
  video_code: string
  artist: string | null
  title: string | null
  normalized_artist: string
  normalized_title: string
}

interface DatabaseMusicCatalogMetadataRow {
  revision: string
  imported_at: string
  record_count: number
  source_name: string | null
}

interface KaraokeDatabase extends MusicCatalogRepository {
  databasePath: string
  loadState: () => StoredAppState
  saveState: (state: AppState) => void
  close: () => void
}

export interface PlayerMusicCatalogDatabase extends MusicCatalogRepository {
  databasePath: string
  close: () => void
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    throw error
  }
}

function readTransaction<T>(database: DatabaseSync, operation: () => T): T {
  if (database.isTransaction) throw new Error('SQLite transaction is unresolved; catalog reads require reopening the database.')
  database.exec('BEGIN')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    throw error
  }
}

function initializeSchema(database: DatabaseSync): void {
  let version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  if (version > SCHEMA_VERSION) {
    throw new Error(`Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}.`)
  }
  if (version === SCHEMA_VERSION) return

  if (version === PREVIOUS_SCHEMA_VERSION) {
    transaction(database, () => {
      database.exec(`ALTER TABLE music_catalog_metadata ADD COLUMN source_name TEXT
        CHECK (source_name IS NULL OR length(source_name) <= 255);`)
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
    })
    return
  }

  if (version === 1) {
    transaction(database, () => {
      database.exec("ALTER TABLE app_state ADD COLUMN fixed_turn_positions_json TEXT NOT NULL DEFAULT '{}';")
      database.exec("ALTER TABLE app_state ADD COLUMN frozen_turn_ids_json TEXT NOT NULL DEFAULT '[]';")
      database.exec('ALTER TABLE app_state ADD COLUMN queue_order_policy_version INTEGER NOT NULL DEFAULT 0;')
      database.exec('ALTER TABLE app_state ADD COLUMN regulars_since_debut INTEGER NOT NULL DEFAULT 0;')
      database.exec('ALTER TABLE app_state ADD COLUMN current_turn_automatic INTEGER NOT NULL DEFAULT 0;')
      database.exec(`PRAGMA user_version = ${BASE_SCHEMA_VERSION};`)
    })
    version = BASE_SCHEMA_VERSION
  }

  if (version === 2) {
    transaction(database, () => {
      database.exec("ALTER TABLE app_state ADD COLUMN frozen_turn_ids_json TEXT NOT NULL DEFAULT '[]';")
      database.exec('ALTER TABLE app_state ADD COLUMN queue_order_policy_version INTEGER NOT NULL DEFAULT 0;')
      database.exec('ALTER TABLE app_state ADD COLUMN regulars_since_debut INTEGER NOT NULL DEFAULT 0;')
      database.exec('ALTER TABLE app_state ADD COLUMN current_turn_automatic INTEGER NOT NULL DEFAULT 0;')
      database.exec(`PRAGMA user_version = ${BASE_SCHEMA_VERSION};`)
    })
    version = BASE_SCHEMA_VERSION
  }

  if (version === 3) {
    transaction(database, () => {
      database.exec('ALTER TABLE app_state ADD COLUMN queue_order_policy_version INTEGER NOT NULL DEFAULT 0;')
      database.exec('ALTER TABLE app_state ADD COLUMN regulars_since_debut INTEGER NOT NULL DEFAULT 0;')
      database.exec('ALTER TABLE app_state ADD COLUMN current_turn_automatic INTEGER NOT NULL DEFAULT 0;')
      database.exec(`PRAGMA user_version = ${BASE_SCHEMA_VERSION};`)
    })
    version = BASE_SCHEMA_VERSION
  }

  transaction(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        session_order INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        name TEXT NOT NULL,
        song_number TEXT NOT NULL,
        song_number2 TEXT NOT NULL DEFAULT '',
        table_number TEXT NOT NULL,
        inserted_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'cancelled')),
        done_at INTEGER,
        cancelled_at INTEGER,
        queue_order INTEGER,
        history_order INTEGER,
        CHECK (
          (status = 'pending' AND queue_order IS NOT NULL AND history_order IS NULL)
          OR
          (status IN ('done', 'cancelled') AND queue_order IS NULL AND history_order IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS entries_by_session_status
        ON entries(session_id, status);

      CREATE TABLE IF NOT EXISTS app_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        current_session_id TEXT,
        priority_ids_json TEXT NOT NULL DEFAULT '[]',
        fixed_turn_positions_json TEXT NOT NULL DEFAULT '{}',
        frozen_turn_ids_json TEXT NOT NULL DEFAULT '[]',
        queue_order_policy_version INTEGER NOT NULL DEFAULT 0,
        regulars_since_debut INTEGER NOT NULL DEFAULT 0,
        current_turn_automatic INTEGER NOT NULL DEFAULT 0,
        next_turn_id TEXT,
        current_turn_id TEXT,
        last_reset TEXT,
        trial_started_at INTEGER,
        license_activated INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS app_metadata (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      PRAGMA user_version = ${BASE_SCHEMA_VERSION};
    `)
  })
  if (version === 0) version = BASE_SCHEMA_VERSION

  if (version !== BASE_SCHEMA_VERSION) {
    throw new Error(`Database schema version ${version} cannot be migrated to ${SCHEMA_VERSION}.`)
  }

  transaction(database, () => {
    database.exec(`
      CREATE TABLE music_catalog (
        music_number TEXT PRIMARY KEY COLLATE BINARY
          CHECK (length(music_number) BETWEEN 1 AND 5
            AND substr(music_number, 1, 1) BETWEEN '1' AND '9'
            AND music_number NOT GLOB '*[^0-9]*'),
        video_code TEXT NOT NULL UNIQUE
          CHECK (length(video_code) = 5 AND video_code NOT GLOB '*[^0-9]*'),
        artist TEXT,
        title TEXT,
        normalized_artist TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        CHECK (artist IS NULL OR length(artist) <= 4096),
        CHECK (title IS NULL OR length(title) <= 4096)
      ) WITHOUT ROWID;

      CREATE TABLE music_catalog_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision TEXT NOT NULL CHECK (length(revision) = 64 AND revision NOT GLOB '*[^a-f0-9]*'),
        imported_at TEXT NOT NULL,
        record_count INTEGER NOT NULL CHECK (record_count > 0),
        source_name TEXT CHECK (source_name IS NULL OR length(source_name) <= 255)
      );

      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
  })
}

function normalizeEntry(entry: QueueEntry, status: EntryStatus): DatabaseEntry {
  if (!entry || typeof entry !== 'object' || !entry.id) {
    throw new Error('Cannot save an entry without an id.')
  }

  return {
    id: String(entry.id),
    sessionId: entry.sessionId == null ? null : String(entry.sessionId),
    name: String(entry.name ?? ''),
    songNumber: String(entry.songNumber ?? ''),
    songNumber2: String(entry.songNumber2 ?? ''),
    table: String(entry.table ?? ''),
    insertedAt: Number(entry.insertedAt) || 0,
    status,
    doneAt: entry.doneAt == null ? null : Number(entry.doneAt),
    cancelledAt: entry.cancelledAt == null ? null : Number(entry.cancelledAt),
    queueOrder: null,
    historyOrder: null
  }
}

function normalizeSnapshot(state: StoredAppState): DatabaseSnapshot {
  const sessions = (Array.isArray(state.sessions) ? state.sessions : []).map((session, index) => {
    if (!session || !session.id) throw new Error('Cannot save a session without an id.')
    return {
      id: String(session.id),
      startedAt: Number(session.startedAt) || 0,
      endedAt: session.endedAt == null ? null : Number(session.endedAt),
      order: index
    }
  })

  const entries = new Map()
  const addEntry = (entry: QueueEntry, status: EntryStatus, orderKey: 'queueOrder' | 'historyOrder', index: number): void => {
    const row = normalizeEntry(entry, status)
    if (entries.has(row.id)) throw new Error(`Duplicate entry id "${row.id}" in saved state.`)
    row.queueOrder = orderKey === 'queueOrder' ? index : null
    row.historyOrder = orderKey === 'historyOrder' ? index : null
    entries.set(row.id, row)
  }

  ;(Array.isArray(state.queue) ? state.queue : []).forEach((entry, index) => {
    addEntry(entry, 'pending', 'queueOrder', index)
  })
  ;(Array.isArray(state.history) ? state.history : []).forEach((entry, index) => {
    if (entry.status === 'pending') {
      // Pending entries from an ended session remain pending in the archive.
      // They keep queue_order in SQLite, but are loaded into history because
      // their session_id differs from app_state.current_session_id.
      addEntry(entry, 'pending', 'queueOrder', index)
      return
    }
    if (entry.status !== 'done' && entry.status !== 'cancelled') {
      throw new Error(`Cannot save history entry with status "${entry.status}".`)
    }
    addEntry(entry, entry.status, 'historyOrder', index)
  })

  return {
    sessions,
    entries,
    appState: {
      currentSessionId: state.currentSessionId == null ? null : String(state.currentSessionId),
      priorityIdsJson: JSON.stringify(Array.isArray(state.priorityIds) ? state.priorityIds : []),
      fixedTurnPositionsJson: JSON.stringify(state.fixedTurnPositions && typeof state.fixedTurnPositions === 'object'
        ? state.fixedTurnPositions : {}),
      frozenTurnIdsJson: JSON.stringify(Array.isArray(state.frozenTurnIds) ? state.frozenTurnIds : []),
      queueOrderPolicyVersion: Number(state.queueOrderPolicyVersion) || 0,
      regularsSinceDebut: Math.max(0, Math.min(2, Math.trunc(Number(state.regularsSinceDebut) || 0))),
      currentTurnAutomatic: state.currentTurnAutomatic === true ? 1 : 0,
      nextTurnId: state.nextTurnId == null ? null : String(state.nextTurnId),
      currentTurnId: state.currentTurnId == null ? null : String(state.currentTurnId),
      lastReset: state.lastReset == null ? null : String(state.lastReset),
      // The pre-v1 30-day/password fields remain only for schema compatibility.
      trialStartedAt: null,
      licenseActivated: 0
    }
  }
}

function snapshotsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function writeSnapshot(database: DatabaseSync, state: StoredAppState): void {
  const queue = Array.isArray(state.queue) ? state.queue : []
  const history = Array.isArray(state.history) ? state.history : []
  const sessions = Array.isArray(state.sessions) ? state.sessions : []

  database.exec('DELETE FROM entries; DELETE FROM sessions; DELETE FROM app_state;')

  const insertSession = database.prepare(
    'INSERT INTO sessions (id, started_at, ended_at, session_order) VALUES (?, ?, ?, ?)'
  )
  sessions.forEach((session, index) => {
    if (!session || !session.id) throw new Error('Cannot save a session without an id.')
    insertSession.run(String(session.id), Number(session.startedAt) || 0,
      session.endedAt == null ? null : Number(session.endedAt), index)
  })

  const insertEntry = database.prepare(`
    INSERT INTO entries (
      id, session_id, name, song_number, song_number2, table_number,
      inserted_at, status, done_at, cancelled_at, queue_order, history_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  queue.forEach((entry, index) => {
    const row = normalizeEntry(entry, 'pending')
    insertEntry.run(row.id, row.sessionId, row.name, row.songNumber, row.songNumber2,
      row.table, row.insertedAt, row.status, null, null, index, null)
  })

  history.forEach((entry, index) => {
    const status = entry.status
    if (status !== 'done' && status !== 'cancelled') {
      throw new Error(`Cannot save history entry with status "${status}".`)
    }
    const row = normalizeEntry(entry, status)
    insertEntry.run(row.id, row.sessionId, row.name, row.songNumber, row.songNumber2,
      row.table, row.insertedAt, row.status, row.doneAt, row.cancelledAt, null, index)
  })

  database.prepare(`
    INSERT INTO app_state (
      singleton, current_session_id, priority_ids_json, fixed_turn_positions_json, frozen_turn_ids_json, next_turn_id,
      current_turn_id, last_reset, trial_started_at, license_activated, queue_order_policy_version,
      regulars_since_debut, current_turn_automatic
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    state.currentSessionId == null ? null : String(state.currentSessionId),
    JSON.stringify(Array.isArray(state.priorityIds) ? state.priorityIds : []),
    JSON.stringify(state.fixedTurnPositions && typeof state.fixedTurnPositions === 'object'
      ? state.fixedTurnPositions : {}),
    JSON.stringify(Array.isArray(state.frozenTurnIds) ? state.frozenTurnIds : []),
    state.nextTurnId == null ? null : String(state.nextTurnId),
    state.currentTurnId == null ? null : String(state.currentTurnId),
    state.lastReset == null ? null : String(state.lastReset),
    null,
    0,
    Number(state.queueOrderPolicyVersion) || 0,
    Math.max(0, Math.min(2, Math.trunc(Number(state.regularsSinceDebut) || 0))),
    state.currentTurnAutomatic === true ? 1 : 0
  )
}

function migrateLegacyStore(database: DatabaseSync, legacyPath: string): void {
  const getMetadata = database.prepare('SELECT value FROM app_metadata WHERE name = ?')
  if (getMetadata.get(LEGACY_MIGRATION)) return

  let legacyState: StoredAppState | null = null
  if (fs.existsSync(legacyPath)) {
    const contents = fs.readFileSync(legacyPath, 'utf8')
    legacyState = JSON.parse(contents)
    if (!legacyState || typeof legacyState !== 'object' || Array.isArray(legacyState)) {
      throw new Error(`Legacy data at ${legacyPath} is not a valid state object.`)
    }
  }

  transaction(database, () => {
    const hasExistingState = Boolean(database.prepare(
      'SELECT 1 FROM app_state WHERE singleton = 1'
    ).get())

    if (legacyState && !hasExistingState) writeSnapshot(database, legacyState)

    database.prepare('INSERT INTO app_metadata (name, value) VALUES (?, ?)')
      .run(LEGACY_MIGRATION, new Date().toISOString())
  })
}

function mapEntry(row: DatabaseEntryRow): QueueEntry {
  const entry: QueueEntry = {
    id: row.id,
    name: row.name,
    songNumber: row.song_number,
    songNumber2: row.song_number2,
    table: row.table_number,
    insertedAt: row.inserted_at,
    status: row.status,
    sessionId: row.session_id
  }
  if (row.done_at != null) entry.doneAt = row.done_at
  if (row.cancelled_at != null) entry.cancelledAt = row.cancelled_at
  return entry
}

function mapMusicCatalogRecord(row: DatabaseMusicCatalogRow): MusicCatalogRecord {
  return {
    musicNumber: row.music_number,
    videoCode: row.video_code,
    artist: row.artist,
    title: row.title,
    normalizedArtist: row.normalized_artist,
    normalizedTitle: row.normalized_title
  }
}

function mapMusicCatalogMetadata(row: DatabaseMusicCatalogMetadataRow | undefined): MusicCatalogMetadata {
  return row
    ? { revision: row.revision, importedAt: row.imported_at, recordCount: row.record_count, sourceName: row.source_name ?? null }
    : { revision: null, importedAt: null, recordCount: 0, sourceName: null }
}

function validateMusicCatalogRecords(records: readonly MusicCatalogRecord[]): MusicCatalogRecord[] {
  if (!Array.isArray(records) || records.length === 0 || records.length > 100_000) {
    throw new Error('A catalog replacement must contain between 1 and 100000 records.')
  }
  return records.map(record => {
    if (!record || typeof record !== 'object' ||
        typeof record.musicNumber !== 'string' || typeof record.videoCode !== 'string' ||
        (record.artist !== null && typeof record.artist !== 'string') ||
        (record.title !== null && typeof record.title !== 'string') ||
        typeof record.normalizedArtist !== 'string' || typeof record.normalizedTitle !== 'string') {
      throw new Error('A catalog replacement contains an invalid record.')
    }
    if (normalizeCatalogCodeForVideoMatch(record.musicNumber) !== record.videoCode ||
        record.artist?.length > 4096 || record.title?.length > 4096 ||
        record.normalizedArtist !== normalizeMusicCatalogText(record.artist) ||
        record.normalizedTitle !== normalizeMusicCatalogText(record.title)) {
      throw new Error('A catalog replacement contains inconsistent music metadata.')
    }
    return { ...record }
  })
}

function createMusicCatalogRepository(database: DatabaseSync): MusicCatalogRepository {
  const readMetadata = (): MusicCatalogMetadata => {
    const row = database.prepare(
      'SELECT revision, imported_at, record_count, source_name FROM music_catalog_metadata WHERE singleton = 1'
    ).get() as unknown as DatabaseMusicCatalogMetadataRow | undefined
    return mapMusicCatalogMetadata(row)
  }

  const getMusicCatalogMetadata = (): MusicCatalogMetadata => {
    if (database.isTransaction) throw new Error('SQLite transaction is unresolved; catalog metadata cannot be read.')
    return readMetadata()
  }

  const replaceMusicCatalog = (inputRecords: readonly MusicCatalogRecord[], metadata: { revision: string; importedAt: string; sourceName?: string | null }): void => {
    const records = validateMusicCatalogRecords(inputRecords)
    if (!metadata || typeof metadata.revision !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.revision) ||
        typeof metadata.importedAt !== 'string' || !Number.isFinite(Date.parse(metadata.importedAt)) ||
        new Date(metadata.importedAt).toISOString() !== metadata.importedAt ||
        (metadata.sourceName !== undefined && metadata.sourceName !== null &&
          (typeof metadata.sourceName !== 'string' || metadata.sourceName.length > 255 || /[\u0000-\u001f\u007f]/.test(metadata.sourceName))) ||
        calculateMusicCatalogRevision(records) !== metadata.revision) {
      throw new Error('Catalog revision or import timestamp is invalid.')
    }
    if (database.isTransaction) throw new Error('SQLite transaction is unresolved; catalog replacement is blocked.')
    transaction(database, () => {
      database.exec('DELETE FROM music_catalog;')
      const insertRecord = database.prepare(`
        INSERT INTO music_catalog (
          music_number, video_code, artist, title, normalized_artist, normalized_title
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      for (const record of records) {
        insertRecord.run(record.musicNumber, record.videoCode, record.artist, record.title,
          record.normalizedArtist, record.normalizedTitle)
      }
      database.prepare(`
        INSERT INTO music_catalog_metadata (singleton, revision, imported_at, record_count, source_name)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          revision = excluded.revision,
          imported_at = excluded.imported_at,
          record_count = excluded.record_count,
          source_name = excluded.source_name
      `).run(metadata.revision, metadata.importedAt, records.length, metadata.sourceName ?? null)
    })
  }

  const searchMusicCatalog = (query: MusicCatalogDatabaseQuery): MusicCatalogDatabasePage => {
    if (!query || typeof query !== 'object' ||
        (query.originalCodePrefix !== null && typeof query.originalCodePrefix !== 'string') ||
        (query.videoCodePrefix !== null && typeof query.videoCodePrefix !== 'string') ||
        typeof query.normalizedText !== 'string' || query.normalizedText.length > 256 ||
        !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100 ||
        !Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > 1_000_000) {
      throw new Error('Catalog search parameters are invalid.')
    }
    return readTransaction(database, () => {
      const metadata = readMetadata()
      if (query.normalizedText.length === 0 && !query.originalCodePrefix && !query.videoCodePrefix) {
        return { metadata, total: 0, records: [] }
      }
      const where = `
        ((? <> '' AND music_number >= ? AND music_number < ?)
         OR (? <> '' AND video_code >= ? AND video_code < ?)
         OR (? <> '' AND (instr(normalized_artist, ?) > 0 OR instr(normalized_title, ?) > 0)))
      `
      const parameters = [
        query.originalCodePrefix ?? '', query.originalCodePrefix ?? '', `${query.originalCodePrefix ?? ''}\uffff`,
        query.videoCodePrefix ?? '', query.videoCodePrefix ?? '', `${query.videoCodePrefix ?? ''}\uffff`,
        query.normalizedText, query.normalizedText, query.normalizedText
      ]
      const totalRow = database.prepare(`SELECT COUNT(*) AS count FROM music_catalog WHERE ${where}`)
        .get(...parameters) as { count: number }
      const rows = database.prepare(`
        SELECT music_number, video_code, artist, title, normalized_artist, normalized_title
        FROM music_catalog WHERE ${where}
        ORDER BY length(music_number), music_number COLLATE BINARY LIMIT ? OFFSET ?
      `).all(...parameters, query.limit, query.offset) as unknown as DatabaseMusicCatalogRow[]
      return { metadata, total: totalRow.count, records: rows.map(mapMusicCatalogRecord) }
    })
  }

  const getMusicCatalogRecordByVideoCode = (videoCode: string): { metadata: MusicCatalogMetadata; record: MusicCatalogRecord | null } => {
    if (typeof videoCode !== 'string' || !/^[0-9]{5}$/.test(videoCode)) throw new Error('A canonical five-digit video code is required.')
    return readTransaction(database, () => {
      const metadata = readMetadata()
      const row = database.prepare(`
        SELECT music_number, video_code, artist, title, normalized_artist, normalized_title
        FROM music_catalog WHERE video_code = ?
      `).get(videoCode) as unknown as DatabaseMusicCatalogRow | undefined
      return { metadata, record: row ? mapMusicCatalogRecord(row) : null }
    })
  }
  return { getMusicCatalogMetadata, replaceMusicCatalog, searchMusicCatalog, getMusicCatalogRecordByVideoCode }
}

const PLAYER_MUSIC_CATALOG_FILENAME = 'player-music-catalog.sqlite'
const PLAYER_CATALOG_SCHEMA_VERSION = 2

function sameDatabaseFile(first: fs.BigIntStats, second: fs.BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

function optionalLstat(filePath: string): fs.BigIntStats | undefined {
  try { return fs.lstatSync(filePath, { bigint: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Reject links and aliases before SQLite can touch a Controller database or its WAL files. */
function assertPlayerCatalogDatabasePathsSafe(userDataPath: string, playerDatabasePath: string): void {
  const operationalPaths = [DATABASE_FILENAME, `${DATABASE_FILENAME}-wal`, `${DATABASE_FILENAME}-shm`]
    .map(name => path.join(userDataPath, name))
  const protectedFiles: fs.BigIntStats[] = []
  for (const filePath of operationalPaths) {
    try {
      const stats = fs.statSync(filePath, { bigint: true })
      if (stats.isFile()) protectedFiles.push(stats)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  for (const candidate of [playerDatabasePath, `${playerDatabasePath}-wal`, `${playerDatabasePath}-shm`]) {
    const linkStats = optionalLstat(candidate)
    if (!linkStats) continue
    const attributes = (linkStats as fs.BigIntStats & { attributes?: number }).attributes ?? 0
    if (!linkStats.isFile() || linkStats.isSymbolicLink() || (process.platform === 'win32' && (attributes & 0x400) !== 0)) {
      throw new Error('Player music catalog database must be a regular file without reparse points.')
    }
    let targetStats: fs.BigIntStats
    try { targetStats = fs.statSync(candidate, { bigint: true }) }
    catch { throw new Error('Player music catalog database could not be verified safely.') }
    if (protectedFiles.some(protectedFile => sameDatabaseFile(targetStats, protectedFile))) {
      throw new Error('Player music catalog database must not alias the Controller operational database.')
    }
  }
}

function ensurePlayerCatalogFileExists(databasePath: string): void {
  if (optionalLstat(databasePath)) return
  let descriptor: number
  try { descriptor = fs.openSync(databasePath, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && optionalLstat(databasePath)) return
    throw error
  }
  fs.closeSync(descriptor)
}

/** Metadata-only store for Player mode. It has no Controller queue/session tables. */
export function createPlayerMusicCatalogDatabase(userDataPath: string): PlayerMusicCatalogDatabase {
  const databasePath = path.join(userDataPath, PLAYER_MUSIC_CATALOG_FILENAME)
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  assertPlayerCatalogDatabasePathsSafe(userDataPath, databasePath)
  ensurePlayerCatalogFileExists(databasePath)
  assertPlayerCatalogDatabasePathsSafe(userDataPath, databasePath)
  const beforeOpen = optionalLstat(databasePath)
  if (!beforeOpen) throw new Error('Player music catalog database could not be created safely.')
  const database = new DatabaseSync(databasePath)
  try {
    const openedDatabase = database.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>
    const mainDatabase = openedDatabase.find(entry => entry.name === 'main')
    const afterOpen = optionalLstat(databasePath)
    assertPlayerCatalogDatabasePathsSafe(userDataPath, databasePath)
    if (!mainDatabase || path.resolve(mainDatabase.file) !== path.resolve(databasePath) ||
        !afterOpen || !sameDatabaseFile(beforeOpen, afterOpen)) {
      throw new Error('Player music catalog database changed identity while it was opened.')
    }
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > PLAYER_CATALOG_SCHEMA_VERSION) throw new Error('Player music catalog database version is newer than this application.')
    if (version === 1) transaction(database, () => {
      database.exec(`ALTER TABLE music_catalog_metadata ADD COLUMN source_name TEXT
        CHECK (source_name IS NULL OR length(source_name) <= 255);`)
      database.exec(`PRAGMA user_version = ${PLAYER_CATALOG_SCHEMA_VERSION};`)
    })
    if (version === 0) transaction(database, () => {
      database.exec(`
        CREATE TABLE music_catalog (
          music_number TEXT PRIMARY KEY COLLATE BINARY
            CHECK (length(music_number) BETWEEN 1 AND 5 AND substr(music_number, 1, 1) BETWEEN '1' AND '9' AND music_number NOT GLOB '*[^0-9]*'),
          video_code TEXT NOT NULL UNIQUE CHECK (length(video_code) = 5 AND video_code NOT GLOB '*[^0-9]*'),
          artist TEXT, title TEXT, normalized_artist TEXT NOT NULL, normalized_title TEXT NOT NULL,
          CHECK (artist IS NULL OR length(artist) <= 4096), CHECK (title IS NULL OR length(title) <= 4096)
        ) WITHOUT ROWID;
        CREATE TABLE music_catalog_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision TEXT NOT NULL CHECK (length(revision) = 64 AND revision NOT GLOB '*[^a-f0-9]*'),
          imported_at TEXT NOT NULL, record_count INTEGER NOT NULL CHECK (record_count > 0),
          source_name TEXT CHECK (source_name IS NULL OR length(source_name) <= 255)
        );
        PRAGMA user_version = ${PLAYER_CATALOG_SCHEMA_VERSION};
      `)
    })
  } catch (error) {
    database.close()
    throw error
  }
  return { databasePath, ...createMusicCatalogRepository(database), close: () => database.close() }
}

export function createKaraokeDatabase(userDataPath: string): KaraokeDatabase {
  const databasePath = path.join(userDataPath, DATABASE_FILENAME)
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })

  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    initializeSchema(database)
    migrateLegacyStore(database, path.join(userDataPath, LEGACY_FILENAME))
  } catch (error) {
    database.close()
    throw error
  }

  const readState = (): StoredAppState => {
    if (database.isTransaction) throw new Error('SQLite transaction is unresolved; recovery requires reopening the database.')
    const appState = database.prepare('SELECT * FROM app_state WHERE singleton = 1').get() as unknown as DatabaseAppStateRow | undefined
    if (!appState) return {}

    const currentSession = appState.current_session_id
      ? database.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(appState.current_session_id) as { ended_at: number | null } | undefined
      : undefined
    const hasSessions = Boolean(database.prepare('SELECT 1 FROM sessions LIMIT 1').get())
    const nullSessionIds = new Set<string>()
    if (!hasSessions) {
      for (const entry of database.prepare("SELECT id FROM entries WHERE status = 'pending' AND session_id IS NULL").all() as { id: string }[]) {
        nullSessionIds.add(entry.id)
      }
    } else if (currentSession && currentSession.ended_at == null && appState.current_session_id) {
      for (const id of [appState.current_turn_id, appState.next_turn_id,
        ...JSON.parse(appState.priority_ids_json || '[]'),
        ...Object.keys(JSON.parse(appState.fixed_turn_positions_json || '{}')),
        ...JSON.parse(appState.frozen_turn_ids_json || '[]')]) {
        if (typeof id === 'string' && id) nullSessionIds.add(id)
      }
    }
    const pending = database.prepare(
      "SELECT * FROM entries WHERE status = 'pending' AND (session_id = ? OR session_id IS NULL) ORDER BY queue_order"
    ).all(appState.current_session_id).map(row => mapEntry(row as unknown as DatabaseEntryRow))
    const activePending = pending.filter(entry =>
      (appState.current_session_id != null && entry.sessionId === appState.current_session_id) || nullSessionIds.has(entry.id))
    const ambiguousNullPending = pending.filter(entry => entry.sessionId == null && !nullSessionIds.has(entry.id))

    return {
      queue: activePending,
      history: [...database.prepare(
        `SELECT * FROM entries
         WHERE status IN ('done', 'cancelled')
            OR (status = 'pending' AND session_id IS NOT NULL AND session_id IS NOT ?)
         ORDER BY session_id, CASE WHEN status = 'pending' THEN queue_order ELSE history_order END`
      ).all(appState.current_session_id).map(row => mapEntry(row as unknown as DatabaseEntryRow)), ...ambiguousNullPending],
      sessions: database.prepare(
        'SELECT id, started_at, ended_at FROM sessions ORDER BY session_order'
      ).all().map(rawSession => {
        const session = rawSession as unknown as DatabaseSessionRow
        return ({
        id: session.id,
        startedAt: session.started_at,
        endedAt: session.ended_at
        })
      }),
      currentSessionId: appState.current_session_id,
      priorityIds: JSON.parse(appState.priority_ids_json),
      fixedTurnPositions: JSON.parse(appState.fixed_turn_positions_json || '{}'),
      frozenTurnIds: JSON.parse(appState.frozen_turn_ids_json || '[]'),
      queueOrderPolicyVersion: appState.queue_order_policy_version || 0,
      regularsSinceDebut: appState.regulars_since_debut || 0,
      currentTurnAutomatic: appState.current_turn_automatic === 1,
      nextTurnId: appState.next_turn_id,
      currentTurnId: appState.current_turn_id,
      lastReset: appState.last_reset,
      // Deprecated 30-day/password fields are intentionally not exposed to the renderer.
    }
  }

  let previousSnapshot: DatabaseSnapshot | null = normalizeSnapshot(readState())

  const saveState = (state: AppState): void => {
    const nextSnapshot = normalizeSnapshot(state)
    const previous = previousSnapshot ?? normalizeSnapshot(readState())

    try {
      transaction(database, () => {
        const saveSession = database.prepare(`
          INSERT INTO sessions (id, started_at, ended_at, session_order) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            session_order = excluded.session_order
        `)
        const deleteSession = database.prepare('DELETE FROM sessions WHERE id = ?')

        for (const session of nextSnapshot.sessions) {
          const oldSession = previous.sessions.find(item => item.id === session.id)
          if (!oldSession || !snapshotsEqual(oldSession, session)) {
            saveSession.run(session.id, session.startedAt, session.endedAt, session.order)
          }
        }
        for (const session of previous.sessions) {
          if (!nextSnapshot.sessions.some(item => item.id === session.id)) deleteSession.run(session.id)
        }

        const saveEntry = database.prepare(`
          INSERT INTO entries (
            id, session_id, name, song_number, song_number2, table_number,
            inserted_at, status, done_at, cancelled_at, queue_order, history_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            session_id = excluded.session_id,
            name = excluded.name,
            song_number = excluded.song_number,
            song_number2 = excluded.song_number2,
            table_number = excluded.table_number,
            inserted_at = excluded.inserted_at,
            status = excluded.status,
            done_at = excluded.done_at,
            cancelled_at = excluded.cancelled_at,
            queue_order = excluded.queue_order,
            history_order = excluded.history_order
        `)
        const deleteEntry = database.prepare('DELETE FROM entries WHERE id = ?')

        for (const [id, entry] of nextSnapshot.entries) {
          const oldEntry = previous.entries.get(id)
          if (!oldEntry || !snapshotsEqual(oldEntry, entry)) {
            saveEntry.run(entry.id, entry.sessionId, entry.name, entry.songNumber,
              entry.songNumber2, entry.table, entry.insertedAt, entry.status,
              entry.doneAt, entry.cancelledAt, entry.queueOrder, entry.historyOrder)
          }
        }
        for (const id of previous.entries.keys()) {
          if (!nextSnapshot.entries.has(id)) deleteEntry.run(id)
        }

        const appState = nextSnapshot.appState
        database.prepare(`
          INSERT INTO app_state (
            singleton, current_session_id, priority_ids_json, fixed_turn_positions_json, frozen_turn_ids_json, next_turn_id,
            current_turn_id, last_reset, trial_started_at, license_activated, queue_order_policy_version,
            regulars_since_debut, current_turn_automatic
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            current_session_id = excluded.current_session_id,
            priority_ids_json = excluded.priority_ids_json,
            fixed_turn_positions_json = excluded.fixed_turn_positions_json,
            frozen_turn_ids_json = excluded.frozen_turn_ids_json,
            next_turn_id = excluded.next_turn_id,
            current_turn_id = excluded.current_turn_id,
            last_reset = excluded.last_reset,
            trial_started_at = excluded.trial_started_at,
            license_activated = excluded.license_activated,
            queue_order_policy_version = excluded.queue_order_policy_version,
            regulars_since_debut = excluded.regulars_since_debut,
            current_turn_automatic = excluded.current_turn_automatic
        `).run(appState.currentSessionId, appState.priorityIdsJson, appState.fixedTurnPositionsJson, appState.frozenTurnIdsJson, appState.nextTurnId,
          appState.currentTurnId, appState.lastReset, appState.trialStartedAt,
          appState.licenseActivated, appState.queueOrderPolicyVersion, appState.regularsSinceDebut,
          appState.currentTurnAutomatic)
      })

    } catch (error) {
      // Never reuse a differential-write cache after an unsuccessful transaction.
      previousSnapshot = null
      throw error
    }
    previousSnapshot = nextSnapshot
  }
  const catalogRepository = createMusicCatalogRepository(database)
  return {
    databasePath,
    loadState: readState,
    saveState,
    ...catalogRepository,
    close: () => database.close()
  }
}
