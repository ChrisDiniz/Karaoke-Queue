// @ts-nocheck
// T3 observation/quiescence only. The application itself is the real package Main.
export {}
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const root = path.resolve(__dirname, '../..')
let mediaRoot

// The test entry cannot be used as an unattended physical runner or with a default profile.
try {
  if (!process.env.KQ_T3_MEDIA_ROOT || !process.env.KQ_T3_SESSION) throw new Error('Missing session')
  mediaRoot = path.resolve(process.env.KQ_T3_MEDIA_ROOT)
  const session = path.resolve(process.env.KQ_T3_SESSION || '')
  const file = path.join(session, 'entry-permit.json')
  require('../../scripts/usb-reconnect-native.cjs').assertNoReparse(session)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Invalid permission file')
  const profileArg = process.argv.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
  require('../../scripts/usb-reconnect-core.cjs').validateEntryPermit(JSON.parse(fs.readFileSync(file, 'utf8')), {
    nonce: process.env.KQ_T3_ENTRY_TOKEN, session, mediaRoot, profile: profileArg,
    ci: process.env.CI || process.env.GITHUB_ACTIONS
  })
} catch {
  console.error('T3_ENTRY_SESSION_PERMISSION_REQUIRED')
  app.exit(2)
  throw new Error('T3_ENTRY_SESSION_PERMISSION_REQUIRED')
}
app.setAppPath(root)
const { MainMediaRuntime } = require('../src/main-media-runtime')
const { VideoLibraryService } = require('../src/video-library-service')
const { StandalonePlayerSequence } = require('../src/standalone-player-sequence')
const control = global.__t3 = { runtime: null, paused: false, frozen: false, activeIO: 0, handles: 0,
  counts: {}, scanStarts: 0, events: [], waiters: new Set(), firstReaddirAt: null, violation: false }
