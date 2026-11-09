'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const installerSmokeSource = () => fs.readFileSync(path.join(root, 'tests/windows-nsis-install-smoke.ps1'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('NSIS ownership instrumentation handles LF and CRLF and rejects missing or duplicate targets', () => {
  const { instrumentUninstallRelease } = require('./windows-nsis-coordination-probe.cjs')
  const source = fs.readFileSync(path.join(root, 'build-resources/installer.nsh'), 'utf8')
  for (const newline of ['\n', '\r\n']) {
    const input = source.replace(/\r?\n/g, newline)
    const output = instrumentUninstallRelease(input, 'C:\\fixture\\release.trace')
    assert.equal((output.match(/FileWrite \$9 "release=/g) || []).length, 1)
    const inserted = output.slice(output.indexOf('Function un.KQ_ReleaseUninstallMutexOwnership'))
    assert.ok(inserted.indexOf('GetCurrentThreadId') < inserted.indexOf('ReleaseMutex'))
    assert.match(inserted, /FileWrite \$9 "release=\$8\$\\r\$\\n"/)
    assert.match(inserted, /ReleaseMutex\(p \$KQUninstallRuntimeMutexHandle\)/)
    assert.throws(() => instrumentUninstallRelease(output + input, 'trace'), /exactly one/)
  }
  assert.throws(() => instrumentUninstallRelease('Function un.other\nFunctionEnd', 'trace'), /exactly one/)
})

test('package metadata and Windows target describe the x64 NSIS product', () => {
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.equal(pkg.build.appId, 'com.karaoke.queue')
  assert.equal(pkg.build.productName, 'Karaoke Queue')
  assert.equal(pkg.build.win.icon, 'build-resources/karaoke-queue.ico')
  assert.equal(pkg.build.win.forceCodeSigning, false)
  assert.deepEqual(pkg.build.win.target, [{ target: 'nsis', arch: ['x64'] }])
  assert.equal(pkg.build.asar, true)
  assert.equal(pkg.build.beforePack, './scripts/build-windows-installation-binding.cjs')
  assert.equal(pkg.build.nsis.perMachine, true, 'production NSIS is fixed to an elevated machine-wide install')
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, false,
    'the native binding trusts only the protected Program Files installation')
  assert.equal(pkg.build.nsis.include, 'installer.nsh')
  assert.equal(pkg.build.nsis.createDesktopShortcut, false,
    'electron-builder must not recreate generic desktop shortcuts on updates')
  assert.equal(pkg.build.nsis.createStartMenuShortcut, false,
    'electron-builder must not recreate generic Start Menu shortcuts on updates')
  const installerInclude = fs.readFileSync(path.join(root, 'build-resources/installer.nsh'), 'utf8')
  const operationGate = fs.readFileSync(path.join(root, 'build-resources/installation-operation.nsh'), 'utf8')
  assert.match(operationGate, /CreateJobObjectW[\s\S]*IsProcessInJob[\s\S]*AssignProcessToJobObject/)
  assert.doesNotMatch(operationGate, /TerminateJobObject|KILL_ON_JOB_CLOSE|BREAKAWAY_OK/)
  assert.match(installerInclude, /customUnInit[\s\S]*isUpdated[\s\S]*KQOperationDelegated != \"1\"/)
  assert.match(installerInclude, /!include LogicLib\.nsh/)
  assert.match(installerInclude, /!include TextFunc\.nsh/)
  assert.match(installerInclude, /\$\{TrimNewLines\} \"\$1\" \$1/,
    'NSIS TrimNewLines receives the line contents first and its output variable second')
  assert.match(installerInclude, /!ifndef BUILD_UNINSTALLER/)
  assert.match(installerInclude, /!macro customInit/)
  assert.match(installerInclude, /!macro customWelcomePage/)
  const appRunningMacro = installerInclude.match(/!macro customCheckAppRunning[\s\S]*?!macroend/)?.[0] ?? ''
  assert.doesNotMatch(installerInclude, /nsProcess::FindProcess/,
    'installer must not depend on a process plugin absent from the electron-builder NSIS environment')
  assert.match(appRunningMacro, /Call KQ_PrepareAndLockInstallation/)
  assert.match(appRunningMacro, /!ifndef BUILD_UNINSTALLER[\s\S]*?KQInstallerExistingMachineInstall == "1"[\s\S]*?KQ_PrepareAndLockInstallation/,
    'the normal installer relies on its global lock protocol while the generated uninstaller does not call installer-only functions')
  assert.doesNotMatch(appRunningMacro, /KILL_PROCESS|Stop-Process|taskkill|\/F/,
    'NSIS must require a normal app shutdown and never force-terminate Main')
  assert.match(installerInclude, /Function KQ_CreateMaintenanceMutexHandles[\s\S]*?install-admin\.v1[\s\S]*?runtime\.v1[\s\S]*?FunctionEnd/,
    'NSIS creates the two approved global mutexes')
  assert.match(installerInclude, /Function KQ_TakeMaintenanceMutexes[\s\S]*?WaitForSingleObject\(p \$KQAdminMutexHandle[\s\S]*?WaitForSingleObject\(p \$KQRuntimeMutexHandle[\s\S]*?FunctionEnd/,
    'NSIS acquires the admin mutex before the runtime mutex while replacing files')
  assert.match(installerInclude, /Function KQ_PrepareAndLockInstallation[\s\S]*?prepare-update[\s\S]*?KQ_TakeMaintenanceMutexes/,
    'NSIS persists the maintenance intent before holding both mutexes over file replacement')
  assert.match(installerInclude, /repair-pending/,
    'the newly installed executable reconciles the durable update intent after file replacement')
  assert.match(installerInclude, /\$\{NSD_CreateRadioButton\} 0 30u/)
  assert.match(installerInclude, /\$\{NSD_CreateRadioButton\} 0 56u/)
  assert.doesNotMatch(installerInclude, /NSD_Create(?:First|Additional)RadioButton/)
  assert.match(installerInclude, /Page custom KQ_MaintenancePageCreate KQ_MaintenancePageLeave/)
  assert.match(installerInclude, /KQInstallerExistingMachineInstall != "1"[\s\S]*?Abort/,
    'the function selector must be hidden during a clean first installation')
  assert.match(installerInclude, /Function KQ_MaintenancePageLeave[\s\S]*KQMaintenanceTargetRole/,
    'the native maintenance page records only an allowlisted role selection')
  assert.doesNotMatch(installerInclude.match(/Function KQ_MaintenancePageLeave[\s\S]*?FunctionEnd/)?.[0] ?? '', /ExecWait/,
    'cancelling the installer before commit must not change the installed role')
  assert.match(installerInclude, /!macro customInstall[\s\S]*--kq-install-admin change-role \$\{KQ_FENCE_ARGS\} --role \$KQMaintenanceTargetRole/,
    'NSIS starts the fixed role change only during the committed install section')
  assert.match(installerInclude, /!macro customInstall/)
  assert.match(installerInclude, /!macro customUnInstall[\s\S]*?uninstall-cleanup/)
  const uninstallHook = installerInclude.match(/!macro customUnInstall[\s\S]*?!macroend/)?.[0] ?? ''
  assert.match(uninstallHook, /uninstall-cleanup[\s\S]*?Call un\.KQ_CreateUninstallMutexHandles[\s\S]*?Call un\.KQ_TakeUninstallMutexes/,
    'the helper first persists the barrier, then the NSIS uninstaller owns the mutexes for the remaining section')
  assert.match(installerInclude, /!ifdef BUILD_UNINSTALLER[\s\S]*?Var KQUninstallAdminMutexHandle[\s\S]*?!macro customUnInstall[\s\S]*?!macro customUnInstallSection[\s\S]*?!endif/,
    'uninstaller-only variables and hooks are excluded from the installer compilation')
  assert.match(installerInclude, /!macro customUnInstallSection[\s\S]*?SectionIn RO[\s\S]*?Call un\.KQ_CloseUninstallMutexHandles[\s\S]*?SectionEnd/,
    'the last mandatory uninstall section releases on the owner worker thread')
  assert.doesNotMatch(installerInclude, /Function (?:un\.)?onGUIEnd/, 'GUI callbacks never release section-owned mutexes')
  assert.match(installerInclude, /Call un\.KQ_TakeUninstallMutexes\s+Call un\.KQ_AssertControlSecurity\s+Call un\.KQ_AssertRemovalFence/, 'obsolete uninstall is revalidated under both locks')
  assert.match(installerInclude, /Function un\.KQ_CreateUninstallMutexHandles[\s\S]*?install-admin\.v1[\s\S]*?runtime\.v1[\s\S]*?FunctionEnd[\s\S]*?Function un\.KQ_TakeUninstallMutexes[\s\S]*?WaitForSingleObject\(p \$KQUninstallAdminMutexHandle[\s\S]*?WaitForSingleObject\(p \$KQUninstallRuntimeMutexHandle/,
    'NSIS reacquires admin then runtime after the helper exits and before removing files')
  assert.match(installerInclude, /restore-after-uninstall/,
    'a later install can recover the durable uninstall barrier without selecting a role')
  assert.match(installerInclude, /KQManifestReinstall == "1"[\s\S]*?KQ_LockInstallationRecovery/)
  assert.match(installerInclude, /Function KQ_LockInstallationRecovery[\s\S]*?KQ_CreateMaintenanceMutexHandles[\s\S]*?KQ_TakeMaintenanceMutexes/,
    'a reinstall must acquire the same exclusion before replacing files')
  assert.match(installerInclude, /KQManifestUninstallPending == "1"[\s\S]*?KQManifestReinstall "1"/,
    'only a matching reinstall path may resume an uninstall tombstone')
  assert.match(installerInclude, /KQInstallerExistingMachineInstall == "0"/)
  assert.match(installerInclude, /KQBootstrapPending == "1"[\s\S]*repair-pending/)
  const fenceInclude = fs.readFileSync(path.join(root, 'build-resources/installation-fence.nsh'), 'utf8')
  assert.match(fenceInclude, /GetNamedSecurityInfoW[\s\S]*GetSecurityDescriptorOwner[\s\S]*ConvertSidToStringSidW/,
    'binary recovery validates the protected control ACL/owner before trusting a missing-helper snapshot')
  assert.match(installerInclude, /KQManifestPending == "1"[\s\S]*KQ_LockInstallationRecovery/)
  assert.match(installerInclude, /FileWrite \$6 "  \$\\"status/)
  assert.doesNotMatch(installerInclude, /FileWrite \$6 .*unconfigured/,
    'NSIS must never publish an unconfigured bootstrap before extraction and shortcut verification finish')
  assert.match(installerInclude, /--delete-app-data/)
  assert.match(installerSmokeSource(), /windows-nsis-active-app\.cjs/)
  assert.match(installerInclude, /CoCreateGuid/)
  assert.match(installerInclude, /CreateDirectoryW/)
  assert.match(installerInclude, /SHGetKnownFolderPath/)
  assert.doesNotMatch(installerInclude, /\$COMMONAPPDATA/)
  assert.match(installerInclude, /ConvertStringSecurityDescriptorToSecurityDescriptorW/)
  assert.match(installerInclude, /D:P\(A;OICI;0x001f01ff;;;SY\)/)
  assert.match(installerInclude, /ReadRegStr \$0 HKCU/)
  assert.match(installerInclude, /Call KQ_AbortUnsafeInstallationState/)
  assert.deepEqual(pkg.build.win.extraResources, [
    { from: 'build-resources/native/win32-x64', to: 'native/win32-x64', filter: ['kq_win32.node'] },
    {
      from: 'build-resources/identity', to: 'identity',
      filter: ['karaoke-player.png', 'karaoke-player.ico', 'karaoke-combined.png', 'karaoke-combined.ico']
    }
  ])
  assert.ok(pkg.build.files.includes('build/**/*'))
  assert.ok(pkg.build.files.includes('!build/tests/**'))
  assert.ok(pkg.build.files.includes('!build/scripts/**'))
  assert.ok(pkg.build.files.includes('build/**/*'))
  assert.ok(!pkg.build.files.includes('!build/standalone-player-preload.js'))
  assert.ok(pkg.build.files.includes('!build/standalone-player-ui-preload.js'))
  assert.ok(pkg.build.artifactName.includes('${version}'))
  assert.ok(pkg.build.artifactName.includes('${arch}'))
})

test('packaging is local-only and cannot publish from the electron-builder command', () => {
  assert.match(pkg.scripts['build:windows'], /npm run build/)
  assert.match(pkg.scripts.build, /node scripts\/build-windows-package\.cjs/)
  assert.equal(pkg.build.publish, undefined)
})

test('the Windows icon is a multi-size ICO file and the old tag-triggered publisher is removed', () => {
  const icon = fs.readFileSync(path.join(root, pkg.build.win.icon))
  assert.equal(icon.readUInt16LE(0), 0)
  assert.equal(icon.readUInt16LE(2), 1)
  assert.ok(icon.readUInt16LE(4) >= 5)
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/build-windows.yml')), false)
})

test('system-path package and NSIS smokes are guarded to disposable hosted Windows', () => {
  const packagedSmoke = fs.readFileSync(path.join(root, 'tests/packaged-windows-smoke.cjs'), 'utf8')
  const installerSmoke = fs.readFileSync(path.join(root, 'tests/windows-nsis-install-smoke.ps1'), 'utf8')
  const userDataProbe = fs.readFileSync(path.join(root, 'tests/windows-nsis-userdata-path.cjs'), 'utf8')
  assert.match(packagedSmoke, /GITHUB_ACTIONS, 'true'/)
  assert.match(packagedSmoke, /RUNNER_OS, 'Windows'/)
  assert.match(packagedSmoke, /RUNNER_ENVIRONMENT, 'github-hosted'/)
  assert.match(installerSmoke, /RUNNER_ENVIRONMENT -ne 'github-hosted'/)
  assert.match(installerSmoke, /GetFolderPath\(\[Environment\+SpecialFolder\]::ApplicationData\)/,
    'Electron resolves the account known folder instead of an APPDATA override')
  assert.doesNotMatch(installerSmoke, /\$env:APPDATA\s*=/,
    'changing APPDATA does not isolate Electron on Windows')
  assert.match(installerSmoke, /foreach \(\$path in @\([^\n]*\$expectedUserData\)\)[\s\S]*Fixture já existe/,
    'an existing account profile must abort before installation')
  assert.match(installerSmoke, /\$safeToCleanFixtures -and \$profileCleanupAllowed[\s\S]*ReparsePoint[\s\S]*Remove-Item -LiteralPath \$expectedUserData/,
    'cleanup may remove only the newly created and confirmed fixture profile')
  assert.doesNotMatch(installerSmoke.slice(0, installerSmoke.indexOf("$userDataDirectory = [IO.Path]::GetFullPath")), /Join-Path\s+\$userDataDirectory\s/,
    'no path is derived from userData before the packaged Main reports it')
  assert.match(installerSmoke, /Copy-Item -LiteralPath \$SourceUninstaller[\s\S]*Invoke-FixtureProcess \$copy/)
  assert.doesNotMatch(installerSmoke, /Start-Process -FilePath \$uninstaller/)
  assert.match(installerSmoke, /\$process\.WaitForExit\(\)/)
  assert.match(installerSmoke, /installationOperationState\(\)/)
  assert.match(installerSmoke, /if \(Test-Path -LiteralPath \$installDirectory\) \{ throw/)
  assert.match(installerSmoke, /Get-ExpectedUninstallDisplayName[\s\S]*\$package\.build\.productName[\s\S]*\$package\.version/,
    'DisplayName is derived from effective product metadata and the current package version')
  const nodeProbe = installerSmoke.match(/\$nodeScript\s*=\s*@'([\s\S]*?)'@/)?.[1] ?? ''
  assert.match(installerSmoke, /^function Get-ExpectedUninstallDisplayName\s*\{/m,
    'DisplayName resolution must be a PowerShell function in the installer smoke scope')
  assert.doesNotMatch(nodeProbe, /Get-ExpectedUninstallDisplayName|\$template|\[string\]\$package/,
    'PowerShell metadata resolution must not be embedded in the Node N-API probe')
  assert.match(installerSmoke, /UninstallString[\s\S]*StartsWith\(\$uninstallPrefix/,
    'the uninstall registry entry is selected by its exact installed uninstaller path')
  assert.match(installerSmoke, /cleanupErrors[\s\S]*Write-Warning "Cleanup incompleto/,
    'cleanup errors are reported without replacing the original smoke failure')
  assert.match(installerSmoke, /ownsInstallationFixture[\s\S]*installationId -eq \$fixtureInstallationId[\s\S]*fixture Program Files preservada/,
    'Program Files cleanup is limited to the install identified by this run’s protected manifest')
  assert.match(installerSmoke, /GetFullPath\(\(Join-Path \$installDirectory 'Karaoke Queue\.exe'\)\)[\s\S]*-ieq \$expectedExecutable/,
    'shortcut cleanup removes only links to the exact fixture executable')
  assert.match(installerSmoke, /Karaoke Queue\\Karaoke Queue\.lnk/,
    'the bootstrap menu link is checked below the product menu directory')
  assert.match(installerSmoke, /windows-nsis-userdata-path\.cjs/,
    'NSIS smoke asks the actual packaged Main for its Electron userData path')
  assert.match(installerSmoke, /KQ_NSI_USERDATA /)
  assert.match(installerSmoke, /createKaraokeDatabase/)
  assert.match(installerSmoke, /Get-FileHash/)
  assert.match(userDataProbe, /app\.getPath\('userData'\)/)
  assert.match(userDataProbe, /app\.isPackaged/)
  assert.doesNotMatch(installerSmoke, /Join-Path \$env:RUNNER_TEMP.*user-data/,
    'the profile sentinel must not live outside Electron’s actual userData')
  for (const workflowPath of ['.github/workflows/pr-validation.yml', '.github/workflows/release-windows.yml']) {
    const workflow = fs.readFileSync(path.join(root, workflowPath), 'utf8')
    assert.match(workflow, /windows-nsis-install-smoke\.ps1/)
    assert.match(workflow, /packaged-windows-smoke\.cjs/)
  }
})

test('role-specific window and taskbar icons are deterministic, distinct, and reproducible', () => {
  const os = require('node:os')
  const { buildFunctionIcons } = require('./build-function-icons.cjs')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kqueue-function-icons-'))
  try {
    buildFunctionIcons(temporary)
    for (const name of ['karaoke-player', 'karaoke-combined']) {
      const committedPng = fs.readFileSync(path.join(root, `build-resources/identity/${name}.png`))
      const generatedPng = fs.readFileSync(path.join(temporary, `${name}.png`))
      const committedIco = fs.readFileSync(path.join(root, `build-resources/identity/${name}.ico`))
      const generatedIco = fs.readFileSync(path.join(temporary, `${name}.ico`))
      assert.deepEqual(generatedPng, committedPng, `${name} PNG must be generated from the approved icon geometry`)
      assert.deepEqual(generatedIco, committedIco, `${name} ICO must be generated from the approved icon geometry`)
      assert.equal(committedPng.readUInt32BE(16), 256)
      assert.equal(committedPng.readUInt32BE(20), 256)
      assert.equal(committedIco.readUInt16LE(0), 0)
      assert.equal(committedIco.readUInt16LE(2), 1)
      assert.equal(committedIco.readUInt16LE(4), 8)
    }
    assert.notDeepEqual(
      fs.readFileSync(path.join(root, 'build-resources/identity/karaoke-player.ico')),
      fs.readFileSync(path.join(root, 'build-resources/identity/karaoke-combined.ico')),
      'the two roles must remain visibly distinct'
    )
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

test('only PR validation builds artifacts; the manual release is the sole publisher', () => {
  const pr = fs.readFileSync(path.join(root, '.github/workflows/pr-validation.yml'), 'utf8')
  const release = fs.readFileSync(path.join(root, '.github/workflows/release-windows.yml'), 'utf8')
  assert.match(pr, /pull_request:/)
  assert.match(pr, /workflow_dispatch:\s*\{\}/,
    'manual validation dispatch must remain separate from the publisher workflow')
  assert.match(pr, /contents: read/)
  assert.doesNotMatch(pr, /contents: write|gh release create|git push.*tags/)
  assert.match(pr, /actions\/upload-artifact@v4/)
  assert.match(pr, /Karaoke-Queue-PR-/)
  assert.match(pr, /Karaoke-Queue-Validation-/)
  assert.match(pr, /nsisInstallUninstallSmoke = 'PASS'/,
    'the artifact manifest is emitted only after packaged and NSIS install smokes pass')
  assert.match(release, /workflow_dispatch:/)
  assert.doesNotMatch(release, /^\s+(?:push|pull_request|release):/m)
  assert.match(release, /cancel-in-progress: false/)
  assert.match(release, /--prerelease/)
  assert.match(release, /gh release create/)
  assert.match(release, /KQUEUE_DISPATCH_REF: \$\{\{ github\.ref \}\}/)
  assert.match(release, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(release, /ref: \$\{\{ needs\.validate\.outputs\.sha \}\}/)
  assert.match(release, /git tag -a "\$TAG" "\$COMMIT_SHA"/)
  assert.match(release, /--target "\$COMMIT_SHA"/)
  assert.match(release, /needs: \[validate, linux-validation, windows-build\]/)
  assert.match(release, /permissions:\n      contents: write/)
  assert.doesNotMatch(release.slice(0, release.indexOf('jobs:')), /contents: write/)
})
