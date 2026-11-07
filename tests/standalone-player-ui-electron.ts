// @ts-nocheck
export {}

// Isolated Standalone C1-C3 UI harness. The manual/E2E seed is Main-only; normal IPC admissions from idle use
// the same authoritative countdown sequence as the operator keyboard.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { _electron: electron } = require('playwright')

if (process.env.KQ_STANDALONE_C1_UI_MAIN === '1') {
  const { app, BrowserWindow, dialog, ipcMain, protocol } = require('electron')
  const projectRoot = process.env.KQ_PROJECT_ROOT
  const mediaRoot = process.env.KQ_PLAYER_TEST_MEDIA_DIR
  const profileRoot = process.env.KQ_STANDALONE_C1_PROFILE
  const documentPath = process.env.KQ_STANDALONE_C1_DOCUMENT
  if (!projectRoot || !mediaRoot || !profileRoot || !documentPath) {
    throw new Error('The isolated Standalone C1 harness requires explicit project, media, profile, and document paths.')
  }

  const { registerPlayerMediaScheme, PlayerMediaProtocol } = require(path.join(projectRoot, 'build/src/player-media-protocol.js'))
  const { ChromiumPlaybackHost } = require(path.join(projectRoot, 'build/src/chromium-playback-host.js'))
  const { PlayerPlaybackRecoveryCoordinator } = require(path.join(projectRoot, 'build/src/player-playback-recovery.js'))
  const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build/src/player-playback-recovery-store.js'))
  const { VideoLibraryService } = require(path.join(projectRoot, 'build/src/video-library-service.js'))
  const { StandalonePlayerOptionsService } = require(path.join(projectRoot, 'build/src/standalone-player-options.js'))
  const { MusicCatalogService } = require(path.join(projectRoot, 'build/src/music-catalog-service.js'))
  const { readVideoLibraryConfiguration, writeVideoLibraryConfiguration } = require(path.join(projectRoot, 'build/src/video-library-configuration.js'))
  const { createPlayerMusicCatalogDatabase } = require(path.join(projectRoot, 'build/database.js'))
  const { createStandalonePlayerWithSharedPlayback } = require(path.join(projectRoot, 'build/src/standalone-player-playback-adapter.js'))
  const { installStandalonePlayerMainIpcBridge } = require(path.join(projectRoot, 'build/src/standalone-player-ipc.js'))

  registerPlayerMediaScheme(protocol)
  app.setPath('userData', profileRoot)
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  void app.whenReady().then(async () => {
    const persistedRoots = readVideoLibraryConfiguration(profileRoot).roots
    const initialRoots = persistedRoots.length > 0 ? persistedRoots : [mediaRoot]
    if (persistedRoots.length === 0) writeVideoLibraryConfiguration(profileRoot, initialRoots)
    const library = new VideoLibraryService(initialRoots)
    await library.refresh()
    const mediaProtocol = new PlayerMediaProtocol(library)
    mediaProtocol.install(protocol)
    const window = new BrowserWindow({
      width: 1280,
      height: 800,
      frame: false,
      show: true,
      backgroundColor: '#101011',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(projectRoot, 'build/standalone-player-ui-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    const documentUrl = pathToFileURL(documentPath).href
    const host = new ChromiumPlaybackHost(ipcMain, window.webContents, documentUrl, async () => {
      if (!window.isDestroyed()) window.destroy()
      return true
    })
    const recoveryStore = new PlayerPlaybackRecoveryStore(profileRoot)
    const recovery = new PlayerPlaybackRecoveryCoordinator(recoveryStore)
    const catalogDatabase = createPlayerMusicCatalogDatabase(profileRoot)
    const catalog = new MusicCatalogService(catalogDatabase, library)
    const folderDialogResults = []
    const catalogDialogResults = []
    let folderDialogCalls = 0
    let catalogDialogCalls = 0
    const options = new StandalonePlayerOptionsService({
      library,
      catalog,
      userDataDirectory: profileRoot,
      dialogs: {
        chooseVideoFolder: async () => {
          folderDialogCalls++
          if (folderDialogResults.length > 0) return folderDialogResults.shift()
          const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
          return !result.canceled ? result.filePaths[0] ?? null : null
        },
        chooseCatalogFile: async () => {
          catalogDialogCalls++
          if (catalogDialogResults.length > 0) return catalogDialogResults.shift()
          const result = await dialog.showOpenDialog(window, {
            properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }]
          })
          return !result.canceled ? result.filePaths[0] ?? null : null
        }
      }
    })
    const sequence = await createStandalonePlayerWithSharedPlayback({
      library,
      mediaSources: mediaProtocol,
      host,
      recovery,
      catalog,
      disposeMediaSources: () => mediaProtocol.dispose(protocol)
    })
    const bridge = installStandalonePlayerMainIpcBridge({
      ipcMain,
      webContents: window.webContents,
      expectedDocumentUrl: documentUrl,
      control: sequence,
      metadataCatalog: catalog,
      options
    })
    let exitAuthorizationNotifications = 0
    bridge.onExitAuthorized(() => { exitAuthorizationNotifications++ })
    await window.loadFile(documentPath)
    await host.ready

    let shutdownPromise
    app.__kqStandaloneC1 = {
      getSnapshot: () => sequence.getSnapshot(),
      waitForCelebration: () => new Promise((resolve, reject) => {
        const current = sequence.getSnapshot()
        if (current.playbackCondition === 'transitioning' && current.phase === 'celebration') {
          resolve(current)
          return
        }
        let unsubscribe = () => undefined
        const timeout = setTimeout(() => {
          unsubscribe()
          reject(new Error('Timed out waiting for the Main-authoritative natural EOF celebration.'))
        }, 12000)
        unsubscribe = sequence.subscribe(snapshot => {
          if (snapshot.playbackCondition !== 'transitioning' || snapshot.phase !== 'celebration') return
          clearTimeout(timeout)
          unsubscribe()
          resolve(snapshot)
        })
      }),
      waitForPlaybackAttempt: (previousAttemptId, musicCode) => new Promise((resolve, reject) => {
        const matches = snapshot => snapshot.playbackCondition === 'ready' &&
          snapshot.state.operationalState === 'playing' && snapshot.state.current.musicCode === musicCode &&
          snapshot.state.current.attemptId !== previousAttemptId
        const current = sequence.getSnapshot()
        if (matches(current)) {
          resolve(current)
          return
        }
        let unsubscribe = () => undefined
        const timeout = setTimeout(() => {
          unsubscribe()
          reject(new Error(`Timed out waiting for the new playback attempt for ${musicCode}.`))
        }, 10000)
        unsubscribe = sequence.subscribe(snapshot => {
          if (!matches(snapshot)) return
          clearTimeout(timeout)
          unsubscribe()
          resolve(snapshot)
        })
      }),
      waitForStableAttempt: (attemptId, operationalState) => new Promise((resolve, reject) => {
        const matches = snapshot => snapshot.playbackCondition === 'ready' &&
          snapshot.state.operationalState === operationalState && snapshot.state.current?.attemptId === attemptId
        const current = sequence.getSnapshot()
        if (matches(current)) {
          resolve(current)
          return
        }
        let unsubscribe = () => undefined
        const timeout = setTimeout(() => {
          unsubscribe()
          reject(new Error(`Timed out waiting for attempt ${attemptId} to become ${operationalState}.`))
        }, 10000)
        unsubscribe = sequence.subscribe(snapshot => {
          if (!matches(snapshot)) return
          clearTimeout(timeout)
          unsubscribe()
          resolve(snapshot)
        })
      }),
      waitForIdle: () => new Promise((resolve, reject) => {
        const matches = snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'idle'
        const current = sequence.getSnapshot()
        if (matches(current)) {
          resolve(current)
          return
        }
        let unsubscribe = () => undefined
        const timeout = setTimeout(() => {
          unsubscribe()
          reject(new Error('Timed out waiting for the Main-authoritative return to idle.'))
        }, 10000)
        unsubscribe = sequence.subscribe(snapshot => {
          if (!matches(snapshot)) return
          clearTimeout(timeout)
          unsubscribe()
          resolve(snapshot)
        })
      }),
      getCatalogMetadata: () => catalog.getMetadata(),
      getOptionsSnapshot: () => options.getSnapshot(),
      getExitAuthorizationNotifications: () => exitAuthorizationNotifications,
      waitForNextLibraryScan: () => new Promise((resolve, reject) => {
        let sawScanning = options.getSnapshot().library.scanStatus === 'scanning'
        let unsubscribe = () => undefined
        const timeout = setTimeout(() => {
          unsubscribe()
          reject(new Error('Timed out waiting for the real VideoLibraryService scan to finish.'))
        }, 15000)
        unsubscribe = options.subscribe(snapshot => {
          if (snapshot.library.scanStatus === 'scanning') {
            sawScanning = true
            return
          }
          if (!sawScanning) return
          clearTimeout(timeout)
          unsubscribe()
          resolve(snapshot)
        })
      }),
      queueVideoFolderSelection: folderPath => folderDialogResults.push(folderPath),
      queueCatalogFileSelection: filePath => catalogDialogResults.push(filePath),
      getOptionsDialogCounts: () => ({ folder: folderDialogCalls, catalog: catalogDialogCalls }),
      getLibraryConfiguration: () => readVideoLibraryConfiguration(profileRoot),
      configureLibraryRoots: roots => library.configureRoots(roots),
      importCatalog: filePath => catalog.importFile(filePath),
      getVideoState: () => window.webContents.executeJavaScript(`(() => {
        const video = document.querySelector('#playback-media-layer video')
        return video ? { paused: video.paused, ended: video.ended, currentTime: video.currentTime,
          duration: video.duration, width: video.videoWidth, height: video.videoHeight, readyState: video.readyState } : null
      })()`),
      // Test-only positioning keeps each C5 control assertion on a real, long-running MP4 segment.
      // It does not synthesize playback events; Chromium continues decoding the actual file.
      seekToBeginningForTest: () => window.webContents.executeJavaScript(`(() => {
        const video = document.querySelector('#playback-media-layer video')
        if (!video || video.paused || video.ended || !Number.isFinite(video.duration)) return false
        video.currentTime = 0
        return true
      })()`),
      // Test-only seek to the last five seconds; Chromium must still play to and emit its real `ended` event.
      seekNearNaturalEnd: () => window.webContents.executeJavaScript(`(() => {
        const video = document.querySelector('#playback-media-layer video')
        if (!video || video.paused || video.ended || !Number.isFinite(video.duration) || video.duration <= 5) return false
        video.currentTime = video.duration - 5
        return true
      })()`),
      // Main-only sample seed. The renderer cannot invoke this method through the restricted IPC bridge.
      seedPlayback: async () => sequence.executeHarnessSampleStart(),
      shutdown: async () => {
        if (shutdownPromise) return shutdownPromise
        shutdownPromise = (async () => {
          bridge.dispose()
          options.dispose()
          await sequence.dispose()
          catalogDatabase.close()
          if (!window.isDestroyed()) window.destroy()
          return {
            bridgeHandlersRemoved: true,
            playbackHostDisposed: host.disposed === true,
            userDatabaseCreated: fs.existsSync(path.join(profileRoot, 'karaoke.sqlite'))
          }
        })()
        return shutdownPromise
      }
    }
    globalThis.__kqStandaloneC1 = app.__kqStandaloneC1

    // Manual-only validation hooks; neither is available through the Renderer bridge or production UI.
    if (process.env.KQ_STANDALONE_C1_MANUAL === '1') {
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !['F10', 'F11'].includes(input.code) || input.isAutoRepeat ||
            input.control || input.alt || input.meta || input.shift) return
        event.preventDefault()
        if (input.code === 'F10') {
          console.log('[Standalone manual] Snapshot autoritativo:', JSON.stringify(sequence.getSnapshot()))
          return
        }
        if (input.code === 'F11') {
          void app.__kqStandaloneC1.seekNearNaturalEnd().then(seeked => {
            console.log(seeked
              ? '[C4 manual] Seek de teste aos últimos 5 segundos; aguardando o evento ended natural do Chromium.'
              : '[C4 manual] Seek ignorado: não há MP4 em reprodução com duração conhecida.')
          }).catch(error => console.error('[C4 manual] Seek falhou:', error))
        }
      })
    }
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
} else {
  const projectRoot = path.resolve(__dirname, '../..')
  const mediaRoot = path.resolve(process.env.KQ_PLAYER_TEST_MEDIA_DIR || '/home/chris/projetos/Video musicas e catalogo')
  const uiDocument = path.join(projectRoot, 'build/src/standalone-player.html')
  assert.ok(fs.existsSync(mediaRoot), 'The read-only real MP4 sample directory must exist.')
  assert.ok(fs.existsSync(path.join(mediaRoot, '01001.mp4')), 'The real 01001.mp4 sample must exist.')
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-c1-e2e-'))
  const profileRoot = path.join(tempRoot, 'profile')
  fs.mkdirSync(profileRoot)
  const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-standalone-c1-captures-'))
  const mainEntry = path.join(tempRoot, 'standalone-c1-main.cjs')
  fs.writeFileSync(mainEntry, `require(${JSON.stringify(__filename)})`)
  const csvFirst = path.join(tempRoot, 'catalog-first.csv')
  const csvSecond = path.join(tempRoot, 'catalog-second.csv')
  const csvPartial = path.join(tempRoot, 'catalog-partial.csv')
  const csvManyIssues = path.join(tempRoot, 'catalog-many-issues.csv')
  const csvMissing = path.join(tempRoot, 'catalog-current-track-unavailable.csv')
  const csvInvalid = path.join(tempRoot, 'catalog-invalid.csv')
  fs.writeFileSync(csvFirst, 'artista;numero;nome_musica\nBon Jovi;1001;Always\n"<svg onload=""alert(1)"">";1002;"<img src=x onerror=""alert(2)"">"\n')
  fs.writeFileSync(csvSecond, 'artista;numero;nome_musica\nBon Jovi;1001;Always (atualizada)\n')
  fs.writeFileSync(csvPartial, 'artista;numero;nome_musica\nABBA;1001;Dancing Queen\nInválido;78952770;Não truncar\nQueen;1002;The Show Must Go On\n')
  fs.writeFileSync(csvManyIssues, `artista;numero;nome_musica\n${Array.from({ length: 61 }, (_, index) =>
    `Inválido ${index + 1};78952770${index + 1};Registro ${index + 1}`).join('\n')}\nQueen;1001;The Show Must Go On\n`)
  fs.writeFileSync(csvMissing, 'artista;numero;nome_musica\nOutro artista;77777;Faixa sem correspondência\n')
  fs.writeFileSync(csvInvalid, 'coluna-errada\nvalor\n')

  async function launch(activeProfileRoot = profileRoot) {
    const app = await electron.launch({
      executablePath: require('electron'),
      args: [`--user-data-dir=${activeProfileRoot}`,
        ...(process.env.KQ_STANDALONE_C8_ONLY === '1' || process.env.KQ_STANDALONE_C9_ONLY === '1'
          ? ['--force-device-scale-factor=1'] : []),
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []), mainEntry],
      env: {
        ...process.env,
        KQ_STANDALONE_C1_UI_MAIN: '1',
        KQ_STANDALONE_C1_MANUAL: '1',
        KQ_PROJECT_ROOT: projectRoot,
        KQ_PLAYER_TEST_MEDIA_DIR: mediaRoot,
        KQ_STANDALONE_C1_PROFILE: activeProfileRoot,
        KQ_STANDALONE_C1_DOCUMENT: uiDocument
      },
      dumpio: true,
      timeout: 30000
    })
    try {
      await app.firstWindow()
      const pages = await app.windows()
      const page = pages.find(candidate => candidate.url().includes('standalone-player.html'))
      if (!page) throw new Error('The isolated one-screen Standalone window was not created: ' + JSON.stringify(pages.map(value => value.url())))
      if (process.env.KQ_STANDALONE_C8_ONLY === '1') {
        await page.setViewportSize({ width: 1280, height: 800 })
      }
      page.on('pageerror', error => console.error('[Standalone UI Renderer error]', error))
      page.on('console', message => {
        if (message.type() === 'error') console.error('[Standalone UI console error]', message.text())
      })
      page.on('requestfailed', request => console.error('[Standalone UI request failed]', request.url(), request.failure()?.errorText))
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => typeof window.standalonePlayer?.lookupMetadata === 'function' &&
        typeof window.playerPlayback?.ready === 'function' && document.body.dataset.operationalState === 'idle')
      await page.evaluate(() => document.fonts.ready)
      return { app, page }
    } catch (error) {
      await app.close()
      throw error
    }
  }

  async function callMain(app, method, ...args) {
    return app.evaluate(async ({ app }, values) => await app.__kqStandaloneC1[values[0]](...values.slice(1)), [method, ...args])
  }

  async function runExitOnly() {
    const { app, page } = await launch()
    try {
      assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })),
        { width: 1280, height: 800, dpr: 1 })
      const beforePlayback = await callMain(app, 'getSnapshot')
      await callMain(app, 'seedPlayback')
      const playing = await callMain(app, 'waitForPlaybackAttempt', beforePlayback.state.current?.attemptId ?? null, '01001')
      assert.equal(playing.state.operationalState, 'playing')
      const videoBefore = await callMain(app, 'getVideoState')
      assert.ok(videoBefore && !videoBefore.paused && videoBefore.readyState >= 2, 'C9 uses a real MP4 in Electron.')

      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.body.dataset.menuScreen === 'main')
      await page.locator('#menu-item-exit').click()
      await page.waitForFunction(() => document.body.dataset.menuScreen === 'exit-confirmation')
      const snapshotAtOpen = await callMain(app, 'getSnapshot')
      assert.equal(snapshotAtOpen.state.current.attemptId, playing.state.current.attemptId)
      assert.equal((await callMain(app, 'getVideoState')).paused, false)
      await page.waitForFunction(previousTime => {
        const video = document.querySelector('#playback-media-layer video')
        return video && !video.paused && video.currentTime > previousTime + 0.35
      }, videoBefore.currentTime)
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.body.dataset.menuScreen === 'main' &&
        document.querySelector('#standalone-exit-confirmation')?.hidden === true)
      assert.deepEqual(await callMain(app, 'getSnapshot'), snapshotAtOpen,
        'canceling the Main-coordinated modal preserves playback and the sequence.')

      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.body.dataset.menuScreen === 'closed')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.body.dataset.menuScreen === 'main')
      await page.locator('#menu-item-exit').click()
      await page.waitForFunction(() => document.body.dataset.menuScreen === 'exit-confirmation')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.body.dataset.menuScreen === 'closed' &&
        document.querySelector('#standalone-exit-confirmation')?.hidden === true)
      assert.equal(page.isClosed(), false, 'confirmation authorization alone does not quit before C9.4.')
      assert.deepEqual(await callMain(app, 'getSnapshot'), snapshotAtOpen,
        'confirmation does not call Stop All or mutate playback and queue state.')
      assert.equal((await callMain(app, 'getVideoState')).paused, false,
        'real MP4 playback continues until the later C9.4 shutdown integration.')
      assert.equal(await callMain(app, 'getExitAuthorizationNotifications'), 1,
        'Main receives one authorization notification for the Renderer-originated confirmation.')
      assert.deepEqual(await page.evaluate(() => window.standalonePlayer.requestExitConfirmation()),
        { outcome: 'authorized' }, 'the Main authorization cannot be reentered.')
    } finally {
      try { await callMain(app, 'shutdown') } catch {}
      await app.close()
    }
  }

  async function sendHarnessInput(app, keyCode) {
    await app.evaluate(({ BrowserWindow }, code) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('The isolated Standalone harness window is unavailable.')
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: code })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: code })
    }, keyCode)
  }

  async function capture(page, name, allowAnimation = false) {
    const file = path.join(captureRoot, `${name}.png`)
    // The resume feedback is intentionally transient. Disabling CSS animations
    // fast-forwards its fade to opacity zero, which would hide the state being
    // compared to the approved Doop frame.
    await page.screenshot({ path: file, animations: allowAnimation ? 'allow' : 'disabled' })
    return file
  }

  async function assertQueueCodesFit(page, expectedCodes, label) {
    const samples = await page.evaluate(async () => {
      const track = document.querySelector('.queue-track')
      const windowElement = document.querySelector('#standalone-queue-window')
      const labelElement = document.querySelector('.queue-label')
      if (!track || !windowElement || !labelElement) throw new Error('The visible queue projection is incomplete.')
      const animations = track.getAnimations()
      animations.forEach(animation => animation.pause())
      const results = []
      const measure = (time, target) => {
        animations.forEach(animation => { animation.currentTime = time })
        const windowRect = windowElement.getBoundingClientRect()
        const labelRect = labelElement.getBoundingClientRect()
        const codeRects = [...track.querySelectorAll('.queue-code')].map(code => {
          const rect = code.getBoundingClientRect()
          return { text: code.textContent, left: rect.left, right: rect.right, width: rect.width }
        })
        target.push({
          time,
          window: { left: windowRect.left, right: windowRect.right, width: windowRect.width },
          labelRight: labelRect.right,
          codeRects,
          glideStart: getComputedStyle(track).getPropertyValue('--queue-glide-start').trim(),
          glideEnd: getComputedStyle(track).getPropertyValue('--queue-glide-end').trim()
        })
      }
      for (const time of [0, 3500, 6990]) {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        measure(time, results)
      }
      const maxCodeLengthResults = []
      const codeElements = [...track.querySelectorAll('.queue-code')]
      const originalCodes = codeElements.map(code => code.textContent)
      if (codeElements.length === 5) {
        codeElements.forEach(code => { code.textContent = '99999' })
        const style = getComputedStyle(windowElement)
        const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
        const availableWidth = Math.max(0, windowElement.clientWidth - horizontalPadding)
        const safeTravel = Math.max(0, availableWidth - track.getBoundingClientRect().width)
        track.style.setProperty('--queue-glide-start', `${Math.min(8, safeTravel)}px`)
        track.style.setProperty('--queue-glide-end', `${Math.min(78, safeTravel)}px`)
        for (const time of [0, 3500, 6990]) {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          measure(time, maxCodeLengthResults)
        }
        codeElements.forEach((code, index) => { code.textContent = originalCodes[index] })
        const originalSafeTravel = Math.max(0, availableWidth - track.getBoundingClientRect().width)
        track.style.setProperty('--queue-glide-start', `${Math.min(8, originalSafeTravel)}px`)
        track.style.setProperty('--queue-glide-end', `${Math.min(78, originalSafeTravel)}px`)
      }
      animations.forEach(animation => animation.play())
      return { results, maxCodeLengthResults }
    })
    for (const sample of samples.results) {
      assert.deepEqual(sample.codeRects.map(code => code.text), expectedCodes,
        `${label}: queue matches the current Main projection at animation time ${sample.time}ms.`)
      assert.ok(sample.codeRects[0].left >= sample.labelRight - 0.5,
        `${label}: the first code remains beside, not underneath, PRÓXIMAS; first=${sample.codeRects[0].left}, labelRight=${sample.labelRight}, window=${JSON.stringify(sample.window)}, glide=${sample.glideStart}->${sample.glideEnd}.`)
      for (const code of sample.codeRects) {
        assert.ok(code.left >= sample.window.left - 0.5 && code.right <= sample.window.right + 0.5,
          `${label}: code ${code.text} is fully inside the queue window at ${sample.time}ms; ` +
          `window=${JSON.stringify(sample.window)} code=${JSON.stringify(code)} glide=${sample.glideStart}->${sample.glideEnd}.`)
      }
    }
    for (const sample of samples.maxCodeLengthResults) {
      assert.deepEqual(sample.codeRects.map(code => code.text), Array.from({ length: 5 }, () => '99999'))
      assert.ok(sample.codeRects[0].left >= sample.labelRight - 0.5,
        `${label}: five maximum-length codes remain beside PRÓXIMAS at ${sample.time}ms.`)
      for (const code of sample.codeRects) {
        assert.ok(code.left >= sample.window.left - 0.5 && code.right <= sample.window.right + 0.5,
          `${label}: max-length code ${code.text} is fully inside the queue window at ${sample.time}ms; ` +
          `window=${JSON.stringify(sample.window)} code=${JSON.stringify(code)} glide=${sample.glideStart}->${sample.glideEnd}.`)
      }
    }
  }

  async function run() {
    const c8Only = process.env.KQ_STANDALONE_C8_ONLY === '1'
    const c9Only = process.env.KQ_STANDALONE_C9_ONLY === '1'
    assert.equal(c8Only && c9Only, false, 'C8 and C9 focused harness modes cannot run simultaneously.')
    if (c9Only) {
      await runExitOnly()
      return
    }
    const context = await launch()
    const { app, page } = context
    let viewport
    let videoState
    try {
      viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
      assert.deepEqual(viewport, { width: 1280, height: 800, dpr: 1 }, 'Doop and Electron captures use the same 1280×800 viewport at 1×.')
      if (!c8Only) {
      if (!c9Only) {
      const exposure = await page.evaluate(() => ({
        standalone: Object.keys(window.standalonePlayer).sort(),
        playback: typeof window.playerPlayback,
        require: typeof window.require,
        ipcRenderer: typeof window.ipcRenderer
      }))
      assert.deepEqual(exposure, {
        standalone: ['cancelMusicCatalogImport', 'confirmMusicCatalogImport', 'execute', 'getCatalogImportIssuesPage',
          'getCurrentTrackMetadata', 'getOptionsSnapshot', 'getSnapshot', 'hidePlaybackSurface', 'importMusicCatalog', 'lookupMetadata',
          'onCatalogRevisionChanged', 'onExitConfirmationRequested', 'onOptionsChanged', 'refreshVideoLibrary',
          'requestExitConfirmation', 'resolveExitConfirmation', 'selectVideoFolder', 'showPlaybackSurface', 'subscribe', 'unsubscribe'],
        playback: 'object', require: 'undefined', ipcRenderer: 'undefined'
      })
      const imageStatus = await page.evaluate(() => [...document.images].map(image => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })))
      assert.deepEqual(imageStatus, Array.from({ length: 4 }, () => ({ complete: true, width: 1280, height: 685 })),
        'the approved project stage art is loaded in idle, countdown, loading, and celebration compositions before capture.')
      const idleSnapshot = await page.evaluate(() => window.standalonePlayer.getSnapshot())
      assert.equal(idleSnapshot.snapshot.state.operationalState, 'idle')
      assert.equal(await page.locator('#standalone-idle-panel').isVisible(), true,
        'the permanent numeric panel remains visible while the application is idle.')
      assert.equal(await page.locator('#standalone-playing-panel').isHidden(), true,
        'the temporary playback panel starts hidden in idle.')
      assert.deepEqual(await page.evaluate(() => window.standalonePlayer.lookupMetadata('1001')),
        { catalogRevision: null, title: null, artist: null }, 'an absent CSV produces an empty preview, not an IPC failure.')
      await page.keyboard.press('i')
      assert.equal(await page.locator('#standalone-current-track-info').isHidden(), true,
        'I is consumed during idle without opening current-track information or the C7 menu.')
      await capture(page, 'c1-idle')

      await page.bringToFront()
      await page.evaluate(() => { window.focus(); document.body.focus() })
      await page.keyboard.press('Control+1')
      assert.equal(await page.locator('#idle-code-digits').getAttribute('aria-label'), 'Nenhum código digitado',
        'unsupported modifiers are ignored.')
      await page.keyboard.press('Numpad1')
      await page.keyboard.press('0')
      await page.keyboard.press('0')
      await page.keyboard.press('1')
      await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Código digitado: 1001')
      assert.equal(await page.locator('#idle-title').textContent(), '—', 'catalogue absence leaves metadata blank.')

      await callMain(app, 'importCatalog', csvFirst)
      await page.waitForFunction(() => document.querySelector('#idle-title')?.textContent === 'Always' &&
        document.querySelector('#idle-artist')?.textContent === 'Bon Jovi')
      await page.keyboard.press('Control+r')
      assert.equal(await page.locator('#idle-code-digits').getAttribute('aria-label'), 'Código digitado: 1001',
        'a deferred C1 stroke does not leak Chromium’s Ctrl+R reload shortcut.')
      assert.equal(await page.locator('#idle-title').textContent(), 'Always')
      const repeatedKeyPrevented = await page.evaluate(() => {
        const event = new KeyboardEvent('keydown', { key: '1', code: 'Digit1', repeat: true, bubbles: true, cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      })
      assert.equal(repeatedKeyPrevented, true, 'auto-repeat is consumed instead of reaching the playback host or browser defaults.')
      assert.equal(await page.locator('#idle-code-digits').getAttribute('aria-label'), 'Código digitado: 1001',
        'a repeated digit does not extend the B2 buffer.')
      await page.evaluate(() => {
        const input = document.createElement('input')
        input.id = 'keyboard-priority-probe'
        document.body.append(input)
        input.focus()
      })
      await page.keyboard.press('Control+r')
      assert.equal(await page.locator('#keyboard-priority-probe').count(), 1,
        'Ctrl+R remains blocked from reloading when an editable field owns focus.')
      await page.locator('#keyboard-priority-probe').evaluate(element => element.remove())
      await page.evaluate(() => document.body.focus())
      await capture(page, 'c1-idle-code-1001')
      assert.equal(await page.locator('img[src^="data:"]').count(), 0, 'catalogue text is never interpreted as HTML.')
      assert.equal(await page.locator('svg[onload], img[onerror]').count(), 0, 'untrusted metadata cannot create executable DOM elements.')

      await page.keyboard.press('Backspace')
      await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Código digitado: 100')
      await page.waitForFunction(() => document.querySelector('#idle-title')?.textContent === '—' &&
        document.querySelector('#idle-artist')?.textContent === '—')
      await page.keyboard.press('1')
      await page.waitForFunction(() => document.querySelector('#idle-title')?.textContent === 'Always')
      assert.equal((await callMain(app, 'getSnapshot')).state.operationalState, 'idle',
        'typing and previewing a valid code alone does not start playback.')

      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Nenhum código digitado' &&
        document.querySelector('#idle-title')?.textContent === '—')
      for (const digit of '99999') await page.keyboard.press(digit)
      await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Código digitado: 99999')
      assert.equal(await page.locator('#idle-title').textContent(), '—')
      assert.equal(await page.locator('#idle-artist').textContent(), '—')
      assert.equal(await page.locator('#idle-feedback').isHidden(), true,
        'missing metadata alone does not imply missing media before Main validates the command.')
      await page.keyboard.press('6')
      assert.equal(await page.locator('#idle-code-digits').getAttribute('aria-label'), 'Código digitado: 99999',
        'the B2 buffer remains limited to five digits.')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('#idle-feedback')?.textContent?.includes('Código 99999 não encontrado.'))
      const missingIdleSnapshot = await callMain(app, 'getSnapshot')
      assert.equal(missingIdleSnapshot.state.operationalState, 'idle')
      assert.deepEqual(missingIdleSnapshot.state.pending, [], 'an absent MP4 is rejected without queue mutation.')
      await capture(page, 'c2-idle-code-missing')
      assert.equal(await page.locator('#standalone-idle-panel').isHidden(), false,
        'the idle entry footer remains visible while a feedback is shown.')
      await page.keyboard.press('Escape')

      await callMain(app, 'configureLibraryRoots', [path.join(tempRoot, 'unavailable-library')])
      for (const digit of '1001') await page.keyboard.press(digit)
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('#idle-feedback')?.textContent?.includes(
        'A disponibilidade do vídeo do código 1001 não pôde ser confirmada.'))
      const unknownIdleSnapshot = await callMain(app, 'getSnapshot')
      assert.equal(unknownIdleSnapshot.state.operationalState, 'idle')
      assert.deepEqual(unknownIdleSnapshot.state.pending, [], 'an unknown library scan is not treated as a valid idle admission.')
      await callMain(app, 'configureLibraryRoots', [mediaRoot])
      await page.keyboard.press('Escape')

      await page.keyboard.press('7')
      await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Código digitado: 7')
      await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Nenhum código digitado', undefined, { timeout: 7000 })
      assert.equal(await page.locator('#idle-title').textContent(), '—', 'the 5-second B2 inactivity timer clears both code and preview.')
      await capture(page, 'c2-idle-after-5s-inactivity')

      await page.reload()
      await page.waitForFunction(() => typeof window.standalonePlayer?.subscribe === 'function' &&
        document.body.dataset.operationalState === 'idle')
      assert.equal(await page.locator('#idle-code-digits').getAttribute('aria-label'), 'Nenhum código digitado',
        'Renderer recreation starts with no stale in-memory preview.')
      assert.equal(await page.locator('#idle-title').textContent(), '—')

      await page.bringToFront()
      for (const digit of '1001') await page.keyboard.press(digit)
      await page.waitForFunction(() => document.querySelector('#idle-title')?.textContent === 'Always' &&
        document.querySelector('#idle-artist')?.textContent === 'Bon Jovi')
      await page.keyboard.press('Enter')
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'countdown' &&
          envelope.snapshot.remainingMs === 5000 && document.querySelector('#standalone-countdown')?.hidden === false &&
          document.querySelector('#countdown-number')?.textContent === '5'
      })
      await page.keyboard.press('i')
      assert.equal(await page.locator('#standalone-current-track-info').isHidden(), true,
        'I is consumed during the Main-owned countdown without opening an overlay.')
      await page.waitForFunction(() => document.querySelector('#countdown-title')?.textContent === 'Always' &&
        document.querySelector('#countdown-artist')?.textContent === 'Bon Jovi')
      assert.equal(await callMain(app, 'getVideoState'), null,
        'the real video element is not opened while the Main-authoritative countdown is active.')
      await capture(page, 'c3-countdown-5')
      await page.waitForFunction(() => document.querySelector('#countdown-number')?.textContent === '4', undefined, { timeout: 2500 })
      await page.keyboard.press('Space')
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'countdown' &&
          envelope.snapshot.paused === true
      })
      const pausedCountdown = await page.locator('#countdown-number').textContent()
      await page.waitForTimeout(1200)
      assert.equal(await page.locator('#countdown-number').textContent(), pausedCountdown,
        'Space freezes the displayed countdown value.')
      assert.equal(await callMain(app, 'getVideoState'), null,
        'pausing countdown still does not prepare or pause an MP4.')
      await page.reload()
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'countdown' &&
          envelope.snapshot.paused === true && document.body.dataset.transitionPhase === 'countdown'
      })
      assert.equal(await page.locator('#countdown-number').textContent(), pausedCountdown,
        'reloading the Renderer preserves the Main-owned frozen countdown value.')
      await page.waitForTimeout(1200)
      assert.equal(await page.locator('#countdown-number').textContent(), pausedCountdown,
        'Renderer reload does not resume a paused Main countdown.')
      assert.equal(await callMain(app, 'getVideoState'), null,
        'Renderer reload while paused does not open the MP4.')
      await capture(page, 'c3-countdown-paused')
      await page.bringToFront()
      await page.evaluate(() => { window.focus(); document.body.focus() })
      await page.keyboard.press('Space')
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'countdown' &&
          envelope.snapshot.paused === false
      })
      const remainingBeforeReload = await page.evaluate(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'countdown'
          ? envelope.snapshot.remainingMs : -1
      })
      assert.ok(remainingBeforeReload > 0 && remainingBeforeReload < 5000)
      await page.reload()
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'countdown' &&
          envelope.snapshot.paused === false && document.body.dataset.transitionPhase === 'countdown'
      })
      const remainingAfterReload = await page.evaluate(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'countdown'
          ? envelope.snapshot.remainingMs : -1
      })
      assert.ok(remainingAfterReload > 0 && remainingAfterReload <= remainingBeforeReload && remainingAfterReload < 5000,
        'reloading the Renderer does not reset the running Main countdown or start a second timer.')
      assert.equal(await callMain(app, 'getVideoState'), null,
        'Renderer reload while running still does not open the MP4 early.')
      await page.bringToFront()
      await page.evaluate(() => { window.focus(); document.body.focus() })
      await page.waitForFunction(() => document.body.dataset.transitionPhase === 'loading', undefined, { timeout: 7000 })
      await page.keyboard.press('i')
      assert.equal(await page.locator('#standalone-current-track-info').isHidden(), true,
        'I has no effect while the next MP4 is loading.')
      await capture(page, 'c3-loading-real-start')
      await page.waitForFunction(() => {
        const video = document.querySelector('#playback-media-layer video')
        return document.body.dataset.operationalState === 'playing' && video && !video.paused && video.readyState >= 2 &&
          video.currentTime > 0.1 && video.videoWidth > 0 && video.videoHeight > 0
      }, undefined, { timeout: 20000 })
      const seeded = await callMain(app, 'getSnapshot')
      assert.equal(seeded.playbackCondition, 'ready', 'Enter publishes a confirmed authoritative playback snapshot after loading.')
      assert.equal(seeded.state.operationalState, 'playing')
      assert.equal(seeded.state.current.musicCode, '01001', 'the normal operator submission starts the canonical physical video code.')
      assert.equal(await page.locator('#standalone-playing-panel').isHidden(), true,
        'idle-to-playing leaves the playback surface clean when no numeric input is active.')
      assert.equal(await page.locator('#standalone-idle-panel').isHidden(), true)
      videoState = await callMain(app, 'getVideoState')
      assert.ok(videoState.duration > 0 && videoState.width > 0 && videoState.height > 0,
        'the real MP4 is rendered by the existing Chromium playback host in the same Electron window.')
      await capture(page, 'c2-playing-clean-start')

      const c6BeforeInfo = await callMain(app, 'getSnapshot')
      const c6VideoBeforeInfo = await callMain(app, 'getVideoState')
      await page.keyboard.press('i')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false &&
        document.querySelector('#current-track-info-title')?.textContent === 'Always' &&
        document.querySelector('#current-track-info-artist')?.textContent === 'Bon Jovi')
      const c6Available = await page.evaluate(() => window.standalonePlayer.getCurrentTrackMetadata())
      assert.deepEqual(c6Available, {
        catalogRevision: c6Available.catalogRevision,
        title: 'Always', artist: 'Bon Jovi',
        entryId: c6BeforeInfo.state.current.entryId,
        attemptId: c6BeforeInfo.state.current.attemptId,
        musicCode: '01001'
      }, 'the Renderer metadata query returns the Main-correlated active entry, attempt, and code.')
      assert.equal(await page.locator('#current-track-info-number').getAttribute('aria-label'), 'Número atual: 1001')
      assert.deepEqual(await page.evaluate(() => ({
        digits: getComputedStyle(document.querySelector('#current-track-info-number span')).color,
        title: getComputedStyle(document.querySelector('#current-track-info-title')).color,
        artist: getComputedStyle(document.querySelector('#current-track-info-artist')).color
      })), { digits: 'rgb(238, 238, 244)', title: 'rgb(240, 240, 245)', artist: 'rgb(240, 240, 245)' },
      'available metadata uses the Doop text and digit colors.')
      await capture(page, 'c6-current-track-info-available')
      const c6StateWithInfo = await callMain(app, 'getSnapshot')
      const c6VideoWithInfo = await callMain(app, 'getVideoState')
      assert.deepEqual(c6StateWithInfo, c6BeforeInfo, 'opening the information panel does not mutate Main playback or queue state.')
      assert.equal(c6VideoWithInfo.paused, false)
      await page.waitForFunction(start => {
        const video = document.querySelector('#playback-media-layer video')
        return video && video.currentTime > start + 0.05
      }, c6VideoBeforeInfo.currentTime, { timeout: 3000 })
      const c6VideoAfterProgress = await callMain(app, 'getVideoState')
      assert.ok(c6VideoAfterProgress.currentTime > c6VideoBeforeInfo.currentTime,
        'the real MP4 continues playing behind the information overlay.')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === true)
      assert.equal(await page.locator('#standalone-current-track-info').isHidden(), true,
        'Esc closes current-track information; the interaction unit test verifies it does not open the C7 menu.')

      await page.keyboard.press('Space')
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.operationalState === 'paused'
      })
      await page.waitForFunction(() => document.body.dataset.operationalState === 'paused', undefined,
        { timeout: 5000 })
      await page.keyboard.press('i')
      try {
        await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false,
          undefined, { timeout: 5000 })
      } catch (error) {
        const diagnostic = await page.evaluate(async () => ({
          panelHidden: document.querySelector('#standalone-current-track-info')?.hidden,
          numericPanelHidden: document.querySelector('#standalone-playing-panel')?.hidden,
          title: document.querySelector('#current-track-info-title')?.textContent,
          activeElement: document.activeElement?.tagName,
          snapshot: (await window.standalonePlayer.getSnapshot()).snapshot,
          currentTrackMetadata: await window.standalonePlayer.getCurrentTrackMetadata()
        }))
        throw new Error(`I did not open during confirmed pause: ${JSON.stringify(diagnostic)}; ${error.message}`)
      }
      assert.equal(await page.locator('#current-track-info-title').textContent(), 'Always',
        'I also opens the confirmed current metadata while playback is paused.')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Space')
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.operationalState === 'playing'
      })

      await callMain(app, 'importCatalog', csvMissing)
      await page.keyboard.press('i')
      try {
        await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false &&
          document.querySelector('#current-track-info-title')?.textContent === 'Dados indisponíveis' &&
          document.querySelector('#current-track-info-artist')?.textContent === 'Dados indisponíveis')
      } catch (error) {
        const diagnostic = await page.evaluate(async () => ({
          panelHidden: document.querySelector('#standalone-current-track-info')?.hidden,
          title: document.querySelector('#current-track-info-title')?.textContent,
          artist: document.querySelector('#current-track-info-artist')?.textContent,
          optionsHidden: document.querySelector('#standalone-options-screen')?.hidden,
          bodyState: { operational: document.body.dataset.operationalState, phase: document.body.dataset.transitionPhase },
          snapshot: (await window.standalonePlayer.getSnapshot()).snapshot,
          currentTrackMetadata: await window.standalonePlayer.getCurrentTrackMetadata(),
          optionsSnapshot: await window.standalonePlayer.getOptionsSnapshot()
        }))
        throw new Error(`C6 unavailable metadata did not render after catalog replacement: ${JSON.stringify(diagnostic)}; ${error.message}`)
      }
      const c6Unavailable = await page.evaluate(() => window.standalonePlayer.getCurrentTrackMetadata())
      assert.equal(c6Unavailable.title, null)
      assert.equal(c6Unavailable.artist, null,
        'missing catalog metadata stays unavailable and is not inferred from the video filename.')
      assert.deepEqual(await page.evaluate(() => ({
        digits: getComputedStyle(document.querySelector('#current-track-info-number span')).color,
        title: getComputedStyle(document.querySelector('#current-track-info-title')).color,
        artist: getComputedStyle(document.querySelector('#current-track-info-artist')).color
      })), { digits: 'rgb(119, 119, 130)', title: 'rgb(240, 240, 245)', artist: 'rgb(240, 240, 245)' },
      'unavailable metadata retains the Doop muted number and full contrast for the fallback text.')
      await capture(page, 'c6-current-track-info-unavailable')
      assert.deepEqual(await callMain(app, 'getSnapshot'), c6BeforeInfo,
        'an unavailable metadata result does not alter the queue or active attempt.')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === true)
      await callMain(app, 'importCatalog', csvFirst)
      await page.keyboard.press('1')
      await page.keyboard.press('i')
      assert.equal(await page.locator('#standalone-playing-panel').isVisible(), true,
        'numeric entry retains keyboard ownership when I is pressed.')
      assert.equal(await page.locator('#playing-code-digits').getAttribute('aria-label'), 'Código digitado: 1')
      assert.equal(await page.locator('#standalone-current-track-info').isHidden(), true)
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-playing-panel')?.hidden === true)

      for (const digit of '1001') await page.keyboard.press(digit)
      await page.waitForFunction(() => document.querySelector('#standalone-playing-panel')?.hidden === false &&
        document.querySelector('#playing-code-digits')?.getAttribute('aria-label') === 'Código digitado: 1001' &&
        document.querySelector('#playing-title')?.textContent === 'Always' &&
        document.querySelector('#playing-artist')?.textContent === 'Bon Jovi')
      await capture(page, 'c2-playing-entry-open')
      await page.waitForFunction(() => document.querySelector('#standalone-playing-panel')?.hidden === true, undefined, { timeout: 7000 })
      assert.equal(await page.locator('#playing-code-digits').getAttribute('aria-label'), 'Nenhum código digitado',
        'the active entry is cleared when its five-second inactivity timer expires.')
      assert.equal(await page.locator('#playing-title').textContent(), '—')
      assert.equal(await page.locator('#playing-artist').textContent(), '—')
      await capture(page, 'c2-playing-entry-timeout')

      await page.keyboard.press('7')
      await page.waitForFunction(() => document.querySelector('#standalone-playing-panel')?.hidden === false &&
        document.querySelector('#playing-code-digits')?.getAttribute('aria-label') === 'Código digitado: 7', undefined, { timeout: 2000 })
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-playing-panel')?.hidden === true)
      assert.equal(await page.locator('#playing-code-digits').getAttribute('aria-label'), 'Nenhum código digitado',
        'Esc closes the active numeric entry without affecting playback.')

      const returnedToIdle = await page.evaluate(() => window.standalonePlayer.execute({
        operationId: 'c2-ui-panel-return-to-idle', command: { type: 'next' }
      }))
      assert.equal(returnedToIdle.outcome, 'confirmed')
      await page.waitForFunction(() => document.body.dataset.operationalState === 'idle' &&
        document.querySelector('#standalone-idle-panel')?.hidden === false &&
        document.querySelector('#standalone-playing-panel')?.hidden === true)
      assert.equal(await page.locator('#idle-code-digits').getAttribute('aria-label'), 'Nenhum código digitado',
        'returning from playback restores the permanent idle panel without stale input.')

      await page.keyboard.press('1')
      await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Código digitado: 1')
      const seededAfterIdleEntry = await callMain(app, 'seedPlayback')
      assert.equal(seededAfterIdleEntry.outcome, 'confirmed')
      await page.waitForFunction(() => document.body.dataset.operationalState === 'playing' &&
        document.querySelector('#standalone-playing-panel')?.hidden === true &&
        document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Nenhum código digitado')
      assert.equal(await page.locator('#idle-title').textContent(), '—',
        'entering playback closes any leftover idle input and clears its preview.')

      assert.equal(await callMain(app, 'seekToBeginningForTest'), true,
        'the FIFO admission assertion starts with the real MP4 away from its natural EOF deadline.')
      const playingBeforeAdmission = await callMain(app, 'getSnapshot')
      const videoBeforeAdmission = await callMain(app, 'getVideoState')
      for (const digit of '1003') await page.keyboard.press(digit)
      await page.keyboard.press('Enter')
      await page.waitForFunction(async () => {
        const snapshot = await window.standalonePlayer.getSnapshot()
        return snapshot.snapshot.playbackCondition === 'ready' && snapshot.snapshot.state.pending.length === 1 &&
          document.querySelector('#playing-feedback')?.textContent?.includes('Código 1003 adicionado ao final da sequência.')
      })
      let authoritative = await callMain(app, 'getSnapshot')
      assert.deepEqual(authoritative.state.pending.map(entry => entry.musicCode), ['01003'], 'Enter appends through the Main FIFO sequence.')
      assert.equal(authoritative.state.current.attemptId, playingBeforeAdmission.state.current.attemptId)
      assert.equal(authoritative.state.operationalState, 'playing')
      assert.equal(await page.locator('#standalone-queue').isHidden(), true,
        'the open numeric panel temporarily takes precedence over the first pending queue entry.')
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1003'],
        'the hidden queue DOM already contains the newly confirmed Main entry.')
      await page.waitForFunction(() => document.querySelector('#standalone-queue')?.hidden === false,
        undefined, { timeout: 7000 })
      assert.equal(await page.locator('#standalone-playing-panel').isHidden(), true,
        'the five-second timeout closes only the temporary numeric panel.')
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1003'],
        'the 0→1 transition appears after timeout without a playback command.')
      await capture(page, 'c5-queue-one-after-timeout')
      await assertQueueCodesFit(page, ['1003'], 'one-code queue')

      const beforeSecondAdmission = await page.evaluate(() => window.standalonePlayer.getSnapshot())
      for (const digit of '1004') await page.keyboard.press(digit)
      await page.keyboard.press('Enter')
      await page.waitForFunction(async revision => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.revision > revision && envelope.snapshot.playbackCondition === 'ready' &&
          envelope.snapshot.state.pending.length === 2
      }, beforeSecondAdmission.revision)
      authoritative = await callMain(app, 'getSnapshot')
      assert.deepEqual(authoritative.state.pending.map(entry => entry.musicCode), ['01003', '01004'],
        'multiple normal Enter admissions preserve FIFO order.')
      assert.equal(await page.locator('#standalone-queue').isHidden(), true)
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1003', '1004'],
        'the 1→2 Main revision updates the hidden queue immediately.')
      await capture(page, 'c5-queue-numeric-entry-open-current')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-queue')?.hidden === false)
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1003', '1004'],
        'Escape restores the latest FIFO queue without any intervening playback event.')
      assert.equal(authoritative.state.current.attemptId, playingBeforeAdmission.state.current.attemptId)
      await capture(page, 'c5-queue-two-after-escape')
      await assertQueueCodesFit(page, ['1003', '1004'], 'two-code queue')
      for (const digit of '1001') await page.keyboard.press(digit)
      await page.waitForFunction(() => document.querySelector('#playing-title')?.textContent === 'Always' &&
        document.querySelector('#playing-artist')?.textContent === 'Bon Jovi')
      assert.ok((await page.locator('#playing-feedback').textContent()).includes('Código 1004 adicionado ao final da sequência.'))
      await capture(page, 'c2-playing-normal-success')
      await page.waitForFunction(() => document.querySelector('#playing-feedback')?.hidden === true, undefined, { timeout: 4500 })
      assert.equal(await page.locator('#standalone-playing-panel').isHidden(), false,
        'the 3.5-second success feedback expires while the independent 5-second entry panel remains visible.')
      assert.equal(await page.locator('#playing-code-digits').getAttribute('aria-label'), 'Código digitado: 1001')
      await page.keyboard.press('Escape')

      for (const digit of '1005') await page.keyboard.press(digit)
      await page.keyboard.press('P')
      await page.waitForFunction(async () => (await window.standalonePlayer.getSnapshot()).snapshot.state?.pending?.length === 3)
      assert.equal(await page.locator('#standalone-queue').isHidden(), true)
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1005', '1003', '1004'],
        'P updates the hidden queue to the authoritative priority order.')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-queue')?.hidden === false)
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1005', '1003', '1004'],
        'closing numeric entry after P restores the latest LIFO order immediately.')
      await capture(page, 'c5-queue-three-after-priority')
      await assertQueueCodesFit(page, ['1005', '1003', '1004'], 'three-code priority queue')

      for (const digit of '1006') await page.keyboard.press(digit)
      await page.keyboard.press('P')
      await page.waitForFunction(async () => {
        const snapshot = await window.standalonePlayer.getSnapshot()
        return snapshot.snapshot.playbackCondition === 'ready' && snapshot.snapshot.state.pending.length === 4 &&
          document.querySelector('#playing-feedback')?.textContent?.includes('Código 1006 priorizado. Será a próxima música após a atual.')
      })
      authoritative = await callMain(app, 'getSnapshot')
      assert.deepEqual(authoritative.state.pending.map(entry => entry.musicCode), ['01006', '01005', '01003', '01004'],
        'multiple P admissions preserve Main-authoritative LIFO priority ahead of normal FIFO entries.')
      assert.equal(authoritative.state.current.attemptId, playingBeforeAdmission.state.current.attemptId,
        'normal and priority additions do not replace the currently playing track.')
      for (const digit of '1001') await page.keyboard.press(digit)
      await page.waitForFunction(() => document.querySelector('#playing-title')?.textContent === 'Always' &&
        document.querySelector('#playing-artist')?.textContent === 'Bon Jovi')
      await capture(page, 'c2-playing-priority-success')
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1006', '1005', '1003', '1004'],
        'a second priority changes the hidden presentation before the entry closes.')

      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-queue')?.hidden === false)
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1006', '1005', '1003', '1004'],
        'closing after a second P restores the newest priority order rather than an older snapshot.')
      await assertQueueCodesFit(page, ['1006', '1005', '1003', '1004'], 'four-code priority queue')
      for (const digit of '2002') await page.keyboard.press(digit)
      await page.keyboard.press('P')
      await page.waitForFunction(() => document.querySelector('#playing-feedback')?.textContent?.includes(
        'O vídeo do código 2002 não está disponível. A música atual continua; a fila não muda.'))
      authoritative = await callMain(app, 'getSnapshot')
      assert.deepEqual(authoritative.state.pending.map(entry => entry.musicCode), ['01006', '01005', '01003', '01004'],
        'an unavailable MP4 does not alter the confirmed FIFO/LIFO queue.')
      assert.equal(authoritative.state.current.attemptId, playingBeforeAdmission.state.current.attemptId)
      for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace')
      for (const digit of '1001') await page.keyboard.press(digit)
      await page.waitForFunction(() => document.querySelector('#playing-title')?.textContent === 'Always' &&
        document.querySelector('#playing-artist')?.textContent === 'Bon Jovi')
      await capture(page, 'c2-playing-unavailable')

      await callMain(app, 'configureLibraryRoots', [path.join(tempRoot, 'unavailable-library')])
      await page.keyboard.press('P')
      await page.waitForFunction(() => document.querySelector('#playing-feedback')?.textContent?.includes(
        'A disponibilidade do vídeo do código 1001 não pôde ser confirmada. A música atual continua; a fila não muda.'))
      authoritative = await callMain(app, 'getSnapshot')
      assert.deepEqual(authoritative.state.pending.map(entry => entry.musicCode), ['01006', '01005', '01003', '01004'],
        'an unknown library scan is not mislabeled as missing media and does not mutate the confirmed queue.')
      assert.equal(authoritative.state.current.attemptId, playingBeforeAdmission.state.current.attemptId)
      await callMain(app, 'configureLibraryRoots', [mediaRoot])

      await callMain(app, 'importCatalog', csvSecond)
      await page.waitForFunction(() => document.querySelector('#playing-title')?.textContent === 'Always (atualizada)')
      assert.equal(await page.locator('#playing-artist').textContent(), 'Bon Jovi',
        'catalog revision updates the active input preview without changing the queue.')
      const currentTimeBeforeExpiry = (await callMain(app, 'getVideoState')).currentTime
      await page.waitForFunction(() => document.querySelector('#standalone-playing-panel')?.hidden === true, undefined, { timeout: 7000 })
      assert.equal(await page.locator('#playing-code-digits').getAttribute('aria-label'), 'Nenhum código digitado',
        'the 5-second active entry timeout clears its code and preview.')
      authoritative = await callMain(app, 'getSnapshot')
      assert.equal(authoritative.state.current.attemptId, playingBeforeAdmission.state.current.attemptId)
      const videoAfterExpiry = await callMain(app, 'getVideoState')
      assert.equal(videoAfterExpiry.paused, false)
      assert.ok(videoAfterExpiry.currentTime > currentTimeBeforeExpiry,
        'closing the temporary input panel leaves the real MP4 playing.')
      await capture(page, 'c2-playing-after-5s-timeout')

      const c4PreviousAttempt = authoritative.state.current.attemptId
      await page.keyboard.press('i')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false)
      const seeked = await callMain(app, 'seekNearNaturalEnd')
      assert.equal(seeked, true, 'the test-only seek positions the real playing MP4 near its end.')
      const firstCelebration = await callMain(app, 'waitForCelebration')
      const endedVideoState = await callMain(app, 'getVideoState')
      assert.ok(endedVideoState === null || endedVideoState.ended === true,
        'the real media element either remains ended or has been removed for the approved celebration composition.')
      const c4Message = firstCelebration.message
      const approvedMessages = require(path.join(projectRoot, 'build/src/standalone-player-contracts.js')).STANDALONE_CELEBRATION_MESSAGES
      assert.equal(approvedMessages.length, 40)
      assert.ok(approvedMessages.includes(c4Message),
        `Main selects one of the approved messages; snapshot=${JSON.stringify(firstCelebration)}.`)
      await page.waitForFunction(() => document.body.dataset.transitionPhase === 'celebration')
      assert.equal(await page.locator('#standalone-current-track-info').isHidden(), true,
        'natural EOF closes current-track information before the celebration composition appears.')
      assert.equal(await page.locator('#standalone-celebration').isVisible(), true)
      assert.equal(await page.locator('#celebration-message').textContent(), c4Message)
      assert.equal(await page.locator('#celebration-continue').isVisible(), true,
        'a pending queue is announced during the celebration.')
      assert.match(await page.locator('#celebration-continue-text').textContent(), /automaticamente em [1-5]s/)
      await capture(page, 'c4-celebration-pending')

      await page.reload()
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'celebration' &&
          document.body.dataset.transitionPhase === 'celebration'
      })
      const afterRendererReload = await page.evaluate(() => window.standalonePlayer.getSnapshot())
      assert.equal(afterRendererReload.snapshot.message, c4Message,
        'reloading Renderer does not reroll the Main-selected celebration message.')
      assert.ok(afterRendererReload.snapshot.remainingMs <= firstCelebration.remainingMs,
        'Renderer reload does not restart the celebration timer.')
      assert.equal(await page.locator('#standalone-playing-panel').isHidden(), true,
        'Renderer reload during celebration does not reopen numeric entry.')
      await page.evaluate(async () => {
        window.__kqC4PhaseHistory = []
        window.__kqC4PhaseSubscription = await window.standalonePlayer.subscribe(envelope => {
          if (envelope.snapshot.playbackCondition === 'transitioning') window.__kqC4PhaseHistory.push(envelope.snapshot.phase)
        })
      })

      const celebrationBeforeConfirmation = await page.evaluate(() => window.standalonePlayer.getSnapshot())
      await page.keyboard.press('Control+Space')
      await page.waitForFunction(() => document.querySelector('#standalone-stop-confirmation')?.hidden === false)
      await page.waitForTimeout(500)
      const celebrationWithConfirmation = await page.evaluate(() => window.standalonePlayer.getSnapshot())
      assert.equal(celebrationWithConfirmation.snapshot.paused, false,
        'opening the local confirmation modal does not pause the Main celebration timer.')
      assert.ok(celebrationWithConfirmation.snapshot.remainingMs < celebrationBeforeConfirmation.snapshot.remainingMs,
        'the celebration timer continues while confirmation is open.')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-stop-confirmation')?.hidden === true)

      await page.keyboard.press('Space')
      await page.waitForFunction(async () => {
        const snapshot = (await window.standalonePlayer.getSnapshot()).snapshot
        return snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'celebration' && snapshot.paused
      })
      const pausedCelebration = await page.evaluate(() => window.standalonePlayer.getSnapshot())
      const pausedRemaining = pausedCelebration.snapshot.remainingMs
      await page.waitForTimeout(1100)
      const frozenCelebration = await page.evaluate(() => window.standalonePlayer.getSnapshot())
      assert.equal(frozenCelebration.snapshot.remainingMs, pausedRemaining,
        'Space freezes the Main timer, independently of the Renderer and ended video.')
      assert.equal(frozenCelebration.snapshot.lastConfirmedState.current.attemptId, c4PreviousAttempt,
        'pausing celebration leaves the completed attempt as the last confirmed current entry.')
      await capture(page, 'c4-celebration-paused')

      for (const digit of '1001') await page.keyboard.press(digit)
      await page.keyboard.press('Enter')
      await page.waitForFunction(async () => {
        const snapshot = (await window.standalonePlayer.getSnapshot()).snapshot
        return snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'celebration' && snapshot.pending.length === 5
      })
      for (const digit of '1001') await page.keyboard.press(digit)
      await page.keyboard.press('P')
      await page.waitForFunction(() => {
        const feedback = document.querySelector('#playing-feedback')
        return feedback?.hidden === false && feedback.textContent?.includes(
          'Código 1001 priorizado. Será a próxima música após a atual.')
      })
      await page.waitForFunction(async () => {
        const snapshot = (await window.standalonePlayer.getSnapshot()).snapshot
        return snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'celebration' && snapshot.pending.length === 6
      })
      const queueDuringCelebration = await callMain(app, 'getSnapshot')
      assert.deepEqual(queueDuringCelebration.pending.map(entry => entry.musicCode),
        ['01001', '01006', '01005', '01003', '01004', '01001'],
        'Enter appends FIFO and P inserts LIFO while the celebration is paused.')
      assert.equal(queueDuringCelebration.lastConfirmedState.current.attemptId, c4PreviousAttempt,
        'queue additions do not restart the previous media or begin the next one.')
      assert.equal(await page.locator('#standalone-playing-panel').isVisible(), true,
        'numeric input and its feedback can be shown above the celebration only after explicit typing.')
      await capture(page, 'c4-celebration-paused-input')

      await page.keyboard.press('Space')
      await page.waitForFunction(async () => {
        const snapshot = (await window.standalonePlayer.getSnapshot()).snapshot
        return snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'celebration' && !snapshot.paused
      })
      authoritative = await callMain(app, 'waitForPlaybackAttempt', c4PreviousAttempt, '01001')
      await page.waitForFunction(async expectedAttemptId => {
        const snapshot = (await window.standalonePlayer.getSnapshot()).snapshot
        return snapshot.playbackCondition === 'ready' && snapshot.state.current?.attemptId === expectedAttemptId
      }, authoritative.state.current.attemptId, { timeout: 10000 })
      assert.equal(authoritative.state.current.musicCode, '01001')
      assert.notEqual(authoritative.state.current.attemptId, c4PreviousAttempt)
      assert.deepEqual(authoritative.state.pending.map(entry => entry.musicCode), ['01006', '01005', '01003', '01004', '01001'])
      const c4Phases = await page.evaluate(() => window.__kqC4PhaseHistory)
      assert.ok(c4Phases.includes('loading'), 'the target enters the existing technical loading phase when the host prepares it.')
      assert.equal(c4Phases.includes('countdown'), false, 'C4 starts the selected next song directly, without another C3 countdown.')
      assert.equal(await page.locator('#standalone-playing-panel').isHidden(), true,
        'the next real playback begins with the clean playing composition.')
      assert.equal(await callMain(app, 'getVideoState').then(state => state.ended), false,
        'Chromium has opened the actual MP4 for the next entry.')
      await capture(page, 'c4-next-playing-clean')

      // C5-A: real HTMLMediaElement pause/resume preserves playback position and the authoritative queue.
      assert.equal(await callMain(app, 'seekToBeginningForTest'), true,
        'the C5 controls start from the beginning of the actual decoded MP4 after the longer C1-C4 scenarios.')
      const c5PlayingBeforePause = await callMain(app, 'getSnapshot')
      assert.equal(c5PlayingBeforePause.state.operationalState, 'playing')
      assert.deepEqual(c5PlayingBeforePause.state.pending.map(entry => entry.musicCode),
        ['01006', '01005', '01003', '01004', '01001'])
      await page.waitForFunction(() => document.querySelector('#standalone-queue')?.hidden === false)
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1006', '1005', '1003', '1004', '1001'],
        'the numeric queue is a visual projection of the authoritative pending snapshot in LIFO/FIFO order.')
      await assertQueueCodesFit(page, ['1006', '1005', '1003', '1004', '1001'], 'five-code queue at 1280x800')
      await capture(page, 'c5-queue')
      assert.equal(await callMain(app, 'seekToBeginningForTest'), true,
        'the pause/resume assertion starts from the beginning of the real MP4 immediately before pausing.')
      await page.keyboard.press('Space')
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.operationalState === 'paused' &&
          document.querySelector('#standalone-paused-indicator')?.hidden === false
      })
      const pausedVideo = await callMain(app, 'getVideoState')
      assert.equal(pausedVideo.paused, true, 'Space pauses the real MP4 and audio element.')
      const pausedPosition = pausedVideo.currentTime
      await page.waitForTimeout(450)
      assert.ok(Math.abs((await callMain(app, 'getVideoState')).currentTime - pausedPosition) < 0.05,
        'the paused MP4 holds its current position.')
      const pausedSnapshot = await callMain(app, 'getSnapshot')
      assert.deepEqual(pausedSnapshot.state.pending.map(entry => entry.musicCode), c5PlayingBeforePause.state.pending.map(entry => entry.musicCode))
      assert.equal(await page.locator('#standalone-paused-indicator').isVisible(), true)
      await capture(page, 'c5-paused')

      await page.keyboard.press('Space')
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.operationalState === 'playing' &&
          document.querySelector('#standalone-resuming-indicator')?.hidden === false &&
          document.querySelector('#standalone-queue')?.hidden === true
      })
      await capture(page, 'c5-resuming', true)
      await page.locator('#standalone-queue').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#standalone-resuming-indicator').isVisible(), false,
        'the authoritative queue returns after the brief resume feedback fades.')
      const resumedVideo = await callMain(app, 'getVideoState')
      assert.equal(resumedVideo.paused, false, 'Space resumes the same Chromium media element.')
      assert.ok(resumedVideo.currentTime >= pausedPosition,
        'resume continues from the paused position without replacing or restarting the attempt.')
      const resumedSnapshot = await callMain(app, 'waitForStableAttempt', c5PlayingBeforePause.state.current.attemptId, 'playing')
      assert.equal(resumedSnapshot.state.current.attemptId, c5PlayingBeforePause.state.current.attemptId)

      // C5-A: R restarts the active entry from the beginning without changing its queue occurrence or pending order.
      const beforeRestart = await callMain(app, 'getSnapshot')
      await page.keyboard.press('r')
      const afterRestart = await callMain(app, 'waitForPlaybackAttempt', beforeRestart.state.current.attemptId,
        beforeRestart.state.current.musicCode)
      assert.equal(afterRestart.state.current.entryId, beforeRestart.state.current.entryId)
      assert.equal(afterRestart.state.current.musicCode, beforeRestart.state.current.musicCode)
      assert.notEqual(afterRestart.state.current.attemptId, beforeRestart.state.current.attemptId)
      assert.deepEqual(afterRestart.state.pending.map(entry => entry.musicCode), beforeRestart.state.pending.map(entry => entry.musicCode))
      const afterRestartVideo = await callMain(app, 'getVideoState')
      assert.notEqual(afterRestartVideo, null)
      assert.equal(afterRestartVideo.paused, false)
      assert.ok(afterRestartVideo.currentTime < 2.5,
        'R starts the current MP4 near the beginning instead of restarting the queue.')
      assert.equal((await callMain(app, 'getSnapshot')).playbackCondition, 'ready', 'R does not start EOF celebration.')
      await capture(page, 'c5-restarted')

      const beforePausedRestart = await callMain(app, 'getSnapshot')
      await page.keyboard.press('Space')
      await callMain(app, 'waitForStableAttempt', beforePausedRestart.state.current.attemptId, 'paused')
      const pausedRestartState = await callMain(app, 'getSnapshot')
      await page.keyboard.press('r')
      const afterPausedRestart = await callMain(app, 'waitForPlaybackAttempt',
        pausedRestartState.state.current.attemptId, pausedRestartState.state.current.musicCode)
      assert.notEqual(afterPausedRestart.state.current.attemptId, pausedRestartState.state.current.attemptId)
      assert.equal(await page.locator('#standalone-resuming-indicator').isHidden(), true,
        'restarting a paused entry is not presented as a pause/resume action.')
      assert.equal(await page.locator('#standalone-queue').isVisible(), true,
        'the queue is not hidden by a false resume feedback after restarting from pause.')

      // C5-B: Next moves to the authoritative head and bypasses EOF celebration.
      const beforeNext = await callMain(app, 'getSnapshot')
      const queueRectBeforeInfo = await page.locator('#standalone-queue').evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      })
      await page.keyboard.press('i')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false &&
        document.querySelector('#standalone-queue')?.hidden === true)
      const pendingBeforeInfo = beforeNext.state.pending.map(entry => entry.musicCode.replace(/^0+(?=\d)/, ''))
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), pendingBeforeInfo,
        'opening I hides Próximas immediately while retaining the latest queue projection in its hidden DOM.')
      assert.deepEqual(await callMain(app, 'getSnapshot'), beforeNext,
        'temporarily hiding Próximas for I does not mutate the authoritative playback or queue snapshot.')
      await capture(page, 'c6-current-track-info-queue-hidden')

      await page.keyboard.press('Space')
      await callMain(app, 'waitForStableAttempt', beforeNext.state.current.attemptId, 'paused')
      assert.equal(await page.locator('#standalone-current-track-info').isHidden(), true,
        'the existing playback-transition rule closes I when pausing begins.')
      assert.equal(await page.locator('#standalone-queue').isHidden(), true,
        'the queue remains hidden under the existing paused-state rule.')
      await page.keyboard.press('i')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false)
      assert.equal(await page.locator('#standalone-queue').isHidden(), true,
        'I remains compatible with confirmed pause, where Próximas is already hidden.')
      await page.keyboard.press('Space')
      await callMain(app, 'waitForStableAttempt', beforeNext.state.current.attemptId, 'playing')
      assert.equal(await page.locator('#standalone-current-track-info').isHidden(), true,
        'the existing resuming transition closes I before the playback overlay takes over.')
      assert.equal(await page.locator('#standalone-queue').isHidden(), true,
        'Próximas stays hidden during the resuming feedback transition.')
      await page.waitForFunction(() => document.querySelector('#standalone-resuming-indicator')?.hidden === true)
      assert.equal(await page.locator('#standalone-queue').isVisible(), true,
        'Próximas returns after the existing resume feedback fades.')
      assert.deepEqual(await page.locator('#standalone-queue').evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      }), queueRectBeforeInfo, 'the queue returns at its original position and size without shifting the composition.')
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), pendingBeforeInfo,
        'pause/resume restores the latest Main-authoritative queue order without changing it.')

      await page.keyboard.press('i')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false &&
        document.querySelector('#standalone-queue')?.hidden === true)
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === true &&
        document.querySelector('#standalone-queue')?.hidden === false)
      assert.deepEqual(await page.locator('#standalone-queue').evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      }), queueRectBeforeInfo, 'Esc does not move or resize Próximas when it reappears.')
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), pendingBeforeInfo,
        'Esc closes I and immediately restores the latest Main-authoritative queue order.')

      await page.keyboard.press('i')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false &&
        document.querySelector('#standalone-queue')?.hidden === true)
      await page.waitForTimeout(2200)
      await page.keyboard.press('i')
      await page.waitForTimeout(1600)
      assert.equal(await page.locator('#standalone-current-track-info').isVisible(), true,
        'repeating I renews the timer past the first 3.5-second deadline.')
      assert.equal(await page.locator('#standalone-queue').isHidden(), true,
        'Próximas remains hidden while the renewed I panel is still open.')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === true &&
        document.querySelector('#standalone-queue')?.hidden === false, undefined, { timeout: 3000 })
      assert.deepEqual(await page.locator('#standalone-queue').evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      }), queueRectBeforeInfo, 'the 3.5-second timeout restores the same queue geometry.')
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), pendingBeforeInfo,
        'the queue returns in its original order after the renewed 3.5-second timer expires.')

      await page.keyboard.press('i')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false &&
        document.querySelector('#standalone-queue')?.hidden === true)
      await page.keyboard.press('Control+ArrowRight')
      const afterNext = await callMain(app, 'waitForPlaybackAttempt', beforeNext.state.current.attemptId, '01006')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === true)
      assert.deepEqual(afterNext.state.pending.map(entry => entry.musicCode), ['01005', '01003', '01004', '01001'])
      await page.waitForFunction(() => document.querySelector('#standalone-queue')?.hidden === false)
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1005', '1003', '1004', '1001'],
        'the queue follows its existing transition rules and reappears after Next closes I.')
      assert.equal(await page.locator('body').getAttribute('data-transition-phase'), 'none')
      assert.equal(await page.locator('#standalone-celebration').isHidden(), true,
        'manual Next does not enter or simulate natural EOF celebration.')
      assert.equal(await callMain(app, 'seekToBeginningForTest'), true,
        'the stop-modal scenario uses the beginning of a still-playing real MP4.')
      await capture(page, 'c5-next')

      // C6 queue updates: Main-confirmed Enter/P commands may update the hidden projection while I remains open.
      await page.keyboard.press('i')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false &&
        document.querySelector('#standalone-queue')?.hidden === true)
      const beforeInfoAdmissions = await callMain(app, 'getSnapshot')
      const enterWhileInfoOpen = await page.evaluate(() => window.standalonePlayer.execute({
        operationId: 'c6-enter-while-info-open',
        command: { type: 'submit-code', enteredCode: '1003', priority: 'normal' }
      }))
      assert.equal(enterWhileInfoOpen.outcome, 'confirmed')
      await page.waitForFunction(async length => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.pending.length === length
      }, beforeInfoAdmissions.state.pending.length + 1)
      assert.equal(await page.locator('#standalone-current-track-info').isVisible(), true,
        'a Main-confirmed Enter queue update does not close I.')
      assert.equal(await page.locator('#standalone-queue').isHidden(), true,
        'the latest Enter projection stays hidden behind I.')
      assert.deepEqual((await callMain(app, 'getSnapshot')).state.pending.map(entry => entry.musicCode),
        ['01005', '01003', '01004', '01001', '01003'])
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1005', '1003', '1004', '1001', '1003'],
        'the hidden DOM keeps the complete five-entry Main projection after Enter.')

      const priorityWhileInfoOpen = await page.evaluate(() => window.standalonePlayer.execute({
        operationId: 'c6-priority-while-info-open',
        command: { type: 'submit-code', enteredCode: '1005', priority: 'priority' }
      }))
      assert.equal(priorityWhileInfoOpen.outcome, 'confirmed')
      await page.waitForFunction(async length => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.pending.length === length
      }, beforeInfoAdmissions.state.pending.length + 2)
      assert.equal(await page.locator('#standalone-current-track-info').isVisible(), true,
        'a Main-confirmed P queue update does not close I.')
      assert.equal(await page.locator('#standalone-queue').isHidden(), true,
        'the latest priority projection stays hidden behind I.')
      const afterInfoAdmissions = await callMain(app, 'getSnapshot')
      assert.deepEqual(afterInfoAdmissions.state.pending.map(entry => entry.musicCode),
        ['01005', '01005', '01003', '01004', '01001', '01003'])
      assert.equal(afterInfoAdmissions.state.current.attemptId, afterNext.state.current.attemptId,
        'Enter/P while I is open leave the active playback attempt unchanged.')
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1005', '1005', '1003', '1004', '1001'],
        'the hidden presentation still limits Próximas to the first five entries and preserves Main order.')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === true &&
        document.querySelector('#standalone-queue')?.hidden === false)
      assert.deepEqual(await page.locator('.queue-code').allTextContents(), ['1005', '1005', '1003', '1004', '1001'],
        'Esc restores the latest priority order without exposing a stale queue projection.')
      await capture(page, 'c6-queue-restored-after-info')

      // C5-C: opening and canceling the confirmation leaves real playback and queue untouched.
      await page.keyboard.press('Control+Space')
      await page.waitForFunction(() => document.querySelector('#standalone-stop-confirmation')?.hidden === false)
      await page.keyboard.press('i')
      assert.equal(await page.locator('#standalone-current-track-info').isHidden(), true,
        'I is consumed while the existing stop confirmation modal owns keyboard input.')
      assert.equal(await page.locator('#standalone-stop-confirmation').isVisible(), true)
      const modalSnapshot = await callMain(app, 'getSnapshot')
      const modalVideoBefore = await callMain(app, 'getVideoState')
      assert.equal(modalSnapshot.state.operationalState, 'playing')
      assert.deepEqual(modalSnapshot.state.pending.map(entry => entry.musicCode), afterInfoAdmissions.state.pending.map(entry => entry.musicCode))
      assert.equal(modalVideoBefore.paused, false, 'opening confirmation does not pause the actual MP4.')
      await page.waitForTimeout(500)
      const modalVideoAfter = await callMain(app, 'getVideoState')
      assert.ok(modalVideoAfter.currentTime > modalVideoBefore.currentTime,
        'audio/video continue progressing while the modal is open.')
      await capture(page, 'c5-stop-confirmation')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('#standalone-stop-confirmation')?.hidden === true)
      assert.deepEqual(await callMain(app, 'getSnapshot'), modalSnapshot,
        'Escape cancellation performs no Main command and preserves the current playback/queue snapshot.')
      assert.equal((await callMain(app, 'getVideoState')).paused, false)

      // Confirm once; the app remains open, no celebration or stale timer may start another song.
      await page.keyboard.press('Control+Space')
      await page.waitForFunction(() => document.querySelector('#standalone-stop-confirmation')?.hidden === false)
      await page.keyboard.press('Enter')
      await page.waitForFunction(async () => {
        const envelope = await window.standalonePlayer.getSnapshot()
        return envelope.snapshot.playbackCondition === 'ready' && envelope.snapshot.state.operationalState === 'idle' &&
          envelope.snapshot.state.pending.length === 0 && document.querySelector('#standalone-stop-confirmation')?.hidden === true
      })
      await callMain(app, 'waitForIdle')
      assert.equal(await page.locator('#standalone-idle-panel').isVisible(), true)
      assert.equal(await page.locator('#standalone-queue').isHidden(), true)
      assert.equal(await page.locator('#standalone-celebration').isHidden(), true)
      assert.equal(await callMain(app, 'getVideoState'), null, 'confirmed Stop All clears the real host media element.')
      await page.waitForTimeout(700)
      const afterStopAll = await callMain(app, 'getSnapshot')
      assert.equal(afterStopAll.state.operationalState, 'idle')
      assert.deepEqual(afterStopAll.state.pending, [], 'no stale transition or EOF restarts queued media after Stop All.')
      assert.equal(await page.evaluate(() => window.standalonePlayer.getSnapshot()).then(envelope => envelope.snapshot.state.operationalState), 'idle',
        'the Electron application remains open after confirmed Stop All.')
      await capture(page, 'c5-stop-all-idle')
      await page.evaluate(async () => {
        if (window.__kqC4PhaseSubscription) await window.standalonePlayer.unsubscribe(window.__kqC4PhaseSubscription)
      })
      const shutdown = await callMain(app, 'shutdown')
      assert.deepEqual(shutdown, { bridgeHandlersRemoved: true, playbackHostDisposed: true, userDatabaseCreated: false })

      const emptyProfileRoot = path.join(tempRoot, 'profile-empty-queue')
      fs.mkdirSync(emptyProfileRoot)
      const emptyQueueRun = await launch(emptyProfileRoot)
      try {
        for (const digit of '1001') await emptyQueueRun.page.keyboard.press(digit)
        await emptyQueueRun.page.keyboard.press('Enter')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.transitionPhase === 'countdown')
        await callMain(emptyQueueRun.app, 'waitForPlaybackAttempt', null, '01001')
        assert.equal(await callMain(emptyQueueRun.app, 'seekNearNaturalEnd'), true)
        const emptyCelebration = await callMain(emptyQueueRun.app, 'waitForCelebration')
        assert.deepEqual(emptyCelebration.pending, [], 'the empty-queue scenario has no pending entries at natural EOF.')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.transitionPhase === 'celebration')
        assert.equal(await emptyQueueRun.page.locator('#celebration-message').textContent(), emptyCelebration.message)
        assert.equal(await emptyQueueRun.page.locator('#celebration-continue').isHidden(), true,
          'an empty queue does not announce a next song.')
        assert.match(await emptyQueueRun.page.locator('#celebration-footer').textContent(), /estado ocioso/)
        await capture(emptyQueueRun.page, 'c4-celebration-empty-queue')
        const idleAfterCelebration = await callMain(emptyQueueRun.app, 'waitForIdle')
        assert.equal(idleAfterCelebration.state.operationalState, 'idle')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.operationalState === 'idle' &&
          document.body.dataset.transitionPhase === 'none')

        // C5 queue regression: six pending entries remain authoritative while the panel displays only five.
        for (const digit of '1001') await emptyQueueRun.page.keyboard.press(digit)
        await emptyQueueRun.page.keyboard.press('Enter')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.transitionPhase === 'countdown')
        const queuePlayback = await callMain(emptyQueueRun.app, 'waitForPlaybackAttempt', null, '01001')
        const queuePlaybackAttempt = queuePlayback.state.current.attemptId
        const queueAdmissions = ['1002', '1003', '1004', '1005', '1006', '1002']
        for (let index = 0; index < queueAdmissions.length; index++) {
          const previousEnvelope = await emptyQueueRun.page.evaluate(() => window.standalonePlayer.getSnapshot())
          for (const digit of queueAdmissions[index]) await emptyQueueRun.page.keyboard.press(digit)
          await emptyQueueRun.page.keyboard.press('Enter')
          await emptyQueueRun.page.waitForFunction(async ({ revision, length }) => {
            const envelope = await window.standalonePlayer.getSnapshot()
            return envelope.revision > revision && envelope.snapshot.playbackCondition === 'ready' &&
              envelope.snapshot.state.pending.length === length
          }, { revision: previousEnvelope.revision, length: index + 1 })
        }
        const sixEntrySnapshot = await callMain(emptyQueueRun.app, 'getSnapshot')
        assert.deepEqual(sixEntrySnapshot.state.pending.map(entry => entry.musicCode),
          ['01002', '01003', '01004', '01005', '01006', '01002'],
          'all six entries remain in Main although only five positions are visualized.')
        assert.equal(sixEntrySnapshot.state.current.attemptId, queuePlaybackAttempt,
          'normal additions leave the real current playback attempt unchanged.')
        assert.equal(await emptyQueueRun.page.locator('#standalone-queue').isHidden(), true,
          'the numeric panel stays in front while queue updates arrive.')
        assert.deepEqual(await emptyQueueRun.page.locator('.queue-code').allTextContents(),
          ['1002', '1003', '1004', '1005', '1006'],
          'the hidden projection keeps the first five authoritative entries while there are six pending.')
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.querySelector('#standalone-queue')?.hidden === false)
        assert.deepEqual(await emptyQueueRun.page.locator('.queue-code').allTextContents(),
          ['1002', '1003', '1004', '1005', '1006'])
        await assertQueueCodesFit(emptyQueueRun.page, ['1002', '1003', '1004', '1005', '1006'],
          'six-entry queue visible window at 1280x800')
        await capture(emptyQueueRun.page, 'c5-queue-five-visible-six-pending')

        const beforeFullPriority = await emptyQueueRun.page.evaluate(() => window.standalonePlayer.getSnapshot())
        for (const digit of '1005') await emptyQueueRun.page.keyboard.press(digit)
        await emptyQueueRun.page.keyboard.press('P')
        await emptyQueueRun.page.waitForFunction(async revision => {
          const envelope = await window.standalonePlayer.getSnapshot()
          return envelope.revision > revision && envelope.snapshot.playbackCondition === 'ready' &&
            envelope.snapshot.state.pending.length === 7
        }, beforeFullPriority.revision)
        const sevenEntrySnapshot = await callMain(emptyQueueRun.app, 'getSnapshot')
        assert.deepEqual(sevenEntrySnapshot.state.pending.map(entry => entry.musicCode),
          ['01005', '01002', '01003', '01004', '01005', '01006', '01002'],
          'priority prepends one entry without discarding or reordering any previous entry.')
        assert.equal(await emptyQueueRun.page.locator('#standalone-queue').isHidden(), true)
        assert.deepEqual(await emptyQueueRun.page.locator('.queue-code').allTextContents(),
          ['1005', '1002', '1003', '1004', '1005'],
          'the hidden five-entry projection immediately moves the new priority to the head.')
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.querySelector('#standalone-queue')?.hidden === false)
        assert.deepEqual(await emptyQueueRun.page.locator('.queue-code').allTextContents(),
          ['1005', '1002', '1003', '1004', '1005'])
        assert.deepEqual((await callMain(emptyQueueRun.app, 'getSnapshot')).state.pending.map(entry => entry.musicCode),
          ['01005', '01002', '01003', '01004', '01005', '01006', '01002'],
          'the displaced code remains pending in the authoritative queue.')
        await assertQueueCodesFit(emptyQueueRun.page, ['1005', '1002', '1003', '1004', '1005'],
          'full-queue priority window at 1280x800')
        await capture(emptyQueueRun.page, 'c5-queue-priority-full')

        await emptyQueueRun.page.setViewportSize({ width: 960, height: 600 })
        await emptyQueueRun.page.waitForFunction(() => innerWidth === 960 && innerHeight === 600)
        await assertQueueCodesFit(emptyQueueRun.page, ['1005', '1002', '1003', '1004', '1005'],
          'full-queue priority window at production minimum 960x600')
        await capture(emptyQueueRun.page, 'c5-queue-priority-full-960x600')

        const beforeQueueAdvance = await callMain(emptyQueueRun.app, 'getSnapshot')
        await emptyQueueRun.page.keyboard.press('Control+ArrowRight')
        const afterQueueAdvance = await callMain(emptyQueueRun.app, 'waitForPlaybackAttempt',
          beforeQueueAdvance.state.current.attemptId, '01005')
        assert.deepEqual(afterQueueAdvance.state.pending.map(entry => entry.musicCode),
          ['01002', '01003', '01004', '01005', '01006', '01002'])
        await emptyQueueRun.page.waitForFunction(() => document.querySelector('#standalone-queue')?.hidden === false)
        assert.deepEqual(await emptyQueueRun.page.locator('.queue-code').allTextContents(),
          ['1002', '1003', '1004', '1005', '1006'],
          'the sixth pending entry appears naturally when the queue head advances.')
        await assertQueueCodesFit(emptyQueueRun.page, ['1002', '1003', '1004', '1005', '1006'],
          'queue after advancing the visible head')

        await emptyQueueRun.page.setViewportSize({ width: 1280, height: 800 })
        await emptyQueueRun.page.waitForFunction(() => innerWidth === 1280 && innerHeight === 800)
        const sixPendingBeforeInfo = await callMain(emptyQueueRun.app, 'getSnapshot')
        assert.equal(sixPendingBeforeInfo.state.pending.length, 6)
        await emptyQueueRun.page.keyboard.press('i')
        await emptyQueueRun.page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === false &&
          document.querySelector('#standalone-queue')?.hidden === true)
        assert.deepEqual(await emptyQueueRun.page.locator('.queue-code').allTextContents(),
          ['1002', '1003', '1004', '1005', '1006'],
          'I hides Próximas without changing its five-entry projection when Main has six pending entries.')
        assert.deepEqual(await callMain(emptyQueueRun.app, 'getSnapshot'), sixPendingBeforeInfo,
          'the overlay does not alter any of the six authoritative pending entries.')
        await capture(emptyQueueRun.page, 'c6-current-track-info-six-pending-hidden-queue')
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.querySelector('#standalone-current-track-info')?.hidden === true &&
          document.querySelector('#standalone-queue')?.hidden === false)
        assert.deepEqual(await emptyQueueRun.page.locator('.queue-code').allTextContents(),
          ['1002', '1003', '1004', '1005', '1006'],
          'Esc restores only the first five entries in their authoritative order.')
        await assertQueueCodesFit(emptyQueueRun.page, ['1002', '1003', '1004', '1005', '1006'],
          'queue after closing I with six entries pending at 1280x800')
        // C7 menu: preserve the real Main queue/playback while navigation keys own the Renderer.
        const c7SnapshotBeforeMenu = await callMain(emptyQueueRun.app, 'getSnapshot')
        const c7VideoBeforeMenu = await callMain(emptyQueueRun.app, 'getVideoState')
        assert.equal(c7SnapshotBeforeMenu.state.operationalState, 'playing')
        assert.equal(c7VideoBeforeMenu.paused, false)
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.querySelector('#standalone-main-menu')?.hidden === false &&
          document.body.dataset.menuScreen === 'main')
        assert.equal(await emptyQueueRun.page.locator('#menu-item-options').isDisabled(), false)
        assert.equal(await emptyQueueRun.page.locator('#menu-item-exit').isDisabled(), false,
          'C9 enables Sair while playback is active so it can use the shared confirmation flow.')
        await emptyQueueRun.page.waitForFunction(() => document.activeElement?.id === 'menu-item-commands')
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement?.id), 'menu-item-commands',
          'opening the menu moves focus to the first available action.')
        await emptyQueueRun.page.keyboard.press('ArrowDown')
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement?.id), 'menu-item-options',
          'arrow navigation reaches Options.')
        await emptyQueueRun.page.keyboard.press('Tab')
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement?.id), 'menu-item-exit',
          'Tab reaches the enabled Sair action.')
        await emptyQueueRun.page.keyboard.press('Shift+Tab')
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement?.id), 'menu-item-options')
        await capture(emptyQueueRun.page, 'c7-main-menu-c8-options-and-c9-exit-enabled')

        await emptyQueueRun.page.keyboard.press('ArrowUp')
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement?.id), 'menu-item-commands')
        await emptyQueueRun.page.keyboard.press('Enter')
        await emptyQueueRun.page.waitForFunction(() => document.querySelector('#standalone-commands-screen')?.hidden === false &&
          document.body.dataset.menuScreen === 'commands')
        await emptyQueueRun.page.waitForFunction(() => document.activeElement?.id === 'commands-screen-title')
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement?.id), 'commands-screen-title',
          'opening the command list moves focus to its heading.')
        assert.equal(await emptyQueueRun.page.locator('.command-card').count(), 10,
          'the approved command list has ten cards, counting 0–9 as one card.')
        for (const cardId of ['command-digits', 'command-enter', 'command-priority', 'command-backspace', 'command-space',
          'command-next', 'command-restart', 'command-current-track-info', 'command-home', 'command-escape']) {
          assert.equal(await emptyQueueRun.page.locator(`#${cardId}`).count(), 1, `${cardId} is present in the command list.`)
        }
        const c7TextFits = await emptyQueueRun.page.locator('.command-card').evaluateAll(cards => cards.map(card => ({
          id: card.id,
          clientHeight: card.clientHeight,
          scrollHeight: card.scrollHeight,
          descriptionHeight: card.querySelector('.command-description')?.clientHeight ?? 0,
          descriptionScrollHeight: card.querySelector('.command-description')?.scrollHeight ?? 0,
          descriptionClientWidth: card.querySelector('.command-description')?.clientWidth ?? 0,
          descriptionScrollWidth: card.querySelector('.command-description')?.scrollWidth ?? 0
        })))
        assert.ok(c7TextFits.every(card => card.scrollHeight <= card.clientHeight + 1),
          `Doop command cards do not clip vertically: ${JSON.stringify(c7TextFits)}`)
        assert.ok(c7TextFits.every(card => card.descriptionScrollHeight <= card.descriptionHeight + 1 &&
          card.descriptionScrollWidth <= card.descriptionClientWidth + 1),
        `Doop command descriptions do not clip: ${JSON.stringify(c7TextFits)}`)
        const c7DoopCommands = [
          { id: 'command-digits', shortcut: '0–9', title: 'Digitar código', description: 'Abre a entrada e insere os dígitos do código.' },
          { id: 'command-enter', shortcut: 'Enter', title: 'Adicionar música', description: 'Ocioso: inicia. Em reprodução: vai ao fim da fila. Pausado: entra no fim sem retomar.' },
          { id: 'command-priority', shortcut: 'P', title: 'Priorizar música', description: 'Ocioso: inicia. Caso contrário, vai ao início da fila pendente; a última prioridade fica primeiro.' },
          { id: 'command-backspace', shortcut: 'Backspace', title: 'Apagar dígito', description: 'Apaga digitos.' },
          { id: 'command-space', shortcut: 'Espaço', title: 'Pausar / continuar', description: 'Pause ou continue a reproducao de uma musica.' },
          { id: 'command-next', shortcut: 'Ctrl+→', title: 'Próxima música', description: 'Encerra a atual e inicia a próxima. Sem próxima, o Player fica ocioso.' },
          { id: 'command-restart', shortcut: 'R', title: 'Reiniciar música', description: 'Recomeça a música atual desde o início.' },
          { id: 'command-current-track-info', shortcut: 'I', title: 'Mostrar informações da música atual', description: 'Exibe o número, a música e o artista em reprodução.' },
          { id: 'command-home', shortcut: 'Ctrl+Espaço', title: 'Encerrar reprodução e voltar ao início', description: 'Encerra a reprodução atual e volta ao início. A fila será perdida.' },
          { id: 'command-escape', shortcut: 'Esc', title: 'Navegar pelo menu', description: 'Fecha a entrada descartando o código; em submenus, volta ao nível anterior.' }
        ]
        const c7RenderedCommands = await emptyQueueRun.page.locator('.command-card').evaluateAll(cards => cards.map(card => ({
          id: card.id,
          shortcut: card.querySelector('.key-wrap')?.textContent?.replace(/\s+/g, '') ?? '',
          title: card.querySelector('.command-name')?.textContent ?? '',
          description: card.querySelector('.command-description')?.textContent ?? ''
        })))
        assert.deepEqual(c7RenderedCommands, c7DoopCommands,
          'every command shortcut, title, description, capitalization and spelling exactly matches Doop in order.')
        assert.equal(await emptyQueueRun.page.locator('.column-title').allTextContents().then(values => values.join('|')),
          'Entrada e fila|Reprodução e navegação')
        assert.equal(await emptyQueueRun.page.locator('.commands-footer-text').textContent(), 'Voltar ao menu anterior')
        await capture(emptyQueueRun.page, 'c7-commands-v1-copy')
        await emptyQueueRun.page.keyboard.press('Tab')
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement?.id), 'commands-screen-title',
          'Tab remains inside the command-list dialog, which has no focusable command cards.')
        await emptyQueueRun.page.keyboard.press('Shift+Tab')
        await emptyQueueRun.page.keyboard.press('ArrowDown')
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement?.id), 'commands-screen-title')

        for (const key of ['1', 'Enter', 'P', 'Space', 'R', 'i', 'Control+ArrowRight', 'Control+Space']) {
          await emptyQueueRun.page.keyboard.press(key)
        }
        await emptyQueueRun.page.waitForTimeout(500)
        assert.deepEqual(await callMain(emptyQueueRun.app, 'getSnapshot'), c7SnapshotBeforeMenu,
          'menu keyboard input cannot mutate playback, queue, priorities, or Main state.')
        assert.equal(await emptyQueueRun.page.locator('#standalone-stop-confirmation').isHidden(), true,
          'Ctrl+Space is listed as a shortcut but is suppressed while the menu owns keyboard input.')
        assert.equal(await emptyQueueRun.page.locator('#standalone-current-track-info').isHidden(), true,
          'I does not open the C6 information panel while the command list is open.')
        assert.equal(await emptyQueueRun.page.locator('#standalone-playing-panel').isHidden(), true,
          'numeric input does not open behind the menu.')
        const c7VideoDuringMenu = await callMain(emptyQueueRun.app, 'getVideoState')
        assert.equal(c7VideoDuringMenu.paused, false, 'Space does not pause the real MP4 while the menu is open.')
        assert.ok(c7VideoDuringMenu.currentTime > c7VideoBeforeMenu.currentTime,
          'the real MP4 continues advancing while the menu is open.')
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.querySelector('#standalone-main-menu')?.hidden === false &&
          document.body.dataset.menuScreen === 'main')
        await emptyQueueRun.page.waitForFunction(() => document.activeElement?.id === 'menu-item-commands')
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement?.id), 'menu-item-commands',
          'Esc from the command list returns focus to the selected main-menu action.')
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.querySelector('#standalone-main-menu')?.hidden === true &&
          document.body.dataset.menuScreen === 'closed')
        await emptyQueueRun.page.waitForFunction(() => document.activeElement === document.body)
        assert.equal(await emptyQueueRun.page.evaluate(() => document.activeElement === document.body), true,
          'closing the main menu returns focus to the Player surface.')
        await emptyQueueRun.page.keyboard.press('Space')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.operationalState === 'paused')
        const pausedMenuSnapshot = await callMain(emptyQueueRun.app, 'getSnapshot')
        const pausedMenuVideo = await callMain(emptyQueueRun.app, 'getVideoState')
        assert.equal(pausedMenuVideo.paused, true)
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main')
        await emptyQueueRun.page.keyboard.press('Space')
        await emptyQueueRun.page.waitForTimeout(400)
        assert.deepEqual(await callMain(emptyQueueRun.app, 'getSnapshot'), pausedMenuSnapshot,
          'Space cannot resume or mutate paused playback while the menu is open.')
        const stillPausedVideo = await callMain(emptyQueueRun.app, 'getVideoState')
        assert.equal(stillPausedVideo.paused, true)
        assert.ok(Math.abs(stillPausedVideo.currentTime - pausedMenuVideo.currentTime) < 0.05,
          'the MP4 remains at the same paused position while the menu is open.')
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'closed')
        await emptyQueueRun.page.keyboard.press('Space')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.operationalState === 'playing')
        assert.equal((await callMain(emptyQueueRun.app, 'getVideoState')).paused, false,
          'the normal playback shortcut works again after closing the menu.')

        // The menu stays visible while the Main-authoritative celebration timer advances and starts its next item.
        const beforeMenuCelebration = await callMain(emptyQueueRun.app, 'getSnapshot')
        assert.equal(beforeMenuCelebration.state.operationalState, 'playing')
        assert.equal(await callMain(emptyQueueRun.app, 'seekNearNaturalEnd'), true)
        const menuCelebration = await callMain(emptyQueueRun.app, 'waitForCelebration')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.transitionPhase === 'celebration')
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main')
        await emptyQueueRun.page.waitForFunction(async remainingMs => {
          const envelope = await window.standalonePlayer.getSnapshot()
          return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'celebration' &&
            envelope.snapshot.remainingMs < remainingMs - 500
        }, menuCelebration.remainingMs)
        const nextAfterMenuCelebration = await callMain(emptyQueueRun.app, 'waitForPlaybackAttempt',
          beforeMenuCelebration.state.current.attemptId, menuCelebration.pending[0].musicCode)
        assert.equal(nextAfterMenuCelebration.state.operationalState, 'playing')
        assert.equal(await emptyQueueRun.page.locator('#standalone-main-menu').isVisible(), true,
          'the main menu remains open when celebration completes and the next song starts.')
        assert.equal((await callMain(emptyQueueRun.app, 'getVideoState')).paused, false)
        await capture(emptyQueueRun.page, 'c7-main-menu-after-celebration-next-start')
        await emptyQueueRun.page.keyboard.press('Escape')
        await emptyQueueRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'closed')

      } finally {
        try { await callMain(emptyQueueRun.app, 'shutdown') } catch {}
        await emptyQueueRun.app.close()
      }
      }

      // C7 countdown: Esc opens the menu, Space is consumed, and Main finishes the real countdown underneath it.
      const c7CountdownProfile = path.join(tempRoot, 'profile-c7-countdown-menu')
      if (!c9Only) fs.mkdirSync(c7CountdownProfile)
      const c7CountdownRun = c9Only ? context : await launch(c7CountdownProfile)
      try {
        // C9.4 enables Sair in the shipped UI; its request still uses the Main-coordinated modal.
        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main' &&
          document.querySelector('#menu-item-exit')?.disabled === false)
        const idleBeforeExitDialog = await callMain(c7CountdownRun.app, 'getSnapshot')
        await c7CountdownRun.page.locator('#menu-item-exit').click()
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'exit-confirmation' &&
          document.querySelector('#standalone-exit-confirmation')?.hidden === false)
        assert.equal(await c7CountdownRun.page.locator('#standalone-main-menu').isVisible(), true,
          'the main menu remains visible behind the exit dialog.')
        assert.equal(await c7CountdownRun.page.locator('#standalone-main-menu').getAttribute('aria-hidden'), 'true')
        assert.equal(await c7CountdownRun.page.locator('#standalone-main-menu').evaluate(menu => menu.inert), true,
          'the obscured menu cannot receive pointer or keyboard interaction.')
        assert.equal(await c7CountdownRun.page.locator('#exit-confirmation-title').textContent(), 'Sair do Karaoke Queue?')
        assert.equal(await c7CountdownRun.page.locator('#exit-confirmation-description').textContent(),
          'O aplicativo será fechado. Se houver uma música em reprodução, ela será interrompida.')
        assert.equal(await c7CountdownRun.page.evaluate(() => document.activeElement?.id), 'exit-confirmation-cancel',
          'the dialog opens with its primary safe action focused.')
        await capture(c7CountdownRun.page, 'c9-exit-confirmation-electron-1280x800')
        await c7CountdownRun.page.keyboard.press('Tab')
        assert.equal(await c7CountdownRun.page.evaluate(() => document.activeElement?.id), 'exit-confirmation-confirm')
        await c7CountdownRun.page.keyboard.press('Tab')
        assert.equal(await c7CountdownRun.page.evaluate(() => document.activeElement?.id), 'exit-confirmation-cancel',
          'Tab remains inside the modal.')
        await c7CountdownRun.page.keyboard.press('Shift+Tab')
        assert.equal(await c7CountdownRun.page.evaluate(() => document.activeElement?.id), 'exit-confirmation-confirm',
          'Shift+Tab wraps within the modal.')
        const obscuredOptions = await c7CountdownRun.page.locator('#menu-item-options').boundingBox()
        assert.ok(obscuredOptions)
        await c7CountdownRun.page.mouse.click(obscuredOptions.x + obscuredOptions.width / 2,
          obscuredOptions.y + obscuredOptions.height / 2)
        assert.equal(await c7CountdownRun.page.locator('#standalone-exit-confirmation').isVisible(), true,
          'clicking a control behind the modal does not activate it or close the confirmation.')
        assert.deepEqual(await callMain(c7CountdownRun.app, 'getSnapshot'), idleBeforeExitDialog,
          'opening the dialog and attempting a click behind it do not change Player state.')
        await c7CountdownRun.page.locator('#exit-confirmation-cancel').click()
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main' &&
          document.querySelector('#standalone-exit-confirmation')?.hidden === true)
        await c7CountdownRun.page.waitForFunction(() => document.activeElement?.id === 'menu-item-exit')
        assert.equal(await c7CountdownRun.page.evaluate(() => document.activeElement?.id), 'menu-item-exit',
          'Cancel restores focus to the action that opened the dialog.')
        assert.equal(await c7CountdownRun.page.locator('#standalone-main-menu').getAttribute('aria-hidden'), null)
        assert.equal(await c7CountdownRun.page.locator('#standalone-main-menu').evaluate(menu => menu.inert), false)

        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'closed')
        for (const digit of '1001') await c7CountdownRun.page.keyboard.press(digit)
        await c7CountdownRun.page.keyboard.press('Enter')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.transitionPhase === 'countdown')
        const countdownBeforeMenu = await callMain(c7CountdownRun.app, 'getSnapshot')
        assert.equal(countdownBeforeMenu.phase, 'countdown')
        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main' &&
          document.querySelector('#standalone-main-menu')?.hidden === false)
        await c7CountdownRun.page.locator('#menu-item-exit').click()
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'exit-confirmation')
        const countdownAtDialogOpen = await callMain(c7CountdownRun.app, 'getSnapshot')
        assert.equal(countdownAtDialogOpen.phase, 'countdown')
        await c7CountdownRun.page.keyboard.press('Space')
        await c7CountdownRun.page.keyboard.press('5')
        await c7CountdownRun.page.keyboard.press('P')
        await c7CountdownRun.page.keyboard.press('r')
        await c7CountdownRun.page.keyboard.press('i')
        await c7CountdownRun.page.keyboard.press('Control+Space')
        await c7CountdownRun.page.keyboard.press('Control+ArrowRight')
        await c7CountdownRun.page.waitForFunction(async remainingMs => {
          const envelope = await window.standalonePlayer.getSnapshot()
          return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'countdown' &&
            envelope.snapshot.remainingMs < remainingMs - 500
        }, countdownAtDialogOpen.remainingMs)
        await capture(c7CountdownRun.page, 'c9-exit-confirmation-countdown-continuing')
        const countdownStillOpen = await callMain(c7CountdownRun.app, 'getSnapshot')
        assert.equal(countdownStillOpen.phase, 'countdown')
        assert.deepEqual(countdownStillOpen.pending, countdownAtDialogOpen.pending,
          'Player shortcuts are consumed without changing the queue while the exit dialog is open.')
        assert.equal(await c7CountdownRun.page.locator('#standalone-exit-confirmation').isVisible(), true,
          'the dialog remains open while its underlying countdown advances.')
        await capture(c7CountdownRun.page, 'c9-exit-confirmation-countdown-continuing')
        const countdownPlayback = await callMain(c7CountdownRun.app, 'waitForPlaybackAttempt', null, '01001')
        assert.equal(countdownPlayback.state.operationalState, 'playing')
        assert.equal(await c7CountdownRun.page.locator('#standalone-exit-confirmation').isVisible(), true,
          'the exit confirmation remains open after countdown completes and the current MP4 starts.')
        assert.equal((await callMain(c7CountdownRun.app, 'getVideoState')).paused, false,
          'the actual MP4 starts and continues underneath the exit confirmation.')
        const videoAtStart = await callMain(c7CountdownRun.app, 'getVideoState')
        await c7CountdownRun.page.waitForFunction(previousTime => {
          const video = document.querySelector('#playback-media-layer video')
          return video && !video.paused && video.currentTime > previousTime + 0.35
        }, videoAtStart.currentTime)
        await capture(c7CountdownRun.page, 'c9-exit-confirmation-mp4-playing')
        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main' &&
          document.querySelector('#standalone-exit-confirmation')?.hidden === true)
        assert.equal(c7CountdownRun.page.isClosed(), false,
          'Main authorization does not close the application before the C9.4 shutdown integration.')
        assert.equal((await callMain(c7CountdownRun.app, 'getVideoState')).paused, false,
          'the MP4 remains playing because C9.4 shutdown is not part of this stage.')
        assert.deepEqual((await callMain(c7CountdownRun.app, 'getSnapshot')).state.pending, [],
          'the exit dialog does not add or remove pending entries.')
        await capture(c7CountdownRun.page, 'c9-exit-intent-does-not-shutdown')

        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'closed')
        await c7CountdownRun.page.keyboard.press('Space')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.operationalState === 'paused')
        const pausedBeforeExitDialog = await callMain(c7CountdownRun.app, 'getSnapshot')
        assert.equal((await callMain(c7CountdownRun.app, 'getVideoState')).paused, true)
        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main')
        await c7CountdownRun.page.locator('#menu-item-exit').click()
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'exit-confirmation')
        assert.deepEqual(await callMain(c7CountdownRun.app, 'getSnapshot'), pausedBeforeExitDialog,
          'opening exit confirmation leaves paused playback and the sequence unchanged.')
        assert.equal((await callMain(c7CountdownRun.app, 'getVideoState')).paused, true)
        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main' &&
          document.querySelector('#standalone-exit-confirmation')?.hidden === true)
        assert.deepEqual(await callMain(c7CountdownRun.app, 'getSnapshot'), pausedBeforeExitDialog,
          'Esc cancellation preserves paused playback and the sequence.')
        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'closed')
        await c7CountdownRun.page.keyboard.press('Space')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.operationalState === 'playing')

        assert.equal(await callMain(c7CountdownRun.app, 'seekNearNaturalEnd'), true)
        await callMain(c7CountdownRun.app, 'waitForCelebration')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.transitionPhase === 'celebration')
        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main')
        const celebrationAtDialogOpen = await callMain(c7CountdownRun.app, 'getSnapshot')
        assert.equal(celebrationAtDialogOpen.phase, 'celebration')
        await c7CountdownRun.page.locator('#menu-item-exit').click()
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'exit-confirmation')
        await c7CountdownRun.page.waitForFunction(async remainingMs => {
          const envelope = await window.standalonePlayer.getSnapshot()
          return envelope.snapshot.playbackCondition === 'transitioning' && envelope.snapshot.phase === 'celebration' &&
            !envelope.snapshot.paused && envelope.snapshot.remainingMs < remainingMs
        }, celebrationAtDialogOpen.remainingMs, { timeout: 5000 })
        const celebrationWithExitDialog = await callMain(c7CountdownRun.app, 'getSnapshot')
        assert.equal(celebrationWithExitDialog.phase, 'celebration')
        assert.deepEqual(celebrationWithExitDialog.pending, celebrationAtDialogOpen.pending,
          'the exit dialog leaves celebration and its queue unchanged while the timer continues.')
        assert.equal(await c7CountdownRun.page.locator('#standalone-exit-confirmation').isVisible(), true)
        await capture(c7CountdownRun.page, 'c9-exit-confirmation-celebration-continuing')
        await c7CountdownRun.page.keyboard.press('Escape')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'main' &&
          document.querySelector('#standalone-exit-confirmation')?.hidden === true)
        assert.equal((await callMain(c7CountdownRun.app, 'getSnapshot')).phase, 'celebration',
          'cancelling the exit dialog does not alter the in-progress celebration.')

        await callMain(c7CountdownRun.app, 'waitForIdle')
        const beforeConfirmedExit = await callMain(c7CountdownRun.app, 'getSnapshot')
        await c7CountdownRun.page.locator('#menu-item-exit').click()
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'exit-confirmation')
        await c7CountdownRun.page.keyboard.press('Enter')
        await c7CountdownRun.page.waitForFunction(() => document.body.dataset.menuScreen === 'closed' &&
          document.querySelector('#standalone-exit-confirmation')?.hidden === true)
        assert.equal(c7CountdownRun.page.isClosed(), false,
          'the isolated C9 IPC harness records one authorization without invoking app.quit.')
        assert.deepEqual(await callMain(c7CountdownRun.app, 'getSnapshot'), beforeConfirmedExit,
          'confirming exit does not call Stop All or mutate playback/queue state in C9.3.')
        assert.equal(await callMain(c7CountdownRun.app, 'getExitAuthorizationNotifications'), 1,
          'Main is notified once for the confirmed menu request.')
        assert.deepEqual(await c7CountdownRun.page.evaluate(() => window.standalonePlayer.requestExitConfirmation()),
          { outcome: 'authorized' }, 'Main refuses re-entry after exit is authorized.')
      } finally {
        if (!c9Only) {
          try { await callMain(c7CountdownRun.app, 'shutdown') } catch {}
          await c7CountdownRun.app.close()
        }
      }
      }

      // C8: approved options screen over real Chromium playback, with Main-owned dialogs and real SQLite/catalog services.
      if (!c9Only) {
      const c8Profile = path.join(tempRoot, 'profile-c8-options')
      fs.mkdirSync(c8Profile)
      let c8Run = await launch(c8Profile)
      try {
        const initialOptions = await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
        assert.equal(initialOptions.library.folderName, path.basename(mediaRoot))
        assert.equal(initialOptions.library.scanStatus, 'ready')
        assert.ok(initialOptions.library.indexedFiles > 0)
        assert.equal(initialOptions.catalog.fileName, null)
        assert.equal(JSON.stringify(initialOptions).includes(mediaRoot), false,
          'the renderer receives a safe folder basename, never the absolute filesystem path.')

        const emptyFolder = path.join(tempRoot, 'empty-video-folder')
        const unavailableFolder = path.join(tempRoot, 'unavailable-video-folder')
        const deepScanFolder = path.join(tempRoot, 'deep-scan-folder')
        fs.mkdirSync(emptyFolder)
        fs.mkdirSync(deepScanFolder)
        // Many empty subfolders create a real, observable async scan without a large video collection or fake delay.
        for (let index = 0; index < 1500; index++) {
          fs.mkdirSync(path.join(deepScanFolder, `dir-${String(index).padStart(4, '0')}`))
        }
        await c8Run.page.keyboard.press('Escape')
        await c8Run.page.waitForFunction(() => document.querySelector('#standalone-main-menu')?.hidden === false)
        await c8Run.page.locator('#menu-item-options').click()
        await c8Run.page.waitForFunction(() => document.body.dataset.menuScreen === 'options' &&
          document.querySelector('#standalone-options-screen')?.hidden === false)
        await c8Run.page.waitForFunction(() => document.activeElement?.id === 'options-change-folder')
        await c8Run.page.waitForFunction((folderName) =>
          document.querySelector('#options-video-folder-name')?.textContent === folderName &&
          document.querySelector('#options-library-indexing')?.hidden === true,
        path.basename(mediaRoot))
        await c8Run.page.evaluate(() => document.fonts.ready)
        const initialOptionsScreenshot = await capture(c8Run.page, 'c8-options-initial-doop-match')
        const initialLayout = await c8Run.page.locator('.options-settings-grid').boundingBox()
        assert.equal(await c8Run.page.locator('#options-change-folder').isVisible(), true)
        assert.equal(await c8Run.page.locator('#options-refresh-library').isDisabled(), false)

        await callMain(c8Run.app, 'queueVideoFolderSelection', emptyFolder)
        const emptyFolderReply = await c8Run.page.evaluate(() => window.standalonePlayer.selectVideoFolder())
        assert.equal(emptyFolderReply.outcome, 'confirmed')
        let optionsState = await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
        assert.equal(optionsState.library.folderName, path.basename(emptyFolder))
        assert.equal(optionsState.library.indexedFiles, 0, 'an accessible empty folder is ready with zero indexed videos.')
        assert.equal(await c8Run.page.locator('#options-library-state').textContent(), 'Pasta disponível')
        assert.deepEqual((await callMain(c8Run.app, 'getLibraryConfiguration')).roots, [emptyFolder],
          'the selected folder is persisted by Main before/with its real library scan.')

        await callMain(c8Run.app, 'queueVideoFolderSelection', unavailableFolder)
        const unavailableFolderReply = await c8Run.page.evaluate(() => window.standalonePlayer.selectVideoFolder())
        assert.equal(unavailableFolderReply.outcome, 'confirmed')
        optionsState = await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
        assert.equal(optionsState.library.folderName, path.basename(unavailableFolder))
        assert.equal(optionsState.library.indexedFiles, null)
        assert.match(await c8Run.page.locator('#options-library-unconfirmed').textContent(), /disponibilidade.*não pôde ser confirmada/i)
        assert.deepEqual((await callMain(c8Run.app, 'getLibraryConfiguration')).roots, [unavailableFolder],
          'an inaccessible selected root remains configured and is not replaced with an older library.')
        const unavailableRefresh = await c8Run.page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())
        assert.equal(unavailableRefresh.outcome, 'confirmed')
        assert.equal(await c8Run.page.locator('#options-change-folder').isVisible(), true,
          'a degraded library can be retried or replaced.')

        await callMain(c8Run.app, 'queueVideoFolderSelection', mediaRoot)
        const restoredAfterUnavailable = await c8Run.page.evaluate(() => window.standalonePlayer.selectVideoFolder())
        assert.equal(restoredAfterUnavailable.outcome, 'confirmed')
        const scanFinished = callMain(c8Run.app, 'waitForNextLibraryScan')
        await callMain(c8Run.app, 'queueVideoFolderSelection', deepScanFolder)
        await c8Run.page.evaluate(() => { window.__c8FolderSelection = window.standalonePlayer.selectVideoFolder() })
        await c8Run.page.waitForFunction(() => document.querySelector('#options-library-indexing')?.hidden === false,
          { timeout: 10000 })
        await capture(c8Run.page, 'c8-options-real-scan-in-progress')
        assert.equal(await c8Run.page.locator('#options-refresh-library').isDisabled(), true,
          'refresh is disabled only while the real VideoLibraryService scan is active.')
        const [completedDeepScan, deepFolderReply] = await Promise.all([
          scanFinished,
          c8Run.page.evaluate(async () => await window.__c8FolderSelection)
        ])
        assert.equal(deepFolderReply.outcome, 'confirmed')
        assert.equal(completedDeepScan.library.scanStatus, 'ready')
        assert.equal(completedDeepScan.library.folderName, path.basename(deepScanFolder))
        await callMain(c8Run.app, 'queueVideoFolderSelection', mediaRoot)
        const restoredAfterDeepScan = await c8Run.page.evaluate(() => window.standalonePlayer.selectVideoFolder())
        assert.equal(restoredAfterDeepScan.outcome, 'confirmed')
        const beforeCancel = await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
        await callMain(c8Run.app, 'queueVideoFolderSelection', null)
        await c8Run.page.locator('#options-change-folder').click()
        assert.deepEqual(await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot()), beforeCancel,
          'canceling the native folder picker preserves the existing folder and index.')
        assert.deepEqual((await callMain(c8Run.app, 'getOptionsDialogCounts')).folder, 6,
          'each idle selection attempt opens one Main-owned folder dialog; a refresh opens none.')
        await capture(c8Run.page, 'c8-options-indexed-and-catalog-absent')

        // Start real playback, then prove direct IPC and UI actions cannot change the library while occupied.
        await c8Run.page.keyboard.press('Escape')
        await c8Run.page.keyboard.press('Escape')
        for (const digit of '1001') await c8Run.page.keyboard.press(digit)
        await c8Run.page.keyboard.press('Enter')
        await c8Run.page.waitForFunction(() => document.body.dataset.transitionPhase === 'countdown')
        const countdownBeforeFolderAttempt = await callMain(c8Run.app, 'getSnapshot')
        const dialogsBeforeCountdown = await callMain(c8Run.app, 'getOptionsDialogCounts')
        const blockedCountdown = await c8Run.page.evaluate(() => window.standalonePlayer.selectVideoFolder())
        assert.equal(blockedCountdown.outcome, 'blocked')
        assert.equal(blockedCountdown.code, 'PLAYER_NOT_IDLE')
        const countdownAfterFolderAttempt = await callMain(c8Run.app, 'getSnapshot')
        assert.equal(countdownAfterFolderAttempt.phase, 'countdown')
        assert.deepEqual(countdownAfterFolderAttempt.target, countdownBeforeFolderAttempt.target)
        assert.ok(countdownAfterFolderAttempt.remainingMs <= countdownBeforeFolderAttempt.remainingMs &&
          countdownAfterFolderAttempt.remainingMs > countdownBeforeFolderAttempt.remainingMs - 1000,
        'the blocked IPC leaves the countdown running normally without restarting or skipping it.')
        assert.deepEqual(await callMain(c8Run.app, 'getOptionsDialogCounts'), dialogsBeforeCountdown,
          'the Main rejects an occupied library change before opening the native dialog.')
        const activeC8 = await callMain(c8Run.app, 'waitForPlaybackAttempt', null, '01001')
        await c8Run.page.waitForFunction(() => document.body.dataset.operationalState === 'playing')
        await c8Run.page.keyboard.press('Escape')
        await c8Run.page.waitForFunction(() => document.querySelector('#standalone-main-menu')?.hidden === false)
        await c8Run.page.locator('#menu-item-options').click()
        await c8Run.page.waitForFunction(() => document.body.dataset.menuScreen === 'options')
        const c8PlaybackBeforeBlockedAction = await callMain(c8Run.app, 'getSnapshot')
        const c8VideoBeforeBlockedAction = await callMain(c8Run.app, 'getVideoState')
        const dialogsBeforePlayingAttempt = await callMain(c8Run.app, 'getOptionsDialogCounts')
        await c8Run.page.locator('#options-change-folder').click()
        await c8Run.page.waitForFunction(() => document.querySelector('#options-toast')?.hidden === false)
        assert.match(await c8Run.page.locator('#options-toast').textContent(), /Player ocioso/i)
        assert.deepEqual(await c8Run.page.locator('.options-settings-grid').boundingBox(), initialLayout,
          'the authorized temporary error toast does not move or resize the approved composition.')
        assert.deepEqual(await callMain(c8Run.app, 'getOptionsDialogCounts'), dialogsBeforePlayingAttempt,
          'the busy-button attempt does not open a native folder picker.')
        assert.deepEqual(await callMain(c8Run.app, 'getSnapshot'), c8PlaybackBeforeBlockedAction,
          'a busy options action leaves the authoritative queue and playback snapshot unchanged.')

        for (const key of ['1', 'P', 'Space', 'R', 'Control+ArrowRight', 'Control+Space']) {
          await c8Run.page.keyboard.press(key)
        }
        assert.deepEqual(await callMain(c8Run.app, 'getSnapshot'), c8PlaybackBeforeBlockedAction,
          'Player commands remain suppressed while Options owns keyboard input.')
        await c8Run.page.waitForFunction(currentTime => {
          const video = document.querySelector('#playback-media-layer video')
          return Boolean(video && video.currentTime > currentTime)
        }, c8VideoBeforeBlockedAction.currentTime)
        const c8VideoAfterMenuKeys = await callMain(c8Run.app, 'getVideoState')
        assert.equal(c8VideoAfterMenuKeys.paused, false)
        assert.ok(c8VideoAfterMenuKeys.currentTime > c8VideoBeforeBlockedAction.currentTime,
          'the real MP4 continues playing beneath Options.')

        // Catalog import/replacement is allowed during playback and updates C6 metadata without changing sequence state.
        const firstCatalogDialogs = await callMain(c8Run.app, 'getOptionsDialogCounts')
        const sequenceBeforeCatalogImport = await callMain(c8Run.app, 'getSnapshot')
        await c8Run.page.keyboard.press('Tab')
        await c8Run.page.keyboard.press('Tab')
        assert.equal(await c8Run.page.evaluate(() => document.activeElement?.id), 'options-import-catalog',
          'Tab reaches the CSV action inside Options without escaping to the Player.')
        await callMain(c8Run.app, 'queueCatalogFileSelection', csvFirst)
        await c8Run.page.keyboard.press('Enter')
        await c8Run.page.waitForFunction(() => window.standalonePlayer.getOptionsSnapshot().then(value =>
          value.catalog.fileName === 'catalog-first.csv'))
        let catalogMetadata = await c8Run.page.evaluate(() => window.standalonePlayer.getCurrentTrackMetadata())
        assert.equal(catalogMetadata.title, 'Always')
        assert.deepEqual(await callMain(c8Run.app, 'getSnapshot'), sequenceBeforeCatalogImport,
          'importing CSV does not mutate playback, queue order, or priority.')
        assert.ok((await callMain(c8Run.app, 'getVideoState')).currentTime > c8VideoAfterMenuKeys.currentTime,
          'the active MP4 advances while the real SQLite CSV import commits.')
        assert.deepEqual(await callMain(c8Run.app, 'getOptionsDialogCounts'),
          { ...firstCatalogDialogs, catalog: firstCatalogDialogs.catalog + 1 })

        await callMain(c8Run.app, 'queueCatalogFileSelection', csvSecond)
        await c8Run.page.locator('#options-import-catalog').click()
        await c8Run.page.waitForFunction(() => window.standalonePlayer.getOptionsSnapshot().then(value =>
          value.catalog.fileName === 'catalog-second.csv'))
        catalogMetadata = await c8Run.page.evaluate(() => window.standalonePlayer.getCurrentTrackMetadata())
        assert.equal(catalogMetadata.title, 'Always (atualizada)', 'catalog replacement refreshes C6 metadata.')
        await c8Run.page.waitForFunction(() => document.querySelector('#options-toast')?.hidden === true)
        await capture(c8Run.page, 'c8-options-catalog-imported-doop-match')
        const catalogAfterReplacement = await callMain(c8Run.app, 'getCatalogMetadata')

        // Recover one malformed music number without writing until the operator confirms; keep playback uninterrupted.
        const sequenceBeforePartialImport = await callMain(c8Run.app, 'getSnapshot')
        const playbackBeforePartialImport = await callMain(c8Run.app, 'getVideoState')
        await callMain(c8Run.app, 'queueCatalogFileSelection', csvPartial)
        await c8Run.page.locator('#options-import-catalog').click()
        await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-dialog')?.hidden === false &&
          document.querySelector('#options-catalog-dialog-confirm')?.hidden === false)
        assert.match(await c8Run.page.locator('#options-catalog-confirmation-summary').textContent(), /2 músicas válidas.*1 registro será ignorado/s)
        assert.match(await c8Run.page.locator('#options-catalog-confirmation-summary').textContent(), /O catálogo atual, com 1 música, será substituído\./)
        await capture(c8Run.page, 'c8-partial-import-confirmation')
        assert.deepEqual(await callMain(c8Run.app, 'getCatalogMetadata'), catalogAfterReplacement,
          'the partial catalog remains private until explicit confirmation.')
        await c8Run.page.locator('#options-catalog-dialog-cancel').click()
        await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-dialog')?.hidden === true)
        assert.deepEqual(await callMain(c8Run.app, 'getCatalogMetadata'), catalogAfterReplacement,
          'canceling a partial import preserves records, count, and last-import metadata.')

        await callMain(c8Run.app, 'queueCatalogFileSelection', csvPartial)
        await c8Run.page.locator('#options-import-catalog').click()
        await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-dialog')?.hidden === false &&
          document.querySelector('#options-catalog-dialog-confirm')?.hidden === false)
        await c8Run.page.locator('#options-catalog-dialog-confirm').click()
        await c8Run.page.waitForFunction(() => window.standalonePlayer.getOptionsSnapshot().then(value =>
          value.catalog.fileName === 'catalog-partial.csv' && value.catalog.importIssueCount === 1))
        const partialMetadata = await c8Run.page.evaluate(() => window.standalonePlayer.getCurrentTrackMetadata())
        assert.equal(partialMetadata.title, 'Dancing Queen')
        assert.deepEqual(await callMain(c8Run.app, 'getSnapshot'), sequenceBeforePartialImport,
          'partial catalog replacement leaves playback sequence and queue unchanged.')
        const playbackAfterPartialImport = await callMain(c8Run.app, 'getVideoState')
        assert.equal(playbackAfterPartialImport.paused, false)
        assert.ok(playbackAfterPartialImport.currentTime > playbackBeforePartialImport.currentTime,
          'the real MP4 continues playing through preview, confirmation, and SQLite commit.')
        const partialOptions = await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
        assert.equal(partialOptions.catalog.importIssueCount, 1)
        await c8Run.page.locator('#options-catalog-view-issues').click()
        await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-dialog-title')?.textContent ===
          'Problemas na importação' && document.querySelector('#options-catalog-issues-list')?.children.length === 1)
        const issueText = await c8Run.page.locator('#options-catalog-issues-list').innerText()
        assert.match(issueText, /Linha 3/)
        assert.match(issueText, /Campo: numero/)
        assert.match(issueText, /Valor: 78952770/)
        assert.match(issueText, /O código deve conter de 1 a 5 dígitos, sem zero inicial\./)
        const issuesDialogBounds = await c8Run.page.locator('.catalog-dialog').boundingBox()
        assert.ok(issuesDialogBounds && issuesDialogBounds.x >= 0 && issuesDialogBounds.y >= 0 &&
          issuesDialogBounds.x + issuesDialogBounds.width <= 1280 &&
          issuesDialogBounds.y + issuesDialogBounds.height <= 800,
        'the issue dialog fits within the 1280×800 viewport without clipping.')
        await c8Run.page.waitForFunction(() => document.activeElement?.id === 'options-catalog-dialog-cancel')
        assert.equal(await c8Run.page.evaluate(() => document.activeElement?.id), 'options-catalog-dialog-cancel',
          'the report modal receives keyboard focus and does not leak Player shortcuts.')
        await capture(c8Run.page, 'c8-partial-import-issues-modal')
        await c8Run.page.keyboard.press('Escape')
        await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-dialog')?.hidden === true)
        await c8Run.page.waitForFunction(() => document.activeElement?.id === 'options-catalog-view-issues')
        assert.equal(await c8Run.page.evaluate(() => document.activeElement?.id), 'options-catalog-view-issues',
          'Esc closes the report and restores focus to its trigger.')

        await callMain(c8Run.app, 'queueCatalogFileSelection', csvInvalid)
        await c8Run.page.locator('#options-import-catalog').click()
        await c8Run.page.waitForFunction(() => document.querySelector('#options-toast')?.hidden === false &&
          document.querySelector('#options-toast')?.textContent?.includes('catálogo anterior foi mantido'))
        const catalogAfterPartialReplacement = await callMain(c8Run.app, 'getCatalogMetadata')
        assert.notDeepEqual(catalogAfterPartialReplacement, catalogAfterReplacement)
        const reportAfterStructuralFailure = await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot().then(value =>
          ({ count: value.catalog.importIssueCount, generation: value.catalog.importGeneration })))
        assert.deepEqual(reportAfterStructuralFailure,
          { count: 1, generation: partialOptions.catalog.importGeneration },
          'a structural CSV error preserves the last completed partial-import report.')
        await callMain(c8Run.app, 'queueCatalogFileSelection', null)
        const cancelledCatalog = await c8Run.page.evaluate(() => window.standalonePlayer.importMusicCatalog())
        assert.equal(cancelledCatalog.outcome, 'cancelled')
        assert.deepEqual(await callMain(c8Run.app, 'getCatalogMetadata'), catalogAfterPartialReplacement,
          'canceling CSV selection preserves the imported catalog.')

        // The modal pages a large report instead of materializing all rows at once.
        await callMain(c8Run.app, 'queueCatalogFileSelection', csvManyIssues)
        await c8Run.page.locator('#options-import-catalog').click()
        await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-dialog-confirm')?.hidden === false)
        await c8Run.page.locator('#options-catalog-dialog-confirm').click()
        await c8Run.page.waitForFunction(() => window.standalonePlayer.getOptionsSnapshot().then(value =>
          value.catalog.importIssueCount === 61))
        await c8Run.page.locator('#options-catalog-view-issues').click()
        await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-issues-list')?.children.length === 50)
        assert.equal(await c8Run.page.locator('#options-catalog-issues-next').isEnabled(), true)
        await c8Run.page.locator('#options-catalog-issues-next').click()
        await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-issues-list')?.children.length === 11)
        assert.match(await c8Run.page.locator('#options-catalog-issues-page').textContent(), /Registros 51–61 de 61/)
        await capture(c8Run.page, 'c8-many-import-issues-second-page')
        await c8Run.page.keyboard.press('Escape')
        await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-dialog')?.hidden === true)

        // Paused and celebration states remain occupied for library actions; user playback shortcuts resume only after closing Options.
        await c8Run.page.keyboard.press('Escape')
        await c8Run.page.keyboard.press('Escape')
        await c8Run.page.keyboard.press('Space')
        await c8Run.page.waitForFunction(() => document.body.dataset.operationalState === 'paused')
        const pausedSnapshot = await callMain(c8Run.app, 'getSnapshot')
        const pausedDialogCount = await callMain(c8Run.app, 'getOptionsDialogCounts')
        const blockedPaused = await c8Run.page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())
        assert.equal(blockedPaused.outcome, 'blocked')
        assert.equal(blockedPaused.code, 'PLAYER_NOT_IDLE')
        assert.deepEqual(await callMain(c8Run.app, 'getSnapshot'), pausedSnapshot)
        assert.deepEqual(await callMain(c8Run.app, 'getOptionsDialogCounts'), pausedDialogCount)

        await c8Run.page.keyboard.press('Space')
        await c8Run.page.waitForFunction(() => document.body.dataset.operationalState === 'playing')
        await callMain(c8Run.app, 'seekNearNaturalEnd')
        const c8Celebration = await callMain(c8Run.app, 'waitForCelebration')
        const blockedCelebration = await c8Run.page.evaluate(() => window.standalonePlayer.selectVideoFolder())
        assert.equal(blockedCelebration.outcome, 'blocked')
        assert.deepEqual((await callMain(c8Run.app, 'getSnapshot')).phase, 'celebration')
        await c8Run.page.keyboard.press('Escape')
        await c8Run.page.waitForFunction(() => document.body.dataset.menuScreen === 'main')
        await c8Run.page.keyboard.press('Escape')
        const finishedC8 = await callMain(c8Run.app, 'waitForIdle')
        assert.equal(finishedC8.state.operationalState, 'idle')
        assert.equal((await c8Run.page.evaluate(() => window.standalonePlayer.getCurrentTrackMetadata())), null)
        await capture(c8Run.page, 'c8-options-imported-catalog-during-playback')
      } finally {
        try { await callMain(c8Run.app, 'shutdown') } catch {}
        await c8Run.app.close()
      }

      // Restart the same isolated profile and confirm both video-root configuration and CSV metadata persisted.
      c8Run = await launch(c8Profile)
      try {
        const persistedOptions = await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
        assert.equal(persistedOptions.library.folderName, path.basename(mediaRoot))
        assert.equal(persistedOptions.library.scanStatus, 'ready')
        assert.equal(persistedOptions.catalog.fileName, 'catalog-many-issues.csv')
        assert.equal(persistedOptions.catalog.recordCount, 1)
        assert.equal(persistedOptions.catalog.importIssueCount, 61)
        assert.deepEqual(await c8Run.page.evaluate(() => window.standalonePlayer.lookupMetadata('1001')),
          { catalogRevision: (await c8Run.page.evaluate(() => window.standalonePlayer.lookupMetadata('1001'))).catalogRevision,
            title: 'The Show Must Go On', artist: 'Queen' },
          'the replacement catalog remains available through the real SQLite service after Electron restarts.')

        const realOriginalCsv = process.env.KQ_STANDALONE_C8_REPRO_ORIGINAL_CSV
        const realReplacementCsv = process.env.KQ_STANDALONE_C8_REPRO_REPLACEMENT_CSV
        if (realOriginalCsv || realReplacementCsv) {
          assert.ok(realOriginalCsv && realReplacementCsv,
            'Both KQ_STANDALONE_C8_REPRO_ORIGINAL_CSV and KQ_STANDALONE_C8_REPRO_REPLACEMENT_CSV are required.')
          for (const filePath of [realOriginalCsv, realReplacementCsv]) {
            assert.equal(path.isAbsolute(filePath), true, 'Real CSV reproduction paths must be absolute.')
            assert.equal(fs.statSync(filePath).isFile(), true, 'Each real CSV reproduction path must name a readable regular file.')
          }

          // Seed the isolated Main-side SQLite catalog exactly as the native manual runner does,
          // then select the replacement through the UI's authorized dialog port and production IPC.
          const importedOriginal = await callMain(c8Run.app, 'importCatalog', realOriginalCsv)
          assert.ok(importedOriginal.recordCount > 0, 'The real original CSV must load before replacement is attempted.')
          const realCatalogBeforeConfirmation = await callMain(c8Run.app, 'getCatalogMetadata')
          const playbackBeforeRealImport = await callMain(c8Run.app, 'getSnapshot')

          await c8Run.page.keyboard.press('Escape')
          await c8Run.page.waitForFunction(() => document.querySelector('#standalone-main-menu')?.hidden === false)
          await c8Run.page.locator('#menu-item-options').click()
          await c8Run.page.waitForFunction(() => document.body.dataset.menuScreen === 'options')
          const realOptionsInitialLayout = await c8Run.page.locator('.options-settings-grid').boundingBox()
          await callMain(c8Run.app, 'queueCatalogFileSelection', realReplacementCsv)
          await c8Run.page.locator('#options-import-catalog').click()
          await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-dialog')?.hidden === false &&
            document.querySelector('#options-catalog-dialog-confirm')?.hidden === false)
          const realConfirmationSummary = await c8Run.page.locator('#options-catalog-confirmation-summary').textContent()
          assert.match(realConfirmationSummary, /1 registro será ignorado/,
            'the real replacement reports the isolated invalid music-number row before changing SQLite.')
          assert.deepEqual(await callMain(c8Run.app, 'getCatalogMetadata'), realCatalogBeforeConfirmation,
            'the prior real SQLite catalog remains untouched while confirmation is pending.')
          await c8Run.page.locator('#options-catalog-dialog-confirm').click()
          const replacementFileName = path.basename(realReplacementCsv)
          await c8Run.page.waitForFunction(fileName => window.standalonePlayer.getOptionsSnapshot().then(value =>
            value.catalog.fileName === fileName && value.catalog.importIssueCount === 1), replacementFileName)
          const realCatalogAfterConfirmation = await callMain(c8Run.app, 'getCatalogMetadata')
          assert.ok(realCatalogAfterConfirmation.recordCount > 0,
            'valid rows from the real replacement CSV are committed after confirmation.')
          const realOptionsAfterConfirmation = await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
          const realIssuePage = await c8Run.page.evaluate(snapshot => window.standalonePlayer.getCatalogImportIssuesPage(
            snapshot.catalog.revision, snapshot.catalog.importGeneration, 0), realOptionsAfterConfirmation)
          assert.deepEqual(realIssuePage.issues.map(issue => ({
            rowNumber: issue.rowNumber, field: issue.field, value: issue.value, code: issue.code
          })), [{ rowNumber: 135, field: 'numero', value: '78952770', code: 'INVALID_MUSIC_NUMBER' }],
          'the actual replacement file reports the known line 135 value without truncation.')
          await c8Run.page.locator('#options-catalog-view-issues').click()
          await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-issues-list')?.textContent?.includes('78952770'))
          await capture(c8Run.page, 'c8-real-csv-partial-import-problems')
          await c8Run.page.keyboard.press('Escape')
          await c8Run.page.waitForFunction(() => document.querySelector('#options-catalog-dialog')?.hidden === true)
          await c8Run.page.waitForFunction(() => document.activeElement?.id === 'options-catalog-view-issues')
          const restoredOptionsLayout = await c8Run.page.evaluate(() => {
            const bounds = document.querySelector('.options-settings-grid')?.getBoundingClientRect()
            return {
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              documentWidth: document.documentElement.scrollWidth,
              documentHeight: document.documentElement.scrollHeight,
              bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null
            }
          })
          assert.equal(restoredOptionsLayout.scrollX, 0)
          assert.equal(restoredOptionsLayout.scrollY, 0)
          assert.equal(restoredOptionsLayout.documentWidth, 1280,
            'the warning and restored focus do not introduce horizontal page overflow.')
          assert.deepEqual(restoredOptionsLayout.bounds, realOptionsInitialLayout,
            'the warning row leaves the approved Options composition in its original position and size.')
          const realMetadataAfterConfirmation = await c8Run.page.evaluate(() => window.standalonePlayer.lookupMetadata('1001'))
          assert.equal(realMetadataAfterConfirmation.catalogRevision, realCatalogAfterConfirmation.revision,
            'metadata lookups use the newly confirmed catalog revision.')
          assert.deepEqual(await callMain(c8Run.app, 'getSnapshot'), playbackBeforeRealImport,
            'the real CSV replacement does not mutate playback or the Standalone sequence.')
          await capture(c8Run.page, 'c8-real-csv-partial-import-confirmed')

          await callMain(c8Run.app, 'shutdown')
          await c8Run.app.close()
          c8Run = await launch(c8Profile)
          const catalogAfterRealRestart = await callMain(c8Run.app, 'getCatalogMetadata')
          assert.equal(catalogAfterRealRestart.revision, realCatalogAfterConfirmation.revision,
            'the confirmed partial catalog revision remains persisted after restart.')
          assert.equal(catalogAfterRealRestart.recordCount, realCatalogAfterConfirmation.recordCount,
            'the valid records from the real replacement remain persisted after restart.')
          const optionsAfterRealRestart = await c8Run.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
          assert.equal(optionsAfterRealRestart.catalog.importIssueCount, 1)
          const reportAfterRealRestart = await c8Run.page.evaluate(snapshot => window.standalonePlayer.getCatalogImportIssuesPage(
            snapshot.catalog.revision, snapshot.catalog.importGeneration, 0), optionsAfterRealRestart)
          assert.equal(reportAfterRealRestart.issues[0].rowNumber, 135,
            'the real invalid-row report remains linked to the imported catalog after restart.')
          assert.deepEqual(await c8Run.page.evaluate(() => window.standalonePlayer.lookupMetadata('1001')),
            realMetadataAfterConfirmation, 'the confirmed valid metadata remains available after restart.')
        }
      } finally {
        try { await callMain(c8Run.app, 'shutdown') } catch {}
        await c8Run.app.close()
      }
      }
      console.log(JSON.stringify({ status: 'PASS', viewport, screenshots: captureRoot, video: videoState }))
    } finally {
      try { await callMain(app, 'shutdown') } catch {}
      await app.close()
    }
  }

  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
