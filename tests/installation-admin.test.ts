import test from 'node:test'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changeInstalledRole as changeInstalledRoleCore, confirmInitialInstallationRole, prepareInstallationUpdate as prepareInstallationUpdateCore,
  cleanupInstallationShortcutsForUninstall as cleanupInstallationShortcutsForUninstallCore, repairPendingInstallation as repairPendingInstallationCore, restoreInstallationAfterUninstall as restoreInstallationAfterUninstallCore,
  type InstallationNativeBinding } from '../src/installation-admin'
import { parseInstallationAdminCommand, type ConfirmInitialRoleCommand } from '../src/installation-admin-args'
import { createUnconfiguredManifest, InstallationControlStore } from '../src/installation-control'
import { getWindowsFunctionIdentity } from '../src/windows-function-identity'

// Test callers take an explicit snapshot just as NSIS does. Production
// services require fences; only these test adapters supply a fresh default.
function snapshotFence(store: InstallationControlStore, completed = false) {
  const state = store.read()!
  const prior = completed && !state.pending ? state.lastCompletedOperation : null
  return { installationId: state.installationId,
    expectedGeneration: prior ? prior.generation - 1 : state.generation,
    operationId: state.pending?.operationId ?? prior?.operationId ?? crypto.randomUUID() }
}
function changeInstalledRole(a0: Parameters<typeof changeInstalledRoleCore>[0], a1: Parameters<typeof changeInstalledRoleCore>[1], a2: Parameters<typeof changeInstalledRoleCore>[2], a3: Parameters<typeof changeInstalledRoleCore>[3], a4: Parameters<typeof changeInstalledRoleCore>[4], fence = snapshotFence(a3, false)) {
  return changeInstalledRoleCore(a0, a1, a2, a3, a4, fence)
}
function prepareInstallationUpdate(a0: Parameters<typeof prepareInstallationUpdateCore>[0], a1: Parameters<typeof prepareInstallationUpdateCore>[1], a2: Parameters<typeof prepareInstallationUpdateCore>[2], fence = snapshotFence(a2, false)) {
  return prepareInstallationUpdateCore(a0, a1, a2, fence)
}
function cleanupInstallationShortcutsForUninstall(a0: Parameters<typeof cleanupInstallationShortcutsForUninstallCore>[0], a1: Parameters<typeof cleanupInstallationShortcutsForUninstallCore>[1], a2: Parameters<typeof cleanupInstallationShortcutsForUninstallCore>[2], a3: Parameters<typeof cleanupInstallationShortcutsForUninstallCore>[3], a4: Parameters<typeof cleanupInstallationShortcutsForUninstallCore>[4], a5: Parameters<typeof cleanupInstallationShortcutsForUninstallCore>[5], fence = snapshotFence(a2, false)) {
  return cleanupInstallationShortcutsForUninstallCore(a0, a1, a2, a3, a4, a5, fence)
}
function repairPendingInstallation(a0: Parameters<typeof repairPendingInstallationCore>[0], a1: Parameters<typeof repairPendingInstallationCore>[1], a2: Parameters<typeof repairPendingInstallationCore>[2], a3: Parameters<typeof repairPendingInstallationCore>[3], fence = snapshotFence(a2, true)) {
  return repairPendingInstallationCore(a0, a1, a2, a3, fence)
}
function restoreInstallationAfterUninstall(a0: Parameters<typeof restoreInstallationAfterUninstallCore>[0], a1: Parameters<typeof restoreInstallationAfterUninstallCore>[1], a2: Parameters<typeof restoreInstallationAfterUninstallCore>[2], a3: Parameters<typeof restoreInstallationAfterUninstallCore>[3], fence = snapshotFence(a2, true)) {
  return restoreInstallationAfterUninstallCore(a0, a1, a2, a3, fence)
}

