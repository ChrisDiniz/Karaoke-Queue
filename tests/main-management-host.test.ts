import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKaraokeDatabase } from '../database'
import { KaraokeApplication, type NewQueueEntry } from '../src/application'
import { createLegacyStateStorageBuffer, createStateRepository } from '../src/state-repository'
import { MainManagementHost } from '../src/main-management-host'
import { LEGACY_STATE_STORAGE_KEYS, type LegacyStateStorageDto } from '../src/persistence-contracts'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-management-host-'))
  const database = createKaraokeDatabase(root)
  const application = new KaraokeApplication(createStateRepository({
    async load() { return database.loadState() },
    async save(state) { database.saveState(state); return true }
  }))
  const host = new MainManagementHost(application, { hostEpoch: 'host-test-1' })
  return {
    root, database, host,
    close() { database.close(); fs.rmSync(root, { recursive: true, force: true }) }
  }
}

const entry = (table: string): NewQueueEntry => ({ name: `Singer ${table}`, songNumber: `SONG-${table}`, songNumber2: '', table })
const legacyState = (queue: string | null): LegacyStateStorageDto => Object.fromEntries(
  Object.values(LEGACY_STATE_STORAGE_KEYS).map(key => [key, key === LEGACY_STATE_STORAGE_KEYS.QUEUE ? queue : null])
) as LegacyStateStorageDto

test('Main host initializes once without a Renderer and serves confirmed serializable snapshots', async () => {
  const context = setup()
  try {
    const first = await context.host.initialize()
    const second = await context.host.initialize(true)
    assert.equal(first.hostEpoch, 'host-test-1')
    assert.equal(second.revision, first.revision)
    const reply = await context.host.execute({ operationId: 'create-one', command: { type: 'addEntries', entries: [entry('1')], selectCurrent: true } })
    assert.equal(reply.snapshot.revision, first.revision + 1)
    assert.equal(reply.snapshot.state.queue.length, 1)
    assert.equal(context.database.loadState().queue?.length, 1)
    ;(reply.snapshot.state.queue as QueueEntry[]).push(entry('forged') as QueueEntry)
    assert.equal(context.host.snapshot().state.queue.length, 1, 'returned DTO mutation cannot reach host state')
  } finally { context.close() }
})

