import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KaraokeApplication } from '../src/application'
import { createStateRepository, PersistenceError } from '../src/state-repository'
import { validateAppStatePayload } from '../src/app-state-validation'
import { createKaraokeDatabase } from '../database'

const input = (table = '1') => ({ name: `Test ${table}`, table, songNumber: '1', songNumber2: '2' })
async function fixture() {
  let saved: StoredAppState = {}
  let writes = 0
  let failAt = -1
  let failure = 'SQLITE_READONLY'
  let readFailure = false
  let commitThenFail = false
  let hold: (() => Promise<void>) | null = null
  const repository = createStateRepository({
    async load() { if (readFailure) throw Error('IPC unavailable'); return structuredClone(saved) },
    async save(state) {
      writes++
      if (hold) await hold()
      if (commitThenFail) { saved = structuredClone(state); throw Error('IPC reply lost') }
      if (writes === failAt || failAt === -2) throw Error(failure)
      saved = structuredClone(state)
      return true
    }
  })
  const app = new KaraokeApplication(repository)
  await app.load()
  return { app, repository, saved: () => structuredClone(saved), writes: () => writes,
    reject: (offset = 1, reason = 'SQLITE_READONLY') => { failAt = offset === -2 ? -2 : writes + offset; failure = reason },
    heal: () => { failAt = -1; readFailure = false; commitThenFail = false },
    loseReply: (loseRead = false) => { commitThenFail = true; readFailure = loseRead },
    hold: (callback: (() => Promise<void>) | null) => { hold = callback }
  }
}

test('publish only after confirmation; snapshots and inputs captured; duplicate completion is a no-op', async () => {
  const f = await fixture()
  let release!: () => void
  f.hold(() => new Promise(resolve => { release = resolve }))
  const entered = input()
  const pending = f.app.addEntry(entered)
  entered.name = 'changed after submission'
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.app.state.queue.length, 0)
  release()
  const entry = await pending
  assert.equal(entry.name, 'Test 1')
  f.hold(null)
  await f.app.ensureCurrentTurn()
  const results = await Promise.all([f.app.completeAndAdvance(entry.id), f.app.completeAndAdvance(entry.id)])
  assert.ok(results[0]); assert.equal(results[1], null)
  assert.equal(f.app.state.history.length, 1)
})

for (const operation of ['add', 'batch', 'edit', 'done', 'cancel', 'pin', 'freeze', 'release', 'unpin', 'current', 'promote', 'end', 'new-session'] as const) {
  test(`rejected ${operation}: no published state, no partial changes, safe recovery`, async () => {
    const f = await fixture()
    const entries = await f.app.addEntries([input('1'), input('2'), input('3')])
    if (operation !== 'current') await f.app.ensureCurrentTurn()
    if (operation === 'release') await f.app.freezeThrough(entries[2].id)
    if (operation === 'unpin') await f.app.moveTurn(entries[2].id, 1)
    const before = structuredClone(f.app.state)
    const dbBefore = f.saved()
    f.reject()
    const actions = {
      add: () => f.app.addEntry(input('4')), batch: () => f.app.addEntries([input('4'), input('5')], true),
      edit: () => f.app.editEntry(entries[0].id, input('5')), done: () => f.app.completeAndAdvance(entries[0].id),
      cancel: () => f.app.cancelAndAdvance(entries[0].id), pin: () => f.app.moveTurn(entries[2].id, 1),
      freeze: () => f.app.freezeThrough(entries[2].id), release: () => f.app.releaseFreeze(),
      unpin: () => f.app.unpin(entries[2].id), current: () => f.app.ensureCurrentTurn(),
      promote: () => f.app.promoteToCurrent(entries[2].id), end: () => f.app.endCurrentSession(),
      'new-session': () => f.app.startNewSession()
    }
    await assert.rejects(actions[operation](), (error: unknown) => error instanceof PersistenceError && error.outcome === 'failed')
    assert.deepEqual(f.app.state, before)
    assert.deepEqual(f.saved(), dbBefore)
    await assert.rejects(f.app.flush())
    f.heal()
    await f.app.recoverPersistence()
    await actions[operation]()
    await f.app.flush()
  })
}

