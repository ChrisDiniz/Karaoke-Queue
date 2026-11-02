#!/usr/bin/env node
'use strict'

// Run from the snapshot-verified native Windows checkout using its Electron
// and Playwright installs. KQ_P5B_MEDIA_DIR is required; KQ_P5B_MPV_EXE is
// optional and used only by the historical side-by-side evaluation mode.
// The harness creates only temporary Electron files and never writes to media.

const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn, spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')

const MP4_EXTENSION = '.mp4'
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\kq-p5b-'
const SAMPLE_LIMIT = 2
const PLAYBACK_OBSERVATION_MS = 4500
const OPERATION_TIMEOUT_MS = 15000
let mpvAttemptSequence = 0

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function parseSampleCode(fileName) {
  if (typeof fileName !== 'string') return null
  const match = /^(\d{5})(?:$|[\s._-])/.exec(path.parse(fileName).name)
  return match ? match[1] : null
}

function hashIsValid(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function fullscreenStatus(windowTransition, videoCapture) {
  if (windowTransition !== true) return 'FAIL'
  if (!videoCapture || videoCapture.status !== 'OBSERVED_CHANGING_FRAMES' || videoCapture.distinctFrameHashes < 2) {
    return 'NOT_VERIFIED'
  }
  return 'PASS'
}

function publicSampleSummary(sample) {
  return {
    code: sample.code,
    fileName: sample.fileName,
    sourceSha256: sample.sourceHash,
    sizeBytes: sample.size,
    modifiedAtMs: sample.originalMtimeMs
  }
}

function publicMpvEvent(event) {
  const result = {
    event: event.event,
    eventNumber: event.eventNumber,
    playlist_entry_id: event.playlist_entry_id,
    reason: event.reason
  }
  if (event.event === 'property-change' && event.id !== 4) {
    result.propertyId = event.id
    result.data = event.data
  }
  return result
}

function compactMpvEvents(events, limit = 80) {
  // time-pos and the 21-file scan generate thousands of observations. Keep
  // enough lifecycle records to show startup, replacement, stop, EOF, errors,
  // and the final interrupted attempt without serializing scan noise.
  const lastEntryId = events.reduce((last, event) =>
    Number.isInteger(event.playlist_entry_id) ? Math.max(last, event.playlist_entry_id) : last, 0)
  const importantEntries = new Set([1, 2, 3, 4, 5, 6, lastEntryId])
  return events.filter(event => {
    if (event.event === 'property-change') return event.id === 1 || event.id === 5
    if (!['start-file', 'file-loaded', 'playback-restart', 'end-file', 'shutdown'].includes(event.event)) return false
    return importantEntries.has(event.playlist_entry_id) || event.reason === 'eof' || event.reason === 'error'
  }).slice(-limit).map(publicMpvEvent)
}

function redactLocalPaths(value) {
  return String(value)
    // When a path begins, redact to end-of-line so spaces in user/profile and
    // media names cannot leave a private suffix visible in diagnostics.
    .replace(/file:\/\/\/[^\r\n]*/gi, '<local-file-url>')
    .replace(/\\\\[^\r\n]+/g, '<local-unc-path>')
    .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, '<local-drive-path>')
    .replace(/(?:\/home\/|\/tmp\/|\/mnt\/|\/Users\/)[^\r\n]*/g, '<local-posix-path>')
}

function redactDiagnostic(value, depth = 0) {
  if (typeof value === 'string') return redactLocalPaths(value).slice(0, 1000)
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactDiagnostic(item, depth + 1))
  if (!value || typeof value !== 'object' || depth >= 5) return value
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, redactDiagnostic(item, depth + 1)]))
}

function compactSampleDecoding(samples, summary, engine) {
  const records = Array.isArray(samples) ? samples : []
  return {
    tested: records.length,
    summary: summary === undefined ? null : summary,
    results: records.map(sample => {
      if (engine === 'chromium') {
        return { code: sample.code, status: sample.status, width: sample.width || null, height: sample.height || null }
      }
      return {
        code: sample.code,
        loaded: Boolean(sample.loaded),
        videoStatus: sample.videoStatus,
        video: sample.video ? { width: sample.video.width, height: sample.video.height, codec: sample.video.codec || null } : null,
        audioStatus: sample.audioStatus,
        audio: sample.audio ? { format: sample.audio.format, channels: sample.audio.channels,
          sampleRate: sample.audio.sampleRate, codec: sample.audio.codec || null } : null
      }
    })
  }
}

function compactChromiumEvents(events, limit = 100) {
  const lifecycleMediaEvents = new Set(['loadedmetadata', 'playing', 'pause', 'seeked', 'emptied', 'ended', 'error'])
  return events
    .filter(event => {
      if (!event || typeof event !== 'object') return false
      if (event.type !== 'renderer-event') {
        return ['electron-harness-ready', 'electron-fullscreen-enter', 'electron-fullscreen-exit',
          'electron-renderer-gone', 'electron-player-window-closed', 'electron-before-quit'].includes(event.type)
      }
      const details = event.details || {}
      if (!lifecycleMediaEvents.has(details.type)) return false
      // Every sample is counted in sampleDecodingSummary; event evidence is
      // limited to the first control sequence plus terminal events.
      return details.type === 'ended' || details.type === 'error' ||
        !Number.isInteger(details.data && details.data.attempt) || details.data.attempt <= 2
    })
    .slice(-limit)
    .map(event => {
      if (event.type !== 'renderer-event') {
        return { type: event.type, at: event.at, details: redactDiagnostic(event.details) }
      }
      const details = event.details || {}
      const data = details.data && typeof details.data === 'object' ? details.data : {}
      const safeData = {}
      for (const key of ['currentTime', 'playbackRate', 'duration', 'videoWidth', 'videoHeight', 'readyState', 'errorCode', 'attempt']) {
        if (typeof data[key] === 'number' || typeof data[key] === 'string' && data[key].length <= 80) safeData[key] = data[key]
      }
      return {
        type: event.type,
        at: event.at,
        details: {
          type: details.type,
          code: details.code,
          ...(Object.keys(safeData).length ? { data: safeData } : {})
        }
      }
    })
}

function timeoutError(label, timeoutMs) {
  return new Error(`${label} did not complete within ${timeoutMs} ms`)
}

function withTimeout(promise, label, timeoutMs = OPERATION_TIMEOUT_MS) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function pollUntil(readValue, predicate, label, timeoutMs = OPERATION_TIMEOUT_MS) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await readValue()
    if (predicate(value)) return value
    await delay(50)
  }
  throw timeoutError(label, timeoutMs)
}

function assertWindowsPath(value, label) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute Windows path`)
  }
  return value
}

function assertLocalWindowsPath(value, label) {
  const absolute = assertWindowsPath(value, label)
  if (!/^[a-zA-Z]:[\\/]/.test(absolute)) throw new Error(`${label} must be a local Windows drive path`)
  return absolute
}

function listSamples(mediaRoot) {
  const configuredStats = fs.lstatSync(mediaRoot)
  if (!configuredStats.isDirectory() || configuredStats.isSymbolicLink()) {
    throw new Error('Media root must be a regular directory, not a symlink or reparse point')
  }
  const root = fs.realpathSync(mediaRoot)
  const rootStats = fs.lstatSync(root)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Media root must be a regular directory')

  const samples = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === MP4_EXTENSION)
    .map(entry => {
      const code = parseSampleCode(entry.name)
      if (!code) return null
      const sourcePath = path.join(root, entry.name)
      const stat = fs.lstatSync(sourcePath)
      if (!stat.isFile() || stat.isSymbolicLink()) return null
      return { code, sourcePath, size: stat.size, modifiedAt: stat.mtimeMs }
    })
    .filter(Boolean)
    .sort((left, right) => left.code.localeCompare(right.code) || left.sourcePath.localeCompare(right.sourcePath))

  const unique = []
  const seen = new Set()
  const duplicateCodes = new Set()
  for (const sample of samples) {
    if (seen.has(sample.code)) {
      duplicateCodes.add(sample.code)
      continue
    }
    seen.add(sample.code)
    unique.push(sample)
  }
  if (duplicateCodes.size) throw new Error(`Sample directory has duplicate coded videos: ${Array.from(duplicateCodes).sort().join(', ')}`)
  if (!unique.length) throw new Error('No top-level MP4 sample with a five-digit filename prefix was found')
  return { root, samples: unique, discoveredCount: unique.length }
}

function describeSamples(samples) {
  // The operator-supplied NTFS directory is an input-only source. Do not copy
  // hundreds of megabytes just to run the isolated harness.
  return samples.map((sample, index) => {
    const before = fs.statSync(sample.sourcePath)
    const sourceHash = index < SAMPLE_LIMIT ? sha256(sample.sourcePath) : null
    const after = fs.statSync(sample.sourcePath)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`Original sample changed while hashing code ${sample.code}`)
    }
    return {
      code: sample.code,
      fileName: path.basename(sample.sourcePath),
      sourcePath: sample.sourcePath,
      fileUrl: pathToFileURL(sample.sourcePath).href,
      sourceHash,
      size: before.size,
      originalMtimeMs: before.mtimeMs
    }
  })
}

function createReport(mediaInfo) {
  return {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      nodeVersion: process.version,
      architecture: process.arch,
      electronVersion: null,
      chromiumVersion: null,
      displays: null
    },
    samples: {
      discoveredMp4Count: mediaInfo.discoveredCount,
      interactiveCodes: [],
      staged: [],
      integrityCheckedCodes: [],
      originalsUnchanged: 'NOT_VERIFIED'
    },
    chromium: emptyEngineReport(),
    mpv: emptyEngineReport(),
    measurements: {
      visibleVideo: 'NOT_VERIFIED',
      systemAudioLoopback: 'NOT_VERIFIED',
      audioVideoSynchronization: 'NOT_VERIFIED',
      multiMonitor: 'NOT_VERIFIED'
    },
    cleanup: { status: 'PENDING', residualMpvProcesses: null },
    failures: [],
    status: 'INCOMPLETE'
  }
}

function emptyEngineReport() {
  return {
    status: 'NOT_RUN',
    version: null,
    versionOutput: null,
    executableSha256: null,
    controls: {},
    events: [],
    visibleVideo: { status: 'NOT_VERIFIED' },
    systemAudioLoopback: { status: 'NOT_VERIFIED' },
    audioVideoSynchronization: { status: 'NOT_VERIFIED' },
    fullscreen: { status: 'NOT_VERIFIED' },
    unexpectedTermination: { status: 'NOT_RUN' },
    rendererCrash: { status: 'NOT_RUN' },
    hostProcessTermination: { status: 'NOT_RUN' },
    playbackStartupMs: null,
    resourceSamples: [],
    processTermination: { status: 'NOT_VERIFIED' }
  }
}

function appendFailure(report, engine, step, error) {
  const entry = { engine, step, message: redactLocalPaths(String(error && error.message ? error.message : error)).slice(0, 500) }
  report.failures.push(entry)
  if (engine && report[engine]) {
    report[engine].status = 'FAIL'
    report[engine].failures ||= []
    report[engine].failures.push(entry)
  }
}

function generatedMainSource() {
  return String.raw`'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, desktopCapturer, ipcMain, session, screen } = require('electron')

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
app.setPath('userData', config.userDataPath)
let captureTargetTitle = config.electronPlayerTitle
let playerWindow
let observerWindow

function recordMainEvent(type, details = {}) {
  const event = { type, at: Date.now(), details }
  global.__kqP5b.events.push(event)
  fs.appendFileSync(config.eventLogPath, JSON.stringify(event) + '\n')
}

