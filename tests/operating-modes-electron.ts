// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')
const { createKaraokeDatabase } = require('../database')

const projectRoot = path.resolve(__dirname, '../..')
const electronPath = require('electron')
const configuredTempRoot = process.env.KARAOKE_TEST_TEMP_ROOT
const tempRoot = configuredTempRoot
  ? path.resolve(configuredTempRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-operating-modes-'))
if (configuredTempRoot) {
  if (fs.existsSync(tempRoot)) throw new Error('The requested isolated test root already exists: ' + tempRoot)
  fs.mkdirSync(tempRoot, { recursive: false })
}
process.stdout.write('TEST_PROFILE_RUN ' + path.basename(tempRoot) + '\n')

function makeProfile(name) {
  const root = path.join(tempRoot, name)
  const userData = path.join(root, 'user-data')
  return {
    root,
    userData,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_DATA_HOME: path.join(root, 'data')
    }
  }
}

function writeMode(profile, mode) {
  fs.mkdirSync(profile.userData, { recursive: true })
  fs.writeFileSync(path.join(profile.userData, 'operating-mode.json'), JSON.stringify({ version: 1, mode }))
}

function launch(profile) {
  return electron.launch({
    executablePath: electronPath,
    args: [projectRoot, `--user-data-dir=${profile.userData}`],
    env: profile.env,
    timeout: 30000
  })
}

function readLogRecords(profile) {
  const logPath = path.join(profile.userData, 'logs', 'app.log')
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
}

