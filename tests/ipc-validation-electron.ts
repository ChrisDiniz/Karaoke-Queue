// @ts-nocheck
export {}
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')
const { prepareControllerModeProfile } = require('./electron-test-profile')

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
  prepareControllerModeProfile(profile)
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
    assert.equal(await page.evaluate(() => !!window.karaokeManagement), true,
      'the production Preload exposes the Management application client')

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
      const invalidPayloads = [
        ['missing command', null],
        ['unknown command', { operationId: 'bad-type', command: { type: 'eraseEverything' } }],
        ['extra command property', { operationId: 'extra', command: { type: 'releaseFreeze', payload: true } }],
        ['entries must be an array', { operationId: 'bad-array', command: { type: 'addEntries', entries: {}, selectCurrent: true } }],
        ['entry has extra property', { operationId: 'extra-entry', command: { type: 'addEntries', entries: [
          { name: 'Invalid', songNumber: '1', songNumber2: '', table: '1', status: 'done' }
        ], selectCurrent: true } }],
        ['non-integral position', { operationId: 'bad-position', command: { type: 'moveTurn', id: 'id', targetPosition: 1.5 } }],
        ['invalid operation id', { operationId: {}, command: { type: 'releaseFreeze' } }]
      ]
      const outcomes = []
      for (const [label, request] of invalidPayloads) {
        try {
          await window.karaokeManagement.command(request)
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
      'every malformed Management command DTO must be rejected before application dispatch')
    assert.deepEqual(after, before, 'rejecting invalid payloads must preserve all SQLite rows')

    const beforeRendererReload = await page.evaluate(() => window.karaokeManagement.getSnapshot())
    await page.reload()
    await page.waitForFunction(() => !!window.__kqueue && !!window.karaokeManagement)
    if (await page.locator('#startup-modal').isVisible()) {
      await page.locator('#btn-startup-primary').click()
    }
    const afterRendererReload = await page.evaluate(() => window.karaokeManagement.getSnapshot())
    assert.equal(afterRendererReload.hostEpoch, beforeRendererReload.hostEpoch,
      'Renderer reload reattaches to the existing Main host')
    assert.equal(afterRendererReload.revision, beforeRendererReload.revision,
      'Renderer reload does not repeat session repairs or initialization writes')
    assert.deepEqual(readPersistedState(), after,
      'Renderer reload preserves the confirmed operational state and session count')

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
