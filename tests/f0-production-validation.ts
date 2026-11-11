// @ts-nocheck
// Test-only observation/barriers installed in the real production Main. No alternate app/IPC/queue.
export {}
const assert = require('node:assert/strict')

exports.installPlaybackObservation = async (app, projectRoot) => {
  await app.evaluate((_electron, { projectRoot }) => {
    const require = process.getBuiltinModule('module').createRequire(projectRoot + '/package.json')
    const path = require('node:path')
    const { performance } = require('node:perf_hooks')
    const { PlayerPlaybackService } = require(path.join(projectRoot, 'build/src/player-playback-service'))
    const { PlayerMediaProtocol } = require(path.join(projectRoot, 'build/src/player-media-protocol'))
    const { StandalonePlayerSequence } = require(path.join(projectRoot, 'build/src/standalone-player-sequence'))
    const probe = global.__f0Structural = { states: [], submits: [], phase: 'idle' }
    const setState = PlayerPlaybackService.prototype.setState
    PlayerPlaybackService.prototype.setState = function (state) {
      const at = performance.now()
      probe.playback = this
      const result = setState.call(this, state)
      probe.states.push({ status: state.status, attemptId: state.attemptId,
        hostEpoch: this.host?.hostEpoch, at })
      return result
    }
    const execute = StandalonePlayerSequence.prototype.execute
    StandalonePlayerSequence.prototype.execute = function (request) {
      probe.sequence = this
      probe.submits.push({ type: request.command.type, at: performance.now() })
      return execute.call(this, request)
    }
    const grant = PlayerMediaProtocol.prototype.grant
    PlayerMediaProtocol.prototype.grant = function (...args) { probe.protocol = this; return grant.apply(this, args) }
  }, { projectRoot })
}

