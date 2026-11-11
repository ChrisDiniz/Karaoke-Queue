// @ts-nocheck
export {}

// Production lifecycle coverage: this launches build/main.js through Electron,
// with the real Preload, validated IPC, SQLite, sequence and Chromium MP4 host.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
let mediaRoot = process.env.KQ_PLAYER_TEST_MEDIA_DIR
const profileRootOverride = process.env.KQ_STANDALONE_PRODUCTION_PROFILE
const configuredTempRoot = process.env.KARAOKE_TEST_TEMP_ROOT
let progressSink = (_message) => {}
let activeF0EvidenceWriter = null
let activeF0EvidenceStage = 'campaign-start'
let activeF0LogPath = null

function writeProgress(message) {
  process.stdout.write(`C9_PROGRESS ${message}\n`)
  try {
    progressSink(message)
  } catch (error) {
    process.stderr.write(`C9_PROGRESS_LOG_ERROR ${String(error)}\n`)
  }
}

function makeProfileRoot() {
  const root = profileRootOverride ? path.resolve(profileRootOverride)
    : configuredTempRoot ? path.resolve(configuredTempRoot)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-standalone-production-'))
  if (profileRootOverride || configuredTempRoot) {
    if (fs.existsSync(root)) {
      if (process.env.KQ_F0_RESUME_INDEX !== '1' || !fs.statSync(root).isDirectory()) {
        throw new Error('The isolated production profile already exists.')
      }
      return root
    }
    fs.mkdirSync(root, { recursive: false })
  }
  return root
}

async function assertNoLinuxElectronProcesses(profileRoot) {
  if (process.platform !== 'linux') return
  const findResiduals = () => {
    const residuals = []
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const command = fs.readFileSync(path.join('/proc', entry, 'cmdline'), 'utf8').replaceAll('\0', ' ')
        if (command.includes(profileRoot) && /electron|chromium|chrome/i.test(command)) {
          residuals.push({ pid: entry, command: command.slice(0, 500) })
        }
      } catch { /* A process can exit while /proc is being enumerated. */ }
    }
    return residuals
  }
  const deadline = Date.now() + 5000
  let residuals = findResiduals()
  while (residuals.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    residuals = findResiduals()
  }
  assert.deepEqual(residuals, [], 'Nenhum processo Electron/Chromium pode permanecer associado ao perfil de produção.')
}

async function assertNoWindowsElectronProcesses(profileRoot) {
  if (process.platform !== 'win32') return
  const escaped = profileRoot.replaceAll("'", "''")
  const command = "$ErrorActionPreference='Stop'; $needle='" + escaped + "'; " +
    '$items=@(Get-CimInstance Win32_Process -Filter "Name = \'electron.exe\'" -ErrorAction Stop | ' +
    'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) }); ' +
    'foreach($item in $items){ Write-Output ("RESIDUAL_ELECTRON pid=" + $item.ProcessId) }; ' +
    'if($items.Count){ exit 3 }'
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 10000, shell: false, windowsHide: true
  })
  if (result.error || result.status !== 0) {
    throw new Error(`O perfil não pode ser removido até o Electron terminar; ${result.stdout || result.stderr || result.error || result.status}`)
  }
}

function sampleWindowsProcessResources(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    const command = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $cpu=[double]$p.CPU; ` +
      "[Console]::Out.WriteLine([string]$p.WorkingSet64 + '|' + $cpu.ToString([Globalization.CultureInfo]::InvariantCulture))"
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', timeout: 5000, shell: false, windowsHide: true
    }).trim()
    const [workingSetText, cpuText] = output.split('|')
    const workingSetBytes = Number(workingSetText)
    const cpuSeconds = Number(cpuText)
    if (!Number.isFinite(workingSetBytes) || !Number.isFinite(cpuSeconds)) return null
    return { workingSetBytes, cpuSeconds }
  } catch { return null }
}

async function seedCatalogDatabase(userData) {
  const { createPlayerMusicCatalogDatabase } = require(path.join(projectRoot, 'build', 'database.js'))
  const { MusicCatalogService } = require(path.join(projectRoot, 'build', 'src', 'music-catalog-service.js'))
  const database = createPlayerMusicCatalogDatabase(userData)
  const catalog = new MusicCatalogService(database)
  const csvPath = path.join(userData, 'catalogo.csv')
  fs.writeFileSync(csvPath, 'artista,numero,nome_musica\nBon Jovi,1001,Always\n', 'utf8')
  try {
    // Use the canonical fixture filename: hosted Windows may resolve the
    // temporary profile through a filesystem alias even after TEMP normalization.
    const imported = await catalog.importFile(await fs.promises.realpath(csvPath))
    assert.equal(imported.recordCount, 1)
  } finally {
    await catalog.close()
    database.close()
    fs.rmSync(csvPath, { force: true })
  }
}

function mediaCodes(root) {
  const codes = new Set()
  for (const relative of fs.readdirSync(root, { recursive: true })) {
    if (typeof relative !== 'string') continue
    const match = /^([0-9]{5})(?:[ _-].*)?\.mp4$/i.exec(path.basename(relative))
    if (match) codes.add(match[1])
  }
  return codes
}

async function waitForSnapshot(page, predicate, message, timeoutMs = 20000) {
  writeProgress(`snapshot START ${message}`)
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await page.evaluate(() => window.standalonePlayer?.getSnapshot?.()).catch(() => undefined)
    if (latest && predicate(latest.snapshot)) {
      if (latest.snapshot.playbackCondition !== 'ready' || latest.snapshot.state.operationalState !== 'idle') {
        await page.locator('#standalone-license-controls').waitFor({ state: 'hidden' })
        assert.equal(await page.locator('#standalone-license-modal').isVisible(), false,
          'activation dialog must not overlay playback, pause, countdown, loading or celebration')
      }
      writeProgress(`snapshot PASS ${message}`)
      return latest.snapshot
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  writeProgress(`snapshot TIMEOUT ${message}`)
  throw new Error(`${message}; último snapshot=${JSON.stringify(latest)}`)
}

async function waitForNativeClose(page, app, timeoutMs = 20000) {
  const child = app.process()
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }))
  let timer
  try {
    return await Promise.race([
      exited,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Electron não encerrou dentro do prazo após confirmação.')), timeoutMs) })
    ])
  } finally { if (timer) clearTimeout(timer) }
}

async function waitForStandaloneWindow(app, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let pages = []
  while (Date.now() < deadline) {
    pages = app.windows()
    const page = pages.find(candidate => candidate.url().includes('/standalone-player.html'))
    if (page) {
      await page.waitForLoadState('domcontentloaded')
      return page
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Janela Standalone ausente; páginas Electron=${JSON.stringify(pages.map(candidate => candidate.url()))}`)
}

async function playbackHostState(app) {
  writeProgress('playback-host-state MAIN START')
  const state = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!window || window.webContents.isDestroyed()) throw new Error('A janela Standalone de produção não foi encontrada.')
    return window.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('video')
      if (!video) return null
      const rect = video.getBoundingClientRect()
      const style = getComputedStyle(video)
      return {
        paused: video.paused, currentTime: video.currentTime, duration: video.duration,
        readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
        visible: style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
    })()`)
  })
  writeProgress('playback-host-state MAIN PASS')
  return state
}

async function playbackSurfacePresentation(app) {
  return app.evaluate(async ({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const window = windows.find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!window || window.webContents.isDestroyed()) throw new Error('A janela Standalone de produção não foi encontrada.')
    const presentation = await window.webContents.executeJavaScript(`(() => {
      const waiting = document.getElementById('player-waiting')
      const video = document.querySelector('#playback-media-layer video')
      const mediaLayer = document.getElementById('playback-media-layer')
      const visible = element => {
        if (!element) return false
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
      }
      return {
        documentTitle: document.title,
        waitingVisible: Boolean(waiting && !waiting.hidden && getComputedStyle(waiting).display !== 'none'),
        waitingCopy: waiting?.innerText ?? '',
        videoPresent: Boolean(video),
        videoPaused: video?.paused ?? null,
        currentTime: video?.currentTime ?? null,
        videoVisible: visible(video),
        mediaLayerVisible: visible(mediaLayer),
        pausedIndicatorVisible: visible(document.getElementById('standalone-paused-indicator')),
        resumeIndicatorVisible: visible(document.getElementById('standalone-resuming-indicator')),
        queueVisible: visible(document.getElementById('standalone-queue')),
        addPanelVisible: visible(document.getElementById('standalone-playing-panel')),
        infoPanelVisible: visible(document.getElementById('standalone-current-track-info')),
        menuVisible: visible(document.getElementById('standalone-main-menu'))
      }
    })()`)
    const inlinePlaybackViews = windows.flatMap(owner => owner.contentView.children)
      .filter(child => child.webContents?.getURL().includes('player-playback.html')).length
    return { ...presentation, windowUrls: windows.map(owner => owner.webContents.getURL()), inlinePlaybackViews }
  })
}

async function capturePlaybackSurface(app, outputPath) {
  const screenshotBase64 = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!window || window.webContents.isDestroyed()) throw new Error('A janela Standalone de produção não foi encontrada para captura.')
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  fs.writeFileSync(outputPath, Buffer.from(screenshotBase64, 'base64'))
  return outputPath
}

async function stopFailedIsolatedApp(app) {
  const child = app.process()
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      const exited = once(child, 'exit').then(() => true)
      const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        encoding: 'utf8', timeout: 10000, shell: false, windowsHide: true
      })
      if ((result.error || result.status !== 0) && child.exitCode === null && child.signalCode === null) {
        throw new Error(`Não foi possível parar a árvore Electron exclusiva do teste; ${result.stdout || result.stderr || result.error || result.status}`)
      }
      const stopped = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(false), 3000))])
      if (!stopped && child.exitCode === null && child.signalCode === null) {
        throw new Error('A árvore Electron exclusiva permaneceu ativa após taskkill /T.')
      }
      return
    }
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    let timer
    const result = await Promise.race([
      exited.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000) })
    ])
    if (timer) clearTimeout(timer)
    if (!result && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))])
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('O processo Electron isolado continuou ativo após SIGTERM e SIGKILL.')
  }
}

async function waitForPlaybackHost(app, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let host
  while (Date.now() < deadline) {
    host = await app.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      const window = windows.find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
      if (!window || window.webContents.isDestroyed()) return undefined
      const video = await window.webContents.executeJavaScript(`(() => {
        const element = document.querySelector('#playback-media-layer video')
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
      })()`)
      return {
        visible: video,
        fullScreen: window.isFullScreen(),
        windowUrls: windows.map(owner => owner.webContents.getURL()),
        inlinePlaybackViews: windows.flatMap(owner => owner.contentView.children)
          .filter(child => child.webContents?.getURL().includes('player-playback.html')).length
      }
    })
    if (host?.visible && host.inlinePlaybackViews === 0 && host.windowUrls.length === 1) return host
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`O vídeo precisa compor a própria janela Standalone de produção sem WebContentsView separado: ${JSON.stringify(host)}`)
}

async function waitForIntegratedPlaybackSurface(app, requireVideo = false) {
  const presentation = await playbackSurfacePresentation(app)
  assert.deepEqual(presentation.windowUrls.length, 1,
    'Standalone e vídeo devem permanecer na única BrowserWindow real de produção.')
  assert.equal(presentation.inlinePlaybackViews, 0,
    'O Main de produção não deve criar um WebContentsView legado sobre os overlays Standalone.')
  if (requireVideo) {
    assert.equal(presentation.videoPresent, true, 'O mesmo documento Standalone deve conter o elemento do MP4.')
    assert.equal(presentation.videoVisible, true, 'O elemento MP4 precisa ocupar uma superfície visível da janela.')
  }
  writeProgress(`integrated-playback-surface PASS ${JSON.stringify(presentation)}`)
  return presentation
}

async function waitForFullScreen(app, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let actual
  while (Date.now() < deadline) {
    actual = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(window => window.webContents.getURL().includes('standalone-player.html'))?.isFullScreen() ?? false)
    if (actual === expected) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const main = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('standalone-player.html'))
    return win ? {
      fullScreen: win.isFullScreen(), focused: win.isFocused(), webContentsFocused: win.webContents.isFocused(),
      url: win.webContents.getURL(), destroyed: win.isDestroyed()
    } : null
  }).catch(error => ({ error: String(error) }))
  const renderer = await app.windows()[0]?.evaluate(() => ({
    focused: document.hasFocus(), f11Trace: window.__f11Trace ?? [], hintHidden: document.getElementById('player-fullscreen-hint')?.hidden
  })).catch(error => ({ error: String(error) }))
  const directBridge = await app.windows()[0]?.evaluate(async () => {
    if (typeof window.playerPlayback?.toggleFullScreen !== 'function') return { available: false }
    try { return { available: true, result: await window.playerPlayback.toggleFullScreen() } }
    catch (error) { return { available: true, error: String(error) } }
  }).catch(error => ({ error: String(error) }))
  const afterDirectBridge = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('standalone-player.html'))
    return win ? { fullScreen: win.isFullScreen(), focused: win.isFocused(), webContentsFocused: win.webContents.isFocused() } : null
  }).catch(error => ({ error: String(error) }))
  throw new Error(`Fullscreen deveria estar ${expected ? 'ativo' : 'desativado'} imediatamente; estado=${actual}; main=${JSON.stringify(main)}; renderer=${JSON.stringify(renderer)}; directBridge=${JSON.stringify(directBridge)}; afterDirectBridge=${JSON.stringify(afterDirectBridge)}`)
}

async function assertStandaloneInputFocus(page, app) {
  const windowFocused = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    return Boolean(window && window.isFocused() && window.webContents.isFocused())
  })
  const documentFocused = await page.evaluate(() => document.hasFocus())
  assert.equal(windowFocused, true, 'A BrowserWindow e seu WebContents devem manter o foco após o clique.')
  assert.equal(documentFocused, true, 'O documento Standalone deve continuar sendo o destino dos atalhos.')
}

async function clickStandaloneSurface(page, app, x, y) {
  if (process.platform !== 'win32') {
    await page.mouse.click(x, y)
    return
  }

  await page.evaluate(() => {
    window.__e0NativeMouseTrace = []
    document.addEventListener('mousedown', event => {
      window.__e0NativeMouseTrace.push({ trusted: event.isTrusted, x: event.clientX, y: event.clientY })
    }, { capture: true, once: true })
  })
  const target = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!win || win.isDestroyed()) throw new Error('A janela Standalone não está disponível para clique nativo.')
    win.show()
    win.focus()
    return { hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(16), pid: process.pid }
  })
  const nativeClick = String.raw`
