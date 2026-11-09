import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUnconfiguredManifest, InstallationControlStore } from '../src/installation-control'
import {
  removeManagedInstallationShortcuts,
  synchronizeBootstrapShortcuts,
  synchronizeInitialFunctionShortcuts,
  type ShortcutShell,
  type WindowsShortcutDetails
} from '../src/installation-shortcuts'
import { getWindowsFunctionIdentity } from '../src/windows-function-identity'

const operationId = 'bf24bd0a-5061-4f27-943f-282bf87e84fd'

function fixture(configureInitialRole = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-shortcuts-'))
  const commonPrograms = path.join(root, 'Common Programs')
  const menuDirectory = path.join(commonPrograms, 'Karaoke Queue')
  const publicDesktop = path.join(root, 'Public Desktop')
  const userDesktop = path.join(root, 'Chris', 'Desktop')
  const installDirectory = path.join(root, 'Program Files', 'Karaoke Queue')
  const resourcesDirectory = path.join(installDirectory, 'resources')
  const executablePath = path.join(installDirectory, 'Karaoke Queue.exe')
  const programData = path.join(root, 'ProgramData', 'KaraokeQueue')
  fs.mkdirSync(commonPrograms, { recursive: true })
  fs.mkdirSync(publicDesktop, { recursive: true })
  fs.mkdirSync(userDesktop, { recursive: true })
  fs.mkdirSync(path.join(resourcesDirectory, 'identity'), { recursive: true })
  fs.mkdirSync(programData, { recursive: true })
  fs.writeFileSync(executablePath, 'synthetic executable')
  for (const role of ['player', 'combined'] as const) {
    fs.writeFileSync(path.join(resourcesDirectory, 'identity', getWindowsFunctionIdentity(role).icoIconFile), 'synthetic icon')
  }
  const store = new InstallationControlStore(programData)
  store.initialize(createUnconfiguredManifest())
  if (configureInitialRole) store.beginInitialRole(operationId, 0, 'combined')

  const shell = new FakeShortcutShell()
  const native = {
    isProcessElevated: () => true,
    isExecutableInProgramFiles: () => true,
    verifyInstallationDirectory: () => ({ ok: true, code: 0 }),
    verifyInstallationManifest: () => ({ ok: true, code: 0 }),
    getCommonProgramsDirectory: () => commonPrograms,
    getPublicDesktopDirectory: () => publicDesktop
  }
  const sync = (role: 'player' | 'combined' = 'combined') => synchronizeInitialFunctionShortcuts({
    platform: 'win32', operationId, role, executablePath, resourcesDirectory,
    native, store, shell
  })
  return {
    root, commonPrograms, menuDirectory, publicDesktop, userDesktop, installDirectory,
    resourcesDirectory, executablePath, store, shell, native, sync,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  }
}

class FakeShortcutShell implements ShortcutShell {
  failWriteNumber: number | undefined
  writeCount = 0
  writeShortcutLink(shortcutPath: string, _operation: 'create', details: WindowsShortcutDetails): boolean {
    this.writeCount++
    if (this.writeCount === this.failWriteNumber) return false
    fs.writeFileSync(shortcutPath, JSON.stringify(details), 'utf8')
    return true
  }
  readShortcutLink(shortcutPath: string): WindowsShortcutDetails {
    return JSON.parse(fs.readFileSync(shortcutPath, 'utf8')) as WindowsShortcutDetails
  }
}

function createShortcut(shell: FakeShortcutShell, filePath: string, details: WindowsShortcutDetails): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  assert.equal(shell.writeShortcutLink(filePath, 'create', details), true)
}

function roleDetails(role: 'player' | 'combined', executablePath: string, iconPath: string): WindowsShortcutDetails {
  const identity = getWindowsFunctionIdentity(role)
  return {
    target: executablePath, cwd: path.dirname(executablePath), args: '', description: identity.displayName,
    icon: iconPath, iconIndex: 0, appUserModelId: identity.appUserModelId
  }
}

