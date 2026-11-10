'use strict'
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const WINDOWS_PATH_HELPER = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class KqFixturePath {
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern System.IntPtr CommandLineToArgvW(string command,out int count);
  [DllImport("kernel32.dll")] static extern System.IntPtr LocalFree(System.IntPtr value);
  public static string[] Arguments(string command) {
    int count; var pointer=CommandLineToArgvW(command,out count);
    if(pointer==System.IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var args=new string[count];
      for(int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*System.IntPtr.Size));
      return args;
    } finally { LocalFree(pointer); }
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetLongPathName(string input, StringBuilder output, uint length);
  public static string Long(string input) {
    var output=new StringBuilder(32768);
    uint length=GetLongPathName(input,output,(uint)output.Capacity);
    if(length==0) throw new Win32Exception(Marshal.GetLastWin32Error());
    if(length>=output.Capacity) throw new InvalidOperationException("Fixture path too long");
    return output.ToString();
  }
}
'@
function Canonical-Path([string]$value) {
  $long=[KqFixturePath]::Long($value)
  if ($long.StartsWith('\\\\?\\UNC\\')) { return '\\\\'+$long.Substring(8) }
  if ($long.StartsWith('\\\\?\\')) { return $long.Substring(4) }
  return $long
}
`

// Wait on process handles, not a delay/retry of filesystem deletion. Never kill
// a process and never operate on another installation's executable directory.
function waitForFixtureProcesses(directory, timeoutMs = 30000) {
  if (process.platform !== 'win32' || !path.isAbsolute(directory)) throw new Error('A Windows fixture directory is required')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid process-exit deadline')
  if (!require('node:fs').existsSync(directory)) return
  const script = `${WINDOWS_PATH_HELPER}
