// @ts-nocheck
export {}

// Isolated Electron recovery harness. Child processes instantiate the actual
// production playback, recovery, media protocol, library, and Chromium host.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

if (process.env.KQ_PLAYER_RECOVERY_E2E_MAIN === '1') {
  const { app, BrowserWindow, ipcMain, protocol } = require('electron')
  const projectRoot = process.env.KQ_PROJECT_ROOT
  const mediaRoot = process.env.KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR
  const profileRoot = process.env.KQ_PLAYER_RECOVERY_TEST_PROFILE
  const combinedMode = process.env.KQ_PLAYER_RECOVERY_TEST_COMBINED === '1'
  if (!projectRoot || !mediaRoot || !profileRoot) throw new Error('Recovery E2E requires the project, read-only media, and isolated profile paths.')

  const { registerPlayerMediaScheme, PlayerMediaProtocol } = require(path.join(projectRoot, 'build/src/player-media-protocol.js'))
  const { ChromiumPlaybackHost } = require(path.join(projectRoot, 'build/src/chromium-playback-host.js'))
  const { PlayerPlaybackService } = require(path.join(projectRoot, 'build/src/player-playback-service.js'))
  const { ManualPlaybackService } = require(path.join(projectRoot, 'build/src/manual-playback-service.js'))
  const { PlayerPlaybackRecoveryCoordinator } = require(path.join(projectRoot, 'build/src/player-playback-recovery.js'))
  const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build/src/player-playback-recovery-store.js'))
  const { VideoLibraryService } = require(path.join(projectRoot, 'build/src/video-library-service.js'))
  const { createKaraokeDatabase } = require(path.join(projectRoot, 'build/database.js'))

  registerPlayerMediaScheme(protocol)
  app.setPath('userData', profileRoot)
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  void app.whenReady().then(async () => {
    const library = new VideoLibraryService([mediaRoot])
    const inventory = await library.refresh()
    if (inventory.scanStatus !== 'ready' || !inventory.items?.some(item => item.musicCode === '01001')) {
      throw new Error('The read-only media directory must index video code 01001 before the recovery harness starts.')
    }
    const store = new PlayerPlaybackRecoveryStore(profileRoot)
    const recovery = new PlayerPlaybackRecoveryCoordinator(store)
    recovery.initialize()
    const mediaProtocol = new PlayerMediaProtocol(library)
    mediaProtocol.install(protocol)
    const database = combinedMode ? createKaraokeDatabase(profileRoot) : undefined
    const databaseBaseline = database ? database.loadState() : undefined
    const window = new BrowserWindow({
      width: 1000,
      height: 700,
      show: true,
      webPreferences: {
        preload: path.join(projectRoot, 'build/player-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    const allowedDocumentUrl = pathToFileURL(path.join(projectRoot, 'build/src/player-playback.html')).href
    const host = new ChromiumPlaybackHost(ipcMain, window.webContents, allowedDocumentUrl, async () => {
      if (!window.isDestroyed()) window.destroy()
      return window.isDestroyed()
    })
    const playback = new PlayerPlaybackService(library, mediaProtocol, recovery)
    const manual = new ManualPlaybackService(playback)
    recovery.attach(playback, manual)
    playback.attachHost(host)
    const events = []
    playback.subscribe(event => events.push(event))

    const api = {
      playback,
      manual,
      recovery,
      store,
      library,
      database,
      databaseBaseline,
      window,
      events,
      getSnapshot() {
        return {
          recovery: recovery.getState(),
          playback: playback.getState(),
          persisted: store.read(),
          commands: events.filter(event => event.type === 'state-changed').map(event => event.state.status),
          database: database?.loadState()
        }
      },
      async waitForState(status, attemptId, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const state = playback.getState()
          if (state.status === status && (!attemptId || state.attemptId === attemptId)) return state
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error(`Timed out waiting for playback state ${status}; current=${JSON.stringify(playback.getState())}`)
      },
      async waitForEvent(type, attemptId, timeoutMs) {
        const existing = events.find(event => event.type === type && (!attemptId || event.attemptId === attemptId))
        if (existing) return existing
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            unsubscribe()
            reject(new Error(`Timed out waiting for ${type}; timeout is not interpreted as natural EOF.`))
          }, timeoutMs)
          const unsubscribe = playback.subscribe(event => {
            if (event.type !== type || (attemptId && event.attemptId !== attemptId)) return
            clearTimeout(timer)
            unsubscribe()
            resolve(event)
          })
        })
      },
      crashRenderer() { window.webContents.forcefullyCrashRenderer() },
      async waitForRendererCrash(timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (window.webContents.isCrashed()) return true
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        return false
      },
      async shutdown() {
        manual.dispose()
        await playback.dispose()
        recovery.dispose()
        mediaProtocol.dispose(protocol)
        library.close()
        database?.close()
        if (!window.isDestroyed()) window.destroy()
      }
    }
    app.__kqPlayerRecoveryTest = api
    globalThis.__kqPlayerRecoveryTest = api
    await window.loadFile(path.join(projectRoot, 'build/src/player-playback.html'))
    await host.ready
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
} else {
  const projectRoot = path.resolve(__dirname, '../..')
  const mediaRoot = process.env.KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR
  if (!mediaRoot || !fs.existsSync(mediaRoot)) {
    process.stderr.write('NOT RUN: set KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR to the read-only original sample media directory. No fallback or copied library is used.\n')
    process.exitCode = 2
  } else {
    const code01001 = fs.readdirSync(mediaRoot, { recursive: true }).some(name =>
      typeof name === 'string' && /^01001(?:[ _-].*)?\.(?:mp4|mkv|webm|avi|mov|mpeg|mpg|wmv)$/i.test(path.basename(name)))
    if (!code01001) {
      process.stderr.write('NOT RUN: the read-only media directory does not contain an indexed 01001 sample.\n')
      process.exitCode = 2
    } else {
      run().catch(error => {
        process.stderr.write(`${error.stack || error}\n`)
        process.exitCode = 1
      })
    }
  }

  async function run() {
    const configuredTempRoot = process.env.KARAOKE_TEST_TEMP_ROOT
    const tempRoot = configuredTempRoot
      ? path.resolve(configuredTempRoot)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-playback-recovery-e2e-'))
    if (configuredTempRoot) {
      if (fs.existsSync(tempRoot)) throw new Error('The isolated recovery E2E root already exists.')
      fs.mkdirSync(tempRoot, { recursive: false })
    }
    process.stdout.write(`TEST_PROFILE_RUN ${path.basename(tempRoot)}\n`)
    const mainEntry = path.join(tempRoot, 'player-playback-recovery-main.cjs')
    fs.writeFileSync(mainEntry, `require(${JSON.stringify(__filename)})`)

    function createProfile(name) {
      const root = path.join(tempRoot, name)
      const userData = path.join(root, 'user-data')
      fs.mkdirSync(userData, { recursive: true })
      return { root, userData }
    }

    function launch(profile, combined = false) {
      return electron.launch({
        executablePath: require('electron'),
        args: [
          `--user-data-dir=${profile.userData}`,
          ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
          mainEntry
        ],
        env: {
          ...process.env,
          KQ_PLAYER_RECOVERY_E2E_MAIN: '1',
          KQ_PROJECT_ROOT: projectRoot,
          KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR: path.resolve(mediaRoot),
          KQ_PLAYER_RECOVERY_TEST_PROFILE: profile.userData,
          KQ_PLAYER_RECOVERY_TEST_COMBINED: combined ? '1' : '0'
        },
        timeout: 30000
      })
    }

    async function hook(app) {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await app.evaluate(({ app }) => {
        if (!app.__kqPlayerRecoveryTest) throw new Error('The production recovery harness did not initialize.')
      })
      return page
    }

    const snapshot = app => app.evaluate(({ app }) => app.__kqPlayerRecoveryTest.getSnapshot())
    const playCode = (app, code) => app.evaluate(async ({ app }, value) =>
      await app.__kqPlayerRecoveryTest.manual.playByMusicCode(value), code)
    const waitState = (app, status, attemptId, timeout = 15000) => app.evaluate(async ({ app }, args) =>
      app.__kqPlayerRecoveryTest.waitForState(args.status, args.attemptId, args.timeout), { status, attemptId, timeout })
    const waitEvent = (app, type, attemptId, timeout) => app.evaluate(async ({ app }, args) =>
      app.__kqPlayerRecoveryTest.waitForEvent(args.type, args.attemptId, args.timeout), { type, attemptId, timeout })
    const stopPlayback = app => app.evaluate(async ({ app }) => await app.__kqPlayerRecoveryTest.manual.stop())
    const recoveryAction = (app, action, attemptId, code) => app.evaluate(async ({ app }, args) =>
      await app.__kqPlayerRecoveryTest.recovery[args.action](args.attemptId, ...(args.code === undefined ? [] : [args.code])),
      { action, attemptId, code })

    async function stopGracefully(app) {
      if (!app) return
      try { await app.evaluate(async ({ app }) => await app.__kqPlayerRecoveryTest.shutdown()) } catch {}
      try { await app.evaluate(({ app }) => app.exit(0)) } catch {}
      await app.close().catch(() => {})
    }

    async function terminateAbruptly(app) {
      const child = app.process()
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
        if (result.status !== 0) throw new Error(`Could not terminate only the isolated recovery Electron tree: ${result.stderr || result.stdout}`)
      } else if (!child.kill('SIGKILL')) {
        throw new Error('Could not send SIGKILL to the isolated recovery Electron process.')
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Abruptly terminated isolated Electron did not exit.')), 15000)
        child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
      })
      await app.close().catch(() => {})
    }

    const playerProfile = createProfile('player-restart')
    const combinedProfile = createProfile('combined-preservation')
    let app
    let combinedApp
    try {
      // Player-only: abrupt process termination leaves a durable unresolved attempt.
      app = await launch(playerProfile)
      await hook(app)
      const first = await playCode(app, '1001')
      assert.equal(first.outcome, 'started')
      const firstAttempt = first.state.attemptId
      const firstActive = await snapshot(app)
      assert.equal(firstActive.persisted.status, 'playing')
      assert.equal(firstActive.persisted.attemptId, firstAttempt)
      assert.equal(fs.existsSync(path.join(playerProfile.userData, 'karaoke.sqlite')), false,
        'Player-only recovery must not create Controller operational SQLite')
      await terminateAbruptly(app)
      app = undefined

      app = await launch(playerProfile)
      await hook(app)
      let recovered = await snapshot(app)
      assert.equal(recovered.recovery.status, 'pending')
      assert.equal(recovered.recovery.attemptId, firstAttempt)
      assert.equal(recovered.playback.status, 'idle', 'a new process starts idle rather than autoplaying')
      assert.deepEqual(recovered.commands, [], 'startup does not send media commands')

      const replay = await recoveryAction(app, 'replayPrevious', firstAttempt)
      assert.equal(replay.outcome, 'started')
      assert.equal(replay.state.musicCode, '01001')
      assert.notEqual(replay.state.attemptId, firstAttempt, 'explicit replay creates a distinct engine attempt')
      const replayAttempt = replay.state.attemptId
      await waitState(app, 'playing', replayAttempt)
      const stopped = await stopPlayback(app)
      assert.equal(stopped.outcome, 'accepted')
      assert.equal(stopped.state.status, 'stopped')
      await stopGracefully(app)
      app = undefined

      app = await launch(playerProfile)
      await hook(app)
      recovered = await snapshot(app)
      assert.equal(recovered.recovery.status, 'resolved')
      assert.equal(recovered.recovery.outcome, 'stopped')
      assert.equal(recovered.playback.status, 'idle')
      assert.deepEqual(recovered.commands, [], 'confirmed Stop does not autoplay after restart')
      await stopGracefully(app)
      app = undefined

      // Natural EOF is observed from the real sample at normal playback speed.
      app = await launch(playerProfile)
      await hook(app)
      const natural = await playCode(app, '1001')
      assert.equal(natural.outcome, 'started')
      const naturalAttempt = natural.state.attemptId
      const ended = await waitEvent(app, 'natural-end-candidate', naturalAttempt, 260000)
      assert.equal(ended.attemptId, naturalAttempt)
      const completedSnapshot = await snapshot(app)
      assert.equal(completedSnapshot.persisted.status, 'completed')
      assert.equal(completedSnapshot.persisted.lastTransition, 'natural-end-confirmed')
      assert.equal(completedSnapshot.playback.status, 'completed')
      await stopGracefully(app)
      app = undefined

      app = await launch(playerProfile)
      await hook(app)
      recovered = await snapshot(app)
      assert.equal(recovered.recovery.status, 'resolved')
      assert.equal(recovered.recovery.outcome, 'completed')
      assert.equal(recovered.playback.status, 'idle')
      assert.deepEqual(recovered.commands, [], 'a completed song is not replayed after restart')
      await stopGracefully(app)
      app = undefined

      // Combined mode: a Player Renderer failure is recoverable without changing Controller SQLite.
      seedCombinedDatabase(combinedProfile.userData)
      const baseline = readOperationalRows(path.join(combinedProfile.userData, 'karaoke.sqlite'))
      combinedApp = await launch(combinedProfile, true)
      const combinedPage = await hook(combinedApp)
      const combinedBaseline = await combinedApp.evaluate(({ app }) => app.__kqPlayerRecoveryTest.databaseBaseline)
      assert.deepEqual(combinedBaseline, await combinedApp.evaluate(({ app }) => app.__kqPlayerRecoveryTest.database.loadState()))
      const combinedStart = await playCode(combinedApp, '1001')
      assert.equal(combinedStart.outcome, 'started')
      const combinedAttempt = combinedStart.state.attemptId
      await combinedApp.evaluate(({ app }) => app.__kqPlayerRecoveryTest.crashRenderer())
      assert.equal(await combinedApp.evaluate(({ app }) => app.__kqPlayerRecoveryTest.waitForRendererCrash()), true)
      await waitState(combinedApp, 'uncertain', combinedAttempt)
      const afterCrash = await snapshot(combinedApp)
      assert.equal(afterCrash.recovery.status, 'pending')
      assert.equal(afterCrash.persisted.status, 'uncertain')
      assert.deepEqual(afterCrash.database, combinedBaseline, 'Player crash must not mutate Combined Controller session/queue')
      assert.deepEqual(readOperationalRows(path.join(combinedProfile.userData, 'karaoke.sqlite')), baseline)
      await stopGracefully(combinedApp)
      combinedApp = undefined

      combinedApp = await launch(combinedProfile, true)
      await hook(combinedApp)
      const combinedRestart = await snapshot(combinedApp)
      assert.equal(combinedRestart.recovery.status, 'pending')
      assert.equal(combinedRestart.playback.status, 'idle')
      assert.deepEqual(combinedRestart.commands, [])
      assert.deepEqual(combinedRestart.database, combinedBaseline)
      assert.deepEqual(readOperationalRows(path.join(combinedProfile.userData, 'karaoke.sqlite')), baseline)
      const pendingAttempt = combinedRestart.recovery.attemptId
      const dismissed = await recoveryAction(combinedApp, 'leaveStopped', pendingAttempt)
      assert.equal(dismissed.status, 'resolved')
      assert.equal(dismissed.outcome, 'dismissed')
      assert.deepEqual((await snapshot(combinedApp)).database, combinedBaseline)
      await stopGracefully(combinedApp)
      combinedApp = undefined

      process.stdout.write('PASS Player recovery Electron E2E: abrupt termination, pending without autoplay, explicit replay with new attempt, confirmed Stop/restart, natural EOF/restart, and Combined database preservation after Renderer crash.\n')
    } finally {
      await stopGracefully(app)
      await stopGracefully(combinedApp)
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  }

  function seedCombinedDatabase(userDataPath) {
    const { createKaraokeDatabase } = require(path.join(projectRoot, 'build/database.js'))
    const database = createKaraokeDatabase(userDataPath)
    try {
      database.saveState({
        queue: [{ id: 'recovery-pending-entry', name: 'Test Singer', songNumber: '1001', songNumber2: '',
          table: '1', insertedAt: 100, status: 'pending', sessionId: 'recovery-active-session' }],
        history: [],
        sessions: [{ id: 'recovery-active-session', startedAt: 50, endedAt: null }],
        currentSessionId: 'recovery-active-session', priorityIds: [], fixedTurnPositions: {}, frozenTurnIds: [],
        queueOrderPolicyVersion: 2, regularsSinceDebut: 0, currentTurnAutomatic: false,
        nextTurnId: null, currentTurnId: 'recovery-pending-entry', lastReset: null
      })
    } finally { database.close() }
  }

  function readOperationalRows(databasePath) {
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      return {
        appState: database.prepare('SELECT * FROM app_state ORDER BY singleton').all(),
        entries: database.prepare('SELECT * FROM entries ORDER BY id').all(),
        sessions: database.prepare('SELECT * FROM sessions ORDER BY session_order').all()
      }
    } finally { database.close() }
  }
}
