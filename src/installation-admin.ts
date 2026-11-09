import path from 'node:path'
import { InstallationControlStore, type InstallationManifest } from './installation-control'
import type { ConfirmInitialRoleCommand, InstallationOperationFence } from './installation-admin-args'
import type { InstalledRole } from './installation-control'
import { removeManagedInstallationShortcuts, type ShortcutShell } from './installation-shortcuts'

export interface InstallationNativeBinding {
  enterInstallationOperation(): { status: string; code: number }
  isProcessElevated(): boolean
  isExecutableInProgramFiles(): boolean
  getProgramDataDirectory(): string | { status: string; code: number }
  getCommonProgramsDirectory(): string | { status: string; code: number }
  getPublicDesktopDirectory(): string | { status: string; code: number }
  verifyInstallationDirectory(): { ok: boolean; code: number }
  verifyInstallationManifest(): { ok: boolean; code: number }
  acquireAdministrative(): { status: string; code: number }
  releaseOwned(): { status: string; code: number }
  acquireRuntime(): { status: string; code: number }
  releaseRuntime(): { status: string; code: number }
  launchInitialRoleConfirmation(operationId: string, expectedGeneration: number, role: 'player' | 'combined', installationId: string): { status: string; code: number }
  getInitialRoleConfirmationStatus(): { status: string; code: number; exitCode?: number }
}

export interface InitialRoleShortcutProvisioner {
  synchronize(role: InstalledRole, operationId: string): void
  synchronizeBootstrap?(operationId: string): void
}

export interface InstallationAdminEnvironment {
  platform: NodeJS.Platform
  isPackaged: boolean
}

function assertOperationFence(current: InstallationManifest, fence: InstallationOperationFence,
  allowCompleted = false, requireCompleted = false): void {
  const completed = allowCompleted && !current.pending && current.generation === fence.expectedGeneration + 1 &&
    current.lastCompletedOperation?.operationId === fence.operationId
  if ((requireCompleted && !current.pending && !completed) || current.installationId !== fence.installationId || (!completed && current.generation !== fence.expectedGeneration) ||
      (current.pending && current.pending.operationId !== fence.operationId)) {
    throw new Error('INSTALLATION_OPERATION_FENCE_MISMATCH')
  }
}

