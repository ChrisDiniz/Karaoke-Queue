'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { CampaignError, parseLastAccess } = require('./usb-reconnect-core.cjs')

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop'; " + command, 'utf16le').toString('base64')],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim()
}
const VOLUMES_COMMAND = `
$items=@(); foreach($volume in Get-Volume | Where-Object DriveLetter) {
  $partition=Get-Partition -DriveLetter $volume.DriveLetter -ErrorAction SilentlyContinue;
  if(-not $partition -or @($partition).Count -ne 1){continue}; $disk=Get-Disk -Number $partition.DiskNumber -ErrorAction SilentlyContinue; if(-not $disk){continue};
  $items += [pscustomobject]@{ drive=([string]$volume.DriveLetter)+':'; volume=[string]$volume.UniqueId;
    disk=[string]$disk.UniqueId; serial=[string]$disk.SerialNumber; offset=[string]$partition.Offset;
    online=($disk.IsOffline -eq $false); fileSystem=[string]$volume.FileSystemType; busType=[string]$disk.BusType; readOnly=[bool]$disk.IsReadOnly }
}; $json=ConvertTo-Json -InputObject @($items) -Compress; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`
function createDeviceProvider({ libraryRoot, salt, expected = () => undefined, execute = powershell }) {
  const drive = path.win32.parse(libraryRoot).root.slice(0, 2).toUpperCase()
  if (!/^[A-Z]:$/.test(drive) || libraryRoot.startsWith('\\\\')) throw new CampaignError('ABSOLUTE_LOCAL_VOLUME_PATH_REQUIRED')
  return {
    async validateRoot() {
      try { assertNoReparse(libraryRoot) } catch { throw new CampaignError('LIBRARY_PATH_VALIDATION_FAILED') }
    },
    async policy() {
      try { return parseLastAccess(execute('fsutil.exe behavior query disablelastaccess')) }
      catch { throw new CampaignError('TIMESTAMP_POLICY_UNVERIFIED') }
    },
    async observe() {
      let rows
      try { rows = JSON.parse(Buffer.from(execute(VOLUMES_COMMAND), 'base64').toString('utf8')) }
      catch { throw new CampaignError('WINDOWS_VOLUME_METADATA_UNAVAILABLE') }
      if (!Array.isArray(rows)) throw new CampaignError('WINDOWS_VOLUME_METADATA_UNAVAILABLE')
      const volumes = rows.map(row => {
        const strong = /^\\\\\?\\Volume\{[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}\\?$/i.test(row.volume || '') &&
          typeof row.disk === 'string' && row.disk.trim().length > 0 && /^\d+$/.test(row.offset || '')
        const key = strong ? crypto.createHash('sha256').update(salt + '\0' +
          JSON.stringify([row.volume.toLowerCase(), row.disk.trim(), row.serial?.trim(), row.offset])).digest('hex') : ''
        return { present: true, online: row.online === true, key, drive: String(row.drive).toUpperCase(), readOnly: row.readOnly === true,
          fileSystem: row.fileSystem, busType: row.busType }
      })
      return volumes.find(row => row.key && row.key === expected()?.key) ||
        volumes.find(row => row.drive === drive) || { present: false }
    }
  }
}
function testVolumeCommand(drive) {
  if (!/^[A-Z]:$/.test(drive) || drive === 'D:') throw new CampaignError('TEST_DEVICE_PATH_REQUIRED')
  return VOLUMES_COMMAND.replace('Get-Volume | Where-Object DriveLetter', `Get-Volume -DriveLetter '${drive[0]}' -ErrorAction SilentlyContinue`)
    .replace("drive=([string]$volume.DriveLetter)+':'", "label=[string]$volume.FileSystemLabel; healthy=([string]$volume.HealthStatus -eq 'Healthy' -and [string]$disk.HealthStatus -eq 'Healthy'); drive=([string]$volume.DriveLetter)+':'")
}
function createTestDeviceProvider({ libraryRoot, salt, expected = () => undefined, execute = powershell }) {
  require('./usb-campaign.cjs').assertTestPath(libraryRoot)
  let drive = 'F:'
  let lastRows
  const wrapped = command => {
    if (command !== VOLUMES_COMMAND) return execute(command)
    const raw = execute(testVolumeCommand(drive))
    try { lastRows = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) } catch { lastRows = undefined }
    return raw
  }
  // Identity derivation is shared; queries stay restricted to the explicitly bound drive.
  return { async validateRoot() { assertNoReparse(drive + '\\musicas') },
    async policy() { return parseLastAccess(execute('fsutil.exe behavior query disablelastaccess')) },
    async observe() {
      const base = createDeviceProvider({ libraryRoot: drive + '\\musicas', salt, expected, execute: wrapped })
      const value = await base.observe()
      return value.present ? { ...value, label: lastRows?.[0]?.label, healthy: lastRows?.[0]?.healthy === true } : value
  }, async identifyOtherLetter(nextDrive) {
    if (!/^[A-Z]:$/.test(nextDrive) || ['C:', 'D:'].includes(nextDrive)) throw new CampaignError('TEST_DEVICE_PATH_REQUIRED')
    const rows = JSON.parse(Buffer.from(execute(testVolumeCommand(nextDrive)), 'base64').toString('utf8'))
    const provider = createDeviceProvider({ libraryRoot: nextDrive + '\\musicas', salt, execute: () => Buffer.from(JSON.stringify(rows)).toString('base64') })
    const found = await provider.observe()
    if (!found.present || found.key !== expected()?.key || String(rows[0]?.label).toLowerCase() !== 'testekaraoke' || rows[0]?.healthy !== true) throw new CampaignError('DIFFERENT_VOLUME_RECONNECTED')
    return { key: found.key, drive: nextDrive, labelVerified: true }
  }, bindVerifiedLetter(found) {
    if (!found || found.key !== expected()?.key || !found.labelVerified || !/^[A-Z]:$/.test(found.drive) || ['C:', 'D:'].includes(found.drive)) throw new CampaignError('DIFFERENT_VOLUME_RECONNECTED')
    drive = found.drive
  } }
}

