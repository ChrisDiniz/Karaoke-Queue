'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const appPackage = require('../package.json')
const expectedVersion = appPackage.version
const executable = path.resolve(process.argv[2] || 'dist/win-unpacked/Karaoke Queue.exe')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-queue-packaged-windows-'))
const userDataDirectory = path.join(tempRoot, 'user-data')
let application

async function launch() {
  application = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDirectory}`],
    cwd: path.dirname(executable),
    timeout: 60000
  })
  const page = await application.firstWindow()
  await page.waitForFunction(() => !!window.__kqueue && !!window.karaokeDatabase && !!window.karaokeLicense,
    undefined, { timeout: 30000 })
  const primary = page.locator('#btn-startup-primary')
  if (await primary.isVisible()) await primary.click()
  return page
}

async function close() {
  if (!application) return
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await application.close().catch(() => {})
  application = undefined
}

function inspectDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return {
      entries: db.prepare('SELECT id, name, status, session_id FROM entries ORDER BY queue_order').all(),
      state: db.prepare('SELECT current_session_id, queue_order_policy_version FROM app_state WHERE singleton = 1').get()
    }
  } finally { db.close() }
}

async function run() {
  try {
    assert.ok(fs.existsSync(executable), `packaged executable not found: ${executable}`)
    let page = await launch()
    const appInfo = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      executablePath: app.getPath('exe'),
      version: app.getVersion(),
      userData: app.getPath('userData')
    }))
    assert.equal(appInfo.packaged, true)
    assert.equal(appInfo.name, appPackage.name, 'Electron app.getName() uses the technical package name')
    assert.equal(path.basename(appInfo.executablePath), `${appPackage.build.productName}.exe`,
      'the packaged executable keeps the commercial product name')
    assert.equal(appInfo.version, expectedVersion)
    assert.ok(path.resolve(appInfo.userData).startsWith(path.resolve(tempRoot)))

    const firstTrial = await page.evaluate(() => window.karaokeLicense.getStatus())
    assert.equal(firstTrial.activated, false)
    assert.equal(firstTrial.expired, false)
    assert.ok(firstTrial.remainingMs > 14 * 24 * 60 * 60 * 1000)
    const licensePath = path.join(appInfo.userData, 'license-state.json')
    const firstTrialRecord = JSON.parse(fs.readFileSync(licensePath, 'utf8'))

    await page.locator('#input-table').fill('81')
    await page.locator('#input-name').fill('Packaged Windows smoke')
    await page.locator('#input-song').fill('810081')
    await page.locator('#form-entry button[type=submit]').click()
    await page.waitForFunction(() => window.__kqueue.queueLength() === 1)
    await page.evaluate(() => window.__kqueue.flushState())
    const databasePath = path.join(appInfo.userData, 'karaoke.sqlite')
    const beforeRestart = inspectDatabase(databasePath)
    assert.equal(beforeRestart.entries.filter(row => row.name === 'Packaged Windows smoke' && row.status === 'pending').length, 1)
    assert.ok(beforeRestart.state.current_session_id)
    assert.equal(beforeRestart.state.queue_order_policy_version, 2)

    await close()
    page = await launch()
    const restored = await page.evaluate(() => window.karaokeDatabase.load())
    assert.equal(restored.queue.filter(entry => entry.name === 'Packaged Windows smoke' && entry.status === 'pending').length, 1)
    assert.deepEqual(inspectDatabase(databasePath), beforeRestart)
    const secondTrial = await page.evaluate(() => window.karaokeLicense.getStatus())
    const secondTrialRecord = JSON.parse(fs.readFileSync(licensePath, 'utf8'))
    assert.equal(secondTrial.activated, false)
    assert.equal(secondTrialRecord.trialStartedAt, firstTrialRecord.trialStartedAt)
    assert.equal(secondTrialRecord.policyVersion, 1)

    console.log(JSON.stringify({
      result: 'PASS', appInfo, firstRunTrial: firstTrial, trialTimestampPersisted: true,
      sqliteIpcWriteRead: true, restartPersistence: true, profilePreserved: true
    }, null, 2))
  } finally {
    await close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