test('synchronization creates verified common links, removes only owned legacy links, and leaves per-user links alone', () => {
  const f = fixture()
  try {
    fs.mkdirSync(f.menuDirectory)
    const generic = { target: f.executablePath, cwd: f.installDirectory, args: '', description: 'Karaoke Queue',
      icon: f.executablePath, iconIndex: 0, appUserModelId: 'com.karaoke.queue' }
    createShortcut(f.shell, path.join(f.publicDesktop, 'Karaoke Queue.lnk'), generic)
    createShortcut(f.shell, path.join(f.menuDirectory, 'Karaoke Queue.lnk'), generic)
    const oldIdentity = getWindowsFunctionIdentity('player')
    const oldRole = roleDetails('player', f.executablePath, path.join(f.resourcesDirectory, 'identity', oldIdentity.icoIconFile))
    createShortcut(f.shell, path.join(f.publicDesktop, `${oldIdentity.displayName}.lnk`), oldRole)
    createShortcut(f.shell, path.join(f.menuDirectory, `${oldIdentity.displayName}.lnk`), oldRole)
    const personalPath = path.join(f.userDesktop, 'Karaoke Queue — Reprodutor.lnk')
    createShortcut(f.shell, personalPath, oldRole)

    f.sync('combined')

    const combined = getWindowsFunctionIdentity('combined')
    for (const directory of [f.menuDirectory, f.publicDesktop]) {
      const link = f.shell.readShortcutLink(path.join(directory, `${combined.displayName}.lnk`))
      assert.equal(link.target, f.executablePath)
      assert.equal(link.appUserModelId, combined.appUserModelId)
      assert.equal(fs.existsSync(path.join(directory, `${oldIdentity.displayName}.lnk`)), false)
      assert.equal(fs.existsSync(path.join(directory, 'Karaoke Queue.lnk')), false)
    }
    assert.equal(fs.existsSync(personalPath), true, 'the current account Desktop is outside the managed common scope')
    assert.equal(f.store.read()?.status, 'pending', 'shortcut sync itself cannot publish a role decision')
  } finally { f.cleanup() }
})

test('a partial write leaves the installation pending and retrying the same operation converges', () => {
  const f = fixture()
  try {
    fs.mkdirSync(f.menuDirectory)
    const generic = { target: f.executablePath, cwd: f.installDirectory, args: '', description: 'Karaoke Queue',
      icon: f.executablePath, iconIndex: 0, appUserModelId: 'com.karaoke.queue' }
    createShortcut(f.shell, path.join(f.publicDesktop, 'Karaoke Queue.lnk'), generic)
    f.shell.writeCount = 0
    f.shell.failWriteNumber = 2
    assert.throws(() => f.sync('combined'), /SHORTCUT_WRITE_FAILED/)
    assert.equal(f.store.read()?.status, 'pending')
    assert.equal(fs.existsSync(path.join(f.publicDesktop, 'Karaoke Queue.lnk')), true,
      'old links are not removed until both new links have been written and verified')
    f.shell.failWriteNumber = undefined
    f.shell.writeCount = 0
    f.sync('combined')
    assert.equal(fs.existsSync(path.join(f.publicDesktop, 'Karaoke Queue.lnk')), false)
    assert.equal(fs.existsSync(path.join(f.publicDesktop, 'Karaoke Queue — Tudo em um.lnk')), true)
  } finally { f.cleanup() }
})

test('an unrelated shortcut occupying a managed name blocks without overwrite or deletion', () => {
  const f = fixture()
  try {
    fs.mkdirSync(f.menuDirectory)
    const identity = getWindowsFunctionIdentity('combined')
    const pathCollision = path.join(f.publicDesktop, `${identity.displayName}.lnk`)
    const unrelated = { target: path.join(f.root, 'other.exe'), cwd: f.root, args: '--custom',
      description: 'User shortcut', icon: path.join(f.root, 'user.ico'), iconIndex: 0, appUserModelId: 'user.app' }
    createShortcut(f.shell, pathCollision, unrelated)
    assert.throws(() => f.sync('combined'), /SHORTCUT_CONFLICT/)
    assert.deepEqual(f.shell.readShortcutLink(pathCollision), unrelated)
    assert.equal(f.store.read()?.status, 'pending')
  } finally { f.cleanup() }
})

test('normal user, development, wrong generation, and non-Windows callers cannot manage shared links', () => {
  const f = fixture()
  try {
    assert.throws(() => synchronizeInitialFunctionShortcuts({
      platform: 'linux', operationId, role: 'combined', executablePath: f.executablePath,
      resourcesDirectory: f.resourcesDirectory, native: {} as never, store: f.store, shell: f.shell
    }), /SHORTCUT_CONTEXT_INVALID/)
    const nonElevated = {
      isProcessElevated: () => false,
      isExecutableInProgramFiles: () => true,
      verifyInstallationDirectory: () => ({ ok: true, code: 0 }),
      verifyInstallationManifest: () => ({ ok: true, code: 0 }),
      getCommonProgramsDirectory: () => f.commonPrograms,
      getPublicDesktopDirectory: () => f.publicDesktop
    }
    assert.throws(() => synchronizeInitialFunctionShortcuts({
      platform: 'win32', operationId, role: 'combined', executablePath: f.executablePath,
      resourcesDirectory: f.resourcesDirectory, native: nonElevated, store: f.store, shell: f.shell
    }), /SHORTCUT_CONTEXT_UNTRUSTED/)
  } finally { f.cleanup() }
})