function attachRendererDiagnostics(targetWindow, name) {
  const contents = targetWindow.webContents
  contents.on('console-message', (_event, ...args) => {
    const details = args[0]
    const message = typeof details === 'string' ? details :
      details && typeof details.message === 'string' ? details.message :
        typeof args[1] === 'string' ? args[1] : ''
    const level = details && typeof details === 'object' ? details.level : details
    recordMainEvent('renderer-console', {
      window: name,
      level,
      message: String(message || '').replace(/[A-Z]:\\[^\s)]+/g, '<local-path>').slice(0, 300)
    })
  })
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    recordMainEvent('renderer-load-failed', { window: name, errorCode, errorDescription: String(errorDescription).slice(0, 200), isMainFrame })
  })
  contents.on('did-finish-load', () => {
    contents.executeJavaScript('JSON.stringify({title:document.title,readyState:document.readyState,playerApi:Boolean(window.__kqP5b),observerApi:Boolean(window.__kqP5bObserver),scriptNames:Array.from(document.scripts,script=>{try{return new URL(script.src).pathname.split("/").pop()}catch{return "<inline>"}})})')
      .then(state => recordMainEvent('renderer-api-state', { window: name, state: JSON.parse(state) }))
      .catch(error => recordMainEvent('renderer-api-state-error', { window: name, message: String(error && error.message || error).slice(0, 200) }))
  })
}

global.__kqP5b = {
  setCaptureTarget(title) { captureTargetTitle = title },
  setPlayerFullscreen(value) {
    if (!playerWindow || playerWindow.isDestroyed()) return false
    playerWindow.setFullScreen(Boolean(value))
    return true
  },
  crashPlayerRenderer() {
    if (!playerWindow || playerWindow.isDestroyed()) return false
    playerWindow.webContents.forcefullyCrashRenderer()
    return true
  },
  events: [],
  getWindowState() {
    return {
      player: playerWindow && !playerWindow.isDestroyed() ? {
        title: playerWindow.getTitle(),
        bounds: playerWindow.getBounds(),
        visible: playerWindow.isVisible(),
        fullScreen: playerWindow.isFullScreen(),
        focused: playerWindow.isFocused()
      } : null,
      observer: observerWindow && !observerWindow.isDestroyed() ? {
        title: observerWindow.getTitle(),
        bounds: observerWindow.getBounds(),
        visible: observerWindow.isVisible()
      } : null
    }
  },
  async listCaptureSources() {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } })
    return sources.map(source => ({ id: source.id, name: source.name }))
  }
}

app.whenReady().then(async () => {
  if (config.showObserver) {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } })
        const source = sources.find(candidate => candidate.name === captureTargetTitle)
        if (!source) {
          recordMainEvent('capture-source-not-found', { candidates: sources.length })
          callback(null)
          return
        }
        callback({ video: source, audio: 'loopback' })
      } catch (error) {
        recordMainEvent('capture-source-error', { message: String(error && error.message || error).slice(0, 200) })
        callback(null)
      }
    })
  }

  playerWindow = new BrowserWindow({
    title: config.electronPlayerTitle,
    width: config.windowWidth,
    height: config.windowHeight,
    x: config.windowX,
    y: config.windowY,
    show: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  playerWindow.on('closed', () => recordMainEvent('electron-player-window-closed'))
  playerWindow.on('enter-full-screen', () => recordMainEvent('electron-fullscreen-enter'))
  playerWindow.on('leave-full-screen', () => recordMainEvent('electron-fullscreen-exit'))
  attachRendererDiagnostics(playerWindow, 'player')
  playerWindow.webContents.on('render-process-gone', (_event, details) => recordMainEvent('electron-renderer-gone', {
    reason: details.reason,
    exitCode: details.exitCode
  }))
  await playerWindow.loadFile(path.join(__dirname, 'player.html'))

  if (config.showObserver) {
    observerWindow = new BrowserWindow({
      title: config.observerTitle,
      width: 480,
      height: 300,
      x: config.observerX,
      y: config.observerY,
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    observerWindow.on('closed', () => recordMainEvent('electron-observer-window-closed'))
    attachRendererDiagnostics(observerWindow, 'observer')
    await observerWindow.loadFile(path.join(__dirname, 'observer.html'))
  }

  ipcMain.on('kq-p5b-event', (_event, payload) => {
    if (!payload || typeof payload.type !== 'string') return
    recordMainEvent('renderer-event', {
      type: payload.type.slice(0, 80),
      code: typeof payload.code === 'string' ? payload.code.slice(0, 5) : undefined,
      data: payload.data && typeof payload.data === 'object' ? payload.data : undefined
    })
  })
  ipcMain.on('kq-p5b-toggle-player-fullscreen', event => {
    if (config.interactiveMode !== true || !playerWindow || playerWindow.isDestroyed() ||
        event.sender !== playerWindow.webContents) return
    playerWindow.setFullScreen(!playerWindow.isFullScreen())
  })
  recordMainEvent('electron-harness-ready', {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    displays: screen.getAllDisplays().length,
    userDataIsolated: app.getPath('userData') === config.userDataPath
  })
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => recordMainEvent('electron-before-quit'))
`
}

function generatedPreloadSource() {
  return String.raw`'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('kqP5bHarness', {
  report: (type, data) => ipcRenderer.send('kq-p5b-event', { type, data }),
  togglePlayerFullscreen: () => ipcRenderer.send('kq-p5b-toggle-player-fullscreen')
})
`
}

function generatedPlayerHtml(interactiveMode = false) {
  const controls = interactiveMode
    ? '<select id="sample" aria-label="Video sample"></select><button id="play">Play selected</button><button id="pause">Pause</button><button id="resume">Resume</button><button id="restart">Restart</button><button id="stop">Stop</button><button id="fullscreen">Fullscreen</button><span id="status">Choose a sample and press Play selected</span>'
    : '<button id="play">Play</button><button id="pause">Pause</button><button id="resume">Resume</button><button id="restart">Restart</button><button id="stop">Stop</button><span id="status">ready</span>'
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' file:; media-src 'self' file:; script-src 'self' file:; style-src 'self' 'unsafe-inline'"><title>Karaoke Queue playback evaluation</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff;font:14px sans-serif}video{width:100%;height:calc(100% - 58px);object-fit:contain;background:#000}nav{height:58px;display:flex;gap:8px;align-items:center;padding:0 10px;background:#151515}button,select{font:inherit}#status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style></head>
<body><video id="media" playsinline></video><nav>${controls}</nav><script src="player.js"></script></body></html>`
}

function generatedPlayerScript(stagedSamples, invalidFileUrl, interactiveMode = false) {
  const mapping = Object.fromEntries(stagedSamples.map(sample => [sample.code, sample.fileUrl]))
  const fileNames = Object.fromEntries(stagedSamples.map(sample => [sample.code, sample.fileName]))
  return `'use strict';
(() => {
  const media = document.getElementById('media')
  const status = document.getElementById('status')
  const files = ${JSON.stringify(mapping)}
  const fileNames = ${JSON.stringify(fileNames)}
  const interactiveMode = ${JSON.stringify(interactiveMode)}
  const invalidURL = ${JSON.stringify(invalidFileUrl)}
  const events = []
  let frameCount = 0
  let currentCode = null
  let attempt = 0
  let activeIntent = 'play'
  let scheduledFrameAttempt = null
  function report(type, data = {}) {
    const event = { type, at: performance.now(), code: currentCode, attempt, intent: activeIntent, ...data }
    events.push(event)
    window.kqP5bHarness.report(type, event)
    status.textContent = type === 'timeupdate'
      ? (currentCode || 'No sample') + '  ' + media.currentTime.toFixed(1) + ' / ' + (Number.isFinite(media.duration) ? media.duration.toFixed(1) : '--') + ' s'
      : type
  }
  function frame(now, metadata, frameCode, frameAttempt) {
    frameCount++
    if (frameCount <= 1 || frameCount % 30 === 0) report('video-frame', {
      frameCount,
      mediaTime: Number(metadata.mediaTime.toFixed(3)),
      presentedFrames: metadata.presentedFrames,
      code: frameCode,
      attempt: frameAttempt
    })
    if (frameAttempt !== attempt) {
      scheduledFrameAttempt = null
      beginFrameLoop()
    } else if (!media.paused && !media.ended) {
      media.requestVideoFrameCallback((nextNow, nextMetadata) => frame(nextNow, nextMetadata, frameCode, frameAttempt))
    } else {
      scheduledFrameAttempt = null
    }
  }
  function beginFrameLoop() {
    if (media.paused || media.ended || !currentCode || scheduledFrameAttempt === attempt) return
    const frameCode = currentCode
    const frameAttempt = attempt
    scheduledFrameAttempt = frameAttempt
    media.requestVideoFrameCallback((now, metadata) => frame(now, metadata, frameCode, frameAttempt))
  }
  for (const name of ['loadedmetadata','loadeddata','canplay','playing','pause','waiting','stalled','seeking','seeked','emptied','ended','error','timeupdate']) {
    media.addEventListener(name, event => report(name, {
      currentTime: Number(media.currentTime.toFixed(3)),
      playbackRate: media.playbackRate,
      duration: Number.isFinite(media.duration) ? Number(media.duration.toFixed(3)) : null,
      videoWidth: media.videoWidth,
      videoHeight: media.videoHeight,
      readyState: media.readyState,
      errorCode: media.error && media.error.code,
      errorMessage: media.error && media.error.message,
      eventType: event.type
    }))
  }
  media.volume = interactiveMode ? 1 : 0.3
  media.addEventListener('playing', beginFrameLoop)
  window.__kqP5b = {
    get events() { return events.slice() },
    get state() { return {
      code: currentCode,
      attempt,
      paused: media.paused,
      ended: media.ended,
      currentTime: media.currentTime,
      playbackRate: media.playbackRate,
      duration: media.duration,
      width: media.videoWidth,
      height: media.videoHeight,
      readyState: media.readyState,
      errorCode: media.error && media.error.code,
      frameCount
    } },
    async load(code, intent = 'play') {
      if (!Object.hasOwn(files, code)) throw new Error('Unknown sequence code')
      currentCode = code
      attempt++
      activeIntent = intent
      media.pause()
      media.src = files[code]
      media.load()
      report('load-requested', { code, source: 'staged-code-only' })
    },
    async loadAndPlay(code) {
      const loaded = new Promise((resolve, reject) => {
        let timer
        const cleanup = () => {
          clearTimeout(timer)
          media.removeEventListener('loadedmetadata', onLoaded)
          media.removeEventListener('error', onError)
        }
        const onLoaded = () => { cleanup(); resolve() }
        const onError = () => { cleanup(); reject(new Error('The selected video could not be loaded')) }
        media.addEventListener('loadedmetadata', onLoaded, { once: true })
        media.addEventListener('error', onError, { once: true })
        timer = setTimeout(() => { cleanup(); reject(new Error('The selected video did not load within 15 seconds')) }, 15000)
      })
      await this.load(code, 'manual-selection')
      await loaded
      return this.play()
    },
    loadInvalid() {
      currentCode = null
      attempt++
      activeIntent = 'invalid-media-test'
      media.src = invalidURL
      media.load()
      report('invalid-load-requested', { source: 'isolated-empty-test-file' })
    },
    async play() {
      activeIntent = 'play'
      await media.play()
      return this.state
    },
    pause() { activeIntent = 'pause'; media.pause(); return this.state },
    async resume() { activeIntent = 'resume'; await media.play(); return this.state },
    async restart() {
      activeIntent = 'restart'
      attempt++
      media.currentTime = 0
      await media.play()
      return this.state
    },
    stop() {
      activeIntent = 'stop'
      media.pause()
      media.removeAttribute('src')
      media.load()
      return this.state
    },
    setRate(value) { media.playbackRate = value; return media.playbackRate }
  }
  document.getElementById('pause').addEventListener('click', () => window.__kqP5b.pause())
  document.getElementById('resume').addEventListener('click', () => window.__kqP5b.resume().catch(error => report('resume-error', { message: error.message })))
  document.getElementById('restart').addEventListener('click', () => window.__kqP5b.restart().catch(error => report('restart-error', { message: error.message })))
  document.getElementById('stop').addEventListener('click', () => window.__kqP5b.stop())
  if (interactiveMode) {
    const select = document.getElementById('sample')
    for (const [code, fileName] of Object.entries(fileNames)) {
      const option = document.createElement('option')
      option.value = code
      option.textContent = code + ' — ' + fileName
      select.appendChild(option)
    }
    document.getElementById('play').addEventListener('click', () => {
      window.__kqP5b.loadAndPlay(select.value).catch(error => report('play-error', { message: error.message }))
    })
    document.getElementById('fullscreen').addEventListener('click', () => window.kqP5bHarness.togglePlayerFullscreen())
  } else {
    document.getElementById('play').addEventListener('click', () => window.__kqP5b.play().catch(error => report('play-error', { message: error.message })))
  }
  report('harness-ready')
})()
`
}

