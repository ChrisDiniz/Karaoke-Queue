'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { _electron: electron } = require('playwright')
const { waitForFixtureProcesses } = require('../scripts/windows-fixture-processes.cjs')

async function run() {
  assert.equal(process.platform, 'win32')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-packaged-cleanup-'))
  const runtime = path.join(scratch, 'runtime')
  const control = path.join(os.tmpdir(), 'kq-protected-fixture-' + crypto.randomUUID())
  let application, child
  try {
    const created = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.resolve(__dirname, '../scripts/create-windows-smoke-control.ps1'), '-FixturePath', control, '-Synthetic'],
      { encoding: 'utf8', shell: false })
    assert.equal(created.status, 0, created.error?.message || created.stderr || created.stdout)
    assert.match(created.stdout, /CANONICAL CONTROL FIXTURE PASS/)
    console.log('WINDOWS CANONICAL CONTROL CREATION PASS synthetic owner / native descriptor readback')
    fs.cpSync(path.dirname(require('electron')), runtime, { recursive: true })
    const executable = path.join(runtime, 'electron.exe')
    const copiedAddon = path.join(runtime, 'preflight-fixture.node')
    assert.ok(process.argv[2], 'native fixture addon must be supplied by the official proof')
    fs.copyFileSync(process.argv[2], copiedAddon)
    const loaded = spawnSync(process.execPath, ['-e', "require(process.argv[1]); console.log('CHILD NAPI LOAD PASS')", copiedAddon], { encoding: 'utf8' })
    assert.equal(loaded.error, undefined, loaded.error?.message)
    assert.equal(loaded.status, 0, loaded.stderr)
    assert.match(loaded.stdout, /CHILD NAPI LOAD PASS/)
    fs.rmSync(copiedAddon) // the preflight child has released its mapped DLL
    assert.equal(fs.existsSync(copiedAddon), false)
    const holder = path.join(scratch, 'holder.cjs')
    fs.writeFileSync(holder, "process.stdin.resume(); process.stdout.write('READY'); process.stdin.once('data',()=>process.exit(0))")
    const canonicalRuntime = fs.realpathSync.native(runtime)
    const shortResult = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
