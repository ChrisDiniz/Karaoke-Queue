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
  : fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'karaoke-operating-modes-'))
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

async function runLegacyControllerAliasAndRecovery() {
  const profile = makeProfile('legacy-controller-alias-recovery')
  fs.mkdirSync(profile.userData, { recursive: true })
  const modePath = path.join(profile.userData, 'operating-mode.json')
  const legacyModeBytes = Buffer.from('{\n  "version": 1,\n  "mode": "controller"\n}\n')
  fs.writeFileSync(modePath, legacyModeBytes)
  const libraryPath = path.join(profile.userData, 'video-library.json')
  const legacyLibraryBytes = Buffer.from('{invalid legacy video-library configuration')
  fs.writeFileSync(libraryPath, legacyLibraryBytes)
  const legacyDatabase = createKaraokeDatabase(profile.userData)
  legacyDatabase.close()
  let app
  try {
    app = await launch(profile)
    const ready = await waitForLogRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'combined', 'legacy Controller configuration must resolve to the final Combined function')
    assert.equal(ready.details.controllerServicesInitialized, true)
    assert.equal(ready.details.playerServicesImplemented, true,
      'legacy Controller profiles must initialize the Combined media runtime')
    assert.equal(ready.details.operationalDatabaseInitialized, true)
    assert.equal(readLogRecords(profile).some(record => record.event === 'VIDEO_LIBRARY_CONFIGURATION_INVALID'), true,
      'invalid optional media configuration must be reported while legacy Management starts')
    assert.deepEqual(fs.readFileSync(modePath), legacyModeBytes,
      'resolving a legacy Controller profile must not rewrite its mode configuration')
    assert.deepEqual(fs.readFileSync(libraryPath), legacyLibraryBytes,
      'resolving a legacy Controller profile must not rewrite invalid media configuration')

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
    assert.equal(restartedReady.details.mode, 'combined')
    assert.deepEqual(fs.readFileSync(modePath), legacyModeBytes,
      'restarting a legacy Controller profile must preserve the original configuration bytes')
    assert.deepEqual(fs.readFileSync(libraryPath), legacyLibraryBytes,
      'restarting a legacy Controller profile must preserve invalid media configuration')
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

async function runMissingLegacyModeConfigurationResolvesCombined() {
  const profile = makeProfile('missing-legacy-mode-configuration')
  fs.mkdirSync(profile.userData, { recursive: true })
  const legacyDatabase = createKaraokeDatabase(profile.userData)
  legacyDatabase.close()
  let app
  try {
    app = await launch(profile)
    const ready = await waitForLogRecord(profile, 'APP_READY')
    assert.equal(ready.details.mode, 'combined', 'a legacy profile without mode configuration must resolve to Combined')
    assert.equal(ready.details.controllerServicesInitialized, true)
    assert.equal(ready.details.playerServicesImplemented, true)
    assert.equal(fs.existsSync(path.join(profile.userData, 'operating-mode.json')), false,
      'normalizing the missing mode must not create or rewrite a configuration file')
  } finally { await forceClose(app) }
}

async function runWelcomeSelectsOnlyFinalModes() {
  const screenshotRoot = process.env.KQ_PLAYER_SCREENSHOT_DIR
    ? path.resolve(process.env.KQ_PLAYER_SCREENSHOT_DIR) : undefined
  for (const mode of ['player', 'combined']) {
    const profile = makeProfile(`welcome-${mode}`)
    let app
    try {
      app = await launch(profile)
      const page = await app.firstWindow()
      await page.locator('.mode-card').first().waitFor({ state: 'visible' })
      await page.setViewportSize({ width: 1280, height: 800 })
      assert.deepEqual(await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
        { width: 1280, height: 800 }, 'the production Welcome surface must render at the approved 1280×800 frame')
      assert.equal(await page.locator('.mode-card').count(), 2,
        'first-run Welcome must present exactly two final product functions')
      assert.equal(await page.locator('.mode-card[data-mode="controller"]').count(), 0,
        'Controller must not be a first-run choice')
      assert.deepEqual(await page.locator('.mode-card').evaluateAll(cards => cards.map(card => card.dataset.mode)),
        ['player', 'combined'])
      assert.equal(await page.locator('.subtitle').textContent(),
        'Escolha como este computador vai funcionar no karaokê. Alterações posteriores serão feitas pela manutenção do instalador.',
        'the selected function can be changed only through installer maintenance (approved A7)')
      assert.equal(await page.locator('.saved-note').innerText(),
        'O modo escolhido ficará salvo neste computador. Alterações posteriores serão feitas pela manutenção do instalador.')
      assert.deepEqual(await page.locator('.mode-description').allTextContents(), [
        'Reproduza vídeos localmente, adicione músicas pelo teclado ou receba comandos remotamente de outra instância.',
        'Gerencie a fila, as mesas e as sessões e reproduza localmente em uma janela para outra tela. Também controle remotamente outro Reprodutor instalado em outra máquina.'
      ], 'the function descriptions must match the approved Doop frame')
      assert.match(await page.locator('.saved-note').textContent(), /manutenção do instalador/,
        'approved installer-maintenance policy takes precedence over stale frame copy that says Settings')
      if (screenshotRoot && mode === 'combined') {
        fs.mkdirSync(screenshotRoot, { recursive: true })
        await page.screenshot({ path: path.join(screenshotRoot, 'welcome-mode-selection.png') })
      }

      await app.evaluate(({ app: electronApp }) => { electronApp.relaunch = () => undefined })
      const child = app.process()
      const processExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
      await page.locator(`.mode-card[data-mode="${mode}"]`).click()
      await page.locator('#welcome-continue').click()
      await page.locator('#welcome-setup-page').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#welcome-mode-page').isHidden(), true,
        'advancing to initial setup must hide the mode selection page')
      assert.equal(await page.locator('#welcome-setup-page h1').textContent(),
        'Configure os vídeos e o catálogo de músicas', 'mode selection must continue to the approved library/catalog setup frame')
      assert.equal(await page.locator('#welcome-configure-later').isEnabled(), true,
        'the initial media setup must remain optional')
      assert.deepEqual(await page.locator('.setup-card h2').allTextContents(),
        ['Biblioteca de vídeos', 'Catálogo de músicas'])
      assert.deepEqual(await page.locator('.setup-card .tag').allTextContents(),
        ['Necessária para reprodução local', 'Opcional'])
      if (screenshotRoot && mode === 'combined') {
        await page.screenshot({ path: path.join(screenshotRoot, 'welcome-library-catalog.png') })
      }

      if (mode === 'player') {
        const libraryRoot = path.join(profile.root, 'media')
        const catalogFile = path.join(profile.root, 'catalog.csv')
        fs.mkdirSync(libraryRoot, { recursive: true })
        fs.writeFileSync(catalogFile, 'numero;artista;nome_musica\n123;Artista;Musica\n')
        await page.evaluate(({ libraryRoot, catalogFile }) => window.karaokeWelcome.completeSetup({ libraryRoot, catalogFile }),
          { libraryRoot, catalogFile }).catch(error => {
          if (!page.isClosed()) throw error
        })
      } else {
        await page.locator('#welcome-configure-later').click().catch(error => {
          if (!page.isClosed()) throw error
        })
      }
      assert.deepEqual(await processExit, { code: 0, signal: null }, 'saving the selected mode must close Welcome cleanly')
      await app.close()
      app = undefined

      const modePath = path.join(profile.userData, 'operating-mode.json')
      assert.deepEqual(JSON.parse(fs.readFileSync(modePath, 'utf8')), { version: 1, mode },
        'first-run selection must persist only the selected final function')
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile.userData, 'welcome-setup.json'), 'utf8')),
        { version: 1, status: 'complete' }, 'completed onboarding must persist per-account setup state')
      if (mode === 'player') {
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile.userData, 'video-library.json'), 'utf8')),
          { version: 1, roots: [path.join(profile.root, 'media')] })
        const catalog = new DatabaseSync(path.join(profile.userData, 'player-music-catalog.sqlite'), { readOnly: true })
        try {
          assert.equal(catalog.prepare('SELECT count(*) AS count FROM music_catalog').get().count, 1,
            'the selected CSV must be imported through the existing Player SQLite catalog')
        } finally { catalog.close() }
      } else {
        assert.equal(fs.existsSync(path.join(profile.userData, 'video-library.json')), false,
          'Configure later must not create a library configuration')
        assert.equal(fs.existsSync(path.join(profile.userData, 'karaoke.sqlite')), false,
          'Configure later must not open or create the Combined operational SQLite database')
      }
      app = await launch(profile)
      const ready = await waitForLogRecord(profile, 'APP_READY')
      assert.equal(ready.details.mode, mode, 'the selected final function must be used on restart')
    } finally { await forceClose(app) }
  }
}

