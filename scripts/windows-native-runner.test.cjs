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
  lastNonEmptyLine,
  makeFingerprint,
  normalizePath,
  generatedBuildPaths,
  prepareFreshBuild,
  powershellCancellation,
  powershellLauncher,
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
  const playerControl = powershellLauncher('C:\\stage', 'run-player-control', false, '--player-control')

  assert.equal(launcherPayload(standard).playbackEvaluation, false)
  assert.equal(launcherPayload(evaluation).playbackEvaluation, true)
  assert.equal(launcherPayload(chromiumFinal).playbackMode, '--playback-chromium-final')
  assert.equal(launcherPayload(chromiumInteractive).playbackMode, '--playback-chromium-interactive')
  assert.equal(launcherPayload(playerPlayback).playbackMode, '--player-playback')
  assert.equal(launcherPayload(standalonePlayback).playbackMode, '--standalone-playback')
  assert.equal(launcherPayload(standaloneIntegration).playbackMode, '--standalone-integration')
  assert.equal(launcherPayload(playerRecovery).playbackMode, '--player-recovery')
  assert.equal(launcherPayload(playerControl).playbackMode, '--player-control')
  assert.match(evaluation, /\$workerArgs \+= "--playback-evaluation"/)
  assert.match(chromiumFinal, /\$workerArgs \+= "--playback-chromium-final"/)
  assert.match(chromiumInteractive, /\$workerArgs \+= "--playback-chromium-interactive"/)
  assert.match(playerPlayback, /\$workerArgs \+= "--player-playback"/)
  assert.match(standalonePlayback, /\$workerArgs \+= "--standalone-playback"/)
  assert.match(standaloneIntegration, /\$workerArgs \+= "--standalone-integration"/)
  assert.match(playerRecovery, /\$workerArgs \+= "--player-recovery"/)
  assert.match(playerControl, /\$workerArgs \+= "--player-control"/)
  assert.match(evaluation, /& node\.exe \$worker @workerArgs/)
  assert.doesNotMatch(evaluation, /playback-engine-evaluation\.cjs/)
  assert.throws(() => powershellLauncher('C:\\stage', 'run-invalid', false, '--unknown-mode'), /não permitido/)
})

test('focused playback recovery harness does not require unrelated window-focus assertions', () => {
  assert.equal(requiresWindowFocus('--player-recovery'), false)
  assert.equal(requiresWindowFocus('--player-playback'), false)
  assert.equal(requiresWindowFocus('--standalone-playback'), false)
  assert.equal(requiresWindowFocus('--standalone-integration'), false)
  assert.equal(requiresWindowFocus('--player-control'), false)
  assert.equal(requiresWindowFocus('--playback-chromium-final'), false)
  assert.equal(requiresWindowFocus(null), true)
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
  assert.deepEqual(selectWindowsTestSuites('--player-control').map(suite => suite.script), [
    'build/tests/player-control-electron.js'
  ])
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

test('recognizes Player control and first-launch Welcome bundles and copied assets as generated build outputs', () => {
  const manifest = manifestFor([
    { path: 'src/player-control-renderer.ts', content: 'export {}' },
    { path: 'src/player-control.html', content: '<main></main>' },
    { path: 'src/player-control.css', content: '.player {}' },
    { path: 'src/welcome-renderer.ts', content: 'export {}' },
    { path: 'src/welcome.html', content: '<main></main>' },
    { path: 'src/welcome.css', content: '.welcome {}' }
  ])
  assert.deepEqual([...generatedBuildPaths([manifest])].sort(), [
    'build/src/player-control-renderer.bundle.js',
    'build/src/player-control-renderer.js',
    'build/src/player-control.css', 'build/src/player-control.html',
    'build/src/welcome-renderer.bundle.js', 'build/src/welcome-renderer.js',
    'build/src/welcome.css', 'build/src/welcome.html'
  ].sort())
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

  restorePreviousBuild(root, state, [manifest])

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
  assert.throws(() => restorePreviousBuild(root, state, [manifest]), /Inventário do build diverge/)
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

  assert.throws(() => restorePreviousBuild(root, state, [manifest]), /Inventário do build diverge/)
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