test('legacy Renderer state is imported by the Main authority and acknowledged for cleanup only after commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-management-legacy-import-'))
  const database = createKaraokeDatabase(root)
  const legacy = createLegacyStateStorageBuffer()
  const legacyQueue = JSON.stringify([{ id: 'legacy-entry', name: 'Legacy Singer', songNumber: '123', songNumber2: '',
    table: '4', insertedAt: 123, status: 'pending', sessionId: null }])
  const application = new KaraokeApplication(createStateRepository({
    async load() { return database.loadState() }, async save(state) { database.saveState(state); return true }
  }, legacy.storage))
  const host = new MainManagementHost(application, { installLegacyStorage: legacy.replace })
  try {
    const initialized = await host.initialize(false, legacyState(legacyQueue))
    assert.equal(initialized.didImportLegacyStorage, true)
    assert.equal(database.loadState().queue?.[0]?.id, 'legacy-entry')
    assert.equal(legacy.storage.getItem(LEGACY_STATE_STORAGE_KEYS.QUEUE), null,
      'the in-memory source is cleared only after the persistence commit')
  } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed or read-only legacy import leaves source values intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-management-legacy-uncommitted-'))
  const database = createKaraokeDatabase(root)
  const inspector = new DatabaseSync(database.databasePath)
  const rawQueue = JSON.stringify([{ id: 'legacy-uncommitted', name: 'Preserve Me', songNumber: '234', songNumber2: '',
    table: '2', insertedAt: 124, status: 'pending', sessionId: null }])
  const legacy = createLegacyStateStorageBuffer()
  legacy.replace(legacyState(rawQueue))
  try {
    inspector.exec("CREATE TRIGGER legacy_import_fail BEFORE INSERT ON app_state BEGIN SELECT RAISE(ABORT, 'legacy import commit failure'); END")
    const failedHost = new MainManagementHost(new KaraokeApplication(createStateRepository({
      async load() { return database.loadState() }, async save(state) { database.saveState(state); return true }
    }, legacy.storage)))
    await assert.rejects(failedHost.initialize())
    assert.equal(legacy.storage.getItem(LEGACY_STATE_STORAGE_KEYS.QUEUE), rawQueue)
    inspector.exec('DROP TRIGGER legacy_import_fail')
    const retried = await failedHost.initialize(false, legacyState(rawQueue))
    assert.equal(retried.didImportLegacyStorage, true)
    assert.equal(database.loadState().queue?.[0]?.id, 'legacy-uncommitted')

    const readOnlyRoot = path.join(root, 'read-only')
    const readOnlyDatabase = createKaraokeDatabase(readOnlyRoot)
    const readOnlyBuffer = createLegacyStateStorageBuffer()
    readOnlyBuffer.replace(legacyState(rawQueue))
    const readOnlyHost = new MainManagementHost(new KaraokeApplication(createStateRepository({
      async load() { return readOnlyDatabase.loadState() }, async save(state) { readOnlyDatabase.saveState(state); return true }
    }, readOnlyBuffer.storage)))
    const readOnly = await readOnlyHost.initialize(true)
    assert.equal(readOnly.didImportLegacyStorage, false)
    assert.equal(readOnlyBuffer.storage.getItem(LEGACY_STATE_STORAGE_KEYS.QUEUE), rawQueue)
    readOnlyDatabase.close()
  } finally { inspector.close(); database.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('a persistence failure does not publish a candidate; retry after recovery commits once', async () => {
  const context = setup()
  const inspector = new DatabaseSync(context.database.databasePath)
  try {
    const initial = await context.host.initialize()
    inspector.exec("CREATE TRIGGER management_reject_write BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT, 'injected SQLite failure'); END")
    await assert.rejects(context.host.execute({ operationId: 'failed-add', command: { type: 'addEntries', entries: [entry('2')], selectCurrent: true } }))
    assert.equal(context.host.snapshot().revision, initial.revision)
    assert.equal(context.host.snapshot().state.queue.length, 0)
    assert.equal(context.database.loadState().queue?.length, 0)
    inspector.exec('DROP TRIGGER management_reject_write')
    await context.host.execute({ operationId: 'retry-add', command: { type: 'addEntries', entries: [entry('2')], selectCurrent: true } })
    assert.equal(context.database.loadState().queue?.length, 1)
  } finally { inspector.close(); context.close() }
})

test('lost reply is reconciled from confirmed snapshot and a same-operation retry does not duplicate writes', async () => {
  const context = setup()
  try {
    const initial = await context.host.initialize()
    const request = { operationId: 'lost-reply-add', command: { type: 'addEntries' as const, entries: [entry('3')], selectCurrent: true } }
    const committedButUnobserved = await context.host.execute(request)
    const reconciled = context.host.snapshot()
    assert.equal(reconciled.revision, committedButUnobserved.snapshot.revision)
    assert.equal(reconciled.state.queue.length, 1)
    const retry = await context.host.execute(request)
    assert.deepEqual(retry, committedButUnobserved)
    assert.equal(context.database.loadState().queue?.length, 1)
    assert.equal(reconciled.revision, initial.revision + 1)
  } finally { context.close() }
})

test('concurrent accepted commands are serialized by the existing application authority', async () => {
  const context = setup()
  try {
    await context.host.initialize()
    await Promise.all(['4', '5', '6'].map(table => context.host.execute({
      operationId: `add-${table}`, command: { type: 'addEntries', entries: [entry(table)], selectCurrent: true }
    })))
    assert.equal(context.database.loadState().queue?.length, 3)
    assert.equal(context.host.snapshot().state.queue.length, 3)
  } finally { context.close() }
})

test('closing the windowless host drains an already accepted operation before returning', async () => {
  let state: Partial<AppState> = {}
  let delayWrites = false
  let markStarted!: () => void
  let releaseWrite!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const gate = new Promise<void>(resolve => { releaseWrite = resolve })
  const app = new KaraokeApplication(createStateRepository({
    async load() { return structuredClone(state) },
    async save(candidate) {
      if (delayWrites) { markStarted(); await gate }
      state = structuredClone(candidate)
      return true
    }
  }))
  const host = new MainManagementHost(app, { hostEpoch: 'pending-op-host' })
  await host.initialize()
  delayWrites = true
  const operation = host.execute({ operationId: 'pending-add', command: { type: 'addEntries', entries: [entry('7')], selectCurrent: true } })
  await started
  let drained = false
  const closing = host.prepareToClose().then(() => { drained = true })
  assert.equal(drained, false)
  releaseWrite()
  await Promise.all([operation, closing])
  assert.equal(drained, true)
  assert.equal(host.snapshot().state.queue.length, 1)
})
