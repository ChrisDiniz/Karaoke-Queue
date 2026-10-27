// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-license-e2e-'))
const validToken = 'YU3ZYVR88H4DRH2KLW43'
const dayMs = 24 * 60 * 60 * 1000

async function launch(profile) {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.resolve(__dirname, '../..'), `--user-data-dir=${profile}`],
    env: { ...process.env, XDG_CONFIG_HOME: path.join(profile, 'config'),
      XDG_CACHE_HOME: path.join(profile, 'cache'), XDG_DATA_HOME: path.join(profile, 'data') },
    timeout: 30000
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.__kqueue && !!window.karaokeLicense)
  if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
  return { app, page }
}

async function close(app) {
  if (!app) return
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app.close().catch(() => {})
}

function readDatabase(profile) {
  const db = new DatabaseSync(path.join(profile, 'karaoke.sqlite'), { readOnly: true })
  try {
    return {
      state: db.prepare('SELECT current_session_id, current_turn_id FROM app_state WHERE singleton = 1').get(),
      sessions: db.prepare('SELECT id, started_at, ended_at FROM sessions ORDER BY session_order').all().map(row => ({ ...row })),
      entries: db.prepare('SELECT id, name, status, session_id FROM entries ORDER BY queue_order').all().map(row => ({ ...row }))
    }
  } finally { db.close() }
}

