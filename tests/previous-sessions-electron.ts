// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-previous-sessions-'))
const userDataDir = path.join(profileRoot, 'profile')
const screenshotDir = path.join(os.tmpdir(), `karaoke-previous-sessions-shots-${Date.now()}`)
fs.mkdirSync(screenshotDir, { recursive: true })

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
  const open = async instance => {
    const page = await instance.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue)
    if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
    return page
  }
  const add = async (page, name, table, song) => {
    await page.locator('#input-name').fill(name)
    await page.locator('#input-song').fill(song)
    await page.locator('#input-table').fill(table)
    await page.locator('#form-entry button[type="submit"]').click()
  }
  const close = async () => {
    if (!app) return
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
    await app.close().catch(() => {})
    app = undefined
  }

  try {
    app = await launch()
    let page = await open(app)
    await add(page, 'Cantora histórica', '12', '4321')
    await page.locator('#now-block .btn-done-lg').click()
    await page.locator('#now-block').waitFor({ state: 'hidden' })
    await page.evaluate(() => window.__kqueue.flushState())
    const userDataPath = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    assert.ok(path.resolve(userDataPath).startsWith(path.resolve(profileRoot)))
    const databasePath = path.join(userDataPath, 'karaoke.sqlite')
    const beforeRestart = new DatabaseSync(databasePath, { readOnly: true })
    const oldSessionId = beforeRestart.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id
    assert.equal(beforeRestart.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(oldSessionId).ended_at, null)
    beforeRestart.close()
    await close()

    // Give the persisted session a deterministic overnight interval without
    // changing the host clock. This remains inside the isolated SQLite profile.
    const seed = new DatabaseSync(databasePath)
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const started = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 22, 10).getTime()
    const today = new Date()
    const ended = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 4, 25).getTime()
    seed.prepare('UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?').run(started, ended, oldSessionId)
    seed.prepare('UPDATE entries SET inserted_at = ?, done_at = ? WHERE session_id = ? AND status = ?')
      .run(started + 20 * 60_000, started + 35 * 60_000, oldSessionId, 'done')
    seed.close()

    app = await launch()
    page = await app.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue)
    assert.equal(await page.locator('#startup-modal').isVisible(), false,
      'an ended session is replaced by a fresh session without another prompt')
    const recoveredSessionDb = new DatabaseSync(databasePath, { readOnly: true })
    const recoveredSessionId = recoveredSessionDb.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id
    assert.notEqual(recoveredSessionId, oldSessionId)
    recoveredSessionDb.close()
    await add(page, 'Pendente atual', '3', '7654')
    const currentDbPath = path.join(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')), 'karaoke.sqlite')
    await page.evaluate(() => window.__kqueue.flushState())
    const activeSessionBeforeRestart = new DatabaseSync(currentDbPath, { readOnly: true })
      .prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id
    await close()
    app = await launch()
    page = await app.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue)
    let pendingWarningText = ''
    page.once('dialog', async dialog => {
      pendingWarningText = dialog.message()
      await dialog.dismiss()
    })
    await page.locator('#btn-startup-secondary').click()
    assert.match(pendingWarningText, /removerá 1 apresentação pendente/)
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 1, 'canceling new-session confirmation preserves the pending turn')
    await page.locator('#btn-startup-primary').click()
    const afterCancelDb = new DatabaseSync(currentDbPath, { readOnly: true })
    assert.equal(afterCancelDb.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id,
      activeSessionBeforeRestart)
    afterCancelDb.close()

    // Expanded navigation exposes the enabled previous-session destination.
    await page.locator('#btn-sidebar-toggle').click()
    await page.locator('#nav-history .sidebar-label').click()
    await page.locator('#nav-previous-sessions').click()
    await page.locator('#previous-sessions-page').waitFor({ state: 'visible' })
    const previousDate = new Date(started).toLocaleDateString('en-CA')
    const currentDate = new Date(ended).toLocaleDateString('en-CA')
    const datePicker = page.locator('#previous-sessions-date')
    await datePicker.fill(currentDate)
    const card = page.locator('.previous-session-card').first()
    await card.waitFor({ state: 'visible' })
    assert.match(await card.innerText(), /Encerrada/)
    await datePicker.fill(previousDate)
    await card.waitFor({ state: 'visible' })
    await datePicker.fill('2030-01-01')
    await page.locator('.previous-session-card').waitFor({ state: 'hidden' })
    await page.locator('#btn-clear-previous-date').click()
    await page.evaluate(() => document.querySelector('#toast')?.classList.add('hidden'))
    await page.screenshot({ path: path.join(screenshotDir, 'lista-sessoes.png'), fullPage: true })
    await card.click()

    await page.locator('#history-panel').waitFor({ state: 'visible' })
    assert.match(await page.locator('#session-page-title').innerText(), /Sessão de/)
    assert.match(await page.locator('#session-start-info').innerText(), /→/)
    assert.equal(await page.locator('#history-stat-songs').innerText(), '1')
    assert.equal(await page.locator('#history-list .history-card').count(), 1)
    await page.screenshot({ path: path.join(screenshotDir, 'detalhes-sessao.png'), fullPage: true })
    await page.locator('#history-list .history-view-table').click()
    await page.locator('#table-modal').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#btn-reset-table').isVisible(), false, 'historical table details are read-only')
    await page.screenshot({ path: path.join(screenshotDir, 'detalhes-mesa-somente-leitura.png'), fullPage: true })
    await page.locator('#btn-close-table-modal').click()
    await page.locator('#btn-back-previous-sessions').click()
    await page.locator('#previous-sessions-page').waitFor({ state: 'visible' })

    const verify = new DatabaseSync(currentDbPath, { readOnly: true })
    const state = verify.prepare('SELECT current_session_id, current_turn_id FROM app_state WHERE singleton = 1').get()
    const currentPending = verify.prepare("SELECT COUNT(*) AS total FROM entries WHERE session_id = ? AND status = 'pending'").get(state.current_session_id).total
    const oldDone = verify.prepare("SELECT COUNT(*) AS total FROM entries WHERE session_id = ? AND status = 'done'").get(oldSessionId).total
    assert.equal(currentPending, 1, 'reading prior sessions does not change the active queue')
    assert.equal(oldDone, 1)
    verify.close()

    await close()
    app = await launch()
    page = await open(app)
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 1, 'current queue is recovered after restart')
    await page.locator('#btn-sidebar-toggle').click()
    await page.locator('#nav-history .sidebar-label').click()
    await page.locator('#nav-previous-sessions').click()
    await page.locator('.previous-session-card').waitFor({ state: 'visible' })
    console.log(`Screenshots: ${screenshotDir}`)
    console.log('PASS: Electron real + SQLite IPC — sessão explícita, filtro overnight, detalhes somente leitura e recuperação após reiniciar')
  } finally {
    await close()
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