function generatedObserverHtml() {
  return String.raw`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' file:; media-src 'self' file: blob:; script-src 'self' file: 'unsafe-inline'; style-src 'self' 'unsafe-inline'"><title>Karaoke Queue playback capture observer</title><style>body{font:13px sans-serif;background:#161616;color:#eee;margin:8px}video{width:100%;height:180px;background:#000;object-fit:contain}pre{white-space:pre-wrap}</style></head><body><strong>Isolated playback capture observer</strong><button id="capture">Capture video and system audio</button><video id="preview" autoplay muted></video><pre id="result" data-ready="false">idle</pre><script src="observer.js"></script></body></html>`
}

function generatedObserverScript() {
  return String.raw`'use strict';
(() => {
  const preview = document.getElementById('preview')
  const result = document.getElementById('result')
  let stream
  let audioContext
  let analyser
  let source
  window.__kqP5bObserver = {
    async measure(durationMs = 4500) {
      const report = {
        status: 'NOT_VERIFIED',
        requestedDurationMs: durationMs,
        elapsedMs: null,
        videoTrackState: null,
        videoTrackSettings: null,
        observedFrames: 0,
        distinctFrameHashes: 0,
        audioTrackState: null,
        nonZeroAudioSamples: 0,
        maxAbsAudioSample: 0,
        rmsAudioSample: 0,
        audioSampleCount: 0,
        captureError: null
      }
      try {
        let captureTimedOut = false
        let captureTimer
        const captureRequest = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(capturedStream => {
          if (captureTimedOut) for (const track of capturedStream.getTracks()) track.stop()
          return capturedStream
        })
        const captureDeadline = new Promise((_, reject) => {
          captureTimer = setTimeout(() => {
            captureTimedOut = true
            reject(new Error('Windows display capture did not resolve within 10 seconds'))
          }, 10000)
        })
        try {
        stream = await Promise.race([captureRequest, captureDeadline])
        } finally {
          clearTimeout(captureTimer)
        }
        const videoTrack = stream.getVideoTracks()[0]
        const audioTrack = stream.getAudioTracks()[0]
        report.videoTrackState = videoTrack && videoTrack.readyState
        report.videoTrackSettings = videoTrack && videoTrack.getSettings()
        report.audioTrackState = audioTrack && audioTrack.readyState
        preview.srcObject = stream
        await preview.play()
        const canvas = document.createElement('canvas')
        canvas.width = 48
        canvas.height = 27
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        const hashes = new Set()
        if (audioTrack) {
          audioContext = new AudioContext()
          analyser = audioContext.createAnalyser()
          analyser.fftSize = 2048
          source = audioContext.createMediaStreamSource(stream)
          source.connect(analyser)
        }
        const audio = audioTrack ? new Float32Array(analyser.fftSize) : null
        const startedAt = performance.now()
        while (performance.now() - startedAt < durationMs) {
          if (videoTrack && videoTrack.readyState === 'live' && preview.videoWidth > 0) {
            // Sample only the central video area, excluding title/status/control
            // chrome that could otherwise create false motion evidence.
            const cropX = preview.videoWidth * 0.15
            const cropY = preview.videoHeight * 0.08
            const cropWidth = preview.videoWidth * 0.7
            const cropHeight = preview.videoHeight * 0.72
            ctx.drawImage(preview, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height)
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            let hash = 2166136261
            for (let index = 0; index < pixels.length; index += 4) {
              hash ^= pixels[index]
              hash = Math.imul(hash, 16777619)
              hash ^= pixels[index + 1]
              hash = Math.imul(hash, 16777619)
              hash ^= pixels[index + 2]
              hash = Math.imul(hash, 16777619)
            }
            hashes.add(hash >>> 0)
            report.observedFrames++
          }
          if (analyser && audio) {
            analyser.getFloatTimeDomainData(audio)
            for (const sample of audio) {
              const absolute = Math.abs(sample)
              if (absolute > 0) report.nonZeroAudioSamples++
              if (absolute > report.maxAbsAudioSample) report.maxAbsAudioSample = absolute
              report.rmsAudioSample += sample * sample
              report.audioSampleCount++
            }
          }
          await new Promise(resolve => requestAnimationFrame(resolve))
        }
        report.elapsedMs = Math.round(performance.now() - startedAt)
        report.distinctFrameHashes = hashes.size
        report.rmsAudioSample = report.audioSampleCount ? Math.sqrt(report.rmsAudioSample / report.audioSampleCount) : 0
        report.status = report.observedFrames > 1 && hashes.size > 1 ? 'OBSERVED_CHANGING_FRAMES' : 'NOT_VERIFIED'
      } catch (error) {
        report.captureError = String(error && error.message || error).slice(0, 300)
      } finally {
        if (source) source.disconnect()
        if (audioContext && audioContext.state !== 'closed') await audioContext.close().catch(() => {})
        if (stream) for (const track of stream.getTracks()) track.stop()
        preview.srcObject = null
        result.textContent = JSON.stringify(report, null, 2)
        result.dataset.report = JSON.stringify(report)
        result.dataset.ready = 'true'
      }
      return report
    }
  }
  document.getElementById('capture').addEventListener('click', () => {
    const result = document.getElementById('result')
    result.dataset.ready = 'false'
    window.__kqP5bObserver.measure().catch(error => {
      result.dataset.report = JSON.stringify({ status: 'NOT_VERIFIED', captureError: String(error && error.message || error) })
      result.dataset.ready = 'true'
    })
  })
})()
`
}

function writeElectronHarness(harnessDirectory, stagedSamples, profilePath, runId, { interactiveMode = false, showObserver = !interactiveMode } = {}) {
  fs.mkdirSync(harnessDirectory, { recursive: false })
  const staged = describeSamples(stagedSamples)
  const codeList = staged.map(sample => ({ code: sample.code, fileName: sample.fileName }))
  const config = {
    userDataPath: profilePath,
    eventLogPath: path.join(path.dirname(profilePath), 'electron-events.jsonl'),
    electronPlayerTitle: `KQ P5B Chromium ${runId}`,
    observerTitle: `KQ P5B observer ${runId}`,
    windowWidth: interactiveMode ? 1180 : 920,
    windowHeight: interactiveMode ? 720 : 560,
    windowX: 50,
    windowY: 50,
    observerX: 1000,
    observerY: 50,
    invalidFileUrl: pathToFileURL(path.join(path.dirname(profilePath), 'invalid.mp4')).href,
    media: codeList,
    interactiveMode,
    showObserver
  }
  fs.writeFileSync(path.join(harnessDirectory, 'package.json'), JSON.stringify({ name: 'kq-p5b-evaluation', version: '1.0.0', main: 'main.js' }))
  fs.writeFileSync(path.join(harnessDirectory, 'main.js'), generatedMainSource())
  fs.writeFileSync(path.join(harnessDirectory, 'preload.js'), generatedPreloadSource())
  fs.writeFileSync(path.join(harnessDirectory, 'player.html'), generatedPlayerHtml(interactiveMode))
  fs.writeFileSync(path.join(harnessDirectory, 'player.js'), generatedPlayerScript(staged, config.invalidFileUrl, interactiveMode))
  if (config.showObserver) {
    fs.writeFileSync(path.join(harnessDirectory, 'observer.html'), generatedObserverHtml())
    fs.writeFileSync(path.join(harnessDirectory, 'observer.js'), generatedObserverScript())
  }
  fs.writeFileSync(path.join(harnessDirectory, 'config.json'), JSON.stringify(config))
  return staged
}

function findWindowPage(pages, title) {
  return pages.find(async page => (await page.title()) === title)
}

async function pageForDocumentTitle(electronApp, expectedDocumentTitle, windowTitle, timeoutMs = OPERATION_TIMEOUT_MS) {
  const observedTitles = new Set()
  const examinedPages = new Set()
  const pendingPages = []
  let wakeForWindow
  let timedOut = false
  const onWindow = page => {
    pendingPages.push(page)
    if (wakeForWindow) {
      const wake = wakeForWindow
      wakeForWindow = undefined
      wake()
    }
  }
  const timeout = setTimeout(() => {
    timedOut = true
    if (wakeForWindow) {
      const wake = wakeForWindow
      wakeForWindow = undefined
      wake()
    }
  }, timeoutMs)

  let listenerRegistered = false
  try {
    electronApp.on('window', onWindow)
    listenerRegistered = true
    while (!timedOut) {
      const currentPages = await electronApp.windows()
      const candidates = [...currentPages, ...pendingPages.splice(0)]
      for (const page of candidates) {
        if (examinedPages.has(page)) continue
        examinedPages.add(page)
        try {
          const title = await page.title()
          observedTitles.add(title || '<empty>')
          if (title === expectedDocumentTitle) return page
        } catch {
          observedTitles.add('<unavailable>')
        }
      }

      if (timedOut) break
      await new Promise(resolve => { wakeForWindow = resolve })
    }
    throw new Error(`Electron evaluation window did not open: ${String(windowTitle).slice(0, 80)}; observed document titles: ${[...observedTitles].join(', ') || '<none>'}`)
  } finally {
    clearTimeout(timeout)
    if (listenerRegistered) electronApp.removeListener('window', onWindow)
    wakeForWindow = undefined
  }
}

async function waitForEvent(page, type, afterIndex = 0, timeoutMs = OPERATION_TIMEOUT_MS, identity = {}) {
  await page.waitForFunction(({ expectedType, startIndex, identity }) => {
    return window.__kqP5b && window.__kqP5b.events.slice(startIndex).some(event =>
      event.type === expectedType && (!identity.code || event.code === identity.code) &&
      (!identity.attempt || event.attempt === identity.attempt) &&
      (!Number.isFinite(identity.minCurrentTime) || event.currentTime >= identity.minCurrentTime)
    )
  }, { expectedType: type, startIndex: afterIndex, identity }, { timeout: timeoutMs })
  const events = await page.evaluate(() => window.__kqP5b.events)
  return events.slice(afterIndex).find(event => event.type === type &&
    (!identity.code || event.code === identity.code) && (!identity.attempt || event.attempt === identity.attempt) &&
    (!Number.isFinite(identity.minCurrentTime) || event.currentTime >= identity.minCurrentTime))
}

async function waitForHarnessApi(page, apiName, description) {
  const rendererErrors = []
  const onPageError = error => rendererErrors.push(String(error && error.message || error).slice(0, 240))
  const onConsole = message => {
    if (message.type() === 'error') rendererErrors.push(message.text().slice(0, 240))
  }
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  try {
    await page.waitForFunction(name => Boolean(window[name]), apiName, { timeout: OPERATION_TIMEOUT_MS })
  } catch (error) {
    const pageState = await page.evaluate(() => ({
      title: document.title,
      readyState: document.readyState,
      scriptNames: Array.from(document.scripts, script => {
        try { return new URL(script.src).pathname.split('/').pop() }
        catch { return '<inline>' }
      }),
      playerApi: Boolean(window.__kqP5b),
      observerApi: Boolean(window.__kqP5bObserver),
      bodyText: document.body ? document.body.innerText.slice(0, 180) : ''
    })).catch(pageError => ({ unavailable: String(pageError && pageError.message || pageError).slice(0, 180) }))
    throw new Error(`${description} did not initialize: ${error.message}; page=${JSON.stringify(pageState)}; rendererErrors=${JSON.stringify(rendererErrors)}`)
  } finally {
    page.removeListener('pageerror', onPageError)
    page.removeListener('console', onConsole)
  }
}