Add-Type -TypeDefinition @'
using System.Text;
using System.Runtime.InteropServices;
public static class KqShortPath {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern uint GetShortPathName(string input,StringBuilder output,uint length);
}
'@
$b=New-Object Text.StringBuilder 32768
$n=[KqShortPath]::GetShortPathName($env:KQ_SHORT_FIXTURE,$b,32768)
if($n -eq 0 -or $n -ge 32768){throw 'GetShortPathName failed'}
$b.ToString()
`], { encoding: 'utf8', env: { ...process.env, KQ_SHORT_FIXTURE: canonicalRuntime } })
    assert.equal(shortResult.status, 0, shortResult.stderr)
    const shortRuntime = shortResult.stdout.trim()
    const cases = [[canonicalRuntime, canonicalRuntime], [canonicalRuntime, path.toNamespacedPath(canonicalRuntime)]]
    if (shortRuntime.toLowerCase() !== canonicalRuntime.toLowerCase()) {
      cases.push([shortRuntime, canonicalRuntime], [canonicalRuntime, shortRuntime])
    } else console.log('WINDOWS 8.3 ALIAS NOT RUN: volume returned no distinct short name')
    for (const [imageRoot, queriedRoot] of cases) {
      child = spawn(path.join(imageRoot, 'electron.exe'), [holder], { cwd: imageRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] })
      const [ready] = await once(child.stdout, 'data')
      assert.equal(String(ready), 'READY')
      assert.throws(() => waitForFixtureProcesses(queriedRoot, 1), /Fixture process still alive/,
        `a live fixture must be found across path forms: ${imageRoot} -> ${queriedRoot}`)
      assert.equal(child.exitCode, null)
      assert.ok(fs.existsSync(executable))
      const exited = once(child, 'exit'); child.stdin.end('exit'); assert.equal((await exited)[0], 0)
      console.log('WINDOWS FIXTURE PATH MATCH PASS ' + JSON.stringify({ imageRoot, queriedRoot }))
    }
    const main = path.join(scratch, 'main.cjs')
    fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(path.join(scratch, 'profile'))}); app.whenReady().then(()=>new BrowserWindow().loadURL('about:blank'))`)
    application = await electron.launch({ executablePath: executable, args: [main], cwd: runtime })
    await application.firstWindow()
    const mainProcess = application.process()
    await application.close(); application = undefined
    assert.equal(mainProcess.exitCode, 0)
    waitForFixtureProcesses(runtime)
    function profileHashes() {
      const result = {}
      function visit(directory, prefix = '') {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const full = path.join(directory, entry.name), relative = path.join(prefix, entry.name)
          if (entry.isDirectory()) visit(full, relative)
          else if (entry.isFile()) result[relative] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        }
      }
      visit(path.join(scratch, 'profile'))
      return result
    }
    const beforeAdmin = profileHashes()
    // Electron creates its user-data container before the first JS statement.
    // Prove that baseline explicitly; an empty directory is not a loaded profile.
    const containerEntry = path.join(scratch, 'empty-container.cjs')
    const containerProfile = path.join(scratch, 'empty-container-profile')
    fs.writeFileSync(containerEntry, `const fs=require('node:fs'),{app}=require('electron');const p=${JSON.stringify(containerProfile)};console.log('KQ_EMPTY_CONTAINER '+JSON.stringify({ready:app.isReady(),entries:fs.existsSync(p)?fs.readdirSync(p):[]}));app.exit(0)`)
    const container = spawnSync(executable, [containerEntry, '--user-data-dir='+containerProfile], { encoding: 'utf8', timeout: 30000 })
    assert.equal(container.status, 0, container.stderr)
    waitForFixtureProcesses(runtime)
    const observation = JSON.parse(container.stdout.split(/\r?\n/).find(line => line.startsWith('KQ_EMPTY_CONTAINER ')).slice(19))
    assert.equal(observation.ready, false)
    assert.deepEqual(observation.entries, [], 'no operational files may exist before Main')
    const absentProfile = path.join(scratch, 'uncreated-profile')
    for (const profile of [path.join(scratch, 'profile'), absentProfile]) {
      const refused = spawnSync(executable, [path.resolve(__dirname, '..'), '--kq-install-admin', 'invalid-operation',
        '--user-data-dir='+profile], { encoding: 'utf8', timeout: 30000 })
      assert.equal(refused.error, undefined, refused.error?.message)
      assert.equal(refused.status, 2)
      assert.match(refused.stderr, /INSTALLATION_ADMIN_ARGUMENTS_INVALID/)
      waitForFixtureProcesses(runtime)
      assert.deepEqual(profileHashes(), beforeAdmin, 'administrative rejection must not initialize or mutate the operational profile')
      assert.deepEqual(fs.existsSync(absentProfile) ? fs.readdirSync(absentProfile) : [], [],
        'administrative rejection must leave the startup container entirely empty')
    }
    const early = path.join(scratch, 'before-ready.cjs'), link = path.join(scratch, 'before-ready.lnk')
    fs.writeFileSync(early, `const {app,shell}=require('electron');const a=require('node:assert/strict');a.equal(app.isReady(),false);a.equal(shell.writeShortcutLink(${JSON.stringify(link)},'create',{target:${JSON.stringify(executable)}}),true);a.equal(require('node:fs').realpathSync.native(shell.readShortcutLink(${JSON.stringify(link)}).target),require('node:fs').realpathSync.native(${JSON.stringify(executable)}));app.exit(0)`)
    for (const profile of [path.join(scratch, 'profile'), absentProfile]) {
      const linked = spawnSync(executable, [early, '--user-data-dir='+profile], { encoding: 'utf8', timeout: 30000 })
      assert.equal(linked.status, 0, linked.stderr)
      waitForFixtureProcesses(runtime)
      assert.deepEqual(profileHashes(), beforeAdmin, 'synchronous pre-ready shell operations must leave operational data untouched')
      assert.deepEqual(fs.existsSync(absentProfile) ? fs.readdirSync(absentProfile) : [], [],
        'pre-ready shell operations must create no Chromium data or subdirectories')
    }
    console.log('WINDOWS ADMIN PROFILE PASS actual Main rejection / pre-ready shell read-write / every profile file preserved')
    fs.writeFileSync(path.join(runtime, 'readonly-fixture'), 'fixture')
    fs.chmodSync(path.join(runtime, 'readonly-fixture'), 0o444)
    fs.rmSync(runtime, { recursive: true, force: true })
    assert.equal(fs.existsSync(runtime), false)
    console.log('WINDOWS PACKAGED CLEANUP PASS live-process refusal / graceful Electron exit / descendants drained / readonly removal')
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.stdin.end('exit'); await exited }
    if (application) await application.close()
    waitForFixtureProcesses(runtime)
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(control, { recursive: true, force: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
