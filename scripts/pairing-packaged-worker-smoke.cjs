'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') throw new Error('PACKAGED_WORKER_SMOKE_REQUIRES_NATIVE_WINDOWS')
const root = path.resolve(__dirname, '..')
const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar')
const executable = path.join(root, 'dist', 'win-unpacked', 'Karaoke Queue.exe')
assert.ok(fs.existsSync(archive), 'Windows package candidate contains app.asar')
assert.ok(fs.existsSync(executable), 'Windows package candidate contains the application executable')
const result = spawnSync(executable, [path.join(__dirname, 'pairing-asar-worker-fixture.cjs'), archive], {
  cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8',
  timeout: 60_000, maxBuffer: 4 * 1024 * 1024, shell: false
})
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
assert.equal(result.error, undefined, result.error?.message)
assert.equal(result.status, 0, 'packaged Electron can start the Main-owned OPAQUE worker')
assert.match(result.stdout || '', /KQ_PACKAGED_OPAQUE_WORKER=PASS/)
process.stdout.write('WINDOWS PACKAGED OPAQUE WORKER/WASM PASS (Electron exe + app.asar)\n')
