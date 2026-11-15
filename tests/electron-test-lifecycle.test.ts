// @ts-nocheck
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import { closeElectronTestAppNormally, hasElectronTestCleanupFailure, runWithElectronTestCleanup,
  terminateElectronTestHarnessAfterCleanupFailure, withElectronTestDeadline } from './electron-test-lifecycle'

function createManagementApp({ exitCode = undefined } = {}) {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  let childUnrefCalls = 0
  const streams = [0, 0, 0].map(() => ({ unref() { this.calls++ }, calls: 0 }))
  child.unref = () => { childUnrefCalls++ }
  child.stdin = streams[0]
  child.stdout = streams[1]
  child.stderr = streams[2]
  let closeCalls = 0
  let quitCalls = 0
  const dialog = { showMessageBox: async (_window, options) => {
    const response = options.buttons.indexOf('Sair sem encerrar sessão')
    return { response, checkboxChecked: false }
  } }
  const electronApp = { quit() {
    quitCalls++
    return dialog.showMessageBox(null, { buttons: ['Encerrar sessão e sair', 'Sair sem encerrar sessão', 'Cancelar'] })
      .then(() => {
        if (exitCode !== undefined) {
          child.exitCode = exitCode
          queueMicrotask(() => child.emit('exit', exitCode, null))
        }
      })
  } }
  return {
    child,
    process() { return child },
    get childUnrefCalls() { return childUnrefCalls },
    streams,
    get closeCalls() { return closeCalls },
    get quitCalls() { return quitCalls },
    get closeChoice() { return dialog.__kqManagementCloseChoice ?? -1 },
    async firstWindow() { return undefined },
    async evaluate(callback) {
      return callback({ app: electronApp, dialog })
    },
    async close() { closeCalls++ }
  }
}

test('normal Electron test shutdown waits for the process and releases Playwright', async () => {
  const app = createManagementApp({ exitCode: 0 })
  await closeElectronTestAppNormally(app, 'management', 100)
  assert.equal(app.closeCalls, 1)
  assert.equal(app.quitCalls, 1, 'Management exits through the normal app.quit lifecycle')
  assert.equal(app.closeChoice, 1, 'an active test session is preserved through its real close decision')
  assert.equal(app.childUnrefCalls, 0)
})

test('shutdown timeout abandons automation without invoking a second unbounded app.close', async () => {
  const app = createManagementApp()
  await assert.rejects(closeElectronTestAppNormally(app, 'management', 10), /ELECTRON_TEST_NORMAL_EXIT_TIMEOUT/)
  assert.equal(app.closeCalls, 0, 'Playwright close would wait again for the same unresponsive process')
  assert.equal(app.childUnrefCalls, 1, 'the test harness detaches its process wait after timeout')
  assert.deepEqual(app.streams.map(stream => stream.calls), [1, 1, 1])
})

test('stalled Playwright evaluation fails with a bounded diagnostic', async () => {
  await assert.rejects(
    withElectronTestDeadline(new Promise(() => undefined), 'management:snapshot', 5),
    /ELECTRON_TEST_AUTOMATION_TIMEOUT:management:snapshot/
  )
})

test('cleanup failure is reported, preserves the original E2E failure, and marks the harness to terminate', async () => {
  const reports: string[] = []
  const original = new Error('ORIGINAL_ASSERTION_FAILURE')
  await assert.rejects(runWithElectronTestCleanup(
    async () => { throw original },
    async () => { throw new Error('ELECTRON_TEST_NORMAL_EXIT_TIMEOUT') },
    error => reports.push((error as Error).message)
  ), error => error === original && /ORIGINAL_ASSERTION_FAILURE/.test(error.message))
  assert.deepEqual(reports, ['ELECTRON_TEST_NORMAL_EXIT_TIMEOUT'])
  assert.equal(hasElectronTestCleanupFailure(original), true,
    'the outer harness can exit after preserving the primary diagnostic')
})

test('cleanup failure remains a test failure when the E2E body succeeded', async () => {
  const reports: string[] = []
  await assert.rejects(runWithElectronTestCleanup(
    async () => 'PASS',
    async () => { throw new Error('ELECTRON_TEST_NORMAL_EXIT_FAILED:1:none') },
    error => reports.push((error as Error).message)
  ), /ELECTRON_TEST_NORMAL_EXIT_FAILED/)
  assert.deepEqual(reports, ['ELECTRON_TEST_NORMAL_EXIT_FAILED:1:none'])
})

test('cleanup-only failure is marked for a bounded harness exit', async () => {
  const cleanupError = new Error('ELECTRON_TEST_NORMAL_EXIT_FAILED:1:none')
  await assert.rejects(runWithElectronTestCleanup(async () => 'PASS', async () => { throw cleanupError }),
    error => error === cleanupError)
  assert.equal(hasElectronTestCleanupFailure(cleanupError), true)
})

test('failed cleanup exits a child test harness despite a lingering event-loop handle', () => {
  const lifecyclePath = path.join(__dirname, 'electron-test-lifecycle.js')
  const child = spawnSync(process.execPath, ['-e', `
    const { terminateElectronTestHarnessAfterCleanupFailure } = require(${JSON.stringify(lifecyclePath)});
    setInterval(() => {}, 1000);
    const error = new Error('ORIGINAL_ASSERTION_FAILURE');
    Object.defineProperty(error, 'electronTestCleanupFailed', { value: true });
    terminateElectronTestHarnessAfterCleanupFailure(error);
    process.stdout.write('HARNESS_DID_NOT_EXIT');
  `], { encoding: 'utf8', timeout: 2500 })
  assert.equal(child.status, 1, 'cleanup failure ends the harness with a failing result')
  assert.doesNotMatch(child.stdout, /HARNESS_DID_NOT_EXIT/)
})
