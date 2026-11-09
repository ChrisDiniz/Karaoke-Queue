import type { InstallationNativeBinding } from './installation-admin'
import type { InstalledRole, InstallationControlStore } from './installation-control'
import type { InstallationRuntimeGate } from './installation-runtime-gate'

export interface PackagedInstallationContext {
  role: InstalledRole | null
  native: Pick<InstallationNativeBinding,
    'verifyInstallationDirectory' | 'verifyInstallationManifest' |
    'launchInitialRoleConfirmation' | 'getInitialRoleConfirmationStatus' | 'acquireRuntime' | 'releaseRuntime'>
  store: Pick<InstallationControlStore, 'read'>
  runtimeGate: InstallationRuntimeGate
}

let installationContext: PackagedInstallationContext | undefined

/** Set only by the trusted packaged bootstrap before loading the Main composition. */
export function setPackagedInstallationContext(context: PackagedInstallationContext): void {
  if (!context.runtimeGate) throw new Error('PACKAGED_RUNTIME_GATE_REQUIRED')
  if (installationContext && installationContext.role !== context.role) throw new Error('INSTALLED_ROLE_ALREADY_SET')
  installationContext = context
}

/** undefined means the unpackaged development profile; null means packaged but unconfigured. */
export function getPackagedInstalledRole(): InstalledRole | null | undefined {
  return installationContext?.role
}

export function getPackagedInstallationContext(): PackagedInstallationContext | undefined {
  return installationContext
}
