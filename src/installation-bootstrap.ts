import type { InstallationNativeBinding } from './installation-admin'
import type { InstalledRole, InstallationControlStore } from './installation-control'
import { InstallationRuntimeGate, type RuntimeGateNative } from './installation-runtime-gate'

export function readPackagedInstalledRole(
  native: Pick<InstallationNativeBinding, 'verifyInstallationDirectory' | 'verifyInstallationManifest'>,
  store: Pick<InstallationControlStore, 'read'>
): InstalledRole | null {
  const directoryCheck = native.verifyInstallationDirectory()
  if (!directoryCheck.ok) throw new Error(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const manifestCheck = native.verifyInstallationManifest()
  if (!manifestCheck.ok) throw new Error(`INSTALLATION_MANIFEST_UNTRUSTED:${manifestCheck.code}`)
  const manifest = store.read()
  if (!manifest) throw new Error('INSTALLATION_MANIFEST_MISSING')
  if (manifest.status === 'pending' || manifest.status === 'repairRequired') throw new Error('INSTALLATION_RECOVERY_REQUIRED')
  if (manifest.status === 'ready') {
    if (manifest.role !== 'player' && manifest.role !== 'combined') throw new Error('INSTALLATION_ROLE_INVALID')
    return manifest.role
  }
  if (manifest.status === 'unconfigured' && manifest.role === null) return null
  throw new Error('INSTALLATION_MANIFEST_STATE_INVALID')
}

/**
 * The protected global role is read only after taking the computer-wide runtime
 * gate. This also gates first-run Welcome so another Windows account cannot hold
 * an onboarding snapshot while an installer commits a different role.
 */
export function acquirePackagedInstallationState(
  native: Pick<InstallationNativeBinding, 'verifyInstallationDirectory' | 'verifyInstallationManifest'> & RuntimeGateNative,
  store: Pick<InstallationControlStore, 'read'>
): { role: InstalledRole | null; runtimeGate: InstallationRuntimeGate } {
  const runtimeGate = InstallationRuntimeGate.acquire(native)
  try {
    return { role: readPackagedInstalledRole(native, store), runtimeGate }
  } catch (error) {
    runtimeGate.release()
    throw error
  }
}