async function runWelcomeSharedMediaSetup() {
  for (const mode of ['player','combined']) {
    const profile = makeProfile('welcome-shared-media-' + mode)
    const root = path.join(profile.root,'videos'); fs.mkdirSync(root,{recursive:true})
    fs.writeFileSync(path.join(root,'01001.mp4'),'inventory only')
    const file = path.join(profile.root,'partial.csv')
    fs.writeFileSync(file,'numero;artista;nome_musica\n1001;Artist;Title\n'+Array.from({length:61},(_,i)=>`bad${i};A;T`).join('\n'))
    let app
    try {
      app = await launch(profile)
      await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1280,800))
      const page = await app.firstWindow()
      await page.locator(`.mode-card[data-mode="${mode}"]`).click()
      await page.locator('#welcome-continue').click()
      await page.locator('#welcome-setup-page').waitFor({state:'visible'})
      await app.evaluate(({dialog},paths) => {
        let next=0; dialog.showOpenDialog = async () => ({canceled:false,filePaths:[paths[next++]]})
      },[root,file,file])
      await page.evaluate(() => { window.welcomeScanStates=[]; window.karaokeWelcome.onMediaChanged(state => window.welcomeScanStates.push(state.library.scanStatus)) })
      await page.locator('#welcome-library-choose').click()
      await page.waitForFunction(() => document.querySelector('#welcome-library-status').textContent.includes('1 vídeos indexados'))
      await page.waitForFunction(() => window.welcomeScanStates.includes('ready'))
      assert.deepEqual(await page.evaluate(() => window.welcomeScanStates),['scanning','ready'])
      await page.locator('#welcome-catalog-choose').click()
      await page.locator('#welcome-catalog-dialog').waitFor({state:'visible'})
      await page.waitForFunction(() => document.querySelectorAll('#welcome-catalog-issues-list li').length===50)
      assert.equal(await page.locator('#welcome-catalog-dialog-cancel').evaluate(node=>node===document.activeElement),true)
      await page.locator('#welcome-catalog-dialog-cancel').click()
      await page.locator('#welcome-catalog-dialog').waitFor({state:'hidden'})
      await page.locator('#welcome-catalog-choose').click()
      await page.locator('#welcome-catalog-dialog').waitFor({state:'visible'})
      await page.waitForFunction(() => document.querySelectorAll('#welcome-catalog-issues-list li').length===50)
      await page.locator('#welcome-catalog-issues-next').click()
      await page.waitForFunction(() => document.querySelectorAll('#welcome-catalog-issues-list li').length===11)
      await page.locator('#welcome-catalog-dialog-confirm').click()
      await page.waitForFunction(() => document.querySelector('#welcome-catalog-status').textContent.includes('61 registros ignorados'))
      await page.locator('#welcome-catalog-dialog-cancel').click()
      const dbFile = path.join(profile.userData, mode==='player'?'player-music-catalog.sqlite':'karaoke.sqlite')
      const db = new DatabaseSync(dbFile,{readOnly:true})
      try { assert.equal(db.prepare('SELECT count(*) AS n FROM music_catalog').get().n,1) } finally { db.close() }
      const screenshots = process.env.KARAOKE_UI_SCREENSHOT_DIR
      if(screenshots) { fs.mkdirSync(screenshots,{recursive:true}); await page.screenshot({path:path.join(screenshots,'welcome-media-'+mode+'.png'),scale:'css'}) }
    } finally { await forceClose(app) }
  }
}

