'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')
const { waitForFixtureProcesses } = require('../scripts/windows-fixture-processes.cjs')
const { createUnconfiguredManifest, InstallationControlStore } = require('../build/src/installation-control.js')

const appPackage = require('../package.json')
const expectedVersion = appPackage.version
const sourceExecutable = path.resolve(process.argv[2] || 'dist/win-unpacked/Karaoke Queue.exe')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-queue-packaged-windows-'))
const userDataDirectory = path.join(tempRoot, 'user-data')
const programFilesDirectory = process.env.ProgramFiles
const programDataRoot = process.env.ProgramData
const fixtureInstallationDirectory = programFilesDirectory
  ? path.join(programFilesDirectory, `Karaoke Queue E1 Smoke-${process.pid}`)
  : undefined
const fixtureControlDirectory = programDataRoot ? path.join(programDataRoot, 'KaraokeQueue') : undefined
let createdInstallationFixture = false
let createdControlFixture = false
let executable = sourceExecutable
let application
let sessionCreated = false
let closeAttempt = 0

function runIcacls(target, args) {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot is unavailable for protected smoke fixtures')
  const icacls = path.join(systemRoot, 'System32', 'icacls.exe')
  const result = spawnSync(icacls, [target, ...args], { encoding: 'utf8', shell: false })
  if (result.error || result.status !== 0) {
    throw new Error(`icacls fixture setup failed: ${result.error?.message || result.stderr || result.stdout || result.status}`)
  }
}

function createProtectedControlFixture() {
  if (!fixtureControlDirectory) throw new Error('ProgramData is unavailable for packaged smoke fixture')
  if (fs.existsSync(fixtureControlDirectory)) throw new Error('KaraokeQueue ProgramData fixture already exists; refusing to reuse it')
  const created = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.resolve(__dirname, '../scripts/create-windows-smoke-control.ps1'), '-FixturePath', fixtureControlDirectory],
    { encoding: 'utf8', shell: false })
  createdControlFixture = fs.existsSync(fixtureControlDirectory)
  assert.equal(created.status, 0, `Canonical fixture creation failed: ${created.error?.message || created.stderr || created.stdout}`)
  const store = new InstallationControlStore(fixtureControlDirectory)
  store.initialize(createUnconfiguredManifest())
  runIcacls(path.join(fixtureControlDirectory, 'installation.json'), ['/setowner', '*S-1-5-32-544'])
  store.beginInitialRole('a10329b8-2c44-4aab-ae67-83ce5dd5b9ab', 0, 'combined')
  store.commitInitialRole('a10329b8-2c44-4aab-ae67-83ce5dd5b9ab')
  runIcacls(path.join(fixtureControlDirectory, 'installation.json'), ['/setowner', '*S-1-5-32-544'])
  // A .node DLL stays mapped for the lifetime of its loading process on
  // Windows. Validate in a child so the parent never locks the fixture image.
  const validation = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict')
    const native = require(process.argv[1])
    for (const [name, result] of Object.entries({ directory: native.verifyInstallationDirectory(), manifest: native.verifyInstallationManifest() })) {
      assert.equal(result.ok, true, 'Production binding rejected '+name+' fixture: Win32 '+result.code)
    }
  `, path.join(fixtureInstallationDirectory, 'resources/native/win32-x64/kq_win32.node')], { stdio: 'inherit', shell: false })
  assert.equal(validation.error, undefined, validation.error?.message)
  assert.equal(validation.status, 0, 'Production binding preflight child must exit successfully')
  console.log('PACKAGED CONTROL PREFLIGHT PASS canonical owner/ACL verified by production binding')
}

function stageUnderProgramFiles() {
  if (!fixtureInstallationDirectory || !fs.existsSync(programFilesDirectory)) throw new Error('Program Files is unavailable for packaged smoke fixture')
  if (fs.existsSync(fixtureInstallationDirectory)) throw new Error('Packaged smoke installation fixture already exists; refusing to reuse it')
  fs.mkdirSync(fixtureInstallationDirectory)
  createdInstallationFixture = true
  fs.cpSync(path.dirname(sourceExecutable), fixtureInstallationDirectory, { recursive: true, errorOnExist: true })
  executable = path.join(fixtureInstallationDirectory, path.basename(sourceExecutable))
}

async function launch() {
  console.log('PACKAGED SMOKE launch')
  application = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDirectory}`],
    cwd: path.dirname(executable),
    timeout: 60000
  })
  const page = await application.firstWindow()
  await page.waitForFunction(() => !!window.__kqueue && !!window.karaokeManagement && !!window.karaokeLicense,
    undefined, { timeout: 30000 })
  const primary = page.locator('#btn-startup-primary')
  if (await primary.isVisible()) await primary.click()
  return page
}

