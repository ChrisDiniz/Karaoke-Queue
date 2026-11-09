import type { InstalledRole } from './installation-control'

export interface ConfirmInitialRoleCommand extends InstallationOperationFence {
  operation: 'confirm-initial'
  operationId: string
  expectedGeneration: number
  role: InstalledRole
}
export interface ChangeInstallationRoleCommand extends InstallationOperationFence {
  operation: 'change-role'
  role: InstalledRole
}
export interface InstallationOperationFence { installationId: string; operationId: string; expectedGeneration: number }
export interface RepairPendingInstallationCommand extends InstallationOperationFence { operation: 'repair-pending' }
export interface PrepareInstallationUpdateCommand extends InstallationOperationFence { operation: 'prepare-update' }
export interface UninstallShortcutCleanupCommand extends InstallationOperationFence { operation: 'uninstall-cleanup' }
export interface RestoreInstallationAfterUninstallCommand extends InstallationOperationFence { operation: 'restore-after-uninstall' }
export type InstallationAdminCommand = ConfirmInitialRoleCommand | ChangeInstallationRoleCommand |
  RepairPendingInstallationCommand | PrepareInstallationUpdateCommand | UninstallShortcutCleanupCommand |
  RestoreInstallationAfterUninstallCommand

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function containsInstallationAdminSwitch(args: readonly string[]): boolean {
  return args.some(value => value === '--kq-install-admin' || value.startsWith('--kq-install-admin='))
}

export function parseInstallationAdminCommand(args: readonly string[]): InstallationAdminCommand | null {
  if (!containsInstallationAdminSwitch(args)) return null
  if (args[0] !== '--kq-install-admin') throw new Error('INSTALLATION_ADMIN_ARGUMENTS_INVALID')
  const fencedOperations = ['change-role', 'repair-pending', 'prepare-update', 'uninstall-cleanup', 'restore-after-uninstall']
  if (fencedOperations.includes(args[1] ?? '')) {
    const change = args[1] === 'change-role'
    if (args.length !== (change ? 10 : 8) || args[2] !== '--installation-id' || args[4] !== '--operation-id' ||
        args[6] !== '--expected-generation' || !UUID_PATTERN.test(args[3] ?? '') || !UUID_PATTERN.test(args[5] ?? '') ||
        !/^(0|[1-9][0-9]*)$/.test(args[7] ?? '') || !Number.isSafeInteger(Number(args[7]))) {
      throw new Error('INSTALLATION_ADMIN_ARGUMENTS_INVALID')
    }
    const fence = { installationId: args[3]!, operationId: args[5]!, expectedGeneration: Number(args[7]) }
    if (change) {
      if (args[8] !== '--role' || (args[9] !== 'player' && args[9] !== 'combined')) throw new Error('INSTALLATION_ADMIN_ARGUMENTS_INVALID')
      return { operation: 'change-role', ...fence, role: args[9] }
    }
    return { operation: args[1] as RepairPendingInstallationCommand['operation'] | PrepareInstallationUpdateCommand['operation'] |
      UninstallShortcutCleanupCommand['operation'] | RestoreInstallationAfterUninstallCommand['operation'], ...fence }
  }
  if (args.length !== 10 || args[8] !== '--installation-id' || !UUID_PATTERN.test(args[9] ?? '') || args[1] !== 'confirm-initial' ||
      args[2] !== '--operation-id' || args[4] !== '--expected-generation' || args[6] !== '--role') {
    throw new Error('INSTALLATION_ADMIN_ARGUMENTS_INVALID')
  }
  const operationId = args[3]
  const generationText = args[5]
  const role = args[7] as string | undefined
  if (!operationId || !UUID_PATTERN.test(operationId) || !generationText || !/^(0|[1-9][0-9]*)$/.test(generationText) ||
      !role || (role !== 'player' && role !== 'combined')) throw new Error('INSTALLATION_ADMIN_ARGUMENTS_INVALID')
  const expectedGeneration = Number(generationText)
  if (!Number.isSafeInteger(expectedGeneration)) throw new Error('INSTALLATION_ADMIN_ARGUMENTS_INVALID')
  return { operation: 'confirm-initial', operationId, expectedGeneration, role, installationId: args[9]! }
}
