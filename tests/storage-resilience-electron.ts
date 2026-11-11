// @ts-nocheck
// Main/IPC/Renderer production test, internal fixtures only. No USB/policy query.
export {}
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { ElectronUsbAdapter } = require('../../scripts/usb-reconnect-electron.cjs')
const { createJournal } = require('../../scripts/usb-reconnect-core.cjs')
const session = process.env.KARAOKE_TEST_TEMP_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'kq-storage-session-'))
if (process.env.KARAOKE_TEST_TEMP_ROOT) fs.mkdirSync(session)
const mediaRoot = path.join(session, 'fixture')
const offline = path.join(session, 'offline')
fs.mkdirSync(mediaRoot)
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-storage-evidence-'))
const journal = createJournal(evidence)
const adapter = new ElectronUsbAdapter({ checkout: path.resolve(__dirname, '../..'), session, mediaRoot, journal, synthetic: true })
async function command(type, extra = {}) {
  return adapter.page.evaluate(({ type, extra }) => window.standalonePlayer.execute({
    operationId: crypto.randomUUID(), command: { type, ...extra }
  }), { type, extra })
}
async function snapshot() { return (await adapter.page.evaluate(() => window.standalonePlayer.getSnapshot())).snapshot }
async function run() {
  try {
    journal.event('fixture-scope', { physicalUSB: 'NOT RUN', devicePolicy: 'NOT QUERIED', video: 'generated WebM/VP8' })
    await adapter.start(); await adapter.ready(); await adapter.createSyntheticMedia(16000)
    fs.copyFileSync(path.join(mediaRoot, '00001.webm'), path.join(mediaRoot, '00002.webm'))
    fs.copyFileSync(path.join(mediaRoot, '00001.webm'), path.join(mediaRoot, '00003.webm'))
    await adapter.page.evaluate(() => window.standalonePlayer.refreshVideoLibrary())
    await adapter.ready()
    assert.equal((await command('submit-code', { enteredCode: '1', priority: 'normal' })).outcome, 'confirmed')
    await adapter.until(s => s.playbackStatus === 'playing', 'INITIAL_REAL_PLAYBACK_NOT_CONFIRMED', 30000)
    await adapter.page.waitForFunction(() => document.querySelector('video')?.currentTime >= 0.5)
    assert.equal((await command('submit-code', { enteredCode: '2', priority: 'normal' })).outcome, 'confirmed')
    assert.equal((await command('submit-code', { enteredCode: '3', priority: 'priority' })).outcome, 'confirmed')
    const before = await snapshot()
    assert.deepEqual(before.state.pending.map(e => e.musicCode), ['00003', '00002'])
    fs.renameSync(mediaRoot, offline)
    await adapter.app.evaluate(() => global.__t3.runtime.probeLibraryAvailability())
    const time = await adapter.page.locator('video').evaluate(v => v.currentTime)
    await adapter.page.waitForFunction(time => document.querySelector('video')?.currentTime > time + 0.25, time)
    assert.equal((await snapshot()).state.current.attemptId, before.state.current.attemptId)
    assert.equal((await snapshot()).playbackCondition, 'ready', 'buffered progress survives root loss')
    // Invalidate the media URL in the test to force a fresh Chromium request/error,
    // bypassing its already-decoded buffered resource. The production protocol rejects
    // the query; physical root loss is independently observed. Real EIO is covered in protocol tests.
    // No synthetic playing/EOF/error observation is submitted through IPC.
    await adapter.page.locator('video').evaluate(v => { v.src = v.src + '?storage-fixture-unavailable'; v.load(); void v.play().catch(() => {}) })
    await adapter.until(async () => Boolean((await snapshot()).storageRecovery?.contained), 'STORAGE_FAILURE_NOT_CONTAINED')
    const interrupted = await snapshot()
    assert.equal(interrupted.playbackCondition, 'blocked')
    assert.equal(interrupted.storageRecovery.target.entryId, before.state.current.entryId)
    assert.deepEqual(interrupted.pending, before.state.pending)
    assert.equal(interrupted.storageRecovery.positionRestorable, false)
    await adapter.until(s => s.playbackStatus === 'idle' && s.streams === 0 && s.grants === 0 && s.handles === 0,
      'INTERRUPTION_RESOURCES_NOT_CONTAINED')
    const modal = adapter.page.locator('#storage-recovery-modal')
    assert.equal(await modal.count(), 1)
    await modal.waitFor({ state: 'visible' })
    assert.equal(await adapter.page.locator('#storage-recovery-dismiss').isVisible(), false)
    assert.match(await modal.textContent(), /prioridades foram mantidas/)
    await adapter.page.screenshot({ path: path.join(evidence, 'modal-1280.png') })
    await adapter.page.setViewportSize({ width: 640, height: 480 })
    assert.ok(await modal.locator('.storage-recovery-dialog').evaluate(e => e.getBoundingClientRect().right <= innerWidth))
    await adapter.page.screenshot({ path: path.join(evidence, 'modal-640.png') })
    await adapter.page.setViewportSize({ width: 1280, height: 800 })
    fs.renameSync(offline, mediaRoot)
    await adapter.app.evaluate(() => global.__t3.runtime.probeLibraryAvailability())
    await adapter.until(async () => Boolean((await snapshot()).storageRecovery?.available), 'RECONNECTION_NOT_OBSERVED')
    assert.equal((await snapshot()).playbackCondition, 'blocked', 'return must not autoplay')
    assert.equal((await adapter.resources()).playbackStatus, 'idle')
    await adapter.page.locator('#storage-recovery-retry').focus()
    await adapter.page.keyboard.press('Tab')
    assert.equal(await adapter.page.evaluate(() => document.activeElement.id), 'storage-recovery-discard')
    await adapter.page.keyboard.press('Shift+Tab')
    assert.equal(await adapter.page.evaluate(() => document.activeElement.id), 'storage-recovery-retry')
    await adapter.page.keyboard.press('Enter')
    await adapter.until(s => s.playbackStatus === 'playing', 'MANUAL_RECOVERY_NOT_PLAYING', 30000)
    await adapter.page.waitForFunction(() => document.querySelector('video')?.currentTime >= 0.5)
    const after = await snapshot()
    assert.notEqual(after.state.current.attemptId, before.state.current.attemptId)
    assert.equal(after.state.current.entryId, before.state.current.entryId)
    assert.deepEqual(after.state.pending, before.state.pending)
    const resources = await adapter.resources()
    assert.ok(resources.media.bytesRead > 0)
    journal.event('manual-recovery-confirmed', { sameOccurrence: true, newAttempt: true, queued: 2, minimumTime: 0.5 })
    await adapter.app.evaluate(() => {
      const sequence = global.__t3.runtime.sequence
      const execute = sequence.execute.bind(sequence)
      global.__discardCommands = []
      sequence.execute = request => { global.__discardCommands.push(request.command.type); return execute(request) }
    })
    const focusControl = process.env.KQ_USB_FOCUS_CONTROL === '1'
    if (focusControl) await adapter.page.evaluate(() => {
      const original = window.requestAnimationFrame
      const callbacks = []
      window.requestAnimationFrame = callback => { callbacks.push(callback); return 0 }
      window.__releaseFocusFrame = () => {
        window.requestAnimationFrame = original
        for (const callback of callbacks.splice(0)) callback(performance.now())
      }
    })
    // A second real resource error exercises discard-current and Ctrl+Space while recovering.
    await adapter.page.locator('video').evaluate(v => { v.src = v.src + '?second-storage-fault'; v.load(); void v.play().catch(() => {}) })
    await adapter.until(async () => Boolean((await snapshot()).storageRecovery?.contained), 'SECOND_FAILURE_NOT_CONTAINED')
    const discard = adapter.page.locator('#storage-recovery-discard')
    await discard.waitFor({ state: 'visible' })
    await adapter.page.waitForFunction(() => !document.getElementById('storage-recovery-discard').disabled)
    if (focusControl) {
      // Deterministic characterization of the OLD harness: explicit focus before
      // the modal's deferred autofocus can send Enter to Retry instead of Discard.
      await discard.focus()
      await adapter.page.evaluate(() => window.__releaseFocusFrame())
      assert.equal(await adapter.page.evaluate(() => document.activeElement.id), 'storage-recovery-retry')
      await adapter.page.keyboard.press('Enter')
      await adapter.until(async () => (await adapter.app.evaluate(() => global.__discardCommands.length)) > 0, 'CONTROL_COMMAND_NOT_OBSERVED')
      assert.equal(await adapter.app.evaluate(() => global.__discardCommands[0]), 'recover-storage')
      journal.event('old-harness-focus-race-confirmed', { mainCommand: 'recover-storage', intendedCommand: 'discard-interrupted', physical: 'NOT RUN' })
      await command('stop-all'); await adapter.close()
      console.log('F008_FOCUS_CONTROL PASS deterministic old-harness focus race; production behavior was not modified')
      return
    }
    // A renderer-frame barrier waits for the documented modal autofocus lifecycle,
    // then target the native button at key dispatch. No arbitrary sleep or timeout increase.
    await adapter.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    await discard.press('Enter')
    await adapter.until(async () => (await adapter.app.evaluate(() => global.__discardCommands.length)) > 0, 'DISCARD_COMMAND_NOT_DELIVERED')
    assert.equal(await adapter.app.evaluate(() => global.__discardCommands[0]), 'discard-interrupted')
    journal.event('discard-command-main-confirmed', { command: 'discard-interrupted', focusBarrier: 'renderer animation frame' })
    await adapter.until(async () => (await snapshot()).storageRecovery?.target === null, 'DISCARD_NOT_CONFIRMED')
    assert.deepEqual((await snapshot()).pending, before.state.pending)
    assert.equal((await adapter.resources()).playbackStatus, 'idle', 'discard must not start the next song')
    journal.event('discard-current-confirmed', { pendingPreserved: 2, automaticNext: false })
    await adapter.page.keyboard.press('Control+Space')
    await adapter.page.locator('#standalone-stop-confirmation').waitFor({ state: 'visible' })
    await adapter.page.locator('#stop-confirmation-confirm').click()
    await adapter.until(async s => {
      const main = await snapshot()
      const engine = await adapter.app.evaluate(() => global.__t3.runtime.playback.getState())
      return main.playbackCondition === 'ready' && main.state.operationalState === 'idle' && main.state.pending.length === 0 &&
        ['idle', 'stopped'].includes(engine.status) && !engine.attemptId && !s.grants && !s.streams && !s.handles
    }, 'FINAL_STOP_NOT_CLEAN')
    const released = await adapter.resources()
    assert.equal(released.media.fileHandlesOpened, released.media.fileHandlesClosed)
    assert.equal(released.media.fileHandleCloseFailures, 0)
    // Shutdown with the recovery modal open, then P1 startup with the same private profile.
    await command('submit-code', { enteredCode: '1', priority: 'normal' })
    await adapter.until(s => s.playbackStatus === 'playing', 'SHUTDOWN_CASE_NOT_PLAYING', 30000)
    await adapter.page.locator('video').evaluate(v => { v.src += '?shutdown-case'; v.load(); void v.play().catch(() => {}) })
    await adapter.until(async () => Boolean((await snapshot()).storageRecovery?.contained), 'SHUTDOWN_CASE_NOT_CONTAINED')
    await adapter.close()
    await adapter.start(); await adapter.ready()
    assert.equal((await snapshot()).state.operationalState, 'idle')
    assert.equal((await snapshot()).storageRecovery, undefined)
    await adapter.close()
    journal.event('shutdown-recovery-p1-confirmed', { safeIdle: true, autoplay: false })
    journal.event('storage-resilience-complete', { status: 'PASS', physicalUSB: 'NOT RUN', main: true, ipc: true, renderer: true })
    console.log('STORAGE_RESILIENCE PASS real Main/IPC/Renderer, generated WebM, root loss with buffer, real re-read failure, contained queue, manual restart, modal keyboard, Stop cleanup')
    console.log('STORAGE_EVIDENCE ' + path.basename(evidence))
  } catch (error) {
    journal.event('primary-error', { code: error.code || error.name, message: String(error.message).slice(0, 300) })
    console.error('PRIMARY_STORAGE_ERROR', error)
    throw error
  } finally { await adapter.close(); fs.rmSync(session, { recursive: true, force: true }) }
}
run().catch(error => { journal.event('storage-resilience-failure', { code: error.code || error.name }); console.error(error); process.exitCode = 1 })
