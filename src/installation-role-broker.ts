import crypto from 'node:crypto'
import type { InstallationNativeBinding } from './installation-admin'
import type { InstalledRole, InstallationControlStore } from './installation-control'

export type InitialRoleBrokerNative = Pick<InstallationNativeBinding,
  'verifyInstallationDirectory' | 'verifyInstallationManifest' |
  'launchInitialRoleConfirmation' | 'getInitialRoleConfirmationStatus'>

export interface InitialRoleBrokerDependencies {
  native: InitialRoleBrokerNative
  store: Pick<InstallationControlStore, 'read'>
  relaunch(): void
  quit(): void
  onConfirmed?(): void
  releaseRuntimeGate(): void
  restoreRuntimeGate(): void
  quitForRecovery(): void
  createOperationId?(): string
  wait?(milliseconds: number): Promise<void>
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function isConfirmed(store: Pick<InstallationControlStore, 'read'>, operationId: string, role: InstalledRole, installationId: string): boolean {
  const manifest = store.read()
  return manifest?.installationId === installationId && manifest?.status === 'ready' && manifest.role === role &&
    manifest.lastCompletedOperation?.operationId === operationId &&
    manifest.lastCompletedOperation.role === role
}

/** Requests only the fixed, allowlisted first-role operation and trusts the protected manifest read-back. */
export async function confirmInitialRoleThroughUac(
  role: InstalledRole,
  deps: InitialRoleBrokerDependencies
): Promise<void> {
  if (role !== 'player' && role !== 'combined') throw new Error('INSTALLATION_ROLE_INVALID')
  const initial = deps.store.read()
  if (!initial) throw new Error('INSTALLATION_MANIFEST_MISSING')
  if (initial.status === 'ready') {
    if (initial.role !== role) throw new Error('INSTALLATION_ROLE_ALREADY_CONFIRMED')
    deps.onConfirmed?.()
    deps.relaunch()
    deps.quit()
    return
  }
  const retryPending = initial.status === 'pending' && initial.pending?.kind === 'confirm-initial' &&
    initial.pending.role === role
  if ((!retryPending && (initial.status !== 'unconfigured' || initial.pending)) ||
      (initial.status === 'pending' && !retryPending)) throw new Error('INSTALLATION_RECOVERY_REQUIRED')

  const directory = deps.native.verifyInstallationDirectory()
  if (!directory.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${directory.code}`)
  const manifest = deps.native.verifyInstallationManifest()
  if (!manifest.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${manifest.code}`)

  const operationId = retryPending ? initial.pending!.operationId : (deps.createOperationId ?? crypto.randomUUID)()
  const expectedGeneration = retryPending ? initial.pending!.baseGeneration : initial.generation
  // The elevated helper takes the same runtime mutex after the Main thread has
  // stopped admitting work. Keep cancellation recoverable by reacquiring and
  // rereading the manifest before this process continues to serve Welcome.
  deps.releaseRuntimeGate()
  const launched = deps.native.launchInitialRoleConfirmation(operationId, expectedGeneration, role, initial.installationId)
  if (launched.status === 'cancelled') {
    deps.restoreRuntimeGate()
    throw new Error('INSTALLATION_ROLE_CONFIRMATION_CANCELLED')
  }
  if (launched.status !== 'started') {
    deps.restoreRuntimeGate()
    throw new Error(`INSTALLATION_ROLE_CONFIRMATION_LAUNCH_${launched.status.toUpperCase()}:${launched.code}`)
  }

  const wait = deps.wait ?? defaultWait
  while (true) {
    const status = deps.native.getInitialRoleConfirmationStatus()
    if (status.status === 'pending') {
      await wait(120)
      continue
    }
    if (status.status !== 'completed') throw new Error(`INSTALLATION_ROLE_CONFIRMATION_WAIT_${status.status.toUpperCase()}:${status.code}`)

    // The helper may commit successfully and still fail to return a reliable exit status.
    if (!isConfirmed(deps.store, operationId, role, initial.installationId)) {
      deps.relaunch()
      deps.quitForRecovery()
      throw new Error(status.exitCode === 1223
        ? 'INSTALLATION_ROLE_CONFIRMATION_CANCELLED'
        : `INSTALLATION_ROLE_CONFIRMATION_FAILED:${status.exitCode ?? status.code}`)
    }
    const committedAcl = deps.native.verifyInstallationManifest()
    if (!committedAcl.ok) {
      deps.relaunch()
      deps.quitForRecovery()
      throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${committedAcl.code}`)
    }
    deps.onConfirmed?.()
    deps.relaunch()
    deps.quit()
    return
  }
}
