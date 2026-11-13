import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createSqliteMigrationBackup } from './src/sqlite-migration-backup'
import {
  MusicCatalogError,
  calculateMusicCatalogRevision,
  normalizeCatalogCodeForVideoMatch,
  normalizeMusicCatalogText
} from './src/music-catalog'
import type {
  MusicCatalogDatabasePage,
  MusicCatalogDatabaseQuery,
  MusicCatalogImportIssue,
  MusicCatalogImportIssuePage,
  MusicCatalogMetadata,
  MusicCatalogRecord,
  MusicCatalogRepository
} from './src/music-catalog'
import type { ManagementOutboxDatabase, ManagementOutboxRecord } from './src/management-remote-outbox'
import type { ManagementRemoteJournalDatabase, ManagementRemoteJournalCursor } from './src/management-remote-journal'
import { parseOperationalMessageObject } from './src/operational-protocol-validation'

const DATABASE_FILENAME = 'karaoke.sqlite'
const LEGACY_FILENAME = 'karaoke-data.json'
const LEGACY_MIGRATION = 'electron-store-v1'
const BASE_SCHEMA_VERSION = 4
const PREVIOUS_SCHEMA_VERSION = 5
const CATALOG_SCHEMA_VERSION = 6
const OUTBOX_SCHEMA_VERSION = 7
const JOURNAL_SCHEMA_VERSION = 8
const JOURNAL_RECOVERY_SCHEMA_VERSION = 9
const SCHEMA_VERSION = 10
const MANAGEMENT_REMOTE_OUTBOX_SCHEMA = `CREATE TABLE management_remote_outbox (
  player_device_id TEXT NOT NULL CHECK (length(player_device_id) BETWEEN 1 AND 128),
  controller_id TEXT NOT NULL CHECK (length(controller_id) BETWEEN 1 AND 128),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  command_json TEXT NOT NULL CHECK (length(CAST(command_json AS BLOB)) BETWEEN 1 AND 65536),
  status TEXT NOT NULL CHECK (status IN ('not-sent', 'rejected', 'accepted', 'completed', 'unknown')),
  detail_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_device_id, controller_id, operation_id)
) STRICT;
CREATE INDEX management_remote_outbox_recoverable
  ON management_remote_outbox(status, created_at, operation_id);`
const MANAGEMENT_REMOTE_JOURNAL_SCHEMA = `CREATE TABLE management_remote_journal_state (
  player_device_id TEXT NOT NULL CHECK (length(player_device_id) BETWEEN 1 AND 128),
  controller_id TEXT NOT NULL CHECK (length(controller_id) BETWEEN 1 AND 128),
  journal_id TEXT NOT NULL CHECK (length(journal_id) BETWEEN 1 AND 128),
  through_sequence INTEGER NOT NULL CHECK (through_sequence BETWEEN 0 AND 9007199254740991),
  high_watermark INTEGER NOT NULL CHECK (high_watermark BETWEEN through_sequence AND 9007199254740991),
  compacted_through INTEGER NOT NULL CHECK (compacted_through BETWEEN 0 AND high_watermark),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_device_id, controller_id)
) STRICT;
CREATE TABLE management_remote_journal_events (
  player_device_id TEXT NOT NULL,
  controller_id TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL CHECK (event_sequence BETWEEN 1 AND 9007199254740991),
  event_json TEXT NOT NULL CHECK (length(CAST(event_json AS BLOB)) BETWEEN 1 AND 8192),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint)=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY (player_device_id, controller_id, event_sequence),
  FOREIGN KEY (player_device_id, controller_id) REFERENCES management_remote_journal_state(player_device_id, controller_id)
) STRICT;
CREATE TABLE management_remote_journal_snapshots (
  player_device_id TEXT NOT NULL,
  controller_id TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  high_watermark INTEGER NOT NULL CHECK (high_watermark BETWEEN 0 AND 9007199254740991),
  snapshot_json TEXT NOT NULL CHECK (length(CAST(snapshot_json AS BLOB)) BETWEEN 1 AND 65536),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint)=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_device_id, controller_id, high_watermark),
  FOREIGN KEY (player_device_id, controller_id) REFERENCES management_remote_journal_state(player_device_id, controller_id)
) STRICT;
CREATE INDEX management_remote_journal_events_page
  ON management_remote_journal_events(player_device_id, controller_id, event_sequence);`

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