$prefix=(Canonical-Path $env:KQ_WAIT_FIXTURE).TrimEnd('\\')+'\\'
# Query only executable names present in this private runtime. An inaccessible
# candidate is not evidence of absence. Get-Process.Path avoids CIM's optional
# ExecutablePath property (dependent on the WMI provider/token).
$names=@(Get-ChildItem -LiteralPath $env:KQ_WAIT_FIXTURE -Filter '*.exe' -File -Recurse | ForEach-Object { $_.BaseName })
function Find-FixtureProcesses {
  foreach ($candidate in @(Get-Process -ErrorAction Stop | Where-Object { $names -contains $_.ProcessName })) {
    try {
      if ($candidate.HasExited) { continue }
      $image=$candidate.Path
      if (-not $image) { throw ('Cannot inspect candidate process: '+$candidate.Id) }
      try { $canonical=Canonical-Path $image }
      catch { if ($candidate.HasExited) { continue }; throw }
      if ($canonical.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) {
        Write-Output $candidate
        $candidate=$null # ownership transferred to the caller
      }
    } finally { if ($candidate) { $candidate.Dispose() } }
  }
}
foreach($process in @(Find-FixtureProcesses)) {
  try {
    $null=$process.Handle
    if (-not $process.WaitForExit([int]$env:KQ_WAIT_DEADLINE)) { throw ('Fixture process still alive: '+$process.Id) }
  } finally { $process.Dispose() }
}
$remaining=@(Find-FixtureProcesses)
try { if ($remaining.Count) { throw 'Fixture processes remain; deletion refused' } }
finally { foreach($process in $remaining) { $process.Dispose() } }
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', shell: false,
    env: { ...process.env, KQ_WAIT_FIXTURE: directory, KQ_WAIT_DEADLINE: String(timeoutMs) }
  })
  if (result.error || result.status !== 0) throw new Error(`Fixture exit not confirmed; files preserved: ${result.error?.message || result.stderr || result.stdout}`)
}
// Playwright launches cmd.exe on Windows, so its ChildProcess is not the real
// Electron Main. Stop only explicitly owned synthetic profiles, pin validated
// Windows handles, and never reconstruct a taskkill tree from reusable PIDs.
function stopFixtureElectron(profilePath, executablePath, mainPid, timeoutMs = 30000) {
  const fs = require('node:fs')
  if (process.platform !== 'win32' || !path.isAbsolute(profilePath) || !path.isAbsolute(executablePath) ||
      !Number.isInteger(mainPid) || mainPid <= 0 || mainPid === process.pid ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid owned Electron fixture')
  const profile = fs.realpathSync.native(profilePath)
  const temp = fs.realpathSync.native(require('node:os').tmpdir())
  const relative = path.relative(temp,profile)
  if (relative.startsWith('..') || path.isAbsolute(relative) ||
      !/^(?:karaoke-operating-modes-|karaoke-queue-windows-e2e-|kq-packaged-cleanup-)[^\\/]+[\\/]/.test(relative)) {
    throw new Error('Only a private synthetic Electron profile below Windows Temp may be stopped')
  }
  const script = `${WINDOWS_PATH_HELPER}
$expectedImage=Canonical-Path $env:KQ_STOP_IMAGE
$fixtureProfile=Canonical-Path $env:KQ_STOP_PROFILE
function Find-OwnedRows {
  foreach($row in @(Get-CimInstance Win32_Process -Filter ("Name='"+[IO.Path]::GetFileName($expectedImage)+"'") -ErrorAction Stop)) {
    if(-not $row.CommandLine) {
      if($row.ProcessId -eq [int]$env:KQ_STOP_MAIN){throw 'Cannot verify the owned Main command line.'}
      continue
    }
    $userDataArguments=@([KqFixturePath]::Arguments($row.CommandLine) | Where-Object { $_.StartsWith('--user-data-dir=',[StringComparison]::OrdinalIgnoreCase) })
    if($userDataArguments.Count -ne 1){continue}
    $value=$userDataArguments[0].Substring('--user-data-dir='.Length)
    try { $candidateProfile=Canonical-Path $value } catch { continue }
    if($candidateProfile.Equals($fixtureProfile,[StringComparison]::OrdinalIgnoreCase)){Write-Output $row}
  }
}
$handles=New-Object 'Collections.Generic.List[Diagnostics.Process]'
try {
  $rows=@(Find-OwnedRows)
  if(-not @($rows | Where-Object {$_.ProcessId -eq [int]$env:KQ_STOP_MAIN}).Count) {
    $mainProbe=$null
    try { $mainProbe=[Diagnostics.Process]::GetProcessById([int]$env:KQ_STOP_MAIN) }
    catch [ArgumentException] { }
    if($mainProbe){try{if(-not $mainProbe.HasExited){throw 'Requested Main does not belong to the verified fixture profile/image.'}}finally{$mainProbe.Dispose()}}
  }
  foreach($row in $rows) {
    try { $candidate=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId) }
    catch [ArgumentException] { continue }
    $retained=$false
    try {
      $null=$candidate.Handle
      if($candidate.HasExited){continue}
      $actual=$candidate.StartTime.ToUniversalTime().Ticks.ToString()
      $observed=$row.CreationDate.ToUniversalTime().Ticks.ToString()
      if($actual.Substring(0,$actual.Length-1) -cne $observed.Substring(0,$observed.Length-1)){throw 'Process identity changed; stop refused.'}
      if(-not (Canonical-Path $candidate.Path).Equals($expectedImage,[StringComparison]::OrdinalIgnoreCase)){throw 'Executable identity changed; stop refused.'}
      $handles.Add($candidate); $retained=$true
    } finally {if(-not $retained){$candidate.Dispose()}}
  }
  # All candidates are pinned and validated before the first termination. Main
  # first, then any still-live owned helpers; no PID-based tree traversal.
  foreach($candidate in @($handles | Sort-Object @{Expression={if($_.Id -eq [int]$env:KQ_STOP_MAIN){0}else{1}}})) {
    if(-not $candidate.HasExited){try{$candidate.Kill()}catch{if(-not $candidate.HasExited){throw}}}
  }
  foreach($candidate in $handles){if(-not $candidate.WaitForExit([int]$env:KQ_STOP_TIMEOUT)){throw 'Owned fixture process still alive.'}}
  if(@(Find-OwnedRows).Count){throw 'New owned fixture processes remain; profile preserved.'}
  Write-Output ('OWNED ELECTRON STOP PASS main='+$env:KQ_STOP_MAIN+' handles='+$handles.Count)
} finally {foreach($candidate in $handles){$candidate.Dispose()}}
`
  const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
    encoding:'utf8',shell:false,timeout:timeoutMs+10000,env:{...process.env,KQ_STOP_IMAGE:fs.realpathSync.native(executablePath),
      KQ_STOP_PROFILE:profile,KQ_STOP_MAIN:String(mainPid),KQ_STOP_TIMEOUT:String(timeoutMs)}
  })
  if(result.error || result.status !== 0) throw new Error(`Owned Electron exit not confirmed; profiles preserved: ${result.error?.message || result.stderr || result.stdout}`)
  return result.stdout.trim()
}
module.exports = { waitForFixtureProcesses, stopFixtureElectron }
