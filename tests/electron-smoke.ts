const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-queue-playwright-'))

async function run() {
  let app: import('playwright').ElectronApplication | undefined

  try {
    const electronApp = await electron.launch({
      executablePath: require('electron'),
      args: [projectRoot, `--user-data-dir=${path.join(profileRoot, 'profile')}`],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(profileRoot, 'config'),
        XDG_CACHE_HOME: path.join(profileRoot, 'cache'),
        XDG_DATA_HOME: path.join(profileRoot, 'data')
      },
      timeout: 30000
    })

    app = electronApp
    const page = await electronApp.firstWindow()
    await page.locator('#form-entry').waitFor({ state: 'visible' })

    const continueButton = page.locator('#btn-startup-primary')
    if (await continueButton.isVisible()) await continueButton.click()

    const singer = 'Playwright Smoke Test'
    const editedSinger = 'Playwright Editado'

    await page.locator('#input-name').fill(singer)
    await page.locator('#input-song').fill('1234')
    await page.locator('#input-song2').fill('5678')
    await page.locator('#input-table').fill('7')
    await page.locator('#form-entry button[type="submit"]').click()
    await page.locator('.now-name').getByText(singer, { exact: true }).waitFor()

    await page.locator('#now-block button[title="Editar"]').click()
    await page.locator('#edit-name').fill(editedSinger)
    await page.locator('#btn-save-edit').click()
    await page.locator('.now-name').getByText(editedSinger, { exact: true }).waitFor()

    await page.locator('#now-block .btn-done-lg').click()
    await page.getByText('Nenhuma entrada na fila.', { exact: true }).waitFor()

    await page.locator('#btn-history').click()
    const historyPanel = page.locator('#history-panel')
    await historyPanel.locator('.history-name').getByText(editedSinger, { exact: true }).waitFor()
    assert.match(await historyPanel.locator('.history-song').innerText(), /1234.*5678/)

    await page.reload()
    await page.locator('#form-entry').waitFor({ state: 'visible' })
    const reopenedContinueButton = page.locator('#btn-startup-primary')
    if (await reopenedContinueButton.isVisible()) await reopenedContinueButton.click()
    await page.locator('#btn-history').click()
    await page.locator('#history-panel .history-name').getByText(editedSinger, { exact: true }).waitFor()

    console.log('PASS: add entry, edit entry, mark sung, history, and persisted state after reload')
  } finally {
    if (app) {
      await app.evaluate(({ app: electronApp }: typeof import('electron')) => electronApp.exit(0)).catch(() => {})
      await app.close().catch(() => {})
    }
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