interface KaraokeDatabase extends MusicCatalogRepository, ManagementOutboxDatabase, ManagementRemoteJournalDatabase {
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

function stableRemoteJournalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableRemoteJournalJson).join(',') + ']'
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + stableRemoteJournalJson(record[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function remoteJournalFingerprint(value: unknown): string {
  return createHash('sha256').update(stableRemoteJournalJson(value), 'utf8').digest('hex')
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
      database.exec(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION};`)
    })
    version = CATALOG_SCHEMA_VERSION
  }

  if (version === CATALOG_SCHEMA_VERSION) {
    transaction(database, () => {
      database.exec(`${MANAGEMENT_REMOTE_OUTBOX_SCHEMA}; PRAGMA user_version = ${OUTBOX_SCHEMA_VERSION};`)
    })
    version = OUTBOX_SCHEMA_VERSION
  }

  if (version === OUTBOX_SCHEMA_VERSION) {
    transaction(database, () => {
      database.exec(`${MANAGEMENT_REMOTE_JOURNAL_SCHEMA}; PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION};`)
    })
    version = JOURNAL_SCHEMA_VERSION
  }

  if (version === JOURNAL_SCHEMA_VERSION) {
    transaction(database, () => {
      const columns = new Set((database.prepare('PRAGMA table_info(management_remote_journal_state)').all() as Array<{ name: string }>).map(row => row.name))
      if (!columns.has('snapshot_high_watermark')) database.exec(`ALTER TABLE management_remote_journal_state ADD COLUMN snapshot_high_watermark INTEGER NOT NULL DEFAULT 0
        CHECK (snapshot_high_watermark BETWEEN 0 AND 9007199254740991);`)
      if (!columns.has('legacy_through_sequence')) database.exec(`ALTER TABLE management_remote_journal_state ADD COLUMN legacy_through_sequence INTEGER
        CHECK (legacy_through_sequence IS NULL OR legacy_through_sequence BETWEEN 0 AND 9007199254740991);`)
      if (!columns.has('recovery_required')) database.exec(`ALTER TABLE management_remote_journal_state ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0
        CHECK (recovery_required IN (0,1));`)
      const states = database.prepare(`SELECT player_device_id,controller_id,through_sequence,high_watermark FROM management_remote_journal_state`)
        .all() as Array<{ player_device_id: string; controller_id: string; through_sequence: number; high_watermark: number }>
      const getEvents = database.prepare(`SELECT event_sequence FROM management_remote_journal_events
        WHERE player_device_id=? AND controller_id=? ORDER BY event_sequence`)
      const update = database.prepare(`UPDATE management_remote_journal_state SET through_sequence=?,legacy_through_sequence=?,
        recovery_required=? WHERE player_device_id=? AND controller_id=?`)
      for (const state of states) {
        let contiguous = 0
        for (const row of getEvents.all(state.player_device_id, state.controller_id) as Array<{ event_sequence: number }>) {
          if (row.event_sequence !== contiguous + 1) break
          contiguous = row.event_sequence
        }
        const legacy = Number(state.through_sequence)
        const safeContiguous = Math.min(contiguous, Number(state.high_watermark))
        const requiresRecovery = legacy > safeContiguous || contiguous > Number(state.high_watermark)
        update.run(safeContiguous, legacy, requiresRecovery ? 1 : 0, state.player_device_id, state.controller_id)
      }
      database.exec(`PRAGMA user_version = ${JOURNAL_RECOVERY_SCHEMA_VERSION};`)
    })
    version = JOURNAL_RECOVERY_SCHEMA_VERSION
  }

  if (version === JOURNAL_RECOVERY_SCHEMA_VERSION) {
    transaction(database, () => {
      database.exec(`CREATE TABLE management_remote_journal_snapshots_v10 (
        player_device_id TEXT NOT NULL,
        controller_id TEXT NOT NULL,
        journal_id TEXT NOT NULL,
        high_watermark INTEGER NOT NULL CHECK (high_watermark BETWEEN 0 AND 9007199254740991),
        player_epoch TEXT NOT NULL CHECK (length(player_epoch) BETWEEN 1 AND 128),
        snapshot_json TEXT NOT NULL CHECK (length(CAST(snapshot_json AS BLOB)) BETWEEN 1 AND 65536),
        fingerprint TEXT NOT NULL CHECK (length(fingerprint)=64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (player_device_id, controller_id, high_watermark, player_epoch),
        FOREIGN KEY (player_device_id, controller_id) REFERENCES management_remote_journal_state(player_device_id, controller_id)
      ) STRICT`)
      const rows = database.prepare(`SELECT player_device_id,controller_id,journal_id,high_watermark,snapshot_json,
        fingerprint,created_at FROM management_remote_journal_snapshots ORDER BY high_watermark`).all() as Array<Record<string, unknown>>
      const insert = database.prepare(`INSERT INTO management_remote_journal_snapshots_v10(player_device_id,controller_id,
        journal_id,high_watermark,player_epoch,snapshot_json,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      for (const row of rows) {
        let snapshot: unknown
        try { snapshot = parseOperationalMessageObject(JSON.parse(String(row.snapshot_json))) }
        catch (error) { throw new Error('Cannot migrate malformed remote journal snapshot.', { cause: error }) }
        if (!snapshot || typeof snapshot !== 'object' || (snapshot as any).kind !== 'response' ||
            (snapshot as any).body?.type !== 'snapshot') throw new Error('Cannot migrate a non-snapshot remote journal record.')
        const envelope = snapshot as { deviceId: string; controllerId: string; body: { payload: Record<string, unknown> } }
        const payload = envelope.body.payload
        const epoch = payload.playerEpoch
        if (envelope.deviceId !== row.player_device_id || envelope.controllerId !== row.controller_id ||
            payload.journalId !== row.journal_id || Number(payload.highWatermark) !== Number(row.high_watermark) ||
            typeof epoch !== 'string' || epoch.length < 1 || epoch.length > 128 ||
            remoteJournalFingerprint(snapshot) !== row.fingerprint) {
          throw new Error('Cannot migrate a mismatched remote journal snapshot.')
        }
        insert.run(String(row.player_device_id), String(row.controller_id), String(row.journal_id), Number(row.high_watermark), epoch,
          String(row.snapshot_json), String(row.fingerprint), Number(row.created_at))
      }
      database.exec(`DROP TABLE management_remote_journal_snapshots;
        ALTER TABLE management_remote_journal_snapshots_v10 RENAME TO management_remote_journal_snapshots;
        PRAGMA user_version = ${SCHEMA_VERSION};`)
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

      PRAGMA user_version = ${CATALOG_SCHEMA_VERSION};
    `)
  })
  version = CATALOG_SCHEMA_VERSION
  transaction(database, () => {
    database.exec(`${MANAGEMENT_REMOTE_OUTBOX_SCHEMA}; PRAGMA user_version = ${OUTBOX_SCHEMA_VERSION};`)
  })
  transaction(database, () => {
    database.exec(`${MANAGEMENT_REMOTE_JOURNAL_SCHEMA}; PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION};`)
  })
  initializeSchema(database)
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

function createMusicCatalogRepository(database: DatabaseSync, options: { persistImportIssues?: boolean } = {}): MusicCatalogRepository {
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

  const validateImportIssues = (issues: readonly MusicCatalogImportIssue[]): MusicCatalogImportIssue[] => {
    if (!Array.isArray(issues) || issues.length > 100_000) throw new Error('Catalog import issue report is invalid.')
    let previousRow = 0
    return issues.map(issue => {
      if (!issue || issue.code !== 'INVALID_MUSIC_NUMBER' || issue.field !== 'numero' ||
          !Number.isSafeInteger(issue.rowNumber) || issue.rowNumber <= previousRow ||
          typeof issue.value !== 'string' || issue.value.length > 4096 ||
          typeof issue.reason !== 'string' || issue.reason.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(issue.value + issue.reason)) {
        throw new Error('Catalog import issue report is invalid.')
      }
      previousRow = issue.rowNumber
      return { ...issue }
    })
  }

  const replaceMusicCatalogCore = (
    inputRecords: readonly MusicCatalogRecord[],
    metadata: { revision: string; importedAt: string; sourceName?: string | null },
    inputIssues: readonly MusicCatalogImportIssue[] = [],
    expectedGeneration?: number,
    expectedRevision?: string | null
  ): void => {
    const records = validateMusicCatalogRecords(inputRecords)
    const issues = options.persistImportIssues ? validateImportIssues(inputIssues) : []
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
      if (expectedRevision !== undefined && readMetadata().revision !== expectedRevision) {
        throw new MusicCatalogError('CATALOG_CHANGED_DURING_CONFIRMATION', 'O catálogo mudou durante a confirmação.')
      }
      let nextImportGeneration: number | undefined
      if (options.persistImportIssues) {
        const state = database.prepare('SELECT generation FROM music_catalog_import_state WHERE singleton = 1')
          .get() as { generation: number } | undefined
        if (!state || !Number.isSafeInteger(state.generation) || state.generation < 0) {
          throw new Error('Standalone catalog import state is invalid.')
        }
        if (expectedGeneration !== undefined && state.generation !== expectedGeneration) {
          throw new MusicCatalogError(
            'CATALOG_CHANGED_DURING_CONFIRMATION',
            'O catálogo mudou enquanto a confirmação estava aberta. Revise a importação antes de tentar novamente.'
          )
        }
        if (state.generation >= Number.MAX_SAFE_INTEGER) throw new Error('Standalone catalog import generation is exhausted.')
        nextImportGeneration = state.generation + 1
      }
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
      if (options.persistImportIssues) {
        database.exec('DELETE FROM music_catalog_import_issues;')
        const insertIssue = database.prepare(`
          INSERT INTO music_catalog_import_issues (issue_order, row_number, field, value, code, reason)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        issues.forEach((issue, index) => insertIssue.run(index, issue.rowNumber, issue.field,
          issue.value, issue.code, issue.reason))
        database.prepare('UPDATE music_catalog_import_state SET generation = ?, issue_count = ? WHERE singleton = 1')
          .run(nextImportGeneration!, issues.length)
        database.prepare(`
          INSERT INTO music_catalog_metadata (singleton, revision, imported_at, record_count, source_name)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            revision = excluded.revision,
            imported_at = excluded.imported_at,
            record_count = excluded.record_count,
            source_name = excluded.source_name
        `).run(metadata.revision, metadata.importedAt, records.length, metadata.sourceName ?? null)
      } else {
        database.prepare(`
          INSERT INTO music_catalog_metadata (singleton, revision, imported_at, record_count, source_name)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            revision = excluded.revision,
            imported_at = excluded.imported_at,
            record_count = excluded.record_count,
            source_name = excluded.source_name
        `).run(metadata.revision, metadata.importedAt, records.length, metadata.sourceName ?? null)
      }
    })
  }

  const replaceMusicCatalog = (inputRecords: readonly MusicCatalogRecord[], metadata: { revision: string; importedAt: string; sourceName?: string | null }, expectedRevision?: string | null): void => {
    replaceMusicCatalogCore(inputRecords, metadata, [], undefined, expectedRevision)
  }

  const replaceMusicCatalogWithImportIssues = options.persistImportIssues
    ? (
        inputRecords: readonly MusicCatalogRecord[],
        metadata: { revision: string; importedAt: string; sourceName?: string | null },
        issues: readonly MusicCatalogImportIssue[],
        expectedGeneration: number
      ): void => replaceMusicCatalogCore(inputRecords, metadata, issues, expectedGeneration)
    : undefined

  const getMusicCatalogImportIssuePage = options.persistImportIssues
    ? (offset: number, limit: number): MusicCatalogImportIssuePage => {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000 ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new Error('Catalog import issue page is invalid.')
        }
        if (database.isTransaction) throw new Error('SQLite transaction is unresolved; catalog import issues cannot be read.')
        return readTransaction(database, () => {
          const metadata = readMetadata()
          const row = database.prepare('SELECT generation, issue_count FROM music_catalog_import_state WHERE singleton = 1')
            .get() as { generation: number; issue_count: number } | undefined
          const issues = database.prepare(`
            SELECT row_number, field, value, code, reason
            FROM music_catalog_import_issues ORDER BY issue_order LIMIT ? OFFSET ?
          `).all(limit, offset) as Array<{
            row_number: number; field: string; value: string; code: string; reason: string
          }>
          return {
            catalogRevision: metadata.revision,
            generation: row?.generation ?? 0,
            total: row?.issue_count ?? 0,
            offset,
            issues: issues.map(issue => ({
              rowNumber: issue.row_number,
              field: issue.field as 'numero',
              value: issue.value,
              code: issue.code as 'INVALID_MUSIC_NUMBER',
              reason: issue.reason
            }))
          }
        })
      }
    : undefined

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
  return {
    getMusicCatalogMetadata,
    replaceMusicCatalog,
    searchMusicCatalog,
    getMusicCatalogRecordByVideoCode,
    ...(replaceMusicCatalogWithImportIssues ? { replaceMusicCatalogWithImportIssues } : {}),
    ...(getMusicCatalogImportIssuePage ? { getMusicCatalogImportIssuePage } : {})
  }
}

