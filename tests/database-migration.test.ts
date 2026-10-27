import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKaraokeDatabase } from '../database'
import { KaraokeApplication } from '../src/application'
import { createStateRepository } from '../src/state-repository'

test('upgrades a schema-v1 SQLite profile in place and retains app state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-schema-v1-'))
  const databasePath = path.join(directory, 'karaoke.sqlite')
  const old = new DatabaseSync(databasePath)
  old.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, session_order INTEGER NOT NULL);
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, session_id TEXT, name TEXT NOT NULL, song_number TEXT NOT NULL,
      song_number2 TEXT NOT NULL DEFAULT '', table_number TEXT NOT NULL, inserted_at INTEGER NOT NULL,
      status TEXT NOT NULL, done_at INTEGER, cancelled_at INTEGER, queue_order INTEGER, history_order INTEGER
    );
    CREATE TABLE app_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), current_session_id TEXT,
      priority_ids_json TEXT NOT NULL DEFAULT '[]', next_turn_id TEXT, current_turn_id TEXT,
      last_reset TEXT, trial_started_at INTEGER, license_activated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE app_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sessions VALUES ('s-old', 1, NULL, 0);
    INSERT INTO entries VALUES ('old-current', 's-old', 'Current', '123', '', '1', 1, 'pending', NULL, NULL, 0, NULL);
    INSERT INTO entries VALUES ('old-priority', 's-old', 'Priority', '456', '', '2', 2, 'pending', NULL, NULL, 1, NULL);
    INSERT INTO app_state VALUES (1, 's-old', '["old-priority"]', NULL, 'old-current', NULL, 1, 0);
    PRAGMA user_version = 1;
  `)
  old.close()

  const database = createKaraokeDatabase(directory)
  try {
    const state = database.loadState()
    assert.equal(state.currentSessionId, 's-old')
    assert.deepEqual(state.priorityIds, ['old-priority'])
    assert.equal(state.queue?.length, 2)
    const upgraded = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(upgraded.prepare('PRAGMA user_version').get()?.user_version, 4)
      assert.ok(upgraded.prepare('PRAGMA table_info(app_state)').all()
        .some((column: any) => column.name === 'fixed_turn_positions_json'))
      assert.ok(upgraded.prepare('PRAGMA table_info(app_state)').all()
        .some((column: any) => column.name === 'frozen_turn_ids_json'))
      assert.ok(upgraded.prepare('PRAGMA table_info(app_state)').all()
        .some((column: any) => column.name === 'regulars_since_debut'))
      assert.deepEqual(state.frozenTurnIds, [])
      assert.equal(upgraded.prepare('SELECT name FROM entries WHERE id = ?').get('old-priority')?.name, 'Priority')
    } finally {
      upgraded.close()
    }
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('upgrades a schema-v2 SQLite profile and preserves individual fixed positions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-schema-v2-'))
  const databasePath = path.join(directory, 'karaoke.sqlite')
  const old = new DatabaseSync(databasePath)
  old.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, session_order INTEGER NOT NULL);
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, session_id TEXT, name TEXT NOT NULL, song_number TEXT NOT NULL,
      song_number2 TEXT NOT NULL DEFAULT '', table_number TEXT NOT NULL, inserted_at INTEGER NOT NULL,
      status TEXT NOT NULL, done_at INTEGER, cancelled_at INTEGER, queue_order INTEGER, history_order INTEGER
    );
    CREATE TABLE app_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), current_session_id TEXT,
      priority_ids_json TEXT NOT NULL DEFAULT '[]', fixed_turn_positions_json TEXT NOT NULL DEFAULT '{}',
      next_turn_id TEXT, current_turn_id TEXT, last_reset TEXT, trial_started_at INTEGER,
      license_activated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE app_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sessions VALUES ('s-v2', 1, NULL, 0);
    INSERT INTO entries VALUES ('v2-current', 's-v2', 'Current', '123', '', '1', 1, 'pending', NULL, NULL, 0, NULL);
    INSERT INTO entries VALUES ('v2-pin', 's-v2', 'Pinned', '456', '', '2', 2, 'pending', NULL, NULL, 1, NULL);
    INSERT INTO app_state VALUES (1, 's-v2', '[]', '{"v2-pin":1}', NULL, 'v2-current', NULL, 1, 0);
    PRAGMA user_version = 2;
  `)
  old.close()

  const database = createKaraokeDatabase(directory)
  try {
    const state = database.loadState()
    assert.deepEqual(state.fixedTurnPositions, { 'v2-pin': 1 })
    assert.deepEqual(state.frozenTurnIds, [])
    const upgraded = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(upgraded.prepare('PRAGMA user_version').get()?.user_version, 4)
      assert.equal(upgraded.prepare('SELECT frozen_turn_ids_json FROM app_state WHERE singleton = 1').get()?.frozen_turn_ids_json, '[]')
    } finally {
      upgraded.close()
    }
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('upgrades a schema-v3 profile with cadence defaults and retains the queue', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-schema-v3-'))
  const databasePath = path.join(directory, 'karaoke.sqlite')
  const old = new DatabaseSync(databasePath)
  old.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, session_order INTEGER NOT NULL);
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, session_id TEXT, name TEXT NOT NULL, song_number TEXT NOT NULL,
      song_number2 TEXT NOT NULL DEFAULT '', table_number TEXT NOT NULL, inserted_at INTEGER NOT NULL,
      status TEXT NOT NULL, done_at INTEGER, cancelled_at INTEGER, queue_order INTEGER, history_order INTEGER
    );
    CREATE TABLE app_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), current_session_id TEXT,
      priority_ids_json TEXT NOT NULL DEFAULT '[]', fixed_turn_positions_json TEXT NOT NULL DEFAULT '{}',
      frozen_turn_ids_json TEXT NOT NULL DEFAULT '[]', next_turn_id TEXT, current_turn_id TEXT,
      last_reset TEXT, trial_started_at INTEGER, license_activated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE app_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sessions VALUES ('s-v3', 1, NULL, 0);
    INSERT INTO entries VALUES ('v3-entry', 's-v3', 'Pending', '123', '', '1', 1, 'pending', NULL, NULL, 0, NULL);
    INSERT INTO app_state VALUES (1, 's-v3', '[]', '{}', '[]', NULL, NULL, NULL, 1, 0);
    PRAGMA user_version = 3;
  `)
  old.close()

  const database = createKaraokeDatabase(directory)
  try {
    const state = database.loadState()
    assert.equal(state.queue?.[0]?.id, 'v3-entry')
    assert.equal(state.queueOrderPolicyVersion, 0)
    assert.equal(state.regularsSinceDebut, 0)
    assert.equal(state.currentTurnAutomatic, false)
    const upgraded = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(upgraded.prepare('PRAGMA user_version').get()?.user_version, 4)
    } finally {
      upgraded.close()
    }
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SQLite persiste ordem operacional, fase do ciclo, fixações e congelamento após reabertura', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-cadence-reopen-'))
  const state: AppState = {
    queue: [
      { id: 'regular-next', name: 'R', songNumber: '1', songNumber2: '', table: '1', insertedAt: 1, status: 'pending', sessionId: 's1' },
      { id: 'debut-next', name: 'D', songNumber: '2', songNumber2: '', table: '2', insertedAt: 2, status: 'pending', sessionId: 's1' }
    ],
    history: [], sessions: [{ id: 's1', startedAt: 1, endedAt: null }], currentSessionId: 's1',
    priorityIds: [], fixedTurnPositions: { 'regular-next': 1 }, frozenTurnIds: ['regular-next'],
    queueOrderPolicyVersion: 1, regularsSinceDebut: 2, currentTurnAutomatic: true,
    nextTurnId: null, currentTurnId: null, lastReset: null, trialStartedAt: 1, licenseActivated: false
  }
  const first = createKaraokeDatabase(directory)
  first.saveState(state)
  first.close()
  const reopened = createKaraokeDatabase(directory)
  try {
    const recovered = reopened.loadState()
    assert.deepEqual(recovered.queue?.map(entry => entry.id), ['regular-next', 'debut-next'])
    assert.equal(recovered.queueOrderPolicyVersion, 1)
    assert.equal(recovered.regularsSinceDebut, 2)
    assert.equal(recovered.currentTurnAutomatic, true)
    assert.deepEqual(recovered.fixedTurnPositions, { 'regular-next': 1 })
    assert.deepEqual(recovered.frozenTurnIds, ['regular-next'])
    const raw = new DatabaseSync(path.join(directory, 'karaoke.sqlite'), { readOnly: true })
    try {
      assert.deepEqual(raw.prepare('SELECT id FROM entries WHERE status = ? ORDER BY queue_order').all('pending')
        .map((row: any) => row.id), ['regular-next', 'debut-next'])
      const persistedCadence = raw.prepare('SELECT queue_order_policy_version, regulars_since_debut, current_turn_automatic FROM app_state').get() as any
      assert.equal(persistedCadence.queue_order_policy_version, 1)
      assert.equal(persistedCadence.regulars_since_debut, 2)
      assert.equal(persistedCadence.current_turn_automatic, 1)
    } finally { raw.close() }
  } finally {
    reopened.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SQLite mantém pendências arquivadas na sessão encerrada sem restaurá-las na fila ativa', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-archived-pending-'))
  const oldPending: QueueEntry = {
    id: 'old-pending', name: 'Cantor antigo', songNumber: '101', songNumber2: '',
    table: '8', insertedAt: 10, status: 'pending', sessionId: 's-old'
  }
  const currentPending: QueueEntry = {
    id: 'new-pending', name: 'Cantor atual', songNumber: '202', songNumber2: '',
    table: '9', insertedAt: 20, status: 'pending', sessionId: 's-new'
  }
  const state: AppState = {
    queue: [currentPending], history: [oldPending],
    sessions: [
      { id: 's-old', startedAt: 1, endedAt: 15 },
      { id: 's-new', startedAt: 16, endedAt: null }
    ],
    currentSessionId: 's-new', priorityIds: [], fixedTurnPositions: {}, frozenTurnIds: [],
    queueOrderPolicyVersion: 1, regularsSinceDebut: 0, currentTurnAutomatic: false,
    nextTurnId: null, currentTurnId: null, lastReset: null, trialStartedAt: 1, licenseActivated: false
  }
  const database = createKaraokeDatabase(directory)
  try {
    database.saveState(state)
    const recovered = database.loadState()
    assert.deepEqual(recovered.queue?.map(entry => entry.id), ['new-pending'])
    assert.deepEqual(recovered.history?.filter(entry => entry.status === 'pending').map(entry => entry.id), ['old-pending'])
    const raw = new DatabaseSync(path.join(directory, 'karaoke.sqlite'), { readOnly: true })
    try {
      const row = raw.prepare('SELECT status, session_id, queue_order, history_order FROM entries WHERE id = ?').get('old-pending') as any
      assert.equal(row.status, 'pending')
      assert.equal(row.session_id, 's-old')
      assert.equal(row.queue_order, 0)
      assert.equal(row.history_order, null)
      assert.equal(raw.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get()?.current_session_id, 's-new')
    } finally { raw.close() }
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SQLite repara apenas vínculo legado comprovado e mantém dados/referências após reinício', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-null-session-repair-'))
  const database = createKaraokeDatabase(directory)
  const current: QueueEntry = {
    id: 'legacy-db-current', name: 'Cantora', songNumber: '111', songNumber2: '222',
    table: '8', insertedAt: 123, status: 'pending', sessionId: null
  }
  const unclear: QueueEntry = {
    id: 'legacy-db-unclear', name: 'Outro', songNumber: '333', songNumber2: '',
    table: '9', insertedAt: 124, status: 'pending', sessionId: null
  }
  const repository = createStateRepository({
    async load() { return database.loadState() },
    async save(state) { database.saveState(state); return true }
  })
  try {
    database.saveState({
      queue: [current, unclear], history: [], sessions: [{ id: 's-active', startedAt: 100, endedAt: null }],
      currentSessionId: 's-active', currentTurnId: current.id, fixedTurnPositions: {}, frozenTurnIds: [],
      priorityIds: [], queueOrderPolicyVersion: 2, regularsSinceDebut: 2, currentTurnAutomatic: false,
      nextTurnId: null, lastReset: null, trialStartedAt: 1, licenseActivated: false
    } as AppState)
    const app = new KaraokeApplication(repository)
    await app.load()
    assert.equal(app.state.queue[0].id, current.id)
    assert.equal(app.state.queue[0].sessionId, 's-active')
    assert.equal(app.state.queue[0].name, 'Cantora')
    assert.equal(app.state.queue[0].songNumber2, '222')
    assert.equal(app.state.history.find(entry => entry.id === unclear.id)?.sessionId, null)
    assert.equal(app.state.history.filter(entry => entry.id === unclear.id).length, 1)
    assert.equal(app.state.regularsSinceDebut, 2)

    const raw = new DatabaseSync(path.join(directory, 'karaoke.sqlite'), { readOnly: true })
    try {
      const rows = raw.prepare('SELECT id, session_id, name, song_number, song_number2, inserted_at FROM entries ORDER BY id')
        .all().map(row => ({ ...row })) as any[]
      assert.deepEqual(rows, [
        { id: current.id, session_id: 's-active', name: 'Cantora', song_number: '111', song_number2: '222', inserted_at: 123 },
        { id: unclear.id, session_id: null, name: 'Outro', song_number: '333', song_number2: '', inserted_at: 124 }
      ])
    } finally { raw.close() }
    const reopened = new KaraokeApplication(repository)
    await reopened.load()
    assert.deepEqual(reopened.state.queue.map(entry => entry.id), [current.id])
    assert.equal(reopened.state.history.filter(entry => entry.id === unclear.id).length, 1)
    assert.equal(reopened.state.queue[0].sessionId, 's-active')
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SQLite não reativa vínculo nulo referenciado quando a sessão atual já terminou', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-ended-null-session-'))
  const database = createKaraokeDatabase(directory)
  const pending: QueueEntry = {
    id: 'ended-null-pending', name: 'Arquivado', songNumber: '1', songNumber2: '',
    table: '8', insertedAt: 10, status: 'pending', sessionId: null
  }
  try {
    database.saveState({
      queue: [pending], history: [], sessions: [{ id: 'ended', startedAt: 1, endedAt: 20 }],
      currentSessionId: 'ended', currentTurnId: pending.id, nextTurnId: null, priorityIds: [],
      fixedTurnPositions: {}, frozenTurnIds: [], queueOrderPolicyVersion: 2,
      regularsSinceDebut: 1, currentTurnAutomatic: false, lastReset: null,
      trialStartedAt: 1, licenseActivated: false
    } as AppState)
    const loaded = database.loadState()
    assert.deepEqual(loaded.queue, [])
    assert.equal(loaded.history?.length, 1)
    assert.equal(loaded.history?.[0].id, pending.id)
    assert.equal(loaded.history?.[0].sessionId, null)
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SQLite descarta os campos legados de trial de 30 dias e senha na nova persistência', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-old-license-fields-'))
  const database = createKaraokeDatabase(directory)
  try {
    database.saveState({
      queue: [], history: [], sessions: [], currentSessionId: null, priorityIds: [],
      fixedTurnPositions: {}, frozenTurnIds: [], nextTurnId: null, currentTurnId: null,
      queueOrderPolicyVersion: 2, regularsSinceDebut: 0, currentTurnAutomatic: false,
      lastReset: null, trialStartedAt: 1, licenseActivated: true
    } as AppState)
    const loaded = database.loadState() as any
    assert.equal(loaded.trialStartedAt, undefined)
    assert.equal(loaded.licenseActivated, undefined)
    const raw = new DatabaseSync(path.join(directory, 'karaoke.sqlite'), { readOnly: true })
    try {
      const legacy = raw.prepare('SELECT trial_started_at, license_activated FROM app_state WHERE singleton = 1').get() as any
      assert.equal(legacy.trial_started_at, null)
      assert.equal(legacy.license_activated, 0)
    } finally { raw.close() }
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
