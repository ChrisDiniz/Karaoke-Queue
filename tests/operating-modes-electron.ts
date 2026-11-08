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
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      projectRoot,
      `--user-data-dir=${profile.userData}`
    ],
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

async function forceClose(app) {
  if (!app) return
  // Player shutdown spans multiple asynchronous Electron quit passes. In test
  // teardown, terminate this isolated process directly instead of asking
  // Playwright to evaluate app.quit while those passes destroy its inspector.
  let child
  try { child = app.process() } catch { return }
  if (!child) return
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    if (process.platform === 'win32') {
      const terminated = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        encoding: 'utf8',
        shell: false
      })
      if (terminated.status !== 0 && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => setImmediate(resolve))
        if (child.exitCode === null && child.signalCode === null) {
          throw new Error(`Could not terminate isolated Electron process tree ${child.pid}: ${terminated.stderr || terminated.stdout || terminated.status}`)
        }
      }
    } else {
      try { child.kill('SIGKILL') } catch {}
    }
    await exited.catch(() => {})
  }
}

async function closeLeavingSessionOpen(app) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  const closed = page.waitForEvent('close', { timeout: 15000 })
  await app.evaluate(({ BrowserWindow, app: electronApp }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      electronApp.__kqueueOriginalQuit = electronApp.quit
      electronApp.quit = () => undefined
    }
  })
  await page.close()
  await closed
  await app.evaluate(({ app: electronApp }) => {
    if (electronApp.__kqueueOriginalQuit) {
      electronApp.quit = electronApp.__kqueueOriginalQuit
      delete electronApp.__kqueueOriginalQuit
    }
  })
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

