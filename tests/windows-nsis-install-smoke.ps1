param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Este smoke instala somente em um runner Windows hospedado e descartável do GitHub.'
}

$installer = [IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Instalador não encontrado: $installer" }
$programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$accountAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
if ($package.name -notmatch '^[A-Za-z0-9._-]+$') { throw 'O nome técnico do pacote não é um componente seguro de userData.' }
# Electron resolves the Windows known folder, not an APPDATA environment override.
# The hosted runner account is disposable; never adopt an existing profile.
$expectedUserData = Join-Path $accountAppData $package.name
$profileCleanupAllowed = $false
$userDataDirectory = $null
$sqlitePath = $null
$fixtureParent = Join-Path ([IO.Path]::GetPathRoot($programFiles)) ("Karaoke Queue Custom CI-$PID")
$installDirectory = Join-Path $fixtureParent 'Karaoke Queue'
if (Test-Path -LiteralPath $fixtureParent) { throw 'Custom installation fixture already exists; preserved.' }
$controlDirectory = Join-Path $programData 'KaraokeQueue'
$controlManifest = Join-Path $controlDirectory 'installation.json'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)) 'Karaoke Queue.lnk'
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)) 'Karaoke Queue\Karaoke Queue.lnk'
$installStarted = $false
$fixtureInstallationId = $null
$roleShortcutNames = @()
$fixtureProcesses = [Collections.Generic.List[System.Diagnostics.Process]]::new()

foreach ($path in @($installDirectory, $controlDirectory, $desktopShortcut, $startMenuShortcut, $expectedUserData)) {
  if (Test-Path -LiteralPath $path) { throw "Fixture já existe; instalação não iniciada e conteúdo preservado: $path" }
}

function Get-ExpectedUninstallDisplayName {
  $template = [string]$package.build.nsis.uninstallDisplayName
  if ([string]::IsNullOrWhiteSpace($template)) { $template = '${productName} ${version}' }
  $expected = $template.Replace('${productName}', [string]$package.build.productName)
  $expected = $expected.Replace('${version}', [string]$package.version)
  $expected = $expected.Replace('${arch}', 'x64').Replace('${ext}', 'exe')
  if ($expected -match '\$\{[^}]+\}') { throw "Macro de DisplayName não suportada pelo smoke: $expected" }
  return $expected
}

function Invoke-FixtureProcess([string]$Image, [string[]]$Arguments) {
  $process = Start-Process -FilePath $Image -ArgumentList $Arguments -PassThru
  $fixtureProcesses.Add($process)
  $process.WaitForExit()
  if (-not $process.HasExited -or $process.ExitCode -ne 0) {
    Write-Host "NSIS_FAILURE image=$Image exit=$($process.ExitCode)"
    foreach ($fixturePath in @($installDirectory, $fixtureParent, $controlDirectory, $controlManifest)) {
      if (Test-Path -LiteralPath $fixturePath) {
        $item = Get-Item -LiteralPath $fixturePath -Force
        Write-Host "NSIS_FIXTURE path=$fixturePath attributes=$($item.Attributes)"
        if ($item.PSIsContainer) { Write-Host ("NSIS_PATH_SECURITY " + (Get-Acl -LiteralPath $fixturePath).Sddl) }
      } else { Write-Host "NSIS_FIXTURE absent=$fixturePath" }
    }
    if (Test-Path -LiteralPath $controlDirectory -PathType Container) {
      $aclReadback = @(& "$env:SystemRoot\System32\icacls.exe" $controlDirectory 2>&1)
      Write-Host ("NSIS_FIXTURE_ACL " + ($aclReadback -join " | "))
    }
    throw "Operação NSIS falhou: image=$Image exit=$($process.ExitCode)"
  }
  return $process
}