for (const failIndex of [1, 3]) test(`five queued operations, failure at ${failIndex}: reject dependents, preserve confirmed prefix`, async () => {
  const f = await fixture()
  f.reject(failIndex)
  const results = await Promise.allSettled(['1', '2', '3', '4', '5'].map(table => f.app.addEntry(input(table))))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, failIndex - 1)
  assert.equal(f.app.state.queue.length, failIndex - 1)
  assert.equal(f.saved().queue!.length, failIndex - 1)
  f.heal()
  const added = await f.app.addEntry(input('6'))
  assert.equal(f.app.state.queue.length, failIndex)
  assert.equal(f.saved().queue!.some(entry => entry.id === added.id), true)
})

test('five concurrent writes prepare from confirmed predecessors; no obsolete snapshot', async () => {
  const f = await fixture()
  const entries = await Promise.all(['1', '2', '3', '4', '5'].map(table => f.app.addEntry(input(table))))
  assert.equal(f.saved().queue!.length, 5)
  assert.equal(new Set(entries.map(entry => entry.id)).size, 5)
  assert.deepEqual(f.app.state.queue.map(entry => entry.id), f.saved().queue!.map(entry => entry.id))
})

test('bounded retries only for verified contention; permanent IO, full, permission, readonly errors do not retry', async () => {
  const f = await fixture()
  f.reject(1, 'SQLITE_BUSY')
  const writes = f.writes()
  await f.app.addEntry(input())
  assert.equal(f.writes() - writes, 2)
  f.reject(-2, 'SQLITE_LOCKED')
  const locked = f.writes()
  await assert.rejects(f.app.addEntry(input('2')))
  assert.equal(f.writes() - locked, 3)
  for (const reason of ['SQLITE_READONLY', 'SQLITE_FULL', 'SQLITE_IOERR', 'EACCES']) {
    f.heal(); f.reject(1, reason)
    const count = f.writes()
    await assert.rejects(f.app.addEntry(input('3')))
    assert.equal(f.writes() - count, 1)
  }
})

test('lost IPC reply after commit reconciles without another write or duplicate', async () => {
  const f = await fixture()
  f.loseReply()
  const count = f.writes()
  await f.app.addEntry(input())
  assert.equal(f.writes(), count + 1)
  assert.equal(f.app.state.queue.length, 1)
})

test('uncertain result blocks writes and close; explicit read recovery publishes confirmed candidate', async () => {
  const f = await fixture()
  f.loseReply(true)
  await assert.rejects(f.app.addEntry(input()), (error: unknown) => error instanceof PersistenceError && error.outcome === 'uncertain')
  assert.equal(f.app.state.queue.length, 0)
  const count = f.writes()
  await assert.rejects(f.app.addEntry(input('2')))
  await assert.rejects(f.app.prepareToClose())
  assert.equal(f.writes(), count)
  f.app.cancelClose()
  f.heal()
  await f.app.recoverPersistence()
  assert.equal(f.app.state.queue.length, 1)
  await f.app.addEntry(input('2'))
  assert.equal(f.saved().queue!.length, 2)
})

test('close waits for accepted commands and blocks new commands; cancellation restores admission', async () => {
  const f = await fixture()
  let release!: () => void
  f.hold(() => new Promise(resolve => { release = resolve }))
  const adding = f.app.addEntry(input())
  let closed = false
  const closing = f.app.prepareToClose().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  const rejected = assert.rejects(f.app.addEntry(input('2')))
  release(); await adding; await closing; await rejected
  f.hold(null); f.app.cancelClose()
  await f.app.addEntry(input('2'))
  assert.equal(f.app.state.queue.length, 2)
})

