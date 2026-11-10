'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildArgs, isWindowsX64, verifyX64Pe } = require('./build-windows-installation-binding.cjs')

test('native build hook runs only for Windows x64 and rejects unsupported Windows architectures', () => {
  assert.equal(isWindowsX64({ electronPlatformName: 'linux', arch: 'x64' }), false)
  assert.equal(isWindowsX64({ electronPlatformName: 'win32', arch: 'x64' }), true)
  assert.equal(isWindowsX64({ electronPlatformName: 'win32', arch: 1 }), true)
  assert.throws(() => isWindowsX64({ electronPlatformName: 'win32', arch: 3 }), /only Windows x64/)
  assert.throws(() => isWindowsX64({ electronPlatformName: 'win32', arch: 'arm64' }), /only Windows x64/)
})

test('native build targets the locked Electron runtime and stable Node-API headers', () => {
  assert.deepEqual(buildArgs('45.0.0', 'C:\\source\\native'), [
    'rebuild', '--directory', 'C:\\source\\native', '--arch=x64',
    '--target=45.0.0', '--runtime=electron', '--dist-url=https://electronjs.org/headers'
  ])
})

test('native binding exposes fixed admin/runtime gates and the initial-role UAC broker', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../build-resources/native/kq-win32.c'), 'utf8')
  assert.match(source, /\{"launchInitialRoleConfirmation", NULL, launch_initial_role_confirmation/)
  assert.match(source, /\{"getInitialRoleConfirmationStatus", NULL, initial_role_confirmation_status/)
  assert.match(source, /\{"getCommonProgramsDirectory", NULL, common_programs_directory/)
  assert.match(source, /\{"getPublicDesktopDirectory", NULL, public_desktop_directory/)
  assert.match(source, /\{"acquireRuntime", NULL, acquire_runtime/)
  assert.match(source, /\{"releaseRuntime", NULL, release_runtime/)
  assert.match(source, /Global\\\\com\.karaoke\.queue\.runtime\.v1/)
  assert.match(source, /S:\(ML;;NW;;;ME\)/)
  assert.match(source, /#ifdef KQ_TEST_RUNTIME_MUTEX[\s\S]+#define RUNTIME_MUTEX_NAME L"Global\\\\com\.karaoke\.queue\.test\.runtime\.v1"[\s\S]+#else/)
  assert.match(source, /execute_info\.lpVerb = L"runas"/)
  assert.match(source, /--kq-install-admin confirm-initial --operation-id/)
  assert.match(source, /valid_operation_id\(operation_id\)/)
  assert.match(source, /current_executable_is_in_program_files\(\)/)
  assert.doesNotMatch(source, /ShellExecuteExW\(&execute_info\)[\s\S]{0,180}lpFile\s*=\s*arguments/)
  assert.doesNotMatch(source, /powershell\.exe|ExecutionPolicy Bypass/)
})

test('packaged runtime takes the per-profile focus lock before global admission and opens no DB before it', () => {
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8')
  const runtime = fs.readFileSync(path.resolve(__dirname, '../main-runtime.ts'), 'utf8')
  const localLock = bootstrap.indexOf('app.requestSingleInstanceLock()')
  const packageGate = bootstrap.indexOf('acquirePackagedInstallationState(native, store)')
  const composition = bootstrap.indexOf("require('./main-runtime')")
  assert.ok(localLock >= 0 && packageGate > localLock && composition > packageGate,
    'the per-profile lock precedes the atomic role read under the package mutex and operational composition')
  assert.match(bootstrap, /adminRequested \? true : app\.requestSingleInstanceLock\(\)/,
    'the elevated initial-role broker must not contend for the normal app profile lock')
  assert.doesNotMatch(bootstrap, /createKaraokeDatabase|node:sqlite/)
  assert.ok(runtime.indexOf('database?.close()') < runtime.indexOf('runtimeGate?.release()'))
  assert.match(runtime, /getPackagedInstallationContext\(\)\?\.runtimeGate\?\.release\(\)/)
})

test('PE validation accepts only x64 images', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-native-pe-'))
  const file = path.join(directory, 'fixture.node')
  try {
    const bytes = Buffer.alloc(80)
    bytes.write('MZ', 0, 'ascii')
    bytes.writeUInt32LE(64, 0x3c)
    bytes.write('PE\0\0', 64, 'ascii')
    bytes.writeUInt16LE(0x8664, 68)
    fs.writeFileSync(file, bytes)
    assert.doesNotThrow(() => verifyX64Pe(file))
    bytes.writeUInt16LE(0x14c, 68)
    fs.writeFileSync(file, bytes)
    assert.throws(() => verifyX64Pe(file), /not an x64 PE image/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