using System;
using System.Runtime.InteropServices;
public static class KqNativeMouseClick {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetClientRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ClientToScreen(IntPtr handle, ref POINT point);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetDpiForWindow(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  public static uint Click() {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 0; inputs[0].data.mi.dwFlags = 0x0002;
    inputs[1].type = 0; inputs[1].data.mi.dwFlags = 0x0004;
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new InvalidOperationException("SendInput aceitou " + sent + " de " + inputs.Length + " eventos; erro=" + Marshal.GetLastWin32Error());
    return sent;
  }
}
`
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$targetPid = ' + String(target.pid),
    '$targetHandle = [IntPtr]([Convert]::ToInt64("' + target.hwnd + '", 16))',
    '$cssX = ' + String(x),
    '$cssY = ' + String(y),
    'Add-Type -TypeDefinition @\'' + nativeClick + "'@",
    '$windowPid = [uint32]0; [void][KqNativeMouseClick]::GetWindowThreadProcessId($targetHandle, [ref]$windowPid)',
    'if ($targetHandle -eq [IntPtr]::Zero -or $windowPid -ne $targetPid) { throw "O HWND não pertence ao processo Electron Standalone esperado." }',
    '$rect = New-Object KqNativeMouseClick+RECT; if (-not [KqNativeMouseClick]::GetClientRect($targetHandle, [ref]$rect)) { throw "GetClientRect falhou." }',
    '$scale = [KqNativeMouseClick]::GetDpiForWindow($targetHandle) / 96.0',
    '$point = New-Object KqNativeMouseClick+POINT; $point.X = [int][Math]::Round($cssX * $scale); $point.Y = [int][Math]::Round($cssY * $scale)',
    'if ($point.X -lt 0 -or $point.Y -lt 0 -or $point.X -ge $rect.Right -or $point.Y -ge $rect.Bottom) { throw "O ponto CSS solicitado está fora da área cliente nativa." }',
    'if (-not [KqNativeMouseClick]::ClientToScreen($targetHandle, [ref]$point)) { throw "ClientToScreen falhou." }',
    'if (-not [KqNativeMouseClick]::SetCursorPos($point.X, $point.Y)) { throw "SetCursorPos falhou." }',
    '$sent = [KqNativeMouseClick]::Click()',
    '$foreground = [KqNativeMouseClick]::GetForegroundWindow(); $foregroundPid = [uint32]0; [void][KqNativeMouseClick]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)',
    'if ($foreground -ne $targetHandle -or $foregroundPid -ne $targetPid) { throw "O clique nativo não ativou a janela Standalone esperada." }',
    'Write-Output ("NATIVE_MOUSE_CLICK_PASS events=" + $sent + " dpi=" + [KqNativeMouseClick]::GetDpiForWindow($targetHandle))'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', command], {
    encoding: 'utf8', timeout: 10000, shell: false, windowsHide: true
  })
  writeProgress(`native mouse click exit=${result.status} stdout=${result.stdout?.trim() ?? ''}`)
  if (result.error || result.status !== 0) {
    throw new Error(`Não foi possível clicar na superfície Standalone com entrada nativa: ${result.stderr || result.error || result.status}`)
  }
  await page.waitForFunction(() => window.__e0NativeMouseTrace?.some(event => event.trusted), undefined, { timeout: 5000 })
}

async function captureComposite(page, app, screenshotRoot, name) {
  await waitForIntegratedPlaybackSurface(app, true)
  const outputPath = path.join(screenshotRoot, name)
  const startedAt = Date.now()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: outputPath, scale: 'css' })
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
  writeProgress(`production composite screenshot ${JSON.stringify({ outputPath, elapsedMs: Date.now() - startedAt, viewport })}`)
  return outputPath
}

async function waitForExitModalReady(page, app, verifyPlaybackSurface = true) {
  if (verifyPlaybackSurface) {
    writeProgress('exit-modal MAIN verify integrated playback compositor')
    await waitForIntegratedPlaybackSurface(app)
    writeProgress('exit-modal MAIN integrated compositor verified')
  }
  writeProgress('exit-modal RENDERER wait visible, focus and layout')
  await page.waitForFunction(() => {
    const overlay = document.getElementById('standalone-exit-confirmation')
    const title = document.getElementById('exit-confirmation-title')
    const description = document.getElementById('exit-confirmation-description')
    const cancel = document.getElementById('exit-confirmation-cancel')
    const confirm = document.getElementById('exit-confirmation-confirm')
    if (!overlay || overlay.hidden || !title || !description || !cancel || !confirm) return false
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0
    }
    return document.activeElement === cancel && visible(title) && visible(description) && visible(cancel) && visible(confirm)
  })
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  writeProgress('exit-modal RENDERER ready')
}

async function captureExitModalState(page, screenshotRoot, name) {
  await waitForExitModalReady(page, undefined, false)
  const diagnostics = await page.evaluate(() => {
    const overlay = document.getElementById('standalone-exit-confirmation')
    const dialog = overlay?.querySelector('.exit-confirmation-dialog')
    const title = document.getElementById('exit-confirmation-title')
    const description = document.getElementById('exit-confirmation-description')
    const cancel = document.getElementById('exit-confirmation-cancel')
    const confirm = document.getElementById('exit-confirmation-confirm')
    const details = (element: HTMLElement | null) => {
      if (!element) return null
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return {
        text: element.innerText,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        color: style.color,
        backgroundColor: style.backgroundColor,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        centerElement: center?.id || center?.className || center?.tagName
      }
    }
    return {
      menuScreen: document.body.dataset.menuScreen,
      transitionPhase: document.body.dataset.transitionPhase,
      overlay: details(overlay),
      dialog: details(dialog as HTMLElement | null),
      title: details(title),
      description: details(description),
      cancel: details(cancel),
      confirm: details(confirm)
    }
  })
  writeProgress(`exit-modal visual ${name} ${JSON.stringify(diagnostics)}`)
  await page.screenshot({ path: path.join(screenshotRoot, `c9-production-exit-modal-${name}.png`) })
}

async function captureC10IdleState(page, screenshotRoot, name) {
  const visual = await page.evaluate(() => {
    const details = (selector: string) => {
      const element = document.querySelector(selector) as HTMLElement | null
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        text: element.innerText,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        transform: style.transform,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
    }
    const card = document.querySelector('.connection-card') as HTMLElement | null
    const cardRect = card?.getBoundingClientRect()
    return {
      disconnectedCard: card?.innerText,
      cardVisible: Boolean(card && !card.hidden && getComputedStyle(card).display !== 'none'),
      cardRect: cardRect ? { x: cardRect.x, y: cardRect.y, width: cardRect.width, height: cardRect.height } : null,
      disconnected: details('.connection-status span'),
      idle: details('.idle-status'),
      codeLabel: details('.code-card > .field-label'),
      metadataLabel: details('.metadata-field .field-label'),
      emptyMetadata: details('.metadata-value.empty'),
      codeDigits: details('#idle-code-digits')
    }
  })
  writeProgress(`C10.1 visual ${name} ${JSON.stringify(visual)}`)
  assert.equal(visual.cardVisible, true, `A caixa Desconectado deve permanecer visível em ${name}.`)
  assert.match(visual.disconnectedCard, /DESCONECTADO[\s\S]*Sem controlador remoto/)
  assert.equal(visual.disconnected.fontSize, '14px', 'O rótulo Desconectado aprovado usa 14 px.')
  assert.equal(visual.idle.fontSize, '14px', 'O rótulo do estado do Player aprovado usa 14 px.')
  assert.equal(visual.cardRect.width, 170, 'A caixa Desconectado mantém a largura aprovada de 170 px.')
  assert.ok(Math.abs(visual.disconnected.rect.y - visual.idle.rect.y) <= 1,
    'Desconectado e Livre/Iniciando devem começar alinhados.')
  assert.match(visual.codeLabel.transform, /matrix\(1, 0, 0, 1, 0, -3\)/,
    'Digite o número aplica o ajuste aprovado de 3 px para cima.')
  assert.ok(Math.abs(visual.codeLabel.rect.y - visual.disconnected.rect.y) <= 5,
    'O rótulo da entrada permanece alinhado dentro da variação permitida pelo conteúdo inline.')
  assert.equal(visual.codeDigits.fontSize, '26px', 'A entrada ociosa usa o tamanho de dígitos do frame aprovado.')
  assert.ok(Math.abs(visual.metadataLabel.rect.y - visual.disconnected.rect.y) <= 1,
    'Música e Artista devem alinhar com os rótulos de status.')
  if (visual.emptyMetadata) {
    assert.match(visual.emptyMetadata.transform, /matrix\(1, 0, 0, 1, 0, 7\)/,
      'Metadados vazios aplicam o deslocamento aprovado de 7 px.')
  }
  await page.screenshot({ path: path.join(screenshotRoot, `c10.1-${name}-1280x800.png`) })
}

const responsiveViewportCases = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 }
]
const responsiveDprCases = [1, 1.25, 1.5, 1.75, 2]
const responsiveAuditMetrics = []
const responsiveCdpSessions = new WeakMap()

async function getResponsiveCdpSession(page) {
  let cdp = responsiveCdpSessions.get(page)
  if (!cdp) {
    cdp = await page.context().newCDPSession(page)
    responsiveCdpSessions.set(page, cdp)
  }
  return cdp
}

async function setProductionViewport(app, page, { width, height }) {
  if (process.platform === 'win32') {
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
      if (!win) throw new Error('A janela de produção Standalone não foi encontrada durante a auditoria responsiva.')
      if (win.isFullScreen()) win.setFullScreen(false)
    })
    const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio)
    const cdp = await getResponsiveCdpSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, screenWidth: width, screenHeight: height, deviceScaleFactor, mobile: false
    })
    await page.waitForFunction(dimensions => window.innerWidth === dimensions.width && window.innerHeight === dimensions.height,
      { width, height }, { timeout: 10000 })
    writeProgress(`C10.3 Windows Electron viewport emulation ${width}x${height} nativeDPR=${deviceScaleFactor}`)
    return
  }
  const actual = await app.evaluate(({ BrowserWindow }, dimensions) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!win) throw new Error('A janela de produção Standalone não foi encontrada durante a auditoria responsiva.')
    if (win.isFullScreen()) win.setFullScreen(false)
    win.setContentSize(dimensions.width, dimensions.height)
    const [contentWidth, contentHeight] = win.getContentSize()
    return { contentWidth, contentHeight }
  }, { width, height })
  assert.deepEqual(actual, { contentWidth: width, contentHeight: height },
    `BrowserWindow deve aceitar a resolução ${width}×${height}.`)
  await page.waitForFunction(dimensions => window.innerWidth === dimensions.width && window.innerHeight === dimensions.height,
    { width, height }, { timeout: 10000 })
}

async function captureResponsiveAuditState(page, screenshotRoot, name, auditPhase = 'before',
  { deferScreenshot = false, skipScreenshot = false } = {}) {
  const timeSensitive = name.includes('celebration')
  const screenshotPath = path.join(screenshotRoot, `c10.3-${auditPhase}-${name}.${timeSensitive ? 'jpg' : 'png'}`)
  const screenshotTask = !skipScreenshot && timeSensitive
    ? page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 78 })
    : undefined
  const metrics = await page.evaluate(stateName => {
    const componentSelectors = [
      '.entry-footer', '.entry-grid', '.connection-card', '.idle-card', '.code-card', '.metadata-card',
      '.queue-bar', '.queue-label', '.track-info', '.track-value', '.paused-status', '.resume-feedback',
      '.play-disc', '.menu-card', '.menu-option', '.commands-content', '.command-grid',
      '.command-card', '.exit-confirmation-dialog', '.countdown-content', '.countdown-ring', '.loading-card',
      '.celebration-content', '.options-library-panel', '.options-assets-grid', '.options-footer', '.catalog-dialog'
    ]
    const textSelectors = [
      '.connection-status span', '.idle-status', '.field-label', '.metadata-value', '.queue-code',
      '.menu-title', '.menu-description', '.exit-confirmation-copy h2', '.exit-confirmation-copy p',
      '.command-name', '.command-description', '.command-card kbd', '.countdown-kicker', '.countdown-number',
      '.loading-heading', '.loading-description', '.transition-track-title', '.transition-track-artist',
      '.celebration-message', '.celebration-subtitle', '.celebration-footer', '.status-text', '.options-heading h1',
      '.options-panel-title', '.options-path-text', '.options-action', '#options-catalog-dialog-title'
    ]
    const visible = element => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const rectangles = {}
    const clipped = []
    for (const selector of componentSelectors) {
      const elements = [...document.querySelectorAll(selector)].filter(visible)
      if (!elements.length) continue
      rectangles[selector] = elements.slice(0, 8).map(element => {
        const rect = element.getBoundingClientRect()
        const geometry = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) {
          clipped.push({ selector, text: element.innerText?.slice(0, 80) ?? '', ...geometry })
        }
        return geometry
      })
    }
    const textSizes = {}
    for (const selector of textSelectors) {
      const element = [...document.querySelectorAll(selector)].find(visible)
      if (element) textSizes[selector] = getComputedStyle(element).fontSize
    }
    return {
      state: stateName,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      document: { clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
      rectangles,
      textSizes,
      clipped
    }
  }, name)
  responsiveAuditMetrics.push(metrics)
  assert.ok(metrics.document.scrollWidth <= metrics.document.clientWidth,
    `${name}: a página não pode ter overflow horizontal.`)
  assert.ok(metrics.document.scrollHeight <= metrics.document.clientHeight,
    `${name}: a página não pode ter overflow vertical.`)
  assert.deepEqual(metrics.clipped, [], `${name}: componentes visíveis devem permanecer dentro da viewport.`)
  if (metrics.viewport.width >= 1920 && Object.keys(metrics.textSizes).length) {
    const smallestText = Math.min(...Object.values(metrics.textSizes).map(value => Number.parseFloat(value)))
    assert.ok(smallestText >= 14, `${name}: textos visíveis em telas grandes devem permanecer legíveis; menor=${smallestText}px.`)
  }
  writeProgress(`C10.3 audit ${name}: viewport=${metrics.viewport.width}x${metrics.viewport.height} DPR=${metrics.devicePixelRatio} overflow=${metrics.document.scrollWidth - metrics.document.clientWidth}x${metrics.document.scrollHeight - metrics.document.clientHeight} clipped=${metrics.clipped.length}`)
  if (!timeSensitive) await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))))
  if (skipScreenshot) {
    // A separately validated lifecycle screenshot captures this transient state.
  } else if (screenshotTask) {
    if (!deferScreenshot) await screenshotTask
  } else await page.screenshot({ path: screenshotPath })
  return deferScreenshot ? { metrics, screenshotTask } : metrics
}

async function auditResponsiveViewport(page, app, screenshotRoot, dimensions, auditPhase = 'before') {
  const suffix = `${dimensions.width}x${dimensions.height}`
  await setProductionViewport(app, page, dimensions)
  await captureResponsiveAuditState(page, screenshotRoot, `${suffix}-idle`, auditPhase)

  await page.keyboard.press('Escape')
  await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
  await captureResponsiveAuditState(page, screenshotRoot, `${suffix}-menu`, auditPhase)
  await page.locator('#menu-item-commands').click()
  await page.locator('#standalone-commands-screen').waitFor({ state: 'visible' })
  await captureResponsiveAuditState(page, screenshotRoot, `${suffix}-commands`, auditPhase)
  await page.keyboard.press('Escape')
  await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')

  await page.keyboard.press('Escape')
  await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
  await page.locator('#menu-item-options').click()
  await page.locator('#standalone-options-screen').waitFor({ state: 'visible' })
  await captureResponsiveAuditState(page, screenshotRoot, `${suffix}-options`, auditPhase)
  await page.keyboard.press('Escape')
  await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!win) throw new Error('A janela Standalone não foi encontrada para capturar o modal de saída.')
    win.close()
  })
  await page.locator('#standalone-exit-confirmation').waitFor({ state: 'visible' })
  await waitForExitModalReady(page, app)
  await captureResponsiveAuditState(page, screenshotRoot, `${suffix}-exit-modal`, auditPhase)
  await page.keyboard.press('Escape')
  await page.locator('#standalone-exit-confirmation').waitFor({ state: 'hidden' })
  if (await page.locator('#standalone-main-menu').isVisible()) await page.keyboard.press('Escape')
  await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
    snapshot.state.operationalState === 'idle' && snapshot.state.pending.length === 0,
  `A auditoria ${suffix} deve retornar ao estado idle sem alterar a sequência.`)
}

async function auditResponsiveDprs(page, app, screenshotRoot, auditPhase = 'before') {
  await setProductionViewport(app, page, { width: 1280, height: 800 })
  const cdp = await getResponsiveCdpSession(page)
  try {
    for (const dpr of responsiveDprCases) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280, height: 800, screenWidth: 1280, screenHeight: 800,
        deviceScaleFactor: dpr, mobile: false
      })
      await page.waitForFunction(scale => Math.abs(window.devicePixelRatio - scale) < 0.01 &&
        window.innerWidth === 1280 && window.innerHeight === 800, dpr, { timeout: 5000 })
      await captureResponsiveAuditState(page, screenshotRoot, `1280x800-dpr-${String(dpr).replace('.', '-')}-idle`, auditPhase)
    }
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  }
  await setProductionViewport(app, page, { width: 1280, height: 800 })
}

async function auditResponsiveFullscreen(page, app, screenshotRoot, auditPhase = 'before') {
  if (process.platform === 'win32') {
    const cdp = await getResponsiveCdpSession(page)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
  }
  const display = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!win) throw new Error('A janela Standalone não foi encontrada para a auditoria fullscreen.')
    win.setFullScreen(true)
    const primary = screen.getPrimaryDisplay()
    const [contentWidth, contentHeight] = win.getContentSize()
    return {
      fullScreen: win.isFullScreen(), contentWidth, contentHeight,
      scaleFactor: primary.scaleFactor, bounds: primary.bounds, workArea: primary.workArea
    }
  })
  await page.waitForFunction(dimensions => window.innerWidth === dimensions.width && window.innerHeight === dimensions.height,
    { width: display.contentWidth, height: display.contentHeight }, { timeout: 10000 })
  writeProgress(`C10.3 fullscreen display ${JSON.stringify(display)}`)
  await captureResponsiveAuditState(page, screenshotRoot,
    `fullscreen-${display.contentWidth}x${display.contentHeight}-os-scale-${display.scaleFactor}`, auditPhase)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (win?.isFullScreen()) win.setFullScreen(false)
  })
  await setProductionViewport(app, page, { width: 1280, height: 800 })
}

async function waitForPlaybackHostTime(app, minimumTime, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    state = await playbackHostState(app)
    if (state?.currentTime > minimumTime) return state
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`O vídeo real deveria continuar avançando; estado=${JSON.stringify(state)}`)
}

function findLinuxNativeExitDialog() {
  if (process.platform !== 'linux') return undefined
  const tree = execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8' })
  const match = tree.match(/\s+(0x[0-9a-f]+)\s+"Karaoke Queue":/i)
  return match?.[1]
}

async function waitForLinuxNativeExitDialog(present, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let dialogId
  while (Date.now() < deadline) {
    dialogId = findLinuxNativeExitDialog()
    if (Boolean(dialogId) === present) return dialogId
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`O diálogo nativo GTK deveria estar ${present ? 'aberto' : 'fechado'}; janela=${dialogId ?? 'ausente'}`)
}

function sendLinuxNativeKeys(...keys) {
  if (process.platform !== 'linux') throw new Error('A automação de teclado X11 só é válida no Linux.')
  const python = [
    'import ctypes, ctypes.util, sys',
    'x11 = ctypes.CDLL(ctypes.util.find_library("X11"))',
    'xtst = ctypes.CDLL(ctypes.util.find_library("Xtst"))',
    'x11.XOpenDisplay.restype = ctypes.c_void_p',
    'x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]',
    'x11.XKeysymToKeycode.restype = ctypes.c_uint',
    'xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]',
    'display = x11.XOpenDisplay(None)',
    'assert display, "XOpenDisplay failed"',
    'keysyms = {"Escape": 0xff1b, "Tab": 0xff09, "Return": 0xff0d}',
    'for name in sys.argv[1:]:',
    '    code = x11.XKeysymToKeycode(display, keysyms[name])',
    '    assert code, "XKeysymToKeycode failed: " + name',
    '    for pressed in (1, 0):',
    '        assert xtst.XTestFakeKeyEvent(display, code, pressed, 0), "XTestFakeKeyEvent failed"',
    '    x11.XFlush(display)',
    'x11.XCloseDisplay(display)'
  ].join('\n')
  const result = spawnSync('python3', ['-c', python, ...keys], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`Não foi possível automatizar o diálogo nativo X11: ${result.stderr || result.error || result.status}`)
  }
}

async function respondToWindowsNativeExitDialog(app, buttonText, timeoutMs = 10000) {
  if (process.platform !== 'win32') throw new Error('O fallback nativo desta validação é específico do Windows.')
  const target = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!win || win.isDestroyed()) throw new Error('A janela principal Standalone não está disponível para validar a caixa nativa.')
    return { hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(16), pid: process.pid }
  })
  const nativeDialog = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class KqNativeDialog {
  public delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetClassNameW")] public static extern int GetClassName(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="GetWindowTextW")] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  static string ReadText(IntPtr handle, bool className) {
    var text = new StringBuilder(512);
    if (className) GetClassName(handle, text, text.Capacity); else GetWindowText(handle, text, text.Capacity);
    return text.ToString();
  }
  public static IntPtr FindExitDialog(uint expectedPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((handle, parameter) => {
      uint pid; GetWindowThreadProcessId(handle, out pid);
      if (pid == expectedPid && IsWindowVisible(handle) && ReadText(handle, true) == "#32770" && ReadText(handle, false) == "Karaoke Queue") {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr GetOwner(IntPtr dialog) { return GetWindow(dialog, 4); }
  public static IntPtr FindButton(IntPtr dialog, string expectedText) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (handle, parameter) => {
      if (ReadText(handle, true) == "Button" && ReadText(handle, false).Replace("&", "").Trim().Equals(expectedText, StringComparison.OrdinalIgnoreCase)) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
`
  const escapedButton = buttonText.replaceAll("'", "''")
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$targetPid = ' + String(target.pid),
    '$expectedOwner = [IntPtr]([Convert]::ToInt64("' + target.hwnd + '", 16))',
    "$buttonText = '" + escapedButton + "'",
    'Add-Type -TypeDefinition @\'' + nativeDialog + "'@",
    '$deadline = [DateTime]::UtcNow.AddMilliseconds(' + String(timeoutMs) + ')',
    '$dialog = [IntPtr]::Zero',
    'while ($dialog -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) { $dialog = [KqNativeDialog]::FindExitDialog([uint32]$targetPid); if ($dialog -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 25 } }',
    'if ($dialog -eq [IntPtr]::Zero) { throw "A caixa nativa Karaoke Queue não apareceu para o processo esperado." }',
    '$owner = [KqNativeDialog]::GetOwner($dialog)',
    'if ($owner -eq [IntPtr]::Zero -or $owner -ne $expectedOwner) { throw "A caixa de diálogo nativa não pertence à BrowserWindow Standalone esperada." }',
    '$button = [KqNativeDialog]::FindButton($dialog, $buttonText)',
    'if ($button -eq [IntPtr]::Zero) { throw "O botão nativo solicitado não existe: $buttonText" }',
    'if (-not [KqNativeDialog]::PostMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) { throw ("BM_CLICK falhou; erro=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }',
    '$closeDeadline = [DateTime]::UtcNow.AddMilliseconds(' + String(timeoutMs) + ')',
    'while ([KqNativeDialog]::FindExitDialog([uint32]$targetPid) -ne [IntPtr]::Zero -and [DateTime]::UtcNow -lt $closeDeadline) { Start-Sleep -Milliseconds 25 }',
    'if ([KqNativeDialog]::FindExitDialog([uint32]$targetPid) -ne [IntPtr]::Zero) { throw "A caixa nativa não fechou após ativar o botão: $buttonText" }',
    'Write-Output ("NATIVE_MESSAGEBOX_BUTTON_CONFIRMED text=" + $buttonText + " processId=" + $targetPid)'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', command], {
    encoding: 'utf8', timeout: timeoutMs + 5000, shell: false, windowsHide: true
  })
  writeProgress(`native-messagebox button=${buttonText} exit=${result.status} stdout=${result.stdout?.trim() ?? ''}`)
  if (result.error || result.status !== 0) {
    throw new Error(`Não foi possível interagir com o diálogo nativo Windows: ${result.stderr || result.error || result.status}`)
  }
}

async function sendWindowsNativeAltF4(app) {
  if (process.platform !== 'win32') throw new Error('Alt+F4 nativo só pode ser enviado no Windows.')
  const target = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!win || win.isDestroyed()) throw new Error('A janela principal Standalone não está disponível para Alt+F4.')
    win.show()
    win.focus()
    return { hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(16), pid: process.pid }
  })
  const nativeInput = String.raw`
using System;
using System.Runtime.InteropServices;
public static class KqNativeInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachState);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetActiveWindow(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetFocus(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static uint SendAltF4() {
    INPUT[] inputs = new INPUT[4];
    inputs[0].type = 1; inputs[0].data.ki.wVk = 0x12;
    inputs[1].type = 1; inputs[1].data.ki.wVk = 0x73;
    inputs[2].type = 1; inputs[2].data.ki.wVk = 0x73; inputs[2].data.ki.dwFlags = 2;
    inputs[3].type = 1; inputs[3].data.ki.wVk = 0x12; inputs[3].data.ki.dwFlags = 2;
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new InvalidOperationException("SendInput aceitou " + sent + " de " + inputs.Length + " eventos; erro=" + Marshal.GetLastWin32Error());
    return sent;
  }
}
`
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$targetPid = ' + String(target.pid),
    '$targetHandle = [IntPtr]([Convert]::ToInt64("' + target.hwnd + '", 16))',
    'Add-Type -TypeDefinition @\'' + nativeInput + "'@",
    '$null = Get-Process -Id $targetPid -ErrorAction Stop',
    'if ($targetHandle -eq [IntPtr]::Zero) { throw "A janela nativa Electron não tem HWND." }',
    '[uint32]$windowPid = 0',
    '[void][KqNativeInput]::GetWindowThreadProcessId($targetHandle, [ref]$windowPid)',
    'if ($windowPid -ne $targetPid) { throw "O HWND não pertence ao processo Electron esperado." }',
    '$foreground = [KqNativeInput]::GetForegroundWindow()',
    '[uint32]$foregroundPid = 0',
    '$foregroundThread = [KqNativeInput]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)',
    '$targetThread = [KqNativeInput]::GetWindowThreadProcessId($targetHandle, [ref]$windowPid)',
    '$currentThread = [KqNativeInput]::GetCurrentThreadId()',
    '$attachedForeground = $false; $attachedTarget = $false',
    '$focusRequested = $false',
    'try {',
    '  if ($foregroundThread -and $foregroundThread -ne $currentThread -and $foregroundThread -ne $targetThread) { $attachedForeground = [KqNativeInput]::AttachThreadInput($currentThread, $foregroundThread, $true) }',
    '  if ($targetThread -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) { $attachedTarget = [KqNativeInput]::AttachThreadInput($currentThread, $targetThread, $true) }',
    '  [void][KqNativeInput]::ShowWindow($targetHandle, 5)',
    '  [void][KqNativeInput]::BringWindowToTop($targetHandle)',
    '  $focusRequested = [KqNativeInput]::SetForegroundWindow($targetHandle)',
    '  [void][KqNativeInput]::SetActiveWindow($targetHandle)',
    '  [void][KqNativeInput]::SetFocus($targetHandle)',
    '  $foreground = [KqNativeInput]::GetForegroundWindow()',
    '  [void][KqNativeInput]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)',
    '  if ($foreground -ne $targetHandle -or $foregroundPid -ne $targetPid) { throw ("A janela Electron não recebeu o foco nativo; foreground=" + $foreground + " foregroundPid=" + $foregroundPid + " target=" + $targetHandle + " targetPid=" + $targetPid + " SetForegroundWindow=" + $focusRequested + " attachedForeground=" + $attachedForeground + " attachedTarget=" + $attachedTarget) }',
    '  $sent = [KqNativeInput]::SendAltF4()',
    '  Write-Output ("ALT_F4_SENDINPUT_PASS events=" + $sent + " targetPid=" + $targetPid + " focusRequested=" + $focusRequested)',
    '} finally {',
    '  if ($attachedTarget) { [void][KqNativeInput]::AttachThreadInput($currentThread, $targetThread, $false) }',
    '  if ($attachedForeground) { [void][KqNativeInput]::AttachThreadInput($currentThread, $foregroundThread, $false) }',
    '}'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', command], {
    encoding: 'utf8', timeout: 10000, shell: false, windowsHide: true
  })
  writeProgress(`alt-f4 helper exit=${result.status} error=${result.error?.message ?? 'none'} stdout=${result.stdout?.trim() ?? ''}`)
  if (result.error || result.status !== 0) {
    throw new Error(`Não foi possível enviar Alt+F4 nativo para o Electron: ${result.stderr || result.error || result.status}`)
  }
}

