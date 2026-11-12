'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  isExcludedPath,
  isSensitivePath,
  isExpectedManualElectronProcess,
  lastNonEmptyLine,
  observeWorkerInputErrors,
  makeFingerprint,
  normalizePath,
  generatedBuildPaths,
  prepareFreshBuild,
  powershellCancellation,
  powershellLauncher,
  recoverNoopInterruptedSync,
  requiresStandaloneProductionMedia,
  requiresWindowFocus,
  selectWindowsTestSuites,
  stageSnapshot,
  verifyBuildOutput,
  restorePreviousBuild,
  syncSnapshot,
  cleanupSyncBackup,
  validateLegacyManifest,
  validateManifest,
  verifySnapshotDirectory,
  verifyThenRun
} = require('./run-windows-native-tests.cjs')

const head = '0123456789abcdef0123456789abcdef01234567'

test('manual launch confirms PID, exact image, app root and profile even when WMI omits ExecutablePath', () => {
  const expected = {
    ProcessId: 24508,
    ExecutablePath: null,
    CommandLine: '"E:\\Karaoke Queue\\checkout\\node_modules\\electron\\dist\\electron.exe" ' +
      '"E:\\Karaoke Queue\\checkout" "--user-data-dir=E:\\Karaoke Queue\\profiles\\fresh-test"'
  }
  const executable = 'E:\\Karaoke Queue\\checkout\\node_modules\\electron\\dist\\electron.exe'
  const appRoot = 'E:\\Karaoke Queue\\checkout'
  const profilePath = 'E:\\Karaoke Queue\\profiles\\fresh-test'

  assert.equal(isExpectedManualElectronProcess(expected, 24508, executable, appRoot, profilePath), true)
  assert.equal(isExpectedManualElectronProcess({ ...expected, ExecutablePath: executable }, 24508, executable, appRoot, profilePath), true)
  assert.equal(isExpectedManualElectronProcess({ ...expected, ProcessId: 24509 }, 24508, executable, appRoot, profilePath), false)
  assert.equal(isExpectedManualElectronProcess({ ...expected, CommandLine: expected.CommandLine.replace('electron.exe', 'other.exe') }, 24508, executable, appRoot, profilePath), false)
  assert.equal(isExpectedManualElectronProcess({ ...expected, CommandLine: expected.CommandLine.replace('fresh-test', 'other-profile') }, 24508, executable, appRoot, profilePath), false)
  assert.equal(isExpectedManualElectronProcess({ ...expected, ExecutablePath: 'E:\\other\\electron.exe' }, 24508, executable, appRoot, profilePath), false)
  assert.equal(isExpectedManualElectronProcess({ ...expected, CommandLine: expected.CommandLine + ' --another-profile' }, 24508, executable, appRoot, profilePath), false)
})

test('runner consumes only an EPIPE caused by its verified cancellation path', () => {
  const { PassThrough } = require('node:stream')
  const cancellingInput = new PassThrough()
  let unexpected
  observeWorkerInputErrors(cancellingInput, () => true, error => { unexpected = error })
  cancellingInput.emit('error', Object.assign(new Error('worker pipe closed'), { code: 'EPIPE' }))
  assert.equal(unexpected, undefined)

  const activeInput = new PassThrough()
  let activeError
  observeWorkerInputErrors(activeInput, () => false, error => { activeError = error })
  const pipeError = Object.assign(new Error('worker pipe closed unexpectedly'), { code: 'EPIPE' })
  activeInput.emit('error', pipeError)
  assert.equal(activeError, pipeError, 'an unexpected EPIPE remains a reported worker communication failure')
})

