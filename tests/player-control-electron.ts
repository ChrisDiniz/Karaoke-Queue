// @ts-nocheck
export {}

// Real application E2E for the isolated Player control window. It deliberately
// uses the production Main, Preload, IPC, services, and Chromium media host.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build/src/player-playback-recovery-store.js'))
const configuredMediaRoot = process.env.KQ_PLAYER_TEST_MEDIA_DIR

function findCodes(mediaRoot) {
  const codes = new Set()
  for (const name of fs.readdirSync(mediaRoot, { recursive: true })) {
    if (typeof name !== 'string') continue
    const match = /^([0-9]{5})(?:[ _-].*)?\.(?:mp4|mkv|webm|avi|mov|mpeg|mpg|wmv)$/i.exec(path.basename(name))
    if (match) codes.add(match[1])
  }
  return codes
}

function makeIsolatedRoot() {
  const configuredRoot = process.env.KARAOKE_TEST_TEMP_ROOT
  const root = configuredRoot
    ? path.resolve(configuredRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-player-control-e2e-'))
  if (configuredRoot) {
    if (fs.existsSync(root)) throw new Error('The isolated Player control E2E root already exists: ' + root)
    fs.mkdirSync(root, { recursive: false })
  }
  return root
}

async function waitForSnapshot(page, predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout
  let latest
  let evaluationError
  while (Date.now() < deadline) {
    latest = await page.evaluate(async () => window.karaokePlayer?.getSnapshot?.()).catch(error => {
      evaluationError = error.message
      return undefined
    })
    if (latest && predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${message}; último snapshot=${JSON.stringify(latest)}; erro ao consultar=${evaluationError ?? 'nenhum'}`)
}

async function findPlaybackHostId(app) {
  return app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const view = window.contentView.children.find(child => child.webContents?.getURL().includes('player-playback.html'))
      if (view) return view.webContents.id
    }
    return null
  })
}

async function waitForPlaybackViewVisibility(app, expected, timeout = 10000) {
  const deadline = Date.now() + timeout
  let latest
  while (Date.now() < deadline) {
    latest = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      return view ? { visible: view.getVisible(), bounds: view.getBounds() } : null
    })
    if (latest?.visible === expected && (!expected || (latest.bounds.width > 0 && latest.bounds.height > 0))) return latest
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Expected Player view visibility=${expected}; latest=${JSON.stringify(latest)}`)
}

async function waitForPlaybackHost(app, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const id = await findPlaybackHostId(app)
    if (id !== null) return id
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('A superfície Chromium do Player não foi criada.')
}

async function playbackHostEvaluate(app, expression) {
  return app.evaluate(async ({ BrowserWindow }, payload) => {
    const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
      .find(child => child.webContents?.getURL().includes('player-playback.html'))
    const host = view?.webContents
    if (!host || host.isDestroyed()) throw new Error('O WebContentsView Chromium não está disponível.')
    return host.executeJavaScript(payload)
  }, expression)
}

async function capturePlaybackHost(app, filePath) {
  const documentReady = await playbackHostEvaluate(app,
    'window.playerPlayback && document.querySelector("video") ? document.querySelector("video").readyState >= 1 : Boolean(document.querySelector("#playback-stage"))')
  assert.ok(documentReady, 'A superfície Chromium precisa renderizar o documento de reprodução.')
  const imageUrl = await app.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
      .find(child => child.webContents?.getURL().includes('player-playback.html'))
    const host = view?.webContents
    if (!host || host.isDestroyed()) throw new Error('O WebContentsView Chromium não está disponível.')
    return (await host.capturePage()).toDataURL()
  })
  fs.writeFileSync(filePath, Buffer.from(imageUrl.slice(imageUrl.indexOf(',') + 1), 'base64'))
}

async function captureCompositedPlayerWindow(app, filePath) {
  try {
    const capture = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const control = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('player-control.html'))
      if (!control) return { title: null, dataUrl: null, sources: [] }
      const [width, height] = control.getSize()
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: Math.max(1, width), height: Math.max(1, height) },
        fetchWindowIcons: false
      })
      const source = sources.find(candidate => candidate.name === control.getTitle())
      return { title: control.getTitle(), dataUrl: source?.thumbnail.toDataURL() ?? null,
        sources: sources.map(candidate => candidate.name) }
    })
    if (!capture.dataUrl) return { captured: false, title: capture.title, sources: capture.sources }
    fs.writeFileSync(filePath, Buffer.from(capture.dataUrl.slice(capture.dataUrl.indexOf(',') + 1), 'base64'))
    return { captured: true, title: capture.title, sources: capture.sources }
  } catch (error) {
    return { captured: false, error: error.message }
  }
}

async function captureCompositedOutputWindow(app, filePath) {
  try {
    const capture = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const output = BrowserWindow.getAllWindows().find(candidate =>
        candidate.getTitle() === 'Karaoke Queue · Player' && candidate.isVisible())
      if (!output) return { title: null, dataUrl: null, sources: [] }
      const [width, height] = output.getSize()
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: Math.max(1, width), height: Math.max(1, height) },
        fetchWindowIcons: false
      })
      const source = sources.find(candidate => candidate.name === output.getTitle())
      return { title: output.getTitle(), dataUrl: source?.thumbnail.toDataURL() ?? null,
        sources: sources.map(candidate => candidate.name) }
    })
    if (!capture.dataUrl) return { captured: false, title: capture.title, sources: capture.sources }
    fs.writeFileSync(filePath, Buffer.from(capture.dataUrl.slice(capture.dataUrl.indexOf(',') + 1), 'base64'))
    return { captured: true, title: capture.title, sources: capture.sources }
  } catch (error) {
    return { captured: false, error: error.message }
  }
}

async function windowDiagnostics(app) {
  let pages = []
  try { pages = app.windows() } catch {}
  const windows = await Promise.all(pages.map(async page => ({
    url: page.url(),
    title: await page.title().catch(error => `indisponível: ${error.message}`)
  })))
  const child = app.process()
  return {
    windows,
    processExitCode: child.exitCode,
    processSignalCode: child.signalCode
  }
}

async function waitForPlayerControlPage(app, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    let pages = []
    try { pages = app.windows() } catch {}
    const controlPage = pages.find(page => page.url().includes('player-control.html'))
    if (controlPage) return controlPage
    const child = app.process()
    if (child.exitCode !== null || child.signalCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`A janela de controle player-control.html não apareceu: ${JSON.stringify(await windowDiagnostics(app))}`)
}