const operationId = 'f5597223-3a62-49ed-ae53-fd9608826311'
const validArgs = ['--kq-install-admin', 'confirm-initial', '--operation-id', operationId,
  '--expected-generation', '0', '--role', 'combined', '--installation-id', 'b7d0aca6-2b3d-4e17-9bd4-85cb23ff81dc']

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-install-admin-'))
  const directory = path.join(root, 'KaraokeQueue')
  fs.mkdirSync(directory)
  const commonPrograms = path.join(root, 'Common Programs')
  const publicDesktop = path.join(root, 'Public Desktop')
  const installDirectory = path.join(root, 'Program Files', 'Karaoke Queue')
  const resourcesDirectory = path.join(installDirectory, 'resources')
  const executablePath = path.join(installDirectory, 'Karaoke Queue.exe')
  fs.mkdirSync(commonPrograms)
  fs.mkdirSync(publicDesktop)
  fs.mkdirSync(path.join(resourcesDirectory, 'identity'), { recursive: true })
  fs.writeFileSync(executablePath, 'synthetic executable')
  for (const role of ['player', 'combined'] as const) {
    fs.writeFileSync(path.join(resourcesDirectory, 'identity', getWindowsFunctionIdentity(role).icoIconFile), 'synthetic icon')
  }
  const store = new InstallationControlStore(directory)
  store.initialize(createUnconfiguredManifest('b7d0aca6-2b3d-4e17-9bd4-85cb23ff81dc'))
  return { root, store, commonPrograms, publicDesktop, installDirectory, resourcesDirectory, executablePath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function parseInitialCommand(): ConfirmInitialRoleCommand {
  const command = parseInstallationAdminCommand(validArgs)
  if (!command || command.operation !== 'confirm-initial') throw new Error('invalid initial fixture command')
  return command
}

function nativeFor(root: string, overrides: Partial<InstallationNativeBinding> = {}) {
  const calls: string[] = []
  const native: InstallationNativeBinding = {
    enterInstallationOperation: () => ({ status: 'delegated', code: 0 }),
    isProcessElevated: () => true,
    isExecutableInProgramFiles: () => true,
    getProgramDataDirectory: () => root,
    getCommonProgramsDirectory: () => path.join(root, 'Common Programs'),
    getPublicDesktopDirectory: () => path.join(root, 'Public Desktop'),
    verifyInstallationDirectory: () => { calls.push('verify-directory'); return { ok: true, code: 0 } },
    verifyInstallationManifest: () => { calls.push('verify-manifest'); return { ok: true, code: 0 } },
    acquireAdministrative: () => { calls.push('acquire'); return { status: 'acquired', code: 0 } },
    releaseOwned: () => { calls.push('release'); return { status: 'released', code: 0 } },
    acquireRuntime: () => { calls.push('acquire-runtime'); return { status: 'acquired', code: 0 } },
    releaseRuntime: () => { calls.push('release-runtime'); return { status: 'released', code: 0 } },
    launchInitialRoleConfirmation: () => ({ status: 'started', code: 0 }),
    getInitialRoleConfirmationStatus: () => ({ status: 'pending', code: 0 }),
    ...overrides
  }
  return { native, calls }
}

function provisionShortcuts(calls: string[] = [], shouldFail = false) {
  return { synchronizeBootstrap() { if (shouldFail) throw new Error('SHORTCUT_WRITE_FAILED') }, synchronize(role: 'player' | 'combined', id: string) {
    calls.push(`shortcuts:${role}:${id}`)
    if (shouldFail) throw new Error('SHORTCUT_WRITE_FAILED')
  } }
}

test('administrative parser accepts only the fixed confirm-initial grammar', () => {
  assert.deepEqual(parseInstallationAdminCommand(validArgs), {
    operation: 'confirm-initial', operationId, expectedGeneration: 0, role: 'combined', installationId: 'b7d0aca6-2b3d-4e17-9bd4-85cb23ff81dc'
  })
  for (const args of [
    [...validArgs, 'extra'],
    ['--kq-install-admin=confirm-initial', ...validArgs.slice(1)],
    [...validArgs.slice(0, 1), 'change-role', ...validArgs.slice(2)],
    [...validArgs.slice(0, 4), 'not-a-uuid', ...validArgs.slice(4)],
    [...validArgs.slice(0, 4), operationId, '--expected-generation', '-1', '--role', 'player'],
    [...validArgs.slice(0, 6), 'controller']
  ]) assert.throws(() => parseInstallationAdminCommand(args), /INSTALLATION_ADMIN_ARGUMENTS_INVALID/)
  assert.equal(parseInstallationAdminCommand(['--version']), null)
  const installationId = 'b7d0aca6-2b3d-4e17-9bd4-85cb23ff81dc'
  for (const operation of ['prepare-update', 'repair-pending', 'uninstall-cleanup', 'restore-after-uninstall', 'change-role']) {
    const args = ['--kq-install-admin', operation, '--installation-id', installationId,
      '--operation-id', operationId, '--expected-generation', '0', ...(operation === 'change-role' ? ['--role', 'combined'] : [])]
    assert.deepEqual(parseInstallationAdminCommand(args), { operation, installationId, operationId, expectedGeneration: 0,
      ...(operation === 'change-role' ? { role: 'combined' } : {}) })
    assert.throws(() => parseInstallationAdminCommand(['--kq-install-admin', operation]), /ARGUMENTS_INVALID/)
  }
  assert.throws(() => parseInstallationAdminCommand(['--kq-install-admin', 'repair-pending', '--role', 'combined']),
    /INSTALLATION_ADMIN_ARGUMENTS_INVALID/)
  assert.throws(() => parseInstallationAdminCommand(['--kq-install-admin', 'change-role', '--role', 'controller']),
    /INSTALLATION_ADMIN_ARGUMENTS_INVALID/)
})

test('elevated maintenance resumes shortcut failure with the pending operation and commits only after readback', () => {
  const f = fixture()
  try {
    f.store.beginInitialRole(operationId, 0, 'player')
    f.store.commitInitialRole(operationId)
    const provisionCalls: string[] = []
    let failOnce = true
    const shortcuts = { synchronize(role: 'player' | 'combined', id: string) {
      provisionCalls.push(`${role}:${id}`)
      if (failOnce) { failOnce = false; throw new Error('SHORTCUT_WRITE_FAILED') }
    } }
    const first = nativeFor(f.root)
    assert.throws(() => changeInstalledRole('combined', { platform: 'win32', isPackaged: true },
      first.native, f.store, shortcuts), /SHORTCUT_WRITE_FAILED/)
    const pending = f.store.read()!
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, 'player')
    assert.equal(pending.pending?.kind, 'change-role')

    const second = nativeFor(f.root)
    const completed = changeInstalledRole('combined', { platform: 'win32', isPackaged: true },
      second.native, f.store, shortcuts)
    assert.equal(completed.status, 'ready')
    assert.equal(completed.role, 'combined')
    assert.equal(completed.generation, 2)
    assert.equal(provisionCalls.length, 2)
    assert.equal(provisionCalls[0]!.split(':')[1], provisionCalls[1]!.split(':')[1],
      'retry must reuse the pending operation id')
    assert.deepEqual(second.calls, ['verify-directory', 'acquire', 'acquire-runtime', 'verify-directory',
      'verify-manifest', 'verify-manifest', 'verify-manifest', 'verify-manifest', 'release-runtime', 'release'])
  } finally { f.cleanup() }
})

