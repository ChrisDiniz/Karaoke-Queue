'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { CampaignError, assertQuiescent } = require('./usb-reconnect-core.cjs')
const { _electron: electron } = require('playwright')

function readRecords(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
class ElectronUsbAdapter {
  constructor({ checkout, session, mediaRoot, journal, signal, synthetic = false, entryNonce, processes = async () => 0 }) {
    Object.assign(this, { checkout, session, mediaRoot, journal, signal, synthetic, entryNonce, processes })
    this.profile = path.join(session, 'profile')
    this.indexFile = path.join(this.profile, 'video-library-index.json')
    this.configFile = path.join(this.profile, 'video-library.json')
    this.last = { measurementComplete: true, idle: true, scanActive: false, activeIO: 0, handles: 0, streams: 0, grants: 0, processes: 0 }
  }
  async bounded(promise, code, ms = 30000) {
    let timer
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CampaignError(code)), ms)
      })])
    } finally { clearTimeout(timer) }
  }
  async sample() {
    if (!this.app) return { ...this.last, processes: await this.processes(this.profile) }
    const state = await this.app.evaluate(() => global.__t3.state())
    const events = await this.app.evaluate(() => global.__t3.drain())
    for (const event of events) this.journal.event('main-observation', event)
    this.last = { ...state, processes: 1 }
    return this.last
  }
  async until(predicate, code, timeoutMs = 180000) {
    const deadline = performance.now() + timeoutMs
    do {
      if (this.signal?.aborted) throw new CampaignError('OPERATOR_CANCELLED', 'PARTIAL')
      const state = await this.sample()
      if (await predicate(state)) return state
      // Poll observations, never issue a filesystem probe or infer success from elapsed time.
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (performance.now() < deadline)
    this.journal.event('observation-timeout', { code, last: this.last })
    throw new CampaignError(code, 'FAIL')
  }
  async start() {
    if (this.app) throw new CampaignError('TEST_APP_ALREADY_ACTIVE')
    if (await this.processes(this.profile)) throw new CampaignError('TEST_PROFILE_STILL_ACTIVE')
    fs.mkdirSync(this.profile, { recursive: true })
    require('./usb-reconnect-native.cjs').assertPrivateTree(this.profile)
    if (!fs.existsSync(this.configFile)) {
      fs.writeFileSync(path.join(this.profile, 'operating-mode.json'), JSON.stringify({ version: 1, mode: 'player' }), { flag: 'wx' })
      fs.writeFileSync(this.configFile, JSON.stringify({ version: 1, roots: [this.mediaRoot] }), { flag: 'wx' })
    } else if (JSON.stringify(JSON.parse(fs.readFileSync(this.configFile)).roots) !== JSON.stringify([this.mediaRoot])) {
      throw new CampaignError('PROFILE_LIBRARY_MISMATCH')
    }
    this.previousLogCount = readRecords(path.join(this.profile, 'logs/app.log')).length
    const permitFile = path.join(this.session, 'entry-permit.json')
    if (this.synthetic) {
      this.entryNonce ||= crypto.randomBytes(32).toString('hex')
      if (this.mediaRoot !== path.join(this.session, 'fixture')) throw new CampaignError('SYNTHETIC_WRITE_SCOPE_INVALID')
      if (!fs.existsSync(permitFile)) fs.writeFileSync(permitFile, JSON.stringify({ nonce: this.entryNonce,
        session: this.session, mediaRoot: this.mediaRoot, modality: 'synthetic' }), { flag: 'wx', mode: 0o600 })
    }
    const permit = JSON.parse(fs.readFileSync(permitFile, 'utf8'))
    require('./usb-reconnect-core.cjs').validateEntryPermit(permit, { nonce: this.entryNonce, session: this.session,
      mediaRoot: this.mediaRoot, profile: this.profile, ci: process.env.CI || process.env.GITHUB_ACTIONS })
    this.launchWallTime = Date.now()
    this.launchedAt = performance.now()
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    this.app = await electron.launch({ executablePath: require('electron'),
      args: [path.join(this.checkout, 'build/tests/usb-reconnect-main-entry.js'), `--user-data-dir=${this.profile}`],
      env: { ...env, KQ_T3_MEDIA_ROOT: this.mediaRoot, KQ_T3_SESSION: this.session, KQ_T3_ENTRY_TOKEN: this.entryNonce, KQ_F0_DIAGNOSTICS: '1',
        XDG_CONFIG_HOME: path.join(this.session, 'config'), XDG_CACHE_HOME: path.join(this.session, 'cache'),
        XDG_DATA_HOME: path.join(this.session, 'data') }, timeout: 30000 })
    this.page = await this.app.firstWindow()
    this.windowObservedMs = performance.now() - this.launchedAt
    await this.page.waitForFunction(() => window.standalonePlayer?.getSnapshot)
    await this.until(s => s.measurementComplete && s.idle, 'OPERATIONAL_IPC_NOT_READY', 30000)
    const operational = await this.page.evaluate(() => window.standalonePlayer.getSnapshot())
    if (operational.snapshot.playbackCondition !== 'ready') throw new CampaignError('OPERATIONAL_IPC_NOT_READY', 'FAIL')
    this.uiObservedMs = performance.now() - this.launchedAt
    this.journal.event('electron-window-and-ipc-observed', { windowPageObservedMs: this.windowObservedMs,
      operationalIpcObservedMs: this.uiObservedMs, source: 'driver monotonic observation, before waiting for reconciliation' })
  }
  async ready() {
    const state = await this.until(s => s.measurementComplete && s.idle && !s.scanActive && s.activeIO === 0,
      'LIBRARY_RECONCILIATION_NOT_COMPLETE')
    const records = readRecords(path.join(this.profile, 'logs/app.log')).slice(this.previousLogCount)
    const usable = records.find(r => r.event === 'F0_STARTUP_USABLE_METRICS')
    const admit = records.find(r => r.event === 'F0_LIBRARY_RECONCILIATION_ADMITTED')
    const windowReady = records.find(r => r.event === 'F0_WINDOW_READY_METRICS')
    const cache = records.find(r => r.event === 'F0_LIBRARY_INDEX_LOAD_METRICS')
    const scan = records.find(r => r.event === 'F0_LIBRARY_SCAN_METRICS')
    const options = await this.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
    const envelope = await this.page.evaluate(() => window.standalonePlayer.getSnapshot())
    const gated = Boolean(usable && admit && usable.details.entriesEnumerated === 0 && usable.details.fileOpens === 0 &&
      usable.details.elapsedMs <= admit.details.elapsedMs && state.firstReaddirAt >= state.gateAt && windowReady?.details.windowVisible && envelope.snapshot.playbackCondition === 'ready')
    const measured = { idle: state.idle, gated, indexedFiles: options.library.indexedFiles,
      cacheRestored: cache?.details.cacheStatus === 'restored', indexReadMs: cache?.details.durationMs ?? null,
      windowFromMainReadyMs: windowReady?.details.elapsedSinceMainReadyMs ?? null,
      usableFromMainReadyMs: usable?.details.elapsedSinceMainReadyMs ?? null,
      windowFromProcessMs: windowReady ? Date.parse(windowReady.timestamp) - this.launchWallTime : null,
      uiObservationFromProcessMs: this.uiObservedMs,
      firstReaddirMainMonotonicMs: state.firstReaddirAt, admissionMainMonotonicMs: state.gateAt,
      gateMainMonotonicMs: usable?.details.elapsedMs ?? null,
      reconciliationAdmissionMainMonotonicMs: admit?.details.elapsedMs ?? null,
      scan: state.scan, startupScan: scan?.details, generation: state.generation, availability: state.availability }
    if (!gated || !scan || options.library.scanStatus !== 'ready') throw new CampaignError('MAIN_STARTUP_GATE_OR_INVENTORY_FAILED', 'FAIL')
    this.journal.event('startup-ready', measured)
    return measured
  }
  async rememberInventory() {
    this.configHash = digest(this.configFile)
    this.indexHash = digest(this.indexFile)
    this.indexGeneration = JSON.parse(fs.readFileSync(this.indexFile)).generation
  }
  async assertPreserved() {
    if (digest(this.configFile) !== this.configHash || digest(this.indexFile) !== this.indexHash) {
      throw new CampaignError('CONFIGURATION_OR_INDEX_LOST', 'FAIL')
    }
    this.journal.event('inventory-preserved', { generation: this.indexGeneration })
  }
  async resources() { return this.sample() }
  async quiesce() {
    const state = await this.until(s => s.idle && !s.scanActive, 'NOT_IDLE_FOR_QUIESCENCE')
    if (state.violation) throw new CampaignError('INSTRUMENTATION_SAFETY_VIOLATION')
    await this.bounded(this.app.evaluate(() => global.__t3.quiesce()), 'IO_QUIESCENCE_UNVERIFIED')
    assertQuiescent(await this.sample(), false)
  }
  async resumeDiscovery() {
    await this.app.evaluate(({ BrowserWindow }) => {
      global.__t3.resume()
      BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('standalone-player.html')).focus()
    })
    // Uses real focus/monitor policy (5s foreground, 30s background), no forced probe.
    this.journal.event('discovery-observation-start', { focus: (await this.sample()).focused,
      foregroundIntervalMs: 5000, backgroundIntervalMs: 30000, observationDeadlineMs: 60000 })
  }
  async availability(available) {
    if (await this.page.evaluate(() => document.body.dataset.menuScreen) !== 'options') {
      await this.page.keyboard.press('Escape')
      await this.page.locator('#menu-item-options').click()
    }
    const startedAt = performance.now()
    const state = await this.until(async s => {
      const options = await this.page.evaluate(() => window.standalonePlayer.getOptionsSnapshot())
      const text = await this.page.locator('#options-library-state').textContent()
      return available
        ? options.library.scanStatus === 'ready' && text === 'Pasta disponível' && !s.scanActive
        : options.library.scanStatus === 'degraded' && text === 'Pasta indisponível'
    }, available ? 'RETURN_NOT_DETECTED' : 'LOSS_NOT_DETECTED', 60000)
    const result = { available, detectionFromDiscoveryResumeMs: performance.now() - startedAt,
      focused: state.focused, availability: state.availability, scanStarts: state.scanStarts }
    this.journal.event('main-ui-availability', result)
    return result
  }
  async selectMusic() {
    const index = JSON.parse(fs.readFileSync(this.indexFile))
    const counts = new Map()
    for (const root of index.roots) for (const file of root.entries) counts.set(file.musicCode, (counts.get(file.musicCode) || 0) + 1)
    const code = [...counts].find(([, count]) => count === 1)?.[0]
    if (!code) throw new CampaignError('NO_UNAMBIGUOUS_SELECTION', 'FAIL')
    if (await this.page.evaluate(() => document.body.dataset.menuScreen) === 'options') {
      await this.page.keyboard.press('Escape'); await this.page.keyboard.press('Escape')
    }
    for (const digit of String(Number(code))) await this.page.keyboard.press(digit)
    await this.page.keyboard.press('Enter')
    this.journal.event('selection-submit-observed', { selectedCount: 1, before: await this.sample() })
    await this.until(s => s.playbackStatus === 'playing' && !s.idle, 'SELECTION_NOT_PLAYING', 30000)
    await this.page.waitForFunction(() => {
      const media = document.querySelector('#playback-media-layer video')
      return media && !media.paused && media.currentTime >= 0.25
    }, undefined, { timeout: 30000 })
    const playingResources = await this.sample()
    if (!playingResources.media?.requests || !playingResources.media.bytesRead || !playingResources.media.fileHandlesOpened) throw new CampaignError('MEDIA_PROTOCOL_NOT_OBSERVED', 'FAIL')
    this.journal.event('real-media-time-advance-observed', { minimumSeconds: 0.25, media: playingResources.media })
    await this.page.keyboard.press('Control+Space')
    await this.page.locator('#standalone-stop-confirmation').waitFor({ state: 'visible' })
    await this.page.locator('#stop-confirmation-confirm').click()
    await this.until(s => s.idle && s.streams === 0 && s.grants === 0 && s.handles === 0, 'SELECTION_STOP_NOT_RELEASED')
    const released = await this.sample()
    if (released.media.fileHandlesOpened !== released.media.fileHandlesClosed || released.media.fileHandleCloseFailures) throw new CampaignError('MEDIA_HANDLE_RELEASE_FAILED', 'FAIL')
    this.journal.event('selection-and-real-playback-confirmed', { selectedCount: 1, mediaNamesRecorded: false })
  }
  async close() {
    if (!this.app) return
    const app = this.app
    const child = app.process()
    const exit = child.exitCode !== null ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
    if (this.page && !this.page.isClosed()) {
      await this.page.locator('#standalone-exit-confirmation').waitFor({ state: 'visible', timeout: 15000 })
      await this.page.locator('#exit-confirmation-confirm').click().catch(error => {
        if (!this.page.isClosed()) throw error
      })
    }
    const result = await this.bounded(exit, 'ELECTRON_EXIT_UNVERIFIED')
    if (result.code !== 0 || result.signal) throw new CampaignError('ELECTRON_EXIT_FAILED')
    this.app = undefined; this.page = undefined
    if (await this.processes(this.profile)) throw new CampaignError('RESIDUAL_PROFILE_PROCESS')
    this.last = { ...this.last, processes: 0, idle: true, scanActive: false, activeIO: 0, handles: 0, streams: 0, grants: 0, resourceSource: 'verified process exit; no owned resources can remain in that process' }
    this.journal.event('electron-exited', { code: result.code, processes: 0 })
  }
  async createSyntheticMedia(durationMs = 4000) {
    if (!Number.isInteger(durationMs) || durationMs < 4000 || durationMs > 60000) throw new CampaignError('SYNTHETIC_DURATION_INVALID')
    if (!this.synthetic || this.mediaRoot !== path.join(this.session, 'fixture')) throw new CampaignError('SYNTHETIC_WRITE_SCOPE_INVALID')
    const bytes = await this.app.evaluate(async ({ BrowserWindow }, durationMs) => {
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      try {
        await window.loadURL('data:text/html,<canvas id="c" width="160" height="90"></canvas>')
        return await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
          const canvas=document.getElementById('c'),ctx=canvas.getContext('2d');
          const stream=canvas.captureStream(15);const chunks=[];
          const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
          recorder.onerror=reject;recorder.ondataavailable=e=>chunks.push(e.data);
          recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())))};
          const start=performance.now();function draw(){const now=performance.now();ctx.fillStyle='navy';ctx.fillRect(0,0,160,90);ctx.fillStyle='white';ctx.fillRect((now/20)%140,20,20,20);if(now-start<${durationMs})requestAnimationFrame(draw);else recorder.stop()};recorder.start();draw();
        })`)
      } finally { window.destroy() }
    }, durationMs)
    fs.writeFileSync(path.join(this.mediaRoot, '00001.webm'), Buffer.from(bytes), { flag: 'wx' })
    const reply = await this.page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())
    if (reply.outcome !== 'confirmed') throw new CampaignError('FIXTURE_REFRESH_FAILED', 'FAIL')
  }
}
module.exports = { ElectronUsbAdapter, readRecords }
