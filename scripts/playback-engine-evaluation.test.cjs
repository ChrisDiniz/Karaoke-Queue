'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const {
  assertLocalWindowsPath,
  compactChromiumEvents,
  compactMpvEvents,
  compactSampleDecoding,
  generatedMainSource,
  generatedObserverHtml,
  generatedObserverScript,
  generatedPlayerHtml,
  generatedPlayerScript,
  fullscreenStatus,
  hashIsValid,
  mpvArguments,
  pageForDocumentTitle,
  parseSampleCode,
  publicMpvEvent,
  publicSampleSummary,
  summarizeInteractiveEvents,
  redactDiagnostic,
  redactLocalPaths
} = require('./playback-engine-evaluation.cjs')

test('sample filename extraction accepts exactly five leading digits and a clear boundary', () => {
  assert.equal(parseSampleCode('00001.mp4'), '00001')
  assert.equal(parseSampleCode('00123 - Queen.MP4'), '00123')
  assert.equal(parseSampleCode('01001_Always.mkv'), '01001')
  assert.equal(parseSampleCode('123456 - ambiguous.mp4'), null)
  assert.equal(parseSampleCode('track-00123.mp4'), null)
  assert.equal(parseSampleCode('1234.mp4'), null)
})

test('media and executable inputs require local absolute Windows drive paths', () => {
  assert.equal(assertLocalWindowsPath('D:\\Media\\Videos', 'media'), 'D:\\Media\\Videos')
  assert.throws(() => assertLocalWindowsPath('relative\\videos', 'media'), /absolute Windows path/)
  assert.throws(() => assertLocalWindowsPath('\\\\server\\share\\videos', 'media'), /local Windows drive path/)
  assert.throws(() => assertLocalWindowsPath('D:\\bad\0path', 'media'), /absolute Windows path/)
})

test('mpv uses fixed isolated IPC arguments and disables user configuration/scripts', () => {
  const args = mpvArguments('\\\\.\\pipe\\kq-p5b-123', 'KQ P5B test')
  assert.ok(args.includes('--no-config'))
  assert.ok(args.includes('--load-scripts=no'))
  assert.ok(args.includes('--input-ipc-server=\\\\.\\pipe\\kq-p5b-123'))
  assert.equal(args.some(argument => argument.startsWith('--input-ipc-server=tcp://')), false)
  assert.equal(args.some(argument => argument.includes(' -- ')), false)
})

test('public reporting helpers validate hashes and omit absolute media paths', () => {
  assert.equal(hashIsValid('a'.repeat(64)), true)
  assert.equal(hashIsValid('../not-a-hash'), false)
  const sample = publicSampleSummary({
    code: '00123',
    fileName: '00123 - Song.mp4',
    sourcePath: 'D:\\Private\\Media\\00123 - Song.mp4',
    fileUrl: 'file:///D:/Private/Media/00123%20-%20Song.mp4',
    sourceHash: 'b'.repeat(64),
    size: 12,
    originalMtimeMs: 34
  })
  assert.equal(sample.code, '00123')
  assert.equal(Object.values(sample).some(value => String(value).includes('Private')), false)

  const event = publicMpvEvent({
    event: 'property-change',
    eventNumber: 12,
    id: 4,
    data: 'D:\\Private\\Media\\00123.mp4',
    filename: 'D:\\Private\\Media\\00123.mp4'
  })
  assert.equal(event.event, 'property-change')
  assert.equal(JSON.stringify(event).includes('Private'), false)
})

test('serialized event summaries retain lifecycle signals but drop progress noise and local paths', () => {
  const mpv = compactMpvEvents([
    { event: 'start-file', eventNumber: 1, playlist_entry_id: 7 },
    { event: 'property-change', eventNumber: 2, id: 2, data: 1.25 },
    { event: 'end-file', eventNumber: 3, playlist_entry_id: 7, reason: 'eof' }
  ])
  assert.deepEqual(mpv.map(event => event.event), ['start-file', 'end-file'])

  const chromium = compactChromiumEvents([
    { type: 'renderer-event', at: 1, details: { type: 'timeupdate', data: { currentTime: 3 } } },
    { type: 'renderer-event', at: 2, details: { type: 'playing', code: '00123', data: { currentTime: 4, filePath: 'C:\\Private\\song.mp4' } } },
    { type: 'electron-fullscreen-enter', at: 3, details: {} }
  ])
  assert.deepEqual(chromium.map(event => event.type === 'renderer-event' ? event.details.type : event.type), [
    'playing', 'electron-fullscreen-enter'
  ])
  assert.equal(JSON.stringify(chromium).includes('Private'), false)
})

