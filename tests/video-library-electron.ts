// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
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

async function waitForEmbeddedPlayer(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const bridge = window.karaokePlayer
    if (!bridge) { reject(new Error('Player bridge is unavailable.')); return }
    const isReady = snapshot => snapshot.videoWindow.open && snapshot.videoWindow.location === 'inline' && snapshot.videoWindow.ready
    let unsubscribe = () => {}
    const timeout = window.setTimeout(() => finish(new Error('Embedded Player surface did not become ready.')), 15000)
    const finish = (error, snapshot) => {
      window.clearTimeout(timeout)
      unsubscribe()
      if (error) reject(error)
      else resolve(snapshot)
    }
    unsubscribe = bridge.onSnapshot(snapshot => { if (isReady(snapshot)) finish(undefined, snapshot) })
    void bridge.getSnapshot().then(snapshot => { if (isReady(snapshot)) finish(undefined, snapshot) }, finish)
  }))
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

async function runControllerSkipsPlayerConfiguration() {
  const profile = makeProfile('controller-only')
  const mediaRoot = path.join(profile.root, 'media')
  fs.mkdirSync(mediaRoot, { recursive: true })
  fs.writeFileSync(path.join(mediaRoot, '00001.mp4'), '')
  writeMode(profile, 'controller')
  fs.writeFileSync(path.join(profile.userData, 'video-library.json'), '{invalid Player-only configuration')
  let app
  try {
    app = await launch(profile)
    const ready = await waitForRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'controller')
    assert.equal(ready.details.playerLibraryInitialized, false)
    assert.equal(ready.details.operationalDatabaseInitialized, true)
    assert.equal(readRecords(profile).some(record => record.event.startsWith('VIDEO_LIBRARY_SCAN_')), false,
      'Controller-only startup must not load or scan Player library state')
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
    const controlPage = await app.firstWindow()
    await controlPage.waitForLoadState('domcontentloaded')
    const playerWindowUrls = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(window => window.webContents.getURL()))
    assert.equal(playerWindowUrls.length, 1,
      'Player-only startup must open only its approved control shell')
    assert.equal(playerWindowUrls.some(url => url.includes('player-control.html')), true)
    assert.equal(playerWindowUrls.some(url => url.includes('player-playback.html')), false,
      'The independent video window must remain closed until an explicit operator action')
    const initialPlayerSnapshot = await waitForEmbeddedPlayer(controlPage)
    assert.equal(initialPlayerSnapshot.playback.status, 'idle', 'Player-only startup must not autoplay')
    assert.equal(initialPlayerSnapshot.videoWindow.open, true, 'Player-only startup must make the embedded video surface available')
    assert.equal(initialPlayerSnapshot.videoWindow.location, 'inline', 'Player-only startup must keep video embedded')

    const previousRunId = ready.runId
    await app.close()
    app = undefined
    fs.writeFileSync(path.join(mediaRoot, 'nested', '01235 - nested.MKV'), '')

    app = await launch(profile)
    const restartedScan = await waitForRecord(profile, 'VIDEO_LIBRARY_SCAN_COMPLETED', previousRunId)
    const restartedReady = await waitForRecord(profile, 'APP_READY', previousRunId)
    assert.equal(restartedReady.details.mode, 'player')
    assert.equal(restartedScan.details.configuredRootCount, 1,
      'configured roots must survive restart')
    assert.equal(restartedScan.details.availableCodes, 2,
      'the index must be rebuilt from the configured filesystem on restart')
    const restartedControlPage = await app.firstWindow()
    await restartedControlPage.waitForLoadState('domcontentloaded')
    const restartedPlayerWindowUrls = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(window => window.webContents.getURL()))
    assert.equal(restartedPlayerWindowUrls.length, 1,
      'Player-only restart must restore only the control shell without opening video output')
    assert.equal(restartedPlayerWindowUrls.some(url => url.includes('player-control.html')), true,
      'the Player control shell must be restored for the configured Player mode')
    assert.equal(restartedPlayerWindowUrls.some(url => url.includes('player-playback.html')), false,
      'the independent video window must remain closed after restart')
    const restartedPlayerSnapshot = await waitForEmbeddedPlayer(restartedControlPage)
    assert.equal(restartedPlayerSnapshot.playback.status, 'idle', 'Player-only restart must not autoplay')
    assert.equal(restartedPlayerSnapshot.videoWindow.open, true, 'Player-only restart must restore the embedded video surface')
    assert.equal(restartedPlayerSnapshot.videoWindow.location, 'inline', 'Player-only restart must keep video embedded')
    assert.equal(fs.existsSync(path.join(profile.userData, 'karaoke.sqlite')), false)
  } finally { await app?.close().catch(() => {}) }
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
  fs.writeFileSync(path.join(profile.userData, 'video-library.json'), '{invalid library configuration')
  let child

  try {
    const electronArgs = [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--disable-gpu', projectRoot, `--user-data-dir=${profile.userData}`
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

    const rejected = await waitForRecord(profile, 'APP_INITIALIZATION_FAILED')
    assert.equal(rejected.level, 'FATAL')
    assert.equal(readRecords(profile).some(record => record.event === 'APP_READY'), false,
      'invalid Player configuration must stop Combined before operational startup')
    const afterHash = crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex')
    assert.equal(afterHash, beforeHash,
      'invalid Player configuration must not open, migrate, or mutate existing Controller SQLite data')
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true
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
    await runControllerSkipsPlayerConfiguration()
    process.stdout.write('VIDEO_LIBRARY PASS Controller ignores Player-only library configuration\n')
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