function Invoke-FixtureUninstall([string]$SourceUninstaller) {
  # _?= intentionally waits for this exact process. Execute from a private
  # temporary copy, so no running image remains in the directory being removed.
  $scratch = Join-Path $env:RUNNER_TEMP ("KQ-NSIS-Uninstall-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $scratch -ErrorAction Stop | Out-Null
  $copy = Join-Path $scratch 'uninstall.exe'
  $process = $null
  try {
    Copy-Item -LiteralPath $SourceUninstaller -Destination $copy -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $SourceUninstaller -Algorithm SHA256).Hash) { throw 'Cópia temporária do uninstaller divergente.' }
    $process = Invoke-FixtureProcess $copy @('/S', "_?=$installDirectory")
    if (-not $process.HasExited -or $process.ExitCode -ne 0) { throw "Uninstall não concluiu com sucesso: exit=$($process.ExitCode)" }
  } finally {
    if (@($fixtureProcesses | Where-Object { -not $_.HasExited }).Count -gt 0) { throw 'Uninstaller ainda ativo; fixture temporária preservada.' }
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction Stop
  }
}

function Assert-ProtectedManifestWithProductBinding {
  if (-not (Test-Path -LiteralPath $controlManifest -PathType Leaf)) { throw 'O instalador não criou o manifesto global.' }
  $manifest = Get-Content -LiteralPath $controlManifest -Raw | ConvertFrom-Json
  if ($manifest.formatVersion -ne 1 -or $manifest.status -ne 'unconfigured' -or $manifest.generation -ne 1 -or
      $null -ne $manifest.role -or $null -ne $manifest.pending -or $manifest.lastCompletedOperation.kind -ne 'prepare-update' -or
      $manifest.identityRevision -ne 0 -or $manifest.installationId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') {
    throw 'O manifesto criado não corresponde ao contrato inicial não configurado.'
  }
  $script:fixtureInstallationId = [string]$manifest.installationId

  $binding = Join-Path $installDirectory 'resources\native\win32-x64\kq_win32.node'
  if (-not (Test-Path -LiteralPath $binding -PathType Leaf)) { throw 'O binding N-API instalado não existe.' }
  $env:KQ_NSI_SMOKE_BINDING = $binding
  $nodeScript = @'
const binding = require(process.env.KQ_NSI_SMOKE_BINDING)
for (const [name, result] of Object.entries({
  installationDirectory: binding.verifyInstallationDirectory(),
  installationManifest: binding.verifyInstallationManifest()
})) {
  console.log(JSON.stringify({ name, ...result }))
  if (!result.ok) process.exitCode = 1
}
'@
  & node.exe -e $nodeScript
  if ($LASTEXITCODE -ne 0) { throw 'O binding de produção rejeitou a ACL/owner da instalação criada pelo NSIS.' }
  Remove-Item Env:\KQ_NSI_SMOKE_BINDING -ErrorAction SilentlyContinue
}

function Assert-ShortcutTarget([string]$LinkPath) {
  if (-not (Test-Path -LiteralPath $LinkPath -PathType Leaf)) { throw "Atalho comum ausente: $LinkPath" }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($LinkPath)
  if ([IO.Path]::GetFullPath($shortcut.TargetPath) -ine [IO.Path]::GetFullPath((Join-Path $installDirectory 'Karaoke Queue.exe'))) {
    throw "O atalho não aponta para o executável instalado: $LinkPath"
  }
}