test('maintenance refuses role mutation when not elevated, busy, abandoned, or already running', () => {
  const f = fixture()
  try {
    f.store.beginInitialRole(operationId, 0, 'player')
    f.store.commitInitialRole(operationId)
    const before = f.store.read()
    const notElevated = nativeFor(f.root, { isProcessElevated: () => false })
    assert.throws(() => changeInstalledRole('combined', { platform: 'win32', isPackaged: true },
      notElevated.native, f.store, provisionShortcuts()), /NOT_ELEVATED/)
    const runtimeBusy = nativeFor(f.root, { acquireRuntime: () => ({ status: 'busy', code: 170 }) })
    assert.throws(() => changeInstalledRole('combined', { platform: 'win32', isPackaged: true },
      runtimeBusy.native, f.store, provisionShortcuts()), /RUNTIME_LOCK_BUSY/)
    const adminAbandoned = nativeFor(f.root, { acquireAdministrative: () => ({ status: 'abandoned', code: 0 }) })
    assert.throws(() => changeInstalledRole('combined', { platform: 'win32', isPackaged: true },
      adminAbandoned.native, f.store, provisionShortcuts()), /ADMIN_RECOVERY_REQUIRED/)
    assert.deepEqual(f.store.read(), before)
  } finally { f.cleanup() }
})

