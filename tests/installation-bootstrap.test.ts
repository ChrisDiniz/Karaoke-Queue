import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquirePackagedInstallationState, readPackagedInstalledRole } from '../src/installation-bootstrap'
import { createUnconfiguredManifest, InstallationControlStore } from '../src/installation-control'

const installationId = '8f199caf-dc49-4e53-9f1d-7d353807b93e'
const operationId = '9e6746d7-38e0-4687-a427-684d258a2fd2'

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-install-bootstrap-'))
  const store = new InstallationControlStore(directory)
  return { directory, store, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

function nativeFor(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  return {
    calls,
    native: {
      verifyInstallationDirectory() { calls.push('directory'); return { ok: true, code: 0 } },
      verifyInstallationManifest() { calls.push('manifest'); return { ok: true, code: 0 } },
      ...overrides
    }
  }
}

test('packaged startup accepts only the confirmed global player or combined role', () => {
  const f = fixture()
  try {
    f.store.initialize(createUnconfiguredManifest(installationId))
    assert.equal(readPackagedInstalledRole(nativeFor().native, f.store), null)
    f.store.beginInitialRole(operationId, 0, 'player')
    f.store.commitInitialRole(operationId)
    const checked = nativeFor()
    assert.equal(readPackagedInstalledRole(checked.native, f.store), 'player')
    assert.deepEqual(checked.calls, ['directory', 'manifest'])
  } finally { f.cleanup() }
})

test('packaged startup rejects pending, missing, corrupt, and untrusted installation state', () => {
  const f = fixture()
  try {
    const pending = f.store.initialize(createUnconfiguredManifest(installationId))
    assert.equal(pending.status, 'unconfigured')
    f.store.beginInitialRole(operationId, 0, 'combined')
    assert.throws(() => readPackagedInstalledRole(nativeFor().native, f.store), /RECOVERY_REQUIRED/)

    const denied = nativeFor({ verifyInstallationDirectory: () => ({ ok: false, code: 5 }) })
    let readCalled = false
    assert.throws(() => readPackagedInstalledRole(denied.native, { read: () => { readCalled = true; return null } }), /DIRECTORY_UNTRUSTED/)
    assert.equal(readCalled, false)
    assert.throws(() => readPackagedInstalledRole(nativeFor({ verifyInstallationManifest: () => ({ ok: false, code: 5 }) }).native, f.store), /MANIFEST_UNTRUSTED/)
  } finally { f.cleanup() }
})

test('missing and corrupt manifests never become a per-user default', () => {
  const f = fixture()
  try {
    assert.throws(() => readPackagedInstalledRole(nativeFor().native, f.store), /MANIFEST_MISSING/)
    f.store.initialize(createUnconfiguredManifest(installationId))
    const manifestPath = path.join(f.directory, 'installation.json')
    fs.writeFileSync(manifestPath, '{invalid')
    const original = fs.readFileSync(manifestPath)
    assert.throws(() => readPackagedInstalledRole(nativeFor().native, f.store), /JSON inválido/)
    assert.deepEqual(fs.readFileSync(manifestPath), original)
  } finally { f.cleanup() }
})

test('startup acquires the global gate before reading role and generation', () => {
  const f = fixture()
  try {
    f.store.initialize(createUnconfiguredManifest(installationId))
    const calls: string[] = []
    const native = {
      verifyInstallationDirectory() { calls.push('directory'); return { ok: true, code: 0 } },
      verifyInstallationManifest() { calls.push('manifest'); return { ok: true, code: 0 } },
      acquireRuntime() {
        calls.push('acquire-runtime')
        f.store.beginInitialRole(operationId, 0, 'combined')
        f.store.commitInitialRole(operationId)
        return { status: 'acquired', code: 0 }
      },
      releaseRuntime() { calls.push('release-runtime'); return { status: 'released', code: 0 } }
    }
    const state = acquirePackagedInstallationState(native, f.store)
    assert.equal(state.role, 'combined', 'the first role read occurs after lock ownership begins')
    assert.deepEqual(calls, ['acquire-runtime', 'directory', 'manifest'])
    state.runtimeGate.release()
    assert.equal(calls.at(-1), 'release-runtime')
  } finally { f.cleanup() }
})

test('pending is reread under the runtime gate and always releases it on startup refusal', () => {
  const f = fixture()
  try {
    f.store.initialize(createUnconfiguredManifest(installationId))
    f.store.beginInitialRole(operationId, 0, 'player')
    const calls: string[] = []
    const native = {
      verifyInstallationDirectory() { calls.push('directory'); return { ok: true, code: 0 } },
      verifyInstallationManifest() { calls.push('manifest'); return { ok: true, code: 0 } },
      acquireRuntime() { calls.push('acquire-runtime'); return { status: 'acquired', code: 0 } },
      releaseRuntime() { calls.push('release-runtime'); return { status: 'released', code: 0 } }
    }
    assert.throws(() => acquirePackagedInstallationState(native, f.store), /RECOVERY_REQUIRED/)
    assert.deepEqual(calls, ['acquire-runtime', 'directory', 'manifest', 'release-runtime'])
  } finally { f.cleanup() }
})