async function measureElectronWindow(electronApp, observerPage, title, engineResult, scenario = 'active-playback') {
  await waitForHarnessApi(observerPage, '__kqP5bObserver', 'Electron capture observer API')
  await electronApp.evaluate(({ }, targetTitle) => global.__kqP5b.setCaptureTarget(targetTitle), title)
  await observerPage.locator('#capture').click()
  await observerPage.waitForFunction(() => document.getElementById('result').dataset.ready === 'true', undefined, { timeout: PLAYBACK_OBSERVATION_MS + OPERATION_TIMEOUT_MS })
  const measurement = await observerPage.evaluate(() => JSON.parse(document.getElementById('result').dataset.report))
  const visibleVideo = {
    status: measurement.status,
    scenario,
    observedFrames: measurement.observedFrames,
    distinctFrameHashes: measurement.distinctFrameHashes,
    elapsedMs: measurement.elapsedMs,
    captureError: measurement.captureError
  }
  const audioTrackLive = measurement.audioTrackState === 'live'
  const audioSignalPresent = measurement.nonZeroAudioSamples > 0 && measurement.maxAbsAudioSample > 0
  const audioLoopback = {
    scenario,
    status: audioTrackLive && audioSignalPresent ? 'SIGNAL_CAPTURED_SYSTEM_WIDE' : 'NOT_VERIFIED',
    trackState: measurement.audioTrackState,
    nonZeroAudioSamples: measurement.nonZeroAudioSamples,
    maxAbsAudioSample: measurement.maxAbsAudioSample,
    rmsAudioSample: measurement.rmsAudioSample,
    audioSampleCount: measurement.audioSampleCount,
    engineAttribution: 'NOT_VERIFIED',
    attribution: 'WASAPI system loopback signal only; does not prove physical speaker output or exclusive attribution to this engine'
  }
  engineResult.visibleVideoCaptures ||= []
  engineResult.visibleVideoCaptures.push(visibleVideo)
  if (!engineResult.visibleVideo || scenario === 'active-playback') engineResult.visibleVideo = visibleVideo
  engineResult.systemAudioLoopbackMeasurements ||= []
  engineResult.systemAudioLoopbackMeasurements.push(audioLoopback)
  if (!engineResult.systemAudioLoopback || scenario === 'active-playback') engineResult.systemAudioLoopback = audioLoopback
  return measurement
}

async function sampleElectronResources(electronApp) {
  return electronApp.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
    type: metric.type,
    pid: metric.pid,
    cpuPercent: metric.cpu && metric.cpu.percentCPUUsage,
    workingSetSize: metric.memory && metric.memory.workingSetSize,
    privateBytes: metric.memory && metric.memory.privateBytes
  })))
}

function evaluationDiagnostics(profilePath) {
  const eventLog = path.join(path.dirname(profilePath), 'electron-events.jsonl')
  try {
    return fs.readFileSync(eventLog, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      .filter(event => ['renderer-console', 'renderer-load-failed', 'renderer-api-state', 'renderer-api-state-error'].includes(event.type))
      .slice(-30).map(event => redactDiagnostic(event))
  } catch {
    return []
  }
}

async function runChromium(report, harnessDirectory, profilePath, stagedSamples, runId, { normalSpeedEof = false } = {}) {
  const engine = report.chromium
  let electronApp
  let playerPage
  let observerPage
  const windowTitle = `KQ P5B Chromium ${runId}`
  const observerTitle = `KQ P5B observer ${runId}`
  const electronPath = require('electron')
  const { _electron: electron } = require('playwright')
  try {
    electronApp = await electron.launch({ executablePath: electronPath, args: [harnessDirectory], timeout: 30000 })
    playerPage = await pageForDocumentTitle(electronApp, 'Karaoke Queue playback evaluation', windowTitle)
    observerPage = await pageForDocumentTitle(electronApp, 'Karaoke Queue playback capture observer', observerTitle)
    await waitForHarnessApi(playerPage, '__kqP5b', 'Electron playback API')
    await waitForHarnessApi(observerPage, '__kqP5bObserver', 'Electron capture observer API')
    const versions = await electronApp.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }))
    engine.version = versions.electron
    report.environment.electronVersion = versions.electron
    report.environment.chromiumVersion = versions.chromium
    const windowState = await electronApp.evaluate(() => global.__kqP5b.getWindowState())
    const captureTitle = windowState.player && windowState.player.title
    report.environment.displays = await electronApp.evaluate(({ screen }) => screen.getAllDisplays().length)
    if (!windowState.player || !windowState.player.visible || !windowState.observer) throw new Error('Isolated Electron evaluation windows are not visible')

    const first = stagedSamples[0]
    let before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.evaluate(code => window.__kqP5b.load(code), first.code)
    await waitForEvent(playerPage, 'loadedmetadata', before)
    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    const startedAt = performance.now()
    await playerPage.locator('#play').click()
    await waitForEvent(playerPage, 'playing', before)
    engine.playbackStartupMs = Math.round(performance.now() - startedAt)
    engine.controls.play = 'PASS'
    engine.resourceSamples.push(await sampleElectronResources(electronApp))

    const capture = await measureElectronWindow(electronApp, observerPage, captureTitle, engine)
    engine.resourceSamples.push(await sampleElectronResources(electronApp))
    engine.events = await playerPage.evaluate(() => window.__kqP5b.events.slice(-30))

    const beforePause = await playerPage.evaluate(() => window.__kqP5b.state.currentTime)
    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#pause').click()
    await waitForEvent(playerPage, 'pause', before)
    engine.controls.pause = 'PASS'
    const pausedState = await playerPage.evaluate(() => window.__kqP5b.state)
    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#resume').click()
    await waitForEvent(playerPage, 'playing', before)
    engine.controls.resume = pausedState.paused === true ? 'PASS' : 'FAIL'

    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#restart').click()
    await waitForEvent(playerPage, 'seeked', before)
    const restarted = await playerPage.evaluate(() => window.__kqP5b.state)
    engine.controls.restart = restarted.currentTime < 2 && restarted.attempt >= 2 && !restarted.paused ? 'PASS' : 'FAIL'

    if (stagedSamples.length > 1) {
      const oldCode = first.code
      const oldAttempt = await playerPage.evaluate(() => window.__kqP5b.state.attempt)
      const newCode = stagedSamples[1].code
      before = await playerPage.evaluate(() => window.__kqP5b.events.length)
      await playerPage.evaluate(code => window.__kqP5b.load(code, 'replace'), newCode)
      await waitForEvent(playerPage, 'loadedmetadata', before)
      const replacementEvents = await playerPage.evaluate(startIndex => window.__kqP5b.events.slice(startIndex), before)
      const replacedState = await playerPage.evaluate(() => window.__kqP5b.state)
      engine.controls.manualReplacement = replacedState.code === newCode && oldCode !== newCode &&
        !replacementEvents.some(event => event.type === 'ended' && event.code === oldCode && event.attempt === oldAttempt) ? 'PASS' : 'FAIL'
      engine.controls.next = 'NOT_APPLICABLE: ordered sequence belongs to Player service'
      engine.replacement = { intent: 'manual replacement', oldCode, oldAttempt,
        newCode, newAttempt: replacedState.attempt,
        oldAttemptEndedNaturally: replacementEvents.some(event => event.type === 'ended' && event.code === oldCode && event.attempt === oldAttempt) }
      before = await playerPage.evaluate(() => window.__kqP5b.events.length)
      await playerPage.evaluate(code => window.__kqP5b.load(code, 'previous'), oldCode)
      await waitForEvent(playerPage, 'loadedmetadata', before)
      engine.controls.previous = 'NOT_APPLICABLE: ordered sequence belongs to Player service'
    } else {
      engine.controls.manualReplacement = 'NOT_VERIFIED: fewer than two distinct codes in the supplied media root'
      engine.controls.next = 'NOT_APPLICABLE: ordered sequence belongs to Player service'
      engine.controls.previous = 'NOT_APPLICABLE: ordered sequence belongs to Player service'
    }

    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#stop').click()
    await waitForEvent(playerPage, 'emptied', before)
    const stopEvents = await playerPage.evaluate(startIndex => window.__kqP5b.events.slice(startIndex), before)
    engine.controls.stop = stopEvents.some(event => event.type === 'emptied') && !stopEvents.some(event => event.type === 'ended') ? 'PASS' : 'FAIL'

    const startedBeforeFullscreen = await playerPage.evaluate(() => window.__kqP5b.state.frameCount)
    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.evaluate(code => window.__kqP5b.load(code), first.code)
    await waitForEvent(playerPage, 'loadedmetadata', before)
    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#play').click()
    await waitForEvent(playerPage, 'playing', before)
    const fullscreenRequested = await electronApp.evaluate(() => global.__kqP5b.setPlayerFullscreen(true))
    const entered = await pollUntil(
      () => electronApp.evaluate(() => global.__kqP5b.getWindowState().player.fullScreen),
      value => fullscreenRequested && value === true,
      'Electron fullscreen enter'
    )
    const fullscreenCapture = await measureElectronWindow(electronApp, observerPage, captureTitle, engine, 'fullscreen-playback')
    const fullscreenExitRequested = await electronApp.evaluate(() => global.__kqP5b.setPlayerFullscreen(false))
    const exited = await pollUntil(
      () => electronApp.evaluate(() => !global.__kqP5b.getWindowState().player.fullScreen),
      value => fullscreenExitRequested && value === true,
      'Electron fullscreen exit'
    )
    const afterFullscreen = await playerPage.evaluate(() => window.__kqP5b.state.frameCount)
    engine.fullscreen = { status: fullscreenStatus(entered && exited && afterFullscreen >= startedBeforeFullscreen,
      fullscreenCapture),
      entered, exited, frameCount: afterFullscreen,
      visibleCapture: engine.visibleVideoCaptures.slice(-1)[0], captureStatus: fullscreenCapture.status }

    engine.sampleDecoding = []
    for (const sample of stagedSamples) {
      before = await playerPage.evaluate(() => window.__kqP5b.events.length)
      const state = await playerPage.evaluate(code => window.__kqP5b.load(code, 'sample-decode').then(() => window.__kqP5b.state), sample.code)
      const identity = { code: sample.code, attempt: state.attempt }
      await waitForEvent(playerPage, 'loadedmetadata', before, OPERATION_TIMEOUT_MS, identity)
      before = await playerPage.evaluate(() => window.__kqP5b.events.length)
      const beforeFrame = before
      await playerPage.locator('#play').click()
      await waitForEvent(playerPage, 'playing', before, OPERATION_TIMEOUT_MS, identity)
      const firstFrame = await waitForEvent(playerPage, 'video-frame', beforeFrame, OPERATION_TIMEOUT_MS, identity)
      const sampleState = await playerPage.evaluate(() => window.__kqP5b.state)
      engine.sampleDecoding.push({
        code: sample.code,
        status: firstFrame && sampleState.width > 0 && sampleState.height > 0 ? 'FIRST_FRAME_CALLBACK_OBSERVED' : 'NOT_VERIFIED',
        frame: firstFrame ? { mediaTime: firstFrame.mediaTime, presentedFrames: firstFrame.presentedFrames } : null,
        dimensions: { width: sampleState.width, height: sampleState.height },
        audioDecoding: 'NOT_VERIFIED'
      })
    }
    engine.sampleDecodingSummary = {
      tested: engine.sampleDecoding.length,
      videoFirstFrameObserved: engine.sampleDecoding.filter(sample => sample.status === 'FIRST_FRAME_CALLBACK_OBSERVED').length,
      audioDecoding: 'NOT_VERIFIED'
    }

    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    const eofState = await playerPage.evaluate(code => window.__kqP5b.load(code, 'natural-eof-test').then(() => window.__kqP5b.state), first.code)
    const eofIdentity = { code: first.code, attempt: eofState.attempt }
    await waitForEvent(playerPage, 'loadedmetadata', before, OPERATION_TIMEOUT_MS, eofIdentity)
    const requestedEofRate = normalSpeedEof ? 1 : 16
    const eofPlayback = await playerPage.evaluate(rate => ({ rate: window.__kqP5b.setRate(rate), state: window.__kqP5b.state }), requestedEofRate)
    if (eofPlayback.rate !== requestedEofRate) throw new Error(`Chromium did not confirm EOF test rate: ${eofPlayback.rate}`)
    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#play').click()
    await waitForEvent(playerPage, 'playing', before, OPERATION_TIMEOUT_MS, eofIdentity)
    const progress = await waitForEvent(playerPage, 'timeupdate', before, OPERATION_TIMEOUT_MS, { ...eofIdentity, minCurrentTime: 8 })
    const eofTimeout = Math.ceil(eofPlayback.state.duration * 1000 / eofPlayback.rate + (normalSpeedEof ? 30000 : 10000))
    const eofEvent = await waitForEvent(playerPage, 'ended', before, eofTimeout, eofIdentity)
    engine.eofPlayback = { mode: normalSpeedEof ? 'normal-speed-complete-track' : 'accelerated-signal-check',
      requestedRate: requestedEofRate, confirmedRate: eofPlayback.rate,
      durationSeconds: eofPlayback.state.duration, progressCurrentTimeSeconds: progress.currentTime,
      progressRate: progress.playbackRate }
    engine.controls.naturalEof = 'PASS'
    engine.naturalCompletion = { classification: 'CANDIDATE_ONLY', code: eofEvent.code,
      attempt: eofEvent.attempt, event: eofEvent.type, intent: eofEvent.intent,
      requiredAuthority: 'Controller presentation reconciliation remains out of scope' }
    engine.events.push(eofEvent)

    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.evaluate(() => window.__kqP5b.loadInvalid())
    await waitForEvent(playerPage, 'error', before)
    engine.controls.invalidMedia = 'PASS'

    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.evaluate(code => window.__kqP5b.load(code, 'crash-test'), first.code)
    await waitForEvent(playerPage, 'loadedmetadata', before)
    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#play').click()
    await waitForEvent(playerPage, 'playing', before)
    const rendererCrashRequested = await electronApp.evaluate(() => global.__kqP5b.crashPlayerRenderer())
    const crashEvents = await pollUntil(
      () => electronApp.evaluate(() => global.__kqP5b.events),
      events => rendererCrashRequested && events.some(event => event.type === 'electron-renderer-gone'),
      'Electron renderer termination event'
    )
    const crashIndex = crashEvents.findIndex(event => event.type === 'electron-renderer-gone')
    const terminalEndedAfterCrash = crashEvents.slice(crashIndex + 1).some(event =>
      event.type === 'renderer-event' && event.details && event.details.type === 'ended'
    )
    engine.rendererCrash = {
      status: crashIndex >= 0 && !terminalEndedAfterCrash ? 'PASS' : 'FAIL',
      rendererGone: crashIndex >= 0,
      rendererGoneDetails: crashIndex >= 0 ? crashEvents[crashIndex] : null,
      endedObservedAfterTermination: terminalEndedAfterCrash,
      interpretation: 'Renderer crash is recorded as process loss; no ended event was observed afterward'
    }
    engine.unexpectedTermination = {
      status: 'NOT_RUN',
      reason: 'The Electron host process is not force-killed because safe Chromium child-tree cleanup is not guaranteed in this runner'
    }
    engine.hostProcessTermination = { status: 'NOT_RUN' }
    engine.events = crashEvents

    engine.audioVideoSynchronization = { status: 'NOT_VERIFIED', reason: 'No synchronized marker fixture was supplied to this harness run' }
    engine.status = Object.values(engine.controls).some(value => String(value).startsWith('FAIL')) ||
      engine.sampleDecodingSummary.videoFirstFrameObserved !== stagedSamples.length ||
      engine.fullscreen.status === 'FAIL' || engine.rendererCrash.status === 'FAIL' ? 'FAIL' : 'COMPLETED'
  } catch (error) {
    appendFailure(report, 'chromium', 'evaluation', error)
    engine.diagnostics = evaluationDiagnostics(profilePath)
  } finally {
    if (electronApp) {
      try {
        if (playerPage) await playerPage.evaluate(() => window.__kqP5b.stop()).catch(() => {})
        await electronApp.close().catch(() => {})
        engine.processTermination = { status: 'PASS', detail: 'Electron test process exited after controlled close' }
      } catch (error) {
        engine.processTermination = { status: 'FAIL', detail: String(error.message || error).slice(0, 200) }
      }
    }
  }
}