const PLAYER_MUSIC_CATALOG_FILENAME = 'player-music-catalog.sqlite'
const PLAYER_CATALOG_SCHEMA_VERSION = 3

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
  const existingDatabase = optionalLstat(databasePath)
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
    let version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > PLAYER_CATALOG_SCHEMA_VERSION) throw new Error('Player music catalog database version is newer than this application.')
    if (existingDatabase && existingDatabase.size > 0 && version < PLAYER_CATALOG_SCHEMA_VERSION) {
      createSqliteMigrationBackup({ database, databasePath, userDataDirectory: userDataPath, sourceSchemaVersion: version })
    }
    if (version === 1) transaction(database, () => {
      database.exec(`ALTER TABLE music_catalog_metadata ADD COLUMN source_name TEXT
        CHECK (source_name IS NULL OR length(source_name) <= 255);`)
      database.exec('PRAGMA user_version = 2;')
    })
    if (version === 1) version = 2
    if (version === 2) transaction(database, () => {
      database.exec(`CREATE TABLE music_catalog_import_issues (
        issue_order INTEGER PRIMARY KEY CHECK (issue_order >= 0),
        row_number INTEGER NOT NULL CHECK (row_number > 0),
        field TEXT NOT NULL CHECK (field = 'numero'),
        value TEXT NOT NULL CHECK (length(value) <= 4096),
        code TEXT NOT NULL CHECK (code = 'INVALID_MUSIC_NUMBER'),
        reason TEXT NOT NULL CHECK (length(reason) <= 512)
      );`)
      database.exec(`CREATE TABLE music_catalog_import_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL CHECK (generation >= 0 AND generation <= 9007199254740991),
        issue_count INTEGER NOT NULL CHECK (issue_count >= 0 AND issue_count <= 100000)
      );
      INSERT INTO music_catalog_import_state (singleton, generation, issue_count) VALUES (1, 0, 0);`)
      database.exec(`PRAGMA user_version = ${PLAYER_CATALOG_SCHEMA_VERSION};`)
    })
    if (version === 2) version = 3
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
        CREATE TABLE music_catalog_import_issues (
          issue_order INTEGER PRIMARY KEY CHECK (issue_order >= 0),
          row_number INTEGER NOT NULL CHECK (row_number > 0),
          field TEXT NOT NULL CHECK (field = 'numero'),
          value TEXT NOT NULL CHECK (length(value) <= 4096),
          code TEXT NOT NULL CHECK (code = 'INVALID_MUSIC_NUMBER'),
          reason TEXT NOT NULL CHECK (length(reason) <= 512)
        );
        CREATE TABLE music_catalog_import_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          generation INTEGER NOT NULL CHECK (generation >= 0 AND generation <= 9007199254740991),
          issue_count INTEGER NOT NULL CHECK (issue_count >= 0 AND issue_count <= 100000)
        );
        INSERT INTO music_catalog_import_state (singleton, generation, issue_count) VALUES (1, 0, 0);
        PRAGMA user_version = ${PLAYER_CATALOG_SCHEMA_VERSION};
      `)
      version = PLAYER_CATALOG_SCHEMA_VERSION
    })
  } catch (error) {
    database.close()
    throw error
  }
  return { databasePath, ...createMusicCatalogRepository(database, { persistImportIssues: true }), close: () => database.close() }
}

export function createKaraokeDatabase(userDataPath: string): KaraokeDatabase {
  const databasePath = path.join(userDataPath, DATABASE_FILENAME)
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const existingDatabase = optionalLstat(databasePath)
  if (existingDatabase) {
    const attributes = (existingDatabase as fs.BigIntStats & { attributes?: number }).attributes ?? 0
    if (!existingDatabase.isFile() || existingDatabase.isSymbolicLink() ||
        (process.platform === 'win32' && (attributes & 0x400) !== 0)) {
      throw new Error('Operational database must be a regular file without reparse points.')
    }
  }

  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (existingDatabase && existingDatabase.size > 0 && version < SCHEMA_VERSION) {
      createSqliteMigrationBackup({ database, databasePath, userDataDirectory: userDataPath, sourceSchemaVersion: version })
    }
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
  const readOutboxRow = (row: Record<string, unknown>): ManagementOutboxRecord => {
    let command: unknown, detail: unknown = null
    try { command = JSON.parse(String(row.command_json)); detail = row.detail_json == null ? null : JSON.parse(String(row.detail_json)) }
    catch (error) { throw new Error('MANAGEMENT_REMOTE_OUTBOX_CORRUPT', { cause: error }) }
    return { playerDeviceId: String(row.player_device_id), controllerId: String(row.controller_id),
      operationId: String(row.operation_id), fingerprint: String(row.fingerprint), command,
      status: row.status as ManagementOutboxRecord['status'], detail,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
  }
  const findOutbox = (playerDeviceId: string, controllerId: string, operationId: string): ManagementOutboxRecord | null => {
    const row = database.prepare(`SELECT * FROM management_remote_outbox
      WHERE player_device_id=? AND controller_id=? AND operation_id=?`).get(playerDeviceId, controllerId, operationId) as Record<string, unknown> | undefined
    return row ? readOutboxRow(row) : null
  }
  const outbox = {
    enqueue(input: Omit<ManagementOutboxRecord, 'status' | 'detail' | 'createdAt' | 'updatedAt'>): { record: ManagementOutboxRecord; duplicate: boolean } {
      const commandJson = JSON.stringify(input.command)
      if (Buffer.byteLength(commandJson, 'utf8') > 64 * 1024) throw new Error('MANAGEMENT_OUTBOX_INVALID')
      const now = Date.now()
      try {
        const result = transaction(database, () => {
          const existing = findOutbox(input.playerDeviceId, input.controllerId, input.operationId)
          if (existing) {
            if (existing.fingerprint !== input.fingerprint) throw new Error('MANAGEMENT_OUTBOX_CONFLICT')
            return { record: existing, duplicate: true }
          }
          database.prepare(`INSERT INTO management_remote_outbox(player_device_id,controller_id,operation_id,
            fingerprint,command_json,status,detail_json,created_at,updated_at) VALUES(?,?,?,?,?,'not-sent',NULL,?,?)`)
            .run(input.playerDeviceId, input.controllerId, input.operationId, input.fingerprint, commandJson, now, now)
          const record = findOutbox(input.playerDeviceId, input.controllerId, input.operationId)
          if (!record) throw new Error('MANAGEMENT_OUTBOX_READBACK_FAILED')
          return { record, duplicate: false }
        })
        return result
      } catch (error) {
        const readback = findOutbox(input.playerDeviceId, input.controllerId, input.operationId)
        if (readback?.fingerprint === input.fingerprint) {
          return { record: readback, duplicate: true }
        }
        if (readback) throw new Error('MANAGEMENT_OUTBOX_CONFLICT', { cause: error })
        throw error
      }
    },
    get(playerDeviceId: string, controllerId: string, operationId: string): ManagementOutboxRecord | null {
      if (database.isTransaction) throw new Error('MANAGEMENT_OUTBOX_UNRESOLVED_TRANSACTION')
      return findOutbox(playerDeviceId, controllerId, operationId)
    },
    listRecoverable(playerDeviceId: string, controllerId: string): ManagementOutboxRecord[] {
      if (database.isTransaction) throw new Error('MANAGEMENT_OUTBOX_UNRESOLVED_TRANSACTION')
      return database.prepare(`SELECT * FROM management_remote_outbox
        WHERE player_device_id=? AND controller_id=? AND status IN ('not-sent','accepted','unknown')
        ORDER BY created_at,operation_id`).all(playerDeviceId, controllerId)
        .map(row => readOutboxRow(row as Record<string, unknown>))
    },
    markTransmissionStarted(playerDeviceId: string, controllerId: string, operationId: string): ManagementOutboxRecord {
      const prior = findOutbox(playerDeviceId, controllerId, operationId)
      if (!prior) throw new Error('MANAGEMENT_OUTBOX_NOT_FOUND')
      if (prior.status === 'completed' || prior.status === 'rejected') throw new Error('MANAGEMENT_OUTBOX_TERMINAL')
      if (prior.status === 'not-sent') {
        const now = Date.now()
        try {
          transaction(database, () => {
            database.prepare(`UPDATE management_remote_outbox SET status='unknown', updated_at=?
              WHERE player_device_id=? AND controller_id=? AND operation_id=? AND status='not-sent'`)
              .run(now, playerDeviceId, controllerId, operationId)
          })
        } catch (error) {
          const readback = findOutbox(playerDeviceId, controllerId, operationId)
          if (readback?.status !== 'unknown') throw error
        }
      }
      const confirmed = findOutbox(playerDeviceId, controllerId, operationId)
      if (!confirmed || ['not-sent', 'completed', 'rejected'].includes(confirmed.status)) {
        throw new Error('MANAGEMENT_OUTBOX_UNCERTAIN')
      }
      return confirmed
    },
    recordRemoteStatus(input: { playerDeviceId: string; controllerId: string; operationId: string; fingerprint: string;
      status: Exclude<ManagementOutboxRecord['status'], 'not-sent'>; detail: unknown }): ManagementOutboxRecord {
      const current = findOutbox(input.playerDeviceId, input.controllerId, input.operationId)
      if (!current) throw new Error('MANAGEMENT_OUTBOX_NOT_FOUND')
      if (current.fingerprint !== input.fingerprint) throw new Error('MANAGEMENT_OUTBOX_FINGERPRINT_MISMATCH')
      const detailJson = stableRemoteJournalJson(input.detail)
      if (typeof detailJson !== 'string' || Buffer.byteLength(detailJson, 'utf8') > 64 * 1024) throw new Error('MANAGEMENT_OUTBOX_INVALID')
      if (current.status === 'completed' || current.status === 'rejected') {
        if (current.status !== input.status || stableRemoteJournalJson(current.detail) !== detailJson) {
          throw new Error('MANAGEMENT_OUTBOX_TERMINAL_CONFLICT')
        }
        return current
      }
      if (current.status === input.status) {
        if (stableRemoteJournalJson(current.detail) === detailJson) return current
        throw new Error('MANAGEMENT_OUTBOX_STATUS_CONFLICT')
      }
      const allowed = current.status === 'not-sent' ? input.status === 'unknown'
        : current.status === 'unknown' ? true
        : current.status === 'accepted' ? ['completed', 'rejected', 'unknown'].includes(input.status)
        : false
      if (!allowed) throw new Error('MANAGEMENT_OUTBOX_TRANSITION_INVALID')
      const now = Date.now()
      try {
        transaction(database, () => {
          database.prepare(`UPDATE management_remote_outbox SET status=?,detail_json=?,updated_at=?
            WHERE player_device_id=? AND controller_id=? AND operation_id=? AND fingerprint=?`)
            .run(input.status, detailJson, now, input.playerDeviceId, input.controllerId, input.operationId, input.fingerprint)
        })
      } catch (error) {
        const readback = findOutbox(input.playerDeviceId, input.controllerId, input.operationId)
        if (readback?.fingerprint !== input.fingerprint || readback.status !== input.status ||
            stableRemoteJournalJson(readback.detail) !== detailJson) throw error
      }
      const result = findOutbox(input.playerDeviceId, input.controllerId, input.operationId)
      if (!result || result.fingerprint !== input.fingerprint || result.status !== input.status) {
        throw new Error('MANAGEMENT_OUTBOX_UNCERTAIN')
      }
      return result
    }
  }
  const readRemoteJournalCursor = (playerDeviceId: string, controllerId: string): ManagementRemoteJournalCursor | null => {
    const row = database.prepare(`SELECT * FROM management_remote_journal_state
      WHERE player_device_id=? AND controller_id=?`).get(playerDeviceId, controllerId) as Record<string, unknown> | undefined
    return row ? { playerDeviceId: String(row.player_device_id), controllerId: String(row.controller_id),
      journalId: String(row.journal_id), throughSequence: Number(row.through_sequence),
      highWatermark: Number(row.high_watermark), snapshotHighWatermark: Number(row.snapshot_high_watermark ?? 0),
      compactedThrough: Number(row.compacted_through),
      legacyThroughSequence: row.legacy_through_sequence == null ? null : Number(row.legacy_through_sequence),
      recoveryRequired: Number(row.recovery_required ?? 0) === 1, updatedAt: Number(row.updated_at) } : null
  }
  const readRemoteJournalEvent = (row: Record<string, unknown>) => {
    let event: unknown
    try { event = JSON.parse(String(row.event_json)) }
    catch (error) { throw new Error('MANAGEMENT_REMOTE_JOURNAL_CORRUPT', { cause: error }) }
    if (remoteJournalFingerprint(event) !== row.fingerprint) throw new Error('MANAGEMENT_REMOTE_JOURNAL_CORRUPT')
    return { sequence: Number(row.event_sequence), event: event as import('./src/operational-protocol-contracts').JournalEvent,
      fingerprint: String(row.fingerprint) }
  }
  const remoteJournal = {
    getCursor(playerDeviceId: string, controllerId: string): ManagementRemoteJournalCursor | null {
      if (database.isTransaction) throw new Error('MANAGEMENT_REMOTE_JOURNAL_UNRESOLVED_TRANSACTION')
      return readRemoteJournalCursor(playerDeviceId, controllerId)
    },
    persistPage(input: Parameters<ManagementRemoteJournalDatabase['remoteJournal']['persistPage']>[0]): ManagementRemoteJournalCursor {
      if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0 ||
          !Number.isSafeInteger(input.throughSequence) || !Number.isSafeInteger(input.highWatermark) ||
          !Number.isSafeInteger(input.compactedThrough) || input.compactedThrough < 0 ||
          input.highWatermark < input.throughSequence || input.compactedThrough > input.highWatermark ||
          input.throughSequence < input.afterSequence || !Array.isArray(input.events)) {
        throw new Error('MANAGEMENT_REMOTE_JOURNAL_PAGE_INVALID')
      }
      let expectedSequence = input.afterSequence + 1
      for (const item of input.events) {
        if (item.sequence !== expectedSequence++ || item.event.eventSequence !== item.sequence ||
            item.event.journalId !== input.journalId || remoteJournalFingerprint(item.event) !== item.fingerprint) {
          throw new Error('MANAGEMENT_REMOTE_JOURNAL_PAGE_INVALID')
        }
        const json = stableRemoteJournalJson(item.event)
        if (Buffer.byteLength(json, 'utf8') > 8 * 1024) throw new Error('MANAGEMENT_REMOTE_JOURNAL_PAGE_INVALID')
      }
      const pageThrough = input.events.length ? input.events[input.events.length - 1].sequence : input.afterSequence
      if (input.throughSequence !== pageThrough || input.hasMore && input.events.length === 0 ||
          !input.hasMore && input.throughSequence !== input.highWatermark) {
        throw new Error('MANAGEMENT_REMOTE_JOURNAL_PAGE_INVALID')
      }
      const now = Date.now()
      try {
        return transaction(database, () => {
          let prior = readRemoteJournalCursor(input.playerDeviceId, input.controllerId)
          if (!prior) {
            if (input.afterSequence !== 0) throw new Error('MANAGEMENT_REMOTE_JOURNAL_CURSOR_GAP')
            database.prepare(`INSERT INTO management_remote_journal_state(player_device_id,controller_id,journal_id,
              through_sequence,high_watermark,compacted_through,updated_at) VALUES(?,?,?,0,?,?,?)`)
              .run(input.playerDeviceId, input.controllerId, input.journalId, input.highWatermark, input.compactedThrough, now)
            prior = readRemoteJournalCursor(input.playerDeviceId, input.controllerId)
          }
          if (!prior || prior.journalId !== input.journalId) throw new Error('MANAGEMENT_REMOTE_JOURNAL_LINEAGE_MISMATCH')
          if (prior.recoveryRequired) throw new Error('MANAGEMENT_REMOTE_JOURNAL_RECOVERY_REQUIRED')
          if (input.highWatermark < prior.highWatermark || input.compactedThrough < prior.compactedThrough) {
            throw new Error('MANAGEMENT_REMOTE_JOURNAL_ROLLBACK')
          }
          if (input.compactedThrough > prior.throughSequence || input.afterSequence < input.compactedThrough) {
            throw new Error('MANAGEMENT_REMOTE_JOURNAL_REPLAY_COMPACTED')
          }
          if (input.afterSequence > prior.throughSequence) throw new Error('MANAGEMENT_REMOTE_JOURNAL_CURSOR_GAP')
          for (const item of input.events) {
            const json = stableRemoteJournalJson(item.event)
            const existing = database.prepare(`SELECT event_json,fingerprint FROM management_remote_journal_events
              WHERE player_device_id=? AND controller_id=? AND event_sequence=?`)
              .get(input.playerDeviceId, input.controllerId, item.sequence) as { event_json?: string; fingerprint?: string } | undefined
            if (existing && (existing.fingerprint !== item.fingerprint || existing.event_json !== json)) {
              throw new Error('MANAGEMENT_REMOTE_JOURNAL_EVENT_CONFLICT')
            }
            if (!existing) database.prepare(`INSERT INTO management_remote_journal_events(player_device_id,controller_id,
              journal_id,event_sequence,event_json,fingerprint) VALUES(?,?,?,?,?,?)`)
              .run(input.playerDeviceId, input.controllerId, input.journalId, item.sequence, json, item.fingerprint)
          }
          const throughSequence = Math.max(prior.throughSequence, input.throughSequence)
          database.prepare(`UPDATE management_remote_journal_state SET through_sequence=?,high_watermark=?,compacted_through=?,updated_at=?
            WHERE player_device_id=? AND controller_id=? AND journal_id=?`)
            .run(throughSequence, Math.max(prior.highWatermark, input.highWatermark),
              Math.max(prior.compactedThrough, input.compactedThrough), now,
              input.playerDeviceId, input.controllerId, input.journalId)
          const confirmed = readRemoteJournalCursor(input.playerDeviceId, input.controllerId)
          if (!confirmed || confirmed.journalId !== input.journalId || confirmed.throughSequence !== throughSequence) {
            throw new Error('MANAGEMENT_REMOTE_JOURNAL_READBACK_FAILED')
          }
          return confirmed
        })
      } catch (error) {
        if (error instanceof Error && /^MANAGEMENT_REMOTE_JOURNAL_(PAGE_INVALID|CURSOR_GAP|LINEAGE_MISMATCH|ROLLBACK|REPLAY_COMPACTED|EVENT_CONFLICT|RECOVERY_REQUIRED)$/.test(error.message)) throw error
        const confirmed = readRemoteJournalCursor(input.playerDeviceId, input.controllerId)
        if (confirmed?.journalId === input.journalId && confirmed.throughSequence >= input.throughSequence &&
            confirmed.highWatermark >= input.highWatermark && input.events.every(item => {
              const row = database.prepare(`SELECT fingerprint FROM management_remote_journal_events WHERE player_device_id=?
                AND controller_id=? AND event_sequence=?`).get(input.playerDeviceId, input.controllerId, item.sequence) as { fingerprint?: string } | undefined
              return row?.fingerprint === item.fingerprint
            })) return confirmed
        throw new Error('MANAGEMENT_REMOTE_JOURNAL_UNCERTAIN', { cause: error })
      }
    },
    persistSnapshot(input: Parameters<ManagementRemoteJournalDatabase['remoteJournal']['persistSnapshot']>[0]): ManagementRemoteJournalCursor {
      if (!Number.isSafeInteger(input.highWatermark) || input.highWatermark < 0 ||
          !Number.isSafeInteger(input.compactedThrough) || input.compactedThrough < 0 || input.compactedThrough > input.highWatermark ||
          typeof input.playerEpoch !== 'string' || input.playerEpoch.length < 1 || input.playerEpoch.length > 128 ||
          remoteJournalFingerprint(input.snapshot) !== input.fingerprint) throw new Error('MANAGEMENT_REMOTE_JOURNAL_SNAPSHOT_INVALID')
      const snapshotJson = stableRemoteJournalJson(input.snapshot)
      if (Buffer.byteLength(snapshotJson, 'utf8') > 64 * 1024) throw new Error('MANAGEMENT_REMOTE_JOURNAL_SNAPSHOT_INVALID')
      const now = Date.now()
      try {
        return transaction(database, () => {
          let prior = readRemoteJournalCursor(input.playerDeviceId, input.controllerId)
          if (prior && prior.journalId !== input.journalId) throw new Error('MANAGEMENT_REMOTE_JOURNAL_LINEAGE_MISMATCH')
          if (prior && (input.highWatermark < prior.highWatermark || input.highWatermark < prior.throughSequence ||
              input.compactedThrough < prior.compactedThrough)) throw new Error('MANAGEMENT_REMOTE_JOURNAL_ROLLBACK')
          if (!prior) {
            database.prepare(`INSERT INTO management_remote_journal_state(player_device_id,controller_id,journal_id,
          through_sequence,high_watermark,compacted_through,snapshot_high_watermark,recovery_required,updated_at)
          VALUES(?,?,?,0,?,?,?,?,?)`)
          .run(input.playerDeviceId, input.controllerId, input.journalId, input.highWatermark,
            input.compactedThrough, input.highWatermark, input.compactedThrough > 0 ? 1 : 0, now)
          }
          const existing = database.prepare(`SELECT snapshot_json,fingerprint FROM management_remote_journal_snapshots
            WHERE player_device_id=? AND controller_id=? AND high_watermark=? AND player_epoch=?`)
            .get(input.playerDeviceId, input.controllerId, input.highWatermark, input.playerEpoch) as { snapshot_json?: string; fingerprint?: string } | undefined
          if (existing && (existing.fingerprint !== input.fingerprint || existing.snapshot_json !== snapshotJson)) {
            throw new Error('MANAGEMENT_REMOTE_JOURNAL_SNAPSHOT_CONFLICT')
          }
          if (!existing) database.prepare(`INSERT INTO management_remote_journal_snapshots(player_device_id,controller_id,
            journal_id,high_watermark,player_epoch,snapshot_json,fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?)`)
            .run(input.playerDeviceId, input.controllerId, input.journalId, input.highWatermark, input.playerEpoch,
              snapshotJson, input.fingerprint, now)
          if (prior) database.prepare(`UPDATE management_remote_journal_state SET high_watermark=?,compacted_through=?,
            snapshot_high_watermark=?,recovery_required=CASE WHEN ? > through_sequence THEN 1 ELSE recovery_required END,
            updated_at=? WHERE player_device_id=? AND controller_id=?`)
            .run(Math.max(prior.highWatermark, input.highWatermark), Math.max(prior.compactedThrough, input.compactedThrough),
              Math.max(prior.snapshotHighWatermark, input.highWatermark), Math.max(prior.compactedThrough, input.compactedThrough),
              now, input.playerDeviceId, input.controllerId)
          const confirmed = readRemoteJournalCursor(input.playerDeviceId, input.controllerId)
          if (!confirmed || confirmed.journalId !== input.journalId || confirmed.snapshotHighWatermark < input.highWatermark) {
            throw new Error('MANAGEMENT_REMOTE_JOURNAL_READBACK_FAILED')
          }
          return confirmed
        })
      } catch (error) {
        if (error instanceof Error && /^MANAGEMENT_REMOTE_JOURNAL_(SNAPSHOT_INVALID|LINEAGE_MISMATCH|ROLLBACK|SNAPSHOT_CONFLICT)$/.test(error.message)) throw error
        const confirmed = readRemoteJournalCursor(input.playerDeviceId, input.controllerId)
        const row = database.prepare(`SELECT fingerprint FROM management_remote_journal_snapshots WHERE player_device_id=?
          AND controller_id=? AND high_watermark=? AND player_epoch=?`)
          .get(input.playerDeviceId, input.controllerId, input.highWatermark, input.playerEpoch) as { fingerprint?: string } | undefined
        if (confirmed?.journalId === input.journalId && confirmed.snapshotHighWatermark >= input.highWatermark && row?.fingerprint === input.fingerprint) {
          return confirmed
        }
        throw new Error('MANAGEMENT_REMOTE_JOURNAL_UNCERTAIN', { cause: error })
      }
    },
    listEvents(input: Parameters<ManagementRemoteJournalDatabase['remoteJournal']['listEvents']>[0]) {
      if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0 ||
          !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 32) throw new Error('MANAGEMENT_REMOTE_JOURNAL_CURSOR_INVALID')
      if (database.isTransaction) throw new Error('MANAGEMENT_REMOTE_JOURNAL_UNRESOLVED_TRANSACTION')
      const cursor = readRemoteJournalCursor(input.playerDeviceId, input.controllerId)
      if (!cursor) return []
      if (cursor.recoveryRequired) throw new Error('MANAGEMENT_REMOTE_JOURNAL_RECOVERY_REQUIRED')
      if (input.afterSequence < cursor.compactedThrough) throw new Error('MANAGEMENT_REMOTE_JOURNAL_REPLAY_COMPACTED')
      if (input.afterSequence > cursor.throughSequence) throw new Error('MANAGEMENT_REMOTE_JOURNAL_GAP')
      const rows = database.prepare(`SELECT event_sequence,event_json,fingerprint FROM management_remote_journal_events
        WHERE player_device_id=? AND controller_id=? AND event_sequence>? ORDER BY event_sequence LIMIT ?`)
        .all(input.playerDeviceId, input.controllerId, input.afterSequence, input.limit) as Array<Record<string, unknown>>
      const events = rows.map(readRemoteJournalEvent)
      let expected = input.afterSequence + 1
      for (const event of events) {
        if (event.sequence !== expected++) throw new Error('MANAGEMENT_REMOTE_JOURNAL_GAP')
      }
      if (events.length === 0 && input.afterSequence < cursor.throughSequence) throw new Error('MANAGEMENT_REMOTE_JOURNAL_GAP')
      return events
    },
    getLatestSnapshot(playerDeviceId: string, controllerId: string): import('./src/operational-protocol-contracts').OperationalMessage | null {
      if (database.isTransaction) throw new Error('MANAGEMENT_REMOTE_JOURNAL_UNRESOLVED_TRANSACTION')
      const row = database.prepare(`SELECT snapshot_json,fingerprint FROM management_remote_journal_snapshots
        WHERE player_device_id=? AND controller_id=? ORDER BY high_watermark DESC,created_at DESC,rowid DESC LIMIT 1`)
        .get(playerDeviceId, controllerId) as { snapshot_json?: string; fingerprint?: string } | undefined
      if (!row) return null
      let snapshot: unknown
      try { snapshot = JSON.parse(String(row.snapshot_json)) }
      catch (error) { throw new Error('MANAGEMENT_REMOTE_JOURNAL_CORRUPT', { cause: error }) }
      if (remoteJournalFingerprint(snapshot) !== row.fingerprint) throw new Error('MANAGEMENT_REMOTE_JOURNAL_CORRUPT')
      return snapshot as import('./src/operational-protocol-contracts').OperationalMessage
    }
  }
  return {
    databasePath,
    loadState: readState,
    saveState,
    ...catalogRepository,
    remoteOutbox: outbox,
    remoteJournal,
    close: () => database.close()
  }
}
