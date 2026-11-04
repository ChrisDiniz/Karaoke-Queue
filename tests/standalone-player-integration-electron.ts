// @ts-nocheck
export {}

// Isolated B4.2 composition: B2 intent -> real Preload/IPC -> B1 sequence ->
// shared PlayerPlaybackService -> Chromium host. It never starts main.ts.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { _electron: electron } = require('playwright')

if (process.env.KQ_STANDALONE_INTEGRATION_E2E_MAIN === '1') {
  const { app, BrowserWindow, ipcMain, protocol } = require('electron')
  const projectRoot = process.env.KQ_PROJECT_ROOT
  const mediaRoot = process.env.KQ_PLAYER_TEST_MEDIA_DIR
  const profileRoot = process.env.KQ_PLAYER_TEST_PROFILE
  const controlDocument = process.env.KQ_STANDALONE_CONTROL_HTML
  const scenario = process.env.KQ_STANDALONE_INTEGRATION_SCENARIO
  if (!projectRoot || !mediaRoot || !profileRoot || !controlDocument ||
      !['fresh', 'relaunch', 'invalid-recovery'].includes(scenario)) {
    throw new Error('Standalone integration E2E requires isolated paths and a supported scenario.')
  }

  const { registerPlayerMediaScheme, PlayerMediaProtocol } = require(path.join(projectRoot, 'build/src/player-media-protocol.js'))
  const { ChromiumPlaybackHost } = require(path.join(projectRoot, 'build/src/chromium-playback-host.js'))
  const { PlayerPlaybackRecoveryCoordinator } = require(path.join(projectRoot, 'build/src/player-playback-recovery.js'))
  const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build/src/player-playback-recovery-store.js'))
  const { VideoLibraryService } = require(path.join(projectRoot, 'build/src/video-library-service.js'))
  const { createStandalonePlayerWithSharedPlayback } = require(path.join(projectRoot, 'build/src/standalone-player-playback-adapter.js'))
  const { installStandalonePlayerMainIpcBridge } = require(path.join(projectRoot, 'build/src/standalone-player-ipc.js'))

  registerPlayerMediaScheme(protocol)
  app.setPath('userData', profileRoot)
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  void app.whenReady().then(async () => {
    const library = new VideoLibraryService([mediaRoot])
    await library.refresh()
    const mediaProtocol = new PlayerMediaProtocol(library)
    mediaProtocol.install(protocol)
    const playbackDocument = path.join(projectRoot, 'build/src/player-playback.html')
    const hostWindow = new BrowserWindow({
      width: 1000, height: 700, show: true, backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(projectRoot, 'build/player-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true
      }
    })
    const host = new ChromiumPlaybackHost(
      ipcMain,
      hostWindow.webContents,
      pathToFileURL(playbackDocument).href,
      async () => {
        if (!hostWindow.isDestroyed()) hostWindow.destroy()
        return hostWindow.isDestroyed()
      }
    )
    const recoveryStore = new PlayerPlaybackRecoveryStore(profileRoot)
    if (scenario === 'invalid-recovery' && !fs.existsSync(recoveryStore.filePath)) {
      fs.writeFileSync(recoveryStore.filePath, '{"version":1,"status":"playing"}')
    }
    const recovery = new PlayerPlaybackRecoveryCoordinator(recoveryStore)
    const sequence = await createStandalonePlayerWithSharedPlayback({
      library,
      mediaSources: mediaProtocol,
      host,
      recovery,
      disposeMediaSources: () => mediaProtocol.dispose(protocol)
    })
    const playback = sequence.composition?.playback
    if (!playback) throw new Error('The Standalone composition must own the shared PlayerPlaybackService.')

    const naturalEndAppliedAttempts = new Set()
    const naturalEndWaiters = new Map()
    const originalHandleNaturalEnd = sequence.handleNaturalEndEvent.bind(sequence)
    sequence.handleNaturalEndEvent = (event, current, context) => {
      originalHandleNaturalEnd(event, current, context)
      const reservation = sequence.reservation
      if (reservation?.kind !== 'next' || !reservation.naturalEndObserved ||
          reservation.previous?.attemptId !== event.attemptId || current.attemptId !== event.attemptId) return
      naturalEndAppliedAttempts.add(event.attemptId)
      for (const resolve of naturalEndWaiters.get(event.attemptId) ?? []) resolve(event.attemptId)
      naturalEndWaiters.delete(event.attemptId)
    }
    const waitForNaturalEndAppliedDuringNext = attemptId => {
      if (naturalEndAppliedAttempts.has(attemptId)) return Promise.resolve(attemptId)
      return new Promise((resolve, reject) => {
        const waiters = naturalEndWaiters.get(attemptId) ?? []
        let timer
        const waiter = value => {
          clearTimeout(timer)
          resolve(value)
        }
        timer = setTimeout(() => {
          const pending = naturalEndWaiters.get(attemptId) ?? []
          const remaining = pending.filter(candidate => candidate !== waiter)
          if (remaining.length) naturalEndWaiters.set(attemptId, remaining)
          else naturalEndWaiters.delete(attemptId)
          reject(new Error('Timed out waiting for the Main sequence to apply the natural end during Next.'))
        }, 15000)
        waiters.push(waiter)
        naturalEndWaiters.set(attemptId, waiters)
      })
    }

    const playbackCalls = []
    const playbackEvents = []
    const originalPlayImmediately = playback.playImmediately.bind(playback)
    playback.playImmediately = async (code, validateBeforeCommit) => {
      playbackCalls.push(code)
      const barrier = startBarrier
      if (barrier && barrier.code === code && !barrier.claimed) {
        barrier.claimed = true
        barrier.startedResolve()
        await barrier.releasePromise
      }
      return originalPlayImmediately(code, validateBeforeCommit)
    }
    const stopOriginal = playback.stop.bind(playback)
    let stopBarrier
    let startBarrier
    playback.stop = async expectedAttemptId => {
      const barrier = stopBarrier
      if (!barrier || barrier.claimed) return stopOriginal(expectedAttemptId)
      barrier.claimed = true
      barrier.startedResolve()
      await barrier.releasePromise
      return stopOriginal(expectedAttemptId)
    }
    const unsubscribePlaybackEvents = playback.subscribe(event => playbackEvents.push({
      type: event.type,
      ...('attemptId' in event ? { attemptId: event.attemptId } : {})
    }))

    const bridges = new Set()
    let controlWindow
    let controlWindowClosedPromise
    const createControlWindow = async () => {
      const window = new BrowserWindow({
        width: 640, height: 400, show: true,
        webPreferences: {
          preload: path.join(projectRoot, 'build/standalone-player-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true
        }
      })
      const bridge = installStandalonePlayerMainIpcBridge({
        ipcMain,
        webContents: window.webContents,
        expectedDocumentUrl: pathToFileURL(controlDocument).href,
        control: sequence
      })
      bridges.add(bridge)
      controlWindow = window
      controlWindowClosedPromise = new Promise(resolve => {
        window.once('closed', () => {
          bridge.dispose()
          bridges.delete(bridge)
          if (controlWindow === window) controlWindow = undefined
          resolve(true)
        })
      })
      await window.loadFile(controlDocument)
      return window
    }
    await createControlWindow()
    await Promise.all([hostWindow.loadFile(playbackDocument), host.ready])

    const waitForSnapshot = (expected, timeoutMs = 20000) => new Promise((resolve, reject) => {
      const matches = snapshot => {
        if (expected.playbackCondition && snapshot.playbackCondition !== expected.playbackCondition) return false
        if (expected.operationalState &&
            (snapshot.playbackCondition !== 'ready' || snapshot.state.operationalState !== expected.operationalState)) return false
        if (Object.hasOwn(expected, 'musicCode') &&
            (snapshot.playbackCondition !== 'ready' || snapshot.state.current?.musicCode !== expected.musicCode)) return false
        if (expected.pendingCodes) {
          const pending = snapshot.playbackCondition === 'ready' ? snapshot.state.pending : snapshot.pending
          if (JSON.stringify(pending.map(entry => entry.musicCode)) !== JSON.stringify(expected.pendingCodes)) return false
        }
        return true
      }
      let settled = false
      let unsubscribe = () => undefined
      const finish = (error, snapshot) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        if (error) reject(error)
        else resolve(snapshot)
      }
      const check = snapshot => { if (matches(snapshot)) finish(undefined, snapshot) }
      const timer = setTimeout(() => finish(new Error('Timed out waiting for the expected Standalone state.')), timeoutMs)
      unsubscribe = sequence.subscribe(check)
      check(sequence.getSnapshot())
    })
    const waitForPlaybackStatus = (status, attemptId, timeoutMs = 15000) => new Promise((resolve, reject) => {
      let unsubscribe = () => undefined
      const finish = (error, state) => {
        clearTimeout(timer)
        unsubscribe()
        if (error) reject(error)
        else resolve(state)
      }
      const check = () => {
        const state = playback.getState()
        if (state.attemptId !== attemptId) finish(new Error('Playback attempt changed before the expected confirmation.'))
        else if (state.status === status) finish(undefined, state)
        else if (['failed', 'uncertain', 'disposed', 'stopped'].includes(state.status)) finish(new Error(`Playback entered ${state.status}.`))
      }
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for playback status ${status}.`)), timeoutMs)
      unsubscribe = playback.subscribe(event => { if (event.type === 'state-changed') check() })
      check()
    })
    const waitForRendererCrash = (target, timeoutMs = 15000) => new Promise((resolve, reject) => {
      if (target.webContents.isCrashed()) { resolve(true); return }
      const onGone = () => { clearTimeout(timer); target.webContents.removeListener('render-process-gone', onGone); resolve(true) }
      const timer = setTimeout(() => {
        target.webContents.removeListener('render-process-gone', onGone)
        reject(new Error('Timed out waiting for the isolated Chromium Renderer to crash.'))
      }, timeoutMs)
      target.webContents.once('render-process-gone', onGone)
    })
    const readHostVideo = () => hostWindow.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('video')
      return video ? { paused: video.paused, ended: video.ended, currentTime: video.currentTime,
        duration: video.duration, width: video.videoWidth, height: video.videoHeight,
        readyState: video.readyState, error: video.error?.code ?? null } : null
    })()`)
    const waitForHostVideoPlaying = () => hostWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Timed out waiting for real Chromium playback.')), 15000)
      let observer
      const finish = (error, value) => { clearTimeout(timeout); observer?.disconnect(); if (error) reject(error); else resolve(value) }
      const check = () => {
        const video = document.querySelector('video')
        if (video && video.readyState >= 2 && !video.paused && video.currentTime > 0.1 && video.duration > 0 && video.videoWidth > 0 && video.videoHeight > 0) {
          finish(null, { currentTime: video.currentTime, duration: video.duration, width: video.videoWidth, height: video.videoHeight })
        } else if (video) {
          video.addEventListener('playing', check, { once: true })
          video.addEventListener('timeupdate', check, { once: true })
          video.addEventListener('loadedmetadata', check, { once: true })
        }
      }
      observer = new MutationObserver(check)
      observer.observe(document.documentElement, { childList: true, subtree: true })
      check()
    })`)
    const waitForHostMediaEnd = () => hostWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Timed out waiting for the real HTMLMediaElement ended event.')), 15000)
      const video = document.querySelector('video')
      const finish = (error, value) => { clearTimeout(timeout); video?.removeEventListener('ended', onEnded); if (error) reject(error); else resolve(value) }
      const onEnded = () => finish(null, { ended: video.ended, currentTime: video.currentTime, duration: video.duration })
      if (!video || video.paused || video.readyState < 2 || !Number.isFinite(video.duration) || video.duration <= 2) {
        finish(new Error('A playing real MP4 with known duration is required before observing natural EOF.'))
        return
      }
      video.addEventListener('ended', onEnded, { once: true })
      video.currentTime = Math.max(0, video.duration - 0.65)
    })`)
    const waitForHostMediaCleared = () => hostWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Timed out waiting for final media cleanup.')), 10000)
      let observer
      const finish = error => { clearTimeout(timeout); observer?.disconnect(); if (error) reject(error); else resolve(true) }
      const check = () => { if (!document.querySelector('video')) finish(null) }
      observer = new MutationObserver(check)
      observer.observe(document.documentElement, { childList: true, subtree: true })
      check()
    })`)
    const waitForHostTimeAfter = value => hostWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Timed out waiting for resumed media time.')), 5000)
      let observer
      const finish = (error, time) => { clearTimeout(timeout); observer?.disconnect(); video?.removeEventListener('timeupdate', check); if (error) reject(error); else resolve(time) }
      const video = document.querySelector('video')
      const check = () => { if (video && video.currentTime > ${Number(value)}) finish(null, video.currentTime) }
      if (!video) { finish(new Error('No video is loaded.')); return }
      video.addEventListener('timeupdate', check)
      check()
    })`)
    const waitForHostRestart = () => hostWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Timed out observing the restarted media clock.')), 10000)
      const video = document.querySelector('video')
      const finish = (error, value) => { clearTimeout(timeout); video?.removeEventListener('timeupdate', check); if (error) reject(error); else resolve(value) }
      const check = () => { if (video && !video.paused && video.currentTime < 3) finish(null, video.currentTime) }
      if (!video) { finish(new Error('No video is loaded after restart.')); return }
      video.addEventListener('timeupdate', check)
      check()
    })`)
    const crashHost = async () => {
      const crashed = waitForRendererCrash(hostWindow)
      hostWindow.webContents.forcefullyCrashRenderer()
      return crashed
    }

    let shutdownPromise
    app.__kqStandaloneIntegrationTest = {
      waitForSnapshot,
      waitForNaturalEndAppliedDuringNext,
      waitForPlaybackStatus,
      crashHostRenderer: crashHost,
      waitForHostRendererCrash: () => hostWindow.webContents.isCrashed() ? Promise.resolve(true) : waitForRendererCrash(hostWindow),
      getHostVideoState: readHostVideo,
      waitForHostVideoPlaying,
      waitForHostMediaEnd,
      waitForHostMediaCleared,
      waitForHostTimeAfter,
      waitForHostRestart,
      getSequenceSnapshot: () => sequence.getSnapshot(),
      getRecoveryState: () => recovery.getState(),
      getRecoveryDiagnostic: () => recovery.getDiagnosticSummary(),
      getRecoveryRecord: () => recoveryStore.read(),
      getPlaybackEvents: () => [...playbackEvents],
      getPlaybackCalls: () => [...playbackCalls],
      holdStop: () => {
        if (stopBarrier) throw new Error('A Stop barrier is already active.')
        let releaseResolve, startedResolve
        const releasePromise = new Promise(resolve => { releaseResolve = resolve })
        const startedPromise = new Promise(resolve => { startedResolve = resolve })
        stopBarrier = { releasePromise, releaseResolve, startedPromise, startedResolve, claimed: false }
      },
      waitForStop: () => stopBarrier?.startedPromise ?? Promise.reject(new Error('No Stop barrier is active.')),
      releaseStop: () => { const current = stopBarrier; stopBarrier = undefined; current?.releaseResolve() },
      holdStart: code => {
        if (startBarrier) throw new Error('A playback start barrier is already active.')
        let releaseResolve, startedResolve
        const releasePromise = new Promise(resolve => { releaseResolve = resolve })
        const startedPromise = new Promise(resolve => { startedResolve = resolve })
        startBarrier = { code, releasePromise, releaseResolve, startedPromise, startedResolve, claimed: false }
      },
      waitForStart: () => startBarrier?.startedPromise ?? Promise.reject(new Error('No start barrier is active.')),
      releaseStart: () => { const current = startBarrier; startBarrier = undefined; current?.releaseResolve() },
      closeControlWindow: async () => {
        const window = controlWindow
        const closed = controlWindowClosedPromise
        if (window && !window.isDestroyed()) window.close()
        if (window && closed) {
          let timer
          try {
            await Promise.race([
              closed,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Control window did not close.')), 10000)
              })
            ])
          } finally {
            clearTimeout(timer)
          }
        }
        return { bridgeCount: bridges.size }
      },
      recreateControlWindow,
      getHostWindowDestroyed: () => hostWindow.isDestroyed(),
      shutdown: async () => {
        if (shutdownPromise) return shutdownPromise
        shutdownPromise = (async () => {
          stopBarrier?.releaseResolve()
          startBarrier?.releaseResolve()
          stopBarrier = undefined
          startBarrier = undefined
          for (const bridge of bridges) bridge.dispose()
          bridges.clear()
          unsubscribePlaybackEvents()
          await sequence.dispose()
          if (controlWindow && !controlWindow.isDestroyed()) controlWindow.destroy()
          if (!hostWindow.isDestroyed()) hostWindow.destroy()
          return {
            recovery: scenario === 'invalid-recovery' ? null : recoveryStore.read(),
            recoveryState: recovery.getState(),
            hostDisposed: host.disposed === true,
            bridgeCount: bridges.size,
            controllerDatabaseExists: fs.existsSync(path.join(profileRoot, 'karaoke.sqlite'))
          }
        })()
        return shutdownPromise
      }
    }
    async function recreateControlWindow() {
      if (controlWindow && !controlWindow.isDestroyed()) throw new Error('The old control window must be destroyed before replacement.')
      await createControlWindow()
      return { bridgeCount: bridges.size, url: pathToFileURL(controlDocument).href }
    }
    globalThis.__kqStandaloneIntegrationTest = app.__kqStandaloneIntegrationTest
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
} else {
  const projectRoot = path.resolve(__dirname, '../..')
  const mediaRoot = process.env.KQ_PLAYER_TEST_MEDIA_DIR
  if (!mediaRoot || !fs.existsSync(mediaRoot)) throw new Error('Defina KQ_PLAYER_TEST_MEDIA_DIR para amostras MP4 reais somente leitura.')
  const samples = ['01001.mp4', '01002.mp4', '01003.mp4', '01004.mp4', '01005.mp4', '01006.mp4', '01008.mp4']
  for (const name of samples) assert.ok(fs.existsSync(path.join(mediaRoot, name)), `A amostra ${name} precisa existir.`)

  const tempRoot = process.env.KARAOKE_TEST_TEMP_ROOT
    ? path.resolve(process.env.KARAOKE_TEST_TEMP_ROOT)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-integration-e2e-'))
  if (process.env.KARAOKE_TEST_TEMP_ROOT) {
    if (fs.existsSync(tempRoot)) throw new Error('A raiz temporária isolada já existe: ' + tempRoot)
    fs.mkdirSync(tempRoot, { recursive: false })
  }
  const profileRoot = path.join(tempRoot, 'profile')
  const controlHtml = path.join(tempRoot, 'standalone-control-test.html')
  const mainEntry = path.join(tempRoot, 'standalone-integration-main.cjs')
  fs.mkdirSync(profileRoot)
  fs.writeFileSync(controlHtml, '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
  fs.writeFileSync(mainEntry, `require(${JSON.stringify(__filename)})`)

  async function hashSamples() {
    const result = new Map()
    for (const name of samples) {
      const hash = crypto.createHash('sha256')
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(path.join(mediaRoot, name))
        stream.on('error', reject)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('end', resolve)
      })
      result.set(name, hash.digest('hex'))
    }
    return result
  }

  async function launch(scenario, useExistingProfile = false) {
    const app = await electron.launch({
      executablePath: require('electron'),
      args: [`--user-data-dir=${profileRoot}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : []), mainEntry],
      env: {
        ...process.env,
        KQ_STANDALONE_INTEGRATION_E2E_MAIN: '1',
        KQ_STANDALONE_INTEGRATION_SCENARIO: scenario,
        KQ_PROJECT_ROOT: projectRoot,
        KQ_PLAYER_TEST_MEDIA_DIR: path.resolve(mediaRoot),
        KQ_PLAYER_TEST_PROFILE: profileRoot,
        KQ_STANDALONE_CONTROL_HTML: controlHtml
      },
      timeout: 30000
    })
    try {
      await app.firstWindow()
      const pages = await app.windows()
      await Promise.all(pages.map(page => page.waitForLoadState('domcontentloaded')))
      let controlPage = pages.find(page => page.url().includes(path.basename(controlHtml)))
      if (!controlPage) throw new Error('Expected isolated control window; attached=' + JSON.stringify(pages.map(page => page.url())))
      await controlPage.waitForFunction(() => typeof window.standalonePlayer?.execute === 'function')
      return { app, controlPage, scenario }
    } catch (error) { await app.close(); throw error }
  }

  function makeInteraction(context) {
    const { StandalonePlayerInteractionController } = require(path.join(projectRoot, 'build/src/standalone-player-interaction.js'))
    const { StandalonePlayerInteractionTransport } = require(path.join(projectRoot, 'build/src/standalone-player-interaction-transport.js'))
    let id = 0
    const scheduler = { schedule: () => ({}), cancel: () => undefined }
    const interaction = new StandalonePlayerInteractionController({
      scheduler,
      digitPanelInactivityMs: 10000,
      createOperationId: () => `b42-${++id}`
    })
    const api = { execute: request => context.controlPage.evaluate(value => window.standalonePlayer.execute(value), request) }
    const transport = new StandalonePlayerInteractionTransport(interaction, api)
    return {
      interaction,
      transport,
      key: key => interaction.handleKeyStroke(key),
      async code(value, priority = 'normal', duplicate = false) {
        for (const digit of value) interaction.handleKeyStroke({ key: digit })
        const intent = interaction.handleKeyStroke({ key: priority === 'priority' ? 'p' : 'Enter' })
        if (!intent) throw new Error('B2 did not emit an intent for a non-empty code.')
        const operation = transport.dispatch(intent)
        if (!duplicate) return { intent, reply: await operation, status: interaction.getSnapshot().lastSubmission }
        const retry = transport.dispatch(intent)
        const [firstReply, retryReply] = await Promise.all([operation, retry])
        return { intent, reply: firstReply, retryReply, status: interaction.getSnapshot().lastSubmission }
      },
      async command(stroke) {
        const intent = interaction.handleKeyStroke(stroke)
        if (!intent) throw new Error('B2 did not emit the expected V1 command.')
        const result = await transport.dispatch(intent)
        return { intent, reply: result, status: interaction.getSnapshot().lastSubmission }
      },
      async dispatch(intent) { return transport.dispatch(intent) }
    }
  }

  async function subscribe(page) {
    await page.evaluate(async () => {
      window.__standaloneUpdates = []
      window.__standaloneSubscription = await window.standalonePlayer.subscribe(envelope => window.__standaloneUpdates.push(envelope))
    })
    return page.evaluate(() => window.__standaloneUpdates[0])
  }

  async function waitSnapshot(page, expected) {
    await page.waitForFunction(value => window.__standaloneUpdates.some(envelope => {
      const snapshot = envelope.snapshot
      if (value.playbackCondition && snapshot.playbackCondition !== value.playbackCondition) return false
      if (value.operationalState && (snapshot.playbackCondition !== 'ready' || snapshot.state.operationalState !== value.operationalState)) return false
      if (value.musicCode && (snapshot.playbackCondition !== 'ready' || snapshot.state.current?.musicCode !== value.musicCode)) return false
      return true
    }), expected, { timeout: 20000 })
    return page.evaluate(value => window.__standaloneUpdates.findLast(envelope => {
      const snapshot = envelope.snapshot
      return (!value.playbackCondition || snapshot.playbackCondition === value.playbackCondition) &&
        (!value.operationalState || (snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === value.operationalState)) &&
        (!value.musicCode || (snapshot.playbackCondition === 'ready' && snapshot.state.current?.musicCode === value.musicCode))
    }), expected)
  }

  async function videoState(context) {
    return call(context.app, 'getHostVideoState')
  }

  async function waitVideoPlaying(context) {
    return call(context.app, 'waitForHostVideoPlaying')
  }

  async function endRealMediaNaturally(context) {
    const event = await call(context.app, 'waitForHostMediaEnd')
    assert.ok(event.currentTime >= event.duration - 0.65, 'Chromium must deliver a real HTMLMediaElement ended event from the final media segment')
    return event
  }

  async function call(app, method, ...args) {
    return app.evaluate(async ({ app }, values) => await app.__kqStandaloneIntegrationTest[values[0]](...values.slice(1)), [method, ...args])
  }

  async function shutdown(context) {
    if (!context || context.closed) return context?.shutdownState
    let error
    try { await call(context.app, 'releaseStop') } catch (failure) { error = failure }
    try { await call(context.app, 'releaseStart') } catch (failure) { error ??= failure }
    try { context.shutdownState = await call(context.app, 'shutdown') } catch (failure) { error ??= failure }
    context.closed = true
    const child = context.app.process()
    try { await context.app.close() } catch (failure) { error ??= failure }
    if (child.exitCode === null && child.signalCode === null) error ??= new Error('The isolated Electron process did not exit.')
    if (error) throw error
    return context.shutdownState
  }

  async function runFreshIntegration() {
    const context = await launch('fresh')
    const client = makeInteraction(context)
    try {
      const exposure = await context.controlPage.evaluate(() => ({
        api: typeof window.standalonePlayer, karaokePlayer: typeof window.karaokePlayer,
        require: typeof window.require, ipcRenderer: typeof window.ipcRenderer
      }))
      assert.deepEqual(exposure, { api: 'object', karaokePlayer: 'undefined', require: 'undefined', ipcRenderer: 'undefined' })
      const initial = await subscribe(context.controlPage)
      assert.equal(initial.snapshot.state.operationalState, 'idle')
      assert.equal(initial.revision, 0)

      const urlPolicy = await context.controlPage.evaluate(async () => {
        location.hash = '#local-menu-state'
        try { await window.standalonePlayer.getSnapshot(); return 'allowed' }
        catch (error) { return error.message }
      })
      assert.equal(urlPolicy, 'STANDALONE_IPC_FORBIDDEN', 'same-origin fragment navigation is rejected by the exact-document policy')
      await context.controlPage.goto(pathToFileURL(controlHtml).href)
      await context.controlPage.waitForFunction(() => typeof window.standalonePlayer?.getSnapshot === 'function')
      await context.controlPage.goto(`${pathToFileURL(controlHtml).href}?local-menu-state=1`)
      await context.controlPage.waitForFunction(() => typeof window.standalonePlayer?.getSnapshot === 'function')
      const queryPolicy = await context.controlPage.evaluate(async () => {
        try { await window.standalonePlayer.getSnapshot(); return 'allowed' }
        catch (error) { return error.message }
      })
      assert.equal(queryPolicy, 'STANDALONE_IPC_FORBIDDEN', 'a same-file query variation is rejected by the exact-document policy')
      await context.controlPage.goto(pathToFileURL(controlHtml).href)
      await context.controlPage.waitForFunction(() => typeof window.standalonePlayer?.getSnapshot === 'function')
      await subscribe(context.controlPage)

      const invalid = await client.code('99999')
      assert.equal(invalid.reply.outcome, 'rejected')
      assert.equal(invalid.status.outcome, 'rejected')
      assert.equal((await context.controlPage.evaluate(() => window.standalonePlayer.getSnapshot())).snapshot.state.operationalState, 'idle')

      const first = await client.code('1001', 'normal', true)
      assert.equal(first.reply.outcome, 'confirmed')
      assert.equal(first.retryReply.outcome, 'confirmed')
      assert.equal(first.retryReply.operationId, first.intent.request.operationId)
      assert.equal(first.status.outcome, 'confirmed')
      assert.equal((await call(context.app, 'getPlaybackCalls')).filter(code => code === '01001').length, 1,
        'same operationId retry across real IPC starts the initial attempt only once')
      const firstEnvelope = await waitSnapshot(context.controlPage, { playbackCondition: 'ready', operationalState: 'playing', musicCode: '01001' })
      const firstAttemptId = firstEnvelope.snapshot.state.current.attemptId
      const firstEntryId = firstEnvelope.snapshot.state.current.entryId
      const firstVideo = await waitVideoPlaying(context)
      assert.ok(firstVideo.duration > 0 && firstVideo.width > 0 && firstVideo.height > 0,
        'Chromium decodes the real 01001.mp4 without any CSV configuration')

      for (const [code, priority] of [['1002', 'normal'], ['1003', 'normal'], ['1004', 'priority'], ['1005', 'priority']]) {
        const added = await client.code(code, priority)
        assert.equal(added.reply.outcome, 'confirmed')
        assert.equal(added.status.outcome, 'confirmed')
      }
      let snapshot = (await context.controlPage.evaluate(() => window.standalonePlayer.getSnapshot())).snapshot
      assert.deepEqual(snapshot.state.pending.map(entry => entry.musicCode), ['01005', '01004', '01002', '01003'])
      assert.equal(snapshot.state.current.attemptId, firstAttemptId, 'admissions never interrupt current playback')

      const paused = await client.command({ key: ' ' })
      assert.equal(paused.reply.outcome, 'confirmed')
      snapshot = await call(context.app, 'getSequenceSnapshot')
      assert.equal(snapshot.state.operationalState, 'paused')
      const pausedVideo = await videoState(context)
      assert.equal(pausedVideo.paused, true)
      const pausedAt = pausedVideo.currentTime
      const addedWhilePaused = await client.code('1006')
      assert.equal(addedWhilePaused.reply.outcome, 'confirmed')
      assert.equal((await videoState(context)).paused, true, 'admission while paused does not resume the host')
      assert.equal((await call(context.app, 'getSequenceSnapshot')).state.current.attemptId, firstAttemptId)

      const resumed = await client.command({ key: ' ' })
      assert.equal(resumed.reply.outcome, 'confirmed')
      await call(context.app, 'waitForHostTimeAfter', pausedAt)
      const restarted = await client.command({ key: 'r' })
      assert.equal(restarted.reply.outcome, 'confirmed')
      snapshot = await call(context.app, 'getSequenceSnapshot')
      assert.equal(snapshot.state.current.entryId, firstEntryId)
      assert.notEqual(snapshot.state.current.attemptId, firstAttemptId)
      const restartAttemptId = snapshot.state.current.attemptId
      await call(context.app, 'waitForHostRestart')

      const playingTimeBeforeReload = (await videoState(context)).currentTime
      const oldRevision = await context.controlPage.evaluate(() => window.__standaloneUpdates.at(-1).revision)
      await context.controlPage.reload()
      await context.controlPage.waitForFunction(() => typeof window.standalonePlayer?.subscribe === 'function')
      const afterReload = await subscribe(context.controlPage)
      assert.ok(afterReload.revision >= oldRevision)
      assert.equal(afterReload.snapshot.state.current.attemptId, restartAttemptId,
        'Renderer reload reconnects to the same Main-owned session and attempt')
      assert.ok((await videoState(context)).currentTime >= playingTimeBeforeReload,
        'Renderer reload does not restart or stop playback in the separately owned host')
      const revisions = await context.controlPage.evaluate(() => window.__standaloneUpdates.map(item => item.revision))
      assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]))

      const naturalBeforeNext = (await call(context.app, 'getPlaybackEvents')).filter(event => event.type === 'natural-end-candidate').length
      const next = await client.command({ key: 'ArrowRight', ctrlKey: true })
      assert.equal(next.reply.outcome, 'confirmed')
      snapshot = await call(context.app, 'getSequenceSnapshot')
      assert.equal(snapshot.state.current.musicCode, '01005')
      assert.equal((await call(context.app, 'getPlaybackEvents')).filter(event => event.type === 'natural-end-candidate').length, naturalBeforeNext,
        'manual Next uses confirmed Stop and does not manufacture a natural EOF')

      const raceAttemptId = snapshot.state.current.attemptId
      await call(context.app, 'holdStop')
      const racingNext = client.command({ key: 'ArrowRight', ctrlKey: true })
      await call(context.app, 'waitForStop')
      const realEnded = await endRealMediaNaturally(context)
      assert.equal(realEnded.ended, true)
      assert.equal(await call(context.app, 'waitForNaturalEndAppliedDuringNext', raceAttemptId), raceAttemptId,
        'the real ended observation reached the Main sequence and marked EOF during the reserved Next before Stop was released')
      await call(context.app, 'releaseStop')
      const racingResult = await racingNext
      assert.equal(racingResult.reply.outcome, 'confirmed')
      snapshot = await call(context.app, 'getSequenceSnapshot')
      assert.equal(snapshot.state.current.musicCode, '01004', 'real Chromium EOF racing with IPC Next produces one queue advance')
      assert.deepEqual(snapshot.state.pending.map(entry => entry.musicCode), ['01002', '01003', '01006'])

      for (const [current, nextCode] of [['01004', '01002'], ['01002', '01003'], ['01003', '01006']]) {
        await endRealMediaNaturally(context)
        snapshot = await call(context.app, 'waitForSnapshot', { playbackCondition: 'ready', operationalState: 'playing', musicCode: nextCode })
        assert.equal(snapshot.state.current.musicCode, nextCode, `natural Chromium EOF from ${current} advances once to ${nextCode}`)
      }
      await endRealMediaNaturally(context)
      snapshot = await call(context.app, 'waitForSnapshot', { playbackCondition: 'ready', operationalState: 'idle' })
      assert.equal(snapshot.state.current, null)
      assert.deepEqual(snapshot.state.pending, [])
      await call(context.app, 'waitForHostMediaCleared')
      const idleNext = await client.command({ key: 'ArrowRight', ctrlKey: true })
      assert.equal(idleNext.reply.outcome, 'confirmed')
      assert.equal((await call(context.app, 'getSequenceSnapshot')).state.operationalState, 'idle')

      await call(context.app, 'holdStart', '01008')
      for (const digit of '1008') client.key({ key: digit })
      const uncertainAckIntent = client.key({ key: 'Enter' })
      assert.ok(uncertainAckIntent?.type === 'player-command')
      const lostAck = client.dispatch(uncertainAckIntent).then(
        value => ({ resolved: true, value }),
        error => ({ resolved: false, error })
      )
      await call(context.app, 'waitForStart')
      await context.controlPage.close()
      const closed = await call(context.app, 'closeControlWindow')
      assert.equal(closed.bridgeCount, 0, 'destroying the control WebContents disposes the bridge and subscription owner only')
      await call(context.app, 'releaseStart')
      assert.equal((await lostAck).resolved, false, 'closing the Renderer before ACK loses only the response channel')
      snapshot = await call(context.app, 'waitForSnapshot', { playbackCondition: 'ready', operationalState: 'playing', musicCode: '01008' })
      const startedDespiteLostAck = snapshot.state.current

      const newWindowPromise = context.app.waitForEvent('window')
      await call(context.app, 'recreateControlWindow')
      const newControlPage = await newWindowPromise
      await newControlPage.waitForLoadState('domcontentloaded')
      await newControlPage.waitForFunction(() => typeof window.standalonePlayer?.getSnapshot === 'function')
      context.controlPage = newControlPage
      const recoveredPageSnapshot = await subscribe(context.controlPage)
      assert.equal(recoveredPageSnapshot.snapshot.state.current.attemptId, startedDespiteLostAck.attemptId)
      assert.equal(recoveredPageSnapshot.snapshot.state.current.musicCode, '01008')
      const retry = await client.dispatch(uncertainAckIntent)
      assert.equal(retry.outcome, 'confirmed')
      assert.equal(client.interaction.getSnapshot().lastSubmission?.outcome, 'confirmed',
        'retrying the original B2 operation after Renderer recreation settles the same interaction intent')
      assert.equal((await call(context.app, 'getPlaybackCalls')).filter(code => code === '01008').length, 1,
        'the lost ACK retry does not start a duplicate attempt')

      await call(context.app, 'crashHostRenderer')
      await call(context.app, 'waitForHostRendererCrash')
      snapshot = await call(context.app, 'waitForSnapshot', { playbackCondition: 'uncertain' })
      const crashedAttemptId = snapshot.lastConfirmedState.current.attemptId
      const record = await call(context.app, 'getRecoveryRecord')
      assert.equal(record.status, 'uncertain')
      assert.equal(record.attemptId, crashedAttemptId)
      assert.equal(record.musicCode, '01008')
      const blockedIntent = client.code('1002')
      const blockedResult = await blockedIntent
      assert.equal(blockedResult.reply.outcome, 'uncertain')
      assert.equal(blockedResult.status.outcome, 'uncertain')
      assert.equal(blockedResult.reply.envelope.snapshot.lastConfirmedState.current.attemptId, crashedAttemptId)

      const shutdownState = await shutdown(context)
      assert.equal(shutdownState.recovery.status, 'uncertain')
      assert.equal(shutdownState.recovery.attemptId, crashedAttemptId)
      assert.equal(shutdownState.hostDisposed, true)
      assert.equal(shutdownState.bridgeCount, 0)
      assert.equal(shutdownState.controllerDatabaseExists, false)
      client.interaction.dispose()
      return { crashedAttemptId, recoveryFile: path.join(profileRoot, 'player-playback-recovery.json') }
    } finally {
      client.interaction.dispose()
      await shutdown(context)
    }
  }

  async function runRecoveryRelaunch(expectedAttemptId) {
    const before = fs.readFileSync(path.join(profileRoot, 'player-playback-recovery.json'), 'utf8')
    const parsedBefore = JSON.parse(before)
    assert.equal(parsedBefore.attemptId, expectedAttemptId)
    const context = await launch('relaunch', true)
    try {
      const initial = await subscribe(context.controlPage)
      assert.equal(initial.snapshot.playbackCondition, 'blocked')
      const recovery = await call(context.app, 'getRecoveryState')
      assert.equal(recovery.status, 'pending')
      assert.equal(recovery.attemptId, expectedAttemptId)
      const noAutoplay = await videoState(context)
      assert.equal(noAutoplay, null, 'a relaunch from the actual crash record does not autoplay recovered media')
      const command = makeInteraction(context)
      const blocked = await command.code('1002')
      assert.equal(blocked.reply.outcome, 'rejected')
      assert.equal(blocked.reply.error.code, 'RECOVERY_PENDING')
      assert.equal(blocked.status.outcome, 'rejected')
      assert.deepEqual(fs.readFileSync(path.join(profileRoot, 'player-playback-recovery.json'), 'utf8'), before,
        'observing the recovery record and blocked operation does not rewrite or discard it')
      const shutdownState = await shutdown(context)
      assert.equal(shutdownState.controllerDatabaseExists, false)
      command.interaction.dispose()
    } finally { await shutdown(context) }
  }

  async function runInvalidRecovery() {
    const invalidProfile = path.join(tempRoot, 'invalid-profile')
    fs.mkdirSync(invalidProfile)
    const invalidFile = path.join(invalidProfile, 'player-playback-recovery.json')
    const invalidBytes = '{"version":1,"status":"playing"}'
    fs.writeFileSync(invalidFile, invalidBytes)
    const context = await launchWithProfile('invalid-recovery', invalidProfile)
    try {
      const initial = await subscribe(context.controlPage)
      assert.equal(initial.snapshot.playbackCondition, 'blocked')
      assert.equal((await call(context.app, 'getRecoveryDiagnostic')).code, 'INVALID_RECORD')
      assert.equal(await videoState(context), null)
      assert.equal(fs.readFileSync(invalidFile, 'utf8'), invalidBytes)
      const command = makeInteraction(context)
      const blocked = await command.code('1001')
      assert.equal(blocked.reply.outcome, 'rejected')
      assert.equal(blocked.reply.error.code, 'RECOVERY_UNAVAILABLE')
      assert.equal(fs.readFileSync(invalidFile, 'utf8'), invalidBytes)
      await shutdown(context)
      command.interaction.dispose()
    } finally {
      await shutdown(context)
    }
  }

  async function launchWithProfile(scenario, isolatedProfile) {
    const app = await electron.launch({
      executablePath: require('electron'),
      args: [`--user-data-dir=${isolatedProfile}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : []), mainEntry],
      env: {
        ...process.env,
        KQ_STANDALONE_INTEGRATION_E2E_MAIN: '1', KQ_STANDALONE_INTEGRATION_SCENARIO: scenario,
        KQ_PROJECT_ROOT: projectRoot, KQ_PLAYER_TEST_MEDIA_DIR: path.resolve(mediaRoot),
        KQ_PLAYER_TEST_PROFILE: isolatedProfile, KQ_STANDALONE_CONTROL_HTML: controlHtml
      },
      timeout: 30000
    })
    try {
      await app.firstWindow()
      const pages = await app.windows()
      await Promise.all(pages.map(page => page.waitForLoadState('domcontentloaded')))
      const controlPage = pages.find(page => page.url().includes(path.basename(controlHtml)))
      if (!controlPage) throw new Error('Expected isolated recovery control window; attached=' + JSON.stringify(pages.map(page => page.url())))
      await controlPage.waitForFunction(() => typeof window.standalonePlayer?.execute === 'function')
      return { app, controlPage, scenario }
    } catch (error) { await app.close(); throw error }
  }

  async function run() {
    const hashesBefore = await hashSamples()
    const csvFiles = fs.readdirSync(mediaRoot, { recursive: true })
      .filter(filename => typeof filename === 'string' && path.extname(filename).toLowerCase() === '.csv')
    let crashedAttemptId
    try {
      const result = await runFreshIntegration()
      crashedAttemptId = result.crashedAttemptId
      await runRecoveryRelaunch(crashedAttemptId)
      await runInvalidRecovery()
      const hashesAfter = await hashSamples()
      assert.deepEqual(hashesAfter, hashesBefore, 'all selected original MP4 samples remain byte-for-byte unchanged')
      assert.equal(fs.existsSync(path.join(profileRoot, 'karaoke.sqlite')), false)
      process.stdout.write(`PASS Standalone B4.2 real Electron IPC + B2 transport + Chromium MP4 integration; recovery crash/relaunch blocked and invalid record preserved; CSV discovered=${JSON.stringify(csvFiles)} and omitted; sample hashes unchanged.\n`)
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }) }
  }

  run().catch(error => {
    console.error(error)
    fs.rmSync(tempRoot, { recursive: true, force: true })
    process.exitCode = 1
  })
}
