import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createKaraokeDatabase } from '../database'
import { ManagementRemoteJournalInbox } from '../src/management-remote-journal'
import type { OperationalMessage } from '../src/operational-protocol-contracts'

const fixtures = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/operational-v1/valid-messages.json'), 'utf8')) as OperationalMessage[]
const deviceId = 'device-player-01'
const controllerId = 'controller-local-01'
const journalId = 'journal-device-01'

function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'kq-management-remote-journal-')) }
function page(overrides: Record<string, unknown> = {}): OperationalMessage {
  const value = structuredClone(fixtures.find(message => message.kind === 'response' && message.body.type === 'journal-page')!) as any
  value.body.payload.highWatermark = 2
  value.body.payload.hasMore = false
  Object.assign(value.body.payload, overrides)
  return value
}
function snapshot(highWatermark: number, compactedThrough = 0): OperationalMessage {
  const value = structuredClone(fixtures.find(message => message.kind === 'response' && message.body.type === 'snapshot')!) as any
  value.body.payload.highWatermark = highWatermark
  value.body.payload.compactedThrough = compactedThrough
  return value
}

test('Management inbox stores contiguous events transactionally and survives restart', () => {
  const directory = temp()
  let database = createKaraokeDatabase(directory)
  let inbox = new ManagementRemoteJournalInbox(database, { controllerId })
  try {
    const first = inbox.persistPage(deviceId, 0, page())
    assert.equal(first.throughSequence, 2)
    assert.equal(inbox.readEvents(deviceId, 0, 32).map(event => event.sequence).join(','), '1,2')
    const replay = inbox.persistPage(deviceId, 0, page())
    assert.equal(replay.throughSequence, 2)
    assert.equal(inbox.readEvents(deviceId, 0, 32).length, 2)

    const changed = page()
    ;((changed as any).body.payload.events[0].payload as { packageRevision: number }).packageRevision = 9
    assert.throws(() => inbox.persistPage(deviceId, 0, changed), /EVENT_CONFLICT/)
    const gap = page({ events: [{ ...((page() as any).body.payload.events[0]), eventSequence: 4 }],
      throughSequence: 4, highWatermark: 4, hasMore: true })
    assert.throws(() => inbox.persistPage(deviceId, 2, gap), /PAGE_INVALID/)
  } finally { database.close() }

  database = createKaraokeDatabase(directory)
  inbox = new ManagementRemoteJournalInbox(database, { controllerId })
  try {
    assert.equal(inbox.cursor(deviceId)?.throughSequence, 2)
    assert.equal(inbox.readEvents(deviceId, 0, 32).length, 2)
  } finally { database.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Management snapshot records announced watermark without advancing received cursor', () => {
  const directory = temp()
  let database = createKaraokeDatabase(directory)
  let inbox = new ManagementRemoteJournalInbox(database, { controllerId })
  try {
    const persisted = inbox.persistSnapshot(deviceId, snapshot(13, 0))
    assert.equal(persisted.throughSequence, 0)
    assert.equal(persisted.snapshotHighWatermark, 13)
    assert.equal(persisted.highWatermark, 13)
    assert.equal(persisted.recoveryRequired, false)
    assert.deepEqual(inbox.readEvents(deviceId, 0, 32), [])
    assert.throws(() => inbox.readEvents(deviceId, 13, 32), /GAP/)
    assert.equal(inbox.latestSnapshot(deviceId)?.kind, 'response')
    const retriedSnapshot = snapshot(13, 0) as any
    retriedSnapshot.messageId = 'different-message-id'
    retriedSnapshot.body.correlationId = 'different-correlation'
    assert.equal(inbox.persistSnapshot(deviceId, retriedSnapshot).throughSequence, 0)
    assert.equal(inbox.cursor(deviceId)?.throughSequence, 0)
    assert.equal(inbox.cursor(deviceId)?.snapshotHighWatermark, 13)
    assert.throws(() => inbox.persistSnapshot(deviceId, snapshot(12, 0)), /ROLLBACK/)
    const foreignLineage = structuredClone(snapshot(14, 4)) as any
    foreignLineage.body.payload.journalId = 'journal-restored-old'
    assert.throws(() => inbox.persistSnapshot(deviceId, foreignLineage), /LINEAGE_MISMATCH/)
    database.close()
    database = createKaraokeDatabase(directory)
    inbox = new ManagementRemoteJournalInbox(database, { controllerId })
    assert.equal(inbox.cursor(deviceId)?.throughSequence, 0)
    assert.equal(inbox.cursor(deviceId)?.snapshotHighWatermark, 13)
  } finally { database.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('snapshot beyond received cursor after Player compaction fences inbox recovery', () => {
  const directory = temp()
  const database = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(database, { controllerId })
  try {
    const cursor = inbox.persistSnapshot(deviceId, snapshot(13, 4))
    assert.equal(cursor.throughSequence, 0)
    assert.equal(cursor.recoveryRequired, true)
    assert.throws(() => inbox.readEvents(deviceId, 0, 32), /RECOVERY_REQUIRED/)
  } finally { database.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('legacy v8 cursor advanced by snapshot is preserved and fenced during v9 migration', () => {
  const directory = temp()
  let database = createKaraokeDatabase(directory)
  try {
    const inbox = new ManagementRemoteJournalInbox(database, { controllerId })
    inbox.persistSnapshot(deviceId, snapshot(13, 0))
    database.close()
    const legacy = new DatabaseSync(path.join(directory, 'karaoke.sqlite'))
    legacy.prepare(`UPDATE management_remote_journal_state SET through_sequence=13
      WHERE player_device_id=? AND controller_id=?`).run(deviceId, controllerId)
    legacy.exec('PRAGMA user_version=8')
    legacy.close()
    database = createKaraokeDatabase(directory)
    const migrated = new ManagementRemoteJournalInbox(database, { controllerId })
    const cursor = migrated.cursor(deviceId)!
    assert.equal(cursor.throughSequence, 0)
    assert.equal(cursor.legacyThroughSequence, 13)
    assert.equal(cursor.recoveryRequired, true)
    assert.equal(migrated.latestSnapshot(deviceId)?.kind, 'response')
    assert.throws(() => migrated.readEvents(deviceId, 0, 32), /RECOVERY_REQUIRED/)
  } finally { database.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Management inbox rejects identity mismatch and never ACKs data it failed to persist', () => {
  const directory = temp()
  const database = createKaraokeDatabase(directory)
  const inbox = new ManagementRemoteJournalInbox(database, { controllerId })
  try {
    const invalidIdentity = page() as any
    invalidIdentity.controllerId = 'other-controller'
    assert.throws(() => inbox.persistPage(deviceId, 0, invalidIdentity), /IDENTITY_MISMATCH/)
    assert.equal(inbox.cursor(deviceId), null)
  } finally { database.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})
