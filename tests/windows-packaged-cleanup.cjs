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
