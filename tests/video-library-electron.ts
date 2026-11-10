// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')
const { writeVideoLibraryConfiguration } = require('../src/video-library-configuration')
const { createKaraokeDatabase } = require('../database')

const projectRoot = path.resolve(__dirname, '../..')
const electronPath = require('electron')
const configuredTempRoot = process.env.KARAOKE_TEST_TEMP_ROOT
const tempRoot = configuredTempRoot
  ? path.resolve(configuredTempRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-video-library-e2e-'))
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

async function getStandaloneControlPage(app) {
  const pages = await app.windows()
  const page = pages.find(candidate => candidate.url().includes('/standalone-player.html'))
  assert.ok(page, `Standalone control Renderer must be attached; pages=${JSON.stringify(pages.map(candidate => candidate.url()))}`)
  return page
}

async function readStandaloneSnapshot(page) {
  page.on('pageerror', error => process.stderr.write(`STANDALONE_RENDERER_ERROR ${error.message}\n`))
  try {
    await page.waitForFunction(() => typeof window.standalonePlayer?.getSnapshot === 'function')
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      bridgeType: typeof window.standalonePlayer,
      scripts: [...document.scripts].map(script => script.src ? new URL(script.src).pathname : 'inline'),
      bodyText: document.body.innerText.slice(0, 400)
    })).catch(() => ({ renderer: 'unavailable' }))
    process.stderr.write(`STANDALONE_BRIDGE_DIAGNOSTIC ${JSON.stringify(diagnostic)}\n`)
    throw error
  }
  const envelope = await page.evaluate(() => window.standalonePlayer.getSnapshot())
  return envelope.snapshot
}

async function closeStandalone(app, page) {
  const closed = page.waitForEvent('close', { timeout: 15000 })
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate =>
      candidate.webContents.getURL().includes('standalone-player.html'))
    if (!window) throw new Error('The Standalone BrowserWindow is not available for the shutdown test.')
    window.close()
  })
  await page.locator('#standalone-exit-confirmation').waitFor({ state: 'visible' })
  await page.locator('#exit-confirmation-confirm').click()
  await closed
  await app.close()
}

async function closeStandaloneForCleanup(app, page) {
  if (!app) return
  try {
    const cleanupPage = page ?? await getStandaloneControlPage(app).catch(() => undefined)
    if (cleanupPage) await closeStandalone(app, cleanupPage)
    else await app.close()
  } catch (error) {
    process.stderr.write(`STANDALONE_TEST_CLEANUP_FAILED ${error instanceof Error ? error.message : String(error)}\n`)
    app.process().kill('SIGKILL')
    await app.close().catch(() => {})
  }
}

function readRecords(profile) {
  const logPath = path.join(profile.userData, 'logs', 'app.log')
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
}

