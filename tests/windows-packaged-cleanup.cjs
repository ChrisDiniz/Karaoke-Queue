'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { _electron: electron } = require('playwright')
const { waitForFixtureProcesses } = require('../scripts/windows-fixture-processes.cjs')

async function run() {
  assert.equal(process.platform, 'win32')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-packaged-cleanup-'))
  const runtime = path.join(scratch, 'runtime')
  let application, child
  try {
    fs.cpSync(path.dirname(require('electron')), runtime, { recursive: true })
    const executable = path.join(runtime, 'electron.exe')
    const holder = path.join(scratch, 'holder.cjs')
    fs.writeFileSync(holder, "process.stdin.resume(); process.stdout.write('READY'); process.stdin.once('data',()=>process.exit(0))")
    child = spawn(executable, [holder], { cwd: runtime, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] })
    const [ready] = await once(child.stdout, 'data')
    assert.equal(String(ready), 'READY')
    assert.throws(() => waitForFixtureProcesses(runtime, 1), /Fixture exit not confirmed/,
      'a live fixture process must prevent deletion, without being killed')
    assert.equal(child.exitCode, null)
    assert.ok(fs.existsSync(executable))
    const exited = once(child, 'exit'); child.stdin.end('exit'); assert.equal((await exited)[0], 0)
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
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