test('real SQLite mid-transaction abort preserves debut, history, order and phase; retry and restart recover together', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-durability-'))
  const db = createKaraokeDatabase(root)
  const inspector = new DatabaseSync(db.databasePath)
  try {
    const repo = createStateRepository({ async load() { return db.loadState() }, async save(state) { db.saveState(state); return true } })
    let app = new KaraokeApplication(repo)
    await app.load()
    const [debut] = await app.addEntries([input('99'), input('100')], true)
    // Seed only cadence via a real save, before reloading the controller.
    db.saveState({ ...structuredClone(app.state), regularsSinceDebut: 2 } as AppState)
    app = new KaraokeApplication(createStateRepository({ async load() { return db.loadState() }, async save(state) { db.saveState(state); return true } }))
    await app.load()
    const before = db.loadState()
    inspector.exec("CREATE TRIGGER fail_state BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL injected'); END")
    await assert.rejects(app.completeAndAdvance(debut.id))
    assert.deepEqual(db.loadState(), before)
    assert.equal(app.state.regularsSinceDebut, 2)
    assert.equal(app.state.currentTurnId, debut.id)
    inspector.exec('DROP TRIGGER fail_state')
    await app.recoverPersistence()
    await app.completeAndAdvance(debut.id)
    assert.equal(app.state.regularsSinceDebut, 0)
    assert.equal(inspector.prepare('SELECT regulars_since_debut FROM app_state').get()!.regulars_since_debut, 0)
    const recovered = new KaraokeApplication(createStateRepository({ async load() { return db.loadState() }, async save(state) { db.saveState(state); return true } }))
    await recovered.load()
    assert.deepEqual(recovered.state, app.state)
  } finally { inspector.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('uncertain but uncommitted result recovers baseline; rejected retry cannot overwrite candidate', async () => {
  let saved: StoredAppState = {}
  let unavailable = false
  const repository = createStateRepository({
    async load() { if (unavailable) throw Error('IPC disconnected'); return structuredClone(saved) },
    async save(state) { if (unavailable) throw Error('IPC disconnected'); saved = structuredClone(state); return true }
  })
  const app = new KaraokeApplication(repository)
  await app.load()
  unavailable = true
  await assert.rejects(app.addEntry(input()))
  unavailable = false
  const recovery = app.recoverPersistence()
  const rejected = assert.rejects(app.addEntry(input('2')))
  assert.equal(await recovery, 'unchanged')
  await rejected
  assert.equal(app.state.queue.length, 0)
  await app.addEntry(input())
  assert.equal(saved.queue!.length, 1)
})

test('readback mismatch stays blocked instead of replacing state or silently overwriting another writer', async () => {
  let saved: StoredAppState = {}
  let altered = false
  const repository = createStateRepository({
    async load() { return structuredClone(saved) },
    async save(state) {
      if (altered) { saved = { ...structuredClone(state), regularsSinceDebut: 2 }; throw Error('response lost') }
      saved = structuredClone(state); return true
    }
  })
  const app = new KaraokeApplication(repository)
  await app.load(); const before = structuredClone(app.state)
  altered = true
  await assert.rejects(app.addEntry(input()))
  await assert.rejects(app.recoverPersistence())
  await assert.rejects(app.addEntry(input('2')))
  assert.deepEqual(app.state, before)
})

test('SQLite read-only connection rejects real write; recovery does not invent a commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-readonly-'))
  const db = createKaraokeDatabase(root)
  let readOnly = false
  let reader: DatabaseSync | undefined
  try {
    const repository = createStateRepository({ async load() { return db.loadState() }, async save(state) {
      if (readOnly) { reader!.exec('UPDATE app_state SET regulars_since_debut = 2'); return true }
      db.saveState(state); return true
    } })
    const app = new KaraokeApplication(repository)
    await app.load()
    const before = db.loadState()
    reader = new DatabaseSync(db.databasePath, { readOnly: true }); readOnly = true
    await assert.rejects(app.addEntry(input()))
    assert.deepEqual(db.loadState(), before)
    assert.deepEqual(app.state, before)
  } finally { reader?.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed read during recovery blocks new writes until baseline can be verified', async () => {
  let saved: StoredAppState = {}
  let canRead = true
  let writes = 0
  const repository = createStateRepository({
    async load() { if (!canRead) throw Error('read failed'); return structuredClone(saved) },
    async save(state) { writes++; saved = structuredClone(state); return true }
  })
  const app = new KaraokeApplication(repository)
  await app.load()
  canRead = false
  await assert.rejects(app.recoverPersistence())
  await assert.rejects(app.addEntry(input()))
  assert.equal(writes, 1)
  canRead = true
  await app.recoverPersistence()
  await app.addEntry(input())
  assert.equal(writes, 2)
})

