'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright')
const { waitForFixtureProcesses } = require('../scripts/windows-fixture-processes.cjs')

async function run() {
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.ok(process.env.KQ_NSI_SMOKE_EXECUTABLE)
  const root = path.dirname(process.env.KQ_NSI_SMOKE_EXECUTABLE)
  const executable = path.join(root, 'Karaoke Queue.exe')
  const uninstaller = path.join(root, 'Uninstall Karaoke Queue.exe')
  const manifestPath = path.join(process.env.ProgramData, 'KaraokeQueue', 'installation.json')
  const before = fs.readFileSync(manifestPath)
  assert.equal(JSON.parse(before).installationId, process.env.KQ_NSI_FIXTURE_INSTALLATION_ID)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-nsis-active-'))
  let application
  try {
    application = await electron.launch({ executablePath: executable, cwd: root, args: [] })
    const page = await application.firstWindow()
    await page.locator('#welcome-mode-page').waitFor({ state: 'visible' })
    const copy = path.join(scratch, 'uninstall.exe')
    fs.copyFileSync(uninstaller, copy, fs.constants.COPYFILE_EXCL)
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    assert.equal(hash(copy), hash(uninstaller))
    const result = spawnSync(copy, ['/S', `_?=${root}`], { encoding: 'utf8', timeout: 60000,
      windowsVerbatimArguments: true })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 32, 'uninstall must report runtime busy, not succeed or fail for an unrelated reason')
    assert.deepEqual(fs.readFileSync(manifestPath), before, 'runtime admission failure must not publish a tombstone')
    assert.ok(fs.existsSync(executable), 'busy uninstall never starts application-file removal')
    assert.equal(await application.evaluate(({ app }) => app.isReady()), true, 'Main remains alive; NSIS never kills it')
    console.log('NSIS ACTIVE APP DENIAL PASS exit=32 manifest_unchanged=true main_alive=true')
  } finally {
    if (application) await application.close()
    waitForFixtureProcesses(root)
    fs.rmSync(scratch, { recursive: true })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
