'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { _electron: electron } = require('playwright')
const { waitForFixtureProcesses } = require('../scripts/windows-fixture-processes.cjs')

async function run() {
  assert.equal(process.platform, 'win32')
  const executablePath = path.resolve(process.env.KQ_NSI_SMOKE_EXECUTABLE || '')
  assert.ok(process.env.KQ_NSI_SMOKE_EXECUTABLE)
  const application = await electron.launch({ executablePath, cwd: path.dirname(executablePath), args: [], timeout: 60000 })
  try {
    const page = await application.firstWindow()
    await page.locator('#welcome-mode-page').waitFor({ state: 'visible', timeout: 30000 })
    const result = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      appData: app.getPath('appData'),
      userData: app.getPath('userData')
    }))
    assert.equal(result.packaged, true)
    assert.equal(result.name, require('../package.json').name)
    assert.equal(path.resolve(result.userData).toLowerCase(),
      path.resolve(result.appData, result.name).toLowerCase(),
      'the NSIS fixture must use Electron’s actual default per-account userData path')
    const child = application.process()
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged userData probe did not exit after app.quit.')), 30000)
      child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Packaged probe exited code=${code} signal=${signal}`)) })
    })
    await application.evaluate(({ app }) => app.quit())
    await exited
    process.stdout.write(`KQ_NSI_USERDATA ${JSON.stringify(result)}\n`)
  } finally {
    await application.close()
    waitForFixtureProcesses(path.dirname(executablePath))
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
