// @ts-nocheck
export {}

// G5.4 real Management Electron smoke: production Main, restricted preload and local isolated profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { _electron: electron } = require('playwright')
const { prepareControllerModeProfile } = require('./electron-test-profile')
const { closeElectronTestAppNormally, createElectronTestTempRoot, runWithElectronTestCleanup,
  terminateElectronTestHarnessAfterCleanupFailure } = require('./electron-test-lifecycle')
const { createKaraokeDatabase } = require('../database')
const { ManagementRemoteOutbox } = require('../src/management-remote-outbox')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = createElectronTestTempRoot('karaoke-g5-devices-electron')

async function run() {
  const userDataDir = path.join(profileRoot, 'profile')
  prepareControllerModeProfile(userDataDir)
  const controllerId = randomUUID()
  fs.writeFileSync(path.join(userDataDir, 'remote-controller-identity.json'), JSON.stringify({
    schemaVersion: 1, role: 'controller', deviceId: controllerId, createdAt: new Date().toISOString()
  }) + '\n')
  const playerId = randomUUID()
  const commandTemplate = JSON.parse(fs.readFileSync(path.join(projectRoot,
    'tests/fixtures/operational-v1/valid-messages.json'), 'utf8')).find(message => message.kind === 'command')
  assert.ok(commandTemplate, 'the G3 command fixture exists for isolated outbox presentation')
  const operationIds = Object.fromEntries(['unknown', 'accepted', 'rejected', 'completed'].map(status => {
    const operationId = randomUUID()
    const command = structuredClone(commandTemplate)
    command.deviceId = playerId
    command.controllerId = controllerId
    command.body.operationId = operationId
    const database = createKaraokeDatabase(userDataDir)
    try {
      const outbox = new ManagementRemoteOutbox(database, { deviceId: controllerId, controllerId })
      const prepared = outbox.prepare(playerId, command).record
      database.remoteOutbox.markTransmissionStarted(playerId, controllerId, operationId)
      if (status === 'accepted' || status === 'completed') {
        database.remoteOutbox.recordRemoteStatus({ playerDeviceId: playerId, controllerId, operationId,
          fingerprint: prepared.fingerprint, status: 'accepted', detail: { operationId, status: 'accepted' } })
      }
      if (status === 'rejected' || status === 'completed') {
        database.remoteOutbox.recordRemoteStatus({ playerDeviceId: playerId, controllerId, operationId,
          fingerprint: prepared.fingerprint, status, detail: { operationId, status } })
      }
    } finally {
      database.close()
    }
    return [status, operationId]
  }))
  const operationId = operationIds.unknown
  const fixtureDatabase = createKaraokeDatabase(userDataDir)
  try { assert.equal(fixtureDatabase.remoteOutbox.listAll(controllerId, 100).length, 4) }
  finally { fixtureDatabase.close() }
  let app

  await runWithElectronTestCleanup(async () => {
    app = await electron.launch({
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
    const page = await app.firstWindow()
    page.on('pageerror', error => console.error('Management page error:', error.message))
    page.on('console', message => { if (message.type() === 'error') console.error('Management console error:', message.text()) })
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 })
    try {
      await page.waitForFunction(() => !!window.__kqueue, undefined, { timeout: 15000 })
    } catch (error) {
      const screenshotDir = process.env.KQ_G5_SCREENSHOT_DIR
      if (screenshotDir) {
        fs.mkdirSync(screenshotDir, { recursive: true })
        await page.screenshot({ path: path.join(screenshotDir, 'management-devices-startup-failure.png') }).catch(() => undefined)
      }
      console.error('Management body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 2000))
      throw error
    }
    await page.locator('#btn-devices').waitFor({ state: 'visible' })
    const continueButton = page.locator('#btn-startup-primary')
    if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
    await page.locator('#form-entry').waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await page.evaluate(() => Boolean(window.karaokeRemoteManagement)), true,
      'the combined Management window receives its restricted G5 preload')

    const headerOrder = await page.evaluate(() => {
      const devices = document.querySelector('#btn-devices')
      const notifications = document.querySelector('#btn-notifications')
      return Boolean(devices && notifications &&
        (devices.compareDocumentPosition(notifications) & Node.DOCUMENT_POSITION_FOLLOWING))
    })
    assert.equal(headerOrder, true, 'Dispositivos appears immediately before Notifications in the header')

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 920))
    const triggerReceivesPointer = await page.evaluate(() => {
      const button = document.querySelector('#btn-devices')
      const rect = button.getBoundingClientRect()
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('#btn-devices') === button
    })
    assert.equal(triggerReceivesPointer, true, 'the trial banner does not cover the Dispositivos button')
    await page.locator('#btn-devices').click()
    const panel = page.getByRole('dialog', { name: 'Dispositivos' })
    try {
      await panel.waitFor({ state: 'visible', timeout: 10000 })
    } catch (error) {
      console.error('Management G5 UI state:', JSON.stringify(await page.evaluate(() => ({
        bridge: Boolean(window.karaokeRemoteManagement),
        rootExists: Boolean(document.querySelector('#remote-devices-root')),
        root: document.querySelector('#remote-devices-root')?.innerHTML.slice(0, 1000),
        overlays: [...document.querySelectorAll('[role="dialog"]')].map(element => element.id || element.getAttribute('aria-labelledby'))
      }))))
      throw error
    }
    assert.equal(await page.locator('#remote-device-heading').innerText(), 'Dispositivos')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      'Fechar dispositivos', 'panel receives initial keyboard focus')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action), 'refresh',
      'Shift+Tab wraps from the first control to the last control in the devices dialog')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      'Fechar dispositivos', 'Tab wraps inside the devices dialog without leaking focus behind the overlay')

    const screenshotDir = process.env.KQ_G5_SCREENSHOT_DIR
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true })
      await page.screenshot({ path: path.join(screenshotDir, 'management-devices-panel-1440x920.png'), animations: 'disabled' })
    }

    const operationList = page.getByRole('region', { name: 'Operações remotas' })
    const uncertainOperation = operationList.locator('.remote-device-card').filter({ hasText: `Operação ${operationId.slice(0, 12)}` })
    await uncertainOperation.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(await uncertainOperation.innerText(), /Resultado incerto/,
      'the UI renders the real durable outbox state from the isolated SQLite profile')
    assert.equal(await uncertainOperation.locator('[data-action="query-operation"]').count(), 0,
      'an uncertain operation cannot be queried until Main confirms the secure channel is reconciled')
    assert.match(await uncertainOperation.innerText(), /Consulta disponível quando o canal seguro estiver reconciliado/)
    assert.doesNotMatch(await uncertainOperation.innerText(), /Consultando/,
      'an unavailable query never becomes an infinite spinner')
    for (const [status, expectedLabel] of [
      ['accepted', 'Aceita · ainda pendente'],
      ['rejected', 'Rejeitada'],
      ['completed', 'Concluída']
    ]) {
      const card = operationList.locator('.remote-device-card')
        .filter({ hasText: `Operação ${operationIds[status].slice(0, 12)}` })
      await card.waitFor({ state: 'visible', timeout: 10000 })
      assert.ok((await card.innerText()).includes(expectedLabel),
        `the persisted ${status} status is presented without inventing a different outcome`)
      assert.equal(await card.locator('[data-action="query-operation"]').count(), 0,
        `the ${status} state does not expose an unnecessary query while the channel is unavailable`)
    }
    const blockedQuery = await page.evaluate(({ requestedPlayerId, requestedOperationId }) =>
      window.karaokeRemoteManagement.queryOperation(requestedPlayerId, requestedOperationId),
    { requestedPlayerId: playerId, requestedOperationId: operationId })
    assert.deepEqual(blockedQuery, { outcome: 'failed', code: 'REMOTE_OPERATIONAL_CHANNEL_UNAVAILABLE' },
      'Main rejects a direct query when the matching Player channel is not reconciled')
    const afterBlockedQuery = await page.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
    assert.equal(afterBlockedQuery.operations.length, 4, 'an unavailable query does not create or duplicate an outbox record')
    assert.equal(afterBlockedQuery.operations.find(operation => operation.operationId === operationId)?.status, 'unknown',
      'an unavailable query preserves the original uncertain operation')

    for (const [width, height] of [[1366, 768], [1920, 1080]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
      await page.waitForFunction(expectedWidth => Math.abs(innerWidth - expectedWidth) < 3, width)
      const viewport = await page.evaluate(() => ({
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        panelVisible: Boolean(document.querySelector('.remote-device-panel')?.getClientRects().length)
      }))
      assert.equal(viewport.horizontalOverflow, false, `no horizontal page overflow at ${width}x${height}`)
      assert.equal(viewport.panelVisible, true, `devices panel remains visible at ${width}x${height}`)
    }

    await page.keyboard.press('Escape')
    await page.locator('#remote-device-heading').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-devices', 'closing restores focus to its trigger')

    await page.locator('#btn-devices').click()
    await panel.waitFor({ state: 'visible' })
    const reopenedOperation = page.getByRole('region', { name: 'Operações remotas' })
      .locator('.remote-device-card').filter({ hasText: `Operação ${operationId.slice(0, 12)}` })
    await reopenedOperation.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(await reopenedOperation.innerText(), /Resultado incerto/,
      'closing and reopening the panel does not clear the persisted uncertain outbox record')
    await page.keyboard.press('Escape')
    await page.locator('#remote-device-heading').waitFor({ state: 'detached' })

    await page.locator('#btn-devices').click()
    await panel.waitFor({ state: 'visible' })
    await page.getByRole('button', { name: /Configuração avançada/ }).click()
    const manualDialog = page.getByRole('dialog', { name: 'Adicionar endereço manual' })
    await manualDialog.waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'remote-manual-address',
      'manual endpoint dialog focuses its first editable field')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim()),
      'Verificar endereço', 'Shift+Tab wraps from the first manual field to the last dialog action')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'remote-manual-address',
      'Tab wraps within the manual endpoint dialog')
    await page.locator('#remote-manual-address').fill('192.168.1.24')
    assert.equal(await page.locator('#remote-manual-address').inputValue(), '192.168.1.24')
    await page.keyboard.press('Escape')
    await page.locator('#remote-manual-heading').waitFor({ state: 'detached' })
    await page.keyboard.press('Escape')
    await page.locator('#remote-device-heading').waitFor({ state: 'detached' })

    await closeElectronTestAppNormally(app, 'management')
    app = undefined
    app = await electron.launch({
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
    const restartedPage = await app.firstWindow()
    await restartedPage.waitForLoadState('domcontentloaded', { timeout: 15000 })
    await restartedPage.waitForFunction(() => Boolean(window.karaokeRemoteManagement), undefined, { timeout: 15000 })
    const restartedContinueButton = restartedPage.locator('#btn-startup-primary')
    if (await restartedContinueButton.isVisible().catch(() => false)) await restartedContinueButton.click()
    await restartedPage.locator('#form-entry').waitFor({ state: 'visible', timeout: 15000 })
    await restartedPage.locator('#btn-devices').waitFor({ state: 'visible', timeout: 10000 })
    await restartedPage.locator('#btn-devices').click()
    const restartedPanel = restartedPage.getByRole('dialog', { name: 'Dispositivos' })
    await restartedPanel.waitFor({ state: 'visible', timeout: 10000 })
    const afterProcessRestart = await restartedPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
    assert.equal(afterProcessRestart.operations.length, 4,
      'the real Management process restart rehydrates every isolated SQLite outbox record exactly once')
    for (const [status, expectedLabel] of [
      ['unknown', 'Resultado incerto'],
      ['accepted', 'Aceita · ainda pendente'],
      ['rejected', 'Rejeitada'],
      ['completed', 'Concluída']
    ]) {
      const operation = afterProcessRestart.operations.find(item => item.operationId === operationIds[status])
      assert.equal(operation?.status, status, `the SQLite ${status} result survives Management process restart`)
      const card = restartedPage.getByRole('region', { name: 'Operações remotas' })
        .locator('.remote-device-card[data-player-id="' + playerId + '"][data-operation-id="' + operationIds[status] + '"]')
      await card.waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await card.count(), 1,
        `the ${status} card keeps an exact stable identity after its query action is removed`)
      assert.ok((await card.innerText()).includes(expectedLabel),
        `the restarted Renderer displays the durable ${status} state without inventing a result`)
      assert.equal(await card.locator('[data-action="query-operation"]').count(), 0,
        `the ${status} result stays non-queryable while no matching Player channel is reconciled`)
    }
    assert.equal(afterProcessRestart.operations.filter(item => item.operationId === operationId).length, 1,
      'process restart does not duplicate the uncertain operation')
    assert.doesNotMatch(await restartedPage.locator('#remote-devices-root').innerText(), /Consultando/,
      'process restart does not leave an infinite query indicator')

    // Corrupt only this isolated test profile after the operation-rehydration assertions.
    // The device panel must surface that the durable pairing list is unknown and block pairing actions.
    fs.writeFileSync(path.join(userDataDir, 'remote-authorization.json'), '{invalid-json', 'utf8')
    await restartedPage.locator('[data-action="refresh"]').click()
    const pairingStoreError = restartedPage.locator('[data-error-code="PAIRING_STATE_UNAVAILABLE"]')
    await pairingStoreError.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(await pairingStoreError.innerText(), /vínculos e journals persistidos/)
    assert.equal(await restartedPage.locator('[data-action="advanced"]').isDisabled(), true,
      'manual initial pairing is blocked while the durable G2 journal cannot be read')
    assert.equal(await restartedPage.locator('[data-purpose="initial"], [data-purpose="recovery"], [data-purpose="renewal"]').count(), 0,
      'an unreadable G2 store cannot offer a new pairing, recovery, or renewal action')

    await restartedPage.keyboard.press('Escape')
    await restartedPage.locator('#remote-device-heading').waitFor({ state: 'detached' })
  }, async () => {
    if (app) await closeElectronTestAppNormally(app, 'management')
    fs.rmSync(profileRoot, { recursive: true, force: true })
  })
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
  if (error?.message === 'ELECTRON_TEST_NORMAL_EXIT_TIMEOUT') {
    // Only terminate this harness after its bounded normal-exit attempt. The Windows runner inspects and
    // reports any residual application process; this test never force-kills Electron to obtain PASS.
    process.exit(1)
  }
  terminateElectronTestHarnessAfterCleanupFailure(error)
})