async function runControllerSettingsModeSwitchPreservesSession() {
  const profile = makeProfile('controller-settings-mode-switch')
  const screenshotRoot = process.env.KQ_PLAYER_SCREENSHOT_DIR
    ? path.resolve(process.env.KQ_PLAYER_SCREENSHOT_DIR) : profile.root
  fs.mkdirSync(screenshotRoot, { recursive: true })
  fs.mkdirSync(profile.userData, { recursive: true })
  const initialized = createKaraokeDatabase(profile.userData)
  initialized.close()
  let app
  try {
    app = await launch(profile)
    const ready = await waitForLogRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'controller')
    const page = await firstPage(app)
    await startSession(page)
    await addEntry(page, 'Mode switch keeps session', '73')

    const databasePath = path.join(profile.userData, 'karaoke.sqlite')
    const beforeState = readOperationalState(databasePath)
    assert.equal(beforeState.sessions.length, 1, 'The mode-switch scenario must retain one active Controller session.')
    assert.equal(beforeState.entries.length, 1, 'The mode-switch scenario must retain a queued presentation.')

    await page.locator('#nav-settings').click()
    await page.locator('#settings-page').waitFor({ state: 'visible' })
    assert.match(await page.locator('.settings-mode-current').textContent(), /Controlador/,
      'Controller settings must identify Controlador as the active mode.')
    assert.equal(await page.locator('#settings-mode-player').isDisabled(), false,
      'Player must be selectable from Controller settings.')
    assert.equal(await page.locator('#settings-mode-combined').isDisabled(), true,
      'Combined must remain unavailable until its integration phase is complete.')
    await page.locator('#toast').waitFor({ state: 'hidden', timeout: 5000 })
    await page.screenshot({ path: path.join(screenshotRoot, 'controller-settings-mode.png') })

    await page.locator('#settings-mode-player').click()
    assert.equal(await page.locator('#settings-mode-change').isDisabled(), false,
      'Selecting Player must enable the explicit mode-change action.')
    await app.evaluate(({ app: electronApp }) => {
      electronApp.relaunch = () => undefined
    })

    const child = app.process()
    const processExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    const scheduledChange = waitForLogRecord(profile, 'OPERATING_MODE_CHANGE_SCHEDULED')
    await page.locator('#settings-mode-change').click()
    let changeRecord
    try {
      changeRecord = await scheduledChange
    } catch (error) {
      const modeStatus = await page.locator('#settings-mode-status').textContent().catch(() => '')
      const ipcFailure = readLogRecords(profile).filter(record => record.event === 'RENDERER_IPC_FAILED' &&
        String(record.message ?? '').includes('settings:operating-mode:change')).at(-1)?.message ?? 'none'
      throw new Error(`${error.message}; Controller mode UI status=${modeStatus}; IPC diagnostic=${ipcFailure}`)
    }
    assert.equal(changeRecord.details.from, 'controller')
    assert.equal(changeRecord.details.to, 'player')
    const exit = await processExit
    assert.equal(exit.code, 0, `The controlled mode switch must exit cleanly; exit=${JSON.stringify(exit)}`)
    await waitForLogRecord(profile, 'OPERATING_MODE_CHANGE_PRESERVED_SESSION')
    await app.close()
    app = undefined

    const modePath = path.join(profile.userData, 'operating-mode.json')
    assert.deepEqual(JSON.parse(fs.readFileSync(modePath, 'utf8')),
      { version: 1, mode: 'player' }, 'The confirmed Controller-to-Player change must persist the selected mode.')
    assert.deepEqual(readOperationalState(databasePath), beforeState,
      'Switching modes must preserve the operational SQLite session, queue, and history state.')

    app = await launch(profile)
    const playerReady = await waitForLogRecord(profile, 'APP_READY', 15000, ready.runId)
    assert.equal(playerReady.details.mode, 'player', 'The same isolated profile must restart in Player mode.')
    assert.equal(playerReady.details.operationalDatabaseInitialized, false,
      'Player startup must preserve but not open the Controller operational database.')
    assert.deepEqual(JSON.parse(fs.readFileSync(modePath, 'utf8')),
      { version: 1, mode: 'player' }, 'Player startup must not overwrite the persisted mode.')
    assert.deepEqual(readOperationalState(databasePath), beforeState,
      'Restarting in Player mode must not mutate the preserved Controller session or queue.')
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
    assert.equal(playerWindows.some(url => url.includes('standalone-player.html')), true,
      'Player-only mode must open the approved Standalone control and playback interface')
    assert.equal(playerWindows.some(url => url.includes('player-control.html')), false,
      'Player-only mode must not start the legacy control shell')
    assert.equal(playerWindows.some(url => url.endsWith('/index.html')), false,
      'Player-only mode must not create the Controller window')
    assert.equal(playerWindows.some(url => url.includes('player-playback.html')), false,
      'Player-only startup must not create a separate playback window')
    assert.equal(playerWindows.length, 1, 'A clean Player-only launch must show one composed Standalone window.')
    const playerPage = await app.firstWindow()
    await playerPage.waitForFunction(() => !!window.standalonePlayer?.getSnapshot)
    const startupState = await playerPage.evaluate(async () => ({
      bridgeKeys: Object.keys(window.standalonePlayer ?? {}).sort(),
      snapshot: await window.standalonePlayer.getSnapshot(),
      stageVisible: Boolean(document.querySelector('#playback-stage')),
      mediaLayerPresent: Boolean(document.querySelector('#playback-media-layer'))
    }))
    assert.ok(startupState.bridgeKeys.includes('execute'),
      'Player-only mode must expose the restricted Standalone bridge')
    assert.equal(startupState.stageVisible, true, 'The composed Standalone window must contain its playback stage.')
    assert.equal(startupState.mediaLayerPresent, true, 'The composed Standalone window must contain its media layer.')
    assert.equal(startupState.snapshot.snapshot.playbackCondition, 'ready',
      'Player startup must begin with an available, confirmed sequence.')
    assert.equal(startupState.snapshot.snapshot.state.operationalState, 'idle',
      'Player startup must not start or resume a song.')
    assert.equal(startupState.snapshot.snapshot.state.current, null,
      'Player startup must not restore a volatile current song.')
    assert.deepEqual(startupState.snapshot.snapshot.state.pending, [],
      'Player startup must not restore a volatile pending sequence.')
    assert.equal(fs.existsSync(path.join(profile.userData, 'karaoke.sqlite')), false,
      'Player-only mode must not create operational Controller SQLite state')
    const playerCatalogPath = path.join(profile.userData, 'player-music-catalog.sqlite')
    assert.equal(fs.existsSync(playerCatalogPath), true, 'Player-only mode must persist the optional metadata catalog separately')
    const playerCatalog = new DatabaseSync(playerCatalogPath, { readOnly: true })
    try {
      const tables = playerCatalog.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map(row => row.name)
      assert.deepEqual(tables, [
        'music_catalog', 'music_catalog_import_issues', 'music_catalog_import_state', 'music_catalog_metadata'
      ],
        'the Player catalog database must not contain tables for queues, entries, sessions, or operational history')
    } finally { playerCatalog.close() }
    assert.equal(app.process().exitCode, null, 'Player lifecycle remains alive in its Standalone window')
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
  let testError
  try {
    await runControllerDefaultAndRecovery()
    process.stdout.write('OPERATING_MODE PASS Controller default and SQLite session recovery\n')
    await runControllerSettingsModeSwitchPreservesSession()
    process.stdout.write('OPERATING_MODE PASS Controller settings switch to Player preserves the active session and queue\n')
    await runPlayerWithoutControllerState()
    process.stdout.write('OPERATING_MODE PASS Player-only embedded startup without Controller persistence\n')
    await runCombinedOneControllerDatabaseAndRestart()
    process.stdout.write('OPERATING_MODE PASS Combined lifecycle, single Controller database and restart persistence\n')
    await runInvalidConfigurationPreservesDatabase()
    process.stdout.write('OPERATING_MODE PASS invalid configuration preserves existing SQLite data\n')
  } catch (error) {
    testError = error
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch (cleanupError) {
      if (!testError) testError = cleanupError
      else testError.message += `; isolated test profile cleanup also failed: ${cleanupError.message}`
    }
  }
  if (testError) throw testError
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