async function runChromiumInteractiveControls(report, harnessDirectory, stagedSamples, runId) {
  const engine = report.chromium
  const result = { status: 'PENDING', controls: {} }
  let electronApp
  try {
    if (stagedSamples.length < 2) throw new Error('The interactive controls check requires two distinct coded samples')
    const { _electron: electron } = require('playwright')
    electronApp = await electron.launch({ executablePath: require('electron'), args: [harnessDirectory], timeout: 30000 })
    const playerPage = await pageForDocumentTitle(electronApp, 'Karaoke Queue playback evaluation', `KQ P5B Chromium ${runId}`)
    await waitForHarnessApi(playerPage, '__kqP5b', 'Interactive Electron playback API')

    const playSelected = async code => {
      await playerPage.locator('#sample').selectOption(code)
      const before = await playerPage.evaluate(() => window.__kqP5b.events.length)
      await playerPage.locator('#play').click()
      const loaded = await waitForEvent(playerPage, 'loadedmetadata', before, OPERATION_TIMEOUT_MS, { code })
      const identity = { code, attempt: loaded.attempt }
      const playing = await waitForEvent(playerPage, 'playing', before, OPERATION_TIMEOUT_MS, identity)
      return { identity, loaded, playing }
    }

    const first = await playSelected(stagedSamples[0].code)
    result.controls.playSelected = first.identity.code === stagedSamples[0].code ? 'PASS' : 'FAIL'
    let before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#pause').click()
    await waitForEvent(playerPage, 'pause', before, OPERATION_TIMEOUT_MS, first.identity)
    result.controls.pause = (await playerPage.evaluate(() => window.__kqP5b.state.paused)) ? 'PASS' : 'FAIL'

    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#resume').click()
    await waitForEvent(playerPage, 'playing', before, OPERATION_TIMEOUT_MS, first.identity)
    result.controls.resume = !(await playerPage.evaluate(() => window.__kqP5b.state.paused)) ? 'PASS' : 'FAIL'

    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#restart').click()
    const restartedAttempt = first.identity.attempt + 1
    await waitForEvent(playerPage, 'seeked', before, OPERATION_TIMEOUT_MS,
      { code: first.identity.code, attempt: restartedAttempt })
    const restartedState = await playerPage.evaluate(() => window.__kqP5b.state)
    result.controls.restart = restartedState.attempt === restartedAttempt &&
      restartedState.currentTime < 2 && !restartedState.paused ? 'PASS' : 'FAIL'

    await playerPage.locator('#fullscreen').click()
    const fullscreenEntered = await pollUntil(
      () => electronApp.evaluate(() => global.__kqP5b.getWindowState().player.fullScreen),
      value => value === true, 'Interactive Player fullscreen enter'
    )
    await playerPage.locator('#fullscreen').click()
    const fullscreenExited = await pollUntil(
      () => electronApp.evaluate(() => !global.__kqP5b.getWindowState().player.fullScreen),
      value => value === true, 'Interactive Player fullscreen exit'
    )
    result.controls.fullscreen = fullscreenEntered && fullscreenExited ? 'PASS' : 'FAIL'

    const replacementStart = await playerPage.evaluate(() => window.__kqP5b.events.length)
    const second = await playSelected(stagedSamples[1].code)
    const replacementEvents = await playerPage.evaluate(startIndex => window.__kqP5b.events.slice(startIndex), replacementStart)
    result.controls.manualReplacement = second.identity.code !== first.identity.code &&
      !replacementEvents.some(event => event.type === 'ended' && event.code === first.identity.code && event.attempt === restartedAttempt)
      ? 'PASS' : 'FAIL'
    result.replacement = {
      oldCode: first.identity.code,
      oldAttempt: restartedAttempt,
      newCode: second.identity.code,
      newAttempt: second.identity.attempt,
      oldAttemptEndedNaturally: replacementEvents.some(event => event.type === 'ended' &&
        event.code === first.identity.code && event.attempt === restartedAttempt)
    }

    before = await playerPage.evaluate(() => window.__kqP5b.events.length)
    await playerPage.locator('#stop').click()
    await waitForEvent(playerPage, 'emptied', before, OPERATION_TIMEOUT_MS, second.identity)
    const stopEvents = await playerPage.evaluate(startIndex => window.__kqP5b.events.slice(startIndex), before)
    result.controls.stop = stopEvents.some(event => event.type === 'emptied') &&
      !stopEvents.some(event => event.type === 'ended') ? 'PASS' : 'FAIL'

    const failedControl = Object.values(result.controls).some(status => status !== 'PASS')
    result.status = failedControl ? 'FAIL' : 'PASS'
    result.events = await playerPage.evaluate(() => window.__kqP5b.events
      .filter(event => ['loadedmetadata', 'playing', 'pause', 'seeked', 'emptied', 'ended', 'error'].includes(event.type))
      .map(event => ({ type: event.type, code: event.code, attempt: event.attempt,
        ...(Number.isFinite(event.currentTime) ? { currentTime: event.currentTime } : {}),
        ...(Number.isFinite(event.errorCode) ? { errorCode: event.errorCode } : {}) })))
  } catch (error) {
    result.status = 'FAIL'
    appendFailure(report, 'chromium', 'interactive-controls', error)
  } finally {
    if (electronApp) {
      try {
        await electronApp.close()
        result.processTermination = 'PASS'
      } catch (error) {
        result.processTermination = 'FAIL'
        appendFailure(report, 'chromium', 'interactive-controls-cleanup', error)
      }
    }
  }
  engine.interactiveUiControls = result
  if (result.status === 'FAIL') engine.status = 'FAIL'
}

class MpvIpc extends EventEmitter {
  constructor(pipePath, child) {
    super()
    this.pipePath = pipePath
    this.child = child
    this.socket = null
    this.buffer = ''
    this.requestId = 1
    this.eventNumber = 0
    this.pending = new Map()
    this.events = []
  }

