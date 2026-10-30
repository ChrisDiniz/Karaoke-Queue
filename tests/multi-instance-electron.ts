// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const electronPath = require('electron')
const configuredTempRoot = process.env.KARAOKE_TEST_TEMP_ROOT
const tempRoot = configuredTempRoot
  ? path.resolve(configuredTempRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-multi-instance-'))
if (configuredTempRoot) {
  if (fs.existsSync(tempRoot)) throw new Error('The requested isolated test root already exists: ' + tempRoot)
  fs.mkdirSync(tempRoot, { recursive: false })
}
process.stdout.write('TEST_PROFILE_RUN ' + path.basename(tempRoot) + '\n')

function makeProfile(name) {
  const root = path.join(tempRoot, name)
  return {
    root,
    userData: path.join(root, 'user-data'),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_DATA_HOME: path.join(root, 'data')
    }
  }
}

function launch(profile) {
  return electron.launch({
    executablePath: electronPath,
    args: [projectRoot, `--user-data-dir=${profile.userData}`],
    env: profile.env,
    timeout: 30000
  })
}

function spawnSecond(profile) {
  return spawn(electronPath, [projectRoot, `--user-data-dir=${profile.userData}`], {
    env: profile.env,
    stdio: 'ignore'
  })
}

async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      reject(new Error(`Second Electron process did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    const onExit = (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once('exit', onExit)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function firstPage(app) {
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.__kqueue)
  return page
}

async function startSession(page) {
  if (await page.locator('#startup-modal').isVisible()) {
    await page.locator('#btn-startup-primary').click()
    await page.locator('#startup-modal').waitFor({ state: 'hidden' })
  }
}

async function addEntry(page, name, table) {
  await page.locator('#input-table').fill(table)
  await page.locator('#input-name').fill(name)
  await page.locator('#input-song').fill(`MULTI-${table}`)
  await page.locator('#form-entry button[type="submit"]').click()
  await page.waitForFunction(() => window.__kqueue.queueLength() > 0)
  await page.evaluate(() => window.__kqueue.flushState())
}

async function databaseAt(app) {
  return path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'karaoke.sqlite')
}

function readOperationalState(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return {
      appState: database.prepare('SELECT * FROM app_state ORDER BY singleton').all(),
      entries: database.prepare('SELECT * FROM entries ORDER BY id').all(),
      sessions: database.prepare('SELECT * FROM sessions ORDER BY session_order').all()
    }
  } finally {
    database.close()
  }
}

async function closeLeavingSessionOpen(app) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  const closed = page.waitForEvent('close', { timeout: 15000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
  await app.close()
}

async function forceClose(app) {
  if (!app) return
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
  await app.close().catch(() => {})
}

async function waitForWindowActivation(app, profile, eventName, scenario) {
  await app.evaluate(({ BrowserWindow }, expectedEvent) => {
    const window = BrowserWindow.getAllWindows()[0]
    globalThis.__multiInstanceFocusEvent = new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 5000)
      window.once('focus', () => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
    globalThis.__multiInstanceActivationEvent = new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 15000)
      window.once(expectedEvent, () => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }, eventName)

  let secondProcess = spawnSecond(profile)
  try {
    const secondExitPromise = waitForExit(secondProcess)
    const activationEventObserved = await app.evaluate(() => globalThis.__multiInstanceActivationEvent)
    const focusEventObserved = await app.evaluate(() => globalThis.__multiInstanceFocusEvent)
    const secondExit = await secondExitPromise
    secondProcess = undefined
    const state = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return {
        minimized: window.isMinimized(),
        visible: window.isVisible(),
        focused: window.isFocused()
      }
    })

    assert.equal(secondExit.code, 0, `${scenario}: duplicate process should exit cleanly`)
    assert.equal(activationEventObserved, true, `${scenario}: owner window should emit ${eventName}`)
    assert.equal(state.visible, true, `${scenario}: owner window should be visible`)
    if (eventName === 'restore') assert.equal(state.minimized, false, `${scenario}: owner window should be restored`)

    process.stdout.write(`WINDOW_ACTIVATION ${JSON.stringify({ scenario, focusEventObserved, ...state })}\n`)
    return state
  } catch (error) {
    if (secondProcess && secondProcess.exitCode === null) secondProcess.kill('SIGTERM')
    throw error
  }
}

async function minimizeWindowForWindowsTest(app) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    globalThis.__multiInstanceMinimizeEvent = new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 10000)
      window.once('minimize', () => {
        clearTimeout(timeout)
        resolve(true)
      })
      window.minimize()
    })
  })
  const minimizeEventObserved = await app.evaluate(() => globalThis.__multiInstanceMinimizeEvent)
  const minimized = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())
  process.stdout.write(`WINDOW_MINIMIZE ${JSON.stringify({ minimizeEventObserved, minimized })}\n`)
  assert.equal(minimizeEventObserved, true, 'Windows owner window should emit the native minimize event')
  assert.equal(minimized, true, 'Windows owner window should be minimized before the second launch')
}

async function verifyHiddenWindowActivation(app, profile) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  await waitForWindowActivation(app, profile, 'show', 'hidden-window show')
}

async function runSameProfileAndRestore() {
  const profile = makeProfile('same-profile')
  let app
  let secondProcess
  try {
    app = await launch(profile)
    const page = await firstPage(app)
    await startSession(page)
    await addEntry(page, 'Perfil compartilhado', '31')
    const databasePath = await databaseAt(app)
    assert.ok(databasePath.startsWith(profile.userData), 'first instance must use the isolated test profile')
    const before = readOperationalState(databasePath)
    assert.equal(before.sessions.length, 1, 'the fixture must have one active session')
    assert.equal(before.entries.length, 1, 'the fixture must have one persisted turn')

    // A: a second native Electron process with the same userData profile must exit
    // without opening or mutating an independent operational state.
    secondProcess = spawnSecond(profile)
    const duplicateExit = await waitForExit(secondProcess)
    secondProcess = undefined
    assert.equal(duplicateExit.code, 0, 'the duplicate instance should shut down cleanly')
    assert.deepEqual(readOperationalState(databasePath), before,
      'the duplicate launch must leave the confirmed database state byte-for-byte equivalent at row level')
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 1,
      'the first instance remains operational after duplicate launch')
    await addEntry(page, 'Continuação do operador', '32')
    assert.equal(readOperationalState(databasePath).entries.length, 2,
      'the first instance must continue accepting persisted operations')

    if (process.platform === 'win32') {
      // Windows must exercise minimize → restore separately from hide → show.
      await minimizeWindowForWindowsTest(app)
      await waitForWindowActivation(app, profile, 'restore', 'minimized-window restore')
    } else {
      process.stdout.write('WINDOW_MINIMIZE NOT RUN: this suite requires native Windows for the minimize/restore assertion.\n')
    }

    await verifyHiddenWindowActivation(app, profile)

    assert.deepEqual(readOperationalState(databasePath).entries.length, 2)
    const beforeRestart = readOperationalState(databasePath)
    await closeLeavingSessionOpen(app)
    app = undefined
    return { profile, beforeRestart }
  } catch (error) {
    if (secondProcess && secondProcess.exitCode === null) secondProcess.kill('SIGTERM')
    await forceClose(app)
    throw error
  } finally {
    if (app) await forceClose(app)
  }
}

async function runRestartRecovery(profile, expectedState) {
  let app
  try {
    app = await launch(profile)
    const page = await firstPage(app)
    const databasePath = await databaseAt(app)
    assert.deepEqual(readOperationalState(databasePath), expectedState,
      'normal shutdown and relaunch must preserve the confirmed database state')
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 2,
      'the active queue must recover after relaunch')
    assert.equal(await page.locator('#startup-modal').isVisible(), true,
      'the operator should be offered the existing active session')
    await page.locator('#btn-startup-primary').click()
    await page.locator('#startup-modal').waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 2)
    return databasePath
  } finally {
    if (app) await forceClose(app)
  }
}

async function runIndependentProfiles() {
  const firstProfile = makeProfile('independent-a')
  const secondProfile = makeProfile('independent-b')
  let firstApp
  let secondApp
  try {
    ;[firstApp, secondApp] = await Promise.all([launch(firstProfile), launch(secondProfile)])
    const firstWindowPage = await firstPage(firstApp)
    const secondWindowPage = await firstPage(secondApp)
    await startSession(firstWindowPage)
    await startSession(secondWindowPage)
    await addEntry(firstWindowPage, 'Somente perfil A', '41')
    await addEntry(secondWindowPage, 'Somente perfil B', '42')

    const firstDatabasePath = await databaseAt(firstApp)
    const secondDatabasePath = await databaseAt(secondApp)
    assert.notEqual(firstDatabasePath, secondDatabasePath, 'independent profiles must resolve to distinct databases')
    assert.ok(firstDatabasePath.startsWith(firstProfile.userData))
    assert.ok(secondDatabasePath.startsWith(secondProfile.userData))
    assert.deepEqual(readOperationalState(firstDatabasePath).entries.map(row => row.name), ['Somente perfil A'])
    assert.deepEqual(readOperationalState(secondDatabasePath).entries.map(row => row.name), ['Somente perfil B'])
    assert.equal(readOperationalState(firstDatabasePath).sessions.length, 1)
    assert.equal(readOperationalState(secondDatabasePath).sessions.length, 1)
  } finally {
    await Promise.all([forceClose(firstApp), forceClose(secondApp)])
  }
}

async function runConcurrentStartup() {
  const profile = makeProfile('concurrent-startup')
  const attempts = await Promise.allSettled([launch(profile), launch(profile)])
  const owners = attempts.filter(result => result.status === 'fulfilled').map(result => result.value)
  try {
    assert.equal(owners.length, 1,
      `simultaneous launches with one profile must yield exactly one Electron owner (fulfilled=${owners.length})`)
    const app = owners[0]
    const page = await firstPage(app)
    await startSession(page)
    await addEntry(page, 'Sessão da inicialização concorrente', '51')
    const databasePath = await databaseAt(app)
    const persisted = readOperationalState(databasePath)
    assert.equal(persisted.sessions.length, 1, 'only the owner initializes one operational session')
    assert.equal(persisted.entries.length, 1, 'only the owner persists one initial presentation')
    assert.equal(await page.evaluate(() => window.__kqueue.queueLength()), 1)
  } finally {
    await Promise.all(owners.map(forceClose))
  }
}

async function run() {
  try {
    const { profile, beforeRestart } = await runSameProfileAndRestore()
    await runRestartRecovery(profile, beforeRestart)
    await runIndependentProfiles()
    await runConcurrentStartup()
    process.stdout.write('Multi-instance Electron E2E passed.\n')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
