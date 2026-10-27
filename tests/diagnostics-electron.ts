// @ts-nocheck
export {}

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-diagnostics-'))
const userDataDir = path.join(profileRoot, 'profile')
const logsDirectory = path.join(userDataDir, 'logs')

async function waitFor(predicate, description, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function run() {
  let app
  const launch = () => electron.launch({
    executablePath: require('electron'),
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(profileRoot, 'config'),
      XDG_CACHE_HOME: path.join(profileRoot, 'cache'),
      XDG_DATA_HOME: path.join(profileRoot, 'data')
    },
    timeout: 30000
  })
  const pageOf = async instance => {
    const page = await instance.firstWindow()
    await page.waitForFunction(() => !!window.__kqueue)
    return page
  }
  const logRecords = () => fs.existsSync(path.join(logsDirectory, 'app.log'))
    ? fs.readFileSync(path.join(logsDirectory, 'app.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  const hasEvent = event => logRecords().some(record => record.event === event)
  const forceExit = async () => {
    if (!app) return
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
    await app.close().catch(() => {})
    app = undefined
  }
  const normalCloseWithoutEndingSession = async () => {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
    const closed = page.waitForEvent('close', { timeout: 8000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
    await app.close().catch(() => {})
    app = undefined
  }

  try {
    app = await launch()
    let page = await pageOf(app)
    if (await page.locator('#startup-modal').isVisible()) await page.locator('#btn-startup-primary').click()
    await waitFor(() => hasEvent('APP_READY'), 'main process ready log')
    assert.ok(fs.existsSync(logsDirectory))
    assert.ok(fs.existsSync(path.join(logsDirectory, 'crashes')))
    assert.equal(await app.evaluate(({ crashReporter }) => crashReporter.getUploadToServer()), false)
    assert.ok(fs.existsSync(path.join(logsDirectory, 'run-state.json')))
    assert.equal(JSON.parse(fs.readFileSync(path.join(logsDirectory, 'run-state.json'), 'utf8')).status, 'running')

    // Keep the headless environment from launching a desktop file manager;
    // verify the IPC invokes Electron's shell with the exact logs directory.
    await app.evaluate(({ shell }) => {
      globalThis.__openedLogsPath = ''
      shell.openPath = async target => { globalThis.__openedLogsPath = target; return '' }
    })
    await page.locator('#nav-settings').click()
    await page.locator('#settings-open-logs').click()
    await waitFor(() => hasEvent('LOG_FOLDER_OPENED') || hasEvent('LOG_FOLDER_OPEN_FAILED'), 'open logs folder result')
    assert.ok(await page.locator('#settings-diagnostics-status').innerText())
    assert.equal(await app.evaluate(() => globalThis.__openedLogsPath), logsDirectory)

    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent('error', {
        message: 'synthetic renderer error token=should-not-appear', error: new Error('synthetic stack')
      }))
      const rejection = new Event('unhandledrejection')
      Object.defineProperty(rejection, 'reason', { value: new Error('synthetic rejected promise') })
      window.dispatchEvent(rejection)
    })
    await page.evaluate(async () => {
      try { await window.karaokeUiScale.setPreference('invalid-scale') } catch {}
      const state = await window.karaokeDatabase.load()
      const duplicate = {
        id: 'diagnostic-duplicate-id', name: 'diagnostic-only', songNumber: '1', songNumber2: '',
        table: '1', insertedAt: Date.now(), status: 'pending', sessionId: state.currentSessionId
      }
      try {
        await window.karaokeDatabase.save({ ...state, queue: [duplicate], history: [{ ...duplicate, status: 'done', doneAt: Date.now() }] })
      } catch {}
      window.karaokeDiagnostics.logSessionEvent('SESSION_RESUMED', state.currentSessionId, 'test')
    })
    await app.evaluate(() => process.emit('unhandledRejection', new Error('synthetic main rejection')))
    await waitFor(() => hasEvent('RENDERER_UNCAUGHT_EXCEPTION')
      && hasEvent('RENDERER_UNHANDLED_REJECTION')
      && hasEvent('RENDERER_IPC_FAILED')
      && hasEvent('SQLITE_SAVE_FAILED')
      && hasEvent('MAIN_UNHANDLED_REJECTION')
      && hasEvent('SESSION_RESUMED'), 'renderer, SQLite and lifecycle diagnostics')
    const rendererError = logRecords().find(record => record.event === 'RENDERER_UNCAUGHT_EXCEPTION')
    assert.ok(rendererError.timestamp && rendererError.runId)
    assert.doesNotMatch(fs.readFileSync(path.join(logsDirectory, 'app.log'), 'utf8'), /should-not-appear/)
    assert.ok(fs.existsSync(path.join(logsDirectory, 'error.log')))

    const firstRunId = JSON.parse(fs.readFileSync(path.join(logsDirectory, 'run-state.json'), 'utf8')).runId
    await forceExit()
    assert.equal(JSON.parse(fs.readFileSync(path.join(logsDirectory, 'run-state.json'), 'utf8')).status, 'running')

    app = await launch()
    page = await pageOf(app)
    await waitFor(() => hasEvent('APP_UNEXPECTED_TERMINATION_DETECTED'), 'previous interrupted run detection')
    assert.ok(logRecords().some(record => record.event === 'APP_UNEXPECTED_TERMINATION_DETECTED'
      && record.details.previousRunId === firstRunId))

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
    await waitFor(() => hasEvent('RENDERER_PROCESS_GONE'), 'renderer process crash event')
    await forceExit()

    app = await launch()
    page = await pageOf(app)
    await waitFor(() => logRecords().filter(record => record.event === 'APP_UNEXPECTED_TERMINATION_DETECTED').length >= 2,
      'renderer-crashed execution detection')
    const userDataPath = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const db = new DatabaseSync(path.join(userDataPath, 'karaoke.sqlite'), { readOnly: true })
    try {
      const activeId = db.prepare('SELECT current_session_id FROM app_state WHERE singleton = 1').get().current_session_id
      assert.equal(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(activeId).ended_at, null,
        'unexpected process exit must not end the session')
    } finally { db.close() }
    await normalCloseWithoutEndingSession()
    const marker = JSON.parse(fs.readFileSync(path.join(logsDirectory, 'run-state.json'), 'utf8'))
    assert.equal(marker.status, 'normal')
    assert.ok(hasEvent('APP_EXIT_NORMAL'))

    app = await launch()
    page = await pageOf(app)
    await waitFor(() => hasEvent('APP_PREVIOUS_RUN_NORMAL'), 'normal previous-run marker')
    await forceExit()
    console.log('PASS: Electron real + SQLite — logs locais, falhas renderer/IPC/SQLite, rotação via unit, minidumps sem upload, deteção de crash e saída normal')
  } finally {
    await forceExit()
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
