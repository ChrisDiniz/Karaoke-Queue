// @ts-nocheck
export {}

// Dedicated Electron process for the Standalone playback integration. It does
// not start the production app, register production IPC, or use ManualPlaybackService.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { _electron: electron } = require('playwright')

if (process.env.KQ_STANDALONE_PLAYBACK_E2E_MAIN === '1') {
  const { app, BrowserWindow, ipcMain, protocol } = require('electron')
  const projectRoot = process.env.KQ_PROJECT_ROOT
  const mediaRoot = process.env.KQ_PLAYER_TEST_MEDIA_DIR
  const invalidRoot = process.env.KQ_STANDALONE_INVALID_MEDIA_DIR
  const profileRoot = process.env.KQ_PLAYER_TEST_PROFILE
  const scenario = process.env.KQ_STANDALONE_SCENARIO
  const recoveryAttemptId = '9b2f5d7a-3861-4a83-86d2-0ce1d6d1903a'
  if (!projectRoot || !mediaRoot || !invalidRoot || !profileRoot ||
      !['playback', 'media-failure', 'recovery-pending', 'recovery-invalid', 'host-uncertain'].includes(scenario)) {
    throw new Error('Standalone playback E2E requires isolated roots and a supported scenario.')
  }

  const { registerPlayerMediaScheme, PlayerMediaProtocol } = require(path.join(projectRoot, 'build/src/player-media-protocol.js'))
  const { ChromiumPlaybackHost } = require(path.join(projectRoot, 'build/src/chromium-playback-host.js'))
  const { PlayerPlaybackRecoveryCoordinator } = require(path.join(projectRoot, 'build/src/player-playback-recovery.js'))
  const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build/src/player-playback-recovery-store.js'))
  const { VideoLibraryService } = require(path.join(projectRoot, 'build/src/video-library-service.js'))
  const { createStandalonePlayerWithSharedPlayback } = require(path.join(projectRoot, 'build/src/standalone-player-playback-adapter.js'))

  registerPlayerMediaScheme(protocol)
  app.setPath('userData', profileRoot)
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  void app.whenReady().then(async () => {
    fs.mkdirSync(invalidRoot, { recursive: true })
    const library = new VideoLibraryService([mediaRoot, invalidRoot])
    await library.refresh()
    const mediaProtocol = new PlayerMediaProtocol(library)
    mediaProtocol.install(protocol)
    const window = new BrowserWindow({
      width: 1000,
      height: 700,
      show: true,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(projectRoot, 'build/player-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    const playbackDocument = path.join(projectRoot, 'build/src/player-playback.html')
    const host = new ChromiumPlaybackHost(
      ipcMain,
      window.webContents,
      pathToFileURL(playbackDocument).href,
      async () => {
        if (!window.isDestroyed()) window.destroy()
        return window.isDestroyed()
      }
    )
    const recoveryStore = new PlayerPlaybackRecoveryStore(profileRoot)
    if (scenario === 'recovery-pending') {
      const timestamp = new Date(0).toISOString()
      recoveryStore.write({
        version: 1,
        revision: 1,
        status: 'playing',
        attemptId: recoveryAttemptId,
        musicCode: '01001',
        playbackStatus: 'playing',
        lastTransition: 'playback-started',
        updatedAt: timestamp,
        startedAt: timestamp
      })
    } else if (scenario === 'recovery-invalid') {
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
    if (!playback) throw new Error('The Standalone sequence must own its real playback service.')

    let stopBarrier
    const originalStop = playback.stop.bind(playback)
    playback.stop = async expectedAttemptId => {
      const barrier = stopBarrier
      if (!barrier || barrier.claimed) return originalStop(expectedAttemptId)
      barrier.claimed = true
      barrier.startedResolve()
      await barrier.releasePromise
      return originalStop(expectedAttemptId)
    }
    const waitForPlaybackStatus = (status, attemptId, timeoutMs = 15000) => new Promise((resolve, reject) => {
      let settled = false
      let unsubscribe = () => undefined
      let timer
      const finish = (error, state) => {
        if (settled) return
        settled = true
        unsubscribe()
        if (timer) clearTimeout(timer)
        if (error) reject(error)
        else resolve(state)
      }
      const check = () => {
        const state = playback.getState()
        if (state.attemptId !== attemptId) {
          finish(new Error(`Playback attempt changed before observing ${status}.`))
          return
        }
        if (state.status === status) finish(undefined, state)
        else if (['failed', 'uncertain', 'disposed', 'stopped'].includes(state.status)) {
          finish(new Error(`Playback entered ${state.status} before observing ${status}.`))
        }
      }
      unsubscribe = playback.subscribe(event => { if (event.type === 'state-changed') check() })
      timer = setTimeout(() => finish(new Error(`Timed out waiting for playback status ${status}.`)), timeoutMs)
      check()
    })
    const waitForRendererCrash = (timeoutMs = 15000) => new Promise((resolve, reject) => {
      if (window.webContents.isCrashed()) { resolve(true); return }
      let timer
      const onGone = () => {
        window.webContents.removeListener('render-process-gone', onGone)
        if (timer) clearTimeout(timer)
        resolve(true)
      }
      timer = setTimeout(() => {
        window.webContents.removeListener('render-process-gone', onGone)
        reject(new Error('Timed out waiting for the isolated Chromium Renderer to crash.'))
      }, timeoutMs)
      window.webContents.once('render-process-gone', onGone)
    })

    let shutdownPromise
    const waitForSnapshot = (expected, timeoutMs = 20000) => new Promise((resolve, reject) => {
      const matches = snapshot => {
        if (expected.playbackCondition && snapshot.playbackCondition !== expected.playbackCondition) return false
        if (expected.operationalState &&
            (snapshot.playbackCondition !== 'ready' || snapshot.state.operationalState !== expected.operationalState)) return false
        if (Object.hasOwn(expected, 'musicCode') &&
            (snapshot.playbackCondition !== 'ready' || snapshot.state.current?.musicCode !== expected.musicCode)) return false
        if (expected.pendingCodes &&
            JSON.stringify(snapshot.playbackCondition === 'ready' ? snapshot.state.pending.map(item => item.musicCode)
              : snapshot.pending.map(item => item.musicCode)) !== JSON.stringify(expected.pendingCodes)) return false
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
      const timer = setTimeout(() => finish(new Error('Timed out waiting for the expected Standalone snapshot.')), timeoutMs)
      unsubscribe = sequence.subscribe(check)
      check(sequence.getSnapshot())
    })

    app.__kqStandalonePlaybackTest = {
      scenario,
      sequence,
      host,
      recovery,
      recoveryStore,
      recoveryAttemptId,
      waitForSnapshot,
      execute: async (command, operationId = crypto.randomUUID(), retrySameOperation = false) => {
        const request = { operationId, command }
        const first = sequence.execute(request)
        if (!retrySameOperation) return first
        const retry = sequence.execute(request)
        return { samePromise: first === retry, result: await first }
      },
      deferNextStop: () => {
        if (stopBarrier) throw new Error('A playback stop barrier is already active.')
        let releaseResolve
        let startedResolve
        const releasePromise = new Promise(resolve => { releaseResolve = resolve })
        const startedPromise = new Promise(resolve => { startedResolve = resolve })
        stopBarrier = { releasePromise, releaseResolve, startedPromise, startedResolve, claimed: false }
      },
      waitForDeferredStop: () => {
        if (!stopBarrier) throw new Error('No playback stop barrier is active.')
        let timer
        return Promise.race([
          stopBarrier.startedPromise,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for reserved Next to call Stop.')), 15000) })
        ]).finally(() => clearTimeout(timer))
      },
      releaseDeferredStop: () => {
        const barrier = stopBarrier
        stopBarrier = undefined
        barrier?.releaseResolve()
      },
      waitForPlaybackStatus,
      crashRenderer: () => window.webContents.forcefullyCrashRenderer(),
      waitForRendererCrash,
      getSnapshot: () => sequence.getSnapshot(),
      getRecoveryState: () => recovery.getState(),
      getRecoveryDiagnostic: () => recovery.getDiagnosticSummary(),
      resolveRecoveryAsStopped: async attemptId => {
        try { return { ok: true, state: await recovery.leaveStopped(attemptId) } }
        catch (error) { return { ok: false, code: error.code ?? 'RECOVERY_FAILED' } }
      },
      shutdown: async () => {
        const barrier = stopBarrier
        stopBarrier = undefined
        barrier?.releaseResolve()
        if (!shutdownPromise) shutdownPromise = sequence.dispose()
        await shutdownPromise
        return {
          recovery: scenario === 'recovery-invalid' ? null : recoveryStore.read(),
          playbackHostDisposed: host.disposed === true,
          browserWindowAliveForOwnerCleanup: !window.isDestroyed()
        }
      }
    }
    globalThis.__kqStandalonePlaybackTest = app.__kqStandalonePlaybackTest
    await Promise.all([window.loadFile(playbackDocument), host.ready])
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
} else {
  const projectRoot = path.resolve(__dirname, '../..')
  const mediaRoot = process.env.KQ_PLAYER_TEST_MEDIA_DIR
  if (!mediaRoot || !fs.existsSync(mediaRoot)) {
    throw new Error('Defina KQ_PLAYER_TEST_MEDIA_DIR para a biblioteca MP4 real, somente leitura.')
  }
  const requiredSamples = ['01001.mp4', '01002.mp4', '01003.mp4', '01004.mp4', '01005.mp4', '01008.mp4']
  for (const filename of requiredSamples) {
    assert.equal(fs.existsSync(path.join(mediaRoot, filename)), true, `A amostra real ${filename} deve existir.`)
  }

  async function hashFile(filename) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(filename)
      stream.on('error', reject)
      stream.on('data', chunk => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  async function hashSamples() {
    const result = new Map()
    for (const filename of requiredSamples) result.set(filename, await hashFile(path.join(mediaRoot, filename)))
    return result
  }

  function createTempRoot() {
    const configured = process.env.KARAOKE_TEST_TEMP_ROOT
    const root = configured ? path.resolve(configured) : fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-playback-e2e-'))
    if (configured) {
      if (fs.existsSync(root)) throw new Error('A raiz temporária isolada já existe: ' + root)
      fs.mkdirSync(root, { recursive: false })
    }
    return root
  }

  const tempRoot = createTempRoot()
  const mainEntry = path.join(tempRoot, 'standalone-playback-main.cjs')
  fs.writeFileSync(mainEntry, `require(${JSON.stringify(__filename)})`)

  async function launchScenario(scenario) {
    const scenarioRoot = path.join(tempRoot, scenario)
    const profileRoot = path.join(scenarioRoot, 'profile')
    const invalidRoot = path.join(scenarioRoot, 'invalid-media')
    fs.mkdirSync(profileRoot, { recursive: true })
    fs.mkdirSync(invalidRoot, { recursive: true })
    if (scenario === 'media-failure') {
      fs.writeFileSync(path.join(invalidRoot, '09998.mp4'), Buffer.from('not a valid MP4 media payload'))
    }

    const app = await electron.launch({
      executablePath: require('electron'),
      args: [
        `--user-data-dir=${profileRoot}`,
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        mainEntry
      ],
      env: {
        ...process.env,
        KQ_STANDALONE_PLAYBACK_E2E_MAIN: '1',
        KQ_STANDALONE_SCENARIO: scenario,
        KQ_PROJECT_ROOT: projectRoot,
        KQ_PLAYER_TEST_MEDIA_DIR: path.resolve(mediaRoot),
        KQ_STANDALONE_INVALID_MEDIA_DIR: invalidRoot,
        KQ_PLAYER_TEST_PROFILE: profileRoot
      },
      timeout: 30000
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      return {
      app,
      page,
      profileRoot,
      releaseDeferredStop: () => app.evaluate(({ app }) => app.__kqStandalonePlaybackTest.releaseDeferredStop()),
      call: (method, ...args) => app.evaluate(async ({ app }, [name, parameters]) =>
        await app.__kqStandalonePlaybackTest[name](...parameters), [method, args]),
      snapshot: () => app.evaluate(({ app }) => app.__kqStandalonePlaybackTest.getSnapshot()),
      execute: (command, operationId = crypto.randomUUID(), retrySameOperation = false) =>
        app.evaluate(async ({ app }, values) => app.__kqStandalonePlaybackTest.execute(...values),
          [command, operationId, retrySameOperation]),
      waitForSnapshot: (expected, timeoutMs) => app.evaluate(async ({ app }, [value, timeout]) =>
        app.__kqStandalonePlaybackTest.waitForSnapshot(value, timeout), [expected, timeoutMs]),
      crashRenderer: () => app.evaluate(({ app }) => app.__kqStandalonePlaybackTest.crashRenderer()),
      waitForRendererCrash: () => app.evaluate(({ app }) => app.__kqStandalonePlaybackTest.waitForRendererCrash()),
      video: () => page.evaluate(() => {
        const video = document.querySelector('video')
        if (!video) return null
        return {
          paused: video.paused,
          ended: video.ended,
          currentTime: video.currentTime,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          readyState: video.readyState,
          error: video.error?.code ?? null
        }
      }),
      waitForVideoPlayback: () => page.waitForFunction(() => {
        const video = document.querySelector('video')
        return Boolean(video && video.readyState >= 2 && !video.paused && video.currentTime > 0.1 &&
          video.duration > 0 && video.videoWidth > 0 && video.videoHeight > 0)
      }, undefined, { timeout: 15000 }),
      seekToRealEnd: async () => {
        await page.waitForFunction(() => {
          const video = document.querySelector('video')
          return Boolean(video && video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 2)
        }, undefined, { timeout: 15000 })
        const target = await page.evaluate(() => {
          const video = document.querySelector('video')
          if (!video || video.paused) throw new Error('A reprodução real precisa estar ativa antes de buscar o fim.')
          window.__kqStandaloneRealEnded = undefined
          video.addEventListener('ended', () => {
            window.__kqStandaloneRealEnded = {
              ended: video.ended,
              currentTime: video.currentTime,
              duration: video.duration
            }
          }, { once: true })
          video.currentTime = Math.max(0, video.duration - 0.75)
          return video.currentTime
        })
        await page.waitForFunction(() => window.__kqStandaloneRealEnded?.ended === true,
          undefined, { timeout: 15000 })
        const ended = await page.evaluate(() => window.__kqStandaloneRealEnded)
        assert.ok(ended.currentTime >= target, 'the real media element must play through the sought final segment')
        return ended
      },
      shutdown: () => app.evaluate(async ({ app }) => await app.__kqStandalonePlaybackTest.shutdown())
      }
    } catch (error) {
      await app.close()
      throw error
    }
  }

  async function closeScenario(context) {
    if (!context) return
    let shutdownError
    try { await context.releaseDeferredStop() } catch (error) { shutdownError = error }
    try { await context.shutdown() } catch (error) { shutdownError ??= error }
    const child = context.app.process()
    try { await context.app.close() } catch (error) { shutdownError ??= error }
    if (child.exitCode === null && child.signalCode === null) {
      shutdownError ??= new Error('The isolated Electron process did not exit during cleanup.')
    }
    if (shutdownError) throw shutdownError
  }

  async function runPlaybackScenario() {
    const context = await launchScenario('playback')
    try {
      const initial = await context.snapshot()
      assert.equal(initial.playbackCondition, 'ready')
      assert.equal(initial.state.operationalState, 'idle', 'startup must not autoplay')
      assert.equal(fs.existsSync(path.join(context.profileRoot, 'karaoke.sqlite')), false,
        'Standalone playback must not create the Controller operational database')

      const firstStart = await context.execute({ type: 'submit-code', enteredCode: '1001', priority: 'normal' },
        'standalone-start-1001', true)
      assert.equal(firstStart.samePromise, true, 'retrying the same intent shares its operation result')
      assert.equal(firstStart.result.outcome, 'confirmed')
      const first = await context.waitForSnapshot({ playbackCondition: 'ready', operationalState: 'playing', musicCode: '01001' })
      const originalEntryId = first.state.current.entryId
      const firstAttemptId = first.state.current.attemptId
      await context.waitForVideoPlayback()
      const firstVideo = await context.video()
      assert.ok(firstVideo.currentTime > 0.1 && firstVideo.duration > 0 && firstVideo.width > 0 && firstVideo.height > 0,
        'Chromium must decode the real 01001 MP4 and advance its media clock without configuring a CSV')

      const paused = await context.execute({ type: 'toggle-pause' }, 'standalone-pause')
      assert.equal(paused.outcome, 'confirmed')
      const pausedState = await context.waitForSnapshot({ playbackCondition: 'ready', operationalState: 'paused', musicCode: '01001' })
      const pausedTime = (await context.video()).currentTime
      assert.equal((await context.video()).paused, true)
      for (const [operationId, enteredCode, priority] of [
        ['normal-1002', '1002', 'normal'], ['normal-1003', '1003', 'normal'],
        ['priority-1004', '1004', 'priority'], ['priority-1005', '1005', 'priority']
      ]) {
        const added = await context.execute({ type: 'submit-code', enteredCode, priority }, `standalone-${operationId}`)
        assert.equal(added.outcome, 'confirmed')
        const stillPaused = await context.snapshot()
        assert.equal(stillPaused.playbackCondition, 'ready')
        assert.equal(stillPaused.state.operationalState, 'paused', 'adding while paused must not resume media')
        assert.equal(stillPaused.state.current.attemptId, firstAttemptId)
      }
      const queued = await context.snapshot()
      assert.equal(queued.playbackCondition, 'ready')
      assert.deepEqual(queued.state.pending.map(item => item.musicCode), ['01005', '01004', '01002', '01003'],
        'priority entries use LIFO at the head while normal entries retain FIFO order')

      const resumed = await context.execute({ type: 'toggle-pause' }, 'standalone-resume')
      assert.equal(resumed.outcome, 'confirmed')
      await context.waitForSnapshot({ playbackCondition: 'ready', operationalState: 'playing', musicCode: '01001' })
      await context.page.waitForFunction(time => {
        const video = document.querySelector('video')
        return Boolean(video && video.paused === false && video.currentTime > time + 0.1)
      }, pausedTime, { timeout: 10000 })

      const restarted = await context.execute({ type: 'restart' }, 'standalone-restart')
      assert.equal(restarted.outcome, 'confirmed')
      const restartSnapshot = await context.waitForSnapshot({ playbackCondition: 'ready', operationalState: 'playing', musicCode: '01001' })
      assert.equal(restartSnapshot.state.current.entryId, originalEntryId, 'restart preserves queue occurrence identity')
      assert.notEqual(restartSnapshot.state.current.attemptId, firstAttemptId, 'restart creates a new media attempt')
      await context.page.waitForFunction(() => {
        const video = document.querySelector('video')
        return Boolean(video && video.readyState >= 2 && !video.paused && video.currentTime < 1.5)
      }, undefined, { timeout: 15000 })

      for (const expectedCode of ['01005', '01004', '01002', '01003']) {
        const next = await context.execute({ type: 'next' }, `standalone-next-${expectedCode}`)
        assert.equal(next.outcome, 'confirmed')
        const nextSnapshot = await context.waitForSnapshot({
          playbackCondition: 'ready', operationalState: 'playing', musicCode: expectedCode
        })
        assert.ok(nextSnapshot.state.current.attemptId)
        await context.waitForVideoPlayback()
      }
      const finalNext = await context.execute({ type: 'next' }, 'standalone-next-idle')
      assert.equal(finalNext.outcome, 'confirmed')
      await context.waitForSnapshot({ playbackCondition: 'ready', operationalState: 'idle' })
      await context.page.waitForFunction(() => document.querySelector('video') === null, undefined, { timeout: 10000 })

      const eofStart = await context.execute({ type: 'submit-code', enteredCode: '1001', priority: 'normal' }, 'standalone-eof-current')
      assert.equal(eofStart.outcome, 'confirmed')
      const eofCurrent = await context.waitForSnapshot({ playbackCondition: 'ready', operationalState: 'playing', musicCode: '01001' })
      await context.waitForVideoPlayback()
      const eofQueued = await context.execute({ type: 'submit-code', enteredCode: '1008', priority: 'normal' }, 'standalone-eof-pending')
      assert.equal(eofQueued.outcome, 'confirmed')
      await context.execute({ type: 'submit-code', enteredCode: '1002', priority: 'normal' }, 'standalone-eof-pending-behind')

      await context.call('deferNextStop')
      const nextRacingEof = context.execute({ type: 'next' }, 'standalone-next-racing-real-eof')
      await context.call('waitForDeferredStop')
      const racingNaturalEnd = await context.seekToRealEnd()
      assert.equal(racingNaturalEnd.ended, true, 'Chromium HTMLMediaElement must report a real natural EOF during reserved Next')
      assert.ok(racingNaturalEnd.currentTime >= racingNaturalEnd.duration)
      await context.call('waitForPlaybackStatus', 'completed', eofCurrent.state.current.attemptId)
      await context.call('releaseDeferredStop')
      assert.equal((await nextRacingEof).outcome, 'confirmed')
      const autoAdvanced = await context.waitForSnapshot({
        playbackCondition: 'ready', operationalState: 'playing', musicCode: '01008'
      })
      assert.notEqual(autoAdvanced.state.current.attemptId, eofCurrent.state.current.attemptId)
      assert.deepEqual(autoAdvanced.state.pending.map(item => item.musicCode), ['01002'],
        'the real EOF/Next race consumes exactly one pending entry')
      await context.waitForVideoPlayback()

      const secondNaturalEnd = await context.seekToRealEnd()
      assert.equal(secondNaturalEnd.ended, true, 'Chromium must naturally end the next MP4 without a manual command')
      const finalQueued = await context.waitForSnapshot({
        playbackCondition: 'ready', operationalState: 'playing', musicCode: '01002'
      })
      assert.notEqual(finalQueued.state.current.attemptId, autoAdvanced.state.current.attemptId)
      await context.waitForVideoPlayback()

      const lastNaturalEnd = await context.seekToRealEnd()
      assert.equal(lastNaturalEnd.ended, true, 'Chromium must naturally end the final queued MP4')
      assert.ok(lastNaturalEnd.currentTime >= lastNaturalEnd.duration)
      await context.waitForSnapshot({ playbackCondition: 'ready', operationalState: 'idle' })
      await context.page.waitForFunction(() => document.querySelector('video') === null, undefined, { timeout: 10000 })
      const empty = await context.snapshot()
      assert.equal(empty.state.current, null)
      assert.deepEqual(empty.state.pending, [])

      const shutdownStart = await context.execute({ type: 'submit-code', enteredCode: '1001', priority: 'normal' },
        'standalone-shutdown-active')
      assert.equal(shutdownStart.outcome, 'confirmed')
      await context.waitForVideoPlayback()
      const shutdown = await context.shutdown()
      assert.equal(shutdown.playbackHostDisposed, true, 'the sequence owner disposes the real Chromium host')
      assert.equal(shutdown.browserWindowAliveForOwnerCleanup, true,
        'the harness remains the sole BrowserWindow owner and closes it with ElectronApplication.close()')
      assert.equal(shutdown.recovery?.status, 'stopped')
      assert.equal(shutdown.recovery?.lastTransition, 'shutdown-confirmed')
      assert.equal(fs.existsSync(path.join(context.profileRoot, 'karaoke.sqlite')), false)
    } finally {
      await closeScenario(context)
    }
  }

  async function runMediaFailureScenario() {
    const context = await launchScenario('media-failure')
    try {
      const initial = await context.snapshot()
      assert.equal(initial.playbackCondition, 'ready')
      assert.equal(initial.state.operationalState, 'idle')
      const result = await context.execute({ type: 'submit-code', enteredCode: '9998', priority: 'normal' },
        'standalone-known-invalid-media')
      assert.equal(result.outcome, 'confirmed',
        'a readable library candidate is admitted before Chromium validates its media payload')
      const blocked = await context.waitForSnapshot({ playbackCondition: 'blocked', pendingCodes: ['09998'] })
      assert.equal(blocked.lastConfirmedState.operationalState, 'idle')
      await context.page.waitForFunction(() => {
        const video = document.querySelector('video')
        return Boolean(video && video.error !== null)
      }, undefined, { timeout: 15000 })
      assert.equal(fs.existsSync(path.join(context.profileRoot, 'karaoke.sqlite')), false)
    } finally {
      await closeScenario(context)
    }
  }

  async function runPendingRecoveryScenario() {
    const context = await launchScenario('recovery-pending')
    try {
      const blocked = await context.snapshot()
      assert.equal(blocked.playbackCondition, 'blocked')
      const recovery = await context.call('getRecoveryState')
      assert.equal(recovery.status, 'pending')
      assert.equal(recovery.attemptId, '9b2f5d7a-3861-4a83-86d2-0ce1d6d1903a')
      assert.equal((await context.video()), null)
      const rejected = await context.execute({ type: 'submit-code', enteredCode: '1001', priority: 'normal' },
        'standalone-recovery-must-block-autoplay')
      assert.equal(rejected.outcome, 'rejected')
      const wrongAttempt = await context.call('resolveRecoveryAsStopped', '2a5a5a5a-3861-4a83-86d2-0ce1d6d1903a')
      assert.deepEqual(wrongAttempt, { ok: false, code: 'SUPERSEDED' }, 'recovery must reject a stale attempt identity')
      assert.equal((await context.call('getRecoveryState')).status, 'pending')
      const matchingAttempt = await context.call('resolveRecoveryAsStopped', '9b2f5d7a-3861-4a83-86d2-0ce1d6d1903a')
      assert.equal(matchingAttempt.ok, true, 'the existing recovery coordinator correlates explicit stopped resolution')
      assert.equal(matchingAttempt.state.status, 'resolved')
      assert.equal(matchingAttempt.state.outcome, 'dismissed')
      assert.equal((await context.snapshot()).playbackCondition, 'blocked',
        'the sequence stays safely blocked until a future approved recovery UI/runtime transition')
      assert.equal((await context.video()), null, 'resolving as stopped never autoplays the recovered code')
      assert.equal(fs.existsSync(path.join(context.profileRoot, 'karaoke.sqlite')), false)
    } finally {
      await closeScenario(context)
    }
  }

  async function runInvalidRecoveryScenario() {
    const context = await launchScenario('recovery-invalid')
    try {
      const blocked = await context.snapshot()
      assert.equal(blocked.playbackCondition, 'blocked')
      const diagnostic = await context.call('getRecoveryDiagnostic')
      assert.equal(diagnostic.code, 'INVALID_RECORD')
      assert.equal(fs.readFileSync(path.join(context.profileRoot, 'player-playback-recovery.json'), 'utf8'),
        '{"version":1,"status":"playing"}', 'invalid recovery bytes are preserved without an approved resolution decision')
      const result = await context.execute({ type: 'submit-code', enteredCode: '1001', priority: 'normal' },
        'standalone-invalid-recovery-blocks-playback')
      assert.equal(result.outcome, 'rejected')
      assert.equal((await context.video()), null)
    } finally {
      await closeScenario(context)
    }
  }

  async function runHostUncertainScenario() {
    const context = await launchScenario('host-uncertain')
    try {
      const initial = await context.snapshot()
      assert.equal(initial.playbackCondition, 'ready')
      assert.equal(initial.state.operationalState, 'idle', 'host recovery must not autoplay at startup')
      const started = await context.execute({ type: 'submit-code', enteredCode: '1001', priority: 'normal' },
        'standalone-host-uncertain-start')
      assert.equal(started.outcome, 'confirmed')
      const playing = await context.waitForSnapshot({ playbackCondition: 'ready', operationalState: 'playing', musicCode: '01001' })
      await context.waitForVideoPlayback()
      const attemptId = playing.state.current.attemptId

      await context.crashRenderer()
      assert.equal(await context.waitForRendererCrash(), true)
      const uncertain = await context.waitForSnapshot({ playbackCondition: 'uncertain' })
      assert.equal(uncertain.lastConfirmedState.current.attemptId, attemptId,
        'the uncertain Standalone state must preserve the failed media attempt identity')
      assert.equal(uncertain.error.code, 'HOST_TERMINATED')
      const recovery = await context.call('getRecoveryState')
      assert.equal(recovery.status, 'pending')
      assert.equal(recovery.attemptId, attemptId)
      assert.equal(recovery.musicCode, '01001')
      assert.equal(recovery.playbackStatus, 'uncertain')

      const rejected = await context.execute({ type: 'submit-code', enteredCode: '1002', priority: 'normal' },
        'standalone-host-uncertain-blocks-new-playback')
      assert.equal(rejected.outcome, 'uncertain', 'a lost host blocks a new incompatible playback intent')
      const shutdown = await context.shutdown()
      assert.equal(shutdown.recovery?.status, 'uncertain')
      assert.equal(shutdown.recovery?.attemptId, attemptId)
      assert.equal(shutdown.recovery?.playbackStatus, 'uncertain')
      assert.equal(shutdown.playbackHostDisposed, true)
      assert.equal(shutdown.browserWindowAliveForOwnerCleanup, true)
      assert.equal(fs.existsSync(path.join(context.profileRoot, 'karaoke.sqlite')), false)
    } finally {
      await closeScenario(context)
    }
  }

  async function run() {
    const hashesBefore = await hashSamples()
    const csvFiles = fs.readdirSync(mediaRoot, { recursive: true })
      .filter(filename => typeof filename === 'string' && path.extname(filename).toLowerCase() === '.csv')
    try {
      await runPlaybackScenario()
      await runMediaFailureScenario()
      await runPendingRecoveryScenario()
      await runInvalidRecoveryScenario()
      await runHostUncertainScenario()
      const hashesAfter = await hashSamples()
      assert.deepEqual(hashesAfter, hashesBefore, 'the original MP4 samples must remain byte-for-byte unchanged')
      process.stdout.write(`PASS Standalone Electron/Chromium integration; real MP4 codes 01001, 01002, 01003, 01004, 01005, 01008; natural EOF observed; CSV discovered=${JSON.stringify(csvFiles)} and intentionally not opened; original sample hashes unchanged.\n`)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  }

  run().catch(error => {
    console.error(error)
    fs.rmSync(tempRoot, { recursive: true, force: true })
    process.exitCode = 1
  })
}