test('administrative branch confirms one role while holding the fixed native gate', () => {
  const f = fixture()
  try {
    const { native, calls } = nativeFor(f.root)
    const command = parseInitialCommand()
    const result = confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true }, native, f.store,
      provisionShortcuts(calls))
    assert.equal(result.role, 'combined')
    assert.equal(result.generation, 1)
    assert.equal(result.identityRevision, 1)
    assert.equal(f.store.read()?.lastCompletedOperation?.operationId, operationId)
    assert.deepEqual(calls, ['verify-directory', 'acquire', 'acquire-runtime', 'verify-directory', 'verify-manifest',
      'verify-manifest', 'shortcuts:combined:f5597223-3a62-49ed-ae53-fd9608826311',
      'verify-manifest', 'verify-manifest', 'release-runtime', 'release'])
  } finally { f.cleanup() }
})

test('administrative confirmation stops before commit if atomic pending manifest ACL is untrusted', () => {
  const f = fixture()
  try {
    let manifestChecks = 0
    const { native } = nativeFor(f.root, {
      verifyInstallationManifest: () => {
        manifestChecks += 1
        return manifestChecks < 2 ? { ok: true, code: 0 } : { ok: false, code: 5 }
      }
    })
    const command = parseInitialCommand()
    assert.throws(() => confirmInitialInstallationRole(command,
      { platform: 'win32', isPackaged: true }, native, f.store, provisionShortcuts()), /MANIFEST_UNTRUSTED:5/)
    assert.equal(f.store.read()?.status, 'pending')
    assert.equal(f.store.read()?.role, null)
    assert.equal(f.store.read()?.lastCompletedOperation, null)
  } finally { f.cleanup() }
})

test('administrative confirmation fails closed if committed manifest ACL changes before readback', () => {
  const f = fixture()
  try {
    let manifestChecks = 0
    const { native } = nativeFor(f.root, {
      verifyInstallationManifest: () => {
        manifestChecks += 1
        return manifestChecks < 4 ? { ok: true, code: 0 } : { ok: false, code: 5 }
      }
    })
    const command = parseInitialCommand()
    assert.throws(() => confirmInitialInstallationRole(command,
      { platform: 'win32', isPackaged: true }, native, f.store, provisionShortcuts()), /MANIFEST_UNTRUSTED:5/)
    assert.equal(f.store.read()?.status, 'ready')
    assert.equal(f.store.read()?.role, 'combined')
    assert.equal(f.store.read()?.lastCompletedOperation?.operationId, operationId)
  } finally { f.cleanup() }
})

test('non-elevated, untrusted, busy, and abandoned administrative contexts make no role change', () => {
  const f = fixture()
  try {
    const command = parseInitialCommand()
    const initial = f.store.read()
    const nonElevated = nativeFor(f.root, { isProcessElevated: () => false })
    assert.throws(() => confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true }, nonElevated.native, f.store, provisionShortcuts()), /NOT_ELEVATED/)
    const untrusted = nativeFor(f.root, { verifyInstallationDirectory: () => ({ ok: false, code: 5 }) })
    assert.throws(() => confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true }, untrusted.native, f.store, provisionShortcuts()), /DIRECTORY_UNTRUSTED/)
    const busy = nativeFor(f.root, { acquireAdministrative: () => ({ status: 'busy', code: 170 }) })
    assert.throws(() => confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true }, busy.native, f.store, provisionShortcuts()), /LOCK_BUSY/)
    const abandoned = nativeFor(f.root, { acquireAdministrative: () => ({ status: 'abandoned', code: 0 }) })
    assert.throws(() => confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true }, abandoned.native, f.store, provisionShortcuts()), /RECOVERY_REQUIRED/)
    const runtimeBusy = nativeFor(f.root, { acquireRuntime: () => ({ status: 'busy', code: 170 }) })
    assert.throws(() => confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true }, runtimeBusy.native, f.store, provisionShortcuts()), /RUNTIME_LOCK_BUSY/)
    const runtimeAbandoned = nativeFor(f.root, { acquireRuntime: () => ({ status: 'abandoned', code: 0 }) })
    assert.throws(() => confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true }, runtimeAbandoned.native, f.store, provisionShortcuts()), /RUNTIME_RECOVERY_REQUIRED/)
    assert.deepEqual(f.store.read(), initial)
    assert.equal(f.store.read()?.status, 'unconfigured')
  } finally { f.cleanup() }
})

