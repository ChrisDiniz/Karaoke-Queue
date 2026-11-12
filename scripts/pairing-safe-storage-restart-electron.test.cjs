'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (process.platform !== 'win32') throw new Error('PAIRING_DPAPI_SMOKE_REQUIRES_NATIVE_WINDOWS')
const root = path.resolve(__dirname, '..')
const electron = require('electron')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-pairing-dpapi-restart-'))

function run(mode, expectedTokenHash) {
  const result = spawnSync(electron, [path.join(root, 'tests/fixtures/pairing-safe-storage-restart-electron.cjs')], {
    cwd: root, env: { ...process.env, KQ_PAIRING_SAFE_STORAGE_TEST_DIR: profile,
      KQ_PAIRING_SAFE_STORAGE_TEST_MODE: mode,
      ...(expectedTokenHash ? { KQ_PAIRING_SAFE_STORAGE_EXPECTED_HASH: expectedTokenHash } : {}) },
    encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024, shell: false
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `Electron safeStorage ${mode} phase succeeds`)
  const match = /KQ_PAIRING_SAFE_STORAGE_RESULT=(\{[^\r\n]+\})/.exec(result.stdout || '')
  assert.ok(match, 'safeStorage fixture reports only a credential digest/result')
  return JSON.parse(match[1])
}

try {
  const write = run('write')
  assert.equal(write.encryptedAtRest, true)
  assert.match(write.tokenHash, /^[A-Za-z0-9_-]{43}$/)
  const read = run('read', write.tokenHash)
  assert.equal(read.recovered, true, 'a new Electron process decrypts the persisted bearer and recovery root')
  process.stdout.write('WINDOWS DPAPI + PAIRING STORE RESTART PASS (two Electron processes)\n')
} finally { fs.rmSync(profile, { recursive: true, force: true }) }
