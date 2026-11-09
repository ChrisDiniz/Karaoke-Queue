import fs from 'node:fs'
import path from 'node:path'
import type { InstalledRole, InstallationControlStore } from './installation-control'
import { getWindowsFunctionIdentity } from './windows-function-identity'

export interface WindowsShortcutDetails {
  target: string
  cwd?: string
  args?: string
  description?: string
  icon?: string
  iconIndex?: number
  appUserModelId?: string
}

type ExpectedWindowsShortcutDetails = Required<WindowsShortcutDetails>

export interface ShortcutShell {
  writeShortcutLink(shortcutPath: string, operation: 'create', details: WindowsShortcutDetails): boolean
  readShortcutLink(shortcutPath: string): WindowsShortcutDetails
}

export interface ShortcutInstallationNative {
  isProcessElevated(): boolean
  isExecutableInProgramFiles(): boolean
  verifyInstallationDirectory(): { ok: boolean; code: number }
  verifyInstallationManifest(): { ok: boolean; code: number }
  getCommonProgramsDirectory(): string | { status: string; code: number }
  getPublicDesktopDirectory(): string | { status: string; code: number }
}

export interface SynchronizeInstallationShortcutsOptions {
  platform: NodeJS.Platform
  operationId: string
  role: InstalledRole
  executablePath: string
  resourcesDirectory: string
  native: ShortcutInstallationNative
  store: Pick<InstallationControlStore, 'read'>
  shell: ShortcutShell
}

export interface SynchronizeBootstrapShortcutsOptions {
  platform: NodeJS.Platform
  operationId: string
  executablePath: string
  native: ShortcutInstallationNative
  store: Pick<InstallationControlStore, 'read'>
  shell: ShortcutShell
}

const PRODUCT_PREFIX = 'Karaoke Queue'
const MENU_DIRECTORY = 'Karaoke Queue'
const GENERIC_SHORTCUT = 'Karaoke Queue.lnk'
const VALID_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fail(code: string): never { throw new Error(code) }

function equalPath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/, '').toLowerCase() ===
    path.resolve(right).replace(/[\\/]+$/, '').toLowerCase()
}