test('an uncertain response after commit can be recovered with the same operation id', () => {
  const f = fixture()
  try {
    const command = parseInitialCommand()
    let failRelease = true
    const first = nativeFor(f.root, { releaseOwned: () => failRelease
      ? { status: 'release_error', code: 6 }
      : { status: 'released', code: 0 } })
    assert.throws(() => confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true }, first.native, f.store, provisionShortcuts()), /ADMIN_RELEASE/)
    assert.equal(f.store.read()?.role, 'combined')
    failRelease = false
    const replay = nativeFor(f.root)
    assert.equal(confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true }, replay.native, f.store, provisionShortcuts()).generation, 1)
  } finally { f.cleanup() }
})

test('maintenance repair after restart resumes the exact initial pending operation', () => {
  const f = fixture()
  try {
    const command = parseInitialCommand()
    let failShortcuts = true
    const shortcuts = { synchronize(role: 'player' | 'combined', id: string) {
      assert.equal(role, 'combined')
      assert.equal(id, operationId)
      if (failShortcuts) { failShortcuts = false; throw new Error('SIMULATED_INTERRUPTION_AFTER_PENDING') }
    } }
    const first = nativeFor(f.root)
    assert.throws(() => confirmInitialInstallationRole(command,
      { platform: 'win32', isPackaged: true }, first.native, f.store, shortcuts), /SIMULATED_INTERRUPTION/)
    const pending = f.store.read()!
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, null)
    assert.deepEqual(pending.pending, { operationId, kind: 'confirm-initial', baseGeneration: 0, role: 'combined' })

    const restarted = nativeFor(f.root)
    const recovered = repairPendingInstallation({ platform: 'win32', isPackaged: true }, restarted.native, f.store, shortcuts)
    assert.equal(recovered.status, 'ready')
    assert.equal(recovered.role, 'combined')
    assert.equal(recovered.generation, 1)
    assert.deepEqual(recovered.lastCompletedOperation,
      { operationId, kind: 'confirm-initial', generation: 1, role: 'combined' })
    assert.deepEqual(restarted.calls, ['verify-directory', 'acquire', 'acquire-runtime', 'verify-directory',
      'verify-manifest', 'verify-manifest', 'verify-manifest', 'release-runtime', 'release'])
    assert.equal(repairPendingInstallation({ platform: 'win32', isPackaged: true },
      nativeFor(f.root).native, f.store, shortcuts).generation, 1, 'recovery replay after response loss is idempotent')
  } finally { f.cleanup() }
})

test('NSIS update preparation publishes pending under admin then runtime locks and recovery preserves the confirmed role', () => {
  const f = fixture()
  try {
    f.store.beginInitialRole(operationId, 0, 'player')
    f.store.commitInitialRole(operationId)
    const preparing = nativeFor(f.root)
    const pending = prepareInstallationUpdate({ platform: 'win32', isPackaged: true }, preparing.native, f.store)
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, 'player')
    assert.equal(pending.pending?.kind, 'prepare-update')
    assert.deepEqual(preparing.calls, ['verify-directory', 'acquire', 'acquire-runtime', 'verify-directory',
      'verify-manifest', 'verify-manifest', 'release-runtime', 'release'])

    const restart = nativeFor(f.root)
    const completed = repairPendingInstallation({ platform: 'win32', isPackaged: true }, restart.native, f.store,
      provisionShortcuts([], true))
    assert.equal(completed.status, 'ready')
    assert.equal(completed.role, 'player')
    assert.equal(completed.generation, 2)
    assert.equal(completed.identityRevision, 1, 'an executable update does not change function identity')
    assert.equal(completed.lastCompletedOperation?.kind, 'prepare-update')
  } finally { f.cleanup() }
})

