'use strict'
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

// Wait on process handles, not a delay/retry of filesystem deletion. Never kill
// a process and never operate on another installation's executable directory.
function waitForFixtureProcesses(directory, timeoutMs = 30000) {
  if (process.platform !== 'win32' || !path.isAbsolute(directory)) throw new Error('A Windows fixture directory is required')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid process-exit deadline')
  // Hosted runners may expose TEMP using an 8.3 path while CIM reports the
  // long executable path. Compare against the actual directory identity.
  const canonicalDirectory = fs.existsSync(directory) ? fs.realpathSync.native(directory) : directory
  const script = `
$ErrorActionPreference='Stop'
$prefix=[IO.Path]::GetFullPath($env:KQ_WAIT_FIXTURE).TrimEnd('\\')+'\\'
function Find-FixtureProcesses {
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
  })
}
foreach($item in (Find-FixtureProcesses)) {
  $process=$null
  try { $process=Get-Process -Id $item.ProcessId -ErrorAction Stop; $null=$process.Handle }
  catch { if (-not (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue)) { continue }; throw }
  try {
    if (-not $process.WaitForExit([int]$env:KQ_WAIT_DEADLINE)) { throw ('Fixture process still alive: '+$item.ProcessId) }
  } finally { $process.Dispose() }
}
if ((Find-FixtureProcesses).Count) { throw 'Fixture processes remain; deletion refused' }
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', shell: false,
    env: { ...process.env, KQ_WAIT_FIXTURE: canonicalDirectory, KQ_WAIT_DEADLINE: String(timeoutMs) }
  })
  if (result.error || result.status !== 0) throw new Error(`Fixture exit not confirmed; files preserved: ${result.error?.message || result.stderr || result.stdout}`)
}
module.exports = { waitForFixtureProcesses }