async function waitForLogRecord(profile, event, timeoutMs = 15000, previousRunId) {
  const found = () => readLogRecords(profile).find(record => record.event === event &&
    (!previousRunId || record.runId !== previousRunId))
  const existing = found()
  if (existing) return existing

  const logDirectory = path.join(profile.userData, 'logs')
  await fs.promises.mkdir(logDirectory, { recursive: true })
  return new Promise((resolve, reject) => {
    let watcher
    const finish = (error, record) => {
      clearTimeout(timer)
      watcher?.close()
      if (error) reject(error)
      else resolve(record)
    }
    const check = () => {
      const record = found()
      if (record) finish(undefined, record)
    }
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${event} in the isolated profile log`)), timeoutMs)
    watcher = fs.watch(logDirectory, check)
    check()
  })
}

async function firstPage(app) {
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.__kqueue)
  return page
}

async function startSession(page) {
  if (await page.locator('#startup-modal').isVisible()) {
    await page.locator('#btn-startup-primary').click()
    await page.locator('#startup-modal').waitFor({ state: 'hidden' })
  }
}

async function addEntry(page, name, table) {
  await page.locator('#input-table').fill(table)
  await page.locator('#input-name').fill(name)
  await page.locator('#input-song').fill(`MODE-${table}`)
  await page.locator('#form-entry button[type="submit"]').click()
  await page.waitForFunction(() => window.__kqueue.queueLength() > 0)
  await page.evaluate(() => window.__kqueue.flushState())
}

function readOperationalState(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return {
      appState: database.prepare('SELECT * FROM app_state ORDER BY singleton').all(),
      entries: database.prepare('SELECT * FROM entries ORDER BY id').all(),
      sessions: database.prepare('SELECT * FROM sessions ORDER BY session_order').all()
    }
  } finally { database.close() }
}

async function forceClose(app, terminateModalProcess = false) {
  if (!app) return
  if (terminateModalProcess) {
    // The fatal native error dialog is synchronous and can block Main-process
    // evaluation. This is safe only for the isolated invalid-config profile.
    try { app.process().kill('SIGTERM') } catch {}
    await app.close().catch(() => {})
    return
  }
  try {
    const pages = app.context().pages()
    if (pages.length > 0) {
      await pages[0].waitForFunction(() => !!window.__kqueue)
      await closeLeavingSessionOpen(app)
      return
    }
    await app.close()
    return
  } catch {
    try { app.process().kill('SIGTERM') } catch {}
    await app.close().catch(() => {})
  }
}

async function closeLeavingSessionOpen(app) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  const closed = page.waitForEvent('close', { timeout: 15000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
  await app.close()
}

async function runControllerDefaultAndRecovery() {
  const profile = makeProfile('controller-default-recovery')
  fs.mkdirSync(profile.userData, { recursive: true })
  const legacyDatabase = createKaraokeDatabase(profile.userData)
  legacyDatabase.close()
  let app
  try {
    app = await launch(profile)
    const ready = await waitForLogRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'controller', 'missing configuration must retain legacy Controller behavior')
    assert.equal(ready.details.controllerServicesInitialized, true)
    assert.equal(ready.details.playerServicesImplemented, false,
      'Controller-only mode must not initialize Player playback')
    assert.equal(ready.details.operationalDatabaseInitialized, true)

    const page = await firstPage(app)
    await startSession(page)
    await addEntry(page, 'Controller recovered', '71')
    const databasePath = path.join(profile.userData, 'karaoke.sqlite')
    const beforeRestart = readOperationalState(databasePath)
    assert.equal(beforeRestart.entries.length, 1)
    assert.equal(beforeRestart.sessions.length, 1)
    const previousRunId = ready.runId
    await closeLeavingSessionOpen(app)
    app = undefined

    app = await launch(profile)
    const restartedReady = await waitForLogRecord(profile, 'APP_READY', 15000, previousRunId)
    assert.equal(restartedReady.details.mode, 'controller')
    const recoveredPage = await firstPage(app)
    assert.deepEqual(readOperationalState(databasePath), beforeRestart)
    assert.equal(await recoveredPage.evaluate(() => window.__kqueue.queueLength()), 1,
      'the active Controller queue must recover from SQLite after restart')
    assert.equal(await recoveredPage.locator('#startup-modal').isVisible(), true,
      'the existing active session must be offered after restart')
    await closeLeavingSessionOpen(app)
    app = undefined
  } finally { await forceClose(app) }
}

async function runPlayerWithoutControllerState() {
  const profile = makeProfile('player-only')
  writeMode(profile, 'player')
  let app
  try {
    app = await launch(profile)
    const ready = await waitForLogRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'player')
    assert.equal(ready.details.controllerServicesInitialized, false)
    assert.equal(ready.details.operationalDatabaseInitialized, false)
    assert.equal(ready.details.catalogServiceInitialized, true,
      'Player-only mode must initialize an optional catalog without opening Controller persistence')
    assert.equal(ready.details.playerServicesImplemented, true,
      'Player-only mode must initialize the playback service without Controller persistence')
    assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.isReady()), true)
    const playerWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.webContents.getURL()))
    assert.equal(playerWindows.some(url => url.includes('player-control.html')), true,
      'Player-only mode must open the approved local control interface')
    assert.equal(playerWindows.some(url => url.endsWith('/index.html')), false,
      'Player-only mode must not create the Controller window')
    assert.equal(playerWindows.some(url => url.includes('player-playback.html')), false,
      'Player-only startup must not show the independent video window before an explicit operator action')
    assert.equal(playerWindows.length, 1, 'A clean Player-only launch must show only its control window.')
    const playerPage = await app.firstWindow()
    await playerPage.waitForFunction(() => !!window.karaokePlayer?.getSnapshot)
    await playerPage.waitForFunction(async () => {
      const state = await window.karaokePlayer.getSnapshot()
      return state.videoWindow.location === 'inline' && state.videoWindow.ready
    })
    const initialPlayerSnapshot = await playerPage.evaluate(() => window.karaokePlayer.getSnapshot())
    assert.equal(initialPlayerSnapshot.videoWindow.open, true,
      'Player-only startup must initialize the embedded playback surface.')
    assert.equal(initialPlayerSnapshot.videoWindow.location, 'inline',
      'Player-only startup must keep playback embedded instead of opening a detached window.')
    assert.equal(initialPlayerSnapshot.playback.status, 'idle', 'Player startup must not start or resume a song.')
    assert.equal(fs.existsSync(path.join(profile.userData, 'karaoke.sqlite')), false,
      'Player-only mode must not create operational Controller SQLite state')
    const playerCatalogPath = path.join(profile.userData, 'player-music-catalog.sqlite')
    assert.equal(fs.existsSync(playerCatalogPath), true, 'Player-only mode must persist the optional metadata catalog separately')
    const playerCatalog = new DatabaseSync(playerCatalogPath, { readOnly: true })
    try {
      const tables = playerCatalog.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map(row => row.name)
      assert.deepEqual(tables, ['music_catalog', 'music_catalog_metadata'],
        'the Player catalog database must not contain tables for queues, entries, sessions, or operational history')
    } finally { playerCatalog.close() }
    assert.equal(app.process().exitCode, null, 'Player lifecycle remains alive without a window')
  } finally { await forceClose(app) }
}

async function runCombinedOneControllerDatabaseAndRestart() {
  const profile = makeProfile('combined')
  writeMode(profile, 'combined')
  let app
  try {
    app = await launch(profile)
    const ready = await waitForLogRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'combined')
    assert.equal(ready.details.controllerServicesInitialized, true)
    assert.equal(ready.details.playerServicesImplemented, true,
      'Combined mode must initialize one Player service alongside the Controller')
    assert.equal(ready.details.operationalDatabaseInitialized, true)
    const page = await firstPage(app)
    await startSession(page)
    await addEntry(page, 'Combined mode', '72')

    const databasePath = path.join(profile.userData, 'karaoke.sqlite')
    const sqliteFiles = fs.readdirSync(profile.userData).filter(name => /\.sqlite(?:3)?$/.test(name))
    assert.deepEqual(sqliteFiles, ['karaoke.sqlite'], 'Combined must reuse the one authoritative Controller database')
    const confirmed = readOperationalState(databasePath)
    assert.equal(confirmed.entries.length, 1)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'Phase 2 must not create an unapproved additional Player window')
    const previousRunId = ready.runId
    await closeLeavingSessionOpen(app)
    app = undefined

    app = await launch(profile)
    const restarted = await waitForLogRecord(profile, 'APP_READY', 15000, previousRunId)
    assert.equal(restarted.details.mode, 'combined', 'the configured mode must survive an application restart')
    assert.deepEqual(readOperationalState(databasePath), confirmed)
    const restartedPage = await firstPage(app)
    assert.equal(await restartedPage.evaluate(() => window.__kqueue.queueLength()), 1,
      'the Combined Controller queue must recover before shutdown')
  } finally { await forceClose(app) }
}

async function runInvalidConfigurationPreservesDatabase() {
  const profile = makeProfile('invalid-configuration')
  fs.mkdirSync(profile.userData, { recursive: true })
  fs.writeFileSync(path.join(profile.userData, 'operating-mode.json'), '{"version":1,"mode":"unknown"}')

  // Seed a real schema using the production database initializer, then compare
  // its bytes around the rejected application startup. No operational fixture
  // or real user profile is involved.
  const seeded = createKaraokeDatabase(profile.userData)
  seeded.close()
  const databasePath = path.join(profile.userData, 'karaoke.sqlite')
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex')
  let child
  try {
    const electronArgs = [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--disable-gpu',
      projectRoot,
      `--user-data-dir=${profile.userData}`
    ]
    child = spawn(electronPath, electronArgs, {
      env: profile.env,
      stdio: 'ignore',
      detached: process.platform !== 'win32'
    })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    const rejected = await waitForLogRecord(profile, 'OPERATING_MODE_CONFIGURATION_INVALID')
    assert.equal(rejected.level, 'FATAL')
    assert.equal(readLogRecords(profile).some(record => record.event === 'APP_READY'), false,
      'invalid configuration must stop before any mode becomes operational')
    const afterHash = crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex')
    assert.equal(afterHash, beforeHash, 'invalid configuration must not open, migrate, or mutate existing operational SQLite data')
    assert.deepEqual(readOperationalState(databasePath), { appState: [], entries: [], sessions: [] })
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        })
        if (result.status !== 0) child.kill('SIGTERM')
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
      await exited
    }
  }
}

async function run() {
  try {
    await runControllerDefaultAndRecovery()
    process.stdout.write('OPERATING_MODE PASS Controller default and SQLite session recovery\n')
    await runPlayerWithoutControllerState()
    process.stdout.write('OPERATING_MODE PASS Player-only embedded startup without Controller persistence\n')
    await runCombinedOneControllerDatabaseAndRestart()
    process.stdout.write('OPERATING_MODE PASS Combined lifecycle, single Controller database and restart persistence\n')
    await runInvalidConfigurationPreservesDatabase()
    process.stdout.write('OPERATING_MODE PASS invalid configuration preserves existing SQLite data\n')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