async function assertVisibleIconsRendered(page, context) {
  const result = await page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
    }
    const svgs = [...document.querySelectorAll('svg')].filter(visible)
    const emptySvg = svgs.filter(svg => !svg.querySelector('path, circle, rect, line, polyline, polygon, ellipse'))
    const logo = document.querySelector('.player-brand img')
    const logoBounds = logo?.getBoundingClientRect()
    return { visibleSvgCount: svgs.length, emptySvgCount: emptySvg.length,
      logoLoaded: Boolean(logo && logo.complete && logo.naturalWidth > 0 && visible(logo)),
      logoLeft: logoBounds?.left ?? null, logoRight: logoBounds?.right ?? null, viewportWidth: innerWidth }
  })
  assert.ok(result.visibleSvgCount > 0, `${context}: a tela deve possuir ícones visíveis.`)
  assert.equal(result.emptySvgCount, 0, `${context}: todos os SVGs visíveis devem conter formas renderizáveis.`)
  assert.equal(result.logoLoaded, true, `${context}: o logotipo do projeto deve estar carregado e visível.`)
  assert.ok(result.logoLeft >= 0 && result.logoRight <= result.viewportWidth,
    `${context}: o logotipo precisa estar dentro do viewport: ${JSON.stringify(result)}`)
}