test('failure diagnostics redact Windows, UNC, file URL and POSIX paths', () => {
  const cases = [
    ['C:\\Users\\karaoke operator\\AppData\\Temp\\media clip.mp4', ['karaoke', 'operator', 'AppData']],
    ['file:///C:/Users/karaoke%20operator/AppData/Temp/media%20clip.mp4', ['karaoke', 'operator', 'AppData']],
    ['\\\\nas server\\shared media\\folder\\clip.mp4', ['nas server', 'shared media']],
    ['/home/operator name/media folder/clip.mp4', ['operator', 'media folder']],
    ['/tmp/kq profile/renderer.log', ['kq profile', 'renderer.log']]
  ]
  for (const [source, privateFragments] of cases) {
    const redacted = redactLocalPaths(source)
    for (const privateFragment of privateFragments) assert.equal(redacted.includes(privateFragment), false)
    assert.equal(redactDiagnostic({ nested: [source] }).nested[0].includes(privateFragments[0]), false)
  }
})

test('compact decoding summary preserves the status of every tested music code', () => {
  const compact = compactSampleDecoding([
    { code: '01001', status: 'FIRST_FRAME_CALLBACK_OBSERVED', width: 1024, height: 768 },
    { code: '01002', status: 'NOT_VERIFIED', width: 0, height: 0 }
  ], { tested: 2, videoFirstFrameObserved: 1 }, 'chromium')
  assert.deepEqual(compact.results.map(result => [result.code, result.status]), [
    ['01001', 'FIRST_FRAME_CALLBACK_OBSERVED'], ['01002', 'NOT_VERIFIED']
  ])
})

test('Chromium-only report can represent an engine that was intentionally not run', () => {
  assert.deepEqual(compactSampleDecoding(undefined, undefined, 'mpv'), {
    tested: 0,
    summary: null,
    results: []
  })
})

test('Chromium compact events retain the emptied event used to verify stop', () => {
  const compact = compactChromiumEvents([
    { type: 'renderer-event', at: 1, details: { type: 'emptied', code: '00123', data: { currentTime: 0 } } }
  ])
  assert.equal(compact.length, 1)
  assert.equal(compact[0].details.type, 'emptied')
})

