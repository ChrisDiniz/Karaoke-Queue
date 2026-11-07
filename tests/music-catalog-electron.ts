// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')
const { createKaraokeDatabase } = require('../database')
const { MusicCatalogService } = require('../src/music-catalog-service')
const { writeVideoLibraryConfiguration } = require('../src/video-library-configuration')

const projectRoot = path.resolve(__dirname, '../..')
const electronPath = require('electron')
const configuredTempRoot = process.env.KARAOKE_TEST_TEMP_ROOT
const tempRoot = configuredTempRoot
  ? path.resolve(configuredTempRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-music-catalog-e2e-'))
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

function writeCatalogFile(profile, fileName = 'catalog.csv') {
  const filePath = path.join(profile.root, fileName)
  fs.mkdirSync(profile.root, { recursive: true })
  fs.writeFileSync(filePath, '\uFEFFartista;numero;nome_musica\r\nBon Jovi;1001;Always\r\n;42;Sem título\r\n', 'utf8')
  return filePath
}

async function seedCatalog(profile) {
  const filePath = writeCatalogFile(profile)
  const database = createKaraokeDatabase(profile.userData)
  const catalog = new MusicCatalogService(database)
  try {
    return await catalog.importFile(filePath)
  } finally {
    await catalog.close()
    database.close()
  }
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
  await page.waitForFunction(() => typeof window.standalonePlayer?.getSnapshot === 'function')
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

function readLogRecords(profile) {
  const logPath = path.join(profile.userData, 'logs', 'app.log')
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
}

async function waitForRecord(profile, event, previousRunId) {
  const find = () => readLogRecords(profile).find(record => record.event === event &&
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

async function runControllerCatalogRestart() {
  const profile = makeProfile('controller')
  writeMode(profile, 'controller')
  const imported = await seedCatalog(profile)
  fs.writeFileSync(path.join(profile.userData, 'video-library.json'), '{invalid Player-only configuration')
  let app
  try {
    app = await launch(profile)
    const ready = await waitForRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'controller')
    assert.equal(ready.details.catalogServiceInitialized, true)
    assert.equal(ready.details.playerLibraryInitialized, false)
    assert.equal(ready.details.operationalDatabaseInitialized, true)
    assert.equal(readLogRecords(profile).some(record => record.event.startsWith('VIDEO_LIBRARY_SCAN_')), false)
    const previousRunId = ready.runId
    await closeController(app)
    app = undefined

    app = await launch(profile)
    const restarted = await waitForRecord(profile, 'APP_READY', previousRunId)
    assert.equal(restarted.details.catalogServiceInitialized, true)
    await closeController(app)
    app = undefined

    const database = createKaraokeDatabase(profile.userData)
    const catalog = new MusicCatalogService(database)
    try {
      const persisted = await catalog.search('always', { limit: 10, offset: 0 })
      assert.equal(persisted.catalogRevision, imported.revision)
      assert.equal(persisted.total, 1)
      assert.equal(persisted.items[0].musicNumber, '1001')
    } finally {
      await catalog.close()
      database.close()
    }
  } finally { await closeController(app) }
}

async function runPlayerUsesIsolatedCatalogDatabase() {
  const profile = makeProfile('player')
  const mediaRoot = path.join(profile.root, 'media')
  fs.mkdirSync(mediaRoot, { recursive: true })
  fs.writeFileSync(path.join(mediaRoot, '00123.mp4'), '')
  writeMode(profile, 'player')
  writeVideoLibraryConfiguration(profile.userData, [mediaRoot])
  let app
  let controlPage
  try {
    app = await launch(profile)
    const ready = await waitForRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'player')
    assert.equal(ready.details.catalogServiceInitialized, true)
    assert.equal(ready.details.playerLibraryInitialized, true)
    assert.equal(ready.details.operationalDatabaseInitialized, false)
    assert.equal(fs.existsSync(path.join(profile.userData, 'karaoke.sqlite')), false)
    const playerCatalogPath = path.join(profile.userData, 'player-music-catalog.sqlite')
    assert.equal(fs.existsSync(playerCatalogPath), true, 'Player-only mode must create its optional catalog store')
    const database = new DatabaseSync(playerCatalogPath, { readOnly: true })
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map(row => row.name)
      assert.deepEqual(tables, ['music_catalog', 'music_catalog_import_issues', 'music_catalog_import_state', 'music_catalog_metadata'],
        'Player catalog persistence must not contain Controller operational tables')
    } finally { database.close() }
    controlPage = await getStandaloneControlPage(app)
    await controlPage.waitForLoadState('domcontentloaded')
    const playerWindowUrls = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(window => window.webContents.getURL()))
    assert.equal(playerWindowUrls.length, 1, 'Player-only startup must open only the approved control shell')
    assert.equal(playerWindowUrls.some(url => url.includes('standalone-player.html')), true,
      `Player-only startup must open the Standalone control shell; windows=${JSON.stringify(playerWindowUrls)}`)
    assert.equal(playerWindowUrls.some(url => url.includes('player-playback.html')), false,
      'The video window must remain closed until an explicit operator action')
    const snapshot = await readStandaloneSnapshot(controlPage)
    assert.equal(snapshot.playbackCondition, 'ready')
    assert.equal(snapshot.state.operationalState, 'idle', 'Player-only startup must not autoplay')
    assert.equal(snapshot.state.current, null)
    assert.deepEqual(snapshot.state.pending, [])
    const options = await controlPage.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
    assert.equal(options.library.scanStatus, 'ready')
    assert.equal(options.library.indexedFiles, 1)
    assert.equal(options.catalog.recordCount, 0)
    await closeStandalone(app, controlPage)
    app = undefined
    controlPage = undefined
  } finally { await closeStandaloneForCleanup(app, controlPage) }
}

async function runCombinedCatalogAndLibraryComposition() {
  const profile = makeProfile('combined')
  const mediaRoot = path.join(profile.root, 'media')
  fs.mkdirSync(mediaRoot, { recursive: true })
  fs.writeFileSync(path.join(mediaRoot, '01001.mp4'), '')
  writeMode(profile, 'combined')
  writeVideoLibraryConfiguration(profile.userData, [mediaRoot])
  const imported = await seedCatalog(profile)
  let app
  try {
    app = await launch(profile)
    const scan = await waitForRecord(profile, 'VIDEO_LIBRARY_SCAN_COMPLETED')
    const ready = await waitForRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'combined')
    assert.equal(ready.details.catalogServiceInitialized, true)
    assert.equal(ready.details.playerLibraryInitialized, true)
    assert.equal(ready.details.operationalDatabaseInitialized, true)
    assert.equal(scan.details.availableCodes, 1)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    await closeController(app)
    app = undefined

    const database = createKaraokeDatabase(profile.userData)
    const catalog = new MusicCatalogService(database)
    try {
      const persisted = await catalog.search('01001', { limit: 10, offset: 0 })
      assert.equal(persisted.catalogRevision, imported.revision)
      assert.equal(persisted.items[0].videoCode, '01001')
    } finally {
      await catalog.close()
      database.close()
    }
  } finally { await closeController(app) }
}

async function run() {
  try {
    await runControllerCatalogRestart()
    process.stdout.write('MUSIC_CATALOG PASS Controller initializes catalog and preserves it across Electron restart\n')
    await runPlayerUsesIsolatedCatalogDatabase()
    process.stdout.write('MUSIC_CATALOG PASS Player uses separate catalog storage without operational SQLite\n')
    await runCombinedCatalogAndLibraryComposition()
    process.stdout.write('MUSIC_CATALOG PASS Combined initializes catalog and Player inventory on one Controller database\n')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