function lstatIfExists(filePath: string): fs.Stats | null {
  try { return fs.lstatSync(filePath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function assertDirectory(directory: string): void {
  if (!path.isAbsolute(directory)) fail('SHORTCUT_DIRECTORY_INVALID')
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SHORTCUT_DIRECTORY_UNTRUSTED')
}

function ensureDirectory(directory: string): void {
  const current = lstatIfExists(directory)
  if (!current) fs.mkdirSync(directory)
  assertDirectory(directory)
}

function readShortcutIfPresent(filePath: string, shell: ShortcutShell): WindowsShortcutDetails | null {
  const stat = lstatIfExists(filePath)
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink()) fail('SHORTCUT_PATH_UNTRUSTED')
  try { return shell.readShortcutLink(filePath) }
  catch { fail('SHORTCUT_READ_FAILED') }
}

function shortcutMatchesTarget(details: WindowsShortcutDetails, executablePath: string): boolean {
  return typeof details.target === 'string' && equalPath(details.target, executablePath) &&
    (details.args === '' || details.args === undefined)
}

function isOwnedRoleShortcut(
  details: WindowsShortcutDetails,
  executablePath: string,
  playerId: string,
  combinedId: string
): boolean {
  return shortcutMatchesTarget(details, executablePath) &&
    (details.appUserModelId === playerId || details.appUserModelId === combinedId)
}

function verifyShortcut(
  filePath: string,
  expected: ExpectedWindowsShortcutDetails,
  shell: ShortcutShell
): void {
  const actual = readShortcutIfPresent(filePath, shell)
  if (!actual || !equalPath(actual.target, expected.target) || (actual.args ?? '') !== '' ||
      actual.appUserModelId !== expected.appUserModelId || typeof actual.icon !== 'string' || !equalPath(actual.icon, expected.icon) ||
      actual.iconIndex !== 0 || actual.description !== expected.description) {
    fail('SHORTCUT_READBACK_FAILED')
  }
}

function removeManagedShortcut(
  filePath: string,
  executablePath: string,
  shell: ShortcutShell,
  playerId: string,
  combinedId: string,
  generic = false
): void {
  const actual = readShortcutIfPresent(filePath, shell)
  if (!actual) return
  const owned = generic
    ? shortcutMatchesTarget(actual, executablePath) &&
      (actual.appUserModelId === '' || actual.appUserModelId === undefined ||
       actual.appUserModelId === 'com.karaoke.queue')
    : isOwnedRoleShortcut(actual, executablePath, playerId, combinedId)
  if (!owned) fail('SHORTCUT_CONFLICT')
  fs.unlinkSync(filePath)
}

/**
 * Reconcile only the product's fixed common links. It is called inside the elevated,
 * Program Files-verified first-role operation while the installation manifest is pending.
 */
export function synchronizeInitialFunctionShortcuts(options: SynchronizeInstallationShortcutsOptions): void {
  if (options.platform !== 'win32' || !VALID_OPERATION_ID.test(options.operationId) ||
      !path.isAbsolute(options.executablePath) || !path.isAbsolute(options.resourcesDirectory)) fail('SHORTCUT_CONTEXT_INVALID')
  if (!options.native.isProcessElevated() || !options.native.isExecutableInProgramFiles()) fail('SHORTCUT_CONTEXT_UNTRUSTED')
  const directoryCheck = options.native.verifyInstallationDirectory()
  if (!directoryCheck.ok) fail(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const manifestCheck = options.native.verifyInstallationManifest()
  if (!manifestCheck.ok) fail(`INSTALLATION_MANIFEST_UNTRUSTED:${manifestCheck.code}`)
  const manifest = options.store.read()
  if (manifest?.status !== 'pending' || manifest.pending?.operationId !== options.operationId ||
      manifest.pending.role !== options.role ||
      (manifest.pending.kind !== 'confirm-initial' && manifest.pending.kind !== 'change-role' &&
       manifest.pending.kind !== 'uninstall')) fail('SHORTCUT_INTENT_MISMATCH')

  const programsRoot = options.native.getCommonProgramsDirectory()
  const desktopRoot = options.native.getPublicDesktopDirectory()
  if (typeof programsRoot !== 'string' || !path.isAbsolute(programsRoot) ||
      typeof desktopRoot !== 'string' || !path.isAbsolute(desktopRoot)) fail('SHORTCUT_KNOWN_FOLDER_UNAVAILABLE')
  assertDirectory(programsRoot)
  assertDirectory(desktopRoot)
  const menuDirectory = path.join(programsRoot, MENU_DIRECTORY)
  ensureDirectory(menuDirectory)

  const identity = getWindowsFunctionIdentity(options.role)
  const identityIconPath = path.join(options.resourcesDirectory, 'identity', identity.icoIconFile)
  const iconStat = fs.lstatSync(identityIconPath)
  if (!iconStat.isFile() || iconStat.isSymbolicLink()) fail('SHORTCUT_ICON_UNTRUSTED')
  const shortcutName = `${identity.displayName}.lnk`
  const expected: ExpectedWindowsShortcutDetails = {
    target: options.executablePath,
    cwd: path.dirname(options.executablePath),
    args: '',
    description: identity.displayName,
    icon: identityIconPath,
    iconIndex: 0,
    appUserModelId: identity.appUserModelId
  }
  const currentPaths = [path.join(menuDirectory, shortcutName), path.join(desktopRoot, shortcutName)]
  const temporaryPaths = currentPaths.map(filePath => path.join(path.dirname(filePath),
    `.${path.basename(filePath, '.lnk')}.${options.operationId}.tmp.lnk`))
  const cleanupStaging = () => {
    for (const temporaryPath of temporaryPaths) {
      try { fs.unlinkSync(temporaryPath) } catch {}
    }
  }

  try {
    for (const [index, currentPath] of currentPaths.entries()) {
      const prior = readShortcutIfPresent(currentPath, options.shell)
      if (prior && (!shortcutMatchesTarget(prior, options.executablePath) ||
          (prior.appUserModelId !== identity.appUserModelId &&
           prior.appUserModelId !== getWindowsFunctionIdentity('player').appUserModelId &&
           prior.appUserModelId !== getWindowsFunctionIdentity('combined').appUserModelId))) {
        fail('SHORTCUT_CONFLICT')
      }
      const temporaryPath = temporaryPaths[index]!
      const staged = readShortcutIfPresent(temporaryPath, options.shell)
      if (staged && (!shortcutMatchesTarget(staged, options.executablePath) ||
          staged.appUserModelId !== identity.appUserModelId)) fail('SHORTCUT_STAGING_CONFLICT')
      const written = options.shell.writeShortcutLink(temporaryPath, 'create', expected)
      if (!written) fail('SHORTCUT_WRITE_FAILED')
      verifyShortcut(temporaryPath, expected, options.shell)
    }

    for (const [index, currentPath] of currentPaths.entries()) {
      fs.renameSync(temporaryPaths[index]!, currentPath)
      verifyShortcut(currentPath, expected, options.shell)
    }

    const otherRole = options.role === 'player' ? 'combined' : 'player'
    const staleRoleName = `${getWindowsFunctionIdentity(otherRole).displayName}.lnk`
    const staleRolePaths = [path.join(menuDirectory, staleRoleName), path.join(desktopRoot, staleRoleName)]
    for (const stalePath of staleRolePaths) {
      removeManagedShortcut(stalePath, options.executablePath, options.shell,
        getWindowsFunctionIdentity('player').appUserModelId,
        getWindowsFunctionIdentity('combined').appUserModelId)
    }

    const genericPaths = [
      path.join(desktopRoot, GENERIC_SHORTCUT),
      path.join(menuDirectory, GENERIC_SHORTCUT),
      path.join(programsRoot, GENERIC_SHORTCUT)
    ]
    for (const genericPath of genericPaths) {
      removeManagedShortcut(genericPath, options.executablePath, options.shell,
        getWindowsFunctionIdentity('player').appUserModelId,
        getWindowsFunctionIdentity('combined').appUserModelId, true)
    }
  } catch (error) {
    cleanupStaging()
    throw error
  }

  // Remove only abandoned staging links with this operation ID after the desired set is verified.
  cleanupStaging()
}

/** Restores the generic first-run links only while a cancelled uninstall is being reversed by reinstall. */
export function synchronizeBootstrapShortcuts(options: SynchronizeBootstrapShortcutsOptions): void {
  if (options.platform !== 'win32' || !VALID_OPERATION_ID.test(options.operationId) || !path.isAbsolute(options.executablePath)) {
    fail('SHORTCUT_CONTEXT_INVALID')
  }
  if (!options.native.isProcessElevated() || !options.native.isExecutableInProgramFiles()) fail('SHORTCUT_CONTEXT_UNTRUSTED')
  const directoryCheck = options.native.verifyInstallationDirectory()
  if (!directoryCheck.ok) fail(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const manifestCheck = options.native.verifyInstallationManifest()
  if (!manifestCheck.ok) fail(`INSTALLATION_MANIFEST_UNTRUSTED:${manifestCheck.code}`)
  const manifest = options.store.read()
  if (!manifest || !['pending', 'repairRequired'].includes(manifest.status) || !manifest.pending || !['uninstall', 'prepare-update'].includes(manifest.pending?.kind ?? '') ||
      manifest.pending.operationId !== options.operationId || manifest.pending.role !== null) fail('SHORTCUT_INTENT_MISMATCH')

  const programsRoot = options.native.getCommonProgramsDirectory()
  const desktopRoot = options.native.getPublicDesktopDirectory()
  if (typeof programsRoot !== 'string' || !path.isAbsolute(programsRoot) ||
      typeof desktopRoot !== 'string' || !path.isAbsolute(desktopRoot)) fail('SHORTCUT_KNOWN_FOLDER_UNAVAILABLE')
  assertDirectory(programsRoot)
  assertDirectory(desktopRoot)
  const menuDirectory = path.join(programsRoot, MENU_DIRECTORY)
  ensureDirectory(menuDirectory)
  const expected: ExpectedWindowsShortcutDetails = {
    target: options.executablePath,
    cwd: path.dirname(options.executablePath),
    args: '',
    description: 'Karaoke Queue — configuração inicial',
    icon: options.executablePath,
    iconIndex: 0,
    appUserModelId: ''
  }
  const destinations = [path.join(menuDirectory, GENERIC_SHORTCUT), path.join(desktopRoot, GENERIC_SHORTCUT)]
  const staging = destinations.map(filePath => path.join(path.dirname(filePath),
    `.${path.basename(filePath, '.lnk')}.${options.operationId}.tmp.lnk`))
  const verifyBootstrap = (filePath: string) => {
    const actual = readShortcutIfPresent(filePath, options.shell)
    if (!actual || !equalPath(actual.target, expected.target) || (actual.args ?? '') !== '' ||
        typeof actual.icon !== 'string' || !equalPath(actual.icon, expected.icon) || actual.iconIndex !== 0 ||
        (actual.appUserModelId !== '' && actual.appUserModelId !== undefined && actual.appUserModelId !== 'com.karaoke.queue')) {
      fail('SHORTCUT_READBACK_FAILED')
    }
  }
  try {
    for (const [index, destination] of destinations.entries()) {
      if (lstatIfExists(destination)) {
        verifyBootstrap(destination)
        continue
      }
      const stage = staging[index]!
      if (lstatIfExists(stage)) verifyBootstrap(stage)
      else {
        if (!options.shell.writeShortcutLink(stage, 'create', expected)) fail('SHORTCUT_WRITE_FAILED')
        verifyBootstrap(stage)
      }
      fs.renameSync(stage, destination)
      verifyBootstrap(destination)
    }
  } finally {
    for (const stage of staging) {
      try { fs.unlinkSync(stage) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}

export interface RemoveInstallationShortcutOptions {
  platform: NodeJS.Platform
  executablePath: string
  resourcesDirectory: string
  native: ShortcutInstallationNative
  shell: ShortcutShell
}

/** Removes only fixed-path links whose target, arguments, AUMID and icon identify this installation. */
export function removeManagedInstallationShortcuts(options: RemoveInstallationShortcutOptions): number {
  if (options.platform !== 'win32' || !path.isAbsolute(options.executablePath) || !path.isAbsolute(options.resourcesDirectory)) {
    fail('SHORTCUT_CONTEXT_INVALID')
  }
  if (!options.native.isProcessElevated() || !options.native.isExecutableInProgramFiles()) fail('SHORTCUT_CONTEXT_UNTRUSTED')
  const directoryCheck = options.native.verifyInstallationDirectory()
  if (!directoryCheck.ok) fail(`INSTALLATION_DIRECTORY_UNTRUSTED:${directoryCheck.code}`)
  const programsRoot = options.native.getCommonProgramsDirectory()
  const desktopRoot = options.native.getPublicDesktopDirectory()
  if (typeof programsRoot !== 'string' || !path.isAbsolute(programsRoot) ||
      typeof desktopRoot !== 'string' || !path.isAbsolute(desktopRoot)) fail('SHORTCUT_KNOWN_FOLDER_UNAVAILABLE')
  assertDirectory(programsRoot)
  assertDirectory(desktopRoot)

  const menuDirectory = path.join(programsRoot, MENU_DIRECTORY)
  const managedPaths = [
    ...(['player', 'combined'] as const).flatMap(role => {
      const identity = getWindowsFunctionIdentity(role)
      return [path.join(menuDirectory, `${identity.displayName}.lnk`), path.join(desktopRoot, `${identity.displayName}.lnk`)]
    }),
    path.join(desktopRoot, GENERIC_SHORTCUT),
    path.join(menuDirectory, GENERIC_SHORTCUT),
    path.join(programsRoot, GENERIC_SHORTCUT)
  ]
  let removed = 0
  for (const filePath of managedPaths) {
    const actual = readShortcutIfPresent(filePath, options.shell)
    if (!actual || !shortcutMatchesTarget(actual, options.executablePath)) continue
    const baseName = path.basename(filePath)
    const role = (['player', 'combined'] as const).find(candidate =>
      `${getWindowsFunctionIdentity(candidate).displayName}.lnk` === baseName)
    if (role) {
      const identity = getWindowsFunctionIdentity(role)
      const expectedIcon = path.join(options.resourcesDirectory, 'identity', identity.icoIconFile)
      if (actual.appUserModelId !== identity.appUserModelId || actual.iconIndex !== 0 ||
          typeof actual.icon !== 'string' || !equalPath(actual.icon, expectedIcon) ||
          actual.description !== identity.displayName) continue
    } else {
      if (!(actual.appUserModelId === '' || actual.appUserModelId === undefined || actual.appUserModelId === 'com.karaoke.queue') ||
          typeof actual.icon !== 'string' || !equalPath(actual.icon, options.executablePath) || actual.iconIndex !== 0) continue
    }
    fs.unlinkSync(filePath)
    removed++
  }
  try { fs.rmdirSync(menuDirectory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
  }
  return removed
}