try {
  $installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  $installStarted = $true
  & (Join-Path $PSScriptRoot 'windows-nsis-maintenance-ui.ps1') -InstallDirectory $installDirectory -ControlDirectory $controlDirectory -InstallerPath $installer -FreshInstall
  if (-not (Test-Path -LiteralPath (Join-Path $installDirectory 'Karaoke Queue.exe') -PathType Leaf)) {
    throw 'NSIS não instalou o executável no local personalizado escolhido.'
  }

  Assert-ProtectedManifestWithProductBinding
  $cache = Join-Path $controlDirectory 'maintenance.exe'
  if (-not (Test-Path -LiteralPath $cache -PathType Leaf)) { throw 'Protected maintenance installer is missing.' }
  $cacheAcl = Get-Acl -LiteralPath $cache
  $privilegedSids = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if ($cacheAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $privilegedSids) { throw 'Maintenance image has an unprivileged owner.' }
  foreach($rule in $cacheAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        ([int64]$rule.FileSystemRights -band 0x500D0156) -ne 0 -and $rule.IdentityReference.Value -notin $privilegedSids) {
      throw 'Maintenance image is writable by an ordinary account.'
    }
  }
  Assert-ShortcutTarget $desktopShortcut
  Assert-ShortcutTarget $startMenuShortcut
  & (Join-Path $PSScriptRoot 'windows-nsis-maintenance-ui.ps1') -InstallDirectory $installDirectory -ControlDirectory $controlDirectory

  $env:KQ_NSI_SMOKE_EXECUTABLE = Join-Path $installDirectory 'Karaoke Queue.exe'
  & node.exe (Join-Path $PSScriptRoot 'windows-nsis-trusted-path.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'O binding não comprovou proteção do local customizado ou sua recuperação.' }
  $probeOutput = @(& node.exe (Join-Path $PSScriptRoot 'windows-nsis-userdata-path.cjs') 2>&1)
  $probeExitCode = $LASTEXITCODE
  if ($probeExitCode -ne 0) { throw "O Main empacotado não confirmou userData: $($probeOutput -join "`n")" }
  $probeLine = $probeOutput | Where-Object { $_ -is [string] -and $_.StartsWith('KQ_NSI_USERDATA ') } | Select-Object -Last 1
  if (-not $probeLine) { throw 'O Main empacotado não informou o caminho real de userData.' }
  $userData = $probeLine.Substring('KQ_NSI_USERDATA '.Length) | ConvertFrom-Json
  if (-not $userData.packaged -or $userData.name -cne $package.name -or
      [IO.Path]::GetFullPath($userData.appData) -ine [IO.Path]::GetFullPath($accountAppData) -or
      [IO.Path]::GetFullPath($userData.userData) -ine [IO.Path]::GetFullPath($expectedUserData)) {
    throw "O caminho real de userData não corresponde ao perfil sintético isolado: $($probeLine.Substring('KQ_NSI_USERDATA '.Length))"
  }
  $env:KQ_NSI_FIXTURE_INSTALLATION_ID = $fixtureInstallationId
  & node.exe (Join-Path $PSScriptRoot 'windows-nsis-active-app.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Uninstall com Main ativo não foi recusado de forma segura.' }
  Remove-Item Env:\KQ_NSI_FIXTURE_INSTALLATION_ID -ErrorAction SilentlyContinue
  $userDataDirectory = [IO.Path]::GetFullPath($userData.userData)
  $profileCleanupAllowed = $true # both real Main probes have closed successfully
  $sqlitePath = Join-Path $userDataDirectory 'karaoke.sqlite'
  $env:KQ_NSI_SMOKE_USERDATA = $userDataDirectory
  $env:KQ_NSI_SMOKE_DB_MODULE = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build\database.js'))
  $prepareUserData = @'
const fs = require('node:fs')
const path = require('node:path')
const { createKaraokeDatabase } = require(process.env.KQ_NSI_SMOKE_DB_MODULE)
const database = createKaraokeDatabase(process.env.KQ_NSI_SMOKE_USERDATA)
database.saveState(database.loadState())
database.close()
fs.writeFileSync(path.join(process.env.KQ_NSI_SMOKE_USERDATA, 'operating-mode.json'), JSON.stringify({version:1,mode:'combined'}))
'@
  & node.exe -e $prepareUserData
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $sqlitePath -PathType Leaf)) {
    throw 'Não foi possível criar a fixture SQLite real no caminho userData reportado pelo Main empacotado.'
  }
  $profileHashes = @{}
  Get-ChildItem -LiteralPath $userDataDirectory -File -Recurse | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($userDataDirectory, $_.FullName)
    $profileHashes[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if (-not $profileHashes.ContainsKey('karaoke.sqlite') -or -not $profileHashes.ContainsKey('operating-mode.json')) {
    throw 'A fixture não contém o SQLite e a configuração esperados no userData real.'
  }
  # Exercise the actual elevated helper on this disposable, already-admin runner.
  # This is NOT an interactive UAC/broker proof, and never runs on the owner's host.
  $beforeConfirmation = Get-Content -LiteralPath $controlManifest -Raw | ConvertFrom-Json
  $initialOperation = [guid]::NewGuid().ToString()
  Invoke-FixtureProcess (Join-Path $installDirectory 'Karaoke Queue.exe') @('--kq-install-admin','confirm-initial',
    '--operation-id',$initialOperation,'--expected-generation',[string]$beforeConfirmation.generation,
    '--role','combined','--installation-id',$fixtureInstallationId) | Out-Null
  $confirmed = Get-Content -LiteralPath $controlManifest -Raw | ConvertFrom-Json
  if ($confirmed.status -ne 'ready' -or $confirmed.role -ne 'combined' -or
      $confirmed.lastCompletedOperation.operationId -ne $initialOperation) { throw 'The actual helper did not confirm the synthetic Combined role.' }
  Invoke-FixtureProcess $installer @('/S', "/D=$installDirectory") | Out-Null
  $repaired = Get-Content -LiteralPath $controlManifest -Raw | ConvertFrom-Json
  if ($repaired.installationId -ne $fixtureInstallationId -or $repaired.role -ne 'combined' -or
      $repaired.status -ne 'ready' -or $repaired.generation -le $confirmed.generation -or $repaired.pending) {
    throw 'Repair/update must preserve the confirmed role and installation identity while completing its new generation.'
  }
  & (Join-Path $PSScriptRoot 'windows-nsis-maintenance-ui.ps1') -InstallDirectory $installDirectory -ControlDirectory $controlDirectory -ConfiguredRole
  foreach ($entry in $profileHashes.GetEnumerator()) {
    if ((Get-FileHash -LiteralPath (Join-Path $userDataDirectory $entry.Key) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) {
      throw "Administrative confirmation/GUI cancellation changed userData: $($entry.Key)"
    }
  }
  $identityModule = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build\src\windows-function-identity.js'))
  $roleShortcutNames = @(& node.exe -e "const i=require(process.argv[1]); console.log(JSON.stringify(['player','combined'].map(m=>i.getWindowsFunctionIdentity(m).displayName+'.lnk')))" $identityModule | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or $roleShortcutNames.Count -ne 2) { throw 'Não foi possível resolver os nomes reais dos atalhos.' }
  $configuredName = $roleShortcutNames[1]
  Assert-ShortcutTarget (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)) $configuredName)
  Assert-ShortcutTarget (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)) ('Karaoke Queue\'+$configuredName))
  $uninstaller = Join-Path $installDirectory 'Uninstall Karaoke Queue.exe'
  $uninstallPrefix = '"' + [IO.Path]::GetFullPath($uninstaller) + '"'
  $expectedDisplayName = Get-ExpectedUninstallDisplayName
  $uninstallEntry = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
    Where-Object { $_.UninstallString -and ([string]$_.UninstallString).StartsWith($uninstallPrefix, [StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
  if (-not $uninstallEntry) { throw 'A entrada de desinstalação por máquina está ausente.' }
  if ([string]$uninstallEntry.DisplayName -cne $expectedDisplayName) {
    throw "DisplayName NSIS divergente dos metadados efetivos do Electron Builder. Esperado='$expectedDisplayName'; recebido='$($uninstallEntry.DisplayName)'."
  }
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'O uninstaller NSIS não existe.' }
  Invoke-FixtureUninstall $uninstaller
  if (Test-Path -LiteralPath $installDirectory) { throw 'O uninstaller deixou arquivos de aplicação no Program Files.' }
  if (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
      Where-Object { $_.UninstallString -and ([string]$_.UninstallString).StartsWith($uninstallPrefix, [StringComparison]::OrdinalIgnoreCase) }) {
    throw 'Uninstall deixou o registro de desinstalação da fixture.'
  }
  if (-not (Test-Path -LiteralPath $controlManifest -PathType Leaf)) {
    throw 'Uninstall removeu o registro global recuperável.'
  }
  $uninstalledManifest = Get-Content -LiteralPath $controlManifest -Raw | ConvertFrom-Json
  if ($uninstalledManifest.installationId -ne $fixtureInstallationId -or $uninstalledManifest.status -ne 'pending' -or
      $uninstalledManifest.pending.kind -ne 'uninstall' -or $uninstalledManifest.role -ne 'combined') {
    throw 'Uninstall não deixou a barreira durável com a função anterior preservada.'
  }
  foreach ($entry in $profileHashes.GetEnumerator()) {
    $profileFile = Join-Path $userDataDirectory $entry.Key
    if (-not (Test-Path -LiteralPath $profileFile -PathType Leaf) -or
        (Get-FileHash -LiteralPath $profileFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) {
      throw "Uninstall alterou ou removeu dados sintéticos do userData: $($entry.Key)"
    }
  }
  $actualProfileFiles = @(Get-ChildItem -LiteralPath $userDataDirectory -File -Recurse | ForEach-Object {
    [IO.Path]::GetRelativePath($userDataDirectory, $_.FullName)
  } | Sort-Object)
  $expectedProfileFiles = @($profileHashes.Keys | Sort-Object)
  if (($actualProfileFiles -join "`n") -ne ($expectedProfileFiles -join "`n")) { throw 'Uninstall criou arquivos inesperados no userData sintético.' }
  if (Test-Path -LiteralPath $desktopShortcut -PathType Leaf) { throw 'Uninstall deixou atalho gerenciado no Desktop público.' }
  if (Test-Path -LiteralPath $startMenuShortcut -PathType Leaf) { throw 'Uninstall deixou atalho gerenciado no Menu Iniciar.' }

  foreach ($name in $roleShortcutNames) {
    foreach ($folder in @([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory),
        (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)) 'Karaoke Queue'))) {
      if (Test-Path -LiteralPath (Join-Path $folder $name)) { throw "Uninstall deixou atalho de função: $name" }
    }
  }
  $reinstall = Invoke-FixtureProcess $installer @('/S', "/D=$installDirectory")
  if ($reinstall.ExitCode -ne 0) { throw "Reinstall após uninstall terminou com exit code $($reinstall.ExitCode)." }
  $reinstalledManifest = Get-Content -LiteralPath $controlManifest -Raw | ConvertFrom-Json
  if ($reinstalledManifest.installationId -ne $fixtureInstallationId -or $reinstalledManifest.status -ne 'unconfigured' -or
      $null -ne $reinstalledManifest.role -or $null -ne $reinstalledManifest.pending -or
      $reinstalledManifest.lastCompletedOperation.kind -ne 'restore-installation') {
    throw 'Reinstall não restaurou de modo idempotente o estado ainda não configurado.'
  }
  Assert-ShortcutTarget $desktopShortcut
  Assert-ShortcutTarget $startMenuShortcut
  foreach ($entry in $profileHashes.GetEnumerator()) {
    if ((Get-FileHash -LiteralPath (Join-Path $userDataDirectory $entry.Key) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) {
      throw "Reinstall changed preserved userData: $($entry.Key)"
    }
  }
  $env:KQ_NSI_FIXTURE_INSTALLATION_ID = $fixtureInstallationId
  & node.exe (Join-Path $PSScriptRoot 'windows-nsis-active-app.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Reinstall não abriu novamente a escolha de modo ou perdeu a exclusão.' }
  Invoke-FixtureUninstall $uninstaller
  if (Test-Path -LiteralPath $installDirectory) { throw 'Segundo uninstall deixou arquivos na instalação.' }
  if ((Test-Path -LiteralPath $desktopShortcut) -or (Test-Path -LiteralPath $startMenuShortcut)) {
    throw 'Uninstall seguido de reinstall deixou atalhos gerenciados residuais.'
  }

  Write-Output "NSIS INSTALL/UNINSTALL PASS installer_sha256=$installerHash manifest_tombstone_recovered=true sqlite_user_data_preserved=true managed_shortcuts_removed=true reinstall_after_uninstall=true userData=$userDataDirectory"
}
finally {
  $cleanupErrors = [Collections.Generic.List[string]]::new()
  $safeToCleanFixtures = @($fixtureProcesses | Where-Object { -not $_.HasExited }).Count -eq 0
  if ($installStarted) {
    try {
      $env:KQ_NSI_CLEANUP_BINDING = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build-resources\native\win32-x64\kq_win32.node'))
      & node.exe -e "const r=require(process.env.KQ_NSI_CLEANUP_BINDING).installationOperationState(); console.log(JSON.stringify(r)); if(r.status!=='absent') process.exitCode=1"
      if ($LASTEXITCODE -ne 0) { $safeToCleanFixtures = $false }
    } catch { $safeToCleanFixtures = $false }
    Remove-Item Env:\KQ_NSI_CLEANUP_BINDING -ErrorAction SilentlyContinue
  }
  if (-not $safeToCleanFixtures) { $cleanupErrors.Add('processo administrativo ainda ativo ou término não comprovado; todas as fixtures foram preservadas') }
  foreach ($variable in @('KQ_NSI_SMOKE_BINDING', 'KQ_NSI_SMOKE_USERDATA', 'KQ_NSI_SMOKE_DB_MODULE',
      'KQ_NSI_SMOKE_EXECUTABLE', 'KQ_NSI_SMOKE_PACKAGE', 'KQ_NSI_FIXTURE_INSTALLATION_ID')) {
    try { Remove-Item -LiteralPath "Env:\$variable" -ErrorAction Stop } catch { }
  }
  try {
    if ($safeToCleanFixtures -and $profileCleanupAllowed -and (Test-Path -LiteralPath $expectedUserData)) {
      $profileItem = Get-Item -LiteralPath $expectedUserData -Force
      if ($profileItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'userData virou reparse point; cleanup recusado.' }
      Remove-Item -LiteralPath $expectedUserData -Recurse -Force -ErrorAction Stop
    }
  } catch { $cleanupErrors.Add("userData sintético da conta hosted: $($_.Exception.Message)") }
  if ($installStarted -and $safeToCleanFixtures) {
    $fixtureLinks = @($desktopShortcut, $startMenuShortcut)
    foreach ($name in $roleShortcutNames) {
      $fixtureLinks += Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)) $name
      $fixtureLinks += Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)) ('Karaoke Queue\'+$name)
    }
    foreach ($linkPath in $fixtureLinks) {
      if (Test-Path -LiteralPath $linkPath -PathType Leaf) {
        try {
          $shell = New-Object -ComObject WScript.Shell
          $target = $shell.CreateShortcut($linkPath).TargetPath
          $expectedExecutable = [IO.Path]::GetFullPath((Join-Path $installDirectory 'Karaoke Queue.exe'))
          if ($target -and [IO.Path]::GetFullPath($target) -ieq $expectedExecutable) {
            Remove-Item -LiteralPath $linkPath -Force
          }
        } catch { $cleanupErrors.Add("atalho ${linkPath}: $($_.Exception.Message)") }
      }
    }
    try {
      $ownsInstallationFixture = $false
      if ($fixtureInstallationId -and (Test-Path -LiteralPath $controlManifest -PathType Leaf)) {
        $cleanupManifest = Get-Content -LiteralPath $controlManifest -Raw | ConvertFrom-Json
        $ownsInstallationFixture = $cleanupManifest.installationId -eq $fixtureInstallationId
      }
      if ($ownsInstallationFixture -and (Test-Path -LiteralPath $installDirectory)) {
        Remove-Item -LiteralPath $installDirectory -Recurse -Force -ErrorAction Stop
      } elseif (Test-Path -LiteralPath $installDirectory) {
        $cleanupErrors.Add('fixture Program Files preservada porque o manifesto não confirmou a installationId deste smoke')
      }
    } catch { $cleanupErrors.Add("fixture Program Files: $($_.Exception.Message)") }
    try {
      if ($fixtureInstallationId -and (Test-Path -LiteralPath $controlManifest -PathType Leaf)) {
        $remainingManifest = Get-Content -LiteralPath $controlManifest -Raw | ConvertFrom-Json
        if ($remainingManifest.installationId -eq $fixtureInstallationId) {
          Remove-Item -LiteralPath $controlDirectory -Recurse -Force -ErrorAction Stop
        }
      }
    } catch { $cleanupErrors.Add("manifesto sintético próprio: $($_.Exception.Message)") }
  }
  if ($safeToCleanFixtures -and (Test-Path -LiteralPath $fixtureParent)) {
    try {
      $parent = Get-Item -LiteralPath $fixtureParent -Force
      if (-not ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
          @(Get-ChildItem -LiteralPath $fixtureParent -Force).Count -eq 0) {
        Remove-Item -LiteralPath $fixtureParent -ErrorAction Stop
      }
    } catch { $cleanupErrors.Add("custom parent fixture: $($_.Exception.Message)") }
  }
  foreach ($cleanupError in $cleanupErrors) { Write-Warning "Cleanup incompleto no runner descartável: $cleanupError" }
}