exports.validateStructuralPlayback = async ({ app, page, projectRoot, mediaRoot, logPath,
  waitForSnapshot, waitForF0LogRecord }) => {
  await waitForF0LogRecord(logPath, 'F0_LIBRARY_SCAN_METRICS')
  await exports.installPlaybackObservation(app, projectRoot)
  await app.evaluate((_electron, { projectRoot, mediaRoot }) => {
    const require = process.getBuiltinModule('module').createRequire(projectRoot + '/package.json')
    const path = require('node:path')
    const fs = require('node:fs')
    const { VideoLibraryService } = require(path.join(projectRoot, 'build/src/video-library-service'))
    const probe = global.__f0Structural
    const getSnapshot = VideoLibraryService.prototype.getSnapshot
    VideoLibraryService.prototype.getSnapshot = function () { probe.library = this; return getSnapshot.call(this) }
    const refresh = VideoLibraryService.prototype.refresh
    VideoLibraryService.prototype.refresh = function () { probe.library = this; return refresh.call(this) }
    const readdir = fs.promises.readdir
    probe.entered = new Promise(resolve => { probe.onEntered = resolve })
    const barrier = new Promise(resolve => { probe.release = resolve })
    fs.promises.readdir = async (...args) => {
      if (path.resolve(args[0]) === path.resolve(mediaRoot) && probe.phase === 'idle') {
        probe.phase = 'pending-readdir'
        probe.onEntered()
        await barrier
      }
      return readdir.apply(fs.promises, args)
    }
    probe.restore = () => { fs.promises.readdir = readdir; probe.release() }
  }, { projectRoot, mediaRoot })
  await page.evaluate(() => {
    window.__f0Events = []
    window.__f0Submits = []
    window.__f0Commands = []
    const identities = new WeakMap()
    const observed = new WeakSet()
    const attach = () => {
      const video = document.querySelector('#playback-media-layer video')
      if (!video || observed.has(video)) return
      observed.add(video)
      for (const type of ['loadedmetadata', 'playing', 'waiting', 'stalled', 'error', 'ended', 'pause', 'timeupdate']) {
        video.addEventListener(type, () => {
          const identity = identities.get(video)
          window.__f0Events.push({ type, attemptId: identity?.attemptId, at: performance.now(),
            currentTime: video.currentTime, paused: video.paused, readyState: video.readyState,
            networkState: video.networkState, established: window.__f0Events.some(e => e.type === 'playing' && e.attemptId === identity?.attemptId) })
        })
      }
    }
    window.playerPlayback.onCommand(command => {
      window.__f0Commands.push({ type: command.type, attemptId: command.attemptId,
        commandId: command.commandId, at: performance.now() })
      if (command.type === 'load') {
        const video = document.querySelector('#playback-media-layer video')
        if (video) identities.set(video, { attemptId: command.attemptId })
        attach()
      }
    })
    new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true })
  })
  try {
    // Keep a real reconciliation pending in its directory I/O, without arbitrary delays.
    await page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
    await app.evaluate(() => { global.__f0Structural.refresh = global.__f0Structural.library.refresh() })
    await app.evaluate(() => global.__f0Structural.entered)
    for (const digit of '1001') await page.keyboard.press(digit)
    await page.evaluate(() => window.__f0Submits.push(performance.now()))
    await page.keyboard.press('Enter')
    const playing = await waitForSnapshot(page, s => s.playbackCondition === 'ready' && s.state.operationalState === 'playing',
      'Main must confirm actual Chromium playback while readdir is pending')
    const attemptId = playing.state.current.attemptId
    await page.waitForFunction(id => window.__f0Events.some(e => e.type === 'playing' && e.attemptId === id), attemptId)
    await app.evaluate(() => global.__f0Structural.release())
    await page.waitForFunction(() => document.querySelector('#playback-media-layer video')?.currentTime >= 2)
    const during = await app.evaluate(() => ({ metrics: global.__f0Structural.library.getScanDiagnosticSnapshot(),
      media: global.__f0Structural.protocol.getDiagnosticMetrics() }))
    assert.equal(during.metrics.scanInProgress, true)
    assert.ok(during.metrics.playbackYieldCount > 0, 'the released scan must wait for real playback')
    assert.equal(during.metrics.lstatCalls, 0, 'no new per-file scan I/O during playback')
    assert.ok(during.media.bytesRead > 0)
    await page.keyboard.press('Space')
    await waitForSnapshot(page, s => s.playbackCondition === 'ready' && s.state.operationalState === 'paused', 'pause real media')
    assert.equal(await page.evaluate(() => document.querySelector('#playback-media-layer video').paused), true)
    const pausedAt = await page.evaluate(() => document.querySelector('#playback-media-layer video').currentTime)
    await page.keyboard.press('Space')
    await page.waitForFunction(at => {
      const video = document.querySelector('#playback-media-layer video')
      return video && !video.paused && video.currentTime > at
    }, pausedAt)
    const stop = async () => {
      await app.evaluate(() => {
        const p = global.__f0Structural.protocol
        const streams = [...p.capabilities.values()].flatMap(c => [...c.streams])
        global.__f0Structural.closures = Promise.all(streams.map(s => s.closed ? undefined :
          new Promise(resolve => s.once('close', resolve))))
      })
      await page.keyboard.press('Control+Space')
      await page.locator('#standalone-stop-confirmation').waitFor({ state: 'visible' })
      await page.locator('#stop-confirmation-confirm').click()
      await waitForSnapshot(page, s => s.playbackCondition === 'ready' && s.state.operationalState === 'idle', 'Stop confirmed while app stays open')
      // Stream close is asynchronous: wait for its counters, without requiring shutdown.
      await page.waitForFunction(() => {
        const video = document.querySelector('#playback-media-layer video')
        return !video || (video.paused && !video.getAttribute('src'))
      })
      const resources = await app.evaluate(async () => {
        const p = global.__f0Structural.protocol
        // Observe stream close events directly; no polling delay or arbitrary sleep.
        await global.__f0Structural.closures
        return p.getDiagnosticMetrics()
      })
      assert.equal(resources.activeGrants, 0)
      assert.equal(resources.activeStreams, 0)
      assert.equal(resources.fileHandlesOpened, resources.fileHandlesClosed)
      assert.equal(resources.fileHandleCloseFailures, 0)
      return resources
    }
    const afterStop = await stop()
    const refresh = await app.evaluate(() => global.__f0Structural.refresh)
    assert.equal(refresh.scanStatus, 'ready', 'background scan must resume and complete after Stop')
    for (const digit of '1001') await page.keyboard.press(digit)
    await page.evaluate(() => window.__f0Submits.push(performance.now()))
    await page.keyboard.press('Enter')
    const second = await waitForSnapshot(page, s => s.playbackCondition === 'ready' && s.state.operationalState === 'playing', 'new playback after Stop')
    assert.notEqual(second.state.current.attemptId, attemptId)
    await page.evaluate(async oldAttempt => {
      for (const type of ['playing', 'pause', 'ended']) window.playerPlayback.sendEvent({ attemptId: oldAttempt,
        sequenceNumber: 9999, observation: { type, currentTime: 9999 } })
      const old = window.__f0Commands.find(c => c.type === 'play' && c.attemptId === oldAttempt)
      if (old) await window.playerPlayback.acknowledge(old.commandId, oldAttempt, true).catch(() => undefined)
    }, attemptId)
    const drained = await app.evaluate(async () => {
      const probe = global.__f0Structural
      await probe.playback.enqueue(() => undefined)
      await probe.sequence.composition.transitions.run(() => undefined)
      return { playback: probe.playback.getState(), sequence: probe.sequence.getSnapshot() }
    })
    assert.equal(drained.playback.status, 'playing')
    assert.equal(drained.playback.attemptId, second.state.current.attemptId)
    assert.equal(drained.sequence.playbackCondition, 'ready')
    const stable = await page.evaluate(() => window.standalonePlayer.getSnapshot())
    assert.equal(stable.snapshot.state.current.attemptId, second.state.current.attemptId)
    assert.equal(stable.snapshot.state.pending.length, 0)
    await page.waitForFunction(id => window.__f0Events.some(e => e.type === 'timeupdate' && e.attemptId === id && e.currentTime >= 0.25), second.state.current.attemptId)
    await stop()
    const main = await app.evaluate(() => ({ states: global.__f0Structural.states, submits: global.__f0Structural.submits }))
    const renderer = await page.evaluate(() => ({ events: window.__f0Events, commands: window.__f0Commands, submits: window.__f0Submits }))
    assert.equal(renderer.events.some(e => e.type === 'error' || e.type === 'ended'), false)
    assert.ok(renderer.events.filter(e => e.type === 'playing').every(e => typeof e.attemptId === 'string'))
    for (const id of [attemptId, second.state.current.attemptId]) {
      const states = main.states.filter(s => s.attemptId === id)
      assert.ok(states.some(s => s.status === 'loading'))
      assert.ok(states.some(s => s.status === 'playing' && typeof s.hostEpoch === 'string'))
    }
    const timings = [attemptId, second.state.current.attemptId].map((id, index) => {
      const states = main.states.filter(s => s.attemptId === id)
      const loading = states.find(s => s.status === 'loading')
      const playing = states.find(s => s.status === 'playing')
      const mainSubmit = main.submits.filter(s => s.type === 'submit-code')[index]
      const events = renderer.events.filter(e => e.attemptId === id)
      const htmlPlaying = events.find(e => e.type === 'playing')
      const advance = events.find(e => e.type === 'timeupdate' && e.currentTime > 0 && e.at >= htmlPlaying.at)
      const loadCommand = renderer.commands.find(c => c.type === 'load' && c.attemptId === id)
      assert.ok(advance, 'each attempt must have a directly observed positive timeupdate')
      assert.ok(Number.isFinite(renderer.submits[index]), 'dispatch observation must be measured, not NaN/null')
      assert.ok(mainSubmit.at <= loading.at && loading.at <= playing.at)
      assert.ok(loadCommand.at <= htmlPlaying.at && htmlPlaying.at <= advance.at)
      return { attemptId: id, hostEpoch: loading.hostEpoch,
        mainSubmitAt: mainSubmit.at, firstDurableAttemptAndLoadingAt: loading.at, mainPlayingAt: playing.at,
        mainSubmitToPlayingMs: playing.at - mainSubmit.at,
        rendererDispatchObservedAt: renderer.submits[index], rendererActualKeydown: 'NOT_MEASURED', rendererLoadCommandAt: loadCommand.at,
        htmlPlayingAt: htmlPlaying.at, firstPositiveTimeupdateAt: advance.at,
        rendererDispatchToHtmlPlayingMs: htmlPlaying.at - renderer.submits[index],
        source: 'Main submit/state and HTML events observed directly; Renderer dispatch observed before press, actual keydown NOT_MEASURED; clocks separate; first durable attempt at load-intent' }
    })
    console.log('F0_STRUCTURAL_PLAYBACK_EVIDENCE ' + JSON.stringify({ main, renderer, timings, during, afterStop,
      timingPolicy: 'Main and Renderer monotonic clocks are separate; no subtraction across clock domains' }))
  } finally {
    await app.evaluate(() => global.__f0Structural.restore()).catch(() => undefined)
  }
}