test('generated isolated Electron harness scripts are syntactically valid', () => {
  assert.doesNotThrow(() => new vm.Script(generatedMainSource()))
  const observerScript = generatedObserverScript()
  const playerScript = generatedPlayerScript([
    { code: '00123', fileName: '00123.mp4', fileUrl: 'file:///D:/media/00123.mp4' }
  ], 'file:///tmp/invalid.mp4')
  assert.match(observerScript, /^'use strict';\s*\(\(\) =>/)
  assert.match(playerScript, /^'use strict';\s*\(\(\) =>/)
  assert.doesNotThrow(() => new vm.Script(observerScript))
  assert.doesNotThrow(() => new vm.Script(playerScript))
})

test('interactive Chromium harness exposes only coded sample selection and basic playback controls', () => {
  const samples = [
    { code: '01001', fileName: '01001.mp4', fileUrl: 'file:///D:/media/01001.mp4' },
    { code: '01002', fileName: '01002 - <script>.mp4', fileUrl: 'file:///D:/media/01002.mp4' }
  ]
  const html = generatedPlayerHtml(true)
  const script = generatedPlayerScript(samples, 'file:///D:/temp/invalid.mp4', true)
  const main = generatedMainSource()

  for (const id of ['sample', 'play', 'pause', 'resume', 'restart', 'stop', 'fullscreen']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(script, /option\.textContent = code \+ ' — ' \+ fileName/)
  assert.doesNotMatch(script, /option\.innerHTML/)
  const playbackBranchStart = script.indexOf('if (interactiveMode) {', script.indexOf("document.getElementById('stop')"))
  const playbackBranchEnd = script.indexOf('} else {', playbackBranchStart)
  const interactiveBranch = script.slice(playbackBranchStart, playbackBranchEnd)
  const noninteractiveBranch = script.slice(playbackBranchEnd)
  assert.match(interactiveBranch, /loadAndPlay\(select\.value\)/)
  assert.doesNotMatch(interactiveBranch, /getElementById\('play'\).*\.play\(\)\.catch/,
    'interactive sample selection must not also trigger the generic resume handler')
  assert.match(noninteractiveBranch, /getElementById\('play'\).*\.play\(\)\.catch/)
  assert.match(script, /togglePlayerFullscreen\(\)/)
  assert.match(main, /config\.interactiveMode !== true/)
  assert.match(main, /event\.sender !== playerWindow\.webContents/)
})

test('interactive event summary keeps playback lifecycle and omits local media paths', () => {
  const events = summarizeInteractiveEvents([
    { type: 'renderer-event', details: { type: 'playing', code: '01001', data: { intent: 'manual-selection', attempt: 1, currentTime: 0, filePath: 'C:\\Private\\01001.mp4' } } },
    { type: 'renderer-event', details: { type: 'ended', code: '01001', data: { intent: 'manual-selection', attempt: 1, currentTime: 198.7, duration: 198.7 } } },
    { type: 'renderer-event', details: { type: 'timeupdate', code: '01001', data: { currentTime: 4 } } },
    { type: 'electron-fullscreen-enter', details: { path: 'C:\\Private' } },
    { type: 'renderer-event', details: { type: 'error', code: '01002', data: { errorCode: 4 } } }
  ])

  assert.deepEqual(events.map(event => event.type), ['playing', 'ended', 'electron-fullscreen-enter', 'error'])
  assert.equal(events[1].currentTime, 198.7)
  assert.equal(JSON.stringify(events).includes('Private'), false)
})

test('isolated file URLs can load only the harness local scripts and media', () => {
  const playerHtml = generatedPlayerHtml()
  const observerHtml = generatedObserverHtml()
  assert.match(playerHtml, /script-src 'self' file:/)
  assert.match(playerHtml, /media-src 'self' file:/)
  assert.match(observerHtml, /script-src 'self' file:/)
  assert.match(observerHtml, /media-src 'self' file: blob:/)
  assert.doesNotMatch(playerHtml + observerHtml, /https?:\/\//)
})

test('Electron page lookup uses the HTML document title while reporting the native window title', async () => {
  const app = new EventEmitter()
  const playerPage = { title: async () => 'Karaoke Queue playback evaluation' }
  const observerPage = { title: async () => 'Karaoke Queue playback capture observer' }
  app.windows = async () => [playerPage, observerPage]

  assert.equal(await pageForDocumentTitle(app, 'Karaoke Queue playback evaluation', 'KQ P5B Chromium run'), playerPage)
  assert.equal(await pageForDocumentTitle(app, 'Karaoke Queue playback capture observer', 'KQ P5B observer run'), observerPage)
  await assert.rejects(
    pageForDocumentTitle(app, 'unrelated title', 'KQ P5B Chromium run', 1),
    /Electron evaluation window did not open: KQ P5B Chromium run/
  )
})

test('Electron page lookup waits for a newly created, fully loaded window', async () => {
  const app = new EventEmitter()
  app.windows = async () => []
  const observerPage = { title: async () => 'Karaoke Queue playback capture observer' }

  const lookup = pageForDocumentTitle(app, 'Karaoke Queue playback capture observer', 'KQ P5B observer', 1000)
  setImmediate(() => app.emit('window', observerPage))

  assert.equal(await lookup, observerPage)
  assert.equal(app.listenerCount('window'), 0)
})

test('Electron page lookup reports observed titles and removes listeners after timeout', async () => {
  const app = new EventEmitter()
  const existingPage = { title: async () => 'Karaoke Queue playback evaluation' }
  app.windows = async () => [existingPage]

  await assert.rejects(
    pageForDocumentTitle(app, 'Karaoke Queue playback capture observer', 'KQ P5B observer', 1),
    /observed document titles: Karaoke Queue playback evaluation/
  )
  assert.equal(app.listenerCount('window'), 0)
})

test('fullscreen PASS requires a successful window transition and changing captured frames', () => {
  assert.equal(fullscreenStatus(true, { status: 'OBSERVED_CHANGING_FRAMES', distinctFrameHashes: 3 }), 'PASS')
  assert.equal(fullscreenStatus(true, { status: 'NOT_VERIFIED', distinctFrameHashes: 0 }), 'NOT_VERIFIED')
  assert.equal(fullscreenStatus(true, { status: 'OBSERVED_CHANGING_FRAMES', distinctFrameHashes: 1 }), 'NOT_VERIFIED')
  assert.equal(fullscreenStatus(false, { status: 'OBSERVED_CHANGING_FRAMES', distinctFrameHashes: 3 }), 'FAIL')
})