  async connect() {
    const startedAt = Date.now()
    let lastError
    while (Date.now() - startedAt < OPERATION_TIMEOUT_MS) {
      if (this.child.exitCode !== null) throw new Error(`mpv exited before IPC connected (${this.child.exitCode})`)
      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection(this.pipePath)
          const onError = error => { socket.destroy(); reject(error) }
          socket.once('error', onError)
          socket.once('connect', () => {
            socket.removeListener('error', onError)
            this.socket = socket
            resolve()
          })
        })
        this.socket.on('data', chunk => this.consume(chunk))
        this.socket.on('error', error => this.emit('ipc-error', error))
        this.socket.on('close', () => this.emit('ipc-close'))
        return
      } catch (error) {
        lastError = error
        await delay(40)
      }
    }
    throw new Error(`mpv named-pipe IPC could not connect: ${String(lastError && lastError.code || lastError)}`)
  }

  consume(chunk) {
    this.buffer += chunk.toString('utf8')
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { this.emit('malformed-line'); continue }
      if (Number.isInteger(message.request_id)) {
        const pending = this.pending.get(message.request_id)
        if (pending) {
          this.pending.delete(message.request_id)
          clearTimeout(pending.timer)
          if (message.error && message.error !== 'success') pending.reject(new Error(`mpv IPC: ${message.error}`))
          else pending.resolve(message)
        }
      } else if (typeof message.event === 'string') {
        const event = { ...message, eventNumber: ++this.eventNumber, observedAtMs: performance.now() }
        this.events.push(event)
        this.emit('mpv-event', event)
      }
    }
  }

  request(command) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('mpv IPC is not connected'))
    const requestId = this.requestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(timeoutError(`mpv request ${requestId}`, OPERATION_TIMEOUT_MS))
      }, OPERATION_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      this.socket.write(JSON.stringify({ command, request_id: requestId }) + '\n', error => {
        if (error) {
          const pending = this.pending.get(requestId)
          if (!pending) return
          this.pending.delete(requestId)
          clearTimeout(pending.timer)
          reject(error)
        }
      })
    })
  }

  observe(name, id) { return this.request(['observe_property', id, name]) }

  waitForEvent(name, afterEventNumber = 0, predicate = () => true, timeoutMs = OPERATION_TIMEOUT_MS) {
    const match = this.events.find(event => event.eventNumber > afterEventNumber && event.event === name && predicate(event))
    if (match) return Promise.resolve(match)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('mpv-event', onEvent)
        const recentEvents = this.events.filter(event => event.event === name || event.event === 'end-file' || event.event === 'file-loaded')
          .slice(-8).map(event => ({ eventNumber: event.eventNumber, event: event.event, reason: event.reason, playlistEntryId: event.playlist_entry_id }))
        reject(new Error(`${timeoutError(`mpv ${name} event`, timeoutMs).message}; recent events=${JSON.stringify(recentEvents)}`))
      }, timeoutMs)
      const onEvent = event => {
        if (event.eventNumber <= afterEventNumber || event.event !== name || !predicate(event)) return
        this.removeListener('mpv-event', onEvent)
        clearTimeout(timer)
        resolve(event)
      }
      this.on('mpv-event', onEvent)
    })
  }

  waitForProperty(id, predicate, afterEventNumber = 0, timeoutMs = OPERATION_TIMEOUT_MS) {
    const match = this.events.find(event => event.eventNumber > afterEventNumber && event.event === 'property-change' && event.id === id && predicate(event.data))
    if (match) return Promise.resolve(match)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('mpv-event', onEvent)
        reject(timeoutError(`mpv property ${id} change`, timeoutMs))
      }, timeoutMs)
      const onEvent = event => {
        if (event.eventNumber <= afterEventNumber || event.event !== 'property-change' || event.id !== id || !predicate(event.data)) return
        this.removeListener('mpv-event', onEvent)
        clearTimeout(timer)
        resolve(event)
      }
      this.on('mpv-event', onEvent)
    })
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('mpv IPC closed'))
    }
    this.pending.clear()
  }
}

function runVersion(executablePath) {
  const result = spawnSync(executablePath, ['--version'], { encoding: 'utf8', shell: false, timeout: 10000, windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`mpv --version returned exit ${result.status}`)
  const output = String(result.stdout || '').trim().slice(0, 4000)
  const firstLine = output.split(/\r?\n/)[0] || 'unknown'
  return { output, firstLine }
}

function mpvArguments(pipePath, title) {
  return [
    '--no-config',
    '--load-scripts=no',
    '--idle=yes',
    '--force-window=yes',
    '--terminal=no',
    '--osc=no',
    `--title=${title}`,
    '--geometry=920x560+50+50',
    `--input-ipc-server=${pipePath}`
  ]
}

async function spawnMpv(executablePath, pipePath, title) {
  const child = spawn(executablePath, mpvArguments(pipePath, title), {
    shell: false,
    windowsHide: false,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000) })
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, at: performance.now() })))
  const ipc = new MpvIpc(pipePath, child)
  try {
    await ipc.connect()
    await Promise.all([
      ipc.observe('pause', 1),
      ipc.observe('time-pos', 2),
      ipc.observe('duration', 3),
      ipc.observe('path', 4),
      ipc.observe('idle-active', 5)
    ])
    return { child, ipc, exit, getStderr: () => stderr }
  } catch (error) {
    ipc.close()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await withTimeout(exit, 'mpv failed-start cleanup', 10000).catch(() => {})
    throw error
  }
}