test('native playback evaluation is forwarded only as an explicit allowlisted worker mode', () => {
  function launcherPayload(script) {
    const match = script.match(/FromBase64String\('([^']+)'\)/)
    assert.ok(match, 'launcher payload is embedded as base64')
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
  }

  const standard = powershellLauncher('C:\\stage', 'run-standard')
  const evaluation = powershellLauncher('C:\\stage', 'run-evaluation', true)
  const chromiumFinal = powershellLauncher('C:\\stage', 'run-chromium-final', false, '--playback-chromium-final')
  const chromiumInteractive = powershellLauncher('C:\\stage', 'run-chromium-interactive', false, '--playback-chromium-interactive')
  const playerPlayback = powershellLauncher('C:\\stage', 'run-player-playback', false, '--player-playback')
  const standalonePlayback = powershellLauncher('C:\\stage', 'run-standalone-playback', false, '--standalone-playback')
  const standaloneIntegration = powershellLauncher('C:\\stage', 'run-standalone-integration', false, '--standalone-integration')
  const playerRecovery = powershellLauncher('C:\\stage', 'run-player-recovery', false, '--player-recovery')
  const standaloneOptions = powershellLauncher('C:\\stage', 'run-standalone-options', false, '--standalone-options')
  const standaloneProduction = powershellLauncher('C:\\stage', 'run-standalone-production', false, '--standalone-production')
  const videoLibrary = powershellLauncher('C:\\stage', 'run-video-library', false, '--video-library')
  const remoteInfrastructure = powershellLauncher('C:\\stage', 'run-remote-infrastructure', false, '--remote-infrastructure')
  const packageCandidate = powershellLauncher('C:\\stage', 'run-package-candidate', false, null, null, null, true)
  const screenshots = powershellLauncher('C:\\stage', 'run-screenshots', false, null, null,
    'E:\\KaraokeQueue\\e1-03-validation\\ui-screenshots')

  assert.equal(launcherPayload(standard).playbackEvaluation, false)
  assert.equal(launcherPayload(evaluation).playbackEvaluation, true)
  assert.equal(launcherPayload(chromiumFinal).playbackMode, '--playback-chromium-final')
  assert.equal(launcherPayload(chromiumInteractive).playbackMode, '--playback-chromium-interactive')
  assert.equal(launcherPayload(playerPlayback).playbackMode, '--player-playback')
  assert.equal(launcherPayload(standalonePlayback).playbackMode, '--standalone-playback')
  assert.equal(launcherPayload(standaloneIntegration).playbackMode, '--standalone-integration')
  assert.equal(launcherPayload(playerRecovery).playbackMode, '--player-recovery')
  assert.equal(launcherPayload(standaloneOptions).playbackMode, '--standalone-options')
  assert.equal(launcherPayload(standaloneProduction).playbackMode, '--standalone-production')
  assert.equal(launcherPayload(videoLibrary).playbackMode, '--video-library')
  assert.equal(launcherPayload(remoteInfrastructure).playbackMode, '--remote-infrastructure')
  assert.equal(launcherPayload(packageCandidate).packageCandidate, true)
  assert.equal(launcherPayload(screenshots).screenshotRoot, 'E:\\KaraokeQueue\\e1-03-validation\\ui-screenshots')
  assert.match(evaluation, /\$workerArgs \+= "--playback-evaluation"/)
  assert.match(chromiumFinal, /\$workerArgs \+= "--playback-chromium-final"/)
  assert.match(chromiumInteractive, /\$workerArgs \+= "--playback-chromium-interactive"/)
  assert.match(playerPlayback, /\$workerArgs \+= "--player-playback"/)
  assert.match(standalonePlayback, /\$workerArgs \+= "--standalone-playback"/)
  assert.match(standaloneIntegration, /\$workerArgs \+= "--standalone-integration"/)
  assert.match(playerRecovery, /\$workerArgs \+= "--player-recovery"/)
  assert.match(standaloneOptions, /\$workerArgs \+= "--standalone-options"/)
  assert.match(standaloneProduction, /\$workerArgs \+= "--standalone-production"/)
  assert.match(videoLibrary, /\$workerArgs \+= "--video-library"/)
  assert.match(remoteInfrastructure, /\$workerArgs \+= "--remote-infrastructure"/)
  assert.match(packageCandidate, /\$workerArgs \+= "--package-candidate"/)
  assert.match(screenshots, /\$env:KQ_PLAYER_SCREENSHOT_DIR = \$screenshotRoot/)
  assert.match(screenshots, /não pode ficar dentro do checkout Windows/)
  assert.match(evaluation, /& node\.exe \$worker @workerArgs/)
  assert.doesNotMatch(evaluation, /playback-engine-evaluation\.cjs/)
  assert.throws(() => powershellLauncher('C:\\stage', 'run-invalid', false, '--unknown-mode'), /não permitido/)
  assert.throws(() => powershellLauncher('C:\\stage', 'run-package-with-tests', false, '--standalone-production', null, null, true), /não combina/)
  assert.throws(() => powershellLauncher('C:\\stage', 'run-retired-player-control', false, '--player-control'), /não permitido/)
  assert.throws(() => powershellLauncher('C:\\stage', 'run-unc-screenshots', false, null, null,
    '\\\\wsl.localhost\\Ubuntu\\tmp\\screenshots'), /caminho absoluto em unidade Windows local/)
})

test('focused playback recovery harness does not require unrelated window-focus assertions', () => {
  assert.equal(requiresWindowFocus('--player-recovery'), false)
  assert.equal(requiresWindowFocus('--player-playback'), false)
  assert.equal(requiresWindowFocus('--standalone-playback'), false)
  assert.equal(requiresWindowFocus('--standalone-integration'), false)
  assert.equal(requiresWindowFocus('--standalone-options'), false)
  assert.equal(requiresWindowFocus('--standalone-production'), false)
  assert.equal(requiresWindowFocus('--video-library'), false)
  assert.equal(requiresWindowFocus('--playback-chromium-final'), false)
  assert.equal(requiresWindowFocus(null), true)
})

test('synthetic F0 startup validation does not require a production MP4 path', () => {
  assert.equal(requiresStandaloneProductionMedia(true), false,
    'the startup-only harness creates its own temporary empty-media fixture')
  assert.equal(requiresStandaloneProductionMedia(false), true,
    'playback-capable production harnesses still require a real MP4 path')
  assert.equal(requiresStandaloneProductionMedia(false, true), false,
    'the explicit F0 real-library campaign selects MP4s from the persisted inventory, not a fixed fixture filename')
})