async function profileProcesses(profile, checkout, execute = powershell) {
  const quote = value => value.replaceAll("'", "''")
  const command = `$profile='${quote(profile)}'; $checkout='${quote(checkout)}'; ` +
    `$items=@(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object { ` +
    `($_.CommandLine -and ($_.CommandLine.IndexOf($profile,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine.IndexOf($checkout,[StringComparison]::OrdinalIgnoreCase) -ge 0)) -or ` +
    `($_.ExecutablePath -and $_.ExecutablePath.StartsWith($checkout+[char]92,[StringComparison]::OrdinalIgnoreCase)) }); Write-Output $items.Count`
  let raw
  try { raw = execute(command).trim() } catch { throw new CampaignError('PROCESS_STATE_UNVERIFIED') }
  if (!/^\d+$/.test(raw)) throw new CampaignError('PROCESS_STATE_UNVERIFIED')
  const count = Number(raw)
  if (!Number.isSafeInteger(count) || count < 0) throw new CampaignError('PROCESS_STATE_UNVERIFIED')
  return count
}
function assertNoReparse(directory) {
  const resolved = path.resolve(directory)
  const parsed = path.parse(resolved)
  let current = parsed.root
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.attributes & 0x400)) throw new CampaignError('REPARSE_OR_NON_DIRECTORY_PATH')
  }
}
function assertPrivateTree(directory) {
  assertNoReparse(directory)
  let count = 0
  function visit(current) {
    if (++count > 50000) throw new CampaignError('PROFILE_TREE_LIMIT')
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || (stat.attributes & 0x400)) throw new CampaignError('PROFILE_LINK_FORBIDDEN')
    if (stat.isFile() && stat.nlink !== 1) throw new CampaignError('PROFILE_HARDLINK_FORBIDDEN')
    if (stat.isDirectory()) for (const child of fs.readdirSync(current)) visit(path.join(current, child))
  }
  visit(directory)
}
function assertInternalSession(session, id, base = require('node:os').tmpdir()) {
  if (!/^[a-f0-9-]{36}$/.test(id) || path.resolve(session) !== path.join(path.resolve(base), 'KQ-T3-' + id)) {
    throw new CampaignError('SESSION_SCOPE_INVALID')
  }
  assertNoReparse(session)
  const ownerFile = path.join(session, 'owner.json')
  const stat = fs.lstatSync(ownerFile)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new CampaignError('SESSION_OWNER_INVALID')
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
  if (owner.kind !== 'KQ-T3-ISOLATED' || owner.id !== id) throw new CampaignError('SESSION_OWNER_INVALID')
}
async function cleanupProfile(session, id, processCount, base) {
  assertInternalSession(session, id, base)
  if (await processCount()) throw new CampaignError('PROFILE_STILL_IN_USE')
  const profile = path.join(session, 'profile')
  if (!fs.existsSync(profile)) return
  assertNoReparse(profile)
  fs.rmSync(profile, { recursive: true })
}
module.exports = { testVolumeCommand, createTestDeviceProvider, VOLUMES_COMMAND, createDeviceProvider, profileProcesses, powershell, assertNoReparse, assertPrivateTree, assertInternalSession, cleanupProfile }
