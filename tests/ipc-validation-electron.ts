// @ts-nocheck
export {}
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-ipc-validation-'))
const profile = path.join(root, 'profile')
const project = path.resolve(__dirname, '../..')
let app
let page
let databasePath
let completed = false

function readPersistedState() {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return {
      state: database.prepare('SELECT * FROM app_state ORDER BY singleton').all(),
      entries: database.prepare('SELECT * FROM entries ORDER BY id').all(),
      sessions: database.prepare('SELECT * FROM sessions ORDER BY session_order').all()
    }
  } finally {
    database.close()
  }
}

async function launch() {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [project, `--user-data-dir=${profile}`],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_DATA_HOME: path.join(root, 'data')
    }
  })
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.__kqueue)
  if (await page.locator('#startup-modal').isVisible()) {
    await page.locator('#btn-startup-primary').click()
  }
  databasePath = path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'karaoke.sqlite')
  assert.ok(databasePath.startsWith(root), 'Electron must use the test-owned temporary profile')
}

async function closeForced() {
  if (!app) return
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app.close().catch(() => {})
  app = null
}

async function add(table, name) {
  await page.locator('#input-table').fill(table)
  await page.locator('#input-name').fill(name)
  await page.locator('#input-song').fill(`SONG-${table}`)
  await page.locator('#form-entry button[type="submit"]').click()
  await page.evaluate(() => window.__kqueue.flushState())
}

async function run() {
  try {
    await launch()
    assert.equal(await page.evaluate(() => !!window.karaokeDatabase), true,
      'the real Preload database bridge must be exposed')

    await add('1', 'Pending singer')
    await add('2', 'Singer with history')
    await page.locator('#now-block .btn-done-lg').click()
    await page.evaluate(() => window.__kqueue.flushState())

    const before = readPersistedState()
    assert.equal(before.sessions.length, 1, 'fixture must contain an active session')
    assert.equal(before.entries.length, 2, 'fixture must contain two persisted presentations')
    assert.equal(before.entries.filter(entry => entry.status === 'done').length, 1,
      'fixture must contain a completed presentation')
    assert.equal(before.entries.filter(entry => entry.status === 'pending').length, 1,
      'fixture must retain a pending presentation')

    const results = await page.evaluate(async () => {
      const base = await window.karaokeDatabase.load()
      const { history, ...withoutHistory } = base
      const invalidPayloads = [
        ['empty object', {}],
        ['null', null],
        ['undefined', undefined],
        ['array root', []],
        ['required field missing', withoutHistory],
        ['queue must be an array', { ...base, queue: {} }],
        ['priorityIds must be an array', { ...base, priorityIds: {} }],
        ['entry identifier must be a string', {
          ...base, queue: [{ ...base.queue[0], id: 7 }]
        }],
        ['entry timestamp must be finite', {
          ...base, queue: [{ ...base.queue[0], insertedAt: Number.NaN }]
        }],
        ['history status must be supported', {
          ...base, history: [{ ...base.history[0], status: 'unknown' }]
        }],
        ['session timestamp must be numeric', {
          ...base, sessions: [{ ...base.sessions[0], startedAt: 'invalid' }]
        }]
      ]
      const outcomes = []
      for (const [label, payload] of invalidPayloads) {
        try {
          await window.karaokeDatabase.save(payload)
          outcomes.push({ label, outcome: 'resolved' })
        } catch (error) {
          outcomes.push({ label, outcome: 'rejected', message: String(error) })
        }
      }
      return outcomes
    })
    const after = readPersistedState()
    console.log('IPC_INVALID_PAYLOADS', JSON.stringify({
      results,
      before: { sessions: before.sessions.length, entries: before.entries.length },
      after: { sessions: after.sessions.length, entries: after.entries.length },
      databasePath
    }))

    assert.ok(results.every(result => result.outcome === 'rejected'),
      'every structurally invalid app-data:save payload must be rejected')
    assert.deepEqual(after, before, 'rejecting invalid payloads must preserve all SQLite rows')

    await add('3', 'Valid operation after rejection')
    assert.equal(readPersistedState().entries.length, 3,
      'a valid application write must still persist after the rejected IPC payload')

    const expectedAfterRestart = readPersistedState()
    await closeForced()
    await launch()
    assert.deepEqual(readPersistedState(), expectedAfterRestart,
      'SQLite data must remain intact after restarting Electron')
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 2,
      'both pending presentations must be recoverable after restart')
    completed = true
    console.log('PASS Electron IPC validation with isolated SQLite and restart recovery')
  } finally {
    await closeForced()
    if (completed) fs.rmSync(root, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