async function run() {
  if (!configuredMediaRoot || !fs.existsSync(configuredMediaRoot)) {
    process.stderr.write('NOT RUN: defina KQ_PLAYER_TEST_MEDIA_DIR para uma biblioteca de vídeos existente e somente leitura.\n')
    process.exitCode = 2
    return
  }

  const codes = findCodes(configuredMediaRoot)
  for (const code of ['01001', '01002']) {
    assert.equal(codes.has(code), true, `A mídia de teste precisa incluir o vídeo ${code}.`)
  }

  const root = makeIsolatedRoot()
  process.stdout.write(`TEST_PROFILE_RUN ${path.basename(root)}\n`)
  const screenshotRoot = process.env.KQ_PLAYER_SCREENSHOT_DIR
    ? path.resolve(process.env.KQ_PLAYER_SCREENSHOT_DIR) : root
  fs.mkdirSync(screenshotRoot, { recursive: true })
  const userData = path.join(root, 'user-data')
  const configRoot = path.join(root, 'config')
  const cacheRoot = path.join(root, 'cache')
  const dataRoot = path.join(root, 'data')
  const catalogPath = path.join(root, 'player-catalog.csv')
    const replacementCatalogPath = path.join(root, 'player-catalog-replacement.csv')
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(catalogPath,
    '\uFEFFartista;numero;nome_musica\r\nBon Jovi;1001;Always\r\nLegião Urbana;1002;Tempo Perdido\r\n', 'utf8')

  let app
  let playbackHostId
  const launchApp = () => electron.launch({
    executablePath: require('electron'),
    args: [
      projectRoot,
      `--user-data-dir=${userData}`
    ],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configRoot,
      XDG_CACHE_HOME: cacheRoot,
      XDG_DATA_HOME: dataRoot
    },
    timeout: 30000
  })
  try {
    // Exercise the actual first-launch Welcome flow. The test harness captures
    // relaunch/quit so it can close this process and start the selected mode
    // itself under Playwright, without leaving an unmanaged relaunched process.
    app = await launchApp()
    const welcomePage = await app.firstWindow()
    await welcomePage.waitForURL('**/welcome.html')
    await welcomePage.locator('#welcome-continue').waitFor({ state: 'visible' })
    assert.equal(await welcomePage.locator('#welcome-continue').isDisabled(), true,
      'Continuar deve iniciar desabilitado até que um modo seja selecionado.')
    await welcomePage.locator('.mode-card[data-mode="player"]').click()
    assert.equal(await welcomePage.locator('#welcome-continue').isEnabled(), true,
      'Selecionar Reprodutor deve habilitar Continuar.')
    await app.evaluate(({ app: electronApp }) => {
      globalThis.__originalAppQuit = electronApp.quit
      globalThis.__originalAppRelaunch = electronApp.relaunch
      globalThis.__welcomeQuitRequested = false
      globalThis.__welcomeRelaunchRequested = false
      globalThis.__welcomeRequestsComplete = new Promise(resolve => {
        globalThis.__resolveWelcomeRequests = resolve
      })
      const completeWhenRequested = () => {
        if (globalThis.__welcomeQuitRequested && globalThis.__welcomeRelaunchRequested) {
          globalThis.__resolveWelcomeRequests(true)
        }
      }
      electronApp.quit = () => {
        globalThis.__welcomeQuitRequested = true
        completeWhenRequested()
      }
      electronApp.relaunch = () => {
        globalThis.__welcomeRelaunchRequested = true
        completeWhenRequested()
      }
    })
    await welcomePage.locator('#welcome-continue').click()
    await app.evaluate(() => globalThis.__welcomeRequestsComplete)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'operating-mode.json'), 'utf8')),
      { version: 1, mode: 'player' }, 'A escolha inicial deve persistir o modo Reprodutor no perfil isolado.')
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit = globalThis.__originalAppQuit
      electronApp.relaunch = globalThis.__originalAppRelaunch
    })
    await app.close()

    const recoveryStore = new PlayerPlaybackRecoveryStore(userData)
    const recoveryStartedAt = new Date().toISOString()
    recoveryStore.write({ version: 1, revision: 1, status: 'playing',
      attemptId: '11111111-1111-4111-8111-111111111111', musicCode: '01001', playbackStatus: 'playing',
      lastTransition: 'playback-started', updatedAt: recoveryStartedAt, startedAt: recoveryStartedAt })
    app = await launchApp()

    let page = await waitForPlayerControlPage(app)
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const control = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('player-control.html'))
      if (!control) throw new Error('A janela de controle do Player não foi encontrada.')
      control.setContentSize(1280, 800)
    })
    await page.locator('#player-recovery-dialog').waitFor({ state: 'visible', timeout: 20000 })
    await waitForSnapshot(page, snapshot => snapshot.recovery.status === 'pending' &&
      snapshot.recovery.musicCode === '01001',
    'Uma tentativa interrompida deve solicitar uma decisão explícita de recuperação')
    await assertVisibleIconsRendered(page, 'recuperação válida')
    await page.screenshot({ path: path.join(screenshotRoot, 'player-recovery-pending.png') })
    await page.locator('#recovery-stay').click()
    await waitForSnapshot(page, snapshot => snapshot.recovery.status === 'resolved' &&
      snapshot.recovery.outcome === 'dismissed', 'Manter parado deve resolver a recuperação sem autoplay')
    await page.locator('#player-recovery-dialog').waitFor({ state: 'hidden' })
    await app.close()

    fs.writeFileSync(recoveryStore.filePath, '{ invalid recovery fixture', 'utf8')
    app = await launchApp()
    page = await waitForPlayerControlPage(app)
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const control = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('player-control.html'))
      if (!control) throw new Error('A janela de controle do Player não foi encontrada após recovery inválida.')
      control.setContentSize(1280, 800)
    })
    await page.locator('#player-invalid-recovery-dialog').waitFor({ state: 'visible', timeout: 20000 })
    const invalidRecoverySnapshot = await waitForSnapshot(page, snapshot => snapshot.recovery.status === 'unreadable',
      'Recovery inválida deve ser apresentada e bloquear nova reprodução')
    assert.equal(invalidRecoverySnapshot.playback.status, 'idle', 'Recovery inválida não deve iniciar playback.')
    await assertVisibleIconsRendered(page, 'recuperação inválida')
    await page.screenshot({ path: path.join(screenshotRoot, 'player-recovery-invalid.png') })
    await page.locator('#invalid-recovery-resolve').click()
    await page.locator('#player-invalid-recovery-dialog').waitFor({ state: 'hidden', timeout: 15000 })
    await waitForSnapshot(page, snapshot => snapshot.recovery.status === 'none' && snapshot.playback.status === 'idle',
      'Resolver recovery inválida deve preservar o registro e manter o Player parado')
    assert.ok(fs.readdirSync(userData).some(name => name.startsWith('player-playback-recovery-quarantine-')),
      'A resolução deve arquivar os bytes inválidos antes de liberar a reprodução.')
    await app.close()

    app = await launchApp()
    page = await waitForPlayerControlPage(app)
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const control = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('player-control.html'))
      if (!control) throw new Error('A janela de controle do Player não foi encontrada após resolver recovery.')
      control.setContentSize(1280, 800)
    })
    await page.locator('#player-video-view').waitFor({ state: 'visible', timeout: 20000 })
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.location === 'inline' && snapshot.videoWindow.ready,
      'Player mode must start with the embedded surface and no detached window.')
    await waitForPlaybackViewVisibility(app, true)
    await assertVisibleIconsRendered(page, 'biblioteca não configurada')
    assert.equal(await page.locator('#player-header-status').isVisible(), false,
      'O cabeçalho de biblioteca não configurada não deve afirmar um estado de música inexistente.')
    const startupSnapshot = await waitForSnapshot(page, snapshot => snapshot.mode === 'player' && snapshot.library.status === 'not-configured',
      'The Player shell must start in the selected mode and report the unconfigured library.')
    assert.equal(startupSnapshot.playback.status, 'idle', 'Player startup must not start playback automatically.')
    assert.equal(startupSnapshot.videoWindow.open, true, 'The embedded playback surface must be available at startup.')
    assert.equal(startupSnapshot.videoWindow.location, 'inline')
    const startupWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.webContents.getURL()))
    assert.equal(startupWindows.length, 1, 'Clean startup must show only the main window.')
    assert.equal(startupWindows.some(url => url.includes('player-playback.html')), false,
      'The embedded surface must not create a detached BrowserWindow during startup.')
    assert.equal(await page.locator('#player-video-window').isDisabled(), true,
      'The header display icon must remain reserved for future pairing.')
    await page.screenshot({ path: path.join(screenshotRoot, 'player-reprodutor-inline-startup.png') })
    await page.locator('#player-nav-manual').click()
    await page.locator('#player-library-empty-view').waitFor({ state: 'visible', timeout: 10000 })
    const hostIdBeforeNavigation = await findPlaybackHostId(app)
    await page.locator('#player-video-window').dispatchEvent('click')
    assert.equal(await page.locator('#player-manual-view').isVisible(), true,
      'The reserved display icon must not navigate to the Player view.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'The reserved display icon must not create a detached window.')
    await page.locator('#player-nav-video').click()
    await page.locator('#player-video-view').waitFor({ state: 'visible', timeout: 10000 })
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.location === 'inline',
      'The Reprodutor navigation item must open the embedded video area.')
    assert.equal(await findPlaybackHostId(app), hostIdBeforeNavigation,
      'Navigating between Controle and Reprodutor must preserve the same Chromium surface.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    await page.locator('#player-nav-manual').click()
    await page.locator('#player-library-empty-view').waitFor({ state: 'visible', timeout: 10000 })
    await page.screenshot({ path: path.join(screenshotRoot, 'player-library-not-configured.png') })
    await page.locator('#player-nav-video').click()
    await page.locator('#player-video-view').waitFor({ state: 'visible', timeout: 10000 })

    // A detached window can close before its intermediate state reaches the Renderer.
    const initialReturnRevision = (await page.evaluate(() => window.karaokePlayer.getSnapshot())).videoWindow.returnToInlineRevision
    await app.evaluate(({ BrowserWindow }) => {
      const control = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('player-control.html'))
      if (!control) throw new Error('The Player control window was not found for the delayed-snapshot scenario.')
      const send = control.webContents.send.bind(control.webContents)
      globalThis.__droppedPlayerWindowSnapshots = 0
      globalThis.__restorePlayerSnapshotSend = () => { control.webContents.send = send }
      control.webContents.send = (channel, ...args) => {
        if (channel === 'player:snapshot' && args[0]?.videoWindow.location === 'window') {
          globalThis.__droppedPlayerWindowSnapshots++
          return control.webContents
        }
        return send(channel, ...args)
      }
    })
    await page.locator('#player-detach-video').click()
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.location === 'window',
      'An explicit detach request must create the output window even while its Renderer notification is delayed.')
    assert.ok(await app.evaluate(() => globalThis.__droppedPlayerWindowSnapshots > 0),
      'The delayed-snapshot scenario must confirm that a detached-window notification was actually dropped.')
    const coldStartHostId = await findPlaybackHostId(app)
    assert.notEqual(coldStartHostId, null,
      'Detaching the Player must preserve one available Chromium surface.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2,
      'Detaching the Player must create exactly one output window.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .flatMap(window => window.contentView.children)
      .filter(child => child.webContents?.getURL().includes('player-playback.html')).length), 1,
    'Detaching the Player must preserve exactly one playback WebContentsView.')
    await app.evaluate(({ BrowserWindow }) => {
      const output = BrowserWindow.getAllWindows().find(candidate =>
        !candidate.webContents.getURL().includes('player-control.html') &&
        candidate.contentView.children.some(child => child.webContents?.getURL().includes('player-playback.html')))
      if (!output) throw new Error('The output window was not found for close handling validation.')
      output.close()
    })
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.location === 'inline' && snapshot.videoWindow.ready &&
      snapshot.videoWindow.returnToInlineRevision > initialReturnRevision,
    'Closing the output before its detached snapshot arrives must publish an authoritative inline-return revision.')
    await app.evaluate(() => globalThis.__restorePlayerSnapshotSend?.())
    await page.locator('#player-video-view').waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await page.locator('#player-manual-view').isVisible(), false,
      'Closing a just-detached output must return navigation to Reprodutor even when the detached snapshot was delayed.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'The main window must remain available after closing the detached output.')
    assert.equal(await findPlaybackHostId(app), coldStartHostId,
      'Closing the idle detached window must reattach the same playback host inline.')
    await page.locator('#player-nav-manual').click()
    await page.locator('#player-library-empty-view').waitFor({ state: 'visible', timeout: 10000 })

    const actualUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    assert.equal(path.resolve(actualUserData), path.resolve(userData), 'O app deve usar apenas o perfil temporário do teste.')
    assert.equal(fs.existsSync(path.join(userData, 'karaoke.sqlite')), false,
      'Player-only não pode abrir nem criar o SQLite operacional do Controlador.')

    const bridgeStatus = await page.evaluate(() => ({
      playerBridge: typeof window.karaokePlayer,
      playerMethods: Object.keys(window.karaokePlayer ?? {}).sort(),
      controllerBridge: typeof window.karaokeDatabase,
      controllerApplication: typeof window.__kqueue,
      nodeRequire: typeof window.require,
      nodeProcess: typeof window.process
    }))
    assert.equal(bridgeStatus.playerBridge, 'object', 'A interface deve receber o bridge tipado do Player pelo Preload.')
    assert.equal(bridgeStatus.controllerBridge, 'undefined', 'O Preload Player-only não deve expor persistência Controller.')
    assert.equal(bridgeStatus.controllerApplication, 'undefined', 'A aplicação operacional do Controller não deve existir no Player-only.')
    assert.equal(bridgeStatus.nodeRequire, 'undefined', 'O Renderer não deve receber require.')
    assert.equal(bridgeStatus.nodeProcess, 'undefined', 'O Renderer não deve receber process Node.js.')
    for (const expectedMethod of ['getSnapshot', 'addToSequence', 'playNow', 'pause', 'resume', 'restart', 'stop']) {
      assert.ok(bridgeStatus.playerMethods.includes(expectedMethod), `O bridge restrito deve expor ${expectedMethod}.`)
    }

    // Main-owned directory selection is reached from the real empty-library
    // action; only the native operating-system picker response is controlled.
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, path.resolve(configuredMediaRoot))
    await page.locator('#player-library-configure').click()
    await waitForSnapshot(page, snapshot => snapshot.library.scanStatus === 'ready' && snapshot.library.availableCodes > 0,
      'A seleção segura de pasta deve indexar vídeos pelo serviço real')
    await page.locator('#player-library-change').waitFor({ state: 'visible' })
    await page.locator('#player-toast').waitFor({ state: 'hidden', timeout: 5000 })
    await assertVisibleIconsRendered(page, 'configurações do acervo')
    await page.screenshot({ path: path.join(screenshotRoot, 'player-settings-library-and-catalog.png') })

    await page.locator('#player-library-refresh').click()
    await waitForSnapshot(page, snapshot => snapshot.library.scanStatus === 'ready' && snapshot.library.availableCodes > 0,
      'Atualizar biblioteca deve refletir o resultado confirmado da indexação')

    // The catalog import uses the real CSV parser and isolated Player catalog
    // database; only the OS file picker is replaced by a deterministic choice.
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, catalogPath)
    await page.locator('#player-catalog-import').click()
    await waitForSnapshot(page, snapshot => snapshot.catalog.metadata.recordCount === 2,
      'A importação CSV deve atualizar o catálogo local do Player')
    await page.locator('#player-toast').waitFor({ state: 'hidden', timeout: 5000 })
    const catalogLookup = await page.evaluate(() => window.karaokePlayer.lookupMusicCode('1001'))
    assert.equal(catalogLookup.videoCode, '01001')
    assert.equal(catalogLookup.title, 'Always')
    assert.equal(catalogLookup.artist, 'Bon Jovi')

    await page.locator('#player-nav-back').click()
    await assertVisibleIconsRendered(page, 'controle manual vazio')
    await page.locator('#player-code').waitFor({ state: 'visible' })
    await page.screenshot({ path: path.join(screenshotRoot, 'player-manual-empty.png') })

    const invalidMediaRoot = path.join(root, 'invalid-media')
    fs.mkdirSync(invalidMediaRoot, { recursive: true })
    fs.writeFileSync(path.join(invalidMediaRoot, '99999.mp4'), 'invalid media fixture', 'utf8')
    await page.locator('#player-nav-settings').click()
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, invalidMediaRoot)
    await page.locator('#player-library-change').click()
    await waitForSnapshot(page, snapshot => snapshot.library.scanStatus === 'ready' &&
      snapshot.library.availableCodes > 0 && snapshot.library.configuredFolders.includes(path.resolve(invalidMediaRoot)),
    'A biblioteca temporária deve indexar o fixture inválido do E2E')
    await page.locator('#player-nav-back').click()
    await page.locator('#player-code').fill('99999')
    await page.locator('#player-play-now').click()
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'failed',
      'Mídia inválida deve produzir falha reconhecida pelo serviço')
    await page.locator('#player-error-dialog').waitFor({ state: 'visible', timeout: 15000 })
    await assertVisibleIconsRendered(page, 'erro de reprodução')
    await page.screenshot({ path: path.join(screenshotRoot, 'player-playback-error.png') })
    await page.locator('#playback-error-stay').click()
    await page.locator('#player-error-dialog').waitFor({ state: 'hidden' })
    const failedState = await page.evaluate(() => window.karaokePlayer.getSnapshot())
    assert.equal(failedState.sequence.pending.length, 0, 'Falha não deve preencher ou avançar a sequência.')
    await page.locator('#player-nav-manual').click()
    await page.locator('#player-code').fill('99999')
    await page.locator('#player-play-now').click()
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'failed' &&
      snapshot.playback.attemptId !== failedState.playback.attemptId,
    'Uma nova tentativa com falha deve receber uma nova identidade de reprodução')
    await page.locator('#player-error-dialog').waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('#playback-error-stay').click()
    await page.locator('#player-error-dialog').waitFor({ state: 'hidden' })
    await page.locator('#player-nav-manual').click()

    await page.locator('#player-nav-settings').click()
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, path.resolve(configuredMediaRoot))
    await page.locator('#player-library-change').click()
    await waitForSnapshot(page, snapshot => snapshot.library.scanStatus === 'ready' &&
      snapshot.library.availableCodes > 0 && snapshot.library.configuredFolders.includes(path.resolve(configuredMediaRoot)),
    'A biblioteca oficial somente leitura deve ser restaurada após o cenário de erro')
    await page.locator('#player-nav-back').click()

    // Add, reorder and remove pending entries through actual DOM controls and
    // verify their authoritative order through the Main-owned snapshot.
    await page.locator('#player-code').fill('1002')
    await page.locator('#player-add-sequence').click()
    await waitForSnapshot(page, snapshot => snapshot.sequence.pending.some(item => item.musicCode === '01002'),
      'Adicionar à sequência deve publicar o item confirmado')
    await page.locator('#player-code').fill('1001')
    await page.locator('#player-add-sequence').click()
    await waitForSnapshot(page, snapshot => snapshot.sequence.pending.length === 2,
      'A sequência local deve conter os dois itens explicitamente adicionados')

    let sequence = await page.evaluate(() => window.karaokePlayer.getSnapshot())
    const firstOrder = sequence.sequence.pending.map(item => item.musicCode)
    assert.deepEqual(firstOrder, ['01002', '01001'])
    const secondItem = sequence.sequence.pending[1]
    await page.locator(`#player-sequence .sequence-grip[data-sequence-id="${secondItem.id}"]`)
      .dragTo(page.locator(`#player-sequence .sequence-grip[data-sequence-id="${sequence.sequence.pending[0].id}"]`))
    await waitForSnapshot(page, snapshot => snapshot.sequence.pending[0]?.id === secondItem.id,
      'Reordenar item pendente deve atualizar o snapshot autoritativo')

    sequence = await page.evaluate(() => window.karaokePlayer.getSnapshot())
    const removeItem = sequence.sequence.pending[0]
    await page.locator(`#player-sequence button[data-sequence-id="${removeItem.id}"][data-action="remove"]`).click()
    await waitForSnapshot(page, snapshot => snapshot.sequence.pending.length === 1 &&
      snapshot.sequence.pending[0].musicCode === '01002', 'Remover item deve preservar a ordem restante')

    await page.locator('#player-nav-settings').click()
    await page.locator('#player-library-refresh').click()
    await page.locator('#player-toast').waitFor({ state: 'visible' })
    await page.locator('#player-nav-back').click()

    // This selection occurs with CSV configured, but playback resolution is
    // still backed by the indexed video library, not by catalog membership.
    await page.locator('#player-code').fill('1001')
    await page.locator('#player-play-now').click()
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' && snapshot.playback.musicCode === '01001',
      'Tocar agora deve iniciar a música pela biblioteca local')
    await page.waitForFunction(() => document.querySelector('#player-current-title')?.textContent === 'Always')
    assert.equal(await page.locator('#player-current-code').textContent(), '1001',
      'A interface deve formatar o código do jeito aprovado no frame Doop.')
    await page.locator('#player-toast').waitFor({ state: 'hidden' })
    playbackHostId = await waitForPlaybackHost(app)
    await page.locator('#player-video-view').waitFor({ state: 'visible' })
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.location === 'inline' && snapshot.videoWindow.ready,
      'A reprodução local deve aparecer na área central da tela Reprodutor.')
    await page.waitForFunction(async () => {
      const host = await window.karaokePlayer.getSnapshot()
      return host.videoWindow.location === 'inline'
    })
    await playbackHostEvaluate(app,
      'new Promise((resolve, reject) => { const check = () => { const video = document.querySelector("video"); if (video && video.currentTime >= 1.1) resolve(true); else setTimeout(check, 50) }; check() })')
    await page.waitForFunction(() => document.querySelector('#player-current-status')?.textContent?.includes('00:01'),
      undefined, { timeout: 10000 })
    await assertVisibleIconsRendered(page, 'controle manual em reprodução')
    await page.screenshot({ path: path.join(screenshotRoot, 'player-video-inline-shell.png') })
    await capturePlaybackHost(app, path.join(screenshotRoot, 'player-video-inline-media.png'))
    const inlineComposite = await captureCompositedPlayerWindow(app, path.join(screenshotRoot, 'player-video-inline-composite.png'))
    process.stdout.write(`PLAYER_INLINE_COMPOSITE ${JSON.stringify(inlineComposite)}\n`)
    if (process.platform === 'win32') assert.equal(inlineComposite.captured, true,
      'A validação Windows deve registrar a composição visível do Player e do vídeo inline.')

    const attemptBeforeDetach = (await page.evaluate(() => window.karaokePlayer.getSnapshot())).playback.attemptId
    const mediaTimeBeforeDetach = await playbackHostEvaluate(app, 'document.querySelector("video").currentTime')
    await page.locator('#player-detach-video').click()
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.location === 'window',
      'Abrir em outra janela deve mover o Player para uma janela independente.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2,
      'A opção de janela separada deve criar apenas uma janela de saída além do painel principal.')
    assert.equal(await findPlaybackHostId(app), playbackHostId,
      'A janela separada deve reutilizar o mesmo WebContents de reprodução.')
    await playbackHostEvaluate(app,
      `new Promise((resolve, reject) => { const check = () => { const media = document.querySelector("video"); if (media && media.currentTime > ${mediaTimeBeforeDetach} + 0.25) resolve(true); else setTimeout(check, 50) }; check() })`)
    await capturePlaybackHost(app, path.join(screenshotRoot, 'player-video-windowed.png'))
    const outputComposite = await captureCompositedOutputWindow(app,
      path.join(screenshotRoot, 'player-video-output-window-composite.png'))
    process.stdout.write(`PLAYER_OUTPUT_COMPOSITE ${JSON.stringify(outputComposite)}\n`)
    if (process.platform === 'win32') assert.equal(outputComposite.captured, true,
      'A validação Windows deve capturar a janela independente composta do Player.')

    const timeBeforeFullscreen = await playbackHostEvaluate(app, 'document.querySelector("video").currentTime')
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      if (!view) throw new Error('O Player em janela separada precisa manter a superfície Chromium ativa.')
      view.webContents.focus()
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' })
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' })
    })
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.fullScreen,
      'F11 deve ativar fullscreen real sem alterar a reprodução')
    const fullscreenSnapshot = await page.evaluate(() => window.karaokePlayer.getSnapshot())
    assert.equal(fullscreenSnapshot.playback.attemptId, attemptBeforeDetach,
      'Entrar em fullscreen não deve substituir a tentativa ativa')
    assert.equal(fullscreenSnapshot.playback.status, 'playing',
      'Entrar em fullscreen não deve pausar nem interromper a reprodução')
    await capturePlaybackHost(app, path.join(screenshotRoot, 'player-video-fullscreen.png'))
    const fullscreenComposite = await captureCompositedOutputWindow(app,
      path.join(screenshotRoot, 'player-video-fullscreen-composite.png'))
    process.stdout.write(`PLAYER_FULLSCREEN_COMPOSITE ${JSON.stringify(fullscreenComposite)}\n`)
    if (process.platform === 'win32') assert.equal(fullscreenComposite.captured, true,
      'A validação Windows deve capturar o fullscreen composto da janela independente.')
    await playbackHostEvaluate(app,
      `new Promise((resolve, reject) => { const check = () => { const media = document.querySelector("video"); if (media && media.currentTime > ${timeBeforeFullscreen} + 0.5) resolve(true); else setTimeout(check, 50) }; check() })`)
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      if (!view) throw new Error('O Player em janela separada precisa manter a superfície Chromium ativa.')
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    })
    await waitForSnapshot(page, snapshot => !snapshot.videoWindow.fullScreen,
      'Escape deve sair do fullscreen sem alterar a reprodução')
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      if (!view) throw new Error('The detached Player must retain its Chromium surface.')
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' })
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' })
    })
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.fullScreen,
      'F11 must enter fullscreen in the detached Player window.')
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      if (!view) throw new Error('The detached Player must retain its Chromium surface.')
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' })
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' })
    })
    await waitForSnapshot(page, snapshot => !snapshot.videoWindow.fullScreen,
      'F11 must exit fullscreen in the detached Player window.')

    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      if (!view) throw new Error('The detached Player must retain its Chromium surface before fullscreen close.')
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' })
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' })
    })
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.fullScreen,
      'The detached Player must enter fullscreen before its close behavior is checked.')

    const timeBeforeOutputClose = await playbackHostEvaluate(app, 'document.querySelector("video").currentTime')
    const attemptBeforeOutputClose = (await page.evaluate(() => window.karaokePlayer.getSnapshot())).playback.attemptId
    await app.evaluate(({ BrowserWindow }) => {
      const output = BrowserWindow.getAllWindows().find(candidate =>
        !candidate.webContents.getURL().includes('player-control.html') &&
        candidate.contentView.children.some(child => child.webContents?.getURL().includes('player-playback.html')))
      if (!output) throw new Error('The detached output window was not found for close handling validation.')
      output.close()
    })
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.location === 'inline' &&
      !snapshot.videoWindow.fullScreen && snapshot.playback.status === 'playing' && snapshot.playback.attemptId === attemptBeforeOutputClose,
    'Closing the fullscreen output must reattach playback without quitting the app or preserving fullscreen.')
    await page.locator('#player-video-view').waitFor({ state: 'visible', timeout: 10000 })
    await waitForPlaybackViewVisibility(app, true)
    assert.equal(await page.locator('#player-close-confirm').isVisible(), false,
      'Closing the detached window must not request application shutdown.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'The detached window X must close only the output window and keep the main window alive.')
    assert.equal(await findPlaybackHostId(app), playbackHostId,
      'Reattaching after the output window closes must preserve the same playback WebContents.')
    await playbackHostEvaluate(app,
      `new Promise((resolve, reject) => { const check = () => { const media = document.querySelector("video"); if (media && media.currentTime > ${timeBeforeOutputClose} + 0.25) resolve(true); else setTimeout(check, 50) }; check() })`)
    await page.screenshot({ path: path.join(screenshotRoot, 'player-video-returned-inline-after-x.png') })
    const returnedInlineComposite = await captureCompositedPlayerWindow(app,
      path.join(screenshotRoot, 'player-video-returned-inline-composite.png'))
    process.stdout.write(`PLAYER_RETURNED_INLINE_COMPOSITE ${JSON.stringify(returnedInlineComposite)}\n`)
    if (process.platform === 'win32') assert.equal(returnedInlineComposite.captured, true,
      'The Windows validation must capture the inline Player composition after closing the detached window.')

    const timeBeforeInlineFullscreen = await playbackHostEvaluate(app, 'document.querySelector("video").currentTime')
    await page.locator('#player-inline-fullscreen').click()
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.fullScreen && snapshot.videoWindow.location === 'inline',
      'Fullscreen must work in the embedded Player area.')
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      if (!view) throw new Error('The embedded Player must retain its Chromium surface.')
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' })
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' })
    })
    await waitForSnapshot(page, snapshot => !snapshot.videoWindow.fullScreen && snapshot.videoWindow.location === 'inline',
      'F11 must exit embedded fullscreen and restore the Player area.')
    await page.locator('.player-header').waitFor({ state: 'visible', timeout: 10000 })
    const restoredInlineBounds = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      return view?.getBounds() ?? null
    })
    assert.ok(restoredInlineBounds && restoredInlineBounds.width > 0 && restoredInlineBounds.height > 0,
      `Exiting fullscreen must restore valid bounds for the embedded Player: ${JSON.stringify(restoredInlineBounds)}`)
    await page.locator('#player-inline-fullscreen').click()
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.fullScreen,
      'The Tela cheia control must enter fullscreen from the embedded Player area.')
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      if (!view) throw new Error('The embedded Player must retain its Chromium surface.')
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    })
    await waitForSnapshot(page, snapshot => !snapshot.videoWindow.fullScreen,
      'Escape must exit embedded fullscreen and restore the navigation and video area.')
    await playbackHostEvaluate(app,
      `new Promise((resolve, reject) => { const check = () => { const media = document.querySelector("video"); if (media && media.currentTime > ${timeBeforeInlineFullscreen} + 0.5) resolve(true); else setTimeout(check, 50) }; check() })`)

    await page.locator('#player-nav-manual').click()
    await page.locator('#player-manual-view').waitFor({ state: 'visible', timeout: 10000 })
    const inlineAttemptBeforeControls = (await page.evaluate(() => window.karaokePlayer.getSnapshot())).playback.attemptId
    const inlinePause = await page.evaluate(() => window.karaokePlayer.pause())
    assert.equal(inlinePause.outcome, 'accepted')
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'paused' &&
      snapshot.videoWindow.location === 'inline', 'Pausing inline playback must preserve its display location.')
    const inlineResume = await page.evaluate(() => window.karaokePlayer.resume())
    assert.equal(inlineResume.outcome, 'accepted')
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' &&
      snapshot.playback.attemptId === inlineAttemptBeforeControls && snapshot.videoWindow.location === 'inline',
    'Resuming inline playback must preserve the attempt and must not open another window.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)

    const inlineRestart = await page.evaluate(() => window.karaokePlayer.restart())
    assert.equal(inlineRestart.outcome, 'accepted')
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' &&
      snapshot.playback.attemptId !== inlineAttemptBeforeControls && snapshot.videoWindow.location === 'inline',
    'Restarting inline playback must invalidate the previous attempt without moving the surface.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)

    for (const code of ['1001', '1002']) {
      const addResult = await page.evaluate(value => window.karaokePlayer.addToSequence(value), code)
      assert.equal(addResult.outcome, 'queued')
    }
    await waitForSnapshot(page, snapshot => snapshot.sequence.pending.length === 3,
      'Inline Next and Previous must use explicit sequence items without replacing the playback surface.')
    const inlineNext = await page.evaluate(() => window.karaokePlayer.next())
    assert.equal(inlineNext.outcome, 'started')
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' &&
      snapshot.playback.musicCode === '01002' && snapshot.videoWindow.location === 'inline',
    'Next must keep playback inline.')
    const inlineNextAgain = await page.evaluate(() => window.karaokePlayer.next())
    assert.equal(inlineNextAgain.outcome, 'started')
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' &&
      snapshot.playback.musicCode === '01001' && snapshot.videoWindow.location === 'inline',
    'Next must follow the explicit sequence and keep the inline display location.')
    const inlinePrevious = await page.evaluate(() => window.karaokePlayer.previous())
    assert.equal(inlinePrevious.outcome, 'started')
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' &&
      snapshot.playback.musicCode === '01002' && snapshot.videoWindow.location === 'inline',
    'Previous must follow the explicit sequence without opening a detached window.')
    const inlineNextToCurrent = await page.evaluate(() => window.karaokePlayer.next())
    assert.equal(inlineNextToCurrent.outcome, 'started')
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' &&
      snapshot.playback.musicCode === '01001' && snapshot.sequence.pending.length === 1 &&
      snapshot.videoWindow.location === 'inline',
    'Inline sequence navigation must preserve the single remaining explicit item.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'Inline Next and Previous must not create a detached window.')
    const timeBeforeManualNavigation = await playbackHostEvaluate(app, 'document.querySelector("video").currentTime')
    await page.locator('#player-nav-manual').click()
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.location === 'inline',
      'Opening Controle during playback must not detach the Player automatically.')
    const hiddenPlaybackAdvanced = await playbackHostEvaluate(app,
      `new Promise(resolve => { const check = () => { const media = document.querySelector("video"); if (media && media.currentTime > ${timeBeforeManualNavigation} + 0.25) resolve(true); else setTimeout(check, 50) }; check() })`)
    assert.equal(hiddenPlaybackAdvanced, true,
      'Playback must continue advancing while the operator uses the manual-control view.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'Navigating to Controle during embedded playback must keep a single application window.')
    assert.equal(await findPlaybackHostId(app), playbackHostId,
      'Navigating to Controle must preserve the same playback surface and attempt.')
    await page.locator('#player-nav-video').click()
    await page.locator('#player-video-view').waitFor({ state: 'visible', timeout: 10000 })
    await playbackHostEvaluate(app,
      `new Promise((resolve, reject) => { const check = () => { const media = document.querySelector("video"); if (media && media.currentTime > ${timeBeforeManualNavigation} + 0.25) resolve(true); else setTimeout(check, 50) }; check() })`)

    const originalCatalogRevision = (await page.evaluate(() => window.karaokePlayer.getSnapshot())).catalog.metadata.revision
    fs.writeFileSync(replacementCatalogPath,
      '\uFEFFartista;numero;nome_musica\r\nArtista Atualizado;1001;Always Atualizada\r\nLegião Urbana;1002;Tempo Perdido\r\n', 'utf8')
    await page.locator('#player-nav-settings').click()
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, replacementCatalogPath)
    await page.locator('#player-catalog-import').click()
    await waitForSnapshot(page, snapshot => snapshot.catalog.metadata.sourceName === 'player-catalog-replacement.csv' &&
      snapshot.catalog.metadata.revision !== originalCatalogRevision,
    'Substituir CSV deve publicar a nova revisão do catálogo')
    await page.locator('#player-toast').waitFor({ state: 'hidden', timeout: 5000 })
    await assertVisibleIconsRendered(page, 'configurações após importar CSV')
    await page.waitForFunction(() => document.querySelector('#player-current-title')?.textContent === 'Always Atualizada',
      undefined, { timeout: 10000 })
    await page.waitForFunction(() => document.querySelector('#player-current-artist')?.textContent === 'Artista Atualizado',
      undefined, { timeout: 10000 })
    await page.screenshot({ path: path.join(screenshotRoot, 'player-settings-library-and-catalog-imported.png') })
    await page.locator('#player-nav-back').click()
    const headerVisual = await page.locator('.player-brand').evaluate(element => {
      const style = getComputedStyle(element)
      const bounds = element.getBoundingClientRect()
      return { display: style.display, visibility: style.visibility, opacity: style.opacity,
        width: bounds.width, text: element.innerText }
    })
    assert.notEqual(headerVisual.display, 'none', 'A marca deve permanecer visível ao retornar das Configurações.')
    assert.ok(headerVisual.width > 0 && headerVisual.text.includes('Karaoke Queue'),
      `O cabeçalho deve preservar a marca depois da navegação: ${JSON.stringify(headerVisual)}`)
    const visiblePlayerWindows = await app.evaluate(({ BrowserWindow }) => ({
      focusedUrl: BrowserWindow.getFocusedWindow()?.webContents.getURL() ?? null,
      controlVisible: BrowserWindow.getAllWindows().some(window =>
        window.webContents.getURL().includes('player-control.html') && window.isVisible()),
      windowCount: BrowserWindow.getAllWindows().length
    }))
    assert.equal(visiblePlayerWindows.controlVisible, true,
      `A janela principal do Reprodutor deve permanecer visível durante playback: ${JSON.stringify(visiblePlayerWindows)}`)
    assert.ok(visiblePlayerWindows.windowCount <= 2,
      `A execução deve manter somente painel e eventual janela de vídeo: ${JSON.stringify(visiblePlayerWindows)}`)
    const runtimeIdentity = await app.evaluate(({ app: electronApp }) => ({
      processPlatform: process.platform,
      processExecutable: process.execPath,
      versions: {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node
      },
      userData: electronApp.getPath('userData')
    }))
    process.stdout.write(`PLAYER_RUNTIME ${JSON.stringify(runtimeIdentity)}\n`)
    const initialPlayback = await page.evaluate(() => window.karaokePlayer.getSnapshot())
    const initialAttemptId = initialPlayback.playback.attemptId
    assert.equal(initialPlayback.sequence.pending.length, 1,
      'Tocar agora não deve descartar a sequência pendente')

    const observedEvents = await page.evaluate(() => {
      window.__playerControlEvents = []
      window.__playerControlUnsubscribe = window.karaokePlayer.onPlaybackEvent(event => {
        window.__playerControlEvents.push(event)
      })
      return true
    })
    assert.equal(observedEvents, true)

    const mediaReadiness = await playbackHostEvaluate(app,
      'new Promise((resolve, reject) => { const check = () => { const media = document.querySelector("video"); if (media && media.readyState >= 2 && media.videoWidth > 0 && media.videoHeight > 0) resolve({ width: media.videoWidth, height: media.videoHeight, objectFit: getComputedStyle(media).objectFit }); else setTimeout(check, 50) }; check() })')
    assert.ok(mediaReadiness.width > 0 && mediaReadiness.height > 0,
      'A superfície de vídeo inline deve renderizar metadados de vídeo real.')
    assert.equal(mediaReadiness.objectFit, 'contain', 'O vídeo deve preservar proporção sem ser esticado.')
    assert.equal(await findPlaybackHostId(app), playbackHostId,
      'O vídeo precisa continuar no mesmo WebContents após mudar de página.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'Navigating to Controle must not create a detached output window during playback.')
    const audioDiagnostics = await playbackHostEvaluate(app, `(() => {
      const media = document.querySelector("video")
      return {
        currentTime: media.currentTime,
        readyState: media.readyState,
        paused: media.paused,
        muted: media.muted,
        defaultMuted: media.defaultMuted,
        volume: media.volume,
        mediaErrorCode: media.error?.code ?? null,
        videoWidth: media.videoWidth,
        videoHeight: media.videoHeight,
        audioTrackCount: 'audioTracks' in media ? media.audioTracks.length : null,
        decodedAudioBytes: 'webkitAudioDecodedByteCount' in media ? media.webkitAudioDecodedByteCount : null
      }
    })()`)
    assert.equal(audioDiagnostics.paused, false, 'O elemento de mídia deve estar efetivamente reproduzindo.')
    assert.equal(audioDiagnostics.muted, false, 'A UI de produção não deve mutar o áudio do vídeo.')
    assert.ok(audioDiagnostics.volume > 0, 'O volume do elemento deve estar acima de zero.')
    assert.equal(audioDiagnostics.mediaErrorCode, null, 'O elemento não deve reportar erro de mídia durante a reprodução.')
    process.stdout.write(`PLAYER_MEDIA_DIAGNOSTICS ${JSON.stringify(audioDiagnostics)}\n`)

    await page.locator('#player-toggle').click()
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'paused',
      'Pausar deve aguardar a confirmação do serviço')
    const pausedPlayback = await page.evaluate(() => window.karaokePlayer.getSnapshot())
    assert.equal(pausedPlayback.playback.attemptId, initialAttemptId,
      'Pausa deve preservar a identidade da tentativa')
    await page.screenshot({ path: path.join(screenshotRoot, 'player-manual-paused.png') })
    await assertVisibleIconsRendered(page, 'controle manual pausado')

    await page.locator('#player-toggle').click()
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing',
      'Continuar deve retomar a reprodução confirmada')
    const resumedPlayback = await page.evaluate(() => window.karaokePlayer.getSnapshot())
    assert.equal(resumedPlayback.playback.attemptId, initialAttemptId,
      'Retomar deve manter a mesma tentativa')
    assert.equal(resumedPlayback.videoWindow.location, 'inline',
      'Resuming embedded playback must preserve the selected display location.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'Resuming playback in the embedded area must not create a detached window.')

    await page.locator('#player-restart').click()
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' &&
      snapshot.playback.attemptId !== initialAttemptId, 'Reiniciar deve confirmar uma nova identidade de tentativa')
    const restartedPlayback = await page.evaluate(() => window.karaokePlayer.getSnapshot())
    assert.notEqual(restartedPlayback.playback.attemptId, initialAttemptId)
    assert.equal(restartedPlayback.videoWindow.location, 'inline',
      'Restarting must preserve the embedded display location.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'Restarting inline playback must not open a detached window.')

    // Confirm that a close request is cancellable without stopping or replacing
    // the active attempt. The final app cleanup remains owned by this E2E.
    await app.evaluate(({ BrowserWindow }) => {
      const control = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('player-control.html'))
      if (!control) throw new Error('Player control window was not found.')
      control.close()
    })
    await page.locator('#player-close-confirm').waitFor({ state: 'visible', timeout: 10000 })
    await assertVisibleIconsRendered(page, 'confirmação de encerramento')
    await page.screenshot({ path: path.join(screenshotRoot, 'player-shutdown-confirmation.png') })
    await page.locator('#player-close-cancel').click()
    await page.locator('#player-close-confirm').waitFor({ state: 'hidden', timeout: 10000 })
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' &&
      snapshot.playback.attemptId === restartedPlayback.playback.attemptId,
    'Cancelar o encerramento deve manter a mesma reprodução ativa')

    await page.locator('#player-stop').click()
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'stopped',
      'Parar deve ser confirmado sem encerrar o app por EOF')
    const finalSnapshot = await page.evaluate(() => window.karaokePlayer.getSnapshot())
    assert.equal(finalSnapshot.sequence.pending.length, 1,
      'Stop não deve avançar nem eliminar o item pendente da sequência')
    const playbackEvents = await page.evaluate(() => {
      window.__playerControlUnsubscribe?.()
      return window.__playerControlEvents
    })
    assert.equal(playbackEvents.some(event => event.type === 'natural-end-candidate'), false,
      'A reprodução observada foi interrompida por controles, nunca concluída naturalmente')

    // Closing an idle detached output returns to the inline area without
    // destroying the playback host; a later explicit detach reuses that host.
    await page.evaluate(() => Promise.all([
      window.karaokePlayer.showVideoWindow(),
      window.karaokePlayer.showVideoWindow()
    ]))
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.open && snapshot.videoWindow.ready,
      'Chamadas simultâneas para abrir a janela devem conectar um único host Chromium')
    assert.equal(await findPlaybackHostId(app), playbackHostId,
      'Chamadas simultâneas de abertura devem reutilizar um único WebContents.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2,
      'As chamadas concorrentes devem criar uma única janela de saída.')

    await app.evaluate(({ BrowserWindow }) => {
      const output = BrowserWindow.getAllWindows().find(candidate =>
        !candidate.webContents.getURL().includes('player-control.html') &&
        candidate.contentView.children.some(child => child.webContents?.getURL().includes('player-playback.html')))
      if (!output) throw new Error('The detached output window was not found for idle close validation.')
      output.close()
    })
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.location === 'inline' && snapshot.videoWindow.ready,
      'Closing an idle detached window must return the Player to the embedded area.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1,
      'Closing an idle detached window must preserve the main window.')
    assert.equal(await findPlaybackHostId(app), playbackHostId,
      'Closing an idle detached window must preserve the same Chromium host.')

    await page.evaluate(() => window.karaokePlayer.showVideoWindow())
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.open && snapshot.videoWindow.ready,
      'A later explicit detach request must create an available Chromium output surface.')
    const reopenedHostId = await findPlaybackHostId(app)
    assert.equal(reopenedHostId, playbackHostId,
      'Detaching again must reuse the same reattached Chromium surface.')
    playbackHostId = reopenedHostId

    // A crashed Renderer is replaced by an owned, fresh host; the controller
    // window stays alive and playback only resumes after a new explicit action.
    const crashedHostId = await findPlaybackHostId(app)
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .find(child => child.webContents?.getURL().includes('player-playback.html'))
      if (!view) throw new Error('The playback WebContentsView was not found before crash validation.')
      view.webContents.forcefullyCrashRenderer()
    })
    await waitForSnapshot(page, snapshot => !snapshot.videoWindow.ready,
      'A falha do Renderer deve marcar o host como indisponível')
    await page.evaluate(() => Promise.all([
      window.karaokePlayer.showVideoWindow(),
      window.karaokePlayer.showVideoWindow()
    ]))
    await waitForSnapshot(page, snapshot => snapshot.videoWindow.open && snapshot.videoWindow.ready,
      'Chamadas simultâneas após crash devem criar somente um novo host Chromium')
    playbackHostId = await findPlaybackHostId(app)
    assert.notEqual(playbackHostId, crashedHostId,
      'Após crash, somente um WebContentsView novo pode substituir o Renderer encerrado.')
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window =>
      window.contentView.children).filter(child => child.webContents?.getURL().includes('player-playback.html')).length), 1,
    'A recriação concorrente após crash não pode criar WebContentsViews duplicados.')
    await page.locator('#player-nav-manual').click()
    await page.locator('#player-code').fill('1002')
    await page.locator('#player-play-now').click()
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'playing' && snapshot.playback.musicCode === '01002',
      'A reprodução deve continuar disponível após recriar a janela de vídeo')
    await page.locator('#player-stop').click()
    await waitForSnapshot(page, snapshot => snapshot.playback.status === 'stopped',
      'A reprodução de verificação deve parar com confirmação')

    assert.equal(fs.existsSync(path.join(userData, 'karaoke.sqlite')), false,
      'A integração manual e de catálogo Player-only não pode criar SQLite operacional do Controller.')
    assert.equal(fs.existsSync(path.join(userData, 'player-music-catalog.sqlite')), true,
      'O catálogo deve persistir somente no armazenamento isolado do Player.')
    process.stdout.write('PASS Player-only app E2E: Preload restrito, IPC real, biblioteca/CSV, sequência, controles, janela Chromium e isolamento do SQLite operacional.\n')
  } finally {
    if (app) {
      let openWindows = []
      try { openWindows = app.windows() } catch {}
      const controlPage = openWindows.find(candidate => candidate.url().includes('player-control.html'))
      if (controlPage) {
        await controlPage.evaluate(async () => {
          const api = window.karaokePlayer
          if (!api) return
          const state = await api.getSnapshot()
          if (['loading', 'starting', 'playing', 'paused', 'stopping'].includes(state.playback.status)) {
            await api.stop()
          }
        }).catch(() => {})
      }
      await app.close().catch(() => {})
    }
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  }
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