test('atomic batch retains per-row current selection; later debut cannot replace its first regular', async () => {
  const f = await fixture()
  const regular = await f.app.addEntry(input('1'))
  await f.app.ensureCurrentTurn()
  await f.app.markDone(regular.id)
  // A recovered phase with no current must not let the batch rewrite the first
  // current selection when a later row becomes eligible for debut insertion.
  let saved = { ...structuredClone(f.app.state), regularsSinceDebut: 2 } as AppState
  let writes = 0
  const app = new KaraokeApplication(createStateRepository({
    async load() { return structuredClone(saved) },
    async save(state) { writes++; saved = structuredClone(state); return true }
  }))
  await app.load()
  const before = writes
  const [first, debut] = await app.addEntries([input('1'), input('99')], true)
  assert.equal(app.state.currentTurnId, first.id)
  assert.deepEqual(app.getPlayOrder().map(entry => entry.id), [first.id, debut.id])
  assert.equal(writes, before + 1)
})

test('SQLite snapshot validation rejects malformed payload before save and preserves the confirmed state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-validated-state-'))
  let database = createKaraokeDatabase(root)
  const state: AppState = {
    queue: [
      { id: 'pending-a', name: 'Singer A', songNumber: '101', songNumber2: '', table: '1',
        insertedAt: 10, status: 'pending', sessionId: 'active-session' },
      { id: 'pending-b', name: 'Singer B', songNumber: '202', songNumber2: '203', table: '2',
        insertedAt: 11, status: 'pending', sessionId: 'active-session' }
    ],
    history: [
      { id: 'done-a', name: 'Singer C', songNumber: '303', songNumber2: '', table: '3',
        insertedAt: 1, status: 'done', sessionId: 'old-session', doneAt: 5 },
      { id: 'cancelled-a', name: 'Singer D', songNumber: '404', songNumber2: '', table: '4',
        insertedAt: 2, status: 'cancelled', sessionId: 'old-session', cancelledAt: 6 }
    ],
    sessions: [
      { id: 'old-session', startedAt: 1, endedAt: 7 },
      { id: 'active-session', startedAt: 8, endedAt: null }
    ],
    currentSessionId: 'active-session', priorityIds: [], fixedTurnPositions: { 'pending-b': 1 },
    frozenTurnIds: ['pending-a'], queueOrderPolicyVersion: 2, regularsSinceDebut: 2,
    currentTurnAutomatic: true, nextTurnId: null, currentTurnId: 'pending-a', lastReset: '2024-01-01'
  }
  let saveCalls = 0
  const saveValidated = (payload: unknown): void => {
    const validated = validateAppStatePayload(payload)
    saveCalls++
    database.saveState(validated)
  }
  const inspect = () => {
    const connection = new DatabaseSync(database.databasePath, { readOnly: true })
    try {
      return {
        loaded: database.loadState(),
        appState: connection.prepare('SELECT * FROM app_state ORDER BY singleton').all(),
        entries: connection.prepare('SELECT * FROM entries ORDER BY id').all(),
        sessions: connection.prepare('SELECT * FROM sessions ORDER BY session_order').all()
      }
    } finally { connection.close() }
  }

  try {
    saveValidated(state)
    assert.equal(saveCalls, 1)
    const confirmed = inspect()
    assert.equal(confirmed.entries.length, 4)
    assert.equal(confirmed.sessions.length, 2)

    for (const invalid of [
      {},
      { ...state, queue: {} },
      { ...state, history: [{ id: 7 }] }
    ]) {
      assert.throws(() => saveValidated(invalid))
      assert.equal(saveCalls, 1, 'validation must reject before calling SQLite saveState')
      assert.deepEqual(inspect(), confirmed, 'rejected payload must preserve every confirmed SQLite row')
    }

    const next: AppState = {
      ...state,
      queue: [...state.queue, { id: 'pending-c', name: 'Singer E', songNumber: '505', songNumber2: '',
        table: '5', insertedAt: 12, status: 'pending', sessionId: 'active-session' }]
    }
    saveValidated(next)
    assert.equal(saveCalls, 2, 'a valid snapshot must persist after invalid snapshots are rejected')
    assert.equal(inspect().entries.length, 5)
    assert.equal(inspect().appState[0].regulars_since_debut, 2)

    database.close()
    database = createKaraokeDatabase(root)
    assert.equal(inspect().loaded.queue?.length, 3)
    assert.equal(inspect().loaded.history?.length, 2)
    assert.equal(inspect().loaded.sessions?.length, 2)
    assert.deepEqual(inspect().loaded.frozenTurnIds, ['pending-a'])
  } finally {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