test('NSIS update before first role selection recovers null-role pending across restart and retry', () => {
  const f = fixture()
  try {
    const preparing = nativeFor(f.root)
    const pending = prepareInstallationUpdate({ platform: 'win32', isPackaged: true }, preparing.native, f.store)
    assert.deepEqual(pending.pending, { operationId: pending.pending?.operationId, kind: 'prepare-update', baseGeneration: 0, role: null })
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, null)

    const commit = f.store.commitInstallationUpdate.bind(f.store)
    let failOnce = true
    f.store.commitInstallationUpdate = (id: string) => {
      if (failOnce) { failOnce = false; throw new Error('SIMULATED_COMMIT_INTERRUPTION') }
      return commit(id)
    }
    const firstRestart = nativeFor(f.root)
    assert.throws(() => repairPendingInstallation({ platform: 'win32', isPackaged: true },
      firstRestart.native, f.store, provisionShortcuts()), /SIMULATED_COMMIT_INTERRUPTION/)
    assert.equal(f.store.read()?.status, 'pending')
    assert.equal(f.store.read()?.role, null)
    assert.equal(f.store.read()?.pending?.operationId, pending.pending?.operationId)

    const secondRestart = nativeFor(f.root)
    const completed = repairPendingInstallation({ platform: 'win32', isPackaged: true },
      secondRestart.native, f.store, provisionShortcuts())
    assert.equal(completed.status, 'unconfigured')
    assert.equal(completed.role, null, 'an update must never infer player or combined')
    assert.equal(completed.generation, 1)
    assert.deepEqual(completed.lastCompletedOperation,
      { operationId: pending.pending?.operationId, kind: 'prepare-update', generation: 1, role: null })
    assert.equal(repairPendingInstallation({ platform: 'win32', isPackaged: true },
      nativeFor(f.root).native, f.store, provisionShortcuts()).generation, 1)
  } finally { f.cleanup() }
})

test('NSIS maintenance can resume a pre-existing initial confirmation without replacing its intent', () => {
  const f = fixture()
  try {
    f.store.beginInitialRole(operationId, 0, 'combined')
    const before = f.store.read()!
    const prepared = prepareInstallationUpdate({ platform: 'win32', isPackaged: true }, nativeFor(f.root).native, f.store)
    assert.deepEqual(prepared.pending, before.pending)
    assert.equal(prepared.pending?.kind, 'confirm-initial')
    const repaired = repairPendingInstallation({ platform: 'win32', isPackaged: true },
      nativeFor(f.root).native, f.store, provisionShortcuts())
    assert.equal(repaired.status, 'ready')
    assert.equal(repaired.role, 'combined')
    assert.equal(repaired.lastCompletedOperation?.operationId, operationId)
  } finally { f.cleanup() }
})

test('uninstall failure leaves a durable barrier, releases helper locks, and retry preserves the role and profile', () => {
  const f = fixture()
  try {
    f.store.beginInitialRole(operationId, 0, 'player')
    f.store.commitInitialRole(operationId)
    const identity = getWindowsFunctionIdentity('player')
    const menuDirectory = path.join(f.commonPrograms, 'Karaoke Queue')
    fs.mkdirSync(menuDirectory)
    const details = {
      target: f.executablePath, cwd: f.installDirectory, args: '', description: identity.displayName,
      icon: path.join(f.resourcesDirectory, 'identity', identity.icoIconFile), iconIndex: 0,
      appUserModelId: identity.appUserModelId
    }
    for (const linkPath of [path.join(menuDirectory, `${identity.displayName}.lnk`),
      path.join(f.publicDesktop, `${identity.displayName}.lnk`)]) fs.writeFileSync(linkPath, JSON.stringify(details))
    const profile = path.join(f.root, 'userData', 'karaoke.sqlite')
    fs.mkdirSync(path.dirname(profile))
    fs.writeFileSync(profile, 'synthetic user database')
    const profileHash = fs.readFileSync(profile).toString('hex')
    let failFirstRead = true
    const shell = {
      writeShortcutLink: () => true,
      readShortcutLink(filePath: string) {
        if (failFirstRead) { failFirstRead = false; throw new Error('SIMULATED_SHORTCUT_READ_FAILURE') }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
      }
    }
    const first = nativeFor(f.root)
    assert.throws(() => cleanupInstallationShortcutsForUninstall({ platform: 'win32', isPackaged: true },
      first.native, f.store, shell, f.executablePath, f.resourcesDirectory), /SHORTCUT_READ_FAILED/)
    const pending = f.store.read()!
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, 'player')
    assert.equal(pending.pending?.kind, 'uninstall')
    assert.deepEqual(first.calls.slice(-2), ['release-runtime', 'release'])

    const second = nativeFor(f.root)
    const removed = cleanupInstallationShortcutsForUninstall({ platform: 'win32', isPackaged: true },
      second.native, f.store, shell, f.executablePath, f.resourcesDirectory)
    assert.equal(removed, 2)
    assert.equal(f.store.read()?.pending?.operationId, pending.pending?.operationId,
      'restart and retry reuse the durable uninstall intent')
    assert.equal(cleanupInstallationShortcutsForUninstall({ platform: 'win32', isPackaged: true },
      nativeFor(f.root).native, f.store, shell, f.executablePath, f.resourcesDirectory), 0)
    assert.equal(fs.readFileSync(profile).toString('hex'), profileHash, 'uninstall preserves per-account userData')
  } finally { f.cleanup() }
})