test('runner cancellation scopes cleanup to the owned run and recovers orphan Electron profiles safely', () => {
  const runId = '1d1c3a83-3396-46b6-8bab-10acdaaeb462'
  const cancellation = powershellCancellation(runId)
  const recovery = powershellCancellation(runId, true)

  assert.match(cancellation, /\$lockInfo = \$info/,
    'the runner retains the lock identity even when its worker has already exited')
  assert.match(cancellation, /\$report\.profileName -ne \$expectedProfileName/,
    'temporary profile cleanup is bound to the report and runId')
  assert.match(cancellation, /\$process\.Name -eq "electron\.exe"/,
    'orphan Electron processes are found by executable and isolated profile')
  assert.match(cancellation, /\$process\.CommandLine\.IndexOf\(\$profilePath/,
    'process termination is limited to the exact temporary profile')
  assert.match(cancellation, /Add-Member -NotePropertyName buildRecovery/,
    'the cancellation report supports missing recovery fields')
  assert.match(recovery, /\$recoveryOnly = \$true/,
    'resume recovery is an explicit runner operation')
  assert.match(recovery, /CANCELLED_RECOVERY_REQUIRED/,
    'resume recovery accepts a prior recovery-required report')
  assert.match(recovery, /\$validReportStatuses = @\("RUNNING"\)/,
    'ordinary cancellation starts from a running report')
  assert.match(recovery, /\$validReportStatuses \+= "CANCELLED_RECOVERY_REQUIRED"/,
    'only explicit recovery accepts a prior recovery-required report')
  assert.match(recovery, /matching worker is still active/,
    'resume recovery refuses to interfere with a live worker')
  assert.match(recovery, /\$report\.stage -eq "TEST"/,
    'an unrecorded profile is rejected after the test stage could have created it')
  assert.match(recovery, /unrecorded test profile exists/,
    'an early-stage cancellation preserves an unexpected unrecorded profile')
  assert.match(cancellation, /ParentProcessId/,
    'orphan Electron descendants are included in targeted process cleanup')
  assert.match(cancellation, /CreationDate/,
    'cleanup verifies original process identities rather than reused PIDs')
  assert.match(cancellation, /taskkill\.exe \/PID .*\/T \/F/,
    'cleanup terminates the confirmed isolated Electron tree')
  assert.doesNotMatch(cancellation, /taskkill\.exe \/IM electron\.exe/i,
    'the runner never kills unrelated Electron processes by image name')
  assert.throws(() => powershellCancellation('invalid;taskkill'), /runId inválido/)
})

test('focused Windows Player recovery mode runs recovery unit coverage before real Electron recovery', () => {
  assert.deepEqual(selectWindowsTestSuites('--player-recovery').map(suite => suite.script), [
    'build/tests/player-playback-recovery.test.js',
    'build/tests/player-playback-recovery-electron.js'
  ])
  assert.deepEqual(selectWindowsTestSuites('--player-playback').map(suite => suite.script), [
    'build/tests/player-playback-electron.js'
  ])
  assert.deepEqual(selectWindowsTestSuites('--standalone-options').map(suite => suite.script), [
    'build/tests/standalone-player-options.test.js',
    'build/tests/standalone-player-ipc.test.js',
    'build/tests/standalone-player-metadata-preview.test.js',
    'build/tests/music-catalog.test.js',
    'build/tests/standalone-player-ui-electron.js'
  ])
  assert.deepEqual(selectWindowsTestSuites('--standalone-production').map(suite => suite.script), [
    'build/tests/standalone-player-contracts.test.js',
    'build/tests/standalone-player-runtime.test.js',
    'build/tests/standalone-player-sequence.test.js',
    'build/tests/standalone-player-ipc.test.js',
    'build/tests/player-playback.test.js',
    'build/tests/player-playback-recovery.test.js',
    'build/tests/main-media-runtime.test.js',
    'build/tests/video-library.test.js',
    'build/tests/video-library-index-store.test.js',
    'build/tests/player-media-protocol.test.js',
    'build/tests/chromium-playback-host.test.js',
    'build/tests/video-library-electron.js',
    'build/tests/standalone-player-production-electron.js',
    'build/tests/f0-bootstrap-electron.js',
    'build/tests/main-management-host.test.js',
    'build/tests/manual-playback.test.js'
  ])
})

test('the standard Windows Electron regression includes native shell shortcut readback', () => {
  assert.equal(selectWindowsTestSuites(null)[0].script, 'tests/windows-shell-shortcut-electron.cjs')
  assert.equal(selectWindowsTestSuites(null)[1].script, 'scripts/windows-runtime-mutex-electron.cjs')
})

test('focused Windows Standalone mode runs affected Standalone/playback tests and its real Electron harness', () => {
  assert.deepEqual(selectWindowsTestSuites('--standalone-playback').map(suite => suite.script), [
    'build/tests/standalone-player-contracts.test.js',
    'build/tests/standalone-player-runtime.test.js',
    'build/tests/standalone-player-sequence.test.js',
    'build/tests/standalone-player-interaction.test.js',
    'build/tests/standalone-player-playback-adapter.test.js',
    'build/tests/player-playback.test.js',
    'build/tests/player-playback-recovery.test.js',
    'build/tests/standalone-player-playback-electron.js'
  ])
})

test('focused Windows Standalone integration mode covers B2/IPC, shared playback and real Electron/MP4 composition', () => {
  assert.deepEqual(selectWindowsTestSuites('--standalone-integration').map(suite => suite.script), [
    'build/tests/standalone-player-contracts.test.js',
    'build/tests/standalone-player-runtime.test.js',
    'build/tests/standalone-player-sequence.test.js',
    'build/tests/standalone-player-interaction.test.js',
    'build/tests/standalone-player-interaction-transport.test.js',
    'build/tests/standalone-player-ipc.test.js',
    'build/tests/standalone-player-playback-adapter.test.js',
    'build/tests/player-playback.test.js',
    'build/tests/player-playback-recovery.test.js',
    'build/tests/standalone-player-integration-electron.js'
  ])
})

test('focused Windows video-library mode runs only the real library unit and Electron fixture suites', () => {
  assert.deepEqual(selectWindowsTestSuites('--video-library').map(suite => suite.script), [
    'build/tests/video-library-index-store.test.js',
    'build/tests/chromium-playback-host.test.js',
    'build/tests/standalone-player-runtime.test.js',
    'build/tests/f0-bootstrap-electron.js',
    'scripts/f0-ci.test.cjs',
    'build/tests/video-library.test.js',
    'build/tests/video-library-electron.js',
    'scripts/usb-reconnect.test.cjs',
    'build/tests/usb-reconnect-synthetic-electron.js',
    'build/tests/standalone-player-sequence.test.js',
    'build/tests/player-playback.test.js',
    'build/tests/player-playback-recovery.test.js',
    'build/tests/player-media-protocol.test.js',
    'build/tests/main-media-runtime.test.js',
    'build/tests/standalone-player-ipc.test.js',
    'build/tests/manual-playback.test.js',
    'build/tests/main-management-host.test.js',
    'build/tests/storage-resilience-electron.js',
    'scripts/usb-campaign.test.cjs',
    'build/tests/usb-campaign-electron.js'
  ])
})

test('focused Windows remote infrastructure mode includes DNS-SD cache tests and native Electron safeStorage', () => {
  assert.equal(requiresWindowFocus('--remote-infrastructure'), false)
  assert.deepEqual(selectWindowsTestSuites('--remote-infrastructure').map(suite => suite.script), [
    'scripts/pairing-opaque-worker.test.cjs',
    'scripts/pairing-bootstrap-integration.test.cjs',
    'build/tests/pairing-bootstrap-lifecycle.test.js',
    'build/tests/pairing-crypto.test.js',
    'build/tests/pairing-store.test.js',
    'build/tests/pairing-audit-regressions.test.js',
    'build/tests/pairing-wire.test.js',
    'build/tests/pairing-renewal.test.js',
    'scripts/pairing-process-integration.test.cjs',
    'scripts/pairing-safe-storage-restart-electron.test.cjs',
    'build/tests/remote-infrastructure.test.js',
    'build/tests/remote-discovery-cache.test.js',
    'build/tests/remote-private-network.test.js',
    'build/tests/remote-discovery-multicast.test.js',
    'scripts/remote-safe-storage-electron.test.cjs'
  ])
})

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function manifestFor(fileEntries) {
  const trackedPaths = fileEntries.filter(item => (item.kind || 'tracked') === 'tracked').map(item => item.path)
  return validateManifest({
    version: 1,
    branch: 'test/windows-runner',
    head,
    trackedPaths,
    files: fileEntries.map(item => ({
      path: item.path,
      sha256: hash(item.content),
      kind: item.kind || 'tracked'
    }))
  })
}

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-windows-runner-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function gitAt(root, args) {
  const result = require('node:child_process').spawnSync('git', args, {
    cwd: root, encoding: 'utf8', shell: false
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

test('normalizes safe relative paths and fingerprints snapshot content deterministically', () => {
  assert.equal(normalizePath('src/app.ts'), 'src/app.ts')
  const first = makeFingerprint('branch', head, ['b.ts', 'a.ts'], [
    { path: 'b.ts', sha256: hash('b') },
    { path: 'a.ts', sha256: hash('a') }
  ])
  const reordered = makeFingerprint('branch', head, ['a.ts', 'b.ts'], [
    { path: 'a.ts', sha256: hash('a') },
    { path: 'b.ts', sha256: hash('b') }
  ])
  assert.equal(first, reordered)
  assert.notEqual(first, makeFingerprint('branch', head, ['a.ts', 'b.ts'], [
    { path: 'a.ts', sha256: hash('changed') },
    { path: 'b.ts', sha256: hash('b') }
  ]))
})

test('selects the final non-empty Electron output line across CRLF diagnostics', () => {
  const output = 'Electron diagnostic: resolving executable\r\n' +
    'warning: optional native module unavailable\r\n' +
    'C:\\validation\\node_modules\\electron\\dist\\electron.exe\r\n\r\n'

  assert.equal(lastNonEmptyLine(output), 'C:\\validation\\node_modules\\electron\\dist\\electron.exe')
})

test('rejects traversal, Windows-reserved names, case collisions, and unsafe manifest content', () => {
  for (const candidate of ['../outside.txt', '/absolute.txt', 'C:/outside.txt', 'CON', 'src/name. ']) {
    assert.throws(() => normalizePath(candidate))
  }
  assert.throws(() => manifestFor([
    { path: 'src/Queue.ts', content: 'one' },
    { path: 'src/queue.ts', content: 'two' }
  ]), /Colisão de caminho/)
  assert.throws(() => manifestFor([{ path: '.env.local', content: 'secret' }]), /sensível/)
  assert.throws(() => manifestFor([{ path: 'profiles/user-data/session.sqlite', content: 'db' }]), /sensível/)
  assert.throws(() => manifestFor([{ path: 'build/main.js', content: 'artifact' }]), /Artefato excluído/)
})

test('accepts a valid legacy fingerprint and recalculates the current snapshot fingerprint', t => {
  const root = tempDirectory(t)
  const content = 'legacy source file\n'
  fs.writeFileSync(path.join(root, 'app.ts'), content)
  const legacy = {
    version: 1,
    branch: 'test/windows-runner',
    head,
    trackedPaths: ['app.ts'],
    files: [{ path: 'app.ts', sha256: hash(content), kind: 'tracked' }],
    fingerprint: hash('previous fingerprint format')
  }

  const normalized = validateLegacyManifest(legacy)
  assert.equal(normalized.fingerprint, makeFingerprint(legacy.branch, legacy.head, legacy.trackedPaths, legacy.files))
  assert.notEqual(normalized.fingerprint, legacy.fingerprint)
  assert.equal(verifySnapshotDirectory(root, normalized).fileCount, 1)
})

test('rejects malformed legacy manifests and file entries without a content hash', () => {
  assert.throws(() => validateLegacyManifest({ fingerprint: 'not-a-hash' }), /Fingerprint legado/)
  assert.throws(() => validateLegacyManifest({
    version: 1,
    branch: 'test/windows-runner',
    head,
    trackedPaths: ['app.ts'],
    files: [{ path: 'app.ts', kind: 'tracked' }],
    fingerprint: hash('legacy fingerprint')
  }), /Entrada inválida/)
})

test('classifies generated artifacts separately from source and personal data', () => {
  for (const candidate of ['node_modules/electron/index.js', 'build/main.js', 'out/result.log', '.npm-cache/data']) {
    assert.equal(isExcludedPath(candidate), true, candidate)
  }
  assert.equal(isExcludedPath('build-resources/native/win32-x64/kq_win32.node'), true,
    'the generated addon is ignored in the source tree and rebuilt by beforePack')
  assert.equal(isExcludedPath('assets/kq_win32.node'), false,
    'the Windows runner must exclude only the exact generated native output path')
  assert.equal(isExcludedPath('docs/sqlite-persistence-safety.md'), false)
  assert.equal(isSensitivePath('.env'), true)
  assert.equal(isSensitivePath('data/session.sqlite'), true)
  assert.equal(isSensitivePath('src/license-service.ts'), false)
})

test('recognizes production playback renderer and copied assets as generated build outputs', () => {
  const manifest = manifestFor([
    { path: 'src/player-playback-renderer.ts', content: 'export {}' },
    { path: 'src/player-playback.html', content: '<video></video>' },
    { path: 'src/player-playback.css', content: 'video { display: block; }' }
  ])
  assert.deepEqual([...generatedBuildPaths([manifest])].sort(), [
    'build/src/player-playback-renderer.js',
    'build/src/player-playback.css',
    'build/src/player-playback.html',
    'build/src/player-playback.js'
  ].sort())
})

test('recognizes first-launch Welcome bundles and copied assets as generated build outputs', () => {
  const manifest = manifestFor([
    { path: 'src/welcome-renderer.ts', content: 'export {}' },
    { path: 'src/welcome.html', content: '<main></main>' },
    { path: 'src/welcome.css', content: '.welcome {}' }
  ])
  assert.deepEqual([...generatedBuildPaths([manifest])].sort(), [
    'build/src/welcome-renderer.bundle.js', 'build/src/welcome-renderer.js',
    'build/src/welcome.css', 'build/src/welcome.html'
  ].sort())
})

test('recognizes Standalone UI harness documents, restricted preloads, bundles and art as build outputs', () => {
  const manifest = manifestFor([
    { path: 'player-preload.ts', content: 'export {}' },
    { path: 'standalone-player-preload.ts', content: 'export {}' },
    { path: 'src/standalone-player-renderer.ts', content: 'export {}' },
    { path: 'src/standalone-player.html', content: '<main></main>' },
    { path: 'src/standalone-player.css', content: 'main {}' },
    { path: 'src/assets/standalone-empty-stage.png', content: 'image' },
    { path: 'tests/standalone-player-ui-electron.ts', content: 'export {}' }
  ])
  const generated = generatedBuildPaths([manifest])
  for (const filePath of [
    'build/standalone-player-ui-preload.js',
    'build/standalone-player-preload.bundle.js',
    'build/src/standalone-player-renderer.bundle.js',
    'build/src/standalone-player.html',
    'build/src/standalone-player.css',
    'build/src/assets/standalone-empty-stage.png',
    'build/tests/standalone-player-ui-electron.js'
  ]) assert.ok(generated.has(filePath), filePath)
})

test('current build inventory omits outputs belonging only to the retired Player control shell', () => {
  const manifest = manifestFor([
    { path: 'main.ts', content: 'export {}' },
    { path: 'src/standalone-player-renderer.ts', content: 'export {}' },
    { path: 'standalone-player-preload.ts', content: 'export {}' },
    { path: 'tests/standalone-player-production-electron.ts', content: 'export {}' }
  ])
  const generated = generatedBuildPaths([manifest])
  for (const filePath of [
    'build/player-control-preload.js',
    'build/src/player-control-renderer.js',
    'build/src/player-control-renderer.bundle.js',
    'build/tests/player-control-electron.js'
  ]) assert.equal(generated.has(filePath), false, filePath)
  assert.ok(generated.has('build/main.js'))
  assert.ok(generated.has('build/src/standalone-player-renderer.bundle.js'))
  assert.ok(generated.has('build/tests/standalone-player-production-electron.js'))
})

test('official manual launcher starts production Main through the shared Windows runner', () => {
  const launcher = fs.readFileSync(path.join(__dirname, 'standalone-manual-windows.ps1'), 'utf8')
  assert.match(launcher, /E:\\KaraokeQueue\\manual-windows/)
  assert.match(launcher, /DriveFormat -ne 'NTFS'/)
  assert.match(launcher, /Execute este arquivo pelo caminho UNC do WSL/)
  assert.match(launcher, /run-windows-native-tests\.cjs/)
  assert.match(launcher, /--manual-launch/)
  assert.doesNotMatch(launcher, /standalone-player-ui-electron|KQ_STANDALONE_C1_UI_MAIN|KQ_STANDALONE_C1_MANUAL/)

  const manualRun = powershellLauncher('C:\\stage', 'run-manual-production', false, null, {
    profileKind: 'new', profileName: 'fresh-runner-test'
  })
  const encodedPayload = manualRun.match(/FromBase64String\('([^']+)'\)/)
  assert.ok(encodedPayload, 'the runner embeds the snapshot and profile request as JSON')
  assert.deepEqual(JSON.parse(Buffer.from(encodedPayload[1], 'base64').toString('utf8')), {
    stagePath: 'C:\\stage', runId: 'run-manual-production', profileKind: 'new', profileName: 'fresh-runner-test'
  })
  assert.match(manualRun, /--manual-launch/)
  assert.match(manualRun, /Get-CimInstance Win32_Process/)
  assert.doesNotMatch(manualRun, /standalone-player-ui-electron|KQ_STANDALONE_C1_UI_MAIN/)
  const runner = fs.readFileSync(path.join(__dirname, 'run-windows-native-tests.cjs'), 'utf8')
  assert.match(runner, /npm\.cmd run compile no Windows/)
  assert.match(runner, /packageJson\.main !== 'build\/main\.js'/)
  assert.throws(() => powershellLauncher('C:\\stage', 'invalid-profile', false, null, {
    profileKind: 'new', profileName: '..\\profile'
  }), /seleção do perfil/)

  const harness = fs.readFileSync(path.join(__dirname, '..', 'tests', 'standalone-player-ui-electron.ts'), 'utf8')
  assert.match(harness, /KQ_STANDALONE_C1_MANUAL === '1'/)
  assert.match(harness, /!\['F10', 'F11'\]\.includes\(input\.code\)/)
  const manualHookStart = harness.indexOf('// Manual-only validation hooks')
  const manualHookEnd = harness.indexOf('\n    }\n  }).catch', manualHookStart)
  assert.ok(manualHookStart >= 0 && manualHookEnd > manualHookStart)
  assert.doesNotMatch(harness.slice(manualHookStart, manualHookEnd), /\bF9\b|seedPlayback/)
  assert.match(harness, /input\.code === 'F10'/)
  assert.match(harness, /input\.code === 'F11'/)
})

test('blocks environment secrets, token/password files, and SQLite journal sidecars from transfer', () => {
  for (const candidate of [
    '.envrc',
    'secrets.env',
    'api-token.json',
    'service-password.json',
    'karaoke.sqlite-wal',
    'karaoke.sqlite-shm',
    'karaoke.sqlite-journal'
  ]) {
    assert.equal(isSensitivePath(candidate), true, candidate)
    assert.throws(
      () => manifestFor([{ path: candidate, content: 'sensitive test value' }]),
      /sensível/,
      candidate
    )
  }
})

test('transfers only the exact reviewed safeStorage source content while blocking changes and adjacent secret paths', () => {
  const sourcePath = 'src/remote-secret-protector.ts'
  const content = fs.readFileSync(path.join(__dirname, '..', sourcePath), 'utf8')
  const snapshot = manifestFor([{ path: sourcePath, content }])
  const adopted = manifestFor([{ path: sourcePath, content: content.replace(/\r?\n/g, '\r\n'), kind: 'adopted' }])
  const acceptedHashes = [
    hash(content.replace(/\r\n/g, '\n')),
    hash(content.replace(/\r?\n/g, '\r\n'))
  ]

  assert.equal(isSensitivePath(sourcePath), true, 'the general sensitive-name rule remains active')
  assert.deepEqual(acceptedHashes.sort(), [
    'e934ab4b948413d2d80aeea717bc2cb18b4e6edade77b7a19c8efac428f53441',
    'e800e0cc56f23219f55de093a09c509132c00ea9a2cf50203be2fb8bfc4d9a21'
  ].sort(), 'any source change requires review of the path exception and regression')
  assert.ok(acceptedHashes.includes(snapshot.files[0].sha256), 'source LF/CRLF checkout forms are hash-pinned')
  assert.equal(adopted.files[0].kind, 'adopted', 'a clean Windows checkout may adopt the same pinned source bytes')
  assert.equal(adopted.files[0].sha256, hash(content.replace(/\r?\n/g, '\r\n')),
    'adoption uses the exact Git for Windows CRLF checkout form')
  assert.ok(acceptedHashes.includes(adopted.files[0].sha256), 'the CRLF form matches a pinned hash')
  assert.throws(() => manifestFor([{ path: sourcePath, content: content + '\n' }]), /sensível/,
    'any source change requires a fresh content review')
  assert.throws(() => manifestFor([{ path: 'src/another-secret-protector.ts', content }]), /sensível/)
  assert.throws(() => manifestFor([{ path: sourcePath, content, kind: 'untracked' }]), /sensível/)
})

test('accepts a directory whose inventory and hashes match the snapshot', t => {
  const root = tempDirectory(t)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'confirmed source\n')
  const manifest = manifestFor([{ path: 'src/app.ts', content: 'confirmed source\n' }])
  assert.deepEqual(verifySnapshotDirectory(root, manifest), {
    fileCount: 1,
    fingerprint: manifest.fingerprint
  })
})

test('rejects a hash mismatch before invoking the build/test sentinel', t => {
  const root = tempDirectory(t)
  fs.writeFileSync(path.join(root, 'app.ts'), 'different destination\n')
  const manifest = manifestFor([{ path: 'app.ts', content: 'expected source\n' }])
  let buildOrTestStarted = false
  assert.throws(
    () => verifyThenRun(root, manifest, () => { buildOrTestStarted = true }),
    /Divergência no checkout Windows/
  )
  assert.equal(buildOrTestStarted, false)
})

test('rejects a checkout from another branch before creating snapshot staging', t => {
  const root = tempDirectory(t)
  const stagingRoot = tempDirectory(t)
  const content = 'verified source\n'
  fs.writeFileSync(path.join(root, 'app.ts'), content)
  const manifest = manifestFor([{ path: 'app.ts', content }])

  assert.throws(
    () => stageSnapshot(root, manifest, { branch: 'another-branch', head }, stagingRoot),
    /Branch do checkout Windows diverge da origem/
  )
  assert.deepEqual(fs.readdirSync(stagingRoot), [])
})

test('removes incomplete staging when a source file changes after snapshot hashing', t => {
  const root = tempDirectory(t)
  const stagingRoot = tempDirectory(t)
  fs.writeFileSync(path.join(root, 'app.ts'), 'changed source\n')
  const manifest = manifestFor([{ path: 'app.ts', content: 'expected source\n' }])

  assert.throws(
    () => stageSnapshot(root, manifest, null, stagingRoot),
    /A origem mudou durante o staging/
  )
  assert.deepEqual(fs.readdirSync(stagingRoot), [])
})

test('incremental source bundle advertises and fetches the explicit branch ref', t => {
  const root = tempDirectory(t)
  const stagingRoot = tempDirectory(t)
  const branch = 'feature/manual-launch'
  gitAt(root, ['init'])
  gitAt(root, ['checkout', '-b', branch])
  gitAt(root, ['config', 'user.name', 'Karaoke Queue Test'])
  gitAt(root, ['config', 'user.email', 'kqueue-test@example.invalid'])

  const oldContent = 'previous source\n'
  fs.writeFileSync(path.join(root, 'app.ts'), oldContent)
  gitAt(root, ['add', 'app.ts'])
  gitAt(root, ['commit', '-m', 'previous source'])
  const oldHead = gitAt(root, ['rev-parse', 'HEAD'])

  const newContent = 'current source\n'
  fs.writeFileSync(path.join(root, 'app.ts'), newContent)
  gitAt(root, ['commit', '-am', 'current source'])
  const newHead = gitAt(root, ['rev-parse', 'HEAD'])
  const marker = validateManifest({
    version: 1, branch, head: oldHead, trackedPaths: ['app.ts'],
    files: [{ path: 'app.ts', sha256: hash(oldContent), kind: 'tracked' }]
  })
  const manifest = validateManifest({
    version: 1, branch, head: newHead, trackedPaths: ['app.ts'],
    files: [{ path: 'app.ts', sha256: hash(newContent), kind: 'tracked' }]
  })

  const stage = stageSnapshot(root, manifest, marker, stagingRoot)
  const bundle = path.join(stage, 'metadata', 'source-head.bundle')
  const branchRef = `refs/heads/${branch}`
  assert.equal(gitAt(root, ['bundle', 'list-heads', bundle]), `${newHead} ${branchRef}`)
  gitAt(root, ['fetch', '--no-tags', bundle, branchRef])
  assert.equal(gitAt(root, ['rev-parse', 'FETCH_HEAD']), newHead)
})

test('recovers a pending sync only after confirming the old snapshot and empty backup', t => {
  const root = tempDirectory(t)
  const gitDir = path.join(root, '.git')
  fs.mkdirSync(gitDir)
  const oldContent = 'confirmed source\n'
  fs.writeFileSync(path.join(root, 'app.ts'), oldContent)
  const marker = manifestFor([{ path: 'app.ts', content: oldContent }])
  const runId = 'staging-4212c976-171b-440e-8016-05c63ac31c42'
  const pendingPath = path.join(gitDir, 'karaoke-queue-wsl-sync-pending.json')
  const backupRoot = path.join(gitDir, 'karaoke-queue-sync-backup-' + runId)
  fs.mkdirSync(backupRoot)
  fs.writeFileSync(pendingPath, JSON.stringify({
    runId,
    fromFingerprint: marker.fingerprint,
    targetFingerprint: hash('next snapshot'),
    startedAt: new Date().toISOString()
  }))
  const checks = []

  assert.equal(recoverNoopInterruptedSync(root, marker, pendingPath, {
    gitState: () => ({ branch: marker.branch, head: marker.head }),
    assertIndexMatchesHead: () => { checks.push('index') }
  }), true)
  assert.deepEqual(checks, ['index'])
  assert.equal(fs.existsSync(pendingPath), false)
  assert.equal(fs.existsSync(backupRoot), false)
})

test('keeps pending sync evidence when backup contains files or snapshot verification fails', t => {
  const root = tempDirectory(t)
  const gitDir = path.join(root, '.git')
  fs.mkdirSync(gitDir)
  const oldContent = 'confirmed source\n'
  fs.writeFileSync(path.join(root, 'app.ts'), oldContent)
  const marker = manifestFor([{ path: 'app.ts', content: oldContent }])
  const runId = 'staging-4212c976-171b-440e-8016-05c63ac31c42'
  const pendingPath = path.join(gitDir, 'karaoke-queue-wsl-sync-pending.json')
  const backupRoot = path.join(gitDir, 'karaoke-queue-sync-backup-' + runId)
  fs.mkdirSync(backupRoot)
  fs.writeFileSync(path.join(backupRoot, 'preserve.bin'), 'backup evidence')
  const pending = {
    runId,
    fromFingerprint: marker.fingerprint,
    targetFingerprint: hash('next snapshot'),
    startedAt: new Date().toISOString()
  }
  fs.writeFileSync(pendingPath, JSON.stringify(pending))
  const dependencies = { gitState: () => ({ branch: marker.branch, head: marker.head }) }

  assert.throws(() => recoverNoopInterruptedSync(root, marker, pendingPath, dependencies), /backup contém arquivos/)
  assert.equal(fs.existsSync(pendingPath), true)
  assert.equal(fs.readFileSync(path.join(backupRoot, 'preserve.bin'), 'utf8'), 'backup evidence')

  fs.rmSync(path.join(backupRoot, 'preserve.bin'))
  fs.writeFileSync(path.join(root, 'app.ts'), 'changed source\n')
  assert.throws(() => recoverNoopInterruptedSync(root, marker, pendingPath, dependencies), /Divergência no checkout Windows/)
  assert.equal(fs.existsSync(pendingPath), true)
  assert.equal(fs.existsSync(backupRoot), true)
})

test('replaces only content matching the previous marker and validates its backup before cleanup', t => {
  const root = tempDirectory(t)
  const stage = tempDirectory(t)
  fs.mkdirSync(path.join(root, '.git'))
  fs.mkdirSync(path.join(stage, 'tree'), { recursive: true })
  const previousContent = 'previous confirmed source\n'
  const nextContent = 'next confirmed source\n'
  fs.writeFileSync(path.join(root, 'app.ts'), previousContent)
  fs.writeFileSync(path.join(stage, 'tree', 'app.ts'), nextContent)
  const marker = manifestFor([{ path: 'app.ts', content: previousContent }])
  const target = manifestFor([{ path: 'app.ts', content: nextContent }])
  const runId = 'replace-verified'
  const backupRoot = path.join(root, '.git', 'karaoke-queue-sync-backup-' + runId)
  const records = []

  syncSnapshot(root, stage, target, marker, runId, false, backupRoot, records)

  assert.equal(fs.readFileSync(path.join(root, 'app.ts'), 'utf8'), nextContent)
  assert.equal(fs.readFileSync(path.join(backupRoot, 'replaced', 'app.ts'), 'utf8'), previousContent)
  assert.deepEqual(verifySnapshotDirectory(root, target).fileCount, 1)
  cleanupSyncBackup(backupRoot, records)
  assert.equal(fs.existsSync(backupRoot), false)
})

test('rejects and preserves destination content that differs from the previous marker', t => {
  const root = tempDirectory(t)
  const stage = tempDirectory(t)
  fs.mkdirSync(path.join(root, '.git'))
  fs.mkdirSync(path.join(stage, 'tree'), { recursive: true })
  const destinationContent = 'unexpected local content\n'
  const previousContent = 'previous confirmed source\n'
  const nextContent = 'next confirmed source\n'
  fs.writeFileSync(path.join(root, 'app.ts'), destinationContent)
  fs.writeFileSync(path.join(stage, 'tree', 'app.ts'), nextContent)
  const marker = manifestFor([{ path: 'app.ts', content: previousContent }])
  const target = manifestFor([{ path: 'app.ts', content: nextContent }])
  const runId = 'preserve-divergence'
  const backupRoot = path.join(root, '.git', 'karaoke-queue-sync-backup-' + runId)
  const records = []

  assert.throws(
    () => syncSnapshot(root, stage, target, marker, runId, false, backupRoot, records),
    /Arquivo de destino mudou após a verificação do snapshot/
  )

  assert.equal(fs.readFileSync(path.join(root, 'app.ts'), 'utf8'), destinationContent)
  assert.equal(fs.existsSync(path.join(backupRoot, 'replaced', 'app.ts')), false)
  assert.deepEqual(records, [])
})

test('preserves and restores an original build containing HTML notes and unknown extensions', t => {
  const root = tempDirectory(t)
  fs.mkdirSync(path.join(root, '.git'))
  const build = path.join(root, 'build')
  fs.mkdirSync(build)
  fs.writeFileSync(path.join(build, 'operator-note.html'), '<p>operator content</p>')
  fs.writeFileSync(path.join(build, 'custom.exe'), 'preserve this file')
  const manifest = manifestFor([
    { path: 'main.ts', content: 'export {}' },
    { path: 'src/index.html', content: '<main></main>' }
  ])

  const state = prepareFreshBuild(root, 'preservation-test')
  assert.equal(fs.existsSync(build), false)
  assert.equal(fs.readFileSync(path.join(state.backupPath, 'operator-note.html'), 'utf8'), '<p>operator content</p>')
  assert.equal(fs.readFileSync(path.join(state.backupPath, 'custom.exe'), 'utf8'), 'preserve this file')

  fs.mkdirSync(path.join(build, 'src'), { recursive: true })
  fs.writeFileSync(path.join(build, 'main.js'), 'compiled javascript')
  fs.writeFileSync(path.join(build, 'src', 'index.html'), '<main></main>')
  assert.deepEqual(verifyBuildOutput(root, manifest), {
    fileCount: 2,
    files: ['build/main.js', 'build/src/index.html']
  })

  restorePreviousBuild(root, state, manifest)

  assert.equal(fs.existsSync(state.backupPath), false)
  assert.equal(fs.readFileSync(path.join(build, 'operator-note.html'), 'utf8'), '<p>operator content</p>')
  assert.equal(fs.readFileSync(path.join(build, 'custom.exe'), 'utf8'), 'preserve this file')
})

test('unexpected generated build inventory blocks cleanup and restoration of the original build', t => {
  const root = tempDirectory(t)
  fs.mkdirSync(path.join(root, '.git'))
  const build = path.join(root, 'build')
  fs.mkdirSync(build)
  fs.writeFileSync(path.join(build, 'operator-note.html'), '<p>original note</p>')
  fs.writeFileSync(path.join(build, 'custom.exe'), 'original binary')
  const state = prepareFreshBuild(root, 'unexpected-output-test')
  const manifest = manifestFor([
    { path: 'main.ts', content: 'export {}' },
    { path: 'src/index.html', content: '<main></main>' }
  ])
  fs.mkdirSync(path.join(build, 'src'), { recursive: true })
  fs.writeFileSync(path.join(build, 'main.js'), 'compiled javascript')
  fs.writeFileSync(path.join(build, 'src', 'index.html'), '<main></main>')
  fs.writeFileSync(path.join(build, 'operator-note.html'), '<p>unexpected generated file</p>')

  assert.throws(() => verifyBuildOutput(root, manifest), /Inventário do build diverge/)
  assert.throws(() => restorePreviousBuild(root, state, manifest), /Inventário do build diverge/)
  assert.equal(fs.readFileSync(path.join(build, 'main.js'), 'utf8'), 'compiled javascript')
  assert.equal(fs.readFileSync(path.join(build, 'src', 'index.html'), 'utf8'), '<main></main>')
  assert.equal(fs.readFileSync(path.join(build, 'operator-note.html'), 'utf8'), '<p>unexpected generated file</p>')
  assert.equal(fs.readFileSync(path.join(state.backupPath, 'operator-note.html'), 'utf8'), '<p>original note</p>')
  assert.equal(fs.readFileSync(path.join(state.backupPath, 'custom.exe'), 'utf8'), 'original binary')
  assert.equal(fs.existsSync(build), true)
  assert.equal(fs.existsSync(state.backupPath), true)
})

test('unexpected generated extension blocks restoration and keeps the original backup', t => {
  const root = tempDirectory(t)
  fs.mkdirSync(path.join(root, '.git'))
  const build = path.join(root, 'build')
  fs.mkdirSync(build)
  fs.writeFileSync(path.join(build, 'operator-note.html'), '<p>original note</p>')
  const state = prepareFreshBuild(root, 'unknown-output-test')
  fs.mkdirSync(build)
  fs.writeFileSync(path.join(build, 'main.js'), 'compiled javascript')
  fs.writeFileSync(path.join(build, 'custom.exe'), 'operator data')
  const manifest = manifestFor([{ path: 'main.ts', content: 'export {}' }])

  assert.throws(() => restorePreviousBuild(root, state, manifest), /Inventário do build diverge/)
  assert.equal(fs.readFileSync(path.join(build, 'main.js'), 'utf8'), 'compiled javascript')
  assert.equal(fs.readFileSync(path.join(build, 'custom.exe'), 'utf8'), 'operator data')
  assert.equal(fs.readFileSync(path.join(state.backupPath, 'operator-note.html'), 'utf8'), '<p>original note</p>')
  assert.equal(fs.existsSync(state.backupPath), true)
})

test('rejects an extra destination file outside generated artifact directories', t => {
  const root = tempDirectory(t)
  fs.writeFileSync(path.join(root, 'app.ts'), 'confirmed source\n')
  fs.writeFileSync(path.join(root, 'local-only.txt'), 'unexpected destination file\n')
  const manifest = manifestFor([{ path: 'app.ts', content: 'confirmed source\n' }])

  assert.throws(
    () => verifySnapshotDirectory(root, manifest),
    /local-only\.txt \(inesperado no destino\)/
  )
  assert.equal(fs.readFileSync(path.join(root, 'local-only.txt'), 'utf8'), 'unexpected destination file\n')
})

test('installation coordination uses the official runner without unrelated UI focus or profile bypass', () => {
  const { selectWindowsTestSuites, requiresWindowFocus } = require('./run-windows-native-tests.cjs')
  assert.equal(requiresWindowFocus('--installation-coordination'), false)
  const suites = selectWindowsTestSuites('--installation-coordination')
  assert.deepEqual(suites.map(suite => suite.name), ['installation-admin-unit', 'installation-control-unit',
    'installation-bootstrap-unit', 'windows-runtime-mutex-electron'])
})