async function sampleWindowsProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'NOT_VERIFIED' }
  const command = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::WriteLine(('{"workingSetBytes":' + $p.WorkingSet64 + ',"privateBytes":' + $p.PrivateMemorySize64 + ',"cpuSeconds":' + $p.CPU + '}'))`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000
  })
  if (result.status !== 0) return { status: 'NOT_VERIFIED', error: String(result.stderr || '').slice(0, 200) }
  try { return { status: 'PASS', ...JSON.parse(result.stdout.trim()) } } catch {
    return { status: 'NOT_VERIFIED', error: 'Invalid process metrics response' }
  }
}

async function waitForMpvStart(ipc, loadedEvent) {
  // mpv's playback-restart event does not carry playlist_entry_id in this build.
  // Commands are serialized by this harness, so the first restart after this
  // file-loaded sequence is the start acknowledgement for the active entry.
  const restart = await ipc.waitForEvent('playback-restart', loadedEvent.eventNumber)
  return restart
}

async function loadMpvFile(ipc, filePath, afterEventNumber, context) {
  context.attemptId ||= `mpv-attempt-${++mpvAttemptSequence}`
  const commandStartedAt = performance.now()
  const ack = await ipc.request(['loadfile', filePath, 'replace'])
  context.commandAck = ack.error
  const started = await ipc.waitForEvent('start-file', afterEventNumber)
  const loaded = await ipc.waitForEvent('file-loaded', started.eventNumber)
  if (Number.isInteger(started.playlist_entry_id)) loaded.playlist_entry_id = started.playlist_entry_id
  if (!Number.isInteger(loaded.playlist_entry_id)) throw new Error('mpv start-file event did not expose playlist_entry_id')
  const entryId = loaded.playlist_entry_id
  context.playlistEntryId = entryId
  const restarted = await waitForMpvStart(ipc, loaded)
  context.started = true
  context.startedEventNumber = restarted.eventNumber
  return { loaded, restarted, attemptId: context.attemptId, code: context.code || null,
    commandToStartMs: Math.round(restarted.observedAtMs - commandStartedAt) }
}

async function runMpv(report, executablePath, stagedSamples, runId, harness, profilePath) {
  const engine = report.mpv
  const children = []
  let session
  const title = `KQ P5B mpv ${runId}`
  const pipePath = WINDOWS_PIPE_PREFIX + runId
  try {
    assertLocalWindowsPath(executablePath, 'KQ_P5B_MPV_EXE')
    const executableStat = fs.lstatSync(executablePath)
    if (!executableStat.isFile() || executableStat.isSymbolicLink() || path.extname(executablePath).toLowerCase() !== '.exe') {
      throw new Error('mpv executable must be a regular local .exe file')
    }
    engine.executableSha256 = sha256(executablePath)
    engine.executableFileName = path.basename(executablePath)
    const version = runVersion(executablePath)
    engine.versionOutput = version.output
    engine.version = version.firstLine
    session = await spawnMpv(executablePath, pipePath, title)
    children.push(session.child)
    await session.ipc.request(['set_property', 'volume', 30])
    const first = stagedSamples[0]
    const firstPath = first.sourcePath
    let sequence = session.ipc.eventNumber
    const startup = await loadMpvFile(session.ipc, firstPath, sequence, { code: first.code, intent: 'play' })
    engine.playbackStartupMs = startup.commandToStartMs
    engine.playbackAttempt = { attemptId: startup.attemptId, playlistEntryId: startup.loaded.playlist_entry_id, code: startup.code }
    engine.controls.play = startup.loaded && startup.restarted ? 'PASS' : 'FAIL'
    engine.events.push(...session.ipc.events.slice(-20).map(publicMpvEvent))
    engine.resourceSamples.push(await sampleWindowsProcess(session.child.pid))
    await measureElectronWindow(harness.electronApp, harness.observerPage, title, engine)
    engine.resourceSamples.push(await sampleWindowsProcess(session.child.pid))

    sequence = session.ipc.eventNumber
    await session.ipc.request(['set_property', 'pause', true])
    const paused = await session.ipc.waitForProperty(1, value => value === true, sequence)
    engine.controls.pause = paused ? 'PASS' : 'FAIL'
    sequence = session.ipc.eventNumber
    await session.ipc.request(['set_property', 'pause', false])
    const resumed = await session.ipc.waitForProperty(1, value => value === false, sequence)
    engine.controls.resume = resumed ? 'PASS' : 'FAIL'

    const attemptBeforeRestart = session.ipc.eventNumber
    await session.ipc.request(['seek', 0, 'absolute', 'exact'])
    const seekConfirmation = await session.ipc.waitForProperty(2,
      value => typeof value === 'number' && value <= 1, attemptBeforeRestart)
    const restartPosition = await session.ipc.request(['get_property', 'time-pos'])
    engine.controls.restart = seekConfirmation && typeof restartPosition.data === 'number' && restartPosition.data <= 1 ? 'PASS' : 'FAIL'
    engine.restart = {
      attemptId: `mpv-attempt-${++mpvAttemptSequence}`,
      previousAttemptId: startup.attemptId,
      eventNumberBeforeSeek: attemptBeforeRestart,
      seekPropertyConfirmed: Boolean(seekConfirmation),
      timePositionSecondsAfterSeek: restartPosition.data,
      playbackEntryId: startup.loaded.playlist_entry_id,
      completionExpected: false
    }

    if (stagedSamples.length > 1) {
      const oldEntryId = startup.loaded.playlist_entry_id
      const nextSample = stagedSamples[1]
      const nextPath = nextSample.sourcePath
      const oldEntryTerminal = session.ipc.waitForEvent('end-file', session.ipc.eventNumber,
        event => event.playlist_entry_id === oldEntryId)
      sequence = session.ipc.eventNumber
      const intentBeforeReplace = { intent: 'replace', oldEntryId, nextCode: nextSample.code, setBeforeCommand: true }
      const replacement = await loadMpvFile(session.ipc, nextPath, sequence, intentBeforeReplace)
      const terminal = await oldEntryTerminal
      engine.controls.manualReplacement = replacement.loaded && terminal.reason === 'stop' ? 'PASS' : 'FAIL'
      engine.controls.next = 'NOT_APPLICABLE: ordered sequence belongs to Player service'
      engine.replacement = { oldEntryId, oldAttemptId: startup.attemptId, reason: terminal.reason,
        nextCode: nextSample.code, newAttemptId: replacement.attemptId, intent: intentBeforeReplace }
      const nextEntryId = replacement.loaded.playlist_entry_id
      const previousPath = first.sourcePath
      const oldNextTerminal = session.ipc.waitForEvent('end-file', session.ipc.eventNumber,
        event => event.playlist_entry_id === nextEntryId)
      sequence = session.ipc.eventNumber
      const previous = await loadMpvFile(session.ipc, previousPath, sequence, { intent: 'previous', code: first.code })
      const nextTerminal = await oldNextTerminal
      engine.controls.previous = 'NOT_APPLICABLE: ordered sequence belongs to Player service'
      engine.previousReplacement = { loaded: Boolean(previous.loaded), oldEntryId: nextEntryId,
        terminalReason: nextTerminal.reason, newAttemptId: previous.attemptId }
    } else {
      engine.controls.manualReplacement = 'NOT_VERIFIED: fewer than two distinct codes in the supplied media root'
      engine.controls.next = 'NOT_APPLICABLE: ordered sequence belongs to Player service'
      engine.controls.previous = 'NOT_APPLICABLE: ordered sequence belongs to Player service'
    }

    const activeEntryId = session.ipc.events.filter(event => event.event === 'file-loaded').slice(-1)[0]?.playlist_entry_id
    const stoppedTerminal = session.ipc.waitForEvent('end-file', session.ipc.eventNumber,
      event => event.playlist_entry_id === activeEntryId)
    const stopIntent = { intent: 'stop', playlistEntryId: activeEntryId, setBeforeCommand: true }
    await session.ipc.request(['stop'])
    const stopped = await stoppedTerminal
    engine.controls.stop = stopIntent.setBeforeCommand && stopped.reason === 'stop' ? 'PASS' : 'FAIL'
    engine.stop = { intent: stopIntent.intent, reason: stopped.reason, playlistEntryId: stopped.playlist_entry_id }

    const fullscreenPlayback = await loadMpvFile(session.ipc, firstPath, session.ipc.eventNumber,
      { intent: 'fullscreen-test', code: first.code })
    const fullscreenBefore = session.ipc.eventNumber
    await session.ipc.request(['set_property', 'fullscreen', true])
    const fullscreenOn = await session.ipc.request(['get_property', 'fullscreen'])
    const visibleSources = await harness.electronApp.evaluate(() => global.__kqP5b.listCaptureSources())
    const mpvWindowVisible = visibleSources.some(source => source.name === title)
    await measureElectronWindow(harness.electronApp, harness.observerPage, title, engine, 'fullscreen-playback')
    await session.ipc.request(['set_property', 'fullscreen', false])
    const fullscreenOff = await session.ipc.request(['get_property', 'fullscreen'])
    engine.fullscreen = {
      status: fullscreenStatus(fullscreenOn.data === true && fullscreenOff.data === false && mpvWindowVisible,
        engine.visibleVideoCaptures.slice(-1)[0]),
      entered: fullscreenOn.data === true,
      exited: fullscreenOff.data === false,
      mpvWindowVisible,
      playbackEntryId: fullscreenPlayback.loaded.playlist_entry_id,
      fullscreenCapture: engine.visibleVideoCaptures.slice(-1)[0],
      eventNumber: fullscreenBefore
    }
    const fullscreenStop = session.ipc.waitForEvent('end-file', session.ipc.eventNumber,
      event => event.playlist_entry_id === fullscreenPlayback.loaded.playlist_entry_id)
    await session.ipc.request(['stop'])
    const fullscreenStopped = await fullscreenStop
    engine.fullscreen.stopReason = fullscreenStopped.reason

    await session.ipc.request(['set_property', 'speed', 16])
    const eofSpeed = await session.ipc.request(['get_property', 'speed'])
    engine.eofAcceleration = { requested: 16, confirmed: eofSpeed.data, status: eofSpeed.data === 16 ? 'PASS' : 'FAIL' }
    if (engine.eofAcceleration.status !== 'PASS') throw new Error('mpv did not confirm accelerated EOF test playback speed')
    const eofAttempt = await loadMpvFile(session.ipc, firstPath, session.ipc.eventNumber, { intent: 'eof-test', code: first.code })
    const eofEntryId = eofAttempt.loaded.playlist_entry_id
    const eofDuration = await session.ipc.request(['get_property', 'duration'])
    const eofWaitMs = typeof eofDuration.data === 'number' ? Math.min(45000, Math.ceil(eofDuration.data * 1000 / 16 + 10000)) : 45000
    const eofEventPromise = session.ipc.waitForEvent('end-file', eofAttempt.restarted.eventNumber,
      event => event.playlist_entry_id === eofEntryId && event.reason === 'eof', eofWaitMs)
    const eof = await eofEventPromise
    engine.controls.naturalEof = eof.reason === 'eof' ? 'PASS' : 'FAIL'
    engine.naturalCompletion = { classification: 'CANDIDATE_ONLY', attemptId: eofAttempt.attemptId, reason: eof.reason,
      playlistEntryId: eof.playlist_entry_id, requiredAuthority: 'Controller presentation reconciliation remains out of scope' }
    engine.events.push(publicMpvEvent(eof))
    await session.ipc.request(['set_property', 'speed', 1])

    const invalidPath = harness.invalidMediaPath
    const errorStart = session.ipc.eventNumber
    await session.ipc.request(['loadfile', invalidPath, 'replace'])
    const errorEvent = await session.ipc.waitForEvent('end-file', errorStart,
      event => event.reason === 'error', 20000)
    engine.controls.invalidMedia = errorEvent.reason === 'error' ? 'PASS' : 'FAIL'
    engine.events.push(publicMpvEvent(errorEvent))

    engine.sampleDecoding = []
    for (const sample of stagedSamples) {
      const attemptStart = session.ipc.eventNumber
      const loadedAttempt = await loadMpvFile(session.ipc, sample.sourcePath, attemptStart,
        { intent: 'sample-decode', code: sample.code })
      const [videoParams, audioParams] = await Promise.all([
        session.ipc.request(['get_property', 'video-params']),
        session.ipc.request(['get_property', 'audio-params'])
      ])
      const video = videoParams.data && {
        width: videoParams.data.w || videoParams.data.width || null,
        height: videoParams.data.h || videoParams.data.height || null,
        codec: videoParams.data.codec || null
      }
      const audio = audioParams.data && {
        format: audioParams.data.format || null,
        channels: audioParams.data.channels || null,
        sampleRate: audioParams.data.samplerate || audioParams.data['samplerate'] || null,
        codec: audioParams.data.codec || null
      }
      engine.sampleDecoding.push({
        code: sample.code,
        attemptId: loadedAttempt.attemptId,
        playlistEntryId: loadedAttempt.loaded.playlist_entry_id,
        loaded: Boolean(loadedAttempt.loaded && loadedAttempt.restarted),
        videoStatus: video && video.width && video.height ? 'DECODER_PARAMETERS_OBSERVED' : 'NOT_VERIFIED',
        video,
        audioStatus: audio ? 'DECODER_PARAMETERS_OBSERVED' : 'NOT_VERIFIED',
        audio
      })
    }
    engine.sampleDecodingSummary = {
      tested: engine.sampleDecoding.length,
      videoDecoderParametersObserved: engine.sampleDecoding.filter(sample => sample.videoStatus === 'DECODER_PARAMETERS_OBSERVED').length,
      audioDecoderParametersObserved: engine.sampleDecoding.filter(sample => sample.audioStatus === 'DECODER_PARAMETERS_OBSERVED').length
    }

    const crashStart = session.ipc.eventNumber
    const crashPlayback = await loadMpvFile(session.ipc, firstPath, crashStart, { intent: 'process-termination-test', code: first.code })
    const terminalBeforeKill = session.ipc.events.some(event => event.eventNumber > crashPlayback.restarted.eventNumber &&
      event.event === 'end-file' && event.playlist_entry_id === crashPlayback.loaded.playlist_entry_id)
    session.child.kill()
    const crashExit = await withTimeout(session.exit, 'forced mpv process termination', 10000)
    const terminalAfterKill = session.ipc.events.find(event => event.eventNumber > crashPlayback.restarted.eventNumber &&
      event.event === 'end-file' && event.playlist_entry_id === crashPlayback.loaded.playlist_entry_id)
    engine.unexpectedTermination = {
      status: crashExit && !terminalBeforeKill && (!terminalAfterKill || terminalAfterKill.reason !== 'eof') ? 'PASS' : 'FAIL',
      attemptId: crashPlayback.attemptId,
      playlistEntryId: crashPlayback.loaded.playlist_entry_id,
      exitCode: crashExit.code,
      signal: crashExit.signal,
      terminalEvent: terminalAfterKill ? { reason: terminalAfterKill.reason, eventNumber: terminalAfterKill.eventNumber } : null,
      eofObserved: Boolean(terminalAfterKill && terminalAfterKill.reason === 'eof'),
      interpretation: 'The mpv process was terminated while a playback attempt was active; termination is not natural EOF'
    }
    engine.events = compactMpvEvents(session.ipc.events)

    engine.audioVideoSynchronization = { status: 'NOT_VERIFIED', reason: 'No synchronized marker fixture was supplied to this harness run' }
    engine.status = Object.values(engine.controls).some(value => String(value).startsWith('FAIL')) ||
      engine.sampleDecodingSummary.videoDecoderParametersObserved !== stagedSamples.length ||
      engine.unexpectedTermination.status === 'FAIL' ? 'FAIL' : 'COMPLETED'
  } catch (error) {
    appendFailure(report, 'mpv', 'evaluation', error)
    engine.mpvStderr = session && redactLocalPaths(session.getStderr()).slice(-1000)
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (session && session.child === child && session.ipc.socket && !session.ipc.socket.destroyed) {
            await session.ipc.request(['quit']).catch(() => {})
          } else child.kill()
          await withTimeout(new Promise(resolve => child.once('exit', resolve)), 'mpv process exit', 10000).catch(() => {})
        } catch {}
      }
    }
    session?.ipc.close()
    engine.events = session ? compactMpvEvents(session.ipc.events) : engine.events
    engine.processTermination = children.length && children.every(child => child.exitCode !== null || child.signalCode !== null)
      ? { status: 'PASS', detail: 'All mpv evaluation processes exited' }
      : children.length ? { status: 'FAIL', detail: 'An mpv evaluation process remained active' } : { status: 'NOT_RUN' }
  }
}

function verifyOriginalsUnchanged(report, selectedSamples) {
  if (!report.samples.staged.length) {
    report.samples.originalsUnchanged = 'NOT_VERIFIED'
    return false
  }
  let unchanged = true
  for (const sample of selectedSamples) {
    try {
      const stat = fs.statSync(sample.sourcePath)
      const hash = sha256(sample.sourcePath)
      const staged = report.samples.staged.find(item => item.code === sample.code)
      if (!staged || hash !== staged.sourceSha256 || stat.size !== sample.size || stat.mtimeMs !== sample.modifiedAt) unchanged = false
    } catch { unchanged = false }
  }
  report.samples.originalsUnchanged = unchanged ? 'PASS' : 'FAIL'
  report.samples.integrityCheckedCodes = report.samples.staged.map(sample => sample.code)
  report.samples.integrityScope = `SHA-256 compared before and after for ${report.samples.integrityCheckedCodes.length} interactive samples; other discovered files were opened read-only but not rehashed by this harness`
  return unchanged
}

function summarizeInteractiveEvents(events) {
  const mediaEvents = new Set(['loadedmetadata', 'playing', 'pause', 'ended', 'error', 'emptied'])
  return events.filter(event => {
    if (event.type === 'electron-fullscreen-enter' || event.type === 'electron-fullscreen-exit' ||
        event.type === 'electron-player-window-closed' || event.type === 'electron-before-quit') return true
    return event.type === 'renderer-event' && mediaEvents.has(event.details && event.details.type)
  }).map(event => {
    if (event.type !== 'renderer-event') return { type: event.type }
    const details = event.details || {}
    const data = details.data && typeof details.data === 'object' ? details.data : {}
    const result = { type: details.type, code: details.code, intent: data.intent, attempt: data.attempt }
    for (const key of ['currentTime', 'duration', 'videoWidth', 'videoHeight', 'errorCode']) {
      if (typeof data[key] === 'number') result[key] = data[key]
    }
    return result
  })
}

async function runChromiumInteractive(report, harnessDirectory, profilePath, stagedSamples, runId, eventLogPath) {
  const engine = report.chromium
  let electronApp
  let processExit
  const { _electron: electron } = require('playwright')
  try {
    electronApp = await electron.launch({ executablePath: require('electron'), args: [harnessDirectory], timeout: 30000 })
    const playerPage = await pageForDocumentTitle(electronApp, 'Karaoke Queue playback evaluation', `KQ P5B Chromium ${runId}`)
    await waitForHarnessApi(playerPage, '__kqP5b', 'Electron playback API')
    const versions = await electronApp.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }))
    engine.version = versions.electron
    engine.status = 'INTERACTIVE_SESSION'
    engine.controls = { operatorSession: 'PENDING_OPERATOR_OBSERVATION' }
    report.environment.electronVersion = versions.electron
    report.environment.chromiumVersion = versions.chromium
    report.environment.displays = await electronApp.evaluate(({ screen }) => screen.getAllDisplays().length)
    process.stdout.write('KQ_P5B_INTERACTIVE_READY ' + JSON.stringify({
      electron: versions.electron,
      chromium: versions.chromium,
      sampleCodes: stagedSamples.map(sample => sample.code),
      controls: ['Select sample', 'Play selected', 'Pause', 'Resume', 'Restart', 'Stop', 'Fullscreen'],
      naturalPlaybackRate: 1,
      humanAudioAndSync: 'PENDING_OPERATOR_OBSERVATION'
    }) + '\n')
    const child = electronApp.process()
    processExit = await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode })
      } else {
        child.once('exit', (code, signal) => resolve({ code, signal }))
      }
    })
    if (processExit.code !== 0) throw new Error(`Interactive Electron harness exited with code ${processExit.code} (${processExit.signal || 'no signal'})`)
    electronApp = null

    let rawEvents = []
    if (fs.existsSync(eventLogPath)) {
      rawEvents = fs.readFileSync(eventLogPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    }
    engine.events = summarizeInteractiveEvents(rawEvents)
    engine.controls.naturalEof = engine.events.some(event => event.type === 'ended') ? 'OBSERVED' : 'NOT_OBSERVED'
    engine.fullscreen = {
      enterObserved: engine.events.some(event => event.type === 'electron-fullscreen-enter'),
      exitObserved: engine.events.some(event => event.type === 'electron-fullscreen-exit')
    }
    engine.processTermination = { status: 'PASS', detail: 'Interactive Electron process exited after the operator closed its only window' }
    engine.status = 'INTERACTIVE_SESSION_COMPLETED'
    report.measurements.visibleVideo = 'PENDING_OPERATOR_OBSERVATION'
    report.measurements.systemAudioLoopback = 'NOT_RUN_IN_INTERACTIVE_MODE'
    report.measurements.audioVideoSynchronization = 'PENDING_OPERATOR_OBSERVATION'
  } catch (error) {
    appendFailure(report, 'chromium', 'interactive-session', error)
    engine.status = 'FAIL'
    engine.diagnostics = evaluationDiagnostics(profilePath)
  } finally {
    if (electronApp) await electronApp.close().catch(() => {})
  }
  if (processExit) {
    engine.processExitCode = processExit.code
    engine.processExitSignal = processExit.signal
  }
}

async function execute({ mode = 'comparison' } = {}) {
  const executionStartedAt = performance.now()
  const report = createReport({ discoveredCount: 0 })
  let selectedSamples = []
  let tempRoot
  let harnessDirectory
  let profilePath
  let stagedSamples = []
  const runId = crypto.randomUUID()
  try {
    if (process.platform !== 'win32') throw new Error('This evaluation must run with native Windows Node.js')
    const mediaDirectory = assertLocalWindowsPath(process.env.KQ_P5B_MEDIA_DIR, 'KQ_P5B_MEDIA_DIR')
    const mediaInfo = listSamples(mediaDirectory)
    selectedSamples = mediaInfo.samples.slice(0, SAMPLE_LIMIT)
    Object.assign(report.samples, {
      discoveredMp4Count: mediaInfo.discoveredCount,
      interactiveCodes: selectedSamples.map(sample => sample.code),
      staged: []
    })
    if (mode === 'interactive') {
      const configuredTempRoot = process.env.KARAOKE_TEST_TEMP_ROOT
      if (configuredTempRoot) {
        tempRoot = assertLocalWindowsPath(configuredTempRoot, 'KARAOKE_TEST_TEMP_ROOT')
        const resolvedTempRoot = path.resolve(tempRoot)
        const systemTempRoot = path.resolve(os.tmpdir())
        if (path.dirname(resolvedTempRoot).toLowerCase() !== systemTempRoot.toLowerCase() ||
            !path.basename(resolvedTempRoot).startsWith('karaoke-queue-windows-e2e-')) {
          throw new Error('The interactive profile must be the runner-owned unique directory directly under the Windows temp root')
        }
        tempRoot = resolvedTempRoot
        if (fs.existsSync(tempRoot)) throw new Error('The isolated interactive profile path already exists')
        fs.mkdirSync(tempRoot, { recursive: false })
      } else {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-p5b-playback-interactive-'))
      }
    } else {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-p5b-playback-evaluation-'))
    }
    harnessDirectory = path.join(tempRoot, 'electron-harness')
    profilePath = path.join(tempRoot, 'isolated-user-data')
    fs.mkdirSync(profilePath, { recursive: false })
    stagedSamples = mediaInfo.samples
    const invalidMediaPath = path.join(tempRoot, 'invalid.mp4')
    fs.writeFileSync(invalidMediaPath, Buffer.alloc(0), { flag: 'wx' })
    stagedSamples = writeElectronHarness(harnessDirectory, stagedSamples, profilePath, runId, { interactiveMode: mode === 'interactive' })
    report.samples.staged = stagedSamples.filter(sample => sample.sourceHash).map(publicSampleSummary)

    if (mode === 'interactive') {
      await runChromiumInteractive(report, harnessDirectory, profilePath, stagedSamples, runId,
        path.join(tempRoot, 'electron-events.jsonl'))
    } else {
      await runChromium(report, harnessDirectory, profilePath, stagedSamples, runId,
        { normalSpeedEof: mode === 'chromium-final' })
      if (mode === 'chromium-final') {
        const interactiveHarness = path.join(tempRoot, 'interactive-controls-harness')
        const interactiveProfile = path.join(tempRoot, 'interactive-controls-user-data')
        fs.mkdirSync(interactiveProfile, { recursive: false })
        writeElectronHarness(interactiveHarness, stagedSamples, interactiveProfile, runId, { interactiveMode: true })
        await runChromiumInteractiveControls(report, interactiveHarness, stagedSamples, runId)
      }
    }
    const mpvExecutable = process.env.KQ_P5B_MPV_EXE
    const mpvPath = mode === 'comparison' && typeof mpvExecutable === 'string' && mpvExecutable.length
      ? assertLocalWindowsPath(mpvExecutable, 'KQ_P5B_MPV_EXE') : null
    if (mode === 'comparison' && mpvPath) {
      report.mpv = emptyEngineReport()
      const electron = require('playwright')._electron
      const app = await electron.launch({ executablePath: require('electron'), args: [harnessDirectory], timeout: 30000 }).catch(() => null)
      if (app) {
        try {
          const observerPage = await pageForDocumentTitle(app, 'Karaoke Queue playback capture observer', `KQ P5B observer ${runId}`)
          await waitForHarnessApi(observerPage, '__kqP5bObserver', 'Electron capture observer API')
          const mpvHarness = { electronApp: app, observerPage, invalidMediaPath }
          await runMpv(report, mpvPath, stagedSamples, runId, mpvHarness, profilePath)
        } catch (error) {
          appendFailure(report, 'mpv', 'observer-startup', error)
          report.mpv.diagnostics = evaluationDiagnostics(profilePath)
        } finally {
          await app.close().catch(() => {})
        }
      } else {
        appendFailure(report, 'mpv', 'observer-startup', new Error('Could not start the isolated Electron capture observer'))
      }
    } else if (mode === 'comparison') {
      report.mpv.status = 'NOT_RUN'
      appendFailure(report, 'mpv', 'configuration', new Error('KQ_P5B_MPV_EXE was not provided'))
    } else {
      report.mpv.status = 'NOT_RUN: excluded by the approved Chromium-only validation scope'
    }

    if (report.environment.displays === 1) report.measurements.multiMonitor = 'NOT_RUN: one Windows display detected'
    else if (report.environment.displays > 1) report.measurements.multiMonitor = 'NOT_VERIFIED: no display movement assertion was performed'
    const originalsUnchanged = verifyOriginalsUnchanged(report, selectedSamples)
    if (!originalsUnchanged) appendFailure(report, null, 'sample-integrity', new Error('A source sample hash, size, or timestamp changed during evaluation'))
    if (mode !== 'interactive') {
      report.measurements.visibleVideo = mode === 'comparison'
        ? ([report.chromium.visibleVideo.status, report.mpv.visibleVideo.status].every(status => status === 'OBSERVED_CHANGING_FRAMES') ? 'PASS_FOR_BOTH' : 'NOT_VERIFIED')
        : report.chromium.visibleVideo.status
      report.measurements.systemAudioLoopback = mode === 'comparison'
        ? { chromium: report.chromium.systemAudioLoopback.status, mpv: report.mpv.systemAudioLoopback.status, comparativeAttribution: 'NOT_VERIFIED' }
        : report.chromium.systemAudioLoopback.status
      report.measurements.audioVideoSynchronization = 'NOT_VERIFIED'
    }
    for (const engineName of mode === 'comparison' ? ['chromium', 'mpv'] : ['chromium']) {
      const engine = report[engineName]
      if (engine.status === 'FAIL' || engine.processTermination.status === 'FAIL') {
        const alreadyReported = report.failures.some(failure => failure.engine === engineName)
        if (!alreadyReported) appendFailure(report, engineName, 'assertion', new Error('One or more required harness assertions failed'))
      }
    }
    report.cleanup = { status: tempRoot && fs.existsSync(tempRoot) ? 'PENDING' : 'PASS', residualMpvProcesses: 'NOT_VERIFIED' }
    report.status = report.failures.length ? 'FAIL' : 'COMPLETED_WITH_UNVERIFIED_MEASUREMENTS'
  } catch (error) {
    appendFailure(report, null, 'setup', error)
    report.status = 'FAIL'
    verifyOriginalsUnchanged(report, selectedSamples)
  } finally {
    if (tempRoot && fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: false })
        report.cleanup = { status: 'PASS', residualMpvProcesses: report.mpv.processTermination.status }
      } catch (error) {
        const cleanupMessage = redactLocalPaths(String(error.message || error)).slice(0, 300)
        report.cleanup = { status: 'FAIL', residualMpvProcesses: report.mpv.processTermination.status, message: cleanupMessage }
        report.status = 'FAIL'
        report.failures.push({ engine: null, step: 'cleanup', message: cleanupMessage })
      }
    }
    report.completedAt = new Date().toISOString()
    report.elapsedMs = Math.round(performance.now() - executionStartedAt)
  }

  report.chromium.events = compactChromiumEvents(report.chromium.events)
  report.mpv.events = compactMpvEvents(report.mpv.events)
  report.chromium.sampleDecoding = compactSampleDecoding(report.chromium.sampleDecoding,
    report.chromium.sampleDecodingSummary, 'chromium')
  report.mpv.sampleDecoding = compactSampleDecoding(report.mpv.sampleDecoding,
    report.mpv.sampleDecodingSummary, 'mpv')
  process.stdout.write('KQ_P5B_REPORT ' + JSON.stringify(report) + '\n')
  if (report.status === 'FAIL') process.exitCode = 1
}

if (require.main === module) {
  const modes = {
    '--chromium-final-validation': 'chromium-final',
    '--interactive-chromium': 'interactive'
  }
  const argumentsList = process.argv.slice(2)
  if (argumentsList.some(argument => !Object.hasOwn(modes, argument)) || argumentsList.length > 1) {
    process.stderr.write('KQ_P5B_FATAL unsupported or conflicting evaluation arguments\n')
    process.exitCode = 2
  } else execute({ mode: modes[argumentsList[0]] || 'comparison' }).catch(error => {
    process.stderr.write('KQ_P5B_FATAL ' + redactLocalPaths(String(error && error.stack || error)) + '\n')
    process.exitCode = 1
  })
}

module.exports = {
  assertLocalWindowsPath,
  compactChromiumEvents,
  compactMpvEvents,
  compactSampleDecoding,
  redactDiagnostic,
  redactLocalPaths,
  assertWindowsPath,
  fullscreenStatus,
  generatedMainSource,
  generatedObserverHtml,
  generatedObserverScript,
  generatedPlayerHtml,
  generatedPlayerScript,
  hashIsValid,
  mpvArguments,
  parseSampleCode,
  pageForDocumentTitle,
  publicMpvEvent,
  publicSampleSummary,
  summarizeInteractiveEvents
}