function event(type, detail = {}) {
  if (control.events.length >= 4000) { control.violation = true; return }
  control.events.push({ type, at: performance.now(), ...detail })
}
function changed() { for (const wake of control.waiters) wake() }
function onMedia(value) {
  if (typeof value !== 'string') return false
  const normalize = text => process.platform === 'win32' ? path.resolve(text).toLowerCase() : path.resolve(text)
  const resolved = normalize(value)
  return resolved === normalize(mediaRoot) || resolved.startsWith(normalize(mediaRoot) + path.sep)
}
for (const method of ['readdir', 'stat', 'lstat', 'realpath', 'access', 'open']) {
  const original = fs.promises[method]
  fs.promises[method] = async (...args) => {
    if (!onMedia(args[0])) return original.apply(fs.promises, args)
    if (control.frozen) { control.violation = true; event('io-after-quiescence', { method }); throw new Error('T3_IO_FROZEN') }
    control.activeIO++
    control.counts[method] = (control.counts[method] || 0) + 1
    if (method === 'readdir' && control.firstReaddirAt === null) control.firstReaddirAt = performance.now()
    try {
      const result = await original.apply(fs.promises, args)
      if (method === 'open') {
        control.handles++
        let closed = false
        const finished = () => { if (!closed) { closed = true; control.handles--; changed() } }
        if (typeof result.once !== 'function') {
          await result.close(); control.handles--; throw new Error('T3_HANDLE_CLOSE_OBSERVATION_UNAVAILABLE')
        }
        result.once('close', finished)
        const close = result.close.bind(result)
        result.close = async () => { await close(); finished() }
      }
      return result
    } finally { control.activeIO--; changed() }
  }
}
const initialize = MainMediaRuntime.prototype.initializePlayerInfrastructure
MainMediaRuntime.prototype.initializePlayerInfrastructure = function (...args) {
  control.runtime = this
  return initialize.apply(this, args)
}
const admit = MainMediaRuntime.prototype.admitStandaloneReconciliation
MainMediaRuntime.prototype.admitStandaloneReconciliation = function (...args) {
  control.gateAt = performance.now()
  event('operational-admission', { enumerations: control.counts.readdir || 0 })
  return admit.apply(this, args)
}
const probe = MainMediaRuntime.prototype.probeLibraryAvailability
MainMediaRuntime.prototype.probeLibraryAvailability = async function (...args) {
  if (control.paused) return undefined
  event('probe-start', { focused: control.focused() })
  const result = await probe.apply(this, args)
  event('probe-end', { availability: this.library?.getAvailabilitySummary() })
  return result
}
const scan = VideoLibraryService.prototype.scanOnce
VideoLibraryService.prototype.scanOnce = async function (...args) {
  if (control.frozen) { control.violation = true; throw new Error('T3_SCAN_DURING_QUIESCENCE') }
  control.scanStarts++
  event('scan-start', { scan: control.scanStarts })
  try { return await scan.apply(this, args) }
  finally { event('scan-end', { scan: control.scanStarts, metrics: this.getScanDiagnosticSnapshot() }); changed() }
}
const refresh = VideoLibraryService.prototype.refresh
VideoLibraryService.prototype.refresh = function (...args) {
  if (control.paused) return Promise.resolve(this.getSnapshot())
  return refresh.apply(this, args)
}
const execute = StandalonePlayerSequence.prototype.execute
StandalonePlayerSequence.prototype.execute = function (...args) {
  if (control.paused) return Promise.reject(new Error('T3_OPERATOR_IO_QUIESCENCE'))
  return execute.apply(this, args)
}
control.focused = () => BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isFocused())
control.state = () => {
  const runtime = control.runtime
  const sequence = runtime?.sequence?.getSnapshot()
  const metrics = runtime?.mediaProtocol?.getDiagnosticMetrics()
  const library = runtime?.library
  return { measurementComplete: Boolean(runtime && sequence && metrics && library),
    idle: sequence?.playbackCondition === 'ready' && sequence.state.operationalState === 'idle' && !sequence.state.current && sequence.state.pending.length === 0 && runtime?.playback?.getState().status === 'idle',
    sequenceCondition: sequence?.playbackCondition,
    playbackStatus: runtime?.playback?.getState().status,
    scanActive: library?.getScanDiagnosticSnapshot().scanInProgress ?? true,
    activeIO: control.activeIO, handles: control.handles,
    streams: metrics?.activeStreams, grants: metrics?.activeGrants,
    media: metrics, scanStarts: control.scanStarts, scan: library?.getScanDiagnosticSnapshot(),
    indexedFiles: library?.getSnapshot().counts.indexedFiles,
    revision: library?.getSnapshot().revision, generation: library?.indexGeneration,
    availability: library?.getAvailabilitySummary(), focused: control.focused(),
    firstReaddirAt: control.firstReaddirAt, gateAt: control.gateAt, paused: control.paused, violation: control.violation }
}
control.quiesce = async () => {
  if (!control.state().idle) throw new Error('T3_NOT_IDLE')
  control.paused = true
  const runtime = control.runtime
  runtime.stopAvailabilityMonitor()
  await runtime.sequence.composition.transitions.run(() => undefined)
  await runtime.backgroundScan
  await runtime.library.refreshPromise
  await runtime.library.probePromise
  while (control.activeIO || control.handles) {
    await new Promise(resolve => { const wake = () => { control.waiters.delete(wake); resolve() }; control.waiters.add(wake) })
  }
  const state = control.state()
  if (!state.idle || state.scanActive || state.streams || state.grants || state.violation) throw new Error('T3_NOT_QUIESCENT')
  control.frozen = true
  event('quiescent')
  return control.state()
}
control.resume = () => {
  control.frozen = false
  control.paused = false
  control.runtime.startAvailabilityMonitor()
  event('discovery-resumed')
}
control.drain = () => control.events.splice(0)
require(path.join(root, require(path.join(root, 'package.json')).main))
