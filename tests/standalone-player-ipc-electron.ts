// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { _electron: electron } = require('playwright')

if (process.env.KQ_STANDALONE_IPC_E2E_MAIN === '1') {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const projectRoot = process.env.KQ_PROJECT_ROOT
  const htmlPath = process.env.KQ_STANDALONE_IPC_HTML
  const profileRoot = process.env.KQ_STANDALONE_IPC_PROFILE
  if (!projectRoot || !htmlPath || !profileRoot || !fs.existsSync(htmlPath)) {
    throw new Error('Standalone IPC E2E requires isolated test paths.')
  }
  const { StandalonePlayerSequence } = require(path.join(projectRoot, 'build/src/standalone-player-sequence.js'))
  const { installStandalonePlayerMainIpcBridge } = require(path.join(projectRoot, 'build/src/standalone-player-ipc.js'))
  const { FakeStandalonePlayback } = require(path.join(projectRoot, 'build/tests/helpers/fake-standalone-playback.js'))

  app.setPath('userData', profileRoot)
  void app.whenReady().then(async () => {
    const playback = new FakeStandalonePlayback()
    const sequence = await StandalonePlayerSequence.create({ createPlayback: () => playback })
    const window = new BrowserWindow({
      show: false,
      width: 640,
      height: 400,
      webPreferences: {
        preload: path.join(projectRoot, 'build/standalone-player-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    const bridge = installStandalonePlayerMainIpcBridge({
      ipcMain,
      webContents: window.webContents,
      expectedDocumentUrl: pathToFileURL(htmlPath).href,
      control: sequence
    })
    const gates = new Map()
    const testApi = {
      holdValidation: code => { gates.set(code, playback.holdValidation(code)); return true },
      waitValidationStarted: code => gates.get(code).started,
      releaseValidation: code => { gates.get(code).release(); gates.delete(code) },
      holdNextStop: () => { gates.set('next-stop', playback.holdNextStop()); return true },
      waitNextStopStarted: () => gates.get('next-stop').started,
      releaseNextStop: () => { gates.get('next-stop').release(); gates.delete('next-stop') },
      completeNaturally: () => playback.completeNaturally(),
      getStarts: () => [...playback.starts],
      getSnapshot: () => sequence.getSnapshot(),
      subscriberListenerCount: () => playback.listenerCount,
      shutdown: async () => {
        bridge.dispose()
        await sequence.dispose()
        return { starts: [...playback.starts], disposeCount: playback.disposeCount, subscriptions: playback.listenerCount }
      }
    }
    app.__kqStandaloneIpcTest = testApi
    globalThis.__kqStandaloneIpcTest = testApi
    await window.loadFile(htmlPath)
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
} else {
  async function run(): Promise<void> {
  const projectRoot = path.resolve(__dirname, '../..')
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-ipc-e2e-'))
  const profileRoot = path.join(tempRoot, 'profile')
  const htmlPath = path.join(tempRoot, 'standalone-ipc-test.html')
  const mainEntry = path.join(tempRoot, 'standalone-ipc-main.cjs')
  fs.mkdirSync(profileRoot)
  fs.writeFileSync(htmlPath, '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
  fs.writeFileSync(mainEntry, `require(${JSON.stringify(__filename)})`)

  let app
  let completed = false
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
        KQ_STANDALONE_IPC_E2E_MAIN: '1',
        KQ_PROJECT_ROOT: projectRoot,
        KQ_STANDALONE_IPC_HTML: htmlPath,
        KQ_STANDALONE_IPC_PROFILE: profileRoot
      },
      timeout: 30000
    })
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => typeof window.standalonePlayer?.subscribe === 'function')
    const exposure = await page.evaluate(() => ({
      standalone: typeof window.standalonePlayer,
      legacyPlayer: typeof window.karaokePlayer,
      database: typeof window.karaokeDatabase,
      require: typeof window.require,
      ipcRenderer: typeof window.ipcRenderer
    }))
    assert.deepEqual(exposure, {
      standalone: 'object', legacyPlayer: 'undefined', database: 'undefined', require: 'undefined', ipcRenderer: 'undefined'
    }, 'the dedicated preload exposes only the narrow Standalone bridge')
    assert.deepEqual(await page.evaluate(() => Object.keys(window.standalonePlayer).sort()),
      ['execute', 'getSnapshot', 'subscribe', 'unsubscribe'], 'the bridge exposes no generic IPC method')

    const firstSubscription = await page.evaluate(async () => {
      window.__updates = []
      window.__subscription = await window.standalonePlayer.subscribe(envelope => window.__updates.push(envelope))
      return { subscription: window.__subscription, updates: window.__updates }
    })
    assert.equal(firstSubscription.updates.length, 1)
    assert.equal(firstSubscription.updates[0].revision, 0)
    assert.equal(firstSubscription.updates[0].snapshot.state.operationalState, 'idle')
    assert.equal((await page.evaluate(() => window.standalonePlayer.getSnapshot())).revision, 0)
    const immutableSnapshot = await page.evaluate(async () => {
      const original = window.__updates[0]
      window.__secondSubscriptionUpdates = []
      window.__secondSubscription = await window.standalonePlayer.subscribe(envelope =>
        window.__secondSubscriptionUpdates.push(envelope))
      try { original.snapshot.state.operationalState = 'playing' } catch {}
      try { original.snapshot.state.pending.push({ entryId: 'renderer', musicCode: '09999' }) } catch {}
      const latest = await window.standalonePlayer.getSnapshot()
      return {
        currentState: latest.snapshot.state.operationalState,
        pendingLength: latest.snapshot.state.pending.length,
        secondState: window.__secondSubscriptionUpdates.at(-1).snapshot.state.operationalState,
        secondPendingLength: window.__secondSubscriptionUpdates.at(-1).snapshot.state.pending.length
      }
    })
    assert.deepEqual(immutableSnapshot, {
      currentState: 'idle', pendingLength: 0, secondState: 'idle', secondPendingLength: 0
    }, 'each Renderer callback receives a detached DTO and cannot mutate the Preload cache or another subscription')
    const secondSubscriptionRef = await page.evaluate(() => window.__secondSubscription)
    assert.equal(await page.evaluate(reference => window.standalonePlayer.unsubscribe(reference), secondSubscriptionRef), true)

    const request = { operationId: 'electron-op-1', command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' } }
    const firstResult = await page.evaluate(value => window.standalonePlayer.execute(value), request)
    assert.equal(firstResult.operationId, request.operationId)
    assert.equal(firstResult.outcome, 'confirmed')
    assert.equal(firstResult.attemptId, 'fake-attempt-1')
    assert.equal(firstResult.envelope.snapshot.state.current.musicCode, '01001')
    const detachedReplies = await page.evaluate(async value => {
      const reply = await window.standalonePlayer.execute(value)
      try { reply.envelope.snapshot.state.current.musicCode = '09999' } catch {}
      const query = await window.standalonePlayer.getSnapshot()
      const queryCode = query.snapshot.state.current?.musicCode
      try { query.snapshot.state.current.musicCode = '09998' } catch {}
      const afterQueryMutation = await window.standalonePlayer.getSnapshot()
      return { queryCode, afterQueryMutation: afterQueryMutation.snapshot.state.current?.musicCode }
    }, request)
    assert.deepEqual(detachedReplies, { queryCode: '01001', afterQueryMutation: '01001' },
      'execute and getSnapshot each return a detached DTO copy')
    const duplicateResult = await page.evaluate(value => window.standalonePlayer.execute(value), request)
    assert.equal(duplicateResult.outcome, 'confirmed')
    assert.deepEqual(await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.getStarts()), ['01001'],
      'same operationId is deduplicated by the existing runtime')

    const conflict = await page.evaluate(value => window.standalonePlayer.execute(value), {
      ...request, command: { ...request.command, enteredCode: '1002' }
    })
    assert.equal(conflict.outcome, 'rejected')
    assert.equal(conflict.error.code, 'OPERATION_ID_CONFLICT')
    assert.equal(conflict.envelope.snapshot.state.current.musicCode, '01001')

    const normal = await page.evaluate(() => window.standalonePlayer.execute({
      operationId: 'electron-op-2', command: { type: 'submit-code', enteredCode: '1002', priority: 'normal' }
    }))
    assert.equal(normal.outcome, 'confirmed')
    assert.equal(normal.attemptId, undefined, 'a queued request is not correlated to the currently playing attempt')
    const priority = await page.evaluate(() => window.standalonePlayer.execute({
      operationId: 'electron-op-3', command: { type: 'submit-code', enteredCode: '1111', priority: 'priority' }
    }))
    assert.equal(priority.outcome, 'confirmed')
    assert.deepEqual(priority.envelope.snapshot.state.pending.map(item => item.musicCode), ['01111', '01002'])
    const pause = await page.evaluate(() => window.standalonePlayer.execute({ operationId: 'electron-op-4', command: { type: 'toggle-pause' } }))
    assert.equal(pause.envelope.snapshot.state.operationalState, 'paused')
    assert.equal(pause.attemptId, 'fake-attempt-1', 'pause identifies the attempt it operated on')
    const addedWhilePaused = await page.evaluate(() => window.standalonePlayer.execute({
      operationId: 'electron-op-5', command: { type: 'submit-code', enteredCode: '1003', priority: 'normal' }
    }))
    assert.equal(addedWhilePaused.envelope.snapshot.state.operationalState, 'paused')

    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.holdValidation('01004'))
    const delayedRequest = { operationId: 'electron-reload-retry', command: { type: 'submit-code', enteredCode: '1004', priority: 'normal' } }
    await page.evaluate(value => {
      window.__delayedCommand = window.standalonePlayer.execute(value)
      return true
    }, delayedRequest)
    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.waitValidationStarted('01004'))

    const oldGeneration = firstSubscription.subscription.generation
    await page.reload()
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => typeof window.standalonePlayer?.subscribe === 'function')
    const reloadedSubscription = await page.evaluate(async () => {
      window.__updates = []
      window.__subscription = await window.standalonePlayer.subscribe(envelope => window.__updates.push(envelope))
      return { subscription: window.__subscription, updates: window.__updates }
    })
    assert.ok(reloadedSubscription.subscription.generation > oldGeneration)
    assert.ok(reloadedSubscription.updates.length >= 1)
    assert.equal(reloadedSubscription.updates[0].snapshot.state.operationalState, 'paused',
      'reload reconnects to current state without changing playback or queue')

    await page.evaluate(value => {
      window.__retryCommand = window.standalonePlayer.execute(value)
      return true
    }, delayedRequest)
    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.releaseValidation('01004'))
    const retried = await page.evaluate(async () => await window.__retryCommand)
    assert.equal(retried.operationId, delayedRequest.operationId)
    assert.equal(retried.outcome, 'confirmed')
    assert.equal(retried.envelope.snapshot.state.operationalState, 'paused')

    const latest = await page.evaluate(() => window.standalonePlayer.getSnapshot())
    assert.deepEqual(latest.snapshot.state.pending.map(item => item.musicCode), ['01111', '01002', '01003', '01004'])
    const revisions = await page.evaluate(() => window.__updates.map(envelope => envelope.revision))
    assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]),
      'Renderer receives only monotonically increasing snapshot revisions')

    const resumed = await page.evaluate(() => window.standalonePlayer.execute({
      operationId: 'electron-op-resume', command: { type: 'toggle-pause' }
    }))
    assert.equal(resumed.envelope.snapshot.state.operationalState, 'playing')
    const restarted = await page.evaluate(() => window.standalonePlayer.execute({
      operationId: 'electron-op-restart', command: { type: 'restart' }
    }))
    assert.equal(restarted.outcome, 'confirmed')
    assert.equal(restarted.attemptId, 'fake-attempt-2')
    assert.equal(restarted.envelope.snapshot.state.current.musicCode, '01001')
    const next = await page.evaluate(() => window.standalonePlayer.execute({
      operationId: 'electron-op-next', command: { type: 'next' }
    }))
    assert.equal(next.outcome, 'confirmed')
    assert.equal(next.envelope.snapshot.state.current.musicCode, '01111')
    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.completeNaturally())
    await page.waitForFunction(() => window.__updates.some(envelope =>
      envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.current?.musicCode === '01002'))

    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.holdNextStop())
    await page.evaluate(() => {
      window.__nextRacingEof = window.standalonePlayer.execute({
        operationId: 'electron-next-racing-eof', command: { type: 'next' }
      })
    })
    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.waitNextStopStarted())
    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.completeNaturally())
    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.releaseNextStop())
    const nextRacingEof = await page.evaluate(async () => await window.__nextRacingEof)
    assert.equal(nextRacingEof.outcome, 'confirmed')
    assert.equal(nextRacingEof.envelope.snapshot.state.current.musicCode, '01003',
      'a natural completion racing with Next crosses the IPC boundary as one sequence transition')
    assert.equal(nextRacingEof.attemptId, nextRacingEof.envelope.snapshot.state.current.attemptId,
      'the response attemptId belongs to the newly confirmed current entry')
    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.completeNaturally())
    await page.waitForFunction(() => window.__updates.some(envelope =>
      envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.current?.musicCode === '01004'))
    await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.completeNaturally())
    await page.waitForFunction(() => window.__updates.some(envelope =>
      envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.operationalState === 'idle'))

    const unsubscribe = await page.evaluate(async () => {
      const reference = window.__subscription
      const accepted = await window.standalonePlayer.unsubscribe(reference)
      return { accepted, updates: window.__updates.length }
    })
    assert.equal(unsubscribe.accepted, true)
    await page.evaluate(() => window.standalonePlayer.execute({
      operationId: 'electron-op-after-unsubscribe', command: { type: 'submit-code', enteredCode: '1005', priority: 'normal' }
    }))
    assert.equal(await page.evaluate(() => window.__updates.length), unsubscribe.updates,
      'unsubscribed Renderer callback receives no later state event')

    const resubscribed = await page.evaluate(async () => {
      window.__resubscriptionUpdates = []
      window.__resubscription = await window.standalonePlayer.subscribe(envelope => window.__resubscriptionUpdates.push(envelope))
      return { subscription: window.__resubscription, updates: window.__resubscriptionUpdates }
    })
    assert.equal(resubscribed.updates.length, 1, 'a fresh subscription receives the latest state as its initial snapshot')
    await page.evaluate(() => window.standalonePlayer.execute({
      operationId: 'electron-op-after-resubscribe', command: { type: 'submit-code', enteredCode: '1006', priority: 'normal' }
    }))
    assert.ok(await page.evaluate(() => window.__resubscriptionUpdates.length > 1),
      'preload can attach its state listener again after the last unsubscribe')
    await page.evaluate(() => window.standalonePlayer.unsubscribe(window.__resubscription))

    const shutdown = await app.evaluate(({ app }) => app.__kqStandaloneIpcTest.shutdown())
    assert.equal(shutdown.disposeCount, 1)
    assert.equal(shutdown.subscriptions, 0)
    assert.deepEqual(shutdown.starts, ['01001', '01111', '01002', '01003', '01004', '01005'], 'bridge operations never instantiate a second playback engine')
    assert.equal(fs.existsSync(path.join(profileRoot, 'karaoke.sqlite')), false, 'the harness never initializes Controller persistence')
    completed = true
    console.log('PASS Standalone Main/Preload IPC bridge; snapshots, V1 commands, attempt correlation, dedupe/conflict, pause, reload retry, Next/EOF arbitration, unsubscribe, and isolation verified.')
  } finally {
    if (app) await app.close().catch(() => {})
    fs.rmSync(tempRoot, { recursive: true, force: true })
    if (!completed) process.exitCode = 1
  }
  }
  void run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