async function runConfigureLaterAfterInvalidCatalog() {
  const profile = makeProfile('configure-later-after-invalid-catalog')
  const libraryRoot = path.join(profile.root, 'media')
  const invalidCatalog = path.join(profile.root, 'invalid.csv')
  fs.mkdirSync(libraryRoot, { recursive: true })
  fs.writeFileSync(invalidCatalog, 'not,a,valid,catalog\n')
  let app
  try {
    app = await launch(profile)
    const page = await app.firstWindow()
    await page.locator('.mode-card[data-mode="combined"]').click()
    await page.locator('#welcome-continue').click()
    await page.locator('#welcome-setup-page').waitFor({ state: 'visible' })
    await app.evaluate(({ app: electronApp }) => { electronApp.relaunch = () => undefined })
    await app.evaluate(({ dialog }, paths) => {
      let index = 0
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths[index++]] })
    }, [libraryRoot, invalidCatalog])
    await page.locator('#welcome-library-choose').click()
    await page.locator('#welcome-catalog-choose').click()
    await page.locator('#welcome-setup-error').waitFor({ state: 'visible' })
    assert.match(await page.locator('#welcome-setup-error').textContent(), /não foi possível selecionar o catálogo/i)
    await page.locator('#welcome-configure-later').click()
    const process = app.process()
    await new Promise((resolve, reject) => {
      if (process.exitCode !== null) return process.exitCode === 0 ? resolve() : reject(new Error(`Welcome exited ${process.exitCode}`))
      process.once('exit', code => code === 0 ? resolve() : reject(new Error(`Welcome exited ${code}`)))
    })
    await app.close()
    app = undefined

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile.userData, 'welcome-setup.json'), 'utf8')),
      { version: 1, status: 'complete' }, 'deferral completes setup without retrying the rejected CSV')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile.userData, 'video-library.json'), 'utf8')),
      { version: 1, roots: [libraryRoot] }, 'the previously committed library selection remains intact')
    const catalog = new DatabaseSync(path.join(profile.userData, 'karaoke.sqlite'), { readOnly: true })
    try { assert.equal(catalog.prepare('SELECT count(*) AS count FROM music_catalog').get().count, 0) }
    finally { catalog.close() }
    assert.equal(readLogRecords(profile).some(record => record.event === 'APP_READY'), false,
      'the initial setup flow still exits after its explicit defer action')
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
  const screenshotRoot = process.env.KQ_PLAYER_SCREENSHOT_DIR
    ? path.resolve(process.env.KQ_PLAYER_SCREENSHOT_DIR) : undefined
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

    await page.locator('#nav-settings').click()
    await page.locator('#settings-page').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#settings-mode-controller, #settings-mode-player, #settings-mode-combined').count(), 0,
      'Settings must not present a function selector after the approved A7 decision')
    assert.equal(await page.evaluate(() => Object.prototype.hasOwnProperty.call(window.karaokePreferences ?? {}, 'changeOperatingMode')), false,
      'the restricted Management preload must not expose normal mode changes')
    if (screenshotRoot) {
      fs.mkdirSync(screenshotRoot, { recursive: true })
      await page.screenshot({ path: path.join(screenshotRoot, 'combined-settings.png') })
    }

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
    await runLegacyControllerAliasAndRecovery()
    process.stdout.write('OPERATING_MODE PASS legacy Controller alias and SQLite session recovery\n')
    await runMissingLegacyModeConfigurationResolvesCombined()
    process.stdout.write('OPERATING_MODE PASS missing legacy mode configuration resolves to Combined without writing\n')
    await runWelcomeSelectsOnlyFinalModes()
    process.stdout.write('OPERATING_MODE PASS Welcome presents and persists only Player and Combined\n')
    await runWelcomeSharedMediaSetup()
    process.stdout.write('OPERATING_MODE PASS Welcome indexing and shared partial CSV report for both roles\n')
    await runConfigureLaterAfterInvalidCatalog()
    process.stdout.write('OPERATING_MODE PASS Configure later skips invalid CSV and preserves confirmed library data\n')
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
