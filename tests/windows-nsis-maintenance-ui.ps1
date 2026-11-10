param([Parameter(Mandatory=$true)][string]$InstallDirectory,
      [Parameter(Mandatory=$true)][string]$ControlDirectory, [switch]$ConfiguredRole, [string]$InstallerPath, [switch]$FreshInstall)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'NSIS GUI proof requires a disposable hosted Windows runner.'
}
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class KqNsisUI {
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr hwnd,string text);
 public delegate bool EnumProc(IntPtr hwnd, IntPtr parameter);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,int message,IntPtr wparam,IntPtr lparam);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,int message,IntPtr wparam,IntPtr lparam);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd,int id);
}
'@
function Find-Control($Process,[string]$Text,[int]$Id=0) {
  $Process.Refresh()
  if ($Process.HasExited -or $Process.MainWindowHandle -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
  $script:matchHandle=[IntPtr]::Zero
  $script:matchText=$Text
  $script:matchId=$Id
  $callback=[KqNsisUI+EnumProc]{param($handle,$unused)
    $value=[Text.StringBuilder]::new(2048)
    [void][KqNsisUI]::GetWindowText($handle,$value,2048)
    if (($script:matchId -gt 0 -and [KqNsisUI]::GetDlgCtrlID($handle) -eq $script:matchId) -or ($script:matchId -eq 0 -and $value.ToString() -ceq $script:matchText)) { $script:matchHandle=$handle; return $false }
    return $true
  }
  [void][KqNsisUI]::EnumChildWindows($Process.MainWindowHandle,$callback,[IntPtr]::Zero)
  return $script:matchHandle
}
function Wait-Control($Process,[string]$Text,[int]$Id=0) {
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  do {
    $handle=Find-Control $Process $Text $Id
    if ($handle -ne [IntPtr]::Zero) { return $handle }
    if ($Process.HasExited) { throw "NSIS exited before control '$Text': $($Process.ExitCode)" }
    Start-Sleep -Milliseconds 50 # observation of GUI readiness, never lock synchronization
  } while([DateTime]::UtcNow -lt $deadline)
  throw "NSIS GUI control was not rendered: $Text"
}
function Close-NSIS($Process) {
  if (-not $Process) { return }
  $Process.Refresh()
  if ($Process.HasExited) { return }
  if ($Process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Cannot safely close NSIS: no GUI handle.' }
  [void][KqNsisUI]::PostMessage($Process.MainWindowHandle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
  if(-not $Process.WaitForExit(20000)){throw 'NSIS did not exit after normal GUI cancellation; fixture preserved.'}
}
function Read-SharedManifest([string]$Path) {
  # Match a normal Windows reader: observing completion must not prevent the
  # production helper's atomic replace by denying FILE_SHARE_DELETE.
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  $reader=[IO.StreamReader]::new($stream)
  try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
}
if ($FreshInstall) {
  if (-not $InstallerPath -or (Test-Path -LiteralPath $InstallDirectory)) { throw 'Fresh GUI install requires a missing isolated target.' }
  $process=$null
  try {
    $process=Start-Process -FilePath ([IO.Path]::GetFullPath($InstallerPath)) -PassThru
    # MUI directory edit, found recursively rather than assuming it is a direct
    # child of the top-level window. This exercises the actual directory picker.
    $edit=Wait-Control $process '' 1019
    if (-not [KqNsisUI]::SetWindowText($edit,$InstallDirectory)) { throw 'Could not set the selected installation directory.' }
    $process.Refresh()
    [void][KqNsisUI]::PostMessage([KqNsisUI]::GetDlgItem($process.MainWindowHandle,1),0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
    $deadline=[DateTime]::UtcNow.AddSeconds(90)
    $finished=$false
    do {
      $process.Refresh()
      if($process.HasExited){throw "Installer exited before its completion page: $($process.ExitCode)"}
      $manifestPath=Join-Path $ControlDirectory 'installation.json'
      if (Test-Path -LiteralPath $manifestPath) {
        try { $state=Read-SharedManifest $manifestPath } catch { $state=$null }
        $next=[KqNsisUI]::GetDlgItem($process.MainWindowHandle,1)
        if ($state -and $state.status -eq 'unconfigured' -and -not $state.pending -and
            (Test-Path -LiteralPath (Join-Path $InstallDirectory 'Karaoke Queue.exe')) -and
            $next -ne [IntPtr]::Zero -and [KqNsisUI]::IsWindowEnabled($next)) { $finished=$true;break }
      }
      Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    if(-not $finished){
      foreach($path in @($InstallDirectory,(Split-Path -Parent $InstallDirectory),$ControlDirectory)) {
        if(Test-Path -LiteralPath $path){Write-Host ("NSIS_GUI_PATH_SECURITY $path "+(Get-Acl -LiteralPath $path).Sddl)}
      }
      throw 'The selected-path GUI install did not reach confirmed completion.'
    }
    [void][KqNsisUI]::PostMessage($next,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
    if(-not $process.WaitForExit(20000) -or $process.ExitCode -ne 0){throw 'The installer did not exit successfully after Finish.'}
    Write-Output 'NSIS DIRECTORY GUI PASS actual MUI picker / custom path / completed installation'
  } finally { Close-NSIS $process }
  return
}
$manifest=Join-Path $ControlDirectory 'installation.json'
$before=[IO.File]::ReadAllText($manifest)
$exe=Join-Path $InstallDirectory 'Karaoke Queue.exe'
$imageHash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
$scratch=Join-Path $env:RUNNER_TEMP ('kq-nsis-ui-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$uninstall=$null; $maintenance=$null
try {
  $copy=Join-Path $scratch 'uninstall.exe'
  Copy-Item -LiteralPath (Join-Path $InstallDirectory 'Uninstall Karaoke Queue.exe') -Destination $copy
  $uninstall=Start-Process -FilePath $copy -ArgumentList @("_?=$InstallDirectory") -PassThru
  $repair=Wait-Control $uninstall 'Reparar / trocar o modo do aplicativo'
  if([KqNsisUI]::SendMessage($repair,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne 1){throw 'Repair must be selected by default.'}
  [void](Wait-Control $uninstall 'Desinstalar o Karaoke Queue')
  if(-not(Test-Path -LiteralPath $exe)){throw 'Opening Control Panel maintenance removed files.'}
  $uninstall.Refresh()
  [void][KqNsisUI]::PostMessage([KqNsisUI]::GetDlgItem($uninstall.MainWindowHandle,1),0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
  $cache=[IO.Path]::GetFullPath((Join-Path $ControlDirectory 'maintenance.exe'))
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  do {
    $matches=@(Get-CimInstance Win32_Process -Filter "Name='maintenance.exe'" | Where-Object { $_.ExecutablePath -ieq $cache })
    if($matches.Count -eq 1){$maintenance=Get-Process -Id $matches[0].ProcessId;break}
    Start-Sleep -Milliseconds 50
  } while([DateTime]::UtcNow -lt $deadline)
  if(-not $maintenance){throw 'Control Panel repair did not launch the protected cached installer.'}
  $repairInstall=Wait-Control $maintenance 'Reparar / reinstalar mantendo o modo atual'
  if($ConfiguredRole) {
    [void](Wait-Control $maintenance 'Trocar para Reprodutor')
    [void](Wait-Control $maintenance 'Trocar para Tudo em um')
  }
  if([KqNsisUI]::SendMessage($repairInstall,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -ne 1){throw 'Reinstall must default to preserving the role.'}
  if([IO.File]::ReadAllText($manifest) -cne $before){throw 'Uncommitted maintenance modified the role/operation generation.'}
  Close-NSIS $maintenance
  if(-not $uninstall.WaitForExit(20000)){throw 'Repair parent did not complete after maintenance cancelled.'}
  if([IO.File]::ReadAllText($manifest) -cne $before -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $imageHash){throw 'GUI repair cancellation altered the installed state.'}
  Write-Output 'NSIS GUI PASS Control Panel repair/remove choices; protected repair launch; default preservation; cancel without mutations'
} finally {
  $cleanupFailure=$null
  foreach($process in @($maintenance,$uninstall)) { try { Close-NSIS $process } catch { $cleanupFailure=$_; Write-Warning $_ } }
  if($cleanupFailure){throw 'NSIS GUI process exit unconfirmed; all fixtures preserved.'}
  Remove-Item -LiteralPath $scratch -Recurse -Force
}