async function close() {
  if (!application) return
  const child = application.process()
  const marker = path.join(tempRoot, `close-prompt-${++closeAttempt}.json`)
  // Explicit native-dialog test port, not a native Windows UI interaction.
  // The production close coordinator still prepares, flushes and closes normally.
  await application.evaluate(({ dialog }, markerPath) => {
    dialog.showMessageBox = async (_window, options) => {
      process.getBuiltinModule('node:fs').writeFileSync(markerPath, JSON.stringify(options))
      if (options.message !== 'Como deseja fechar o aplicativo?' ||
          JSON.stringify(options.buttons) !== JSON.stringify(['Encerrar sessão e sair', 'Sair sem encerrar sessão', 'Cancelar'])) {
        throw new Error('Unexpected native dialog during packaged smoke shutdown')
      }
      return { response: 1, checkboxChecked: false }
    }
  }, marker)
  console.log('PACKAGED SMOKE graceful close; native session prompt uses explicit test port')
  await application.close() // Playwright requests app.quit and waits for Main.
  assert.notEqual(child.exitCode, null, 'Main must actually exit before fixture cleanup')
  assert.equal(child.exitCode, 0, 'Main shutdown must succeed')
  application = undefined
  if (sessionCreated) {
    assert.ok(fs.existsSync(marker), 'normal shutdown must ask how to close the active session')
    const prompt = JSON.parse(fs.readFileSync(marker, 'utf8'))
    assert.equal(prompt.message, 'Como deseja fechar o aplicativo?')
    assert.deepEqual(prompt.buttons, ['Encerrar sessão e sair', 'Sair sem encerrar sessão', 'Cancelar'])
  }
  console.log('PACKAGED SMOKE graceful close confirmed')
  waitForFixtureProcesses(fixtureInstallationDirectory) // also before restart
}

function inspectDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return {
      entries: db.prepare('SELECT id, name, status, session_id FROM entries ORDER BY queue_order').all(),
      state: db.prepare('SELECT current_session_id, queue_order_policy_version FROM app_state WHERE singleton = 1').get()
    }
  } finally { db.close() }
}