async function run() {
  const screenshots = path.join(root, 'screenshots')
  fs.mkdirSync(screenshots, { recursive: true })
  const activeProfile = path.join(root, 'profile-active')
  fs.mkdirSync(activeProfile, { recursive: true })
  let app
  try {
    let launched = await launch(activeProfile)
    app = launched.app
    let page = launched.page
    await page.locator('#license-trial-controls').waitFor({ state: 'visible' })
    assert.match(await page.locator('#license-trial-label').textContent(), /Teste · 15 dias restantes/)
    const before = await page.evaluate(() => ({
      header: document.querySelector('.app-header').getBoundingClientRect().height,
      bell: document.querySelector('#btn-notifications').getBoundingClientRect().toJSON(),
      formTop: document.querySelector('.form-section').getBoundingClientRect().top
    }))
    assert.equal(before.header, 40)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(960, 600))
    const narrowHeader = await page.evaluate(() => ({
      header: document.querySelector('.app-header').getBoundingClientRect(),
      controls: document.querySelector('#license-trial-controls').getBoundingClientRect(),
      bell: document.querySelector('#btn-notifications').getBoundingClientRect()
    }))
    assert.equal(narrowHeader.header.height, 40)
    assert.ok(narrowHeader.controls.left >= narrowHeader.header.left)
    assert.ok(narrowHeader.controls.right < narrowHeader.bell.left, 'trial controls do not overlap notifications at minimum window width')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
    await page.screenshot({ path: path.join(screenshots, 'trial-active.png') })
    await page.locator('#btn-license-open').click()
    await page.locator('#license-modal').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#license-lock-message').isVisible(), false)
    await page.screenshot({ path: path.join(screenshots, 'activation-modal.png') })
    await page.locator('#license-code').fill('karaokequeue')
    await page.locator('#license-form button[type="submit"]').click()
    assert.equal(await page.locator('#license-error').textContent(), 'Token de ativação inválido.')
    assert.equal(await page.locator('#license-modal').isVisible(), true)
    await page.locator('#license-code').fill('A'.repeat(20))
    await page.locator('#license-form button[type="submit"]').click()
    assert.equal(await page.locator('#license-error').textContent(), 'Token de ativação inválido.')
    await page.locator('#license-code').fill(`  ${validToken.toLowerCase()}  `)
    await page.locator('#license-form button[type="submit"]').click()
    await page.locator('#license-trial-controls').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('#license-modal').isVisible(), false)
    const after = await page.evaluate(() => ({
      header: document.querySelector('.app-header').getBoundingClientRect().height,
      bell: document.querySelector('#btn-notifications').getBoundingClientRect().toJSON(),
      formTop: document.querySelector('.form-section').getBoundingClientRect().top
    }))
    assert.equal(after.header, before.header)
    assert.equal(after.formTop, before.formTop)
    assert.deepEqual(after.bell, before.bell)
    const licenseFile = path.join(activeProfile, 'license-state.json')
    assert.equal(JSON.parse(fs.readFileSync(licenseFile, 'utf8')).activated, true)
    await close(app)
    app = undefined
    launched = await launch(activeProfile)
    app = launched.app
    page = launched.page
    assert.equal(await page.locator('#license-trial-controls').isVisible(), false, 'activation persists after restart')
    await close(app)
    app = undefined

    const expiredProfile = path.join(root, 'profile-expired')
    fs.mkdirSync(expiredProfile, { recursive: true })
    launched = await launch(expiredProfile)
    app = launched.app
    page = launched.page
    await page.locator('#input-table').fill('8')
    await page.locator('#input-name').fill('Fila preservada')
    await page.locator('#input-song').fill('808')
    await page.locator('#form-entry button[type="submit"]').click()
    await page.evaluate(() => window.__kqueue.flushState())
    await close(app)
    app = undefined
    const expiredLicensePath = path.join(expiredProfile, 'license-state.json')
    const expiredLicense = JSON.parse(fs.readFileSync(expiredLicensePath, 'utf8'))
    expiredLicense.trialStartedAt = Date.now() - 15 * dayMs
    fs.writeFileSync(expiredLicensePath, JSON.stringify(expiredLicense))

    const beforeExpired = readDatabase(expiredProfile)
    launched = await launch(expiredProfile)
    app = launched.app
    page = launched.page
    await page.locator('#license-modal').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#license-lock-message').isVisible(), true)
    assert.match(await page.locator('#license-trial-label').textContent(), /Teste expirado/)
    await page.screenshot({ path: path.join(screenshots, 'trial-expired.png') })
    const visibleData = await page.evaluate(() => window.karaokeDatabase.load())
    assert.ok(visibleData.queue.some(entry => entry.name === 'Fila preservada'), 'expired users can still read their queue')
    await assert.rejects(page.evaluate(state => window.karaokeDatabase.save({ ...state, queue: [] }), visibleData), /LICENSE_EXPIRED/)
    assert.deepEqual(readDatabase(expiredProfile), beforeExpired, 'blocked save leaves SQLite sessions and entries intact')

    const closedWithoutEnding = await app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
      const window = BrowserWindow.getAllWindows()[0]
      const timeout = setTimeout(() => resolve(false), 5000)
      window.once('closed', () => { clearTimeout(timeout); resolve(true) })
      window.close()
    }))
    assert.equal(closedWithoutEnding, true, 'expired app can exit without ending its open session')
    await close(app)
    app = undefined
    assert.deepEqual(readDatabase(expiredProfile), beforeExpired, 'closing the expired app preserves the active session and queue')
    launched = await launch(expiredProfile)
    app = launched.app
    page = launched.page
    await page.locator('#license-modal').waitFor({ state: 'visible' })

    await page.locator('#license-code').fill(validToken)
    await page.locator('#license-form button[type="submit"]').click()
    assert.equal(await page.locator('#license-modal').isVisible(), false)
    assert.equal(await page.locator('#license-trial-controls').isVisible(), false)
    assert.deepEqual(readDatabase(expiredProfile), beforeExpired, 'activation does not change karaoke data')
    await close(app)
    app = undefined
    launched = await launch(expiredProfile)
    app = launched.app
    page = launched.page
    assert.equal(await page.locator('#license-modal').isVisible(), false)
    assert.equal(await page.locator('#license-trial-controls').isVisible(), false)
    console.log(`PASS Electron + SQLite IPC licensing: 15-day display, invalid/old token, activation persistence, exact expiry lock, rejected operational write, preserved session/data and unlock. Screenshots: ${screenshots}`)
  } finally {
    await close(app)
  }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
