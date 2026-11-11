// @ts-nocheck
export {}

// This file is both the Node/Playwright driver and, in a child Electron process,
// a temporary Main entry. The child mode is test-only and never changes app startup.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { _electron: electron } = require('playwright')

if (process.env.KQ_PLAYER_PLAYBACK_E2E_MAIN === '1') {
  const { app, BrowserWindow, ipcMain, protocol } = require('electron')
  const projectRoot = process.env.KQ_PROJECT_ROOT
  const mediaRoot = process.env.KQ_PLAYER_TEST_MEDIA_DIR
  const invalidRoot = process.env.KQ_PLAYER_INVALID_MEDIA_DIR
  const profileRoot = process.env.KQ_PLAYER_TEST_PROFILE
  if (!projectRoot || !mediaRoot || !invalidRoot || !profileRoot) throw new Error('Playback E2E requires isolated project, profile, and media roots.')

  const { registerPlayerMediaScheme, PlayerMediaProtocol } = require(path.join(projectRoot, 'build/src/player-media-protocol.js'))
  const { ChromiumPlaybackHost } = require(path.join(projectRoot, 'build/src/chromium-playback-host.js'))
  const { PlayerPlaybackService } = require(path.join(projectRoot, 'build/src/player-playback-service.js'))
  const { ManualPlaybackService } = require(path.join(projectRoot, 'build/src/manual-playback-service.js'))
  const { VideoLibraryService } = require(path.join(projectRoot, 'build/src/video-library-service.js'))

  registerPlayerMediaScheme(protocol)
  app.setPath('userData', profileRoot)
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  void app.whenReady().then(async () => {
    const library = new VideoLibraryService([mediaRoot, invalidRoot])
    await library.refresh()
    const mediaProtocol = new PlayerMediaProtocol(library)
    mediaProtocol.install(protocol)
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
    const host = new ChromiumPlaybackHost(
      ipcMain,
      window.webContents,
      pathToFileURL(path.join(projectRoot, 'build/src/player-playback.html')).href,
      async () => {
        if (!window.isDestroyed()) window.destroy()
        return window.isDestroyed()
      }
    )
    const service = new PlayerPlaybackService(library, mediaProtocol)
    service.attachHost(host)
    const manual = new ManualPlaybackService(service, { autoAdvanceOnNaturalEnd: true })
    const events = []
    service.subscribe(event => events.push(event))
    const playbackTestHook = {
      service,
      manual,
      library,
      events,
      window,
      async waitForState(status, attemptId, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const state = service.getState()
          if (state.status === status && (!attemptId || state.attemptId === attemptId)) return state
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error(`Timed out waiting for playback state ${status}; current=${JSON.stringify(service.getState())}`)
      },
      async waitForMusicCode(status, musicCode, previousAttemptId, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const state = service.getState()
          if (state.status === status && state.musicCode === musicCode && state.attemptId !== previousAttemptId) return state
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error(`Timed out waiting for ${musicCode} in ${status}; current=${JSON.stringify(service.getState())}`)
      },
      async waitForEvent(type, attemptId, fromIndex = 0, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const event = events.slice(fromIndex).find(item => item.type === type &&
            (!attemptId || item.attemptId === attemptId || item.state?.attemptId === attemptId))
          if (event) return event
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error(`Timed out waiting for playback event ${type} for ${attemptId ?? 'any attempt'}`)
      },
      async shutdown() {
        manual.dispose()
        await service.dispose()
        mediaProtocol.dispose(protocol)
        library.close()
        if (!window.isDestroyed()) window.destroy()
      },
      crashRenderer() {
        window.webContents.forcefullyCrashRenderer()
      },
      isRendererCrashed() {
        return window.webContents.isCrashed()
      }
    }
    app.__kqPlayerPlaybackTest = playbackTestHook
    globalThis.__kqPlayerPlaybackTest = playbackTestHook
    await window.loadFile(path.join(projectRoot, 'build/src/player-playback.html'))
    await host.ready
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
} else {
  const projectRoot = path.resolve(__dirname, '../..')
  const mediaRoot = process.env.KQ_PLAYER_TEST_MEDIA_DIR
  if (!mediaRoot || !fs.existsSync(mediaRoot)) {
    throw new Error('Set KQ_PLAYER_TEST_MEDIA_DIR to the read-only real sample video directory before running this Electron suite.')
  }

  const requiredSamples = ['01001', '01002']
  const sampleCodes = new Set()
  for (const name of fs.readdirSync(mediaRoot, { recursive: true })) {
    if (typeof name !== 'string') continue
    const match = /^([0-9]{5})(?:[ _-].*)?\.(?:mp4|mkv|webm|avi|mov|mpeg|mpg|wmv)$/i.exec(path.basename(name))
    if (match) sampleCodes.add(match[1])
  }
  for (const code of requiredSamples) {
    assert.equal(sampleCodes.has(code), true, `Real sample ${code} must be present in KQ_PLAYER_TEST_MEDIA_DIR`)
  }
  const absentCodes = Array.from({ length: 99999 }, (_, index) => String(99999 - index).padStart(5, '0'))
    .filter(code => !sampleCodes.has(code))
  const [invalidCode, missingCode] = absentCodes
  assert.ok(invalidCode && missingCode,
    'The sample library must leave two canonical codes available for invalid and missing media tests')
  const duplicateCode = '01002'

  const configuredTempRoot = process.env.KARAOKE_TEST_TEMP_ROOT
  const tempRoot = configuredTempRoot
    ? path.resolve(configuredTempRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-player-playback-e2e-'))
  if (configuredTempRoot) {
    if (fs.existsSync(tempRoot)) throw new Error('The requested isolated Player test root already exists: ' + tempRoot)
    fs.mkdirSync(tempRoot, { recursive: false })
  }
  const profileRoot = path.join(tempRoot, 'profile')
  const invalidRoot = path.join(tempRoot, 'invalid-media')
  const mainEntry = path.join(tempRoot, 'player-playback-main.cjs')
  fs.mkdirSync(profileRoot, { recursive: true })
  fs.mkdirSync(invalidRoot, { recursive: true })
  fs.writeFileSync(path.join(invalidRoot, `${invalidCode}.mp4`), Buffer.alloc(0))
  fs.writeFileSync(path.join(invalidRoot, `${duplicateCode}.mp4`), Buffer.alloc(0))
  fs.writeFileSync(mainEntry, `require(${JSON.stringify(__filename)})`)

  async function run() {
    let app
    try {
      app = await electron.launch({
        executablePath: require('electron'),
        args: [
          `--user-data-dir=${profileRoot}`,
          ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
          mainEntry
        ],
        env: {
          ...process.env,
          KQ_PLAYER_PLAYBACK_E2E_MAIN: '1',
          KQ_PROJECT_ROOT: projectRoot,
          KQ_PLAYER_TEST_MEDIA_DIR: path.resolve(mediaRoot),
          KQ_PLAYER_INVALID_MEDIA_DIR: invalidRoot,
          KQ_PLAYER_TEST_PROFILE: profileRoot
        },
        timeout: 30000
      })
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const state = () => app.evaluate(({ app }) => app.__kqPlayerPlaybackTest.service.getState())
      const invoke = method => app.evaluate(async ({ app }, name) => await app.__kqPlayerPlaybackTest.service[name](), method)
      const call = (method, ...args) => app.evaluate(async ({ app }, [name, parameters]) =>
        await app.__kqPlayerPlaybackTest.service[name](...parameters), [method, args])
      const waitState = (status, attemptId, timeoutMs) => app.evaluate(async ({ app }, [expected, id, timeout]) =>
        await app.__kqPlayerPlaybackTest.waitForState(expected, id, timeout), [status, attemptId, timeoutMs])
      const waitMusicCode = (status, musicCode, previousAttemptId, timeoutMs) => app.evaluate(async ({ app }, [expected, code, previousId, timeout]) =>
        await app.__kqPlayerPlaybackTest.waitForMusicCode(expected, code, previousId, timeout), [status, musicCode, previousAttemptId, timeoutMs])
      const waitEvent = (type, attemptId, fromIndex, timeoutMs) => app.evaluate(async ({ app }, [name, id, index, timeout]) =>
        await app.__kqPlayerPlaybackTest.waitForEvent(name, id, index, timeout), [type, attemptId, fromIndex, timeoutMs])
      const events = () => app.evaluate(({ app }) => app.__kqPlayerPlaybackTest.events.slice())
      const manualCall = (method, ...args) => app.evaluate(async ({ app }, [name, parameters]) =>
        await app.__kqPlayerPlaybackTest.manual[name](...parameters), [method, args])
      const video = () => page.evaluate(() => {
        const media = document.querySelector('video')
        if (!media) return null
        return { paused: media.paused, ended: media.ended, currentTime: media.currentTime,
          duration: media.duration, videoWidth: media.videoWidth, videoHeight: media.videoHeight,
          readyState: media.readyState, error: media.error?.code ?? null }
      })

      assert.equal((await state()).status, 'idle', 'the Player host must not autoplay on startup')
      assert.equal(fs.existsSync(path.join(profileRoot, 'karaoke.sqlite')), false,
        'the isolated Player playback host must not create Controller operational SQLite')

      const manualStart = await manualCall('playByMusicCode', '1001')
      assert.equal(manualStart.outcome, 'started', 'manual code 1001 must resolve and start indexed video 01001 without CSV')
      const manualAttempt = (await state()).attemptId
      assert.equal((await state()).musicCode, '01001')
      await waitState('playing', manualAttempt, 15000)
      const beforeMissingSelection = await state()
      const missingSelection = await manualCall('playByMusicCode', missingCode)
      assert.equal(missingSelection.outcome, 'unavailable')
      assert.equal((await state()).attemptId, beforeMissingSelection.attemptId,
        'an unavailable manual selection must not replace the currently playing media')
      const duplicateInputCode = duplicateCode.replace(/^0+/, '')
      const ambiguousSelection = await manualCall('playByMusicCode', duplicateInputCode)
      assert.equal(ambiguousSelection.outcome, 'unavailable',
        `ambiguous indexed codes must not select an arbitrary file: ${JSON.stringify(ambiguousSelection)}`)

      await manualCall('stop')
      fs.unlinkSync(path.join(invalidRoot, `${duplicateCode}.mp4`))
      await app.evaluate(async ({ app }) => await app.__kqPlayerPlaybackTest.library.refresh())
      const resumedSelection = await manualCall('playByMusicCode', '1001')
      assert.equal(resumedSelection.outcome, 'started')

      await manualCall('setNavigationSequence', ['1001', '1002'], 0)
      const nextResult = await manualCall('next')
      assert.equal(nextResult.outcome, 'started', 'Next must use the explicit sequence')
      const nextAttempt = (await state()).attemptId
      assert.equal((await state()).musicCode, '01002')
      await waitState('playing', nextAttempt, 15000)
      assert.equal((await manualCall('next')).reason, 'SEQUENCE_BOUNDARY', 'Next must stop at the explicit sequence boundary')
      const previousResult = await manualCall('previous')
      assert.equal(previousResult.outcome, 'started', 'Previous must use the explicit sequence')
      const previousAttempt = (await state()).attemptId
      assert.equal((await state()).musicCode, '01001')
      await waitState('playing', previousAttempt, 15000)
      const manualStopped = await manualCall('stop')
      assert.equal(manualStopped.outcome, 'accepted')
      assert.equal(manualStopped.state.status, 'stopped')
      assert.equal(manualStopped.state.containmentStatus, 'stop-acknowledged')

      const firstManualStart = await manualCall('playByMusicCode', '1001')
      assert.equal(firstManualStart.outcome, 'started')
      const firstAttempt = (await state()).attemptId
      await waitState('playing', firstAttempt, 15000)
      const firstMetadata = await video()
      assert.ok(firstMetadata && firstMetadata.duration > 0 && firstMetadata.videoWidth > 0 && firstMetadata.videoHeight > 0,
        'Chromium must load real sample metadata and dimensions')
      const initialVideo = await video()
      await page.waitForFunction(() => {
        const media = document.querySelector('video')
        return Boolean(media && media.currentTime > 0.25)
      }, undefined, { timeout: 15000 })
      const progressedVideo = await video()
      assert.ok(progressedVideo.currentTime > initialVideo.currentTime, 'real Chromium video time must advance')

      const manualPause = await manualCall('pause')
      assert.equal(manualPause.outcome, 'accepted')
      await waitState('paused', firstAttempt, 10000)
      const pausedTime = (await video()).currentTime
      await page.waitForTimeout(350)
      assert.ok(Math.abs((await video()).currentTime - pausedTime) < 0.05, 'pause must hold current playback time')
      const manualResume = await manualCall('resume')
      assert.equal(manualResume.outcome, 'accepted')
      await waitState('playing', firstAttempt, 10000)

      const eventIndexBeforeRestart = (await events()).length
      const manualRestart = await manualCall('restart')
      assert.equal(manualRestart.outcome, 'accepted')
      const restartedAttempt = (await state()).attemptId
      assert.notEqual(restartedAttempt, firstAttempt, 'restart must invalidate the previous attempt identity')
      await waitState('playing', restartedAttempt, 15000)
      await page.waitForFunction(() => document.querySelector('video')?.currentTime < 1.5, undefined, { timeout: 10000 })
      await manualCall('stop')
      await waitState('stopped', restartedAttempt, 10000)
      assert.equal((await events()).slice(eventIndexBeforeRestart).filter(event => event.type === 'natural-end-candidate').length, 0,
        'restart and stop must not report a song as naturally completed')

      const beforeReplacementStart = await manualCall('playByMusicCode', '1001')
      assert.equal(beforeReplacementStart.outcome, 'started')
      const replacedAttempt = (await state()).attemptId
      await waitState('playing', replacedAttempt, 10000)
      const beforeReplacement = (await events()).length
      const replacedSelection = await manualCall('playByMusicCode', '1002')
      assert.equal(replacedSelection.outcome, 'started')
      const secondAttempt = (await state()).attemptId
      assert.notEqual(secondAttempt, replacedAttempt)
      await waitState('playing', secondAttempt, 15000)
      assert.ok((await events()).slice(beforeReplacement).some(event =>
        event.type === 'interrupted' && event.attemptId === replacedAttempt && event.reason === 'replace'))
      assert.equal((await events()).slice(beforeReplacement).some(event =>
        event.type === 'natural-end-candidate' && event.attemptId === replacedAttempt), false,
      'replacing a playing video must interrupt it, not complete it')
      await manualCall('stop')

      await page.evaluate(() => {
        window.__kqInvalidMediaError = null
        document.addEventListener('error', event => {
          const media = event.target
          if (media instanceof HTMLMediaElement && media.error) {
            window.__kqInvalidMediaError = { code: media.error.code, message: media.error.message }
          }
        }, { once: true, capture: true })
      })
      const invalidInputMedia = await manualCall('playByMusicCode', invalidCode.replace(/^0+/, ''))
      assert.equal(invalidInputMedia.outcome, 'failed', 'invalid media must not be reported as successful playback')

      // A zero-byte file is indexed; observe the native error before confirmed
      // containment clears the media element and its error state.
      const invalidAttempt = (await state()).attemptId
      await waitState('failed', invalidAttempt, 15000)
      const invalidMediaError = await page.evaluate(() => window.__kqInvalidMediaError)
      assert.ok(invalidMediaError && Number.isInteger(invalidMediaError.code) && invalidMediaError.code > 0,
        'invalid media must produce a native HTMLMediaElement error before containment')
      assert.ok(['stop-acknowledged', 'host-terminated'].includes((await state()).containmentStatus),
        'a failed media attempt can reach failed only after confirmed containment')

      // Natural EOF is measured at normal speed; no synthetic ended event or timeout is used as evidence.
      await manualCall('clearSequence')
      const queuedNext = await manualCall('addToSequence', '1002')
      assert.equal(queuedNext.outcome, 'queued')
      const eofStart = await manualCall('playByMusicCode', '1001')
      assert.equal(eofStart.outcome, 'started')
      const eofAttempt = (await state()).attemptId
      await waitState('playing', eofAttempt, 15000)
      const eofDuration = (await video()).duration
      assert.ok(Number.isFinite(eofDuration) && eofDuration > 0, 'the EOF run requires a finite real-media duration')
      const eofEventsBefore = (await events()).length
      const eofTimeout = Math.ceil(eofDuration * 1000 + 45000)
      const candidate = await waitEvent('natural-end-candidate', eofAttempt, eofEventsBefore, eofTimeout)
      assert.equal(candidate.musicCode, '01001')
      assert.equal((await events()).slice(eofEventsBefore).filter(event => event.type === 'natural-end-candidate' && event.attemptId === eofAttempt).length, 1)
      const autoAdvanced = await waitMusicCode('playing', '01002', eofAttempt, 15000)
      assert.notEqual(autoAdvanced.attemptId, eofAttempt, 'the next explicit sequence item must start as a new attempt')
      const completedSequence = await manualCall('getSequence')
      assert.equal(completedSequence.current.musicCode, '01002')
      assert.equal(completedSequence.pending.length, 0)

      // Terminate Chromium's real playback Renderer while a new attempt is active.
      const crashStart = await manualCall('playByMusicCode', '1002')
      assert.equal(crashStart.outcome, 'started')
      const crashedAttempt = (await state()).attemptId
      await waitState('playing', crashedAttempt, 10000)
      // Establish the baseline after the intentional start. Only events after
      // the Renderer is crashed can indicate an unintended restart.
      const crashEventsBefore = (await events()).length
      const rendererCrash = page.waitForEvent('crash', { timeout: 15000 })
      await app.evaluate(({ app }) => app.__kqPlayerPlaybackTest.crashRenderer())
      await rendererCrash
      await waitState('uncertain', crashedAttempt, 10000)
      assert.equal(await app.evaluate(({ app }) => app.__kqPlayerPlaybackTest.isRendererCrashed()), true,
        'the test must observe an actual Chromium Renderer process crash')
      const afterRendererCrash = (await events()).slice(crashEventsBefore)
      assert.equal(afterRendererCrash.filter(event => event.type === 'natural-end-candidate').length, 0,
        'Renderer termination must not be classified as natural completion')
      assert.ok(afterRendererCrash.some(event =>
        event.type === 'interrupted' && event.attemptId === crashedAttempt && event.reason === 'host-terminated'))
      assert.ok(afterRendererCrash.some(event => event.type === 'uncertain' && event.attemptId === crashedAttempt))
      assert.equal(afterRendererCrash.some(event => event.type === 'state-changed' &&
        event.state.status === 'playing' && event.state.attemptId === crashedAttempt), false,
      'the failed Renderer must not restart playback automatically')

      await app.evaluate(async ({ app }) => await app.__kqPlayerPlaybackTest.shutdown())
      await app.close()
      app = undefined
      const leftovers = fs.readdirSync(profileRoot)
      assert.equal(leftovers.some(name => /karaoke\.sqlite/.test(name)), false)
      process.stdout.write(`PASS playback Electron integration; Chromium EOF observed for 01001 (${Math.round(eofDuration)}s), active-renderer crash classified uncertain.\n`)
    } finally {
      if (app) {
        await app.evaluate(async ({ app }) => await app.__kqPlayerPlaybackTest?.shutdown()).catch(() => {})
        await app.close().catch(() => {})
      }
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  }

  run().catch(error => { console.error(error); process.exitCode = 1 })
}