export function confirmInitialInstallationRole(
  command: ConfirmInitialRoleCommand,
  environment: InstallationAdminEnvironment,
  native: InstallationNativeBinding,
  store: InstallationControlStore,
  shortcuts: InitialRoleShortcutProvisioner
): InstallationManifest {
  if (command.operation !== 'confirm-initial') throw new Error('INSTALLATION_ADMIN_OPERATION_INVALID')
  if (environment.platform !== 'win32' || !environment.isPackaged) throw new Error('INSTALLATION_ADMIN_CONTEXT_INVALID')
  if (!native.isProcessElevated()) throw new Error('INSTALLATION_ADMIN_NOT_ELEVATED')
  if (!native.isExecutableInProgramFiles()) throw new Error('INSTALLATION_ADMIN_IMAGE_UNTRUSTED')
  const operationTree = native.enterInstallationOperation()
  if (operationTree.status !== 'joined' && operationTree.status !== 'delegated') {
    throw new Error(`INSTALLATION_OPERATION_${operationTree.status.toUpperCase()}:${operationTree.code}`)
  }
  const directoryCheck = native.verifyInstallationDirectory()
  if (!directoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const acquired = native.acquireAdministrative()
  if (acquired.status === 'abandoned') {
    const release = native.releaseOwned()
    if (release.status !== 'released') throw new Error('INSTALLATION_ADMIN_ABANDONED_RELEASE_FAILED')
    throw new Error('INSTALLATION_ADMIN_RECOVERY_REQUIRED')
  }
  if (acquired.status !== 'acquired') throw new Error(`INSTALLATION_ADMIN_LOCK_${acquired.status.toUpperCase()}:${acquired.code}`)
  let runtimeAcquired = false
  try {
    const runtime = native.acquireRuntime()
    if (runtime.status === 'abandoned') throw new Error('INSTALLATION_RUNTIME_RECOVERY_REQUIRED')
    if (runtime.status !== 'acquired') throw new Error(`INSTALLATION_RUNTIME_LOCK_${runtime.status.toUpperCase()}:${runtime.code}`)
    runtimeAcquired = true
    const lockedDirectoryCheck = native.verifyInstallationDirectory()
    if (!lockedDirectoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${lockedDirectoryCheck.code}`)
    const manifestCheck = native.verifyInstallationManifest()
    if (!manifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${manifestCheck.code}`)
    const root = native.getProgramDataDirectory()
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('INSTALLATION_PROGRAM_DATA_UNAVAILABLE')
    const expectedDirectory = path.join(root, 'KaraokeQueue')
    if (path.resolve(store.directory) !== path.resolve(expectedDirectory)) throw new Error('INSTALLATION_CONTROL_PATH_MISMATCH')
    const initial = store.read()
    if (!initial) throw new Error('INSTALLATION_MANIFEST_MISSING')
    assertOperationFence(initial, command, true)
    if (!initial.pending && initial.lastCompletedOperation?.operationId === command.operationId) {
      if (initial.lastCompletedOperation.kind !== 'confirm-initial' || initial.role !== command.role || initial.status !== 'ready') {
        throw new Error('INSTALLATION_OPERATION_REUSE_CONFLICT')
      }
      return initial // lost ACK: no shortcut side effects after the confirmed commit
    }
    store.beginInitialRole(command.operationId, command.expectedGeneration, command.role)
    const pendingManifestCheck = native.verifyInstallationManifest()
    if (!pendingManifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${pendingManifestCheck.code}`)
    if (!shortcuts || typeof shortcuts.synchronize !== 'function') throw new Error('INSTALLATION_SHORTCUT_SYNC_UNAVAILABLE')
    shortcuts.synchronize(command.role, command.operationId)
    const synchronizedManifestCheck = native.verifyInstallationManifest()
    if (!synchronizedManifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${synchronizedManifestCheck.code}`)
    const committed = store.commitInitialRole(command.operationId)
    const committedManifestCheck = native.verifyInstallationManifest()
    if (!committedManifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${committedManifestCheck.code}`)
    const verified = store.read()
    if (!verified || verified.generation !== committed.generation || verified.role !== command.role ||
        verified.lastCompletedOperation?.operationId !== command.operationId) throw new Error('INSTALLATION_COMMIT_READBACK_FAILED')
    return verified
  } finally {
    try {
      if (runtimeAcquired) {
        const runtimeReleased = native.releaseRuntime()
        if (runtimeReleased.status !== 'released') throw new Error(`INSTALLATION_RUNTIME_RELEASE_${runtimeReleased.status.toUpperCase()}:${runtimeReleased.code}`)
      }
    } finally {
      const released = native.releaseOwned()
      if (released.status !== 'released') throw new Error(`INSTALLATION_ADMIN_RELEASE_${released.status.toUpperCase()}:${released.code}`)
    }
  }
}

/**
 * Changes the computer-wide role only from the elevated maintenance branch.
 * A matching pending operation is resumed with its original id and generation.
 */
export function changeInstalledRole(
  role: InstalledRole,
  environment: InstallationAdminEnvironment,
  native: InstallationNativeBinding,
  store: InstallationControlStore,
  shortcuts: InitialRoleShortcutProvisioner,
  fence: InstallationOperationFence
): InstallationManifest {
  if (role !== 'player' && role !== 'combined') throw new Error('INSTALLATION_ROLE_INVALID')
  if (environment.platform !== 'win32' || !environment.isPackaged) throw new Error('INSTALLATION_ADMIN_CONTEXT_INVALID')
  if (!native.isProcessElevated()) throw new Error('INSTALLATION_ADMIN_NOT_ELEVATED')
  if (!native.isExecutableInProgramFiles()) throw new Error('INSTALLATION_ADMIN_IMAGE_UNTRUSTED')
  const operationTree = native.enterInstallationOperation()
  if (operationTree.status !== 'joined' && operationTree.status !== 'delegated') {
    throw new Error(`INSTALLATION_OPERATION_${operationTree.status.toUpperCase()}:${operationTree.code}`)
  }
  if (operationTree.status !== 'delegated') throw new Error('INSTALLATION_NSIS_OPERATION_REQUIRED')
  const directoryCheck = native.verifyInstallationDirectory()
  if (!directoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const acquired = native.acquireAdministrative()
  if (acquired.status === 'abandoned') {
    const release = native.releaseOwned()
    if (release.status !== 'released') throw new Error('INSTALLATION_ADMIN_ABANDONED_RELEASE_FAILED')
    throw new Error('INSTALLATION_ADMIN_RECOVERY_REQUIRED')
  }
  if (acquired.status !== 'acquired') throw new Error(`INSTALLATION_ADMIN_LOCK_${acquired.status.toUpperCase()}:${acquired.code}`)

  let runtimeAcquired = false
  try {
    const runtime = native.acquireRuntime()
    if (runtime.status === 'abandoned') throw new Error('INSTALLATION_RUNTIME_RECOVERY_REQUIRED')
    if (runtime.status !== 'acquired') throw new Error(`INSTALLATION_RUNTIME_LOCK_${runtime.status.toUpperCase()}:${runtime.code}`)
    runtimeAcquired = true
    const lockedDirectoryCheck = native.verifyInstallationDirectory()
    if (!lockedDirectoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${lockedDirectoryCheck.code}`)
    const manifestCheck = native.verifyInstallationManifest()
    if (!manifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${manifestCheck.code}`)
    const root = native.getProgramDataDirectory()
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('INSTALLATION_PROGRAM_DATA_UNAVAILABLE')
    if (path.resolve(store.directory) !== path.resolve(path.join(root, 'KaraokeQueue'))) {
      throw new Error('INSTALLATION_CONTROL_PATH_MISMATCH')
    }
    const current = store.read()
    if (!current) throw new Error('INSTALLATION_MANIFEST_MISSING')
    assertOperationFence(current, fence, true)
    if (!current.pending && current.lastCompletedOperation?.operationId === fence.operationId &&
        (current.lastCompletedOperation.kind !== 'change-role' || current.role !== role)) {
      throw new Error('INSTALLATION_OPERATION_REUSE_CONFLICT')
    }
    if (current.status === 'ready' && current.role === role) return current

    let operationId: string
    if (current.pending?.kind === 'change-role' && current.pending.role === role &&
        (current.status === 'pending' || current.status === 'repairRequired')) {
      operationId = current.pending.operationId
    } else {
      if (current.status !== 'ready' || !current.role) throw new Error('INSTALLATION_RECOVERY_REQUIRED')
      operationId = fence.operationId
      store.beginRoleChange(operationId, current.generation, role)
    }

    const pendingCheck = native.verifyInstallationManifest()
    if (!pendingCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${pendingCheck.code}`)
    if (!shortcuts || typeof shortcuts.synchronize !== 'function') throw new Error('INSTALLATION_SHORTCUT_SYNC_UNAVAILABLE')
    shortcuts.synchronize(role, operationId)
    const shortcutCheck = native.verifyInstallationManifest()
    if (!shortcutCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${shortcutCheck.code}`)
    const committed = store.commitRoleChange(operationId)
    const committedCheck = native.verifyInstallationManifest()
    if (!committedCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${committedCheck.code}`)
    const verified = store.read()
    if (!verified || verified.status !== 'ready' || verified.generation !== committed.generation ||
        verified.role !== role || verified.lastCompletedOperation?.operationId !== operationId ||
        verified.lastCompletedOperation.kind !== 'change-role') throw new Error('INSTALLATION_COMMIT_READBACK_FAILED')
    return verified
  } finally {
    try {
      if (runtimeAcquired) {
        const runtimeReleased = native.releaseRuntime()
        if (runtimeReleased.status !== 'released') throw new Error(`INSTALLATION_RUNTIME_RELEASE_${runtimeReleased.status.toUpperCase()}:${runtimeReleased.code}`)
      }
    } finally {
      const released = native.releaseOwned()
      if (released.status !== 'released') throw new Error(`INSTALLATION_ADMIN_RELEASE_${released.status.toUpperCase()}:${released.code}`)
    }
  }
}

/** Replays only the exact pending intent persisted by the installer protocol. */
export function repairPendingInstallation(
  environment: InstallationAdminEnvironment,
  native: InstallationNativeBinding,
  store: InstallationControlStore,
  shortcuts: InitialRoleShortcutProvisioner,
  fence: InstallationOperationFence
): InstallationManifest {
  if (environment.platform !== 'win32' || !environment.isPackaged) throw new Error('INSTALLATION_ADMIN_CONTEXT_INVALID')
  if (!native.isProcessElevated()) throw new Error('INSTALLATION_ADMIN_NOT_ELEVATED')
  if (!native.isExecutableInProgramFiles()) throw new Error('INSTALLATION_ADMIN_IMAGE_UNTRUSTED')
  const operationTree = native.enterInstallationOperation()
  if (operationTree.status !== 'joined' && operationTree.status !== 'delegated') {
    throw new Error(`INSTALLATION_OPERATION_${operationTree.status.toUpperCase()}:${operationTree.code}`)
  }
  if (operationTree.status !== 'delegated') throw new Error('INSTALLATION_NSIS_OPERATION_REQUIRED')
  const directoryCheck = native.verifyInstallationDirectory()
  if (!directoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const acquired = native.acquireAdministrative()
  if (acquired.status === 'abandoned') {
    const release = native.releaseOwned()
    if (release.status !== 'released') throw new Error('INSTALLATION_ADMIN_ABANDONED_RELEASE_FAILED')
    throw new Error('INSTALLATION_ADMIN_RECOVERY_REQUIRED')
  }
  if (acquired.status !== 'acquired') throw new Error(`INSTALLATION_ADMIN_LOCK_${acquired.status.toUpperCase()}:${acquired.code}`)

  let runtimeAcquired = false
  try {
    const runtime = native.acquireRuntime()
    if (runtime.status === 'abandoned') throw new Error('INSTALLATION_RUNTIME_RECOVERY_REQUIRED')
    if (runtime.status !== 'acquired') throw new Error(`INSTALLATION_RUNTIME_LOCK_${runtime.status.toUpperCase()}:${runtime.code}`)
    runtimeAcquired = true
    const lockedDirectoryCheck = native.verifyInstallationDirectory()
    if (!lockedDirectoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${lockedDirectoryCheck.code}`)
    const manifestCheck = native.verifyInstallationManifest()
    if (!manifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${manifestCheck.code}`)
    const root = native.getProgramDataDirectory()
    if (typeof root !== 'string' || !path.isAbsolute(root) ||
        path.resolve(store.directory) !== path.resolve(path.join(root, 'KaraokeQueue'))) {
      throw new Error('INSTALLATION_CONTROL_PATH_MISMATCH')
    }
    const current = store.read()
    if (!current) throw new Error('INSTALLATION_MANIFEST_MISSING')
    assertOperationFence(current, fence, true, true)
    const pending = current.pending
    if (!pending) {
      if (current.lastCompletedOperation?.kind === 'restore-installation') throw new Error('INSTALLATION_OPERATION_REUSE_CONFLICT')
      if (current.status === 'ready' || current.status === 'unconfigured') return current
      throw new Error('INSTALLATION_RECOVERY_REQUIRED')
    }
    if (!['pending', 'repairRequired'].includes(current.status)) throw new Error('INSTALLATION_RECOVERY_REQUIRED')
    let committed: InstallationManifest
    if (pending.kind === 'prepare-update') {
      if (pending.role === null && pending.baseGeneration === 0) {
        if (!shortcuts.synchronizeBootstrap) throw new Error('INSTALLATION_BOOTSTRAP_SHORTCUT_SYNC_UNAVAILABLE')
        shortcuts.synchronizeBootstrap(pending.operationId)
      }
      committed = store.commitInstallationUpdate(pending.operationId)
    } else if (pending.kind === 'uninstall') {
      throw new Error('INSTALLATION_UNINSTALL_RECOVERY_REQUIRES_NSIS')
    } else {
      if (!shortcuts || typeof shortcuts.synchronize !== 'function') throw new Error('INSTALLATION_SHORTCUT_SYNC_UNAVAILABLE')
      shortcuts.synchronize(pending.role, pending.operationId)
      const shortcutCheck = native.verifyInstallationManifest()
      if (!shortcutCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${shortcutCheck.code}`)
      committed = pending.kind === 'confirm-initial'
        ? store.commitInitialRole(pending.operationId)
        : store.commitRoleChange(pending.operationId)
    }
    const committedCheck = native.verifyInstallationManifest()
    if (!committedCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${committedCheck.code}`)
    const verified = store.read()
    const expectedStatus = pending.kind === 'prepare-update' && pending.role === null ? 'unconfigured' : 'ready'
    if (!verified || verified.status !== expectedStatus || verified.generation !== committed.generation ||
        verified.role !== pending.role || verified.lastCompletedOperation?.operationId !== pending.operationId) {
      throw new Error('INSTALLATION_RECOVERY_READBACK_FAILED')
    }
    const expectedCompletedKind = pending.kind === 'prepare-update' ? 'prepare-update' : pending.kind
    if (verified.lastCompletedOperation.kind !== expectedCompletedKind) throw new Error('INSTALLATION_RECOVERY_READBACK_FAILED')
    return verified
  } finally {
    try {
      if (runtimeAcquired) {
        const runtimeReleased = native.releaseRuntime()
        if (runtimeReleased.status !== 'released') throw new Error(`INSTALLATION_RUNTIME_RELEASE_${runtimeReleased.status.toUpperCase()}:${runtimeReleased.code}`)
      }
    } finally {
      const released = native.releaseOwned()
      if (released.status !== 'released') throw new Error(`INSTALLATION_ADMIN_RELEASE_${released.status.toUpperCase()}:${released.code}`)
    }
  }
}

/** Persists a maintenance barrier before NSIS replaces any installed executable files. */
export function prepareInstallationUpdate(
  environment: InstallationAdminEnvironment,
  native: InstallationNativeBinding,
  store: InstallationControlStore,
  fence: InstallationOperationFence
): InstallationManifest {
  if (environment.platform !== 'win32' || !environment.isPackaged) throw new Error('INSTALLATION_ADMIN_CONTEXT_INVALID')
  if (!native.isProcessElevated()) throw new Error('INSTALLATION_ADMIN_NOT_ELEVATED')
  if (!native.isExecutableInProgramFiles()) throw new Error('INSTALLATION_ADMIN_IMAGE_UNTRUSTED')
  const operationTree = native.enterInstallationOperation()
  if (operationTree.status !== 'joined' && operationTree.status !== 'delegated') {
    throw new Error(`INSTALLATION_OPERATION_${operationTree.status.toUpperCase()}:${operationTree.code}`)
  }
  if (operationTree.status !== 'delegated') throw new Error('INSTALLATION_NSIS_OPERATION_REQUIRED')
  const directoryCheck = native.verifyInstallationDirectory()
  if (!directoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const acquired = native.acquireAdministrative()
  if (acquired.status === 'abandoned') {
    const release = native.releaseOwned()
    if (release.status !== 'released') throw new Error('INSTALLATION_ADMIN_ABANDONED_RELEASE_FAILED')
    throw new Error('INSTALLATION_ADMIN_RECOVERY_REQUIRED')
  }
  if (acquired.status !== 'acquired') throw new Error(`INSTALLATION_ADMIN_LOCK_${acquired.status.toUpperCase()}:${acquired.code}`)
  let runtimeAcquired = false
  try {
    const runtime = native.acquireRuntime()
    if (runtime.status === 'abandoned') throw new Error('INSTALLATION_RUNTIME_RECOVERY_REQUIRED')
    if (runtime.status !== 'acquired') throw new Error(`INSTALLATION_RUNTIME_LOCK_${runtime.status.toUpperCase()}:${runtime.code}`)
    runtimeAcquired = true
    const lockedDirectoryCheck = native.verifyInstallationDirectory()
    if (!lockedDirectoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${lockedDirectoryCheck.code}`)
    const manifestCheck = native.verifyInstallationManifest()
    if (!manifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${manifestCheck.code}`)
    const root = native.getProgramDataDirectory()
    if (typeof root !== 'string' || !path.isAbsolute(root) ||
        path.resolve(store.directory) !== path.resolve(path.join(root, 'KaraokeQueue'))) {
      throw new Error('INSTALLATION_CONTROL_PATH_MISMATCH')
    }
    const current = store.read()
    if (!current) throw new Error('INSTALLATION_MANIFEST_MISSING')
    assertOperationFence(current, fence, false)
    let prepared: InstallationManifest
    if (current.pending) {
      if (current.pending.kind === 'uninstall' || !['pending', 'repairRequired'].includes(current.status)) {
        throw new Error('INSTALLATION_RECOVERY_REQUIRED')
      }
      // Replacing binaries is safe while resuming an exact pending confirmation,
      // role change, or update; repair-pending keeps its original operationId.
      prepared = current
    } else {
      if (current.status !== 'ready' && current.status !== 'unconfigured') throw new Error('INSTALLATION_RECOVERY_REQUIRED')
      prepared = store.beginInstallationUpdate(fence.operationId, current.generation)
    }
    const pendingCheck = native.verifyInstallationManifest()
    if (!pendingCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${pendingCheck.code}`)
    const verified = store.read()
    if (!verified || verified.status !== prepared.status || !verified.pending ||
        verified.pending.operationId !== prepared.pending?.operationId ||
        verified.pending.kind !== prepared.pending?.kind || verified.role !== prepared.role) {
      throw new Error('INSTALLATION_UPDATE_PENDING_READBACK_FAILED')
    }
    return verified
  } finally {
    try {
      if (runtimeAcquired) {
        const runtimeReleased = native.releaseRuntime()
        if (runtimeReleased.status !== 'released') throw new Error(`INSTALLATION_RUNTIME_RELEASE_${runtimeReleased.status.toUpperCase()}:${runtimeReleased.code}`)
      }
    } finally {
      const released = native.releaseOwned()
      if (released.status !== 'released') throw new Error(`INSTALLATION_ADMIN_RELEASE_${released.status.toUpperCase()}:${released.code}`)
    }
  }
}

export function cleanupInstallationShortcutsForUninstall(
  environment: InstallationAdminEnvironment,
  native: InstallationNativeBinding,
  store: InstallationControlStore,
  shell: ShortcutShell,
  executablePath: string,
  resourcesDirectory: string,
  fence: InstallationOperationFence
): number {
  if (environment.platform !== 'win32' || !environment.isPackaged) throw new Error('INSTALLATION_ADMIN_CONTEXT_INVALID')
  if (!native.isProcessElevated()) throw new Error('INSTALLATION_ADMIN_NOT_ELEVATED')
  if (!native.isExecutableInProgramFiles()) throw new Error('INSTALLATION_ADMIN_IMAGE_UNTRUSTED')
  const operationTree = native.enterInstallationOperation()
  if (operationTree.status !== 'joined' && operationTree.status !== 'delegated') {
    throw new Error(`INSTALLATION_OPERATION_${operationTree.status.toUpperCase()}:${operationTree.code}`)
  }
  if (operationTree.status !== 'delegated') throw new Error('INSTALLATION_NSIS_OPERATION_REQUIRED')
  const directoryCheck = native.verifyInstallationDirectory()
  if (!directoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const acquired = native.acquireAdministrative()
  if (acquired.status === 'abandoned') {
    const release = native.releaseOwned()
    if (release.status !== 'released') throw new Error('INSTALLATION_ADMIN_ABANDONED_RELEASE_FAILED')
    throw new Error('INSTALLATION_ADMIN_RECOVERY_REQUIRED')
  }
  if (acquired.status !== 'acquired') throw new Error(`INSTALLATION_ADMIN_LOCK_${acquired.status.toUpperCase()}:${acquired.code}`)

  let runtimeAcquired = false
  try {
    const runtime = native.acquireRuntime()
    if (runtime.status === 'abandoned') throw new Error('INSTALLATION_RUNTIME_RECOVERY_REQUIRED')
    if (runtime.status !== 'acquired') throw new Error(`INSTALLATION_RUNTIME_LOCK_${runtime.status.toUpperCase()}:${runtime.code}`)
    runtimeAcquired = true
    const lockedDirectoryCheck = native.verifyInstallationDirectory()
    if (!lockedDirectoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${lockedDirectoryCheck.code}`)
    const manifestCheck = native.verifyInstallationManifest()
    if (!manifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${manifestCheck.code}`)
    const root = native.getProgramDataDirectory()
    if (typeof root !== 'string' || !path.isAbsolute(root) ||
        path.resolve(store.directory) !== path.resolve(path.join(root, 'KaraokeQueue'))) {
      throw new Error('INSTALLATION_CONTROL_PATH_MISMATCH')
    }
    let manifest = store.read()
    if (!manifest) throw new Error('INSTALLATION_RECOVERY_REQUIRED')
    assertOperationFence(manifest, fence, false)
    if (manifest.pending) {
      if (manifest.pending.kind !== 'uninstall' || !['pending', 'repairRequired'].includes(manifest.status)) {
        throw new Error('INSTALLATION_RECOVERY_REQUIRED')
      }
      manifest = store.beginInstallationUninstall(manifest.pending.operationId, manifest.pending.baseGeneration)
    } else {
      if (manifest.status !== 'ready' && manifest.status !== 'unconfigured') throw new Error('INSTALLATION_RECOVERY_REQUIRED')
      manifest = store.beginInstallationUninstall(fence.operationId, manifest.generation)
    }
    const pendingCheck = native.verifyInstallationManifest()
    if (!pendingCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${pendingCheck.code}`)
    const pending = store.read()
    if (!pending || pending.status !== 'pending' || pending.pending?.kind !== 'uninstall' ||
        pending.pending.operationId !== manifest.pending?.operationId || pending.role !== manifest.role) {
      throw new Error('INSTALLATION_UNINSTALL_PENDING_READBACK_FAILED')
    }
    const removed = removeManagedInstallationShortcuts({ platform: environment.platform, executablePath,
      resourcesDirectory, native, shell })
    const afterRemovalCheck = native.verifyInstallationManifest()
    if (!afterRemovalCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${afterRemovalCheck.code}`)
    const afterRemoval = store.read()
    if (!afterRemoval || afterRemoval.status !== 'pending' || afterRemoval.pending?.kind !== 'uninstall' ||
        afterRemoval.pending.operationId !== pending.pending.operationId || afterRemoval.role !== pending.role) {
      throw new Error('INSTALLATION_UNINSTALL_PENDING_READBACK_FAILED')
    }
    return removed
  } finally {
    try {
      if (runtimeAcquired) {
        const runtimeReleased = native.releaseRuntime()
        if (runtimeReleased.status !== 'released') throw new Error(`INSTALLATION_RUNTIME_RELEASE_${runtimeReleased.status.toUpperCase()}:${runtimeReleased.code}`)
      }
    } finally {
      const released = native.releaseOwned()
      if (released.status !== 'released') throw new Error(`INSTALLATION_ADMIN_RELEASE_${released.status.toUpperCase()}:${released.code}`)
    }
  }
}

/** Restores the recorded role only when a later NSIS reinstall resumes an uninstall tombstone. */
export function restoreInstallationAfterUninstall(
  environment: InstallationAdminEnvironment,
  native: InstallationNativeBinding,
  store: InstallationControlStore,
  shortcuts: InitialRoleShortcutProvisioner,
  fence: InstallationOperationFence
): InstallationManifest {
  if (environment.platform !== 'win32' || !environment.isPackaged) throw new Error('INSTALLATION_ADMIN_CONTEXT_INVALID')
  if (!native.isProcessElevated()) throw new Error('INSTALLATION_ADMIN_NOT_ELEVATED')
  if (!native.isExecutableInProgramFiles()) throw new Error('INSTALLATION_ADMIN_IMAGE_UNTRUSTED')
  const operationTree = native.enterInstallationOperation()
  if (operationTree.status !== 'joined' && operationTree.status !== 'delegated') {
    throw new Error(`INSTALLATION_OPERATION_${operationTree.status.toUpperCase()}:${operationTree.code}`)
  }
  if (operationTree.status !== 'delegated') throw new Error('INSTALLATION_NSIS_OPERATION_REQUIRED')
  const directoryCheck = native.verifyInstallationDirectory()
  if (!directoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const acquired = native.acquireAdministrative()
  if (acquired.status === 'abandoned') {
    const release = native.releaseOwned()
    if (release.status !== 'released') throw new Error('INSTALLATION_ADMIN_ABANDONED_RELEASE_FAILED')
    throw new Error('INSTALLATION_ADMIN_RECOVERY_REQUIRED')
  }
  if (acquired.status !== 'acquired') throw new Error(`INSTALLATION_ADMIN_LOCK_${acquired.status.toUpperCase()}:${acquired.code}`)

  let runtimeAcquired = false
  try {
    const runtime = native.acquireRuntime()
    if (runtime.status === 'abandoned') throw new Error('INSTALLATION_RUNTIME_RECOVERY_REQUIRED')
    if (runtime.status !== 'acquired') throw new Error(`INSTALLATION_RUNTIME_LOCK_${runtime.status.toUpperCase()}:${runtime.code}`)
    runtimeAcquired = true
    const lockedDirectoryCheck = native.verifyInstallationDirectory()
    if (!lockedDirectoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${lockedDirectoryCheck.code}`)
    const manifestCheck = native.verifyInstallationManifest()
    if (!manifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${manifestCheck.code}`)
    const root = native.getProgramDataDirectory()
    if (typeof root !== 'string' || !path.isAbsolute(root) ||
        path.resolve(store.directory) !== path.resolve(path.join(root, 'KaraokeQueue'))) {
      throw new Error('INSTALLATION_CONTROL_PATH_MISMATCH')
    }
    const current = store.read()
    if (!current) throw new Error('INSTALLATION_MANIFEST_MISSING')
    assertOperationFence(current, fence, true, true)
    if (!current.pending && (current.status === 'ready' || current.status === 'unconfigured') &&
        current.lastCompletedOperation?.kind === 'restore-installation') return current
    const pending = current.pending
    if (!pending || pending.kind !== 'uninstall' || !['pending', 'repairRequired'].includes(current.status)) {
      throw new Error('INSTALLATION_REINSTALL_RECOVERY_REQUIRED')
    }
    if (pending.role === null) {
      if (typeof shortcuts.synchronizeBootstrap !== 'function') throw new Error('INSTALLATION_BOOTSTRAP_SHORTCUT_SYNC_UNAVAILABLE')
      shortcuts.synchronizeBootstrap(pending.operationId)
    } else {
      if (!shortcuts || typeof shortcuts.synchronize !== 'function') throw new Error('INSTALLATION_SHORTCUT_SYNC_UNAVAILABLE')
      shortcuts.synchronize(pending.role, pending.operationId)
    }
    const synchronizedCheck = native.verifyInstallationManifest()
    if (!synchronizedCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${synchronizedCheck.code}`)
    const committed = store.restoreInstallationAfterUninstall(pending.operationId)
    const committedCheck = native.verifyInstallationManifest()
    if (!committedCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${committedCheck.code}`)
    const verified = store.read()
    const expectedStatus = pending.role === null ? 'unconfigured' : 'ready'
    if (!verified || verified.status !== expectedStatus || verified.generation !== committed.generation ||
        verified.role !== pending.role || verified.lastCompletedOperation?.kind !== 'restore-installation' ||
        verified.lastCompletedOperation.operationId !== pending.operationId) {
      throw new Error('INSTALLATION_REINSTALL_READBACK_FAILED')
    }
    return verified
  } finally {
    try {
      if (runtimeAcquired) {
        const runtimeReleased = native.releaseRuntime()
        if (runtimeReleased.status !== 'released') throw new Error(`INSTALLATION_RUNTIME_RELEASE_${runtimeReleased.status.toUpperCase()}:${runtimeReleased.code}`)
      }
    } finally {
      const released = native.releaseOwned()
      if (released.status !== 'released') throw new Error(`INSTALLATION_ADMIN_RELEASE_${released.status.toUpperCase()}:${released.code}`)
    }
  }
}

export function loadWindowsInstallationBinding(resourcesPath: string, platform: NodeJS.Platform): InstallationNativeBinding {
  if (platform !== 'win32' || !path.isAbsolute(resourcesPath)) throw new Error('INSTALLATION_NATIVE_UNAVAILABLE')
  const addonPath = path.join(resourcesPath, 'native', 'win32-x64', 'kq_win32.node')
  const binding = require(addonPath) as Partial<InstallationNativeBinding>
  const required: (keyof InstallationNativeBinding)[] = [
    'isProcessElevated', 'isExecutableInProgramFiles', 'getProgramDataDirectory',
    'getCommonProgramsDirectory', 'getPublicDesktopDirectory',
    'verifyInstallationDirectory', 'verifyInstallationManifest', 'acquireAdministrative', 'releaseOwned',
    'acquireRuntime', 'releaseRuntime',
    'launchInitialRoleConfirmation', 'getInitialRoleConfirmationStatus'
  ]
  if (required.some(key => typeof binding[key] !== 'function')) throw new Error('INSTALLATION_NATIVE_API_INVALID')
  return binding as InstallationNativeBinding
}
