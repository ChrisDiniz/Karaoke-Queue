'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildInputFingerprint, writeBuildSeal, verifyBuildSeal } = require('./windows-build-provenance.cjs')

const sourceInputs = [
  'src/main.ts', 'src/assets/logo.png',
  'build-resources/installer.nsh', 'build-resources/native/kq-win32.c',
  'build-resources/native/binding.gyp', 'build-resources/identity/role.ico',
  'main.ts', 'main-runtime.ts', 'preload.ts', 'player-preload.ts', 'welcome-preload.ts',
  'standalone-player-preload.ts', 'database.ts', 'types.d.ts',
  'scripts/copy-assets.ts', 'scripts/build-windows-installation-binding.cjs',
  'scripts/build-function-icons.cjs', 'scripts/build-windows-package.cjs',
  'scripts/windows-build-provenance.cjs', 'scripts/verify-windows-build.cjs',
  'scripts/run-windows-native-tests.cjs', 'tests/installation-admin.test.ts',
  'package.json', 'package-lock.json', 'tsconfig.json'
]

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-build-seal-'))
  for (const file of sourceInputs) {
    const destination = path.join(root, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, `fixture:${file}\n`)
  }
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), `${'0123456789abcdef'.repeat(2)}01234567\n`)
  const outputs = ['Karaoke-Queue-Setup-0.5.0-x64.exe', 'win-unpacked/Karaoke Queue.exe',
    'win-unpacked/resources/app.asar', 'win-unpacked/resources/native/win32-x64/kq_win32.node']
  for (const file of outputs) {
    const destination = path.join(root, 'dist', file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, `built:${file}\n`)
  }
  return { root, outputs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('the build input inventory covers all production, compiler, resource, and packaging source classes', () => {
  const f = fixture()
  try {
    const { files } = buildInputFingerprint(f.root)
    for (const input of sourceInputs) assert.ok(files.includes(input), `missing fingerprint input: ${input}`)
    assert.ok(!files.includes('build-resources/native/win32-x64/kq_win32.node'),
      'generated native output is not an input to its own build fingerprint')
    assert.ok(!files.includes('build-resources/native/build/Release/old.obj'))
  } finally { f.cleanup() }
})

test('a completed seal rejects changes to each effective build input class', () => {
  const f = fixture()
  try {
    const seal = writeBuildSeal(f.root, f.outputs)
    assert.equal(verifyBuildSeal(f.root, f.outputs).inputFingerprint, seal.inputFingerprint)

    for (const input of sourceInputs) {
      const filePath = path.join(f.root, input)
      const original = fs.readFileSync(filePath)
      fs.appendFileSync(filePath, 'changed after packaging')
      assert.throws(() => verifyBuildSeal(f.root, f.outputs), /does not match the current build inputs/, input)
      fs.writeFileSync(filePath, original)
      assert.equal(verifyBuildSeal(f.root, f.outputs).inputFingerprint, seal.inputFingerprint,
        `restoring ${input} restores the seal's exact input fingerprint`)
    }

    const futureScript = path.join(f.root, 'scripts', 'future-build-input.ts')
    fs.writeFileSync(futureScript, 'export {}\n')
    assert.throws(() => verifyBuildSeal(f.root, f.outputs), /does not match the current build inputs/,
      'new compiler or packaging scripts under a covered directory invalidate old seals')
    fs.rmSync(futureScript)
    assert.equal(verifyBuildSeal(f.root, f.outputs).inputFingerprint, seal.inputFingerprint)
  } finally { f.cleanup() }
})

test('completed build seal rejects output tampering, incomplete output sets, and missing seals', () => {
  const f = fixture()
  try {
    writeBuildSeal(f.root, f.outputs)
    assert.equal(verifyBuildSeal(f.root, f.outputs).commit.length, 40)
    assert.throws(() => verifyBuildSeal(f.root, f.outputs.slice(0, -1)), /exact required final outputs/)
    fs.writeFileSync(path.join(f.root, 'dist', f.outputs[0]), 'partial replacement')
    assert.throws(() => verifyBuildSeal(f.root, f.outputs), /changed after the successful build/)
    fs.rmSync(path.join(f.root, 'dist', '.kq-windows-build-seal.json'))
    assert.throws(() => verifyBuildSeal(f.root, f.outputs), /No completed Windows build seal/)
  } finally { f.cleanup() }
})

test('packaging keeps official Electron checksum validation without depending on a second SHASUMS download', () => {
  const { electronChecksumOptions } = require('./build-windows-package.cjs')
  const key = 'electron-v45.0.0-win32-x64.zip', checksum = 'a'.repeat(64)
  assert.deepEqual(electronChecksumOptions('45.0.0', { [key]: checksum }), { checksums: { [key]: checksum } })
  assert.throws(() => electronChecksumOptions('45.0.1', { [key]: checksum }), /no trusted checksum/)
  assert.throws(() => electronChecksumOptions('45.0.0', { [key]: 'invalid' }), /no trusted checksum/)
  const electron = require('electron/package.json')
  const official = require('electron/checksums.json')
  assert.ok(electronChecksumOptions(electron.version, official).checksums[`electron-v${electron.version}-win32-x64.zip`])
})

test('build supervisor rejects HTTP failures, reset exit codes, unsettled builds and stale output', () => {
  const supervisor = require.resolve('./build-windows-package.cjs')
  for (const [label, body, expected] of [
    ['HTTP 504', "throw new Error('HTTP 504 Gateway Time-out')", /worker failed: exit=1/],
    ['reset exit code', "process.on('exit',()=>{process.exitCode=0}); throw new Error('HTTP 504 Gateway Time-out')", /No completed Windows build seal/],
    ['unsettled task', "console.error('HTTP 504 Gateway Time-out'); new Promise(()=>{})", /No completed Windows build seal/],
    ['zero exit without build', 'process.exit(0)', /No completed Windows build seal/]
  ]) {
    const f = fixture()
    try {
      fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify(require('../package.json')))
      const worker = path.join(f.root, 'scripts', 'fake-builder.cjs')
      fs.writeFileSync(worker, body)
      writeBuildSeal(f.root, f.outputs) // old complete-looking output must never authorize this attempt
      const parent = path.join(f.root, 'scripts', 'supervisor-test.cjs')
      fs.writeFileSync(parent, `
        try { require(${JSON.stringify(supervisor)}).runSupervisedBuild(${JSON.stringify(f.root)}, ${JSON.stringify(worker)}) }
        catch(error) { console.error(error.message); process.exitCode=1 }
      `)
      const result = spawnSync(process.execPath, [parent], { encoding: 'utf8' })
      assert.equal(result.error, undefined, result.error?.message)
      assert.equal(result.status, 1, label)
      assert.match(result.stderr, expected, label)
      if (label !== 'zero exit without build') assert.match(result.stderr, /HTTP 504/)
      assert.equal(fs.existsSync(path.join(f.root, 'dist', '.kq-windows-build-seal.json')), false)
    } finally { f.cleanup() }
  }
})
