'use strict'
// Only disposable hosted NSIS fixtures. No Main, SQLite, UAC or profile startup.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
if (process.argv[2] === '--child') {
  const binding = require(process.env.KQ_TRUST_BINDING)
  console.log('KQ_TRUST ' + JSON.stringify(binding.isExecutableInTrustedLocation()))
} else {
  assert.equal(process.platform,'win32')
  assert.equal(process.env.GITHUB_ACTIONS,'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted')
  const image=process.env.KQ_NSI_SMOKE_EXECUTABLE
  assert.ok(image)
  const root=path.dirname(image)
  assert.match(root,/Karaoke Queue Custom CI-[0-9]+[\\]Karaoke Queue$/)
  assert.ok(fs.existsSync(image))
  const env={...process.env,KQ_TRUST_ROOT:root,KQ_TRUST_BINDING:path.join(root,'resources/native/win32-x64/kq_win32.node'),ELECTRON_RUN_AS_NODE:'1'}
  const ps = (script,extra={}) => {
    const r=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop'; "+script,'utf16le').toString('base64')],{encoding:'utf8',env:{...env,...extra},timeout:30000})
    assert.equal(r.error,undefined,r.error?.message)
    assert.equal(r.status,0,r.stdout+r.stderr)
    return r.stdout.trim()
  }
  const trusted=() => {
    const r=spawnSync(image,[__filename,'--child'],{encoding:'utf8',env,timeout:30000})
    assert.equal(r.error,undefined,r.error?.message); assert.equal(r.status,0,r.stdout+r.stderr)
    const row=r.stdout.split(/\r?\n/).find(x=>x.startsWith('KQ_TRUST '))
    assert.ok(row,'actual packaged Electron must report the production binding decision')
    return JSON.parse(row.slice('KQ_TRUST '.length))
  }
  assert.equal(trusted(),true,'registered protected custom location must be accepted by packaged Electron')
  const sddl=ps('[IO.Directory]::GetAccessControl($env:KQ_TRUST_ROOT).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)')
  try {
    // A this-folder-only grant: the file ACL stays untouched. The ancestor/root
    // trust check itself must reject the executable location.
    ps("$acl=[IO.Directory]::GetAccessControl($env:KQ_TRUST_ROOT); $sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-11'); $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Allow); [void]$acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($env:KQ_TRUST_ROOT,$acl)")
    assert.equal(trusted(),false,'a writable installation root must fail closed')
  } finally {
    ps('$acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetSecurityDescriptorSddlForm($env:KQ_TRUST_SDDL); [IO.Directory]::SetAccessControl($env:KQ_TRUST_ROOT,$acl)',{KQ_TRUST_SDDL:sddl})
  }
  assert.equal(trusted(),true,'exact protected root restored before any Main/helper execution')
  const key='HKLM:\\Software\\7792ee38-9a49-5e2e-a032-ba1be2d8f3a5'
  try {
    ps("Set-ItemProperty -LiteralPath $env:KQ_TRUST_KEY -Name InstallLocation -Value ($env:KQ_TRUST_ROOT+'-not-the-installation')",{KQ_TRUST_KEY:key})
    assert.equal(trusted(),false,'a registry/image mismatch must fail closed')
  } finally {
    ps('Set-ItemProperty -LiteralPath $env:KQ_TRUST_KEY -Name InstallLocation -Value $env:KQ_TRUST_ROOT',{KQ_TRUST_KEY:key})
  }
  assert.equal(trusted(),true)
  console.log('NSIS CUSTOM PATH TRUST PASS packaged N-API / writable-root rejection / HKLM mismatch rejection / protected restoration')
}