async function sendWindowsNativeF11(app, requestFocus = false) {
  if (process.platform !== 'win32') throw new Error('F11 físico só pode ser enviado no Windows.')
  const target = await app.evaluate(({ BrowserWindow }, shouldFocus) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!win || win.isDestroyed()) throw new Error('A janela Standalone não está disponível para F11 nativo.')
    if (shouldFocus) { win.show(); win.focus() }
    return { hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(16), pid: process.pid }
  }, requestFocus)
  const nativeF11 = String.raw`
using System;
using System.Runtime.InteropServices;
public static class KqNativeF11 {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachState);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetActiveWindow(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetFocus(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static uint SendF11() {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 1; inputs[0].data.ki.wVk = 0x7A;
    inputs[1].type = 1; inputs[1].data.ki.wVk = 0x7A; inputs[1].data.ki.dwFlags = 2;
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new InvalidOperationException("SendInput aceitou " + sent + " de " + inputs.Length + " eventos; erro=" + Marshal.GetLastWin32Error());
    return sent;
  }
}

`
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$targetPid = ' + String(target.pid),
    '$targetHandle = [IntPtr]([Convert]::ToInt64("' + target.hwnd + '", 16))',
    '$requestFocus = $' + (requestFocus ? 'true' : 'false'),
    'Add-Type -TypeDefinition @\'' + nativeF11 + "'@",
    '[uint32]$foregroundPid = 0',
    '$foreground = [KqNativeF11]::GetForegroundWindow()',
    '$foregroundThread = [KqNativeF11]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)',
    '[uint32]$targetPidFromHandle = 0',
    '$targetThread = [KqNativeF11]::GetWindowThreadProcessId($targetHandle, [ref]$targetPidFromHandle)',
    '$currentThread = [KqNativeF11]::GetCurrentThreadId()',
    '$attachedForeground = $false; $attachedTarget = $false; $focusRequested = $false',
    'try {',
    '  if ($targetHandle -eq [IntPtr]::Zero -or $targetPidFromHandle -ne $targetPid) { throw "O HWND F11 não pertence ao Electron Standalone esperado." }',
    '  if ($requestFocus) {',
    '    if ($foregroundThread -and $foregroundThread -ne $currentThread -and $foregroundThread -ne $targetThread) { $attachedForeground = [KqNativeF11]::AttachThreadInput($currentThread, $foregroundThread, $true) }',
    '    if ($targetThread -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) { $attachedTarget = [KqNativeF11]::AttachThreadInput($currentThread, $targetThread, $true) }',
    '    [void][KqNativeF11]::ShowWindow($targetHandle, 5)',
    '    [void][KqNativeF11]::BringWindowToTop($targetHandle)',
    '    $focusRequested = [KqNativeF11]::SetForegroundWindow($targetHandle)',
    '    [void][KqNativeF11]::SetActiveWindow($targetHandle)',
    '    [void][KqNativeF11]::SetFocus($targetHandle)',
    '  }',
    '  $foreground = [KqNativeF11]::GetForegroundWindow()',
    '  [void][KqNativeF11]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)',
    '  if ($foreground -ne $targetHandle -or $foregroundPid -ne $targetPid) {',
    '    Write-Output ("F11_NATIVE_NOT_FOREGROUND foreground=" + $foreground + " pid=" + $foregroundPid + " target=" + $targetHandle + " pid=" + $targetPid + " focusRequested=" + $focusRequested)',
    '  } else {',
    '    $sent = [KqNativeF11]::SendF11()',
    '    Write-Output ("F11_SENDINPUT_PASS events=" + $sent + " targetPid=" + $targetPid + " focusRequested=" + $focusRequested)',
    '  }',
    '} finally {',
    '  if ($attachedTarget) { [void][KqNativeF11]::AttachThreadInput($currentThread, $targetThread, $false) }',
    '  if ($attachedForeground) { [void][KqNativeF11]::AttachThreadInput($currentThread, $foregroundThread, $false) }',
    '}'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', command], {
    encoding: 'utf8', timeout: 10000, shell: false, windowsHide: true
  })
  writeProgress(`f11 native focusRequested=${requestFocus} exit=${result.status} stdout=${result.stdout?.trim() ?? ''}`)
  if (result.error || result.status !== 0) {
    throw new Error(`Não foi possível enviar F11 físico sem ocultar perda de foco: ${result.stderr || result.error || result.status}`)
  }
  return result.stdout?.includes('F11_SENDINPUT_PASS') === true
}

async function waitForWindowsNativeF11Event(page, previousCount) {
  try {
    await page.waitForFunction(count => window.__f11Trace?.length > count, previousCount, { timeout: 2000 })
    return true
  } catch (error) {
    if (error?.name === 'TimeoutError') return false
    throw error
  }
}

async function sendWindowsNativeCloseCommand(app) {
  const target = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!win || win.isDestroyed()) throw new Error('A janela principal Standalone não está disponível para SC_CLOSE.')
    return { hwnd: win.getNativeWindowHandle().readBigUInt64LE(0).toString(16), pid: process.pid }
  })
  const nativeClose = String.raw`
using System;
using System.Runtime.InteropServices;
public static class KqNativeClose {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
}
`
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$targetPid = ' + String(target.pid),
    '$targetHandle = [IntPtr]([Convert]::ToInt64("' + target.hwnd + '", 16))',
    'Add-Type -TypeDefinition @\'' + nativeClose + "'@",
    '[uint32]$windowPid = 0',
    '[void][KqNativeClose]::GetWindowThreadProcessId($targetHandle, [ref]$windowPid)',
    'if ($targetHandle -eq [IntPtr]::Zero -or $windowPid -ne $targetPid) { throw "O HWND SC_CLOSE não pertence ao Electron Standalone esperado." }',
    '$posted = [KqNativeClose]::PostMessage($targetHandle, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero)',
    'if (-not $posted) { throw ("PostMessage SC_CLOSE falhou; erro=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }',
    'Write-Output ("NATIVE_SC_CLOSE_POSTED targetPid=" + $targetPid)'
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', command], {
    encoding: 'utf8', timeout: 10000, shell: false, windowsHide: true
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Não foi possível enviar WM_SYSCOMMAND/SC_CLOSE à janela Electron: ${result.stderr || result.error || result.status}`)
  }
  writeProgress(`native-sc-close helper exit=${result.status} stdout=${result.stdout?.trim() ?? ''}`)
}

async function waitForWindowsNativeCloseEvent(app, timeoutMs = 1500) {
  return app.evaluate(({ BrowserWindow }, timeout) => new Promise(resolve => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
    if (!win || win.__nativeCloseEventCount > 0) return resolve(win?.__nativeCloseEventCount ?? 0)
    const timer = setTimeout(() => resolve(win.__nativeCloseEventCount), timeout)
    win.once('close', () => {
      clearTimeout(timer)
      resolve(win.__nativeCloseEventCount)
    })
  }), timeoutMs)
}

async function waitForRecoveryRecord(recoveryPath, predicate, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    try { latest = JSON.parse(fs.readFileSync(recoveryPath, 'utf8')) }
    catch { latest = undefined }
    if (latest && predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`${message}; registro=${JSON.stringify(latest)}`)
}

function readF0LogRecords(logPath) {
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

async function waitForF0LogRecord(logPath, event, runId, occurrence = 1, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const matches = readF0LogRecords(logPath).filter(record =>
      record.event === event && (!runId || record.details?.runId === runId))
    if (matches.length >= occurrence) return matches[occurrence - 1]
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Evento diagnóstico ${event} não concluído dentro do limite; ocorrência=${occurrence}.`)
}

function millisecondsFromLaunch(launchStartedAtMs, record) {
  const occurredAt = Date.parse(record?.timestamp ?? '')
  return Number.isFinite(occurredAt) ? Math.max(0, occurredAt - launchStartedAtMs) : null
}

