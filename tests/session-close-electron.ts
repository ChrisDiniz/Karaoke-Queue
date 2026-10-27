// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-session-close-'))
const userDataDir = path.join(profileRoot, 'profile')

async function run() {
  let app
  const launch = () => electron.launch({
    executablePath: require('electron'),
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(profileRoot, 'config'),
      XDG_CACHE_HOME: path.join(profileRoot, 'cache'),
      XDG_DATA_HOME: path.join(profileRoot, 'data')
    },
    timeout: 30000
  })
  const pageOf = async instance => {
    const page = await instance.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue)
    return page
  }
  const setCloseResponses = async (responses) => app.evaluate((_electron, values) => {
    globalThis.__kqueueCloseResponses = values
  }, responses)
  const installDialogStub = async () => app.evaluate(({ dialog }) => {
    globalThis.__kqueueCloseResponses = []
    globalThis.__kqueueCloseDialogCalls = []
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__kqueueCloseDialogCalls.push(options)
      const response = globalThis.__kqueueCloseResponses.shift()
      return { response: response === undefined ? 2 : response }
    }
  })
  const closeWindow = async () => {
    const page = await app.firstWindow()
    const closed = page.waitForEvent('close', { timeout: 8000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
    await app.close().catch(() => {})
    app = undefined
  }
  const forceExit = async () => {
    if (!app) return
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
    await app.close().catch(() => {})
    app = undefined
  }
  const databasePath = () => path.join(userDataDir, 'karaoke.sqlite')
  const readDb = callback => {
    const db = new DatabaseSync(databasePath(), { readOnly: true })
    try { return callback(db) } finally { db.close() }
  }

  try {
    app = await launch()
    let page = await pageOf(app)
    if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
    await installDialogStub()
    const initial = readDb(db => db.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id)

    await page.locator('#input-name').fill('Cantora pendente')
    await page.locator('#input-song').fill('1234')
    await page.locator('#input-table').fill('4')
    await page.locator('#form-entry button[type="submit"]').click()
    await page.waitForFunction(() => window.__kqueue.queueLength() === 1)

    // C: cancel close. It must neither persist an end time nor change session state.
    await setCloseResponses([2])
    // Trigger the BrowserWindow close event, rather than browser-side window.close.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await page.waitForTimeout(200)
    assert.equal(await page.locator('#now-block').isVisible(), true)
    assert.equal(readDb(db => db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(initial).ended_at), null)
    assert.equal(readDb(db => db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND status = 'pending'").get(initial).n), 1)

    // A with active work: the second confirmation is canceled; the session stays untouched.
    await setCloseResponses([0, 1])
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await page.waitForTimeout(200)
    const closeCalls = await app.evaluate(() => globalThis.__kqueueCloseDialogCalls)
    assert.equal(closeCalls.length, 3) // initial close cancel plus two prompts for A
    assert.match(closeCalls[2].message, /1 apresentação não concluída/)
    assert.equal(readDb(db => db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(initial).ended_at), null)
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 1)

    // A confirmed with pending work: archive it and close; next launch is prompt-free.
    await setCloseResponses([0, 0])
    await closeWindow()
    const closedRunRecords = fs.readFileSync(path.join(userDataDir, 'logs', 'app.log'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    assert.ok(closedRunRecords.some(record => record.event === 'SESSION_CLOSE_REQUESTED' && record.details.sessionId === initial))
    assert.ok(closedRunRecords.some(record => record.event === 'SESSION_ENDED' && record.details.sessionId === initial))
    assert.ok(closedRunRecords.some(record => record.event === 'SESSION_PERSISTED' && record.details.sessionId === initial))
    assert.ok(closedRunRecords.some(record => record.event === 'APP_EXIT_NORMAL'))
    assert.ok(readDb(db => db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(initial).ended_at))
    assert.equal(readDb(db => db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND status = 'pending'").get(initial).n), 1)
    app = await launch()
    page = await pageOf(app)
    assert.equal(await page.locator('#startup-modal').isVisible(), false)
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 0)
    const resumedSession = readDb(db => db.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id)
    assert.notEqual(resumedSession, initial)
    await installDialogStub()

    await page.locator('#input-name').fill('Cantor da sessão retomada')
    await page.locator('#input-song').fill('5678')
    await page.locator('#input-table').fill('5')
    await page.locator('#form-entry button[type="submit"]').click()
    await page.waitForFunction(() => window.__kqueue.queueLength() === 1)

    // B: leave the new session open and persist, then verify startup offers continue/new.
    await setCloseResponses([1])
    await closeWindow()
    assert.equal(readDb(db => db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(resumedSession).ended_at), null)
    assert.equal(readDb(db => db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND status = 'pending'").get(resumedSession).n), 1)

    app = await launch()
    page = await pageOf(app)
    assert.equal(await page.locator('#startup-modal').isVisible(), true)
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 1)
    await page.locator('#btn-startup-primary').click()
    await forceExit() // crash/forced process exit must leave ended_at null

    app = await launch()
    page = await pageOf(app)
    assert.equal(await page.locator('#startup-modal').isVisible(), true)
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 1)
    await installDialogStub()

    // Cancel the explicit new-session confirmation: no state transition occurs.
    const beforeCancelSession = await page.evaluate(() => window.__kqueue.closeSummary())
    await page.evaluate(() => { window.confirm = () => false })
    await page.locator('#btn-startup-secondary').click()
    await page.waitForTimeout(100)
    assert.deepEqual(await page.evaluate(() => window.__kqueue.closeSummary()), beforeCancelSession)
    assert.equal(readDb(db => db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(resumedSession).ended_at), null)

    // Explicitly start a new session after confirmation; old pending entry remains archived.
    await page.evaluate(() => { window.confirm = () => true })
    await page.locator('#btn-startup-secondary').click()
    await page.locator('#startup-modal').waitFor({ state: 'hidden' })
    const newSessionId = readDb(db => db.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id)
    assert.notEqual(newSessionId, resumedSession)
    const transition = readDb(db => ({
      old: db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(resumedSession),
      current: db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(newSessionId),
      oldPending: db.prepare("SELECT status, session_id, queue_order FROM entries WHERE session_id = ? AND status = 'pending'").all(resumedSession),
      activePending: db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND status = 'pending'").get(newSessionId).n,
      activeState: db.prepare('SELECT current_turn_id, frozen_turn_ids_json, fixed_turn_positions_json, regulars_since_debut FROM app_state WHERE singleton = 1').get()
    }))
    assert.ok(transition.old.ended_at)
    assert.equal(transition.current.ended_at, null)
    assert.equal(transition.oldPending.length, 1)
    assert.equal(transition.oldPending[0].status, 'pending')
    assert.equal(transition.oldPending[0].session_id, resumedSession)
    assert.equal(transition.activePending, 0)
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 0)
    assert.equal(transition.activeState.current_turn_id, null)
    assert.equal(transition.activeState.frozen_turn_ids_json, '[]')
    assert.equal(transition.activeState.fixed_turn_positions_json, '{}')
    assert.equal(transition.activeState.regulars_since_debut, 0)

    // A with an empty queue needs only the first confirmation, then restart is prompt-free.
    await setCloseResponses([0])
    await closeWindow()
    assert.ok(readDb(db => db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(newSessionId).ended_at))
    app = await launch()
    page = await pageOf(app)
    assert.equal(await page.locator('#startup-modal').isVisible(), false)
    const freshId = readDb(db => db.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id)
    assert.notEqual(freshId, newSessionId)
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 0)

    console.log('PASS: Electron real + SQLite — cancelar, encerrar, sair sem encerrar, crash recovery, confirmação startup, pendências arquivadas e nova sessão vazia')
  } finally {
    await forceExit()
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
