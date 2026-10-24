import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DATABASE_FILENAME = 'karaoke.sqlite'
const LEGACY_FILENAME = 'karaoke-data.json'
const LEGACY_MIGRATION = 'electron-store-v1'
const SCHEMA_VERSION = 1

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
  next_turn_id: string | null
  current_turn_id: string | null
  last_reset: string | null
  trial_started_at: number | null
  license_activated: number
}

interface KaraokeDatabase {
  databasePath: string
  loadState: () => StoredAppState
  saveState: (state: AppState) => void
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

function initializeSchema(database: DatabaseSync): void {
  const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  if (version > SCHEMA_VERSION) {
    throw new Error(`Database schema version ${version} is newer than supported version ${SCHEMA_VERSION}.`)
  }
  if (version === SCHEMA_VERSION) return

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
      nextTurnId: state.nextTurnId == null ? null : String(state.nextTurnId),
      currentTurnId: state.currentTurnId == null ? null : String(state.currentTurnId),
      lastReset: state.lastReset == null ? null : String(state.lastReset),
      trialStartedAt: state.trialStartedAt == null ? null : Number(state.trialStartedAt),
      licenseActivated: state.licenseActivated === true ? 1 : 0
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
      singleton, current_session_id, priority_ids_json, next_turn_id,
      current_turn_id, last_reset, trial_started_at, license_activated
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    state.currentSessionId == null ? null : String(state.currentSessionId),
    JSON.stringify(Array.isArray(state.priorityIds) ? state.priorityIds : []),
    state.nextTurnId == null ? null : String(state.nextTurnId),
    state.currentTurnId == null ? null : String(state.currentTurnId),
    state.lastReset == null ? null : String(state.lastReset),
    state.trialStartedAt == null ? null : Number(state.trialStartedAt),
    state.licenseActivated === true ? 1 : 0
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
    const appState = database.prepare('SELECT * FROM app_state WHERE singleton = 1').get() as unknown as DatabaseAppStateRow | undefined
    if (!appState) return {}

    return {
      queue: database.prepare(
        "SELECT * FROM entries WHERE status = 'pending' ORDER BY queue_order"
      ).all().map(row => mapEntry(row as unknown as DatabaseEntryRow)),
      history: database.prepare(
        "SELECT * FROM entries WHERE status IN ('done', 'cancelled') ORDER BY history_order"
      ).all().map(row => mapEntry(row as unknown as DatabaseEntryRow)),
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
      nextTurnId: appState.next_turn_id,
      currentTurnId: appState.current_turn_id,
      lastReset: appState.last_reset,
      trialStartedAt: appState.trial_started_at ?? Date.now(),
      licenseActivated: appState.license_activated === 1
    }
  }

  let previousSnapshot = normalizeSnapshot(readState())

  const saveState = (state: AppState): void => {
    const nextSnapshot = normalizeSnapshot(state)
    const previous = previousSnapshot

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
          singleton, current_session_id, priority_ids_json, next_turn_id,
          current_turn_id, last_reset, trial_started_at, license_activated
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          current_session_id = excluded.current_session_id,
          priority_ids_json = excluded.priority_ids_json,
          next_turn_id = excluded.next_turn_id,
          current_turn_id = excluded.current_turn_id,
          last_reset = excluded.last_reset,
          trial_started_at = excluded.trial_started_at,
          license_activated = excluded.license_activated
      `).run(appState.currentSessionId, appState.priorityIdsJson, appState.nextTurnId,
        appState.currentTurnId, appState.lastReset, appState.trialStartedAt,
        appState.licenseActivated)
    })

    previousSnapshot = nextSnapshot
  }

  return {
    databasePath,
    loadState: readState,
    saveState,
    close: () => database.close()
  }
}
