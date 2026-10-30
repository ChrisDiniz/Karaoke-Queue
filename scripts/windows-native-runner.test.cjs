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
  prepareFreshBuild,
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