async function run() {
  const f0RealLibrary = process.env.KQ_F0_REAL_LIBRARY === '1'
  const f0T2T4 = f0RealLibrary && process.env.KQ_F0_T2T4 === '1'
  const f0ResumeIndex = f0T2T4 && process.env.KQ_F0_RESUME_INDEX === '1'
  const reportDirectory = process.env.KQ_F0_REPORT_DIR ? path.resolve(process.env.KQ_F0_REPORT_DIR) : undefined
  const f0StartupOnly = process.env.KQ_F0_STARTUP_ONLY === '1' && !f0RealLibrary
  const f0SeedPausedRecovery = f0StartupOnly && process.env.KQ_F0_SEED_PAUSED_RECOVERY === '1'
  const profileRoot = makeProfileRoot()
  if (f0RealLibrary) {
    const configuredRoot = process.env.KQ_F0_LIBRARY_ROOT
    if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
      throw new Error('O modo F0 real requer uma raiz Windows absoluta em KQ_F0_LIBRARY_ROOT.')
    }
    mediaRoot = path.resolve(configuredRoot)
    if (!fs.statSync(mediaRoot).isDirectory()) throw new Error('A raiz F0 real precisa estar acessível.')
    if (f0T2T4 && (!reportDirectory || !path.isAbsolute(reportDirectory))) {
      throw new Error('A campanha T2/T4 requer KQ_F0_REPORT_DIR persistente no disco interno.')
    }
    if (path.parse(profileRoot).root.toLowerCase() === path.parse(mediaRoot).root.toLowerCase()) {
      throw new Error('O perfil F0 deve ficar em uma unidade interna diferente da biblioteca externa.')
    }
  } else if (f0StartupOnly || process.env.KQ_F0_BOOTSTRAP_CASE) {
    mediaRoot = path.join(profileRoot, 'f0-empty-media-fixture')
    fs.mkdirSync(mediaRoot)
    fs.writeFileSync(path.join(mediaRoot, '01001.mp4'), '')
  } else if (!mediaRoot || !fs.statSync(mediaRoot).isDirectory()) {
    throw new Error('Defina KQ_PLAYER_TEST_MEDIA_DIR para uma biblioteca local com 01001.mp4 real.')
  }
  if (!f0RealLibrary && !mediaCodes(mediaRoot).has('01001')) throw new Error('A biblioteca de teste precisa conter 01001.mp4.')

  if (f0T2T4 && !f0ResumeIndex) fs.mkdirSync(reportDirectory, { recursive: false })
  if (f0ResumeIndex && (!fs.existsSync(reportDirectory) || !fs.existsSync(path.join(reportDirectory, 'scenarios.jsonl')))) {
    throw new Error('A retomada T2/T4 requer o relatório progressivo anterior.')
  }
  const evidencePath = f0T2T4 ? path.join(reportDirectory, 'scenarios.jsonl') : undefined
  const recordEvidence = (scenario, status, details) => {
    if (!evidencePath) return
    const record = { at: new Date().toISOString(), scenario, status, details }
    const fd = fs.openSync(evidencePath, 'a')
    try { fs.writeSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  if (f0T2T4) {
    activeF0EvidenceWriter = recordEvidence
    recordEvidence('campaign', 'RUNNING', {
      platform: process.platform, architecture: process.arch, node: process.versions.node,
      snapshotHead: process.env.KQ_F0_SNAPSHOT_HEAD ?? 'NOT_PROVIDED',
      snapshotFingerprint: process.env.KQ_F0_SNAPSHOT_FINGERPRINT ?? 'NOT_PROVIDED',
      mediaVolumeFileSystem: 'NTFS (verified before campaign)', mediaAccess: 'read-only by harness contract',
      profileDrive: path.parse(profileRoot).root.slice(0, 2), libraryDrive: path.parse(mediaRoot).root.slice(0, 2)
    })
  }
  const progressPath = path.join(profileRoot, 'c9-progress.log')
  progressSink = message => fs.appendFileSync(progressPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
  const userData = path.join(profileRoot, 'user-data')
  const configRoot = path.join(profileRoot, 'config')
  const cacheRoot = path.join(profileRoot, 'cache')
  const dataRoot = path.join(profileRoot, 'data')
  const screenshotRoot = process.env.KQ_PLAYER_SCREENSHOT_DIR
    ? path.resolve(process.env.KQ_PLAYER_SCREENSHOT_DIR)
    : path.join(os.tmpdir(), `karaoke-queue-standalone-production-screenshots-${process.pid}`)
  fs.mkdirSync(userData, { recursive: true })
  if (!f0StartupOnly && !f0RealLibrary) fs.mkdirSync(screenshotRoot, { recursive: true })
  if (f0ResumeIndex) {
    const modePath = path.join(userData, 'operating-mode.json')
    const libraryPath = path.join(userData, 'video-library.json')
    const catalogPath = path.join(userData, 'player-music-catalog.sqlite')
    const indexPath = path.join(userData, 'video-library-index.json')
    if (![modePath, libraryPath, catalogPath, indexPath].every(file => fs.existsSync(file))) {
      throw new Error('A retomada T2/T4 não encontrou configuração, catálogo e índice persistente completos.')
    }
    const mode = JSON.parse(fs.readFileSync(modePath, 'utf8'))
    const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
    assert.equal(mode.mode, 'player', 'O perfil reutilizado deve permanecer em modo Standalone.')
    assert.deepEqual(library.roots.map(root => path.resolve(root)), [path.resolve(mediaRoot)],
      'A raiz configurada no perfil deve corresponder exatamente à unidade autorizada.')
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    assert.ok(index.version >= 1 && Array.isArray(index.roots) && index.roots.length > 0,
      'O índice persistente existente precisa ter estrutura versionada válida.')
  } else {
    fs.writeFileSync(path.join(userData, 'operating-mode.json'), JSON.stringify({ version: 1, mode: 'player' }))
    fs.writeFileSync(path.join(userData, 'video-library.json'), JSON.stringify({ version: 1, roots: [path.resolve(mediaRoot)] }))
    await seedCatalogDatabase(userData)
  }
  if (process.env.KQ_F0_BOOTSTRAP_CASE === 'cached-ready') {
    const { VideoLibraryService } = require(path.join(projectRoot, 'build/src/video-library-service'))
    const { VideoLibraryIndexStore } = require(path.join(projectRoot, 'build/src/video-library-index-store'))
    const library = new VideoLibraryService([mediaRoot], { indexStore: new VideoLibraryIndexStore(userData) })
    await library.refresh()
    library.close()
  }
  const inheritedStatus = process.env.KQ_F0_RECOVERY_STATUS
  if (inheritedStatus) {
    const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build', 'src', 'player-playback-recovery-store.js'))
    if (inheritedStatus === 'invalid') fs.writeFileSync(path.join(userData, 'player-playback-recovery.json'), '{incomplete')
    else {
      const variants = { paused: ['paused', 'playback-paused'], playing: ['playing', 'playback-started'],
        pending: ['loading', 'load-intent'], uncertain: ['uncertain', 'playback-uncertain'] }
      const variant = variants[inheritedStatus]
      assert.ok(variant, 'Unsupported isolated recovery fixture')
      const updatedAt = new Date().toISOString()
      new PlayerPlaybackRecoveryStore(userData).write({ version: 1, revision: 1, status: inheritedStatus,
        attemptId: crypto.randomUUID(), musicCode: '01001', playbackStatus: variant[0],
        lastTransition: variant[1], updatedAt, startedAt: updatedAt })
    }
  }


  let mainEvaluationSequence = 0
  const launch = async (diagnostics, preserveFullscreen = false) => {
    const launchStartedAtMs = Date.now()
    const launchStartedAt = performance.now()
    const launched = await electron.launch({
      executablePath: require('electron'),
      args: [process.env.KQ_F0_BOOTSTRAP_CASE ? path.join(__dirname, 'f0-production-bootstrap-entry.js') : projectRoot, `--user-data-dir=${userData}`],
      env: { ...process.env, ...(diagnostics === undefined ? {} : { KQ_F0_DIAGNOSTICS: diagnostics ? '1' : '0' }),
        XDG_CONFIG_HOME: configRoot, XDG_CACHE_HOME: cacheRoot, XDG_DATA_HOME: dataRoot },
      timeout: 30000
    })
    const evaluateMain = launched.evaluate.bind(launched)
    launched.evaluate = (...args) => {
      const id = ++mainEvaluationSequence
      writeProgress(`main-eval-${id} START`)
      return evaluateMain(...args).then(value => {
        writeProgress(`main-eval-${id} PASS`)
        return value
      }, error => {
        writeProgress(`main-eval-${id} FAIL ${String(error)}`)
        throw error
      })
    }
    await waitForStandaloneWindow(launched)
    const pageAvailableAt = performance.now()
    await waitForFullScreen(launched, true)
    if (!preserveFullscreen) {
      // Startup is proved above; visual/F11 scenarios deliberately begin windowed.
      await launched.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false))
      await waitForFullScreen(launched, false)
    }
    launched.__f0Launch = {
      launchStartedAtMs,
      launchStartedAtPerf: launchStartedAt,
      elapsedToWindowPageMs: Math.max(0, pageAvailableAt - launchStartedAt)
    }
    return launched
  }

  let app
  let page
  try {
    app = await launch(f0StartupOnly ? false : true, f0RealLibrary)
    page = await waitForStandaloneWindow(app)
    await page.waitForFunction(() => window.standalonePlayer?.getSnapshot)
    if (process.env.KQ_F0_BOOTSTRAP_CASE) {
      const { validateBootstrapBarrier } = require('./f0-production-validation')
      await validateBootstrapBarrier({ app, page, userData, waitForSnapshot, waitForF0LogRecord,
        scenario: process.env.KQ_F0_BOOTSTRAP_CASE })
      app = undefined
      page = undefined
      return
    }
    await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'idle',
      'O app real deve iniciar em idle sem autorreprodução.')
    if (inheritedStatus) {
      const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build', 'src', 'player-playback-recovery-store.js'))
      const resolved = new PlayerPlaybackRecoveryStore(userData).read()
      assert.equal(resolved?.status, inheritedStatus === 'invalid' ? 'idle' : 'dismissed',
        'Main must durably resolve inherited recovery before publishing operational idle')
    }
    const startupLogPath = path.join(userData, 'logs', 'app.log')
    if (!f0StartupOnly) {
    const usable = await waitForF0LogRecord(startupLogPath, 'F0_STARTUP_USABLE_METRICS')
    assert.equal(usable.details.entriesEnumerated, 0, 'Production Main must not enumerate before operational readiness')
    assert.equal(usable.details.fileOpens, 0, 'Production Main must not open candidates before operational readiness')
    const admitted = await waitForF0LogRecord(startupLogPath, 'F0_LIBRARY_RECONCILIATION_ADMITTED', usable.details.runId)
    assert.ok(admitted.details.elapsedMs >= usable.details.elapsedMs)
    }
    if (process.env.KQ_F0_STRUCTURAL_ONLY === '1') {
      const { validateStructuralPlayback } = require('./f0-production-validation')
      await validateStructuralPlayback({ app, page, projectRoot, mediaRoot, logPath: startupLogPath,
        waitForSnapshot, waitForF0LogRecord })
      const exit = waitForNativeClose(page, app)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
      await waitForExitModalReady(page, app, false)
      await page.keyboard.press('Enter').catch(error => {
        if (!/page, context or browser has been closed/i.test(String(error))) throw error
      })
      assert.equal((await exit).code, 0)
      app = undefined
      page = undefined
      process.stdout.write('PASS F0 structural Main: gated startup, concurrent scan/playback, correlated media, Stop resource release and new attempt.\n')
      return
    }
    if (process.env.KQ_F0_RECOVERY_ONLY === '1') {
      assert.ok(inheritedStatus, 'Focused recovery requires an explicit inherited fixture')
      const refreshIdle = await page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())
      assert.equal(refreshIdle.outcome, 'confirmed', 'Recovered operational idle permits refresh')
      const prior = JSON.parse(fs.readFileSync(path.join(userData, 'player-playback-recovery.json'), 'utf8'))
      for (const digit of '1001') await page.keyboard.press(digit)
      await page.keyboard.press('Enter')
      const playing = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01001',
        'Recovered Main must admit a new correlated playback attempt')
      assert.notEqual(playing.state.current.attemptId, prior.attemptId)
      await page.waitForFunction(() => {
        const video = document.querySelector('#playback-media-layer video')
        return video && !video.paused && video.readyState >= 2 && video.currentTime >= 0.25
      })
      const activeRefresh = await page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())
      assert.equal(activeRefresh.outcome, 'blocked')
      assert.equal(activeRefresh.code, 'PLAYER_NOT_IDLE')
      await page.keyboard.press('Control+Space')
      await page.locator('#standalone-stop-confirmation').waitFor({ state: 'visible' })
      await page.locator('#stop-confirmation-confirm').click()
      await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'idle', 'Confirmed containment must restore operational idle')
      assert.equal((await page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())).outcome, 'confirmed')
      const exit = waitForNativeClose(page, app)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
      await waitForExitModalReady(page, app, false)
      await page.keyboard.press('Enter').catch(error => {
        if (!/page, context or browser has been closed/i.test(String(error))) throw error
      })
      const result = await exit
      assert.equal(result.code, 0)
      assert.equal(result.signal, null)
      app = undefined
      page = undefined
      process.stdout.write('PASS F0 recovery Main: durable resolution, new real playback, idle/active refresh guards, confirmed stop and shutdown.\n')
      return
    }
    if (f0RealLibrary) {
      activeF0EvidenceStage = 'prepare-index-once'
      const runtimeVersions = await app.evaluate(() => ({
        electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node
      }))
      if (f0T2T4) {
        recordEvidence('runtime', 'PASS', {
          platform: process.platform, architecture: process.arch, electron: runtimeVersions.electron,
          chromium: runtimeVersions.chromium, node: runtimeVersions.node, cpuCount: os.cpus().length,
          totalMemoryBytes: os.totalmem()
        })
      }
      const logPath = path.join(userData, 'logs', 'app.log')
      if (f0T2T4) activeF0LogPath = logPath
      const firstLaunch = app.__f0Launch
      const recordsBeforeT2 = f0ResumeIndex ? readF0LogRecords(logPath) : undefined
      const firstMainReady = f0ResumeIndex
        ? recordsBeforeT2.find(record => record.event === 'F0_MAIN_READY_METRICS' &&
          recordsBeforeT2.some(candidate => candidate.event === 'F0_LIBRARY_INDEX_LOAD_METRICS' &&
            candidate.details?.runId === record.details.runId && candidate.details?.cacheStatus === 'missing'))
        : await waitForF0LogRecord(logPath, 'F0_MAIN_READY_METRICS')
      assert.ok(firstMainReady, 'A evidência T1 da primeira indexação precisa permanecer no log do perfil temporário.')
      const firstRunId = firstMainReady.details.runId
      const firstWindowReady = await waitForF0LogRecord(logPath, 'F0_WINDOW_READY_METRICS', firstRunId)
      const firstStartupUsable = await waitForF0LogRecord(logPath, 'F0_STARTUP_USABLE_METRICS', firstRunId)
      const firstIndexLoad = await waitForF0LogRecord(logPath, 'F0_LIBRARY_INDEX_LOAD_METRICS', firstRunId)
      const firstScanRecord = await waitForF0LogRecord(logPath, 'F0_LIBRARY_SCAN_METRICS', firstRunId)
      const firstScan = firstScanRecord.details
      assert.equal(firstIndexLoad.details.cacheStatus, 'missing', 'T1 precisa começar sem índice persistente.')
      assert.equal(firstWindowReady.details.windowVisible, true,
        'T1 precisa registrar que a janela estava visível no marco de prontidão.')
      assert.equal(firstScan.scanStatus, 'ready', 'T1 precisa concluir uma geração completa do inventário.')
      assert.ok(firstScan.indexedFiles > 0, 'A varredura real precisa indexar ao menos um candidato.')
      assert.ok(firstScan.availableCodes > 0, 'A biblioteca real precisa conter códigos disponíveis para playback.')
      assert.ok(firstStartupUsable.details.elapsedMs < firstScanRecord.details.elapsedMs,
        'T1 precisa demonstrar UI utilizável antes do fim da reconciliação completa.')
      const indexPath = path.join(userData, 'video-library-index.json')
      const firstIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      const firstIndexEntries = firstIndex.roots.reduce((total, root) => total + root.entries.length, 0)
      const firstIndexBytes = fs.statSync(indexPath).size
      const indexedCodes = firstIndex.roots.flatMap(root => root.entries.map(entry => entry.musicCode))
      const codeCounts = indexedCodes.reduce((counts, code) => counts.set(code, (counts.get(code) ?? 0) + 1), new Map())
      const firstIndexCodes = [...codeCounts].filter(([, count]) => count === 1).map(([code]) => code).sort()
      if (f0T2T4 && !firstIndexCodes.length) throw new Error('O índice real não contém códigos únicos elegíveis para T4.')
      const playbackCode = f0T2T4 ? firstIndexCodes[0] : '01001'
      const enteredPlaybackCode = String(Number(playbackCode))
      if (f0T2T4) {
        const selected = firstIndex.roots.flatMap(root => root.entries)
          .find(entry => entry.musicCode === playbackCode)
        assert.ok(selected, 'O código selecionado precisa corresponder a uma entrada persistida do índice.')
        recordEvidence('T4-index-selection', 'PASS', {
          selectedEntryCount: 1, codeUniqueInIndex: true, filenameRecorded: false,
          selectedSizeBytes: selected.size, selectedModifiedAtMs: selected.mtimeMs
        })
      }
      const firstEvidence = f0ResumeIndex
        ? fs.readFileSync(evidencePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
          .find(record => record.scenario === 'T2-profile-index-preparation-only')?.details
        : { elapsedToWindowReadyMs: millisecondsFromLaunch(firstLaunch.launchStartedAtMs, firstWindowReady),
          elapsedToMainUsableMs: millisecondsFromLaunch(firstLaunch.launchStartedAtMs, firstStartupUsable),
          harnessElapsedToWindowPageMs: firstLaunch.elapsedToWindowPageMs,
          indexStatus: firstIndexLoad.details.cacheStatus, scanDurationMs: firstScan.durationMs,
          indexedFiles: firstScan.indexedFiles, directoriesEnumerated: firstScan.directoriesEnumerated,
          entriesEnumerated: firstScan.entriesEnumerated, lstatCalls: firstScan.lstatCalls,
          statCalls: firstScan.statCalls, realpathCalls: firstScan.realpathCalls,
          filesOpened: firstScan.fileOpens, filesClosed: firstScan.fileCloses, bytesRead: firstScan.bytesRead,
          indexEntries: firstIndexEntries, indexBytes: firstIndexBytes }
      assert.ok(firstEvidence && firstEvidence.indexedFiles === firstScan.indexedFiles,
        'A retomada deve reutilizar a evidência original da única indexação inicial.')
      if (f0ResumeIndex) {
        recordEvidence('T2-profile-index-preparation-reused', 'PASS', {
          indexedFiles: firstEvidence.indexedFiles, indexBytes: firstEvidence.indexBytes,
          generation: firstIndex.generation, initialScanRepeated: false
        })
      } else {
        recordEvidence('T2-profile-index-preparation-only', 'PASS', firstEvidence)
        process.stdout.write(`F0_T2_PROFILE_PREPARATION ${JSON.stringify(firstEvidence)}\n`)
      }
      assert.equal(firstIndexEntries, firstScan.indexedFiles,
        'O índice persistido deve corresponder ao inventário completo do primeiro scan.')

      const closeNormally = async () => {
        const exit = waitForNativeClose(page, app)
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
          .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
        await waitForExitModalReady(page, app, false)
        await page.keyboard.press('Enter').catch(error => {
          if (!/page, context or browser has been closed/i.test(String(error))) throw error
        })
        const result = await exit
        assert.equal(result.signal, null)
        assert.equal(result.code, 0, 'O processo isolado deve encerrar pelo protocolo de shutdown normal.')
        app = undefined
        page = undefined
      }
      if (!f0ResumeIndex) await closeNormally()

      const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build', 'src', 'player-playback-recovery-store.js'))
      const recoveryStore = new PlayerPlaybackRecoveryStore(userData)
      let pausedRecord
      if (!f0T2T4) {
      const recoveredAt = new Date().toISOString()
      pausedRecord = recoveryStore.write({
        version: 1,
        revision: (recoveryStore.read()?.revision ?? 0) + 1,
        status: 'paused',
        attemptId: crypto.randomUUID(),
        musicCode: '01001',
        playbackStatus: 'paused',
        lastTransition: 'playback-paused',
        updatedAt: recoveredAt,
        startedAt: recoveredAt
      })
      assert.equal(recoveryStore.read()?.status, 'paused', 'O cenário T5 deve usar um registro paused válido no perfil descartável.')
      }

      recordEvidence('T2-profile-reused', 'PASS', { indexedFiles: firstScan.indexedFiles, generation: firstIndex.generation })
      activeF0EvidenceStage = 'second-start-and-reconciliation'
      let recoveredIdle
      let secondSnapshotReadyMs
      let secondLaunch
      if (!f0ResumeIndex) {
        app = await launch(true, true)
        page = await waitForStandaloneWindow(app)
        await page.waitForFunction(() => window.standalonePlayer?.getSnapshot)
        recoveredIdle = await waitForSnapshot(page,
          snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'idle',
          f0T2T4 ? 'T2 deve abrir com índice restaurado em idle real.' : 'T5 deve abrir com índice restaurado e recovery paused resolvido em idle seguro.')
        secondLaunch = app.__f0Launch
        secondSnapshotReadyMs = Math.max(0, Date.now() - secondLaunch.launchStartedAtMs)
      } else {
        recoveredIdle = (await page.evaluate(() => window.standalonePlayer.getSnapshot())).snapshot
        secondLaunch = app.__f0Launch
        secondSnapshotReadyMs = Math.max(0, Date.now() - secondLaunch.launchStartedAtMs)
      }
      const resourcesAtT2Ui = f0T2T4 ? sampleWindowsProcessResources(app.process().pid) : null
      assert.ok(!recoveredIdle.state.current, 'T2 não pode retomar automaticamente uma faixa anterior.')
      const secondMainReady = f0ResumeIndex
        ? readF0LogRecords(logPath).filter(record => record.event === 'F0_MAIN_READY_METRICS').at(-1)
        : await waitForF0LogRecord(logPath, 'F0_MAIN_READY_METRICS', undefined, 2)
      assert.ok(secondMainReady, 'A inicialização T2 precisa registrar o marco Main real.')
      const secondRunId = secondMainReady.details.runId
      const secondWindowReady = await waitForF0LogRecord(logPath, 'F0_WINDOW_READY_METRICS', secondRunId)
      const secondStartupUsable = await waitForF0LogRecord(logPath, 'F0_STARTUP_USABLE_METRICS', secondRunId)
      assert.equal(secondWindowReady.details.windowVisible, true,
        'T2 precisa registrar que a janela estava visível no marco de prontidão.')
      const secondIndexLoad = await waitForF0LogRecord(logPath, 'F0_LIBRARY_INDEX_LOAD_METRICS', secondRunId)
      assert.equal(secondIndexLoad.details.cacheStatus, 'restored', 'T2 precisa restaurar o último índice completo.')
      assert.equal(secondIndexLoad.details.indexedFiles, firstScan.indexedFiles,
        'O cache deve disponibilizar o inventário da primeira geração antes da reconciliação.')
      assert.equal(secondStartupUsable.details.scanInProgress, false,
        'Nenhuma reconciliação pode começar antes do gate operacional.')
      for (const counter of ['entriesEnumerated', 'directoriesEnumerated', 'candidateFiles', 'fileOpens', 'cacheHits']) {
        assert.equal(secondStartupUsable.details[counter], 0, `Nenhum ${counter} antes do gate operacional.`)
      }
      const admitted = await waitForF0LogRecord(logPath, 'F0_LIBRARY_RECONCILIATION_ADMITTED', secondRunId)
      assert.ok(admitted.details.elapsedMs >= secondStartupUsable.details.elapsedMs)
      const recoveryAfterStartup = recoveryStore.read()
      if (f0T2T4 && f0ResumeIndex) assert.equal(recoveryAfterStartup?.status, 'stopped',
        'A retomada de validação pode conter apenas o terminal stopped confirmado pela execução T4 anterior.')
      else if (f0T2T4) assert.ok(!recoveryAfterStartup || recoveryAfterStartup.status === 'idle',
        'A primeira execução T2 não pode conter recovery ativo ou uma tentativa anterior no perfil recém-preparado.')
      else {
        assert.equal(recoveryAfterStartup?.status, 'dismissed', 'O registro antigo paused deve ser resolvido, não retomado.')
        assert.equal(recoveryAfterStartup?.lastTransition, 'recovery-dismissed')
        assert.equal(recoveryAfterStartup?.attemptId, pausedRecord.attemptId,
          'A resolução deve preservar a identidade da evidência operacional anterior.')
      }
      assert.equal(recoveredIdle.state.pending.length, 0, 'A fila volátil anterior não pode ser reconstruída.')
      const t2Evidence = { cacheStatus: secondIndexLoad.details.cacheStatus,
        indexReadMs: secondIndexLoad.details.durationMs,
        elapsedToWindowReadyMs: millisecondsFromLaunch(secondLaunch.launchStartedAtMs, secondWindowReady),
        elapsedToUiUsableMs: millisecondsFromLaunch(secondLaunch.launchStartedAtMs, secondStartupUsable),
        startupEntriesEnumerated: secondStartupUsable.details.entriesEnumerated,
        scanStatusAtUiUsable: secondStartupUsable.details.scanStatus,
        scanInProgressAtUiUsable: secondStartupUsable.details.scanInProgress,
        candidatesExaminedAtUiUsable: secondStartupUsable.details.candidateFiles,
        cacheHitsAtUiUsable: secondStartupUsable.details.cacheHits,
        cachedEntries: secondIndexLoad.details.indexedFiles,
        directoriesEnumeratedAtUiUsable: secondStartupUsable.details.directoriesEnumerated,
        fileOpensAtUiUsable: secondStartupUsable.details.fileOpens,
        lstatCallsAtUiUsable: secondStartupUsable.details.lstatCalls,
        statCallsAtUiUsable: secondStartupUsable.details.statCalls,
        realpathCallsAtUiUsable: secondStartupUsable.details.realpathCalls,
        processResourcesAtUiUsable: resourcesAtT2Ui,
        recoveryState: recoveryAfterStartup?.status ?? 'none', idle: recoveredIdle.state.operationalState,
        pendingCount: recoveredIdle.state.pending.length }
      recordEvidence('T2-cache-and-idle-assertions', 'PASS', t2Evidence)
      const durableProfileFiles = ['operating-mode.json', 'video-library.json', 'player-music-catalog.sqlite']
      const durableProfileBeforePlayback = Object.fromEntries(durableProfileFiles.map(name => [name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(userData, name))).digest('hex')]))

      await require('./f0-production-validation').installPlaybackObservation(app, projectRoot)
      activeF0EvidenceStage = 'T4-observe-lazily-created-media-element'
      await page.evaluate(() => {
        window.__f0VideoEvents = []
        const observedVideos = new WeakSet()
        const attempts = new WeakMap()
        window.playerPlayback.onCommand(command => {
          if (command.type === 'load') {
            const video = document.querySelector('#playback-media-layer video')
            if (video) attempts.set(video, command.attemptId)
          }
        })
        const attach = () => {
          const video = document.querySelector('#playback-media-layer video')
          if (!video || observedVideos.has(video)) return
          observedVideos.add(video)
          for (const type of ['loadedmetadata', 'timeupdate', 'canplay', 'playing', 'waiting', 'stalled', 'error', 'ended']) {
            video.addEventListener(type, event => {
              const currentTime = video.currentTime
              let bufferedAheadSeconds = 0
              for (let index = 0; index < video.buffered.length; index++) {
                if (video.buffered.start(index) <= currentTime && video.buffered.end(index) >= currentTime) {
                  bufferedAheadSeconds = Math.max(0, video.buffered.end(index) - currentTime)
                }
              }
              window.__f0VideoEvents.push({ type: event.type, attemptId: attempts.get(video), at: performance.now(), wallTime: Date.now(), readyState: video.readyState,
                networkState: video.networkState, currentTime, bufferedAheadSeconds,
                mediaErrorCode: video.error?.code ?? 0 })
            })
          }
        }
        window.__f0VideoObserver = new MutationObserver(attach)
        window.__f0VideoObserver.observe(document.documentElement, { childList: true, subtree: true })
        attach()
      })

      const startFromKeyboard = async () => {
        activeF0EvidenceStage = 'T4-playback-start-pause-resume-stop'
        for (const digit of enteredPlaybackCode) await page.keyboard.press(digit)
        await page.keyboard.press('Enter')
        const enterSubmittedAt = performance.now()
        const rendererEnterSubmittedAt = await page.evaluate(() => performance.now())
        const playing = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
          snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === playbackCode,
        'O código válido do índice precisa iniciar reprodução real por teclado e Main/IPC.')
        assert.ok(typeof playing.state.current?.attemptId === 'string' && playing.state.current.attemptId.length > 0,
          'O estado playing precisa corresponder a uma tentativa identificável.')
        const elapsedFromEnterToMainPlayingMs = Math.max(0, performance.now() - enterSubmittedAt)
        const mediaPlayingHandle = await page.waitForFunction(() =>
          window.__f0VideoEvents?.find(event => event.type === 'playing') ?? false,
        undefined, { timeout: 20000 })
        const mediaPlayingEvent = await mediaPlayingHandle.jsonValue()
        await mediaPlayingHandle.dispose()
        const mediaProgressHandle = await page.waitForFunction(() => {
          const video = document.querySelector('#playback-media-layer video')
          return video && video.currentTime >= 0.25
            ? { currentTime: video.currentTime, readyState: video.readyState, networkState: video.networkState }
            : false
        }, undefined, { timeout: 20000 })
        const mediaProgress = await mediaProgressHandle.jsonValue()
        await mediaProgressHandle.dispose()
        const mainObservedTiming = await app.evaluate((_electron, id) => {
          const probe = global.__f0Structural
          const states = probe.states.filter(state => state.attemptId === id)
          const submit = probe.submits.filter(item => item.type === 'submit-code').at(-1)
          return { submit, states, timingSource: 'direct Main monotonic observation; separate from Renderer clock' }
        }, playing.state.current.attemptId)
        assert.equal(mediaPlayingEvent.attemptId, playing.state.current.attemptId)
        assert.ok(mainObservedTiming.states.some(state => state.status === 'playing' && state.hostEpoch))
        const t4Resources = sampleWindowsProcessResources(app.process().pid)
        return { elapsedFromEnterToMainPlayingMs, mainPlayingTimingSource: 'harness snapshot observation (polling)',
          elapsedFromEnterToHtmlPlayingMs: Math.max(0, mediaPlayingEvent.at - rendererEnterSubmittedAt),
          elapsedFromEnterToTimeAdvanceMs: Math.max(0, performance.now() - enterSubmittedAt),
          attemptId: playing.state.current.attemptId,
          currentTime: mediaProgress.currentTime, readyState: mediaProgress.readyState, networkState: mediaProgress.networkState,
          mediaPlayingEvent, mainObservedTiming, t4Resources,
          playbackStartedAtWallMs: mediaPlayingEvent.wallTime, rendererStartedAt: rendererEnterSubmittedAt }
      }
      const stopThroughUi = async () => {
        await app.evaluate(() => {
          const p = global.__f0Structural.protocol
          const streams = [...p.capabilities.values()].flatMap(c => [...c.streams])
          global.__f0Structural.closures = Promise.all(streams.map(s => s.closed ? undefined :
            new Promise(resolve => s.once('close', resolve))))
        })
        await page.keyboard.press('Control+Space')
        await page.locator('#standalone-stop-confirmation').waitFor({ state: 'visible' })
        await page.locator('#stop-confirmation-confirm').click()
        const idle = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
          snapshot.state.operationalState === 'idle',
        'Stop All precisa confirmar a contenção e devolver o Player a idle.')
        const stoppedResources = await app.evaluate(async () => {
          await global.__f0Structural.closures
          return global.__f0Structural.protocol.getDiagnosticMetrics()
        })
        assert.equal(stoppedResources.activeGrants, 0)
        assert.equal(stoppedResources.activeStreams, 0)
        assert.equal(stoppedResources.fileHandlesOpened, stoppedResources.fileHandlesClosed)
        recordEvidence('T4-resources-after-stop-app-open', 'PASS', stoppedResources)
        return idle
      }

      const recoveredPlayback = await startFromKeyboard()
      await page.keyboard.press('Space')
      const pausedFirst = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'paused', 'O primeiro MP4 real precisa pausar por comando do operador.')
      const pausedMediaState = await page.evaluate(() => ({ paused: document.querySelector('#playback-media-layer video').paused,
        currentTime: document.querySelector('#playback-media-layer video').currentTime }))
      assert.equal(pausedMediaState.paused, true)
      await page.keyboard.press('Space')
      const resumedMediaHandle = await page.waitForFunction(pausedAt => {
        const video = document.querySelector('#playback-media-layer video')
        return video && !video.paused && video.currentTime > pausedAt ? video.currentTime : false
      }, pausedMediaState.currentTime, { timeout: 10000 })
      const resumedMediaCurrentTime = await resumedMediaHandle.jsonValue()
      await resumedMediaHandle.dispose()
      const resumedFirst = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'playing', 'O mesmo MP4 precisa retomar após pausa.')
      assert.equal(resumedFirst.state.current?.attemptId, pausedFirst.state.current?.attemptId)
      assert.equal(resumedFirst.state.current?.attemptId, recoveredPlayback.attemptId,
        'A retomada pertence à mesma tentativa que iniciou a reprodução real.')
      const activeRefresh = await page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())
      assert.equal(activeRefresh.outcome, 'blocked', 'Atualização deve continuar bloqueada durante playback real.')
      assert.equal(activeRefresh.code, 'PLAYER_NOT_IDLE')
      const recoveredPlaybackEvents = await page.evaluate(() => window.__f0VideoEvents.map(event => ({ ...event })))
      await page.evaluate(() => window.__f0VideoObserver?.disconnect())
      assert.equal(recoveredPlaybackEvents.some(event => event.type === 'error'), false,
        'A reprodução real não pode terminar com erro de mídia.')
      assert.equal(recoveredPlaybackEvents.some(event => event.type === 'ended'), false,
        'Waiting/stalled ou EOF não podem concluir a faixa durante a prova de pausa/retomada.')
      const t4FirstEvidence = {
        eventCounts: Object.fromEntries(['canplay', 'playing', 'waiting', 'stalled', 'error', 'ended'].map(type =>
          [type, recoveredPlaybackEvents.filter(event => event.type === type).length])),
        mainObservedTiming: recoveredPlayback.mainObservedTiming,
        mainPlayingTimingSource: 'harness IPC snapshot observation, before currentTime wait',
        currentTimeAdvanced: recoveredPlayback.currentTime >= 0.25,
        currentTimeObservedSeconds: recoveredPlayback.currentTime,
        elapsedFromEnterToMainPlayingMs: recoveredPlayback.elapsedFromEnterToMainPlayingMs,
        elapsedFromEnterToHtmlPlayingMs: recoveredPlayback.elapsedFromEnterToHtmlPlayingMs,
        elapsedFromEnterToTimeAdvanceMs: recoveredPlayback.elapsedFromEnterToTimeAdvanceMs,
        attemptCorrelated: Boolean(recoveredPlayback.attemptId), attemptId: recoveredPlayback.attemptId,
        initialReadyState: recoveredPlayback.readyState, initialNetworkState: recoveredPlayback.networkState,
        pauseTimeSeconds: pausedMediaState.currentTime, resumedCurrentTimeSeconds: resumedMediaCurrentTime,
        resumedSameAttempt: resumedFirst.state.current?.attemptId === recoveredPlayback.attemptId,
        activeRefresh: activeRefresh.outcome,
        eventTimeline: recoveredPlaybackEvents.map(event => ({
          type: event.type, elapsedMs: Math.max(0, event.at - recoveredPlayback.rendererStartedAt),
          readyState: event.readyState, networkState: event.networkState, currentTime: event.currentTime,
          bufferedAheadSeconds: event.bufferedAheadSeconds, mediaErrorCode: event.mediaErrorCode
        })) }
      recordEvidence('T4-real-mp4-playback-1', 'PASS', t4FirstEvidence)
      activeF0EvidenceStage = 'T4-stop-and-resource-release'
      await stopThroughUi()
      const secondScanRecord = await waitForF0LogRecord(logPath, 'F0_LIBRARY_SCAN_METRICS', secondRunId)
      const secondScan = secondScanRecord.details
      const scanFinishedElapsedMs = Math.max(0, Date.parse(secondScanRecord.timestamp) - secondLaunch.launchStartedAtMs)
      const uiUsableElapsedMs = millisecondsFromLaunch(secondLaunch.launchStartedAtMs, secondStartupUsable)
      const reconciliationCompletedAfterUiMs = Math.max(0, scanFinishedElapsedMs - uiUsableElapsedMs)
      const playbackStartedElapsedMs = Math.max(0, recoveredPlayback.playbackStartedAtWallMs - secondLaunch.launchStartedAtMs)
      assert.ok(secondStartupUsable.details.elapsedMs < secondScan.elapsedMs,
        'O marco monotônico Main de UI utilizável deve anteceder a conclusão da reconciliação.')
      // The scan may finish before the polling harness samples IPC; admission ordering is asserted above.
      if (playbackStartedElapsedMs < scanFinishedElapsedMs) {
        assert.ok(secondScan.playbackYieldCount > 0,
          'Uma reconciliação ainda ativa durante playback deve ceder I/O ao Player.')
      }
      const idleAfterStop = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'idle', 'Stop deve devolver o Player a idle operacional verdadeiro.')
      const secondIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      const secondIndexBytes = fs.statSync(indexPath).size
      const durableProfileAfterPlayback = Object.fromEntries(durableProfileFiles.map(name => [name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(userData, name))).digest('hex')]))
      assert.deepEqual(durableProfileAfterPlayback, durableProfileBeforePlayback,
        'Playback não pode alterar configuração, raiz de biblioteca ou catálogo do perfil temporário.')
      const closeStartedAt = performance.now()
      await closeNormally()
      const shutdownDurationMs = Math.max(0, performance.now() - closeStartedAt)
      const mediaRecord = await waitForF0LogRecord(logPath, 'F0_MEDIA_PROTOCOL_METRICS', secondRunId)
      const mediaMetrics = mediaRecord.details
      assert.ok(mediaMetrics.requests > 0, 'Chromium precisa solicitar o MP4 pelo protocolo local real.')
      assert.ok(mediaMetrics.fileHandlesOpened > 0, 'A biblioteca precisa abrir o arquivo físico para playback.')
      assert.equal(mediaMetrics.fileHandlesOpened, mediaMetrics.fileHandlesClosed,
        'Todos os handles abertos pelo protocolo de mídia precisam fechar no shutdown normal.')
      assert.equal(mediaMetrics.fileHandleCloseFailures, 0, 'Nenhum fechamento de handle pode falhar.')
      assert.equal(mediaMetrics.streamsOpened, mediaMetrics.streamsClosed,
        'Todos os streams HTTP locais do playback precisam emitir fechamento.')
      assert.equal(mediaMetrics.activeStreams, 0, 'Nenhum stream local pode permanecer ativo após shutdown.')
      assert.ok(mediaMetrics.bytesRead > 0, 'O Electron precisa ter lido bytes do MP4 real durante playback.')
      assert.equal(JSON.stringify([firstScan, secondScan, mediaMetrics]).includes(mediaRoot), false,
        'Os resultados agregados não podem registrar a raiz real da biblioteca.')
      assert.equal(JSON.stringify([firstScan, secondScan, mediaMetrics]).includes('01001'), false,
        'Os resultados agregados não podem registrar códigos ou nomes de arquivos.')

      const summary = {
        environment: { platform: process.platform, architecture: process.arch,
          profileDrive: path.parse(profileRoot).root.slice(0, 2), libraryDrive: path.parse(mediaRoot).root.slice(0, 2),
          electron: runtimeVersions.electron, chromium: runtimeVersions.chromium, node: runtimeVersions.node,
          cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem() },
        indexPreparation: { result: 'PREPARATION_ONLY', elapsedToWindowReadyMs: firstEvidence.elapsedToWindowReadyMs ?? null,
          elapsedToMainUsableMs: firstEvidence.elapsedToMainUsableMs ?? null,
          harnessElapsedToWindowPageMs: firstEvidence.harnessElapsedToWindowPageMs ?? null,
          scanDurationMs: firstScan.durationMs, scanCompletedAfterLaunchMs: firstScan.elapsedMs ?? null,
          indexedFiles: firstScan.indexedFiles, availableCodes: firstScan.availableCodes,
          directoriesEnumerated: firstScan.directoriesEnumerated, entriesEnumerated: firstScan.entriesEnumerated,
          lstatCalls: firstScan.lstatCalls, statCalls: firstScan.statCalls, realpathCalls: firstScan.realpathCalls,
          fileOpens: firstScan.fileOpens, fileCloses: firstScan.fileCloses, bytesRead: firstScan.bytesRead,
          indexEntries: firstIndexEntries, indexBytes: firstIndexBytes },
        T2: { result: 'PASS', cacheStatus: secondIndexLoad.details.cacheStatus,
          indexReadMs: secondIndexLoad.details.durationMs,
          elapsedToWindowReadyMs: millisecondsFromLaunch(secondLaunch.launchStartedAtMs, secondWindowReady),
          elapsedToMainUsableMs: millisecondsFromLaunch(secondLaunch.launchStartedAtMs, secondStartupUsable),
          harnessElapsedToWindowPageMs: secondLaunch.elapsedToWindowPageMs, snapshotReadyMs: secondSnapshotReadyMs,
          entriesEnumeratedAtUsable: secondStartupUsable.details.entriesEnumerated,
          scanStatusAtUsable: secondStartupUsable.details.scanStatus,
          scanInProgressAtUsable: secondStartupUsable.details.scanInProgress,
          candidatesExaminedAtUsable: secondStartupUsable.details.candidateFiles,
          cacheHitsAtUsable: secondStartupUsable.details.cacheHits,
          directoriesEnumeratedAtUsable: secondStartupUsable.details.directoriesEnumerated,
          filesOpenedAtUsable: secondStartupUsable.details.fileOpens,
          processResourcesAtUiUsable: resourcesAtT2Ui,
          lstatCallsAtUsable: secondStartupUsable.details.lstatCalls,
          statCallsAtUsable: secondStartupUsable.details.statCalls,
          realpathCallsAtUsable: secondStartupUsable.details.realpathCalls,
          reconciliationCompletedAfterLaunchMs: scanFinishedElapsedMs,
          reconciliationCompletedAfterUiMs,
          reconciliationDurationMs: secondScan.durationMs, reconciliationEntries: secondScan.entriesEnumerated,
          reconciliationDirectories: secondScan.directoriesEnumerated,
          reconciliationCandidatesExamined: secondScan.candidateFiles,
          reconciliationLstatCalls: secondScan.lstatCalls,
          reconciliationCacheHits: secondScan.cacheHits, reconciliationOpens: secondScan.fileOpens,
          playbackYieldCount: secondScan.playbackYieldCount,
          playbackYieldDurationMs: secondScan.playbackYieldDurationMs },
        T3: { result: 'NOT RUN', reason: 'Reconexão física supervisionada fora do escopo desta campanha.' },
        T4: { result: 'PASS', uniqueVideosPlayed: 1, attempts: 1,
          elapsedFromEnterToMainPlayingMs: recoveredPlayback.elapsedFromEnterToMainPlayingMs,
          elapsedFromEnterToHtmlPlayingMs: recoveredPlayback.elapsedFromEnterToHtmlPlayingMs,
          elapsedFromEnterToTimeAdvanceMs: recoveredPlayback.elapsedFromEnterToTimeAdvanceMs,
          mediaEvents: Object.fromEntries(['canplay', 'playing', 'waiting', 'stalled', 'error', 'ended'].map(type =>
            [type, recoveredPlaybackEvents.filter(event => event.type === type).length])),
          currentTimeAdvancedToSeconds: recoveredPlayback.currentTime,
          pausedAtSeconds: pausedMediaState.currentTime, resumedSameAttempt: true,
          activeRefresh: activeRefresh.outcome, stateAfterStop: idleAfterStop.state.operationalState,
          processResourcesWhilePlaying: recoveredPlayback.t4Resources,
          mediaMetrics: { requests: mediaMetrics.requests, rangeRequests: mediaMetrics.rangeRequests,
            fileHandlesOpened: mediaMetrics.fileHandlesOpened, fileHandlesClosed: mediaMetrics.fileHandlesClosed,
            streamsOpened: mediaMetrics.streamsOpened, streamsClosed: mediaMetrics.streamsClosed,
            activeStreamsAfterShutdown: mediaMetrics.activeStreams, bytesRead: mediaMetrics.bytesRead },
          shutdownDurationMs },
        T2T4: { profileDurableDataUnchanged: true, finalIndexGeneration: secondIndex.generation,
          finalIndexBytes: secondIndexBytes },
        playbackOverlappedReconciliation: playbackStartedElapsedMs < scanFinishedElapsedMs
      }
      summary.T2.result = 'PASS'
      summary.T4.result = 'PASS'
      summary.campaign = f0T2T4 ? 'T2+T4' : 'F0-real-library'
      recordEvidence('T2+T4-final-summary', 'PASS', summary)
      recordEvidence('campaign', 'PASS', { T2: summary.T2.result, T4: summary.T4.result, T3: summary.T3.result })
      await assertNoWindowsElectronProcesses(profileRoot)
      process.stdout.write(`F0_REAL_LIBRARY_SUMMARY ${JSON.stringify(summary)}\n`)
      if (evidencePath) process.stdout.write(`F0_EVIDENCE_FILE ${path.basename(evidencePath)}\n`)
      process.stdout.write('PASS F0 T2/T4 Windows real-library scenario; isolated temporary userData/profile; external media was accessed read-only.\n')
      fs.rmSync(profileRoot, { recursive: true, force: true })
      return
    }
    if (f0StartupOnly) {
      const firstSnapshot = (await page.evaluate(() => window.standalonePlayer.getSnapshot())).snapshot
      const firstLogPath = path.join(userData, 'logs', 'app.log')
      const firstRecords = fs.readFileSync(firstLogPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
      assert.equal(firstRecords.some(record => record.event.startsWith('F0_')), false,
        'Diagnósticos desativados não podem gravar eventos da campanha.')

      const closeIdleApp = async () => {
        const exit = waitForNativeClose(page, app)
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
          .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
        await waitForExitModalReady(page, app, false)
        await page.keyboard.press('Enter').catch(error => {
          if (!/page, context or browser has been closed/i.test(String(error))) throw error
        })
        const result = await exit
        assert.equal(result.signal, null)
        assert.equal(result.code, 0)
        app = undefined
        page = undefined
      }
      await waitForF0LogRecord(firstLogPath, 'VIDEO_LIBRARY_SCAN_COMPLETED')
      await closeIdleApp()

      if (f0SeedPausedRecovery) {
        const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build', 'src', 'player-playback-recovery-store.js'))
        const recoveryStore = new PlayerPlaybackRecoveryStore(userData)
        const updatedAt = new Date().toISOString()
        recoveryStore.write({ version: 1, revision: (recoveryStore.read()?.revision ?? 0) + 1,
          status: 'paused', attemptId: crypto.randomUUID(), musicCode: '01001', playbackStatus: 'paused',
          lastTransition: 'playback-paused', updatedAt, startedAt: updatedAt })
      }

      const durableFiles = ['operating-mode.json', 'video-library.json', 'player-music-catalog.sqlite']
      const before = Object.fromEntries(durableFiles.map(name => [name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(userData, name))).digest('hex')]))
      app = await launch(true)
      page = await waitForStandaloneWindow(app)
      await page.waitForFunction(() => window.standalonePlayer?.getSnapshot)
      const secondSnapshot = (await page.evaluate(() => window.standalonePlayer.getSnapshot())).snapshot
      assert.equal(secondSnapshot.playbackCondition, firstSnapshot.playbackCondition)
      assert.deepEqual(secondSnapshot.state, firstSnapshot.state,
        'A instrumentação não pode alterar estado idle/fila entre execuções equivalentes.')
      if (f0SeedPausedRecovery) {
        const { PlayerPlaybackRecoveryStore } = require(path.join(projectRoot, 'build', 'src', 'player-playback-recovery-store.js'))
        const recovered = new PlayerPlaybackRecoveryStore(userData).read()
        assert.equal(recovered?.status, 'dismissed', 'O recovery paused anterior deve ser resolvido sem retomar mídia.')
        assert.match(recovered?.reason ?? '', /^startup-prior:paused:playback-paused$/)
      }
      const after = Object.fromEntries(durableFiles.map(name => [name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(userData, name))).digest('hex')]))
      assert.deepEqual(after, before, 'A instrumentação não pode alterar configuração nem catálogo SQLite.')

      await waitForF0LogRecord(firstLogPath, 'F0_LIBRARY_SCAN_METRICS')
      const gate = await waitForF0LogRecord(firstLogPath, 'F0_STARTUP_USABLE_METRICS')
      assert.equal(gate.details.entriesEnumerated, 0)
      assert.equal(gate.details.fileOpens, 0)
      const admitted = await waitForF0LogRecord(firstLogPath, 'F0_LIBRARY_RECONCILIATION_ADMITTED')
      assert.ok(admitted.details.elapsedMs >= gate.details.elapsedMs)
      const diagnosticRecords = fs.readFileSync(firstLogPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
        .filter(record => record.event.startsWith('F0_'))
      const expectedEvents = ['F0_MAIN_READY_METRICS', 'F0_LIBRARY_INDEX_LOAD_METRICS', 'F0_LIBRARY_SCAN_METRICS',
        'F0_WINDOW_READY_METRICS', 'F0_STARTUP_USABLE_METRICS']
      for (const event of expectedEvents) assert.ok(diagnosticRecords.some(record => record.event === event), `Métrica ausente: ${event}`)
      const windowReady = diagnosticRecords.find(record => record.event === 'F0_WINDOW_READY_METRICS')
      assert.equal(windowReady?.details?.windowVisible, true,
        'A janela Standalone precisa estar visível no marco de prontidão documentado.')
      const indexLoad = diagnosticRecords.find(record => record.event === 'F0_LIBRARY_INDEX_LOAD_METRICS')
      assert.equal(indexLoad?.details?.cacheStatus, 'restored',
        'a segunda execução carrega o último índice completo antes da reconciliação em segundo plano')
      const indexPath = path.join(userData, 'video-library-index.json')
      const persistedIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      assert.ok(persistedIndex.generation >= 1)
      const details = diagnosticRecords.map(record => record.details)
      assert.ok(details.every(item => item && typeof item.runId === 'string' && typeof item.elapsedMs === 'number'))
      assert.equal(new Set(details.map(item => item.runId)).size, 1, 'Todas as fases devem compartilhar runId.')
      for (let index = 1; index < details.length; index++) {
        assert.ok(details[index].elapsedMs >= details[index - 1].elapsedMs,
          'As marcas monotônicas devem permanecer não decrescentes na ordem do log.')
      }
      assert.equal(JSON.stringify(details).includes('01001'), false)
      assert.equal(JSON.stringify(details).includes(mediaRoot), false)
      await closeIdleApp()
      await assertNoLinuxElectronProcesses(profileRoot)
      process.stdout.write(`PASS F0 production startup: cache restored before reconciliation, Main/IPC ready, pathless metrics, unchanged idle state/config/catalog${f0SeedPausedRecovery ? ', inherited paused recovery resolved without autoplay' : ''}. Synthetic empty MP4 fixture; no playback assertion.\n`)
      return
    }
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
      if (!win) throw new Error('A janela de produção Standalone não foi encontrada.')
      win.setContentSize(1280, 800)
    })
    const bridge = await page.evaluate(() => ({
      keys: Object.keys(window.standalonePlayer ?? {}).sort(),
      require: typeof window.require,
      process: typeof window.process,
      disconnected: document.querySelector('.connection-card')?.innerText,
      mode: document.body.dataset.menuScreen
    }))
    assert.equal(bridge.require, 'undefined', 'O Renderer de produção não recebe require.')
    assert.equal(bridge.process, 'undefined', 'O Renderer de produção não recebe process.')
    assert.match(bridge.disconnected, /DESCONECTADO[\s\S]*Sem controlador remoto/,
      'O cartão ocioso aprovado deve aparecer como desconectado.')
    assert.ok(bridge.keys.includes('execute'), 'O Preload de produção expõe somente o contrato Standalone tipado.')
    await page.screenshot({ path: path.join(screenshotRoot, 'c9-production-idle-1280x800.png') })

    // C10.3: verify the responsive changes across the requested production viewports,
    // fullscreen, and browser scale factors.
    writeProgress('C10.3 responsive validation start')
    for (const dimensions of responsiveViewportCases) {
      await auditResponsiveViewport(page, app, screenshotRoot, dimensions, 'after')
    }
    await auditResponsiveFullscreen(page, app, screenshotRoot, 'after')
    await auditResponsiveDprs(page, app, screenshotRoot, 'after')
    fs.writeFileSync(path.join(screenshotRoot, 'c10.3-after-metrics.json'), JSON.stringify({
      platform: process.platform,
      nativeDisplay: await app.evaluate(({ screen }) => {
        const display = screen.getPrimaryDisplay()
        return { scaleFactor: display.scaleFactor, bounds: display.bounds, workArea: display.workArea }
      }),
      viewportCases: responsiveViewportCases,
      dprCases: responsiveDprCases,
      responsiveAuditMetrics
    }, null, 2))
    await setProductionViewport(app, page, { width: 1280, height: 800 })
    writeProgress('C10.3 responsive validation captured')

    // C10.1: the disconnected state and idle panel stay visible while the operator previews a code.
    await captureC10IdleState(page, screenshotRoot, 'idle')
    for (const digit of '1001') await page.keyboard.press(digit)
    await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Código digitado: 1001' &&
      document.querySelector('#idle-title')?.textContent === 'Always' &&
      document.querySelector('#idle-artist')?.textContent === 'Bon Jovi')
    const c10CodePreview = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'idle' && snapshot.state.pending.length === 0,
    'A prévia C10.1 não deve iniciar playback ou alterar a fila.')
    assert.equal(c10CodePreview.state.pending.length, 0)
    await captureC10IdleState(page, screenshotRoot, 'code-informed')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Nenhum código digitado' &&
      document.querySelector('#idle-title')?.textContent === '—' && document.querySelector('#idle-artist')?.textContent === '—')

    for (const digit of '99999') await page.keyboard.press(digit)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('#idle-feedback')?.textContent?.includes('Código 99999 não encontrado.'))
    const c10InvalidCode = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'idle' && snapshot.state.pending.length === 0,
    'O código inexistente C10.1 deve manter o Player ocioso e a fila vazia.')
    assert.deepEqual(c10InvalidCode.state.pending, [])
    assert.equal(await page.locator('#idle-title').textContent(), '—')
    assert.equal(await page.locator('#idle-artist').textContent(), '—')
    await captureC10IdleState(page, screenshotRoot, 'code-not-found')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('#idle-code-digits')?.getAttribute('aria-label') === 'Nenhum código digitado')

    const phaseTraceSubscription = await page.evaluate(async () => {
      window.__c9PhaseTrace = []
      window.__c9DomPhaseTrace = [document.body.dataset.transitionPhase]
      window.__c10LoadingCaptureMetrics = undefined
      window.__c9PhaseObserver = new MutationObserver(() => {
        const phase = document.body.dataset.transitionPhase
        if (window.__c9DomPhaseTrace.at(-1) !== phase) window.__c9DomPhaseTrace.push(phase)
        if (phase !== 'loading' || window.__c10LoadingCaptureMetrics) return
        const screen = document.querySelector('#standalone-loading')
        const card = document.querySelector('.loading-card')
        const style = card ? getComputedStyle(card) : undefined
        const rect = card?.getBoundingClientRect()
        window.__c10LoadingCaptureMetrics = {
          state: phase,
          exitModalVisible: document.getElementById('standalone-exit-confirmation')?.hidden === false,
          viewport: { width: innerWidth, height: innerHeight },
          devicePixelRatio,
          document: { clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
            scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
          loadingScreenVisible: Boolean(screen && !screen.hidden),
          loadingCard: {
            visible: Boolean(card && !card.hidden && style?.display !== 'none' &&
              style?.visibility !== 'hidden' && rect && rect.width > 0 && rect.height > 0),
            rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
            headingFontSize: card?.querySelector('.loading-heading') && getComputedStyle(card.querySelector('.loading-heading')).fontSize,
            descriptionFontSize: card?.querySelector('.loading-description') && getComputedStyle(card.querySelector('.loading-description')).fontSize
          }
        }
      })
      window.__c9PhaseObserver.observe(document.body, { attributes: true, attributeFilter: ['data-transition-phase'] })
      return window.standalonePlayer.subscribe(envelope => {
        window.__c9PhaseTrace.push({ phase: envelope.snapshot.phase,
          playbackCondition: envelope.snapshot.playbackCondition,
        operationalState: envelope.snapshot.state.operationalState })
      })
    })

    // C10.2: existing library/catalog controls remain in Options, without the mode selector.
    await page.keyboard.press('Escape')
    await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
    await page.locator('#menu-item-options').click()
    await page.locator('#standalone-options-screen').waitFor({ state: 'visible' })
    const optionsText = await page.locator('#standalone-options-screen').innerText()
    assert.match(optionsText, /Biblioteca de vídeos/)
    assert.match(optionsText, /Catálogo de músicas/)
    assert.doesNotMatch(optionsText, /Modo de operação|Alterar modo/)
    for (const selector of [
      '#options-change-folder', '#options-refresh-library', '#options-import-catalog',
      '#options-catalog-view-issues', '#options-catalog-dialog', '#options-toast'
    ]) {
      assert.equal(await page.locator(selector).count(), 1, `A tela Opções deve preservar ${selector}.`)
    }
    assert.equal(await page.locator('#options-mode-panel').count(), 0,
      'O painel de modo não deve permanecer na tela Opções.')
    assert.equal(await page.locator('#apply-mode').count(), 0,
      'A ação de alterar modo não deve permanecer na tela Opções.')
    const optionsLayout = await page.locator('.options-library-panel').evaluate(element => {
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight
      }
    })
    assert.ok(optionsLayout.height < 400, 'A tela Opções deve usar um painel compacto sem a coluna de modo.')
    assert.ok(optionsLayout.x >= 0 && optionsLayout.x + optionsLayout.width <= optionsLayout.viewportWidth,
      'O painel Opções deve caber horizontalmente na viewport.')
    assert.ok(Math.abs(optionsLayout.y + optionsLayout.height / 2 - optionsLayout.viewportHeight / 2) < 32,
      'O painel reorganizado deve ficar visualmente centrado na viewport.')
    assert.ok(optionsLayout.scrollWidth <= optionsLayout.viewportWidth && optionsLayout.scrollHeight <= optionsLayout.viewportHeight,
      'A tela Opções não deve introduzir overflow na viewport de referência.')
    await page.screenshot({ path: path.join(screenshotRoot, 'c10.2-options-after-1280x800.png') })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    // Countdown remains live while the OS/window close path asks for confirmation.
    await setProductionViewport(app, page, { width: 3840, height: 2160 })
    const first = await page.evaluate(async () => window.standalonePlayer.execute({
      operationId: crypto.randomUUID(), command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
    }))
    assert.equal(first.outcome, 'confirmed')
    const duringCountdown = await waitForSnapshot(page, snapshot =>
      snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'countdown',
    'O primeiro item precisa iniciar pelo countdown autorizado.')
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
      win.close()
    })
    await page.locator('#standalone-exit-confirmation').waitFor({ state: 'visible' })
    await waitForExitModalReady(page, app)
    await new Promise(resolve => setTimeout(resolve, 1200))
    const afterCountdownWait = await waitForSnapshot(page, snapshot =>
      snapshot.playbackCondition === 'transitioning' && snapshot.phase === 'countdown',
    'A confirmação não pode suspender nem descartar o countdown.')
    assert.ok(afterCountdownWait.remainingMs < duringCountdown.remainingMs,
      'O countdown deve continuar enquanto o modal de saída está aberto.')
    await captureResponsiveAuditState(page, screenshotRoot, '3840x2160-countdown-exit-modal', 'after', { skipScreenshot: true })
    await captureExitModalState(page, screenshotRoot, 'countdown')
    await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing',
    'O MP4 real deve concluir o loading e começar enquanto a confirmação de saída permanece aberta.')
    assert.equal(await page.locator('#standalone-exit-confirmation').isVisible(), true,
      'O loading não fecha nem descarta a confirmação de saída.')
    const phaseTraces = await page.evaluate(() => ({ snapshots: window.__c9PhaseTrace, dom: window.__c9DomPhaseTrace }))
    const loadingWasObserved = phaseTraces.snapshots.some(state =>
      state.playbackCondition === 'transitioning' && state.phase === 'loading') || phaseTraces.dom.includes('loading')
    assert.ok(loadingWasObserved,
      `A transição real para loading deve aparecer enquanto o modal continua aberto; trace=${JSON.stringify(phaseTraces)}`)
    await page.waitForFunction(() => Boolean(window.__c10LoadingCaptureMetrics), undefined, { timeout: 10000 })
    const loadingMetrics = await page.evaluate(() => window.__c10LoadingCaptureMetrics)
    responsiveAuditMetrics.push(loadingMetrics)
    writeProgress(`C10.3 loading metrics ${JSON.stringify(loadingMetrics)}`)
    assert.equal(loadingMetrics.state, 'loading')
    assert.equal(loadingMetrics.exitModalVisible, true)
    assert.equal(loadingMetrics.loadingScreenVisible, true)
    assert.equal(loadingMetrics.loadingCard.visible, true)
    assert.deepEqual(loadingMetrics.document, {
      clientWidth: 3840, clientHeight: 2160, scrollWidth: 3840, scrollHeight: 2160
    }, 'O loading real deve caber na viewport 4K, mesmo com a confirmação de saída aberta.')
    assert.ok(loadingMetrics.loadingCard.rect.x >= 0 && loadingMetrics.loadingCard.rect.y >= 0 &&
      loadingMetrics.loadingCard.rect.x + loadingMetrics.loadingCard.rect.width <= 3840 &&
      loadingMetrics.loadingCard.rect.y + loadingMetrics.loadingCard.rect.height <= 2160,
    'O cartão de loading 4K não pode ser cortado pela viewport.')
    await captureExitModalState(page, screenshotRoot, 'playback-after-loading')
    await page.evaluate(async subscription => {
      window.__c9PhaseObserver?.disconnect()
      await window.standalonePlayer.unsubscribe(subscription)
      delete window.__c9PhaseObserver
      delete window.__c9PhaseTrace
      delete window.__c9DomPhaseTrace
      delete window.__c10LoadingCaptureMetrics
    }, phaseTraceSubscription)
    await page.keyboard.press('Escape')
    await page.locator('#standalone-exit-confirmation').waitFor({ state: 'hidden' })

    const playing = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01001',
    'O playback real deve começar no MP4 após o countdown.')
    await captureResponsiveAuditState(page, screenshotRoot, '3840x2160-playing', 'after')
    await setProductionViewport(app, page, { width: 1280, height: 800 })
    await waitForPlaybackHost(app)
    const playingSurface = await playbackSurfacePresentation(app)
    writeProgress(`production playback surface ${JSON.stringify(playingSurface)}`)
    assert.equal(playingSurface.waitingVisible, false,
      'A superfície sobreposta não pode exibir a tela antiga de espera enquanto o MP4 está tocando.')
    assert.equal(playingSurface.videoPaused, false,
      'A superfície aprovada deve exibir o MP4 ativo, sem abrir outra janela legada.')
    assert.deepEqual(playingSurface.windowUrls, [page.url()],
      'O playback Standalone deve continuar na janela principal sem criar janelas legadas adicionais.')
    const playbackScreenshotPath = path.join(screenshotRoot, 'production-main-playback-surface.png')
    await capturePlaybackSurface(app, playbackScreenshotPath)
    writeProgress(`production playback surface screenshot ${playbackScreenshotPath}`)
    const hostBeforeModal = await playbackHostState(app)
    assert.equal(hostBeforeModal.paused, false, 'O elemento de vídeo do host real deve estar reproduzindo.')
    const queued = await page.evaluate(async () => window.standalonePlayer.execute({
      operationId: crypto.randomUUID(), command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
    }))
    assert.equal(queued.outcome, 'confirmed')
    const withQueue = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.pending.length === 1,
      'A fila precisa continuar editável durante o playback.')
    assert.equal(withQueue.state.current.attemptId, playing.state.current.attemptId)

    // Regression coverage for the real operator compositor: the MP4, queue,
    // overlays, and keyboard all share the production Standalone WebContents.
    await page.locator('#standalone-queue').waitFor({ state: 'visible' })
    let integratedSurface = await waitForIntegratedPlaybackSurface(app, true)
    assert.equal(integratedSurface.queueVisible, true,
      'Próximas deve aparecer sobre o vídeo sempre que houver pendências.')
    let mediaBeforePanel = await playbackHostState(app)
    const queueComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-with-queue-1280x800.png')

    await page.keyboard.type('1001')
    await page.locator('#standalone-playing-panel').waitFor({ state: 'visible' })
    integratedSurface = await waitForIntegratedPlaybackSurface(app, true)
    assert.equal(integratedSurface.addPanelVisible, true, 'O painel Adicionar deve aparecer sobre a reprodução.')
    assert.equal(integratedSurface.queueVisible, false, 'Próximas deve ocultar-se temporariamente sob Adicionar.')
    assert.equal(integratedSurface.videoPaused, false, 'Abrir Adicionar não pode pausar o vídeo.')
    const mediaDuringAdd = await waitForPlaybackHostTime(app, mediaBeforePanel.currentTime + 0.1)
    assert.ok(mediaDuringAdd.currentTime > mediaBeforePanel.currentTime,
      'O MP4 precisa continuar avançando visualmente atrás do painel Adicionar.')
    const addComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-add-panel-1280x800.png')
    await clickStandaloneSurface(page, app, 640, 400)
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.press('Escape')
    await page.locator('#standalone-playing-panel').waitFor({ state: 'hidden' })
    await page.locator('#standalone-queue').waitFor({ state: 'visible' })
    const queueAfterAddComposite = await captureComposite(page, app, screenshotRoot,
      'regression-queue-restored-after-add-1280x800.png')

    await page.keyboard.press('i')
    await page.locator('#standalone-current-track-info').waitFor({ state: 'visible' })
    integratedSurface = await waitForIntegratedPlaybackSurface(app, true)
    assert.equal(integratedSurface.infoPanelVisible, true, 'Informações da faixa devem aparecer sobre o vídeo.')
    assert.equal(integratedSurface.queueVisible, false, 'Próximas deve ocultar-se temporariamente sob Informações.')
    assert.equal(integratedSurface.videoPaused, false, 'Abrir Informações não pode pausar o vídeo.')
    const mediaDuringInfo = await waitForPlaybackHostTime(app, mediaDuringAdd.currentTime + 0.1)
    assert.ok(mediaDuringInfo.currentTime > mediaDuringAdd.currentTime,
      'O MP4 precisa continuar avançando visualmente atrás de Informações.')
    const infoComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-info-panel-1280x800.png')
    await page.locator('#standalone-current-track-info').click({ position: { x: 20, y: 20 } })
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.press('Escape')
    await page.locator('#standalone-current-track-info').waitFor({ state: 'hidden' })
    await page.locator('#standalone-queue').waitFor({ state: 'visible' })
    const queueAfterInfoComposite = await captureComposite(page, app, screenshotRoot,
      'regression-queue-restored-after-info-1280x800.png')

    await page.keyboard.press('Escape')
    await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
    integratedSurface = await waitForIntegratedPlaybackSurface(app, true)
    assert.equal(integratedSurface.menuVisible, true, 'O menu Esc deve aparecer sobre o vídeo.')
    assert.equal(integratedSurface.videoPaused, false, 'Abrir o menu Esc não pode pausar o vídeo.')
    const mediaDuringMenu = await waitForPlaybackHostTime(app, mediaDuringInfo.currentTime + 0.1)
    assert.ok(mediaDuringMenu.currentTime > mediaDuringInfo.currentTime,
      'O MP4 precisa continuar avançando atrás do menu Esc.')
    const menuComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-escape-menu-1280x800.png')
    await page.keyboard.press('Escape')
    await page.locator('#standalone-main-menu').waitFor({ state: 'hidden' })

    await page.keyboard.press('Space')
    await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'paused' && snapshot.state.pending.length === 1,
    'O atalho Espaço deve pausar o MP4 pela interface de produção.')
    await page.locator('#standalone-paused-indicator').waitFor({ state: 'visible' })
    await waitForIntegratedPlaybackSurface(app, true)
    assert.equal((await playbackHostState(app)).paused, true)
    const pausedIndicatorState = () => page.locator('#standalone-paused-indicator').evaluate(element => ({
      hidden: (element as HTMLElement).hidden,
      opacity: Number(getComputedStyle(element).opacity),
      animationName: getComputedStyle(element).animationName,
      animationDuration: getComputedStyle(element).animationDuration
    }))
    const pausedStartState = await pausedIndicatorState()
    assert.equal(pausedStartState.hidden, false)
    assert.equal(pausedStartState.animationName, 'paused-pulse',
      `Pausado deve manter o pulso visual aprovado: ${JSON.stringify(pausedStartState)}`)
    assert.equal(pausedStartState.animationDuration, '1.5s',
      `O pulso Pausado deve manter a duração aprovada: ${JSON.stringify(pausedStartState)}`)
    const pausedComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-paused-overlay-1280x800.png')
    await page.waitForTimeout(600)
    const pausedPulseMiddleState = await pausedIndicatorState()
    assert.equal(pausedPulseMiddleState.hidden, false,
      `Pausado deve permanecer visível durante o pulso: ${JSON.stringify(pausedPulseMiddleState)}`)
    assert.ok(Math.abs(pausedPulseMiddleState.opacity - pausedStartState.opacity) > 0.08,
      `A opacidade do pulso deve mudar visivelmente entre amostras: início=${JSON.stringify(pausedStartState)} meio=${JSON.stringify(pausedPulseMiddleState)}`)
    const pausedPulseMiddleComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-paused-pulse-middle-600ms-1280x800.png')
    await page.waitForTimeout(1000)
    await page.locator('#standalone-paused-indicator').waitFor({ state: 'visible' })
    const pausedPulseLateState = await pausedIndicatorState()
    assert.equal(pausedPulseLateState.hidden, false,
      `Pausado deve permanecer enquanto a música estiver pausada: ${JSON.stringify(pausedPulseLateState)}`)
    const pausedPulseLateComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-paused-pulse-late-1600ms-1280x800.png')
    writeProgress(`paused-pulse samples ${JSON.stringify({ pausedStartState, pausedPulseMiddleState, pausedPulseLateState })}`)
    await page.evaluate(() => {
      const element = document.getElementById('standalone-resuming-indicator')
      if (!element) throw new Error('O indicador Retomando deve existir para observar sua transição.')
      window.__resumeIndicatorTrace = []
      const capture = () => window.__resumeIndicatorTrace.push({
        at: performance.now(), hidden: element.hidden, confirmed: element.dataset.confirmed ?? null,
        opacity: Number(getComputedStyle(element).opacity), animationName: getComputedStyle(element).animationName,
        animationDuration: getComputedStyle(element).animationDuration
      })
      window.__resumeIndicatorTrace.push({ reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches })
      window.__resumeIndicatorObserver = new MutationObserver(capture)
      window.__resumeIndicatorObserver.observe(element, { attributes: true, attributeFilter: ['hidden', 'data-confirmed'] })
    })
    await clickStandaloneSurface(page, app, 640, 400)
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.press('Space')
    await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing' && snapshot.state.pending.length === 1,
    'Espaço deve retomar a mesma música depois de cliques reais na superfície Electron.')
    await page.locator('#standalone-resuming-indicator').waitFor({ state: 'visible' })
    const resumeTrace = await page.evaluate(() => window.__resumeIndicatorTrace)
    const resumeConfirmed = resumeTrace.find(entry => entry.confirmed === 'true' && !entry.hidden && Number.isFinite(entry.at))
    assert.ok(resumeConfirmed, `O Renderer deve registrar o início confirmado do fade: ${JSON.stringify(resumeTrace)}`)
    const resumeStartComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-resuming-start-1280x800.png')
    const resumeStartedAt = resumeConfirmed.at
    const resumeIndicatorState = () => page.locator('#standalone-resuming-indicator').evaluate(element => ({
      at: performance.now(), hidden: element.hidden,
      opacity: Number(getComputedStyle(element).opacity),
      animationName: getComputedStyle(element).animationName,
      animationDuration: getComputedStyle(element).animationDuration
    }))
    const waitForResumeOffset = async offset => {
      const now = await page.evaluate(() => performance.now())
      if (now < resumeStartedAt + offset) await page.waitForTimeout(resumeStartedAt + offset - now)
    }
    await waitForResumeOffset(500)
    const resumeMiddleState = await resumeIndicatorState()
    assert.equal(resumeMiddleState.hidden, false,
      `O indicador deve continuar presente durante o fade intermediário: ${JSON.stringify(resumeMiddleState)}`)
    const reducedMotion = resumeTrace.some(entry => entry.reducedMotion === true)
    if (!reducedMotion) {
      assert.equal(resumeMiddleState.animationName, 'resume-feedback-fade',
        `Retomando deve usar o fade aprovado: ${JSON.stringify(resumeMiddleState)}`)
      assert.ok(resumeMiddleState.opacity > 0 && resumeMiddleState.opacity < 1,
        `A amostra intermediária deve mostrar o esmaecimento visual: ${JSON.stringify(resumeMiddleState)}`)
    }
    const resumeMiddleComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-resuming-middle-500ms-1280x800.png')
    await waitForResumeOffset(1100)
    const resumeEndState = await resumeIndicatorState()
    assert.equal(resumeEndState.hidden, false,
      `O fade de retomada deve terminar sem sumir prematuramente: ${JSON.stringify(resumeEndState)}`)
    if (!reducedMotion) {
      assert.ok(resumeEndState.opacity > 0 && resumeEndState.opacity <= resumeMiddleState.opacity,
        `O indicador deve continuar visível enquanto o fade progride: meio=${JSON.stringify(resumeMiddleState)} fim=${JSON.stringify(resumeEndState)}`)
    }
    const resumeEndComposite = await captureComposite(page, app, screenshotRoot,
      'regression-playing-resuming-late-1100ms-1280x800.png')
    writeProgress(`resume-transition samples ${JSON.stringify({ resumeTrace, resumeMiddleState, resumeEndState })}`)
    await page.locator('#standalone-resuming-indicator').waitFor({ state: 'hidden' })
    await page.evaluate(() => {
      window.__resumeIndicatorObserver?.disconnect()
      delete window.__resumeIndicatorObserver
      delete window.__resumeIndicatorTrace
    })
    await page.locator('#standalone-queue').waitFor({ state: 'visible' })
    const queueRestoredComposite = await captureComposite(page, app, screenshotRoot,
      'regression-queue-restored-after-resume-1280x800.png')
    writeProgress(`regression-composites ${JSON.stringify({ queueComposite, addComposite, queueAfterAddComposite,
      infoComposite, queueAfterInfoComposite, menuComposite,
      pausedComposite, pausedPulseMiddleComposite, pausedPulseLateComposite,
      resumeStartComposite, resumeMiddleComposite, resumeEndComposite, queueRestoredComposite })}`)

    mediaBeforePanel = await playbackHostState(app)
    await page.evaluate(() => {
      window.__f11Trace = []
      window.addEventListener('keydown', event => {
        if (event.key === 'F11') window.__f11Trace.push({ type: event.type, defaultPrevented: event.defaultPrevented,
          isTrusted: event.isTrusted, focused: document.hasFocus(), at: performance.now() })
      }, true)
    })
    await page.keyboard.press('F11')
    await waitForFullScreen(app, true)
    await page.locator('#player-fullscreen-hint').waitFor({ state: 'visible' })
    const fullscreenComposite = await captureComposite(page, app, screenshotRoot,
      'regression-fullscreen-playing-1280x800.png')
    await page.keyboard.press('F11')
    await waitForFullScreen(app, false)
    const windowComposite = await captureComposite(page, app, screenshotRoot,
      'regression-window-after-f11-1280x800.png')
    await page.keyboard.press('F11')
    await waitForFullScreen(app, true)
    await page.keyboard.press('F11')
    await waitForFullScreen(app, false)
    await page.keyboard.press('F11')
    await waitForFullScreen(app, true)
    assert.equal((await page.locator('#player-fullscreen-hint').innerText()).trim(),
      'Pressione F11 para sair da tela cheia',
    'A dica Standalone deve indicar somente F11 como atalho para sair da tela cheia.')
    await page.keyboard.press('Escape')
    await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
    await waitForFullScreen(app, true)
    await page.keyboard.press('Escape')
    await page.locator('#standalone-main-menu').waitFor({ state: 'hidden' })
    await waitForFullScreen(app, true)
    await page.keyboard.press('F11')
    await waitForFullScreen(app, false)
    if (process.platform === 'win32') {
      writeProgress('f11 native START focus once, then send consecutive OS-level keys')
      const nativeF11ExpectedStates = [true, false, true, false]
      let nativeF11SequenceComplete = true
      for (let index = 0; index < nativeF11ExpectedStates.length; index++) {
        const previousCount = await page.evaluate(() => window.__f11Trace?.length ?? 0)
        const sent = await sendWindowsNativeF11(app, index === 0)
        if (!sent) {
          writeProgress(`f11 native NOT RUN o processo auxiliar não manteve a janela Standalone em foreground antes da entrada ${index + 1}/4; nenhum F11 foi enviado sem foco verificado`)
          nativeF11SequenceComplete = false
          break
        }
        if (!await waitForWindowsNativeF11Event(page, previousCount)) {
          writeProgress(`f11 native NOT RUN SendInput aceitou a entrada, mas Chromium não recebeu keydown em ${index + 1}/4; foco e sequência CDP já foram validados`)
          nativeF11SequenceComplete = false
          break
        }
        const nativeEvent = await page.evaluate(count => window.__f11Trace[count], previousCount)
        assert.equal(nativeEvent.isTrusted, true, 'F11 nativo precisa chegar como evento confiável do Chromium.')
        assert.equal(nativeEvent.defaultPrevented, true, 'O handler Standalone precisa consumir o F11 nativo.')
        await waitForFullScreen(app, nativeF11ExpectedStates[index])
        if (index === 0 || index === 1 || index === 3) await assertStandaloneInputFocus(page, app)
      }
      if (nativeF11SequenceComplete) writeProgress('f11 native PASS dois ciclos fullscreen/janela sem refocar entre teclas')
    }
    assert.ok((await playbackHostState(app)).currentTime >= mediaBeforePanel.currentTime,
      'Alternâncias F11 consecutivas não podem reiniciar nem retroceder o MP4.')

    await page.keyboard.press('Escape')
    await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
    await captureResponsiveAuditState(page, screenshotRoot, '3840x2160-playing-menu-queue', 'after')
    await page.keyboard.press('Escape')
    await page.locator('#standalone-main-menu').waitFor({ state: 'hidden' })

    // Paused playback and its queue remain unchanged while a native close request is pending.
    const pauseResult = await page.evaluate(async () => window.standalonePlayer.execute({
      operationId: crypto.randomUUID(), command: { type: 'toggle-pause' }
    }))
    assert.equal(pauseResult.outcome, 'confirmed')
    const paused = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'paused' && snapshot.state.pending.length === 1,
    'O MP4 real deve aceitar pausa preservando a fila.')
    const pausedSurface = await playbackSurfacePresentation(app)
    assert.equal(pausedSurface.waitingVisible, false,
      'A tela de espera legada deve permanecer oculta enquanto o vídeo Standalone está pausado.')
    assert.equal(pausedSurface.videoPaused, true,
      'Pausar deve atingir o mesmo elemento de vídeo que está visível na superfície Standalone.')
    await captureResponsiveAuditState(page, screenshotRoot, '3840x2160-paused-queue', 'after')
    assert.equal((await playbackHostState(app)).paused, true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
    await waitForExitModalReady(page, app)
    const pausedDuringConfirmation = await page.evaluate(async () => window.standalonePlayer.getSnapshot())
    assert.equal(pausedDuringConfirmation.snapshot.state.operationalState, 'paused')
    assert.equal(pausedDuringConfirmation.snapshot.state.current.attemptId, paused.state.current.attemptId)
    assert.equal(pausedDuringConfirmation.snapshot.state.pending.length, 1)
    assert.equal((await playbackHostState(app)).paused, true)
    await page.keyboard.press('Escape')
    await page.locator('#standalone-exit-confirmation').waitFor({ state: 'hidden' })
    await waitForIntegratedPlaybackSurface(app, true)
    const pauseAfterCancel = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'paused' && snapshot.state.pending.length === 1,
    'Cancelar precisa preservar a pausa e a fila.')
    assert.equal(pauseAfterCancel.state.current.attemptId, paused.state.current.attemptId)
    const resumeResult = await page.evaluate(async () => window.standalonePlayer.execute({
      operationId: crypto.randomUUID(), command: { type: 'toggle-pause' }
    }))
    assert.equal(resumeResult.outcome, 'confirmed')
    await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing' && snapshot.state.pending.length === 1,
    'O operador deve conseguir retomar a mesma faixa após cancelar a saída.')
    await setProductionViewport(app, page, { width: 1280, height: 800 })

    // Menu Sair and X race into one confirmation; playback, timer and queue remain live.
    writeProgress('menu-x START open main menu')
    await page.keyboard.press('Escape')
    writeProgress('menu-x PASS escape pressed')
    await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
    writeProgress('menu-x PASS main menu visible')
    await page.evaluate(() => document.getElementById('menu-item-exit').click())
    writeProgress('menu-x PASS menu Sair clicked')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
    writeProgress('menu-x PASS BrowserWindow.close returned')
    await waitForExitModalReady(page, app)
    writeProgress('menu-x PASS modal ready')
    assert.equal(await page.locator('#standalone-exit-confirmation').count(), 1,
      'Pedido pelo menu concorrendo com X deve renderizar uma confirmação única.')
    const pendingMenuClose = await page.evaluate(async () => window.standalonePlayer.getSnapshot())
    assert.equal(pendingMenuClose.snapshot.state.pending.length, 1)
    assert.equal(pendingMenuClose.snapshot.state.current.attemptId, playing.state.current.attemptId)
    const mediaBeforeCancel = await playbackHostState(app)
    const mediaDuringCancel = await waitForPlaybackHostTime(app, mediaBeforeCancel.currentTime)
    assert.equal(mediaDuringCancel.paused, false, 'Abrir a confirmação não pode pausar o elemento de vídeo.')
    assert.ok(mediaDuringCancel.currentTime > mediaBeforeCancel.currentTime,
      'O tempo do MP4 real deve avançar enquanto a confirmação está aberta.')
    await page.keyboard.press('Escape')
    await page.locator('#standalone-exit-confirmation').waitFor({ state: 'hidden' })
    writeProgress('menu-x PASS modal cancelled')
    // Cancel from the menu restores the menu; close it before expecting the playback surface to show.
    await page.keyboard.press('Escape')
    await page.locator('#standalone-main-menu').waitFor({ state: 'hidden' })
    await waitForIntegratedPlaybackSurface(app, true)
    const afterCancel = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing' && snapshot.state.pending.length === 1,
    'Cancelar preserva playback e fila sem mutações.')
    assert.equal(afterCancel.state.current.attemptId, playing.state.current.attemptId)
    writeProgress('menu-x PASS cancelled state restored')

    // Use OS-level input; page.keyboard would send Alt+F4 only through Renderer CDP.
    if (process.platform === 'win32') {
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
        win.__nativeCloseEventCount = 0
        win.on('close', () => { win.__nativeCloseEventCount++ })
      })
      writeProgress('alt-f4 START native input')
      let altF4CloseEventCount = 0
      try {
        await sendWindowsNativeAltF4(app)
        writeProgress('alt-f4 INPUT SENT')
        altF4CloseEventCount = await waitForWindowsNativeCloseEvent(app)
      } catch (error) {
        writeProgress(`alt-f4 NOT RUN physical close delivery: ${String(error)}`)
      }
      writeProgress(`alt-f4 physical-browser-window-close-events=${altF4CloseEventCount}`)
      if (app.process().exitCode !== null) {
        throw new Error('Alt+F4 encerrou o processo antes de uma confirmação de saída ser apresentada.')
      }
      if (altF4CloseEventCount === 0) {
        writeProgress('alt-f4 NOT RUN: SendInput não produziu um evento close da BrowserWindow; SC_CLOSE será validado separadamente.')
        await sendWindowsNativeCloseCommand(app)
        const scCloseEventCount = await waitForWindowsNativeCloseEvent(app, 3000)
        writeProgress(`native-sc-close browser-window-event-count=${scCloseEventCount}`)
        assert.equal(scCloseEventCount, 1,
          'WM_SYSCOMMAND/SC_CLOSE deve percorrer exatamente uma vez o close event da BrowserWindow de produção.')
      } else {
        assert.equal(altF4CloseEventCount, 1, 'Alt+F4 deve atingir o close event da BrowserWindow de produção exatamente uma vez.')
      }
    } else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
    // Native close paths may leave the inline video host attached while the
    // Renderer modal is open, so verify the MP4 keeps advancing in that case.
    await waitForExitModalReady(page, app, process.platform !== 'win32')
    const pendingClose = await page.evaluate(async () => window.standalonePlayer.getSnapshot())
    assert.equal(pendingClose.snapshot.state.pending.length, 1, 'O pedido de fechamento não pode alterar a fila.')
    assert.equal(pendingClose.snapshot.state.current.attemptId, playing.state.current.attemptId)
    if (process.platform === 'win32') {
      const nativeCloseMediaBefore = await playbackHostState(app)
      const nativeCloseMediaDuring = await waitForPlaybackHostTime(app, nativeCloseMediaBefore.currentTime)
      assert.equal(nativeCloseMediaDuring.paused, false, 'Um pedido nativo de fechamento não pode pausar o MP4 enquanto o modal está aberto.')
      assert.ok(nativeCloseMediaDuring.currentTime > nativeCloseMediaBefore.currentTime,
        'O MP4 real deve continuar avançando durante a confirmação de fechamento nativa.')
      await page.screenshot({ path: path.join(screenshotRoot, 'c9-production-exit-modal-native-close.png') })
    }
    await page.locator('#exit-confirmation-cancel').click()
    await page.locator('#standalone-exit-confirmation').waitFor({ state: 'hidden' })
    await waitForIntegratedPlaybackSurface(app, true)

    // A real MP4 EOF occurs while the exit modal is open; celebration keeps advancing and Cancel preserves it.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
    await waitForExitModalReady(page, app)
    const mediaDuration = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
      return window.webContents.executeJavaScript(`document.querySelector('#playback-media-layer video').duration`)
    })
    assert.ok(Number.isFinite(mediaDuration) && mediaDuration > 1, 'O MP4 real precisa expor duração para o teste de EOF.')
    await setProductionViewport(app, page, { width: 3840, height: 2160 })
    await app.evaluate(async ({ BrowserWindow }, targetTime) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
      return window.webContents.executeJavaScript(`document.querySelector('#playback-media-layer video').currentTime = ${targetTime}`)
    }, Math.max(0, mediaDuration - 0.12))
    const celebration = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'transitioning' &&
      snapshot.phase === 'celebration',
    'EOF nativo do MP4 precisa iniciar celebração enquanto o modal de saída está aberto.')
    assert.equal(await page.locator('#standalone-exit-confirmation').isVisible(), true)
    const celebrationVisual = await captureResponsiveAuditState(page, screenshotRoot,
      '3840x2160-celebration-exit-modal', 'after', { deferScreenshot: true })
    const celebrationAdvanced = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'transitioning' &&
      snapshot.phase === 'celebration' && snapshot.remainingMs < celebration.remainingMs - 300,
    'A celebração deve continuar avançando durante a confirmação de saída.')
    await page.keyboard.press('Escape')
    await page.locator('#standalone-exit-confirmation').waitFor({ state: 'hidden' })
    const celebrationAfterCancel = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'transitioning' &&
      snapshot.phase === 'celebration' && snapshot.remainingMs <= celebrationAdvanced.remainingMs,
    'Cancelar durante a celebração não pode reiniciar ou pausar seu timer.')
    const nextPlaying = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01001' &&
      snapshot.state.current.attemptId !== playing.state.current.attemptId && snapshot.state.pending.length === 0,
    'A fila pendente deve iniciar depois da celebração sem recriar a entrada já executada.')
    await celebrationVisual.screenshotTask
    assert.ok(celebrationAfterCancel.remainingMs >= 0)
    await setProductionViewport(app, page, { width: 1280, height: 800 })

    // Confirm Sair from the production menu with playback and a queued entry,
    // while a real MP4 EOF races shutdown. The durable result must describe
    // exactly the outcome that Main actually confirmed.
    const queuedForMenuExit = await page.evaluate(async () => window.standalonePlayer.execute({
      operationId: crypto.randomUUID(), command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
    }))
    assert.equal(queuedForMenuExit.outcome, 'confirmed')
    const menuExitQueued = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing' && snapshot.state.pending.length === 1,
    'A confirmação Sair precisa cobrir uma fila pendente sem parar o MP4 ativo.')
    assert.equal(menuExitQueued.state.current.attemptId, nextPlaying.state.current.attemptId)
    await page.keyboard.press('Escape')
    await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
    await page.locator('#menu-item-exit').click()
    await waitForExitModalReady(page, app)
    const menuExitPending = await page.evaluate(async () => window.standalonePlayer.getSnapshot())
    assert.equal(menuExitPending.snapshot.state.pending.length, 1,
      'Abrir a confirmação Sair não pode alterar a fila pendente.')
    assert.equal(menuExitPending.snapshot.state.current.attemptId, menuExitQueued.state.current.attemptId)
    const terminalRaceMedia = await playbackHostState(app)
    assert.ok(Number.isFinite(terminalRaceMedia.duration) && terminalRaceMedia.duration > terminalRaceMedia.currentTime,
      'A segunda tentativa deve continuar reproduzindo o MP4 real antes da corrida EOF/shutdown.')
    const processExit = waitForNativeClose(page, app)
    const raceActions = await Promise.allSettled([
      page.keyboard.press('Enter'),
      app.evaluate(async ({ BrowserWindow }, duration) => {
        const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
        if (!window) throw new Error('O host de playback deve existir para disputar o EOF real com shutdown.')
        return window.webContents.executeJavaScript(`(() => { const video = document.querySelector('#playback-media-layer video'); if (!video || !Number.isFinite(video.duration)) throw new Error('Vídeo sem duração válida para EOF.'); video.currentTime = Math.max(0, video.duration - 0.12); return video.currentTime; })()`)
      }, terminalRaceMedia.duration)
    ])
    assert.equal(raceActions[0].status, 'fulfilled', 'Enter deve confirmar a saída durante a tentativa de EOF real.')
    const exited = await processExit
    assert.equal(exited.signal, null, 'Confirmação deve encerrar normalmente, sem matar o processo.')
    assert.equal(exited.code, 0, 'Saída segura deve finalizar o processo Electron com status zero.')
    app = undefined

    const recoveryPath = path.join(userData, 'player-playback-recovery.json')
    assert.equal(fs.existsSync(recoveryPath), true, 'A recuperação durável deve permanecer após shutdown.')
    const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'))
    assert.ok((recovery.status === 'stopped' && recovery.lastTransition === 'shutdown-confirmed') ||
      (recovery.status === 'completed' && recovery.lastTransition === 'natural-end-confirmed'),
    'A corrida deve persistir exatamente Stop confirmado ou EOF natural real, sem estado terminal artificial.')
    assert.equal(recovery.attemptId, nextPlaying.state.current.attemptId,
      'O shutdown deve encerrar a tentativa que estava realmente tocando; a tentativa anterior teve EOF natural.')
    assert.equal(fs.existsSync(path.join(userData, 'player-music-catalog.sqlite')), true,
      'A persistência SQLite do catálogo deve permanecer após a saída.')
    const { createPlayerMusicCatalogDatabase } = require(path.join(projectRoot, 'build', 'database.js'))
    const persistedCatalog = createPlayerMusicCatalogDatabase(userData)
    try {
      const catalogEntry = persistedCatalog.getMusicCatalogRecordByVideoCode('01001')
      assert.equal(catalogEntry.metadata.recordCount, 1)
      assert.equal(catalogEntry.record?.artist, 'Bon Jovi')
      assert.equal(catalogEntry.record?.title, 'Always')
    } finally { persistedCatalog.close() }
    assert.equal(fs.existsSync(path.join(userData, 'karaoke.sqlite')), false,
      'A composição Standalone não deve criar o SQLite operacional do Combined.')

    // Restart verifies the durable record and confirms shutdown did not autoplay or restore the volatile queue.
    app = await launch()
    page = await waitForStandaloneWindow(app)
    const restarted = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'idle',
    'Reiniciar após saída confirmada deve começar parado, sem fila recuperada nem autoplay.')
    assert.equal(restarted.state.pending.length, 0, 'A sequência volátil não deve persistir para recuperação futura.')

    // A fresh production process exercises repeated native-window mouse/keyboard
    // interaction and a real queued Next without disturbing the C9 assertions above.
    await setProductionViewport(app, page, { width: 1280, height: 800 })
    const focusPlaybackStart = await page.evaluate(async () => window.standalonePlayer.execute({
      operationId: crypto.randomUUID(), command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
    }))
    assert.equal(focusPlaybackStart.outcome, 'confirmed')
    const focusPlaying = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01001',
    'O cenário de foco deve iniciar um MP4 no Main de produção.')
    const focusQueueAdd = await page.evaluate(async () => window.standalonePlayer.execute({
      operationId: crypto.randomUUID(), command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
    }))
    assert.equal(focusQueueAdd.outcome, 'confirmed')
    await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.pending.length === 1,
      'Uma pendência deve existir para validar Próximos e o atalho Avançar.')
    await page.locator('#standalone-queue').waitFor({ state: 'visible' })
    await waitForIntegratedPlaybackSurface(app, true)
    const focusMediaBefore = await playbackHostState(app)
    await clickStandaloneSurface(page, app, 640, 400)
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.press('Space')
    await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'paused',
      'Espaço deve continuar funcionando após o primeiro clique sobre o vídeo.')
    await page.locator('#standalone-paused-indicator').waitFor({ state: 'visible' })
    await clickStandaloneSurface(page, app, 640, 400)
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.press('Space')
    await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'playing',
      'Espaço deve continuar funcionando após cliques sucessivos no vídeo pausado.')
    await page.locator('#standalone-resuming-indicator').waitFor({ state: 'visible' })
    await page.locator('#standalone-resuming-indicator').waitFor({ state: 'hidden' })
    await page.locator('#standalone-queue').waitFor({ state: 'visible' })
    await clickStandaloneSurface(page, app, 640, 400)
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.press('i')
    await page.locator('#standalone-current-track-info').waitFor({ state: 'visible' })
    await page.locator('#standalone-current-track-info').click({ position: { x: 20, y: 20 } })
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.press('Escape')
    await page.locator('#standalone-current-track-info').waitFor({ state: 'hidden' })
    await page.locator('#standalone-queue').waitFor({ state: 'visible' })
    await clickStandaloneSurface(page, app, 640, 400)
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.type('1001')
    await page.locator('#standalone-playing-panel').waitFor({ state: 'visible' })
    await clickStandaloneSurface(page, app, 640, 400)
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.press('Escape')
    await page.locator('#standalone-playing-panel').waitFor({ state: 'hidden' })
    await page.locator('#standalone-queue').waitFor({ state: 'visible' })
    const focusMediaAfterClicks = await waitForPlaybackHostTime(app, focusMediaBefore.currentTime + 0.1)
    assert.ok(focusMediaAfterClicks.currentTime > focusMediaBefore.currentTime,
      'Cliques nos overlays e no vídeo não podem reiniciar, pausar ou congelar o MP4.')

    await clickStandaloneSurface(page, app, 640, 400)
    await assertStandaloneInputFocus(page, app)
    await page.keyboard.press('Control+ArrowRight')
    const focusedNext = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
      snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01001' &&
      snapshot.state.current.attemptId !== focusPlaying.state.current.attemptId && snapshot.state.pending.length === 0,
    'Ctrl+Seta Direita deve avançar a fila depois de cliques sucessivos na janela.')
    const focusMediaBeforeFullscreen = await playbackHostState(app)
    await page.keyboard.press('F11')
    await waitForFullScreen(app, true)
    await page.locator('#player-fullscreen-hint').waitFor({ state: 'visible' })
    const focusFullscreen = await captureComposite(page, app, screenshotRoot,
      'regression-focus-fullscreen-1280x800.png')
    await page.keyboard.press('F11')
    await waitForFullScreen(app, false)
    const focusWindow = await captureComposite(page, app, screenshotRoot,
      'regression-focus-window-after-f11-1280x800.png')
    await page.keyboard.press('F11')
    await waitForFullScreen(app, true)
    await page.keyboard.press('F11')
    await waitForFullScreen(app, false)
    const focusMediaAfterFullscreen = await playbackHostState(app)
    const afterFullscreenSnapshot = await waitForSnapshot(page, snapshot =>
      snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'playing' &&
      snapshot.state.current?.attemptId === focusedNext.state.current.attemptId,
    'Alternâncias F11 devem manter a mesma tentativa de playback após Next.')
    assert.ok(focusMediaAfterFullscreen.currentTime >= focusMediaBeforeFullscreen.currentTime,
      'As alternâncias F11 não podem reiniciar nem retroceder o MP4 da faixa atual.')
    assert.equal(afterFullscreenSnapshot.state.current.attemptId, focusedNext.state.current.attemptId)
    writeProgress(`regression-focus screenshots ${JSON.stringify({ focusFullscreen, focusWindow })}`)

    if (process.platform === 'linux' || process.platform === 'win32') {
      await app.evaluate(({ app }) => {
        setImmediate(() => app.quit())
        return true
      })
      await waitForExitModalReady(page, app)
      assert.equal(await page.locator('#standalone-exit-confirmation').isVisible(), true,
        'Um app.quit programático também deve convergir para a confirmação comum.')
      await page.keyboard.press('Escape')
      await page.locator('#standalone-exit-confirmation').waitFor({ state: 'hidden' })
      assert.equal(app.process().exitCode, null, 'Cancelar um app.quit interceptado deve preservar o processo ativo.')

      // Stop through the approved confirmation flow, then verify the production
      // menu exit while truly idle as well as during active playback above.
      await page.keyboard.press('Control+Space')
      await page.locator('#standalone-stop-confirmation').waitFor({ state: 'visible' })
      await page.locator('#stop-confirmation-confirm').click()
      const stoppedBeforeIdleExit = await waitForSnapshot(page, snapshot =>
        snapshot.playbackCondition === 'ready' && snapshot.state.operationalState === 'idle' && snapshot.state.pending.length === 0,
      'A confirmação Stop All deve deixar o aplicativo ocioso antes do cenário de saída pelo menu.')
      assert.equal(stoppedBeforeIdleExit.state.current, null)
      await page.keyboard.press('Escape')
      await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
      await page.locator('#menu-item-exit').click()
      await waitForExitModalReady(page, app)
      const idleMenuExit = await page.evaluate(async () => window.standalonePlayer.getSnapshot())
      assert.equal(idleMenuExit.snapshot.state.operationalState, 'idle')
      assert.equal(idleMenuExit.snapshot.state.pending.length, 0)
      const idleMenuProcessExit = waitForNativeClose(page, app)
      await page.keyboard.press('Enter').catch(error => {
        if (!/page, context or browser has been closed/i.test(String(error))) throw error
      })
      const idleMenuClosed = await idleMenuProcessExit
      assert.equal(idleMenuClosed.signal, null)
      assert.equal(idleMenuClosed.code, 0, 'Confirmar Sair no menu em estado ocioso deve encerrar normalmente.')
      app = undefined

      // Confirm a fresh OS/window-close request through the same production
      // dialog. On Windows SC_CLOSE is sent to the verified HWND; on Linux the
      // BrowserWindow close event represents the same Electron lifecycle path.
      app = await launch()
      page = await waitForStandaloneWindow(app)
      await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'idle',
      'O app deve iniciar ocioso antes da confirmação do fechamento da janela.')
      if (process.platform === 'win32') await sendWindowsNativeCloseCommand(app)
      else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
      await waitForExitModalReady(page, app)
      assert.equal(await page.locator('#standalone-exit-confirmation').count(), 1,
        'O fechamento da janela deve abrir a confirmação única de produção.')
      const confirmedWindowClose = waitForNativeClose(page, app)
      await page.keyboard.press('Enter').catch(error => {
        if (!/page, context or browser has been closed/i.test(String(error))) throw error
      })
      const confirmedWindowCloseResult = await confirmedWindowClose
      assert.equal(confirmedWindowCloseResult.signal, null)
      assert.equal(confirmedWindowCloseResult.code, 0,
        'Confirmar o fechamento da janela deve executar o shutdown normal de produção.')
      app = undefined

      // C11: enforce the capacity through the production Main/Preload/IPC path,
      // exercise both priorities concurrently, then show one coalesced toast.
      app = await launch()
      page = await waitForStandaloneWindow(app)
      await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'idle',
      'O cenário C11 precisa iniciar com a sequência Standalone vazia.')
      const c11Current = await page.evaluate(async () => window.standalonePlayer.execute({
        operationId: crypto.randomUUID(), command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
      }))
      assert.equal(c11Current.outcome, 'confirmed')
      const c11Playing = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'playing' && snapshot.state.current?.musicCode === '01001',
      'O MP4 deve estar ativo antes de testar a capacidade de pendências.')
      const c11MediaStarted = await waitForPlaybackHostTime(app, 0.1)
      assert.equal(c11MediaStarted.paused, false, 'O relógio do MP4 deve avançar antes do cenário C11.')
      await setProductionViewport(app, page, { width: 1280, height: 800 })
      const c11AdmissionBatch = await page.evaluate(async () => Promise.all(Array.from({ length: 31 }, (_, index) =>
        window.standalonePlayer.execute({
          operationId: crypto.randomUUID(),
          command: { type: 'submit-code', enteredCode: '1001', priority: index % 2 === 0 ? 'normal' : 'priority' }
        }))))
      assert.equal(c11AdmissionBatch.filter(result => result.outcome === 'confirmed').length, 30,
        'O Main de produção deve admitir exatamente 30 pendências mesmo com Enter/P concorrentes.')
      assert.equal(c11AdmissionBatch.filter(result => result.outcome === 'rejected' &&
        result.error.code === 'QUEUE_LIMIT_REACHED').length, 1,
      'A 31ª admissão concorrente deve retornar o resultado tipado de fila cheia.')
      const c11Full = await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'playing' && snapshot.state.pending.length === 30,
      'A sequência de produção deve manter 30 pendências além da música atual.')
      assert.equal(c11Full.state.current.attemptId, c11Playing.state.current.attemptId,
        'Admitir 30 pendências não pode interromper ou substituir a música atual.')
      const c11BeforeRejection = await page.evaluate(async () => window.standalonePlayer.getSnapshot())
      const mediaBeforeLimitToast = await playbackHostState(app)
      for (const [index, key] of ['Enter', 'p', 'Enter'].entries()) {
        if (index > 0) await page.keyboard.press('Escape')
        await page.keyboard.type('1001')
        await page.keyboard.press(key)
        await page.locator('#queue-limit-toast').waitFor({ state: 'visible' })
        assert.equal(await page.locator('#queue-limit-toast').isVisible(), true,
          'O toast de limite deve continuar visível no Renderer de controle até a captura.')
        await waitForIntegratedPlaybackSurface(app, true)
        assert.equal((await page.locator('#queue-limit-toast').textContent())?.trim(),
          'Fila cheia. O limite é de 30 músicas aguardando.')
        assert.equal(await page.locator('#queue-limit-toast').count(), 1,
          'Toasts repetidos substituem o mesmo elemento em vez de se acumularem.')
        assert.equal(await page.locator('#standalone-stop-confirmation').isVisible(), false,
          'Fila cheia informa sem abrir modal ou pedir confirmação.')
        if (index === 0) {
          const c11ToastScreenshot = path.join(screenshotRoot, 'c11-full-queue-toast-1280x800.png')
          const c11ToastElementScreenshot = path.join(screenshotRoot, 'c11-full-queue-toast-element.png')
          await page.screenshot({ path: c11ToastScreenshot })
          await page.locator('#queue-limit-toast').screenshot({ path: c11ToastElementScreenshot })
          writeProgress(`C11 toast screenshot styles=${JSON.stringify(await page.locator('#queue-limit-toast').evaluate(element => ({
            hidden: element.hidden,
            display: getComputedStyle(element).display,
            visibility: getComputedStyle(element).visibility,
            opacity: getComputedStyle(element).opacity,
            rect: element.getBoundingClientRect().toJSON()
          })))}`)
          writeProgress(`C11 full-queue toast screenshot=${c11ToastScreenshot}`)
          writeProgress(`C11 full-queue toast element screenshot=${c11ToastElementScreenshot}`)
        }
      }
      const c11AfterRejection = await page.evaluate(async () => window.standalonePlayer.getSnapshot())
      assert.deepEqual(c11AfterRejection, c11BeforeRejection,
        'Rejeições de Enter/P não podem publicar nem alterar o snapshot confirmado da sequência.')
      // Windows may expose video currentTime only on the next media clock tick;
      // wait for that observable tick instead of sampling immediately after
      // the UI/IPC round trips. This still requires real time advancement.
      const mediaAfterLimitToast = await waitForPlaybackHostTime(app, mediaBeforeLimitToast.currentTime + 0.1)
      writeProgress(`C11 MP4 advanced during full-queue feedback from=${mediaBeforeLimitToast.currentTime} to=${mediaAfterLimitToast.currentTime}`)
      assert.equal(mediaAfterLimitToast.paused, false, 'A música atual continua reproduzindo após rejeições de capacidade.')
      assert.ok(mediaAfterLimitToast.currentTime > mediaBeforeLimitToast.currentTime,
        'O tempo do MP4 continua avançando durante o feedback de fila cheia.')

      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
      const c11BeforeExit = await page.evaluate(async () => window.standalonePlayer.getSnapshot())
      assert.equal(c11BeforeExit.snapshot.state.pending.length, 30)
      await page.locator('#menu-item-exit').click()
      await waitForExitModalReady(page, app)
      const c11FullQueueExit = waitForNativeClose(page, app)
      await page.keyboard.press('Enter').catch(error => {
        if (!/page, context or browser has been closed/i.test(String(error))) throw error
      })
      const c11FullQueueExitResult = await c11FullQueueExit
      assert.equal(c11FullQueueExitResult.signal, null)
      assert.equal(c11FullQueueExitResult.code, 0, 'Shutdown C9 deve concluir com a fila C11 cheia.')
      app = undefined
      const c11ShutdownRecovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'))
      assert.equal(c11ShutdownRecovery.status, 'stopped')
      assert.equal(c11ShutdownRecovery.lastTransition, 'shutdown-confirmed')
      assert.equal(c11ShutdownRecovery.attemptId, c11Playing.state.current.attemptId)
      assert.notEqual(c11ShutdownRecovery.lastTransition, 'natural-end-confirmed',
        'Encerrar com fila cheia não pode fabricar EOF.')

      app = await launch()
      page = await waitForStandaloneWindow(app)
      await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'idle',
      'O novo processo deve iniciar ocioso antes dos cenários de recovery.')

      // Crash the real video host so Main has a durable uncertain recovery record.
      const recoveryBeforeHostCrash = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'))
      const startAfterRestart = await page.evaluate(async () => window.standalonePlayer.execute({
        operationId: crypto.randomUUID(), command: { type: 'submit-code', enteredCode: '1001', priority: 'normal' }
      }))
      assert.equal(startAfterRestart.outcome, 'confirmed')
      await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'playing', 'O MP4 real precisa iniciar antes do crash controlado do host.')
      await app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
        if (!window) throw new Error('A superfície de playback deve existir antes do crash do compositor Standalone.')
        const gone = new Promise(resolve => window.webContents.once('render-process-gone', resolve))
        window.webContents.forcefullyCrashRenderer()
        await gone
      })
      const uncertain = await waitForRecoveryRecord(recoveryPath, record => record.status === 'uncertain',
        'A perda do host real precisa ser registrada como recovery incerto, sem EOF.')
      assert.equal(uncertain.status, 'uncertain')
      assert.equal(uncertain.lastTransition, 'host-terminated')
      assert.notEqual(uncertain.lastTransition, 'natural-end-confirmed')
      assert.ok(uncertain.revision > recoveryBeforeHostCrash.revision)

      // Crash the Standalone Renderer and exercise the actual platform-native fallback.
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
        if (!win || !win.webContents.isCrashed()) {
          throw new Error('A mesma WebContents de produção que hospedou o vídeo também deve ser o Renderer Standalone encerrado.')
        }
        win.close()
      })
      if (process.platform === 'win32') await respondToWindowsNativeExitDialog(app, 'Cancelar')
      else {
        await waitForLinuxNativeExitDialog(true)
        sendLinuxNativeKeys('Escape')
        await waitForLinuxNativeExitDialog(false)
      }
      assert.equal(app.process().exitCode, null, 'Cancelar no fallback nativo precisa manter o processo aberto.')
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('standalone-player.html'))
        if (!win || !win.webContents.isCrashed()) throw new Error('O teste precisa manter o Renderer indisponível após Cancelar.')
        win.close()
      })
      const uncertainProcessExit = waitForNativeClose(page, app)
      if (process.platform === 'win32') await respondToWindowsNativeExitDialog(app, 'Sair do aplicativo')
      else {
        await waitForLinuxNativeExitDialog(true)
        sendLinuxNativeKeys('Tab', 'Return')
      }
      const uncertainExited = await uncertainProcessExit
      assert.equal(uncertainExited.signal, null)
      assert.equal(uncertainExited.code, 0, 'Confirmação pelo fallback nativo precisa completar o shutdown ordenado.')
      app = undefined
      const preservedUncertain = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'))
      assert.equal(preservedUncertain.status, 'uncertain', 'O shutdown não pode descartar ou resolver falsamente recovery incerto.')
      assert.equal(preservedUncertain.lastTransition, 'host-terminated')
      assert.equal(preservedUncertain.attemptId, uncertain.attemptId)
      assert.notEqual(preservedUncertain.lastTransition, 'natural-end-confirmed', 'O crash não pode fabricar EOF.')
    } else {
      await page.keyboard.press('Escape')
      await page.locator('#standalone-main-menu').waitFor({ state: 'visible' })
      await page.locator('#menu-item-exit').click()
      await waitForExitModalReady(page, app)
      const restartExit = waitForNativeClose(page, app)
      await page.keyboard.press('Enter').catch(error => {
        if (!/page, context or browser has been closed/i.test(String(error))) throw error
      })
      await restartExit
      app = undefined

      // Run app.quit last in a fresh production process. Playwright's Main CDP
      // evaluation may remain pending until the Renderer settles before-quit;
      // no later Main-side calls should depend on that evaluation completing.
      app = await launch()
      page = await waitForStandaloneWindow(app)
      await waitForSnapshot(page, snapshot => snapshot.playbackCondition === 'ready' &&
        snapshot.state.operationalState === 'idle',
      'O processo isolado para app.quit deve iniciar sem autoplay.')
      void app.evaluate(({ app }) => {
        setImmediate(() => app.quit())
        return true
      }).catch(() => {})
      await waitForExitModalReady(page, app, false)
      assert.equal(await page.locator('#standalone-exit-confirmation').isVisible(), true,
        'Um app.quit programático também deve convergir para a confirmação comum.')
      await page.keyboard.press('Escape')
      await page.locator('#standalone-exit-confirmation').waitFor({ state: 'hidden' })
      assert.equal(app.process().exitCode, null, 'Cancelar um app.quit interceptado precisa preservar o processo.')

      // Finish this last Windows process through the ordinary window-close
      // event so the runner can verify process cleanup after the cancellation.
      const appQuitExit = waitForNativeClose(page, app)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find(candidate => candidate.webContents.getURL().includes('standalone-player.html')).close())
      await waitForExitModalReady(page, app, false)
      await page.keyboard.press('Enter').catch(error => {
        if (!/page, context or browser has been closed/i.test(String(error))) throw error
      })
      const appQuitClosed = await appQuitExit
      assert.equal(appQuitClosed.signal, null)
      assert.equal(appQuitClosed.code, 0, 'Confirmar a saída após cancelar app.quit deve encerrar o processo Windows.')
      app = undefined
    }
    await assertNoLinuxElectronProcesses(profileRoot)
    process.stdout.write(`PASS Standalone production Electron C9 lifecycle; screenshots=${screenshotRoot}\n`)
  } finally {
    if (app) {
      writeProgress('cleanup START stop isolated Electron')
      await stopFailedIsolatedApp(app)
      writeProgress('cleanup PASS isolated Electron stopped')
    }
    if (!profileRootOverride && fs.existsSync(profileRoot)) {
      await assertNoWindowsElectronProcesses(profileRoot)
      fs.rmSync(profileRoot, { recursive: true, force: true })
    }
  }
}

