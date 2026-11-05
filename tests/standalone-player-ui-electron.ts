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
  const { app, BrowserWindow, ipcMain, protocol } = require('electron')
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
  const { MusicCatalogService } = require(path.join(projectRoot, 'build/src/music-catalog-service.js'))
  const { createPlayerMusicCatalogDatabase } = require(path.join(projectRoot, 'build/database.js'))
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
      metadataCatalog: catalog
    })
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
  fs.writeFileSync(csvFirst, 'artista;numero;nome_musica\nBon Jovi;1001;Always\n"<svg onload=""alert(1)"">";1002;"<img src=x onerror=""alert(2)"">"\n')
  fs.writeFileSync(csvSecond, 'artista;numero;nome_musica\nBon Jovi;1001;Always (atualizada)\n')

  async function launch(activeProfileRoot = profileRoot) {
    const app = await electron.launch({
      executablePath: require('electron'),
      args: [`--user-data-dir=${activeProfileRoot}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : []), mainEntry],
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
    const context = await launch()
    const { app, page } = context
    try {
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
      assert.deepEqual(viewport, { width: 1280, height: 800, dpr: 1 }, 'Doop and Electron captures use the same 1280×800 viewport at 1×.')
      const exposure = await page.evaluate(() => ({
        standalone: Object.keys(window.standalonePlayer).sort(),
        playback: typeof window.playerPlayback,
        require: typeof window.require,
        ipcRenderer: typeof window.ipcRenderer
      }))
      assert.deepEqual(exposure, {
        standalone: ['execute', 'getSnapshot', 'lookupMetadata', 'onCatalogRevisionChanged', 'subscribe', 'unsubscribe'],
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
      const videoState = await callMain(app, 'getVideoState')
      assert.ok(videoState.duration > 0 && videoState.width > 0 && videoState.height > 0,
        'the real MP4 is rendered by the existing Chromium playback host in the same Electron window.')
      await capture(page, 'c2-playing-clean-start')

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
      await page.keyboard.press('Control+ArrowRight')
      const afterNext = await callMain(app, 'waitForPlaybackAttempt', beforeNext.state.current.attemptId, '01006')
      assert.deepEqual(afterNext.state.pending.map(entry => entry.musicCode), ['01005', '01003', '01004', '01001'])
      assert.equal(await page.locator('body').getAttribute('data-transition-phase'), 'none')
      assert.equal(await page.locator('#standalone-celebration').isHidden(), true,
        'manual Next does not enter or simulate natural EOF celebration.')
      assert.equal(await callMain(app, 'seekToBeginningForTest'), true,
        'the stop-modal scenario uses the beginning of a still-playing real MP4.')
      await capture(page, 'c5-next')

      // C5-C: opening and canceling the confirmation leaves real playback and queue untouched.
      await page.keyboard.press('Control+Space')
      await page.waitForFunction(() => document.querySelector('#standalone-stop-confirmation')?.hidden === false)
      const modalSnapshot = await callMain(app, 'getSnapshot')
      const modalVideoBefore = await callMain(app, 'getVideoState')
      assert.equal(modalSnapshot.state.operationalState, 'playing')
      assert.deepEqual(modalSnapshot.state.pending.map(entry => entry.musicCode), afterNext.state.pending.map(entry => entry.musicCode))
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
      } finally {
        try { await callMain(emptyQueueRun.app, 'shutdown') } catch {}
        await emptyQueueRun.app.close()
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