test('uninstall removes verified common shortcuts and preserves a link at the same name owned by another target', () => {
  const f = fixture()
  try {
    fs.mkdirSync(f.menuDirectory)
    for (const role of ['player', 'combined'] as const) {
      const identity = getWindowsFunctionIdentity(role)
      const icon = path.join(f.resourcesDirectory, 'identity', identity.icoIconFile)
      const details = roleDetails(role, f.executablePath, icon)
      createShortcut(f.shell, path.join(f.menuDirectory, `${identity.displayName}.lnk`), details)
      createShortcut(f.shell, path.join(f.publicDesktop, `${identity.displayName}.lnk`), details)
    }
    const generic: WindowsShortcutDetails = { target: f.executablePath, cwd: f.installDirectory, args: '',
      description: 'Karaoke Queue — configuração inicial', icon: f.executablePath, iconIndex: 0, appUserModelId: 'com.karaoke.queue' }
    createShortcut(f.shell, path.join(f.menuDirectory, 'Karaoke Queue.lnk'), generic)
    createShortcut(f.shell, path.join(f.publicDesktop, 'Karaoke Queue.lnk'), generic)
    createShortcut(f.shell, path.join(f.commonPrograms, 'Karaoke Queue.lnk'), generic)
    const unrelatedPath = path.join(f.publicDesktop, 'Karaoke Queue — Reprodutor.lnk')
    createShortcut(f.shell, unrelatedPath, { ...generic, target: path.join(f.root, 'other.exe'), args: '--keep' })

    const removed = removeManagedInstallationShortcuts({ platform: 'win32', executablePath: f.executablePath,
      resourcesDirectory: f.resourcesDirectory, native: f.native, shell: f.shell })
    assert.equal(removed, 6)
    for (const filePath of [
      path.join(f.menuDirectory, 'Karaoke Queue — Reprodutor.lnk'),
      path.join(f.menuDirectory, 'Karaoke Queue — Tudo em um.lnk'),
      path.join(f.menuDirectory, 'Karaoke Queue.lnk'),
      path.join(f.publicDesktop, 'Karaoke Queue.lnk'),
      path.join(f.commonPrograms, 'Karaoke Queue.lnk')
    ]) assert.equal(fs.existsSync(filePath), false)
    assert.deepEqual(f.shell.readShortcutLink(unrelatedPath), { ...generic, target: path.join(f.root, 'other.exe'), args: '--keep' })
    assert.equal(fs.existsSync(f.menuDirectory), false, 'only the now-empty product menu directory is removed')
    assert.equal(fs.existsSync(f.userDesktop), true, 'per-account shortcuts and profiles are outside common uninstall cleanup')
  } finally { f.cleanup() }
})

test('reinstall restores only generic bootstrap links idempotently while the uninstall tombstone is pending', () => {
  const f = fixture(false)
  const uninstallId = 'b67248f9-cc04-447b-a978-a1b755493d73'
  try {
    f.store.beginInstallationUninstall(uninstallId, 0)
    const options = { platform: 'win32' as const, operationId: uninstallId, executablePath: f.executablePath,
      native: f.native, store: f.store, shell: f.shell }
    f.shell.failWriteNumber = 2
    assert.throws(() => synchronizeBootstrapShortcuts(options), /SHORTCUT_WRITE_FAILED/)
    assert.equal(f.store.read()?.status, 'pending', 'shortcut setup cannot clear the uninstall recovery barrier')
    f.shell.failWriteNumber = undefined
    f.shell.writeCount = 0
    synchronizeBootstrapShortcuts(options)
    synchronizeBootstrapShortcuts(options)
    for (const filePath of [path.join(f.menuDirectory, 'Karaoke Queue.lnk'),
      path.join(f.publicDesktop, 'Karaoke Queue.lnk')]) {
      assert.deepEqual(f.shell.readShortcutLink(filePath), {
        target: f.executablePath, cwd: f.installDirectory, args: '',
        description: 'Karaoke Queue — configuração inicial', icon: f.executablePath,
        iconIndex: 0, appUserModelId: ''
      })
    }
    assert.equal(f.store.read()?.pending?.operationId, uninstallId,
      'only the owning administrator may publish the restored role after shortcut readback')
  } finally { f.cleanup() }
})
