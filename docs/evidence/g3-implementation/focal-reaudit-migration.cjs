// Independent focal audit: real v8 layout, transactional failure, restart and evidence retention.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createKaraokeDatabase } = require(path.join(process.cwd(), 'build/database'))
const { ManagementRemoteJournalInbox } = require(path.join(process.cwd(), 'build/src/management-remote-journal'))
const fixtures = JSON.parse(fs.readFileSync('tests/fixtures/operational-v1/valid-messages.json', 'utf8'))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-focal-v8-'))
let db
try {
  db = createKaraokeDatabase(directory)
  const page = structuredClone(fixtures.find(x => x.kind === 'response' && x.body.type === 'journal-page'))
  page.body.payload.highWatermark = 2
  page.body.payload.hasMore = false
  const device = page.deviceId, controller = page.controllerId
  new ManagementRemoteJournalInbox(db, { controllerId: controller }).persistPage(device, 0, page)
  db.close(); db = null
  let raw = new DatabaseSync(path.join(directory, 'karaoke.sqlite'))
  for (const name of ['snapshot_high_watermark', 'legacy_through_sequence', 'recovery_required']) {
    raw.exec(`ALTER TABLE management_remote_journal_state DROP COLUMN ${name}`)
  }
  raw.exec(`PRAGMA user_version=8;
    CREATE TRIGGER audit_abort_migration BEFORE UPDATE ON management_remote_journal_state
    BEGIN SELECT RAISE(ABORT,'audit-migration-fault'); END;`)
  raw.close()
  assert.throws(() => createKaraokeDatabase(directory), /audit-migration-fault/)
  raw = new DatabaseSync(path.join(directory, 'karaoke.sqlite'))
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 8)
  assert.equal(raw.prepare('PRAGMA table_info(management_remote_journal_state)').all().some(x => x.name === 'recovery_required'), false)
  assert.equal(raw.prepare('SELECT count(*) n FROM management_remote_journal_events').get().n, 2)
  raw.exec('DROP TRIGGER audit_abort_migration')
  raw.close()
  db = createKaraokeDatabase(directory)
  let inbox = new ManagementRemoteJournalInbox(db, { controllerId: controller })
  assert.equal(inbox.cursor(device).throughSequence, 2)
  assert.equal(inbox.cursor(device).legacyThroughSequence, 2)
  assert.equal(inbox.cursor(device).recoveryRequired, false)
  assert.equal(inbox.readEvents(device, 0, 32).length, 2)
  db.close(); db = createKaraokeDatabase(directory)
  inbox = new ManagementRemoteJournalInbox(db, { controllerId: controller })
  assert.equal(inbox.cursor(device).legacyThroughSequence, 2)
  assert.equal(inbox.readEvents(device, 0, 32).length, 2)
  console.log('A3 independent v8 migration: PASS (rollback, retry, consistent prefix, retained events and idempotent restart)')
} finally { db?.close(); fs.rmSync(directory, { recursive: true, force: true }) }
