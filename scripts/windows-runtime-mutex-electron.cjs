'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { verifyX64Pe } = require('./build-windows-installation-binding.cjs')

const root = path.resolve(__dirname, '..')
const nativeSource = path.join(root, 'build-resources', 'native')

function fail(message) { throw new Error(message) }

function spawn(executable, args, cwd, label) {
  const result = spawnSync(executable, args, {
    cwd, encoding: 'utf8', shell: false, timeout: 120000,
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error || result.status !== 0) {
    fail(`${label} failed: ${result.error?.message || result.status}`)
  }
  return result.stdout
}

function buildIsolatedAddon(scratchRoot) {
  const sourceDirectory = path.join(scratchRoot, 'native-fixture')
  fs.mkdirSync(sourceDirectory)
  let source = fs.readFileSync(path.join(nativeSource, 'kq-win32.c'), 'utf8')
  const testName = `Global\\com.karaoke.queue.test.runtime.${crypto.randomUUID()}`
  const fixedName = 'Global\\\\com.karaoke.queue.test.runtime.v1'
  if (!source.includes(fixedName)) fail('Test-only mutex name placeholder is missing from native source.')
  source = source.replace(fixedName, testName.replaceAll('\\', '\\\\'))
  source = source.replace(fixedName.replace('.test.runtime.v1', '.test.operation.v1'),
    testName.replace('.test.runtime.', '.test.operation.').replaceAll('\\', '\\\\'))
  fs.writeFileSync(path.join(sourceDirectory, 'kq-win32.c'), source)
  fs.writeFileSync(path.join(sourceDirectory, 'binding.gyp'), JSON.stringify({ targets: [{
    target_name: 'kq_win32_test', sources: ['kq-win32.c'],
    defines: ['NAPI_VERSION=8', 'UNICODE', '_UNICODE', 'KQ_TEST_RUNTIME_MUTEX=1'],
    conditions: [["OS=='win'", { libraries: ['shell32.lib', 'advapi32.lib', 'ole32.lib', 'shlwapi.lib'] }]]
  }] }, null, 2))
  const electronVersion = require('electron/package.json').version
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js', { paths: [root] })
  spawn(process.execPath, [nodeGyp, 'rebuild', '--directory', sourceDirectory, '--arch=x64',
    `--target=${electronVersion}`, '--runtime=electron', '--dist-url=https://electronjs.org/headers'],
  sourceDirectory, 'node-gyp isolated Electron N-API fixture build')
  const addonPath = path.join(sourceDirectory, 'build', 'Release', 'kq_win32_test.node')
  if (!fs.existsSync(addonPath)) fail('Isolated Electron N-API fixture addon was not produced.')
  verifyX64Pe(addonPath)
  return addonPath
}

function runElectronFixture(addonPath, scratchRoot) {
  const electron = require('electron')
  spawn(electron, [__filename, '--electron', addonPath, scratchRoot], root,
    'Electron runtime mutex fixture')
}

async function workerThreadRelease(addonPath) {
  const { Worker } = require('node:worker_threads')
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    try { parentPort.postMessage(require(workerData).releaseRuntime()); }
    catch (error) { parentPort.postMessage({ status: 'worker_error', message: error.message }); }
  `, { eval: true, workerData: addonPath })
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    })
  } finally { await worker.terminate() }
}

function childResult(addonPath, scratchRoot, mode) {
  return spawnSync(process.execPath, [__filename, '--electron-child', mode, addonPath, scratchRoot], {
    cwd: root, encoding: 'utf8', shell: false, timeout: 60000, maxBuffer: 1024 * 1024
  })
}

function parseChild(result, label) {
  if (result.error || result.status !== 0) fail(`${label}: ${result.error?.message || result.status}: ${result.stderr || ''}`)
  const line = String(result.stdout).split(/\r?\n/).findLast(value => value.startsWith('KQ_MUTEX_CHILD '))
  if (!line) fail(`${label}: child result missing; output=${result.stdout}`)
  return JSON.parse(line.slice('KQ_MUTEX_CHILD '.length))
}

async function electronParent(addonPath, scratchRoot) {
  const { app } = require('electron')
  const profile = path.join(scratchRoot, `electron-parent-${process.pid}`)
  fs.mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  await app.whenReady()
  const native = require(addonPath)
  const inherited = '(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;AU)'
  for (const flag of ['', 'AI']) assert.equal(native.testManifestDacl('D:'+flag+inherited).status, 'matched')
  for (const bad of ['D:P'+inherited, 'D:NO_ACCESS_CONTROL', 'D:',
    'D:'+inherited.replace('0x1200a9', 'FA'), 'D:'+inherited.replaceAll(';ID;', ';;'),
    'D:'+inherited+'(A;ID;FA;;;WD)', 'D:'+inherited.replace('(A;ID;FA;;;BA)', '')]) {
    assert.equal(native.testManifestDacl(bad).status, 'rejected', bad)
  }
  process.stdout.write('WINDOWS MANIFEST DACL PASS AI/no-AI equivalence; grants, SIDs, inherited flags and protection remain strict\n')
  assert.deepEqual(native.acquireRuntime(), { status: 'acquired', code: 0 })
  assert.equal(native.acquireRuntime().status, 'recursive_blocked')
  assert.deepEqual(await workerThreadRelease(addonPath), { status: 'wrong_thread', code: 1444 })

  const blocked = parseChild(childResult(addonPath, scratchRoot, 'contend'), 'mutex contention child')
  assert.equal(blocked.status, 'busy', 'a second Electron process cannot acquire the held global mutex')
  assert.deepEqual(native.releaseRuntime(), { status: 'released', code: 0 })

  const available = parseChild(childResult(addonPath, scratchRoot, 'acquire-release'), 'mutex release child')
  assert.equal(available.status, 'acquired')
  assert.equal(available.release, 'released')

  assert.deepEqual(native.openTestRuntimeReference(), { status: 'opened', code: 0 },
    'the abandoned mutex object must remain alive after its owning process exits')
  const abandoned = parseChild(childResult(addonPath, scratchRoot, 'abandon'), 'mutex abandonment child')
  assert.equal(abandoned.status, 'acquired')
  assert.deepEqual(native.acquireRuntime(), { status: 'abandoned', code: 735 })
  assert.deepEqual(native.acquireRuntime(), { status: 'acquired', code: 0 }, 'abandoned ownership is released fail-closed')
  assert.deepEqual(native.releaseRuntime(), { status: 'released', code: 0 })
  assert.deepEqual(native.closeTestRuntimeReference(), { status: 'closed', code: 0 })
  process.stdout.write('WINDOWS ELECTRON N-API RUNTIME MUTEX PASS recursive/thread-owner/contention/release/abandoned/ACL-readback\n')
  app.quit()
}

async function electronChild(mode, addonPath, scratchRoot) {
  const { app } = require('electron')
  const profile = path.join(scratchRoot, `electron-child-${mode}-${process.pid}`)
  fs.mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  await app.whenReady()
  const native = require(addonPath)
  const acquired = native.acquireRuntime()
  if (mode === 'contend') {
    assert.equal(acquired.status, 'busy')
    process.stdout.write(`KQ_MUTEX_CHILD ${JSON.stringify(acquired)}\n`)
    app.quit()
    return
  }
  assert.equal(acquired.status, 'acquired')
  if (mode === 'abandon') {
    process.stdout.write(`KQ_MUTEX_CHILD ${JSON.stringify(acquired)}\n`)
    process.exit(0)
  }
  assert.equal(mode, 'acquire-release')
  const released = native.releaseRuntime()
  assert.equal(released.status, 'released')
  process.stdout.write(`KQ_MUTEX_CHILD ${JSON.stringify({ status: acquired.status, release: released.status })}\n`)
  app.quit()
}

async function run() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('This isolated mutex proof requires native Windows x64.')
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-queue-runtime-mutex-'))
  let completed = false
  try {
    const addonPath = buildIsolatedAddon(scratchRoot)
    runElectronFixture(addonPath, scratchRoot)
    spawn(process.execPath, [path.join(root, 'tests/windows-packaged-cleanup.cjs'), addonPath], root, 'packaged fixture process lifecycle')
    spawn(process.execPath, [path.join(root, 'scripts/windows-installation-operation.cjs'), addonPath], root, 'Electron operation-tree lifetime fixture')
    spawn(process.execPath, [path.join(root, 'scripts/windows-nsis-coordination-probe.cjs'), addonPath, scratchRoot], root, 'NSIS production mutex section ownership fixture')
    completed = true
  } finally {
    if (completed) fs.rmSync(scratchRoot, { recursive: true, force: true })
    else console.error(`ISOLATED PROOF ARTIFACTS PRESERVED ${scratchRoot}`)
  }
}

if (!process.versions.electron) {
  run().catch(error => { console.error(error); process.exitCode = 1 })
} else {
  const args = process.argv.slice(2)
  const action = args[0]
  const task = action === '--electron'
    ? electronParent(args[1], args[2])
    : action === '--electron-child'
      ? electronChild(args[1], args[2], args[3])
      : Promise.reject(new Error('Unknown Electron mutex fixture action.'))
  task.catch(error => {
    console.error(error)
    require('electron').app.exit(1)
  })
}