test('reinstall after uninstall resumes idempotently and does not select an unconfigured role', () => {
  const f = fixture()
  try {
    f.store.beginInstallationUninstall('3902ccb2-fc43-4d80-8d50-84f2ef16c0c0', 0)
    const provisioner = {
      synchronize: (_role: 'player' | 'combined', _id: string) => assert.fail('null role must not provision a function identity'),
      synchronizeBootstrap(_id: string) { throw new Error('SIMULATED_BOOTSTRAP_SHORTCUT_FAILURE') }
    }
    assert.throws(() => restoreInstallationAfterUninstall({ platform: 'win32', isPackaged: true },
      nativeFor(f.root).native, f.store, provisioner), /SIMULATED_BOOTSTRAP_SHORTCUT_FAILURE/)
    const pending = f.store.read()!
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, null)
    assert.equal(pending.pending?.kind, 'uninstall')

    const restarted = nativeFor(f.root)
    const restored = restoreInstallationAfterUninstall({ platform: 'win32', isPackaged: true }, restarted.native, f.store, {
      synchronize: () => assert.fail('null role must remain unconfigured'),
      synchronizeBootstrap: id => assert.equal(id, pending.pending?.operationId)
    })
    assert.equal(restored.status, 'unconfigured')
    assert.equal(restored.role, null)
    assert.equal(restored.generation, 1)
    assert.equal(restoreInstallationAfterUninstall({ platform: 'win32', isPackaged: true },
      nativeFor(f.root).native, f.store, provisioner).generation, 1)
  } finally { f.cleanup() }
})

test('an independent administrative tree is rejected before locks or effects', () => {
  const f = fixture()
  try {
    const before = f.store.read()
    const n = nativeFor(f.root, { enterInstallationOperation: () => ({ status: 'busy', code: 170 }) })
    assert.throws(() => prepareInstallationUpdate({ platform: 'win32', isPackaged: true }, n.native, f.store), /OPERATION_BUSY/)
    assert.deepEqual(n.calls, [])
    assert.deepEqual(f.store.read(), before)
  } finally { f.cleanup() }
})

test('obsolete uninstall/restore/update intents never consume a later generation or another installation', () => {
  const f = fixture()
  try {
    const env = { platform: 'win32' as const, isPackaged: true }
    const fence = { installationId: f.store.read()!.installationId, expectedGeneration: 0, operationId }
    const n = nativeFor(f.root).native
    const shell = { readShortcutLink: () => { throw new Error('must not read a shortcut') }, writeShortcutLink: () => true }
    const pending = prepareInstallationUpdate(env, n, f.store, fence)
    assert.equal(pending.pending?.operationId, operationId)
    repairPendingInstallation(env, n, f.store, provisionShortcuts(), fence)
    const confirmed = f.store.read()
    for (const stale of [fence, { ...fence, expectedGeneration: 1, installationId: '9ee1683d-15a8-429b-a8fd-43f58f75264e' }]) {
      assert.throws(() => prepareInstallationUpdate(env, n, f.store, stale), /FENCE_MISMATCH/)
      assert.throws(() => cleanupInstallationShortcutsForUninstall(env, n, f.store, shell,
        f.executablePath, f.resourcesDirectory, stale), /FENCE_MISMATCH/)
      assert.throws(() => restoreInstallationAfterUninstall(env, n, f.store, provisionShortcuts(), stale), /FENCE_MISMATCH|REINSTALL_RECOVERY_REQUIRED/)
      assert.deepEqual(f.store.read(), confirmed)
    }
    const conflicting = { ...fence, expectedGeneration: 1, operationId: '901eb673-54a8-4cac-8d91-4c3e31daee36' }
    const uninstallId = '506ed810-202f-42ea-94e5-812c72b18963'
    f.store.beginInstallationUninstall(uninstallId, 1)
    assert.throws(() => restoreInstallationAfterUninstall(env, n, f.store, provisionShortcuts(), conflicting), /FENCE_MISMATCH/)
    assert.equal(f.store.read()?.pending?.operationId, uninstallId)
  } finally { f.cleanup() }
})