run().catch(error => {
  const errorName = error?.name || 'Error'
  if (activeF0EvidenceWriter && activeF0LogPath && fs.existsSync(activeF0LogPath)) {
    const aggregateMetrics = readF0LogRecords(activeF0LogPath)
      .filter(record => record.event?.startsWith('F0_'))
      .map(record => ({ event: record.event, timestamp: record.timestamp, details: record.details }))
    activeF0EvidenceWriter('diagnostic-metrics-at-failure', aggregateMetrics.length ? 'COLLECTED' : 'NONE', {
      stage: activeF0EvidenceStage, records: aggregateMetrics
    })
  }
  activeF0EvidenceWriter?.('T2+T4-run', 'FAIL', { stage: activeF0EvidenceStage, errorType: errorName })
  let message = String(error?.message || error)
  if (mediaRoot) {
    const escapedRoot = mediaRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    message = message.replace(new RegExp(escapedRoot + '[^\\r\\n]*', 'gi'), '[BIBLIOTECA_REAL]')
  }
  message = message.replace(/\b\d{5}[^\\/:\r\n]*\.mp4\b/gi, '[ARQUIVO_MP4]')
  writeProgress(`RUN FAIL ${errorName}`)
  process.stderr.write(`${errorName}: ${message.split('\n')[0]}\n`)
  process.exitCode = 1
})