async function run() {
  let failure
  let result
  try {
    assert.equal(process.platform, 'win32', 'protected packaged smoke fixture is Windows-only')
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'protected Program Files/ProgramData fixtures are permitted only on GitHub-hosted Windows')
    assert.equal(process.env.RUNNER_OS, 'Windows')
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
    assert.ok(fs.existsSync(sourceExecutable), `packaged executable not found: ${sourceExecutable}`)
    stageUnderProgramFiles()
    createProtectedControlFixture()
    fs.mkdirSync(userDataDirectory, { recursive: true })
    const legacyModePath = path.join(userDataDirectory, 'operating-mode.json')
    const legacyModeBytes = Buffer.from(JSON.stringify({ version: 1, mode: 'player' }))
    fs.writeFileSync(legacyModePath, legacyModeBytes)
    let page = await launch()
    const appInfo = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      executablePath: app.getPath('exe'),
      version: app.getVersion(),
      userData: app.getPath('userData')
    }))
    assert.equal(appInfo.packaged, true)
    assert.equal(appInfo.name, appPackage.name, 'Electron app.getName() uses the technical package name')
    assert.equal(path.basename(appInfo.executablePath), `${appPackage.build.productName}.exe`,
      'the packaged executable keeps the commercial product name')
    assert.equal(appInfo.version, expectedVersion)
    assert.ok(path.resolve(appInfo.userData).startsWith(path.resolve(tempRoot)))
    assert.deepEqual(fs.readFileSync(legacyModePath), legacyModeBytes,
      'the per-account legacy mode file is preserved; the protected global manifest selects Combined')

    const firstTrial = await page.evaluate(() => window.karaokeLicense.getStatus())
    assert.equal(firstTrial.activated, false)
    assert.equal(firstTrial.expired, false)
    assert.ok(firstTrial.remainingMs > 14 * 24 * 60 * 60 * 1000)
    const licensePath = path.join(appInfo.userData, 'license-state.json')
    const firstTrialRecord = JSON.parse(fs.readFileSync(licensePath, 'utf8'))

    await page.locator('#input-table').fill('81')
    await page.locator('#input-name').fill('Packaged Windows smoke')
    await page.locator('#input-song').fill('810081')
    await page.locator('#form-entry button[type=submit]').click()
    await page.waitForFunction(() => window.__kqueue.queueLength() === 1)
    await page.evaluate(() => window.__kqueue.flushState())
    const databasePath = path.join(appInfo.userData, 'karaoke.sqlite')
    const beforeRestart = inspectDatabase(databasePath)
    assert.equal(beforeRestart.entries.filter(row => row.name === 'Packaged Windows smoke' && row.status === 'pending').length, 1)
    assert.ok(beforeRestart.state.current_session_id)
    assert.equal(beforeRestart.state.queue_order_policy_version, 2)

    sessionCreated = true
    await close()
    page = await launch()
    const restored = await page.evaluate(() => window.karaokeManagement.getSnapshot())
    assert.equal(restored.state.queue.filter(entry => entry.name === 'Packaged Windows smoke' && entry.status === 'pending').length, 1)
    assert.deepEqual(inspectDatabase(databasePath), beforeRestart)
    const secondTrial = await page.evaluate(() => window.karaokeLicense.getStatus())
    const secondTrialRecord = JSON.parse(fs.readFileSync(licensePath, 'utf8'))
    assert.equal(secondTrial.activated, false)
    assert.equal(secondTrialRecord.trialStartedAt, firstTrialRecord.trialStartedAt)
    assert.equal(secondTrialRecord.policyVersion, 1)

    console.log('PACKAGED SMOKE restart/SQLite/trial assertions passed')
    result = {
      result: 'PASS', appInfo, firstRunTrial: firstTrial, trialTimestampPersisted: true,
      sqliteIpcWriteRead: true, restartPersistence: true, profilePreserved: true,
      protectedGlobalFunction: 'combined', perAccountLegacyModePreserved: true
    }
  } catch (error) { failure = error }
  const cleanupErrors = []
  let processesExited = false
  try {
    await close()
    if (createdInstallationFixture) waitForFixtureProcesses(fixtureInstallationDirectory)
    processesExited = true
  } catch (error) { cleanupErrors.push(error) }
  if (processesExited) {
    for (const directory of [tempRoot, ...(createdInstallationFixture ? [fixtureInstallationDirectory] : []),
      ...(createdControlFixture ? [fixtureControlDirectory] : [])]) {
      try { fs.rmSync(directory, { recursive: true, force: true }) }
      catch (error) { cleanupErrors.push(error) }
    }
  }
  if (failure || cleanupErrors.length) {
    throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      'Packaged smoke failed; original failure and cleanup errors follow')
  }
  console.log(JSON.stringify(result, null, 2)) // PASS only after cleanup succeeds
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
