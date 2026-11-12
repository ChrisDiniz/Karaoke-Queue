'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-remote-safe-storage-'))
try {
  const electron = require('electron')
  const result = spawnSync(electron, [path.join(root, 'tests/fixtures/remote-safe-storage-electron.cjs')], {
    cwd: root,
    env: { ...process.env, KQ_REMOTE_SAFE_STORAGE_TEST_DIR: profile },
    encoding: 'utf8',
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, 'Electron safeStorage fixture exits successfully')
  const match = /KQ_REMOTE_SAFE_STORAGE_RESULT=(\{[^\r\n]+\})/.exec(result.stdout || '')
  assert.ok(match, 'fixture reports only non-secret capability and persistence results')
  const report = JSON.parse(match[1])
  assert.equal(report.platform, process.platform)
  if (process.platform === 'win32') {
    assert.equal(report.asyncAvailable, true, 'Windows uses Electron asynchronous safeStorage')
    assert.equal(report.remoteEnabled, true)
    assert.equal(report.persistedIdentity, true)
    assert.equal(report.privateKeyProtected, true)
  } else if (process.platform === 'linux' && report.remoteEnabled) {
    assert.ok(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(report.backend))
    assert.equal(report.persistedIdentity, true)
    assert.equal(report.privateKeyProtected, true)
  } else {
    assert.equal(report.remoteEnabled, false, 'unsupported or unsafe backend disables remote mode')
    assert.equal(fs.existsSync(path.join(profile, 'remote-player-identity.json')), false)
  }
  process.stdout.write(report.remoteEnabled
    ? 'PASS Electron safeStorage native API, fail-closed policy and isolated identity round-trip\n'
    : 'PASS Electron safeStorage native API; unsupported backend correctly disables remote identity storage\n')
} finally {
  fs.rmSync(profile, { recursive: true, force: true })
}
