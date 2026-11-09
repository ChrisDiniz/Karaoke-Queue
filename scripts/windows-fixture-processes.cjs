'use strict'
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Wait on process handles, not a delay/retry of filesystem deletion. Never kill
// a process and never operate on another installation's executable directory.
function waitForFixtureProcesses(directory, timeoutMs = 30000) {
  if (process.platform !== 'win32' || !path.isAbsolute(directory)) throw new Error('A Windows fixture directory is required')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid process-exit deadline')
  if (!require('node:fs').existsSync(directory)) return
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class KqFixturePath {
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
module.exports = { waitForFixtureProcesses }