test('an interrupted initial install keeps pending until bootstrap shortcut readback succeeds', () => {
  const f = fixture()
  try {
    const env = { platform: 'win32' as const, isPackaged: true }
    const fence = snapshotFence(f.store)
    prepareInstallationUpdate(env, nativeFor(f.root).native, f.store, fence)
    const shortcuts = { synchronize() { assert.fail('initial install does not select a role') },
      synchronizeBootstrap() { throw new Error('BOOTSTRAP_READBACK_FAILED') } }
    assert.throws(() => repairPendingInstallation(env, nativeFor(f.root).native, f.store, shortcuts, fence), /BOOTSTRAP_READBACK_FAILED/)
    assert.equal(f.store.read()?.status, 'pending')
    assert.equal(f.store.read()?.generation, 0)
    assert.equal(f.store.read()?.pending?.operationId, fence.operationId)
    const result = repairPendingInstallation(env, nativeFor(f.root).native, f.store, {
      synchronize() { assert.fail('role must remain null') }, synchronizeBootstrap(id) { assert.equal(id, fence.operationId) }
    }, fence)
    assert.equal(result.status, 'unconfigured')
    assert.equal(result.generation, 1)
    assert.equal(result.role, null)
  } finally { f.cleanup() }
})

test('initial confirmation from a replaced installation is rejected even when generation is zero', () => {
  const f = fixture()
  try {
    const command = { ...parseInitialCommand(), installationId: '9ee1683d-15a8-429b-a8fd-43f58f75264e' }
    assert.throws(() => confirmInitialInstallationRole(command, { platform: 'win32', isPackaged: true },
      nativeFor(f.root).native, f.store, provisionShortcuts()), /FENCE_MISMATCH/)
    assert.equal(f.store.read()?.status, 'unconfigured')
    assert.equal(f.store.read()?.pending, null)
  } finally { f.cleanup() }
})

test('maintenance commands require an inherited NSIS operation tree, not just elevation', () => {
  const f = fixture()
  try {
    const before = f.store.read()
    const n = nativeFor(f.root, { enterInstallationOperation: () => ({ status: 'joined', code: 0 }) })
    assert.throws(() => prepareInstallationUpdate({ platform: 'win32', isPackaged: true }, n.native, f.store), /NSIS_OPERATION_REQUIRED/)
    assert.deepEqual(n.calls, [])
    assert.deepEqual(f.store.read(), before)
  } finally { f.cleanup() }
})

test('lost confirmation and maintenance ACKs return the completed operation without rewriting shortcuts', () => {
  const f = fixture()
  try {
    const env = { platform: 'win32' as const, isPackaged: true }
    const native = nativeFor(f.root).native
    const command = parseInitialCommand()
    confirmInitialInstallationRole(command, env, native, f.store, provisionShortcuts())
    const noSideEffects = { synchronize() { assert.fail('confirmed operation must not replay shortcut mutation') } }
    assert.equal(confirmInitialInstallationRole(command, env, native, f.store, noSideEffects).generation, 1)
    const fence = snapshotFence(f.store)
    const changed = changeInstalledRoleCore('player', env, native, f.store, provisionShortcuts(), fence)
    assert.equal(changed.generation, 2)
    assert.equal(changeInstalledRoleCore('player', env, native, f.store, noSideEffects, fence).generation, 2)
    assert.throws(() => changeInstalledRoleCore('combined', env, native, f.store, noSideEffects, fence), /REUSE_CONFLICT/)
    assert.equal(f.store.read()?.role, 'player')
  } finally { f.cleanup() }
})