async function waitForRecord(profile, event, previousRunId) {
  const find = () => readRecords(profile).find(record => record.event === event &&
    (!previousRunId || record.runId !== previousRunId))
  const existing = find()
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
      const record = find()
      if (record) finish(undefined, record)
    }
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${event} in the isolated profile log`)), 15000)
    watcher = fs.watch(logDirectory, check)
    check()
  })
}

async function closeController(app) {
  if (!app) return
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue)
    const closed = page.waitForEvent('close', { timeout: 15000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
  } finally { await app.close().catch(() => {}) }
}

async function runLegacyControllerInvalidLibraryKeepsManagementAvailable() {
  const profile = makeProfile('legacy-controller-invalid-library')
  writeMode(profile, 'controller')
  const configPath = path.join(profile.userData, 'video-library.json')
  const originalConfig = Buffer.from('{invalid legacy video-library configuration')
  fs.writeFileSync(configPath, originalConfig)
  let app
  try {
    app = await launch(profile)
    const ready = await waitForRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'combined')
    assert.equal(ready.details.playerLibraryInitialized, true)
    assert.equal(ready.details.operationalDatabaseInitialized, true)
    assert.equal(readRecords(profile).some(record => record.event === 'VIDEO_LIBRARY_CONFIGURATION_INVALID'), true,
      'Combined must report invalid optional media configuration instead of ignoring it')
    assert.deepEqual(fs.readFileSync(configPath), originalConfig,
      'legacy Combined startup must preserve invalid media configuration for explicit repair')
    assert.equal(fs.existsSync(path.join(profile.userData, 'karaoke.sqlite')), true)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  } finally { await closeController(app) }
}

async function runPlayerScanAndRestart() {
  const profile = makeProfile('player-only')
  const mediaRoot = path.join(profile.root, 'media')
  fs.mkdirSync(path.join(mediaRoot, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(mediaRoot, '01234.mp4'), '')
  writeMode(profile, 'player')
  writeVideoLibraryConfiguration(profile.userData, [mediaRoot])
  let app
  let controlPage
  try {
    app = await launch(profile)
    const scan = await waitForRecord(profile, 'VIDEO_LIBRARY_SCAN_COMPLETED')
    const ready = await waitForRecord(profile, 'APP_READY')
    assert.equal(ready.details.playerLibraryInitialized, true)
    assert.equal(ready.details.controllerServicesInitialized, false)
    assert.equal(ready.details.operationalDatabaseInitialized, false)
    assert.equal(scan.details.scanStatus, 'ready')
    assert.equal(scan.details.configuredRootCount, 1)
    assert.equal(scan.details.availableCodes, 1)
    assert.equal(JSON.stringify(scan).includes(mediaRoot), false, 'startup diagnostics must not publish local absolute paths')
    assert.equal(fs.existsSync(path.join(profile.userData, 'karaoke.sqlite')), false,
      'Player-only startup must not create the Controller operational database')
    controlPage = await getStandaloneControlPage(app)
    await controlPage.waitForLoadState('domcontentloaded')
    const playerWindowUrls = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(window => window.webContents.getURL()))
    assert.equal(playerWindowUrls.length, 1,
      'Player-only startup must open only its approved control shell')
    assert.equal(playerWindowUrls.some(url => url.includes('standalone-player.html')), true,
      `Player-only startup must open the Standalone control screen; windows=${JSON.stringify(playerWindowUrls)}`)
    assert.equal(playerWindowUrls.some(url => url.includes('player-playback.html')), false,
      'The independent video window must remain closed until an explicit operator action')
    const initialPlayerSnapshot = await readStandaloneSnapshot(controlPage)
    assert.equal(initialPlayerSnapshot.playbackCondition, 'ready')
    assert.equal(initialPlayerSnapshot.state.operationalState, 'idle', 'Player-only startup must not autoplay')
    assert.equal(initialPlayerSnapshot.state.current, null)
    assert.deepEqual(initialPlayerSnapshot.state.pending, [])
    const initialOptions = await controlPage.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
    assert.equal(initialOptions.library.scanStatus, 'ready')
    assert.equal(initialOptions.library.indexedFiles, 1, 'Standalone Options must expose the completed media-library index')

    const previousRunId = ready.runId
    await closeStandalone(app, controlPage)
    app = undefined
    controlPage = undefined
    fs.writeFileSync(path.join(mediaRoot, 'nested', '01235 - nested.MKV'), '')

    app = await launch(profile)
    const restartedScan = await waitForRecord(profile, 'VIDEO_LIBRARY_SCAN_COMPLETED', previousRunId)
    const restartedReady = await waitForRecord(profile, 'APP_READY', previousRunId)
    assert.equal(restartedReady.details.mode, 'player')
    assert.equal(restartedScan.details.configuredRootCount, 1,
      'configured roots must survive restart')
    assert.equal(restartedScan.details.availableCodes, 2,
      'the index must be rebuilt from the configured filesystem on restart')
    controlPage = await getStandaloneControlPage(app)
    const restartedControlPage = controlPage
    await restartedControlPage.waitForLoadState('domcontentloaded')
    const restartedPlayerWindowUrls = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(window => window.webContents.getURL()))
    assert.equal(restartedPlayerWindowUrls.length, 1,
      'Player-only restart must restore only the control shell without opening video output')
    assert.equal(restartedPlayerWindowUrls.some(url => url.includes('standalone-player.html')), true,
      `the Standalone control shell must be restored for the configured Player mode; windows=${JSON.stringify(restartedPlayerWindowUrls)}`)
    assert.equal(restartedPlayerWindowUrls.some(url => url.includes('player-playback.html')), false,
      'the independent video window must remain closed after restart')
    const restartedPlayerSnapshot = await readStandaloneSnapshot(restartedControlPage)
    assert.equal(restartedPlayerSnapshot.playbackCondition, 'ready')
    assert.equal(restartedPlayerSnapshot.state.operationalState, 'idle', 'Player-only restart must not autoplay')
    assert.equal(restartedPlayerSnapshot.state.current, null)
    assert.deepEqual(restartedPlayerSnapshot.state.pending, [])
    const restartedOptions = await restartedControlPage.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
    assert.equal(restartedOptions.library.scanStatus, 'ready')
    assert.equal(restartedOptions.library.indexedFiles, 2,
      'the configured library must be re-indexed after restart without storing its inventory in the Controller database')
    assert.equal(fs.existsSync(path.join(profile.userData, 'karaoke.sqlite')), false)
  } finally { await closeStandaloneForCleanup(app, controlPage) }
}

async function runCombinedReusesControllerAndPlayerOwnership() {
  const profile = makeProfile('combined')
  const mediaRoot = path.join(profile.root, 'media')
  fs.mkdirSync(mediaRoot, { recursive: true })
  fs.writeFileSync(path.join(mediaRoot, '54321.avi'), '')
  writeMode(profile, 'combined')
  writeVideoLibraryConfiguration(profile.userData, [mediaRoot])
  let app
  try {
    app = await launch(profile)
    const scan = await waitForRecord(profile, 'VIDEO_LIBRARY_SCAN_COMPLETED')
    const ready = await waitForRecord(profile, 'APP_READY')
    assert.equal(scan.details.availableCodes, 1)
    assert.equal(ready.details.controllerServicesInitialized, true)
    assert.equal(ready.details.playerLibraryInitialized, true)
    assert.equal(ready.details.operationalDatabaseInitialized, true)
    assert.equal(fs.existsSync(path.join(profile.userData, 'karaoke.sqlite')), true)
    assert.deepEqual(fs.readdirSync(profile.userData).filter(name => /\.sqlite(?:3)?$/.test(name)), ['karaoke.sqlite'],
      'Combined mode must keep one authoritative Controller SQLite database')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'Phase 3 must reuse the current Controller window and not invent a Player layout')
  } finally { await closeController(app) }
}

async function runInvalidLibraryConfigurationPreservesOperationalData() {
  const profile = makeProfile('invalid-library-configuration')
  writeMode(profile, 'combined')
  const seeded = createKaraokeDatabase(profile.userData)
  seeded.close()
  const databasePath = path.join(profile.userData, 'karaoke.sqlite')
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex')
  const configPath = path.join(profile.userData, 'video-library.json')
  const originalConfig = Buffer.from('{invalid library configuration')
  fs.writeFileSync(configPath, originalConfig)
  let app
  try {
    app = await launch(profile)
    const ready = await waitForRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'combined')
    assert.equal(ready.details.operationalDatabaseInitialized, true,
      'invalid optional media configuration must not prevent Management startup')
    assert.equal(readRecords(profile).some(record => record.event === 'VIDEO_LIBRARY_CONFIGURATION_INVALID'), true)
    assert.deepEqual(fs.readFileSync(configPath), originalConfig,
      'invalid media configuration must remain available for explicit repair')
    const afterHash = crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex')
    assert.equal(afterHash, beforeHash,
      'Combined startup with invalid media configuration must not mutate existing operational SQLite data')
  } finally { await closeController(app) }
}

async function run() {
  try {
    await runLegacyControllerInvalidLibraryKeepsManagementAvailable()
    process.stdout.write('VIDEO_LIBRARY PASS legacy Controller resolves to Combined and preserves invalid media configuration\n')
    await runPlayerScanAndRestart()
    process.stdout.write('VIDEO_LIBRARY PASS Player scan, no Controller database/UI, and restart reconstruction\n')
    await runCombinedReusesControllerAndPlayerOwnership()
    process.stdout.write('VIDEO_LIBRARY PASS Combined owns one Controller database and one Player library service\n')
    await runInvalidLibraryConfigurationPreservesOperationalData()
    process.stdout.write('VIDEO_LIBRARY PASS invalid Player configuration preserves existing Controller SQLite\n')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
