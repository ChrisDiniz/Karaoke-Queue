import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmInitialRoleThroughUac, type InitialRoleBrokerNative } from '../src/installation-role-broker'
import { createUnconfiguredManifest, type InstallationManifest } from '../src/installation-control'

const operationId = 'd14ac5fd-9545-4459-a9fa-4d7f9de4bea6'

function fixture(initial = createUnconfiguredManifest()) {
  let manifest: InstallationManifest | null = initial
  const calls: string[] = []
  let polls = 0
  const native: InitialRoleBrokerNative = {
    verifyInstallationDirectory: () => { calls.push('verify-directory'); return { ok: true, code: 0 } },
    verifyInstallationManifest: () => { calls.push('verify-manifest'); return { ok: true, code: 0 } },
    launchInitialRoleConfirmation: (id, generation, role) => {
      calls.push(`launch:${id}:${generation}:${role}`)
      return { status: 'started', code: 0 }
    },
    getInitialRoleConfirmationStatus: () => {
      polls++
      if (polls === 1) return { status: 'pending', code: 0 }
      if (manifest) manifest = { ...manifest, generation: 1, identityRevision: 1, role: 'player', status: 'ready', pending: null,
        lastCompletedOperation: { operationId, kind: 'confirm-initial', generation: 1, role: 'player' } }
      return { status: 'completed', code: 0, exitCode: 0 }
    }
  }
  return { calls, native, getManifest: () => manifest, setManifest: (next: InstallationManifest | null) => { manifest = next } }
}

function gateCallbacks(calls: string[]) {
  return {
    releaseRuntimeGate: () => calls.push('release-runtime-gate'),
    restoreRuntimeGate: () => calls.push('restore-runtime-gate'),
    quitForRecovery() { calls.push('quit-for-recovery') }
  }
}

test('UAC broker requests only the selected initial role and verifies manifest commit before relaunch', async () => {
  const f = fixture()
  let relaunched = 0
  let quit = 0
  let confirmed = 0
  await confirmInitialRoleThroughUac('player', {
    native: f.native, store: { read: f.getManifest }, createOperationId: () => operationId,
    wait: async ms => { assert.equal(ms, 120) }, onConfirmed: () => confirmed++,
    ...gateCallbacks(f.calls),
    relaunch: () => relaunched++, quit: () => quit++
  })
  assert.equal(relaunched, 1)
  assert.equal(quit, 1)
  assert.equal(confirmed, 1)
  assert.ok(f.calls.indexOf('release-runtime-gate') < f.calls.indexOf(`launch:${operationId}:0:player`))
})

test('UAC cancellation and completed helper without matching manifest leave app open and fail', async () => {
  const cancelled = fixture()
  cancelled.native.launchInitialRoleConfirmation = () => ({ status: 'cancelled', code: 1223 })
  let restoreCount = 0
  await assert.rejects(confirmInitialRoleThroughUac('combined', {
    native: cancelled.native, store: { read: cancelled.getManifest }, ...gateCallbacks([]),
    restoreRuntimeGate() { restoreCount++ }, relaunch() {}, quit() {}, quitForRecovery() {}
  }), /INSTALLATION_ROLE_CONFIRMATION_CANCELLED/)
  assert.equal(restoreCount, 1)

  const noCommit = fixture()
  noCommit.native.getInitialRoleConfirmationStatus = () => ({ status: 'completed', code: 0, exitCode: 0 })
  let recoveryQuit = 0
  await assert.rejects(confirmInitialRoleThroughUac('player', {
    native: noCommit.native, store: { read: noCommit.getManifest }, ...gateCallbacks([]),
    relaunch() {}, quit() {}, quitForRecovery() { recoveryQuit++ }
  }), /INSTALLATION_ROLE_CONFIRMATION_FAILED/)
  assert.equal(recoveryQuit, 1, 'uncertain admin completion must stop serving the unconfigured Welcome context')
})

test('a matching pending operation retries with its original id; conflicting roles remain blocked', async () => {
  const pending = fixture({ ...createUnconfiguredManifest(), generation: 0, status: 'pending',
    pending: { operationId, kind: 'confirm-initial', baseGeneration: 0, role: 'player' } })
  let relaunched = 0
  await confirmInitialRoleThroughUac('player', {
    native: pending.native, store: { read: pending.getManifest }, ...gateCallbacks(pending.calls),
    relaunch() { relaunched++ }, quit() {}, quitForRecovery() {}
  })
  assert.ok(pending.calls.includes(`launch:${operationId}:0:player`))
  assert.equal(relaunched, 1)

  const conflictingPending = fixture({ ...createUnconfiguredManifest(), generation: 0, status: 'pending',
    pending: { operationId, kind: 'confirm-initial', baseGeneration: 0, role: 'combined' } })
  await assert.rejects(confirmInitialRoleThroughUac('player', {
    native: conflictingPending.native, store: { read: conflictingPending.getManifest }, ...gateCallbacks([]),
    relaunch() {}, quit() {}, quitForRecovery() {}
  }), /INSTALLATION_RECOVERY_REQUIRED/)
  assert.deepEqual(conflictingPending.calls, [])

  const ready = fixture({ ...createUnconfiguredManifest(), generation: 1, role: 'combined', status: 'ready',
    lastCompletedOperation: { operationId, kind: 'confirm-initial', generation: 1, role: 'combined' } })
  await assert.rejects(confirmInitialRoleThroughUac('player', {
    native: ready.native, store: { read: ready.getManifest }, ...gateCallbacks([]),
    relaunch() {}, quit() {}, quitForRecovery() {}
  }), /INSTALLATION_ROLE_ALREADY_CONFIRMED/)
  assert.deepEqual(ready.calls, [])
})
