import { app, dialog, shell } from 'electron'
import { containsInstallationAdminSwitch, parseInstallationAdminCommand } from './src/installation-admin-args'
import { changeInstalledRole, cleanupInstallationShortcutsForUninstall, confirmInitialInstallationRole,
  loadWindowsInstallationBinding, prepareInstallationUpdate, repairPendingInstallation } from './src/installation-admin'
import { restoreInstallationAfterUninstall } from './src/installation-admin'
import { acquirePackagedInstallationState } from './src/installation-bootstrap'
import { InstallationControlStore } from './src/installation-control'
import { setPackagedInstallationContext } from './src/installed-role-context'
import { synchronizeBootstrapShortcuts, synchronizeInitialFunctionShortcuts } from './src/installation-shortcuts'
import type { InstalledRole } from './src/installation-control'
import path from 'node:path'

const adminArgs = process.argv.slice(1)
const adminRequested = containsInstallationAdminSwitch(adminArgs)
const hasApplicationInstanceLock = adminRequested ? true : app.requestSingleInstanceLock()
if (!adminRequested && !hasApplicationInstanceLock) app.quit()

function showBootstrapFailure(title: string, error: unknown): void {
  const code = error instanceof Error ? error.message : 'INSTALLATION_BOOTSTRAP_FAILED'
  dialog.showErrorBox(title, `Nenhum dado operacional foi aberto ou alterado. Código: ${code}`)
  app.exit(2)
}

if (adminRequested) {
  // Administrative operations use synchronous Win32/filesystem/shell APIs.
  // Exit before Chromium readiness so even rejected commands cannot open or
  // mutate the account's operational profile (including ShaderCache).
  try {
    const command = parseInstallationAdminCommand(adminArgs)
    if (!command) throw new Error('INSTALLATION_ADMIN_ARGUMENTS_INVALID')
    const native = loadWindowsInstallationBinding(process.resourcesPath, process.platform)
    const programData = native.getProgramDataDirectory()
    if (typeof programData !== 'string' || !path.isAbsolute(programData)) {
      throw new Error('INSTALLATION_PROGRAM_DATA_UNAVAILABLE')
    }
    const store = new InstallationControlStore(path.join(programData, 'KaraokeQueue'))
    const shortcuts = {
      synchronize: (role: InstalledRole, operationId: string) => synchronizeInitialFunctionShortcuts({
        platform: process.platform,
        operationId,
        role,
        executablePath: process.execPath,
        resourcesDirectory: process.resourcesPath,
        native,
        store,
        shell
      }),
      synchronizeBootstrap: (operationId: string) => synchronizeBootstrapShortcuts({
        platform: process.platform,
        operationId,
        executablePath: process.execPath,
        native,
        store,
        shell
      })
    }
    if (command.operation === 'confirm-initial') {
      confirmInitialInstallationRole(command, { platform: process.platform, isPackaged: app.isPackaged }, native, store, shortcuts)
    } else if (command.operation === 'repair-pending') {
      repairPendingInstallation({ platform: process.platform, isPackaged: app.isPackaged }, native, store, shortcuts, command)
    } else if (command.operation === 'prepare-update') {
      prepareInstallationUpdate({ platform: process.platform, isPackaged: app.isPackaged }, native, store, command)
    } else if (command.operation === 'uninstall-cleanup') {
      cleanupInstallationShortcutsForUninstall({ platform: process.platform, isPackaged: app.isPackaged },
        native, store, shell, process.execPath, process.resourcesPath, command)
    } else if (command.operation === 'restore-after-uninstall') {
      restoreInstallationAfterUninstall({ platform: process.platform, isPackaged: app.isPackaged }, native, store, shortcuts, command)
    } else {
      changeInstalledRole(command.role, { platform: process.platform, isPackaged: app.isPackaged }, native, store, shortcuts, command)
    }
    app.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'INSTALLATION_ADMIN_FAILED'
    const code = /^[A-Z][A-Z0-9_]+/.exec(message)?.[0] ?? 'INSTALLATION_ADMIN_FAILED'
    console.error(code)
    app.exit(code === 'INSTALLATION_RUNTIME_LOCK_BUSY' ? 32 : 2)
  }
} else if (hasApplicationInstanceLock) {
  let packagedBootstrapSucceeded = false
  if (app.isPackaged) {
    try {
      if (process.platform !== 'win32') throw new Error('PACKAGED_PLATFORM_UNSUPPORTED')
      const native = loadWindowsInstallationBinding(process.resourcesPath, process.platform)
      if (!native.isExecutableInProgramFiles()) throw new Error('INSTALLATION_IMAGE_UNTRUSTED')
      const programData = native.getProgramDataDirectory()
      if (typeof programData !== 'string' || !path.isAbsolute(programData)) throw new Error('INSTALLATION_PROGRAM_DATA_UNAVAILABLE')
      const store = new InstallationControlStore(path.join(programData, 'KaraokeQueue'))
      const state = acquirePackagedInstallationState(native, store)
      try { setPackagedInstallationContext({ role: state.role, native, store, runtimeGate: state.runtimeGate }) }
      catch (error) { state.runtimeGate.release(); throw error }
      packagedBootstrapSucceeded = true
    } catch (error) {
      void app.whenReady().then(() => showBootstrapFailure('Não foi possível validar a instalação', error))
    }
  }

  if (!app.isPackaged || packagedBootstrapSucceeded) {
    // This synchronous load preserves Electron's before-ready protocol registration and
    // single-instance lock while keeping operational composition behind the global gate.
    try {
      require('./main-runtime')
    } catch (error) {
      void app.whenReady().then(() => showBootstrapFailure('Não foi possível carregar a instalação', error))
    }
  }
}