exports.validateBootstrapBarrier = async ({ app, page, userData, scenario, waitForSnapshot, waitForF0LogRecord }) => {
  const fs = require('node:fs')
  const path = require('node:path')
  await app.evaluate(() => global.__f0Bootstrap.reached)
  const blocked = await page.evaluate(() => window.standalonePlayer.getSnapshot())
  assert.equal(blocked.snapshot.playbackCondition, 'blocked', 'Visible window must not imply operational readiness')
  // The real restricted IPC must reject playback while recovery/host readiness is held.
  const reply = await page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())
  assert.equal(reply.outcome, 'blocked')
  const probe = await app.evaluate(() => ({ enumerations: global.__f0Bootstrap.enumerations,
    hostReady: global.__f0Bootstrap.actualHostReady }))
  assert.equal(probe.hostReady, true, 'real Chromium host reached the controlled boundary')
  assert.equal(probe.enumerations, 0)
  const logPath = path.join(userData, 'logs/app.log')
  assert.equal(fs.readFileSync(logPath, 'utf8').includes('F0_LIBRARY_RECONCILIATION_ADMITTED'), false)
  if (scenario === 'ready' || scenario === 'cached-ready') {
    await app.evaluate(() => global.__f0Bootstrap.release())
    await waitForSnapshot(page, s => s.playbackCondition === 'ready' && s.state.operationalState === 'idle', 'release real Main readiness barrier')
    const usable = await waitForF0LogRecord(logPath, 'F0_STARTUP_USABLE_METRICS')
    assert.equal(usable.details.entriesEnumerated, 0)
    const admitted = await waitForF0LogRecord(logPath, 'F0_LIBRARY_RECONCILIATION_ADMITTED')
    assert.ok(admitted.details.elapsedMs >= usable.details.elapsedMs)
    await waitForF0LogRecord(logPath, 'F0_LIBRARY_SCAN_METRICS')
  }
  const exited = new Promise(resolve => app.process().once('exit', (code, signal) => resolve({ code, signal })))
  if (scenario === 'host-failed') {
    await app.evaluate(() => global.__f0Bootstrap.reject(new Error('ISOLATED_HOST_READY_FAILURE'))).catch(() => undefined)
  } else if (scenario === 'persistence-failure') {
    await app.evaluate(() => global.__f0Bootstrap.release()).catch(() => undefined)
  } else {
    // app.quit exercises production shutdown both before and after the readiness gate.
    await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
    if (scenario === 'ready' || scenario === 'cached-ready') {
      await page.locator('#standalone-exit-confirmation').waitFor({ state: 'visible' })
      await page.keyboard.press('Enter').catch(() => undefined)
    }
  }
  const result = await exited
  assert.equal(result.signal, null)
  if (scenario === 'ready' || scenario === 'cached-ready' || scenario === 'close-before-ready') assert.equal(result.code, 0)
  const records = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  if (scenario === 'host-failed' || scenario === 'persistence-failure') {
    assert.ok(records.some(r => r.event === 'APP_INITIALIZATION_FAILED'), 'the intentional failure must reach Main fatal startup handling')
  }
  if (scenario !== 'ready' && scenario !== 'cached-ready') {
    assert.equal(records.some(r => r.event === 'F0_STARTUP_USABLE_METRICS' || r.event === 'F0_LIBRARY_RECONCILIATION_ADMITTED'), false,
      'failed/never-ready/recovery-failed Main must not publish an operational or scan gate')
  }
  if (scenario === 'persistence-failure') {
    const recovery = JSON.parse(fs.readFileSync(path.join(userData, 'player-playback-recovery.json'), 'utf8'))
    assert.equal(recovery.status, 'paused', 'failed resolution must preserve the original operational record')
  }
  console.log(`PASS F0 production bootstrap ${scenario}: zero pre-gate enumeration, restricted IPC blocked, actual host boundary, confirmed process exit`)
}
